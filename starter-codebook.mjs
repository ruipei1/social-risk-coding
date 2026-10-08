import { transaction, timestamp } from './model.mjs';

const FRAMEWORK_VERSION = 'behavior-framework-v4';
const PREVIOUS_FRAMEWORK_VERSIONS = ['behavior-framework-v3', 'behavior-framework-v2'];

const families = {
  "Making social connections": [
    "Reaching out to someone new",
    "Joining a new social group or club",
    "Inviting someone to an activity",
    "Reconnecting with someone",
    "Attending a social event",
    "Not socializing or not going to social events"
  ],
  "Romantic initiation": [
    "Expressing romantic feelings"
  ],
  "Expressing views": [
    "Expressing yourself or your views in front of others",
    "Disagreeing with others"
  ],
  "Participating publicly": [
    "Taking a leadership role"
  ],
  "Seeking help or opportunities": [
    "Asking for help or a favor",
    "Contacting a professor or professional",
    "Applying for a position"
  ],
  "Addressing interpersonal problems": [
    "Raising an interpersonal concern or requesting a change in behavior",
    "Giving critical feedback"
  ],
  "Disclosing personal information": [
    "Sharing something personal",
    "Admitting a lie or mistake",
    "Sharing personal background or identity"
  ],
  "Setting boundaries or leaving": [
    "Resisting social pressure",
    "Refusing a responsibility",
    "Ending a relationship or leaving a group"
  ],
  "Intervening for others": [
    "Defending someone",
    "Challenging offensive remarks",
    "Reporting misconduct"
  ],
  "Potentially harmful social behavior": [
    "Gossiping",
    "Insulting someone or making potentially offensive jokes"
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
    "Using AI",
    "Procrastinating",
    "Taking up a challenge",
    "Dropping a course or leaving school",
    "Changing or leaving a job",
    "Starting a business",
    "Spending money",
    "Gambling",
    "Investing money",
    "Taking part in sports or exercise",
    "Changing travel plans",
    "Trying something new"
  ]
};
const who = ["Friend", "Unfamiliar person", "Romantic interest or partner", "Family member", "Classmate", "Coworker", "Authority figure", "Group", "Unspecified"];
const settings = ["Class or school", "Work", "Social gathering", "Online interaction", "Home", "Travel or road", "Sport or recreation", "Unspecified"];
const consequences = ["Rejection", "Judgment", "Conflict", "Burdening someone", "Relationship loss", "Other"];

// Each entry lists the untouched v2 starter labels that roll into the v3 label.
// User-revised entries are deliberately left alone rather than overwritten.
const migrationSources = new Map(Object.entries({
  'behavior:Reaching out to someone new': ['Reaching out to someone new', 'Introducing oneself'],
  'behavior:Joining a new social group or club': ['Joining a new social group or club', 'Joining a group or club', 'Approaching an unfamiliar group'],
  'behavior:Expressing romantic feelings': ['Expressing romantic feelings', 'Asking for contact information', 'Asking someone on a date'],
  'behavior:Expressing yourself or your views in front of others': [
    'Expressing yourself or your views in front of others',
    'Sharing an opinion',
    'Discussing political or religious beliefs',
    'Asking a question',
    'Answering a question',
    'Presenting to an audience',
    'Performing in front of others'
  ],
  'behavior:Disagreeing with others': ['Disagreeing with others', 'Expressing disagreement'],
  'behavior:Asking for help or a favor': ['Asking for help or a favor', 'Asking for help', 'Requesting a favor'],
  'behavior:Raising an interpersonal concern or requesting a change in behavior': [
    'Raising an interpersonal concern or requesting a change in behavior',
    'Confronting hurtful behavior',
    'Requesting a change in behavior',
    'Expressing dissatisfaction'
  ],
  'behavior:Sharing something personal': ['Sharing something personal', 'Sharing personal struggles', 'Sharing personal feelings'],
  'behavior:Not socializing or not going to social events': ['Not socializing or not going to social events', 'Declining an invitation'],
  'behavior:Resisting social pressure': ['Resisting social pressure', 'Declining alcohol or drugs'],
  'behavior:Ending a relationship or leaving a group': ['Ending a relationship or leaving a group', 'Ending a relationship', 'Leaving a group'],
  'behavior:Insulting someone or making potentially offensive jokes': [
    'Insulting someone or making potentially offensive jokes',
    'Insulting someone',
    'Making potentially offensive jokes'
  ],
  'behavior:Using AI': ['Using AI', 'Using AI on assignments'],
  'behavior:Taking up a challenge': ['Taking up a challenge', 'Taking a challenging course'],
  'behavior:Trying something new': ['Trying something new', 'Trying an unfamiliar activity']
}));

export const STARTER_CODES = [
  ...Object.entries(families).flatMap(([family, names]) => names.map(name => ({dimension:'behavior', family, name}))),
  ...who.map(name => ({dimension:'who', family:'', name})),
  ...settings.map(name => ({dimension:'setting', family:'', name})),
  ...consequences.map(name => ({dimension:'anticipated_interpersonal_consequence', family:'', name}))
].map(c => ({ ...c, seed_key:`${FRAMEWORK_VERSION}:${c.dimension}:${c.name}`, definition:'', include_rule:'', exclude_rule:'', example:'', status:'draft' }));

const sourceNames = code => migrationSources.get(`${code.dimension}:${code.name}`) || [code.name];
const previousSeedKeys = (dimension, name) => PREVIOUS_FRAMEWORK_VERSIONS.map(version => `${version}:${dimension}:${name}`);

