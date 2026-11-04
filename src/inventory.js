'use strict';
/**
 * Stock availability and movements. Every function that changes stock or
 * availability writes to stock_ledger inside the same transaction, after locking
 * the product (or piece) row so concurrent requests are serialised by Postgres.
 * Nothing here is called by the scan/lookup path — scanning is read-only.
 */
const { nextCode, newToken } = require('./codes');

class StockError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

const SALEABLE_PIECE = "(status = 'available' OR (status = 'display' AND display_for_sale = 1))";
let spSeq = 0;

/**
 * Run fn in a transaction. If db is already a transaction, use a savepoint so a
 * failure can be rolled back on its own (used when confirming multi-line orders).
 */
async function inTx(db, fn) {
  if (!db.inTx) return db.tx((t) => { t.inTx = true; return fn(t); });
  if (db.noSavepoints) return fn(db);
  const sp = `sp_${++spSeq}`;
  await db.query(`SAVEPOINT ${sp}`);
  try {
    const out = await fn(db);
    await db.query(`RELEASE SAVEPOINT ${sp}`);
    return out;
  } catch (e) {
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    throw e;
  }
}

async function ledger(db, e) {
  const r = { user_id: null, piece_id: null, from_location_id: null, to_location_id: null, condition: null, reference: null, note: null, ...e };
  await db.query(`INSERT INTO stock_ledger (user_id, movement, product_id, piece_id, from_location_id, to_location_id, condition, qty, reference, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [r.user_id, r.movement, r.product_id, r.piece_id, r.from_location_id, r.to_location_id, r.condition, r.qty, r.reference, r.note]);
}

async function getProduct(db, id, lock = false) {
  const p = await db.one(`SELECT * FROM products WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id)]);
  if (!p) throw new StockError('Product not found', 404);
  return p;
}
async function getPiece(db, id, lock = false) {
  const p = await db.one(`SELECT * FROM pieces WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id)]);
  if (!p) throw new StockError('Piece not found', 404);
  return p;
}
function posInt(n, what = 'Quantity') {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) throw new StockError(`${what} must be a whole number above zero`, 400);
  return v;
}

// ---------------- Availability ----------------

async function balance(db, productId, locationId, condition) {
  const r = await db.one('SELECT qty FROM stock_balances WHERE product_id = $1 AND location_id = $2 AND condition = $3', [productId, locationId, condition]);
  return r ? r.qty : 0;
}

async function adjustBalance(db, productId, locationId, condition, delta, rack) {
  // One round trip in the usual case: the update only applies if stock stays >= 0.
  // (an UPSERT would trip the qty >= 0 CHECK on the candidate row for negative deltas)
  const upd = await db.query('UPDATE stock_balances SET qty = qty + $1, rack = COALESCE($2, rack) WHERE product_id = $3 AND location_id = $4 AND condition = $5 AND qty + $1 >= 0 RETURNING qty',
    [delta, rack || null, productId, locationId, condition]);
  if (upd.length) return;
  const cur = await balance(db, productId, locationId, condition);
  if (cur + delta < 0) throw new StockError(`Not enough ${condition.replace('_', ' ')} stock at this location (have ${cur})`);
  await db.query('INSERT INTO stock_balances (product_id, location_id, condition, qty, rack) VALUES ($1, $2, $3, $4, $5)', [productId, locationId, condition, delta, rack || null]);
}

/** Saleable, unreserved quantity of a SKU-tracked product at a location. */
async function skuAvailableAt(db, productId, locationId) {
  return (await db.one(`SELECT GREATEST(0,
      COALESCE((SELECT SUM(qty) FROM stock_balances WHERE product_id = $1 AND location_id = $2 AND condition IN ('sellable','display_sale')), 0)
    - COALESCE((SELECT SUM(qty) FROM reservations WHERE product_id = $1 AND location_id = $2 AND piece_id IS NULL AND status = 'active'), 0))::int AS n`,
  [productId, locationId])).n;
}

/** The location with the most saleable, unreserved stock of a SKU product. */
async function bestSkuLocation(db, productId) {
  return db.one(`SELECT l.id, GREATEST(0, COALESCE(b.q, 0) - COALESCE(r.q, 0))::int AS available FROM locations l
    LEFT JOIN (SELECT location_id, SUM(qty) q FROM stock_balances WHERE product_id = $1 AND condition IN ('sellable','display_sale') GROUP BY 1) b ON b.location_id = l.id
    LEFT JOIN (SELECT location_id, SUM(qty) q FROM reservations WHERE product_id = $1 AND piece_id IS NULL AND status = 'active' GROUP BY 1) r ON r.location_id = l.id
    ORDER BY 2 DESC, l.id LIMIT 1`, [productId]);
}

function expectedFrom(product, inc) {
  if (inc) return { date: inc.expected_date, source: inc.kind, qty: inc.qty };
  if (product.made_to_order && product.lead_time_days) {
    const d = new Date(Date.now() + product.lead_time_days * 864e5);
    return { date: d.toISOString().slice(0, 10), source: 'made_to_order', lead_time_days: product.lead_time_days };
  }
  return null;
}

function classify({ available, reserved, display, damaged }, madeToOrder) {
  if (available > 0) return 'available_now';
  if (madeToOrder) return 'made_to_order';
  if (reserved > 0) return 'reserved';
  if (display > 0) return 'display_only';
  if (damaged > 0) return 'damaged';
  return 'out_of_stock';
}

/**
 * Full availability for a product.
 * physical = everything on hand; available = saleable and unreserved only
 * (display pieces count only when explicitly released for sale; damaged never).
 */
async function productAvailability(db, productId) {
  const a = (await availabilityMany(db, [productId])).get(Number(productId));
  if (!a) throw new StockError('Product not found', 404);
  return a;
}

/**
 * Availability for many products in six queries (run in parallel), whatever the
 * number of products — the network round trip to the database is the slow part.
 * Returns Map(productId → availability).
 */
async function availabilityMany(db, productIds) {
  const ids = [...new Set(productIds.map(Number).filter(Number.isFinite))];
  const out = new Map();
  if (!ids.length) return out;
  const [products, locs, bal, res, pcs, inc] = await Promise.all([
    db.query('SELECT id, tracking, made_to_order, lead_time_days FROM products WHERE id = ANY($1)', [ids]),
    db.query("SELECT * FROM locations ORDER BY CASE type WHEN 'showroom' THEN 0 WHEN 'warehouse' THEN 1 ELSE 2 END, name"),
    db.query('SELECT product_id, location_id, condition, qty, rack FROM stock_balances WHERE product_id = ANY($1)', [ids]),
    db.query(`SELECT product_id, location_id, SUM(qty)::int n FROM reservations WHERE product_id = ANY($1) AND piece_id IS NULL AND status = 'active' GROUP BY 1, 2`, [ids]),
    db.query("SELECT product_id, status, display_for_sale, location_id, rack FROM pieces WHERE product_id = ANY($1) AND status != 'sold'", [ids]),
    db.query(`SELECT DISTINCT ON (product_id) product_id, kind, qty, expected_date FROM incoming
      WHERE product_id = ANY($1) AND status IN ('requested','ordered') AND expected_date IS NOT NULL ORDER BY product_id, expected_date`, [ids]),
  ]);
  for (const product of products) {
    out.set(product.id, computeAvailability(product, locs,
      bal.filter((x) => x.product_id === product.id), res.filter((x) => x.product_id === product.id),
      pcs.filter((x) => x.product_id === product.id), inc.find((x) => x.product_id === product.id)));
  }
  return out;
}

function computeAvailability(product, locs, bal, res, pieces, inc) {
  const byLocation = [];
  let inTransit = 0;

  if (product.tracking === 'sku') {
    for (const loc of locs) {
      const b = (c) => (bal.find((x) => x.location_id === loc.id && x.condition === c) || { qty: 0 }).qty;
      const sellable = b('sellable'), displaySale = b('display_sale'), display = b('display'), damaged = b('damaged');
      const reserved = (res.find((r) => r.location_id === loc.id) || { n: 0 }).n;
      const racks = [...new Set(bal.filter((x) => x.location_id === loc.id && x.qty > 0 && x.rack).map((x) => x.rack))];
      const row = { physical: sellable + displaySale + display + damaged, reserved, available: Math.max(0, sellable + displaySale - reserved), display, display_for_sale: displaySale, damaged, racks };
      if (row.physical > 0 || row.reserved > 0) byLocation.push({ location_id: loc.id, location: loc.name, location_code: loc.code, type: loc.type, ...row });
    }
  } else {
    const all = pieces;
    inTransit = all.filter((p) => p.status === 'in_transit').length;
    for (const loc of locs) {
      const ps = all.filter((p) => p.location_id === loc.id && p.status !== 'in_transit');
      const row = {
        physical: ps.length,
        reserved: ps.filter((p) => p.status === 'reserved').length,
        available: ps.filter((p) => p.status === 'available' || (p.status === 'display' && p.display_for_sale)).length,
        display: ps.filter((p) => p.status === 'display' && !p.display_for_sale).length,
        display_for_sale: ps.filter((p) => p.status === 'display' && p.display_for_sale).length,
        damaged: ps.filter((p) => p.status === 'damaged').length,
        racks: [...new Set(ps.map((p) => p.rack).filter(Boolean))],
      };
      if (row.physical > 0 || row.reserved > 0) byLocation.push({ location_id: loc.id, location: loc.name, location_code: loc.code, type: loc.type, ...row });
    }
  }
  const sum = (k) => byLocation.reduce((s, r) => s + r[k], 0);
  const totals = {
    physical: sum('physical'), reserved: sum('reserved'), available: sum('available'),
    display: sum('display'), display_for_sale: sum('display_for_sale'), damaged: sum('damaged'), in_transit: inTransit,
  };
  return {
    product_id: product.id, tracking: product.tracking, totals, byLocation,
    status: classify(totals, product.made_to_order),
    expected: totals.available > 0 ? null : expectedFrom(product, inc),
  };
}

function pieceStatus(piece) {
  if (piece.status === 'display') return piece.display_for_sale ? 'available_now' : 'display_only';
  return { available: 'available_now', reserved: 'reserved', sold: 'sold', damaged: 'damaged', in_transit: 'in_transit' }[piece.status];
}

// ---------------- Reservations ----------------

/**
 * Reserve a unique piece or SKU quantity. The piece update is conditional on the
 * piece still being saleable (Postgres re-checks the condition after any concurrent
 * update commits) and a partial unique index allows one active reservation per piece,
 * so two staff reserving the same piece at the same time cannot both succeed.
 */
function reserve(db, { productId, pieceId, locationId, qty = 1, customerName, quotationId, userId }) {
  return inTx(db, async (t) => {
    if (pieceId) {
      // Lock the piece row: a second concurrent request waits here, then sees it reserved.
      const before = await getPiece(t, pieceId, true);
      const upd = await t.one(`UPDATE pieces SET status = 'reserved' WHERE id = $1 AND ${SALEABLE_PIECE} RETURNING product_id, location_id`, [before.id]);
      if (!upd) {
        throw new StockError(before.status === 'reserved' ? 'This piece has just been reserved by someone else' : `This piece is not available to reserve (${pieceStatus(before).replace('_', ' ')})`);
      }
      const prev = before.status;
      const r = await t.one(`INSERT INTO reservations (product_id, piece_id, location_id, qty, piece_prev_status, customer_name, quotation_id, created_by)
        VALUES ($1, $2, $3, 1, $4, $5, $6, $7) RETURNING id`, [upd.product_id, pieceId, upd.location_id, prev, customerName || null, quotationId || null, userId]);
      await ledger(t, { user_id: userId, movement: 'reserve', product_id: upd.product_id, piece_id: Number(pieceId), from_location_id: upd.location_id, qty: 1, reference: `RES-${r.id}`, note: customerName });
      return r.id;
    }
    const product = await getProduct(t, productId, true);
    if (product.tracking === 'piece') throw new StockError('This product is tracked by individual piece — choose the exact piece to reserve', 400);
    const n = posInt(qty);
    let loc = locationId ? Number(locationId) : null;
    let avail;
    if (loc) avail = await skuAvailableAt(t, product.id, loc);
    else ({ id: loc, available: avail } = (await bestSkuLocation(t, product.id)) || { id: null, available: 0 });
    if (avail < n) throw new StockError(`Only ${avail} available to reserve at this location`);
    const r = await t.one('INSERT INTO reservations (product_id, location_id, qty, customer_name, quotation_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [product.id, loc, n, customerName || null, quotationId || null, userId]);
    await ledger(t, { user_id: userId, movement: 'reserve', product_id: product.id, from_location_id: loc, qty: n, reference: `RES-${r.id}`, note: customerName });
    return r.id;
  });
}

function releaseReservation(db, reservationId, userId, reason = 'cancelled') {
  return inTx(db, async (t) => {
    const r = await t.one('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [Number(reservationId)]);
    if (!r) throw new StockError('Reservation not found', 404);
    if (r.status !== 'active') throw new StockError('Reservation is no longer active');
    await t.query("UPDATE reservations SET status = 'released', closed_at = now() WHERE id = $1", [r.id]);
    if (r.piece_id) await t.query("UPDATE pieces SET status = $1 WHERE id = $2 AND status = 'reserved'", [r.piece_prev_status || 'available', r.piece_id]);
    await ledger(t, { user_id: userId, movement: 'release', product_id: r.product_id, piece_id: r.piece_id, from_location_id: r.location_id, qty: r.qty, reference: `RES-${r.id}`, note: reason });
  });
}

// ---------------- Movements ----------------

function receive(db, { productId, locationId, rack, qty, condition = 'sellable', pieces, incomingId, reference, userId }) {
  return inTx(db, async (t) => {
    const product = await getProduct(t, productId, true);
    if (!locationId) throw new StockError('Choose a receiving location', 400);
    const created = [];
    if (product.tracking === 'piece') {
      const list = Array.isArray(pieces) && pieces.length ? pieces : Array.from({ length: posInt(qty) }, () => ({}));
      for (const spec of list) {
        const status = spec.status || (condition === 'damaged' ? 'damaged' : condition === 'display' ? 'display' : 'available');
        const code = await nextCode(t, 'AHU');
        const r = await t.one(`INSERT INTO pieces (piece_code, public_token, product_id, condition, finish_note, location_id, rack, status, cost_price, selling_price, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [code, newToken(), product.id, spec.condition || 'New', spec.finish_note || null,
          locationId, spec.rack || rack || null, status, spec.cost_price ?? product.cost_price, spec.selling_price ?? product.selling_price, spec.notes || null]);
        await ledger(t, { user_id: userId, movement: 'receive', product_id: product.id, piece_id: r.id, to_location_id: locationId, condition: status, qty: 1, reference });
        created.push({ id: r.id, piece_code: code });
      }
    } else {
      const n = posInt(qty);
      await adjustBalance(t, product.id, locationId, condition, n, rack);
      await ledger(t, { user_id: userId, movement: 'receive', product_id: product.id, to_location_id: locationId, condition, qty: n, reference });
    }
    if (incomingId) await t.query("UPDATE incoming SET status = 'received' WHERE id = $1 AND product_id = $2", [incomingId, product.id]);
    return { created };
  });
}

