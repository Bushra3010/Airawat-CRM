'use strict';
/**
 * Stock availability and movements. Every function that changes stock or
 * availability writes to stock_ledger inside the same transaction.
 * Nothing here is called by the scan/lookup path — scanning is read-only.
 */
const { nextCode, newToken } = require('./codes');

class StockError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

const SALEABLE_PIECE = "(p.status = 'available' OR (p.status = 'display' AND p.display_for_sale = 1))";

function ledger(db, e) {
  db.prepare(`INSERT INTO stock_ledger (user_id, movement, product_id, piece_id, from_location_id, to_location_id, condition, qty, reference, note)
    VALUES (@user_id, @movement, @product_id, @piece_id, @from_location_id, @to_location_id, @condition, @qty, @reference, @note)`).run({
    user_id: null, piece_id: null, from_location_id: null, to_location_id: null, condition: null, reference: null, note: null, ...e,
  });
}

function getProduct(db, id) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) throw new StockError('Product not found', 404);
  return p;
}
function getPiece(db, id) {
  const p = db.prepare('SELECT * FROM pieces WHERE id = ?').get(id);
  if (!p) throw new StockError('Piece not found', 404);
  return p;
}
function posInt(n, what = 'Quantity') {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) throw new StockError(`${what} must be a whole number above zero`, 400);
  return v;
}

// ---------------- Availability ----------------

function skuReservedAt(db, productId, locationId) {
  return db.prepare(`SELECT COALESCE(SUM(qty),0) n FROM reservations
    WHERE product_id = ? AND piece_id IS NULL AND location_id = ? AND status = 'active'`).get(productId, locationId).n;
}

function balance(db, productId, locationId, condition) {
  const r = db.prepare('SELECT qty FROM stock_balances WHERE product_id = ? AND location_id = ? AND condition = ?').get(productId, locationId, condition);
  return r ? r.qty : 0;
}

function adjustBalance(db, productId, locationId, condition, delta, rack) {
  const cur = balance(db, productId, locationId, condition);
  if (cur + delta < 0) throw new StockError(`Not enough ${condition.replace('_', ' ')} stock at this location (have ${cur})`);
  // (an UPSERT would trip the qty >= 0 CHECK on the candidate row for negative deltas)
  const upd = db.prepare('UPDATE stock_balances SET qty = qty + ?, rack = COALESCE(?, rack) WHERE product_id = ? AND location_id = ? AND condition = ?')
    .run(delta, rack || null, productId, locationId, condition);
  if (!upd.changes) {
    db.prepare('INSERT INTO stock_balances (product_id, location_id, condition, qty, rack) VALUES (?, ?, ?, ?, ?)').run(productId, locationId, condition, delta, rack || null);
  }
}

/** Saleable, unreserved quantity of a SKU-tracked product at a location. */
function skuAvailableAt(db, productId, locationId) {
  const saleable = balance(db, productId, locationId, 'sellable') + balance(db, productId, locationId, 'display_sale');
  return Math.max(0, saleable - skuReservedAt(db, productId, locationId));
}

