// TasteFit client. Vanilla JS, no build step.
// Talks to /api/plan and /api/replan (NDJSON streams of agent steps + result).

const KINDS = [
  ['auto', 'Any'],
  ['music', 'Music'],
  ['film', 'Film'],
  ['tv', 'TV'],
  ['book', 'Book'],
  ['food', 'Food'],
  ['place', 'Place'],
];
const KIND_LABEL = Object.fromEntries(KINDS);
const COLORS = ['coral', 'teal', 'cobalt', 'marigold', 'orchid'];
const LEVEL_LABEL = { great: 'Great fit', good: 'Good fit', stretch: 'Stretch', unknown: 'No signal' };
const OCCASIONS = {
  night_out: { label: 'Night out', times: { dinner: '7:00 pm', activity: '9:30 pm', film: 'Tomorrow', music: 'On the way' }, labels: { dinner: 'Dinner', activity: 'After dinner', film: 'Film', music: 'Playlist' } },
  day_out: { label: 'Weekend day', times: { dinner: '12:30 pm', activity: '2:30 pm', film: 'Tonight', music: 'All day' }, labels: { dinner: 'Lunch', activity: 'Afternoon', film: 'Film', music: 'Playlist' } },
};
const SWAP_HINTS = {
  dinner: 'Change this: cheaper, closer, no sushi',
  activity: 'Change this: closer, quieter, livelier',
  film: 'Change this: lighter, scarier, animated',
  music: 'Change this: more chill, livelier',
};
const SAMPLE = {
  city: 'Chicago',
  occasion: 'night_out',
  budget: 2,
  people: [
    { name: 'Ana', favorites: [{ text: 'Phoebe Bridgers', kind: 'music' }, { text: 'Lady Bird', kind: 'film' }, { text: 'Ramen', kind: 'food' }, { text: 'Normal People', kind: 'book' }] },
    { name: 'Ben', favorites: [{ text: 'Korean food', kind: 'food' }, { text: 'Parasite', kind: 'film' }, { text: 'NewJeans', kind: 'music' }] },
    { name: 'Cleo', favorites: [{ text: 'Daft Punk', kind: 'music' }, { text: 'Blade Runner 2049', kind: 'film' }, { text: 'Tacos', kind: 'food' }] },
  ],
};
const STORE_KEY = 'tastefit-group-v1';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  people: [],
  city: '',
  occasion: 'night_out',
  budget: 2,
  mode: null,
  phase: 'idle', // idle | planning | done | error
  trace: [],
  plan: null,
  session: null,
  error: '',
  chat: [],
  replanning: false,
  justSwapped: null,
  animateMeters: false,
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt2 = (n) => (typeof n === 'number' ? n.toFixed(2) : '–');
const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.max(1, Math.round(ms))} ms`);
const X_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const joinNames = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ---------------------------------------------------------------------------
// Persistence (per-viewer convenience only)
// ---------------------------------------------------------------------------
function loadGroup() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && Array.isArray(saved.people) && saved.people.length >= 2) return saved;
  } catch {
    /* ignore */
  }
  return structuredClone(SAMPLE);
}
function saveGroup() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ people: state.people.map(({ name, favorites }) => ({ name, favorites })), city: state.city, occasion: state.occasion, budget: state.budget }));
  } catch {
    /* ignore */
  }
}
function applyGroup(g) {
  state.people = g.people.slice(0, 5).map((p) => ({ name: String(p.name || ''), favorites: (p.favorites || []).slice(0, 8).map((f) => ({ text: String(f.text || ''), kind: KIND_LABEL[f.kind] ? f.kind : 'auto' })), nextKind: 'auto' }));
  state.city = g.city || '';
  state.occasion = OCCASIONS[g.occasion] ? g.occasion : 'night_out';
  state.budget = [1, 2, 3].includes(Number(g.budget)) ? Number(g.budget) : 2;
  $('#city').value = state.city;
  document.querySelector(`input[name="occasion"][value="${state.occasion}"]`).checked = true;
  document.querySelector(`input[name="budget"][value="${state.budget}"]`).checked = true;
  renderPeople();
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
function matchFor(personIndex, fav) {
  const local = state.people[personIndex];
  const name = local?.name.trim() || `Friend ${personIndex + 1}`;
  const p = state.plan?.people?.find((x) => x.name === name);
  if (!p) return null;
  return p.favorites.find((f) => f.input.toLowerCase() === fav.text.toLowerCase()) || null;
}

function chipHtml(personIndex, fav, j) {
  const m = matchFor(personIndex, fav);
  const cls = m ? (m.status === 'matched' ? 'is-matched' : 'is-missing') : '';
  const kind = m?.status === 'matched' ? m.kind : fav.kind;
  const title = m ? (m.status === 'matched' ? `Matched in Qloo as ${m.match}` : 'Qloo found no match') : '';
  return `<li class="chip ${cls}" ${title ? `title="${esc(title)}"` : ''}>
    ${kind && kind !== 'auto' ? `<span class="chip-kind">${esc(KIND_LABEL[kind] || kind)}</span>` : ''}
    <span class="chip-text">${esc(fav.text)}</span>
    ${m?.status === 'missing' ? '<span class="visually-hidden">(no match in Qloo)</span>' : ''}
    <button type="button" data-role="remove-fav" data-fav="${j}" aria-label="Remove ${esc(fav.text)}">${X_ICON}</button>
  </li>`;
}

const PLACEHOLDERS = ['e.g. Phoebe Bridgers, Lady Bird, ramen', 'e.g. Korean food, Parasite', 'e.g. Daft Punk, tacos', 'e.g. The Bear, jazz', 'e.g. Dune, Bad Bunny'];

function renderPeople() {
  const ol = $('#people');
  ol.innerHTML = state.people
    .map(
      (p, i) => `
    <li class="person" data-color="${COLORS[i]}" data-index="${i}">
      <div class="person-head">
        <input class="person-name" data-role="name" value="${esc(p.name)}" maxlength="24" placeholder="Friend ${i + 1}" aria-label="Friend ${i + 1} name" autocomplete="off">
        ${state.people.length > 2 ? `<button type="button" class="icon-btn remove-person" data-role="remove-person" aria-label="Remove ${esc(p.name || `friend ${i + 1}`)}">${X_ICON}</button>` : ''}
      </div>
      ${p.favorites.length ? `<ul class="chips" aria-label="${esc(p.name || `Friend ${i + 1}`)}’s favourites">${p.favorites.map((f, j) => chipHtml(i, f, j)).join('')}</ul>` : ''}
      ${
        p.favorites.length < 8
          ? `<div class="chip-input">
        <select data-role="kind" aria-label="Kind of favourite">${KINDS.map(([v, l]) => `<option value="${v}" ${p.nextKind === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input data-role="fav-input" placeholder="${esc(PLACEHOLDERS[i] || PLACEHOLDERS[0])}" maxlength="60" aria-label="Add a favourite for ${esc(p.name || `friend ${i + 1}`)}" enterkeyhint="done" autocomplete="off">
        <button type="button" class="add-chip" data-role="add-fav">Add</button>
      </div>`
          : ''
      }
    </li>`,
    )
    .join('');
  const add = $('#add-person');
  add.disabled = state.people.length >= 5;
  add.textContent = state.people.length >= 5 ? 'Five friends is the maximum' : 'Add a friend';
  renderHeadlineNames();
}

