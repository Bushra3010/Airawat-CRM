'use strict';
/**
 * First-run setup on an empty database (as on a fresh Supabase project),
 * staff user management and sign-in throttling.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startPostgres } = require('./helpers');
const { open } = require('../src/db');
const { createApp } = require('../src/server');

let pg, db, server, base, dir;
const ADMIN_PW = 'first-admin-pass-123';

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airawat-setup-'));
  pg = await startPostgres(dir);
  db = open(pg.url, { max: 5 });
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await db.close();
  await pg.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function startApp(adminPassword) {
  // fresh bootstrap module so its "already set up" memo starts empty
  delete require.cache[require.resolve('../src/bootstrap')];
  const { ensureReady } = require('../src/bootstrap');
  const app = createApp({ db, uploadDir: path.join(dir, 'up'), ready: () => ensureReady(db, { adminPassword, demo: false }) });
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}
async function call(method, p, body, cookie) {
  const r = await fetch(base + '/api' + p, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (username, password) => call('POST', '/login', { username, password });

test('an empty database is not usable until an admin password is configured', async () => {
  server = await startApp(undefined);
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await login('admin', 'whatever');
  assert.equal(r.status, 503);
  assert.match(r.body.error, /ADMIN_INITIAL_PASSWORD/);
  await new Promise((res) => server.close(res));
});

test('first run creates the admin login, locations and label sizes, and no demo data', async () => {
  server = await startApp(ADMIN_PW);
  base = `http://127.0.0.1:${server.address().port}`;
  // two instances starting at once must not create two admins
  await Promise.all([login('admin', 'x'), login('admin', 'y')]);
  const r = await login('admin', ADMIN_PW);
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'admin');
  assert.equal((await db.one('SELECT COUNT(*)::int n FROM users')).n, 1);
  assert.equal((await db.one('SELECT COUNT(*)::int n FROM products')).n, 0, 'no demo products');
  assert.equal((await db.one('SELECT COUNT(*)::int n FROM locations')).n, 2);
  assert.ok((await db.one('SELECT COUNT(*)::int n FROM label_templates')).n >= 5);
  const rls = await db.query("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity");
  assert.deepEqual(rls, [], 'every table has row level security on');
});

test('admins manage staff logins; other roles cannot', async () => {
  const admin = (await login('admin', ADMIN_PW)).cookie;
  let r = await call('POST', '/users', { username: 'Priya', name: 'Priya', role: 'sales', password: 'short' }, admin);
  assert.equal(r.status, 400, 'password too short');
  r = await call('POST', '/users', { username: 'priya', name: 'Priya', role: 'sales', password: 'priya-pass-0001' }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.pass_hash, undefined, 'password hash never returned');
  const priyaId = r.body.id;
  assert.equal((await call('POST', '/users', { username: 'priya', name: 'Dup', role: 'sales', password: 'xxxxxxxxxxxx' }, admin)).status, 409);

  const priya = (await login('PRIYA', 'priya-pass-0001')).cookie;
  assert.ok(priya, 'usernames are case-insensitive');
  assert.equal((await call('GET', '/users', null, priya)).status, 403);
  assert.equal((await call('POST', '/users', { username: 'x1x', name: 'X', role: 'admin', password: 'xxxxxxxxxxxx' }, priya)).status, 403);
  assert.equal((await call('POST', '/locations', { code: 'BR3', name: 'Kothrud', type: 'branch' }, priya)).status, 403);

  // reset password: old password stops working and her session ends
  r = await call('PATCH', `/users/${priyaId}`, { password: 'new-priya-pass-02' }, admin);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/me', null, priya)).status, 401);
  assert.equal((await login('priya', 'priya-pass-0001')).status, 401);
  const priya2 = (await login('priya', 'new-priya-pass-02')).cookie;

  // own password change
  assert.equal((await call('POST', '/me/password', { current_password: 'wrong-one-123', new_password: 'another-pass-03' }, priya2)).status, 403);
  assert.equal((await call('POST', '/me/password', { current_password: 'new-priya-pass-02', new_password: 'another-pass-03' }, priya2)).status, 200);
  assert.equal((await call('GET', '/me', null, priya2)).status, 200, 'stays signed in on this device');

  // disabling signs her out and blocks sign-in
  await call('PATCH', `/users/${priyaId}`, { active: false }, admin);
  assert.equal((await call('GET', '/me', null, priya2)).status, 401);
  assert.equal((await login('priya', 'another-pass-03')).status, 401);

  // the last admin cannot be demoted or disabled
  const adminId = (await call('GET', '/me', null, admin)).body.id;
  assert.equal((await call('PATCH', `/users/${adminId}`, { role: 'sales' }, admin)).status, 400);
  assert.equal((await call('PATCH', `/users/${adminId}`, { active: false }, admin)).status, 400);

  // locations
  r = await call('POST', '/locations', { code: 'br3', name: 'Kothrud Branch', type: 'branch' }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 'BR3');
  r = await call('PATCH', `/locations/${r.body.id}`, { name: 'Kothrud Showroom', type: 'showroom' }, admin);
  assert.deepEqual([r.body.name, r.body.type], ['Kothrud Showroom', 'showroom']);
});

test('repeated wrong passwords lock that username for 15 minutes', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await login('admin', 'wrong-guess-' + i)).status, 401);
  const r = await login('admin', ADMIN_PW);
  assert.equal(r.status, 429, 'even the right password is refused while locked');
  await db.query("UPDATE login_failures SET ts = ts - interval '16 minutes'");
  assert.equal((await login('admin', ADMIN_PW)).status, 200, 'unlocked after 15 minutes');
});

test('database URLs with un-encoded special characters in the password are accepted', () => {
  const { connectionConfig } = require('../src/db');
  const c = connectionConfig('postgresql://postgres.abcref:Pa#ss%w/o?r@d!@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres');
  assert.deepEqual(c, { user: 'postgres.abcref', password: 'Pa#ss%w/o?r@d!', host: 'aws-0-ap-southeast-2.pooler.supabase.com', port: 6543, database: 'postgres' });
  assert.deepEqual(connectionConfig('postgres://u:p%40ss@localhost:5432/db'), { connectionString: 'postgres://u:p%40ss@localhost:5432/db' });
  assert.throws(() => connectionConfig('https://abc.supabase.co'), /not a valid postgres/);
});

test('instances starting at the same time migrate without deadlocking', async () => {
  const { migrate } = require('../src/db');
  await db.query('DELETE FROM schema_meta');   // force a re-run of the migration
  const pools = Array.from({ length: 4 }, () => open(pg.url, { max: 2 }));
  try {
    await Promise.all(pools.map((p) => migrate(p)));
    assert.equal((await db.one('SELECT COUNT(*)::int n FROM schema_meta')).n, 1);
    const t = Date.now();
    await migrate(db);
    assert.ok(Date.now() - t < 200, 'already-migrated database is skipped quickly');
  } finally {
    await Promise.all(pools.map((p) => p.close()));
  }
});
