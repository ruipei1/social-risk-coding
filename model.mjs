import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const DIMENSIONS = [
  ['behavior', 'Behavior', 'What action is being done, considered, or avoided? Choose specific behaviors; more than one can fit.'],
  ['who', 'Who is involved?', 'Optional. Choose the people or relationships stated in the response.'],
  ['setting', 'Setting', 'Optional. Where does it happen? Choose only settings supported by the text.']
].map(([id, label, help]) => ({ id, label, help }));
// Retain the original fields for saved annotations and exports.
export const LEGACY_DIM_IDS = ['situation', 'anticipated_loss', 'anticipated_benefit', 'stated_reason', 'decision_described', 'reported_outcome', 'evidence_status'];
export const ALL_DIM_IDS = [...DIMENSIONS.map(d => d.id), ...LEGACY_DIM_IDS];
export const PROMPTS = ['general', 'social'].flatMap(domain => ['self', 'other'].flatMap(perspective => ['approach', 'avoid'].map(direction => {
  const id = `${domain}_${perspective}_${direction}`;
  const risk = domain === 'social' ? 'a risk with social consequences (for example, how others view you, group membership, or belongingness)' : 'a risk';
  return { id, domain, perspective, direction,
    label: `${domain === 'general' ? 'General' : 'Social'} · ${perspective === 'self' ? 'Self' : 'Others'} · ${direction === 'approach' ? 'Approach' : 'Avoid'}`,
    text: perspective === 'self' ? `Recall a decision within the past two weeks when you had the choice to take ${risk} or play it safe, and chose to ${direction === 'approach' ? 'take' : 'avoid'} the risk. Describe the decision.` : `Think of a risky decision your peers commonly face involving ${risk}, where you believe most people choose to ${direction === 'approach' ? 'take' : 'avoid'} the risk. Describe the decision.`
  };
})));
export const hash = s => createHash('sha256').update(s).digest('hex');
export const timestamp = () => new Date().toISOString();
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password, encoded) {
  const [salt, digest] = encoded.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, 'hex'));
}
export function openDB(filename = process.env.DB_PATH || resolve('data', 'coding.sqlite')) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','coder')), active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS responses (id TEXT PRIMARY KEY, record_key TEXT NOT NULL, participant_key TEXT NOT NULL, participant_label TEXT NOT NULL, record_number INTEGER NOT NULL, prompt TEXT NOT NULL, domain TEXT NOT NULL, perspective TEXT NOT NULL, direction TEXT NOT NULL, source TEXT NOT NULL, pool TEXT NOT NULL, wave TEXT NOT NULL, complete INTEGER NOT NULL, text TEXT NOT NULL, blank INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_responses_record ON responses(record_number);
    CREATE INDEX IF NOT EXISTS idx_responses_prompt ON responses(prompt, record_number);
    CREATE TABLE IF NOT EXISTS annotations (response_id TEXT NOT NULL REFERENCES responses(id), user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(response_id,user_id));
    CREATE INDEX IF NOT EXISTS idx_annotations_user_status ON annotations(user_id,status);
    CREATE TABLE IF NOT EXISTS codes (id INTEGER PRIMARY KEY, dimension TEXT NOT NULL, name TEXT NOT NULL, definition TEXT NOT NULL, include_rule TEXT NOT NULL, exclude_rule TEXT NOT NULL, example TEXT NOT NULL, status TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES users(id), version INTEGER NOT NULL, updated TEXT NOT NULL, UNIQUE(dimension,name));
    CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), version INTEGER NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, digest TEXT NOT NULL, records INTEGER NOT NULL, imported TEXT NOT NULL);
  `);
  if (!db.prepare("PRAGMA table_info(codes)").all().some(c => c.name === "family")) db.exec("ALTER TABLE codes ADD COLUMN family TEXT NOT NULL DEFAULT ''");
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function parseCSV(input) {
  const rows = []; let row = [], field = '', quoted = false;
  input = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field === '') quoted = !quoted;
      else throw new Error('Invalid CSV quotation.');
    } else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quotation.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift();
  if (!headers || new Set(headers).size !== headers.length) throw new Error('CSV headers missing or duplicated.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV record ${index + 1} has a different column count.`);
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}
export function importCSV(db, path) {
  const text = readFileSync(path, 'utf8'), rows = parseCSV(text);
  if (!rows.length) throw new Error('CSV contains no records.');
  for (const field of ['analysis_response_key', 'participant_key', 'survey_source', 'pool', 'collection_wave_verified', 'response_complete', ...PROMPTS.map(p => p.id)]) {
    if (!(field in rows[0])) throw new Error(`Missing harmonized column: ${field}`);
  }
  return transaction(db, () => {
    const existingKeys = new Map(db.prepare('SELECT record_key, record_number, participant_key, participant_label FROM responses GROUP BY record_key').all().map(r => [r.record_key, r]));
    const participantLabels = new Map([...existingKeys.values()].filter(r => r.participant_key).map(r => [r.participant_key, r.participant_label]));
    let recordNumber = Math.max(0, ...[...existingKeys.values()].map(r => r.record_number));
    let personNumber = Math.max(0, ...[...participantLabels.values()].map(s => Number(s.slice(1))));
    const seen = new Set(); let added = 0;
    const insert = db.prepare('INSERT INTO responses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of rows) {
      const key = row.analysis_response_key;
      if (!key || seen.has(key)) throw new Error('Missing or duplicated response key. Import cancelled.');
      seen.add(key);
      const existing = existingKeys.get(key);
      const ordinal = existing?.record_number ?? ++recordNumber;
      if (row.participant_key && !participantLabels.has(row.participant_key)) participantLabels.set(row.participant_key, `P${String(++personNumber).padStart(3, '0')}`);
      const label = row.participant_key ? participantLabels.get(row.participant_key) : `Unknown · record ${ordinal}`;
      for (const prompt of PROMPTS) {
        const value = row[prompt.id];
        if (value === 'NA_STRUCTURAL') throw new Error('Risk columns must be harmonized before import.');
        const response = [key + ':' + prompt.id, key, row.participant_key, label, ordinal, prompt.id, prompt.domain, prompt.perspective, prompt.direction, row.survey_source, row.pool, row.collection_wave_verified, row.response_complete === '1' ? 1 : 0, value, value.trim() ? 0 : 1];
        const prior = db.prepare('SELECT * FROM responses WHERE id=?').get(response[0]);
        if (prior) {
          if (JSON.stringify(Object.values(prior)) !== JSON.stringify(response)) throw new Error('An existing response changed. Import cancelled to protect linked annotations.');
        } else { insert.run(...response); added++; }
      }
    }
    db.prepare('INSERT INTO imports(filename,digest,records,imported) VALUES (?,?,?,?)').run(path.split(/[\\/]/).pop(), hash(text), rows.length, timestamp());
    return { records: rows.length, added, responses: db.prepare('SELECT count(*) n FROM responses').get().n };
  });
}
export function addUser(db, username, name, password, role = 'coder') {
  if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) throw new Error('Username must have 3–50 letters, numbers, dots, underscores or hyphens.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error('Use a password with 12–200 characters.');
  if (!['coder', 'admin'].includes(role)) throw new Error('Invalid role.');
  return db.prepare('INSERT INTO users(username,name,password,role) VALUES (?,?,?,?)').run(username.toLowerCase(), name.trim() || username, passwordHash(password), role).lastInsertRowid;
}
export function csvExport(rows, fields) {
  const cell = value => {
    let s = String(value ?? '');
    // Prevent a spreadsheet from interpreting participant text as a formula.
    if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [fields, ...rows.map(row => fields.map(f => row[f]))].map(r => r.map(cell).join(',')).join('\r\n');
}