function expectedAvailability(db, product) {
  const inc = db.prepare(`SELECT kind, qty, expected_date FROM incoming WHERE product_id = ? AND status IN ('requested','ordered')
    AND expected_date IS NOT NULL ORDER BY expected_date LIMIT 1`).get(product.id);
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
function productAvailability(db, productId) {
  const product = getProduct(db, productId);
  const locs = db.prepare('SELECT * FROM locations ORDER BY CASE type WHEN \'showroom\' THEN 0 WHEN \'warehouse\' THEN 1 ELSE 2 END, name').all();
  const byLocation = [];
  let inTransit = 0;

  for (const loc of locs) {
    let row;
    if (product.tracking === 'sku') {
      const b = (c) => balance(db, product.id, loc.id, c);
      const sellable = b('sellable'), displaySale = b('display_sale'), display = b('display'), damaged = b('damaged');
      const reserved = skuReservedAt(db, product.id, loc.id);
      const racks = db.prepare('SELECT DISTINCT rack FROM stock_balances WHERE product_id = ? AND location_id = ? AND qty > 0 AND rack IS NOT NULL').all(product.id, loc.id).map((r) => r.rack);
      row = {
        physical: sellable + displaySale + display + damaged,
        reserved, available: Math.max(0, sellable + displaySale - reserved),
        display, display_for_sale: displaySale, damaged, racks,
      };
    } else {
      const ps = db.prepare('SELECT * FROM pieces WHERE product_id = ? AND location_id = ? AND status NOT IN (\'sold\',\'in_transit\')').all(product.id, loc.id);
      row = {
        physical: ps.length,
        reserved: ps.filter((p) => p.status === 'reserved').length,
        available: ps.filter((p) => p.status === 'available' || (p.status === 'display' && p.display_for_sale)).length,
        display: ps.filter((p) => p.status === 'display' && !p.display_for_sale).length,
        display_for_sale: ps.filter((p) => p.status === 'display' && p.display_for_sale).length,
        damaged: ps.filter((p) => p.status === 'damaged').length,
        racks: [...new Set(ps.map((p) => p.rack).filter(Boolean))],
      };
    }
    if (row.physical > 0 || row.reserved > 0) byLocation.push({ location_id: loc.id, location: loc.name, location_code: loc.code, type: loc.type, ...row });
  }
  if (product.tracking === 'piece') {
    inTransit = db.prepare("SELECT COUNT(*) n FROM pieces WHERE product_id = ? AND status = 'in_transit'").get(product.id).n;
  }
  const sum = (k) => byLocation.reduce((s, r) => s + r[k], 0);
  const totals = {
    physical: sum('physical'), reserved: sum('reserved'), available: sum('available'),
    display: sum('display'), display_for_sale: sum('display_for_sale'), damaged: sum('damaged'), in_transit: inTransit,
  };
  return {
    product_id: product.id, tracking: product.tracking, totals, byLocation,
    status: classify(totals, product.made_to_order),
    expected: totals.available > 0 ? null : expectedAvailability(db, product),
  };
}

function pieceStatus(piece) {
  if (piece.status === 'display') return piece.display_for_sale ? 'available_now' : 'display_only';
  return { available: 'available_now', reserved: 'reserved', sold: 'sold', damaged: 'damaged', in_transit: 'in_transit' }[piece.status];
}

// ---------------- Reservations ----------------

/**
 * Reserve a unique piece or SKU quantity. Runs as an IMMEDIATE transaction and the
 * piece update is conditional on the piece still being saleable, so two staff
 * reserving the same piece at the same time cannot both succeed.
 */
function reserve(db, { productId, pieceId, locationId, qty = 1, customerName, quotationId, userId }) {
  return db.transaction(() => {
    if (pieceId) {
      const piece = getPiece(db, pieceId);
      const res = db.prepare(`UPDATE pieces AS p SET status = 'reserved' WHERE p.id = ? AND ${SALEABLE_PIECE}`).run(pieceId);
      if (res.changes !== 1) {
        throw new StockError(piece.status === 'reserved' ? 'This piece has just been reserved by someone else' : `This piece is not available to reserve (${pieceStatus(piece).replace('_', ' ')})`);
      }
      const r = db.prepare(`INSERT INTO reservations (product_id, piece_id, location_id, qty, piece_prev_status, customer_name, quotation_id, created_by)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?)`).run(piece.product_id, pieceId, piece.location_id, piece.status, customerName || null, quotationId || null, userId);
      ledger(db, { user_id: userId, movement: 'reserve', product_id: piece.product_id, piece_id: pieceId, from_location_id: piece.location_id, qty: 1, reference: `RES-${r.lastInsertRowid}`, note: customerName });
      return Number(r.lastInsertRowid);
    }
    const product = getProduct(db, productId);
    if (product.tracking === 'piece') throw new StockError('This product is tracked by individual piece — choose the exact piece to reserve', 400);
    const n = posInt(qty);
    let loc = locationId;
    if (!loc) {
      const best = db.prepare('SELECT id FROM locations').all().map((l) => ({ id: l.id, a: skuAvailableAt(db, product.id, l.id) })).sort((a, b) => b.a - a.a)[0];
      loc = best && best.id;
    }
    const avail = loc ? skuAvailableAt(db, product.id, loc) : 0;
    if (avail < n) throw new StockError(`Only ${avail} available to reserve at this location`);
    const r = db.prepare(`INSERT INTO reservations (product_id, location_id, qty, customer_name, quotation_id, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(product.id, loc, n, customerName || null, quotationId || null, userId);
    ledger(db, { user_id: userId, movement: 'reserve', product_id: product.id, from_location_id: loc, qty: n, reference: `RES-${r.lastInsertRowid}`, note: customerName });
    return Number(r.lastInsertRowid);
  }).immediate();
}

function releaseReservation(db, reservationId, userId, reason = 'cancelled') {
  return db.transaction(() => {
    const r = db.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId);
    if (!r) throw new StockError('Reservation not found', 404);
    if (r.status !== 'active') throw new StockError('Reservation is no longer active');
    db.prepare("UPDATE reservations SET status = 'released', closed_at = datetime('now') WHERE id = ?").run(reservationId);
    if (r.piece_id) {
      db.prepare("UPDATE pieces SET status = ? WHERE id = ? AND status = 'reserved'").run(r.piece_prev_status || 'available', r.piece_id);
    }
    ledger(db, { user_id: userId, movement: 'release', product_id: r.product_id, piece_id: r.piece_id, from_location_id: r.location_id, qty: r.qty, reference: `RES-${r.id}`, note: reason });
  }).immediate();
}

// ---------------- Movements ----------------

function receive(db, { productId, locationId, rack, qty, condition = 'sellable', pieces, incomingId, reference, userId }) {
  return db.transaction(() => {
    const product = getProduct(db, productId);
    if (!locationId) throw new StockError('Choose a receiving location', 400);
    const created = [];
    if (product.tracking === 'piece') {
      const list = Array.isArray(pieces) && pieces.length ? pieces : Array.from({ length: posInt(qty) }, () => ({}));
      for (const spec of list) {
        const cond = spec.status || (condition === 'damaged' ? 'damaged' : condition === 'display' ? 'display' : 'available');
        const code = nextCode(db, 'AHU');
        const r = db.prepare(`INSERT INTO pieces (piece_code, public_token, product_id, condition, finish_note, location_id, rack, status, cost_price, selling_price, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, newToken(), product.id, spec.condition || 'New', spec.finish_note || null,
          locationId, spec.rack || rack || null, cond, spec.cost_price ?? product.cost_price, spec.selling_price ?? product.selling_price, spec.notes || null);
        ledger(db, { user_id: userId, movement: 'receive', product_id: product.id, piece_id: Number(r.lastInsertRowid), to_location_id: locationId, condition: cond, qty: 1, reference });
        created.push({ id: Number(r.lastInsertRowid), piece_code: code });
      }
    } else {
      const n = posInt(qty);
      adjustBalance(db, product.id, locationId, condition, n, rack);
      ledger(db, { user_id: userId, movement: 'receive', product_id: product.id, to_location_id: locationId, condition, qty: n, reference });
    }
    if (incomingId) db.prepare("UPDATE incoming SET status = 'received' WHERE id = ? AND product_id = ?").run(incomingId, product.id);
    return { created };
  }).immediate();
}

