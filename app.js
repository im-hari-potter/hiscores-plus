// Skills+ (formerly Hiscores+) — the page. Views: Lookup, Compare, Gains, Leaderboard,
// and the planner: Goals, Bank, Prices (planner-ui.js).

import {
  SKILLS, SKILL_BY_ID, SKILL_IDS, COMBAT_IDS, COMBAT_KEYS, MIN_RANKED_LEVEL, MAX_LEVEL,
  levelProgress, combatFromProfile, combatBreakdown, levelsToNextCombat, combatLevel, boundUnrankedLevels,
} from './skills.js';
import { HiscoresApi, LIVE_API, isElectron, toSafeName, toDisplayName, checkName } from './api.js';
import { Totals, topPercent, formatPercent } from './totals.js';
import { rankParamForPage, pageOfRank, pageCount } from './totals-core.js';
import { store, players, snapshots, exportBackup, importBackup } from './store.js';
import { Prices, LIVE_MARKET } from './prices.js';
import { createPlanner } from './planner-ui.js';

const VERSION = '2.4.0';
const MAX_COMPARE = 5;

// How to reach the API:
//  - inside LostKit: straight to Lost City (LostKit lets its tool pages do that)
//  - in a browser: straight to Lost City first (works if they ever allow other
//    websites), then the relay on this site's own address, ./api/hiscores,
//    which exists when the site is hosted on Netlify (see the _redirects file)
//  - ?api=local: only the local test server
const params = new URLSearchParams(location.search);
const RELAY = new URL('api/hiscores', location.href).href;
const ROUTES = params.get('api') === 'local' ? [RELAY] : isElectron() ? [LIVE_API] : [LIVE_API, RELAY];
const api = new HiscoresApi({ routes: ROUTES });
const totals = new Totals(api);
// Market prices: LostKit may read the market's item pages (with sales); a normal
// browser only gets its JSON API (open offers). ?api=local uses the test server.
const LOCAL = params.get('api') === 'local';
const prices = new Prices(LOCAL
  ? { origin: new URL('market', location.href).href, routes: ['page', 'api'], gapMs: 50 }
  : { origin: LIVE_MARKET, routes: isElectron() ? ['page', 'api'] : ['api'] });
if (LOCAL) window.__skills = { prices };                   // for the test scripts
const TABS = ['lookup', 'compare', 'gains', 'leaders', 'goals', 'bank', 'prices'];
const PLAN_TABS = ['goals', 'bank', 'prices'];

// ── State ────────────────────────────────────────────────────────────────
const prefs = store.get('prefs', {});
const DEFAULT_ORDER = [0, ...SKILL_IDS];

// The Lookup tiles can be dragged into any order; this keeps every id exactly once.
function normalizeOrder(order) {
  const valid = Array.isArray(order) ? order.filter((id, i) => DEFAULT_ORDER.includes(id) && order.indexOf(id) === i) : [];
  return [...valid, ...DEFAULT_ORDER.filter(id => !valid.includes(id))];
}

const state = {
  tab: TABS.includes(prefs.tab) ? prefs.tab : 'lookup',
  filter: prefs.filter === 'combat' ? 'combat' : 'all',
  lookup: { profile: null, previous: null, snapSaved: false },
  compare: {
    names: Array.isArray(prefs.compare) ? prefs.compare.slice(0, MAX_COMPARE) : [],
    profiles: {}, errors: {}, loading: new Set(),
    mode: ['level', 'xp', 'rank', 'top'].includes(prefs.compareMode) ? prefs.compareMode : 'level',
    // 'default' (game order), 'skill' (A-Z) or 'p:<name>' (that player's numbers); dir 1 = A-Z / best first
    sort: prefs.compareSort && typeof prefs.compareSort.key === 'string' ? { key: prefs.compareSort.key, dir: prefs.compareSort.dir === -1 ? -1 : 1 } : { key: 'default', dir: 1 },
  },
  gains: { player: prefs.gainsPlayer || null, since: prefs.gainsSince || 'prev', hideZero: !!prefs.gainsHideZero, loading: false },
  leaders: {
    type: SKILL_BY_ID.has(prefs.lbType) ? prefs.lbType : 0,
    page: Number.isInteger(prefs.lbPage) && prefs.lbPage > 0 ? prefs.lbPage : 1,
    rows: null, highlight: null, loading: false, loadedKey: null,
  },
  tileOrder: normalizeOrder(prefs.tileOrder),
  // Lookup tiles sorted by the shown player's numbers ({ key: 'level'|'xp'|'rank'|'top', dir }),
  // or null for the dragged/default layout. Dragging a tile turns a sort into a layout.
  tileSort: prefs.tileSort && ['level', 'xp', 'rank', 'top'].includes(prefs.tileSort.key) ? { key: prefs.tileSort.key, dir: prefs.tileSort.dir === -1 ? -1 : 1 } : null,
  calc: null,              // { levels, source } for the combat calculator
};

function savePrefs() {
  store.set('prefs', {
    tab: state.tab,
    filter: state.filter,
    compare: state.compare.names,
    compareMode: state.compare.mode,
    compareSort: state.compare.sort,
    gainsPlayer: state.gains.player,
    gainsSince: state.gains.since,
    gainsHideZero: state.gains.hideZero,
    lbType: state.leaders.type,
    lbPage: state.leaders.page,
    tileOrder: state.tileOrder,
    tileSort: state.tileSort,
    lastLookup: state.lookup.profile?.name || prefs.lastLookup || null,
  });
}

