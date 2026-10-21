/**
 * TasteFit agent.
 *
 * One set of tools, two policies:
 *   - Gemini policy: an LLM tool-calling loop (lib/llm.js) decides which tools to
 *     call and writes the reasons.
 *   - Scripted policy: the same tools in a fixed order, used when GEMINI_API_KEY
 *     is missing, and to finish any step the LLM didn't complete in time.
 *
 * Tools:
 *   qloo_search    resolve favourites to Qloo entities (/search) or cuisine tags (/v2/tags)
 *   qloo_insights  group recommendations for a slot (/v2/insights, all members as signals)
 *                  + one ranking call per person over the same candidates
 *   group_overlap  local fairness scoring (lib/scoring.js)
 *   finalize_plan  structured output, validated against the candidates Qloo returned
 *
 * Whatever happens, planNight() returns a valid plan object.
 */
import { createQlooClient, entitiesFrom, tagsFrom, normalizeEntity, normalizeTag, QLOO_DEFAULT_BASE_URL } from './qloo.js';
import { createMockFetch, MOCK_API_KEY } from './mock-qloo.js';
import { createGemini, functionResponseTurn, GEMINI_DEFAULT_MODEL } from './llm.js';
import * as S from './scoring.js';

export const PERSON_COLORS = ['coral', 'teal', 'cobalt', 'marigold', 'orchid'];
export const KINDS = ['auto', 'music', 'film', 'tv', 'book', 'food', 'place'];
const KIND_TYPES = { music: 'urn:entity:artist', film: 'urn:entity:movie', tv: 'urn:entity:tv_show', book: 'urn:entity:book', place: 'urn:entity:place' };
const INSIGHT_TYPES = new Set(['urn:entity:artist', 'urn:entity:movie', 'urn:entity:tv_show', 'urn:entity:book', 'urn:entity:place', 'urn:entity:person', 'urn:entity:podcast', 'urn:entity:brand', 'urn:entity:videogame']);
/** Category tag for restaurants. Assumed (not enumerated in the pinned spec); configurable. */
export const RESTAURANT_TAG = process.env.QLOO_RESTAURANT_TAG || 'urn:tag:genre:place:restaurant';

export const OCCASIONS = {
  night_out: { label: 'Night out', times: { dinner: '7:00 pm', activity: '9:30 pm', film: 'Tomorrow', music: 'On the way' }, labels: { dinner: 'Dinner', activity: 'After dinner', film: 'Film', music: 'Playlist' }, activityTag: 'bar' },
  day_out: { label: 'Weekend day', times: { dinner: '12:30 pm', activity: '2:30 pm', film: 'Tonight', music: 'All day' }, labels: { dinner: 'Lunch', activity: 'Afternoon', film: 'Film', music: 'Playlist' }, activityTag: 'museum' },
};

/**
 * Place categories that make sense for the activity slot, sent to Qloo as
 * filter.tags (union). Without them a "night out" can end at a sculpture or a
 * hockey arena. Both spellings of a few ids are listed because Qloo uses
 * e.g. both `night_club` and `nightclub` across its taxonomy.
 */
const PLACE = 'urn:tag:category:place:';
export const ACTIVITY_CATEGORIES = {
  night_out: ['bar', 'cocktail_bar', 'wine_bar', 'listening_bar', 'live_music_venue', 'jazz_club', 'comedy_club', 'night_club', 'nightclub', 'karaoke'].map((t) => PLACE + t).concat(['urn:tag:genre:place:jazz_club']),
  day_out: ['museum', 'art_gallery', 'park', 'botanical_garden', 'planetarium', 'aquarium', 'book_store', 'market', 'night_market', 'outdoor_cinema'].map((t) => PLACE + t),
};
const ACTIVITY_EXCLUDE = ['arena', 'stadium', 'hockey_rink', 'sports_complex'].map((t) => PLACE + t);

/** Tag types shown as "what the group shares": taste genres, not dishes, prices or amenities. */
export const TASTE_TAG_TYPES = ['urn:tag:genre:music', 'urn:tag:genre:media'];
const BUDGET_MAX_PRICE = { 1: 1, 2: 2, 3: undefined };
const SLOT_SPECS = {
  taste_profile: { type: 'urn:tag', take: 10 },
  dinner: { type: 'urn:entity:place', take: 10, place: true },
  activity: { type: 'urn:entity:place', take: 10, place: true },
  film: { type: 'urn:entity:movie', take: 10 },
  music: { type: 'urn:entity:artist', take: 15 },
};

