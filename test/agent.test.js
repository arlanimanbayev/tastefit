import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockQloo, fakeGemini, lastToolResult, SAMPLE_INPUT } from './helpers.js';
import { planNight, validatePlanInput, isFoodish, TOOL_DECLARATIONS, insightsResilient } from '../lib/agent.js';
import { createQlooClient, QlooError } from '../lib/qloo.js';
import { createMockFetch } from '../lib/mock-qloo.js';

const input = () => validatePlanInput(structuredClone(SAMPLE_INPUT)).value;

function assertValidPlan(plan) {
  assert.equal(plan.slots.length, 4);
  assert.deepEqual(plan.slots.map((s) => s.slot), ['dinner', 'activity', 'film', 'music']);
  for (const s of plan.slots) {
    assert.ok(!s.empty, `${s.slot} has a pick`);
    assert.ok(s.pick.name, `${s.slot} pick has a name`);
    assert.ok(s.reason && s.reason.length > 10, `${s.slot} has a reason`);
    assert.equal(s.fits.length, 3);
    for (const f of s.fits) assert.ok(['great', 'good', 'stretch', 'unknown'].includes(f.level));
  }
  assert.equal(plan.slots.find((s) => s.slot === 'music').tracks.length, 6);
  assert.equal(plan.fairness.length, 3);
}

test('validatePlanInput rejects bad input and cleans good input', () => {
  assert.match(validatePlanInput({ people: [] }).error, /city/);
  assert.match(validatePlanInput({ city: 'X', people: [{ name: 'A', favorites: ['x'] }] }).error, /two people/);
  assert.match(validatePlanInput({ city: 'X', people: [{ name: 'A', favorites: ['x'] }, { name: 'B', favorites: [] }] }).error, /two people one favourite/);
  const ok = validatePlanInput({
    city: '  Paris  ',
    budget: 9,
    occasion: 'party',
    people: [
      { name: 'Ana', favorites: ['Amélie', { text: 'x'.repeat(200), kind: 'film' }] },
      { name: 'ana', favorites: [{ text: 'Coco', kind: 'weird' }] },
      ...Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, favorites: ['Jazz'] })),
    ],
  }).value;
  assert.equal(ok.city, 'Paris');
  assert.equal(ok.budget, 2);
  assert.equal(ok.occasion, 'night_out');
  assert.equal(ok.people.length, 5);
  assert.equal(ok.people[1].name, 'ana 2', 'duplicate names are disambiguated');
  assert.equal(ok.people[0].favorites[1].text.length, 60);
  assert.equal(ok.people[1].favorites[0].kind, 'auto');
});

test('isFoodish spots dishes and cuisines', () => {
  assert.ok(isFoodish('Korean food'));
  assert.ok(isFoodish('tacos'));
  assert.ok(!isFoodish('Phoebe Bridgers'));
});

test('scripted planner (no Gemini key) produces a complete, grounded plan', async () => {
  const qloo = mockQloo();
  const events = [];
  const { plan, session, trace } = await planNight(input(), { qloo, llm: null, emit: (e) => events.push(e) });
  assertValidPlan(plan);
  assert.equal(plan.mode.agent, 'scripted');
  assert.equal(plan.mode.qloo, 'mock');
  assert.equal(plan.stats.favoritesResolved, 10);
  // Every tool ran and was streamed.
  const tools = new Set(trace.map((t) => t.tool).filter(Boolean));
  for (const t of ['qloo_search', 'qloo_insights', 'group_overlap', 'finalize_plan']) assert.ok(tools.has(t), `trace has ${t}`);
  assert.equal(events[0].type, 'meta');
  assert.ok(events.filter((e) => e.type === 'trace').length >= trace.length);
  // Group call + one ranking call per person per slot.
  const insightCalls = qloo.calls.filter((c) => c.path === '/v2/insights');
  assert.ok(insightCalls.some((c) => c.params['filter.results.entities']), 'per-person ranking calls were made');
  assert.ok(insightCalls.some((c) => c.params['filter.type'] === 'urn:tag'), 'taste profile call was made');
  const dinnerGroup = insightCalls.find((c) => c.params['filter.location.query'] === 'Chicago' && c.params['filter.tags']);
  assert.ok(dinnerGroup.params['signal.interests.tags'].length >= 2, 'cuisine tags are sent as signals');
  // Nobody is left without a great non-playlist pick in the sample group.
  for (const f of plan.fairness) assert.ok(f.great.filter((l) => l !== 'Playlist').length >= 1, `${f.person} gets a great fit`);
  // The group's own favourites are never recommended back.
  assert.ok(!plan.slots.some((s) => ['Parasite', 'Lady Bird', 'Blade Runner 2049'].includes(s.pick.name)));
  assert.ok(session.v === 1 && session.slots.dinner.candidates.length > 0);
});