// ── Small helpers ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat();
const fmt = n => nf.format(n);
const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const when = t => dtf.format(new Date(t));
const iconSrc = skill => `${skill.icon}.webp`;
const iconImg = (skill, cls = '') => `<span class="ico ico-${skill.icon} ${cls}" role="img" aria-label="${esc(skill.name)}" title="${esc(skill.name)}"></span>`;
// Crossed swords for the combat level (its own icon, not the Attack sword).
const COMBAT = { name: 'Combat level', icon: 'combat' };
// Keep every icon decoded in memory, so views that re-render don't flicker.
const ICON_CACHE = [...SKILLS, COMBAT].map(s => Object.assign(new Image(), { src: iconSrc(s), decoding: 'sync' }));
const visibleIds = (withOverall = true) => (state.filter === 'combat' ? COMBAT_IDS : withOverall ? [0, ...SKILL_IDS] : SKILL_IDS);

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} days ${h % 24} h`;
}

function compactXp(xp) {
  if (xp >= 10_000_000) return (xp / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'm';
  if (xp >= 1_000_000) return (xp / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'm';
  if (xp >= 100_000) return Math.round(xp / 1000).toLocaleString() + 'k';
  return fmt(xp);
}

function showMsg(id, html, kind = '') {
  const el = $(id);
  if (!el) return;
  if (!html) { el.hidden = true; el.innerHTML = ''; return; }
  el.className = 'msg' + (kind ? ' ' + kind : '');
  el.innerHTML = html;
  el.hidden = false;
}

function errorText(e) {
  if (!e) return 'Something went wrong.';
  if (e.kind === 'blocked') { showBlockedBanner(); return 'This browser is not allowed to read the hiscores from here (see the note at the top).'; }
  return esc(e.message || String(e));
}

function showBlockedBanner() {
  const b = $('banner');
  if (!b.hidden) return;
  b.innerHTML = `<b>Your browser won't let this page read the Lost City hiscores.</b>
    Lost City's API tells browsers that only its own website may read it. LostKit's tool tabs are allowed
    through, so this page works there. For normal browsers the site needs the small relay described in the README
    (hosting on Netlify turns it on), or Lost City would have to allow other websites.`;
  b.hidden = false;
}

function levelsOf(profile) {
  const out = {};
  for (const s of SKILLS) if (s.id !== 0 && profile.stats[s.id]) out[s.key] = profile.stats[s.id].level;
  return out;
}

function combatText(c) {
  return c.min === c.max ? String(c.min) : `${c.min}–${c.max}`;
}

// "Top 14.3%" pieces for a skill at a rank; null when no total is known yet.
function topFor(id, rank) {
  const t = totals.for(id, rank);
  if (!t) return null;
  const p = topPercent(rank, t.total);
  if (p == null) return null;
  const skill = SKILL_BY_ID.get(id);
  const who = id === 0 ? 'ranked accounts' : `players with ${MIN_RANKED_LEVEL}+ ${skill.name}`;
  const title = `Rank ${fmt(rank)} of ${fmt(t.total)} ${who}` +
    `\nAhead of ${fmt(Math.max(0, t.total - rank))} of them` +
    `\nTotal counted ${ago(t.at)}${t.floor ? ' (grown since - using your rank)' : ''}`;
  return { p, text: formatPercent(p), total: t.total, title };
}

// ── Planner (Goals, Bank, Prices) ────────────────────────────────────────
const planner = createPlanner({
  api, totals, prices, esc, fmt, ago, iconImg, showMsg, errorText,
  fullMarket: LOCAL || isElectron(),
  defaultAccount: () => prefs.lastLookup || players.saved()[0] || null,
  lookupProfile: () => state.lookup.profile,
  // Fetching the planned account's XP is a lookup like any other: keep a snapshot for Gains.
  onProfile: profile => { snapshots.add(profile); players.pushRecent(profile.name); },
  onChange: () => { if (state.tab === 'lookup') renderTiles(); },
  goTab: tab => setTab(tab),
});

// ── Rendering: shared bits ───────────────────────────────────────────────
function render() {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  document.querySelectorAll('#filter-seg button').forEach(b => b.classList.toggle('on', b.dataset.filter === state.filter));
  $('filter-seg').hidden = PLAN_TABS.includes(state.tab);        // All/Combat only means something for the hiscores views
  for (const v of TABS) $('view-' + v).hidden = v !== state.tab;
  if (state.tab === 'lookup') renderLookup();
  if (state.tab === 'compare') renderCompare();
  if (state.tab === 'gains') renderGains();
  if (state.tab === 'leaders') renderLeaders();
  if (PLAN_TABS.includes(state.tab)) planner.render(state.tab);
  renderStatus();
  updateHash();
}

function setTab(tab) {
  state.tab = tab;
  savePrefs();
  render();
  if (tab === 'compare') loadCompareMissing();
  if (tab === 'leaders') loadLeaders();
  if (tab === 'gains') maybeAutoUpdateGains();
  if (PLAN_TABS.includes(tab)) planner.show(tab);
}

// Chips for saved and recent players. mode 'lookup' opens them, 'compare' toggles them.
function chipsHtml(mode) {
  const saved = players.saved();
  const savedSafe = new Set(saved.map(toSafeName));
  const recent = players.recent().filter(n => !savedSafe.has(toSafeName(n))).slice(0, 8);
  const added = new Set(state.compare.names.map(toSafeName));
  const chip = (n, cls) => {
    const on = mode === 'compare' && added.has(toSafeName(n));
    const title = mode === 'compare' ? (on ? 'Remove from compare' : 'Add to compare') : 'Look up';
    return `<button type="button" class="chip ${cls}${on ? ' added' : ''}" data-chip="${esc(n)}" title="${title}">${esc(n)}</button>`;
  };
  let html = '';
  if (saved.length) html += `<span class="label">Saved</span>` + saved.map(n => chip(n, 'saved')).join('');
  if (recent.length) html += `<span class="label">Recent</span>` + recent.map(n => chip(n, '')).join('');
  return html;
}

// ── Lookup ───────────────────────────────────────────────────────────────
async function doLookup(rawName, { force = false } = {}) {
  const problem = checkName(rawName);
  if (problem) { showMsg('lookup-msg', esc(problem), 'error'); return; }
  const name = toDisplayName(rawName);
  $('lookup-name').value = name;
  if (state.tab !== 'lookup') { state.tab = 'lookup'; render(); }
  showMsg('lookup-msg', `Looking up <b>${esc(name)}</b>…`);
  try {
    const profile = await api.player(name, { force });
    if (!profile) {
      showMsg('lookup-msg', `No hiscores entry for <b>${esc(name)}</b>. Check the spelling. New players appear after they log out once.`, 'error');
      return;
    }
    showMsg('lookup-msg', '');
    const snap = snapshots.add(profile);
    state.lookup = { profile, previous: snap.previous, snapSaved: snap.saved };
    state.calc = { levels: calcLevelsFrom(profile), source: profile.name };
    players.pushRecent(profile.name);
    savePrefs();
    $('lookup-result').dataset.for = '';     // rebuild the calculator with the fresh levels
    renderLookup();
    updateHash();
  } catch (e) {
    showMsg('lookup-msg', errorText(e), 'error');
  }
}

function renderLookup() {
  $('lookup-chips').innerHTML = chipsHtml('lookup');
  const box = $('lookup-result');
  const p = state.lookup.profile;
  if (!box.firstElementChild || box.dataset.for !== (p ? p.safe : '') || box.dataset.filter !== state.filter) {
    box.innerHTML = `<div id="lk-card"></div><div id="lk-combat"></div><div id="lk-tiles"></div>`;
    box.dataset.for = p ? p.safe : '';
    box.dataset.filter = state.filter;
    renderCombatCard();                     // has inputs, so only rebuilt when the player or filter changes
  }
  renderPlayerCard();
  renderTiles();
}

function renderPlayerCard() {
  const el = $('lk-card');
  const p = state.lookup.profile;
  if (!el) return;
  if (!p) {
    el.innerHTML = state.filter === 'combat' ? '' :
      `<div class="empty">Look up a player to see their stats, their Top % in every skill,<br>and what they've gained since last time.</div>`;
    return;
  }
  const overall = p.stats[0];
  const combat = combatFromProfile(levelsOf(p), overall?.level);
  const saved = players.isSaved(p.name);
  const top = overall ? topFor(0, overall.rank) : null;
  const gain = gainLine(p, state.lookup.previous);
  el.innerHTML = `
    <div class="card">
      <div class="pc-top">
        <span class="pc-name">${esc(p.name)}</span>
        <button type="button" class="star${saved ? ' on' : ''}" data-star="${esc(p.name)}" title="${saved ? 'Remove from saved players' : 'Save this player'}" aria-pressed="${saved}">★</button>
        <span class="pc-combat" title="${combat.min === combat.max ? 'Combat level' : 'Some combat skills are below 15 and not on the hiscores, so the exact level is unknown'}">${iconImg(COMBAT)} Combat <b>${combatText(combat)}</b></span>
      </div>
      ${overall ? `
      <div class="pc-sub">
        <span class="c-level">Total level ${fmt(overall.level)}</span>
        <span class="c-xp">${fmt(overall.xp)} XP</span>
        <span class="c-rank">Rank ${fmt(overall.rank)}</span>
        ${top ? `<span class="c-top" title="${esc(top.title)}">Top ${top.text}%</span>` : `<span class="c-top pending">Top …</span>`}
      </div>` : ''}
      <div class="pc-foot">
        <span>Fetched ${ago(p.fetchedAt)}</span>
        <span>${gain}</span>
        <button type="button" class="linkish" data-action="to-gains">Gains</button>
        <button type="button" class="linkish" data-action="to-goals" title="Plan goals for ${esc(p.name)}">Goals</button>
        <button type="button" class="linkish" data-action="add-compare">Add to compare</button>
        <button type="button" class="linkish" data-action="refresh-lookup">Refresh</button>
      </div>
    </div>`;
}

function gainLine(profile, previous) {
  if (!previous) return 'First snapshot saved. Gains show from the next lookup.';
  const now = profile.stats[0]?.xp ?? 0;
  const before = previous.stats[0]?.xp ?? 0;
  const diff = now - before;
  if (diff <= 0) return `No XP gained since ${when(previous.t)}.`;
  return `<span class="gain-up">+${fmt(diff)} XP</span> since ${when(previous.t)} (${ago(previous.t)})`;
}

function renderTiles() {
  const el = $('lk-tiles');
  const p = state.lookup.profile;
  if (!el) return;
  if (!p) { el.innerHTML = ''; return; }
  if (tileDrag?.active) { tileDrag.stale = true; return; }   // don't pull tiles out from under a drag
  const levels = levelsOf(p);
  const bounds = boundUnrankedLevels(levels, p.stats[0]?.level);
  const shown = visibleIds(true);
  const ids = fullTileOrder(p).filter(id => shown.includes(id));
  const custom = state.tileSort || state.tileOrder.some((id, i) => id !== DEFAULT_ORDER[i]);
  const ts = state.tileSort;
  const sortBtn = (k, label) => {
    const on = ts?.key === k;
    return `<button type="button" class="${on ? 'on' : ''}" data-tsort="${k}" title="Sort the tiles by ${label}${on ? ' (click again to flip)' : ''}">${label}${on ? (ts.dir === 1 ? ' ▼' : ' ▲') : ''}</button>`;
  };
  el.innerHTML = `<div class="tiles-bar">
      <span>Sort by</span>
      <div class="seg" role="group" aria-label="Sort tiles">${sortBtn('level', 'Level')}${sortBtn('xp', 'XP')}${sortBtn('rank', 'Rank')}${sortBtn('top', 'Top %')}</div>
      <span>or drag the tiles.</span>
      ${custom ? `<button type="button" class="linkish" data-action="tiles-reset">Reset layout</button>` : ''}
    </div>
    <div class="stats-grid" id="tiles-grid">${ids.map(id => tileHtml(SKILL_BY_ID.get(id), p.stats[id], bounds)).join('')}</div>`;
}

