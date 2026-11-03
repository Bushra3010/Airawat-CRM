'use strict';
/**
 * Demo data. Run `npm run seed` (wipes data/airawat.db).
 *
 * Demo staff logins (test values for this app only — change before real use):
 *   admin   / airawat-admin    (Admin)
 *   manager / airawat-manager  (Manager — sees costs)
 *   sales   / airawat-sales    (Sales — find, shortlist, quote, reserve)
 *   store   / airawat-store    (Storekeeper — receive, transfer, dispatch, count)
 *   sales2  / airawat-sales2   (Second sales login for reservation-conflict testing)
 */
const fs = require('fs');
const path = require('path');
const { open, migrate, TABLES } = require('./db');
const { nextCode, newToken } = require('./codes');
const { hashPassword } = require('./server');
const { DEFAULT_TEMPLATES } = require('./labels');
const inv = require('./inventory');

const USERS = [
  ['admin', 'Aarti (Admin)', 'admin', 'airawat-admin'],
  ['manager', 'Rohan (Manager)', 'manager', 'airawat-manager'],
  ['sales', 'Priya (Sales)', 'sales', 'airawat-sales'],
  ['store', 'Vikram (Store)', 'storekeeper', 'airawat-store'],
  ['sales2', 'Imran (Sales)', 'sales', 'airawat-sales2'],
];