const FOOD_WORDS = new Set(
  'food cuisine restaurant brunch breakfast noodles noodle ramen sushi omakase sashimi tacos taco burrito mexican korean kbbq bibimbap kimchi thai pad curry indian biryani italian pasta pizza chinese dumplings dumpling dim sum bao french bistro croissant mediterranean greek falafel hummus vegan vegetarian salad bbq barbecue brisket ribs seafood oysters fish burger burgers fries vietnamese pho banh mi steak ethiopian japanese izakaya tapas spanish cajun soul southern dessert ice cream bakery coffee'.split(' '),
);
export function isFoodish(text) {
  const words = S.normText(text).split(' ');
  return words.some((w) => FOOD_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Build Qloo + LLM clients from env. Missing keys select demo data / scripted planner. */
export function depsFromEnv(env = process.env) {
  const live = Boolean(env.QLOO_API_KEY);
  const qloo = live
    ? createQlooClient({ apiKey: env.QLOO_API_KEY, baseUrl: env.QLOO_BASE_URL || QLOO_DEFAULT_BASE_URL, mode: 'live' })
    : createQlooClient({ apiKey: MOCK_API_KEY, baseUrl: 'https://demo.qloo.invalid', fetchImpl: createMockFetch({ latencyMs: Number(env.MOCK_LATENCY_MS ?? 70) }), mode: 'mock' });
  const llm = env.GEMINI_API_KEY ? createGemini({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL }) : null;
  return { qloo, llm };
}

export function modeInfo({ qloo, llm }) {
  return { qloo: qloo.mode, agent: llm ? 'gemini' : 'scripted', model: llm?.model || null };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function validatePlanInput(body) {
  if (!body || typeof body !== 'object') return { error: 'Send a JSON body with people and a city.' };
  const city = str(body.city, 60);
  if (!city) return { error: 'Add a city so Qloo can find places nearby.' };
  if (!Array.isArray(body.people)) return { error: 'Add at least two people.' };
  const seen = new Map();
  const people = [];
  for (const p of body.people.slice(0, 5)) {
    let name = str(p?.name, 24) || `Friend ${people.length + 1}`;
    const n = seen.get(name.toLowerCase()) || 0;
    seen.set(name.toLowerCase(), n + 1);
    if (n) name = `${name} ${n + 1}`;
    const favorites = (Array.isArray(p?.favorites) ? p.favorites : [])
      .map((f) => (typeof f === 'string' ? { text: f } : f))
      .map((f) => ({ text: str(f?.text, 60), kind: KINDS.includes(f?.kind) ? f.kind : 'auto' }))
      .filter((f) => f.text)
      .slice(0, 8);
    people.push({ name, favorites });
  }
  if (people.length < 2) return { error: 'Add at least two people.' };
  if (people.filter((p) => p.favorites.length).length < 2) return { error: 'Give at least two people one favourite each.' };
  const occasion = OCCASIONS[body.occasion] ? body.occasion : 'night_out';
  const budget = [1, 2, 3].includes(Number(body.budget)) ? Number(body.budget) : 2;
  return { value: { city, people, occasion, budget, notes: str(body.notes, 200) } };
}

// ---------------------------------------------------------------------------
// Context + trace
// ---------------------------------------------------------------------------

function createContext(input, emit, budgetMs) {
  const now = Date.now();
  return {
    city: input.city,
    occasion: input.occasion,
    budget: input.budget,
    notes: input.notes || '',
    people: input.people.map((p, i) => ({
      name: p.name,
      color: PERSON_COLORS[i % PERSON_COLORS.length],
      favorites: p.favorites.map((f) => ({ input: f.text, kind: f.kind || 'auto', status: 'pending' })),
    })),
    slots: {},
    plan: {},
    proposal: null,
    tasteProfile: [],
    tasteProfileTried: false,
    activityTagId: undefined,
    headline: null,
    playlistTitle: null,
    finalized: false,
    rebalanceNotes: [],
    trace: [],
    emit: emit || (() => {}),
    startedAt: now,
    deadline: now + budgetMs,
    stats: { modelTurns: 0 },
    policy: 'scripted',
  };
}

let traceSeq = 0;
function traceStart(ctx, { kind = 'tool', tool, title, by }) {
  const event = { id: `t${(traceSeq += 1)}`, kind, tool, title, detail: '', status: 'running', ms: 0, by: by || ctx.policy };
  const started = Date.now();
  ctx.trace.push(event);
  ctx.emit({ type: 'trace', event: { ...event } });
  return {
    done(detail, status = 'done') {
      event.detail = detail || '';
      event.status = status;
      event.ms = Date.now() - started;
      ctx.emit({ type: 'trace', event: { ...event } });
    },
  };
}

const remaining = (ctx) => ctx.deadline - Date.now();
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const matchedEntities = (p) => p.favorites.filter((f) => f.entity).map((f) => f.entity.id);
const foodTags = (p) => p.favorites.filter((f) => f.tag).map((f) => f.tag.id);

// ---------------------------------------------------------------------------
// Tool implementations (shared by both policies)
// ---------------------------------------------------------------------------

async function resolveFavorite(qloo, fav) {
  const wantsFood = fav.kind === 'food' || (fav.kind === 'auto' && isFoodish(fav.input));
  if (wantsFood) {
    // 1) Plain search on the dish/cuisine word ("Korean food" -> "korean"): Qloo's
    //    restaurant-genre tags (urn:tag:genre:place:restaurant:*) are what places carry.
    const cleaned = String(fav.input).replace(/\b(food|foods|cuisine|restaurants?|dishes|places?)\b/gi, ' ').replace(/\s+/g, ' ').trim() || fav.input;
    try {
      const plain = tagsFrom(await qloo.tags({ 'filter.query': cleaned, take: 10 })).map(normalizeTag).filter(Boolean);
      const genre = plain.find((t) => /^urn:tag:genre:place:restaurant:/.test(t.id));
      if (genre) {
        Object.assign(fav, { kind: 'food', status: 'matched', tag: { id: genre.id, name: genre.name }, entity: undefined });
        return fav;
      }
    } catch {
      /* fall through to semantic search */
    }
    // 2) Semantic search as before.
    const res = await qloo.tags({ 'filter.query': fav.input, 'feature.semantic_search': true, take: 8 });
    const tags = tagsFrom(res).map(normalizeTag).filter(Boolean);
    const pick =
      tags.find((t) => /:place:restaurant:/.test(t.id)) ||
      tags.find((t) => t.parents.includes('urn:entity:place') && !/:category:/.test(t.id)) ||
      (fav.kind === 'food' ? tags[0] : undefined);
    if (pick) {
      Object.assign(fav, { kind: 'food', status: 'matched', tag: { id: pick.id, name: pick.name }, entity: undefined });
      return fav;
    }
  }
  const types = KIND_TYPES[fav.kind];
  const res = await qloo.search({ query: fav.input, types, take: 5 });
  const found = entitiesFrom(res)
    .map(normalizeEntity)
    .filter((e) => e && (INSIGHT_TYPES.has(e.type) || !e.type));
  const exact = found.find((e) => S.normText(e.name) === S.normText(fav.input));
  const pick = exact || found[0];
  if (!pick) {
    fav.status = 'missing';
    return fav;
  }
  Object.assign(fav, {
    status: 'matched',
    kind: pick.kind === 'other' ? fav.kind : pick.kind,
    entity: { id: pick.id, name: pick.name, type: pick.type, kind: pick.kind, tags: pick.tags.slice(0, 4) },
    alternatives: found.filter((e) => e !== pick).slice(0, 2).map((e) => `${e.name} (${e.kind})`),
  });
  return fav;
}

async function toolSearch(ctx, { qloo }, args = {}) {
  // Accept explicit items from the LLM, but only for favourites the user entered.
  const wanted = Array.isArray(args.items) && args.items.length ? args.items : null;
  const targets = [];
  for (const p of ctx.people) {
    for (const f of p.favorites) {
      if (f.status !== 'pending') continue;
      if (wanted) {
        const hit = wanted.find((w) => S.normText(w?.person) === S.normText(p.name) && S.normText(w?.text) === S.normText(f.input));
        if (!hit) continue;
        if (KINDS.includes(hit.kind) && f.kind === 'auto') f.kind = hit.kind;
      }
      targets.push({ p, f });
    }
  }
  if (wanted && !targets.length) for (const p of ctx.people) for (const f of p.favorites) if (f.status === 'pending') targets.push({ p, f });

  const byPerson = new Map();
  for (const t of targets) byPerson.set(t.p, [...(byPerson.get(t.p) || []), t.f]);
  await Promise.all(
    [...byPerson.entries()].map(async ([p, favs]) => {
      const step = traceStart(ctx, { tool: 'qloo_search', title: `Looked up ${p.name}'s favourites in Qloo` });
      await Promise.all(
        favs.map((f) =>
          resolveFavorite(qloo, f).catch((err) => {
            f.status = 'missing';
            f.error = err.message;
          }),
        ),
      );
      step.done(favs.map((f) => (f.status === 'matched' ? `${f.input} → ${f.entity?.name || f.tag?.name} (${f.kind})` : `${f.input}: no match`)).join('; '));
    }),
  );
  return ctx.people.map((p) => ({
    person: p.name,
    favourites: p.favorites.map((f) => ({ input: f.input, status: f.status, match: f.entity ? `${f.entity.name} [${f.kind}]` : f.tag ? `${f.tag.name} [food tag]` : null })),
  }));
}

/** Resolve pending favourites once, even if several tools ask at the same time. */
async function ensureResolved(ctx, deps) {
  if (!ctx.people.some((p) => p.favorites.some((f) => f.status === 'pending'))) return;
  ctx.searchPromise ||= toolSearch(ctx, deps, {}).finally(() => {
    ctx.searchPromise = null;
  });
  await ctx.searchPromise;
}

/** Occasion tag (e.g. "bar") used as a soft signal for the activity slot. */
function resolveActivityTag(ctx, qloo) {
  ctx.activityTagPromise ||= (async () => {
    try {
      const q = OCCASIONS[ctx.occasion].activityTag;
      const tags = tagsFrom(await qloo.tags({ 'filter.query': q, 'feature.semantic_search': true, take: 5 })).map(normalizeTag).filter(Boolean);
      const t = tags.find((x) => x.parents.includes('urn:entity:place') || /:place:/.test(x.id));
      return t ? t.id : null;
    } catch {
      return null; // optional bias only
    }
  })();
  return ctx.activityTagPromise;
}

function slotTitle(ctx, slot) {
  const where = ctx.city;
  return {
    taste_profile: 'Asked Qloo what the group’s tastes share',
    dinner: `Asked Qloo for ${OCCASIONS[ctx.occasion].labels.dinner.toLowerCase()} spots in ${where} that fit the group`,
    activity: `Asked Qloo where to go ${ctx.occasion === 'day_out' ? 'in the afternoon' : 'after dinner'} in ${where}`,
    film: 'Asked Qloo for a film the whole group would watch',
    music: 'Asked Qloo for artists to build a shared playlist',
  }[slot];
}

/** Resolve preference words ("comedy", "live music") to Qloo tag ids scoped to the slot's entity type. */
async function resolvePreferenceTags(qloo, slot, terms = []) {
  const type = SLOT_SPECS[slot]?.type;
  const ids = [];
  for (const term of terms.slice(0, 6)) {
    if (ids.length >= 2) break;
    try {
      const tags = tagsFrom(await qloo.tags({ 'filter.query': term, 'feature.semantic_search': true, take: 8 })).map(normalizeTag).filter(Boolean);
      const scoped = tags.find((t) => t.parents.includes(type)) || (tags.some((t) => t.parents.length) ? undefined : tags[0]);
      if (scoped) ids.push(scoped.id);
    } catch {
      /* preference is optional */
    }
  }
  return uniq(ids);
}

const CATEGORY_PARAMS = ['filter.tags', 'operator.filter.tags', 'filter.exclude.tags'];
const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/**
 * Insights call that survives the two least-certain parameters: if Qloo rejects
 * the request (4xx other than auth/rate limit), drop feature.explainability,
 * then the category tag filters, and try again.
 */
export async function insightsResilient(qloo, params) {
  const attempts = [params];
  if (params['feature.explainability']) attempts.push(omit(attempts.at(-1), ['feature.explainability']));
  if (CATEGORY_PARAMS.some((k) => params[k])) attempts.push(omit(attempts.at(-1), CATEGORY_PARAMS));
  let lastError;
  for (const p of attempts) {
    try {
      return { entities: entitiesFrom(await qloo.insights(p)).map(normalizeEntity).filter(Boolean), params: p };
    } catch (err) {
      lastError = err;
      const recoverable = err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status);
      if (!recoverable) throw err;
    }
  }
  throw lastError;
}

/**
 * Keep genre-style tags only (music and film/TV/book genres), trim Qloo's stray
 * whitespace, and drop near-duplicates ("indie" vs "Indie"), so the "what the
 * group shares" row reads like tastes rather than menu items.
 */
export function pickTasteTags(tags, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const name = String(t.name || '').trim().replace(/\s+/g, ' ');
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    const type = t.type || '';
    const isGenre = TASTE_TAG_TYPES.some((p) => type.startsWith(p) || t.id.startsWith(p + ':'));
    if (!isGenre) continue;
    seen.add(key);
    out.push({ id: t.id, name: name.charAt(0).toUpperCase() + name.slice(1), affinity: t.affinity ?? null });
    if (out.length >= limit) break;
  }
  return out;
}

/** Group call + one ranking call per person. Stores candidates with fits on ctx.slots[slot]. */
async function fetchSlot(ctx, { qloo }, slot, { constraints = {}, take, extraSignalTags = [] } = {}) {
  const spec = SLOT_SPECS[slot];
  const step = traceStart(ctx, { tool: 'qloo_insights', title: slotTitle(ctx, slot) });
  const signalIds = uniq(ctx.people.flatMap(matchedEntities)).slice(0, 30);
  const groupFoodTags = uniq(ctx.people.flatMap(foodTags)).slice(0, 10);
  const favIds = new Set(signalIds);

  if (slot === 'taste_profile') {
    ctx.tasteProfileTried = true;
    try {
      if (!signalIds.length) throw new Error('no entity signals');
      const base = { 'filter.type': 'urn:tag', 'signal.interests.entities': signalIds, take: 25 };
      let raw;
      try {
        raw = await qloo.insights({ ...base, 'filter.tag.types': TASTE_TAG_TYPES });
      } catch (err) {
        if (!(err.status >= 400 && err.status < 500) || [401, 403, 429].includes(err.status)) throw err;
        raw = await qloo.insights(base); // older API without filter.tag.types: filter below instead
      }
      ctx.tasteProfile = pickTasteTags(tagsFrom(raw).map(normalizeTag).filter(Boolean));
      step.done(ctx.tasteProfile.map((t) => t.name).join(', ') || 'No shared tags returned');
    } catch (err) {
      step.done(`Skipped (${err.message})`, 'skipped');
    }
    return { slot, shared_tastes: ctx.tasteProfile.map((t) => `${t.name}${t.affinity != null ? ` (${t.affinity.toFixed(2)})` : ''}`) };
  }

  const params = { 'filter.type': spec.type, take: take || spec.take, 'feature.explainability': true };
  if (signalIds.length) params['signal.interests.entities'] = signalIds;
  if (spec.place) params['filter.location.query'] = ctx.city;
  if (slot === 'dinner') {
    const cuisines = groupFoodTags.filter((id) => /^urn:tag:genre:place:restaurant:/.test(id));
    // Every candidate serves at least one cuisine someone asked for; with no food
    // favourites, any restaurant.
    params['filter.tags'] = cuisines.length ? cuisines : RESTAURANT_TAG;
    params['operator.filter.tags'] = 'union';
    if (groupFoodTags.length) {
      params['signal.interests.tags'] = groupFoodTags;
      params['operator.signal.interests.tags'] = 'union';
    }
  }
  if (slot === 'activity') {
    params['filter.tags'] = ACTIVITY_CATEGORIES[ctx.occasion] || ACTIVITY_CATEGORIES.night_out;
    params['operator.filter.tags'] = 'union';
    params['filter.exclude.tags'] = [RESTAURANT_TAG, ...ACTIVITY_EXCLUDE];
    const bias = await resolveActivityTag(ctx, qloo);
    if (bias) params['signal.interests.tags'] = bias;
  }
  if (extraSignalTags.length) {
    // A re-plan preference ("lighter" → comedy) becomes a Qloo tag signal.
    params['signal.interests.tags'] = uniq([...[].concat(params['signal.interests.tags'] || []), ...extraSignalTags]);
    params['operator.signal.interests.tags'] = 'union';
  }

  let candidates = [];
  let usedParams = params;
  try {
    ({ entities: candidates, params: usedParams } = await insightsResilient(qloo, params));
    if (!candidates.length && slot === 'dinner' && usedParams['filter.tags'] && usedParams['filter.tags'] !== RESTAURANT_TAG) {
      // No place serves the requested cuisines nearby: any restaurant, same signals.
      ({ entities: candidates, params: usedParams } = await insightsResilient(qloo, { ...usedParams, 'filter.tags': RESTAURANT_TAG }));
    }
    if (!candidates.length && (usedParams['filter.tags'] || usedParams['filter.exclude.tags'])) {
      // An empty result with a category filter: retry without it.
      ({ entities: candidates, params: usedParams } = await insightsResilient(qloo, omit(usedParams, CATEGORY_PARAMS)));
    }
  } catch (err) {
    step.done(`Qloo error: ${err.message}`, 'error');
    ctx.slots[slot] = { candidates: [], request: null, constraints, excluded: [] };
    return { slot, error: err.message };
  }
  const relaxed = Boolean((params['filter.tags'] || params['filter.exclude.tags']) && !usedParams['filter.tags'] && !usedParams['filter.exclude.tags']);
  const seen = new Set();
  candidates = candidates.filter((c) => !favIds.has(c.id) && !seen.has(c.id) && seen.add(c.id));

  // Per-person ranking over the same candidate set.
  let personCalls = 0;
  const perPerson = {};
  if (candidates.length) {
    await Promise.all(
      ctx.people.map(async (p) => {
        const ids = matchedEntities(p);
        const tags = slot === 'dinner' ? foodTags(p) : [];
        if (!ids.length && !tags.length) return;
        const rp = { 'filter.type': spec.type, 'filter.results.entities': candidates.map((c) => c.id), take: candidates.length, 'feature.explainability': true };
        if (ids.length) rp['signal.interests.entities'] = ids;
        if (tags.length) {
          rp['signal.interests.tags'] = tags;
          rp['operator.signal.interests.tags'] = 'union';
        }
        try {
          personCalls += 1;
          const { entities: ranked } = await insightsResilient(qloo, rp);
          perPerson[p.name] = { byId: new Map(ranked.map((e) => [e.id, { affinity: e.affinity, explain: e.explain }])) };
        } catch {
          perPerson[p.name] = null;
        }
      }),
    );
  }
  S.attachFits(candidates, ctx.people, perPerson);
  if (slot === 'dinner') S.applyCuisineMatches(candidates, ctx.people);
  const prev = ctx.slots[slot];
  ctx.slots[slot] = {
    candidates,
    request: { path: '/v2/insights', params: usedParams },
    personCalls,
    relaxed,
    constraints: { ...(prev?.constraints || {}), ...constraints },
    excluded: prev?.excluded || [],
  };
  ctx.proposal = null; // candidates changed: overlap must be recomputed
  step.done(
    candidates.length
      ? `${candidates.length} candidates from Qloo, each scored for ${personCalls} ${personCalls === 1 ? 'person' : 'people'}${relaxed ? ' (category filter relaxed)' : ''}`
      : 'Qloo returned no candidates',
    candidates.length ? 'done' : 'error',
  );
  return {
    slot,
    candidates: candidates.slice(0, 6).map((c) => ({
      entity_id: c.id,
      name: c.name,
      group_affinity: round(c.groupAffinity),
      tags: c.tags.slice(0, 3).map((t) => t.name),
      price_level: c.priceLevel,
      fit: Object.fromEntries(ctx.people.map((p) => [p.name, c.fits[p.name]?.level])),
    })),
  };
}
const round = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : null);

