import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { transaction, timestamp, hash } from './model.mjs';
import { CODEBOOK_VERSION, PREVIOUS_CODEBOOK_VERSION, BEHAVIOR_CODES, DIRECT_MAPPING, CONTEXT_LABELS } from './behavior-vocabulary.mjs';

const RENAMED_CODES = new Map([
 ['Personal disclosure','Sharing something personal'],
 ['Expressing opinions or disagreement','Expressing views'],
 ['Confronting or addressing interpersonal conflict','Addressing an interpersonal problem'],
 ['Defending, supporting, or intervening for others','Intervening for others'],
 ['Engaging in harmful social behavior (lying, gossiping, or manipulation)','Engaging in harmful social behavior'],
 ['Making an education or career decision','Making an education or work decision'],
 ['Performing or posting publicly (online or in person)','Speaking or performing publicly']
]);

function historyFor(db,row) {
 return db.prepare("SELECT id,entity,user_id,payload FROM history WHERE entity_id=? AND entity LIKE 'annotation%' ORDER BY id").all(row.response_id).filter(h=>{
  const p=JSON.parse(h.payload);return (p.target_user_id ?? h.user_id)===row.user_id && (p.batch_id==null || p.batch_id===row.batch_id);
 });
}
// Context-sensitive assignments are deliberately held for human review. Original text,
// coder notes, prior assignments and history IDs accompany each review; no keyword inference.
export function assignmentDecision(code, response, history) {
 const canonical=BEHAVIOR_CODES.some(c=>c.name===code.name);
 const known=DIRECT_MAPPING.get(code.name);
 if ((canonical || known) && !CONTEXT_LABELS.has(code.name)) return {targets:[canonical?code.name:known],reason:'Unambiguous label meaning retained; approach/avoid does not change behavior.'};
 return {targets:[],reason:code.name==='Other to discuss'?'Legacy discussion marker: review separately from behavior; do not infer Other behavior.':CONTEXT_LABELS.has(code.name)?'Original response and earlier coding require interpretation to distinguish the new behavior boundaries.':'Unrecognized or researcher-edited behavior: no automatic name-based mapping.',evidence:{response_text:response.text,history_ids:history.map(h=>h.id)}};
}
function record(db,entity,id,author,version,payload){db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run(entity,String(id),author,version,JSON.stringify(payload),timestamp());}
export function codebookReport(db) {
 const exists=db.prepare("SELECT name FROM sqlite_master WHERE name='behavior_migrations'").get();
 if(!exists)return {version:null};
 const migration=db.prepare('SELECT * FROM behavior_migrations WHERE version=?').get(CODEBOOK_VERSION);
 const labels=db.prepare("SELECT name,definition,include_rule,exclude_rule,example,family FROM codes WHERE dimension='behavior' AND status!='retired' ORDER BY name").all();
 return {version:migration?.version??null,backup:migration?.backup,manifest:migration?JSON.parse(migration.report):null,labels,
 reviews:db.prepare(`SELECT v.*,a.version annotation_version,r.text,r.participant_label,r.prompt,u.username,b.name batch_name FROM behavior_reviews v JOIN annotations a ON a.response_id=v.response_id AND a.user_id=v.user_id AND a.batch_id=v.batch_id JOIN responses r ON r.id=v.response_id JOIN users u ON u.id=v.user_id JOIN coding_batches b ON b.id=v.batch_id ORDER BY v.batch_id,r.record_number,v.user_id,v.legacy_code_id`).all().map(r=>({...r,evidence:JSON.parse(r.evidence)}))};
}
export function migrateBehavior(db,author) {
 if(!db.prepare("SELECT id FROM users WHERE id=? AND role='admin'").get(author))throw new Error('Administrator required.');
 const existing=db.prepare("SELECT name FROM sqlite_master WHERE name='behavior_migrations'").get();
 if(existing&&db.prepare('SELECT version FROM behavior_migrations WHERE version=?').get(CODEBOOK_VERSION))return {version:CODEBOOK_VERSION,already_applied:true};
 const targeted=!!(existing&&db.prepare('SELECT version FROM behavior_migrations WHERE version=?').get(PREVIOUS_CODEBOOK_VERSION));
 // Snapshot committed WAL content before any vocabulary/schema mutation. Fail closed on backup failure.
 const file=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main').file;
 const backup=file?`${file}.before-${CODEBOOK_VERSION}-${randomUUID()}.sqlite`:null;
 if(backup){db.prepare('VACUUM INTO ?').run(backup);chmodSync(backup,0o600);}
 return transaction(db,()=>{
 db.exec(`CREATE TABLE IF NOT EXISTS behavior_migrations(version TEXT PRIMARY KEY,applied TEXT NOT NULL,backup TEXT,report TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS behavior_reviews(response_id TEXT NOT NULL,user_id INTEGER NOT NULL,batch_id INTEGER NOT NULL,legacy_code_id INTEGER NOT NULL,legacy_name TEXT NOT NULL,reason TEXT NOT NULL,evidence TEXT NOT NULL,version TEXT NOT NULL,resolved_at TEXT,resolution TEXT,PRIMARY KEY(response_id,user_id,batch_id,legacy_code_id));`);
 if(targeted){
  const annotations=db.prepare('SELECT * FROM annotations ORDER BY response_id,user_id,batch_id').all(),responses=db.prepare('SELECT * FROM responses ORDER BY id').all(),nonbehavior=db.prepare("SELECT * FROM codes WHERE dimension!='behavior' ORDER BY id").all();
  const canonicalNames=new Set(BEHAVIOR_CODES.map(code=>code.name));
  const priorCanonicalNames=new Set(RENAMED_CODES.values());
  const custom=()=>db.prepare("SELECT * FROM codes WHERE dimension='behavior' ORDER BY id").all().filter(code=>!canonicalNames.has(code.name)&&!priorCanonicalNames.has(code.name));
  const oldHistory=db.prepare('SELECT * FROM history ORDER BY id').all(),before={annotations:hash(JSON.stringify(annotations)),responses:hash(JSON.stringify(responses)),nonbehavior:hash(JSON.stringify(nonbehavior)),custom_behaviors:hash(JSON.stringify(custom())),history_digest:hash(JSON.stringify(oldHistory))};
  const changed=[];
  for(const spec of BEHAVIOR_CODES){
   const previousName=RENAMED_CODES.get(spec.name);
   const prior=db.prepare("SELECT * FROM codes WHERE dimension='behavior' AND name=?").get(spec.name) || (previousName?db.prepare("SELECT * FROM codes WHERE dimension='behavior' AND name=?").get(previousName):null);
   if(!prior){
    if(spec.name!=='Drawing attention to oneself or being put on the spot')throw new Error(`Version ${PREVIOUS_CODEBOOK_VERSION} is missing canonical behavior ${spec.name}`);
    const updated=timestamp();
    const id=Number(db.prepare("INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES ('behavior',?,?,?,?,?,'active',?,1,?,'')").run(spec.name,spec.definition,spec.include_rule,spec.exclude_rule,spec.example,author,updated).lastInsertRowid);
    const saved=db.prepare('SELECT * FROM codes WHERE id=?').get(id);record(db,'code',id,author,saved.version,{...saved,codebook_version:CODEBOOK_VERSION});
    changed.push({id,name:spec.name,action:'added',version:saved.version});
    continue;
   }
   const fields=['definition','include_rule','exclude_rule','example','family','status'],values={...spec,family:'',status:'active'};
   if(prior.name===spec.name&&fields.every(field=>prior[field]===values[field]))continue;
   const updated=timestamp();record(db,'code_before_definition_migration',prior.id,author,prior.version,{...prior,codebook_version:CODEBOOK_VERSION});
   db.prepare("UPDATE codes SET name=?,definition=?,include_rule=?,exclude_rule=?,example=?,family='',status='active',version=version+1,updated=? WHERE id=?").run(spec.name,spec.definition,spec.include_rule,spec.exclude_rule,spec.example,updated,prior.id);
   const saved=db.prepare('SELECT * FROM codes WHERE id=?').get(prior.id);record(db,'code',prior.id,author,saved.version,{...saved,codebook_version:CODEBOOK_VERSION});
   changed.push({id:prior.id,name:saved.name,previous_name:prior.name,action:prior.name===saved.name?'updated':'renamed',previous_version:prior.version,version:saved.version});
  }
  const after={annotations:hash(JSON.stringify(db.prepare('SELECT * FROM annotations ORDER BY response_id,user_id,batch_id').all())),responses:hash(JSON.stringify(db.prepare('SELECT * FROM responses ORDER BY id').all())),nonbehavior:hash(JSON.stringify(db.prepare("SELECT * FROM codes WHERE dimension!='behavior' ORDER BY id").all())),custom_behaviors:hash(JSON.stringify(custom())),history_digest:hash(JSON.stringify(db.prepare('SELECT * FROM history WHERE id<=? ORDER BY id').all(oldHistory.at(-1)?.id??0)))};
  if(Object.keys(before).some(key=>before[key]!==after[key]))throw new Error('Targeted vocabulary preservation check failed.');
  const report={version:CODEBOOK_VERSION,from_version:PREVIOUS_CODEBOOK_VERSION,targeted:true,changed_definitions:changed,before,after,canonical:BEHAVIOR_CODES.length,selectable:db.prepare("SELECT count(*) n FROM codes WHERE dimension='behavior' AND status!='retired'").get().n};
  db.prepare('INSERT INTO behavior_migrations VALUES (?,?,?,?)').run(CODEBOOK_VERSION,timestamp(),backup,JSON.stringify(report));record(db,'codebook_migration',CODEBOOK_VERSION,author,1,report);
  return report;
 }
 const old=db.prepare("SELECT * FROM codes WHERE dimension='behavior' ORDER BY id").all(),oldMap=new Map(old.map(c=>[c.id,c]));
 const annotations=db.prepare('SELECT * FROM annotations ORDER BY response_id,user_id,batch_id').all();
 const stable=a=>{const p=JSON.parse(a.payload);if(p.dimensions?.behavior)p.dimensions.behavior.codes=[];return {response_id:a.response_id,user_id:a.user_id,batch_id:a.batch_id,status:a.status,payload:p};};
 const oldHistory=db.prepare('SELECT * FROM history ORDER BY id').all();
 const nonbehavior=()=>hash(JSON.stringify(db.prepare("SELECT * FROM codes WHERE dimension!='behavior' ORDER BY id").all()));
 const before={preserved_annotations:hash(JSON.stringify(annotations.map(stable))),nonbehavior:nonbehavior(),history_digest:hash(JSON.stringify(oldHistory)),responses:hash(JSON.stringify(db.prepare('SELECT * FROM responses ORDER BY id').all())),annotations:annotations.length,history:db.prepare('SELECT count(*) n FROM history').get().n};
 const ids=new Map();let added=0,retired=0,changed=0,flagged=0;
 for(const spec of BEHAVIOR_CODES){
  const prior=old.find(c=>c.name===spec.name);const now=timestamp();let id;
  if(prior){id=prior.id;record(db,'code_before_flat_migration',id,author,prior.version,{...prior,codebook_version:CODEBOOK_VERSION});
   db.prepare("UPDATE codes SET definition=?,include_rule=?,exclude_rule=?,example=?,family='',status='active',version=version+1,updated=? WHERE id=?").run(spec.definition,spec.include_rule,spec.exclude_rule,spec.example,now,id);
  }else {id=Number(db.prepare("INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES ('behavior',?,?,?,?,?,'active',?,1,?,'')").run(spec.name,spec.definition,spec.include_rule,spec.exclude_rule,spec.example,author,now).lastInsertRowid);added++;}
  ids.set(spec.name,id);const saved=db.prepare('SELECT * FROM codes WHERE id=?').get(id);record(db,'code',id,author,saved.version,{...saved,codebook_version:CODEBOOK_VERSION});
 }
 for(const code of old){if(ids.get(code.name)===code.id)continue;if(code.status==='retired')continue;
  db.prepare("UPDATE codes SET status='retired',version=version+1,updated=? WHERE id=?").run(timestamp(),code.id);retired++;
  record(db,'code',code.id,author,code.version+1,{...code,status:'retired',version:code.version+1,previous:code,codebook_version:CODEBOOK_VERSION});
 }
 const mapping=old.map(c=>({id:c.id,name:c.name,family:c.family,previous_status:c.status,definition:c.definition,policy:CONTEXT_LABELS.has(c.name)?'review':ids.has(c.name)||DIRECT_MAPPING.has(c.name)?'map':'review',target:CONTEXT_LABELS.has(c.name)?null:ids.has(c.name)?c.name:DIRECT_MAPPING.get(c.name)??null}));
 for(const row of annotations){const previous=JSON.parse(row.payload),selected=previous.dimensions?.behavior?.codes??[];if(!selected.length)continue;
  const response=db.prepare('SELECT * FROM responses WHERE id=?').get(row.response_id),history=historyFor(db,row),decisions=[];const next=[];
  for(const id of selected){const code=oldMap.get(id);if(!code)throw new Error(`Unknown selected behavior ${id}`);
   const decision=assignmentDecision(code,response,history);decisions.push({old_id:id,old_name:code.name,...decision});
   if(decision.targets.length)next.push(...decision.targets.map(name=>ids.get(name)));
   else {next.push(id);flagged++;db.prepare('INSERT INTO behavior_reviews(response_id,user_id,batch_id,legacy_code_id,legacy_name,reason,evidence,version) VALUES (?,?,?,?,?,?,?,?)').run(row.response_id,row.user_id,row.batch_id,id,code.name,decision.reason,JSON.stringify({...decision.evidence,previous_payload:previous,history}),CODEBOOK_VERSION);}
  }
  const payload=structuredClone(previous);payload.dimensions.behavior.codes=[...new Set(next)];
  // A new version records the decision even when all selections remain held for review.
  const updated=timestamp();db.prepare('UPDATE annotations SET payload=?,version=version+1,updated=? WHERE response_id=? AND user_id=? AND batch_id=?').run(JSON.stringify(payload),updated,row.response_id,row.user_id,row.batch_id);changed++;
  record(db,'annotation_codebook_migration',row.response_id,author,row.version+1,{batch_id:row.batch_id,target_user_id:row.user_id,status:row.status,previous_payload:previous,payload,decisions,codebook_version:CODEBOOK_VERSION});
 }
 const report={version:CODEBOOK_VERSION,added,retired,annotations_migrated:changed,review_assignments:flagged,mapping,before,after:{preserved_annotations:hash(JSON.stringify(db.prepare('SELECT * FROM annotations ORDER BY response_id,user_id,batch_id').all().map(stable))),nonbehavior:nonbehavior(),history_digest:hash(JSON.stringify(db.prepare('SELECT * FROM history WHERE id<=? ORDER BY id').all(oldHistory.at(-1)?.id??0))),responses:hash(JSON.stringify(db.prepare('SELECT * FROM responses ORDER BY id').all())),annotations:db.prepare('SELECT count(*) n FROM annotations').get().n},canonical:BEHAVIOR_CODES.length,selectable:BEHAVIOR_CODES.length};
 if(['responses','annotations','preserved_annotations','nonbehavior','history_digest'].some(k=>report.before[k]!==report.after[k]))throw new Error('Preservation check failed.');
 db.prepare('INSERT INTO behavior_migrations VALUES (?,?,?,?)').run(CODEBOOK_VERSION,timestamp(),backup,JSON.stringify(report));record(db,'codebook_migration',CODEBOOK_VERSION,author,1,report);
 return report;
 });
}

