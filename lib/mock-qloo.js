/**
 * Demo-mode Qloo backend.
 *
 * createMockFetch() returns a drop-in `fetch` that answers the same URLs the real
 * client builds (/search, /v2/insights, /v2/tags) with JSON shaped like Qloo's
 * responses. Because it sits *under* lib/qloo.js, demo mode exercises the real
 * URL-building, header and parsing code.
 *
 * Affinities come from a hidden, hand-written taste model (data/fixtures/mock-model.json):
 * every fixture entity has a few weighted "facets", and affinity is the cosine
 * similarity between the signal profile and a candidate. It's deterministic and
 * sensible, but it is *not* Qloo data. The UI labels this mode "Demo data".
 */
import { readFileSync } from 'node:fs';

const fixtureUrl = (name) => new URL(`../data/fixtures/${name}`, import.meta.url);
let fixtures;
function loadFixtures() {
  if (fixtures) return fixtures;
  const entities = JSON.parse(readFileSync(fixtureUrl('entities.json'), 'utf8'));
  const { tags } = JSON.parse(readFileSync(fixtureUrl('tags.json'), 'utf8'));
  const model = JSON.parse(readFileSync(fixtureUrl('mock-model.json'), 'utf8'));
  const byId = new Map();
  for (const [type, list] of Object.entries(entities)) for (const e of list) byId.set(e.entity_id, { ...e, _type: type });
  const tagById = new Map(tags.map((t) => [t.id, t]));
  // Tag facets: explicit ones, else the average of entities that carry the tag.
  const tagFacets = { ...model.tagFacets };
  for (const t of tags) {
    if (tagFacets[t.id]) continue;
    const carriers = [...byId.values()].filter((e) => e.tags.some((x) => x.id === t.id));
    tagFacets[t.id] = carriers.reduce((acc, e) => addInto(acc, model.entityFacets[e.entity_id], 1 / carriers.length), {});
  }
  fixtures = { entities, tags, tagById, byId, entityFacets: model.entityFacets, tagFacets, tagSynonyms: model.tagSynonyms };
  return fixtures;
}