function slotConstraints(ctx, slot) {
  const st = ctx.slots[slot] || {};
  const c = { ...(st.constraints || {}) };
  const budgetMax = BUDGET_MAX_PRICE[ctx.budget];
  if (SLOT_SPECS[slot]?.place && budgetMax && !c.maxPriceLevel) c.maxPriceLevel = budgetMax;
  c.excludeIds = [...(c.excludeIds || []), ...(st.excluded || [])];
  return c;
}

/** Local fairness scoring across all slots that have candidates. */
function computeOverlap(ctx, onlySlots) {
  const ledger = S.newLedger(ctx.people);
  const proposal = ctx.proposal ? { ...ctx.proposal } : {};
  // When re-planning one slot, the other slots' current picks seed the ledger.
  if (onlySlots) for (const [slot, entry] of Object.entries(ctx.plan)) if (!onlySlots.includes(slot)) S.recordPick(ledger, slot, entry.fits);
  for (const slot of S.SLOT_ORDER) {
    if (onlySlots && !onlySlots.includes(slot)) continue;
    const st = ctx.slots[slot];
    if (!st?.candidates?.length) continue;
    const cons = slotConstraints(ctx, slot);
    let cands = S.applyConstraints(st.candidates, cons);
    let budgetRelaxed = false;
    if (!cands.length) {
      cands = S.applyConstraints(st.candidates, { ...cons, maxPriceLevel: undefined });
      budgetRelaxed = true;
    }
    if (!cands.length) cands = st.candidates.filter((c) => !cons.excludeIds.includes(c.id));
    if (!cands.length) continue;
    if (slot === 'music') {
      const pl = S.selectPlaylist(cands, ctx.people, ledger);
      proposal.music = { pick: pl.tracks[0], tracks: pl.tracks, fits: pl.fits, ranked: S.rankSlot(cands, ctx.people, ledger).slice(0, 6), candidates: cands };
      S.recordPick(ledger, 'music', pl.fits);
      continue;
    }
    const otherPlace = slot === 'activity' ? (proposal.dinner || ctx.plan.dinner)?.pick : slot === 'dinner' && cons.closer ? ctx.plan.activity?.pick : undefined;
    const ranked = S.rankSlot(cands, ctx.people, ledger, { anchor: otherPlace, preferTerms: cons.preferTerms || [], distanceWeight: cons.closer ? 0.12 : 0.02 });
    const top = ranked[0];
    proposal[slot] = { pick: top.c, fits: top.c.fits, score: top.score, ranked: ranked.slice(0, 6), candidates: cands, budgetRelaxed };
    S.recordPick(ledger, slot, top.c.fits);
  }
  const notes = onlySlots ? [] : S.rebalance(proposal, ctx.people);
  ctx.proposal = proposal;
  if (notes.length) ctx.rebalanceNotes = notes;
  return notes;
}