function renderHeadlineNames() {
  const names = state.people.map((p, i) => ({ name: p.name.trim(), color: COLORS[i] })).filter((x) => x.name);
  const el = $('#headline-names');
  if (names.length < 2) {
    el.textContent = 'everyone';
    return;
  }
  const parts = names.map((n) => `<span class="who" data-color="${n.color}">${esc(n.name)}</span>`);
  el.innerHTML = parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function addFavorite(i, text, kind) {
  const p = state.people[i];
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean || p.favorites.length >= 8) return;
  if (!p.favorites.some((f) => f.text.toLowerCase() === clean.toLowerCase())) p.favorites.push({ text: clean, kind });
  saveGroup();
  renderPeople();
  $(`.person[data-index="${i}"] [data-role="fav-input"]`)?.focus();
}

function bindComposer() {
  const people = $('#people');
  people.addEventListener('input', (e) => {
    const li = e.target.closest('.person');
    if (!li) return;
    const i = Number(li.dataset.index);
    if (e.target.dataset.role === 'name') {
      state.people[i].name = e.target.value;
      renderHeadlineNames();
      saveGroup();
    }
  });
  people.addEventListener('change', (e) => {
    const li = e.target.closest('.person');
    if (li && e.target.dataset.role === 'kind') state.people[Number(li.dataset.index)].nextKind = e.target.value;
  });
  people.addEventListener('keydown', (e) => {
    if (e.target.dataset.role !== 'fav-input') return;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const li = e.target.closest('.person');
      const i = Number(li.dataset.index);
      addFavorite(i, e.target.value, state.people[i].nextKind || 'auto');
    } else if (e.key === 'Backspace' && !e.target.value) {
      const i = Number(e.target.closest('.person').dataset.index);
      if (state.people[i].favorites.length) {
        state.people[i].favorites.pop();
        saveGroup();
        renderPeople();
        $(`.person[data-index="${i}"] [data-role="fav-input"]`)?.focus();
      }
    }
  });
  people.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('.person');
    const i = Number(li.dataset.index);
    if (btn.dataset.role === 'add-fav') {
      const input = $('[data-role="fav-input"]', li);
      addFavorite(i, input.value, state.people[i].nextKind || 'auto');
    } else if (btn.dataset.role === 'remove-fav') {
      state.people[i].favorites.splice(Number(btn.dataset.fav), 1);
      saveGroup();
      renderPeople();
      $(`.person[data-index="${i}"] [data-role="fav-input"]`)?.focus();
    } else if (btn.dataset.role === 'remove-person') {
      state.people.splice(i, 1);
      saveGroup();
      renderPeople();
      $('#add-person').focus();
    }
  });
  $('#add-person').addEventListener('click', () => {
    if (state.people.length >= 5) return;
    state.people.push({ name: '', favorites: [], nextKind: 'auto' });
    saveGroup();
    renderPeople();
    $(`.person[data-index="${state.people.length - 1}"] [data-role="name"]`)?.focus();
  });
  $('#city').addEventListener('input', (e) => {
    state.city = e.target.value;
    saveGroup();
  });
  document.querySelectorAll('input[name="occasion"]').forEach((r) =>
    r.addEventListener('change', () => {
      state.occasion = r.value;
      saveGroup();
      if (state.phase === 'idle') renderStage();
    }),
  );
  document.querySelectorAll('input[name="budget"]').forEach((r) =>
    r.addEventListener('change', () => {
      state.budget = Number(r.value);
      saveGroup();
    }),
  );
  $('#load-sample').addEventListener('click', () => {
    applyGroup(structuredClone(SAMPLE));
    saveGroup();
  });
  $('#plan-form').addEventListener('submit', (e) => {
    e.preventDefault();
    planNight();
  });
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
async function streamPost(url, body, onEvent) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  } catch {
    onEvent({ type: 'error', message: 'TasteFit could not be reached. Check your connection and try again.' });
    return;
  }
  const ctype = res.headers.get('content-type') || '';
  if (!res.ok || !ctype.includes('ndjson') || !res.body) {
    let message = `The request failed (HTTP ${res.status}). Try again.`;
    try {
      const j = await res.json();
      if (j.error) message = j.error;
    } catch {
      /* keep default */
    }
    onEvent({ type: 'error', message });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (line) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line));
    } catch {
      /* skip partial line */
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  flush(buf);
}

