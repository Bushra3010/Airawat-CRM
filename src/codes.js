'use strict';
const crypto = require('crypto');

// ---------- Code 128 ----------
// Bar/space width patterns for symbol values 0..105, then the stop pattern (106).
const PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

function digitRun(s, i) {
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) >= 48 && s.charCodeAt(i + n) <= 57) n++;
  return n;
}

/** Encode text as Code 128 (sets B and C). Returns symbol values incl. start, checksum and stop. */
function code128Values(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('Barcode text is empty');
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`Character "${ch}" cannot be encoded in Code 128 set B/C`);
  }
  const values = [];
  let set;
  let i = 0;
  const run0 = digitRun(text, 0);
  if (run0 >= 4 || (run0 === text.length && run0 >= 2 && run0 % 2 === 0)) { set = 'C'; values.push(START_C); }
  else { set = 'B'; values.push(START_B); }
  while (i < text.length) {
    const run = digitRun(text, i);
    if (set === 'C') {
      if (run >= 2) { values.push(Number(text.substr(i, 2))); i += 2; continue; }
      values.push(CODE_B); set = 'B';
    }
    // set B: switch to C for runs of >= 4 digits (an odd leading digit stays in B)
    if (run >= 4) {
      if (run % 2 === 1) { values.push(text.charCodeAt(i) - 32); i++; }
      values.push(CODE_C); set = 'C';
      continue;
    }
    values.push(text.charCodeAt(i) - 32); i++;
  }
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += values[k] * k;
  values.push(sum % 103);
  values.push(STOP);
  return values;
}

/** Module pattern: array of booleans (true = bar), excluding quiet zones. */
function code128Modules(text) {
  const mods = [];
  for (const v of code128Values(text)) {
    const p = PATTERNS[v];
    for (let k = 0; k < p.length; k++) for (let w = 0; w < Number(p[k]); w++) mods.push(k % 2 === 0);
  }
  return mods;
}

/** Run-length bars: [{x, w}] in modules, for drawing. */
function code128Bars(text) {
  const mods = code128Modules(text);
  const bars = [];
  for (let i = 0; i < mods.length; i++) {
    if (!mods[i]) continue;
    let w = 1;
    while (mods[i + w]) w++;
    bars.push({ x: i, w });
    i += w - 1;
  }
  return { bars, modules: mods.length };
}

// ---------- Stable internal identifiers ----------
const PRODUCT_PREFIX = 'AHP';
const PIECE_PREFIX = 'AHU';

/** Next stable code for a prefix, e.g. AHP-000123. Atomic, so concurrent requests never share a code. */
async function nextCode(db, prefix) {
  const row = await db.one(`INSERT INTO code_sequences (prefix, next_value) VALUES ($1, 2)
    ON CONFLICT (prefix) DO UPDATE SET next_value = code_sequences.next_value + 1 RETURNING next_value`, [prefix]);
  return `${prefix}-${String(row.next_value - 1).padStart(6, '0')}`;
}

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

// ---------- Manufacturer barcode validation ----------
function gtinCheckDigitValid(code) {
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

/** Validate a manufacturer barcode value. Returns normalised value or throws. */
function badCode(msg) { const e = new Error(msg); e.status = 400; return e; }

function normaliseMfrBarcode(raw) {
  if (raw == null) return null;
  const code = String(raw).trim();
  if (!code) return null;
  if (!/^[\x20-\x7e]{4,48}$/.test(code)) throw badCode('Manufacturer barcode must be 4–48 printable characters');
  if (code.toUpperCase().startsWith(PRODUCT_PREFIX + '-') || code.toUpperCase().startsWith(PIECE_PREFIX + '-')) {
    throw badCode('Manufacturer barcode cannot use the internal code prefixes');
  }
  if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length) && !gtinCheckDigitValid(code)) {
    throw badCode('This looks like an EAN/UPC barcode but its check digit is wrong — please re-scan');
  }
  return code;
}

/** Ensure a code is not already used by any product/piece (internal or manufacturer). */
async function assertCodeFree(db, code, except = {}) {
  if (!code) return;
  const hits = await db.query(`
    SELECT 'product' AS type, id FROM products WHERE internal_code = $1 OR mfr_barcode = $1 OR sku = $1
    UNION ALL SELECT 'piece', id FROM pieces WHERE piece_code = $1 OR mfr_barcode = $1`, [code]);
  const clash = hits.find((h) => !(h.type === except.type && h.id === except.id));
  if (clash) {
    const err = new Error(`Barcode "${code}" is already assigned to another ${clash.type}`);
    err.status = 409;
    throw err;
  }
}

// ---------- YouTube ----------
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);

/** Returns the 11-character video id for a supported YouTube URL, or null. */
function parseYouTube(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(u.protocol) || !YT_HOSTS.has(u.hostname.toLowerCase())) return null;
  let id = null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname.toLowerCase() === 'youtu.be') id = parts[0];
  else if (parts[0] === 'watch') id = u.searchParams.get('v');
  else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1];
  return id && YT_ID.test(id) ? id : null;
}

const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const ytWatch = (id) => `https://www.youtube.com/watch?v=${id}`;

module.exports = {
  code128Values, code128Modules, code128Bars, nextCode, newToken,
  normaliseMfrBarcode, assertCodeFree, gtinCheckDigitValid,
  parseYouTube, ytThumb, ytWatch, PRODUCT_PREFIX, PIECE_PREFIX,
};