function toolOverlap(ctx, _deps, args = {}) {
  const step = traceStart(ctx, { tool: 'group_overlap', title: 'Balanced the picks so nobody is left out' });
  const notes = computeOverlap(ctx, ctx.replanSlot ? [ctx.replanSlot] : undefined);
  const counts = ctx.people.map((p) => `${p.name} ${Object.values(ctx.proposal).filter((s) => s.fits?.[p.name]?.level === 'great').length}`);
  step.done(`Great fits per person: ${counts.join(', ')}${notes.length ? `. Swapped ${notes.map((n) => `${n.slot} to ${n.to} for ${n.person}`).join('; ')}` : ''}`);
  const want = Array.isArray(args.slots) && args.slots.length ? args.slots : S.SLOT_ORDER;
  return {
    recommended: Object.fromEntries(
      Object.entries(ctx.proposal)
        .filter(([slot]) => want.includes(slot))
        .map(([slot, s]) => [
          slot,
          slot === 'music'
            ? { playlist: s.tracks.map((t) => t.name), fit: Object.fromEntries(Object.entries(s.fits).map(([n, f]) => [n, `${f.level} via ${f.via || 'n/a'}`])) }
            : {
                entity_id: s.pick.id,
                name: s.pick.name,
                fit: Object.fromEntries(ctx.people.map((p) => [p.name, describeFit(ctx, slot, s.pick, p)])),
                alternatives: s.ranked.slice(1, 4).map((r) => ({ entity_id: r.c.id, name: r.c.name, score: r.score, fit: Object.fromEntries(ctx.people.map((p) => [p.name, r.c.fits[p.name]?.level])) })),
              },
        ]),
    ),
    rebalanced: notes,
  };
}

function describeFit(ctx, slot, pick, person) {
  const f = pick.fits?.[person.name];
  if (!f || f.norm == null) return 'no signal';
  const b = S.becauseFor(person, slot, pick);
  return `${f.level}${b ? ` (${b.text})` : ''}`;
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Commit picks. LLM choices are validated against Qloo candidates; anything invalid falls back to the proposal. */
function toolFinalize(ctx, _deps, args = {}) {
  const step = traceStart(ctx, { tool: 'finalize_plan', title: 'Wrote the plan' });
  if (!ctx.proposal) computeOverlap(ctx, ctx.replanSlot ? [ctx.replanSlot] : undefined);
  const issues = [];
  const picks = Array.isArray(args.picks) ? args.picks : [];
  const names = ctx.people.map((p) => p.name.toLowerCase());
  for (const slot of S.SLOT_ORDER) {
    if (ctx.replanSlot && slot !== ctx.replanSlot) continue;
    const prop = ctx.proposal[slot];
    if (!prop) continue;
    if (ctx.plan[slot] && args._onlyMissing) continue;
    const llm = picks.find((p) => p?.slot === slot);
    let chosen = prop;
    if (llm?.entity_id && slot !== 'music' && llm.entity_id !== prop.pick.id) {
      const alt = prop.candidates.find((c) => c.id === llm.entity_id);
      if (alt) chosen = { ...prop, pick: alt, fits: alt.fits };
      else issues.push(`${slot}: entity_id ${String(llm.entity_id).slice(0, 40)} was not among Qloo's candidates; kept the recommended pick`);
    }
    let reason = cleanText(llm?.reason, 400);
    let reasonBy = ctx.policy;
    const namesPerson = reason && names.some((n) => reason.toLowerCase().includes(n));
    const sameEntity = chosen.pick.id === (llm?.entity_id || chosen.pick.id) || slot === 'music';
    if (!reason || reason.length < 20 || !namesPerson || !sameEntity) {
      if (llm && reason) issues.push(`${slot}: reason replaced with Qloo-grounded template`);
      reason = null;
      reasonBy = 'template';
    }
    ctx.plan[slot] = { pick: chosen.pick, tracks: chosen.tracks, fits: chosen.fits, reason, reasonBy, ranked: chosen.ranked, budgetRelaxed: chosen.budgetRelaxed };
  }
  // Template reasons need to know who is served elsewhere.
  for (const slot of Object.keys(ctx.plan)) {
    const entry = ctx.plan[slot];
    if (!entry.reason || (ctx.replanSlot === slot && entry.reasonBy === 'template')) {
      const servedElsewhere = new Set(ctx.people.filter((p) => Object.entries(ctx.plan).some(([s, e]) => s !== slot && e.fits?.[p.name]?.level === 'great')).map((p) => p.name));
      entry.reason = S.buildReason(slot, entry.pick, entry.fits, ctx.people, { servedElsewhere });
      entry.reasonBy = 'template';
    }
  }
  const headline = cleanText(args.headline, 120);
  const title = cleanText(args.playlist_title, 60);
  if (headline) ctx.headline = headline;
  if (title) ctx.playlistTitle = title;
  ctx.finalized = true;
  step.done(`${Object.keys(ctx.plan).length} picks committed${issues.length ? `; ${issues.length} corrected` : ''}`);
  return { ok: true, committed: Object.fromEntries(Object.entries(ctx.plan).map(([s, e]) => [s, e.pick?.name])), issues };
}

// ---------------------------------------------------------------------------
// Gemini policy
// ---------------------------------------------------------------------------

const SLOT_ENUM = ['dinner', 'activity', 'film', 'music'];
export const TOOL_DECLARATIONS = [
  {
    name: 'qloo_search',
    description: 'Resolve the people’s favourites (artists, films, shows, books, places, or foods/cuisines) to Qloo entities or cuisine tags. Call once with every favourite from the brief.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              person: { type: 'string' },
              text: { type: 'string', description: 'The favourite exactly as written in the brief' },
              kind: { type: 'string', enum: KINDS, description: 'Use food for dishes or cuisines; auto if unsure' },
            },
            required: ['person', 'text'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'qloo_insights',
    description:
      'Ask Qloo Taste AI for candidates for one slot, using every person’s resolved favourites as signals, then score each candidate for each person separately. taste_profile returns the tags the group shares. Call taste_profile, dinner, activity, film and music in parallel.',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'string', enum: ['taste_profile', ...SLOT_ENUM] },
        avoid: { type: 'array', items: { type: 'string' }, description: 'Words to exclude, e.g. sushi' },
        max_price_level: { type: 'integer', description: 'Maximum price level 1-4 for places' },
        prefer: { type: 'array', items: { type: 'string' }, description: 'Tag words to favour, e.g. comedy, live music' },
      },
      required: ['slot'],
    },
  },
  {
    name: 'group_overlap',
    description: 'Combine group and per-person Qloo affinities into a fair plan: maximises group fit while making sure each person gets at least one great match. Returns the recommended pick per slot with alternatives.',
    parameters: { type: 'object', properties: { slots: { type: 'array', items: { type: 'string', enum: SLOT_ENUM } } } },
  },
  {
    name: 'finalize_plan',
    description: 'Commit the plan. Use entity_id values from group_overlap only. Each reason names who the pick fits and why, using only facts from tool results.',
    parameters: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: 'At most 12 words describing the night' },
        playlist_title: { type: 'string', description: 'At most 6 words' },
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slot: { type: 'string', enum: SLOT_ENUM },
              entity_id: { type: 'string', description: 'Omit for music' },
              reason: { type: 'string', description: '1-2 sentences, e.g. "Matches Ana’s indie folk and Ben’s love of Korean food."' },
            },
            required: ['slot', 'reason'],
          },
        },
      },
      required: ['picks'],
    },
  },
];

