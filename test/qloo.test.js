import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildQlooUrl,
  createQlooClient,
  createTtlCache,
  entitiesFrom,
  tagsFrom,
  normalizeEntity,
  normalizeTag,
  parseExplainability,
  kindFromType,
  QlooError,
  QLOO_DEFAULT_BASE_URL,
} from '../lib/qloo.js';
import { createMockFetch } from '../lib/mock-qloo.js';

const sample = (name) => JSON.parse(readFileSync(new URL(`../data/fixtures/samples/${name}`, import.meta.url), 'utf8'));

/** Fake fetch that records requests and replays canned responses. */
function recorder(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = typeof responses === 'function' ? responses(calls.length) : responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
}

test('buildQlooUrl joins arrays with commas and drops empty values', () => {
  const url = buildQlooUrl(QLOO_DEFAULT_BASE_URL, '/v2/insights', {
    'filter.type': 'urn:entity:place',
    'signal.interests.entities': ['A', 'B', '', null],
    'filter.location.query': 'New York',
    take: 8,
    'feature.explainability': true,
    'filter.tags': '',
    skipped: undefined,
  });
  assert.equal(url.origin + url.pathname, 'https://api.qloo.com/v2/insights');
  assert.equal(url.searchParams.get('signal.interests.entities'), 'A,B');
  assert.equal(url.searchParams.get('filter.location.query'), 'New York');
  assert.equal(url.searchParams.get('take'), '8');
  assert.equal(url.searchParams.get('feature.explainability'), 'true');
  assert.equal(url.searchParams.has('filter.tags'), false);
  assert.equal(url.searchParams.has('skipped'), false);
});

test('buildQlooUrl keeps a base path and refuses plain http', () => {
  assert.equal(buildQlooUrl('https://gateway.example.com/qloo/', 'search', { query: 'x' }).pathname, '/qloo/search');
  assert.throws(() => buildQlooUrl('http://api.qloo.com', '/search', {}), QlooError);
  assert.doesNotThrow(() => buildQlooUrl('http://localhost:9999', '/search', {}));
});

test('client sends GET with X-Api-Key and never puts the key in the URL', async () => {
  const { calls, fetchImpl } = recorder([{ body: sample('search-phoebe-bridgers.json') }]);
  const client = createQlooClient({ apiKey: 'secret-key', fetchImpl, cache: null });
  const res = await client.search({ query: 'Phoebe Bridgers', types: 'urn:entity:artist', take: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'secret-key');
  assert.equal(calls[0].url.pathname, '/search');
  assert.equal(calls[0].url.searchParams.get('types'), 'urn:entity:artist');
  assert.ok(!calls[0].url.toString().includes('secret-key'));
  assert.equal(entitiesFrom(res)[0].name, 'Phoebe Bridgers');
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, '/search');
});

test('client retries 429 once, then succeeds', async () => {
  const { calls, fetchImpl } = recorder([{ status: 429, body: { message: 'slow down' } }, { body: { results: [] } }]);
  const client = createQlooClient({ apiKey: 'k', fetchImpl, cache: null });
  await client.insights({ 'filter.type': 'urn:entity:movie' });
  assert.equal(calls.length, 2);
});

test('client does not retry 400 and surfaces the API message', async () => {
  const { calls, fetchImpl } = recorder([{ status: 400, body: { error: { message: 'bad filter.type' } } }, { body: {} }]);
  const client = createQlooClient({ apiKey: 'k', fetchImpl, cache: null });
  await assert.rejects(client.insights({ 'filter.type': 'nope' }), (err) => err instanceof QlooError && err.status === 400 && /bad filter.type/.test(err.message));
  assert.equal(calls.length, 1);
});

test('client turns network failures into retryable QlooError', async () => {
  const { calls, fetchImpl } = recorder(() => new TypeError('fetch failed'));
  const client = createQlooClient({ apiKey: 'k', fetchImpl, cache: null, maxAttempts: 2 });
  await assert.rejects(client.search({ query: 'x' }), (err) => err instanceof QlooError && err.retryable);
  assert.equal(calls.length, 2);
});

test('client caches identical requests', async () => {
  const { calls, fetchImpl } = recorder(() => ({ body: { results: [] } }));
  const client = createQlooClient({ apiKey: 'k', fetchImpl, cache: createTtlCache() });
  await client.search({ query: 'same' });
  await client.search({ query: 'same' });
  assert.equal(calls.length, 1);
  assert.equal(client.calls.filter((c) => c.cached).length, 1);
});

test('client requires an API key', () => {
  assert.throws(() => createQlooClient({}), QlooError);
});

