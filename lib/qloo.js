/**
 * Qloo API client used by the TasteFit agent.
 *
 * API facts below were taken from Qloo's official hackathon harness
 * (@qloo/qloo-harness 0.1.26), whose client is pinned to Qloo's OpenAPI 2.0
 * spec (retrieved 2026-08-20):
 *   - production base URL  https://api.qloo.com   (override with QLOO_BASE_URL)
 *   - auth header          X-Api-Key: <key>
 *   - all calls are GET; array params are sent comma-separated
 *   - GET /search          query, types, take
 *   - GET /v2/insights     filter.type, signal.interests.entities, signal.interests.tags,
 *                          filter.location.query, filter.tags, filter.exclude.tags,
 *                          operator.filter.tags, filter.results.entities, take,
 *                          feature.explainability
 *   - GET /v2/tags         filter.query, feature.semantic_search, take
 * Response shapes: entity lists live in `results` (array) or `results.entities`;
 * tag lists in `results.tags`. Insights entities carry `query.affinity`.
 *
 * Not in the pinned spec, so treated as best-effort: the restaurant category tag
 * (QLOO_RESTAURANT_TAG) and the per-signal shape of `query.explainability`.
 * Both degrade gracefully (relaxed retry / empty attribution).
 */

export const QLOO_DEFAULT_BASE_URL = 'https://api.qloo.com';

/** Insights-capable entity types (urn:entity:*) from the pinned spec. */
export const ENTITY_TYPES = Object.freeze({
  artist: 'urn:entity:artist',
  movie: 'urn:entity:movie',
  tv_show: 'urn:entity:tv_show',
  book: 'urn:entity:book',
  place: 'urn:entity:place',
  person: 'urn:entity:person',
  podcast: 'urn:entity:podcast',
  brand: 'urn:entity:brand',
  videogame: 'urn:entity:videogame',
});

/** UI kind for an entity/tag type URN. */
export function kindFromType(type = '') {
  if (type.startsWith('urn:tag')) return 'food';
  const key = type.replace('urn:entity:', '').split(':')[0];
  return (
    { artist: 'music', movie: 'film', tv_show: 'tv', book: 'book', place: 'place', person: 'person', podcast: 'podcast', brand: 'brand', videogame: 'game', author: 'book', album: 'music', actor: 'person', director: 'person' }[key] ||
    'other'
  );
}

export class QlooError extends Error {
  constructor(message, { status, retryable = false, path } = {}) {
    super(message);
    this.name = 'QlooError';
    this.status = status;
    this.retryable = retryable;
    this.path = path;
  }
}

/**
 * Build a Qloo request URL. Arrays are joined with commas (Qloo's documented
 * list format); empty values are dropped.
 */
export function buildQlooUrl(baseUrl, path, params = {}) {
  const base = new URL(baseUrl || QLOO_DEFAULT_BASE_URL);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new QlooError('Qloo base URL must use HTTPS.');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  const url = new URL(String(path).replace(/^\/+/, ''), base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    const serialized = Array.isArray(value) ? value.filter((v) => v !== '' && v != null).join(',') : String(value);
    if (serialized !== '') url.searchParams.set(key, serialized);
  }
  return url;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Create a client. `fetchImpl` is injectable: demo mode passes the mock fetch
 * from lib/mock-qloo.js so the exact same URL-building and parsing code runs.
 */
export function createQlooClient({
  apiKey,
  baseUrl = QLOO_DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 7000,
  maxAttempts = 2,
  mode = 'live',
  cache = sharedCache,
  concurrency = 6,
} = {}) {
  if (!apiKey) throw new QlooError('Qloo API key is required.');
  const calls = []; // per-client call log, surfaced to the UI as evidence

  // Simple semaphore so parallel per-person calls never flood the API.
  let active = 0;
  const waiting = [];
  const acquire = () => (active < concurrency ? (active += 1, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  async function get(path, params) {
    await acquire();
    try {
      return await getUnlimited(path, params);
    } finally {
      release();
    }
  }

  async function getUnlimited(path, params) {
    const url = buildQlooUrl(baseUrl, path, params);
    const cacheKey = `${mode}|${url}`;
    const started = Date.now();
    const cached = cache?.get(cacheKey);
    if (cached) {
      calls.push({ path, params, ms: 0, status: 200, cached: true });
      return cached;
    }
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
          signal: controller.signal,
        });
        const text = await res.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new QlooError('Qloo returned invalid JSON.', { status: res.status, retryable: res.status >= 500, path });
        }
        if (!res.ok) {
          const message = body?.error?.message || body?.message || `Qloo request failed (HTTP ${res.status}).`;
          throw new QlooError(message, { status: res.status, retryable: RETRYABLE.has(res.status), path });
        }
        calls.push({ path, params, ms: Date.now() - started, status: res.status, cached: false });
        cache?.set(cacheKey, body);
        return body;
      } catch (err) {
        lastError =
          err instanceof QlooError
            ? err
            : new QlooError(err?.name === 'AbortError' ? 'Qloo request timed out.' : 'Could not reach the Qloo API.', { retryable: true, path });
        if (!lastError.retryable || attempt === maxAttempts) break;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    calls.push({ path, params, ms: Date.now() - started, status: lastError?.status || 0, cached: false, error: lastError?.message });
    throw lastError;
  }

  return {
    mode,
    calls,
    /** GET /search: resolve free text to entities. */
    search: ({ query, types, take = 5 }) => get('/search', { query, types, take }),
    /** GET /v2/insights: Qloo Taste AI recommendations / ranking. */
    insights: (params) => get('/v2/insights', params),
    /** GET /v2/tags: tag ontology search. */
    tags: (params) => get('/v2/tags', params),
  };
}