const PLAN_SYSTEM = `You are TasteFit, a concierge agent that plans one outing for a group of friends whose tastes differ.
Ground every pick in Qloo data from your tools. Never invent venues, titles, artists, scores or facts.
Work in four steps, using as few turns as possible:
1. Call qloo_search once with every favourite in the brief (kind "food" for dishes or cuisines).
2. In ONE turn, call qloo_insights for taste_profile, dinner, activity, film and music in parallel. Only pass avoid / max_price_level / prefer if the brief asks for it.
3. Call group_overlap.
4. Call finalize_plan with one pick per slot. Use the recommended entity_id unless an alternative clearly fits the brief better. Each reason is 1-2 plain sentences that name the people it fits and why, citing their favourites (for example "Matches Ana's indie folk and Ben's love of Korean food"). Be honest when a pick is a stretch for someone. Add a headline (max 12 words) and a playlist_title (max 6 words).
Keep any text outside tool calls to one short sentence.`;

function briefFor(ctx) {
  const occ = OCCASIONS[ctx.occasion];
  const lines = [
    `City: ${ctx.city}`,
    `Occasion: ${occ.label}`,
    `Budget: ${'$'.repeat(ctx.budget)}${BUDGET_MAX_PRICE[ctx.budget] ? ` (max price level ${BUDGET_MAX_PRICE[ctx.budget]})` : ''}`,
  ];
  if (ctx.notes) lines.push(`Notes from the group: ${ctx.notes}`);
  lines.push('People and favourites:');
  for (const p of ctx.people) lines.push(`- ${p.name}: ${p.favorites.map((f) => (f.kind !== 'auto' ? `${f.input} (${f.kind})` : f.input)).join('; ')}`);
  return lines.join('\n');
}

function makeToolRunner(ctx, deps) {
  return async (name, args = {}) => {
    try {
      if (name === 'qloo_search') return await toolSearch(ctx, deps, args);
      if (name === 'qloo_insights') {
        const slot = args.slot;
        if (!SLOT_SPECS[slot]) return { error: `Unknown slot ${slot}` };
        const constraints = {};
        if (Array.isArray(args.avoid)) constraints.excludeTerms = args.avoid.map((x) => cleanText(x, 30)).filter(Boolean).slice(0, 5);
        if (Number.isInteger(args.max_price_level) && args.max_price_level >= 1 && args.max_price_level <= 4) constraints.maxPriceLevel = args.max_price_level;
        if (Array.isArray(args.prefer)) constraints.preferTerms = args.prefer.map((x) => cleanText(x, 30)).filter(Boolean).slice(0, 5);
        await ensureResolved(ctx, deps);
        if (ctx.replanSlot && slot !== ctx.replanSlot && slot !== 'taste_profile') return { error: `Only ${ctx.replanSlot} can change in this re-plan.` };
        return await fetchSlot(ctx, deps, slot, { constraints });
      }
      if (name === 'group_overlap') return toolOverlap(ctx, deps, args);
      if (name === 'finalize_plan') return toolFinalize(ctx, deps, args);
      return { error: `Unknown tool ${name}` };
    } catch (err) {
      return { error: err.message };
    }
  };
}

async function geminiLoop(ctx, deps, { system, brief, declarations, maxTurns = 8, reserveMs = 6000 }) {
  const run = makeToolRunner(ctx, deps);
  const contents = [{ role: 'user', parts: [{ text: brief }] }];
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const left = remaining(ctx) - reserveMs;
    if (left < 2500) {
      traceStart(ctx, { kind: 'system', title: 'Time budget reached, finishing with the scripted planner', by: 'system' }).done('');
      break;
    }
    const step = traceStart(ctx, { kind: 'model', title: turn === 0 ? `${deps.llm.model} read the brief` : `${deps.llm.model} chose the next step` });
    let out;
    try {
      out = await deps.llm.generate({ system, contents, functionDeclarations: declarations, timeoutMs: Math.min(12000, left) });
    } catch (err) {
      step.done(err.message, 'error');
      throw err;
    }
    ctx.stats.modelTurns += 1;
    contents.push(out.content);
    step.done(out.functionCalls.length ? `Calling ${out.functionCalls.map((c) => (c.name === 'qloo_insights' ? `qloo_insights(${c.args?.slot})` : c.name)).join(', ')}` : out.text.slice(0, 160) || 'Finished');
    if (!out.functionCalls.length) break;
    const results = await Promise.all(out.functionCalls.slice(0, 8).map(async (fc) => ({ id: fc.id, name: fc.name, response: await run(fc.name, fc.args) })));
    contents.push(functionResponseTurn(results));
    if (ctx.finalized) break;
  }
}

// ---------------------------------------------------------------------------
// Scripted policy (also completes whatever the LLM left unfinished)
// ---------------------------------------------------------------------------