// Simple illustrated placeholder photos (replace with real product photos).
const SHAPES = {
  cabinet: '<rect x="90" y="40" width="220" height="200" rx="6" fill="#8a5a33"/><rect x="105" y="55" width="90" height="110" fill="#a8743f"/><rect x="205" y="55" width="90" height="110" fill="#a8743f"/><rect x="105" y="175" width="190" height="50" fill="#9c6a39"/><circle cx="188" cy="110" r="4" fill="#e2c26b"/><circle cx="212" cy="110" r="4" fill="#e2c26b"/><rect x="100" y="240" width="12" height="20" fill="#6d4526"/><rect x="288" y="240" width="12" height="20" fill="#6d4526"/>',
  table: '<rect x="50" y="110" width="300" height="22" rx="4" fill="#9a6535"/><rect x="70" y="132" width="16" height="120" fill="#7b4e28"/><rect x="314" y="132" width="16" height="120" fill="#7b4e28"/><rect x="100" y="70" width="40" height="50" rx="4" fill="#b98250"/><rect x="260" y="70" width="40" height="50" rx="4" fill="#b98250"/>',
  bed: '<rect x="40" y="150" width="320" height="60" rx="6" fill="#8a5a33"/><rect x="40" y="40" width="14" height="210" fill="#6d4526"/><rect x="346" y="40" width="14" height="210" fill="#6d4526"/><rect x="40" y="40" width="320" height="10" fill="#6d4526"/><rect x="60" y="130" width="280" height="30" rx="10" fill="#efe6d8"/><rect x="70" y="110" width="80" height="28" rx="10" fill="#fff"/>',
  idol: '<ellipse cx="200" cy="245" rx="90" ry="14" fill="#a07a2c"/><circle cx="200" cy="170" r="60" fill="#d4a93c"/><circle cx="200" cy="95" r="38" fill="#e2bb4f"/><path d="M200 110 q-30 40 -10 80" stroke="#b88c25" stroke-width="12" fill="none"/><circle cx="200" cy="52" r="12" fill="#c69a30"/>',
  swing: '<rect x="40" y="30" width="320" height="14" fill="#6d4526"/><line x1="110" y1="44" x2="110" y2="170" stroke="#b08a3a" stroke-width="5"/><line x1="290" y1="44" x2="290" y2="170" stroke="#b08a3a" stroke-width="5"/><rect x="90" y="170" width="220" height="30" rx="6" fill="#8a5a33"/><rect x="90" y="120" width="220" height="50" rx="6" fill="#a8743f"/>',
  drawers: '<rect x="110" y="40" width="180" height="210" rx="6" fill="#9c6a39"/>' + [0, 1, 2, 3].map((i) => `<rect x="122" y="${52 + i * 48}" width="156" height="40" fill="#b98250"/><circle cx="200" cy="${72 + i * 48}" r="5" fill="#e2c26b"/>`).join(''),
  sofa: '<rect x="50" y="130" width="300" height="70" rx="14" fill="#7a3b2e"/><rect x="70" y="80" width="260" height="70" rx="14" fill="#934a3a"/><rect x="40" y="110" width="40" height="100" rx="12" fill="#7a3b2e"/><rect x="320" y="110" width="40" height="100" rx="12" fill="#7a3b2e"/><rect x="70" y="200" width="12" height="30" fill="#4d2a1d"/><rect x="318" y="200" width="12" height="30" fill="#4d2a1d"/>',
  tv: '<rect x="40" y="170" width="320" height="70" rx="6" fill="#8a5a33"/><rect x="55" y="182" width="90" height="46" fill="#a8743f"/><rect x="255" y="182" width="90" height="46" fill="#a8743f"/><rect x="110" y="50" width="180" height="105" rx="4" fill="#2c2c2c"/>',
  shelf: '<rect x="120" y="30" width="160" height="230" fill="#8a5a33"/>' + [0, 1, 2, 3].map((i) => `<rect x="130" y="${40 + i * 55}" width="140" height="45" fill="#f1e6d4"/><rect x="${136 + i * 8}" y="${50 + i * 55}" width="14" height="35" fill="#c0392b"/><rect x="${154 + i * 8}" y="${54 + i * 55}" width="12" height="31" fill="#2e6b8a"/>`).join(''),
  desk: '<rect x="50" y="110" width="300" height="20" fill="#9a6535"/><rect x="60" y="130" width="100" height="110" fill="#8a5a33"/><rect x="70" y="140" width="80" height="40" fill="#b98250"/><rect x="330" y="130" width="14" height="110" fill="#7b4e28"/>',
};
function photoSvg(shape, bg, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="${bg}"/><rect y="255" width="400" height="45" fill="#00000010"/>${SHAPES[shape]}<text x="200" y="285" font-family="Helvetica,Arial" font-size="15" text-anchor="middle" fill="#5a4a3c">${label}</text></svg>`;
}

const SAMPLE_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // placeholder — replace with your product videos

async function seed(db, { photoDir } = {}) {
  await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

  for (const [k, v] of [['business_name', 'Airawat Handicraft'], ['public_pages_enabled', '1'], ['public_show_prices', '1'], ['public_show_expected_date', '0'],
    ['currency', 'INR'], ['showroom_contact', '+91 98229 97011']]) await db.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [k, v]);

  const users = {};
  for (const [u, n, r, pw] of USERS) users[u] = (await db.one('INSERT INTO users (username, name, role, pass_hash) VALUES ($1, $2, $3, $4) RETURNING id', [u, n, r, hashPassword(pw)])).id;

  const loc = async (code, name, type) => (await db.one('INSERT INTO locations (code, name, type) VALUES ($1, $2, $3) RETURNING id', [code, name, type])).id;
  const L = { show: await loc('SHR', 'Baner Showroom', 'showroom'), wh: await loc('WH1', 'Main Warehouse', 'warehouse'), br: await loc('BR2', 'Second Branch', 'branch') };

  for (const t of DEFAULT_TEMPLATES) {
    const r = { cols: null, rows: null, margin_top_mm: 0, margin_left_mm: 0, gap_x_mm: 0, gap_y_mm: 0, ...t };
    await db.query(`INSERT INTO label_templates (name, layout, width_mm, height_mm, cols, rows, margin_top_mm, margin_left_mm, gap_x_mm, gap_y_mm, dpi)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [r.name, r.layout, r.width_mm, r.height_mm, r.cols, r.rows, r.margin_top_mm, r.margin_left_mm, r.gap_x_mm, r.gap_y_mm, r.dpi]);
  }

  if (photoDir) fs.mkdirSync(photoDir, { recursive: true });
  const COLS = ['internal_code', 'public_token', 'sku', 'parent_id', 'variant_label', 'name', 'category', 'material', 'finish', 'length_cm', 'width_cm', 'height_cm',
    'description', 'care', 'short_specs', 'selling_price', 'cost_price', 'vendor', 'internal_notes', 'tracking', 'made_to_order', 'lead_time_days', 'mfr_barcode'];
  const pIns = async (p) => {
    const row = { parent_id: null, variant_label: null, category: null, material: null, finish: null, length_cm: null, width_cm: null, height_cm: null, description: null, care: null,
      short_specs: null, cost_price: null, vendor: null, internal_notes: null, tracking: 'sku', made_to_order: 0, lead_time_days: null, mfr_barcode: null, ...p,
      internal_code: await nextCode(db, 'AHP'), public_token: newToken() };
    const { id } = await db.one(`INSERT INTO products (${COLS.join(',')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, COLS.map((c) => row[c]));
    if (p.shape) {
      const file = `${p.sku.toLowerCase()}.svg`;
      if (photoDir) fs.writeFileSync(path.join(photoDir, file), photoSvg(p.shape, p.bg || '#f3ece2', p.name.replace(/&/g, 'and')));
      await db.query('INSERT INTO photos (product_id, url, is_public, sort) VALUES ($1, $2, 1, 0)', [id, `/seed-img/${file}`]);
    }
    return id;
  };
  const care = 'Dust with a soft dry cloth. Avoid direct sunlight and moisture. Polish with wax every 6 months.';
  const P = {};
  P.hutch = await pIns({ sku: 'AH-CAB-HUTCH', name: 'Sheesham Hutch Cabinet', category: 'Cabinets', material: 'Sheesham wood', finish: 'Honey', length_cm: 120, width_cm: 45, height_cm: 180,
    description: 'Hand-carved solid Sheesham hutch with glass-panel upper doors and brass fittings. Each cabinet is finished by hand, so grain and tone vary slightly.',
    care, selling_price: 68000, cost_price: 41000, vendor: 'Jodhpur Woodcraft Works', internal_notes: 'Negotiable to 62k for showroom pieces', tracking: 'piece', shape: 'cabinet' });
  P.dining = await pIns({ sku: 'AH-DIN-6S', name: 'Sheesham 6 Seater Dining Set', category: 'Dining Room', material: 'Sheesham wood', length_cm: 180, width_cm: 90, height_cm: 76,
    description: 'Six-seater dining table with six cushioned chairs. Available in two finishes.', care, selling_price: 89000, cost_price: 54000, vendor: 'Jodhpur Woodcraft Works', shape: 'table', active: 1 });
  P.diningHoney = await pIns({ sku: 'AH-DIN-6S-HON', parent_id: P.dining, variant_label: 'Honey finish', name: 'Sheesham 6 Seater Dining Set', category: 'Dining Room', material: 'Sheesham wood', finish: 'Honey',
    length_cm: 180, width_cm: 90, height_cm: 76, care, selling_price: 89000, cost_price: 54000, vendor: 'Jodhpur Woodcraft Works', shape: 'table', bg: '#f6ead4' });
  P.diningWalnut = await pIns({ sku: 'AH-DIN-6S-WAL', parent_id: P.dining, variant_label: 'Walnut finish', name: 'Sheesham 6 Seater Dining Set', category: 'Dining Room', material: 'Sheesham wood', finish: 'Walnut',
    length_cm: 180, width_cm: 90, height_cm: 76, care, selling_price: 92000, cost_price: 55500, vendor: 'Jodhpur Woodcraft Works', shape: 'table', bg: '#e9dccb' });
  P.bed = await pIns({ sku: 'AH-BED-POSTER-K', name: 'Teak Poster Bed — King', category: 'Bedroom', material: 'Teak wood', finish: 'Natural teak', length_cm: 213, width_cm: 198, height_cm: 210,
    description: 'Four-poster king bed in seasoned teak with carved headboard. Made to order in your choice of finish.', care, selling_price: 145000, cost_price: 88000, vendor: 'In-house workshop',
    made_to_order: 1, lead_time_days: 45, shape: 'bed' });
  P.ganesha = await pIns({ sku: 'AH-IDL-GANESH-M', name: 'Brass Ganesha Idol — Medium', category: 'Temple/Statues', material: 'Brass', finish: 'Antique gold', length_cm: 20, width_cm: 15, height_cm: 30,
    description: 'Solid brass Ganesha with antique gold finish.', care: 'Wipe with a dry cloth. Clean occasionally with a brass cleaner.', selling_price: 7800, cost_price: 4100, vendor: 'Moradabad Metal Arts',
    mfr_barcode: '8901234567890', shape: 'idol', bg: '#f7efdc', short_specs: 'Brass · 30 cm tall' });
  P.jhula = await pIns({ sku: 'AH-SWG-ANTQ', name: 'Antique Carved Jhula (Swing)', category: 'Showpieces', material: 'Teak wood', finish: 'Aged natural', length_cm: 150, width_cm: 60, height_cm: 200,
    description: 'Restored antique teak jhula with brass chains. One of a kind.', care, selling_price: 210000, cost_price: 120000, vendor: 'Private collection', tracking: 'piece', shape: 'swing' });
  P.chest = await pIns({ sku: 'AH-CHD-MANGO-4', name: 'Mango Wood Chest of 4 Drawers', category: 'Chest of Drawers', material: 'Mango wood', finish: 'Honey oak', length_cm: 80, width_cm: 45, height_cm: 95,
    description: 'Four-drawer chest with ceramic knobs.', care, selling_price: 24500, cost_price: 14000, vendor: 'Saharanpur Craft Co.', shape: 'drawers' });
  P.chest2 = await pIns({ sku: 'AH-CHD-SHEE-5', name: 'Sheesham Chest of 5 Drawers', category: 'Chest of Drawers', material: 'Sheesham wood', finish: 'Honey', length_cm: 85, width_cm: 45, height_cm: 110,
    description: 'Five-drawer chest with brass handles.', care, selling_price: 27500, cost_price: 16500, vendor: 'Jodhpur Woodcraft Works', shape: 'drawers', bg: '#f6ead4' });
  P.sofa = await pIns({ sku: 'AH-SCB-3S', name: 'Sofa Cum Bed — 3 Seater', category: 'Sofa Cum Beds', material: 'Sheesham wood', finish: 'Walnut', length_cm: 195, width_cm: 85, height_cm: 85,
    description: 'Pull-out sofa cum bed with upholstered cushions.', care, selling_price: 52000, cost_price: 31000, vendor: 'Pune Upholstery', shape: 'sofa' });
  P.tv = await pIns({ sku: 'AH-TVU-180', name: 'Carved TV Unit 180', category: 'TV Units', material: 'Sheesham wood', finish: 'Provincial teak', length_cm: 180, width_cm: 45, height_cm: 55,
    description: 'Low TV unit with two cabinets and an open shelf.', care, selling_price: 38500, cost_price: 22000, vendor: 'Jodhpur Woodcraft Works', shape: 'tv' });
  P.shelf = await pIns({ sku: 'AH-BKS-5T', name: 'Five Tier Book Shelf', category: 'Book Shelves', material: 'Sheesham wood', finish: 'Natural', length_cm: 90, width_cm: 35, height_cm: 180,
    description: 'Tall open bookshelf with five tiers.', care, selling_price: 21000, cost_price: 12500, vendor: 'Jodhpur Woodcraft Works', shape: 'shelf' });
  P.desk = await pIns({ sku: 'AH-STD-120', name: 'Study Table with Drawers', category: 'Office & Study', material: 'Sheesham wood', finish: 'Walnut', length_cm: 120, width_cm: 60, height_cm: 76,
    description: 'Study table with three drawers on one side.', care, selling_price: 26000, cost_price: 15500, vendor: 'Jodhpur Woodcraft Works', shape: 'desk' });

  const u = users.store;
  // Hutch cabinet: five physical cabinets, same SKU, each its own piece.
  const hutch = (await inv.receive(db, { productId: P.hutch, locationId: L.wh, userId: u, reference: 'GRN-1001', pieces: [
    { condition: 'New', finish_note: 'Honey, even grain', cost_price: 41000, selling_price: 68000, rack: 'WH-A3' },
    { condition: 'New', finish_note: 'Honey, darker grain', cost_price: 41000, selling_price: 68000, rack: 'WH-A3' },
    { condition: 'Minor scratch on left side', finish_note: 'Honey', cost_price: 41000, selling_price: 61000, rack: 'WH-A4' },
    { condition: 'Glass panel cracked', finish_note: 'Honey', cost_price: 41000, selling_price: 68000, rack: 'WH-QC', status: 'damaged' },
  ] })).created;
  const showHutch = (await inv.receive(db, { productId: P.hutch, locationId: L.show, userId: u, reference: 'GRN-1001', pieces: [
    { condition: 'Display — light wear', finish_note: 'Honey', cost_price: 41000, selling_price: 64000, rack: 'Zone B · Wall 2', status: 'display' },
  ] })).created;
  await db.query("INSERT INTO photos (product_id, piece_id, url, caption, is_public) VALUES ($1, $2, '/seed-img/ah-cab-hutch.svg', 'Scratch detail', 0)", [P.hutch, hutch[2].id]);
  await inv.reserve(db, { pieceId: hutch[1].id, customerName: 'Mehta family', userId: users.sales });

  await inv.receive(db, { productId: P.jhula, locationId: L.show, userId: u, reference: 'ACQ-77', pieces: [
    { condition: 'Restored antique', finish_note: 'Aged natural teak', cost_price: 120000, selling_price: 210000, rack: 'Entrance atrium', status: 'display' },
  ] });

  const rcv = (productId, l, qty, rack, condition = 'sellable') => inv.receive(db, { productId, locationId: l, qty, rack, condition, userId: u, reference: 'OPENING' });
  await rcv(P.diningHoney, L.show, 1, 'Zone A · Dining 1', 'display');
  await rcv(P.diningHoney, L.wh, 2, 'WH-C1');
  await rcv(P.diningWalnut, L.br, 1, 'Floor 1');
  await rcv(P.ganesha, L.show, 12, 'Zone D · Shelf 3');
  await rcv(P.ganesha, L.wh, 20, 'WH-S2');
  await rcv(P.ganesha, L.show, 1, 'Zone D · Shelf 3', 'damaged');
  await rcv(P.chest2, L.wh, 3, 'WH-B2');
  await rcv(P.sofa, L.wh, 1, 'WH-QC', 'damaged');
  await rcv(P.tv, L.show, 1, 'Zone C · Living 2', 'display_sale');
  await rcv(P.tv, L.wh, 2, 'WH-B5');
  await rcv(P.shelf, L.show, 2, 'Zone E');
  await rcv(P.desk, L.br, 3, 'Floor 2');
  await db.query("INSERT INTO incoming (product_id, kind, qty, expected_date, status, note, created_by) VALUES ($1, 'purchase', 6, current_date + 21, 'ordered', 'PO-2231', $2)", [P.chest, users.manager]);
  await db.query("INSERT INTO incoming (product_id, kind, qty, expected_date, status, note, created_by) VALUES ($1, 'production', 2, current_date + 30, 'ordered', 'Workshop batch', $2)", [P.sofa, users.manager]);

  const vIns = (productId, pieceId, title, type, primary, visibility, overrides) => db.query(`INSERT INTO videos (product_id, piece_id, title, url, youtube_id, video_type, is_primary, visibility, overrides_parent)
    VALUES ($1, $2, $3, $4, 'jNQXAC9IVRw', $5, $6, $7, $8)`, [productId, pieceId, title, SAMPLE_VIDEO, type, primary, visibility, overrides]);
  await vIns(P.hutch, null, 'Sample: Hutch cabinet overview (replace)', 'overview', 1, 'customer', 0);
  await vIns(P.hutch, null, 'Sample: Assembly notes for delivery team (internal)', 'installation', 0, 'internal', 0);
  await vIns(P.hutch, showHutch[0].id, 'Sample: Walkaround of this display cabinet', 'demonstration', 0, 'customer', 0);
  await vIns(P.dining, null, 'Sample: Dining set overview (replace)', 'overview', 1, 'customer', 0);
  await vIns(P.dining, null, 'Sample: Finish options explained', 'finish', 0, 'customer', 0);
  await vIns(P.diningWalnut, null, 'Sample: Walnut finish close-up', 'finish', 0, 'customer', 1);
  await vIns(P.ganesha, null, 'Sample: Brass care guide', 'care', 1, 'customer', 0);

  return { users, locations: L, products: P, hutchPieces: [...hutch, ...showHutch] };
}

/**
 * Database setup: create tables (idempotent), lock them down, create the photo bucket,
 * and load demo data only into an empty database (or with --reset, which wipes everything).
 */
async function setup({ reset = false, demo = true } = {}) {
  const db = open();
  try {
    await migrate(db);
    console.log('Tables ready (row level security on)');
    if (await require('./storage').ensureBucket()) console.log('Photo storage bucket ready');
    const { n } = await db.one('SELECT COUNT(*)::int n FROM users');
    if (reset || (n === 0 && demo)) {
      await seed(db, { photoDir: path.join(__dirname, '..', 'public', 'seed-img') });
      console.log('Demo data loaded — demo logins are listed at the top of src/seed.js');
    } else if (n > 0) {
      console.log('Existing data kept (use --reset to wipe and reload demo data)');
    }
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  require('./env');
  const args = process.argv.slice(2);
  setup({ reset: args.includes('--reset'), demo: !args.includes('--no-demo') }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { seed, setup, USERS, photoSvg };