function transfer(db, { productId, pieceId, fromLocationId, toLocationId, qty, condition = 'sellable', rack, reference, userId }) {
  return inTx(db, async (t) => {
    if (!toLocationId) throw new StockError('Choose a destination', 400);
    if (pieceId) {
      const piece = await getPiece(t, pieceId, true);
      if (piece.status === 'sold') throw new StockError('This piece has been sold');
      if (piece.location_id === Number(toLocationId) && (rack || null) === piece.rack) throw new StockError('Piece is already at this location', 400);
      await t.query('UPDATE pieces SET location_id = $1, rack = $2 WHERE id = $3', [toLocationId, rack || null, piece.id]);
      await t.query("UPDATE reservations SET location_id = $1 WHERE piece_id = $2 AND status = 'active'", [toLocationId, piece.id]);
      await ledger(t, { user_id: userId, movement: 'transfer', product_id: piece.product_id, piece_id: piece.id, from_location_id: piece.location_id, to_location_id: toLocationId, qty: 1, reference, note: rack ? `rack ${rack}` : null });
      return;
    }
    const product = await getProduct(t, productId, true);
    if (product.tracking === 'piece') throw new StockError('Choose the exact piece to transfer', 400);
    if (!fromLocationId || Number(fromLocationId) === Number(toLocationId)) throw new StockError('Choose two different locations', 400);
    const n = posInt(qty);
    if (condition === 'sellable' || condition === 'display_sale') {
      const free = await skuAvailableAt(t, product.id, fromLocationId);
      if (free < n) throw new StockError(`Only ${free} unreserved units can be moved from this location`);
    }
    await adjustBalance(t, product.id, fromLocationId, condition, -n);
    await adjustBalance(t, product.id, toLocationId, condition, n, rack);
    await ledger(t, { user_id: userId, movement: 'transfer', product_id: product.id, from_location_id: fromLocationId, to_location_id: toLocationId, condition, qty: n, reference });
  });
}

