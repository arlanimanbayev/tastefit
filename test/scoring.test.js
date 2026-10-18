import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../lib/scoring.js';

const people = [{ name: 'Ana' }, { name: 'Ben' }, { name: 'Cleo' }];
const fit = (norm) => ({ norm, level: S.fitLevel(norm), raw: norm });
const cand = (id, group, a, b, c, extra = {}) => ({ id, name: id, groupNorm: group, fits: { Ana: fit(a), Ben: fit(b), Cleo: fit(c) }, tags: [], ...extra });

test('minMax normalises within a call and flags flat sets', () => {
  assert.deepEqual(S.minMax([0.9, 0.7, 0.8]).map((x) => Math.round(x * 100) / 100), [1, 0, 0.5]);
  assert.deepEqual(S.minMax([0.91, 0.912]), [0.5, 0.5]);
  assert.deepEqual(S.minMax([0.5, undefined]), [0.5, null]);
});

test('fitLevel thresholds', () => {
  assert.equal(S.fitLevel(0.9), 'great');
  assert.equal(S.fitLevel(0.5), 'good');
  assert.equal(S.fitLevel(0.1), 'stretch');
  assert.equal(S.fitLevel(null), 'unknown');
});

test('attachFits normalises each person separately and keeps raw Qloo affinity', () => {
  const cands = [{ id: 'x', affinity: 0.9 }, { id: 'y', affinity: 0.8 }];
  const perPerson = {
    Ana: { byId: new Map([['x', { affinity: 0.6 }], ['y', { affinity: 0.95 }]]) },
    Ben: { byId: new Map([['x', { affinity: 0.7 }], ['y', { affinity: 0.5 }]]) },
    Cleo: null,
  };
  S.attachFits(cands, people, perPerson);
  assert.equal(cands[0].groupNorm, 1);
  assert.equal(cands[0].fits.Ana.norm, 0);
  assert.equal(cands[1].fits.Ana.norm, 1);
  assert.equal(cands[1].fits.Ana.raw, 0.95);
  assert.equal(cands[0].fits.Ben.level, 'great');
  assert.equal(cands[0].fits.Cleo.level, 'unknown');
});

test('rankSlot prefers a pick nobody hates over one person’s favourite', () => {
  const oneFan = cand('one-fan', 1, 1, 0, 0);
  const middle = cand('middle', 0.6, 0.7, 0.7, 0.7);
  const ranked = S.rankSlot([oneFan, middle], people, S.newLedger(people));
  assert.equal(ranked[0].c.id, 'middle');
});

test('fairness boost favours people with no great pick yet', () => {
  const forAna = cand('for-ana', 0.5, 1, 0.5, 0.5);
  const forBen = cand('for-ben', 0.5, 0.5, 1, 0.5);
  const ledger = S.newLedger(people);
  S.recordPick(ledger, 'dinner', { Ana: fit(1), Ben: fit(0.2), Cleo: fit(0.5) });
  const ranked = S.rankSlot([forAna, forBen], people, ledger);
  assert.equal(ranked[0].c.id, 'for-ben');
});

test('rankSlot penalises distance from an anchor and boosts requested terms', () => {
  const near = cand('near', 0.5, 0.5, 0.5, 0.5, { lat: 41.9, lon: -87.63 });
  const far = cand('far', 0.6, 0.6, 0.6, 0.6, { lat: 41.95, lon: -87.7 });
  const anchor = { lat: 41.9, lon: -87.631 };
  assert.equal(S.rankSlot([near, far], people, {}, { anchor, distanceWeight: 0.12 })[0].c.id, 'near');
  const comedy = cand('comedy', 0.4, 0.5, 0.5, 0.5, { tags: [{ id: 't', name: 'Comedy' }] });
  const drama = cand('drama', 0.6, 0.6, 0.6, 0.6, { tags: [{ id: 'd', name: 'Drama' }] });
  assert.equal(S.rankSlot([drama, comedy], people, {}, { preferTerms: ['comedy'] })[0].c.id, 'comedy');
});

test('selectPlaylist gives everyone at least one top artist', () => {
  const artists = [cand('a1', 1, 1, 0, 0), cand('a2', 0.9, 0.9, 0.1, 0), cand('b1', 0.2, 0, 1, 0), cand('c1', 0.1, 0, 0, 1), cand('x', 0.8, 0.5, 0.5, 0.5)];
  const { tracks, fits } = S.selectPlaylist(artists, people, S.newLedger(people), 3);
  assert.equal(tracks.length, 3);
  assert.deepEqual(tracks.map((t) => t.id).sort(), ['a1', 'b1', 'c1']);
  for (const p of people) assert.equal(fits[p.name].level, 'great');
  assert.equal(fits.Ben.via, 'b1');
});

