'use strict';
/**
 * Verification for the Showroom Product Finder, piece tracking, labels, videos
 * and customer QR pages (spec section 8).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { open } = require('../src/db');
const inv = require('../src/inventory');
const labels = require('../src/labels');
const { code128Values, parseYouTube } = require('../src/codes');
const {
  MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource, DecodeHintType, BarcodeFormat,
} = require('@zxing/library');
const jsQR = require('jsqr');

let ctx, sales, sales2, store, manager;
test.before(async () => {
  ctx = await setup();
  [sales, sales2, store, manager] = await Promise.all(['sales', 'sales2', 'store', 'manager'].map((u) => ctx.login(u)));
});
test.after(() => ctx.close());

const P = () => ctx.ids.products;
const L = () => ctx.ids.locations;
const ledgerCount = () => ctx.db.prepare('SELECT COUNT(*) n FROM stock_ledger').get().n;
const avail = (id) => inv.productAvailability(ctx.db, id);

// ---------------------------------------------------------------- scanning
test('scanning opens the correct product or exact piece', async () => {
  const db = ctx.db;
  const ganesha = db.prepare('SELECT * FROM products WHERE id = ?').get(P().ganesha);
  const piece = db.prepare('SELECT * FROM pieces WHERE id = ?').get(ctx.ids.hutchPieces[2].id);
  const before = ledgerCount();
  const cases = [
    [ganesha.internal_code, { type: 'product', product_id: ganesha.id, matched: 'internal_code' }],
    [ganesha.sku, { type: 'product', product_id: ganesha.id, matched: 'sku' }],
    [ganesha.mfr_barcode, { type: 'product', product_id: ganesha.id, matched: 'mfr_barcode' }],
    [piece.piece_code, { type: 'piece', piece_id: piece.id, product_id: piece.product_id, matched: 'piece_code' }],
    [piece.piece_code.toLowerCase(), { type: 'piece', piece_id: piece.id }],
    [`https://showroom.example.test/p/${piece.public_token}`, { type: 'piece', piece_id: piece.id, matched: 'qr' }],
    [`https://showroom.example.test/p/${ganesha.public_token}`, { type: 'product', product_id: ganesha.id, matched: 'qr' }],
  ];
  for (const [code, expected] of cases) {
    const r = await sales.get('/scan?code=' + encodeURIComponent(code));
    assert.equal(r.status, 200, code);
    for (const [k, v] of Object.entries(expected)) assert.equal(r.body[k], v, `${code} → ${k}`);
  }
  // every piece of the 5-cabinet SKU resolves to itself, not to a sibling
  for (const pc of ctx.ids.hutchPieces) {
    const r = await sales.get('/scan?code=' + pc.piece_code);
    assert.equal(r.body.piece_id, pc.id);
  }
  assert.equal((await sales.get('/scan?code=NOPE-123')).status, 404);
  assert.equal(ledgerCount(), before, 'scanning must never write to the stock ledger');
});

test('stock movements require explicit confirmation', async () => {
  const before = ledgerCount();
  const a = avail(P().ganesha).totals.available;
  const r = await store.post('/stock/dispatch', { product_id: P().ganesha, location_id: L().show, qty: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.body.needs_confirmation, true);
  assert.equal((await sales.post('/stock/reserve', { piece_id: ctx.ids.hutchPieces[0].id })).status, 400);
  assert.equal(avail(P().ganesha).totals.available, a);
  assert.equal(ledgerCount(), before);
  // permissions: sales cannot dispatch even with confirmation
  assert.equal((await sales.post('/stock/dispatch', { product_id: P().ganesha, location_id: L().show, qty: 1, confirm: true })).status, 403);
});

// ---------------------------------------------------------------- saleable availability
test('reserved, damaged and display-only stock is excluded from saleable availability', () => {
  const g = avail(P().ganesha);          // 12 showroom + 20 warehouse sellable, 1 damaged
  assert.equal(g.totals.available, 32);
  assert.equal(g.totals.damaged, 1);
  assert.equal(g.totals.physical, 33);

  const h = avail(P().hutch);            // 5 cabinets: 2 free, 1 reserved, 1 damaged, 1 display
  assert.deepEqual([h.totals.physical, h.totals.available, h.totals.reserved, h.totals.damaged, h.totals.display], [5, 2, 1, 1, 1]);
  const show = h.byLocation.find((l) => l.type === 'showroom');
  assert.equal(show.available, 0, 'showroom display cabinet is not saleable');

  const j = avail(P().jhula);            // single antique piece on display only
  assert.equal(j.status, 'display_only');
  assert.equal(j.totals.available, 0);

  const sofa = avail(P().sofa);          // only a damaged unit
  assert.equal(sofa.status, 'damaged');
  assert.equal(sofa.totals.available, 0);
  assert.ok(sofa.expected && sofa.expected.date, 'incoming production gives an expected date');

  const tv = avail(P().tv);              // display piece explicitly released for sale counts
  assert.equal(tv.totals.available, 3);

  assert.equal(avail(P().bed).status, 'made_to_order');
  assert.equal(avail(P().chest).status, 'out_of_stock');
  assert.ok(avail(P().chest).expected.date);
});

test('a display piece can only be reserved once explicitly released for sale', async () => {
  const jhula = ctx.db.prepare('SELECT * FROM pieces WHERE product_id = ?').get(P().jhula);
  let r = await sales.post('/stock/reserve', { piece_id: jhula.id, confirm: true });
  assert.equal(r.status, 409);
  r = await manager.post('/stock/condition', { piece_id: jhula.id, to_condition: 'display_sale', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(avail(P().jhula).status, 'available_now');
  r = await sales.post('/stock/reserve', { piece_id: jhula.id, customer_name: 'Test', confirm: true });
  assert.equal(r.status, 200);
  await sales.post('/stock/release', { reservation_id: r.body.reservation_id, confirm: true });
  const after = ctx.db.prepare('SELECT status, display_for_sale FROM pieces WHERE id = ?').get(jhula.id);
  assert.deepEqual({ ...after }, { status: 'display', display_for_sale: 1 }, 'release restores the display-for-sale state');
  await manager.post('/stock/condition', { piece_id: jhula.id, to_condition: 'display', confirm: true });
  assert.equal(avail(P().jhula).status, 'display_only');
});

// ---------------------------------------------------------------- concurrency
test('two staff members cannot reserve the same unique piece', async () => {
  const piece = ctx.ids.hutchPieces[0];
  const results = await Promise.all([
    sales.post('/stock/reserve', { piece_id: piece.id, customer_name: 'Customer A', confirm: true }),
    sales2.post('/stock/reserve', { piece_id: piece.id, customer_name: 'Customer B', confirm: true }),
  ]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409]);
  assert.match(results.find((r) => r.status === 409).body.error, /reserved/i);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM reservations WHERE piece_id = ? AND status = 'active'").get(piece.id).n, 1);
  const winner = results.find((r) => r.status === 200).body.reservation_id;
  await sales.post('/stock/release', { reservation_id: winner, confirm: true });
});

test('reservation is safe across separate database connections (multi-process)', () => {
  const a = open(ctx.file), b = open(ctx.file);
  const piece = ctx.ids.hutchPieces[0];
  const r1 = inv.reserve(a, { pieceId: piece.id, userId: 1, customerName: 'conn A' });
  assert.throws(() => inv.reserve(b, { pieceId: piece.id, userId: 1, customerName: 'conn B' }), /reserved/);
  // even a raw second active reservation row is rejected by the database
  assert.throws(() => b.prepare("INSERT INTO reservations (product_id, piece_id, qty, status) VALUES (?, ?, 1, 'active')").run(P().hutch, piece.id), /UNIQUE/);
  inv.releaseReservation(a, r1, 1);
  a.close(); b.close();
});

// ---------------------------------------------------------------- stock updates
test('stock availability updates after reservation, transfer, dispatch, cancellation and inspected returns (SKU)', async () => {
  const id = P().ganesha;
  const showAvail = () => avail(id).byLocation.find((l) => l.location_id === L().show).available;
  const ledger0 = ledgerCount();

  let r = await sales.post('/stock/reserve', { product_id: id, location_id: L().show, qty: 5, customer_name: 'Kulkarni', confirm: true });
  assert.equal(r.status, 200);
  const res1 = r.body.reservation_id;
  assert.equal(avail(id).totals.available, 27);
  assert.equal(avail(id).totals.reserved, 5);
  assert.equal(showAvail(), 7);

  r = await store.post('/stock/transfer', { product_id: id, from_location_id: L().show, to_location_id: L().wh, qty: 8, condition: 'sellable', confirm: true });
  assert.equal(r.status, 409, 'cannot move reserved units');
  r = await store.post('/stock/transfer', { product_id: id, from_location_id: L().show, to_location_id: L().br, qty: 3, condition: 'sellable', rack: 'B-1', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(showAvail(), 4);
  assert.equal(avail(id).byLocation.find((l) => l.location_id === L().br).available, 3);
  assert.equal(avail(id).totals.available, 27, 'transfer moves stock without changing total');

  r = await store.post('/stock/dispatch', { reservation_id: res1, reference: 'INV-1', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(avail(id).totals.reserved, 0);
  assert.equal(avail(id).totals.physical, 33 - 5);
  assert.equal(avail(id).totals.available, 27);

  r = await sales.post('/stock/reserve', { product_id: id, location_id: L().show, qty: 2, confirm: true });
  assert.equal(avail(id).totals.available, 25);
  r = await sales.post('/stock/release', { reservation_id: r.body.reservation_id, reason: 'customer cancelled', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(avail(id).totals.available, 27, 'cancellation returns stock to available');

  r = await store.post('/stock/return', { product_id: id, location_id: L().show, qty: 1, result: 'sellable', confirm: true });
  assert.equal(avail(id).totals.available, 28);
  r = await store.post('/stock/return', { product_id: id, location_id: L().show, qty: 1, result: 'damaged', confirm: true });
  assert.equal(avail(id).totals.available, 28, 'damaged return is not saleable');
  assert.equal(avail(id).totals.damaged, 2);

  r = await store.post('/stock/count', { product_id: id, location_id: L().wh, condition: 'sellable', counted_qty: 19, confirm: true });
  assert.equal(r.body.delta, -1);
  assert.equal(avail(id).totals.available, 27);

  const moves = ctx.db.prepare('SELECT movement, qty FROM stock_ledger WHERE id > ? ORDER BY id').all(ledger0).map((m) => m.movement);
  assert.deepEqual(moves, ['reserve', 'transfer', 'dispatch', 'reserve', 'release', 'return', 'return', 'count_adjust']);
});

test('selling or reserving a particular piece updates exactly that piece (piece flow)', async () => {
  const [p0, p1, p2] = ctx.ids.hutchPieces;
  const state = (id) => ctx.db.prepare('SELECT status, location_id FROM pieces WHERE id = ?').get(id);
  const before1 = state(p1.id);
  let r = await sales.post('/stock/reserve', { piece_id: p0.id, confirm: true });
  assert.equal(state(p0.id).status, 'reserved');
  assert.deepEqual(state(p1.id), before1, 'sibling piece untouched');
  assert.equal(avail(P().hutch).totals.available, 1);

  r = await store.post('/stock/transfer', { piece_id: p0.id, to_location_id: L().show, rack: 'Zone B · Wall 3', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(state(p0.id).location_id, L().show);
  assert.equal(state(p0.id).status, 'reserved', 'still reserved after transfer');

  r = await store.post('/stock/dispatch', { piece_id: p0.id, reference: 'INV-9', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(state(p0.id).status, 'sold');
  assert.equal(ctx.db.prepare("SELECT status FROM reservations WHERE piece_id = ? ORDER BY id DESC").get(p0.id).status, 'fulfilled');
  assert.equal(avail(P().hutch).totals.physical, 4);

  r = await store.post('/stock/return', { piece_id: p0.id, location_id: L().wh, result: 'sellable', rack: 'WH-A3', confirm: true });
  assert.equal(state(p0.id).status, 'available');
  assert.equal(avail(P().hutch).totals.available, 2);

  // Dispatching an unreserved piece that is not saleable is refused
  assert.equal((await store.post('/stock/dispatch', { piece_id: ctx.ids.hutchPieces[3].id, confirm: true })).status, 409, 'damaged piece');
  assert.equal((await store.post('/stock/dispatch', { piece_id: ctx.ids.hutchPieces[4].id, confirm: true })).status, 409, 'display piece');

  const hist = (await sales.get('/pieces/' + p0.id)).body.history.map((h) => h.movement);
  assert.deepEqual(hist.slice(0, 4), ['return', 'dispatch', 'transfer', 'reserve']);
  void p2;
});

test('confirming an order re-checks availability and reserves all-or-nothing', async () => {
  const q = (await sales.post('/quotations', { customer_name: 'Order test', items: [
    { product_id: P().shelf, qty: 1 },
    { product_id: P().shelf, qty: 5 },          // only 2 exist
  ] })).body.id;
  let r = await sales.post(`/quotations/${q}/confirm`, { confirm: true });
  assert.equal(r.status, 409);
  assert.equal(avail(P().shelf).totals.reserved, 0, 'nothing reserved when one line fails');
  const items = (await sales.get('/quotations/' + q)).body.items;
  assert.equal((await sales.del('/quotation-items/' + items[1].id)).status, 200);
  r = await sales.post(`/quotations/${q}/confirm`, { confirm: true });
  assert.equal(r.status, 200);
  assert.equal(avail(P().shelf).totals.reserved, 1);
  r = await sales.post(`/quotations/${q}/cancel`, { confirm: true });
  assert.equal(avail(P().shelf).totals.reserved, 0, 'cancelling the order releases its stock');
});

test('a shortlist never reserves stock and can become a quotation', async () => {
  const s = (await sales.post('/shortlists', { customer_name: 'Shah' })).body.id;
  const a0 = avail(P().diningHoney).totals.available;
  await sales.post(`/shortlists/${s}/items`, { code: ctx.db.prepare('SELECT internal_code FROM products WHERE id = ?').get(P().diningHoney).internal_code, pref_finish: 'Honey', qty: 2 });
  await sales.post(`/shortlists/${s}/items`, { code: ctx.ids.hutchPieces[1].piece_code });
  assert.equal(avail(P().diningHoney).totals.available, a0);
  const list = (await sales.get('/shortlists/' + s)).body;
  assert.equal(list.items.length, 2);
  assert.equal(list.items[1].status, 'reserved', 'current availability is shown');
  const qid = (await sales.post(`/shortlists/${s}/quotation`)).body.id;
  const quote = (await sales.get('/quotations/' + qid)).body;
  assert.equal(quote.items.length, 2);
  assert.equal(quote.items[0].pref_finish, 'Honey');
  assert.equal(quote.items[1].can_fulfil, false, 'reserved piece flagged before confirming');
});

// ---------------------------------------------------------------- videos
test('product videos appear against the correct product / variant / piece', async () => {
  const titles = (vs) => vs.map((v) => v.title);
  const parent = (await sales.get('/videos?product_id=' + P().dining)).body;
  assert.deepEqual(titles(parent).sort(), ['Sample: Dining set overview (replace)', 'Sample: Finish options explained']);

  const honey = (await sales.get('/videos?product_id=' + P().diningHoney)).body;
  assert.deepEqual(titles(honey).sort(), ['Sample: Dining set overview (replace)', 'Sample: Finish options explained'], 'variant inherits parent videos');
  assert.ok(honey.every((v) => v.scope === 'same_design' && v.inherited));

  const walnut = (await sales.get('/videos?product_id=' + P().diningWalnut)).body;
  assert.deepEqual(titles(walnut).sort(), ['Sample: Dining set overview (replace)', 'Sample: Walnut finish close-up'], 'variant finish video overrides the parent finish video');
  assert.equal(walnut.find((v) => v.video_type === 'finish').scope, 'this_product');

  const display = ctx.ids.hutchPieces[4];
  const pv = (await sales.get(`/videos?product_id=${P().hutch}&piece_id=${display.id}`)).body;
  const exact = pv.find((v) => v.title.includes('this display cabinet'));
  assert.equal(exact.scope, 'exact_piece');
  assert.equal(exact.scope_label, 'Shows this exact piece');
  assert.ok(pv.filter((v) => v !== exact).every((v) => v.scope_label === 'Same design — not this exact piece'));

  const other = (await sales.get(`/videos?product_id=${P().hutch}&piece_id=${ctx.ids.hutchPieces[1].id}`)).body;
  assert.ok(!other.some((v) => v.scope === 'exact_piece'), 'another piece does not get this piece’s video');
  assert.ok(other.some((v) => v.visibility === 'internal'), 'staff see internal videos');
  assert.equal(other.filter((v) => v.is_primary).length, 1);

  assert.equal((await sales.get(`/videos?product_id=${P().ganesha}`)).body.length, 1, 'unrelated products have their own videos only');
});

test('YouTube URLs are validated and unavailable videos handled', async () => {
  for (const ok of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw?t=3', 'https://youtube.com/shorts/jNQXAC9IVRw', 'https://m.youtube.com/watch?feature=x&v=jNQXAC9IVRw', 'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw']) {
    assert.equal(parseYouTube(ok), 'jNQXAC9IVRw', ok);
  }
  for (const bad of ['https://vimeo.com/123', 'https://www.youtube.com/channel/UC123', 'https://evil.com/watch?v=jNQXAC9IVRw', 'javascript:alert(1)', 'https://youtu.be/short']) {
    assert.equal(parseYouTube(bad), null, bad);
  }
  let r = await manager.post('/videos', { product_id: P().shelf, title: 'Bad', url: 'https://vimeo.com/1', video_type: 'overview' });
  assert.equal(r.status, 400);
  r = await manager.post('/videos', { product_id: P().shelf, title: 'Shelf overview', url: 'https://youtu.be/jNQXAC9IVRw', video_type: 'overview', is_primary: true });
  assert.equal(r.status, 200);
  const vid = r.body.id;
  await sales.post(`/videos/${vid}/player-error`, { code: 150 });
  let pubData = await fetch(`${ctx.base}/api/public/p/${ctx.db.prepare('SELECT public_token FROM products WHERE id = ?').get(P().shelf).public_token}`).then((x) => x.json());
  assert.equal(pubData.videos[0].embeddable, false, 'embedding-disabled video falls back to a YouTube link');
  await sales.post(`/videos/${vid}/player-error`, { code: 100 });
  pubData = await fetch(`${ctx.base}/api/public/p/${ctx.db.prepare('SELECT public_token FROM products WHERE id = ?').get(P().shelf).public_token}`).then((x) => x.json());
  assert.equal(pubData.videos.length, 0, 'removed/private videos are hidden from customers');
});

// ---------------------------------------------------------------- public pages
const FORBIDDEN_KEYS = /cost|margin|vendor|internal|notes|customer_name|customer_phone|qty|quantity|physical|reserved|rack|location|ledger|created_by/i;
function walkKeys(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach((o) => walkKeys(o, out));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { out.push(k); walkKeys(v, out); }
  return out;
}

test('customer QR pages expose only approved public information', async () => {
  const db = ctx.db;
  const hutch = db.prepare('SELECT * FROM products WHERE id = ?').get(P().hutch);
  const damagedPiece = db.prepare('SELECT * FROM pieces WHERE id = ?').get(ctx.ids.hutchPieces[2].id);
  const secrets = ['41000', '41,000', 'Jodhpur Woodcraft', 'Negotiable', 'Mehta', 'WH-A3', 'WH-A4', 'Scratch detail', 'Assembly notes'];

  for (const token of [hutch.public_token, damagedPiece.public_token]) {
    const json = await fetch(`${ctx.base}/api/public/p/${token}`).then((r) => r.json());
    const keys = walkKeys(json);
    assert.deepEqual(keys.filter((k) => FORBIDDEN_KEYS.test(k)), [], 'no internal fields in public JSON');
    const html = await fetch(`${ctx.base}/p/${token}`).then((r) => r.text());
    const text = JSON.stringify(json) + html;
    for (const s of secrets) assert.ok(!text.includes(s), `public page leaks "${s}"`);
    assert.ok(!json.videos.some((v) => /internal/i.test(v.title)), 'internal videos hidden');
  }
  const pieceJson = await fetch(`${ctx.base}/api/public/p/${damagedPiece.public_token}`).then((r) => r.json());
  assert.equal(pieceJson.photos.some((p) => p.caption === 'Scratch detail'), false, 'unapproved photo hidden');
  assert.equal(pieceJson.price, 61000, 'piece-specific selling price');
  const displayJson = await fetch(`${ctx.base}/api/public/p/${db.prepare('SELECT public_token FROM pieces WHERE id = ?').get(ctx.ids.hutchPieces[4].id).public_token}`).then((r) => r.json());
  assert.equal(displayJson.price, null, 'display-only piece is not presented as saleable');
  assert.match(displayJson.availability_text, /display/i);
  assert.ok(!/\d/.test(pieceJson.availability_text), 'availability is wording only, no quantities');

  // the public page works without login; internal APIs do not
  assert.equal((await fetch(`${ctx.base}/p/${hutch.public_token}`)).status, 200);
  for (const p of [`/api/products/${hutch.id}`, '/api/search?q=hutch', `/api/scan?code=${hutch.internal_code}`, '/api/ledger', `/api/pieces/${damagedPiece.id}`]) {
    assert.equal((await fetch(ctx.base + p)).status, 401, p);
  }
  const csp = (await fetch(`${ctx.base}/p/${hutch.public_token}`)).headers.get('content-security-policy');
  assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com/);
  assert.equal((await fetch(`${ctx.base}/styles.css`)).headers.get('content-security-policy'), null, 'public CSP is scoped to public pages');

  // links can be disabled: per piece, per product, and globally
  await manager.put('/pieces/' + damagedPiece.id, { public_enabled: false });
  assert.equal((await fetch(`${ctx.base}/p/${damagedPiece.public_token}`)).status, 404);
  await manager.put('/products/' + hutch.id, { public_show_price: false });
  assert.equal((await fetch(`${ctx.base}/api/public/p/${hutch.public_token}`).then((r) => r.json())).price, null);
  await manager.put('/products/' + hutch.id, { public_enabled: false });
  assert.equal((await fetch(`${ctx.base}/api/public/p/${hutch.public_token}`)).status, 404);
  await manager.put('/products/' + hutch.id, { public_enabled: true, public_show_price: true });
  await manager.put('/settings', { public_pages_enabled: false });
  assert.equal((await fetch(`${ctx.base}/p/${hutch.public_token}`)).status, 404);
  await manager.put('/settings', { public_pages_enabled: true });
  assert.equal((await fetch(`${ctx.base}/p/${hutch.public_token}`)).status, 200);

  // public enquiry is stored but needs a valid phone
  assert.equal((await fetch(`${ctx.base}/api/public/p/${hutch.public_token}/enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A', phone: 'x' }) })).status, 400);
  assert.equal((await fetch(`${ctx.base}/api/public/p/${hutch.public_token}/enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Anita', phone: '+91 98200 00000' }) })).status, 200);
});

test('shared customer catalogue is off by default and shows only approved fields', async () => {
  const s = (await sales.post('/shortlists', { customer_name: 'Rao Family', customer_phone: '9800000000' })).body.id;
  await sales.post(`/shortlists/${s}/items`, { product_id: P().hutch, piece_id: ctx.ids.hutchPieces[0].id });
  const token = ctx.db.prepare('SELECT share_token FROM shortlists WHERE id = ?').get(s).share_token;
  assert.equal((await fetch(`${ctx.base}/c/${token}`)).status, 404);
  await sales.patch('/shortlists/' + s, { share_enabled: true });
  const json = await fetch(`${ctx.base}/api/public/c/${token}`).then((r) => r.json());
  assert.deepEqual(walkKeys(json).filter((k) => FORBIDDEN_KEYS.test(k) && k !== 'qty'), []);
  const text = JSON.stringify(json) + await fetch(`${ctx.base}/c/${token}`).then((r) => r.text());
  for (const sec of ['41000', 'Jodhpur', '9800000000', 'Rao Family', 'Negotiable']) assert.ok(!text.includes(sec), sec);
  assert.equal(json.items[0].price, 68000);
  await sales.patch('/shortlists/' + s, { share_show_prices: false });
  assert.equal((await fetch(`${ctx.base}/api/public/c/${token}`).then((r) => r.json())).items[0].price, null);
});

// ---------------------------------------------------------------- codes
test('internal codes are stable and manufacturer barcodes are validated for duplicates', async () => {
  const id = P().desk;
  const before = ctx.db.prepare('SELECT internal_code, public_token FROM products WHERE id = ?').get(id);
  await manager.put('/products/' + id, { name: 'Study Table Renamed', selling_price: 27000, internal_code: 'HACK', public_token: 'HACKHACKHACK' });
  await store.post('/stock/transfer', { product_id: id, from_location_id: L().br, to_location_id: L().show, qty: 1, confirm: true });
  const after = ctx.db.prepare('SELECT internal_code, public_token, name FROM products WHERE id = ?').get(id);
  assert.equal(after.name, 'Study Table Renamed');
  assert.deepEqual([after.internal_code, after.public_token], [before.internal_code, before.public_token]);

  const ganeshaEan = ctx.db.prepare('SELECT mfr_barcode FROM products WHERE id = ?').get(P().ganesha).mfr_barcode;
  let r = await manager.put('/products/' + id, { mfr_barcode: ganeshaEan });
  assert.equal(r.status, 409, 'duplicate manufacturer barcode');
  r = await manager.put('/pieces/' + ctx.ids.hutchPieces[1].id, { mfr_barcode: ganeshaEan });
  assert.equal(r.status, 409, 'duplicate across products and pieces');
  r = await manager.put('/products/' + id, { mfr_barcode: '8901234567891' });
  assert.equal(r.status, 400, 'bad EAN check digit');
  r = await manager.put('/products/' + id, { mfr_barcode: before.internal_code });
  assert.equal(r.status, 400, 'cannot reuse internal code prefix');
  r = await manager.put('/products/' + id, { mfr_barcode: '4006381333931' });
  assert.equal(r.status, 200);
  assert.equal((await sales.get('/scan?code=4006381333931')).body.product_id, id);
  const created = (await manager.post('/products', { name: 'New Stool', sku: 'ah-stl-1', selling_price: 4000 })).body;
  assert.match(created.internal_code, /^AHP-\d{6}$/);
  assert.equal((await manager.post('/products', { name: 'Dup', sku: 'AH-STL-1' })).status, 409);
});

test('Code 128 encoder produces correct check characters', () => {
  // Known value: "AHP-000001" → Start B, A H P - , Code C, 00 00 01, checksum, stop
  const v = code128Values('AHP-000001');
  assert.deepEqual(v.slice(0, 9), [104, 33, 40, 48, 13, 99, 0, 0, 1]);
  let sum = v[0]; for (let i = 1; i < v.length - 2; i++) sum += v[i] * i;
  assert.equal(v[v.length - 2], sum % 103);
  assert.equal(v[v.length - 1], 106);
  assert.throws(() => code128Values('café'));
});

// ---------------------------------------------------------------- labels
/** Rasterise label primitives at the printer's resolution, on white paper with a 3 mm margin. */
function rasterise(lab, dpi, region) {
  const dpmm = dpi / 25.4, m = 3;
  const W = Math.ceil((lab.w + 2 * m) * dpmm), H = Math.ceil((lab.h + 2 * m) * dpmm);
  const px = new Uint8ClampedArray(W * H).fill(255);
  for (const it of lab.items) {
    if (it.t !== 'rect' || !it[region]) continue;
    const x0 = Math.round((it.x + m) * dpmm), x1 = Math.round((it.x + it.w + m) * dpmm);
    const y0 = Math.round((it.y + m) * dpmm), y1 = Math.round((it.y + it.h + m) * dpmm);
    for (let y = y0; y < y1; y++) px.fill(0, y * W + x0, y * W + x1);
  }
  return { px, W, H };
}
function decodeJsQR({ px, W, H }) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < px.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i]; rgba[i * 4 + 3] = 255; }
  const r = jsQR(rgba, W, H);
  return r && r.data;
}
function decode({ px, W, H }, format) {
  const reader = new MultiFormatReader();
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [format]], [DecodeHintType.TRY_HARDER, true]]);
  reader.setHints(hints);
  return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(px, W, H))), hints).getText();
}