function dispatch(db, { productId, pieceId, locationId, qty, reservationId, reference, userId }) {
  return inTx(db, async (t) => {
    let res = null;
    if (reservationId) {
      res = await t.one("SELECT * FROM reservations WHERE id = $1 AND status = 'active' FOR UPDATE", [Number(reservationId)]);
      if (!res) throw new StockError('Reservation is not active');
      pieceId = res.piece_id; productId = res.product_id; locationId = res.location_id; qty = res.qty;
    }
    if (pieceId) {
      const piece = await getPiece(t, pieceId, true);
      if (!res) {
        res = await t.one("SELECT * FROM reservations WHERE piece_id = $1 AND status = 'active' FOR UPDATE", [piece.id]);
        if (!res && !(piece.status === 'available' || (piece.status === 'display' && piece.display_for_sale))) {
          throw new StockError(`This piece cannot be dispatched (${pieceStatus(piece).replace('_', ' ')})`);
        }
      }
      await t.query("UPDATE pieces SET status = 'sold' WHERE id = $1", [piece.id]);
      if (res) await t.query("UPDATE reservations SET status = 'fulfilled', closed_at = now() WHERE id = $1", [res.id]);
      await ledger(t, { user_id: userId, movement: 'dispatch', product_id: piece.product_id, piece_id: piece.id, from_location_id: piece.location_id, qty: -1, reference });
      return;
    }
    const product = await getProduct(t, productId, true);
    if (product.tracking === 'piece') throw new StockError('Choose the exact piece to dispatch', 400);
    if (!locationId) throw new StockError('Choose the dispatch location', 400);
    const n = posInt(qty);
    if (!res && await skuAvailableAt(t, product.id, locationId) < n) throw new StockError('Not enough unreserved stock to dispatch');
    // take sellable first, then display pieces released for sale
    const fromSellable = Math.min(n, await balance(t, product.id, locationId, 'sellable'));
    if (fromSellable) await adjustBalance(t, product.id, locationId, 'sellable', -fromSellable);
    if (n - fromSellable) await adjustBalance(t, product.id, locationId, 'display_sale', -(n - fromSellable));
    if (res) await t.query("UPDATE reservations SET status = 'fulfilled', closed_at = now() WHERE id = $1", [res.id]);
    await ledger(t, { user_id: userId, movement: 'dispatch', product_id: product.id, from_location_id: locationId, condition: 'sellable', qty: -n, reference: reference || (res ? `RES-${res.id}` : null) });
  });
}

