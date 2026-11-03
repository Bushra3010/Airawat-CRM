'use strict';
const inv = require('./inventory');
const { ytThumb, ytWatch } = require('./codes');

const STATUS_LABEL = {
  available_now: 'Available Now', reserved: 'Reserved', out_of_stock: 'Out of Stock',
  made_to_order: 'Made to Order', display_only: 'Display Only', damaged: 'Damaged', sold: 'Sold', in_transit: 'In Transit',
};

async function primaryPhoto(db, productId, pieceId) {
  if (pieceId) {
    const p = await db.one('SELECT url FROM photos WHERE piece_id = $1 ORDER BY sort, id LIMIT 1', [pieceId]);
    if (p) return p.url;
  }
  const p = await db.one('SELECT url FROM photos WHERE product_id = $1 AND piece_id IS NULL ORDER BY sort, id LIMIT 1', [productId])
    || await db.one('SELECT ph.url FROM photos ph JOIN products pr ON pr.parent_id = ph.product_id WHERE pr.id = $1 AND ph.piece_id IS NULL ORDER BY ph.sort LIMIT 1', [productId]);
  return p ? p.url : null;
}

function dims(p) {
  const d = [p.length_cm, p.width_cm, p.height_cm].filter((x) => x != null);
  return d.length ? `${d.map((x) => +x).join(' × ')} cm` : null;
}

const STATUS_RANK = ['available_now', 'made_to_order', 'reserved', 'display_only', 'damaged', 'out_of_stock'];

async function card(db, p) {
  const a = await inv.productAvailability(db, p.id);
  // A design with variants and no stock of its own shows the best status of its variants.
  const kids = await db.query('SELECT id FROM products WHERE parent_id = $1 AND active = 1', [p.id]);
  let variants = 0;
  if (kids.length && a.totals.physical === 0) {
    const ka = await Promise.all(kids.map((k) => inv.productAvailability(db, k.id)));
    a.totals.available = ka.reduce((s, x) => s + x.totals.available, 0);
    a.status = ka.map((x) => x.status).sort((x, y) => STATUS_RANK.indexOf(x) - STATUS_RANK.indexOf(y))[0];
    variants = kids.length;
  }
  return {
    variants,
    id: p.id, sku: p.sku, name: p.name, variant_label: p.variant_label, category: p.category, material: p.material, finish: p.finish,
    dimensions: dims(p), selling_price: p.selling_price, tracking: p.tracking, photo: await primaryPhoto(db, p.id),
    status: a.status, status_label: STATUS_LABEL[a.status], available: a.totals.available, expected: a.expected,
  };
}

/**
 * Search by name, SKU, barcode, category, material, finish and dimensions.
 * Dimension tokens like "120", "120x60" or "120x60x75" match within ±3 cm.
 */
async function search(db, { q = '', category, material, finish, availability, limit = 60 } = {}) {
  const where = ['pr.active = 1'];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const tokens = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const t of tokens) {
    const like = p(`%${t}%`);
    const pieceMatch = `EXISTS (SELECT 1 FROM pieces pc WHERE pc.product_id = pr.id AND (pc.piece_code ILIKE ${like} OR COALESCE(pc.mfr_barcode,'') ILIKE ${like} OR COALESCE(pc.finish_note,'') ILIKE ${like}))`;
    const dim = t.replace(/cm$/, '').match(/^(\d+(?:\.\d+)?)(?:[x×*](\d+(?:\.\d+)?))?(?:[x×*](\d+(?:\.\d+)?))?$/);
    if (dim) {
      const conds = dim.slice(1).filter(Boolean).map(Number).map((n) => {
        const v = p(n);
        return `(ABS(COALESCE(pr.length_cm,-99)-${v})<=3 OR ABS(COALESCE(pr.width_cm,-99)-${v})<=3 OR ABS(COALESCE(pr.height_cm,-99)-${v})<=3)`;
      });
      where.push(`((${conds.join(' AND ')}) OR pr.sku ILIKE ${like} OR pr.internal_code ILIKE ${like} OR COALESCE(pr.mfr_barcode,'') ILIKE ${like} OR ${pieceMatch})`);
      continue;
    }
    where.push(`(pr.name ILIKE ${like} OR pr.sku ILIKE ${like} OR pr.internal_code ILIKE ${like} OR COALESCE(pr.mfr_barcode,'') ILIKE ${like}
      OR COALESCE(pr.category,'') ILIKE ${like} OR COALESCE(pr.material,'') ILIKE ${like} OR COALESCE(pr.finish,'') ILIKE ${like}
      OR COALESCE(pr.variant_label,'') ILIKE ${like} OR ${pieceMatch})`);
  }
  for (const [k, v] of Object.entries({ category, material, finish })) if (v) where.push(`pr.${k} = ${p(v)}`);
  const rows = await db.query(`SELECT pr.* FROM products pr WHERE ${where.join(' AND ')} ORDER BY pr.name LIMIT 500`, params);
  let cards = await Promise.all(rows.map((r) => card(db, r)));
  if (availability) cards = cards.filter((c) => c.status === availability);
  return cards.slice(0, Number(limit) || 60);
}