async function scriptedComplete(ctx, deps) {
  const prevPolicy = ctx.policy;
  if (ctx.policy === 'gemini') ctx.policy = 'scripted';
  await ensureResolved(ctx, deps);
  const missing = S.SLOT_ORDER.filter((s) => !ctx.slots[s]);
  const jobs = missing.map((s) => fetchSlot(ctx, deps, s));
  if (!ctx.tasteProfileTried && remaining(ctx) > 3000) jobs.push(fetchSlot(ctx, deps, 'taste_profile'));
  await Promise.all(jobs);
  const planned = S.SLOT_ORDER.filter((s) => ctx.plan[s]);
  const plannable = S.SLOT_ORDER.filter((s) => ctx.slots[s]?.candidates?.length);
  if (!ctx.finalized || plannable.some((s) => !planned.includes(s))) {
    if (!ctx.proposal || missing.length) toolOverlap(ctx, deps, {});
    toolFinalize(ctx, deps, { _onlyMissing: ctx.finalized });
  }
  ctx.policy = prevPolicy;
}

// ---------------------------------------------------------------------------
// Public API: plan + replan
// ---------------------------------------------------------------------------

export async function planNight(input, { qloo, llm, emit, budgetMs = 24000 } = {}) {
  const ctx = createContext(input, emit, budgetMs);
  ctx.emit({ type: 'meta', mode: modeInfo({ qloo, llm }) });
  let agentUsed = 'scripted';
  if (llm) {
    ctx.policy = 'gemini';
    try {
      await geminiLoop(ctx, { qloo, llm }, { system: PLAN_SYSTEM, brief: briefFor(ctx), declarations: TOOL_DECLARATIONS });
      agentUsed = 'gemini';
    } catch (err) {
      agentUsed = 'scripted-fallback';
      traceStart(ctx, { kind: 'system', title: 'Gemini was unavailable, so the scripted planner finished the job', by: 'system' }).done(err.message, 'error');
    }
  }
  await scriptedComplete(ctx, { qloo, llm });
  return buildResult(ctx, { qloo, llm, agentUsed });
}

const REPLAN_SYSTEM = `You are TasteFit, re-planning ONE slot of a group outing after a request from the group.
Use only Qloo data from tools. Steps: (1) call qloo_insights for the slot to change, passing avoid / max_price_level / prefer that capture the request; (2) call group_overlap with just that slot; (3) call finalize_plan with a pick for that slot only and a 1-2 sentence reason naming who it fits and how it answers the request. Never pick the current choice again.`;

export async function replanSlot(sessionIn, request, { qloo, llm, emit, budgetMs = 18000 } = {}) {
  const ctx = restoreContext(sessionIn, emit, budgetMs);
  ctx.emit({ type: 'meta', mode: modeInfo({ qloo, llm }) });
  const instruction = str(request?.instruction, 200);
  const parsed = S.parseInstruction(instruction);
  const slot = S.SLOT_ORDER.includes(request?.slot) ? request.slot : parsed.slot;
  if (!slot) {
    return { error: 'Say which part to change: dinner, the place after, the film or the playlist. For example, “cheaper dinner” or “a lighter film”.' };
  }
  const before = ctx.plan[slot];
  ctx.replanSlot = slot;
  const step = traceStart(ctx, { kind: 'system', title: `Re-planning ${labelFor(ctx, slot).toLowerCase()}: ${parsed.summary}`, by: 'system' });
  step.done(instruction);

  // Hard constraints from the instruction, always enforced.
  const st = ctx.slots[slot] || { candidates: [], constraints: {}, excluded: [] };
  const cons = { ...(st.constraints || {}) };
  if (parsed.constraints.excludeTerms.length) cons.excludeTerms = uniq([...(cons.excludeTerms || []), ...parsed.constraints.excludeTerms]);
  if (parsed.constraints.preferTerms.length) cons.preferTerms = parsed.constraints.preferTerms;
  else delete cons.preferTerms;
  if (parsed.constraints.cheaper) {
    const current = before?.pick?.priceLevel ?? BUDGET_MAX_PRICE[ctx.budget] ?? 3;
    cons.maxPriceLevel = Math.max(1, current - 1);
  }
  cons.closer = Boolean(parsed.constraints.closer);
  const excluded = uniq([...(st.excluded || []), ...(before?.pick ? [before.pick.id] : []), ...(slot === 'music' ? (before?.tracks || []).map((t) => t.id) : [])]);
  ctx.slots[slot] = { ...st, constraints: cons, excluded };

  // Need more (or better-matching) candidates? Ask Qloo again: a bigger page,
  // with any preference resolved to a Qloo tag and sent as a signal.
  const usable = () => S.applyConstraints(ctx.slots[slot].candidates || [], slotConstraints(ctx, slot));
  const preferUnmet = cons.preferTerms?.length && !usable().some((c) => S.matchesTerms(c, cons.preferTerms));
  if (usable().length < (slot === 'music' ? 6 : 2) || preferUnmet) {
    const extraSignalTags = cons.preferTerms?.length ? await resolvePreferenceTags(qloo, slot, cons.preferTerms) : [];
    // 20 matches the result budget Qloo's own harness uses per request.
    await fetchSlot(ctx, { qloo }, slot, { constraints: cons, take: 20, extraSignalTags });
    ctx.slots[slot].excluded = excluded;
  }

  let agentUsed = 'scripted';
  if (llm) {
    ctx.policy = 'gemini';
    const brief = `${briefFor(ctx)}\n\nCurrent plan:\n${Object.entries(ctx.plan)
      .map(([s, e]) => `- ${s}: ${e.pick?.name}`)
      .join('\n')}\n\nSlot to change: ${slot}\nRequest: ${instruction || 'something different'}`;
    try {
      ctx.finalized = false;
      await geminiLoop(ctx, { qloo, llm }, { system: REPLAN_SYSTEM, brief, declarations: TOOL_DECLARATIONS.filter((d) => d.name !== 'qloo_search'), maxTurns: 4, reserveMs: 3000 });
      agentUsed = 'gemini';
    } catch (err) {
      agentUsed = 'scripted-fallback';
      traceStart(ctx, { kind: 'system', title: 'Gemini was unavailable, so the scripted planner made the swap', by: 'system' }).done(err.message, 'error');
    }
    ctx.policy = 'scripted';
  }
  // Re-apply hard constraints in case the LLM loosened them, then commit.
  ctx.slots[slot].constraints = { ...cons, ...(ctx.slots[slot].constraints || {}), excludeTerms: cons.excludeTerms, maxPriceLevel: cons.maxPriceLevel ?? ctx.slots[slot].constraints?.maxPriceLevel, closer: cons.closer };
  ctx.slots[slot].excluded = excluded;
  const after = ctx.plan[slot];
  const llmPickOk = agentUsed === 'gemini' && after && after.pick?.id !== before?.pick?.id && S.applyConstraints([after.pick], slotConstraints(ctx, slot)).length === 1;
  if (!llmPickOk) {
    ctx.proposal = null;
    const swap = traceStart(ctx, { tool: 'group_overlap', title: `Re-scored ${labelFor(ctx, slot).toLowerCase()} options with your request` });
    computeOverlap(ctx, [slot]);
    swap.done(ctx.proposal[slot] ? `Best remaining: ${ctx.proposal[slot].pick.name}` : 'No option meets the request');
    if (ctx.proposal[slot]) {
      const prop = ctx.proposal[slot];
      const servedElsewhere = new Set(ctx.people.filter((p) => Object.entries(ctx.plan).some(([s, e]) => s !== slot && e.fits?.[p.name]?.level === 'great')).map((p) => p.name));
      ctx.plan[slot] = { pick: prop.pick, tracks: prop.tracks, fits: prop.fits, ranked: prop.ranked, reason: S.buildReason(slot, prop.pick, prop.fits, ctx.people, { servedElsewhere }), reasonBy: 'template', budgetRelaxed: prop.budgetRelaxed };
    }
  }
  const changed = ctx.plan[slot]?.pick?.id !== before?.pick?.id;
  const result = buildResult(ctx, { qloo, llm, agentUsed });
  const fromName = slot === 'music' ? 'the playlist' : before?.pick?.name;
  const toName = slot === 'music' ? 'a new mix' : ctx.plan[slot]?.pick?.name;
  result.message = changed
    ? `Swapped ${labelFor(ctx, slot).toLowerCase()}: ${fromName} → ${toName} (${parsed.summary}).`
    : `Nothing in Qloo’s results for ${labelFor(ctx, slot).toLowerCase()} meets “${instruction}”, so I kept ${fromName}.`;
  result.changedSlot = changed ? slot : null;
  return result;
}

