'use strict';
/**
 * Barcode / QR labels. One layout engine produces drawing primitives in mm,
 * snapped to the printer's dot grid; PDF (A4 sheets or thermal rolls) and ZPL
 * are rendered from it, and the tests rasterise the same primitives to prove
 * the printed codes decode at the chosen size.
 *
 * Label data is built from an explicit whitelist: purchase cost, margin and
 * vendor are never read here.
 */
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { code128Bars, code128Modules } = require('./codes');
const { dims } = require('./catalog');
const ZX = require('@zxing/library');

/**
 * QR matrix that is verified to decode with ZXing (used by the staff scanner on
 * phones without a native barcode detector). A small share of valid codes are not
 * read by ZXing at some module sizes depending on the mask pattern, so each code is
 * test-decoded at several sizes and another mask (all are valid per ISO 18004) is
 * chosen when needed.
 */
const qrCache = new Map();
const CHECK_SCALES = [3, 6, 10, 14];
function zxingReads(qr, text) {
  return CHECK_SCALES.every((s) => zxingReadsAt(qr, text, s));
}
function zxingReadsAt(qr, text, s) {
  const n = qr.modules.size, qz = 4, W = (n + 2 * qz) * s;
  const px = new Uint8ClampedArray(W * W).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.modules.data[r * n + c]) for (let y = 0; y < s; y++) px.fill(0, ((r + qz) * s + y) * W + (c + qz) * s, ((r + qz) * s + y) * W + (c + qz + 1) * s);
  }
  try { return new ZX.QRCodeReader().decode(new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.RGBLuminanceSource(px, W, W)))).getText() === text; } catch { return false; }
}
function makeQr(text) {
  if (qrCache.has(text)) return qrCache.get(text);
  let qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  if (!zxingReads(qr, text)) {
    for (let mask = 0; mask < 8; mask++) {
      if (mask === qr.maskPattern) continue;
      const alt = QRCode.create(text, { errorCorrectionLevel: 'M', maskPattern: mask });
      if (zxingReads(alt, text)) { qr = alt; break; }
    }
  }
  if (qrCache.size > 5000) qrCache.clear();
  qrCache.set(text, qr);
  return qr;
}

const PT = 72 / 25.4;        // points per mm
const PT_MM = 25.4 / 72;     // mm per point
const MIN_X_MM = 0.25;       // smallest reliable Code 128 module for handheld scanners
const MIN_QR_MODULE_MM = 0.33;
const MIN_BAR_H_MM = 5;

const DEFAULT_TEMPLATES = [
  { name: 'A4 sheet — 63.5 × 38.1 mm (21 per sheet)', layout: 'a4', width_mm: 63.5, height_mm: 38.1, cols: 3, rows: 7, margin_top_mm: 15.15, margin_left_mm: 7.2, gap_x_mm: 2.5, gap_y_mm: 0, dpi: 600 },
  { name: 'A4 sheet — 99.1 × 38.1 mm (14 per sheet)', layout: 'a4', width_mm: 99.1, height_mm: 38.1, cols: 2, rows: 7, margin_top_mm: 15.15, margin_left_mm: 4.65, gap_x_mm: 2.5, gap_y_mm: 0, dpi: 600 },
  { name: 'A4 sheet — 38.1 × 21.2 mm (65 per sheet, QR recommended)', layout: 'a4', width_mm: 38.1, height_mm: 21.2, cols: 5, rows: 13, margin_top_mm: 10.7, margin_left_mm: 4.65, gap_x_mm: 2.5, gap_y_mm: 0, dpi: 600 },
  { name: 'Thermal roll — 50 × 25 mm (203 dpi, barcode or QR)', layout: 'thermal', width_mm: 50, height_mm: 25, dpi: 203 },
  { name: 'Thermal roll — 75 × 50 mm (203 dpi)', layout: 'thermal', width_mm: 75, height_mm: 50, dpi: 203 },
  { name: 'Thermal roll — 100 × 50 mm (300 dpi)', layout: 'thermal', width_mm: 100, height_mm: 50, dpi: 300 },
];

const fmtPrice = (n) => `Rs. ${Math.round(n).toLocaleString('en-IN')}`;