async function facets(db) {
  const col = async (c) => (await db.query(`SELECT DISTINCT ${c} v FROM products WHERE active = 1 AND ${c} IS NOT NULL ORDER BY ${c}`)).map((r) => r.v);
  return { categories: await col('category'), materials: await col('material'), finishes: await col('finish') };
}

/**
 * Resolve a scanned/typed code to a product or the exact piece.
 * Accepts internal codes, SKUs, manufacturer barcodes and customer QR URLs (…/p/<token>).
 * Read-only: never changes stock.
 */
async function resolveCode(db, raw) {
  const code = String(raw || '').trim().slice(0, 300);
  if (!code) return null;
  const m = code.match(/\/p\/([A-Za-z0-9_-]{8,})\/?(?:[?#].*)?$/);
  if (m) {
    const piece = await db.one('SELECT id, product_id FROM pieces WHERE public_token = $1', [m[1]]);
    if (piece) return { type: 'piece', piece_id: piece.id, product_id: piece.product_id, matched: 'qr' };
    const product = await db.one('SELECT id FROM products WHERE public_token = $1', [m[1]]);
    if (product) return { type: 'product', product_id: product.id, matched: 'qr' };
    return null;
  }
  const up = code.toUpperCase();
  const piece = await db.one('SELECT id, product_id, piece_code FROM pieces WHERE upper(piece_code) = $1 OR mfr_barcode = $2', [up, code]);
  if (piece) return { type: 'piece', piece_id: piece.id, product_id: piece.product_id, matched: piece.piece_code.toUpperCase() === up ? 'piece_code' : 'mfr_barcode' };
  const product = await db.one('SELECT id, internal_code, sku FROM products WHERE upper(internal_code) = $1 OR mfr_barcode = $2 OR upper(sku) = $1', [up, code]);
  if (product) {
    const matched = product.internal_code.toUpperCase() === up ? 'internal_code' : product.sku.toUpperCase() === up ? 'sku' : 'mfr_barcode';
    return { type: 'product', product_id: product.id, matched };
  }
  return null;
}

/**
 * Videos for a product (and optionally one exact piece), with inheritance:
 * piece → product/variant → parent design. A more specific video flagged
 * overrides_parent hides inherited videos of the same type.
 */
async function videosFor(db, { productId, pieceId }, { includeInternal = true } = {}) {
  const product = await db.one('SELECT id, parent_id FROM products WHERE id = $1', [productId]);
  if (!product) return [];
  const levels = [];
  if (pieceId) levels.push({ rows: await db.query('SELECT * FROM videos WHERE piece_id = $1 ORDER BY id', [pieceId]), scope: 'exact_piece' });
  levels.push({ rows: await db.query('SELECT * FROM videos WHERE product_id = $1 AND piece_id IS NULL ORDER BY id', [product.id]), scope: pieceId ? 'same_design' : 'this_product' });
  if (product.parent_id) levels.push({ rows: await db.query('SELECT * FROM videos WHERE product_id = $1 AND piece_id IS NULL ORDER BY id', [product.parent_id]), scope: 'same_design' });

  const out = [];
  const overridden = new Set();
  for (const level of levels) {
    const newlyOverridden = [];
    for (const v of level.rows) {
      if (!includeInternal && v.visibility !== 'customer') continue;
      if (overridden.has(v.video_type)) continue;
      if (v.overrides_parent) newlyOverridden.push(v.video_type);
      out.push({
        id: v.id, title: v.title, youtube_id: v.youtube_id, url: ytWatch(v.youtube_id), thumbnail: ytThumb(v.youtube_id),
        video_type: v.video_type, visibility: v.visibility, embed_status: v.embed_status, inherited: level.scope !== levels[0].scope,
        scope: level.scope, is_primary: !!v.is_primary, source_product_id: v.product_id, source_piece_id: v.piece_id,
        scope_label: level.scope === 'exact_piece' ? 'Shows this exact piece' : level.scope === 'this_product' ? 'This product' : 'Same design — not this exact piece',
      });
    }
    newlyOverridden.forEach((t) => overridden.add(t));
  }
  // exactly one primary: the most specific one flagged primary
  let primarySeen = false;
  for (const v of out) { if (v.is_primary && !primarySeen) primarySeen = true; else v.is_primary = false; }
  if (!primarySeen && out.length) out[0].is_primary = true;
  return out.sort((a, b) => b.is_primary - a.is_primary);
}

async function photosFor(db, productId, pieceId, publicOnly = false) {
  const pub = publicOnly ? 'AND is_public = 1' : '';
  const piecePhotos = pieceId ? await db.query(`SELECT id, url, caption, is_public, 1 AS exact_piece FROM photos WHERE piece_id = $1 ${pub} ORDER BY sort, id`, [pieceId]) : [];
  let design = await db.query(`SELECT id, url, caption, is_public, 0 AS exact_piece FROM photos WHERE product_id = $1 AND piece_id IS NULL ${pub} ORDER BY sort, id`, [productId]);
  if (!design.length) {
    const parent = await db.one('SELECT parent_id FROM products WHERE id = $1', [productId]);
    if (parent && parent.parent_id) design = await db.query(`SELECT id, url, caption, is_public, 0 AS exact_piece FROM photos WHERE product_id = $1 AND piece_id IS NULL ${pub} ORDER BY sort, id`, [parent.parent_id]);
  }
  return [...piecePhotos, ...design];
}

/** Similar products that are available now: same category, closest price/size/material. */
async function alternatives(db, productId, limit = 6) {
  const p = await db.one('SELECT * FROM products WHERE id = $1', [productId]);
  if (!p) return [];
  const cands = await db.query('SELECT * FROM products WHERE active = 1 AND id != $1 AND (category = $2 OR parent_id = $1 OR id = $3 OR parent_id = $3)',
    [p.id, p.category, p.parent_id || -1]);
  const scored = [];
  for (const c of cands) {
    const cc = await card(db, c);
    if (cc.status !== 'available_now') continue;
    let score = 0;
    if (p.parent_id && (c.parent_id === p.parent_id || c.id === p.parent_id)) score += 5;
    if (c.material && c.material === p.material) score += 2;
    if (c.finish && c.finish === p.finish) score += 1;
    if (p.selling_price && c.selling_price) score += Math.max(0, 2 - Math.abs(c.selling_price - p.selling_price) / p.selling_price * 4);
    for (const k of ['length_cm', 'width_cm', 'height_cm']) if (p[k] && c[k]) score += Math.max(0, 1 - Math.abs(c[k] - p[k]) / p[k] * 3);
    scored.push({ ...cc, score: +score.toFixed(2) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function pieceView(db, piece, { includeCost }) {
  const loc = piece.location_id ? await db.one('SELECT name, type, code FROM locations WHERE id = $1', [piece.location_id]) : null;
  const res = await db.one("SELECT r.id, r.customer_name, r.created_at, u.name AS by_name FROM reservations r LEFT JOIN users u ON u.id = r.created_by WHERE r.piece_id = $1 AND r.status = 'active'", [piece.id]);
  const status = inv.pieceStatus(piece);
  return {
    id: piece.id, piece_code: piece.piece_code, mfr_barcode: piece.mfr_barcode, condition: piece.condition, finish_note: piece.finish_note,
    location_id: piece.location_id, location: loc && loc.name, location_type: loc && loc.type, rack: piece.rack,
    status, status_label: STATUS_LABEL[status], raw_status: piece.status,
    display_piece: piece.status === 'display', display_for_sale: !!piece.display_for_sale,
    selling_price: piece.selling_price, cost_price: includeCost ? piece.cost_price : undefined,
    public_enabled: !!piece.public_enabled, public_token: piece.public_token, notes: includeCost ? piece.notes : undefined,
    reservation: res || null, photo: await primaryPhoto(db, piece.product_id, piece.id),
  };
}

/** Full staff product detail. Cost/vendor/internal fields only when allowed. */
async function productDetail(db, productId, { includeCost = false } = {}) {
  const p = await db.one('SELECT * FROM products WHERE id = $1', [productId]);
  if (!p) return null;
  const availability = await inv.productAvailability(db, p.id);
  const pieces = p.tracking === 'piece'
    ? await Promise.all((await db.query("SELECT * FROM pieces WHERE product_id = $1 ORDER BY CASE status WHEN 'available' THEN 0 WHEN 'display' THEN 1 WHEN 'reserved' THEN 2 WHEN 'damaged' THEN 3 ELSE 4 END, piece_code", [p.id])).map((x) => pieceView(db, x, { includeCost })))
    : [];
  const variantRows = await db.query('SELECT * FROM products WHERE active = 1 AND id != $1 AND ((parent_id IS NOT NULL AND parent_id = $2) OR parent_id = $1 OR id = $2)', [p.id, p.parent_id || -1]);
  const variants = await Promise.all(variantRows.map((v) => card(db, v)));
  const reservations = await db.query(`SELECT r.*, l.name AS location, u.name AS by_name, pc.piece_code FROM reservations r
    LEFT JOIN locations l ON l.id = r.location_id LEFT JOIN users u ON u.id = r.created_by LEFT JOIN pieces pc ON pc.id = r.piece_id
    WHERE r.product_id = $1 AND r.status = 'active' ORDER BY r.created_at DESC`, [p.id]);
  const incoming = await db.query("SELECT * FROM incoming WHERE product_id = $1 AND status IN ('requested','ordered') ORDER BY expected_date", [p.id]);
  const out = {
    id: p.id, sku: p.sku, internal_code: p.internal_code, mfr_barcode: p.mfr_barcode, name: p.name, variant_label: p.variant_label, parent_id: p.parent_id,
    category: p.category, material: p.material, finish: p.finish, length_cm: p.length_cm, width_cm: p.width_cm, height_cm: p.height_cm,
    dimensions: dims(p), description: p.description, care: p.care, short_specs: p.short_specs, selling_price: p.selling_price,
    tracking: p.tracking, made_to_order: !!p.made_to_order, lead_time_days: p.lead_time_days,
    public_enabled: !!p.public_enabled, public_show_price: !!p.public_show_price, public_token: p.public_token,
    status_label: STATUS_LABEL[availability.status], availability, pieces, variants, reservations, incoming,
    photos: await photosFor(db, p.id), videos: await videosFor(db, { productId: p.id }),
    alternatives: availability.status === 'available_now' ? [] : await alternatives(db, p.id),
  };
  if (includeCost) Object.assign(out, { cost_price: p.cost_price, vendor: p.vendor, internal_notes: p.internal_notes });
  return out;
}

async function pieceDetail(db, pieceId, opts = {}) {
  const piece = await db.one('SELECT * FROM pieces WHERE id = $1', [pieceId]);
  if (!piece) return null;
  const product = await productDetail(db, piece.product_id, opts);
  const history = await db.query(`SELECT sl.ts, sl.movement, sl.qty, sl.condition, sl.reference, sl.note, fl.name AS from_loc, tl.name AS to_loc, u.name AS by_name
    FROM stock_ledger sl LEFT JOIN locations fl ON fl.id = sl.from_location_id LEFT JOIN locations tl ON tl.id = sl.to_location_id
    LEFT JOIN users u ON u.id = sl.user_id WHERE sl.piece_id = $1 ORDER BY sl.id DESC`, [pieceId]);
  const view = await pieceView(db, piece, opts);
  const alts = view.status === 'available_now' ? [] : [
    ...product.pieces.filter((x) => x.id !== piece.id && x.status === 'available_now').slice(0, 4).map((x) => ({ ...x, kind: 'piece', name: product.name })),
    ...(await alternatives(db, piece.product_id, 4)).map((x) => ({ ...x, kind: 'product' })),
  ];
  return {
    piece: view, product, history, alternatives: alts,
    photos: await photosFor(db, piece.product_id, piece.id), videos: await videosFor(db, { productId: piece.product_id, pieceId }),
  };
}

module.exports = { search, facets, resolveCode, videosFor, photosFor, alternatives, productDetail, pieceDetail, card, dims, STATUS_LABEL, primaryPhoto };
