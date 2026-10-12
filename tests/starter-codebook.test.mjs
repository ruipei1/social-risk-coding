import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB, addUser, DIMENSIONS } from '../model.mjs';
import { STARTER_CODES, seedStarterCodebook } from '../starter-codebook.mjs';

test('starter categories cover all dimensions, preserve edits on rerun, and do not code responses', () => {
  const db = openDB(':memory:');
  try {
    const id = addUser(db, 'test-admin', 'Test admin', 'a-long-test-password', 'admin');
    assert.equal(STARTER_CODES.length, 67);
    assert.deepEqual(new Set(STARTER_CODES.map(c => c.dimension)), new Set(DIMENSIONS.map(d => d.id)));
    const behaviors = new Set(STARTER_CODES.filter(c => c.dimension === 'behavior').map(c => c.name));
    for (const name of [
      'Joining a new social group or club',
      'Reaching out to someone new',
      'Taking up a challenge',
      'Trying something new',
      'Sharing opinions',
      'Sharing something personal',
      'Resisting social pressure',
      'Disagreeing with others',
      'Asking for help or a favor',
      'Raising an interpersonal concern or requesting a change in behavior',
      'Ending a relationship or leaving a group',
      'Insulting someone or making potentially offensive jokes',
      'Using AI',
      'Not going to social events'
    ]) assert.ok(behaviors.has(name), `missing revised behavior: ${name}`);
    for (const name of [
      'Approaching an unfamiliar group',
      'Joining a group or club',
      'Sharing an opinion',
      'Performing in front of others',
      'Discussing political or religious beliefs',
      'Sharing personal feelings',
      'Sharing personal struggles',
      'Asking someone on a date',
      'Expressing disagreement',
      'Using AI on assignments',
      'Declining an invitation',
      'Asking for contact information',
      'Asking for help',
      'Requesting a favor',
      'Confronting hurtful behavior',
      'Requesting a change in behavior',
      'Expressing dissatisfaction',
      'Ending a relationship',
      'Leaving a group',
      'Declining alcohol or drugs',
      'Insulting someone',
      'Making potentially offensive jokes'
    ]) assert.ok(!behaviors.has(name), `superseded behavior remains: ${name}`);
    assert.deepEqual(STARTER_CODES.filter(c => c.dimension === 'anticipated_interpersonal_consequence').map(c => c.name),
      ['Rejection','Judgment','Conflict','Burdening someone','Relationship loss','Other']);
    assert.equal(seedStarterCodebook(db, id).added, STARTER_CODES.length);
    const first = db.prepare('SELECT * FROM codes ORDER BY id LIMIT 1').get();
    db.prepare('UPDATE codes SET name=?,definition=?,status=? WHERE id=?').run('Renamed category', 'Locally revised definition', 'active', first.id);
    assert.equal(seedStarterCodebook(db, id).added, 0);
    assert.equal(db.prepare('SELECT definition FROM codes WHERE id=?').get(first.id).definition, 'Locally revised definition');
    assert.equal(db.prepare('SELECT count(*) n FROM codes').get().n, STARTER_CODES.length);
    assert.ok(db.prepare('SELECT count(*) n FROM history').get().n >= STARTER_CODES.length);
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

test('v2 label consolidation keeps stable primary IDs and migrates saved assignments', () => {
 const db=openDB(':memory:'); try {
  const author=addUser(db,'test-admin','Test admin','a-long-test-password','admin');
  db.exec('CREATE TABLE codebook_seeds (seed_key TEXT PRIMARY KEY, code_id INTEGER NOT NULL REFERENCES codes(id))');
  const addV2=(name,family,version=1,status='draft')=>{
    const id=Number(db.prepare('INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('behavior',name,'','','','',status,author,version,'test',family).lastInsertRowid);
    db.prepare('INSERT INTO codebook_seeds VALUES (?,?)').run(`behavior-framework-v2:behavior:${name}`,id);
    return id;
  };
  const joining=addV2('Joining a group or club','Making social connections');
  const approaching=addV2('Approaching an unfamiliar group','Making social connections');
  const opinion=addV2('Sharing an opinion','Expressing views');
  const question=addV2('Asking a question','Participating publicly');
  const locallyRevised=addV2('Introducing oneself','Making social connections',2,'active');
  db.prepare('INSERT INTO responses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('response-1','record-1','person-1','P001',1,'general_self_approach','general','self','approach','test','psych','test',1,'Example response',0);
  const batchId=db.prepare('SELECT id FROM coding_batches WHERE active=1').get().id;
  db.prepare('INSERT INTO annotations(response_id,user_id,batch_id,status,payload,version,updated) VALUES (?,?,?,?,?,?,?)').run('response-1',author,batchId,'draft',JSON.stringify({response_quality:'substantive',dimensions:{behavior:{codes:[joining,approaching,opinion,question]}},memos:{}}),1,'test');

  const result=seedStarterCodebook(db,author);
  assert.ok(result.revised >= 2);
  assert.ok(result.retired >= 2);
  assert.equal(result.annotations_migrated,1);
  assert.equal(db.prepare('SELECT name FROM codes WHERE id=?').get(joining).name,'Joining a new social group or club');
  assert.equal(db.prepare('SELECT status FROM codes WHERE id=?').get(approaching).status,'retired');
  assert.equal(db.prepare('SELECT name FROM codes WHERE id=?').get(opinion).name,'Sharing opinions');
  assert.equal(db.prepare('SELECT status FROM codes WHERE id=?').get(question).status,'retired');
  assert.deepEqual(JSON.parse(db.prepare('SELECT payload FROM annotations WHERE response_id=?').get('response-1').payload).dimensions.behavior.codes,[joining,opinion]);
  assert.equal(db.prepare('SELECT name FROM codes WHERE id=?').get(locallyRevised).name,'Introducing oneself');
  assert.ok(db.prepare("SELECT id FROM codes WHERE dimension='behavior' AND name='Reaching out to someone new'").get());
  assert.equal(db.prepare("SELECT count(*) n FROM history WHERE entity='annotation_codebook_migration'").get().n,1);

  const historyCount=db.prepare('SELECT count(*) n FROM history').get().n;
  const rerun=seedStarterCodebook(db,author);
  assert.deepEqual(rerun,{added:0,revised:0,retired:0,annotations_migrated:0,total_starters:STARTER_CODES.length});
  assert.equal(db.prepare('SELECT count(*) n FROM history').get().n,historyCount);
 } finally {db.close();}
});

test('meeting changes consolidate edited and unseeded labels and preserve readings across batches', () => {
  const db = openDB(':memory:');
  try {
    const author = addUser(db, 'admin', 'Admin', 'a-long-test-password', 'admin');
    const add = (name, family) => Number(db.prepare('INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated,family) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('behavior', name, 'Coder definition', '', '', '', 'active', author, 3, 'test', family).lastInsertRowid);
    const names = ['Sharing an opinion', 'Answering a question', 'Performing in front of others', 'Discussing political or religious beliefs', 'Taking a leadership role', 'Taking a challenging course', 'Learn something challenging', 'Taking a new class', 'Declining an invitation', 'Trying an unfamiliar activity', 'Sharing personal feelings', 'Sharing personal struggles', 'Using AI on assignments', 'Asking someone on a date'];
    const ids = names.map(name => add(name, 'Participating publicly'));
    db.prepare('INSERT INTO responses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('r','record','person','P001',1,'general_self_approach','general','self','approach','test','psych','test',1,'Original text',0);
    const batch = db.prepare('SELECT id FROM coding_batches WHERE active=1').get().id;
    const payload = {dimensions:{behavior:{codes:ids, note:'Keep notes'}},memos:{observations:'Keep observation'},response_quality:'substantive'};
    db.prepare('INSERT INTO annotations VALUES (?,?,?,?,?,?,?)').run('r',author,batch,'complete',JSON.stringify(payload),1,'test');
    seedStarterCodebook(db, author);
    const active = db.prepare("SELECT * FROM codes WHERE status!='retired'").all();
    assert.ok(active.every(c => c.family !== 'Participating publicly'));
    assert.ok(names.every(name => !active.some(c => c.name === name)));
    const reading = JSON.parse(db.prepare('SELECT payload FROM annotations').get().payload);
    const selected = reading.dimensions.behavior.codes.map(id => db.prepare('SELECT name FROM codes WHERE id=?').get(id).name);
    assert.deepEqual(new Set(selected), new Set(['Sharing opinions','Taking up a challenge','Not going to social events','Trying something new','Sharing something personal','Using AI','Other to discuss']));
    assert.equal(reading.memos.observations, 'Keep observation');
    assert.equal(reading.dimensions.behavior.note, 'Keep notes');
    assert.equal(db.prepare('SELECT text FROM responses').get().text, 'Original text');
    assert.equal(db.prepare('SELECT status FROM annotations').get().status, 'complete');
    assert.equal(db.prepare('SELECT definition FROM codes WHERE id=?').get(ids[0]).definition, 'Coder definition');
    const history = db.prepare('SELECT count(*) n FROM history').get().n;
    seedStarterCodebook(db, author);
    assert.equal(db.prepare('SELECT count(*) n FROM history').get().n, history);
  } finally { db.close(); }
});
