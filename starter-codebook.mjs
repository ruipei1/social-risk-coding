import { transaction, timestamp } from './model.mjs';
import { BEHAVIOR_CODES, CODEBOOK_VERSION } from './behavior-vocabulary.mjs';
import { migrateBehavior } from './behavior-migration.mjs';
export const CONSEQUENCE_GUIDE_VERSION = 'consequence-unspecified-v1';
export const CONSEQUENCE_GUIDE_CODES = [
 {name:'Unspecified',definition:'A social or interpersonal consequence is implied, but the response does not state what kind.',include_rule:'Use only when the response supports the presence of an interpersonal consequence without identifying its type.',exclude_rule:'Leave this dimension empty when no interpersonal consequence is supported. Use a named consequence when stated.'},
 {name:'Other',definition:'A specific social or interpersonal consequence is stated but does not fit another available consequence label.',include_rule:'Record the stated consequence in observations so the distinction remains auditable.',exclude_rule:'Do not use for an unstated or merely implied consequence; use Unspecified instead.'}
];
const other = {
 who:['Friend','Unfamiliar person','Romantic interest or partner','Family member','Classmate','Coworker','Authority figure','Group','Unspecified'],
 setting:['Class or school','Work','Social gathering','Online interaction','Home','Travel or road','Sport or recreation','Unspecified'],
 anticipated_interpersonal_consequence:['Rejection','Judgment','Conflict','Burdening someone','Relationship loss',...CONSEQUENCE_GUIDE_CODES.map(code=>code.name)]
};
const starterSpec=(dimension,name)=>CONSEQUENCE_GUIDE_CODES.find(code=>dimension==='anticipated_interpersonal_consequence'&&code.name===name)||{};
export const STARTER_CODES=[...BEHAVIOR_CODES,...Object.entries(other).flatMap(([dimension,names])=>names.map(name=>({dimension,name,family:'',definition:'',include_rule:'',exclude_rule:'',example:'',status:'draft',...starterSpec(dimension,name)})))];
function migrateConsequenceGuide(db,authorId){
 db.exec('CREATE TABLE IF NOT EXISTS codebook_migrations(version TEXT PRIMARY KEY,applied TEXT NOT NULL,report TEXT NOT NULL)');
 if(db.prepare('SELECT version FROM codebook_migrations WHERE version=?').get(CONSEQUENCE_GUIDE_VERSION))return {version:CONSEQUENCE_GUIDE_VERSION,already_applied:true};
 return transaction(db,()=>{
  const changes=[];
  for(const spec of CONSEQUENCE_GUIDE_CODES){
   const prior=db.prepare("SELECT * FROM codes WHERE dimension='anticipated_interpersonal_consequence' AND name=?").get(spec.name),updated=timestamp();let id,version;
   if(prior){
    id=prior.id;version=prior.version;
    const next={definition:spec.definition,include_rule:spec.include_rule,exclude_rule:spec.exclude_rule,status:prior.status==='retired'?'draft':prior.status};
    if(Object.entries(next).some(([key,value])=>prior[key]!==value)){
     db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('code_before_consequence_guide',String(id),authorId,prior.version,JSON.stringify({...prior,codebook_version:CONSEQUENCE_GUIDE_VERSION}),updated);
     version=prior.version+1;
     db.prepare('UPDATE codes SET definition=?,include_rule=?,exclude_rule=?,status=?,version=?,updated=? WHERE id=?').run(spec.definition,spec.include_rule,spec.exclude_rule,next.status,version,updated,id);
     db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('code',String(id),authorId,version,JSON.stringify({...db.prepare('SELECT * FROM codes WHERE id=?').get(id),codebook_version:CONSEQUENCE_GUIDE_VERSION}),updated);
     changes.push({name:spec.name,action:'updated',id});
    }
   }else{
    version=1;
    id=Number(db.prepare("INSERT INTO codes(dimension,name,family,definition,include_rule,exclude_rule,example,status,author_id,version,updated) VALUES ('anticipated_interpersonal_consequence',?,'',?,?,?,'','draft',?,1,?)").run(spec.name,spec.definition,spec.include_rule,spec.exclude_rule,authorId,updated).lastInsertRowid);
    db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('code',String(id),authorId,version,JSON.stringify({...db.prepare('SELECT * FROM codes WHERE id=?').get(id),codebook_version:CONSEQUENCE_GUIDE_VERSION}),updated);
    changes.push({name:spec.name,action:'added',id});
   }
  }
  const report={version:CONSEQUENCE_GUIDE_VERSION,changes};
  db.prepare('INSERT INTO codebook_migrations VALUES (?,?,?)').run(CONSEQUENCE_GUIDE_VERSION,timestamp(),JSON.stringify(report));
  db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('codebook_migration',CONSEQUENCE_GUIDE_VERSION,authorId,1,JSON.stringify(report),timestamp());
  return report;
 });
}
export function seedStarterCodebook(db,authorId){
 const result=migrateBehavior(db,authorId);
 // Existing nonbehavior codebooks, including user additions/renames/retirements, are untouched.
 transaction(db,()=>{for(const [dimension,names] of Object.entries(other)){
  if(db.prepare('SELECT id FROM codes WHERE dimension=? LIMIT 1').get(dimension))continue;
  for(const name of names){const updated=timestamp(),spec=starterSpec(dimension,name);const id=Number(db.prepare("INSERT INTO codes(dimension,name,family,definition,include_rule,exclude_rule,example,status,author_id,version,updated) VALUES (?,?,'',?,?,?,'','draft',?,1,?)").run(dimension,name,spec.definition||'',spec.include_rule||'',spec.exclude_rule||'',authorId,updated).lastInsertRowid);
   db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('code',String(id),authorId,1,JSON.stringify({...db.prepare('SELECT * FROM codes WHERE id=?').get(id),codebook_version:CODEBOOK_VERSION}),updated);
  }
 }});return {...result,consequence_guide:migrateConsequenceGuide(db,authorId)};
}