/** Whitelisted label content for a product or piece. */
function labelData(db, { type, id }, opts, baseUrl, businessName) {
  if (type === 'piece') {
    const pc = db.prepare('SELECT id, piece_code, public_token, mfr_barcode, selling_price, product_id, finish_note FROM pieces WHERE id = ?').get(id);
    if (!pc) throw Object.assign(new Error(`Piece ${id} not found`), { status: 404 });
    const p = db.prepare('SELECT name, variant_label, sku, selling_price, short_specs, length_cm, width_cm, height_cm, material, finish FROM products WHERE id = ?').get(pc.product_id);
    return {
      business: businessName, name: p.variant_label ? `${p.name} — ${p.variant_label}` : p.name, sku: p.sku,
      piece_code: opts.show_piece_id === false ? null : pc.piece_code,
      barcode: (opts.use_mfr && pc.mfr_barcode) || pc.piece_code,
      qr: `${baseUrl}/p/${pc.public_token}`,
      price: opts.show_price ? (pc.selling_price ?? p.selling_price) : null,
      specs: opts.show_specs ? (p.short_specs || [dims(p), p.material, pc.finish_note || p.finish].filter(Boolean).join(' · ')) : null,
    };
  }
  const p = db.prepare('SELECT name, variant_label, sku, internal_code, public_token, mfr_barcode, selling_price, short_specs, length_cm, width_cm, height_cm, material, finish FROM products WHERE id = ?').get(id);
  if (!p) throw Object.assign(new Error(`Product ${id} not found`), { status: 404 });
  return {
    business: businessName, name: p.variant_label ? `${p.name} — ${p.variant_label}` : p.name, sku: p.sku, piece_code: null,
    barcode: (opts.use_mfr && p.mfr_barcode) || p.internal_code,
    qr: `${baseUrl}/p/${p.public_token}`,
    price: opts.show_price ? p.selling_price : null,
    specs: opts.show_specs ? (p.short_specs || [dims(p), p.material, p.finish].filter(Boolean).join(' · ')) : null,
  };
}