const labelFor = (ctx, slot) => OCCASIONS[ctx.occasion].labels[slot];

// ---------------------------------------------------------------------------
// Result + session (round-tripped through the browser; the API is stateless)
// ---------------------------------------------------------------------------

function publicEntity(e) {
  if (!e) return null;
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    type: e.type,
    description: e.description,
    year: e.year,
    address: e.address,
    priceLevel: e.priceLevel,
    rating: e.rating,
    image: e.image,
    tags: (e.tags || []).filter((t) => t.id !== RESTAURANT_TAG).slice(0, 4).map((t) => t.name),
    popularity: e.popularity,
    groupAffinity: e.groupAffinity,
  };
}

function signalsFor(ctx, pick) {
  const owners = new Map();
  for (const p of ctx.people) for (const f of p.favorites) if (f.entity) owners.set(f.entity.id, [...(owners.get(f.entity.id) || []), { person: p.name, name: f.entity.name }]);
  return (pick?.explain || [])
    .filter((e) => owners.has(e.id) && e.score > 0)
    .slice(0, 4)
    .map((e) => ({ name: owners.get(e.id)[0].name, people: owners.get(e.id).map((o) => o.person), score: round(e.score) }));
}

function buildResult(ctx, { qloo, llm, agentUsed }) {
  const occ = OCCASIONS[ctx.occasion];
  const slots = S.SLOT_ORDER.filter((s) => ctx.plan[s] || ctx.slots[s]).map((slot) => {
    const entry = ctx.plan[slot];
    const st = ctx.slots[slot] || {};
    const base = { slot, label: occ.labels[slot], time: occ.times[slot] };
    if (!entry?.pick) return { ...base, empty: true, message: 'Qloo returned nothing usable for this part of the night. Try another city or different favourites.' };
    const fits = ctx.people.map((p) => {
      const f = entry.fits?.[p.name] || {};
      const because = f.norm != null ? (slot === 'music' ? (f.via ? { text: f.via } : null) : S.becauseFor(p, slot, entry.pick)) : null;
      return { person: p.name, color: p.color, raw: round(f.raw), norm: round(f.norm), level: f.level || 'unknown', because: because?.text || null, source: because?.source || null };
    });
    const out = {
      ...base,
      pick: publicEntity(entry.pick),
      reason: entry.reason,
      reasonBy: entry.reasonBy,
      fits,
      evidence: {
        signals: signalsFor(ctx, entry.pick),
        alternatives: (entry.ranked || [])
          .filter((r) => r.c.id !== entry.pick.id && !(entry.tracks || []).some((t) => t.id === r.c.id))
          .slice(0, 3)
          .map((r) => ({ name: r.c.name, score: r.score, groupAffinity: round(r.c.groupAffinity), fits: Object.fromEntries(ctx.people.map((p) => [p.name, round(r.c.fits?.[p.name]?.norm)])) })),
        pickScore: (entry.ranked || []).find((r) => r.c.id === entry.pick.id)?.score ?? null,
        request: st.request ? { path: st.request.path, params: summarizeParams(st.request.params) } : null,
        personCalls: st.personCalls || 0,
        candidates: st.candidates?.length || 0,
        relaxed: Boolean(st.relaxed),
        budgetRelaxed: Boolean(entry.budgetRelaxed),
        constraints: describeConstraints(st.constraints),
      },
    };
    if (slot === 'music') {
      out.pick = { name: ctx.playlistTitle || playlistTitle(ctx, entry.tracks), kind: 'playlist' };
      out.tracks = (entry.tracks || []).map((t) => ({
        ...publicEntity(t),
        fitsFor: ctx.people.filter((p) => t.fits?.[p.name]?.level === 'great').map((p) => p.name),
      }));
    }
    if (slot === 'activity' && ctx.plan.dinner?.pick?.lat != null && entry.pick.lat != null) out.distanceKm = Math.round(S.haversineKm(ctx.plan.dinner.pick, entry.pick) * 10) / 10;
    return out;
  });
  const fairness = ctx.people.map((p) => ({
    person: p.name,
    color: p.color,
    great: slots.filter((s) => s.fits?.find((f) => f.person === p.name)?.level === 'great').map((s) => s.label),
    hasSignal: p.favorites.some((f) => f.entity || f.tag),
  }));
  const favs = ctx.people.flatMap((p) => p.favorites);
  const live = qloo.calls.filter((c) => !c.cached);
  return {
    plan: {
      city: ctx.city,
      occasion: ctx.occasion,
      occasionLabel: occ.label,
      budget: ctx.budget,
      headline: ctx.headline || headlineFor(ctx),
      people: ctx.people.map((p) => ({
        name: p.name,
        color: p.color,
        favorites: p.favorites.map((f) => ({ input: f.input, kind: f.kind, status: f.status, match: f.entity?.name || f.tag?.name || null })),
      })),
      tasteProfile: ctx.tasteProfile,
      slots,
      fairness,
      rebalanced: ctx.rebalanceNotes,
      stats: {
        qlooRequests: qloo.calls.length,
        qlooLive: live.length,
        qlooCached: qloo.calls.length - live.length,
        favoritesResolved: favs.filter((f) => f.status === 'matched').length,
        favoritesTotal: favs.length,
        candidatesScored: S.SLOT_ORDER.reduce((n, s) => n + (ctx.slots[s]?.candidates?.length || 0), 0),
        modelTurns: ctx.stats.modelTurns,
        ms: Date.now() - ctx.startedAt,
      },
      mode: { ...modeInfo({ qloo, llm }), agentUsed },
    },
    trace: ctx.trace,
    session: toSession(ctx),
  };
}

function summarizeParams(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    const arr = Array.isArray(v) ? v : String(v).split(',');
    out[k] = arr.length > 3 ? `${arr.slice(0, 2).join(',')},… (${arr.length} ids)` : Array.isArray(v) ? v.join(',') : String(v);
  }
  return out;
}

function describeConstraints(c = {}) {
  const out = [];
  if (c.maxPriceLevel) out.push(`price level ≤ ${c.maxPriceLevel}`);
  if (c.excludeTerms?.length) out.push(`no ${c.excludeTerms.join(', no ')}`);
  if (c.preferTerms?.length) out.push(`prefer ${c.preferTerms.slice(0, 3).join(', ')}`);
  if (c.closer) out.push('closer to the rest of the night');
  return out;
}

function headlineFor(ctx) {
  const d = ctx.plan.dinner?.pick;
  const a = ctx.plan.activity?.pick;
  const f = ctx.plan.film?.pick;
  const cuisine = d?.tags?.find((t) => t.id !== RESTAURANT_TAG)?.name;
  const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
  const parts = [];
  if (d) parts.push(cuisine ? `${cuisine} at ${d.name}` : d.name);
  if (a) {
    const kind = a.tags?.[0]?.name?.toLowerCase();
    parts.push(kind ? `${article(kind)} ${kind} after` : `${a.name} after`);
  }
  if (f) parts.push(`then ${f.name} ${OCCASIONS[ctx.occasion].times.film.toLowerCase()}`);
  return parts.length ? `${parts.join(', ')}.` : `A ${OCCASIONS[ctx.occasion].label.toLowerCase()} in ${ctx.city}.`;
}

