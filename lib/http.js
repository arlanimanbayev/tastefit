/**
 * HTTP glue shared by the Vercel functions in api/ and by dev-server.js.
 * Uses only the plain Node (req, res) API so it runs the same in both places.
 *
 * Responses stream as NDJSON when the client sends `Accept: application/x-ndjson`
 * (one {type:'trace'} line per agent step, then {type:'result'}); otherwise the
 * handler returns a single JSON document.
 */
import { depsFromEnv, planNight, replanSlot, validatePlanInput, modeInfo } from './agent.js';

const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJson(req) {
  // Vercel pre-parses JSON bodies; reading req.body can throw on malformed JSON.
  try {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// --- Rate limiting (per warm instance; protects the shared API quota) -------
const windows = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { plan: 30, replan: 90 };

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
}

export function rateLimited(req, bucket, env = process.env) {
  if (env.RATE_LIMIT === 'off') return false;
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const hits = (windows.get(key) || []).filter((t) => now - t < WINDOW_MS);
  const limit = Number(env[`RATE_LIMIT_${bucket.toUpperCase()}`]) || LIMITS[bucket];
  if (hits.length >= limit) {
    windows.set(key, hits);
    return true;
  }
  hits.push(now);
  windows.set(key, hits);
  if (windows.size > 5000) windows.delete(windows.keys().next().value);
  return false;
}

// --- Streaming ---------------------------------------------------------------
const wantsStream = (req) => String(req.headers.accept || '').includes('application/x-ndjson');

async function respond(req, res, run) {
  if (!wantsStream(req)) {
    const result = await run(() => {});
    if (result?.error) return sendJson(res, 422, { error: result.error });
    return sendJson(res, 200, result);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const write = (obj) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
  };
  try {
    const result = await run(write);
    if (result?.error) write({ type: 'error', message: result.error });
    else write({ type: 'result', ...result });
  } catch (err) {
    console.error('[tastefit] agent error:', err?.message);
    write({ type: 'error', message: publicMessage(err) });
  }
  res.end();
}

function publicMessage(err) {
  if (err instanceof HttpError) return err.message;
  if (/expired|Add a city|Add at least|Give at least/.test(err?.message || '')) return err.message;
  return 'Something went wrong while planning. Try again in a moment.';
}

function guard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error('[tastefit] request failed:', err?.message);
      if (!res.headersSent) sendJson(res, err instanceof HttpError ? err.status : 500, { error: publicMessage(err) });
      else res.end();
    }
  };
}

// --- Handlers ----------------------------------------------------------------
export const handlePlan = guard(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
  if (rateLimited(req, 'plan')) return sendJson(res, 429, { error: 'Too many plans from this connection. Wait a few minutes and try again.' });
  const body = await readJson(req);
  const input = validatePlanInput(body);
  if (input.error) return sendJson(res, 400, { error: input.error });
  const deps = depsFromEnv();
  await respond(req, res, (emit) => planNight(input.value, { ...deps, emit }));
});

export const handleReplan = guard(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
  if (rateLimited(req, 'replan')) return sendJson(res, 429, { error: 'Too many changes from this connection. Wait a few minutes and try again.' });
  const body = await readJson(req);
  if (!body?.session) return sendJson(res, 400, { error: 'This plan has expired. Plan the night again.' });
  if (!String(body.instruction || '').trim() && !body.slot) return sendJson(res, 400, { error: 'Say what to change, for example “cheaper” or “no sushi”.' });
  const deps = depsFromEnv();
  await respond(req, res, async (emit) => {
    try {
      return await replanSlot(body.session, { slot: body.slot, instruction: body.instruction }, { ...deps, emit });
    } catch (err) {
      if (/expired|Add a|Give at least/.test(err.message)) throw new HttpError(400, err.message);
      throw err;
    }
  });
});

export const handleHealth = guard(async (req, res) => {
  const deps = depsFromEnv();
  sendJson(res, 200, { ok: true, mode: modeInfo(deps) });
});