/** Queue UI updates so fast (demo-mode) traces stay readable. */
function makePacer(gapMs) {
  let chain = Promise.resolve();
  return {
    push(fn, gap = 0) {
      chain = chain.then(fn).then(() => (gap && !reducedMotion ? sleep(gap) : null));
      return chain;
    },
    done: () => chain,
    gap: gapMs,
  };
}

function upsert(list, event) {
  const i = list.findIndex((e) => e.id === event.id);
  if (i >= 0) list[i] = event;
  else list.push(event);
}

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const j = await res.json();
    state.mode = j.mode;
  } catch {
    state.mode = null;
  }
  renderModePills();
  renderStage();
}

function renderModePills() {
  const q = $('#qloo-pill');
  const a = $('#agent-pill');
  const m = state.plan?.mode || state.mode;
  if (!m) {
    q.innerHTML = '<span class="dot"></span><span>Status unknown</span>';
    return;
  }
  q.className = `pill ${m.qloo === 'live' ? 'is-live' : 'is-demo'}`;
  q.innerHTML = `<span class="dot"></span><span>${m.qloo === 'live' ? 'Live Qloo data' : 'Demo data'}</span>`;
  q.title = m.qloo === 'live' ? 'Recommendations come from the Qloo API' : 'No Qloo key is configured: places are fictional and scores come from a local stand-in model';
  a.className = `pill agent-pill ${m.agent === 'gemini' ? 'is-live' : ''}`;
  const used = m.agentUsed === 'scripted-fallback' ? 'Scripted planner (Gemini fallback)' : m.agent === 'gemini' ? `Agent: ${m.model}` : 'Agent: scripted planner';
  a.innerHTML = `<span class="dot"></span><span>${esc(used)}</span>`;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------
async function planNight() {
  if (state.phase === 'planning') return;
  const err = $('#form-error');
  err.textContent = '';
  const people = state.people
    .map((p, i) => ({ name: p.name.trim() || `Friend ${i + 1}`, favorites: p.favorites.map((f) => ({ text: f.text, kind: f.kind })) }))
    .filter((p) => p.favorites.length);
  if (!state.city.trim()) {
    err.textContent = 'Add a city so the agent can find places nearby.';
    $('#city').focus();
    return;
  }
  if (people.length < 2) {
    err.textContent = 'Give at least two friends one favourite each.';
    return;
  }
  // Inputs typed but not yet added count too.
  state.phase = 'planning';
  state.trace = [];
  state.chat = [];
  state.error = '';
  const button = $('#plan-button');
  button.disabled = true;
  button.textContent = 'Planning…';
  renderStage();
  // Bring the live trace into view (the Plan button sits low on the page).
  const stageTop = $('#stage').getBoundingClientRect().top;
  if (stageTop < 0 || stageTop > window.innerHeight * 0.4) {
    window.scrollTo({ top: Math.max(0, window.scrollY + stageTop - 16), behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  const pacer = makePacer(140);
  let result = null;
  let failure = null;
  await streamPost('/api/plan', { city: state.city.trim(), occasion: state.occasion, budget: state.budget, people }, (ev) => {
    if (ev.type === 'meta') {
      state.mode = ev.mode;
      renderModePills();
    } else if (ev.type === 'trace') {
      const isNew = !state.trace.some((t) => t.id === ev.event.id);
      pacer.push(() => {
        upsert(state.trace, ev.event);
        renderTraceList();
      }, isNew ? pacer.gap : 0);
    } else if (ev.type === 'result') result = ev;
    else if (ev.type === 'error') failure = ev.message;
  });
  await pacer.done();
  if (result) {
    state.plan = result.plan;
    state.session = result.session;
    state.trace = result.trace || state.trace;
    state.baseStats = result.plan.stats;
    state.baseMode = result.plan.mode;
    state.changes = 0;
    state.phase = 'done';
    state.animateMeters = true;
    renderModePills();
    renderPeople();
  } else {
    state.phase = 'error';
    state.error = failure || 'The agent stopped without a plan. Try again.';
  }
  button.disabled = false;
  button.textContent = 'Plan our night';
  renderStage();
  state.animateMeters = false;
  $('#night-title')?.focus({ preventScroll: true });
}

async function replan(slot, instruction) {
  if (!state.session || state.replanning) return;
  const occ = OCCASIONS[state.plan.occasion];
  state.replanning = true;
  setBusy(true);
  const userText = instruction || `Something different for ${occ.labels[slot].toLowerCase()}`;
  const agentMsg = { from: 'agent', text: 'Working on it…', steps: [], pending: true };
  state.chat.push({ from: 'user', text: userText }, agentMsg);
  renderChat();
  let result = null;
  await streamPost('/api/replan', { session: state.session, slot, instruction }, (ev) => {
    if (ev.type === 'trace') {
      upsert(agentMsg.steps, ev.event);
      agentMsg.text = `${ev.event.title}…`;
      renderChat();
    } else if (ev.type === 'result') result = ev;
    else if (ev.type === 'error') {
      agentMsg.text = ev.message;
      agentMsg.error = true;
    }
  });
  agentMsg.pending = false;
  if (result) {
    state.plan = result.plan;
    state.session = result.session;
    agentMsg.text = result.message;
    state.justSwapped = result.changedSlot;
    if (result.changedSlot) state.changes = (state.changes || 0) + 1;
    renderResult();
    renderModePills();
  }
  state.replanning = false;
  setBusy(false);
  renderChat();
  if (state.justSwapped) {
    const el = document.querySelector(`.slot[data-slot="${state.justSwapped}"]`);
    if (el && !isInViewport(el)) el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    state.justSwapped = null;
  }
}

function isInViewport(el) {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.top < window.innerHeight - 120;
}

function setBusy(busy) {
  document.querySelectorAll('.swap button, .chat-form button, .suggestions button').forEach((b) => {
    b.disabled = busy;
  });
  document.querySelectorAll('.swap button').forEach((b) => {
    b.textContent = busy ? 'Working…' : 'Swap';
  });
}

// ---------------------------------------------------------------------------
// Stage rendering
// ---------------------------------------------------------------------------
function noticeHtml() {
  const m = state.plan?.mode || state.mode;
  if (m?.qloo !== 'mock') return '';
  return `<div class="notice" role="note"><div><strong>Demo data.</strong> This deployment has no Qloo API key, so venues are fictional and scores come from a small local stand-in model. Artists, films and books are real. With a key, every number below comes from Qloo.</div></div>`;
}

function emptyHtml() {
  return `<section class="panel empty">
    <h2>Your night shows up here</h2>
    <p>The sample group is ready, so you can plan straight away. Or swap in your own friends and favourites.</p>
    <ol class="how">
      <li><div><strong>Look up every favourite in Qloo</strong><span>Artists, films, books and places become Qloo entities; dishes become cuisine tags.</span></div></li>
      <li><div><strong>Ask Qloo what the group shares</strong><span>One Taste AI call per part of the night, with everyone’s favourites as signals.</span></div></li>
      <li><div><strong>Score every option for each person</strong><span>A separate Qloo call per friend ranks the same options against their taste alone.</span></div></li>
      <li><div><strong>Balance the night</strong><span>The agent picks the plan where nobody is left out, and explains each pick.</span></div></li>
    </ol>
  </section>`;
}

function ghostRunHtml() {
  const occ = OCCASIONS[state.occasion];
  const text = state.phase === 'planning' ? 'Waiting for the agent' : 'Waiting for your group';
  return `<ol class="run ghost-run" aria-hidden="true">${['dinner', 'activity', 'film', 'music']
    .map((s) => `<li class="slot"><div class="slot-time">${timeHtml(occ.times[s])}<span class="slot-label">${occ.labels[s]}</span></div><div class="slot-card">${text}</div></li>`)
    .join('')}</ol>`;
}

function traceItemHtml(t) {
  const status = { running: 'In progress', done: 'Done', error: 'Failed', skipped: 'Skipped' }[t.status] || '';
  return `<li class="tr is-${esc(t.status)}" data-kind="${esc(t.kind)}">
    <span class="tr-icon" aria-hidden="true"></span>
    <div><p class="tr-title"><span class="visually-hidden">${status}: </span>${esc(t.title)}${t.tool ? `<code>${esc(t.tool)}</code>` : ''}</p>${t.detail ? `<p class="tr-detail">${esc(t.detail)}</p>` : ''}</div>
    <span class="tr-ms">${t.status === 'running' ? '' : secs(t.ms)}</span>
  </li>`;
}

function renderTraceList() {
  const list = $('#trace-list');
  if (list) list.innerHTML = state.trace.map(traceItemHtml).join('');
}

function traceSummaryHtml() {
  // Stats and steps describe the original plan; re-plans are logged in the chat.
  const s = state.baseStats || state.plan.stats;
  const m = state.baseMode || state.plan.mode;
  const by = m.agentUsed === 'gemini' ? `agent (${m.model} chose the tool calls)` : m.agentUsed === 'scripted-fallback' ? 'scripted planner (Gemini was unavailable)' : 'scripted planner';
  const cached = s.qlooCached ? ` (${s.qlooCached} served from cache)` : '';
  const changes = state.changes ? ` ${state.changes} ${state.changes === 1 ? 'change' : 'changes'} since, logged below.` : '';
  return `<details class="panel trace-panel" id="trace-details">
    <summary class="trace-summary">
      <span class="sum-title">How the agent planned this</span>
      <span class="sum-stats">${s.qlooRequests} Qloo requests${cached}, ${s.favoritesResolved} of ${s.favoritesTotal} favourites matched, ${s.candidatesScored} options scored, ${secs(s.ms)}. Run by the ${esc(by)}.${changes}</span>
      <span class="sum-toggle"><span class="when-closed">Show steps</span><span class="when-open">Hide steps</span></span>
    </summary>
    <ol class="trace">${state.trace.map(traceItemHtml).join('')}</ol>
  </details>`;
}

function renderStage() {
  const stage = $('#stage');
  stage.setAttribute('aria-busy', String(state.phase === 'planning'));
  if (state.phase === 'idle') {
    stage.innerHTML = noticeHtml() + emptyHtml() + ghostRunHtml();
    return;
  }
  if (state.phase === 'planning') {
    stage.innerHTML = `${noticeHtml()}<section class="panel trace-panel"><h2>The agent is planning</h2><ol class="trace" id="trace-list">${state.trace.map(traceItemHtml).join('')}</ol></section>${ghostRunHtml()}`;
    return;
  }
  if (state.phase === 'error') {
    stage.innerHTML = `${noticeHtml()}<section class="panel empty" role="alert"><h2>No plan this time</h2><p>${esc(state.error)}</p></section>${state.trace.length ? `<section class="panel trace-panel"><h2>What the agent tried</h2><ol class="trace">${state.trace.map(traceItemHtml).join('')}</ol></section>` : ''}`;
    return;
  }
  stage.innerHTML = `${noticeHtml()}<div id="trace-wrap"></div><section class="night-head" id="night"></section><ol class="run" id="run"></ol>${chatShellHtml()}`;
  renderResult();
  renderChat();
}

function renderResult() {
  $('#trace-wrap').innerHTML = traceSummaryHtml();
  $('#night').innerHTML = nightHeadHtml();
  const run = $('#run');
  run.classList.toggle('fill-in', state.animateMeters);
  run.innerHTML = state.plan.slots.map((s, idx) => slotHtml(s, idx)).join('');
  if (state.justSwapped) document.querySelector(`.slot[data-slot="${state.justSwapped}"]`)?.classList.add('just-swapped');
}

function nightHeadHtml() {
  const p = state.plan;
  const names = joinNames(p.people.map((x) => x.name));
  const shared = (p.tasteProfile || []).slice(0, 8);
  return `
    <p class="night-kicker">${esc(p.occasionLabel)} in ${esc(p.city)} for ${esc(names)}</p>
    <h2 class="night-title" id="night-title" tabindex="-1">${esc(p.headline)}</h2>
    <div class="fair-row" aria-label="Great fits per person">${p.fairness
      .map((f) => {
        const n = f.great.length;
        const text = !f.hasSignal ? 'no favourites matched' : n ? `${n} great ${n === 1 ? 'fit' : 'fits'}` : 'no great fit yet';
        return `<span class="fair ${n ? '' : 'is-left-out'}" data-color="${f.color}" title="${esc(f.great.join(', ') || 'None')}"><span class="sw" aria-hidden="true"></span><b>${esc(f.person)}</b> ${text}</span>`;
      })
      .join('')}</div>
    ${
      shared.length
        ? `<div class="shared"><h3>What the group shares, according to Qloo</h3><ul class="shared-list">${shared
            .map((t) => `<li>${esc(t.name)}${typeof t.affinity === 'number' ? `<span class="aff" title="Qloo affinity">${fmt2(t.affinity)}</span>` : ''}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${p.rebalanced?.length ? `<p class="proof">Fairness pass: ${esc(p.rebalanced.map((r) => `swapped ${labelOf(r.slot)} to ${r.to} so ${r.person} gets a great fit`).join('; '))}.</p>` : ''}`;
}

const labelOf = (slot) => (OCCASIONS[state.plan?.occasion] || OCCASIONS.night_out).labels[slot].toLowerCase();

function metaFor(s) {
  const e = s.pick;
  const bits = [];
  if (s.slot === 'music') {
    bits.push(`${s.tracks?.length || 0} artists`);
    return bits;
  }
  if (e.tags?.length) bits.push(e.tags.slice(0, 2).join(', '));
  if (e.year) bits.push(String(e.year));
  if (e.priceLevel) bits.push('$'.repeat(Math.round(e.priceLevel)));
  if (e.rating) bits.push(`${e.rating.toFixed(1)} rating`);
  if (e.address) bits.push(e.address);
  if (s.distanceKm != null) bits.push(`${s.distanceKm} km from ${labelOf('dinner')}`);
  return bits;
}

function linkFor(s) {
  const live = state.plan.mode.qloo === 'live';
  if (s.slot === 'dinner' || s.slot === 'activity') {
    if (!live) return '';
    const q = encodeURIComponent(`${s.pick.name} ${s.pick.address || state.plan.city}`);
    return `<a href="https://www.google.com/maps/search/?api=1&amp;query=${q}" target="_blank" rel="noopener noreferrer">Open in Maps</a>`;
  }
  return '';
}

function metersHtml(s, idx) {
  return `<ul class="meters" aria-label="How well this fits each person">${s.fits
    .map((f, k) => {
      const level = f.level || 'unknown';
      const why = s.slot === 'music' && f.because ? `${f.because} is in the mix` : f.because;
      return `<li class="meter ${level === 'unknown' ? 'is-unknown' : ''}" data-color="${f.color}" style="--v:${f.norm ?? 0};--i:${idx * 3 + k}">
        <span class="meter-name">${esc(f.person)}</span>
        <span class="meter-bar" aria-hidden="true"><span class="meter-fill"></span></span>
        <span class="meter-text"><b>${LEVEL_LABEL[level]}</b>${typeof f.norm === 'number' && level !== 'unknown' ? ` <span title="${esc(f.person)}’s match vs. their best option here${f.raw != null ? ` (raw Qloo affinity ${fmt2(f.raw)})` : ''}">${Math.round(f.norm * 100)}%</span>` : ''}${why ? `<span class="why">${esc(why)}</span>` : ''}</span>
      </li>`;
    })
    .join('')}</ul>`;
}

function evidenceHtml(s) {
  const ev = s.evidence || {};
  const people = state.plan.people;
  const pickRow = `<tr class="is-pick"><td>${esc(s.slot === 'music' ? 'This playlist' : s.pick.name)} (picked)</td><td>${fmt2(s.pick.groupAffinity)}</td>${people
    .map((p) => `<td>${fmt2(s.fits.find((f) => f.person === p.name)?.norm)}</td>`)
    .join('')}<td>${fmt2(ev.pickScore)}</td></tr>`;
  const altRows = (ev.alternatives || [])
    .map((a) => `<tr><td>${esc(a.name)}</td><td>${fmt2(a.groupAffinity)}</td>${people.map((p) => `<td>${fmt2(a.fits?.[p.name])}</td>`).join('')}<td>${fmt2(a.score)}</td></tr>`)
    .join('');
  const req = ev.request
    ? `GET ${ev.request.path}?${Object.entries(ev.request.params)
        .map(([k, v]) => `${k}=${v}`)
        .join('&')}`
    : '';
  return `<details class="evidence">
    <summary>Qloo evidence for this pick</summary>
    <div class="ev-body">
      <dl class="ev-grid">
        ${s.slot !== 'music' ? `<div><dt>Group affinity</dt><dd>${fmt2(s.pick.groupAffinity)}</dd></div>` : ''}
        <div><dt>Options compared</dt><dd>${ev.candidates ?? '–'}</dd></div>
        <div><dt>Per-person Qloo calls</dt><dd>${ev.personCalls ?? 0}</dd></div>
        ${ev.pickScore != null ? `<div><dt>Fairness score</dt><dd>${fmt2(ev.pickScore)}</dd></div>` : ''}
      </dl>
      ${
        ev.signals?.length
          ? `<div><h4>Favourites Qloo tied to this pick</h4><ul class="ev-signals">${ev.signals
              .map((g) => `<li>${esc(g.name)} (${esc(g.people.join(', '))}) <span class="num">${fmt2(g.score)}</span></li>`)
              .join('')}</ul></div>`
          : ''
      }
      ${
        s.slot !== 'music' && (ev.alternatives || []).length
          ? `<div><h4>How it beat the runners-up</h4><div class="table-wrap"><table class="ev-table"><thead><tr><th>Option</th><th>Group</th>${people
              .map((p) => `<th><span class="sw" data-color="${p.color}"></span>${esc(p.name)}</th>`)
              .join('')}<th>Score</th></tr></thead><tbody>${pickRow}${altRows}</tbody></table></div></div>`
          : ''
      }
      ${req ? `<div><h4>Qloo request</h4><p class="req">${esc(req)}</p></div>` : ''}
      <p class="ev-note">Bars and percentages compare options within each person’s own Qloo call (100% = their best option for this slot). The table shows raw Qloo affinity scores.${ev.constraints?.length ? ` Applied: ${esc(ev.constraints.join(', '))}.` : ''}${ev.relaxed ? ' Qloo’s category filter returned nothing here, so it was relaxed.' : ''}${ev.budgetRelaxed ? ' Nothing matched the budget, so it was relaxed.' : ''}</p>
    </div>
  </details>`;
}

const timeHtml = (t) => `<span class="time ${/\d/.test(t) ? '' : 'is-word'}">${esc(t)}</span>`;

function slotHtml(s, idx) {
  const head = `<div class="slot-time">${timeHtml(s.time)}<span class="slot-label">${esc(s.label)}</span></div>`;
  if (s.empty) return `<li class="slot" data-slot="${s.slot}">${head}<div class="slot-card"><p class="slot-empty">${esc(s.message)}</p></div></li>`;
  const meta = metaFor(s);
  const link = linkFor(s);
  const tracks =
    s.slot === 'music'
      ? `<ul class="tracks">${(s.tracks || [])
          .map(
            (t) => `<li class="track"><a href="https://open.spotify.com/search/${encodeURIComponent(t.name)}" target="_blank" rel="noopener noreferrer">${esc(t.name)}</a><span class="for" title="${esc(t.fitsFor.length ? `Great fit for ${t.fitsFor.join(', ')}` : 'For the group')}">${t.fitsFor
              .map((n) => `<i data-color="${state.plan.people.find((p) => p.name === n)?.color || ''}"></i>`)
              .join('')}</span></li>`,
          )
          .join('')}</ul>`
      : '';
  const reasonBy = s.reasonBy === 'gemini' ? 'Reason written by Gemini from Qloo results' : 'Reason generated from Qloo scores';
  return `<li class="slot" data-slot="${s.slot}">${head}
    <article class="slot-card" aria-label="${esc(s.label)}: ${esc(s.pick.name)}">
      <div class="pick-head">
        <div>
          <h3 class="pick-name">${esc(s.pick.name)}</h3>
          ${meta.length || link ? `<p class="pick-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}${link}</p>` : ''}
        </div>
        ${s.pick.image ? `<img class="pick-img" src="${esc(s.pick.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      </div>
      ${s.pick.description && s.slot !== 'music' ? `<p class="pick-desc">${esc(s.pick.description)}</p>` : ''}
      ${tracks}
      <p class="reason">${esc(s.reason)}<span class="reason-by">${reasonBy}</span></p>
      ${metersHtml(s, idx)}
      ${evidenceHtml(s)}
      <form class="swap" data-slot="${s.slot}">
        <label class="visually-hidden" for="swap-${s.slot}">Change ${esc(s.label.toLowerCase())}</label>
        <input id="swap-${s.slot}" name="instruction" placeholder="${esc(SWAP_HINTS[s.slot])}" maxlength="200" autocomplete="off">
        <button type="submit" ${state.replanning ? 'disabled' : ''}>${state.replanning ? 'Working…' : 'Swap'}</button>
      </form>
    </article>
  </li>`;
}

function chatShellHtml() {
  const occ = OCCASIONS[state.plan.occasion];
  const suggestions = [`Cheaper ${occ.labels.dinner.toLowerCase()}`, `No sushi for ${occ.labels.dinner.toLowerCase()}`, 'Somewhere closer after dinner', 'A lighter film', 'A more chill playlist'];
  return `<section class="panel chat" aria-labelledby="chat-title">
    <h2 id="chat-title">Change something</h2>
    <p>Tell the agent what to swap. It changes only that part of the night and keeps everyone’s fit in view.</p>
    <div class="suggestions">${suggestions.map((t) => `<button type="button" data-say="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <ol class="chat-log" id="chat-log"></ol>
    <form class="chat-form" id="chat-form">
      <input id="chat-input" maxlength="200" placeholder="e.g. no sushi, and somewhere cheaper" aria-label="What should change?" autocomplete="off">
      <button type="submit">Send</button>
    </form>
  </section>`;
}

function renderChat() {
  const log = $('#chat-log');
  if (!log) return;
  log.innerHTML = state.chat
    .map((m) => {
      const steps = m.steps?.filter((s) => s.status === 'done').length;
      return `<li class="msg from-${m.from} ${m.error ? 'is-error' : ''}">${esc(m.text)}${m.from === 'agent' && !m.pending && steps ? `<div class="steps">${steps} agent ${steps === 1 ? 'step' : 'steps'}: ${esc(m.steps.map((s) => s.title).join('; '))}</div>` : ''}</li>`;
    })
    .join('');
}

function bindStage() {
  const stage = $('#stage');
  stage.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.classList.contains('swap')) {
      e.preventDefault();
      const input = form.querySelector('input');
      const text = input.value.trim();
      input.value = '';
      replan(form.dataset.slot, text);
    } else if (form.id === 'chat-form') {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      replan(undefined, text);
    }
  });
  stage.addEventListener('click', (e) => {
    const b = e.target.closest('[data-say]');
    if (b) replan(undefined, b.dataset.say);
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/></svg>';
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
function renderThemeButton() {
  const dark = currentTheme() === 'dark';
  const btn = $('#theme-toggle');
  btn.innerHTML = dark ? SUN : MOON;
  btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}
function bindTheme() {
  $('#theme-toggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('tastefit-theme', next);
    } catch {
      /* ignore */
    }
    renderThemeButton();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeButton);
  renderThemeButton();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
bindTheme();
bindComposer();
bindStage(); // delegated once; the stage's contents are re-rendered freely
applyGroup(loadGroup());
renderStage();
loadHealth();