function transfer(db, { productId, pieceId, fromLocationId, toLocationId, qty, condition = 'sellable', rack, reference, userId }) {
  return db.transaction(() => {
    if (!toLocationId) throw new StockError('Choose a destination', 400);
    if (pieceId) {
      const piece = getPiece(db, pieceId);
      if (piece.status === 'sold') throw new StockError('This piece has been sold');
      if (piece.location_id === Number(toLocationId) && (rack || null) === piece.rack) throw new StockError('Piece is already at this location', 400);
      db.prepare('UPDATE pieces SET location_id = ?, rack = ? WHERE id = ?').run(toLocationId, rack || null, pieceId);
      db.prepare("UPDATE reservations SET location_id = ? WHERE piece_id = ? AND status = 'active'").run(toLocationId, pieceId);
      ledger(db, { user_id: userId, movement: 'transfer', product_id: piece.product_id, piece_id: pieceId, from_location_id: piece.location_id, to_location_id: toLocationId, qty: 1, reference, note: rack ? `rack ${rack}` : null });
      return;
    }
    const product = getProduct(db, productId);
    if (product.tracking === 'piece') throw new StockError('Choose the exact piece to transfer', 400);
    if (!fromLocationId || Number(fromLocationId) === Number(toLocationId)) throw new StockError('Choose two different locations', 400);
    const n = posInt(qty);
    if (condition === 'sellable' || condition === 'display_sale') {
      const free = skuAvailableAt(db, product.id, fromLocationId);
      if (free < n) throw new StockError(`Only ${free} unreserved units can be moved from this location`);
    }
    adjustBalance(db, product.id, fromLocationId, condition, -n);
    adjustBalance(db, product.id, toLocationId, condition, n, rack);
    ledger(db, { user_id: userId, movement: 'transfer', product_id: product.id, from_location_id: fromLocationId, to_location_id: toLocationId, condition, qty: n, reference });
  }).immediate();
}

