'use strict';
const inv = require('./inventory');
const { ytThumb, ytWatch } = require('./codes');

const STATUS_LABEL = {
  available_now: 'Available Now', reserved: 'Reserved', out_of_stock: 'Out of Stock',
  made_to_order: 'Made to Order', display_only: 'Display Only', damaged: 'Damaged', sold: 'Sold', in_transit: 'In Transit',
};

/**
 * First photo for many products / pieces in one or two queries.
 * Products fall back to their parent design's photo; pieces fall back to the product's.
 * Returns { product: Map(productId → url), piece: Map(pieceId → url) }.
 */
async function photoMaps(db, productIds, pieceIds = []) {
  const pids = [...new Set(productIds.map(Number))], cids = [...new Set(pieceIds.filter(Boolean).map(Number))];
  const [prod, piece] = await Promise.all([
    pids.length ? db.query(`SELECT DISTINCT ON (pr.id) pr.id AS product_id, ph.url FROM products pr
      JOIN photos ph ON ph.piece_id IS NULL AND (ph.product_id = pr.id OR ph.product_id = pr.parent_id)
      WHERE pr.id = ANY($1) ORDER BY pr.id, (ph.product_id = pr.id) DESC, ph.sort, ph.id`, [pids]) : [],
    cids.length ? db.query('SELECT DISTINCT ON (piece_id) piece_id, url FROM photos WHERE piece_id = ANY($1) ORDER BY piece_id, sort, id', [cids]) : [],
  ]);
  return { product: new Map(prod.map((r) => [r.product_id, r.url])), piece: new Map(piece.map((r) => [r.piece_id, r.url])) };
}

async function primaryPhoto(db, productId, pieceId) {
  const m = await photoMaps(db, [productId], [pieceId]);
  return m.piece.get(Number(pieceId)) || m.product.get(Number(productId)) || null;
}

function dims(p) {
  const d = [p.length_cm, p.width_cm, p.height_cm].filter((x) => x != null);
  return d.length ? `${d.map((x) => +x).join(' × ')} cm` : null;
}

const STATUS_RANK = ['available_now', 'made_to_order', 'reserved', 'display_only', 'damaged', 'out_of_stock'];

/** Photo cards for many product rows with a fixed number of queries. */
async function cardsFor(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((p) => p.id);
  const kids = await db.query('SELECT id, parent_id FROM products WHERE parent_id = ANY($1) AND active = 1', [ids]);
  const [avail, photos] = await Promise.all([availabilityMany(db, [...ids, ...kids.map((k) => k.id)]), photoMaps(db, ids)]);
  return rows.map((p) => {
    const a = avail.get(p.id);
    let { status } = a, available = a.totals.available, variants = 0;
    // A design with variants and no stock of its own shows the best status of its variants.
    const mine = kids.filter((k) => k.parent_id === p.id);
    if (mine.length && a.totals.physical === 0) {
      const ka = mine.map((k) => avail.get(k.id));
      available = ka.reduce((s, x) => s + x.totals.available, 0);
      status = ka.map((x) => x.status).sort((x, y) => STATUS_RANK.indexOf(x) - STATUS_RANK.indexOf(y))[0];
      variants = mine.length;
    }
    return {
      variants,
      id: p.id, sku: p.sku, name: p.name, variant_label: p.variant_label, category: p.category, material: p.material, finish: p.finish,
      dimensions: dims(p), selling_price: p.selling_price, tracking: p.tracking, photo: photos.product.get(p.id) || null,
      status, status_label: STATUS_LABEL[status], available, expected: a.expected,
    };
  });
}
const availabilityMany = (db, ids) => inv.availabilityMany(db, ids);

async function card(db, p) {
  return (await cardsFor(db, [p]))[0];
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
  let cards = await cardsFor(db, rows);
  if (availability) cards = cards.filter((c) => c.status === availability);
  return cards.slice(0, Number(limit) || 60);
}