function addInto(acc, facets = {}, w = 1) {
  for (const [k, v] of Object.entries(facets)) acc[k] = (acc[k] || 0) + v * w;
  return acc;
}
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of Object.values(a)) na += v * v;
  for (const v of Object.values(b)) nb += v * v;
  for (const [k, v] of Object.entries(a)) if (b[k]) dot += v * b[k];
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
/** Tiny deterministic jitter in [-0.5, 0.5) so ties break consistently. */
function jitter(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000 - 0.5;
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
const round = (x) => Math.round(x * 10000) / 10000;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Strip mock-only fields and attach request-specific data. */
function present(e, city) {
  const { _type, ...rest } = e;
  const out = structuredClone(rest);
  if (city && out.properties?.address) out.properties.address = `${out.properties.address}, ${city}`;
  return out;
}

// --- /search ----------------------------------------------------------------
function search(params) {
  const f = loadFixtures();
  const q = norm(params.get('query'));
  if (!q) return json(400, { error: { message: 'query is required' } });
  const types = list(params.get('types'));
  const take = Math.min(Number(params.get('take')) || 10, 50);
  const qTokens = q.split(' ');
  const scored = [];
  for (const e of f.byId.values()) {
    if (types.length && !types.includes(e._type)) continue;
    const n = norm(e.name);
    let s = 0;
    if (n === q) s = 3;
    else if (n.startsWith(q) || q.startsWith(n)) s = 2;
    else if (n.includes(q) || q.includes(n)) s = 1.5;
    else {
      const overlap = qTokens.filter((t) => t.length > 2 && n.split(' ').includes(t)).length;
      if (overlap) s = overlap / Math.max(qTokens.length, n.split(' ').length);
    }
    if (s > 0) scored.push({ e, s: s + e.popularity * 0.1 });
  }
  scored.sort((a, b) => b.s - a.s);
  return json(200, { results: scored.slice(0, take).map(({ e }) => present(e)) });
}

// --- /v2/tags ---------------------------------------------------------------
function tagSearch(params) {
  const f = loadFixtures();
  const q = norm(params.get('filter.query'));
  const take = Math.min(Number(params.get('take')) || 10, 50);
  const scored = [];
  for (const t of f.tags) {
    const names = [t.name, ...(f.tagSynonyms[t.id] || [])].map(norm);
    let s = 0;
    for (const n of names) {
      if (n === q) s = Math.max(s, 3);
      else if (q && (n.includes(q) || q.includes(n))) s = Math.max(s, 1.5 + n.length / 100);
      else if (q.split(' ').some((tok) => tok.length > 2 && n.split(' ').includes(tok))) s = Math.max(s, 1);
    }
    if (s > 0) scored.push({ t, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return json(200, { success: true, results: { tags: scored.slice(0, take).map(({ t }) => structuredClone(t)) } });
}

// --- /v2/insights -------------------------------------------------------------
function insights(params) {
  const f = loadFixtures();
  const filterType = params.get('filter.type');
  if (!filterType) return json(400, { error: { message: 'filter.type is required' } });
  const signalIds = list(params.get('signal.interests.entities'));
  const signalTags = list(params.get('signal.interests.tags'));
  const take = Math.min(Number(params.get('take')) || 20, 50);
  const explain = params.get('feature.explainability') === 'true';

  // Signal profile = sum of signal entity facets + signal tag facets.
  const profile = {};
  for (const id of signalIds) addInto(profile, f.entityFacets[id]);
  for (const id of signalTags) addInto(profile, f.tagFacets[id], 0.8);
  const hasSignal = Object.keys(profile).length > 0;
  const seed = `${signalIds.join(',')}|${signalTags.join(',')}`;

  if (filterType === 'urn:tag') {
    // Taste analysis: which tags characterise the signal entities.
    const candidates = f.tags.filter((t) => !t.id.startsWith('urn:tag:category:') && t.id !== 'urn:tag:genre:place:restaurant');
    const ranked = candidates
      .map((t) => ({ t, a: 0.55 + 0.44 * cosine(profile, f.tagFacets[t.id] || {}) + 0.004 * jitter(seed + t.id) }))
      .sort((x, y) => y.a - x.a)
      .slice(0, take)
      .map(({ t, a }) => ({ tag_id: t.id, name: t.name, subtype: t.type, types: t.parents.map((p) => p.type), query: { affinity: round(a) } }));
    return json(200, { success: true, results: { tags: ranked }, duration: 12 });
  }

  let pool = f.entities[filterType];
  if (!pool) return json(400, { error: { message: `Unsupported filter.type ${filterType}` } });
  pool = pool.map((e) => f.byId.get(e.entity_id));

  const only = list(params.get('filter.results.entities'));
  if (only.length) pool = pool.filter((e) => only.includes(e.entity_id));
  const include = list(params.get('filter.tags'));
  if (include.length) pool = pool.filter((e) => e.tags.some((t) => include.includes(t.id)));
  const exclude = list(params.get('filter.exclude.tags'));
  if (exclude.length) pool = pool.filter((e) => !e.tags.some((t) => exclude.includes(t.id)));

  const city = params.get('filter.location.query') || undefined;
  const ranked = pool
    .map((e) => {
      const sim = hasSignal ? cosine(profile, f.entityFacets[e.entity_id] || {}) : 0;
      const affinity = hasSignal ? 0.5 + 0.45 * sim + 0.04 * e.popularity + 0.01 * jitter(seed + e.entity_id) : 0.4 + 0.5 * e.popularity;
      return { e, affinity: Math.min(0.9999, affinity) };
    })
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, take)
    .map(({ e, affinity }) => {
      const item = present(e, city);
      delete item.types;
      item.type = 'urn:entity';
      item.subtype = e._type;
      item.query = { affinity: round(affinity) };
      if (explain && signalIds.length) {
        item.query.explainability = {
          'signal.interests.entities': signalIds
            .map((id) => ({ entity_id: id, score: round(cosine(f.entityFacets[id] || {}, f.entityFacets[e.entity_id] || {})) }))
            .sort((a, b) => b.score - a.score),
        };
      }
      return item;
    });
  return json(200, { success: true, results: { entities: ranked }, duration: 18 });
}

/**
 * Mock fetch. `latencyMs` adds a small jittered delay per request so the
 * streamed agent trace in demo mode paces like a real network.
 */
export function createMockFetch({ latencyMs = 0 } = {}) {
  return async function mockFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const key = init.headers?.['X-Api-Key'] ?? init.headers?.get?.('X-Api-Key');
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs * (0.6 + Math.random() * 0.8)));
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (!key) return json(401, { error: { message: 'Missing X-Api-Key header' } });
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/search') return search(url.searchParams);
    if (path === '/v2/insights') return insights(url.searchParams);
    if (path === '/v2/tags') return tagSearch(url.searchParams);
    return json(404, { error: { message: `Unknown path ${path}` } });
  };
}

export const MOCK_API_KEY = 'demo-mode';
