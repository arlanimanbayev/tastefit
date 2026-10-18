/**
 * Local group scoring for TasteFit. No network calls in this file.
 *
 * Qloo gives two kinds of numbers:
 *   - group affinity: one /v2/insights call with *everyone's* favourites as signals
 *   - per-person affinity: one call per person that ranks the same candidate set
 *     (filter.results.entities) against only that person's favourites
 * Qloo warns that scores from separate calls aren't directly comparable, so
 * every comparison here is made *within* a call: each person's affinities are
 * min-max normalised across the candidate set before anything is combined.
 */

export const SLOT_ORDER = ['dinner', 'activity', 'film', 'music'];
export const FIT = Object.freeze({ great: 0.7, good: 0.4 });

const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const normText = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Min-max normalise; a flat set (range < 0.01) maps to 0.5 = "no clear preference". */
export function minMax(values) {
  const nums = values.filter((v) => typeof v === 'number');
  if (!nums.length) return values.map(() => null);
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return values.map((v) => (typeof v !== 'number' ? null : hi - lo < 0.01 ? 0.5 : (v - lo) / (hi - lo)));
}

export function fitLevel(norm) {
  if (norm == null) return 'unknown';
  if (norm >= FIT.great) return 'great';
  if (norm >= FIT.good) return 'good';
  return 'stretch';
}

/**
 * Attach group and per-person fit numbers to candidates.
 * @param candidates normalised entities from the group call (with .affinity)
 * @param perPerson  { [name]: { byId: Map<id, {affinity, explain}> } | null }
 */
export function attachFits(candidates, people, perPerson) {
  const groupNorms = minMax(candidates.map((c) => c.affinity));
  candidates.forEach((c, i) => {
    c.groupAffinity = c.affinity;
    c.groupNorm = groupNorms[i] ?? 0.5;
    c.fits = {};
  });
  for (const p of people) {
    const data = perPerson[p.name];
    const raws = candidates.map((c) => data?.byId.get(c.id)?.affinity);
    const norms = minMax(raws);
    candidates.forEach((c, i) => {
      c.fits[p.name] = {
        raw: typeof raws[i] === 'number' ? raws[i] : null,
        norm: norms[i],
        level: fitLevel(norms[i]),
        explain: data?.byId.get(c.id)?.explain || [],
      };
    });
  }
  return candidates;
}

/** Base score without fairness: group affinity, mean fit, and the worst-off person. */
export function baseScore(c, people) {
  const norms = people.map((p) => c.fits?.[p.name]?.norm).map((n) => (n == null ? 0.5 : n));
  const mean = norms.reduce((a, b) => a + b, 0) / (norms.length || 1);
  const min = norms.length ? Math.min(...norms) : 0.5;
  // The group call over-represents whoever listed the most favourites, so
  // per-person fit (mean + worst-off person) carries most of the weight.
  return 0.2 * (c.groupNorm ?? 0.5) + 0.35 * mean + 0.3 * min;
}

/**
 * Fairness boost: people with fewer "great" picks so far weigh more.
 * ledger: { [name]: { great: number, slots: string[] } }
 */
