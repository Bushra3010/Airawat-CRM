'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const inv = require('./inventory');
const catalog = require('./catalog');
const pub = require('./public');
const labels = require('./labels');
const { nextCode, newToken, normaliseMfrBarcode, assertCodeFree, parseYouTube } = require('./codes');

// ---------------- Auth ----------------
const ROLE_PERMS = {
  admin: ['*'],
  manager: ['view', 'view_cost', 'reserve', 'quote', 'receive', 'transfer', 'dispatch', 'count', 'adjust', 'return', 'labels', 'manage_products', 'manage_settings', 'enquiry'],
  sales: ['view', 'reserve', 'quote', 'enquiry', 'labels'],
  storekeeper: ['view', 'receive', 'transfer', 'dispatch', 'count', 'adjust', 'return', 'labels', 'enquiry'],
};
const can = (user, perm) => !!user && (ROLE_PERMS[user.role].includes('*') || ROLE_PERMS[user.role].includes(perm));
const permsOf = (user) => (ROLE_PERMS[user.role].includes('*') ? ROLE_PERMS.manager.concat(['manage_users']) : ROLE_PERMS[user.role]);

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

// ---------------- App ----------------
function createApp({ db, uploadDir = path.join(__dirname, '..', 'data', 'uploads'), publicBaseUrl } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  fs.mkdirSync(uploadDir, { recursive: true });

  const baseUrl = (req) => {
    const s = db.prepare("SELECT value FROM settings WHERE key = 'public_base_url'").get();
    return (publicBaseUrl || (s && s.value) || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  };
  const businessName = () => pub.settings(db).business_name;

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  // ================= PUBLIC (no login) =================
  // Only these routes are reachable without a session, and they only use the
  // whitelisting functions in public.js — never the internal inventory API.
  const publicCsp = "default-src 'self'; img-src 'self' https://i.ytimg.com data:; frame-src https://www.youtube-nocookie.com; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'";
  const publicRouter = express.Router();
  const publicHeaders = (req, res, next) => { res.set('Content-Security-Policy', publicCsp); res.set('Cache-Control', 'no-store'); next(); };
  publicRouter.use(['/p/', '/c/', '/api/public/'], publicHeaders);
  publicRouter.get('/p/:token', (req, res) => {
    const d = pub.publicItem(db, req.params.token);
    if (!d) return res.status(404).type('html').send(pub.renderNotAvailable(businessName()));
    res.type('html').send(pub.renderItemPage(d, req.params.token));
  });
  publicRouter.get('/c/:token', (req, res) => {
    const d = pub.publicCatalogue(db, req.params.token);
    if (!d) return res.status(404).type('html').send(pub.renderNotAvailable(businessName()));
    res.type('html').send(pub.renderCataloguePage(d));
  });
  publicRouter.get('/api/public/p/:token', (req, res) => {
    const d = pub.publicItem(db, req.params.token);
    if (!d) return res.status(404).json({ error: 'Not available' });
    res.json(d);
  });
  publicRouter.get('/api/public/c/:token', (req, res) => {
    const d = pub.publicCatalogue(db, req.params.token);
    if (!d) return res.status(404).json({ error: 'Not available' });
    res.json(d);
  });
  const hits = new Map();
  publicRouter.post('/api/public/p/:token/enquiry', express.json({ limit: '4kb' }), (req, res) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter((t) => now - t < 10 * 60e3);
    if (list.length >= 5) return res.status(429).json({ error: 'Too many requests — please ask showroom staff' });
    list.push(now); hits.set(req.ip, list);
    const d = pub.publicItem(db, req.params.token);
    if (!d) return res.status(404).json({ error: 'Not available' });
    const name = String(req.body.name || '').trim().slice(0, 80);
    const phone = String(req.body.phone || '').trim().slice(0, 20);
    if (!name || !/^[+\d][\d\s-]{6,19}$/.test(phone)) return res.status(400).json({ error: 'Please enter your name and a valid phone number' });
    const piece = db.prepare('SELECT id, product_id FROM pieces WHERE public_token = ?').get(req.params.token);
    const productId = piece ? piece.product_id : db.prepare('SELECT id FROM products WHERE public_token = ?').get(req.params.token).id;
    db.prepare("INSERT INTO enquiries (product_id, piece_id, source, customer_name, customer_phone, message) VALUES (?, ?, 'public_qr', ?, ?, ?)")
      .run(productId, piece ? piece.id : null, name, phone, String(req.body.message || '').slice(0, 500));
    res.json({ ok: true });
  });
  app.use(publicRouter);

  // ================= STAFF =================
  app.use('/vendor/html5-qrcode.min.js', (req, res) => res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js')));
  app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  const api = express.Router();
  api.use(express.json({ limit: '8mb' }));
  // JSON-only mutations (blocks cross-site form posts)
  api.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON body required' });
    next();
  });

  api.post('/login', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(req.body.username || '').toLowerCase());
    if (!u || !verifyPassword(req.body.password || '', u.pass_hash)) return res.status(401).json({ error: 'Wrong username or password' });
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, u.id, Date.now() + 12 * 3600e3);
    res.set('Set-Cookie', `ahs=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}${req.secure ? '; Secure' : ''}`);
    res.json({ id: u.id, name: u.name, role: u.role, permissions: permsOf(u) });
  });

  api.use((req, res, next) => {
    const token = parseCookies(req).ahs;
    const s = token && db.prepare('SELECT u.id, u.name, u.role, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.active = 1').get(token, Date.now());
    if (!s) return res.status(401).json({ error: 'Please sign in' });
    req.user = s; req.sessionToken = token;
    next();
  });
  const need = (perm) => (req, res, next) => (can(req.user, perm) ? next() : res.status(403).json({ error: 'You do not have permission for this action' }));
  // Inventory movements must be explicitly confirmed; a scan alone never moves stock.
  const confirmed = (req, res, next) => (req.body && req.body.confirm === true ? next() : res.status(400).json({ error: 'Stock changes need explicit confirmation', needs_confirmation: true }));
  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') out.catch((e) => sendErr(res, e));
      else if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) { sendErr(res, e); }
  };
  function sendErr(res, e) {
    const status = e.status || (/UNIQUE constraint failed: reservations/.test(e.message) ? 409 : /constraint/i.test(e.message) ? 400 : 500);
    if (status === 500) console.error(e);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : (/UNIQUE constraint failed: reservations/.test(e.message) ? 'This piece has just been reserved by someone else' : e.message) });
  }

  api.post('/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.set('Set-Cookie', 'ahs=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });
  api.get('/me', (req, res) => res.json({ ...req.user, permissions: permsOf(req.user), business_name: businessName() }));
  api.get('/locations', need('view'), (req, res) => res.json(db.prepare('SELECT * FROM locations ORDER BY type, name').all()));

  // ---------- Finder ----------
  api.get('/search', need('view'), wrap((req) => catalog.search(db, req.query)));
  api.get('/facets', need('view'), wrap(() => catalog.facets(db)));

  /** Scan resolution: read-only. Returns what was scanned and which actions this user may take. */
  api.get('/scan', need('view'), wrap((req) => {
    const r = catalog.resolveCode(db, req.query.code);
    if (!r) { const e = new Error(`No product or piece found for "${String(req.query.code || '').slice(0, 60)}"`); e.status = 404; throw e; }
    const product = db.prepare('SELECT tracking FROM products WHERE id = ?').get(r.product_id);
    const actions = ['view', 'quote', 'reserve', 'receive', 'transfer', 'dispatch', 'count'].filter((a) => can(req.user, a));
    return { ...r, tracking: product.tracking, actions };
  }));

  api.get('/products/:id', need('view'), wrap((req) => {
    const d = catalog.productDetail(db, Number(req.params.id), { includeCost: can(req.user, 'view_cost') });
    if (!d) throw Object.assign(new Error('Product not found'), { status: 404 });
    return d;
  }));
  api.get('/pieces/:id', need('view'), wrap((req) => {
    const d = catalog.pieceDetail(db, Number(req.params.id), { includeCost: can(req.user, 'view_cost') });
    if (!d) throw Object.assign(new Error('Piece not found'), { status: 404 });
    return d;
  }));
  api.get('/products/:id/alternatives', need('view'), wrap((req) => catalog.alternatives(db, Number(req.params.id), 8)));

  // ---------- Product admin ----------
  const PRODUCT_FIELDS = ['sku', 'parent_id', 'variant_label', 'name', 'category', 'material', 'finish', 'length_cm', 'width_cm', 'height_cm', 'description', 'care', 'short_specs',
    'selling_price', 'cost_price', 'vendor', 'internal_notes', 'tracking', 'made_to_order', 'lead_time_days', 'mfr_barcode', 'public_enabled', 'public_show_price', 'active'];
  function cleanProduct(body, existing) {
    const out = {};
    for (const k of PRODUCT_FIELDS) if (k in body) out[k] = body[k] === '' ? null : body[k];
    for (const k of ['made_to_order', 'public_enabled', 'public_show_price', 'active']) if (k in out) out[k] = out[k] ? 1 : 0;
    if ('mfr_barcode' in out) {
      out.mfr_barcode = normaliseMfrBarcode(out.mfr_barcode);
      assertCodeFree(db, out.mfr_barcode, existing ? { type: 'product', id: existing.id } : {});
    }
    if ('sku' in out) {
      out.sku = String(out.sku || '').trim().toUpperCase();
      if (!out.sku) throw Object.assign(new Error('SKU is required'), { status: 400 });
      const clash = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(out.sku, existing ? existing.id : -1);
      if (clash) throw Object.assign(new Error('SKU already exists'), { status: 409 });
    }
    if (existing && 'tracking' in out && out.tracking !== existing.tracking) {
      const has = db.prepare('SELECT (SELECT COUNT(*) FROM stock_balances WHERE product_id = ? AND qty > 0) + (SELECT COUNT(*) FROM pieces WHERE product_id = ?) n').get(existing.id, existing.id).n;
      if (has) throw Object.assign(new Error('Tracking type cannot change once stock exists'), { status: 409 });
    }
    return out;
  }
  api.post('/products', need('manage_products'), wrap((req) => db.transaction(() => {
    const data = cleanProduct(req.body);
    if (!data.name) throw Object.assign(new Error('Name is required'), { status: 400 });
    data.internal_code = nextCode(db, 'AHP');
    data.public_token = newToken();
    data.tracking = data.tracking || 'sku';
    const keys = Object.keys(data);
    const r = db.prepare(`INSERT INTO products (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`).run(data);
    return { id: Number(r.lastInsertRowid), internal_code: data.internal_code };
  })()));
  api.put('/products/:id', need('manage_products'), wrap((req) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!existing) throw Object.assign(new Error('Product not found'), { status: 404 });
    // internal_code and public_token are deliberately not editable: labels stay valid.
    const data = cleanProduct(req.body, existing);
    if (!Object.keys(data).length) return { ok: true };
    db.prepare(`UPDATE products SET ${Object.keys(data).map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...data, id: existing.id });
    return { ok: true };
  }));
  api.put('/pieces/:id', need('manage_products'), wrap((req) => {
    const pc = db.prepare('SELECT * FROM pieces WHERE id = ?').get(Number(req.params.id));
    if (!pc) throw Object.assign(new Error('Piece not found'), { status: 404 });
    const data = {};
    for (const k of ['condition', 'finish_note', 'selling_price', 'cost_price', 'notes', 'mfr_barcode', 'public_enabled', 'rack']) if (k in req.body) data[k] = req.body[k] === '' ? null : req.body[k];
    if ('public_enabled' in data) data.public_enabled = data.public_enabled ? 1 : 0;
    if ('mfr_barcode' in data) { data.mfr_barcode = normaliseMfrBarcode(data.mfr_barcode); assertCodeFree(db, data.mfr_barcode, { type: 'piece', id: pc.id }); }
    if (Object.keys(data).length) db.prepare(`UPDATE pieces SET ${Object.keys(data).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...data, id: pc.id });
    return { ok: true };
  }));
  api.get('/barcode-check', need('view'), wrap((req) => {
    try {
      const code = normaliseMfrBarcode(req.query.code);
      assertCodeFree(db, code, req.query.type ? { type: req.query.type, id: Number(req.query.id) } : {});
      return { ok: true, code };
    } catch (e) { return { ok: false, error: e.message }; }
  }));

  // Photos: URL or uploaded data URL (jpeg/png/webp, max ~5 MB)
  api.post('/photos', need('manage_products'), wrap((req) => {
    const { product_id, piece_id, url, data_url, caption, is_public = true } = req.body;
    if (!db.prepare('SELECT id FROM products WHERE id = ?').get(product_id)) throw Object.assign(new Error('Product not found'), { status: 404 });
    let finalUrl = url;
    if (data_url) {
      const m = String(data_url).match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw Object.assign(new Error('Photo must be a JPEG, PNG or WebP image'), { status: 400 });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 5.5e6) throw Object.assign(new Error('Photo is larger than 5 MB'), { status: 400 });
      const name = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      fs.writeFileSync(path.join(uploadDir, name), buf);
      finalUrl = `/uploads/${name}`;
    } else if (!/^(https:\/\/|\/)/.test(String(url || ''))) {
      throw Object.assign(new Error('Photo URL must start with https://'), { status: 400 });
    }
    const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM photos WHERE product_id = ?').get(product_id).s;
    const r = db.prepare('INSERT INTO photos (product_id, piece_id, url, caption, is_public, sort) VALUES (?, ?, ?, ?, ?, ?)').run(product_id, piece_id || null, finalUrl, caption || null, is_public ? 1 : 0, sort);
    return { id: Number(r.lastInsertRowid), url: finalUrl };
  }));
  api.patch('/photos/:id', need('manage_products'), wrap((req) => {
    if ('is_public' in req.body) db.prepare('UPDATE photos SET is_public = ? WHERE id = ?').run(req.body.is_public ? 1 : 0, Number(req.params.id));
    if ('caption' in req.body) db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(req.body.caption || null, Number(req.params.id));
    return { ok: true };
  }));
  api.delete('/photos/:id', need('manage_products'), wrap((req) => { db.prepare('DELETE FROM photos WHERE id = ?').run(Number(req.params.id)); return { ok: true }; }));

  // ---------- Videos ----------
  const VIDEO_TYPES = ['overview', 'dimensions', 'finish', 'demonstration', 'installation', 'care'];
  function cleanVideo(body, existing = {}) {
    const v = { ...existing, ...body };
    const id = parseYouTube(v.url);
    if (!id) throw Object.assign(new Error('Enter a YouTube video link (youtube.com/watch?v=…, youtu.be/…, /shorts/… or /embed/…)'), { status: 400 });
    if (!VIDEO_TYPES.includes(v.video_type)) throw Object.assign(new Error('Choose a video type'), { status: 400 });
    if (!String(v.title || '').trim()) throw Object.assign(new Error('Title is required'), { status: 400 });
    if (v.piece_id) {
      const pc = db.prepare('SELECT product_id FROM pieces WHERE id = ?').get(v.piece_id);
      if (!pc || pc.product_id !== Number(v.product_id)) throw Object.assign(new Error('Piece does not belong to this product'), { status: 400 });
    }
    return {
      product_id: Number(v.product_id), piece_id: v.piece_id ? Number(v.piece_id) : null, title: String(v.title).trim().slice(0, 200),
      url: String(v.url).trim(), youtube_id: id, video_type: v.video_type, is_primary: v.is_primary ? 1 : 0,
      visibility: v.visibility === 'internal' ? 'internal' : 'customer', overrides_parent: v.overrides_parent ? 1 : 0,
      embed_status: existing.youtube_id === id ? existing.embed_status : 'unchecked',
    };
  }
  function clearOtherPrimaries(v, id) {
    if (!v.is_primary) return;
    db.prepare('UPDATE videos SET is_primary = 0 WHERE product_id = ? AND COALESCE(piece_id,0) = ? AND id != ?').run(v.product_id, v.piece_id || 0, id);
  }
  api.get('/videos', need('view'), wrap((req) => catalog.videosFor(db, { productId: Number(req.query.product_id), pieceId: req.query.piece_id ? Number(req.query.piece_id) : null })));
  api.get('/videos/own', need('view'), wrap((req) => db.prepare('SELECT * FROM videos WHERE product_id = ? ORDER BY piece_id, is_primary DESC, id').all(Number(req.query.product_id))));
  api.post('/videos', need('manage_products'), wrap((req) => db.transaction(() => {
    const v = cleanVideo(req.body);
    const r = db.prepare(`INSERT INTO videos (product_id, piece_id, title, url, youtube_id, video_type, is_primary, visibility, overrides_parent, embed_status)
      VALUES (@product_id, @piece_id, @title, @url, @youtube_id, @video_type, @is_primary, @visibility, @overrides_parent, @embed_status)`).run(v);
    clearOtherPrimaries(v, r.lastInsertRowid);
    return { id: Number(r.lastInsertRowid), youtube_id: v.youtube_id };
  })()));
  api.put('/videos/:id', need('manage_products'), wrap((req) => db.transaction(() => {
    const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(Number(req.params.id));
    if (!existing) throw Object.assign(new Error('Video not found'), { status: 404 });
    const v = cleanVideo(req.body, existing);
    db.prepare(`UPDATE videos SET piece_id=@piece_id, title=@title, url=@url, youtube_id=@youtube_id, video_type=@video_type, is_primary=@is_primary,
      visibility=@visibility, overrides_parent=@overrides_parent, embed_status=@embed_status WHERE id=@id`).run({ ...v, id: existing.id });
    clearOtherPrimaries(v, existing.id);
    return { ok: true };
  })()));
  api.delete('/videos/:id', need('manage_products'), wrap((req) => { db.prepare('DELETE FROM videos WHERE id = ?').run(Number(req.params.id)); return { ok: true }; }));
  // Check availability with YouTube oEmbed: 401 = private/embedding disabled, 404 = removed.
  api.post('/videos/:id/check', need('view'), wrap(async (req, res) => {
    const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Video not found' });
    let status;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${v.youtube_id}`)}`, { signal: AbortSignal.timeout(6000) });
      status = r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'embed_disabled' : r.status === 404 || r.status === 400 ? 'unavailable' : null;
    } catch { status = null; }
    if (!status) return res.json({ embed_status: v.embed_status, error: 'Could not reach YouTube right now' });
    db.prepare("UPDATE videos SET embed_status = ?, checked_at = datetime('now') WHERE id = ?").run(status, v.id);
    res.json({ embed_status: status });
  }));
  // The staff player reports YouTube errors (100 = removed/private, 101/150 = embedding disabled).
  api.post('/videos/:id/player-error', need('view'), wrap((req) => {
    const code = Number(req.body.code);
    const status = code === 100 ? 'unavailable' : (code === 101 || code === 150) ? 'embed_disabled' : null;
    if (status) db.prepare("UPDATE videos SET embed_status = ?, checked_at = datetime('now') WHERE id = ?").run(status, Number(req.params.id));
    return { embed_status: status };
  }));

  // ---------- Stock movements (explicit + confirmed) ----------
  const uid = (req) => req.user.id;
  api.post('/stock/reserve', need('reserve'), confirmed, wrap((req) => ({ reservation_id: inv.reserve(db, { productId: req.body.product_id, pieceId: req.body.piece_id, locationId: req.body.location_id, qty: req.body.qty, customerName: req.body.customer_name, quotationId: req.body.quotation_id, userId: uid(req) }) })));
  api.post('/stock/release', need('reserve'), confirmed, wrap((req) => { inv.releaseReservation(db, req.body.reservation_id, uid(req), req.body.reason || 'cancelled'); return { ok: true }; }));
  api.post('/stock/receive', need('receive'), confirmed, wrap((req) => inv.receive(db, { productId: req.body.product_id, locationId: req.body.location_id, rack: req.body.rack, qty: req.body.qty, condition: req.body.condition, pieces: req.body.pieces, incomingId: req.body.incoming_id, reference: req.body.reference, userId: uid(req) })));
  api.post('/stock/transfer', need('transfer'), confirmed, wrap((req) => { inv.transfer(db, { productId: req.body.product_id, pieceId: req.body.piece_id, fromLocationId: req.body.from_location_id, toLocationId: req.body.to_location_id, qty: req.body.qty, condition: req.body.condition, rack: req.body.rack, reference: req.body.reference, userId: uid(req) }); return { ok: true }; }));
  api.post('/stock/dispatch', need('dispatch'), confirmed, wrap((req) => { inv.dispatch(db, { productId: req.body.product_id, pieceId: req.body.piece_id, locationId: req.body.location_id, qty: req.body.qty, reservationId: req.body.reservation_id, reference: req.body.reference, userId: uid(req) }); return { ok: true }; }));
  api.post('/stock/count', need('count'), confirmed, wrap((req) => inv.count(db, { productId: req.body.product_id, pieceId: req.body.piece_id, locationId: req.body.location_id, condition: req.body.condition, countedQty: req.body.counted_qty, rack: req.body.rack, note: req.body.note, userId: uid(req) })));
  api.post('/stock/condition', need('adjust'), confirmed, wrap((req) => { inv.changeCondition(db, { productId: req.body.product_id, pieceId: req.body.piece_id, locationId: req.body.location_id, fromCondition: req.body.from_condition, toCondition: req.body.to_condition, qty: req.body.qty, note: req.body.note, userId: uid(req) }); return { ok: true }; }));
  api.post('/stock/return', need('return'), confirmed, wrap((req) => { inv.returnInspected(db, { productId: req.body.product_id, pieceId: req.body.piece_id, locationId: req.body.location_id, qty: req.body.qty, result: req.body.result, rack: req.body.rack, reference: req.body.reference, note: req.body.note, userId: uid(req) }); return { ok: true }; }));
  api.get('/ledger', need('view'), wrap((req) => db.prepare(`SELECT sl.*, p.name AS product, p.sku, pc.piece_code, fl.name AS from_loc, tl.name AS to_loc, u.name AS by_name
    FROM stock_ledger sl JOIN products p ON p.id = sl.product_id LEFT JOIN pieces pc ON pc.id = sl.piece_id LEFT JOIN locations fl ON fl.id = sl.from_location_id
    LEFT JOIN locations tl ON tl.id = sl.to_location_id LEFT JOIN users u ON u.id = sl.user_id
    WHERE (@p IS NULL OR sl.product_id = @p) AND (@pc IS NULL OR sl.piece_id = @pc) ORDER BY sl.id DESC LIMIT 300`)
    .all({ p: req.query.product_id ? Number(req.query.product_id) : null, pc: req.query.piece_id ? Number(req.query.piece_id) : null })));

  // ---------- Enquiries and purchase / production requests ----------
  api.post('/enquiries', need('enquiry'), wrap((req) => {
    const b = req.body;
    if (!b.product_id) throw Object.assign(new Error('Product is required'), { status: 400 });
    const r = db.prepare("INSERT INTO enquiries (product_id, piece_id, source, customer_name, customer_phone, message, created_by) VALUES (?, ?, 'staff', ?, ?, ?, ?)")
      .run(b.product_id, b.piece_id || null, b.customer_name || null, b.customer_phone || null, b.message || null, uid(req));
    return { id: Number(r.lastInsertRowid) };
  }));
  api.get('/enquiries', need('enquiry'), wrap(() => db.prepare(`SELECT e.*, p.name AS product, p.sku, pc.piece_code, u.name AS by_name FROM enquiries e
    LEFT JOIN products p ON p.id = e.product_id LEFT JOIN pieces pc ON pc.id = e.piece_id LEFT JOIN users u ON u.id = e.created_by ORDER BY e.status, e.id DESC LIMIT 200`).all()));
  api.patch('/enquiries/:id', need('enquiry'), wrap((req) => { db.prepare('UPDATE enquiries SET status = ? WHERE id = ?').run(req.body.status === 'closed' ? 'closed' : 'open', Number(req.params.id)); return { ok: true }; }));
  api.post('/incoming', need('quote'), wrap((req) => {
    const b = req.body;
    if (!['purchase', 'production'].includes(b.kind)) throw Object.assign(new Error('Choose purchase or production'), { status: 400 });
    const r = db.prepare('INSERT INTO incoming (product_id, kind, qty, expected_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.product_id, b.kind, Math.max(1, Number(b.qty) || 1), b.expected_date || null, b.note || null, uid(req));
    return { id: Number(r.lastInsertRowid) };
  }));
  api.get('/incoming', need('view'), wrap(() => db.prepare("SELECT i.*, p.name AS product, p.sku FROM incoming i JOIN products p ON p.id = i.product_id WHERE i.status IN ('requested','ordered') ORDER BY expected_date").all()));
  api.patch('/incoming/:id', need('manage_products'), wrap((req) => {
    const b = req.body;
    db.prepare('UPDATE incoming SET status = COALESCE(?, status), expected_date = COALESCE(?, expected_date) WHERE id = ?').run(b.status || null, b.expected_date || null, Number(req.params.id));
    return { ok: true };
  }));

  // ---------- Shortlists (never reserve stock) ----------
  const shortlistItems = (id) => db.prepare(`SELECT si.*, p.name, p.sku, p.variant_label, p.material, p.finish, p.length_cm, p.width_cm, p.height_cm, p.selling_price, p.tracking,
      pc.piece_code, pc.selling_price AS piece_price FROM shortlist_items si JOIN products p ON p.id = si.product_id LEFT JOIN pieces pc ON pc.id = si.piece_id WHERE si.shortlist_id = ? ORDER BY si.id`)
    .all(id).map((it) => {
      const a = inv.productAvailability(db, it.product_id);
      const pieceRow = it.piece_id && db.prepare('SELECT * FROM pieces WHERE id = ?').get(it.piece_id);
      const status = pieceRow ? inv.pieceStatus(pieceRow) : a.status;
      return { ...it, dimensions: catalog.dims(it), price: it.piece_price ?? it.selling_price, photo: catalog.primaryPhoto(db, it.product_id, it.piece_id),
        status, status_label: catalog.STATUS_LABEL[status], available: pieceRow ? (status === 'available_now' ? 1 : 0) : a.totals.available };
    });
  api.get('/shortlists', need('quote'), wrap(() => db.prepare(`SELECT s.*, u.name AS by_name, (SELECT COUNT(*) FROM shortlist_items WHERE shortlist_id = s.id) AS items
    FROM shortlists s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC LIMIT 100`).all()));
  api.post('/shortlists', need('quote'), wrap((req) => {
    const r = db.prepare('INSERT INTO shortlists (customer_name, customer_phone, share_token, created_by) VALUES (?, ?, ?, ?)').run(req.body.customer_name || null, req.body.customer_phone || null, newToken(), uid(req));
    return { id: Number(r.lastInsertRowid) };
  }));
  api.get('/shortlists/:id', need('quote'), wrap((req) => {
    const s = db.prepare('SELECT * FROM shortlists WHERE id = ?').get(Number(req.params.id));
    if (!s) throw Object.assign(new Error('Shortlist not found'), { status: 404 });
    return { ...s, share_url: `${baseUrl(req)}/c/${s.share_token}`, items: shortlistItems(s.id) };
  }));
  api.patch('/shortlists/:id', need('quote'), wrap((req) => {
    const b = req.body, id = Number(req.params.id);
    for (const k of ['customer_name', 'customer_phone']) if (k in b) db.prepare(`UPDATE shortlists SET ${k} = ? WHERE id = ?`).run(b[k] || null, id);
    for (const k of ['share_enabled', 'share_show_prices']) if (k in b) db.prepare(`UPDATE shortlists SET ${k} = ? WHERE id = ?`).run(b[k] ? 1 : 0, id);
    return { ok: true };
  }));
  api.post('/shortlists/:id/items', need('quote'), wrap((req) => {
    const b = req.body;
    let productId = b.product_id, pieceId = b.piece_id || null;
    if (b.code) {
      const r = catalog.resolveCode(db, b.code);
      if (!r) throw Object.assign(new Error('Code not recognised'), { status: 404 });
      productId = r.product_id; pieceId = r.piece_id || null;
    }
    if (!db.prepare('SELECT id FROM products WHERE id = ?').get(productId)) throw Object.assign(new Error('Product not found'), { status: 404 });
    const r = db.prepare('INSERT INTO shortlist_items (shortlist_id, product_id, piece_id, qty, pref_finish, pref_dimensions, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Number(req.params.id), productId, pieceId, Math.max(1, Number(b.qty) || 1), b.pref_finish || null, b.pref_dimensions || null, b.note || null);
    return { id: Number(r.lastInsertRowid) };
  }));
  api.put('/shortlist-items/:id', need('quote'), wrap((req) => {
    const b = req.body;
    db.prepare('UPDATE shortlist_items SET qty = COALESCE(?, qty), pref_finish = ?, pref_dimensions = ?, note = ? WHERE id = ?')
      .run(b.qty ? Math.max(1, Number(b.qty)) : null, b.pref_finish || null, b.pref_dimensions || null, b.note || null, Number(req.params.id));
    return { ok: true };
  }));
  api.delete('/shortlist-items/:id', need('quote'), wrap((req) => { db.prepare('DELETE FROM shortlist_items WHERE id = ?').run(Number(req.params.id)); return { ok: true }; }));

  // ---------- Quotations / orders ----------
  function newQuoteNumber() {
    return nextCode(db, `Q${new Date().getFullYear()}`).replace(/-0+(\d{4,})$/, '-$1');
  }
  function createQuotation({ customer_name, customer_phone, shortlist_id, items = [] }, userId) {
    return db.transaction(() => {
      const r = db.prepare('INSERT INTO quotations (number, customer_name, customer_phone, shortlist_id, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(newQuoteNumber(), customer_name || null, customer_phone || null, shortlist_id || null, userId);
      const qid = Number(r.lastInsertRowid);
      for (const it of items) addQuoteItem(qid, it);
      return qid;
    })();
  }
  function addQuoteItem(qid, it) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    if (!p) throw Object.assign(new Error('Product not found'), { status: 404 });
    const pc = it.piece_id ? db.prepare('SELECT * FROM pieces WHERE id = ? AND product_id = ?').get(it.piece_id, p.id) : null;
    if (it.piece_id && !pc) throw Object.assign(new Error('Piece does not belong to this product'), { status: 400 });
    const price = it.unit_price != null && it.unit_price !== '' ? Number(it.unit_price) : (pc ? pc.selling_price ?? p.selling_price : p.selling_price);
    db.prepare('INSERT INTO quotation_items (quotation_id, product_id, piece_id, qty, unit_price, pref_finish, pref_dimensions, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(qid, p.id, pc ? pc.id : null, pc ? 1 : Math.max(1, Number(it.qty) || 1), price || 0, it.pref_finish || null, it.pref_dimensions || null, it.note || null);
  }
  function quotationView(id) {
    const q = db.prepare('SELECT q.*, u.name AS by_name FROM quotations q LEFT JOIN users u ON u.id = q.created_by WHERE q.id = ?').get(id);
    if (!q) throw Object.assign(new Error('Quotation not found'), { status: 404 });
    const items = db.prepare(`SELECT qi.*, p.name, p.sku, p.variant_label, p.tracking, p.made_to_order, pc.piece_code FROM quotation_items qi JOIN products p ON p.id = qi.product_id
      LEFT JOIN pieces pc ON pc.id = qi.piece_id WHERE qi.quotation_id = ? ORDER BY qi.id`).all(id).map((it) => {
      const piece = it.piece_id && db.prepare('SELECT * FROM pieces WHERE id = ?').get(it.piece_id);
      const a = inv.productAvailability(db, it.product_id);
      const status = piece ? inv.pieceStatus(piece) : a.status;
      const resv = db.prepare("SELECT id, qty, location_id FROM reservations WHERE quotation_id = ? AND product_id = ? AND COALESCE(piece_id,0) = ? AND status = 'active'").all(id, it.product_id, it.piece_id || 0);
      const heldByThis = resv.reduce((s, r) => s + r.qty, 0);
      const can_fulfil = heldByThis >= it.qty || (piece ? status === 'available_now' : a.totals.available >= it.qty);
      return { ...it, status, status_label: catalog.STATUS_LABEL[status], available: piece ? (status === 'available_now' ? 1 : 0) : a.totals.available,
        reservations: resv, can_fulfil, needs_piece: it.tracking === 'piece' && !it.piece_id, photo: catalog.primaryPhoto(db, it.product_id, it.piece_id) };
    });
    return { ...q, items, total: items.reduce((s, i) => s + i.qty * i.unit_price, 0) };
  }
  api.get('/quotations', need('quote'), wrap(() => db.prepare(`SELECT q.*, (SELECT SUM(qty*unit_price) FROM quotation_items WHERE quotation_id = q.id) AS total,
    (SELECT COUNT(*) FROM quotation_items WHERE quotation_id = q.id) AS items FROM quotations q ORDER BY q.id DESC LIMIT 100`).all()));
  api.post('/quotations', need('quote'), wrap((req) => ({ id: createQuotation(req.body, uid(req)) })));
  api.get('/quotations/:id', need('quote'), wrap((req) => quotationView(Number(req.params.id))));
  api.post('/quotations/:id/items', need('quote'), wrap((req) => {
    const q = db.prepare('SELECT status FROM quotations WHERE id = ?').get(Number(req.params.id));
    if (!q || !['draft', 'sent'].includes(q.status)) throw Object.assign(new Error('Only draft quotations can be changed'), { status: 409 });
    addQuoteItem(Number(req.params.id), req.body); return { ok: true };
  }));
  api.patch('/quotation-items/:id', need('quote'), wrap((req) => {
    const it = db.prepare('SELECT qi.*, q.status FROM quotation_items qi JOIN quotations q ON q.id = qi.quotation_id WHERE qi.id = ?').get(Number(req.params.id));
    if (!it || !['draft', 'sent'].includes(it.status)) throw Object.assign(new Error('Only draft quotations can be changed'), { status: 409 });
    if ('piece_id' in req.body) {
      const pc = req.body.piece_id ? db.prepare('SELECT * FROM pieces WHERE id = ? AND product_id = ?').get(req.body.piece_id, it.product_id) : null;
      if (req.body.piece_id && !pc) throw Object.assign(new Error('Piece does not belong to this product'), { status: 400 });
      db.prepare('UPDATE quotation_items SET piece_id = ?, qty = 1, unit_price = COALESCE(?, unit_price) WHERE id = ?').run(pc ? pc.id : null, pc ? pc.selling_price : null, it.id);
    }
    if ('qty' in req.body && !it.piece_id) db.prepare('UPDATE quotation_items SET qty = ? WHERE id = ?').run(Math.max(1, Number(req.body.qty) || 1), it.id);
    if ('unit_price' in req.body) db.prepare('UPDATE quotation_items SET unit_price = ? WHERE id = ?').run(Math.max(0, Number(req.body.unit_price) || 0), it.id);
    return { ok: true };
  }));
  api.delete('/quotation-items/:id', need('quote'), wrap((req) => {
    const it = db.prepare('SELECT q.status FROM quotation_items qi JOIN quotations q ON q.id = qi.quotation_id WHERE qi.id = ?').get(Number(req.params.id));
    if (!it || !['draft', 'sent'].includes(it.status)) throw Object.assign(new Error('Only draft quotations can be changed'), { status: 409 });
    db.prepare('DELETE FROM quotation_items WHERE id = ?').run(Number(req.params.id)); return { ok: true };
  }));
  api.post('/shortlists/:id/quotation', need('quote'), wrap((req) => {
    const s = db.prepare('SELECT * FROM shortlists WHERE id = ?').get(Number(req.params.id));
    if (!s) throw Object.assign(new Error('Shortlist not found'), { status: 404 });
    const items = db.prepare('SELECT * FROM shortlist_items WHERE shortlist_id = ?').all(s.id);
    if (!items.length) throw Object.assign(new Error('Shortlist is empty'), { status: 400 });
    return { id: createQuotation({ customer_name: s.customer_name, customer_phone: s.customer_phone, shortlist_id: s.id, items }, uid(req)) };
  }));
  /** Confirm as order: re-checks current availability and reserves every line, all or nothing. */
  api.post('/quotations/:id/confirm', need('reserve'), confirmed, wrap((req) => {
    const id = Number(req.params.id);
    return db.transaction(() => {
      const q = quotationView(id);
      if (!['draft', 'sent'].includes(q.status)) throw Object.assign(new Error('Quotation is already ' + q.status), { status: 409 });
      if (!q.items.length) throw Object.assign(new Error('Quotation has no items'), { status: 400 });
      const problems = [];
      for (const it of q.items) {
        if (it.needs_piece) { problems.push(`${it.name}: choose the exact piece`); continue; }
        try {
          inv.reserve(db, { productId: it.product_id, pieceId: it.piece_id, qty: it.qty, customerName: q.customer_name, quotationId: id, userId: uid(req) });
        } catch (e) { problems.push(`${it.name}${it.piece_code ? ` (${it.piece_code})` : ''}: ${e.message}`); }
      }
      if (problems.length) throw Object.assign(new Error(`Cannot confirm — ${problems.join('; ')}`), { status: 409, problems });
      db.prepare("UPDATE quotations SET kind = 'order', status = 'confirmed' WHERE id = ?").run(id);
      return quotationView(id);
    }).immediate();
  }));
  api.post('/quotations/:id/cancel', need('reserve'), confirmed, wrap((req) => {
    const id = Number(req.params.id);
    db.transaction(() => {
      for (const r of db.prepare("SELECT id FROM reservations WHERE quotation_id = ? AND status = 'active'").all(id)) inv.releaseReservation(db, r.id, uid(req), `Order cancelled`);
      db.prepare("UPDATE quotations SET status = 'cancelled' WHERE id = ?").run(id);
    })();
    return quotationView(id);
  }));
  api.post('/quotations/:id/dispatch', need('dispatch'), confirmed, wrap((req) => {
    const id = Number(req.params.id);
    db.transaction(() => {
      const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
      if (!q || q.status !== 'confirmed') throw Object.assign(new Error('Only confirmed orders can be dispatched'), { status: 409 });
      for (const r of db.prepare("SELECT id FROM reservations WHERE quotation_id = ? AND status = 'active'").all(id)) inv.dispatch(db, { reservationId: r.id, reference: q.number, userId: uid(req) });
      db.prepare("UPDATE quotations SET status = 'dispatched' WHERE id = ?").run(id);
    })();
    return quotationView(id);
  }));

  // ---------- Labels ----------
  api.get('/label-templates', need('labels'), wrap(() => db.prepare('SELECT * FROM label_templates ORDER BY id').all()));
  api.post('/label-templates', need('manage_settings'), wrap((req) => {
    const b = req.body;
    const t = { name: String(b.name || '').trim(), layout: b.layout === 'thermal' ? 'thermal' : 'a4', width_mm: +b.width_mm, height_mm: +b.height_mm, cols: +b.cols || null, rows: +b.rows || null,
      margin_top_mm: +b.margin_top_mm || 0, margin_left_mm: +b.margin_left_mm || 0, gap_x_mm: +b.gap_x_mm || 0, gap_y_mm: +b.gap_y_mm || 0, dpi: [203, 300, 600].includes(+b.dpi) ? +b.dpi : 300 };
    if (!t.name || !(t.width_mm > 10 && t.height_mm > 8)) throw Object.assign(new Error('Enter a name and a size of at least 10 × 8 mm'), { status: 400 });
    if (t.layout === 'a4') {
      if (!(t.cols >= 1 && t.rows >= 1)) throw Object.assign(new Error('Enter columns and rows for the sheet'), { status: 400 });
      if (t.margin_left_mm + t.cols * t.width_mm + (t.cols - 1) * t.gap_x_mm > 210.5 || t.margin_top_mm + t.rows * t.height_mm + (t.rows - 1) * t.gap_y_mm > 297.5) throw Object.assign(new Error('These labels do not fit on an A4 sheet'), { status: 400 });
    }
    const r = db.prepare(`INSERT INTO label_templates (name, layout, width_mm, height_mm, cols, rows, margin_top_mm, margin_left_mm, gap_x_mm, gap_y_mm, dpi)
      VALUES (@name, @layout, @width_mm, @height_mm, @cols, @rows, @margin_top_mm, @margin_left_mm, @gap_x_mm, @gap_y_mm, @dpi)`).run(t);
    return { id: Number(r.lastInsertRowid) };
  }));
  function buildLabels(req) {
    const b = req.body;
    const tpl = db.prepare('SELECT * FROM label_templates WHERE id = ?').get(Number(b.template_id));
    if (!tpl) throw Object.assign(new Error('Choose a label size'), { status: 400 });
    tpl.start_at = Math.max(1, Number(b.start_at) || 1);
    const opts = { content: ['barcode', 'qr', 'both'].includes(b.content) ? b.content : 'both', show_price: !!b.show_price, show_specs: !!b.show_specs, show_piece_id: b.show_piece_id !== false, use_mfr: !!b.use_mfr };
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw Object.assign(new Error('Add at least one item'), { status: 400 });
    // Expand "all pieces of product" requests and copies
    const expanded = [];
    for (const it of items) {
      const copies = Math.min(500, Math.max(1, Number(it.copies) || 1));
      if (it.type === 'product_pieces') {
        for (const pc of db.prepare("SELECT id FROM pieces WHERE product_id = ? AND status != 'sold' ORDER BY piece_code").all(Number(it.id))) for (let i = 0; i < copies; i++) expanded.push({ type: 'piece', id: pc.id });
      } else for (let i = 0; i < copies; i++) expanded.push({ type: it.type === 'piece' ? 'piece' : 'product', id: Number(it.id) });
    }
    if (expanded.length > 2000) throw Object.assign(new Error('Too many labels in one batch (max 2000)'), { status: 400 });
    const datas = expanded.map((it) => labels.labelData(db, it, opts, baseUrl(req), businessName()));
    return { tpl, opts, datas };
  }
  api.post('/labels/preview', need('labels'), wrap((req) => {
    const { tpl, opts, datas } = buildLabels(req);
    const seen = new Map();
    for (const d of datas) if (!seen.has(d.barcode)) seen.set(d.barcode, { ...d, checks: labels.layoutLabel(d, tpl, opts).checks });
    const perPage = tpl.layout === 'a4' ? tpl.cols * tpl.rows : 1;
    return { count: datas.length, pages: Math.ceil((datas.length + tpl.start_at - 1) / perPage), labels: [...seen.values()] };
  }));
  api.post('/labels/pdf', need('labels'), wrap(async (req, res) => {
    const { tpl, opts, datas } = buildLabels(req);
    const pdf = await labels.renderPdf(datas.map((d) => labels.layoutLabel(d, tpl, opts)), tpl, { outline: !!req.body.outline });
    res.type('application/pdf').set('Content-Disposition', `inline; filename="labels-${Date.now()}.pdf"`).send(pdf);
  }));
  api.post('/labels/zpl', need('labels'), wrap((req, res) => {
    const { tpl, opts, datas } = buildLabels(req);
    res.type('text/plain').set('Content-Disposition', `attachment; filename="labels-${Date.now()}.zpl"`).send(labels.renderZpl(datas, tpl, opts));
  }));

  // ---------- Settings ----------
  const SETTING_KEYS = ['business_name', 'public_pages_enabled', 'public_show_prices', 'public_show_expected_date', 'public_base_url', 'showroom_contact', 'availability_wording', 'currency'];
  api.get('/settings', need('view'), wrap(() => {
    const s = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
    return { ...s, availability_wording: pub.settings(db).wording };
  }));
  api.put('/settings', need('manage_settings'), wrap((req) => {
    for (const k of SETTING_KEYS) {
      if (!(k in req.body)) continue;
      let v = req.body[k];
      if (k === 'availability_wording') v = JSON.stringify(Object.fromEntries(Object.entries(v || {}).filter(([kk]) => kk in pub.DEFAULT_WORDING).map(([kk, vv]) => [kk, String(vv).slice(0, 120)])));
      if (typeof v === 'boolean') v = v ? '1' : '0';
      if (k === 'public_base_url' && v && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v)) throw Object.assign(new Error('Public base URL must start with http:// or https://'), { status: 400 });
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v ?? ''));
    }
    return { ok: true };
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

module.exports = { createApp, hashPassword, verifyPassword, ROLE_PERMS };
