'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../src/db');
const { seed, USERS } = require('../src/seed');
const { createApp } = require('../src/server');

/** Fresh file-backed database + running server for each test file. */
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airawat-test-'));
  const file = path.join(dir, 'test.db');
  const db = open(file);
  const ids = seed(db, {});
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
  const close = () => new Promise((r) => server.close(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); r(); }));
  return { db, file, ids, base, login, close };
}

module.exports = { setup };
