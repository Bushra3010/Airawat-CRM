'use strict';
const inv = require('./inventory');
const { ytThumb, ytWatch } = require('./codes');

const STATUS_LABEL = {
  available_now: 'Available Now', reserved: 'Reserved', out_of_stock: 'Out of Stock',
  made_to_order: 'Made to Order', display_only: 'Display Only', damaged: 'Damaged', sold: 'Sold', in_transit: 'In Transit',
};

function primaryPhoto(db, productId, pieceId) {
  if (pieceId) {
    const p = db.prepare('SELECT url FROM photos WHERE piece_id = ? ORDER BY sort, id LIMIT 1').get(pieceId);
    if (p) return p.url;
  }
  const p = db.prepare('SELECT url FROM photos WHERE product_id = ? AND piece_id IS NULL ORDER BY sort, id LIMIT 1').get(productId)
    || db.prepare('SELECT ph.url FROM photos ph JOIN products pr ON pr.parent_id = ph.product_id WHERE pr.id = ? AND ph.piece_id IS NULL ORDER BY ph.sort LIMIT 1').get(productId);
  return p ? p.url : null;
}

function dims(p) {
  const d = [p.length_cm, p.width_cm, p.height_cm].filter((x) => x != null);
  return d.length ? `${d.map((x) => +x).join(' × ')} cm` : null;
}

const STATUS_RANK = ['available_now', 'made_to_order', 'reserved', 'display_only', 'damaged', 'out_of_stock'];

function card(db, p) {
  const a = inv.productAvailability(db, p.id);
  // A design with variants and no stock of its own shows the best status of its variants.
  const kids = db.prepare('SELECT id FROM products WHERE parent_id = ? AND active = 1').all(p.id);
  let variants = 0;
  if (kids.length && a.totals.physical === 0) {
    const ka = kids.map((k) => inv.productAvailability(db, k.id));
    a.totals.available = ka.reduce((s, x) => s + x.totals.available, 0);
    a.status = ka.map((x) => x.status).sort((x, y) => STATUS_RANK.indexOf(x) - STATUS_RANK.indexOf(y))[0];
    variants = kids.length;
  }
  return {
    variants,
    id: p.id, sku: p.sku, name: p.name, variant_label: p.variant_label, category: p.category, material: p.material, finish: p.finish,
    dimensions: dims(p), selling_price: p.selling_price, tracking: p.tracking, photo: primaryPhoto(db, p.id),
    status: a.status, status_label: STATUS_LABEL[a.status], available: a.totals.available, expected: a.expected,
  };
}

/**
 * Search by name, SKU, barcode, category, material, finish and dimensions.
 * Dimension tokens like "120", "120x60" or "120x60x75" match within ±tolerance cm.
 */