export function resolveBehaviorReview(db,author,input) {
 return transaction(db,()=>{
  const {response_id,user_id,batch_id,legacy_code_id,annotation_version,targets,reason}=input;
  if(!Array.isArray(targets)||targets.length>BEHAVIOR_CODES.length||targets.some(n=>!BEHAVIOR_CODES.some(c=>c.name===n))||typeof reason!=='string'||!reason.trim()||reason.length>6000)throw new Error('Choose valid labels and record the response evidence.');
  const row=db.prepare('SELECT * FROM annotations WHERE response_id=? AND user_id=? AND batch_id=?').get(response_id,user_id,batch_id);
  const review=db.prepare('SELECT * FROM behavior_reviews WHERE response_id=? AND user_id=? AND batch_id=? AND legacy_code_id=?').get(response_id,user_id,batch_id,legacy_code_id);
  if(!row||!review||review.resolved_at)throw new Error('Review is missing or already resolved.');
  if(row.version!==annotation_version)throw new Error('Reading changed. Reload the report before resolving.');
  const prior=JSON.parse(row.payload),payload=structuredClone(prior),selected=payload.dimensions?.behavior?.codes??[];
  if(!selected.includes(legacy_code_id))throw new Error('Legacy selection changed. Inspect the latest reading.');
  payload.dimensions.behavior.codes=[...new Set([...selected.filter(id=>id!==legacy_code_id),...targets.map(n=>db.prepare("SELECT id FROM codes WHERE dimension='behavior' AND name=? AND status='active'").get(n).id)])];
  const updated=timestamp();db.prepare('UPDATE annotations SET payload=?,version=version+1,updated=? WHERE response_id=? AND user_id=? AND batch_id=?').run(JSON.stringify(payload),updated,response_id,user_id,batch_id);
  db.prepare('UPDATE behavior_reviews SET resolved_at=?,resolution=? WHERE response_id=? AND user_id=? AND batch_id=? AND legacy_code_id=?').run(updated,JSON.stringify({targets,reason,author}),response_id,user_id,batch_id,legacy_code_id);
  record(db,'annotation_migration_review',response_id,author,row.version+1,{target_user_id:user_id,batch_id,status:row.status,previous_payload:prior,payload,legacy_code_id,targets,reason,codebook_version:CODEBOOK_VERSION});
  return {version:row.version+1};
 });
}