/** Stock count. SKU: set counted quantity (difference is posted). Piece: verify or relocate. */
function count(db, { productId, pieceId, locationId, condition = 'sellable', countedQty, rack, userId, note }) {
  return inTx(db, async (t) => {
    if (pieceId) {
      const piece = await getPiece(t, pieceId, true);
      if (locationId && Number(locationId) !== piece.location_id) {
        await t.query('UPDATE pieces SET location_id = $1, rack = COALESCE($2, rack) WHERE id = $3', [locationId, rack || null, piece.id]);
        await ledger(t, { user_id: userId, movement: 'count_relocate', product_id: piece.product_id, piece_id: piece.id, from_location_id: piece.location_id, to_location_id: locationId, qty: 0, note: note || 'Found at a different location during count' });
      } else {
        await ledger(t, { user_id: userId, movement: 'count_verify', product_id: piece.product_id, piece_id: piece.id, from_location_id: piece.location_id, qty: 0, note });
      }
      return { delta: 0 };
    }
    const product = await getProduct(t, productId, true);
    if (!locationId) throw new StockError('Choose the count location', 400);
    const counted = Number(countedQty);
    if (!Number.isInteger(counted) || counted < 0) throw new StockError('Counted quantity must be zero or more', 400);
    const delta = counted - await balance(t, product.id, locationId, condition);
    if (delta !== 0) await adjustBalance(t, product.id, locationId, condition, delta, rack);
    await ledger(t, { user_id: userId, movement: 'count_adjust', product_id: product.id, to_location_id: locationId, condition, qty: delta, note: note || `Counted ${counted}` });
    return { delta };
  });
}