function search(db, { q = '', category, material, finish, availability, limit = 60 } = {}) {
  const where = ['pr.active = 1'];
  const params = {};
  const tokens = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  tokens.forEach((t, i) => {
    const dim = t.replace(/cm$/, '').match(/^(\d+(?:\.\d+)?)(?:[x×*](\d+(?:\.\d+)?))?(?:[x×*](\d+(?:\.\d+)?))?$/);
    if (dim) {
      const nums = dim.slice(1).filter(Boolean).map(Number);
      const conds = nums.map((n, k) => {
        params[`d${i}_${k}`] = n;
        return `(ABS(COALESCE(pr.length_cm,-99)-@d${i}_${k})<=3 OR ABS(COALESCE(pr.width_cm,-99)-@d${i}_${k})<=3 OR ABS(COALESCE(pr.height_cm,-99)-@d${i}_${k})<=3)`;
      });
      params[`t${i}`] = `%${t}%`;
      where.push(`((${conds.join(' AND ')}) OR LOWER(pr.sku) LIKE @t${i} OR pr.internal_code LIKE @t${i} OR pr.mfr_barcode LIKE @t${i}
        OR EXISTS (SELECT 1 FROM pieces pc WHERE pc.product_id = pr.id AND (pc.piece_code LIKE @t${i} OR pc.mfr_barcode LIKE @t${i})))`);
      return;
    }
    params[`t${i}`] = `%${t}%`;
    where.push(`(LOWER(pr.name) LIKE @t${i} OR LOWER(pr.sku) LIKE @t${i} OR LOWER(pr.internal_code) LIKE @t${i} OR LOWER(COALESCE(pr.mfr_barcode,'')) LIKE @t${i}
      OR LOWER(COALESCE(pr.category,'')) LIKE @t${i} OR LOWER(COALESCE(pr.material,'')) LIKE @t${i} OR LOWER(COALESCE(pr.finish,'')) LIKE @t${i}
      OR LOWER(COALESCE(pr.variant_label,'')) LIKE @t${i}
      OR EXISTS (SELECT 1 FROM pieces pc WHERE pc.product_id = pr.id AND (LOWER(pc.piece_code) LIKE @t${i} OR LOWER(COALESCE(pc.mfr_barcode,'')) LIKE @t${i} OR LOWER(COALESCE(pc.finish_note,'')) LIKE @t${i})))`);
  });
  for (const [k, v] of Object.entries({ category, material, finish })) {
    if (v) { params[k] = v; where.push(`pr.${k} = @${k}`); }
  }
  const rows = db.prepare(`SELECT pr.* FROM products pr WHERE ${where.join(' AND ')} ORDER BY pr.name LIMIT 500`).all(params);
  let cards = rows.map((p) => card(db, p));
  if (availability) cards = cards.filter((c) => c.status === availability);
  return cards.slice(0, limit);
}

function facets(db) {
  const col = (c) => db.prepare(`SELECT DISTINCT ${c} v FROM products WHERE active = 1 AND ${c} IS NOT NULL ORDER BY ${c}`).all().map((r) => r.v);
  return { categories: col('category'), materials: col('material'), finishes: col('finish') };
}

/**
 * Resolve a scanned/typed code to a product or the exact piece.
 * Accepts internal codes, SKUs, manufacturer barcodes and customer QR URLs (…/p/<token>).
 * Read-only: never changes stock.
 */
