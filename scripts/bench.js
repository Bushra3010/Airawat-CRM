'use strict';
/**
 * Counts database round trips per screen against a local Postgres with simulated
 * network latency (default 200 ms per query, like Netlify Ohio → Supabase Sydney).
 *   node scripts/bench.js [rttMs]
 */
const pg = require('pg');
const { setup } = require('../test/helpers');

const RTT = Number(process.argv[2] || 200);
let count = 0;
const orig = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  count++;
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  const p = new Promise((r) => setTimeout(r, RTT)).then(() => orig.apply(this, args));
  if (cb) { p.then((r) => cb(null, r), (e) => cb(e)); return undefined; }
  return p;
};

(async () => {
  const ctx = await setup();
  const admin = await ctx.login('admin');
  const P = ctx.ids.products;
  const piece = ctx.ids.hutchPieces[0].id;
  const q = (await admin.post('/quotations', { customer_name: 'Bench', items: [{ product_id: P.ganesha, qty: 2 }, { product_id: P.hutch, piece_id: piece }, { product_id: P.tv, qty: 1 }] })).body.id;
  const sl = (await admin.post('/shortlists', { customer_name: 'Bench' })).body.id;
  for (const id of [P.ganesha, P.tv, P.shelf]) await admin.post(`/shortlists/${sl}/items`, { product_id: id });
  const token = (await ctx.db.one('SELECT public_token FROM products WHERE id = $1', [P.hutch])).public_token;
  const steps = [
    ['me', () => admin.get('/me')],
    ['search (all)', () => admin.get('/search?q=')],
    ['search "sheesham"', () => admin.get('/search?q=sheesham')],
    ['scan', () => admin.get('/scan?code=AHU-000001')],
    ['product (pieces)', () => admin.get('/products/' + P.hutch)],
    ['product (out of stock)', () => admin.get('/products/' + P.chest)],
    ['piece', () => admin.get('/pieces/' + piece)],
    ['quotation', () => admin.get('/quotations/' + q)],
    ['shortlist', () => admin.get('/shortlists/' + sl)],
    ['customer QR page', () => fetch(`${ctx.base}/p/${token}`)],
    ['reserve (SKU)', () => admin.post('/stock/reserve', { product_id: P.ganesha, qty: 1, confirm: true })],
    ['confirm order', () => admin.post(`/quotations/${q}/confirm`, { confirm: true })],
  ];
  console.log(`simulated latency ${RTT} ms per query\n`);
  console.log('screen'.padEnd(26), 'queries'.padStart(8), 'time'.padStart(9));
  for (const [name, fn] of steps) {
    count = 0;
    const t = Date.now();
    const r = await fn();
    if (r.status >= 400) console.log('  !', name, r.status);
    console.log(name.padEnd(26), String(count).padStart(8), `${((Date.now() - t) / 1000).toFixed(1)}s`.padStart(9));
  }
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