function playlistTitle(ctx, tracks = []) {
  const counts = new Map();
  for (const t of tracks) for (const tag of t.tags || []) counts.set(tag.name, (counts.get(tag.name) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  if (top.length >= 2) return `${top[0]} meets ${top[1]}`;
  return `${ctx.city} ${ctx.occasion === 'day_out' ? 'daytime' : 'after dark'}`;
}

const SESSION_VERSION = 1;
function packEntity(e) {
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    type: e.type,
    description: e.description,
    year: e.year,
    address: e.address,
    priceLevel: e.priceLevel,
    rating: e.rating,
    image: e.image,
    lat: e.lat,
    lon: e.lon,
    popularity: e.popularity,
    affinity: e.affinity,
    groupAffinity: e.groupAffinity,
    groupNorm: e.groupNorm,
    explain: (e.explain || []).slice(0, 4),
    tags: (e.tags || []).slice(0, 6),
    fits: Object.fromEntries(Object.entries(e.fits || {}).map(([n, f]) => [n, { raw: f.raw, norm: f.norm, explain: (f.explain || []).slice(0, 2) }])),
  };
}

function toSession(ctx) {
  return {
    v: SESSION_VERSION,
    city: ctx.city,
    occasion: ctx.occasion,
    budget: ctx.budget,
    notes: ctx.notes,
    people: ctx.people,
    tasteProfile: ctx.tasteProfile,
    headline: ctx.headline,
    playlistTitle: ctx.playlistTitle,
    rebalanceNotes: ctx.rebalanceNotes,
    slots: Object.fromEntries(
      Object.entries(ctx.slots)
        .filter(([s]) => S.SLOT_ORDER.includes(s))
        .map(([s, st]) => [s, { candidates: (st.candidates || []).map(packEntity), request: st.request, personCalls: st.personCalls, relaxed: st.relaxed, constraints: st.constraints || {}, excluded: st.excluded || [] }]),
    ),
    plan: Object.fromEntries(
      Object.entries(ctx.plan).map(([s, e]) => [
        s,
        {
          pickId: e.pick?.id,
          trackIds: (e.tracks || []).map((t) => t.id),
          reason: e.reason,
          reasonBy: e.reasonBy,
          budgetRelaxed: e.budgetRelaxed,
          ranked: (e.ranked || []).slice(0, 6).map((r) => ({ id: r.c.id, score: r.score })),
        },
      ]),
    ),
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const sstr = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);

function unpackEntity(raw, people) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  const fits = {};
  for (const p of people) {
    const f = raw.fits?.[p.name];
    const norm = num(f?.norm) ?? null;
    fits[p.name] = { raw: num(f?.raw) ?? null, norm, level: S.fitLevel(norm), explain: Array.isArray(f?.explain) ? f.explain.filter((x) => typeof x?.id === 'string').slice(0, 6).map((x) => ({ id: x.id, score: num(x.score) ?? 0 })) : [] };
  }
  return {
    id: sstr(raw.id, 120),
    name: sstr(raw.name, 200),
    kind: sstr(raw.kind, 20),
    type: sstr(raw.type, 60),
    description: sstr(raw.description, 400),
    year: num(raw.year),
    address: sstr(raw.address, 200),
    priceLevel: num(raw.priceLevel),
    rating: num(raw.rating),
    image: typeof raw.image === 'string' && /^https:\/\//.test(raw.image) ? raw.image.slice(0, 500) : undefined,
    lat: num(raw.lat),
    lon: num(raw.lon),
    popularity: num(raw.popularity),
    affinity: num(raw.affinity),
    groupAffinity: num(raw.groupAffinity),
    groupNorm: num(raw.groupNorm) ?? 0.5,
    explain: Array.isArray(raw.explain) ? raw.explain.filter((x) => typeof x?.id === 'string').slice(0, 6).map((x) => ({ id: x.id, score: num(x.score) ?? 0 })) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t?.id === 'string' && typeof t?.name === 'string').slice(0, 6).map((t) => ({ id: t.id.slice(0, 120), name: t.name.slice(0, 60), type: sstr(t.type, 60) })) : [],
    fits,
  };
}

/** Rebuild an agent context from a browser-held session, validating every field. */
export function restoreContext(session, emit, budgetMs = 18000) {
  if (!session || session.v !== SESSION_VERSION || !Array.isArray(session.people)) throw new Error('This plan has expired. Plan the night again.');
  const input = validatePlanInput({
    city: session.city,
    occasion: session.occasion,
    budget: session.budget,
    notes: session.notes,
    people: session.people.slice(0, 5).map((p) => ({ name: p?.name, favorites: (p?.favorites || []).map((f) => ({ text: f?.input, kind: f?.kind })) })),
  });
  if (input.error) throw new Error(input.error);
  const ctx = createContext(input.value, emit, budgetMs);
  // Restore resolved favourites.
  ctx.people.forEach((p, i) => {
    const src = session.people[i]?.favorites || [];
    p.favorites.forEach((f, j) => {
      const s = src[j] || {};
      f.status = ['matched', 'missing'].includes(s.status) ? s.status : 'missing';
      if (s.entity && typeof s.entity.id === 'string') f.entity = { id: s.entity.id.slice(0, 120), name: sstr(s.entity.name, 200) || f.input, type: sstr(s.entity.type, 60), kind: sstr(s.entity.kind, 20), tags: (s.entity.tags || []).filter((t) => typeof t?.id === 'string').slice(0, 4) };
      if (s.tag && typeof s.tag.id === 'string') f.tag = { id: s.tag.id.slice(0, 120), name: sstr(s.tag.name, 60) || f.input };
      if (!f.entity && !f.tag) f.status = 'missing';
    });
  });
  ctx.tasteProfile = Array.isArray(session.tasteProfile) ? session.tasteProfile.slice(0, 8).filter((t) => typeof t?.name === 'string').map((t) => ({ id: sstr(t.id, 120), name: t.name.slice(0, 60), affinity: num(t.affinity) ?? null })) : [];
  ctx.tasteProfileTried = true;
  ctx.headline = sstr(session.headline, 120) || null;
  ctx.playlistTitle = sstr(session.playlistTitle, 60) || null;
  for (const slot of S.SLOT_ORDER) {
    const st = session.slots?.[slot];
    if (!st) continue;
    const candidates = (Array.isArray(st.candidates) ? st.candidates : []).slice(0, 40).map((c) => unpackEntity(c, ctx.people)).filter(Boolean);
    const cons = st.constraints || {};
    ctx.slots[slot] = {
      candidates,
      request: st.request && typeof st.request.path === 'string' ? { path: st.request.path.slice(0, 40), params: Object.fromEntries(Object.entries(st.request.params || {}).slice(0, 20).map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 2000)])) } : null,
      personCalls: num(st.personCalls) || 0,
      relaxed: Boolean(st.relaxed),
      constraints: {
        maxPriceLevel: [1, 2, 3, 4].includes(cons.maxPriceLevel) ? cons.maxPriceLevel : undefined,
        excludeTerms: Array.isArray(cons.excludeTerms) ? cons.excludeTerms.map((t) => sstr(t, 30)).filter(Boolean).slice(0, 8) : [],
        preferTerms: Array.isArray(cons.preferTerms) ? cons.preferTerms.map((t) => sstr(t, 30)).filter(Boolean).slice(0, 8) : [],
      },
      excluded: Array.isArray(st.excluded) ? st.excluded.filter((x) => typeof x === 'string').slice(0, 60) : [],
    };
    const entry = session.plan?.[slot];
    const pick = candidates.find((c) => c.id === entry?.pickId);
    if (pick) {
      const tracks = slot === 'music' ? (entry.trackIds || []).map((id) => candidates.find((c) => c.id === id)).filter(Boolean) : undefined;
      let fits = pick.fits;
      if (slot === 'music' && tracks?.length) {
        fits = {};
        for (const p of ctx.people) {
          const best = tracks.filter((t) => t.fits[p.name]?.norm != null).sort((a, b) => b.fits[p.name].norm - a.fits[p.name].norm)[0];
          const norm = best ? best.fits[p.name].norm : null;
          fits[p.name] = { raw: best?.fits[p.name].raw ?? null, norm, level: S.fitLevel(norm), via: best?.name };
        }
      }
      const ranked = (Array.isArray(entry.ranked) ? entry.ranked : [])
        .slice(0, 6)
        .map((r) => ({ c: candidates.find((c) => c.id === r?.id), score: num(r?.score) ?? 0 }))
        .filter((r) => r.c);
      ctx.plan[slot] = { pick, tracks, fits, reason: sstr(entry.reason, 400) || null, reasonBy: ['gemini', 'template', 'scripted'].includes(entry.reasonBy) ? entry.reasonBy : 'template', ranked, budgetRelaxed: Boolean(entry.budgetRelaxed) };
    }
  }
  ctx.finalized = true;
  return ctx;
}
