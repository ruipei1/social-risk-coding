import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, addUser } from '../model.mjs';
import { seedStarterCodebook, CONSEQUENCE_GUIDE_VERSION } from '../starter-codebook.mjs';
import { BEHAVIOR_CODES, CODEBOOK_VERSION, PREVIOUS_CODEBOOK_VERSION } from '../behavior-vocabulary.mjs';
import { migrateBehavior, codebookReport } from '../behavior-migration.mjs';
function fixture(db, names){
 const admin=addUser(db,'admin','Admin','long-admin-password','admin'),coder=addUser(db,'coder','Coder','long-coder-password');
 const insert=db.prepare("INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES ('behavior',?,'Preserve old definition','Old include','Old exclude','Old example','active',?,3,'before','Legacy category')");
 const ids=names.map(n=>Number(insert.run(n,admin).lastInsertRowid));
 db.prepare("INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES ('setting','Healthcare','Local setting','','','','draft',?,2,'before','')").run(coder);
 db.prepare('INSERT INTO responses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('r','record','person','P001',1,'social_self_avoid','social','self','avoid','source','pool','wave',1,'I wanted to ask a question in class but did not. Then I asked a friend for help.',0);
 db.prepare("INSERT INTO coding_batches(name,active,created) VALUES ('Second',0,'before')").run();
 for(const batch of [1,2])for(const user of [admin,coder]) db.prepare('INSERT INTO annotations VALUES (?,?,?,?,?,?,?)').run('r',user,batch,user===admin?'complete':'flagged',JSON.stringify({dimensions:{behavior:{codes:ids,note:'Keep note',quote:'ask a question',evidence:'explicit'},who:{codes:[],note:'Who note'}},memos:{observations:'Keep exact observation',reflection:'Old memo'},response_quality:'substantive'}),4,'before');
 return {admin,ids};
}
for(const version of ['drive-v4','render-v5'])test(`${version}: full vocabulary migration preserves text, notes, ownership, statuses, history and definitions; rerun is inert`,()=>{
 const db=openDB(':memory:');try{
 const names=JSON.parse(readFileSync(new URL(`./fixtures/${version}.json`,import.meta.url),'utf8'));
 const {admin,ids}=fixture(db,names);const responses=db.prepare('SELECT * FROM responses').all(),old=db.prepare('SELECT * FROM annotations').all(),setting=db.prepare("SELECT * FROM codes WHERE dimension='setting'").get();
 const r=migrateBehavior(db,admin);assert.equal(r.selectable,19);assert.equal(r.mapping.length,names.length);
 assert.deepEqual(db.prepare('SELECT * FROM responses').all(),responses);assert.deepEqual(db.prepare("SELECT * FROM codes WHERE dimension='setting'").get(),setting);
 const after=db.prepare('SELECT * FROM annotations').all();assert.equal(after.length,old.length);
 for(let i=0;i<after.length;i++){
  assert.deepEqual([after[i].response_id,after[i].user_id,after[i].batch_id,after[i].status],[old[i].response_id,old[i].user_id,old[i].batch_id,old[i].status]);
  const before=JSON.parse(old[i].payload),next=JSON.parse(after[i].payload);assert.equal(new Set(next.dimensions.behavior.codes).size,next.dimensions.behavior.codes.length);before.dimensions.behavior.codes=[];next.dimensions.behavior.codes=[];assert.deepEqual(next,before);
 }
 for(const id of ids){const c=db.prepare('SELECT * FROM codes WHERE id=?').get(id);if(c.status==='retired'){assert.equal(c.definition,'Preserve old definition');assert.equal(c.family,'Legacy category');}}
 const labels=codebookReport(db).labels;assert.equal(labels.length,19);assert.deepEqual(labels.map(x=>({...x})),BEHAVIOR_CODES.map(({name,definition,include_rule,exclude_rule,example,family})=>({name,definition,include_rule,exclude_rule,example,family})).sort((a,b)=>a.name.localeCompare(b.name)));
 seedStarterCodebook(db,admin);
 const h=db.prepare('SELECT * FROM history ORDER BY id').all();assert.ok(h.some(x=>x.entity==='annotation_codebook_migration'&&JSON.parse(x.payload).previous_payload));
 seedStarterCodebook(db,admin);seedStarterCodebook(db,admin);assert.deepEqual(db.prepare('SELECT * FROM history ORDER BY id').all(),h);assert.deepEqual(db.prepare('SELECT * FROM annotations').all(),after);
 }finally{db.close();}
});
test('ambiguous and edited labels remain assigned, retired and independently flagged across all batches',()=>{
 const db=openDB(':memory:');try{const {admin,ids}=fixture(db,['Sharing opinions','Asking for contact information','Other to discuss','Coder novel behavior','Asking for help','Requesting a favor']);
 migrateBehavior(db,admin);const report=codebookReport(db);assert.equal(report.reviews.length,16);
 for(const a of db.prepare('SELECT * FROM annotations').all()){
  const selected=JSON.parse(a.payload).dimensions.behavior.codes;for(const id of ids.slice(0,4))assert.ok(selected.includes(id));assert.equal(selected.length,5);
 }
 for(const review of report.reviews){assert.ok(review.evidence.response_text.includes('ask a question'));assert.ok(Array.isArray(review.evidence.history));}
 }finally{db.close();}
});
test('disk database is backed up before migration and backup keeps old vocabulary',()=>{
 const dir=mkdtempSync(join(tmpdir(),'behavior-backup-')),db=openDB(join(dir,'coding.sqlite'));try{const {admin}=fixture(db,['Asking for help']);migrateBehavior(db,admin);const r=codebookReport(db);assert.ok(existsSync(r.backup));assert.equal(r.version,CODEBOOK_VERSION);const saved=openDB(r.backup);assert.equal(saved.prepare("SELECT count(*) n FROM codes WHERE dimension='behavior'").get().n,1);saved.close();}finally{db.close();rmSync(dir,{recursive:true});}
});
test('transaction rolls back all changes if a selected behavior is invalid',()=>{
 const db=openDB(':memory:');try{const {admin}=fixture(db,['Asking for help']);db.prepare("UPDATE annotations SET payload=?").run(JSON.stringify({dimensions:{behavior:{codes:[99999]}}}));assert.throws(()=>migrateBehavior(db,admin),/Unknown selected behavior/);assert.equal(db.prepare("SELECT count(*) n FROM codes WHERE dimension='behavior'").get().n,1);assert.equal(db.prepare("SELECT count(*) n FROM history").get().n,0);}finally{db.close();}
});

test('v7 updates definitions without changing v6 annotations or researcher-added behaviors',()=>{
 const db=openDB(':memory:');try{
  const admin=addUser(db,'v7-admin','V7 Admin','long-admin-password','admin'),now='before';
  const insert=db.prepare("INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES ('behavior',?,?,?,?,?,'active',?,1,?,'')");
  for(const spec of BEHAVIOR_CODES){
   const include=spec.name==='Other behavior'?'Use for an established action not covered above. Online communication or AI use without an established function can go here.':spec.include_rule;
   insert.run(spec.name,spec.definition,include,spec.exclude_rule,spec.example,admin,now);
  }
  const custom=Number(db.prepare("INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES ('behavior','Researcher distinction','','','','','draft',?,1,?,'')").run(admin,now).lastInsertRowid);
  db.prepare('INSERT INTO responses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('v7-r','record','person','P001',1,'social_self_avoid','social','self','avoid','source','pool','wave',1,'A preserved response.',0);
  db.prepare('INSERT INTO annotations VALUES (?,?,?,?,?,?,?)').run('v7-r',admin,1,'complete',JSON.stringify({dimensions:{behavior:{codes:[custom]}},memos:{observations:'Keep me'},response_quality:'substantive'}),2,now);
  db.exec('CREATE TABLE behavior_migrations(version TEXT PRIMARY KEY,applied TEXT NOT NULL,backup TEXT,report TEXT NOT NULL)');
  db.prepare('INSERT INTO behavior_migrations VALUES (?,?,?,?)').run(PREVIOUS_CODEBOOK_VERSION,now,null,'{}');
  const before=db.prepare('SELECT * FROM annotations').get(),report=migrateBehavior(db,admin);
  assert.equal(report.targeted,true);assert.equal(report.from_version,PREVIOUS_CODEBOOK_VERSION);
  assert.deepEqual(db.prepare('SELECT * FROM annotations').get(),before);assert.equal(db.prepare('SELECT status FROM codes WHERE id=?').get(custom).status,'draft');
  assert.doesNotMatch(db.prepare("SELECT include_rule FROM codes WHERE name='Other behavior'").get().include_rule,/AI use without/);
  const history=db.prepare('SELECT * FROM history ORDER BY id').all();assert.equal(migrateBehavior(db,admin).already_applied,true);assert.deepEqual(db.prepare('SELECT * FROM history ORDER BY id').all(),history);
 }finally{db.close();}
});

test('consequence guide migration adds Unspecified, defines Other, and is idempotent',()=>{
 const db=openDB(':memory:');try{
  const admin=addUser(db,'consequence-admin','Consequence Admin','long-admin-password','admin');
  db.prepare("INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES ('anticipated_interpersonal_consequence','Other','','','','','draft',?,1,'before','')").run(admin);
  const first=seedStarterCodebook(db,admin),unspecified=db.prepare("SELECT * FROM codes WHERE dimension='anticipated_interpersonal_consequence' AND name='Unspecified'").get(),other=db.prepare("SELECT * FROM codes WHERE dimension='anticipated_interpersonal_consequence' AND name='Other'").get();
  assert.equal(first.consequence_guide.version,CONSEQUENCE_GUIDE_VERSION);assert.match(unspecified.definition,/implied/);assert.match(unspecified.exclude_rule,/Leave this dimension empty/);assert.match(other.definition,/specific/);
  const history=db.prepare('SELECT * FROM history ORDER BY id').all();assert.equal(seedStarterCodebook(db,admin).consequence_guide.already_applied,true);assert.deepEqual(db.prepare('SELECT * FROM history ORDER BY id').all(),history);
 }finally{db.close();}
});

test('review resolution is version-checked, supports distinct actions and preserves prior batch status/notes',async()=>{
 const {resolveBehaviorReview}=await import('../behavior-migration.mjs');const db=openDB(':memory:');try{
 const {admin}=fixture(db,['Sharing opinions']);migrateBehavior(db,admin);
 const review=codebookReport(db).reviews.find(x=>x.batch_id===2&&x.user_id===admin),before=db.prepare('SELECT * FROM annotations WHERE batch_id=2 AND user_id=?').get(admin);
 const input={...review,targets:['Speaking or performing publicly','Asking for help or a favor'],reason:'Original response explicitly describes a classroom question and a separate request to a friend.'};
 assert.throws(()=>resolveBehaviorReview(db,admin,{...input,annotation_version:0}),/Reading changed/);
 resolveBehaviorReview(db,admin,input);const after=db.prepare('SELECT * FROM annotations WHERE batch_id=2 AND user_id=?').get(admin);
 assert.equal(after.status,before.status);assert.deepEqual(JSON.parse(after.payload).memos,JSON.parse(before.payload).memos);assert.equal(JSON.parse(after.payload).dimensions.behavior.codes.length,2);
 assert.ok(codebookReport(db).reviews.find(x=>x.batch_id===2&&x.user_id===admin).resolved_at);
 assert.throws(()=>resolveBehaviorReview(db,admin,input),/already resolved/);
 }finally{db.close();}
});