function dispatch(db, { productId, pieceId, locationId, qty, reservationId, reference, userId }) {
  return db.transaction(() => {
    let res = null;
    if (reservationId) {
      res = db.prepare("SELECT * FROM reservations WHERE id = ? AND status = 'active'").get(reservationId);
      if (!res) throw new StockError('Reservation is not active');
      pieceId = res.piece_id; productId = res.product_id; locationId = res.location_id; qty = res.qty;
    }
    if (pieceId) {
      const piece = getPiece(db, pieceId);
      if (!res) {
        res = db.prepare("SELECT * FROM reservations WHERE piece_id = ? AND status = 'active'").get(pieceId);
        if (!res && !(piece.status === 'available' || (piece.status === 'display' && piece.display_for_sale))) {
          throw new StockError(`This piece cannot be dispatched (${pieceStatus(piece).replace('_', ' ')})`);
        }
      }
      db.prepare("UPDATE pieces SET status = 'sold' WHERE id = ?").run(pieceId);
      if (res) db.prepare("UPDATE reservations SET status = 'fulfilled', closed_at = datetime('now') WHERE id = ?").run(res.id);
      ledger(db, { user_id: userId, movement: 'dispatch', product_id: piece.product_id, piece_id: pieceId, from_location_id: piece.location_id, qty: -1, reference });
      return;
    }
    const product = getProduct(db, productId);
    if (product.tracking === 'piece') throw new StockError('Choose the exact piece to dispatch', 400);
    if (!locationId) throw new StockError('Choose the dispatch location', 400);
    const n = posInt(qty);
    if (!res && skuAvailableAt(db, product.id, locationId) < n) throw new StockError('Not enough unreserved stock to dispatch');
    // take sellable first, then display pieces released for sale
    const fromSellable = Math.min(n, balance(db, product.id, locationId, 'sellable'));
    if (fromSellable) adjustBalance(db, product.id, locationId, 'sellable', -fromSellable);
    if (n - fromSellable) adjustBalance(db, product.id, locationId, 'display_sale', -(n - fromSellable));
    if (res) db.prepare("UPDATE reservations SET status = 'fulfilled', closed_at = datetime('now') WHERE id = ?").run(res.id);
    ledger(db, { user_id: userId, movement: 'dispatch', product_id: product.id, from_location_id: locationId, condition: 'sellable', qty: -n, reference: reference || (res ? `RES-${res.id}` : null) });
  }).immediate();
}

/** Stock count. SKU: set counted quantity (difference is posted). Piece: verify or relocate. */
function count(db, { productId, pieceId, locationId, condition = 'sellable', countedQty, rack, userId, note }) {
  return db.transaction(() => {
    if (pieceId) {
      const piece = getPiece(db, pieceId);
      if (locationId && Number(locationId) !== piece.location_id) {
        db.prepare('UPDATE pieces SET location_id = ?, rack = COALESCE(?, rack) WHERE id = ?').run(locationId, rack || null, pieceId);
        ledger(db, { user_id: userId, movement: 'count_relocate', product_id: piece.product_id, piece_id: pieceId, from_location_id: piece.location_id, to_location_id: locationId, qty: 0, note: note || 'Found at a different location during count' });
      } else {
        ledger(db, { user_id: userId, movement: 'count_verify', product_id: piece.product_id, piece_id: pieceId, from_location_id: piece.location_id, qty: 0, note });
      }
      return { delta: 0 };
    }
    const product = getProduct(db, productId);
    if (!locationId) throw new StockError('Choose the count location', 400);
    const counted = Number(countedQty);
    if (!Number.isInteger(counted) || counted < 0) throw new StockError('Counted quantity must be zero or more', 400);
    const delta = counted - balance(db, product.id, locationId, condition);
    if (delta !== 0) adjustBalance(db, product.id, locationId, condition, delta, rack);
    ledger(db, { user_id: userId, movement: 'count_adjust', product_id: product.id, to_location_id: locationId, condition, qty: delta, note: note || `Counted ${counted}` });
    return { delta };
  }).immediate();
}

