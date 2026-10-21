// Regression tests for issues seen against the live Qloo hackathon API:
// noisy "shared taste" tags (dishes, prices, amenities) and an activity slot
// that could land on a sculpture or a sports arena.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockQloo, SAMPLE_INPUT } from './helpers.js';
import { planNight, pickTasteTags, ACTIVITY_CATEGORIES, TASTE_TAG_TYPES } from '../lib/agent.js';
import { createQlooClient } from '../lib/qloo.js';
import { createMockFetch } from '../lib/mock-qloo.js';
import { MOCK_API_KEY } from '../lib/mock-qloo.js';

test('pickTasteTags keeps genres only, trims and de-duplicates names', () => {
  const tags = [
    { id: 'urn:tag:specialty_dish:place:fish_chips', name: 'Fish Chips', type: 'urn:tag:specialty_dish:place', affinity: 1 },
    { id: 'urn:tag:cost_description:place:very_expensive', name: 'Very expensive', type: 'urn:tag:cost_description:place', affinity: 1 },
    { id: 'urn:tag:genre:music:indie', name: ' indie', type: 'urn:tag:genre:music', affinity: 0.989 },
    { id: 'urn:tag:genre:music:indie_2', name: 'Indie', type: 'urn:tag:genre:music', affinity: 0.98 },
    { id: 'urn:tag:genre:media:fiction', name: 'Fiction', type: 'urn:tag:genre:media', affinity: 0.981 },
    { id: 'urn:tag:genre:music:dream_pop', name: 'dream pop', type: 'urn:tag:genre:music', affinity: 0.976 },
  ];
  const out = pickTasteTags(tags);
  assert.deepEqual(out.map((t) => t.name), ['Indie', 'Fiction', 'Dream pop']);
  assert.ok(out.every((t) => TASTE_TAG_TYPES.some((p) => t.id.startsWith(p))));
});

test('activity request asks Qloo for occasion-appropriate place categories', async () => {
  const urls = [];
  const inner = createMockFetch();
  const spy = (url, init) => {
    urls.push(new URL(String(url)));
    return inner(url, init);
  };
  const qloo = createQlooClient({ apiKey: MOCK_API_KEY, baseUrl: 'https://demo.qloo.invalid', fetchImpl: spy, mode: 'mock', cache: null });
  const { plan } = await planNight(structuredClone(SAMPLE_INPUT), { qloo, llm: null });

  const placeCalls = urls.filter((u) => u.pathname.endsWith('/v2/insights') && u.searchParams.get('filter.type') === 'urn:entity:place');
  const activityCall = placeCalls.find((u) => (u.searchParams.get('filter.exclude.tags') || '').includes('urn:tag:genre:place:restaurant'));
  assert.ok(activityCall, 'an activity insights call was made');
  const include = activityCall.searchParams.get('filter.tags').split(',');
  for (const t of ['urn:tag:category:place:bar', 'urn:tag:category:place:live_music_venue', 'urn:tag:category:place:comedy_club']) {
    assert.ok(include.includes(t), `night out asks for ${t}`);
  }
  assert.ok(activityCall.searchParams.get('filter.exclude.tags').includes('urn:tag:category:place:arena'));

  const tagCall = urls.find((u) => u.searchParams.get('filter.type') === 'urn:tag');
  assert.equal(tagCall.searchParams.get('filter.tag.types'), TASTE_TAG_TYPES.join(','));
  assert.ok(plan.tasteProfile.length > 0, 'shared tastes still returned');
  assert.ok(plan.tasteProfile.every((t) => /genre:(music|media)/.test(t.id)));
});

test('day out uses daytime categories', () => {
  assert.ok(ACTIVITY_CATEGORIES.day_out.includes('urn:tag:category:place:museum'));
  assert.ok(!ACTIVITY_CATEGORIES.day_out.includes('urn:tag:category:place:night_club'));
});

test('food favourites resolve to restaurant-genre tags and dinner serves one of them', async () => {
  const { plan } = await planNight(structuredClone(SAMPLE_INPUT), { qloo: mockQloo(), llm: null });
  const dinner = plan.slots.find((s) => s.slot === 'dinner');
  assert.ok(dinner, 'dinner slot present');
  const cuisineFit = dinner.fits.find((f) => /love of/i.test(f.because || ''));
  assert.ok(cuisineFit, 'at least one person gets the dinner because of their cuisine');
  assert.equal(cuisineFit.level, 'great');
});

test('client retries HTTP 429 (rate limit) and paces live calls', async () => {
  let n = 0;
  const starts = [];
  const fakeFetch = async () => {
    starts.push(Date.now());
    n += 1;
    if (n <= 2) return new Response('{"error_msg":"Rate limit exceeded"}', { status: 429 });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  const qloo = createQlooClient({ apiKey: 'k', baseUrl: 'https://example.test', fetchImpl: fakeFetch, cache: null, minIntervalMs: 40 });
  const body = await qloo.search({ query: 'x' });
  assert.deepEqual(body, { results: [] });
  assert.equal(n, 3, 'two rate-limited attempts, then success');
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= 35, 'calls are spaced out');
});
