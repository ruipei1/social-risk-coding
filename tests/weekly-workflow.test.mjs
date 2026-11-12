import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDB, addUser } from '../model.mjs';
import {
  migrationPreview, activateWeeklyMigration, ensureReleasedWeeks, weeklyDashboard,
  adminWeeklyOverview, updateWeeklySettings, addWeeklyBreak, removeWeeklyBreak
} from '../weekly-workflow.mjs';

const payload = JSON.stringify({ response_quality:'substantive', dimensions:{}, memos:{} });

function setup(count = 1000) {
  const db = openDB(':memory:');
  const admin = Number(addUser(db, 'weekly-admin', 'Weekly Admin', 'weekly-admin-password', 'admin'));
  const ras = [
    ['joyce','Joyce'], ['liqing','Liqing'], ['mcamposgort','Melissa Campos']
  ].map(([username,name]) => ({ id:Number(addUser(db, username, name, `${username}-weekly-password`, 'coder')), username, name }));
  const insert = db.prepare(`INSERT INTO responses
    (id,record_key,participant_key,participant_label,record_number,prompt,domain,perspective,direction,source,pool,wave,complete,text,blank)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= count; i++) insert.run(
    `response-${i}`, `record-${Math.ceil(i / 8)}`, `person-${Math.ceil(i / 8)}`, `P${String(Math.ceil(i / 8)).padStart(3,'0')}`,
    Math.ceil(i / 8), 'general_self_approach', 'general', 'self', 'approach', 'source', 'pool', 'wave', 1, `Response ${i}`, 0
  );
  return { db, admin, ras, sourceBatch:db.prepare('SELECT id FROM coding_batches WHERE active=1').get().id };
}

function complete(db, responseId, userId, batchId) {
  db.prepare('INSERT INTO annotations(response_id,user_id,batch_id,status,payload,version,updated) VALUES (?,?,?,?,?,?,?)')
    .run(responseId, userId, batchId, 'complete', payload, 1, '2026-11-01T00:00:00.000Z');
}

test('migration preview preserves the newest completed batch and requires confirmation when the newest batch is empty', () => {
  const s = setup(30); try {
    complete(s.db, 'response-1', s.ras[0].id, s.sourceBatch);
    complete(s.db, 'response-2', s.ras[1].id, s.sourceBatch);
    s.db.prepare('INSERT INTO annotations(response_id,user_id,batch_id,status,payload,version,updated) VALUES (?,?,?,?,?,?,?)')
      .run('response-3',s.ras[2].id,s.sourceBatch,'draft',payload,1,'2026-11-01T00:00:00Z');
    s.db.prepare('UPDATE coding_batches SET active=0').run();
    s.db.prepare("INSERT INTO coding_batches(name,start_participant,start_record_number,active,created) VALUES ('Empty newest round','',1,1,'2026-11-11')").run();
    const preview = migrationPreview(s.db);
    assert.equal(preview.ambiguous, true);
    assert.equal(preview.selected_batch_id, s.sourceBatch);
    assert.equal(preview.exempt_latest_completed, 2);
    assert.equal(preview.older_coded_requiring_recode, 1);
    assert.equal(preview.never_coded_responses, 27);
    assert.equal(preview.total_remaining, 28);
    assert.equal(preview.exempt_latest_completed + preview.older_coded_requiring_recode + preview.never_coded_responses, preview.total_responses);
    assert.match(preview.ambiguity_reason, /no completed readings/);
  } finally { s.db.close(); }
});

test('weekly migration is repeatable and never deletes historical coding', () => {
  const s = setup(40); try {
    complete(s.db, 'response-1', s.ras[0].id, s.sourceBatch);
    const preview = migrationPreview(s.db, s.sourceBatch);
    const first = activateWeeklyMigration(s.db, { sourceBatchId:s.sourceBatch, previewKey:preview.preview_key, userId:s.admin });
    const second = activateWeeklyMigration(s.db, { sourceBatchId:s.sourceBatch, previewKey:preview.preview_key, userId:s.admin });
    assert.equal(first.already_applied, false);
    assert.equal(second.already_applied, true);
    assert.equal(s.db.prepare('SELECT count(*) n FROM weekly_migrations').get().n, 1);
    assert.equal(s.db.prepare('SELECT count(*) n FROM annotations').get().n, 1);
    assert.equal(s.db.prepare('SELECT status FROM annotations WHERE response_id=?').get('response-1').status, 'complete');
  } finally { s.db.close(); }
});

test('disk migration creates a readable backup before changing the active round', () => {
  const folder=mkdtempSync(join(tmpdir(),'weekly-backup-test-')),path=join(folder,'coding.sqlite');
  const db=openDB(path);try{
    const admin=Number(addUser(db,'backup-admin','Backup Admin','backup-admin-password','admin'));
    for(const [username,name] of [['joyce','Joyce'],['liqing','Liqing'],['mcamposgort','Melissa Campos']]) addUser(db,username,name,`${username}-backup-password`);
    db.prepare(`INSERT INTO responses(id,record_key,participant_key,participant_label,record_number,prompt,domain,perspective,direction,source,pool,wave,complete,text,blank)
      VALUES ('backup-response','backup-record','backup-person','P001',1,'general_self_approach','general','self','approach','source','pool','wave',1,'Backup response',0)`).run();
    const source=db.prepare('SELECT id FROM coding_batches WHERE active=1').get().id,preview=migrationPreview(db,source);
    const result=activateWeeklyMigration(db,{sourceBatchId:source,previewKey:preview.preview_key,userId:admin});
    assert.ok(result.backup_path);assert.ok(existsSync(result.backup_path));
    const backup=new DatabaseSync(result.backup_path);try{
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(backup.prepare('SELECT count(*) n FROM responses').get().n,1);
      assert.equal(backup.prepare('SELECT count(*) n FROM weekly_migrations').get().n,0);
    }finally{backup.close();}
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});

test('an active week assigns exactly 150 unique responses to each RA without overlap', () => {
  const s = setup(); try {
    for (let i = 1; i <= 10; i++) complete(s.db, `response-${i}`, s.ras[i % 3].id, s.sourceBatch);
    const preview = migrationPreview(s.db, s.sourceBatch);
    activateWeeklyMigration(s.db, { sourceBatchId:s.sourceBatch, previewKey:preview.preview_key, userId:s.admin });
    ensureReleasedWeeks(s.db, new Date('2026-11-22T17:00:00Z'));
    const rows = s.db.prepare('SELECT user_id,count(*) n,count(DISTINCT response_id) unique_n FROM weekly_assignments GROUP BY user_id ORDER BY user_id').all();
    assert.deepEqual(rows.map(row => row.n), [150,150,150]);
    assert.ok(rows.every(row => row.n === row.unique_n));
    assert.equal(s.db.prepare('SELECT count(*) n FROM weekly_assignments').get().n, 450);
    assert.equal(s.db.prepare('SELECT count(DISTINCT response_id) n FROM weekly_assignments').get().n, 450);
    assert.equal(s.db.prepare("SELECT count(*) n FROM weekly_assignments WHERE response_id IN ('response-1','response-2','response-3','response-4','response-5','response-6','response-7','response-8','response-9','response-10')").get().n, 0);
    ensureReleasedWeeks(s.db, new Date('2026-11-22T22:00:00Z'));
    assert.equal(s.db.prepare('SELECT count(*) n FROM weekly_assignments').get().n, 450);
  } finally { s.db.close(); }
});

test('breaks release no work and incomplete assignments carry into the next active week', () => {
  const s = setup(); try {
    const preview = migrationPreview(s.db, s.sourceBatch);
    const migration = activateWeeklyMigration(s.db, { sourceBatchId:s.sourceBatch, previewKey:preview.preview_key, userId:s.admin });
    ensureReleasedWeeks(s.db, new Date('2026-11-22T17:00:00Z'));
    const joyceAssignments = s.db.prepare('SELECT response_id FROM weekly_assignments WHERE user_id=? ORDER BY response_id').all(s.ras[0].id);
    for (const row of joyceAssignments.slice(0, 110)) complete(s.db, row.response_id, s.ras[0].id, migration.weekly_batch_id);
    ensureReleasedWeeks(s.db, new Date('2026-11-29T17:00:00Z'));
    assert.equal(s.db.prepare("SELECT status FROM coding_weeks WHERE week_start='2026-11-23'").get().status, 'break');
    assert.equal(s.db.prepare('SELECT count(*) n FROM weekly_assignments').get().n, 450);
    ensureReleasedWeeks(s.db, new Date('2026-12-06T17:00:00Z'));
    const dashboard = weeklyDashboard(s.db, s.ras[0].id, new Date('2026-12-03T17:00:00Z'));
    assert.equal(dashboard.carryover, 40);
    assert.equal(dashboard.weeks.find(week => week.week_start === '2026-11-30').assigned, 150);
    assert.equal(dashboard.overall.assigned, 300);
    assert.equal(dashboard.overall.complete, 110);
  } finally { s.db.close(); }
});

test('future quota changes leave existing weeks unchanged and affect only later releases', () => {
  const s = setup(); try {
    const preview = migrationPreview(s.db, s.sourceBatch);
    activateWeeklyMigration(s.db, { sourceBatchId:s.sourceBatch, previewKey:preview.preview_key, userId:s.admin });
    ensureReleasedWeeks(s.db, new Date('2026-11-22T17:00:00Z'));
    updateWeeklySettings(s.db, { default_quota:100, start_date:'2026-11-16' });
    assert.equal(s.db.prepare('SELECT start_date FROM weekly_settings').get().start_date,'2026-11-16');
    ensureReleasedWeeks(s.db, new Date('2026-12-06T17:00:00Z'));
    const weeks = s.db.prepare("SELECT week_start,quota,status FROM coding_weeks ORDER BY week_start").all().map(row => ({ ...row }));
    assert.deepEqual(weeks, [
      { week_start:'2026-11-16', quota:150, status:'released' },
      { week_start:'2026-11-23', quota:100, status:'break' },
      { week_start:'2026-11-30', quota:100, status:'released' }
    ]);
    const second = s.db.prepare("SELECT count(*) n FROM weekly_assignments wa JOIN coding_weeks w ON w.id=wa.week_id WHERE w.week_start='2026-11-30'").get().n;
    assert.equal(second, 300);
  } finally { s.db.close(); }
});

test('calendar breaks are editable until they affect the released audit record', () => {
  const s = setup(20); try {
    const added = addWeeklyBreak(s.db, { label:'Lab closure', start_date:'2027-02-01', end_date:'2027-02-07', userId:s.admin });
    removeWeeklyBreak(s.db, added.id);
    assert.equal(s.db.prepare('SELECT count(*) n FROM weekly_breaks WHERE id=?').get(added.id).n, 0);
    assert.throws(() => addWeeklyBreak(s.db, { label:'Broken', start_date:'2027-02-09', end_date:'2027-02-01', userId:s.admin }), /valid break/);
  } finally { s.db.close(); }
});

test('admin overview never reports more current completions than unique responses', () => {
  const s = setup(12); try {
    for (let i = 1; i <= 4; i++) {
      complete(s.db, `response-${i}`, s.ras[0].id, s.sourceBatch);
      if (i <= 2) complete(s.db, `response-${i}`, s.ras[1].id, s.sourceBatch);
    }
    const preview = migrationPreview(s.db, s.sourceBatch);
    activateWeeklyMigration(s.db, { sourceBatchId:s.sourceBatch, previewKey:preview.preview_key, userId:s.admin });
    const overview = adminWeeklyOverview(s.db, new Date('2026-11-12T17:00:00Z'));
    assert.equal(overview.total_responses, 12);
    assert.equal(overview.completed_responses, 4);
    assert.equal(overview.remaining_responses, 8);
    assert.ok(overview.completed_responses <= overview.total_responses);
  } finally { s.db.close(); }
});
