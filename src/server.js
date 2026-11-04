'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const inv = require('./inventory');
const catalog = require('./catalog');
const pub = require('./public');
const labels = require('./labels');
const storage = require('./storage');
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
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------------- App ----------------
function createApp({ db, uploadDir = path.join(__dirname, '..', 'data', 'uploads'), publicBaseUrl, serveStatic = true, ready } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // First-run setup (tables, bucket, admin login) before any dynamic request.
  if (ready) {
    app.use(['/api', '/p/', '/c/'], async (req, res, next) => {
      try { await ready(); next(); } catch (e) {
        console.error(e.message);
        res.status(503).json({ error: e.status === 503 ? e.message : 'The app is starting up — please try again in a moment' });
      }
    });
  }
  app.set('trust proxy', process.env.NETLIFY || process.env.TRUST_PROXY ? true : 'loopback');

  const baseUrl = async (req) => {
    const s = await db.one("SELECT value FROM settings WHERE key = 'public_base_url'");
    return (publicBaseUrl || (s && s.value) || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  };
  const businessName = async () => (await pub.settings(db)).business_name;

  // Express 4 does not catch rejected promises: route every handler through this.
  const wrap = (fn) => async (req, res, next) => {
    try {
      const out = await fn(req, res, next);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) { sendErr(res, e); }
  };
  function sendErr(res, e) {
    const dupRes = e.code === '23505' && /ux_res_piece_active/.test(e.constraint || e.message);
    // 23xxx = constraint violations; 22xxx = bad input such as a non-numeric id
    const badInput = /^22/.test(e.code || '');
    const status = dupRes ? 409 : e.status || (e.code === '23505' ? 409 : /^23/.test(e.code || '') || badInput ? 400 : 500);
    if (status === 500) console.error(e);
    if (res.headersSent) return;
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : dupRes ? 'This piece has just been reserved by someone else' : badInput ? 'Invalid request' : e.message });
  }

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  // ================= PUBLIC (no login) =================
  // Only these routes are reachable without a session, and they only use the
  // whitelisting functions in public.js — never the internal inventory API.
  const publicCsp = "default-src 'self'; img-src 'self' https://i.ytimg.com https://*.supabase.co data:; frame-src https://www.youtube-nocookie.com; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'";
  const publicRouter = express.Router();
  const publicHeaders = (req, res, next) => { res.set('Content-Security-Policy', publicCsp); res.set('Cache-Control', 'no-store'); next(); };
  publicRouter.use(['/p/', '/c/', '/api/public/'], publicHeaders);
  publicRouter.get('/p/:token', wrap(async (req, res) => {
    const d = await pub.publicItem(db, req.params.token);
    if (!d) return void res.status(404).type('html').send(pub.renderNotAvailable(await businessName()));
    res.type('html').send(pub.renderItemPage(d, req.params.token));
  }));
  publicRouter.get('/c/:token', wrap(async (req, res) => {
    const d = await pub.publicCatalogue(db, req.params.token);
    if (!d) return void res.status(404).type('html').send(pub.renderNotAvailable(await businessName()));
    res.type('html').send(pub.renderCataloguePage(d));
  }));
  publicRouter.get('/api/public/p/:token', wrap(async (req) => {
    const d = await pub.publicItem(db, req.params.token);
    if (!d) throw fail('Not available', 404);
    return d;
  }));
  publicRouter.get('/api/public/c/:token', wrap(async (req) => {
    const d = await pub.publicCatalogue(db, req.params.token);
    if (!d) throw fail('Not available', 404);
    return d;
  }));
  const hits = new Map();
  publicRouter.post('/api/public/p/:token/enquiry', express.json({ limit: '4kb' }), wrap(async (req) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter((t) => now - t < 10 * 60e3);
    if (list.length >= 5) throw fail('Too many requests — please ask showroom staff', 429);
    list.push(now); hits.set(req.ip, list);
    if (!await pub.publicItem(db, req.params.token)) throw fail('Not available', 404);
    const piece = await db.one('SELECT id, product_id FROM pieces WHERE public_token = $1', [req.params.token]);
    const productId = piece ? piece.product_id : (await db.one('SELECT id FROM products WHERE public_token = $1', [req.params.token])).id;
    // Serverless instances do not share memory, so also cap enquiries per item in the database.
    const recent = await db.one("SELECT COUNT(*)::int n FROM enquiries WHERE source = 'public_qr' AND product_id = $1 AND created_at > now() - interval '10 minutes'", [productId]);
    if (recent.n >= 20) throw fail('Too many requests — please ask showroom staff', 429);
    const name = String(req.body.name || '').trim().slice(0, 80);
    const phone = String(req.body.phone || '').trim().slice(0, 20);
    if (!name || !/^[+\d][\d\s-]{6,19}$/.test(phone)) throw fail('Please enter your name and a valid phone number');
    await db.query("INSERT INTO enquiries (product_id, piece_id, source, customer_name, customer_phone, message) VALUES ($1, $2, 'public_qr', $3, $4, $5)",
      [productId, piece ? piece.id : null, name, phone, String(req.body.message || '').slice(0, 500)]);
    return { ok: true };
  }));
  app.use(publicRouter);

  // ================= STAFF =================
  if (serveStatic) {
    app.use('/vendor/html5-qrcode.min.js', (req, res) => res.sendFile(path.join(path.dirname(require.resolve('html5-qrcode/package.json')), 'html5-qrcode.min.js')));
    app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));
    app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
  }

  const api = express.Router();
  api.use(express.json({ limit: '5mb' }));
  // JSON-only mutations (blocks cross-site form posts)
  api.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON body required' });
    next();
  });

  const MAX_FAILURES = 8;   // per username per 15 minutes
  api.post('/login', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase().slice(0, 60);
    const { n } = await db.one("SELECT COUNT(*)::int n FROM login_failures WHERE username = $1 AND ts > now() - interval '15 minutes'", [username]);
    if (n >= MAX_FAILURES) throw fail('Too many wrong passwords — wait 15 minutes or ask an admin to reset it', 429);
    const u = await db.one('SELECT * FROM users WHERE username = $1 AND active = 1', [username]);
    if (!u || !verifyPassword(req.body.password || '', u.pass_hash)) {
      await db.query('INSERT INTO login_failures (username) VALUES ($1)', [username]);
      if (Math.random() < 0.05) await db.query("DELETE FROM login_failures WHERE ts < now() - interval '1 day'");
      throw fail('Wrong username or password', 401);
    }
    await db.query('DELETE FROM login_failures WHERE username = $1', [username]);
    const token = crypto.randomBytes(24).toString('base64url');
    await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, u.id, Date.now() + 12 * 3600e3]);
    if (Math.random() < 0.05) await db.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
    res.set('Set-Cookie', `ahs=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}${req.secure ? '; Secure' : ''}`);
    return { id: u.id, name: u.name, role: u.role, permissions: permsOf(u) };
  }));

  api.use(wrap(async (req, res, next) => {
    const token = parseCookies(req).ahs;
    const s = token && await db.one('SELECT u.id, u.name, u.role, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > $2 AND u.active = 1', [token, Date.now()]);
    if (!s) throw fail('Please sign in', 401);
    req.user = s; req.sessionToken = token;
    next();
  }));
  const need = (perm) => (req, res, next) => (can(req.user, perm) ? next() : res.status(403).json({ error: 'You do not have permission for this action' }));
  // Inventory movements must be explicitly confirmed; a scan alone never moves stock.
  const confirmed = (req, res, next) => (req.body && req.body.confirm === true ? next() : res.status(400).json({ error: 'Stock changes need explicit confirmation', needs_confirmation: true }));

  api.post('/logout', wrap(async (req, res) => {
    await db.query('DELETE FROM sessions WHERE token = $1', [req.sessionToken]);
    res.set('Set-Cookie', 'ahs=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  }));
  api.get('/me', wrap(async (req) => ({ ...req.user, permissions: permsOf(req.user), business_name: await businessName() })));
  api.get('/locations', need('view'), wrap(() => db.query('SELECT * FROM locations ORDER BY type, name')));

  // ---------- Staff users & passwords ----------
  const MIN_PW = 10;
  const checkPw = (pw) => { if (String(pw || '').length < MIN_PW) throw fail(`Password must be at least ${MIN_PW} characters`); };
  const USER_COLS = 'id, username, name, role, active';
  api.post('/me/password', wrap(async (req) => {
    const u = await db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!verifyPassword(req.body.current_password || '', u.pass_hash)) throw fail('Current password is wrong', 403);
    checkPw(req.body.new_password);
    await db.query('UPDATE users SET pass_hash = $1 WHERE id = $2', [hashPassword(req.body.new_password), u.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [u.id, req.sessionToken]);   // sign out other devices
    return { ok: true };
  }));
  api.get('/users', need('manage_users'), wrap(() => db.query(`SELECT ${USER_COLS} FROM users ORDER BY active DESC, role, name`)));
  api.post('/users', need('manage_users'), wrap(async (req) => {
    const x = req.body;
    const username = String(x.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw fail('Username: 3–40 letters, numbers, dots, dashes or underscores');
    if (!ROLE_PERMS[x.role]) throw fail('Choose a role');
    if (!String(x.name || '').trim()) throw fail('Enter the person\'s name');
    checkPw(x.password);
    if (await db.one('SELECT id FROM users WHERE username = $1', [username])) throw fail('That username is taken', 409);
    return db.one(`INSERT INTO users (username, name, role, pass_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLS}`, [username, String(x.name).trim().slice(0, 80), x.role, hashPassword(x.password)]);
  }));
  api.patch('/users/:id', need('manage_users'), wrap(async (req) => {
    const id = Number(req.params.id), x = req.body;
    const u = await db.one('SELECT * FROM users WHERE id = $1', [id]);
    if (!u) throw fail('User not found', 404);
    const demoting = ('role' in x && x.role !== 'admin') || ('active' in x && !x.active);
    if (u.role === 'admin' && demoting) {
      const { n } = await db.one("SELECT COUNT(*)::int n FROM users WHERE role = 'admin' AND active = 1 AND id != $1", [id]);
      if (!n) throw fail('Keep at least one active admin');
    }
    if ('role' in x) { if (!ROLE_PERMS[x.role]) throw fail('Choose a role'); await db.query('UPDATE users SET role = $1 WHERE id = $2', [x.role, id]); }
    if ('name' in x && String(x.name).trim()) await db.query('UPDATE users SET name = $1 WHERE id = $2', [String(x.name).trim().slice(0, 80), id]);
    if ('active' in x) await db.query('UPDATE users SET active = $1 WHERE id = $2', [x.active ? 1 : 0, id]);
    if ('password' in x) { checkPw(x.password); await db.query('UPDATE users SET pass_hash = $1 WHERE id = $2', [hashPassword(x.password), id]); await db.query('DELETE FROM login_failures WHERE username = $1', [u.username]); }
    // role, deactivation or password reset signs the person out everywhere
    if ('role' in x || 'active' in x || 'password' in x) await db.query('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [id, req.sessionToken]);
    return db.one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  }));

  // ---------- Locations ----------
  const LOC_TYPES = ['showroom', 'warehouse', 'branch'];
  api.post('/locations', need('manage_settings'), wrap(async (req) => {
    const x = req.body;
    const code = String(x.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,10}$/.test(code)) throw fail('Code: 2–10 letters or numbers');
    if (!String(x.name || '').trim()) throw fail('Enter a name');
    if (!LOC_TYPES.includes(x.type)) throw fail('Choose showroom, warehouse or branch');
    return db.one('INSERT INTO locations (code, name, type) VALUES ($1, $2, $3) RETURNING *', [code, String(x.name).trim().slice(0, 80), x.type]);
  }));
  api.patch('/locations/:id', need('manage_settings'), wrap(async (req) => {
    const x = req.body, id = Number(req.params.id);
    if ('name' in x && String(x.name).trim()) await db.query('UPDATE locations SET name = $1 WHERE id = $2', [String(x.name).trim().slice(0, 80), id]);
    if ('type' in x) { if (!LOC_TYPES.includes(x.type)) throw fail('Choose showroom, warehouse or branch'); await db.query('UPDATE locations SET type = $1 WHERE id = $2', [x.type, id]); }
    return db.one('SELECT * FROM locations WHERE id = $1', [id]);
  }));

  // ---------- Finder ----------
  api.get('/search', need('view'), wrap((req) => catalog.search(db, req.query)));
  api.get('/facets', need('view'), wrap(() => catalog.facets(db)));

  /** Scan resolution: read-only. Returns what was scanned and which actions this user may take. */
  api.get('/scan', need('view'), wrap(async (req) => {
    const r = await catalog.resolveCode(db, req.query.code);
    if (!r) throw fail(`No product or piece found for "${String(req.query.code || '').slice(0, 60)}"`, 404);
    const product = await db.one('SELECT tracking FROM products WHERE id = $1', [r.product_id]);
    const actions = ['view', 'quote', 'reserve', 'receive', 'transfer', 'dispatch', 'count'].filter((a) => can(req.user, a));
    return { ...r, tracking: product.tracking, actions };
  }));

  api.get('/products/:id', need('view'), wrap(async (req) => {
    const d = await catalog.productDetail(db, Number(req.params.id), { includeCost: can(req.user, 'view_cost') });
    if (!d) throw fail('Product not found', 404);
    return d;
  }));
  api.get('/pieces/:id', need('view'), wrap(async (req) => {
    const d = await catalog.pieceDetail(db, Number(req.params.id), { includeCost: can(req.user, 'view_cost') });
    if (!d) throw fail('Piece not found', 404);
    return d;
  }));
  api.get('/products/:id/alternatives', need('view'), wrap((req) => catalog.alternatives(db, Number(req.params.id), 8)));

  // ---------- Product admin ----------
  const PRODUCT_FIELDS = ['sku', 'parent_id', 'variant_label', 'name', 'category', 'material', 'finish', 'length_cm', 'width_cm', 'height_cm', 'description', 'care', 'short_specs',
    'selling_price', 'cost_price', 'vendor', 'internal_notes', 'tracking', 'made_to_order', 'lead_time_days', 'mfr_barcode', 'public_enabled', 'public_show_price', 'active'];
  async function cleanProduct(body, existing) {
    const out = {};
    for (const k of PRODUCT_FIELDS) if (k in body) out[k] = body[k] === '' ? null : body[k];
    for (const k of ['made_to_order', 'public_enabled', 'public_show_price', 'active']) if (k in out) out[k] = out[k] ? 1 : 0;
    if ('tracking' in out && !['sku', 'piece'].includes(out.tracking)) throw fail('Unknown tracking type');
    if ('mfr_barcode' in out) {
      out.mfr_barcode = normaliseMfrBarcode(out.mfr_barcode);
      await assertCodeFree(db, out.mfr_barcode, existing ? { type: 'product', id: existing.id } : {});
    }
    if ('sku' in out) {
      out.sku = String(out.sku || '').trim().toUpperCase();
      if (!out.sku) throw fail('SKU is required');
      if (await db.one('SELECT id FROM products WHERE sku = $1 AND id != $2', [out.sku, existing ? existing.id : -1])) throw fail('SKU already exists', 409);
    }
    if (existing && 'tracking' in out && out.tracking !== existing.tracking) {
      const has = await db.one('SELECT (SELECT COUNT(*) FROM stock_balances WHERE product_id = $1 AND qty > 0) + (SELECT COUNT(*) FROM pieces WHERE product_id = $1) AS n', [existing.id]);
      if (has.n) throw fail('Tracking type cannot change once stock exists', 409);
    }
    return out;
  }
  const insertSql = (table, data) => {
    const keys = Object.keys(data);
    return [`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, keys.map((k) => data[k])];
  };
  const updateSql = (table, data, id) => {
    const keys = Object.keys(data);
    return [`UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map((k) => data[k]), id]];
  };

  api.post('/products', need('manage_products'), wrap(async (req) => {
    const data = await cleanProduct(req.body);
    if (!data.name) throw fail('Name is required');
    if (!data.sku) throw fail('SKU is required');
    data.internal_code = await nextCode(db, 'AHP');
    data.public_token = newToken();
    data.tracking = data.tracking || 'sku';
    const r = await db.one(...insertSql('products', data));
    return { id: r.id, internal_code: data.internal_code };
  }));
  api.put('/products/:id', need('manage_products'), wrap(async (req) => {
    const existing = await db.one('SELECT * FROM products WHERE id = $1', [Number(req.params.id)]);
    if (!existing) throw fail('Product not found', 404);
    // internal_code and public_token are deliberately not editable: labels stay valid.
    const data = await cleanProduct(req.body, existing);
    if (!Object.keys(data).length) return { ok: true };
    data.updated_at = new Date();
    await db.query(...updateSql('products', data, existing.id));
    return { ok: true };
  }));
  api.put('/pieces/:id', need('manage_products'), wrap(async (req) => {
    const pc = await db.one('SELECT * FROM pieces WHERE id = $1', [Number(req.params.id)]);
    if (!pc) throw fail('Piece not found', 404);
    const data = {};
    for (const k of ['condition', 'finish_note', 'selling_price', 'cost_price', 'notes', 'mfr_barcode', 'public_enabled', 'rack']) if (k in req.body) data[k] = req.body[k] === '' ? null : req.body[k];
    if ('public_enabled' in data) data.public_enabled = data.public_enabled ? 1 : 0;
    if ('mfr_barcode' in data) { data.mfr_barcode = normaliseMfrBarcode(data.mfr_barcode); await assertCodeFree(db, data.mfr_barcode, { type: 'piece', id: pc.id }); }
    if (Object.keys(data).length) await db.query(...updateSql('pieces', data, pc.id));
    return { ok: true };
  }));
  api.get('/barcode-check', need('view'), wrap(async (req) => {
    try {
      const code = normaliseMfrBarcode(req.query.code);
      await assertCodeFree(db, code, req.query.type ? { type: req.query.type, id: Number(req.query.id) } : {});
      return { ok: true, code };
    } catch (e) { return { ok: false, error: e.message }; }
  }));

  // Photos: URL or uploaded data URL (jpeg/png/webp, max 3.5 MB — the app resizes before upload)
  api.post('/photos', need('manage_products'), wrap(async (req) => {
    const { product_id, piece_id, url, data_url, caption, is_public = true } = req.body;
    if (!await db.one('SELECT id FROM products WHERE id = $1', [product_id])) throw fail('Product not found', 404);
    let finalUrl = url, storagePath = null;
    if (data_url) {
      const m = String(data_url).match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw fail('Photo must be a JPEG, PNG or WebP image');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 3.5e6) throw fail('Photo is larger than 3.5 MB');
      ({ url: finalUrl, storage_path: storagePath } = await storage.savePhoto(buf, m[1] === 'jpeg' ? 'jpg' : m[1], { uploadDir }));
    } else if (!/^(https:\/\/|\/)/.test(String(url || ''))) {
      throw fail('Photo URL must start with https://');
    }
    const sort = (await db.one('SELECT COALESCE(MAX(sort),0)+1 AS s FROM photos WHERE product_id = $1', [product_id])).s;
    const r = await db.one('INSERT INTO photos (product_id, piece_id, url, storage_path, caption, is_public, sort) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [product_id, piece_id || null, finalUrl, storagePath, caption || null, is_public ? 1 : 0, sort]);
    return { id: r.id, url: finalUrl };
  }));
  api.patch('/photos/:id', need('manage_products'), wrap(async (req) => {
    if ('is_public' in req.body) await db.query('UPDATE photos SET is_public = $1 WHERE id = $2', [req.body.is_public ? 1 : 0, Number(req.params.id)]);
    if ('caption' in req.body) await db.query('UPDATE photos SET caption = $1 WHERE id = $2', [req.body.caption || null, Number(req.params.id)]);
    return { ok: true };
  }));
  api.delete('/photos/:id', need('manage_products'), wrap(async (req) => {
    const ph = await db.one('DELETE FROM photos WHERE id = $1 RETURNING storage_path', [Number(req.params.id)]);
    if (ph) await storage.deletePhoto(ph.storage_path);
    return { ok: true };
  }));

  // ---------- Videos ----------
  const VIDEO_TYPES = ['overview', 'dimensions', 'finish', 'demonstration', 'installation', 'care'];
  async function cleanVideo(body, existing = {}) {
    const v = { ...existing, ...body };
    const id = parseYouTube(v.url);
    if (!id) throw fail('Enter a YouTube video link (youtube.com/watch?v=…, youtu.be/…, /shorts/… or /embed/…)');
    if (!VIDEO_TYPES.includes(v.video_type)) throw fail('Choose a video type');
    if (!String(v.title || '').trim()) throw fail('Title is required');
    if (v.piece_id) {
      const pc = await db.one('SELECT product_id FROM pieces WHERE id = $1', [v.piece_id]);
      if (!pc || pc.product_id !== Number(v.product_id)) throw fail('Piece does not belong to this product');
    }
    return {
      product_id: Number(v.product_id), piece_id: v.piece_id ? Number(v.piece_id) : null, title: String(v.title).trim().slice(0, 200),
      url: String(v.url).trim(), youtube_id: id, video_type: v.video_type, is_primary: v.is_primary ? 1 : 0,
      visibility: v.visibility === 'internal' ? 'internal' : 'customer', overrides_parent: v.overrides_parent ? 1 : 0,
      embed_status: existing.youtube_id === id ? existing.embed_status : 'unchecked',
    };
  }
  async function clearOtherPrimaries(t, v, id) {
    if (v.is_primary) await t.query('UPDATE videos SET is_primary = 0 WHERE product_id = $1 AND COALESCE(piece_id,0) = $2 AND id != $3', [v.product_id, v.piece_id || 0, id]);
  }
  api.get('/videos', need('view'), wrap((req) => catalog.videosFor(db, { productId: Number(req.query.product_id), pieceId: req.query.piece_id ? Number(req.query.piece_id) : null })));
  api.get('/videos/own', need('view'), wrap((req) => db.query('SELECT * FROM videos WHERE product_id = $1 ORDER BY piece_id NULLS FIRST, is_primary DESC, id', [Number(req.query.product_id)])));
  api.post('/videos', need('manage_products'), wrap(async (req) => {
    const v = await cleanVideo(req.body);
    return db.tx(async (t) => {
      const r = await t.one(...insertSql('videos', v));
      await clearOtherPrimaries(t, v, r.id);
      return { id: r.id, youtube_id: v.youtube_id };
    });
  }));
  api.put('/videos/:id', need('manage_products'), wrap(async (req) => {
    const existing = await db.one('SELECT * FROM videos WHERE id = $1', [Number(req.params.id)]);
    if (!existing) throw fail('Video not found', 404);
    const v = await cleanVideo(req.body, existing);
    return db.tx(async (t) => {
      await t.query(...updateSql('videos', v, existing.id));
      await clearOtherPrimaries(t, v, existing.id);
      return { ok: true };
    });
  }));
  api.delete('/videos/:id', need('manage_products'), wrap(async (req) => { await db.query('DELETE FROM videos WHERE id = $1', [Number(req.params.id)]); return { ok: true }; }));
  // Check availability with YouTube oEmbed: 401 = private/embedding disabled, 404 = removed.
  api.post('/videos/:id/check', need('view'), wrap(async (req) => {
    const v = await db.one('SELECT * FROM videos WHERE id = $1', [Number(req.params.id)]);
    if (!v) throw fail('Video not found', 404);
    let status;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${v.youtube_id}`)}`, { signal: AbortSignal.timeout(6000) });
      status = r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'embed_disabled' : r.status === 404 || r.status === 400 ? 'unavailable' : null;
    } catch { status = null; }
    if (!status) return { embed_status: v.embed_status, error: 'Could not reach YouTube right now' };
    await db.query('UPDATE videos SET embed_status = $1, checked_at = now() WHERE id = $2', [status, v.id]);
    return { embed_status: status };
  }));
  // The staff player reports YouTube errors (100 = removed/private, 101/150 = embedding disabled).
  api.post('/videos/:id/player-error', need('view'), wrap(async (req) => {
    const code = Number(req.body.code);
    const status = code === 100 ? 'unavailable' : (code === 101 || code === 150) ? 'embed_disabled' : null;
    if (status) await db.query('UPDATE videos SET embed_status = $1, checked_at = now() WHERE id = $2', [status, Number(req.params.id)]);
    return { embed_status: status };
  }));

  // ---------- Stock movements (explicit + confirmed) ----------
  const uid = (req) => req.user.id;
  const b = (req) => req.body;
  api.post('/stock/reserve', need('reserve'), confirmed, wrap(async (req) => ({ reservation_id: await inv.reserve(db, { productId: b(req).product_id, pieceId: b(req).piece_id, locationId: b(req).location_id, qty: b(req).qty, customerName: b(req).customer_name, quotationId: b(req).quotation_id, userId: uid(req) }) })));
  api.post('/stock/release', need('reserve'), confirmed, wrap(async (req) => { await inv.releaseReservation(db, b(req).reservation_id, uid(req), b(req).reason || 'cancelled'); return { ok: true }; }));
  api.post('/stock/receive', need('receive'), confirmed, wrap((req) => inv.receive(db, { productId: b(req).product_id, locationId: b(req).location_id, rack: b(req).rack, qty: b(req).qty, condition: b(req).condition, pieces: b(req).pieces, incomingId: b(req).incoming_id, reference: b(req).reference, userId: uid(req) })));
  api.post('/stock/transfer', need('transfer'), confirmed, wrap(async (req) => { await inv.transfer(db, { productId: b(req).product_id, pieceId: b(req).piece_id, fromLocationId: b(req).from_location_id, toLocationId: b(req).to_location_id, qty: b(req).qty, condition: b(req).condition, rack: b(req).rack, reference: b(req).reference, userId: uid(req) }); return { ok: true }; }));
  api.post('/stock/dispatch', need('dispatch'), confirmed, wrap(async (req) => { await inv.dispatch(db, { productId: b(req).product_id, pieceId: b(req).piece_id, locationId: b(req).location_id, qty: b(req).qty, reservationId: b(req).reservation_id, reference: b(req).reference, userId: uid(req) }); return { ok: true }; }));
  api.post('/stock/count', need('count'), confirmed, wrap((req) => inv.count(db, { productId: b(req).product_id, pieceId: b(req).piece_id, locationId: b(req).location_id, condition: b(req).condition, countedQty: b(req).counted_qty, rack: b(req).rack, note: b(req).note, userId: uid(req) })));
  api.post('/stock/condition', need('adjust'), confirmed, wrap(async (req) => { await inv.changeCondition(db, { productId: b(req).product_id, pieceId: b(req).piece_id, locationId: b(req).location_id, fromCondition: b(req).from_condition, toCondition: b(req).to_condition, qty: b(req).qty, note: b(req).note, userId: uid(req) }); return { ok: true }; }));
  api.post('/stock/return', need('return'), confirmed, wrap(async (req) => { await inv.returnInspected(db, { productId: b(req).product_id, pieceId: b(req).piece_id, locationId: b(req).location_id, qty: b(req).qty, result: b(req).result, rack: b(req).rack, reference: b(req).reference, note: b(req).note, userId: uid(req) }); return { ok: true }; }));
  api.get('/ledger', need('view'), wrap((req) => db.query(`SELECT sl.*, p.name AS product, p.sku, pc.piece_code, fl.name AS from_loc, tl.name AS to_loc, u.name AS by_name
    FROM stock_ledger sl JOIN products p ON p.id = sl.product_id LEFT JOIN pieces pc ON pc.id = sl.piece_id LEFT JOIN locations fl ON fl.id = sl.from_location_id
    LEFT JOIN locations tl ON tl.id = sl.to_location_id LEFT JOIN users u ON u.id = sl.user_id
    WHERE ($1::int IS NULL OR sl.product_id = $1) AND ($2::int IS NULL OR sl.piece_id = $2) ORDER BY sl.id DESC LIMIT 300`,
  [req.query.product_id ? Number(req.query.product_id) : null, req.query.piece_id ? Number(req.query.piece_id) : null])));

  // ---------- Enquiries and purchase / production requests ----------
  api.post('/enquiries', need('enquiry'), wrap(async (req) => {
    const x = req.body;
    if (!x.product_id) throw fail('Product is required');
    const r = await db.one("INSERT INTO enquiries (product_id, piece_id, source, customer_name, customer_phone, message, created_by) VALUES ($1, $2, 'staff', $3, $4, $5, $6) RETURNING id",
      [x.product_id, x.piece_id || null, x.customer_name || null, x.customer_phone || null, x.message || null, uid(req)]);
    return { id: r.id };
  }));
  api.get('/enquiries', need('enquiry'), wrap(() => db.query(`SELECT e.*, p.name AS product, p.sku, pc.piece_code, u.name AS by_name FROM enquiries e
    LEFT JOIN products p ON p.id = e.product_id LEFT JOIN pieces pc ON pc.id = e.piece_id LEFT JOIN users u ON u.id = e.created_by ORDER BY e.status, e.id DESC LIMIT 200`)));
  api.patch('/enquiries/:id', need('enquiry'), wrap(async (req) => { await db.query('UPDATE enquiries SET status = $1 WHERE id = $2', [req.body.status === 'closed' ? 'closed' : 'open', Number(req.params.id)]); return { ok: true }; }));
  api.post('/incoming', need('quote'), wrap(async (req) => {
    const x = req.body;
    if (!['purchase', 'production'].includes(x.kind)) throw fail('Choose purchase or production');
    const r = await db.one('INSERT INTO incoming (product_id, kind, qty, expected_date, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [x.product_id, x.kind, Math.max(1, Number(x.qty) || 1), x.expected_date || null, x.note || null, uid(req)]);
    return { id: r.id };
  }));
  api.get('/incoming', need('view'), wrap(() => db.query("SELECT i.*, p.name AS product, p.sku FROM incoming i JOIN products p ON p.id = i.product_id WHERE i.status IN ('requested','ordered') ORDER BY expected_date")));
  api.patch('/incoming/:id', need('manage_products'), wrap(async (req) => {
    await db.query('UPDATE incoming SET status = COALESCE($1, status), expected_date = COALESCE($2::date, expected_date) WHERE id = $3', [req.body.status || null, req.body.expected_date || null, Number(req.params.id)]);
    return { ok: true };
  }));

  // ---------- Shortlists (never reserve stock) ----------
  async function shortlistItems(id) {
    const rows = await db.query(`SELECT si.*, p.name, p.sku, p.variant_label, p.material, p.finish, p.length_cm, p.width_cm, p.height_cm, p.selling_price, p.tracking,
      pc.piece_code, pc.selling_price AS piece_price FROM shortlist_items si JOIN products p ON p.id = si.product_id LEFT JOIN pieces pc ON pc.id = si.piece_id WHERE si.shortlist_id = $1 ORDER BY si.id`, [id]);
    return Promise.all(rows.map(async (it) => {
      const a = await inv.productAvailability(db, it.product_id);
      const pieceRow = it.piece_id && await db.one('SELECT * FROM pieces WHERE id = $1', [it.piece_id]);
      const status = pieceRow ? inv.pieceStatus(pieceRow) : a.status;
      return { ...it, dimensions: catalog.dims(it), price: it.piece_price ?? it.selling_price, photo: await catalog.primaryPhoto(db, it.product_id, it.piece_id),
        status, status_label: catalog.STATUS_LABEL[status], available: pieceRow ? (status === 'available_now' ? 1 : 0) : a.totals.available };
    }));
  }
  api.get('/shortlists', need('quote'), wrap(() => db.query(`SELECT s.*, u.name AS by_name, (SELECT COUNT(*) FROM shortlist_items WHERE shortlist_id = s.id) AS items
    FROM shortlists s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC LIMIT 100`)));
  api.post('/shortlists', need('quote'), wrap(async (req) => {
    const r = await db.one('INSERT INTO shortlists (customer_name, customer_phone, share_token, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [req.body.customer_name || null, req.body.customer_phone || null, newToken(), uid(req)]);
    return { id: r.id };
  }));
  api.get('/shortlists/:id', need('quote'), wrap(async (req) => {
    const s = await db.one('SELECT * FROM shortlists WHERE id = $1', [Number(req.params.id)]);
    if (!s) throw fail('Shortlist not found', 404);
    return { ...s, share_url: `${await baseUrl(req)}/c/${s.share_token}`, items: await shortlistItems(s.id) };
  }));
  api.patch('/shortlists/:id', need('quote'), wrap(async (req) => {
    const x = req.body, id = Number(req.params.id);
    for (const k of ['customer_name', 'customer_phone']) if (k in x) await db.query(`UPDATE shortlists SET ${k} = $1 WHERE id = $2`, [x[k] || null, id]);
    for (const k of ['share_enabled', 'share_show_prices']) if (k in x) await db.query(`UPDATE shortlists SET ${k} = $1 WHERE id = $2`, [x[k] ? 1 : 0, id]);
    return { ok: true };
  }));
  api.post('/shortlists/:id/items', need('quote'), wrap(async (req) => {
    const x = req.body;
    let productId = x.product_id, pieceId = x.piece_id || null;
    if (x.code) {
      const r = await catalog.resolveCode(db, x.code);
      if (!r) throw fail('Code not recognised', 404);
      productId = r.product_id; pieceId = r.piece_id || null;
    }
    if (!await db.one('SELECT id FROM products WHERE id = $1', [productId])) throw fail('Product not found', 404);
    const r = await db.one('INSERT INTO shortlist_items (shortlist_id, product_id, piece_id, qty, pref_finish, pref_dimensions, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [Number(req.params.id), productId, pieceId, Math.max(1, Number(x.qty) || 1), x.pref_finish || null, x.pref_dimensions || null, x.note || null]);
    return { id: r.id };
  }));
  api.put('/shortlist-items/:id', need('quote'), wrap(async (req) => {
    const x = req.body;
    await db.query('UPDATE shortlist_items SET qty = COALESCE($1, qty), pref_finish = $2, pref_dimensions = $3, note = $4 WHERE id = $5',
      [x.qty ? Math.max(1, Number(x.qty)) : null, x.pref_finish || null, x.pref_dimensions || null, x.note || null, Number(req.params.id)]);
    return { ok: true };
  }));
  api.delete('/shortlist-items/:id', need('quote'), wrap(async (req) => { await db.query('DELETE FROM shortlist_items WHERE id = $1', [Number(req.params.id)]); return { ok: true }; }));

  // ---------- Quotations / orders ----------
  async function newQuoteNumber(t) {
    return (await nextCode(t, `Q${new Date().getFullYear()}`)).replace(/-0+(\d{4,})$/, '-$1');
  }
  async function addQuoteItem(t, qid, it) {
    const p = await t.one('SELECT * FROM products WHERE id = $1', [it.product_id]);
    if (!p) throw fail('Product not found', 404);
    const pc = it.piece_id ? await t.one('SELECT * FROM pieces WHERE id = $1 AND product_id = $2', [it.piece_id, p.id]) : null;
    if (it.piece_id && !pc) throw fail('Piece does not belong to this product');
    const price = it.unit_price != null && it.unit_price !== '' ? Number(it.unit_price) : (pc ? pc.selling_price ?? p.selling_price : p.selling_price);
    await t.query('INSERT INTO quotation_items (quotation_id, product_id, piece_id, qty, unit_price, pref_finish, pref_dimensions, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [qid, p.id, pc ? pc.id : null, pc ? 1 : Math.max(1, Number(it.qty) || 1), price || 0, it.pref_finish || null, it.pref_dimensions || null, it.note || null]);
  }
  function createQuotation({ customer_name, customer_phone, shortlist_id, items = [] }, userId) {
    return db.tx(async (t) => {
      const r = await t.one('INSERT INTO quotations (number, customer_name, customer_phone, shortlist_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [await newQuoteNumber(t), customer_name || null, customer_phone || null, shortlist_id || null, userId]);
      for (const it of items) await addQuoteItem(t, r.id, it);
      return r.id;
    });
  }
  async function quotationView(t, id) {
    const q = await t.one('SELECT q.*, u.name AS by_name FROM quotations q LEFT JOIN users u ON u.id = q.created_by WHERE q.id = $1', [id]);
    if (!q) throw fail('Quotation not found', 404);
    const rows = await t.query(`SELECT qi.*, p.name, p.sku, p.variant_label, p.tracking, p.made_to_order, pc.piece_code FROM quotation_items qi JOIN products p ON p.id = qi.product_id
      LEFT JOIN pieces pc ON pc.id = qi.piece_id WHERE qi.quotation_id = $1 ORDER BY qi.id`, [id]);
    const items = [];
    for (const it of rows) {
      const piece = it.piece_id && await t.one('SELECT * FROM pieces WHERE id = $1', [it.piece_id]);
      const a = await inv.productAvailability(t, it.product_id);
      const status = piece ? inv.pieceStatus(piece) : a.status;
      const resv = await t.query("SELECT id, qty, location_id FROM reservations WHERE quotation_id = $1 AND product_id = $2 AND COALESCE(piece_id,0) = $3 AND status = 'active'", [id, it.product_id, it.piece_id || 0]);
      const heldByThis = resv.reduce((s, r) => s + r.qty, 0);
      const canFulfil = heldByThis >= it.qty || (piece ? status === 'available_now' : a.totals.available >= it.qty);
      items.push({ ...it, status, status_label: catalog.STATUS_LABEL[status], available: piece ? (status === 'available_now' ? 1 : 0) : a.totals.available,
        reservations: resv, can_fulfil: canFulfil, needs_piece: it.tracking === 'piece' && !it.piece_id, photo: await catalog.primaryPhoto(t, it.product_id, it.piece_id) });
    }
    return { ...q, items, total: items.reduce((s, i) => s + i.qty * i.unit_price, 0) };
  }
  const editableQuote = async (qid) => {
    const q = await db.one('SELECT status FROM quotations WHERE id = $1', [qid]);
    if (!q || !['draft', 'sent'].includes(q.status)) throw fail('Only draft quotations can be changed', 409);
  };
  api.get('/quotations', need('quote'), wrap(() => db.query(`SELECT q.*, (SELECT SUM(qty*unit_price) FROM quotation_items WHERE quotation_id = q.id) AS total,
    (SELECT COUNT(*) FROM quotation_items WHERE quotation_id = q.id) AS items FROM quotations q ORDER BY q.id DESC LIMIT 100`)));
  api.post('/quotations', need('quote'), wrap(async (req) => ({ id: await createQuotation(req.body, uid(req)) })));
  api.get('/quotations/:id', need('quote'), wrap((req) => quotationView(db, Number(req.params.id))));
  api.post('/quotations/:id/items', need('quote'), wrap(async (req) => {
    await editableQuote(Number(req.params.id));
    await addQuoteItem(db, Number(req.params.id), req.body); return { ok: true };
  }));
  api.patch('/quotation-items/:id', need('quote'), wrap(async (req) => {
    const it = await db.one('SELECT qi.*, q.status FROM quotation_items qi JOIN quotations q ON q.id = qi.quotation_id WHERE qi.id = $1', [Number(req.params.id)]);
    if (!it || !['draft', 'sent'].includes(it.status)) throw fail('Only draft quotations can be changed', 409);
    if ('piece_id' in req.body) {
      const pc = req.body.piece_id ? await db.one('SELECT * FROM pieces WHERE id = $1 AND product_id = $2', [req.body.piece_id, it.product_id]) : null;
      if (req.body.piece_id && !pc) throw fail('Piece does not belong to this product');
      await db.query('UPDATE quotation_items SET piece_id = $1, qty = 1, unit_price = COALESCE($2, unit_price) WHERE id = $3', [pc ? pc.id : null, pc ? pc.selling_price : null, it.id]);
    }
    if ('qty' in req.body && !it.piece_id) await db.query('UPDATE quotation_items SET qty = $1 WHERE id = $2', [Math.max(1, Number(req.body.qty) || 1), it.id]);
    if ('unit_price' in req.body) await db.query('UPDATE quotation_items SET unit_price = $1 WHERE id = $2', [Math.max(0, Number(req.body.unit_price) || 0), it.id]);
    return { ok: true };
  }));
  api.delete('/quotation-items/:id', need('quote'), wrap(async (req) => {
    const it = await db.one('SELECT q.status FROM quotation_items qi JOIN quotations q ON q.id = qi.quotation_id WHERE qi.id = $1', [Number(req.params.id)]);
    if (!it || !['draft', 'sent'].includes(it.status)) throw fail('Only draft quotations can be changed', 409);
    await db.query('DELETE FROM quotation_items WHERE id = $1', [Number(req.params.id)]); return { ok: true };
  }));
  api.post('/shortlists/:id/quotation', need('quote'), wrap(async (req) => {
    const s = await db.one('SELECT * FROM shortlists WHERE id = $1', [Number(req.params.id)]);
    if (!s) throw fail('Shortlist not found', 404);
    const items = await db.query('SELECT * FROM shortlist_items WHERE shortlist_id = $1 ORDER BY id', [s.id]);
    if (!items.length) throw fail('Shortlist is empty');
    return { id: await createQuotation({ customer_name: s.customer_name, customer_phone: s.customer_phone, shortlist_id: s.id, items }, uid(req)) };
  }));
  /** Confirm as order: re-checks current availability and reserves every line, all or nothing. */
  api.post('/quotations/:id/confirm', need('reserve'), confirmed, wrap(async (req) => {
    const id = Number(req.params.id);
    return db.tx(async (t) => {
      t.inTx = true;
      const q = await t.one('SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [id]);
      if (!q) throw fail('Quotation not found', 404);
      if (!['draft', 'sent'].includes(q.status)) throw fail('Quotation is already ' + q.status, 409);
      const view = await quotationView(t, id);
      if (!view.items.length) throw fail('Quotation has no items');
      const problems = [];
      for (const it of view.items) {
        if (it.needs_piece) { problems.push(`${it.name}: choose the exact piece`); continue; }
        try {
          await inv.reserve(t, { productId: it.product_id, pieceId: it.piece_id, qty: it.qty, customerName: q.customer_name, quotationId: id, userId: uid(req) });
        } catch (e) {
          if (!e.status && e.code !== '23505') throw e;
          problems.push(`${it.name}${it.piece_code ? ` (${it.piece_code})` : ''}: ${e.code === '23505' ? 'just reserved by someone else' : e.message}`);
        }
      }
      if (problems.length) throw Object.assign(fail(`Cannot confirm — ${problems.join('; ')}`, 409), { problems });
      await t.query("UPDATE quotations SET kind = 'order', status = 'confirmed' WHERE id = $1", [id]);
      return quotationView(t, id);
    });
  }));
  api.post('/quotations/:id/cancel', need('reserve'), confirmed, wrap(async (req) => {
    const id = Number(req.params.id);
    await db.tx(async (t) => {
      t.inTx = true;
      for (const r of await t.query("SELECT id FROM reservations WHERE quotation_id = $1 AND status = 'active'", [id])) await inv.releaseReservation(t, r.id, uid(req), 'Order cancelled');
      await t.query("UPDATE quotations SET status = 'cancelled' WHERE id = $1", [id]);
    });
    return quotationView(db, id);
  }));
  api.post('/quotations/:id/dispatch', need('dispatch'), confirmed, wrap(async (req) => {
    const id = Number(req.params.id);
    await db.tx(async (t) => {
      t.inTx = true;
      const q = await t.one('SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [id]);
      if (!q || q.status !== 'confirmed') throw fail('Only confirmed orders can be dispatched', 409);
      for (const r of await t.query("SELECT id FROM reservations WHERE quotation_id = $1 AND status = 'active'", [id])) await inv.dispatch(t, { reservationId: r.id, reference: q.number, userId: uid(req) });
      await t.query("UPDATE quotations SET status = 'dispatched' WHERE id = $1", [id]);
    });
    return quotationView(db, id);
  }));

  // ---------- Labels ----------
  const MAX_LABELS = Number(process.env.MAX_LABELS_PER_BATCH || (process.env.NETLIFY ? 600 : 2000));
  api.get('/label-templates', need('labels'), wrap(() => db.query('SELECT * FROM label_templates ORDER BY id')));
  api.post('/label-templates', need('manage_settings'), wrap(async (req) => {
    const x = req.body;
    const t = { name: String(x.name || '').trim(), layout: x.layout === 'thermal' ? 'thermal' : 'a4', width_mm: +x.width_mm, height_mm: +x.height_mm, cols: +x.cols || null, rows: +x.rows || null,
      margin_top_mm: +x.margin_top_mm || 0, margin_left_mm: +x.margin_left_mm || 0, gap_x_mm: +x.gap_x_mm || 0, gap_y_mm: +x.gap_y_mm || 0, dpi: [203, 300, 600].includes(+x.dpi) ? +x.dpi : 300 };
    if (!t.name || !(t.width_mm > 10 && t.height_mm > 8)) throw fail('Enter a name and a size of at least 10 × 8 mm');
    if (t.layout === 'a4') {
      if (!(t.cols >= 1 && t.rows >= 1)) throw fail('Enter columns and rows for the sheet');
      if (t.margin_left_mm + t.cols * t.width_mm + (t.cols - 1) * t.gap_x_mm > 210.5 || t.margin_top_mm + t.rows * t.height_mm + (t.rows - 1) * t.gap_y_mm > 297.5) throw fail('These labels do not fit on an A4 sheet');
    }
    const r = await db.one(...insertSql('label_templates', t));
    return { id: r.id };
  }));
  async function buildLabels(req) {
    const x = req.body;
    const tpl = await db.one('SELECT * FROM label_templates WHERE id = $1', [Number(x.template_id)]);
    if (!tpl) throw fail('Choose a label size');
    tpl.start_at = Math.max(1, Number(x.start_at) || 1);
    const opts = { content: ['barcode', 'qr', 'both'].includes(x.content) ? x.content : 'both', show_price: !!x.show_price, show_specs: !!x.show_specs, show_piece_id: x.show_piece_id !== false, use_mfr: !!x.use_mfr };
    const items = Array.isArray(x.items) ? x.items : [];
    if (!items.length) throw fail('Add at least one item');
    // Expand "all pieces of product" requests and copies
    const expanded = [];
    for (const it of items) {
      const copies = Math.min(500, Math.max(1, Number(it.copies) || 1));
      if (it.type === 'product_pieces') {
        for (const pc of await db.query("SELECT id FROM pieces WHERE product_id = $1 AND status != 'sold' ORDER BY piece_code", [Number(it.id)])) for (let i = 0; i < copies; i++) expanded.push({ type: 'piece', id: pc.id });
      } else for (let i = 0; i < copies; i++) expanded.push({ type: it.type === 'piece' ? 'piece' : 'product', id: Number(it.id) });
      if (expanded.length > MAX_LABELS) throw fail(`Too many labels in one batch (max ${MAX_LABELS})`);
    }
    const base = await baseUrl(req), biz = await businessName();
    const cache = new Map();
    const datas = [];
    for (const it of expanded) {
      const k = `${it.type}:${it.id}`;
      if (!cache.has(k)) cache.set(k, await labels.labelData(db, it, opts, base, biz));
      datas.push(cache.get(k));
    }
    return { tpl, opts, datas };
  }
  api.post('/labels/preview', need('labels'), wrap(async (req) => {
    const { tpl, opts, datas } = await buildLabels(req);
    const seen = new Map();
    for (const d of datas) if (!seen.has(d.barcode)) seen.set(d.barcode, { ...d, checks: labels.layoutLabel(d, tpl, opts).checks });
    const perPage = tpl.layout === 'a4' ? tpl.cols * tpl.rows : 1;
    return { count: datas.length, pages: Math.ceil((datas.length + tpl.start_at - 1) / perPage), labels: [...seen.values()] };
  }));
  api.post('/labels/pdf', need('labels'), wrap(async (req, res) => {
    const { tpl, opts, datas } = await buildLabels(req);
    const pdf = await labels.renderPdf(datas.map((d) => labels.layoutLabel(d, tpl, opts)), tpl, { outline: !!req.body.outline });
    res.type('application/pdf').set('Content-Disposition', `inline; filename="labels-${Date.now()}.pdf"`).send(pdf);
  }));
  api.post('/labels/zpl', need('labels'), wrap(async (req, res) => {
    const { tpl, opts, datas } = await buildLabels(req);
    res.type('text/plain').set('Content-Disposition', `attachment; filename="labels-${Date.now()}.zpl"`).send(labels.renderZpl(datas, tpl, opts));
  }));

  // ---------- Settings ----------
  const SETTING_KEYS = ['business_name', 'public_pages_enabled', 'public_show_prices', 'public_show_expected_date', 'public_base_url', 'showroom_contact', 'availability_wording', 'currency'];
  api.get('/settings', need('view'), wrap(async () => {
    const s = Object.fromEntries((await db.query('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
    return { ...s, availability_wording: (await pub.settings(db)).wording };
  }));
  api.put('/settings', need('manage_settings'), wrap(async (req) => {
    for (const k of SETTING_KEYS) {
      if (!(k in req.body)) continue;
      let v = req.body[k];
      if (k === 'availability_wording') v = JSON.stringify(Object.fromEntries(Object.entries(v || {}).filter(([kk]) => kk in pub.DEFAULT_WORDING).map(([kk, vv]) => [kk, String(vv).slice(0, 120)])));
      if (typeof v === 'boolean') v = v ? '1' : '0';
      if (k === 'public_base_url' && v && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v)) throw fail('Public base URL must start with http:// or https://');
      await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, String(v ?? '')]);
    }
    return { ok: true };
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

module.exports = { createApp, hashPassword, verifyPassword, ROLE_PERMS };
