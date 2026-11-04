'use strict';
/**
 * Customer-facing data. Everything returned from here is built from an explicit
 * whitelist — never spread a DB row into these objects. Costs, margins, vendors,
 * customer records, internal notes and exact quantities must never appear.
 */
const inv = require('./inventory');
const { videosFor, photosFor, dims } = require('./catalog');

const DEFAULT_WORDING = {
  available_now: 'Available — ask our showroom team',
  reserved: 'Currently reserved — ask us about similar pieces',
  out_of_stock: 'Currently unavailable — ask us about similar pieces',
  made_to_order: 'Made to order',
  display_only: 'Showroom display piece',
  damaged: 'Please ask showroom staff',
  sold: 'This piece has been sold — ask us about similar pieces',
  in_transit: 'Please ask showroom staff',
};

async function settings(db) {
  const s = Object.fromEntries((await db.query('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
  let wording = DEFAULT_WORDING;
  try { wording = { ...DEFAULT_WORDING, ...JSON.parse(s.availability_wording || '{}') }; } catch { /* keep defaults */ }
  return {
    business_name: s.business_name || 'Airawat Handicraft',
    public_pages_enabled: s.public_pages_enabled !== '0',
    public_show_prices: s.public_show_prices !== '0',
    public_show_expected_date: s.public_show_expected_date === '1',
    currency: s.currency || 'INR',
    showroom_contact: s.showroom_contact || '',
    wording,
  };
}

function publicProductFields(p) {
  return {
    name: p.name, variant: p.variant_label || null, sku: p.sku, category: p.category || null,
    material: p.material || null, finish: p.finish || null, dimensions: dims(p),
    length_cm: p.length_cm, width_cm: p.width_cm, height_cm: p.height_cm,
    description: p.description || null, care: p.care || null,
  };
}

async function publicVideos(db, productId, pieceId) {
  return (await videosFor(db, { productId, pieceId }, { includeInternal: false })).map((v) => ({
    title: v.title, youtube_id: v.youtube_id, url: v.url, thumbnail: v.thumbnail, video_type: v.video_type,
    is_primary: v.is_primary, scope_label: v.scope_label, embeddable: v.embed_status !== 'embed_disabled' && v.embed_status !== 'unavailable',
    unavailable: v.embed_status === 'unavailable',
  })).filter((v) => !v.unavailable);
}

const publicPhotos = async (db, productId, pieceId) => (await photosFor(db, productId, pieceId, true))
  .map((ph) => ({ url: ph.url, caption: ph.caption || null, exact_piece: !!ph.exact_piece }));

/** Data for the customer QR page of a product or piece, or null if not public. */
async function publicItem(db, token) {
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(String(token))) return null;
  // settings and the token lookup in parallel; the product comes back with a piece match
  const [s, hit] = await Promise.all([
    settings(db),
    db.one(`SELECT row_to_json(pc) AS piece, row_to_json(pr) AS product FROM pieces pc JOIN products pr ON pr.id = pc.product_id WHERE pc.public_token = $1
      UNION ALL SELECT NULL, row_to_json(pr) FROM products pr WHERE pr.public_token = $1 LIMIT 1`, [token]),
  ]);
  if (!s.public_pages_enabled || !hit) return null;
  const { piece, product } = hit;
  if (piece && !piece.public_enabled) return null;
  if (!product || !product.public_enabled || !product.active) return null;

  const [avail, photos, videos] = await Promise.all([
    piece ? null : inv.productAvailability(db, product.id),
    publicPhotos(db, product.id, piece && piece.id),
    publicVideos(db, product.id, piece && piece.id),
  ]);
  const status = piece ? inv.pieceStatus(piece) : avail.status;
  // a price implies the item can be bought: hide it for display-only, damaged and sold items
  const showPrice = s.public_show_prices && !!product.public_show_price && !['sold', 'display_only', 'damaged'].includes(status);
  const price = piece ? (piece.selling_price ?? product.selling_price) : product.selling_price;
  const expected = s.public_show_expected_date && avail && status !== 'available_now' && avail.expected ? avail.expected.date : null;
  return {
    business_name: s.business_name, showroom_contact: s.showroom_contact, currency: s.currency,
    kind: piece ? 'piece' : 'product',
    piece: piece ? { code: piece.piece_code, condition: piece.condition, finish_note: piece.finish_note || null } : null,
    product: publicProductFields(product),
    price: showPrice && price != null ? price : null,
    availability_text: s.wording[status] || s.wording.out_of_stock,
    expected_date: expected,
    photos,
    videos,
  };
}

/** Shareable customer catalogue for a shortlist. */
async function publicCatalogue(db, token) {
  const s = await settings(db);
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(String(token))) return null;
  const sl = await db.one('SELECT * FROM shortlists WHERE share_token = $1 AND share_enabled = 1', [token]);
  if (!sl) return null;
  const items = [];
  for (const it of await db.query('SELECT * FROM shortlist_items WHERE shortlist_id = $1 ORDER BY id', [sl.id])) {
    const p = await db.one('SELECT * FROM products WHERE id = $1', [it.product_id]);
    const piece = it.piece_id ? await db.one('SELECT * FROM pieces WHERE id = $1', [it.piece_id]) : null;
    const price = piece ? (piece.selling_price ?? p.selling_price) : p.selling_price;
    items.push({
      product: publicProductFields(p),
      piece_code: piece ? piece.piece_code : null,
      qty: it.qty, preferred_finish: it.pref_finish || null, preferred_dimensions: it.pref_dimensions || null,
      price: s.public_show_prices && sl.share_show_prices && p.public_show_price && price != null ? price : null,
      photos: (await publicPhotos(db, p.id, piece && piece.id)).slice(0, 4).map((ph) => ({ url: ph.url, caption: ph.caption })),
      videos: await publicVideos(db, p.id, piece && piece.id),
    });
  }
  return {
    business_name: s.business_name, showroom_contact: s.showroom_contact, currency: s.currency,
    title: sl.customer_name ? `Selection for ${sl.customer_name.split(' ')[0]}` : 'Your selection', items,
    note: 'Prices and availability are confirmed by our team at the time of order.',
  };
}

// ---------------- HTML ----------------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur) => n == null ? '' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);

const PAGE_CSS = `
:root{--brand:#e0232a;--ink:#1d1b1a;--muted:#6b6560;--bg:#faf7f4;--card:#fff;--line:#e8e1da}
@media (prefers-color-scheme:dark){:root{--ink:#f2eeea;--muted:#a59d96;--bg:#171514;--card:#211e1c;--line:#36312d}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header img{width:34px;height:34px}header b{color:var(--brand);letter-spacing:.04em}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;line-height:1.25;margin:.2em 0}h2{font-size:1.1rem;margin:1.4em 0 .5em}
.gallery{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;margin:0 -16px;padding:0 16px}
.gallery figure{margin:0;flex:0 0 86%;scroll-snap-align:center}.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;background:var(--line)}
figcaption{font-size:.8rem;color:var(--muted)}
.price{font-size:1.4rem;font-weight:700}.avail{display:inline-block;padding:4px 10px;border-radius:999px;background:var(--line);font-size:.9rem;margin:6px 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0}dt{color:var(--muted)}dd{margin:0}
.video{position:relative;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:#000;margin-bottom:6px}
.video button{all:unset;cursor:pointer;position:absolute;inset:0;display:grid;place-items:center}
.video img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.85}
.video span{position:relative;background:var(--brand);color:#fff;padding:10px 16px;border-radius:999px;font-weight:600}
.video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.vmeta{font-size:.85rem;color:var(--muted);margin-bottom:16px}.vmeta a{color:var(--brand)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.btn{display:inline-block;background:var(--brand);color:#fff;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
input,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--bg);color:var(--ink);margin:4px 0 10px}
.muted{color:var(--muted);font-size:.9rem}footer{text-align:center;color:var(--muted);font-size:.8rem;padding:24px}
`;

const VIDEO_JS = `
document.querySelectorAll('[data-yt]').forEach(function(b){b.addEventListener('click',function(){
  var box=b.parentNode,id=b.getAttribute('data-yt'),f=document.createElement('iframe');
  f.src='https://www.youtube-nocookie.com/embed/'+id+'?autoplay=1&rel=0&playsinline=1';
  f.allow='autoplay; encrypted-media; picture-in-picture; fullscreen';f.title=b.getAttribute('aria-label');
  box.innerHTML='';box.appendChild(f);});});
`;

function videoHtml(v) {
  const meta = `<div class="vmeta">${esc(v.title)} · ${esc(v.scope_label)} · <a href="${esc(v.url)}" target="_blank" rel="noopener">Open on YouTube</a></div>`;
  if (!v.embeddable) return `<div class="card">${esc(v.title)} — this video can only be watched on YouTube. <a class="btn" href="${esc(v.url)}" target="_blank" rel="noopener">Open on YouTube</a></div>`;
  return `<div class="video"><button data-yt="${esc(v.youtube_id)}" aria-label="Play ${esc(v.title)}"><img src="${esc(v.thumbnail)}" alt="" loading="lazy"><span>▶ Play video</span></button></div>${meta}`;
}

function shell(title, business, body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · ${esc(business)}</title><link rel="icon" href="/mark.png"><style>${PAGE_CSS}</style></head>
<body><header><img src="/mark.png" alt=""><b>${esc(business.toUpperCase())}</b></header><main>${body}</main>
<footer>${esc(business)}</footer><script>${VIDEO_JS}${script}</script></body></html>`;
}

function renderItemPage(d, token) {
  const p = d.product;
  const specs = [['Dimensions', p.dimensions], ['Material', p.material], ['Finish', d.piece && d.piece.finish_note ? d.piece.finish_note : p.finish], ['Category', p.category], ['Reference', d.piece ? d.piece.code : p.sku]]
    .filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const photos = d.photos.length ? `<div class="gallery">${d.photos.map((ph) => `<figure><img src="${esc(ph.url)}" alt="${esc(p.name)}" loading="lazy">${ph.exact_piece ? '<figcaption>Photo of this exact piece</figcaption>' : (d.kind === 'piece' ? '<figcaption>Same design — individual pieces vary</figcaption>' : '')}</figure>`).join('')}</div>` : '';
  const body = `${photos}
<h1>${esc(p.name)}${p.variant ? ` <span class="muted">— ${esc(p.variant)}</span>` : ''}</h1>
${d.price != null ? `<div class="price">${esc(money(d.price, d.currency))}</div>` : ''}
<div class="avail">${esc(d.availability_text)}${d.expected_date ? ` · expected ${esc(d.expected_date)}` : ''}</div>
${p.description ? `<p>${esc(p.description)}</p>` : ''}
<div class="card"><dl>${specs}</dl></div>
${p.care ? `<h2>Care</h2><p>${esc(p.care)}</p>` : ''}
${d.videos.length ? `<h2>Videos</h2>${d.videos.map(videoHtml).join('')}` : ''}
<div class="card" id="ask"><h2 style="margin-top:0">Interested?</h2>
<p>Show this screen to our showroom staff${d.showroom_contact ? `, or call ${esc(d.showroom_contact)}` : ''}. Or leave your details and we will get back to you.</p>
<form id="enq"><label>Your name<input name="name" maxlength="80" required></label><label>Phone<input name="phone" maxlength="20" inputmode="tel" required></label>
<label>Message (optional)<textarea name="message" maxlength="500" rows="2"></textarea></label><button class="btn">Send enquiry</button></form><p id="enqmsg" class="muted"></p></div>`;
  const script = `document.getElementById('enq').addEventListener('submit',function(e){e.preventDefault();var f=e.target,m=document.getElementById('enqmsg');
fetch('/api/public/p/${esc(token)}/enquiry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.name.value,phone:f.phone.value,message:f.message.value})})
.then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error);f.remove();m.textContent='Thank you — our team will contact you shortly.';});}).catch(function(err){m.textContent=err.message||'Could not send, please ask staff.';});});`;
  return shell(p.name, d.business_name, body, script);
}

function renderCataloguePage(d) {
  const items = d.items.map((it) => {
    const p = it.product;
    const prefs = [it.qty > 1 ? `Qty ${it.qty}` : '', it.preferred_finish ? `Finish: ${it.preferred_finish}` : '', it.preferred_dimensions ? `Size: ${it.preferred_dimensions}` : ''].filter(Boolean).join(' · ');
    return `<div class="card">${it.photos.length ? `<div class="gallery">${it.photos.map((ph) => `<figure><img src="${esc(ph.url)}" alt="${esc(p.name)}" loading="lazy"></figure>`).join('')}</div>` : ''}
<h2>${esc(p.name)}${p.variant ? ` — ${esc(p.variant)}` : ''}</h2>${it.price != null ? `<div class="price">${esc(money(it.price, d.currency))}</div>` : ''}
${prefs ? `<p class="muted">${esc(prefs)}</p>` : ''}<dl>${[['Dimensions', p.dimensions], ['Material', p.material], ['Finish', p.finish], ['Reference', it.piece_code || p.sku]].filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
${p.description ? `<p>${esc(p.description)}</p>` : ''}${it.videos.map((v) => `<div class="vmeta">▶ <a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a> · ${esc(v.scope_label)}</div>`).join('')}</div>`;
  }).join('');
  return shell(d.title, d.business_name, `<h1>${esc(d.title)}</h1><p class="muted">${esc(d.note)}</p>${items || '<p>No items.</p>'}`);
}

function renderNotAvailable(business) {
  return shell('Not available', business, '<h1>This page is not available</h1><p>Please ask our showroom staff for details about this item.</p>');
}

module.exports = { settings, publicItem, publicCatalogue, renderItemPage, renderCataloguePage, renderNotAvailable, DEFAULT_WORDING };