// Every tile id in the order they're shown: sorted by the player's numbers (Overall
// first), or the saved drag layout.
function fullTileOrder(p) {
  if (!state.tileSort || !p) return state.tileOrder;
  return [0, ...sortSkillsBy(SKILL_IDS, p.stats, state.tileSort.key, state.tileSort.dir)];
}

// ── Dragging tiles around ────────────────────────────────────────────────
// Mouse: press and move. Touch: hold for a moment, then move (a quick swipe still scrolls).
let tileDrag = null;

function wireTileDrag() {
  const root = $('lookup-result');
  root.addEventListener('pointerdown', e => {
    const tile = e.target.closest('#tiles-grid .tile');
    if (!tile || e.button !== 0 || tileDrag) return;
    tileDrag = { tile, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType !== 'mouse' };
    if (tileDrag.touch) tileDrag.timer = setTimeout(() => tileDrag && !tileDrag.active && startTileDrag(), 350);
  });
  window.addEventListener('pointermove', e => {
    const d = tileDrag;
    if (!d || e.pointerId !== d.id) return;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.active) {
      const moved = Math.hypot(d.x - d.x0, d.y - d.y0);
      if (d.touch) { if (moved > 10) endTileDrag(false); return; }  // moved before the hold: it's a scroll
      if (moved < 6) return;
      startTileDrag();
    }
    moveTileDrag();
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', e => { if (tileDrag?.active) e.preventDefault(); }, { passive: false });
  window.addEventListener('pointerup', e => { if (tileDrag && e.pointerId === tileDrag.id) endTileDrag(true); });
  window.addEventListener('pointercancel', e => { if (tileDrag && e.pointerId === tileDrag.id) endTileDrag(false); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && tileDrag?.active) endTileDrag(false); });
}

function startTileDrag() {
  const d = tileDrag;
  const rect = d.tile.getBoundingClientRect();
  d.active = true;
  d.dx = d.x0 - rect.left; d.dy = d.y0 - rect.top;
  d.before = [...d.tile.parentNode.children];
  d.ghost = d.tile.cloneNode(true);
  d.ghost.classList.add('tile-ghost');
  Object.assign(d.ghost.style, { width: rect.width + 'px', height: rect.height + 'px' });
  document.body.appendChild(d.ghost);
  d.tile.classList.add('tile-placeholder');
  document.body.classList.add('tiles-dragging');
  moveTileDrag();
}

function moveTileDrag() {
  const d = tileDrag;
  d.ghost.style.left = (d.x - d.dx) + 'px';
  d.ghost.style.top = (d.y - d.dy) + 'px';
  const over = document.elementFromPoint(d.x, d.y)?.closest('#tiles-grid .tile');
  if (!over || over === d.tile) return;
  const tiles = [...d.tile.parentNode.children];
  if (tiles.indexOf(d.tile) < tiles.indexOf(over)) over.after(d.tile); else over.before(d.tile);
}

function endTileDrag(keep) {
  const d = tileDrag;
  tileDrag = null;
  if (!d) return;
  clearTimeout(d.timer);
  if (!d.active) return;
  d.ghost.remove();
  d.tile.classList.remove('tile-placeholder');
  document.body.classList.remove('tiles-dragging');
  const grid = d.tile.parentNode;
  if (!keep) {                                   // put everything back where it was
    for (const t of d.before) grid.appendChild(t);
  } else {
    const moved = [...grid.children].map(t => Number(t.dataset.id));
    const slots = new Set(moved);
    let k = 0;
    state.tileOrder = fullTileOrder(state.lookup.profile).map(id => (slots.has(id) ? moved[k++] : id));
    state.tileSort = null;                       // it's your own layout now
    savePrefs();
  }
  if (d.stale || keep) renderTiles();
}

function tileHtml(skill, stat, bounds) {
  if (!stat) {
    const b = bounds[skill.key];
    const lvl = !b ? `&lt;${MIN_RANKED_LEVEL}` : b.min === b.max ? b.min : `${b.min}–${b.max}`;
    return `<div class="tile unranked" data-id="${skill.id}" title="${esc(skill.name)}: below level ${MIN_RANKED_LEVEL}, so not on the hiscores">
      ${iconImg(skill)}
      <div class="v">Level: ${lvl}</div>
      <div class="v">Not ranked</div>
      <div class="next">Ranks at ${MIN_RANKED_LEVEL}</div>
      ${planner.tileGoal(state.lookup.profile, skill)}
    </div>`;
  }
  const top = topFor(skill.id, stat.rank);
  const topHtml = top
    ? `<div class="v top-line" title="${esc(top.title)}">Top ${top.text}% <span class="of">of ${fmt(top.total)}</span></div>`
    : `<div class="v top-line pending">Top …</div>`;
  let tail = '';
  if (skill.id !== 0) {
    const pr = levelProgress(stat.level, stat.xp);
    tail = pr.maxed
      ? `<div class="next maxed">Maxed</div><div class="pbar maxed"><div style="width:100%"></div></div>`
      : `<div class="next">Next: ${fmt(pr.remaining)} XP</div>
         <div class="pbar" title="${fmt(pr.remaining)} XP to level ${pr.nextLevel} (${pr.pct.toFixed(1)}%)"><div style="width:${pr.pct.toFixed(1)}%"></div></div>`;
  }
  return `<div class="tile${skill.id === 0 ? ' overall' : ''}" data-id="${skill.id}" title="${esc(skill.name)}">
    ${iconImg(skill)}
    <div class="v c-level">Level: ${fmt(stat.level)}</div>
    <div class="v c-xp">XP: ${fmt(stat.xp)}</div>
    <div class="v c-rank">Rank: ${fmt(stat.rank)}</div>
    ${topHtml}
    ${tail}
    ${skill.id !== 0 ? planner.tileGoal(state.lookup.profile, skill) : ''}
  </div>`;
}

// ── Combat card + calculator ─────────────────────────────────────────────
function calcLevelsFrom(profile) {
  const levels = levelsOf(profile);
  const combat = combatFromProfile(levels, profile.stats[0]?.level);
  return { ...combat.low };
}

const FRESH = { attack: 1, strength: 1, defence: 1, hitpoints: 10, ranged: 1, prayer: 1, magic: 1 };

