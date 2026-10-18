import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockQloo, fakeGemini, lastToolResult, SAMPLE_INPUT } from './helpers.js';
import { planNight, replanSlot, validatePlanInput } from '../lib/agent.js';

async function basePlan() {
  return planNight(validatePlanInput(structuredClone(SAMPLE_INPUT)).value, { qloo: mockQloo(), llm: null });
}
const names = (plan) => Object.fromEntries(plan.slots.map((s) => [s.slot, s.pick.name]));
const roundTrip = (session) => JSON.parse(JSON.stringify(session)); // as the browser would send it

test('replan swaps only the requested slot', async () => {
  const before = await basePlan();
  const after = await replanSlot(roundTrip(before.session), { slot: 'film', instruction: 'something else' }, { qloo: mockQloo(), llm: null });
  assert.equal(after.changedSlot, 'film');
  const a = names(before.plan);
  const b = names(after.plan);
  assert.notEqual(b.film, a.film);
  assert.equal(b.dinner, a.dinner);
  assert.equal(b.activity, a.activity);
  assert.equal(b.music, a.music);
  assert.match(after.message, /^Swapped film:/);
});

test('"cheaper" lowers the price level and keeps the rest of the night', async () => {
  const before = await basePlan();
  const oldDinner = before.plan.slots.find((s) => s.slot === 'dinner').pick;
  const after = await replanSlot(roundTrip(before.session), { slot: 'dinner', instruction: 'cheaper' }, { qloo: mockQloo(), llm: null });
  const newDinner = after.plan.slots.find((s) => s.slot === 'dinner');
  assert.ok(newDinner.pick.priceLevel < oldDinner.priceLevel, `${newDinner.pick.priceLevel} < ${oldDinner.priceLevel}`);
  assert.ok(newDinner.evidence.constraints.some((c) => c.startsWith('price level')));
  assert.equal(names(after.plan).film, names(before.plan).film);
});

test('"no sushi" excludes sushi, and constraints persist across later swaps', async () => {
  const before = await basePlan();
  const first = await replanSlot(roundTrip(before.session), { slot: 'dinner', instruction: 'no sushi and no korean' }, { qloo: mockQloo(), llm: null });
  const pick = first.plan.slots.find((s) => s.slot === 'dinner').pick;
  assert.ok(!/sushi|korean|omakase/i.test(`${pick.name} ${pick.tags.join(' ')}`), pick.name);
  const second = await replanSlot(roundTrip(first.session), { slot: 'dinner', instruction: 'something different' }, { qloo: mockQloo(), llm: null });
  const pick2 = second.plan.slots.find((s) => s.slot === 'dinner').pick;
  assert.ok(!/sushi|korean|omakase/i.test(`${pick2.name} ${pick2.tags.join(' ')}`), pick2.name);
  assert.notEqual(pick2.name, pick.name);
});

test('"closer" moves the after-dinner stop nearer to dinner', async () => {
  const before = await basePlan();
  const d0 = before.plan.slots.find((s) => s.slot === 'activity').distanceKm;
  const after = await replanSlot(roundTrip(before.session), { slot: 'activity', instruction: 'closer please' }, { qloo: mockQloo(), llm: null });
  const d1 = after.plan.slots.find((s) => s.slot === 'activity').distanceKm;
  assert.ok(d1 < d0, `${d1} < ${d0}`);
});

test('the chat box can name the slot in words', async () => {
  const before = await basePlan();
  const after = await replanSlot(roundTrip(before.session), { instruction: 'a lighter film' }, { qloo: mockQloo(), llm: null });
  assert.equal(after.changedSlot, 'film');
  const film = after.plan.slots.find((s) => s.slot === 'film').pick;
  assert.ok(film.tags.some((t) => /comedy|family|animation|musical/i.test(t)), `${film.name}: ${film.tags}`);
});

test('a playlist re-plan builds a new mix that still covers everyone', async () => {
  const before = await basePlan();
  const old = before.plan.slots.find((s) => s.slot === 'music').tracks.map((t) => t.name);
  const after = await replanSlot(roundTrip(before.session), { slot: 'music', instruction: 'more chill' }, { qloo: mockQloo(), llm: null });
  const music = after.plan.slots.find((s) => s.slot === 'music');
  assert.ok(music.tracks.every((t) => !old.includes(t.name)));
  assert.ok(music.fits.every((f) => f.level !== 'unknown'));
});

test('an instruction with no recognisable slot asks which part to change', async () => {
  const before = await basePlan();
  const res = await replanSlot(roundTrip(before.session), { instruction: 'make it better' }, { qloo: mockQloo(), llm: null });
  assert.match(res.error, /Say which part to change/);
});

test('a tampered or stale session is rejected', async () => {
  await assert.rejects(replanSlot({ v: 99, people: [] }, { slot: 'film' }, { qloo: mockQloo(), llm: null }), /expired/);
  await assert.rejects(replanSlot(null, { slot: 'film' }, { qloo: mockQloo(), llm: null }), /expired/);
});

test('with Gemini, the re-plan agent may only change the requested slot', async () => {
  const before = await basePlan();
  const { requests, llm } = fakeGemini((turn, body) => {
    if (turn === 0) return { parts: [{ functionCall: { id: 'a', name: 'qloo_insights', args: { slot: 'dinner', avoid: ['korean'] } } }, { functionCall: { id: 'b', name: 'qloo_insights', args: { slot: 'film' } } }] };
    if (turn === 1) return { parts: [{ functionCall: { id: 'c', name: 'group_overlap', args: { slots: ['dinner'] } } }] };
    const rec = lastToolResult(body, 'group_overlap').recommended.dinner;
    return {
      parts: [
        {
          functionCall: {
            id: 'd',
            name: 'finalize_plan',
            args: { picks: [{ slot: 'dinner', entity_id: rec.entity_id, reason: `Skips Korean as asked; Ana and Cleo both rate ${rec.name} highly.` }, { slot: 'film', entity_id: 'X', reason: 'Sneaky change for Ana.' }] },
          },
        },
      ],
    };
  });
  const after = await replanSlot(roundTrip(before.session), { slot: 'dinner', instruction: 'no korean' }, { qloo: mockQloo(), llm });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.tools[0].functionDeclarations.some((d) => d.name === 'qloo_search'), false);
  const filmResult = lastToolResult(requests[1].body, 'qloo_insights');
  assert.ok(Array.isArray(requests[1].body.contents.at(-1).parts) && filmResult !== undefined);
  const dinner = after.plan.slots.find((s) => s.slot === 'dinner');
  assert.equal(dinner.reasonBy, 'gemini');
  assert.ok(!/korean/i.test(dinner.pick.tags.join(' ')));
  assert.equal(names(after.plan).film, names(before.plan).film, 'film untouched');
  assert.equal(after.plan.mode.agentUsed, 'gemini');
});
