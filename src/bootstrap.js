'use strict';
/**
 * Makes a fresh database usable without any terminal steps: creates/updates the
 * tables, the photo bucket, default settings, label sizes and locations, and the
 * first admin login (password from ADMIN_INITIAL_PASSWORD). Runs once per server
 * instance; an advisory lock stops two instances setting up at the same time.
 * Demo data is only loaded when DEMO_DATA=1 (never on by default in production).
 */
const path = require('path');
const { migrate } = require('./db');

const SETUP_LOCK = 4242001;
let ready = null;

class SetupError extends Error {
  constructor(message) { super(message); this.status = 503; }
}

async function firstRun(db, { adminPassword, demo, photoDir }) {
  const { hashPassword } = require('./server');
  const { DEFAULT_TEMPLATES } = require('./labels');
  await db.tx(async (t) => {
    t.inTx = true;
    await t.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
    if ((await t.one('SELECT COUNT(*)::int n FROM users')).n > 0) return;
    if (demo) {
      await require('./seed').seed(t, { photoDir });
      return;
    }
    if (!adminPassword || String(adminPassword).length < 10) {
      throw new SetupError('Setup needed: set ADMIN_INITIAL_PASSWORD (at least 10 characters) in the site environment variables, then reload.');
    }
    for (const [k, v] of [['business_name', 'Airawat Handicraft'], ['public_pages_enabled', '1'], ['public_show_prices', '1'], ['public_show_expected_date', '0'], ['currency', 'INR'], ['showroom_contact', '']]) {
      await t.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
    }
    if ((await t.one('SELECT COUNT(*)::int n FROM locations')).n === 0) {
      await t.query("INSERT INTO locations (code, name, type) VALUES ('SHR', 'Baner Showroom', 'showroom'), ('WH1', 'Main Warehouse', 'warehouse')");
    }
    if ((await t.one('SELECT COUNT(*)::int n FROM label_templates')).n === 0) {
      for (const tp of DEFAULT_TEMPLATES) {
        const r = { cols: null, rows: null, margin_top_mm: 0, margin_left_mm: 0, gap_x_mm: 0, gap_y_mm: 0, ...tp };
        await t.query(`INSERT INTO label_templates (name, layout, width_mm, height_mm, cols, rows, margin_top_mm, margin_left_mm, gap_x_mm, gap_y_mm, dpi)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [r.name, r.layout, r.width_mm, r.height_mm, r.cols, r.rows, r.margin_top_mm, r.margin_left_mm, r.gap_x_mm, r.gap_y_mm, r.dpi]);
      }
    }
    await t.query("INSERT INTO users (username, name, role, pass_hash) VALUES ('admin', 'Administrator', 'admin', $1)", [hashPassword(adminPassword)]);
    console.log('First run: created admin login, default locations and label sizes');
  });
}

/** Resolve once the database is ready. Retries on the next request if setup failed. */
function ensureReady(db, opts = {}) {
  if (!ready) {
    const o = {
      adminPassword: process.env.ADMIN_INITIAL_PASSWORD,
      demo: process.env.DEMO_DATA === '1',
      photoDir: path.join(__dirname, '..', 'public', 'seed-img'),
      ...opts,
    };
    ready = (async () => {
      await migrate(db);
      // already set up (the usual cold start): one query, no transaction
      if (await db.one('SELECT 1 FROM users LIMIT 1')) return;
      await require('./storage').ensureBucket().catch((e) => console.error(e.message));
      await firstRun(db, o);
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

module.exports = { ensureReady, SetupError };
