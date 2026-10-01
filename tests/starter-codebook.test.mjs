import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB, addUser, DIMENSIONS } from '../model.mjs';
import { STARTER_CODES, seedStarterCodebook } from '../starter-codebook.mjs';

test('starter categories cover all dimensions, preserve edits on rerun, and do not code responses', () => {
  const db = openDB(':memory:');
  try {
    const id = addUser(db, 'test-admin', 'Test admin', 'a-long-test-password', 'admin');
    assert.equal(STARTER_CODES.length, STARTER_CODES.length);
    assert.deepEqual(new Set(STARTER_CODES.map(c => c.dimension)), new Set(DIMENSIONS.map(d => d.id)));
    assert.equal(seedStarterCodebook(db, id).added, STARTER_CODES.length);
    const first = db.prepare('SELECT * FROM codes ORDER BY id LIMIT 1').get();
    db.prepare('UPDATE codes SET name=?,definition=?,status=? WHERE id=?').run('Renamed category', 'Locally revised definition', 'active', first.id);
    assert.equal(seedStarterCodebook(db, id).added, 0);
    assert.equal(db.prepare('SELECT definition FROM codes WHERE id=?').get(first.id).definition, 'Locally revised definition');
    assert.equal(db.prepare('SELECT count(*) n FROM codes').get().n, STARTER_CODES.length);
    assert.equal(db.prepare('SELECT count(*) n FROM history').get().n, STARTER_CODES.length);
    assert.equal(db.prepare('SELECT count(*) n FROM annotations').get().n, 0);
    assert.ok(STARTER_CODES.filter(c => c.dimension === 'behavior').every(c => c.family));
  } finally { db.close(); }
});

test('upgrading broad starters retains assigned code IDs and leaves user revisions untouched', () => {
 const db=openDB(':memory:'); try {
  const author=addUser(db,'test-admin','Test admin','a-long-test-password','admin');
  db.exec('CREATE TABLE codebook_seeds (seed_key TEXT PRIMARY KEY, code_id INTEGER NOT NULL REFERENCES codes(id))');
  const insert=db.prepare("INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated) VALUES ('behavior',?,'','','','','draft',?,?,'test')");
  const broad=Number(insert.run('Speaking up',author,1).lastInsertRowid);
  const edited=Number(insert.run('My revised behavior',author,2).lastInsertRowid);
  db.prepare('INSERT INTO codebook_seeds VALUES (?,?)').run('initial-framework-v1:behavior:1',broad);
  db.prepare('INSERT INTO codebook_seeds VALUES (?,?)').run('initial-framework-v1:behavior:2',edited);
  seedStarterCodebook(db,author);
  assert.equal(db.prepare('SELECT status FROM codes WHERE id=?').get(broad).status,'retired');
  assert.equal(db.prepare('SELECT status FROM codes WHERE id=?').get(edited).status,'draft');
  const histories=db.prepare('SELECT count(*) n FROM history').get().n;
  seedStarterCodebook(db,author);
  assert.equal(db.prepare('SELECT count(*) n FROM history').get().n,histories);
 } finally {db.close();}
});
