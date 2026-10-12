import { transaction, timestamp } from './model.mjs';
import { BEHAVIOR_CODES, CODEBOOK_VERSION } from './behavior-vocabulary.mjs';
import { migrateBehavior } from './behavior-migration.mjs';
const other = {
 who:['Friend','Unfamiliar person','Romantic interest or partner','Family member','Classmate','Coworker','Authority figure','Group','Unspecified'],
 setting:['Class or school','Work','Social gathering','Online interaction','Home','Travel or road','Sport or recreation','Unspecified'],
 anticipated_interpersonal_consequence:['Rejection','Judgment','Conflict','Burdening someone','Relationship loss','Other']
};
export const STARTER_CODES=[...BEHAVIOR_CODES,...Object.entries(other).flatMap(([dimension,names])=>names.map(name=>({dimension,name,family:'',definition:'',include_rule:'',exclude_rule:'',example:'',status:'draft'})))];
export function seedStarterCodebook(db,authorId){
 const result=migrateBehavior(db,authorId);
 // Existing nonbehavior codebooks, including user additions/renames/retirements, are untouched.
 transaction(db,()=>{for(const [dimension,names] of Object.entries(other)){
  if(db.prepare('SELECT id FROM codes WHERE dimension=? LIMIT 1').get(dimension))continue;
  for(const name of names){const updated=timestamp();const id=Number(db.prepare("INSERT INTO codes(dimension,name,family,definition,include_rule,exclude_rule,example,status,author_id,version,updated) VALUES (?,?,'','','','','','draft',?,1,?)").run(dimension,name,authorId,updated).lastInsertRowid);
   db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('code',String(id),authorId,1,JSON.stringify({...db.prepare('SELECT * FROM codes WHERE id=?').get(id),codebook_version:CODEBOOK_VERSION}),updated);
  }
 }});return result;
}