function renderCombatCard() {
  const el = $('lk-combat');
  if (!el) return;
  if (state.filter !== 'combat') { el.innerHTML = ''; return; }
  const p = state.lookup.profile;
  if (!state.calc || (p && state.calc.source !== p.name)) {
    state.calc = p ? { levels: calcLevelsFrom(p), source: p.name } : { levels: { ...FRESH }, source: null };
  }
  const L = state.calc.levels;
  const order = ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer', 'magic'];
  el.innerHTML = `
    <div class="card combat-card">
      <div id="cc-live"></div>
      <details class="calc" ${p ? '' : 'open'}>
        <summary>Combat calculator${p ? ` (starts from ${esc(p.name)}'s levels)` : ''}</summary>
        <div class="calc-grid">
          ${order.map(k => {
            const s = SKILLS.find(x => x.key === k);
            return `<label>${iconImg(s)}<span>${s.name}</span><input class="input small" type="number" min="${k === 'hitpoints' ? 10 : 1}" max="99" value="${L[k]}" data-calc="${k}" aria-label="${s.name} level"></label>`;
          }).join('')}
        </div>
        <div class="bar"><button type="button" class="btn small" data-action="calc-reset">${p ? `Reset to ${esc(p.name)}` : 'Reset'}</button></div>
      </details>
    </div>`;
  renderCombatLive();
}

function renderCombatLive() {
  const el = $('cc-live');
  if (!el || !state.calc) return;
  const L = state.calc.levels;
  const p = state.lookup.profile;
  const b = combatBreakdown(L);
  const next = levelsToNextCombat(L);
  const real = p ? combatFromProfile(levelsOf(p), p.stats[0]?.level) : null;
  const differs = p && real && (COMBAT_KEYS.some(k => L[k] !== real.low[k]));
  const f2 = n => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const needs = COMBAT_KEYS
    .filter(k => next[k] != null)
    .sort((a, c) => next[a] - next[c])
    .map(k => {
      const s = SKILLS.find(x => x.key === k);
      return `<span class="need" title="${s.name} ${L[k]} → ${L[k] + next[k]}">${iconImg(s)} ${s.name} +${next[k]}</span>`;
    }).join('');
  let head;
  if (!p) head = `Combat level <span class="big">${b.level}</span>`;
  else if (differs) head = `What-if combat level <span class="big">${b.level}</span> <span class="cc-style">${b.level - real.min >= 0 ? '+' : ''}${b.level - real.min} from ${esc(p.name)}'s ${combatText(real)}</span>`;
  else head = `Combat level <span class="big">${combatText(real)}</span>`;
  const unknown = p && !differs && real.min !== real.max
    ? `<div class="cc-line">Some combat skills are below 15, so they're not on the hiscores. Their lowest possible levels are used below, and you can change them in the calculator.</div>` : '';
  el.innerHTML = `
    <div class="cc-head">${iconImg(COMBAT)} ${head}</div>
    <div class="cc-bar" title="${Math.round(b.progress * 100)}% of the way to ${b.level + 1}"><div style="width:${(b.progress * 100).toFixed(1)}%"></div></div>
    ${unknown}
    <div class="cc-line">Base: ¼ × (Defence <b>${L.defence}</b> + Hitpoints <b>${L.hitpoints}</b> + half of Prayer <b>${L.prayer}</b> = <b>${Math.floor(L.prayer / 2)}</b>) = <b>${f2(b.base)}</b></div>
    <div class="cc-line">Plus the best of: Melee 0.325 × (Attack <b>${L.attack}</b> + Strength <b>${L.strength}</b>) = <b>${f2(b.melee)}</b> ·
      Ranged 0.325 × (<b>${L.ranged}</b> + half <b>${Math.floor(L.ranged / 2)}</b>) = <b>${f2(b.range)}</b> ·
      Magic 0.325 × (<b>${L.magic}</b> + half <b>${Math.floor(L.magic / 2)}</b>) = <b>${f2(b.magic)}</b></div>
    <div class="cc-line">= ${f2(b.exact)}, rounded down to <b>${b.level}</b>${b.level < 126 ? `. Any one of these gets ${b.level + 1}:` : '. Maxed.'}</div>
    ${b.level < 126 ? `<div class="cc-next">${needs || '<span class="c-faint">Nothing single-handedly; train a few skills.</span>'}</div>` : ''}`;
}

// ── Compare ──────────────────────────────────────────────────────────────
function addToCompare(rawName) {
  const problem = checkName(rawName);
  if (problem) { showMsg('compare-msg', esc(problem), 'error'); return false; }
  const name = toDisplayName(rawName);
  const safe = toSafeName(name);
  if (state.compare.names.some(n => toSafeName(n) === safe)) { showMsg('compare-msg', `${esc(name)} is already in the list.`); return false; }
  if (state.compare.names.length >= MAX_COMPARE) { showMsg('compare-msg', `Compare holds ${MAX_COMPARE} players. Remove one first.`, 'error'); return false; }
  state.compare.names.push(name);
  showMsg('compare-msg', '');
  savePrefs();
  loadCompareOne(name);
  return true;
}

function removeFromCompare(name) {
  const safe = toSafeName(name);
  state.compare.names = state.compare.names.filter(n => toSafeName(n) !== safe);
  if (state.compare.sort.key === 'p:' + safe) state.compare.sort = { key: 'default', dir: 1 };
  delete state.compare.profiles[safe];
  delete state.compare.errors[safe];
  savePrefs();
  renderCompare();
  updateHash();
}

async function loadCompareOne(name, { force = false } = {}) {
  const safe = toSafeName(name);
  state.compare.loading.add(safe);
  delete state.compare.errors[safe];
  renderCompare();
  try {
    const profile = await api.player(name, { force });
    if (!state.compare.names.some(n => toSafeName(n) === safe)) return; // removed while loading
    if (profile) {
      state.compare.profiles[safe] = profile;
      snapshots.add(profile);
      players.pushRecent(profile.name);
    } else {
      state.compare.errors[safe] = 'No hiscores entry';
    }
  } catch (e) {
    state.compare.errors[safe] = e.kind === 'blocked' ? 'Blocked (open in LostKit)' : e.message;
  } finally {
    state.compare.loading.delete(safe);
    if (state.tab === 'compare') renderCompare();
    updateHash();
  }
}

function loadCompareMissing({ force = false } = {}) {
  for (const name of state.compare.names) {
    const safe = toSafeName(name);
    if (force || (!state.compare.profiles[safe] && !state.compare.loading.has(safe))) loadCompareOne(name, { force });
  }
}

// Who leads a row: skills by XP (that's what rank is), Overall by level then XP.
function leadKey(id, stat) {
  if (!stat) return [-1, -1];
  return id === 0 ? [stat.level, stat.xp] : [stat.xp, 0];
}
const cmpKey = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

function renderCompare() {
  $('compare-chips').innerHTML = chipsHtml('compare');
  document.querySelectorAll('#compare-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.compare.mode));
  const box = $('compare-result');
  const names = state.compare.names;
  if (!names.length) {
    box.innerHTML = `<div class="empty">Add up to ${MAX_COMPARE} players to compare them skill by skill.<br>The leader in each row is highlighted, and Top % is shown for everyone.</div>`;
    return;
  }
  const cols = names.map(n => {
    const safe = toSafeName(n);
    return { name: n, safe, p: state.compare.profiles[safe], err: state.compare.errors[safe], loading: state.compare.loading.has(safe) };
  });
  const mode = state.compare.mode;

  const head = cols.map(c => {
    let sub;
    if (c.p) {
      const cb = combatFromProfile(levelsOf(c.p), c.p.stats[0]?.level);
      sub = `Combat ${combatText(cb)} · Total ${c.p.stats[0] ? fmt(c.p.stats[0].level) : '?'}`;
    } else if (c.loading) sub = '<span class="pending">Loading…</span>';
    else sub = `<span class="c-lose">${esc(c.err || 'Not loaded')}</span>`;
    const key = 'p:' + c.safe;
    const on = state.compare.sort.key === key;
    const name = esc(c.p ? c.p.name : c.name);
    return `<th class="p" aria-sort="${on ? (state.compare.sort.dir === 1 ? 'descending' : 'ascending') : 'none'}"><span class="pname"><button type="button" class="th-sort${on ? ' on' : ''}" data-csort="${esc(key)}" title="Sort the skills by ${name}'s numbers">${name}<span class="arrow">${on ? (state.compare.sort.dir === 1 ? '▼' : '▲') : ''}</span></button><button type="button" class="x" data-remove="${esc(c.name)}" title="Remove" aria-label="Remove ${name}">✕</button></span><span class="sub">${sub}</span></th>`;
  }).join('');
  const skillOn = state.compare.sort.key === 'skill';
  const skillHead = `<th class="l" aria-sort="${skillOn ? (state.compare.sort.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-sort${skillOn ? ' on' : ''}" data-csort="skill" title="Sort the skills by name">Skill<span class="arrow">${skillOn ? (state.compare.sort.dir === 1 ? '▲' : '▼') : ''}</span></button></th>`;

  const rows = [];
  // Combat level row
  const combats = cols.map(c => c.p ? combatFromProfile(levelsOf(c.p), c.p.stats[0]?.level) : null);
  const bestCombat = Math.max(...combats.map(c => (c ? c.min : -1)));
  rows.push(`<tr class="combat"><td class="sk"><span class="sk-cell"><span class="pos"></span>${iconImg(COMBAT)} Combat</span></td>${cols.map((c, i) => {
    const cb = combats[i];
    if (!cb) return `<td class="p none"><span class="val">–</span></td>`;
    const best = cols.filter(x => x.p).length > 1 && cb.min === bestCombat;
    return `<td class="p${best ? ' best' : ''}"><span class="val">${combatText(cb)}</span></td>`;
  }).join('')}</tr>`);

  const ids = visibleIds(true);
  const leads = cols.map(() => 0);
  const order = [...ids.filter(id => id === 0), ...sortCompareSkills(ids.filter(id => id !== 0), cols, mode)];
  // Position down the list, 1 to 19 (Combat and Overall aren't counted). When the table is
  // sorted by a player, the top 10 are picked out in gold.
  const byPlayer = state.compare.sort.key.startsWith('p:') && cols.some(c => 'p:' + c.safe === state.compare.sort.key && c.p);
  let position = 0;
  for (const id of order) {
    const skill = SKILL_BY_ID.get(id);
    const keys = cols.map(c => leadKey(id, c.p?.stats[id]));
    const loaded = cols.filter(c => c.p).length;
    let bestKey = null;
    cols.forEach((c, i) => { if (c.p && c.p.stats[id] && (!bestKey || cmpKey(keys[i], bestKey) > 0)) bestKey = keys[i]; });
    const leaders = cols.map((c, i) => !!(c.p && c.p.stats[id] && bestKey && cmpKey(keys[i], bestKey) === 0));
    if (id !== 0 && loaded > 1) leaders.forEach((l, i) => { if (l) leads[i]++; });
    const cells = cols.map((c, i) => {
      if (!c.p) return `<td class="p none"><span class="val">${c.loading ? '<span class="pending">…</span>' : '–'}</span></td>`;
      const st = c.p.stats[id];
      if (!st) return `<td class="p none" title="${esc(c.p.name)}: ${esc(skill.name)} below ${MIN_RANKED_LEVEL}, not ranked"><span class="val">–</span><span class="sub">not ranked</span></td>`;
      const top = topFor(id, st.rank);
      const topTxt = top ? `Top ${top.text}%` : 'Top …';
      let val, sub;
      if (mode === 'level') { val = fmt(st.level); sub = `${compactXp(st.xp)} xp · ${topTxt}`; }
      else if (mode === 'xp') { val = fmt(st.xp); sub = `lvl ${st.level} · ${topTxt}`; }
      else if (mode === 'rank') { val = '#' + fmt(st.rank); sub = topTxt; }
      else { val = top ? topTxt : '<span class="pending">Top …</span>'; sub = `#${fmt(st.rank)}${top ? ' of ' + fmt(top.total) : ''}`; }
      const bestIdx = leaders.findIndex(Boolean);
      const behind = !leaders[i] && bestIdx >= 0 ? `\n${fmt(cols[bestIdx].p.stats[id].xp - st.xp)} XP behind ${cols[bestIdx].p.name}` : '';
      const title = `${c.p.name} · ${skill.name}\nLevel ${fmt(st.level)} · ${fmt(st.xp)} XP · Rank ${fmt(st.rank)}${top ? `\nTop ${top.text}% (of ${fmt(top.total)})` : ''}${behind}`;
      return `<td class="p${leaders[i] && loaded > 1 ? ' best' : ''}" title="${esc(title)}"><span class="val">${val}</span><span class="sub">${sub}</span></td>`;
    }).join('');
    const pos = id === 0 ? '' : ++position;
    const posHtml = `<span class="pos${byPlayer && pos && pos <= 10 ? ' top10' : ''}">${pos}</span>`;
    rows.push(`<tr class="${id === 0 ? 'overall' : ''}"><td class="sk"><span class="sk-cell">${posHtml}${iconImg(skill)} ${esc(skill.name)}</span></td>${cells}</tr>`);
  }

  const foot = cols.filter(c => c.p).length > 1
    ? `<tfoot><tr><td class="sk">Skills led</td>${cols.map((c, i) => `<td class="p">${c.p ? `<span class="lead-count">${leads[i]}</span> / ${ids.filter(id => id !== 0).length}` : ''}</td>`).join('')}</tr></tfoot>`
    : '';
  box.innerHTML = `${compareSortNote(cols, mode)}<div class="table-wrap"><table class="grid cmp"><thead><tr>${skillHead}${head}</tr></thead><tbody>${rows.join('')}</tbody>${foot}</table></div>`;
}

// Skills (never Combat or Overall, which stay on top) in the order the table is sorted by.
function sortCompareSkills(ids, cols, mode) {
  const { key, dir } = state.compare.sort;
  if (key === 'skill') return [...ids].sort((a, b) => SKILL_BY_ID.get(a).name.localeCompare(SKILL_BY_ID.get(b).name) * dir);
  const col = key.startsWith('p:') ? cols.find(c => 'p:' + c.safe === key) : null;
  if (!col?.p) return ids;
  return sortSkillsBy(ids, col.p.stats, mode, dir);
}

// Skills ordered by one player's level / xp / rank / Top %: dir 1 = best first.
// Skills below 15 (no hiscores row) always go last, whichever way.
function sortSkillsBy(ids, stats, mode, dir) {
  const score = id => {                       // bigger is better; null = not ranked
    const st = stats[id];
    if (!st) return null;
    if (mode === 'level') return st.level * 1e10 + st.xp;
    if (mode === 'xp') return st.xp;
    if (mode === 'rank') return -st.rank;
    const t = topFor(id, st.rank);
    return t ? -t.p : null;
  };
  return [...ids].sort((a, b) => {
    const x = score(a), y = score(b);
    if (x === null || y === null) return (x === null) - (y === null) || ids.indexOf(a) - ids.indexOf(b);
    return (y - x) * dir || ids.indexOf(a) - ids.indexOf(b);
  });
}

function compareSortNote(cols, mode) {
  const { key, dir } = state.compare.sort;
  if (key === 'default') return '';
  let what;
  if (key === 'skill') what = `by skill name, ${dir === 1 ? 'A to Z' : 'Z to A'}`;
  else {
    const col = cols.find(c => 'p:' + c.safe === key);
    if (!col) return '';
    const label = { level: 'level', xp: 'XP', rank: 'rank', top: 'Top %' }[mode];
    const best = mode === 'level' || mode === 'xp' ? ['highest', 'lowest'] : ['best', 'worst'];
    what = `by ${esc(col.p ? col.p.name : col.name)}'s ${label}, ${dir === 1 ? best[0] : best[1]} first`;
  }
  return `<div class="sort-note">Skills sorted ${what}. Combat and Overall stay on top. <button type="button" class="linkish" data-csort-reset>Back to skill order</button></div>`;
}

// ── Gains ────────────────────────────────────────────────────────────────
function gainsPlayers() {
  const tracked = snapshots.tracked();
  const seen = new Set(tracked.map(t => t.safe));
  const extra = players.saved().filter(n => !seen.has(toSafeName(n))).map(n => ({ safe: toSafeName(n), name: n, count: 0, last: 0 }));
  return [...tracked, ...extra];
}

function baselineOptions(list) {
  // list: snapshots oldest first; the newest is "now"
  if (list.length < 2) return [];
  const latest = list[list.length - 1];
  const older = list.slice(0, -1);
  const opts = [{ value: 'prev', label: `Previous snapshot (${when(older[older.length - 1].t)})` }];
  for (const [value, label, ms] of [['d1', '24 hours ago', 864e5], ['d7', '7 days ago', 7 * 864e5], ['d30', '30 days ago', 30 * 864e5]]) {
    const hit = [...older].reverse().find(s => s.t <= latest.t - ms);
    if (hit) opts.push({ value, label: `${label} (${when(hit.t)})` });
  }
  opts.push({ value: 'first', label: `First snapshot (${when(older[0].t)})` });
  return opts;
}

function pickBaseline(list, since) {
  const latest = list[list.length - 1];
  const older = list.slice(0, -1);
  if (!older.length) return null;
  const back = ms => [...older].reverse().find(s => s.t <= latest.t - ms) || null;
  if (since === 'd1') return back(864e5) || older[older.length - 1];
  if (since === 'd7') return back(7 * 864e5) || older[0];
  if (since === 'd30') return back(30 * 864e5) || older[0];
  if (since === 'first') return older[0];
  if (since?.startsWith('t:')) return older.find(s => s.t === Number(since.slice(2))) || older[older.length - 1];
  return older[older.length - 1];
}

function renderGains() {
  const list = gainsPlayers();
  const sel = $('gains-player');
  if (!state.gains.player && list.length) state.gains.player = list[0].name;
  const current = state.gains.player ? toSafeName(state.gains.player) : null;
  sel.innerHTML = list.length
    ? list.map(t => `<option value="${esc(t.name)}"${t.safe === current ? ' selected' : ''}>${esc(t.name)}${t.count ? ` (${t.count})` : ''}</option>`).join('')
    : `<option value="">No players yet</option>`;
  $('gains-hide-zero').checked = state.gains.hideZero;
  $('gains-update').disabled = !state.gains.player || state.gains.loading;

  const box = $('gains-result');
  if (!state.gains.player) {
    $('gains-since').innerHTML = '';
    box.innerHTML = `<div class="empty">Every lookup saves a snapshot of that player's stats.<br>Look someone up now and again later, and their gains show up here.<br><span class="c-faint">Hiscores update when a player logs out.</span></div>`;
    return;
  }
  const snaps = snapshots.list(state.gains.player);
  const opts = baselineOptions(snaps);
  const since = $('gains-since');
  since.innerHTML = opts.map(o => `<option value="${o.value}"${o.value === state.gains.since ? ' selected' : ''}>${esc(o.label)}</option>`).join('') +
    (snaps.length > 2 ? `<optgroup label="All snapshots">${snaps.slice(0, -1).reverse().map(s => `<option value="t:${s.t}"${state.gains.since === 't:' + s.t ? ' selected' : ''}>${esc(when(s.t))}</option>`).join('')}</optgroup>` : '');
  since.disabled = opts.length === 0;

  if (!snaps.length) {
    box.innerHTML = `<div class="empty">No snapshots of ${esc(state.gains.player)} yet. Press <b>Update now</b> to take the first one.</div>`;
    return;
  }
  const latest = snaps[snaps.length - 1];
  const base = pickBaseline(snaps, state.gains.since);
  if (!base) {
    box.innerHTML = `<div class="empty">First snapshot of ${esc(state.gains.player)} taken ${esc(when(latest.t))}.<br>Gains appear once there's a newer one: press <b>Update now</b> later (after they've logged out).</div>` + historyFoot(snaps);
    return;
  }

  let totalXp = 0, totalLevels = 0;
  const rows = visibleIds(true).map(id => {
    const skill = SKILL_BY_ID.get(id);
    const now = latest.stats[id];
    const then = base.stats[id];
    if (!now && !then) return state.gains.hideZero ? '' : `<tr class="dim"><td class="sk"><span class="sk-cell">${iconImg(skill)} ${esc(skill.name)}</span></td><td>–</td><td>–</td><td>–</td><td>–</td><td>–</td><td>–</td></tr>`;
    const xpNow = now ? now.xp : 0;
    const dXp = now && then ? now.xp - then.xp : null;
    const dLvl = now && then ? now.level - then.level : null;
    const isNew = now && !then;          // reached 15 during this period: the old numbers aren't known
    const changed = isNew || (dXp ?? 0) !== 0;
    if (state.gains.hideZero && !changed && id !== 0) return '';
    const dRank = now && then ? then.rank - now.rank : null;
    const newCell = `<span class="gain-up" title="Reached ${MIN_RANKED_LEVEL} in this period. Below that a skill isn't on the hiscores, so its starting point isn't known.">new</span>`;
    const xpCell = isNew ? newCell : dXp == null ? '–' : dXp > 0 ? `<span class="gain-up">+${fmt(dXp)}</span>` : `<span class="gain-zero">0</span>`;
    const lvlCell = isNew ? newCell : dLvl == null ? '–' : dLvl > 0 ? `<span class="gain-up">+${dLvl}</span>` : `<span class="gain-zero">0</span>`;
    const rankCell = dRank == null || dRank === 0 ? `<span class="gain-zero">–</span>`
      : dRank > 0 ? `<span class="gain-up" title="Climbed ${fmt(dRank)} places">▲ ${fmt(dRank)}</span>` : `<span class="gain-down" title="Dropped ${fmt(-dRank)} places">▼ ${fmt(-dRank)}</span>`;
    return `<tr class="${changed ? '' : 'dim'}"><td class="sk"><span class="sk-cell">${iconImg(skill)} ${esc(skill.name)}</span></td>
      <td>${now ? fmt(now.level) : '–'}</td><td>${lvlCell}</td><td>${fmt(xpNow)}</td><td>${xpCell}</td>
      <td>${now ? fmt(now.rank) : '–'}</td><td>${rankCell}</td></tr>`;
  }).join('');

  const period = latest.t - base.t;
  const overallNow = latest.stats[0], overallThen = base.stats[0];
  const overallRank = overallNow && overallThen ? overallThen.rank - overallNow.rank : 0;
  // Overall includes skills below 15 too, so it's the true total gained.
  if (overallNow && overallThen) {
    totalXp = overallNow.xp - overallThen.xp;
    totalLevels = overallNow.level - overallThen.level;
  }
  box.innerHTML = `
    <div class="summary">
      <span><b>${esc(state.gains.player)}</b></span>
      <span>${esc(when(base.t))} → ${esc(when(latest.t))} (${duration(period)})</span>
      <span>XP gained <b class="${totalXp > 0 ? 'gain-up' : ''}">${totalXp > 0 ? '+' : ''}${fmt(totalXp)}</b></span>
      <span>Levels <b class="${totalLevels > 0 ? 'gain-up' : ''}">${totalLevels > 0 ? '+' : ''}${totalLevels}</b></span>
      ${overallRank ? `<span>Overall rank <b class="${overallRank > 0 ? 'gain-up' : 'gain-down'}">${overallRank > 0 ? '▲' : '▼'} ${fmt(Math.abs(overallRank))}</b></span>` : ''}
    </div>
    <div class="table-wrap fit"><table class="grid gains">
      <thead><tr><th class="l">Skill</th><th>Level</th><th>Levels</th><th>XP</th><th>XP gained</th><th>Rank</th><th>Rank change</th></tr></thead>
      <tbody>${rows || `<tr><td class="l" colspan="7">No changes in this period.</td></tr>`}</tbody>
    </table></div>
    ${historyFoot(snaps)}`;
}

function historyFoot(snaps) {
  return `<div class="pc-foot">${snaps.length} snapshot${snaps.length === 1 ? '' : 's'} stored for ${esc(state.gains.player)} in this browser ·
    <button type="button" class="linkish" data-action="gains-delete">Delete this history</button></div>`;
}

async function updateGains({ force = true } = {}) {
  const name = state.gains.player;
  if (!name || state.gains.loading) return;
  state.gains.loading = true;
  $('gains-update').disabled = true;
  showMsg('gains-msg', `Fetching ${esc(name)}…`);
  try {
    const profile = await api.player(name, { force });
    if (!profile) showMsg('gains-msg', `No hiscores entry for <b>${esc(name)}</b>.`, 'error');
    else {
      const res = snapshots.add(profile);
      showMsg('gains-msg', res.saved ? '' : `No change since the last snapshot (${esc(when(res.previous?.t || Date.now()))}).`);
      players.pushRecent(profile.name);
    }
  } catch (e) {
    showMsg('gains-msg', errorText(e), 'error');
  } finally {
    state.gains.loading = false;
    if (state.tab === 'gains') renderGains();
  }
}

function maybeAutoUpdateGains() {
  const name = state.gains.player;
  if (!name) return;
  const snaps = snapshots.list(name);
  const last = snaps[snaps.length - 1];
  if (!last || Date.now() - last.t > 10 * 60e3) updateGains({ force: false });
}

// ── Leaderboard ──────────────────────────────────────────────────────────
async function loadLeaders({ force = false } = {}) {
  const lb = state.leaders;
  const key = `${lb.type}:${lb.page}`;
  if (!force && lb.loadedKey === key && lb.rows) { renderLeaders(); return; }
  const token = (lb.token = (lb.token || 0) + 1);
  lb.loading = true;
  renderLeaders();
  try {
    const rows = await api.category(lb.type, rankParamForPage(lb.page), { force });
    if (token !== lb.token) return; // moved on meanwhile
    lb.rows = rows;
    lb.loadedKey = key;
    totals.observePage(lb.type, rows);
    showMsg('leaders-msg', rows.length ? '' : 'Nobody on this page — it is past the last ranked player.');
  } catch (e) {
    showMsg('leaders-msg', errorText(e), 'error');
  } finally {
    if (token === lb.token) {
      lb.loading = false;
      if (state.tab === 'leaders') renderLeaders();
      savePrefs();
      updateHash();
    }
  }
}

function goLeaders(type, page, highlight = null) {
  const lb = state.leaders;
  lb.type = type;
  lb.page = Math.max(1, page);
  lb.highlight = highlight;
  loadLeaders();
}

function renderLeaders() {
  const lb = state.leaders;
  const ids = visibleIds(true);
  if (!ids.includes(lb.type)) lb.type = ids[0];
  const picker = $('leaders-skills');
  if (picker.dataset.ids !== ids.join(',')) {
    picker.dataset.ids = ids.join(',');
    picker.innerHTML = ids.map(id => {
      const s = SKILL_BY_ID.get(id);
      return `<button type="button" class="skill-btn" data-lb-type="${id}" title="${esc(s.name)}" aria-label="${esc(s.name)}">${iconImg(s)}</button>`;
    }).join('');
  }
  picker.querySelectorAll('.skill-btn').forEach(b => {
    const on = Number(b.dataset.lbType) === lb.type;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const skill = SKILL_BY_ID.get(lb.type);
  const t = totals.get(lb.type);
  const pages = t ? pageCount(t.total) : null;
  $('leaders-head').innerHTML = `${iconImg(skill)}<span class="title">${esc(skill.name)}</span>
    <span class="meta">${t ? `${fmt(t.total)} ${lb.type === 0 ? 'ranked accounts' : `players with ${MIN_RANKED_LEVEL}+ ${esc(skill.name)}`} · counted ${ago(t.at)}` : 'Counting players…'}</span>`;
  $('lb-page').textContent = `Page ${fmt(lb.page)}${pages ? ` of ${fmt(pages)}` : ''}`;
  $('lb-prev').disabled = $('lb-first').disabled = lb.page <= 1 || lb.loading;
  $('lb-next').disabled = lb.loading || (pages != null && lb.page >= pages && lb.rows && lb.rows.length < 21);
  $('lb-last').disabled = lb.loading || pages == null;

  const box = $('leaders-result');
  if (!lb.rows && lb.loading) { box.innerHTML = `<div class="empty pending">Loading page ${fmt(lb.page)}…</div>`; return; }
  if (!lb.rows) { box.innerHTML = ''; return; }
  const hl = lb.highlight;
  const body = lb.rows.map(r => {
    const top = topFor(lb.type, r.rank);
    const on = hl && (hl === r.safe || hl === r.rank);
    return `<tr class="${on ? 'hl' : ''}">
      <td>${fmt(r.rank)}</td>
      <td class="l"><button type="button" class="namebtn" data-lookup="${esc(r.name)}" title="Look up ${esc(r.name)}">${esc(r.name)}</button></td>
      <td>${fmt(r.level)}</td>
      <td>${fmt(r.xp)}</td>
      <td class="c-top"${top ? ` title="${esc(top.title)}"` : ''}>${top ? `Top ${top.text}%` : '…'}</td>
      <td class="c"><button type="button" class="mini" data-add="${esc(r.name)}" title="Add to compare">+ Compare</button></td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="table-wrap fit${lb.loading ? ' pending' : ''}"><table class="grid lb">
    <thead><tr><th>Rank</th><th class="l">Player</th><th>${lb.type === 0 ? 'Total level' : 'Level'}</th><th>XP</th><th>Top %</th><th></th></tr></thead>
    <tbody>${body || `<tr><td class="l" colspan="6">No players here.</td></tr>`}</tbody></table></div>`;
}

async function findInLeaders(rawName) {
  const problem = checkName(rawName);
  if (problem) { showMsg('leaders-msg', esc(problem), 'error'); return; }
  const name = toDisplayName(rawName);
  const skill = SKILL_BY_ID.get(state.leaders.type);
  showMsg('leaders-msg', `Finding ${esc(name)}…`);
  try {
    const p = await api.player(name);
    if (!p) { showMsg('leaders-msg', `No hiscores entry for <b>${esc(name)}</b>.`, 'error'); return; }
    const st = p.stats[state.leaders.type];
    if (!st) { showMsg('leaders-msg', `${esc(p.name)} isn't ranked in ${esc(skill.name)} (below level ${MIN_RANKED_LEVEL}).`, 'error'); return; }
    showMsg('leaders-msg', '');
    goLeaders(state.leaders.type, pageOfRank(st.rank), p.safe);
  } catch (e) {
    showMsg('leaders-msg', errorText(e), 'error');
  }
}

// ── Status bar ───────────────────────────────────────────────────────────
function renderStatus() {
  const q = api.status();
  const job = totals.jobStatus();
  let left;
  if (q.fg > 0) left = `<span class="busy">Fetching… ${q.fg > 1 ? `${q.fg} requests queued` : ''}${q.waitMs > 300 ? ` (next in ${(q.waitMs / 1000).toFixed(1)} s)` : ''}</span>`;
  else if (job) left = `<span class="busy">Updating player counts ${job.done + 1}/${job.count}${job.current != null ? ` (${esc(SKILL_BY_ID.get(job.current).name)})` : ''}</span>`;
  else left = 'Ready · the API allows 1 request every 2 s';
  const ps = prices.status();
  if (ps.busy || ps.queued) left += ` · <span class="busy">Prices ${fmt(Math.min(ps.done + 1, ps.total))}/${fmt(ps.total)}</span>`;
  $('status-api').innerHTML = left;
  const oldest = totals.newest();
  $('status-totals').textContent = oldest ? `Player counts from ${ago(oldest)}` : 'Player counts: loading';
}

// ── Settings dialog ──────────────────────────────────────────────────────
function renderSettings() {
  const rows = [0, ...SKILL_IDS].map(id => {
    const s = SKILL_BY_ID.get(id);
    const t = totals.get(id);
    return `<tr><td class="sk"><span class="sk-cell">${iconImg(s)} ${esc(s.name)}</span></td>
      <td>${t ? fmt(t.total) : '–'}</td><td class="l">${t ? ago(t.at) : '–'}</td><td class="l c-faint">${t ? esc(t.source) : ''}</td></tr>`;
  }).join('');
  $('totals-table').innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th class="l">Category</th><th>Players</th><th class="l">Counted</th><th class="l">Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const job = totals.jobStatus();
  $('totals-stop').hidden = !job;
  $('totals-refresh').disabled = $('totals-refresh-all').disabled = !!job;
  const tracked = snapshots.tracked();
  const snapCount = tracked.reduce((a, t) => a + t.count, 0);
  const plan = planner.summary();
  $('data-summary').textContent = `${players.saved().length} saved players · ${tracked.length} tracked players · ${snapCount} snapshots · ${plan.goals} goals · ${plan.banks} bank${plan.banks === 1 ? '' : 's'}. Stored in this browser only; a backup lets you move it or keep it safe.`;
  $('about-version').textContent = `Version ${VERSION} · reading the API ${api.base === LIVE_API ? 'directly' : `through ${api.base}`}`;
}

// ── URL hash (so a view can be bookmarked or reopened) ──────────────────
function updateHash() {
  let h = '';
  if (state.tab === 'lookup' && state.lookup.profile) h = `lookup/${state.lookup.profile.safe}`;
  else if (state.tab === 'compare' && state.compare.names.length) h = `compare/${state.compare.names.map(toSafeName).join(',')}`;
  else if (state.tab === 'gains' && state.gains.player) h = `gains/${toSafeName(state.gains.player)}`;
  else if (state.tab === 'leaders') h = `leaders/${state.leaders.type}/${state.leaders.page}`;
  else h = state.tab;                                         // goals, bank, prices and empty views
  const want = '#' + h;
  if (location.hash !== want) history.replaceState(null, '', want);
}

function applyHash() {
  const [tab, a, b] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (tab === 'lookup' && a) { state.tab = 'lookup'; doLookup(a); return true; }
  if (tab === 'compare' && a) {
    state.tab = 'compare';
    state.compare.names = a.split(',').filter(n => !checkName(n)).slice(0, MAX_COMPARE).map(toDisplayName);
    return true;
  }
  if (tab === 'gains' && a) { state.tab = 'gains'; state.gains.player = toDisplayName(a); return true; }
  if (tab === 'leaders') {
    state.tab = 'leaders';
    if (SKILL_BY_ID.has(Number(a))) state.leaders.type = Number(a);
    if (Number(b) > 0) state.leaders.page = Math.floor(Number(b));
    return true;
  }
  if (TABS.includes(tab)) { state.tab = tab; return true; }
  return false;
}

// ── Events ───────────────────────────────────────────────────────────────
function wire() {
  wireTileDrag();
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (b) setTab(b.dataset.tab);
  });
  $('filter-seg').addEventListener('click', e => {
    const b = e.target.closest('button[data-filter]');
    if (!b || b.dataset.filter === state.filter) return;
    state.filter = b.dataset.filter;
    savePrefs();
    render();
  });

  $('lookup-form').addEventListener('submit', e => { e.preventDefault(); doLookup($('lookup-name').value); });
  $('compare-form').addEventListener('submit', e => {
    e.preventDefault();
    if (addToCompare($('compare-name').value)) $('compare-name').value = '';
  });
  $('lb-rank-form').addEventListener('submit', e => {
    e.preventDefault();
    const r = parseInt($('lb-rank').value.replace(/[^\d]/g, ''), 10);
    if (r > 0) goLeaders(state.leaders.type, pageOfRank(r), r);
  });
  $('lb-find-form').addEventListener('submit', e => { e.preventDefault(); findInLeaders($('lb-find').value); });
  $('lb-first').addEventListener('click', () => goLeaders(state.leaders.type, 1));
  $('lb-prev').addEventListener('click', () => goLeaders(state.leaders.type, state.leaders.page - 1));
  $('lb-next').addEventListener('click', () => goLeaders(state.leaders.type, state.leaders.page + 1));
  $('lb-last').addEventListener('click', () => {
    const t = totals.get(state.leaders.type);
    if (t) goLeaders(state.leaders.type, pageCount(t.total));
  });

  $('compare-mode').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.compare.mode = b.dataset.mode;
    savePrefs();
    renderCompare();
  });
  $('compare-refresh').addEventListener('click', () => loadCompareMissing({ force: true }));
  $('compare-clear').addEventListener('click', () => {
    state.compare.names = []; state.compare.profiles = {}; state.compare.errors = {};
    savePrefs(); renderCompare(); updateHash();
  });

  $('gains-player').addEventListener('change', e => {
    state.gains.player = e.target.value || null;
    state.gains.since = 'prev';
    showMsg('gains-msg', '');
    savePrefs(); renderGains(); updateHash();
    maybeAutoUpdateGains();
  });
  $('gains-since').addEventListener('change', e => { state.gains.since = e.target.value; savePrefs(); renderGains(); });
  $('gains-hide-zero').addEventListener('change', e => { state.gains.hideZero = e.target.checked; savePrefs(); renderGains(); });
  $('gains-update').addEventListener('click', () => updateGains({ force: true }));

  // Delegated clicks inside the views
  document.querySelector('main').addEventListener('click', e => {
    const t = e.target;
    const chip = t.closest('[data-chip]');
    if (chip) {
      const name = chip.dataset.chip;
      if (state.tab === 'compare') {
        if (state.compare.names.some(n => toSafeName(n) === toSafeName(name))) removeFromCompare(name);
        else addToCompare(name);
      } else doLookup(name);
      return;
    }
    const star = t.closest('[data-star]');
    if (star) { players.toggleSaved(star.dataset.star); renderLookup(); return; }
    const remove = t.closest('[data-remove]');
    if (remove) { removeFromCompare(remove.dataset.remove); return; }
    const look = t.closest('[data-lookup]');
    if (look) { doLookup(look.dataset.lookup); return; }
    const add = t.closest('[data-add]');
    if (add) {
      if (addToCompare(add.dataset.add)) { add.textContent = 'Added'; add.disabled = true; }
      else showMsg('leaders-msg', $('compare-msg').innerHTML, 'error');
      return;
    }
    const lbType = t.closest('[data-lb-type]');
    if (lbType) { goLeaders(Number(lbType.dataset.lbType), 1); return; }
    const tsort = t.closest('[data-tsort]');
    if (tsort) {
      const k = tsort.dataset.tsort;
      state.tileSort = state.tileSort?.key === k ? { key: k, dir: -state.tileSort.dir } : { key: k, dir: 1 };
      savePrefs(); renderTiles();
      return;
    }
    const csort = t.closest('[data-csort]');
    if (csort) {
      const k = csort.dataset.csort;
      const cur = state.compare.sort;
      state.compare.sort = cur.key === k ? { key: k, dir: -cur.dir } : { key: k, dir: 1 };
      savePrefs(); renderCompare();
      return;
    }
    if (t.closest('[data-csort-reset]')) { state.compare.sort = { key: 'default', dir: 1 }; savePrefs(); renderCompare(); return; }
    const act = t.closest('[data-action]');
    if (!act) return;
    const p = state.lookup.profile;
    switch (act.dataset.action) {
      case 'to-gains':
        if (p) { state.gains.player = p.name; state.gains.since = 'prev'; }
        setTab('gains');
        break;
      case 'to-goals':
        if (p && planner.account !== p.name) planner.setAccount(p.name);
        setTab('goals');
        break;
      case 'add-compare':
        if (p) {
          if (!state.compare.names.some(n => toSafeName(n) === p.safe)) addToCompare(p.name);
          setTab('compare');
        }
        break;
      case 'refresh-lookup':
        if (p) doLookup(p.name, { force: true });
        break;
      case 'tiles-reset':
        state.tileOrder = [...DEFAULT_ORDER];
        state.tileSort = null;
        savePrefs(); renderTiles();
        break;
      case 'calc-reset':
        state.calc = null;
        renderCombatCard();
        break;
      case 'gains-delete':
        if (act.dataset.armed) {
          snapshots.remove(state.gains.player);
          state.gains.player = null;
          savePrefs(); renderGains();
        } else {
          act.dataset.armed = '1';
          act.textContent = 'Click again to delete';
        }
        break;
    }
  });

  document.querySelector('main').addEventListener('input', e => {
    const input = e.target.closest('[data-calc]');
    if (!input || !state.calc) return;
    const key = input.dataset.calc;
    const min = key === 'hitpoints' ? 10 : 1;
    const v = parseInt(input.value, 10);
    if (Number.isFinite(v)) {
      state.calc.levels[key] = Math.min(MAX_LEVEL, Math.max(min, v));
      renderCombatLive();
    }
  });
  document.querySelector('main').addEventListener('change', e => {
    const input = e.target.closest('[data-calc]');
    if (input && state.calc) input.value = state.calc.levels[input.dataset.calc];
  });

  // Settings
  const dlg = $('settings');
  $('settings-btn').addEventListener('click', () => { renderSettings(); showMsg('settings-msg', ''); dlg.showModal(); });
  $('settings-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  $('totals-refresh').addEventListener('click', () => { totals.refresh(); renderSettings(); });
  $('totals-refresh-all').addEventListener('click', () => { totals.refresh({ force: true }); renderSettings(); });
  $('totals-stop').addEventListener('click', () => { totals.cancel(); });
  $('backup-copy').addEventListener('click', async () => {
    const text = exportBackup();
    try { await navigator.clipboard.writeText(text); showMsg('settings-msg', 'Backup copied. Paste it somewhere safe (a note, an email to yourself).', 'ok'); }
    catch (err) {
      $('restore-box').hidden = false;
      $('restore-text').value = text;
      $('restore-text').select();
      showMsg('settings-msg', "Couldn't reach the clipboard, so the backup is in the box below. Press Ctrl+C to copy it.");
    }
  });
  $('backup-download').addEventListener('click', () => {
    const blob = new Blob([exportBackup()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `skills-plus-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });
  $('backup-restore-toggle').addEventListener('click', () => { $('restore-box').hidden = !$('restore-box').hidden; $('restore-text').value = ''; });
  $('restore-go').addEventListener('click', () => {
    try {
      const res = importBackup($('restore-text').value);
      showMsg('settings-msg', `Restored: ${res.snaps} snapshots, ${res.playersAdded} saved players, ${res.goals} goals and ${res.banks} bank${res.banks === 1 ? '' : 's'} added.`, 'ok');
      renderSettings(); render();
    } catch (err) { showMsg('settings-msg', esc(err.message), 'error'); }
  });
  $('data-clear').addEventListener('click', e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to clear'; return; }
    for (const key of store.keys()) store.remove(key);
    b.dataset.armed = ''; b.textContent = 'Clear everything';
    state.lookup = { profile: null, previous: null, snapSaved: false };
    state.compare.names = []; state.compare.profiles = {};
    state.gains.player = null;
    planner.reset();
    showMsg('settings-msg', 'Everything this tool stored has been removed.', 'ok');
    renderSettings(); render();
  });

  api.addEventListener('queue', renderStatus);
  prices.addEventListener('update', renderStatus);
  totals.addEventListener('update', () => {
    renderStatus();
    if (state.tab === 'lookup') { renderPlayerCard(); renderTiles(); }
    if (state.tab === 'compare') renderCompare();
    if (state.tab === 'leaders') renderLeaders();
    if ($('settings').open) renderSettings();
  });
  window.addEventListener('hashchange', () => { if (applyHash()) { render(); afterRoute(); } });
  setInterval(renderStatus, 30_000);
}

function afterRoute() {
  if (state.tab === 'compare') loadCompareMissing();
  if (state.tab === 'leaders') loadLeaders();
  if (state.tab === 'gains') maybeAutoUpdateGains();
  if (PLAN_TABS.includes(state.tab)) planner.show(state.tab);
}

// ── Start ────────────────────────────────────────────────────────────────
function start() {
  wire();
  const routed = location.hash.length > 1 && applyHash();
  if (!routed && state.tab === 'lookup' && prefs.lastLookup) $('lookup-name').value = prefs.lastLookup;
  render();
  if (!routed && state.tab === 'lookup' && prefs.lastLookup) doLookup(prefs.lastLookup);
  afterRoute();
  // Refresh any player counts older than a day and a half, in the background.
  totals.loaded.then(() => totals.refresh());
}

start();