/** Re-classify stock: sellable/display/display_sale/damaged (SKU) or piece status. */
function changeCondition(db, { productId, pieceId, locationId, fromCondition, toCondition, qty, userId, note }) {
  const valid = ['sellable', 'display', 'display_sale', 'damaged'];
  if (!valid.includes(toCondition)) return Promise.reject(new StockError('Unknown condition', 400));
  return inTx(db, async (t) => {
    if (pieceId) {
      const piece = await getPiece(t, pieceId, true);
      if (['reserved', 'sold'].includes(piece.status)) throw new StockError(`A ${piece.status} piece cannot be re-classified`);
      const status = { sellable: 'available', display: 'display', display_sale: 'display', damaged: 'damaged' }[toCondition];
      await t.query('UPDATE pieces SET status = $1, display_for_sale = $2 WHERE id = $3', [status, toCondition === 'display_sale' ? 1 : 0, piece.id]);
      await ledger(t, { user_id: userId, movement: 'reclassify', product_id: piece.product_id, piece_id: piece.id, from_location_id: piece.location_id, condition: toCondition, qty: 0, note: note || `${piece.status} → ${toCondition}` });
      return;
    }
    const product = await getProduct(t, productId, true);
    if (!valid.includes(fromCondition) || fromCondition === toCondition) throw new StockError('Choose two different conditions', 400);
    const n = posInt(qty);
    if (fromCondition === 'sellable' || fromCondition === 'display_sale') {
      const free = await skuAvailableAt(t, product.id, locationId);
      if (free < n) throw new StockError(`Only ${free} unreserved units can be re-classified`);
    }
    await adjustBalance(t, product.id, locationId, fromCondition, -n);
    await adjustBalance(t, product.id, locationId, toCondition, n);
    await ledger(t, { user_id: userId, movement: 'reclassify', product_id: product.id, from_location_id: locationId, to_location_id: locationId, condition: `${fromCondition}→${toCondition}`, qty: n, note });
  });
}

