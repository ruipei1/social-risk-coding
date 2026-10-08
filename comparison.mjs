import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIMENSIONS } from './model.mjs';
import { observationsText } from './public/memos.js';

// Compare saved code-ID sets, never label text, order, or unread placeholders.
export function compareReadings(readings, { includeDrafts = false } = {}) {
  const eligible = readings.filter(r => r.saved && (includeDrafts || r.status === 'complete'));
  const fields = {};
  for (const { id } of DIMENSIONS) {
    const sets = eligible.map(r => [...new Set(r.dimensions[id].map(c => c.id))].sort((a,b) => a-b));
    const union = [...new Set(sets.flat())];
    fields[id] = { differs: sets.length >= 2 && new Set(sets.map(JSON.stringify)).size > 1,
      differingIds: sets.length < 2 ? [] : union.filter(id => !sets.every(s => s.includes(id))) };
  }
  fields.response_quality = { differs: eligible.length >= 2 && new Set(eligible.map(r => r.response_quality)).size > 1 };
  const disagreement = Object.values(fields).some(f => f.differs);
  return { fields, eligibleCoderIds: eligible.map(r => r.coder_id),
    result: eligible.length < 2 ? 'insufficient' : disagreement ? 'disagreement' : 'consistent',
    observationsDiffer: eligible.length >= 2 && new Set(eligible.map(r => r.observations)).size > 1,
    missing: readings.filter(r => !r.saved).length,
    unfinished: readings.filter(r => r.saved && r.status !== 'complete').length,
    noLabels: eligible.length >= 2 && eligible.every(r => DIMENSIONS.every(d => r.dimensions[d.id].length === 0)) };
}

export function comparisonUsers(db, batchId = null) {
  batchId ??= db.prepare('SELECT id FROM coding_batches WHERE active=1').get()?.id;
  return db.prepare('SELECT id,username,name,active FROM users WHERE active=1 OR id IN (SELECT user_id FROM annotations WHERE batch_id=?) ORDER BY id').all(batchId).map(user => ({ ...user, active:!!user.active }));
}

export function comparisonData(db, options = {}) {
  const batchId = options.batchId ?? db.prepare('SELECT id FROM coding_batches WHERE active=1').get()?.id;
  const allUsers = comparisonUsers(db, batchId), selectedIds = options.coderIds == null ? null : new Set(options.coderIds);
  const users = selectedIds == null ? allUsers : allUsers.filter(user => selectedIds.has(user.id));
  const userWhere = selectedIds == null ? '' : ` AND user_id IN (${users.map(() => '?').join(',')})`;
  const userArgs = selectedIds == null ? [] : users.map(user => user.id);
  const codes = new Map(db.prepare('SELECT id,dimension,name,family,status FROM codes').all().map(c => [c.id,c]));
  const saved = db.prepare(`SELECT * FROM annotations WHERE batch_id=?${userWhere} ORDER BY response_id,user_id`).all(batchId,...userArgs);
  const byResponse = new Map();
  for (const a of saved) {
    if (!byResponse.has(a.response_id)) byResponse.set(a.response_id, new Map());
    byResponse.get(a.response_id).set(a.user_id,a);
  }
  const annotationWhere = selectedIds == null ? '' : ` AND user_id IN (${users.map(() => '?').join(',')})`;
  const responses = db.prepare(`SELECT id,participant_label,prompt,text FROM responses WHERE id IN (SELECT response_id FROM annotations WHERE batch_id=?${annotationWhere}) ORDER BY record_number,rowid`).all(batchId,...userArgs);
  return responses.map(response => {
    const readings = users.map(u => {
      const a = byResponse.get(response.id).get(u.id);
      const base = { coder_id:u.id, username:u.username, name:u.name, active:!!u.active, saved:!!a };
      if (!a) return { ...base, status:'unread' };
      const p = JSON.parse(a.payload);
      const dimensions = Object.fromEntries(DIMENSIONS.map(d => [d.id, (p.dimensions?.[d.id]?.codes || []).map(id => codes.get(id) || {id,name:`Unknown code ${id}`,dimension:d.id,family:'',status:'unknown'})]));
      return { ...base, status:a.status, response_quality:p.response_quality, dimensions, observations:observationsText(p.memos), version:a.version, updated:a.updated };
    });
    return { response, readings, ...compareReadings(readings,options) };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0] || args[0].startsWith('--') || args.slice(1).some(a => a !== '--include-drafts')) {
    console.error('Usage: node comparison.mjs DATABASE.sqlite [--include-drafts]');
    process.exitCode = 1;
  } else {
    let db;
    try {
      db = new DatabaseSync(resolve(args[0]), {readOnly:true});
      console.log(JSON.stringify(comparisonData(db,{includeDrafts:args.includes('--include-drafts')}),null,2));
    } catch(error) { console.error('Comparison failed:',error.message); process.exitCode=1; }
    finally { db?.close(); }
  }
}
