import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const timestamp = () => new Date().toISOString();
const transaction = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};

export const WEEKLY_TIMEZONE = 'America/New_York';
export const WEEKLY_RAS = ['joyce', 'liqing', 'mcamposgort'];
export const DEFAULT_WEEKLY_QUOTA = 150;

const iso = date => date.toISOString().slice(0, 10);
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const parseDate = value => new Date(`${value}T12:00:00.000Z`);

export function localDateISO(now = new Date(), timeZone = WEEKLY_TIMEZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function mondayFor(dateISO) {
  const date = parseDate(dateISO), day = date.getUTCDay();
  return iso(addDays(date, day === 0 ? -6 : 1 - day));
}

export function initializeWeeklySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      timezone TEXT NOT NULL,
      default_quota INTEGER NOT NULL CHECK(default_quota>0 AND default_quota<=1000),
      paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
      start_date TEXT NOT NULL,
      allocation_seed TEXT NOT NULL,
      source_batch_id INTEGER REFERENCES coding_batches(id),
      weekly_batch_id INTEGER REFERENCES coding_batches(id),
      migration_key TEXT,
      migrated_at TEXT,
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weekly_breaks (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created TEXT NOT NULL,
      UNIQUE(label,start_date,end_date)
    );
    CREATE TABLE IF NOT EXISTS coding_weeks (
      id INTEGER PRIMARY KEY,
      week_start TEXT UNIQUE NOT NULL,
      week_end TEXT NOT NULL,
      sequence INTEGER,
      quota INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('released','break')),
      released_at TEXT,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weekly_assignments (
      response_id TEXT PRIMARY KEY REFERENCES responses(id),
      week_id INTEGER NOT NULL REFERENCES coding_weeks(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      assigned_at TEXT NOT NULL,
      reassigned_by INTEGER REFERENCES users(id),
      reassigned_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_assignments_user_week ON weekly_assignments(user_id,week_id);
    CREATE TABLE IF NOT EXISTS weekly_migrations (
      id INTEGER PRIMARY KEY,
      migration_key TEXT UNIQUE NOT NULL,
      source_batch_id INTEGER NOT NULL REFERENCES coding_batches(id),
      weekly_batch_id INTEGER NOT NULL REFERENCES coding_batches(id),
      backup_path TEXT,
      summary TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT OR IGNORE INTO weekly_settings
    (id,timezone,default_quota,paused,start_date,allocation_seed,updated)
    VALUES (1,?,?,?,?,?,?)`).run(WEEKLY_TIMEZONE, DEFAULT_WEEKLY_QUOTA, 0, '2026-11-16', 'social-risk-weekly-v1', timestamp());
  const seedBreak = db.prepare('INSERT OR IGNORE INTO weekly_breaks(label,start_date,end_date,created) VALUES (?,?,?,?)');
  for (const row of [
    ['Thanksgiving break', '2026-11-23', '2026-11-29'],
    ['Winter break', '2026-12-07', '2027-01-10'],
    ['Spring break', '2027-03-13', '2027-03-20']
  ]) seedBreak.run(...row, timestamp());
}

export function weeklySettings(db) {
  return db.prepare('SELECT * FROM weekly_settings WHERE id=1').get();
}

function countForBatch(db, batchId, status = null) {
  return db.prepare(`SELECT count(DISTINCT response_id) n FROM annotations WHERE batch_id=?${status ? ' AND status=?' : ''}`)
    .get(...(status ? [batchId, status] : [batchId])).n;
}

export function migrationPreview(db, sourceBatchId = null) {
  const batches = db.prepare(`
    SELECT b.id,b.name,b.active,b.created,
      count(DISTINCT a.response_id) saved_responses,
      count(DISTINCT CASE WHEN a.status='complete' THEN a.response_id END) completed_responses
    FROM coding_batches b LEFT JOIN annotations a ON a.batch_id=b.id
    GROUP BY b.id ORDER BY b.id DESC`).all();
  const latest = batches[0] || null;
  const suggested = batches.find(batch => batch.completed_responses > 0) || latest;
  const selected = sourceBatchId == null ? suggested : batches.find(batch => batch.id === Number(sourceBatchId));
  if (!selected) throw new Error('Choose an existing coding batch to preserve.');
  const total = db.prepare('SELECT count(*) n FROM responses WHERE blank=0').get().n;
  const exempt = countForBatch(db, selected.id, 'complete');
  const codedElsewhere = db.prepare(`
    SELECT count(DISTINCT r.id) n FROM responses r
    JOIN annotations a ON a.response_id=r.id
    WHERE r.blank=0 AND NOT EXISTS (
      SELECT 1 FROM annotations keep WHERE keep.response_id=r.id AND keep.batch_id=? AND keep.status='complete'
    )`).get(selected.id).n;
  const neverCoded = db.prepare(`SELECT count(*) n FROM responses r WHERE r.blank=0
    AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.response_id=r.id)`).get().n;
  const remaining = total - exempt;
  const settings = weeklySettings(db);
  const key = createHash('sha256').update(JSON.stringify({ source:selected.id,total,exempt,remaining,quota:settings.default_quota })).digest('hex');
  return {
    batches, latest_batch_id: latest?.id || null, suggested_batch_id: suggested?.id || null,
    selected_batch_id: selected.id,
    ambiguous: !!(latest && suggested && latest.id !== suggested.id),
    ambiguity_reason: latest && suggested && latest.id !== suggested.id
      ? `The newest batch, ${latest.name}, has no completed readings; ${suggested.name} is the newest batch with completed work.` : '',
    total_responses: total,
    exempt_latest_completed: exempt,
    older_coded_requiring_recode: codedElsewhere,
    never_coded_responses: neverCoded,
    total_remaining: remaining,
    proposed_per_ra: WEEKLY_RAS.map(username => ({ username, responses: Math.floor(remaining / 3) + (WEEKLY_RAS.indexOf(username) < remaining % 3 ? 1 : 0) })),
    weekly_quota: settings.default_quota,
    estimated_active_weeks: Math.ceil(remaining / (settings.default_quota * WEEKLY_RAS.length)),
    preview_key: key
  };
}

function backupDatabase(db) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!file) return null;
  const folder = join(dirname(file), 'backups');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const safeTime = timestamp().replaceAll(':', '-').replaceAll('.', '-');
  const path = join(folder, `coding-before-weekly-${safeTime}.sqlite`);
  db.prepare('VACUUM INTO ?').run(path);
  return path;
}

export function activateWeeklyMigration(db, { sourceBatchId, previewKey, userId }) {
  const preview = migrationPreview(db, sourceBatchId);
  if (preview.preview_key !== previewKey) throw new Error('The migration preview is stale. Review the counts again.');
  const existing = db.prepare('SELECT * FROM weekly_migrations WHERE migration_key=?').get(previewKey);
  if (existing) return { already_applied:true, ...existing, summary:JSON.parse(existing.summary) };
  const settings = weeklySettings(db);
  if (settings.migrated_at) throw new Error('Weekly coding has already been activated.');
  const backupPath = backupDatabase(db);
  const created = timestamp();
  let weeklyBatchId;
  transaction(db, () => {
    db.prepare('UPDATE coding_batches SET active=0 WHERE active=1').run();
    const nameBase = 'Weekly coding';
    let name = nameBase, suffix = 1;
    while (db.prepare('SELECT id FROM coding_batches WHERE name=?').get(name)) name = `${nameBase} ${++suffix}`;
    weeklyBatchId = Number(db.prepare(`INSERT INTO coding_batches
      (name,start_participant,start_record_number,active,created_by,created) VALUES (?,?,?,?,?,?)`)
      .run(name, '', 1, 1, userId, created).lastInsertRowid);
    db.prepare(`UPDATE weekly_settings SET source_batch_id=?,weekly_batch_id=?,migration_key=?,migrated_at=?,updated=? WHERE id=1`)
      .run(preview.selected_batch_id, weeklyBatchId, previewKey, created, created);
    db.prepare(`INSERT INTO weekly_migrations
      (migration_key,source_batch_id,weekly_batch_id,backup_path,summary,created_by,created) VALUES (?,?,?,?,?,?,?)`)
      .run(previewKey, preview.selected_batch_id, weeklyBatchId, backupPath, JSON.stringify(preview), userId, created);
    db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)')
      .run('weekly_migration', previewKey, userId, 1, JSON.stringify({ ...preview, backup_path:backupPath, weekly_batch_id:weeklyBatchId }), created);
  });
  return { already_applied:false, weekly_batch_id:weeklyBatchId, backup_path:backupPath, summary:preview };
}

function weekOverlapsBreak(db, start, end) {
  return db.prepare('SELECT * FROM weekly_breaks WHERE start_date<=? AND end_date>=? ORDER BY start_date LIMIT 1').get(end, start) || null;
}

function activeRAs(db) {
  const rows = db.prepare(`SELECT id,username,name FROM users WHERE active=1 AND username IN (${WEEKLY_RAS.map(() => '?').join(',')})`).all(...WEEKLY_RAS);
  const byName = new Map(rows.map(row => [row.username, row]));
  const ordered = WEEKLY_RAS.map(name => byName.get(name)).filter(Boolean);
  if (ordered.length !== WEEKLY_RAS.length) throw new Error('Joyce, Liqing, and Melissa must all have active accounts before weekly assignments can be released.');
  return ordered;
}

function releaseWeek(db, weekStart) {
  const settings = weeklySettings(db), weekEnd = iso(addDays(parseDate(weekStart), 6));
  const existing = db.prepare('SELECT * FROM coding_weeks WHERE week_start=?').get(weekStart);
  if (existing) return existing;
  const breakRow = weekOverlapsBreak(db, weekStart, weekEnd), created = timestamp();
  let weekId;
  transaction(db, () => {
    if (breakRow) {
      weekId = Number(db.prepare(`INSERT INTO coding_weeks(week_start,week_end,quota,status,created) VALUES (?,?,?,?,?)`)
        .run(weekStart, weekEnd, settings.default_quota, 'break', created).lastInsertRowid);
      return;
    }
    const sequence = db.prepare("SELECT count(*) n FROM coding_weeks WHERE status='released'").get().n + 1;
    weekId = Number(db.prepare(`INSERT INTO coding_weeks(week_start,week_end,sequence,quota,status,released_at,created) VALUES (?,?,?,?,?,?,?)`)
      .run(weekStart, weekEnd, sequence, settings.default_quota, 'released', created, created).lastInsertRowid);
    const ras = activeRAs(db);
    const assignedCounts = new Map(db.prepare('SELECT user_id,count(*) n FROM weekly_assignments GROUP BY user_id').all().map(row => [row.user_id, row.n]));
    ras.sort((a, b) => (assignedCounts.get(a.id) || 0) - (assignedCounts.get(b.id) || 0) || a.username.localeCompare(b.username));
    const candidates = db.prepare(`SELECT r.id FROM responses r WHERE r.blank=0
      AND NOT EXISTS (SELECT 1 FROM weekly_assignments wa WHERE wa.response_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.response_id=r.id AND a.batch_id=? AND a.status='complete')
      ORDER BY r.record_number,r.rowid`).all(settings.source_batch_id);
    candidates.sort((a, b) => createHash('sha256').update(settings.allocation_seed + a.id).digest('hex')
      .localeCompare(createHash('sha256').update(settings.allocation_seed + b.id).digest('hex')));
    const capacity = settings.default_quota * ras.length, selected = candidates.slice(0, capacity);
    const insert = db.prepare('INSERT INTO weekly_assignments(response_id,week_id,user_id,assigned_at) VALUES (?,?,?,?)');
    const perRA = new Map(ras.map(ra => [ra.id, 0]));
    for (let i = 0; i < selected.length; i++) {
      const available = ras.filter(ra => perRA.get(ra.id) < settings.default_quota);
      const ra = available[i % available.length];
      insert.run(selected[i].id, weekId, ra.id, created);
      perRA.set(ra.id, perRA.get(ra.id) + 1);
    }
  });
  return db.prepare('SELECT * FROM coding_weeks WHERE id=?').get(weekId);
}

export function ensureReleasedWeeks(db, now = new Date()) {
  const settings = weeklySettings(db);
  if (!settings.migrated_at || settings.paused) return [];
  const currentMonday = mondayFor(localDateISO(now, settings.timezone));
  if (currentMonday < settings.start_date) return [];
  const released = [];
  for (let day = mondayFor(settings.start_date); day <= currentMonday; day = iso(addDays(parseDate(day), 7))) released.push(releaseWeek(db, day));
  return released;
}

function assignmentCounts(db, userId, weeklyBatchId, weekId = null) {
  const args = [weeklyBatchId, userId], clause = weekId ? ' AND wa.week_id=?' : '';
  if (weekId) args.push(weekId);
  return db.prepare(`SELECT count(*) assigned,
    COALESCE(sum(COALESCE(a.status,'unread')='complete'),0) complete,
    COALESCE(sum(COALESCE(a.status,'unread')='draft'),0) draft,
    COALESCE(sum(COALESCE(a.status,'unread')='flagged'),0) flagged
    FROM weekly_assignments wa LEFT JOIN annotations a
      ON a.response_id=wa.response_id AND a.user_id=wa.user_id AND a.batch_id=?
    WHERE wa.user_id=?${clause}`).get(...args);
}

export function weeklyDashboard(db, userId, now = new Date()) {
  ensureReleasedWeeks(db, now);
  const settings = weeklySettings(db), today = localDateISO(now, settings.timezone), monday = mondayFor(today);
  const current = db.prepare('SELECT * FROM coding_weeks WHERE week_start=?').get(monday) || null;
  const weeks = settings.weekly_batch_id ? db.prepare(`SELECT w.*,
    count(wa.response_id) assigned,
    sum(COALESCE(a.status,'unread')='complete') complete,
    sum(COALESCE(a.status,'unread')='draft') draft,
    sum(COALESCE(a.status,'unread')='flagged') flagged
    FROM coding_weeks w LEFT JOIN weekly_assignments wa ON wa.week_id=w.id AND wa.user_id=?
    LEFT JOIN annotations a ON a.response_id=wa.response_id AND a.user_id=wa.user_id AND a.batch_id=?
    GROUP BY w.id ORDER BY w.week_start DESC`).all(userId, settings.weekly_batch_id) : [];
  const overall = settings.weekly_batch_id ? assignmentCounts(db, userId, settings.weekly_batch_id) : {assigned:0,complete:0,draft:0,flagged:0};
  const carryover = settings.weekly_batch_id ? db.prepare(`SELECT count(*) n FROM weekly_assignments wa JOIN coding_weeks w ON w.id=wa.week_id
    LEFT JOIN annotations a ON a.response_id=wa.response_id AND a.user_id=wa.user_id AND a.batch_id=?
    WHERE wa.user_id=? AND w.week_start<? AND COALESCE(a.status,'unread')!='complete'`).get(settings.weekly_batch_id, userId, monday).n : 0;
  const next = settings.weekly_batch_id ? db.prepare(`SELECT wa.response_id FROM weekly_assignments wa JOIN coding_weeks w ON w.id=wa.week_id
    LEFT JOIN annotations a ON a.response_id=wa.response_id AND a.user_id=wa.user_id AND a.batch_id=?
    JOIN responses r ON r.id=wa.response_id WHERE wa.user_id=? AND COALESCE(a.status,'unread')!='complete'
    ORDER BY CASE WHEN w.week_start=? THEN 0 ELSE 1 END,w.week_start,r.record_number,r.rowid LIMIT 1`)
    .get(settings.weekly_batch_id, userId, monday) : null;
  const breakRow = weekOverlapsBreak(db, monday, iso(addDays(parseDate(monday), 6)));
  return { settings, today, current_week:current, current_break:breakRow, weeks, overall, carryover, next_response_id:next?.response_id || null, next_week_id:next?.week_id || null };
}

export function adminWeeklyOverview(db, now = new Date()) {
  ensureReleasedWeeks(db, now);
  const settings = weeklySettings(db), total = db.prepare('SELECT count(*) n FROM responses WHERE blank=0').get().n;
  const exempt = settings.source_batch_id ? countForBatch(db, settings.source_batch_id, 'complete') : 0;
  const newlyComplete = settings.weekly_batch_id ? db.prepare("SELECT count(DISTINCT response_id) n FROM annotations WHERE batch_id=? AND status='complete'").get(settings.weekly_batch_id).n : 0;
  const completed = exempt + newlyComplete, remaining = Math.max(0, total - completed);
  const ras = db.prepare(`SELECT id,username,name FROM users WHERE username IN (${WEEKLY_RAS.map(() => '?').join(',')}) ORDER BY id`).all(...WEEKLY_RAS);
  const ra_progress = ras.map(ra => ({ ...ra, ...(settings.weekly_batch_id ? assignmentCounts(db, ra.id, settings.weekly_batch_id) : {assigned:0,complete:0,draft:0,flagged:0}) }));
  return {
    settings, breaks:db.prepare('SELECT * FROM weekly_breaks ORDER BY start_date').all(),
    weeks:db.prepare('SELECT * FROM coding_weeks ORDER BY week_start DESC').all(),
    total_responses:total, completed_responses:completed, remaining_responses:remaining,
    completion_percent:total ? Math.round(completed / total * 1000) / 10 : 0,
    estimated_active_weeks:Math.ceil(remaining / (settings.default_quota * WEEKLY_RAS.length)), ra_progress
  };
}

export function updateWeeklySettings(db, input) {
  const current = weeklySettings(db);
  const quota = input.default_quota == null ? current.default_quota : Number(input.default_quota);
  if (!Number.isInteger(quota) || quota < 1 || quota > 1000) throw new Error('Weekly quota must be between 1 and 1,000.');
  const paused = input.paused == null ? current.paused : input.paused ? 1 : 0;
  const startDate = input.start_date == null ? current.start_date : String(input.start_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('Enter a valid schedule start date.');
  db.prepare('UPDATE weekly_settings SET default_quota=?,paused=?,start_date=?,updated=? WHERE id=1').run(quota, paused, startDate, timestamp());
  return weeklySettings(db);
}

export function addWeeklyBreak(db, { label, start_date, end_date, userId }) {
  if (!label?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end_date || '') || end_date < start_date) throw new Error('Enter a label and a valid break date range.');
  const id = Number(db.prepare('INSERT INTO weekly_breaks(label,start_date,end_date,created_by,created) VALUES (?,?,?,?,?)')
    .run(label.trim(), start_date, end_date, userId, timestamp()).lastInsertRowid);
  return db.prepare('SELECT * FROM weekly_breaks WHERE id=?').get(id);
}

export function removeWeeklyBreak(db, id) {
  const row = db.prepare('SELECT * FROM weekly_breaks WHERE id=?').get(id);
  if (!row) throw new Error('Break not found.');
  const used = db.prepare("SELECT 1 FROM coding_weeks WHERE status='break' AND week_start<=? AND week_end>=? LIMIT 1").get(row.end_date, row.start_date);
  if (used) throw new Error('This break has already affected a released calendar week and must remain in the audit record.');
  db.prepare('DELETE FROM weekly_breaks WHERE id=?').run(id);
}

export function reassignWeeklyResponse(db, { responseId, targetUserId, adminId }) {
  const assignment = db.prepare('SELECT * FROM weekly_assignments WHERE response_id=?').get(responseId);
  if (!assignment) throw new Error('Weekly assignment not found.');
  const settings = weeklySettings(db);
  const saved = db.prepare('SELECT 1 FROM annotations WHERE response_id=? AND batch_id=?').get(responseId, settings.weekly_batch_id);
  if (saved) throw new Error('Started responses cannot be reassigned; preserve the current coding record and review it with the administrator.');
  const target = db.prepare(`SELECT id FROM users WHERE id=? AND active=1 AND username IN (${WEEKLY_RAS.map(() => '?').join(',')})`).get(targetUserId, ...WEEKLY_RAS);
  if (!target) throw new Error('Choose an active research assistant.');
  db.prepare('UPDATE weekly_assignments SET user_id=?,reassigned_by=?,reassigned_at=? WHERE response_id=?').run(targetUserId, adminId, timestamp(), responseId);
  db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)')
    .run('weekly_reassignment', responseId, adminId, 1, JSON.stringify({ from_user_id:assignment.user_id, to_user_id:targetUserId, week_id:assignment.week_id }), timestamp());
}