/** Lay out one label. Returns primitives in mm (origin top-left) plus print-size checks. */
function layoutLabel(data, tpl, opts = {}) {
  const content = opts.content || 'both';     // 'barcode' | 'qr' | 'both'
  const w = tpl.width_mm, h = tpl.height_mm;
  const dpmm = tpl.dpi / 25.4;
  const snap = (mm) => Math.round(mm * dpmm) / dpmm;
  const pad = Math.max(1.2, Math.min(w, h) * 0.05);
  const innerW = w - 2 * pad, innerH = h - 2 * pad;
  const items = [];
  const checks = { warnings: [] };
  let leftW = innerW;

  if (content !== 'barcode') {
    const qr = makeQr(data.qr);
    const n = qr.modules.size;
    // big enough for phones, small enough to leave room for text
    let maxSize = Math.min(innerH, innerW * (content === 'qr' ? 0.5 : 0.45), n * (content === 'both' ? 0.75 : 1.0));
    if (content === 'both') {
      // leave enough width for the barcode at the minimum reliable bar width
      const minDots = Math.ceil(MIN_X_MM * dpmm - 1e-9);
      const barcodeW = (code128Bars(data.barcode).modules + 20) * (minDots / dpmm);
      const gapFactor = 1 + Math.max(4 / n, 1.5 / maxSize);   // QR quiet gap of 4 modules (min 1.5 mm)
      maxSize = Math.max(Math.min(maxSize, (innerW - barcodeW) / gapFactor), innerW * 0.25);
    }
    const modDots = Math.floor((maxSize * dpmm) / n);
    const mod = modDots / dpmm;
    const size = mod * n;
    const x0 = snap(w - pad - size), y0 = snap(pad + (innerH - size) / 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.modules.data[r * n + c]) continue;
        let run = 1;
        while (c + run < n && qr.modules.data[r * n + c + run]) run++;
        items.push({ t: 'rect', x: x0 + c * mod, y: y0 + r * mod, w: run * mod, h: mod, qr: true });
        c += run - 1;
      }
    }
    checks.qr = { modules: n, module_mm: +mod.toFixed(3), module_dots: modDots, size_mm: +size.toFixed(2), x: x0, y: y0 };
    if (modDots < 2 || mod < MIN_QR_MODULE_MM) checks.warnings.push(`QR modules are ${mod.toFixed(2)} mm — too small for reliable phone scanning; use a larger label`);
    leftW = innerW - size - Math.max(4 * mod, 1.5);
  }

  let textBottom = h - pad;
  if (content !== 'qr') {
    const { bars, modules } = code128Bars(data.barcode);
    const total = modules + 20;                       // 10-module quiet zone each side
    const xDots = Math.floor((leftW * dpmm) / total);
    const X = xDots / dpmm;
    const hrSize = Math.min(7, Math.max(5, h * 0.2));  // human-readable text (pt)
    const hrH = hrSize * PT_MM * 1.15;
    const barH = Math.min(15, Math.max(MIN_BAR_H_MM, innerH * 0.36));
    const by = snap(h - pad - hrH - barH);
    const bx = snap(pad + 10 * X);
    for (const b of bars) items.push({ t: 'rect', x: bx + b.x * X, y: by, w: b.w * X, h: barH, barcode: true });
    items.push({ t: 'text', x: pad, y: by + barH + 0.2, w: leftW, size: hrSize, text: data.barcode, align: 'center', mono: true, lines: 1, hr: true });
    checks.barcode = { value: data.barcode, modules, x_mm: +X.toFixed(4), x_dots: xDots, width_mm: +(modules * X).toFixed(2), height_mm: +barH.toFixed(2), x: bx, y: by, quiet_mm: +(10 * X).toFixed(2) };
    if (xDots < 1 || X < MIN_X_MM - 0.001) checks.warnings.push(`Barcode bars are ${X.toFixed(3)} mm wide (minimum ${MIN_X_MM} mm) — scanners may fail; use QR only or a wider label`);
    textBottom = by - 0.6;
  }

  // Text block, top to bottom; optional lines are dropped if they do not fit.
  const scale = Math.min(1.5, Math.max(0.75, h / 30));
  const lines = [
    { key: 'business', text: data.business.toUpperCase(), size: 5.5 * scale, bold: true, brand: true },
    { key: 'name', text: data.name, size: 8 * scale, bold: true, lines: 2 },
    { key: 'sku', text: `SKU ${data.sku}`, size: 6 * scale },
    data.piece_code ? { key: 'piece', text: `Piece ID ${data.piece_code}`, size: 6 * scale, bold: true } : null,
    data.price != null ? { key: 'price', text: fmtPrice(data.price), size: 9 * scale, bold: true } : null,
    data.specs ? { key: 'specs', text: data.specs, size: 5.5 * scale, lines: 2, optional: true } : null,
  ].filter(Boolean);
  const height = (l, n) => l.size * PT_MM * 1.22 * n;
  const avail = textBottom - pad;
  let used = lines.reduce((s, l) => s + height(l, l.lines || 1), 0);
  // shrink: drop specs, then single-line name, then scale everything down
  if (used > avail) { const i = lines.findIndex((l) => l.optional); if (i >= 0) { used -= height(lines[i], lines[i].lines); lines.splice(i, 1); } }
  const nameLine = lines.find((l) => l.key === 'name');
  if (used > avail && nameLine.lines === 2) { used -= height(nameLine, 1); nameLine.lines = 1; }
  if (used > avail) {
    const f = Math.max(0.55, avail / used);
    lines.forEach((l) => { l.size *= f; });
    if (avail / used < 0.55) checks.warnings.push('Label is too small for all text; some text may be clipped');
  }
  let y = pad;
  for (const l of lines) {
    const n = l.lines || 1;
    items.push({ t: 'text', x: pad, y, w: leftW, size: +l.size.toFixed(2), bold: !!l.bold, brand: !!l.brand, text: l.text, lines: n, key: l.key });
    y += height(l, n);
  }
  return { w, h, items, checks };
}