function resolveCode(db, raw) {
  let code = String(raw || '').trim();
  if (!code) return null;
  const m = code.match(/\/p\/([A-Za-z0-9_-]{8,})\/?(?:[?#].*)?$/);
  if (m) {
    const piece = db.prepare('SELECT id, product_id FROM pieces WHERE public_token = ?').get(m[1]);
    if (piece) return { type: 'piece', piece_id: piece.id, product_id: piece.product_id, matched: 'qr' };
    const product = db.prepare('SELECT id FROM products WHERE public_token = ?').get(m[1]);
    if (product) return { type: 'product', product_id: product.id, matched: 'qr' };
    return null;
  }
  const piece = db.prepare('SELECT id, product_id, piece_code FROM pieces WHERE piece_code = ? COLLATE NOCASE OR mfr_barcode = ?').get(code, code);
  if (piece) return { type: 'piece', piece_id: piece.id, product_id: piece.product_id, matched: piece.piece_code.toUpperCase() === code.toUpperCase() ? 'piece_code' : 'mfr_barcode' };
  const product = db.prepare('SELECT id, internal_code, sku FROM products WHERE internal_code = ? COLLATE NOCASE OR mfr_barcode = ? OR sku = ? COLLATE NOCASE').get(code, code, code);
  if (product) {
    const matched = product.internal_code.toUpperCase() === code.toUpperCase() ? 'internal_code' : product.sku.toUpperCase() === code.toUpperCase() ? 'sku' : 'mfr_barcode';
    return { type: 'product', product_id: product.id, matched };
  }
  return null;
}

/**
 * Videos for a product (and optionally one exact piece), with inheritance:
 * piece → product/variant → parent design. A more specific video flagged
 * overrides_parent hides inherited videos of the same type.
 */
function videosFor(db, { productId, pieceId }, { includeInternal = true } = {}) {
  const product = db.prepare('SELECT id, parent_id FROM products WHERE id = ?').get(productId);
  if (!product) return [];
  const levels = [];
  if (pieceId) levels.push({ rows: db.prepare('SELECT * FROM videos WHERE piece_id = ?').all(pieceId), scope: 'exact_piece' });
  levels.push({ rows: db.prepare('SELECT * FROM videos WHERE product_id = ? AND piece_id IS NULL').all(product.id), scope: pieceId ? 'same_design' : 'this_product' });
  if (product.parent_id) levels.push({ rows: db.prepare('SELECT * FROM videos WHERE product_id = ? AND piece_id IS NULL').all(product.parent_id), scope: 'same_design' });

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

function photosFor(db, productId, pieceId, publicOnly = false) {
  const pub = publicOnly ? 'AND is_public = 1' : '';
  const piecePhotos = pieceId ? db.prepare(`SELECT id, url, caption, is_public, 1 AS exact_piece FROM photos WHERE piece_id = ? ${pub} ORDER BY sort, id`).all(pieceId) : [];
  let design = db.prepare(`SELECT id, url, caption, is_public, 0 AS exact_piece FROM photos WHERE product_id = ? AND piece_id IS NULL ${pub} ORDER BY sort, id`).all(productId);
  if (!design.length) {
    const parent = db.prepare('SELECT parent_id FROM products WHERE id = ?').get(productId);
    if (parent && parent.parent_id) design = db.prepare(`SELECT id, url, caption, is_public, 0 AS exact_piece FROM photos WHERE product_id = ? AND piece_id IS NULL ${pub} ORDER BY sort, id`).all(parent.parent_id);
  }
  return [...piecePhotos, ...design];
}

/** Similar products that are available now: same category, closest price/size/material. */
function alternatives(db, productId, limit = 6) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) return [];
  const cands = db.prepare('SELECT * FROM products WHERE active = 1 AND id != ? AND (category = ? OR parent_id = ? OR id = ? OR parent_id = ?)')
    .all(p.id, p.category, p.id, p.parent_id || -1, p.parent_id || -1);
  const scored = [];
  for (const c of cands) {
    const cc = card(db, c);
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

function locName(db, id) {
  const l = id && db.prepare('SELECT name, type, code FROM locations WHERE id = ?').get(id);
  return l || null;
}

function pieceView(db, piece, { includeCost }) {
  const loc = locName(db, piece.location_id);
  const res = db.prepare("SELECT r.id, r.customer_name, r.created_at, u.name AS by_name FROM reservations r LEFT JOIN users u ON u.id = r.created_by WHERE r.piece_id = ? AND r.status = 'active'").get(piece.id);
  return {
    id: piece.id, piece_code: piece.piece_code, mfr_barcode: piece.mfr_barcode, condition: piece.condition, finish_note: piece.finish_note,
    location_id: piece.location_id, location: loc && loc.name, location_type: loc && loc.type, rack: piece.rack,
    status: inv.pieceStatus(piece), status_label: STATUS_LABEL[inv.pieceStatus(piece)], raw_status: piece.status,
    display_piece: piece.status === 'display', display_for_sale: !!piece.display_for_sale,
    selling_price: piece.selling_price, cost_price: includeCost ? piece.cost_price : undefined,
    public_enabled: !!piece.public_enabled, public_token: piece.public_token, notes: includeCost ? piece.notes : undefined,
    reservation: res || null, photo: primaryPhoto(db, piece.product_id, piece.id),
  };
}

/** Full staff product detail. Cost/vendor/internal fields only when allowed. */
function productDetail(db, productId, { includeCost = false } = {}) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) return null;
  const availability = inv.productAvailability(db, p.id);
  const pieces = p.tracking === 'piece'
    ? db.prepare("SELECT * FROM pieces WHERE product_id = ? ORDER BY CASE status WHEN 'available' THEN 0 WHEN 'display' THEN 1 WHEN 'reserved' THEN 2 WHEN 'damaged' THEN 3 ELSE 4 END, piece_code").all(p.id).map((x) => pieceView(db, x, { includeCost }))
    : [];
  const variants = db.prepare('SELECT * FROM products WHERE active = 1 AND id != ? AND ((parent_id IS NOT NULL AND parent_id = ?) OR parent_id = ? OR id = ?)')
    .all(p.id, p.parent_id || -1, p.id, p.parent_id || -1).map((v) => card(db, v));
  const reservations = db.prepare(`SELECT r.*, l.name AS location, u.name AS by_name, pc.piece_code FROM reservations r
    LEFT JOIN locations l ON l.id = r.location_id LEFT JOIN users u ON u.id = r.created_by LEFT JOIN pieces pc ON pc.id = r.piece_id
    WHERE r.product_id = ? AND r.status = 'active' ORDER BY r.created_at DESC`).all(p.id);
  const incoming = db.prepare("SELECT * FROM incoming WHERE product_id = ? AND status IN ('requested','ordered') ORDER BY expected_date").all(p.id);
  const out = {
    id: p.id, sku: p.sku, internal_code: p.internal_code, mfr_barcode: p.mfr_barcode, name: p.name, variant_label: p.variant_label, parent_id: p.parent_id,
    category: p.category, material: p.material, finish: p.finish, length_cm: p.length_cm, width_cm: p.width_cm, height_cm: p.height_cm,
    dimensions: dims(p), description: p.description, care: p.care, short_specs: p.short_specs, selling_price: p.selling_price,
    tracking: p.tracking, made_to_order: !!p.made_to_order, lead_time_days: p.lead_time_days,
    public_enabled: !!p.public_enabled, public_show_price: !!p.public_show_price, public_token: p.public_token,
    status_label: STATUS_LABEL[availability.status], availability, pieces, variants, reservations, incoming,
    photos: photosFor(db, p.id), videos: videosFor(db, { productId: p.id }),
    alternatives: availability.status === 'available_now' ? [] : alternatives(db, p.id),
  };
  if (includeCost) Object.assign(out, { cost_price: p.cost_price, vendor: p.vendor, internal_notes: p.internal_notes });
  return out;
}

function pieceDetail(db, pieceId, opts = {}) {
  const piece = db.prepare('SELECT * FROM pieces WHERE id = ?').get(pieceId);
  if (!piece) return null;
  const product = productDetail(db, piece.product_id, opts);
  const history = db.prepare(`SELECT sl.ts, sl.movement, sl.qty, sl.condition, sl.reference, sl.note, fl.name AS from_loc, tl.name AS to_loc, u.name AS by_name
    FROM stock_ledger sl LEFT JOIN locations fl ON fl.id = sl.from_location_id LEFT JOIN locations tl ON tl.id = sl.to_location_id
    LEFT JOIN users u ON u.id = sl.user_id WHERE sl.piece_id = ? ORDER BY sl.id DESC`).all(pieceId);
  const view = pieceView(db, piece, opts);
  const alts = view.status === 'available_now' ? [] : [
    ...product.pieces.filter((x) => x.id !== piece.id && x.status === 'available_now').slice(0, 4).map((x) => ({ ...x, kind: 'piece', name: product.name })),
    ...alternatives(db, piece.product_id, 4).map((x) => ({ ...x, kind: 'product' })),
  ];
  return {
    piece: view, product, history, alternatives: alts,
    photos: photosFor(db, piece.product_id, piece.id), videos: videosFor(db, { productId: piece.product_id, pieceId }),
  };
}

module.exports = { search, facets, resolveCode, videosFor, photosFor, alternatives, productDetail, pieceDetail, card, dims, STATUS_LABEL, primaryPhoto };