/** Small TTL cache shared by warm serverless invocations. */
export function createTtlCache({ ttlMs = 10 * 60 * 1000, max = 500 } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      map.set(key, { at: Date.now(), value });
      if (map.size > max) map.delete(map.keys().next().value);
    },
    clear: () => map.clear(),
  };
}
const sharedCache = createTtlCache();

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : undefined);

/** Entity list from /search (`results: []`) or /v2/insights (`results.entities`). */
export function entitiesFrom(response) {
  const results = response?.results;
  if (Array.isArray(results)) return results;
  if (results && Array.isArray(results.entities)) return results.entities;
  return [];
}

/** Tag list from /v2/tags or an urn:tag insights call (`results.tags`). */
export function tagsFrom(response) {
  const results = response?.results;
  if (Array.isArray(results)) return results;
  if (results && Array.isArray(results.tags)) return results.tags;
  return [];
}

/**
 * Per-signal attribution from `query.explainability`, when Qloo includes it.
 * Accepts the documented-in-examples shape
 *   { "signal.interests.entities": [{ entity_id, score }] }
 * and a few tolerant variants. Returns [{ id, score }] sorted by score.
 */
export function parseExplainability(raw) {
  if (!raw) return [];
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'object') {
    const bucket = raw['signal.interests.entities'] ?? raw.signal_interests_entities ?? raw.entities ?? raw.signals;
    if (Array.isArray(bucket)) list = bucket;
    else if (bucket && typeof bucket === 'object') list = Object.entries(bucket).map(([id, score]) => ({ entity_id: id, score }));
  }
  return list
    .map((item) => ({ id: item?.entity_id ?? item?.id, score: asNum(item?.score ?? item?.weight ?? item?.affinity) }))
    .filter((x) => typeof x.id === 'string' && x.score !== undefined)
    .sort((a, b) => b.score - a.score);
}

function addressOf(props) {
  const a = props?.address;
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') return a.formatted || [a.street, a.city].filter(Boolean).join(', ') || undefined;
  return undefined;
}

/** Flatten a raw Qloo entity into the fields TasteFit uses. */
export function normalizeEntity(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = raw.entity_id ?? raw.id;
  if (typeof id !== 'string' || typeof raw.name !== 'string') return undefined;
  const props = raw.properties && typeof raw.properties === 'object' ? raw.properties : {};
  const query = raw.query && typeof raw.query === 'object' ? raw.query : {};
  const types = Array.isArray(raw.types) ? raw.types : [];
  const type =
    (typeof raw.subtype === 'string' && raw.subtype.startsWith('urn:entity:') && raw.subtype) ||
    types.find((t) => typeof t === 'string' && t.startsWith('urn:entity:')) ||
    (typeof raw.type === 'string' && raw.type.startsWith('urn:entity:') ? raw.type : undefined) ||
    raw.subtype ||
    raw.type;
  const loc = raw.location || props.location || {};
  const image = props.image?.url || (typeof props.image === 'string' ? props.image : undefined);
  const year = asNum(props.release_year) ?? asNum(String(props.release_date || '').slice(0, 4));
  return {
    id,
    name: raw.name,
    type,
    kind: kindFromType(type),
    popularity: asNum(raw.popularity),
    affinity: asNum(raw.affinity ?? query.affinity),
    explain: parseExplainability(query.explainability),
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((t) => ({ id: t?.id ?? t?.tag_id, name: t?.name, type: t?.type ?? t?.subtype }))
      .filter((t) => typeof t.id === 'string' && typeof t.name === 'string')
      .slice(0, 12),
    // Every tag id, for exact matching (a place's cuisine tag can sit 80+ deep in Qloo's list).
    tagIds: (Array.isArray(raw.tags) ? raw.tags : []).map((t) => t?.id ?? t?.tag_id).filter((id) => typeof id === 'string'),
    description: props.short_description || props.description || raw.disambiguation || undefined,
    year,
    address: addressOf(props),
    priceLevel: asNum(props.price_level),
    rating: asNum(props.business_rating),
    image: typeof image === 'string' && /^https:\/\//.test(image) ? image : undefined,
    lat: asNum(loc.lat ?? loc.latitude),
    lon: asNum(loc.lon ?? loc.lng ?? loc.longitude),
  };
}

/** Flatten a raw Qloo tag. */
export function normalizeTag(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = raw.id ?? raw.tag_id;
  if (typeof id !== 'string' || typeof raw.name !== 'string') return undefined;
  return {
    id,
    name: raw.name.trim(),
    type: raw.type ?? raw.subtype,
    affinity: asNum(raw.affinity ?? raw.query?.affinity),
    parents: (Array.isArray(raw.parents) ? raw.parents : []).map((p) => p?.type).filter(Boolean),
  };
}
