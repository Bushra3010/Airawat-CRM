'use strict';
/**
 * Product photo storage. Uses a public Supabase Storage bucket when SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are set (required on Netlify, whose disk is temporary);
 * otherwise saves to a local folder for development.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUCKET = process.env.PHOTO_BUCKET || 'product-photos';

function supabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

const headers = (key, extra = {}) => ({ Authorization: `Bearer ${key}`, apikey: key, ...extra });

/** Create the public photo bucket if it does not exist. */
async function ensureBucket() {
  const sb = supabase();
  if (!sb) return false;
  const r = await fetch(`${sb.url}/storage/v1/bucket`, {
    method: 'POST', headers: headers(sb.key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 6 * 1024 * 1024, allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'] }),
  });
  if (!r.ok) {
    const body = await r.text();
    if (!/already exists|Duplicate/i.test(body)) throw new Error(`Could not create storage bucket: ${r.status} ${body}`);
  }
  return true;
}

/** Store an image buffer; returns { url, storage_path }. */
async function savePhoto(buf, ext, { uploadDir }) {
  const name = `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const sb = supabase();
  if (sb) {
    const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const upload = () => fetch(`${sb.url}/storage/v1/object/${BUCKET}/${name}`, { method: 'POST', headers: headers(sb.key, { 'Content-Type': type, 'x-upsert': 'false' }), body: buf });
    let r = await upload();
    if (r.status === 404 || r.status === 400) {   // bucket missing (e.g. deleted in the dashboard): recreate once
      await ensureBucket();
      r = await upload();
    }
    if (!r.ok) throw Object.assign(new Error(`Photo upload failed (${r.status})`), { status: 502 });
    return { url: `${sb.url}/storage/v1/object/public/${BUCKET}/${name}`, storage_path: name };
  }
  const file = path.join(uploadDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return { url: `/uploads/${name}`, storage_path: null };
}

async function deletePhoto(storagePath) {
  const sb = supabase();
  if (!sb || !storagePath) return;
  await fetch(`${sb.url}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE', headers: headers(sb.key, { 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: [storagePath] }),
  }).catch(() => {});
}

module.exports = { ensureBucket, savePhoto, deletePhoto, supabase, BUCKET };
