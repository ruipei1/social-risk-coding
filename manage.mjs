import { openDB, importCSV, addUser, passwordHash } from './model.mjs';
import { seedStarterCodebook } from './starter-codebook.mjs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const db = openDB();
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'import') console.log(importCSV(db, resolve(args[0] || '../Combined data/social_risk_combined_analysis.csv')));
  else if (command === 'seed-codebook') {
    const author = db.prepare('SELECT id FROM users WHERE username=? AND role=?').get(args[0] || 'local-researcher', 'admin');
    if (!author) throw new Error('Supply an existing administrator username.');
    console.log(seedStarterCodebook(db, author.id));
  } else if (command === 'add-user') {
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    addUser(db, args[0] || '', args[2] || args[0] || '', password, args[1] || 'coder');
    console.log('Account created.');
  } else if (command === 'reset-password') {
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (password.length < 12 || password.length > 200) throw new Error('Use 12–200 characters.');
    const user = db.prepare('SELECT id FROM users WHERE username=?').get(args[0]);
    if (!user) throw new Error('Account not found.');
    db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    console.log('Password reset and sessions revoked.');
  } else if (command === 'disable-user') {
    const user = db.prepare('SELECT id FROM users WHERE username=?').get(args[0]);
    if (!user) throw new Error('Account not found.');
    db.prepare('UPDATE users SET active=0 WHERE id=?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    console.log('Account disabled.');
  } else if (command === 'backup') {
    if (!args[0]) throw new Error('Supply a new backup filename.');
    db.prepare('VACUUM INTO ?').run(resolve(args[0]));
    console.log('Consistent database backup created.');
  } else console.log('Commands: import [CSV], seed-codebook ADMIN_USERNAME, add-user USERNAME [admin|coder] [NAME] (password from stdin), reset-password USERNAME (stdin), disable-user USERNAME, backup NEW_PATH');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { db.close(); }