/** Customer return after inspection: goes back as sellable or damaged. */
function returnInspected(db, { productId, pieceId, locationId, qty = 1, result, rack, reference, userId, note }) {
  if (!['sellable', 'damaged'].includes(result)) return Promise.reject(new StockError('Inspection result must be sellable or damaged', 400));
  if (!locationId) return Promise.reject(new StockError('Choose where the return is stored', 400));
  return inTx(db, async (t) => {
    if (pieceId) {
      const piece = await getPiece(t, pieceId, true);
      if (piece.status !== 'sold') throw new StockError('Only a sold piece can be returned');
      await t.query('UPDATE pieces SET status = $1, display_for_sale = 0, location_id = $2, rack = $3 WHERE id = $4',
        [result === 'sellable' ? 'available' : 'damaged', locationId, rack || null, piece.id]);
      await ledger(t, { user_id: userId, movement: 'return', product_id: piece.product_id, piece_id: piece.id, to_location_id: locationId, condition: result, qty: 1, reference, note });
      return;
    }
    const product = await getProduct(t, productId, true);
    const n = posInt(qty);
    await adjustBalance(t, product.id, locationId, result, n, rack);
    await ledger(t, { user_id: userId, movement: 'return', product_id: product.id, to_location_id: locationId, condition: result, qty: n, reference, note });
  });
}

module.exports = {
  StockError, inTx, productAvailability, availabilityMany, pieceStatus, skuAvailableAt, reserve, releaseReservation,
  receive, transfer, dispatch, count, changeCondition, returnInspected, ledger,
};