test('Gemini loop: tools are declared, thought signatures round-trip, LLM picks are validated', async () => {
  const { requests, llm } = fakeGemini((turn, body) => {
    if (turn === 0)
      return {
        parts: [
          {
            functionCall: { id: 'c1', name: 'qloo_search', args: { items: SAMPLE_INPUT.people.flatMap((p) => p.favorites.map((f) => ({ person: p.name, text: f.text, kind: f.kind }))) } },
            thoughtSignature: 'sig-0',
          },
        ],
      };
    if (turn === 1)
      return {
        parts: ['taste_profile', 'dinner', 'activity', 'film', 'music'].map((slot, i) => ({
          functionCall: { id: `i${i}`, name: 'qloo_insights', args: { slot } },
          ...(i === 0 ? { thoughtSignature: 'sig-1' } : {}),
        })),
      };
    if (turn === 2) return { parts: [{ functionCall: { id: 'o1', name: 'group_overlap', args: {} } }] };
    const rec = lastToolResult(body, 'group_overlap').recommended;
    return {
      parts: [
        {
          functionCall: {
            id: 'f1',
            name: 'finalize_plan',
            args: {
              headline: 'Korean barbecue, live music, then a mind-bender',
              playlist_title: 'Grill to Groove',
              picks: [
                { slot: 'dinner', entity_id: rec.dinner.entity_id, reason: "Ben's love of Korean food leads here, and Cleo is a good match too." },
                { slot: 'activity', entity_id: rec.activity.entity_id, reason: 'A great room for everyone tonight.' }, // names nobody: rejected
                { slot: 'film', entity_id: 'NOT-A-QLOO-ID', reason: 'Ana will love this one, trust me.' }, // invalid id: corrected
                { slot: 'music', reason: 'Hozier for Ana, IU for Ben and Radiohead for Cleo.' },
              ],
            },
          },
        },
      ],
    };
  });
  const { plan } = await planNight(input(), { qloo: mockQloo(), llm });
  assertValidPlan(plan);
  assert.equal(plan.mode.agentUsed, 'gemini');
  assert.equal(plan.stats.modelTurns, 4);
  assert.equal(requests.length, 4);

  const first = requests[0];
  assert.match(first.url, /\/v1beta\/models\/test-model:generateContent$/);
  assert.equal(first.headers['x-goog-api-key'], 'gemini-test-key');
  assert.deepEqual(first.body.tools[0].functionDeclarations.map((d) => d.name), TOOL_DECLARATIONS.map((d) => d.name));
  assert.equal(first.body.toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.match(first.body.contents[0].parts[0].text, /Ana: Phoebe Bridgers/);

  // Model turn echoed verbatim (thought signature preserved), then a functionResponse turn.
  const second = requests[1].body.contents;
  assert.equal(second[1].role, 'model');
  assert.equal(second[1].parts[0].thoughtSignature, 'sig-0');
  assert.equal(second[2].role, 'user');
  assert.equal(second[2].parts[0].functionResponse.name, 'qloo_search');
  assert.equal(second[2].parts[0].functionResponse.id, 'c1');
  assert.equal(requests[2].body.contents[4].parts.length, 5, 'five parallel insights results returned together');

  const bySlot = Object.fromEntries(plan.slots.map((s) => [s.slot, s]));
  assert.equal(bySlot.dinner.reasonBy, 'gemini');
  assert.match(bySlot.dinner.reason, /Ben's love of Korean food/);
  assert.equal(bySlot.activity.reasonBy, 'template', 'a reason that names nobody is replaced');
  assert.notEqual(bySlot.film.pick.id, 'NOT-A-QLOO-ID');
  assert.equal(bySlot.film.reasonBy, 'template', 'reason written for an invalid pick is replaced');
  assert.equal(bySlot.music.pick.name, 'Grill to Groove');
  assert.equal(plan.headline, 'Korean barbecue, live music, then a mind-bender');
});

test('Gemini errors fall back to the scripted planner and still return a valid plan', async () => {
  const { llm } = fakeGemini(() => ({ status: 503, message: 'model overloaded' }));
  const { plan, trace } = await planNight(input(), { qloo: mockQloo(), llm });
  assertValidPlan(plan);
  assert.equal(plan.mode.agentUsed, 'scripted-fallback');
  assert.ok(trace.some((t) => /Gemini was unavailable/.test(t.title)));
});

test('if Gemini stops early, the scripted policy finishes the remaining steps', async () => {
  const { llm } = fakeGemini((turn) => (turn === 0 ? { parts: [{ functionCall: { name: 'qloo_insights', args: { slot: 'film' } } }] } : { parts: [{ text: 'All done.' }] }));
  const { plan, trace } = await planNight(input(), { qloo: mockQloo(), llm });
  assertValidPlan(plan);
  assert.equal(plan.mode.agentUsed, 'gemini');
  assert.ok(trace.some((t) => t.tool === 'finalize_plan' && t.by === 'scripted'));
});

test('a tight time budget skips the LLM and still returns a valid plan', async () => {
  const { requests, llm } = fakeGemini(() => ({ parts: [{ text: 'never called' }] }));
  const { plan, trace } = await planNight(input(), { qloo: mockQloo(), llm, budgetMs: 4000 });
  assertValidPlan(plan);
  assert.equal(requests.length, 0);
  assert.ok(trace.some((t) => /Time budget reached/.test(t.title)));
});

test('unknown favourites are reported, not invented', async () => {
  const data = validatePlanInput({
    city: 'Chicago',
    people: [
      { name: 'Ana', favorites: ['Phoebe Bridgers', 'Zxqv Nonexistent Band 12345'] },
      { name: 'Ben', favorites: ['Parasite'] },
    ],
  }).value;
  const { plan } = await planNight(data, { qloo: mockQloo(), llm: null });
  const ana = plan.people.find((p) => p.name === 'Ana');
  assert.equal(ana.favorites[1].status, 'missing');
  assert.equal(ana.favorites[1].match, null);
  assert.equal(plan.stats.favoritesResolved, 2);
});

test('insightsResilient drops uncertain params on a 4xx, but not on auth errors', async () => {
  const seen = [];
  const picky = {
    insights: async (p) => {
      seen.push(Object.keys(p));
      if (p['feature.explainability']) throw new QlooError('unknown feature', { status: 400 });
      if (p['filter.tags']) throw new QlooError('unknown tag', { status: 400 });
      return { results: { entities: [{ entity_id: 'X', name: 'Somewhere', query: { affinity: 0.9 } }] } };
    },
  };
  const out = await insightsResilient(picky, { 'filter.type': 'urn:entity:place', 'filter.tags': 'urn:tag:x', 'operator.filter.tags': 'union', 'feature.explainability': true });
  assert.equal(seen.length, 3);
  assert.equal(out.entities[0].name, 'Somewhere');
  assert.ok(!('filter.tags' in out.params) && !('feature.explainability' in out.params));

  const denied = { insights: async () => { throw new QlooError('bad key', { status: 401 }); } };
  await assert.rejects(insightsResilient(denied, { 'filter.type': 'urn:entity:place', 'feature.explainability': true }), /bad key/);
});

test('a plan still completes when Qloo rejects the restaurant category tag', async () => {
  const mock = createMockFetch();
  const strict = async (url, init) => {
    if (new URL(url).searchParams.get('filter.tags')?.includes('urn:tag:genre:place:restaurant')) {
      return new Response(JSON.stringify({ error: { message: 'invalid filter.tags' } }), { status: 400 });
    }
    return mock(url, init);
  };
  const qloo = createQlooClient({ apiKey: 'demo', baseUrl: 'https://demo.qloo.invalid', fetchImpl: strict, cache: null, mode: 'mock' });
  const { plan } = await planNight(input(), { qloo, llm: null });
  assertValidPlan(plan);
  const dinner = plan.slots.find((s) => s.slot === 'dinner');
  assert.equal(dinner.evidence.relaxed, true);
  assert.ok(!('filter.tags' in dinner.evidence.request.params));
});
