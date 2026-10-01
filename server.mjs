import http from 'node:http';
import { observationsText } from './public/memos.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DIMENSIONS, ALL_DIM_IDS, PROMPTS, openDB, hash, timestamp, passwordMatches, passwordHash, addUser, transaction, csvExport } from './model.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const failure = (status, message) => Object.assign(new Error(message), { status });
const check = (condition, message, status = 400) => { if (!condition) throw failure(status, message); };
const str = (value, max = 6000) => { check(typeof value === 'string' && value.length <= max, `Text must be at most ${max} characters.`); return value; };
const number = value => { check(Number.isSafeInteger(value) && value >= 0, 'Invalid version.'); return value; };
const DIM_IDS = DIMENSIONS.map(d => d.id);
const dummyPassword = passwordHash(randomBytes(20).toString('hex'));

export function createApp({ db = openDB(), preview = false, origin = process.env.APP_ORIGIN || 'http://127.0.0.1:4317' } = {}) {
  const secure = origin.startsWith('https://');
  if (preview) {
    check(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Preview must use a loopback origin.');
    if (!db.prepare('SELECT id FROM users WHERE username=?').get('local-researcher')) addUser(db, 'local-researcher', 'Local researcher', randomBytes(32).toString('hex'), 'admin');
  }
  function session(req) {
    const token = /(?:^|;\s*)coding_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    return token ? db.prepare('SELECT u.id,u.username,u.name,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1').get(hash(token), Date.now()) : null;
  }
  function signIn(res, user) {
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(token), user.id, csrf, Date.now() + 12 * 3600_000);
    res.setHeader('Set-Cookie', `coding_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
    return { user: { id: user.id, name: user.name, username: user.username, role: user.role }, csrf };
  }
  function annotation(responseId, userId) {
    const saved = db.prepare('SELECT * FROM annotations WHERE response_id=? AND user_id=?').get(responseId, userId);
    return saved ? { ...saved, payload: JSON.parse(saved.payload) } : { version: 0, status: 'unread', payload: { dimensions: {}, memos: {}, response_quality: 'substantive' } };
  }
  function validatePayload(payload, previous = {}) {
    check(payload && typeof payload === 'object', 'Missing annotation.');
    const result = { dimensions: {}, memos: {}, response_quality: payload.response_quality };
    check(['substantive', 'no_example', 'ambiguous', 'off_topic', 'blank'].includes(result.response_quality), 'Choose a response type.');
    for (const d of ALL_DIM_IDS) {
      const item = payload.dimensions?.[d] ?? previous.dimensions?.[d] ?? {};
      const codes = item.codes || [];
      check(Array.isArray(codes) && codes.length <= 30 && codes.every(Number.isSafeInteger), 'Invalid codes.');
      for (const id of codes) check(db.prepare('SELECT id FROM codes WHERE id=? AND dimension=?').get(id, d), 'Code does not belong to this dimension.');
      const evidence = item.evidence || 'unreviewed';
      check(['unreviewed', 'explicit', 'inferred', 'not_stated', 'unclear', 'mixed'].includes(evidence), 'Invalid evidence status.');
      result.dimensions[d] = { note: str(item.note || ''), quote: str(item.quote || ''), evidence, codes: [...new Set(codes)] };
    }
    for (const field of ['at_stake', 'unstated', 'context', 'reflection']) result.memos[field] = str(payload.memos?.[field] || '', 12000);
    if (Object.hasOwn(payload.memos || {}, 'observations')) result.memos.observations = str(payload.memos.observations, 50000);
    return result;
  }
  async function body(req) {
    check(req.headers['content-type']?.startsWith('application/json'), 'JSON required.', 415);
    let raw = '';
    for await (const chunk of req) { raw += chunk; check(Buffer.byteLength(raw) <= 300000, 'Request too large.', 413); }
    try { return JSON.parse(raw); } catch { throw failure(400, 'Invalid JSON.'); }
  }
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, origin), path = url.pathname;
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) check(req.headers.origin === origin, 'Request origin does not match APP_ORIGIN.', 403);
      if (req.method === 'GET' && path === '/health') return json({ ok: true });
      if (req.method === 'GET' && path === '/api/session') {
        const user = session(req);
        return json({ user: user ? { id: user.id, username: user.username, name: user.name, role: user.role } : null, csrf: user?.csrf, preview, dimensions: DIMENSIONS, prompts: PROMPTS });
      }
      if (req.method === 'POST' && path === '/api/preview-login') {
        check(preview && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress), 'Local preview unavailable.', 403);
        return json(signIn(res, db.prepare('SELECT * FROM users WHERE username=?').get('local-researcher')));
      }
      if (req.method === 'POST' && path === '/api/login') {
        const input = await body(req), username = str(input.username, 50).toLowerCase(), password = str(input.password, 200);
        const keys = ['user:' + username, 'ip:' + req.socket.remoteAddress];
        db.prepare('DELETE FROM login_attempts WHERE expires<?').run(Date.now());
        for (const key of keys) {
          const attempts = db.prepare('SELECT attempts FROM login_attempts WHERE key=?').get(key)?.attempts || 0;
          check(attempts < (key.startsWith('ip:') ? 60 : 12), 'Too many attempts. Try again in 15 minutes.', 429);
        }
        const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
        const valid = passwordMatches(password, user?.password || dummyPassword);
        if (!user || !valid) {
          for (const key of keys) db.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(key, Date.now() + 900000);
          throw failure(401, 'Username or password is incorrect.');
        }
        db.prepare('DELETE FROM login_attempts WHERE key=?').run(keys[0]);
        return json(signIn(res, user));
      }
      if (path.startsWith('/api/')) {
        const user = session(req); check(user, 'Please sign in to continue.', 401);
        if (req.method !== 'GET') check(req.headers['x-csrf-token'] === user.csrf, 'Session verification failed. Sign in again.', 403);
        const admin = () => check(user.role === 'admin', 'Administrator access required.', 403);
        if (req.method === 'POST' && path === '/api/logout') {
          db.prepare('DELETE FROM sessions WHERE token=?').run(hash(/coding_session=([a-f0-9]+)/.exec(req.headers.cookie)?.[1] || ''));
          res.setHeader('Set-Cookie', 'coding_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return json({ ok: true });
        }
        if (req.method === 'GET' && path === '/api/stats') {
          const counts = db.prepare('SELECT count(*) total, sum(blank=0) nonblank, count(DISTINCT record_key) records FROM responses').get();
          const mine = db.prepare('SELECT status, count(*) n FROM annotations WHERE user_id=? GROUP BY status').all(user.id);
          return json({ ...counts, mine, byPrompt: db.prepare("SELECT r.prompt, count(*) total, sum(r.blank=0) nonblank, sum(COALESCE(a.status,'unread')='complete') complete FROM responses r LEFT JOIN annotations a ON a.response_id=r.id AND a.user_id=? GROUP BY r.prompt").all(user.id) });
        }
        if (req.method === 'GET' && path === '/api/responses') {
          const where = [], args = [user.id];
          for (const key of ['domain', 'perspective', 'direction', 'pool']) if (url.searchParams.get(key)) { where.push(`r.${key}=?`); args.push(url.searchParams.get(key)); }
          const search = url.searchParams.get('q')?.slice(0, 200);
          if (search) { where.push("(r.text LIKE ? ESCAPE '\\' OR r.participant_label LIKE ? ESCAPE '\\')"); const term = '%' + search.replace(/[\\%_]/g, '\\$&') + '%'; args.push(term, term); }
          if (url.searchParams.get('blanks') !== '1') where.push('r.blank=0');
          const status = url.searchParams.get('status');
          if (status) { where.push("COALESCE(a.status,'unread')=?"); args.push(status); }
          const from = `FROM responses r LEFT JOIN annotations a ON a.response_id=r.id AND a.user_id=? ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
          const total = db.prepare('SELECT count(*) n ' + from).get(...args).n;
          const offset = Math.max(0, Math.min(100000, parseInt(url.searchParams.get('offset') || '0') || 0));
          const list = db.prepare("SELECT r.id,r.participant_label,r.record_number,r.prompt,r.text,r.blank,COALESCE(a.status,'unread') status " + from + ' ORDER BY r.record_number, r.rowid LIMIT 40 OFFSET ?').all(...args, offset);
          return json({ total, offset, responses: list });
        }
        if (req.method === 'GET' && path.startsWith('/api/response/')) {
          const id = decodeURIComponent(path.slice('/api/response/'.length));
          const response = db.prepare('SELECT * FROM responses WHERE id=?').get(id); check(response, 'Response not found.', 404);
          const related = db.prepare('SELECT id,prompt,text,blank FROM responses WHERE record_key=? ORDER BY rowid').all(response.record_key);
          return json({ response, annotation: annotation(id, user.id), related });
        }
        if (req.method === 'PUT' && path.startsWith('/api/annotation/')) {
          const id = decodeURIComponent(path.slice('/api/annotation/'.length)), input = await body(req);
          const response = db.prepare('SELECT * FROM responses WHERE id=?').get(id); check(response, 'Response not found.', 404);
          const version = number(input.version), payload = validatePayload(input.payload, annotation(id, user.id).payload);
          check(['draft', 'complete', 'flagged'].includes(input.status), 'Invalid annotation status.');
          // Every quoted passage must be present in the original response.
          for (const item of Object.values(payload.dimensions)) if (item.quote) check(response.text.includes(item.quote), 'A supporting excerpt does not match the original response.');
          const updated = timestamp();
          transaction(db, () => {
            const current = annotation(id, user.id);
            check(current.version === version, 'This response was saved in another tab. Your changes are still here; copy them before reloading.', 409);
            db.prepare('INSERT INTO annotations VALUES (?,?,?,?,?,?) ON CONFLICT(response_id,user_id) DO UPDATE SET status=excluded.status,payload=excluded.payload,version=excluded.version,updated=excluded.updated').run(id, user.id, input.status, JSON.stringify(payload), version + 1, updated);
            db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('annotation', id, user.id, version + 1, JSON.stringify({ status: input.status, payload }), updated);
          });
          return json({ version: version + 1, updated });
        }
        if (req.method === 'GET' && path === '/api/codes') return json(db.prepare('SELECT c.*,u.name author FROM codes c JOIN users u ON u.id=c.author_id ORDER BY c.dimension,c.name').all());
        if ((req.method === 'POST' || req.method === 'PUT') && /^\/api\/codes(?:\/\d+)?$/.test(path)) {
          const input = await body(req), id = req.method === 'PUT' ? Number(path.split('/').pop()) : null;
          check(DIM_IDS.includes(input.dimension), 'Invalid dimension.');
          input.status ??= 'draft';
          const name = str(input.name, 100).trim(), definition = str(input.definition || '');
          check(name, 'A code name is required.');
          check(['draft', 'active', 'retired'].includes(input.status), 'Invalid code status.');
          const values = [input.dimension, name, definition, str(input.include_rule || ''), str(input.exclude_rule || ''), str(input.example || ''), input.status];
          let savedId;
          transaction(db, () => {
            let version = 1;
            if (id) {
              const prior = db.prepare('SELECT * FROM codes WHERE id=?').get(id); check(prior, 'Code not found.', 404);
              check(user.role === 'admin' || (prior.author_id === user.id && prior.status === 'draft' && input.status === 'draft'), 'Only an administrator can revise approved codes or another coder’s drafts.', 403);
              check(input.dimension === prior.dimension, 'A code’s dimension cannot change. Create a new code instead.');
              check(prior.version === number(input.version), 'This code changed in another session. Reopen it before editing.', 409);
              version = prior.version + 1;
              db.prepare('UPDATE codes SET dimension=?,name=?,definition=?,include_rule=?,exclude_rule=?,example=?,status=?,version=?,updated=? WHERE id=?').run(...values, version, timestamp(), id);
              savedId = id;
            } else {
              check(user.role === 'admin' || input.status === 'draft', 'New codes from coders must be drafts.', 403);
              savedId = Number(db.prepare('INSERT INTO codes(dimension,name,definition,include_rule,exclude_rule,example,status,author_id,version,updated) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...values, user.id, version, timestamp()).lastInsertRowid);
              const family = input.dimension === 'behavior' ? str(input.family || '', 100).trim() : '';
              db.prepare('UPDATE codes SET family=? WHERE id=?').run(family, savedId);
            }
            db.prepare('INSERT INTO history(entity,entity_id,user_id,version,payload,created) VALUES (?,?,?,?,?,?)').run('code', String(savedId), user.id, version, JSON.stringify(input), timestamp());
          });
          return json({ id: savedId });
        }
        if (req.method === 'GET' && path === '/api/team') {
          admin();
          return json(db.prepare("SELECT u.id,u.username,u.name,u.role,u.active,count(a.response_id) started,sum(a.status='complete') complete,sum(a.status='flagged') flagged FROM users u LEFT JOIN annotations a ON a.user_id=u.id GROUP BY u.id ORDER BY u.id").all());
        }
        if (req.method === 'POST' && path === '/api/users') {
          admin(); const input = await body(req);
          return json({ id: Number(addUser(db, str(input.username, 50), str(input.name, 100), str(input.password, 200), input.role)) });
        }
        if (req.method === 'GET' && path === '/api/export') {
          const kind = url.searchParams.get('kind') || 'annotations';
          if (kind === 'codes') {
            const rows = db.prepare('SELECT c.*,u.username author FROM codes c JOIN users u ON u.id=c.author_id').all();
            res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="codebook.csv"' });
            return res.end(csvExport(rows, ['id','dimension','family','name','definition','include_rule','exclude_rule','example','status','author','version','updated']));
          }
          if (kind === 'history') {
            admin(); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="coding-history.json"' });
            return res.end(JSON.stringify(db.prepare('SELECT * FROM history ORDER BY id').all(), null, 2));
          }
          const all = url.searchParams.get('all') === '1'; if (all) admin();
          const rows = db.prepare(`SELECT r.record_key,r.participant_key,r.participant_label,r.prompt,r.source,r.pool,r.wave,r.complete survey_complete,r.text,u.username coder,a.status,a.payload,a.version,a.updated FROM annotations a JOIN responses r ON r.id=a.response_id JOIN users u ON u.id=a.user_id ${all ? '' : 'WHERE a.user_id=?'} ORDER BY r.record_number,r.rowid,u.id`).all(...(all ? [] : [user.id]));
          const fields = ['record_key','participant_key','participant_label','prompt','source','pool','wave','survey_complete','text','coder','status','response_quality','version','updated'];
          for (const d of ALL_DIM_IDS) fields.push(`${d}_note`, `${d}_code_ids`, `${d}_code_names`, `${d}_quote`, `${d}_evidence`);
          fields.push('memo_observations','memo_at_stake','memo_unstated','memo_context','memo_reflection');
          const codeMap = new Map(db.prepare('SELECT id,name FROM codes').all().map(c => [c.id, c.name]));
          for (const row of rows) {
            const payload = JSON.parse(row.payload); row.response_quality = payload.response_quality;
            for (const d of ALL_DIM_IDS) { const v = payload.dimensions?.[d] || {note:'',codes:[],quote:'',evidence:'unreviewed'}; row[`${d}_note`] = v.note; row[`${d}_code_ids`] = JSON.stringify(v.codes); row[`${d}_code_names`] = JSON.stringify(v.codes.map(id => codeMap.get(id))); row[`${d}_quote`] = v.quote; row[`${d}_evidence`] = v.evidence; }
            for (const [key, val] of Object.entries(payload.memos)) row['memo_' + key] = val;
            row.memo_observations = observationsText(payload.memos);
          }
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${all ? 'team' : 'my'}-annotations.csv"` });
          return res.end(csvExport(rows, fields));
        }
        throw failure(404, 'API route not found.');
      }
      const assets = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/memos.js': ['memos.js','text/javascript'], '/style.css': ['style.css','text/css'], '/favicon.svg': ['favicon.svg','image/svg+xml'] };
      const asset = assets[path]; check(req.method === 'GET' && asset, 'Page not found.', 404);
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }); res.end(readFileSync(join(ROOT, 'public', asset[0])));
    } catch (error) {
      if (!error.status && !error.message.includes('UNIQUE constraint')) console.error('Request failed:', error.message);
      json({ error: error.status ? error.message : error.message.includes('UNIQUE constraint') ? 'That name already exists. Choose another name.' : 'The server could not complete this request. Your unsaved changes remain in this page.' }, error.status || (error.message.includes('UNIQUE constraint') ? 409 : 500));
    }
  };
  return { handler, db };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preview = process.argv.includes('--preview');
  const port = Number(process.env.PORT || 4317), host = preview ? '127.0.0.1' : (process.env.HOST || '127.0.0.1');
  const origin = process.env.APP_ORIGIN || (!preview && process.env.RENDER_EXTERNAL_URL) || `http://127.0.0.1:${port}`;
  if (process.env.NODE_ENV === 'production' && (preview || !origin.startsWith('https://'))) throw new Error('Production requires HTTPS APP_ORIGIN and no preview flag.');
  const { handler, db } = createApp({ preview, origin });
  const server = http.createServer({ requestTimeout: 30000, headersTimeout: 15000 }, handler);
  server.listen(port, host, () => console.log(`Social Risk Coding: ${origin}${preview ? ' (local preview)' : ''}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
