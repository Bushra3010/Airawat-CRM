'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','sales','storekeeper')),
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('showroom','warehouse','branch'))
);

-- Stable sequences for internal codes. Codes never change after issue.
CREATE TABLE IF NOT EXISTS code_sequences (prefix TEXT PRIMARY KEY, next_value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  internal_code TEXT UNIQUE NOT NULL,         -- stable internal Code 128 identifier
  public_token TEXT UNIQUE NOT NULL,          -- stable token used in customer QR URL
  sku TEXT UNIQUE NOT NULL,
  parent_id INTEGER REFERENCES products(id),  -- set for variants of a design
  variant_label TEXT,
  name TEXT NOT NULL,
  category TEXT,
  material TEXT,
  finish TEXT,
  length_cm REAL, width_cm REAL, height_cm REAL,
  description TEXT,
  care TEXT,
  short_specs TEXT,
  selling_price REAL,
  cost_price REAL,           -- internal only
  vendor TEXT,               -- internal only
  internal_notes TEXT,       -- internal only
  tracking TEXT NOT NULL DEFAULT 'sku' CHECK (tracking IN ('sku','piece')),
  made_to_order INTEGER NOT NULL DEFAULT 0,
  lead_time_days INTEGER,
  mfr_barcode TEXT UNIQUE,   -- existing manufacturer barcode, if any
  public_enabled INTEGER NOT NULL DEFAULT 1,
  public_show_price INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Individual physical pieces for unique / antique / differing items.
CREATE TABLE IF NOT EXISTS pieces (
  id INTEGER PRIMARY KEY,
  piece_code TEXT UNIQUE NOT NULL,            -- stable internal code
  public_token TEXT UNIQUE NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  mfr_barcode TEXT UNIQUE,
  condition TEXT NOT NULL DEFAULT 'New',
  finish_note TEXT,
  location_id INTEGER REFERENCES locations(id),
  rack TEXT,
  status TEXT NOT NULL CHECK (status IN ('available','reserved','sold','display','damaged','in_transit')),
  display_for_sale INTEGER NOT NULL DEFAULT 0, -- display piece explicitly released for sale
  cost_price REAL,
  selling_price REAL,
  notes TEXT,
  public_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  piece_id INTEGER REFERENCES pieces(id),
  url TEXT NOT NULL,
  caption TEXT,
  is_public INTEGER NOT NULL DEFAULT 1,       -- approved for customer pages
  sort INTEGER NOT NULL DEFAULT 0
);

-- SKU-level on-hand balances per location and stock condition.
CREATE TABLE IF NOT EXISTS stock_balances (
  product_id INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  condition TEXT NOT NULL CHECK (condition IN ('sellable','display','display_sale','damaged')),
  rack TEXT,
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (product_id, location_id, condition)
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  piece_id INTEGER REFERENCES pieces(id),
  location_id INTEGER REFERENCES locations(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  piece_prev_status TEXT,   -- piece status to restore if the reservation is released
  customer_name TEXT,
  quotation_id INTEGER REFERENCES quotations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','fulfilled')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
-- Database-level guarantee: one active reservation per unique piece.
CREATE UNIQUE INDEX IF NOT EXISTS ux_res_piece_active ON reservations(piece_id) WHERE piece_id IS NOT NULL AND status = 'active';

-- The stock ledger: every stock change is recorded here.
CREATE TABLE IF NOT EXISTS stock_ledger (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  movement TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  piece_id INTEGER REFERENCES pieces(id),
  from_location_id INTEGER REFERENCES locations(id),
  to_location_id INTEGER REFERENCES locations(id),
  condition TEXT,
  qty INTEGER NOT NULL,
  reference TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS ix_ledger_product ON stock_ledger(product_id, ts);
CREATE INDEX IF NOT EXISTS ix_ledger_piece ON stock_ledger(piece_id, ts);

-- Incoming purchase / production that sets expected availability dates.
CREATE TABLE IF NOT EXISTS incoming (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase','production')),
  qty INTEGER NOT NULL,
  expected_date TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','ordered','received','cancelled')),
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  piece_id INTEGER REFERENCES pieces(id),
  source TEXT NOT NULL CHECK (source IN ('staff','public_qr')),
  customer_name TEXT,
  customer_phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id), -- design or variant it belongs to
  piece_id INTEGER REFERENCES pieces(id),             -- set when video shows this exact piece
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  youtube_id TEXT NOT NULL,
  video_type TEXT NOT NULL CHECK (video_type IN ('overview','dimensions','finish','demonstration','installation','care')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'customer' CHECK (visibility IN ('customer','internal')),
  overrides_parent INTEGER NOT NULL DEFAULT 0,  -- when set on a variant/piece video, hides inherited videos of the same type
  embed_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (embed_status IN ('unchecked','ok','unavailable','embed_disabled')),
  checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'quotation' CHECK (kind IN ('quotation','order')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','confirmed','dispatched','cancelled')),
  customer_name TEXT,
  customer_phone TEXT,
  shortlist_id INTEGER REFERENCES shortlists(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  piece_id INTEGER REFERENCES pieces(id),
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  pref_finish TEXT,
  pref_dimensions TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS shortlists (
  id INTEGER PRIMARY KEY,
  customer_name TEXT,
  customer_phone TEXT,
  share_token TEXT UNIQUE NOT NULL,
  share_enabled INTEGER NOT NULL DEFAULT 0,
  share_show_prices INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shortlist_items (
  id INTEGER PRIMARY KEY,
  shortlist_id INTEGER NOT NULL REFERENCES shortlists(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  piece_id INTEGER REFERENCES pieces(id),
  qty INTEGER NOT NULL DEFAULT 1,
  pref_finish TEXT,
  pref_dimensions TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS label_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  layout TEXT NOT NULL CHECK (layout IN ('a4','thermal')),
  width_mm REAL NOT NULL, height_mm REAL NOT NULL,
  cols INTEGER, rows INTEGER,
  margin_top_mm REAL DEFAULT 0, margin_left_mm REAL DEFAULT 0,
  gap_x_mm REAL DEFAULT 0, gap_y_mm REAL DEFAULT 0,
  dpi INTEGER NOT NULL DEFAULT 300
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open };
