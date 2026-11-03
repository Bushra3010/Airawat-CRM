'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open, migrate } = require('../src/db');
const { seed, USERS } = require('../src/seed');
const { createApp } = require('../src/server');

/** Real PostgreSQL for tests: TEST_DATABASE_URL if given, otherwise a throwaway embedded server. */
async function startPostgres(dir) {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop: async () => {} };
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = 55000 + Math.floor(Math.random() * 5000);
  const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pg'), user: 'postgres', password: 'test', port, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  return { url: `postgres://postgres:test@localhost:${port}/postgres`, stop: () => pg.stop() };
}

/** Fresh database + running server for a test file. */
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airawat-test-'));
  const pg = await startPostgres(dir);
  const db = open(pg.url, { max: 10 });
  await migrate(db);
  const ids = await seed(db, {});
  const app = createApp({ db, uploadDir: path.join(dir, 'uploads'), publicBaseUrl: 'https://showroom.example.test' });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pw = Object.fromEntries(USERS.map((u) => [u[0], u[3]]));

  async function login(username) {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: pw[username] }) });
    if (!r.ok) throw new Error('login failed for ' + username);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const call = async (method, p, body) => {
      const res = await fetch(base + '/api' + p, { method, headers: { cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const ct = res.headers.get('content-type') || '';
      return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
  }
  const close = async () => {
    await new Promise((r) => server.close(r));
    await db.close();
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, url: pg.url, ids, base, login, close };
}

module.exports = { setup };
