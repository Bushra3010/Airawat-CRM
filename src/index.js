'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { open } = require('./db');
const { createApp } = require('./server');

const root = path.join(__dirname, '..');
const file = process.env.DB_FILE || path.join(root, 'data', 'airawat.db');
const fresh = !fs.existsSync(file);
const db = open(file);
if (fresh) {
  require('./seed').seed(db, { photoDir: path.join(root, 'public', 'seed-img') });
  console.log('New database created with demo data (see src/seed.js for demo logins).');
}
const app = createApp({ db, publicBaseUrl: process.env.PUBLIC_BASE_URL });

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