function placements(tpl, count, startAt = 1) {
  const out = [];
  if (tpl.layout === 'thermal') {
    for (let i = 0; i < count; i++) out.push({ page: i, x: 0, y: 0 });
    return out;
  }
  const perPage = tpl.cols * tpl.rows;
  for (let i = 0; i < count; i++) {
    const slot = i + (startAt - 1);
    const page = Math.floor(slot / perPage), k = slot % perPage;
    const col = k % tpl.cols, row = Math.floor(k / tpl.cols);
    out.push({ page, x: tpl.margin_left_mm + col * (tpl.width_mm + tpl.gap_x_mm), y: tpl.margin_top_mm + row * (tpl.height_mm + tpl.gap_y_mm) });
  }
  return out;
}

/** Render labels to a PDF buffer. A4 sheet or one-label-per-page thermal. */
function renderPdf(labels, tpl, { outline = false, compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const size = tpl.layout === 'a4' ? 'A4' : [tpl.width_mm * PT, tpl.height_mm * PT];
    const doc = new PDFDocument({ size, margin: 0, autoFirstPage: false, compress, info: { Title: 'Labels', Producer: 'Airawat labels' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const pos = placements(tpl, labels.length, tpl.start_at || 1);
    let page = -1;
    labels.forEach((lab, i) => {
      const p = pos[i];
      if (p.page !== page) { doc.addPage({ size, margin: 0 }); page = p.page; }
      const ox = p.x, oy = p.y;
      if (outline) doc.save().lineWidth(0.3).strokeColor('#bbbbbb').roundedRect(ox * PT, oy * PT, lab.w * PT, lab.h * PT, 4).stroke().restore();
      for (const it of lab.items) {
        if (it.t === 'rect') { doc.rect((ox + it.x) * PT, (oy + it.y) * PT, it.w * PT, it.h * PT).fill('#000000'); continue; }
        const font = it.mono ? 'Courier' : it.bold ? 'Helvetica-Bold' : 'Helvetica';
        doc.font(font).fontSize(it.size).fillColor(it.brand ? '#c8102e' : '#000000')
          .text(it.text, (ox + it.x) * PT, (oy + it.y) * PT, { width: it.w * PT, height: it.size * 1.25 * it.lines + 1, ellipsis: true, lineGap: 0, align: it.align || 'left', lineBreak: it.lines > 1 });
      }
    });
    if (!labels.length) doc.addPage({ size, margin: 0 });
    doc.end();
  });
}

/** ZPL for Zebra-compatible thermal printers (uses the printer's native barcode/QR engine). */
function renderZpl(datas, tpl, opts) {
  const dpmm = tpl.dpi / 25.4;
  const d = (mm) => Math.round(mm * dpmm);
  return datas.map((data) => {
    const lab = layoutLabel(data, tpl, opts);
    const out = ['^XA', '^CI28', `^PW${d(tpl.width_mm)}`, `^LL${d(tpl.height_mm)}`];
    for (const it of lab.items) {
      if (it.t !== 'text' || it.hr) continue;
      const fh = Math.max(12, Math.round(it.size * PT_MM * dpmm));
      const clean = it.text.replace(/[\^~]/g, ' ');
      out.push(`^FO${d(it.x)},${d(it.y)}^A0N,${fh},${fh}^FB${d(it.w)},${it.lines},0,L^FD${clean}^FS`);
    }
    if (lab.checks.barcode) {
      const b = lab.checks.barcode;
      out.push(`^FO${d(b.x)},${d(b.y)}^BY${Math.max(1, b.x_dots)}^BCN,${d(b.height_mm)},Y,N,N,A^FD${data.barcode.replace(/[\^~]/g, '')}^FS`);
    }
    if (lab.checks.qr) {
      const q = lab.checks.qr;
      out.push(`^FO${d(q.x)},${Math.max(0, d(q.y) - 10)}^BQN,2,${Math.max(1, Math.min(10, q.module_dots))}^FDMA,${data.qr}^FS`);
    }
    out.push('^PQ1', '^XZ');
    return out.join('\n');
  }).join('\n');
}

module.exports = { makeQr, DEFAULT_TEMPLATES, labelData, layoutLabel, renderPdf, renderZpl, placements, MIN_X_MM, code128Modules };
