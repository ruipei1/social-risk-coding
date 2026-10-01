import { transaction, timestamp } from './model.mjs';

const families = {
  "Making social connections": [
    "Introducing oneself",
    "Approaching an unfamiliar group",
    "Inviting someone to an activity",
    "Reconnecting with someone",
    "Attending a social event",
    "Joining a group or club"
  ],
  "Romantic initiation": [
    "Asking someone on a date",
    "Asking for contact information",
    "Expressing romantic feelings"
  ],
  "Expressing views": [
    "Sharing an opinion",
    "Expressing disagreement",
    "Discussing political or religious beliefs"
  ],
  "Participating publicly": [
    "Asking a question",
    "Answering a question",
    "Presenting to an audience",
    "Performing in front of others",
    "Taking a leadership role"
  ],
  "Seeking help or opportunities": [
    "Asking for help",
    "Requesting a favor",
    "Contacting a professor or professional",
    "Applying for a position"
  ],
  "Addressing interpersonal problems": [
    "Confronting hurtful behavior",
    "Giving critical feedback",
    "Requesting a change in behavior",
    "Expressing dissatisfaction"
  ],
  "Disclosing personal information": [
    "Sharing personal struggles",
    "Sharing personal feelings",
    "Admitting a lie or mistake",
    "Sharing personal background or identity"
  ],
  "Setting boundaries or leaving": [
    "Declining an invitation",
    "Refusing a responsibility",
    "Ending a relationship",
    "Leaving a group",
    "Declining alcohol or drugs"
  ],
  "Intervening for others": [
    "Defending someone",
    "Challenging offensive remarks",
    "Reporting misconduct"
  ],
  "Potentially harmful social behavior": [
    "Gossiping",
    "Insulting someone",
    "Making potentially offensive jokes"
  ],
  "Online communication": [
    "Posting unspecified content",
    "Commenting on a social media post"
  ],
  "Other everyday behaviors": [
    "Drinking alcohol",
    "Using drugs or smoking",
    "Driving unsafely",
    "Cheating on schoolwork",
    "Using AI on assignments",
    "Procrastinating",
    "Taking a challenging course",
    "Dropping a course or leaving school",
    "Changing or leaving a job",
    "Starting a business",
    "Spending money",
    "Gambling",
    "Investing money",
    "Taking part in sports or exercise",
    "Changing travel plans",
    "Trying an unfamiliar activity"
  ]
};
const who = ["Friend", "Unfamiliar person", "Romantic interest or partner", "Family member", "Classmate", "Coworker", "Authority figure", "Group", "Unspecified"];
const settings = ["Class or school", "Work", "Social gathering", "Online interaction", "Home", "Travel or road", "Sport or recreation", "Unspecified"];

export const STARTER_CODES = [
  ...Object.entries(families).flatMap(([family, names]) => names.map(name => ({dimension:'behavior', family, name}))),
  ...who.map(name => ({dimension:'who', family:'', name})),
  ...settings.map(name => ({dimension:'setting', family:'', name}))
].map(c => ({ ...c, seed_key:`behavior-framework-v2:${c.dimension}:${c.name}`, definition:'', include_rule:'', exclude_rule:'', example:'', status:'draft' }));

export function seedStarterCodebook(db, authorId) {
  if (!db.prepare('SELECT id FROM users WHERE id=? AND role=?').get(authorId, 'admin')) throw new Error('An administrator must own the starter codebook.');
  return transaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS codebook_seeds (seed_key TEXT PRIMARY KEY, code_id INTEGER NOT NULL REFERENCES codes(id))');
    // Retire untouched broad starter behaviors; retain their IDs and every saved assignment.
    const old = db.prepare("SELECT c.* FROM codes c JOIN codebook_seeds s ON s.code_id=c.id WHERE s.seed_key LIKE 'initial-framework-v1:behavior:%' AND c.version=1 AND c.status='draft'").all();
    for (const c of old) {
      const updated = timestamp();
      db.prepare("UPDATE codes SET status='retired',version=version+1,updated=? WHERE id=?").run(updated,c.id);
      db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('code',String(c.id),authorId,c.version+1,JSON.stringify({...c,status:'retired',provenance:'Replaced broad starter behavior with specific provisional behaviors; prior assignments retained.'}),updated);
    }
    let added=0;
    for (const code of STARTER_CODES) {
      if (db.prepare('SELECT code_id FROM codebook_seeds WHERE seed_key=?').get(code.seed_key)) continue;
      let id = db.prepare('SELECT id FROM codes WHERE dimension=? AND name=?').get(code.dimension,code.name)?.id;
      if (!id) {
        const updated=timestamp();
        id=Number(db.prepare('INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES (?,?,?,?,?,?,?,?,1,?,?)').run(code.dimension,code.name,'','','','',code.status,authorId,updated,code.family).lastInsertRowid);
        db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('code',String(id),authorId,1,JSON.stringify({...code,provenance:'Provisional starting vocabulary informed by an exploratory reading of 400 responses; not frequency findings.'}),updated);
        added++;
      }
      db.prepare('INSERT INTO codebook_seeds VALUES (?,?)').run(code.seed_key,id);
    }
    return {added,total_starters:STARTER_CODES.length};
  });
}