async function facets(db) {
  const rows = await db.query(`SELECT array_agg(DISTINCT category) FILTER (WHERE category IS NOT NULL) AS categories,
    array_agg(DISTINCT material) FILTER (WHERE material IS NOT NULL) AS materials,
    array_agg(DISTINCT finish) FILTER (WHERE finish IS NOT NULL) AS finishes FROM products WHERE active = 1`);
  const sorted = (a) => (a || []).sort((x, y) => x.localeCompare(y));
  return { categories: sorted(rows[0].categories), materials: sorted(rows[0].materials), finishes: sorted(rows[0].finishes) };
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
  // one query: this piece's videos, this product's, and the parent design's
  const rows = await db.query(`SELECT v.* FROM videos v WHERE (v.piece_id IS NOT NULL AND v.piece_id = $2)
    OR (v.piece_id IS NULL AND (v.product_id = $1 OR v.product_id = (SELECT parent_id FROM products WHERE id = $1))) ORDER BY v.id`,
  [Number(productId), pieceId ? Number(pieceId) : null]);
  const levels = [];
  if (pieceId) levels.push({ rows: rows.filter((v) => v.piece_id), scope: 'exact_piece' });
  levels.push({ rows: rows.filter((v) => !v.piece_id && v.product_id === Number(productId)), scope: pieceId ? 'same_design' : 'this_product' });
  levels.push({ rows: rows.filter((v) => !v.piece_id && v.product_id !== Number(productId)), scope: 'same_design' });

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

/** Photos for a product (and one exact piece) in one query; a variant without its own photos uses its design's. */
async function photosFor(db, productId, pieceId, publicOnly = false) {
  const rows = await db.query(`SELECT id, url, caption, is_public, product_id, piece_id FROM photos
    WHERE ((piece_id IS NOT NULL AND piece_id = $2) OR (piece_id IS NULL AND (product_id = $1 OR product_id = (SELECT parent_id FROM products WHERE id = $1))))
    ${publicOnly ? 'AND is_public = 1' : ''} ORDER BY sort, id`, [Number(productId), pieceId ? Number(pieceId) : null]);
  const shape = (r, exact) => ({ id: r.id, url: r.url, caption: r.caption, is_public: r.is_public, exact_piece: exact });
  const own = rows.filter((r) => !r.piece_id && r.product_id === Number(productId));
  const design = own.length ? own : rows.filter((r) => !r.piece_id && r.product_id !== Number(productId));
  return [...rows.filter((r) => r.piece_id).map((r) => shape(r, 1)), ...design.map((r) => shape(r, 0))];
}

/** Similar products that are available now: same category, closest price/size/material. */
async function alternatives(db, productId, limit = 6, product) {
  const p = product || await db.one('SELECT * FROM products WHERE id = $1', [productId]);
  if (!p) return [];
  const cands = await db.query('SELECT * FROM products WHERE active = 1 AND id != $1 AND (category = $2 OR parent_id = $1 OR id = $3 OR parent_id = $3)',
    [p.id, p.category, p.parent_id || -1]);
  const cards = await cardsFor(db, cands);
  const scored = [];
  for (const [i, c] of cands.entries()) {
    const cc = cards[i];
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

// Pieces with their location, active reservation and first photo, in one query.
const PIECE_ROWS = `SELECT pc.*, l.name AS loc_name, l.type AS loc_type,
    r.id AS res_id, r.customer_name AS res_customer, r.created_at AS res_at, u.name AS res_by,
    (SELECT url FROM photos ph WHERE ph.piece_id = pc.id ORDER BY sort, id LIMIT 1) AS piece_photo
  FROM pieces pc LEFT JOIN locations l ON l.id = pc.location_id
  LEFT JOIN reservations r ON r.piece_id = pc.id AND r.status = 'active' LEFT JOIN users u ON u.id = r.created_by`;

function pieceView(piece, { includeCost }, designPhoto = null) {
  const status = inv.pieceStatus(piece);
  return {
    id: piece.id, piece_code: piece.piece_code, mfr_barcode: piece.mfr_barcode, condition: piece.condition, finish_note: piece.finish_note,
    location_id: piece.location_id, location: piece.loc_name || null, location_type: piece.loc_type || null, rack: piece.rack,
    status, status_label: STATUS_LABEL[status], raw_status: piece.status,
    display_piece: piece.status === 'display', display_for_sale: !!piece.display_for_sale,
    selling_price: piece.selling_price, cost_price: includeCost ? piece.cost_price : undefined,
    public_enabled: !!piece.public_enabled, public_token: piece.public_token, notes: includeCost ? piece.notes : undefined,
    reservation: piece.res_id ? { id: piece.res_id, customer_name: piece.res_customer, created_at: piece.res_at, by_name: piece.res_by } : null,
    photo: piece.piece_photo || designPhoto,
  };
}

/** Full staff product detail. Cost/vendor/internal fields only when allowed. */
async function productDetail(db, productId, { includeCost = false } = {}) {
  const p = await db.one('SELECT * FROM products WHERE id = $1', [productId]);
  if (!p) return null;
  // Everything else depends only on the product row: fetch it all in parallel.
  const [availability, pieceRows, variantRows, reservations, incoming, photos, videos, design] = await Promise.all([
    inv.productAvailability(db, p.id),
    p.tracking === 'piece' ? db.query(`${PIECE_ROWS} WHERE pc.product_id = $1
      ORDER BY CASE pc.status WHEN 'available' THEN 0 WHEN 'display' THEN 1 WHEN 'reserved' THEN 2 WHEN 'damaged' THEN 3 ELSE 4 END, pc.piece_code`, [p.id]) : [],
    db.query('SELECT * FROM products WHERE active = 1 AND id != $1 AND ((parent_id IS NOT NULL AND parent_id = $2) OR parent_id = $1 OR id = $2)', [p.id, p.parent_id || -1]),
    db.query(`SELECT r.*, l.name AS location, u.name AS by_name, pc.piece_code FROM reservations r
      LEFT JOIN locations l ON l.id = r.location_id LEFT JOIN users u ON u.id = r.created_by LEFT JOIN pieces pc ON pc.id = r.piece_id
      WHERE r.product_id = $1 AND r.status = 'active' ORDER BY r.created_at DESC`, [p.id]),
    db.query("SELECT * FROM incoming WHERE product_id = $1 AND status IN ('requested','ordered') ORDER BY expected_date", [p.id]),
    photosFor(db, p.id),
    videosFor(db, { productId: p.id }),
    photoMaps(db, [p.id]),
  ]);
  const designPhoto = design.product.get(p.id) || null;
  const pieces = pieceRows.map((x) => pieceView(x, { includeCost }, designPhoto));
  const [variants, alts] = await Promise.all([
    cardsFor(db, variantRows),
    availability.status === 'available_now' ? [] : alternatives(db, p.id, 6, p),
  ]);
  const out = {
    id: p.id, sku: p.sku, internal_code: p.internal_code, mfr_barcode: p.mfr_barcode, name: p.name, variant_label: p.variant_label, parent_id: p.parent_id,
    category: p.category, material: p.material, finish: p.finish, length_cm: p.length_cm, width_cm: p.width_cm, height_cm: p.height_cm,
    dimensions: dims(p), description: p.description, care: p.care, short_specs: p.short_specs, selling_price: p.selling_price,
    tracking: p.tracking, made_to_order: !!p.made_to_order, lead_time_days: p.lead_time_days,
    public_enabled: !!p.public_enabled, public_show_price: !!p.public_show_price, public_token: p.public_token,
    status_label: STATUS_LABEL[availability.status], availability, pieces, variants, reservations, incoming,
    photos, videos, alternatives: alts,
  };
  if (includeCost) Object.assign(out, { cost_price: p.cost_price, vendor: p.vendor, internal_notes: p.internal_notes });
  return out;
}

async function pieceDetail(db, pieceId, opts = {}) {
  const piece = await db.one('SELECT id, product_id FROM pieces WHERE id = $1', [pieceId]);
  if (!piece) return null;
  const [product, history, photos, videos] = await Promise.all([
    productDetail(db, piece.product_id, opts),
    db.query(`SELECT sl.ts, sl.movement, sl.qty, sl.condition, sl.reference, sl.note, fl.name AS from_loc, tl.name AS to_loc, u.name AS by_name
      FROM stock_ledger sl LEFT JOIN locations fl ON fl.id = sl.from_location_id LEFT JOIN locations tl ON tl.id = sl.to_location_id
      LEFT JOIN users u ON u.id = sl.user_id WHERE sl.piece_id = $1 ORDER BY sl.id DESC`, [pieceId]),
    photosFor(db, piece.product_id, piece.id),
    videosFor(db, { productId: piece.product_id, pieceId }),
  ]);
  const view = product.pieces.find((x) => x.id === piece.id);
  let alts = [];
  if (view.status !== 'available_now') {
    // the product page already worked out alternatives when the design has none free
    const otherProducts = product.alternatives.length ? product.alternatives : await alternatives(db, piece.product_id, 4);
    alts = [
      ...product.pieces.filter((x) => x.id !== piece.id && x.status === 'available_now').slice(0, 4).map((x) => ({ ...x, kind: 'piece', name: product.name })),
      ...otherProducts.slice(0, 4).map((x) => ({ ...x, kind: 'product' })),
    ];
  }
  return { piece: view, product, history, alternatives: alts, photos, videos };
}

module.exports = { search, facets, resolveCode, videosFor, photosFor, alternatives, productDetail, pieceDetail, card, cardsFor, photoMaps, dims, STATUS_LABEL, primaryPhoto };