function recordCodeHistory(db, code, authorId, provenance) {
  db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)')
    .run('code', String(code.id), authorId, code.version, JSON.stringify({...code, provenance}), code.updated);
}

function migrateAssignedCodes(db, replacements, authorId) {
  if (!replacements.size) return 0;
  let migrated = 0;
  for (const row of db.prepare('SELECT * FROM annotations').all()) {
    const prior = JSON.parse(row.payload);
    const payload = structuredClone(prior);
    let changed = false;
    for (const item of Object.values(payload.dimensions || {})) {
      if (!Array.isArray(item.codes)) continue;
      const mapped = item.codes.map(id => replacements.get(id) || id);
      const unique = [...new Set(mapped)];
      if (unique.length !== item.codes.length || unique.some((id, index) => id !== item.codes[index])) {
        item.codes = unique;
        changed = true;
      }
    }
    if (!changed) continue;
    const updated = timestamp(), version = row.version + 1;
    db.prepare('UPDATE annotations SET payload=?,version=?,updated=? WHERE response_id=? AND user_id=? AND batch_id=?')
      .run(JSON.stringify(payload), version, updated, row.response_id, row.user_id, row.batch_id);
    db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)')
      .run('annotation_codebook_migration', row.response_id, authorId, version, JSON.stringify({
        target_user_id: row.user_id,
        batch_id: row.batch_id,
        status: row.status,
        payload,
        previous_payload: prior,
        provenance: 'Merged superseded starter labels into the revised social-risk codebook.'
      }), updated);
    migrated++;
  }
  return migrated;
}

export function seedStarterCodebook(db, authorId) {
  if (!db.prepare('SELECT id FROM users WHERE id=? AND role=?').get(authorId, 'admin')) throw new Error('An administrator must own the starter codebook.');
  return transaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS codebook_seeds (seed_key TEXT PRIMARY KEY, code_id INTEGER NOT NULL REFERENCES codes(id))');
    // Retire untouched broad starter behaviors; retain their IDs and every saved assignment.
    const old = db.prepare("SELECT c.* FROM codes c JOIN codebook_seeds s ON s.code_id=c.id WHERE s.seed_key LIKE 'initial-framework-v1:behavior:%' AND c.version=1 AND c.status='draft'").all();
    for (const c of old) {
      const updated = timestamp(), version = c.version + 1;
      db.prepare("UPDATE codes SET status='retired',version=?,updated=? WHERE id=?").run(version, updated, c.id);
      recordCodeHistory(db, {...c, status:'retired', version, updated}, authorId, 'Replaced broad starter behavior with specific provisional behaviors; prior assignments retained.');
    }

    let added = 0, revised = 0, retired = 0;
    const replacements = new Map();
    for (const code of STARTER_CODES) {
      if (db.prepare('SELECT code_id FROM codebook_seeds WHERE seed_key=?').get(code.seed_key)) continue;

      const sources = [...new Map(sourceNames(code).flatMap(name => previousSeedKeys(code.dimension, name).map(seedKey => db.prepare(`
        SELECT c.* FROM codes c
        JOIN codebook_seeds s ON s.code_id=c.id
        WHERE s.seed_key=? AND c.dimension=? AND c.name=? AND c.status='draft'
          AND c.definition='' AND c.include_rule='' AND c.exclude_rule='' AND c.example=''
      `).get(seedKey, code.dimension, name))).filter(Boolean).map(source => [source.id, source])).values()];
      let primary = db.prepare('SELECT * FROM codes WHERE dimension=? AND name=?').get(code.dimension, code.name) || sources[0];

      if (!primary) {
        const updated = timestamp();
        const id = Number(db.prepare('INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES (?,?,?,?,?,?,?,?,1,?,?)')
          .run(code.dimension, code.name, '', '', '', '', code.status, authorId, updated, code.family).lastInsertRowid);
        primary = db.prepare('SELECT * FROM codes WHERE id=?').get(id);
        recordCodeHistory(db, primary, authorId, 'Provisional starting vocabulary informed by an exploratory reading of 400 responses; not frequency findings.');
        added++;
      } else if (sources.some(source => source.id === primary.id) && (primary.name !== code.name || primary.family !== code.family)) {
        const updated = timestamp(), version = primary.version + 1;
        db.prepare('UPDATE codes SET name=?,family=?,version=?,updated=? WHERE id=?').run(code.name, code.family, version, updated, primary.id);
        primary = {...primary, name:code.name, family:code.family, version, updated};
        recordCodeHistory(db, primary, authorId, 'Revised starter label for the consolidated social-risk codebook.');
        revised++;
      }

      db.prepare('INSERT INTO codebook_seeds VALUES (?,?)').run(code.seed_key, primary.id);
      for (const source of sources) {
        if (source.id === primary.id) continue;
        const updated = timestamp(), version = source.version + 1;
        db.prepare("UPDATE codes SET status='retired',version=?,updated=? WHERE id=?").run(version, updated, source.id);
        recordCodeHistory(db, {...source, status:'retired', version, updated}, authorId, `Merged into "${code.name}"; saved assignments migrated to code ${primary.id}.`);
        replacements.set(source.id, primary.id);
        retired++;
      }
    }
    const annotations_migrated = migrateAssignedCodes(db, replacements, authorId);
    return {added, revised, retired, annotations_migrated, total_starters:STARTER_CODES.length};
  });
}
