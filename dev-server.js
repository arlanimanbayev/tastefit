#!/usr/bin/env node
/**
 * Zero-dependency local server: serves public/ and routes /api/* to the same
 * handlers Vercel runs. Loads a local .env file if present (never committed).
 *
 *   node dev-server.js            # http://localhost:3000
 *   PORT=8080 node dev-server.js
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');

// Minimal .env loader: KEY=value lines; existing env vars win.
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const routes = {
  '/api/plan': (await import('./api/plan.js')).default,
  '/api/replan': (await import('./api/replan.js')).default,
  '/api/health': (await import('./api/health.js')).default,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Same security headers as vercel.json.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(publicDir, pathname));
  if (!file.startsWith(publicDir + sep) && file !== publicDir) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const { pathname } = new URL(req.url, 'http://localhost');
  const handler = routes[pathname.replace(/\/+$/, '')];
  if (handler) return handler(req, res);
  if (pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Unknown API route.' }));
  }
  return serveStatic(req, res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  const qloo = process.env.QLOO_API_KEY ? 'live Qloo API' : 'demo data (no QLOO_API_KEY)';
  const agent = process.env.GEMINI_API_KEY ? `Gemini ${process.env.GEMINI_MODEL || 'default model'}` : 'scripted planner (no GEMINI_API_KEY)';
  console.log(`TasteFit running at http://localhost:${port}  [${qloo}; ${agent}]`);
});
