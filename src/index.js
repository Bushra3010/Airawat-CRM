'use strict';
require('./env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { open } = require('./db');
const { createApp } = require('./server');

const root = path.join(__dirname, '..');

/** Without DATABASE_URL, run a private local Postgres in data/pg (development only). */
async function localDatabaseUrl() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = path.join(root, 'data', 'pg');
  const port = Number(process.env.LOCAL_PG_PORT || 54329);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'local-dev-only', port, persistent: true, onLog: () => {} });
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  const stop = () => pg.stop().finally(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log(`Local development database running (data/pg, port ${port})`);
  return `postgres://postgres:local-dev-only@localhost:${port}/postgres`;
}

async function main() {
  const url = process.env.DATABASE_URL || await localDatabaseUrl();
  const db = open(url);
  // Private local database: demo data. Supabase: first admin from ADMIN_INITIAL_PASSWORD (DEMO_DATA=1 for demo data).
  const { ensureReady } = require('./bootstrap');
  await ensureReady(db, process.env.DATABASE_URL ? {} : { demo: true });
  const app = createApp({ db, publicBaseUrl: process.env.PUBLIC_BASE_URL, ready: () => ensureReady(db) });

  // Phone cameras need HTTPS (or localhost). Uses HTTPS_KEY / HTTPS_CERT, or the
  // certificate made by `npm run cert` in certs/.
  const keyFile = process.env.HTTPS_KEY || path.join(root, 'certs', 'server.key');
  const certFile = process.env.HTTPS_CERT || path.join(root, 'certs', 'server.crt');
  const caFile = path.join(root, 'certs', 'ca.crt');
  const useHttps = fs.existsSync(keyFile) && fs.existsSync(certFile);

  // Staff phones download the shop's CA certificate here to trust the HTTPS certificate.
  // (Public certificate only — the CA private key never leaves certs/.)
  if (fs.existsSync(caFile)) {
    app.get('/ca.crt', (req, res) => res.type('application/x-x509-ca-cert').set('Content-Disposition', 'attachment; filename="airawat-showroom-ca.crt"').sendFile(caFile));
  }

  const port = Number(process.env.PORT || 3000);
  const httpsPort = Number(process.env.HTTPS_PORT || 3443);
  const lanIps = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

  http.createServer(app).listen(port, '0.0.0.0', () => console.log(`Airawat Showroom: http://localhost:${port}`));
  if (useHttps) {
    https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, app).listen(httpsPort, '0.0.0.0', () => {
      console.log(`HTTPS for phones: ${lanIps.map((ip) => `https://${ip}:${httpsPort}`).join('  ') || `https://localhost:${httpsPort}`}`);
      if (fs.existsSync(caFile)) console.log(`Install the shop certificate on staff phones from http://${lanIps[0] || 'localhost'}:${port}/ca.crt`);
    });
  } else {
    console.log('HTTPS is off — run `npm run cert` so phone cameras can scan over the Wi-Fi.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
