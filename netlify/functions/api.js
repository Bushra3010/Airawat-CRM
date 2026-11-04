'use strict';
// Netlify Function wrapping the Express app. Static files (public/) are served by Netlify's CDN;
// /api/*, /p/* and /c/* are routed here by netlify.toml.
const serverless = require('serverless-http');
const { open } = require('../../src/db');
const { createApp } = require('../../src/server');
const { ensureReady } = require('../../src/bootstrap');

const db = open(process.env.DATABASE_URL, { max: Number(process.env.DB_POOL_MAX || 6) });
const handler = serverless(createApp({ db, serveStatic: false, ready: () => ensureReady(db) }), { binary: ['application/pdf'] });
const PREFIX = '/.netlify/functions/api';

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event.path && event.path.startsWith(PREFIX)) event.path = event.path.slice(PREFIX.length) || '/';
  return handler(event, context);
};