test('rebalance swaps a slot so a left-out person gets a great fit', () => {
  const dinnerPick = cand('d1', 1, 1, 0.9, 0.3);
  const filmPick = cand('f1', 1, 0.9, 0.8, 0.3);
  const filmAlt = cand('f2', 0.9, 0.8, 0.7, 0.9);
  const plan = {
    dinner: { pick: dinnerPick, fits: dinnerPick.fits, candidates: [dinnerPick] },
    film: { pick: filmPick, fits: filmPick.fits, candidates: [filmPick, filmAlt] },
  };
  const notes = S.rebalance(plan, people);
  assert.equal(plan.film.pick.id, 'f2');
  assert.deepEqual(notes, [{ person: 'Cleo', slot: 'film', from: 'f1', to: 'f2' }]);
});

test('rebalance refuses swaps that cost the group too much', () => {
  const pick = cand('p', 1, 1, 1, 0.1);
  const costly = cand('alt', 0, 0, 0, 1);
  const plan = { film: { pick, fits: pick.fits, candidates: [pick, costly] } };
  assert.deepEqual(S.rebalance(plan, people), []);
  assert.equal(plan.film.pick.id, 'p');
});

test('applyConstraints enforces price, excluded ids and excluded words (with synonyms)', () => {
  const list = [
    { id: 'a', name: 'Saltwater Omakase', priceLevel: 4, tags: [{ name: 'Sushi' }] },
    { id: 'b', name: 'Casa Ofrenda', priceLevel: 1, tags: [{ name: 'Mexican' }] },
    { id: 'c', name: 'Mystery Spot', tags: [] },
    { id: 'd', name: 'Hanok Table', priceLevel: 2, tags: [{ name: 'Korean' }] },
  ];
  assert.deepEqual(S.applyConstraints(list, { maxPriceLevel: 2 }).map((x) => x.id), ['b', 'c', 'd']);
  assert.deepEqual(S.applyConstraints(list, { excludeTerms: ['sushi'] }).map((x) => x.id), ['b', 'c', 'd']);
  assert.deepEqual(S.applyConstraints(list, { excludeTerms: ['Korean'], excludeIds: ['b'] }).map((x) => x.id), ['a', 'c']);
});

test('parseInstruction understands cheaper / closer / no X / slot words / preferences', () => {
  const a = S.parseInstruction('Cheaper dinner please, and no sushi');
  assert.equal(a.slot, 'dinner');
  assert.equal(a.constraints.cheaper, true);
  assert.deepEqual(a.constraints.excludeTerms, ['sushi']);
  const b = S.parseInstruction('somewhere closer after dinner');
  assert.equal(b.constraints.closer, true);
  assert.equal(b.slot, 'dinner', 'mentions dinner first; callers pass an explicit slot from the card');
  const c = S.parseInstruction('a lighter film');
  assert.equal(c.slot, 'film');
  assert.ok(c.constraints.preferTerms.includes('comedy'));
  const d = S.parseInstruction('more chill playlist');
  assert.equal(d.slot, 'music');
  assert.equal(S.parseInstruction('make it better').slot, undefined);
  assert.deepEqual(S.parseInstruction("we don't want karaoke").constraints.excludeTerms, ['karaoke']);
});

test('buildReason names people, cites their favourites, and only claims "elsewhere" when true', () => {
  const ppl = [
    { name: 'Ana', favorites: [{ kind: 'music', entity: { id: 'pb', name: 'Phoebe Bridgers', tags: [{ name: 'Indie Folk', type: 'urn:tag:genre:music' }] } }] },
    { name: 'Ben', favorites: [{ kind: 'food', tag: { id: 'urn:tag:korean', name: 'Korean' } }] },
    { name: 'Cleo', favorites: [{ kind: 'film', entity: { id: 'br', name: 'Blade Runner 2049', tags: [] } }] },
  ];
  const pick = { id: 'x', tags: [{ id: 'urn:tag:korean', name: 'Korean' }], fits: { Ana: { explain: [{ id: 'pb', score: 0.8 }] } } };
  const fits = { Ana: fit(0.9), Ben: fit(1), Cleo: fit(0.1) };
  const r1 = S.buildReason('dinner', pick, fits, ppl);
  assert.match(r1, /Ana's indie folk side \(Phoebe Bridgers\)/);
  assert.match(r1, /Ben's love of Korean food/);
  assert.match(r1, /A stretch for Cleo\.$/);
  const r2 = S.buildReason('dinner', pick, fits, ppl, { servedElsewhere: new Set(['Cleo']) });
  assert.match(r2, /Cleo, who gets a better match elsewhere/);
});

test('foodPhrase reads naturally', () => {
  assert.equal(S.foodPhrase('Korean'), 'love of Korean food');
  assert.equal(S.foodPhrase('Ramen'), 'love of ramen');
  assert.equal(S.foodPhrase('Thai'), 'love of Thai food');
});
