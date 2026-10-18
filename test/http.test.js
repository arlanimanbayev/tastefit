import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SAMPLE_INPUT } from './helpers.js';
import plan from '../api/plan.js';
import replan from '../api/replan.js';
import health from '../api/health.js';

let server;
let base;
before(async () => {
  const routes = { '/api/plan': plan, '/api/replan': replan, '/api/health': health };
  server = http.createServer((req, res) => routes[new URL(req.url, 'http://x').pathname](req, res));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, accept = 'application/json') =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', accept }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('GET /api/health reports demo + scripted modes without keys', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.deepEqual((await res.json()).mode, { qloo: 'mock', agent: 'scripted', model: null });
});

test('POST /api/plan streams NDJSON: meta, trace steps, then the result', async () => {
  const res = await post('/api/plan', SAMPLE_INPUT, 'application/x-ndjson');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /ndjson/);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'meta');
  assert.ok(lines.filter((l) => l.type === 'trace').length >= 10);
  const result = lines.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.plan.slots.length, 4);
  assert.ok(result.session);
});

test('POST /api/plan returns plain JSON when not streaming', async () => {
  const res = await post('/api/plan', SAMPLE_INPUT);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan.slots.length, 4);
});

test('POST /api/plan validates input and methods', async () => {
  assert.equal((await post('/api/plan', { city: '', people: [] })).status, 400);
  assert.equal((await post('/api/plan', '{not json')).status, 400);
  assert.equal((await fetch(`${base}/api/plan`)).status, 405);
});

test('POST /api/replan round-trips the session from /api/plan', async () => {
  const planned = await (await post('/api/plan', SAMPLE_INPUT)).json();
  const res = await post('/api/replan', { session: planned.session, slot: 'dinner', instruction: 'cheaper' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changedSlot, 'dinner');
  assert.equal((await post('/api/replan', { instruction: 'cheaper' })).status, 400);
  assert.equal((await post('/api/replan', { session: { v: 0 }, instruction: 'cheaper' })).status, 400);
  const unclear = await post('/api/replan', { session: planned.session, instruction: 'hmm' });
  assert.equal(unclear.status, 422);
});