test('bulk-generated labels scan correctly at the intended printed size', async () => {
  const db = ctx.db;
  const tpls = db.prepare('SELECT * FROM label_templates').all();
  const items = [
    ...db.prepare('SELECT id FROM products').all().map((p) => ({ type: 'product', id: p.id })),
    ...db.prepare('SELECT id FROM pieces').all().map((p) => ({ type: 'piece', id: p.id })),
  ];
  // Which code modes must print without size warnings on each stock label size
  const mustBeClean = (t) => t.width_mm >= 60 ? ['both', 'barcode', 'qr'] : t.width_mm >= 50 ? ['barcode', 'qr'] : ['qr'];
  let decoded = 0;
  for (const tpl of tpls) {
    for (const content of ['both', 'barcode', 'qr']) {
      const opts = { content, show_price: true, show_specs: true };
      for (const it of items) {
        const data = labels.labelData(db, it, opts, 'https://showroom.example.test', 'Airawat Handicraft');
        const lab = labels.layoutLabel(data, tpl, opts);
        const clean = lab.checks.warnings.length === 0;
        if (mustBeClean(tpl).includes(content)) assert.ok(clean, `${tpl.name} [${content}]: ${lab.checks.warnings.join('; ')}`);
        if (!clean) continue;  // the label screen shows the warning before printing
        if (lab.checks.qr) {
          assert.ok(lab.checks.qr.module_mm >= 0.33 && Number.isInteger(lab.checks.qr.module_dots));
          const img = rasterise(lab, tpl.dpi, 'qr');
          assert.equal(decode(img, BarcodeFormat.QR_CODE), data.qr, `${tpl.name} [${content}] QR ${data.barcode} (ZXing)`);
          assert.equal(decodeJsQR(img), data.qr, `${tpl.name} [${content}] QR ${data.barcode} (jsQR)`);
          decoded++;
        }
        if (lab.checks.barcode) {
          assert.ok(lab.checks.barcode.x_mm >= labels.MIN_X_MM - 0.001 && lab.checks.barcode.height_mm >= 5);
          assert.equal(decode(rasterise(lab, tpl.dpi, 'barcode'), BarcodeFormat.CODE_128), data.barcode, `${tpl.name} [${content}] barcode`);
          decoded++;
        }
      }
    }
  }
  assert.ok(decoded > 200, `decoded ${decoded}`);
  // the smallest sheet warns instead of silently printing an unreadable barcode
  const tiny = tpls.find((t) => t.width_mm < 40);
  const w = labels.layoutLabel(labels.labelData(db, items[0], {}, 'https://x.test', 'A'), tiny, { content: 'both' }).checks.warnings;
  assert.ok(w.some((x) => /Barcode bars/.test(x)));

  // manufacturer barcode option prints the existing EAN
  const g = labels.labelData(db, { type: 'product', id: P().ganesha }, { use_mfr: true }, 'https://x.test', 'A');
  const t = tpls.find((x) => x.layout === 'thermal');
  assert.equal(decode(rasterise(labels.layoutLabel(g, t, { content: 'barcode' }), t.dpi, 'barcode'), BarcodeFormat.CODE_128), '8901234567890');
});

