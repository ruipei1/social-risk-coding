import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, importCSV, parseCSV, PROMPTS, addUser, csvExport } from '../model.mjs';
import { createApp } from '../server.mjs';

const fixture = (key='test-record', text='I said "no",\nand stayed home.') => ({ analysis_response_key:key, participant_key:'person-one', survey_source:'test source', pool:'psych', collection_wave_verified:'2026_Q1', response_complete:'1', ...Object.fromEntries(PROMPTS.map((p,i) => [p.id, i === 1 ? '' : text])) });
function writeCSV(path, rows) {
  const fields = Object.keys(rows[0]), quote = s => '"' + String(s).replaceAll('"','""') + '"';
  writeFileSync(path, [fields,...rows.map(r => fields.map(f => r[f]))].map(row => row.map(quote).join(',')).join('\r\n'));
}
function setup() {
  const folder = mkdtempSync(join(tmpdir(),'risk-coding-test-')), db = openDB(':memory:');
  const file = join(folder,'source.csv'); writeCSV(file,[fixture()]); importCSV(db,file);
  addUser(db,'admin','Admin','administrator-test-password','admin');
  addUser(db,'coder-a','Coder A','coder-a-test-password'); addUser(db,'coder-b','Coder B','coder-b-test-password');
  const {handler} = createApp({db, origin:'http://localhost:4317'});
  async function request(path,{method='GET',body,cookie,csrf,origin='http://localhost:4317'}={}) {
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    req.method=method; req.url=path; req.headers={origin,'content-type':'application/json',cookie,'x-csrf-token':csrf}; req.socket={remoteAddress:'127.0.0.1'};
    const headers={}; let status=200, output='';
    const res={setHeader(k,v){headers[k.toLowerCase()]=v;},writeHead(code,h={}){status=code;Object.entries(h).forEach(([k,v])=>headers[k.toLowerCase()]=v);},end(s){output=String(s||'');}};
    await handler(req,res);
    return {status,headers,output,data:headers['content-type']?.includes('application/json') ? JSON.parse(output) : null};
  }
  async function login(username,password){const r=await request('/api/login',{method:'POST',body:{username,password}});assert.equal(r.status,200);return {cookie:r.headers['set-cookie'].split(';')[0],csrf:r.data.csrf};}
  return {db,file,request,login,close(){db.close();rmSync(folder,{recursive:true,force:true});}};
}
const annotation = (note='A personal boundary', quote='') => ({version:0,status:'draft',payload:{response_quality:'substantive',dimensions:{situation:{note,quote,evidence:'explicit',codes:[]}},memos:{at_stake:'A test memo'}}});
const code = (name='Boundary setting') => ({dimension:'who',name,definition:'A decision concerning personal limits.',status:'draft',include_rule:'When a limit is described',exclude_rule:'Not merely uncertainty',example:''});

test('a name-only code enters the shared dimension pool without annotating a response', async () => {
 const s=setup();try {
   const a=await s.login('coder-a','coder-a-test-password'), b=await s.login('coder-b','coder-b-test-password');
   const created=await s.request('/api/codes',{...a,method:'POST',body:{dimension:'behavior',name:'Setting a limit',family:'Setting boundaries or leaving'}});
   assert.equal(created.status,200);
   const saved=(await s.request('/api/codes',b)).data.find(c=>c.id===created.data.id);
   assert.equal(saved.family,'Setting boundaries or leaving'); assert.equal(saved.name,'Setting a limit'); assert.equal(saved.dimension,'behavior'); assert.equal(saved.definition,'');
   assert.equal(s.db.prepare('SELECT count(*) n FROM annotations').get().n,0);
   assert.equal((await s.request('/api/codes',{...a,method:'POST',body:{dimension:'behavior',name:'  '}})).status,400);
 } finally {s.close();}
});