test('parses /search results (array shape)', () => {
  const [e] = entitiesFrom(sample('search-phoebe-bridgers.json')).map(normalizeEntity);
  assert.equal(e.name, 'Phoebe Bridgers');
  assert.equal(e.type, 'urn:entity:artist');
  assert.equal(e.kind, 'music');
  assert.match(e.id, /^[0-9A-F-]{36}$/);
  assert.ok(e.tags.some((t) => t.name === 'Indie Folk'));
});

test('parses /v2/insights results (results.entities shape) with affinity and explainability', () => {
  const list = entitiesFrom(sample('insights-dinner-chicago.json')).map(normalizeEntity);
  assert.equal(list.length, 3);
  for (const e of list) {
    assert.equal(e.type, 'urn:entity:place');
    assert.equal(typeof e.affinity, 'number');
    assert.ok(e.address.endsWith('Chicago'));
    assert.ok(e.priceLevel >= 1 && e.priceLevel <= 4);
    assert.ok(Array.isArray(e.explain) && e.explain.length === 1);
  }
  assert.ok(list[0].affinity >= list[1].affinity, 'sorted by affinity');
});

test('normalizeEntity tolerates variant field shapes', () => {
  const [film, bistro, ...rest] = entitiesFrom(sample('insights-variant-shapes.json')).map(normalizeEntity);
  assert.equal(rest.filter(Boolean).length, 0, 'entity without id is dropped');
  assert.equal(film.id, '0B5E1C02-2C0F-4E8A-9D5D-3F1C1C9E7A11');
  assert.equal(film.kind, 'film');
  assert.equal(film.year, 2019);
  assert.equal(film.popularity, 0.81);
  assert.equal(film.image, 'https://images.example.com/film.jpg');
  assert.deepEqual(film.explain, [{ id: 'AAA-1', score: 0.7 }, { id: 'BBB-2', score: 0.2 }]);
  assert.equal(film.tags[0].id, 'urn:tag:genre:media:drama');
  assert.equal(bistro.type, 'urn:entity:place');
  assert.equal(bistro.address, '12 Example St, Springfield');
  assert.equal(bistro.image, undefined, 'non-https images are dropped');
  assert.equal(bistro.lat, 41.9);
  assert.equal(bistro.lon, -87.6);
});

test('parses /v2/tags results', () => {
  const tags = tagsFrom(sample('tags-korean.json')).map(normalizeTag);
  assert.equal(tags[0].id, 'urn:tag:genre:place:restaurant:korean');
  assert.ok(tags[0].parents.includes('urn:entity:place'));
});

test('parseExplainability handles arrays, maps and junk', () => {
  assert.deepEqual(parseExplainability({ 'signal.interests.entities': [{ entity_id: 'a', score: 0.2 }, { entity_id: 'b', score: 0.9 }] }), [
    { id: 'b', score: 0.9 },
    { id: 'a', score: 0.2 },
  ]);
  assert.deepEqual(parseExplainability([{ id: 'x', weight: '0.5' }]), [{ id: 'x', score: 0.5 }]);
  assert.deepEqual(parseExplainability('nonsense'), []);
  assert.deepEqual(parseExplainability(null), []);
});

test('kindFromType maps entity URNs to UI kinds', () => {
  assert.equal(kindFromType('urn:entity:tv_show'), 'tv');
  assert.equal(kindFromType('urn:entity:place:restaurant'), 'place');
  assert.equal(kindFromType('urn:tag:genre:place:restaurant:thai'), 'food');
});

test('mock backend answers the same URLs as the real API', async () => {
  const client = createQlooClient({ apiKey: 'demo', baseUrl: 'https://demo.qloo.invalid', fetchImpl: createMockFetch(), cache: null, mode: 'mock' });
  const search = entitiesFrom(await client.search({ query: 'Parasite', types: 'urn:entity:movie' })).map(normalizeEntity);
  assert.equal(search[0].name, 'Parasite');
  const ranked = entitiesFrom(
    await client.insights({ 'filter.type': 'urn:entity:movie', 'signal.interests.entities': [search[0].id], 'filter.results.entities': [search[0].id], take: 5 }),
  );
  assert.equal(ranked.length, 1, 'filter.results.entities restricts the candidate set');
  const tagged = tagsFrom(await client.insights({ 'filter.type': 'urn:tag', 'signal.interests.entities': [search[0].id], take: 3 })).map(normalizeTag);
  assert.equal(tagged.length, 3);
  assert.equal(typeof tagged[0].affinity, 'number');
});

test('mock backend rejects requests without X-Api-Key', async () => {
  const res = await createMockFetch()('https://demo.qloo.invalid/search?query=x', { headers: {} });
  assert.equal(res.status, 401);
});
