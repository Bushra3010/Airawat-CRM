// Cloudflare Worker entry. Static files (public/) are served by Workers Static Assets;
// /api/*, /p/* and /c/* run the same Express app as Netlify/local, via workerd's Node HTTP server support.
//
// Workers can't reuse a database socket across requests, so each request opens its own
// small pool. The Express app is built once and reaches that pool through AsyncLocalStorage.
import { AsyncLocalStorage } from 'node:async_hooks';
import { httpServerHandler } from 'cloudflare:node';
import { open } from '../src/db.js';
import { createApp } from '../src/server.js';
import { ensureReady } from '../src/bootstrap.js';

const PORT = 8080;
const als = new AsyncLocalStorage();

function requestDb() {
  const store = als.getStore();
  if (!store) throw new Error('No database for this request');
  if (!store.db) {
    // Hyperdrive's endpoint is inside Cloudflare's network and talks plain Postgres; it connects to Supabase over TLS.
    const hd = store.env.HYPERDRIVE;
    store.db = hd ? open(hd.connectionString, { max: 2, ssl: false }) : open(process.env.DATABASE_URL, { max: 2 });
  }
  return store.db;
}
// Looks like the db object from src/db.js, but resolves to the current request's pool.
const db = new Proxy({}, { get: (_, key) => requestDb()[key] });

createApp({ db, serveStatic: false, ready: () => ensureReady(db) }).listen(PORT);
const server = httpServerHandler({ port: PORT });

export default {
  async fetch(request, env, ctx) {
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || '127.0.0.1');
    headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
    const store = { env };
    try {
      return await als.run(store, () => server.fetch(new Request(request, { headers }), env, ctx));
    } finally {
      if (store.db) ctx.waitUntil(store.db.close().catch(() => {}));
    }
  },
};