test('CSV import preserves multiline text, blank answers, IDs and is idempotent',()=>{
  const s=setup();try{assert.equal(s.db.prepare('SELECT count(*) n FROM responses').get().n,8);assert.equal(s.db.prepare('SELECT text FROM responses WHERE prompt=?').get('general_self_approach').text,fixture().general_self_approach);assert.equal(s.db.prepare('SELECT blank FROM responses WHERE prompt=?').get('general_self_avoid').blank,1);assert.equal(importCSV(s.db,s.file).added,0);assert.equal(parseCSV('\uFEFFa,b\r\n"x,y","a""b"\r\n')[0].b,'a"b');}finally{s.close();}
});
test('changed source is rejected atomically, preserving original responses',()=>{
 const s=setup();try{writeCSV(s.file,[fixture('new-record'),fixture('test-record','Changed text')]);assert.throws(()=>importCSV(s.db,s.file),/changed/);assert.equal(s.db.prepare('SELECT count(*) n FROM responses').get().n,8);}finally{s.close();}
});
test('protected data, production preview and cross-origin requests are denied',async()=>{
 const s=setup();try{assert.equal((await s.request('/api/responses')).status,401);assert.equal((await s.request('/api/preview-login',{method:'POST',body:{}})).status,403);assert.equal((await s.request('/api/login',{method:'POST',body:{username:'admin',password:'administrator-test-password'},origin:'http://evil.example'})).status,403);assert.equal((await s.request('/data/coding.sqlite')).status,404);}finally{s.close();}
});
test('annotations are independent per coder, persist, and detect conflicting saves',async()=>{
 const s=setup();try{const a=await s.login('coder-a','coder-a-test-password'),b=await s.login('coder-b','coder-b-test-password'),id='test-record:general_self_approach';assert.equal((await s.request('/api/annotation/'+id,{...a,method:'PUT',body:annotation()})).status,200);assert.equal((await s.request('/api/response/'+id,b)).data.annotation.version,0);assert.equal((await s.request('/api/response/'+id,a)).data.annotation.payload.dimensions.situation.note,'A personal boundary');assert.equal((await s.request('/api/annotation/'+id,{...a,method:'PUT',body:annotation('Stale change')})).status,409);assert.equal((await s.request('/api/annotation/'+id,{...b,method:'PUT',body:annotation('Independent reading')})).status,200);assert.equal(s.db.prepare('SELECT count(*) n FROM history').get().n,2);}finally{s.close();}
});
test('CSRF, fabricated quotations, and cross-dimension codes are rejected',async()=>{
 const s=setup();try{const a=await s.login('coder-a','coder-a-test-password'),id='test-record:general_self_approach';assert.equal((await s.request('/api/annotation/'+id,{cookie:a.cookie,method:'PUT',body:annotation()})).status,403);assert.equal((await s.request('/api/annotation/'+id,{...a,method:'PUT',body:annotation('note','Invented quote')})).status,400);const c=await s.request('/api/codes',{...a,method:'POST',body:code()});const data=annotation();data.payload.dimensions.behavior={codes:[c.data.id]};assert.equal((await s.request('/api/annotation/'+id,{...a,method:'PUT',body:data})).status,400);assert.equal((await s.request('/api/annotation/'+id,{...a,method:'PUT',body:annotation('note','stayed home.')})).status,200);}finally{s.close();}
});
test('RAs may propose drafts; only admins may approve or change another coder’s definition',async()=>{
 const s=setup();try{const a=await s.login('coder-a','coder-a-test-password'),b=await s.login('coder-b','coder-b-test-password'),admin=await s.login('admin','administrator-test-password');const r=await s.request('/api/codes',{...a,method:'POST',body:code()});assert.equal(r.status,200);assert.equal((await s.request('/api/codes',{...a,method:'POST',body:{...code('Other'),status:'active'}})).status,403);assert.equal((await s.request('/api/codes/'+r.data.id,{...b,method:'PUT',body:{...code(),version:1}})).status,403);assert.equal((await s.request('/api/codes/'+r.data.id,{...admin,method:'PUT',body:{...code(),version:1,status:'active'}})).status,200);assert.equal((await s.request('/api/codes/'+r.data.id,{...admin,method:'PUT',body:{...code(),version:1}})).status,409);}finally{s.close();}
});
test('filters distinguish blank/unread/complete and escape literal search',async()=>{
 const s=setup();try{const a=await s.login('coder-a','coder-a-test-password');assert.equal((await s.request('/api/responses',a)).data.total,7);assert.equal((await s.request('/api/responses?blanks=1',a)).data.total,8);assert.equal((await s.request('/api/responses?domain=social&perspective=other',a)).data.total,2);assert.equal((await s.request('/api/responses?q=%25',a)).data.total,0);const data=annotation();data.status='complete';await s.request('/api/annotation/test-record:general_self_approach',{...a,method:'PUT',body:data});assert.equal((await s.request('/api/responses?status=complete',a)).data.total,1);}finally{s.close();}
});
test('team exports are admin-only; personal CSV roundtrips notes and protects formula cells',async()=>{
 const s=setup();try{const a=await s.login('coder-a','coder-a-test-password');await s.request('/api/annotation/test-record:general_self_approach',{...a,method:'PUT',body:annotation('=SUM(1,2)')});assert.equal((await s.request('/api/export?all=1',a)).status,403);assert.equal((await s.request('/api/team',a)).status,403);assert.equal((await s.request('/api/export?kind=history',a)).status,403);const csv=await s.request('/api/export',a);const parsed=parseCSV(csv.output);assert.equal(parsed.length,1);assert.equal(parsed[0].situation_note,"'=SUM(1,2)");assert.equal(parsed[0].text,fixture().general_self_approach);assert.match(csvExport([{text:'@formula'}],['text']),/'@formula/);}finally{s.close();}
});
test('admin creates an RA and logout revokes its session',async()=>{
 const s=setup();try{const a=await s.login('admin','administrator-test-password');assert.equal((await s.request('/api/users',{...a,method:'POST',body:{username:'new-ra',name:'New RA',password:'a-long-test-password',role:'coder'}})).status,200);const ra=await s.login('new-ra','a-long-test-password');assert.equal((await s.request('/api/users',{...ra,method:'POST',body:{username:'other',name:'Other',password:'a-long-test-password',role:'admin'}})).status,403);await s.request('/api/logout',{...ra,method:'POST',body:{}});assert.equal((await s.request('/api/responses',ra)).status,401);}finally{s.close();}
});

test('simplified coding preserves hidden legacy fields and exports old and new annotations', async () => {
 const s=setup(); try {
  const a=await s.login('coder-a','coder-a-test-password'), id='test-record:general_self_approach';
  const session=(await s.request('/api/session',a)).data;
  assert.deepEqual(session.dimensions.map(d=>d.id),['behavior','who','setting']);
  await s.request('/api/annotation/'+id,{...a,method:'PUT',body:annotation('Keep this older situation')});
  // A genuinely old payload has no who or setting keys at all.
  const old=annotation().payload;
  s.db.prepare('UPDATE annotations SET payload=?').run(JSON.stringify(old));
  assert.equal((await s.request('/api/export',a)).status,200);
  const c=await s.request('/api/codes',{...a,method:'POST',body:{dimension:'who',name:'Friend'}});
  const update={version:1,status:'flagged',payload:{response_quality:'substantive',dimensions:{who:{codes:[c.data.id]}},memos:{observations:'Context changes the meaning.'}}};
  assert.equal((await s.request('/api/annotation/'+id,{...a,method:'PUT',body:update})).status,200);
  const saved=(await s.request('/api/response/'+id,a)).data.annotation;
  assert.equal(saved.payload.dimensions.situation.note,old.dimensions.situation.note);
  assert.deepEqual(saved.payload.dimensions.who.codes,[c.data.id]);
  const row=parseCSV((await s.request('/api/export',a)).output)[0];
  assert.equal(row.who_code_names,'["Friend"]');
  assert.equal(row.memo_observations,'Context changes the meaning.');
  assert.equal(row.situation_note,old.dimensions.situation.note);
 } finally {s.close();}
});

test('comparison is admin-only and distinguishes disagreements from missing readings', async () => {
 const s=setup(); try {
  const a=await s.login('coder-a','coder-a-test-password'), b=await s.login('coder-b','coder-b-test-password'), admin=await s.login('admin','administrator-test-password');
  assert.equal((await s.request('/api/comparison')).status,401);
  assert.equal((await s.request('/api/comparison',a)).status,403);
  const c=await s.request('/api/codes',{...a,method:'POST',body:{dimension:'behavior',name:'Taking a class',family:'Learning'}});
  const one=annotation();one.status='complete';one.payload.dimensions.behavior={codes:[c.data.id]};
  const id='test-record:general_self_approach';
  assert.equal((await s.request('/api/annotation/'+id,{...a,method:'PUT',body:one})).status,200);
  let result=(await s.request('/api/comparison',admin)).data;
  assert.equal(result.rows[0].result,'insufficient');assert.equal(result.rows[0].missing,2);
  const two=annotation();two.status='complete';
  assert.equal((await s.request('/api/annotation/'+id,{...b,method:'PUT',body:two})).status,200);
  result=(await s.request('/api/comparison?filter=disagreement',admin)).data;
  assert.equal(result.total,1);assert.equal(result.rows[0].fields.behavior.differs,true);
  assert.equal(result.rows[0].missing,1);assert.deepEqual(result.rows[0].fields.behavior.differingIds,[c.data.id]);
  assert.equal(result.rows[0].readings.find(r=>r.username==='coder-a').dimensions.behavior[0].name,'Taking a class');
  assert.equal((await s.request('/api/comparison?q=doesnotexist',admin)).data.total,0);
  assert.equal((await s.request('/api/comparison?offset=-1',admin)).status,400);
 } finally {s.close();}
});