test('QR codes that trip ZXing are regenerated with a readable mask', () => {
  // Valid codes (jsQR reads them) that ZXing's reader rejects with the default mask
  for (const url of ['https://showroom.example.test/p/G5JNe4SxfZBg', 'https://showroom.example.test/p/XBRYOH9AmKam']) {
    const data = { business: 'A', name: 'X', sku: 'S', barcode: 'AHP-000001', qr: url };
    const tpl = { width_mm: 50, height_mm: 25, dpi: 203, layout: 'thermal' };
    const img = rasterise(labels.layoutLabel(data, tpl, { content: 'qr' }), 203, 'qr');
    assert.equal(decode(img, BarcodeFormat.QR_CODE), url);
    assert.equal(decodeJsQR(img), url);
  }
});

test('label PDFs and ZPL never contain cost, margin or vendor', async () => {
  const tpl = ctx.db.prepare("SELECT * FROM label_templates WHERE layout = 'a4' ORDER BY width_mm DESC").get();
  const items = [{ type: 'product_pieces', id: P().hutch }, { type: 'product', id: P().ganesha, copies: 30 }];
  const r = await sales.post('/labels/preview', { template_id: tpl.id, items, show_price: true, show_specs: true, content: 'both' });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 5 + 30, 'one label per unsold piece plus copies');
  assert.equal(r.body.pages, Math.ceil(35 / (tpl.cols * tpl.rows)));
  for (const l of r.body.labels) assert.deepEqual(Object.keys(l).filter((k) => /cost|margin|vendor/i.test(k)), []);

  const datas = [];
  for (const pc of ctx.db.prepare('SELECT id FROM pieces WHERE product_id = ?').all(P().hutch)) datas.push(labels.labelData(ctx.db, { type: 'piece', id: pc.id }, { show_price: true, show_specs: true }, 'https://x.test', 'Airawat Handicraft'));
  const pdf = (await labels.renderPdf(datas.map((d) => labels.layoutLabel(d, tpl, {})), tpl, { compress: false })).toString('latin1');
  assert.ok(pdf.startsWith('%PDF'));
  // pdfkit writes text as hex glyph strings (split at kerning pairs): decode and join them
  const printed = [...pdf.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
  assert.ok(printed.includes('Rs. 68,000'), 'selling price printed when chosen');
  assert.ok(printed.includes('AIRAWAT HANDICRAFT') && printed.includes('AH-CAB-HUTCH'));
  assert.ok(!/41000|41,000|Jodhpur|Negotiable/.test(printed + pdf), 'cost/vendor not printed');

  const thermal = ctx.db.prepare("SELECT * FROM label_templates WHERE layout = 'thermal'").get();
  const zpl = await sales.post('/labels/zpl', { template_id: thermal.id, items: [{ type: 'product', id: P().ganesha, copies: 2 }], show_price: true });
  const z = zpl.body.toString();
  assert.equal((z.match(/\^XA/g) || []).length, 2);
  assert.match(z, /\^BC/); assert.match(z, /\^BQ/);
  assert.ok(!/4100|Moradabad/.test(z));

  const res = await sales.post('/labels/pdf', { template_id: tpl.id, items: [{ type: 'product', id: P().ganesha }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.subarray(0, 4).toString(), '%PDF');
});

test('search finds products by name, SKU, barcode, category, material, finish and dimensions', async () => {
  const q = async (s) => (await sales.get('/search?q=' + encodeURIComponent(s))).body.map((c) => c.sku);
  assert.ok((await q('hutch')).includes('AH-CAB-HUTCH'));
  assert.ok((await q('ah-idl')).includes('AH-IDL-GANESH-M'));
  assert.ok((await q('8901234567890')).includes('AH-IDL-GANESH-M'));
  assert.ok((await q(ctx.ids.hutchPieces[3].piece_code)).includes('AH-CAB-HUTCH'));
  assert.ok((await q('cabinets')).includes('AH-CAB-HUTCH'));
  assert.ok((await q('mango')).includes('AH-CHD-MANGO-4'));
  assert.ok((await q('walnut dining')).includes('AH-DIN-6S-WAL'));
  const d = await q('180x90');
  assert.ok(d.includes('AH-DIN-6S-HON') && !d.includes('AH-CAB-HUTCH'));
  assert.ok((await q('120x45x180')).includes('AH-CAB-HUTCH'));
  const avNow = (await sales.get('/search?availability=available_now')).body;
  assert.ok(avNow.every((c) => c.status === 'available_now'));
  const alts = (await sales.get('/products/' + P().chest)).body.alternatives;
  assert.ok(alts.length && alts.every((a) => a.status === 'available_now'));
  assert.equal(alts[0].sku, 'AH-CHD-SHEE-5', 'closest available alternative first');
});

test('cost is visible only to roles allowed to see it', async () => {
  const s = (await sales.get('/products/' + P().hutch)).body;
  assert.equal(s.cost_price, undefined); assert.equal(s.vendor, undefined);
  assert.ok(s.pieces.every((p) => p.cost_price === undefined));
  const m = (await manager.get('/products/' + P().hutch)).body;
  assert.equal(m.cost_price, 41000);
});