export function fairScore(c, people, ledger = {}) {
  const weights = people.map((p) => 1 / (1 + (ledger[p.name]?.great || 0)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const boost = people.reduce((acc, p, i) => acc + weights[i] * (c.fits?.[p.name]?.norm ?? 0.5), 0) / total;
  return baseScore(c, people) + 0.15 * boost;
}

export const newLedger = (people) => Object.fromEntries(people.map((p) => [p.name, { great: 0, slots: [] }]));

export function recordPick(ledger, slot, fitsByName) {
  for (const [name, fit] of Object.entries(fitsByName || {})) {
    if (!ledger[name]) ledger[name] = { great: 0, slots: [] };
    if (fit?.level === 'great') {
      ledger[name].great += 1;
      ledger[name].slots.push(slot);
    }
  }
}

/** Rank candidates for one slot given who has been served so far. */
export function rankSlot(candidates, people, ledger, { anchor, preferTerms = [], distanceWeight = 0.02 } = {}) {
  return candidates
    .map((c) => {
      let score = fairScore(c, people, ledger);
      const notes = [];
      if (anchor && c.lat != null && anchor.lat != null) {
        const km = haversineKm(anchor, c);
        c.distanceKm = Math.round(km * 10) / 10;
        score -= Math.min(0.3, km * distanceWeight);
      }
      if (preferTerms.length && matchesTerms(c, preferTerms)) {
        score += 0.2; // an explicit request outweighs small fit differences
        notes.push('matches your request');
      }
      return { c, score: Math.round(score * 1000) / 1000, notes };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Greedy playlist: first give every person (least-served first) their best
 * artist, then fill by group score. Returns tracks and each person's best fit.
 */
export function selectPlaylist(artists, people, ledger, size = 6) {
  const order = [...people].sort((a, b) => (ledger[a.name]?.great || 0) - (ledger[b.name]?.great || 0));
  const picked = [];
  const remaining = () => artists.filter((a) => !picked.includes(a));
  for (const p of order) {
    if (picked.length >= size) break;
    const best = remaining()
      .filter((a) => a.fits[p.name]?.norm != null)
      .sort((a, b) => b.fits[p.name].norm + 0.3 * b.groupNorm - (a.fits[p.name].norm + 0.3 * a.groupNorm))[0];
    if (best) picked.push(best);
  }
  for (const { c } of rankSlot(remaining(), people, ledger)) {
    if (picked.length >= size) break;
    picked.push(c);
  }
  const fits = {};
  for (const p of people) {
    const best = picked
      .filter((a) => a.fits[p.name]?.norm != null)
      .sort((a, b) => b.fits[p.name].norm - a.fits[p.name].norm)[0];
    const norm = best ? best.fits[p.name].norm : null;
    fits[p.name] = { raw: best?.fits[p.name].raw ?? null, norm, level: fitLevel(norm), via: best?.name, viaId: best?.id };
  }
  return { tracks: picked, fits };
}

/**
 * After the greedy pass, try one swap per person who has no "great" pick:
 * take the alternative where they're a great fit that costs the group least.
 * Only accepts swaps that lose less than `maxLoss` of base score.
 */
export function rebalance(plan, people, { maxLoss = 0.12 } = {}) {
  const notes = [];
  // The playlist always contains something for everyone, so it doesn't count here.
  const countGreat = (name) => Object.entries(plan).filter(([slot, s]) => slot !== 'music' && s.pick && s.fits?.[name]?.level === 'great').length;
  for (const p of people) {
    if (countGreat(p.name) > 0) continue;
    if (!Object.values(plan).some((s) => s.fits?.[p.name]?.norm != null)) continue; // no signal for this person
    let best = null;
    for (const [slot, s] of Object.entries(plan)) {
      if (slot === 'music' || !s.pick || s.locked) continue;
      const current = baseScore(s.pick, people);
      for (const alt of s.candidates || []) {
        if (alt.id === s.pick.id || alt.fits?.[p.name]?.level !== 'great' || s.excluded?.has?.(alt.id)) continue;
        // Don't take the only great pick away from someone else.
        const losers = people.filter((q) => q.name !== p.name && s.fits[q.name]?.level === 'great' && alt.fits[q.name]?.level !== 'great' && countGreat(q.name) <= 1);
        if (losers.length) continue;
        const loss = current - baseScore(alt, people);
        if (loss < maxLoss && (!best || loss < best.loss)) best = { slot, alt, loss };
      }
    }
    if (best) {
      const s = plan[best.slot];
      notes.push({ person: p.name, slot: best.slot, from: s.pick.name, to: best.alt.name });
      s.pick = best.alt;
      s.fits = best.alt.fits;
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Constraints and re-plan instructions
// ---------------------------------------------------------------------------

const SYNONYMS = {
  sushi: ['sushi', 'omakase', 'sashimi'],
  meat: ['barbecue', 'bbq', 'burger', 'steak', 'fried chicken'],
  spicy: ['thai', 'indian', 'spicy'],
  seafood: ['seafood', 'oyster', 'sushi', 'fish'],
  bars: ['bar', 'cocktail'],
  alcohol: ['bar', 'cocktail', 'wine', 'tiki', 'speakeasy'],
  drinking: ['bar', 'cocktail', 'wine', 'tiki'],
  clubs: ['nightclub', 'club', 'dance'],
  horror: ['horror', 'thriller'],
};

export function candidateText(c) {
  return normText([c.name, c.description, ...(c.tags || []).map((t) => t.name)].join(' '));
}
export function matchesTerms(c, terms) {
  const text = ` ${candidateText(c)} `;
  return terms.some((t) => {
    const n = normText(t);
    const stem = n.replace(/s$/, '');
    return n && (text.includes(` ${n} `) || text.includes(` ${stem} `) || text.includes(` ${stem}`));
  });
}

/** Remove candidates that break hard constraints. */
export function applyConstraints(candidates, constraints = {}) {
  const exclude = new Set(constraints.excludeIds || []);
  const terms = (constraints.excludeTerms || []).flatMap((t) => SYNONYMS[normText(t)] || [t]);
  return candidates.filter((c) => {
    if (exclude.has(c.id)) return false;
    if (constraints.maxPriceLevel && typeof c.priceLevel === 'number' && c.priceLevel > constraints.maxPriceLevel) return false;
    if (terms.length && matchesTerms(c, terms)) return false;
    return true;
  });
}

const SLOT_WORDS = {
  dinner: /\b(dinner|lunch|food|eat|eating|restaurant|meal|cuisine|brunch|sushi|tacos?|pizza|ramen|burgers?|thai|indian|korean|italian|mexican|vegan|vegetarian|bbq|barbecue)\b/,
  activity: /\b(bar|bars|drinks?|club|activity|afterwards?|after dinner|venue|museum|gallery|karaoke|cocktails?|dancing|comedy|live music|place to go)\b/,
  film: /\b(film|films|movie|movies|watch|series|tv)\b/,
  music: /\b(music|playlist|songs?|soundtrack|artists?|tunes|vibe)\b/,
};
const PREFER = [
  [/\b(lighter|light|fun|funn(y|ier)|feel[- ]good|comedy|laugh)\b/, ['comedy', 'family', 'animation', 'musical']],
  [/\b(romantic|romance|date)\b/, ['romance', 'wine bar', 'cocktail']],
  [/\b(scar(y|ier)|thriller|tense|darker)\b/, ['thriller']],
  [/\b(chill|chiller|quiet|quieter|calm|calmer|low[- ]key|relaxed|mellow)\b/, ['listening bar', 'wine bar', 'bookstore', 'jazz club', 'botanical garden', 'ambient', 'bedroom pop', 'jazz', 'dream pop', 'neo-classical']],
  [/\b(lively|livelier|party|dance|dancing|loud|louder|energ(y|etic))\b/, ['nightclub', 'dance hall', 'karaoke', 'live music venue']],
  [/\b(live music|band|gig|concert)\b/, ['live music venue', 'jazz club']],
  [/\b(sci[- ]?fi|space)\b/, ['science fiction']],
  [/\b(animated|animation|cartoon)\b/, ['animation']],
];
const STOP = new Set(['more', 'the', 'a', 'an', 'any', 'that', 'this', 'one', 'it', 'please', 'thanks', 'too', 'so']);

/**
 * Parse a re-plan instruction like "cheaper", "closer", "no sushi",
 * "something lighter for the film". Returns { slot?, constraints, summary }.
 */
export function parseInstruction(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[’']/g, "'")} `;
  const constraints = { excludeTerms: [], preferTerms: [] };
  const summary = [];
  let slot;
  for (const s of SLOT_ORDER) if (!slot && SLOT_WORDS[s].test(t)) slot = s;
  if (/\b(cheap|cheaper|budget|less expensive|affordable|inexpensive|lower price|too expensive|pricey)\b/.test(t)) {
    constraints.cheaper = true;
    summary.push('cheaper');
  }
  if (/\b(closer|nearby|near|walking distance|walkable|shorter walk|close by)\b/.test(t)) {
    constraints.closer = true;
    summary.push('closer');
  }
  const negation = /\b(?:no|not|without|skip|avoid|hate|hates|don't want|dont want|no more|allergic to)\s+([a-z][a-z -]{1,30}?)(?=[,.!?;]| and | but | or | please|\s*$)/g;
  let m;
  while ((m = negation.exec(t))) {
    const words = m[1].split(' ').filter((w) => w && !STOP.has(w));
    const term = words.join(' ').trim();
    if (term && !/^(cheap|expensive|far|close)/.test(term)) {
      constraints.excludeTerms.push(term);
      summary.push(`no ${term}`);
    }
  }
  for (const [re, terms] of PREFER) {
    if (re.test(t)) {
      constraints.preferTerms.push(...terms);
      summary.push(re.source.match(/[a-z]{4,}/)?.[0] || 'preference');
    }
  }
  constraints.preferTerms = [...new Set(constraints.preferTerms)];
  return { slot, constraints, summary: summary.join(', ') || 'something different' };
}

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Plain-language reasons
// ---------------------------------------------------------------------------

const SLOT_KINDS = { dinner: ['food', 'place'], activity: ['place', 'music'], film: ['film', 'tv', 'book'], music: ['music'] };

/** What about this person explains their fit: a matching cuisine, Qloo's explainability, or their closest favourite. */
export function becauseFor(person, slot, candidate) {
  const matched = (person.favorites || []).filter((f) => f.entity || f.tag);
  if (!matched.length) return null;
  const candTagIds = new Set((candidate?.tags || []).map((t) => t.id));
  const food = matched.find((f) => f.tag && candTagIds.has(f.tag.id));
  if (food) return { text: foodPhrase(food.tag.name), via: food.tag.name, source: 'tag-match' };
  const explain = candidate?.fits?.[person.name]?.explain || [];
  for (const e of explain) {
    const fav = matched.find((f) => f.entity?.id === e.id);
    if (fav) return { text: phraseFor(fav), via: fav.entity.name, source: 'qloo-explainability' };
  }
  const kinds = SLOT_KINDS[slot] || [];
  const fav = matched.find((f) => kinds.includes(f.kind)) || matched.find((f) => f.entity) || matched[0];
  return { text: phraseFor(fav), via: fav.entity?.name || fav.tag?.name, source: 'closest-favourite' };
}

/** "Korean" → "love of Korean food"; "Ramen" → "love of ramen". */
export function foodPhrase(name) {
  return /(an|ese|ch|ai|ish|ic)$/i.test(name) ? `love of ${name} food` : `love of ${name.toLowerCase()}`;
}
const genreCase = (s) =>
  s
    .toLowerCase()
    .replace(/\bk-pop\b/g, 'K-pop')
    .replace(/\bj-pop\b/g, 'J-pop')
    .replace(/\br&b\b/g, 'R&B');

function phraseFor(fav) {
  if (fav.tag) return foodPhrase(fav.tag.name);
  const genre = (fav.entity.tags || []).find((t) => /genre/.test(t.type || '') && !/place/.test(t.type || ''));
  return genre ? `${genreCase(genre.name)} side (${fav.entity.name})` : fav.entity.name;
}

const joinNames = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Template reason used by the scripted planner and as a fallback for the LLM.
 * `servedElsewhere` lists people who have a great fit in another slot, so the
 * text only claims "a better match elsewhere" when that's true.
 */
export function buildReason(slot, pick, fits, people, { servedElsewhere = new Set() } = {}) {
  const rows = people.map((p) => ({ p, f: fits?.[p.name] })).filter((x) => x.f && x.f.norm != null);
  if (!rows.length) return 'Picked from Qloo’s group recommendations for your city.';
  const great = rows.filter((x) => x.f.level === 'great');
  const good = rows.filter((x) => x.f.level === 'good');
  const stretch = rows.filter((x) => x.f.level === 'stretch');
  const parts = [];
  if (slot === 'music') {
    const vias = great.filter((x) => x.f.via).map((x) => `${x.f.via} for ${x.p.name}`);
    parts.push(`Something for everyone: ${joinNames(vias.slice(0, 4)) || 'a blend of the group’s top artists'}.`);
    return parts.join(' ');
  }
  if (great.length) {
    const phrases = great.slice(0, 3).map((x) => {
      const b = becauseFor(x.p, slot, pick);
      return b ? `${x.p.name}'s ${b.text}` : x.p.name;
    });
    parts.push(`Matches ${joinNames(phrases)}.`);
  } else {
    parts.push(`The best middle ground for ${joinNames(rows.map((x) => x.p.name))}: nobody's top pick, nobody left out.`);
  }
  if (great.length && good.length) parts.push(`${joinNames(good.map((x) => x.p.name))} ${good.length > 1 ? 'are' : 'is'} a good fit too.`);
  if (great.length && stretch.length) {
    const names = stretch.map((x) => x.p.name);
    const covered = names.every((n) => servedElsewhere.has(n));
    parts.push(covered ? `A stretch for ${joinNames(names)}, who ${names.length > 1 ? 'get' : 'gets'} a better match elsewhere in the night.` : `A stretch for ${joinNames(names)}.`);
  }
  return parts.join(' ');
}