/** Re-classify stock: sellable/display/display_sale/damaged (SKU) or piece status. */
function changeCondition(db, { productId, pieceId, locationId, fromCondition, toCondition, qty, userId, note }) {
  const valid = ['sellable', 'display', 'display_sale', 'damaged'];
  if (!valid.includes(toCondition)) throw new StockError('Unknown condition', 400);
  return db.transaction(() => {
    if (pieceId) {
      const piece = getPiece(db, pieceId);
      if (['reserved', 'sold'].includes(piece.status)) throw new StockError(`A ${piece.status} piece cannot be re-classified`);
      const status = { sellable: 'available', display: 'display', display_sale: 'display', damaged: 'damaged' }[toCondition];
      db.prepare('UPDATE pieces SET status = ?, display_for_sale = ? WHERE id = ?').run(status, toCondition === 'display_sale' ? 1 : 0, pieceId);
      ledger(db, { user_id: userId, movement: 'reclassify', product_id: piece.product_id, piece_id: pieceId, from_location_id: piece.location_id, condition: toCondition, qty: 0, note: note || `${piece.status} → ${toCondition}` });
      return;
    }
    const product = getProduct(db, productId);
    if (!valid.includes(fromCondition) || fromCondition === toCondition) throw new StockError('Choose two different conditions', 400);
    const n = posInt(qty);
    if (fromCondition === 'sellable' || fromCondition === 'display_sale') {
      const free = skuAvailableAt(db, product.id, locationId);
      if (free < n) throw new StockError(`Only ${free} unreserved units can be re-classified`);
    }
    adjustBalance(db, product.id, locationId, fromCondition, -n);
    adjustBalance(db, product.id, locationId, toCondition, n);
    ledger(db, { user_id: userId, movement: 'reclassify', product_id: product.id, from_location_id: locationId, to_location_id: locationId, condition: `${fromCondition}→${toCondition}`, qty: n, note });
  }).immediate();
}

/** Customer return after inspection: goes back as sellable or damaged. */
function returnInspected(db, { productId, pieceId, locationId, qty = 1, result, rack, reference, userId, note }) {
  if (!['sellable', 'damaged'].includes(result)) throw new StockError('Inspection result must be sellable or damaged', 400);
  if (!locationId) throw new StockError('Choose where the return is stored', 400);
  return db.transaction(() => {
    if (pieceId) {
      const piece = getPiece(db, pieceId);
      if (piece.status !== 'sold') throw new StockError('Only a sold piece can be returned');
      db.prepare('UPDATE pieces SET status = ?, display_for_sale = 0, location_id = ?, rack = ? WHERE id = ?')
        .run(result === 'sellable' ? 'available' : 'damaged', locationId, rack || null, pieceId);
      ledger(db, { user_id: userId, movement: 'return', product_id: piece.product_id, piece_id: pieceId, to_location_id: locationId, condition: result, qty: 1, reference, note });
      return;
    }
    const product = getProduct(db, productId);
    const n = posInt(qty);
    adjustBalance(db, product.id, locationId, result, n, rack);
    ledger(db, { user_id: userId, movement: 'return', product_id: product.id, to_location_id: locationId, condition: result, qty: n, reference, note });
  }).immediate();
}

module.exports = {
  StockError, productAvailability, pieceStatus, skuAvailableAt, reserve, releaseReservation,
  receive, transfer, dispatch, count, changeCondition, returnInspected, ledger,
};
