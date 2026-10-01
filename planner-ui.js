// Skills+ planner views: Goals, Bank and Prices.
//
// Goals and the bank belong to one account (the "planning for" name), stored
// per account so alts can have their own. The maths lives in planner.js; this
// file only turns it into LostKit-style panels.

import { SKILLS, SKILL_BY_KEY, SKILL_IDS, MIN_RANKED_LEVEL, MAX_LEVEL, boundUnrankedLevels } from './skills.js';
import { ITEMS, METHODS, BANK_GROUPS, ICONS_PER_ROW, ICON_SIZE, UNID_HERBS } from './gamedata.js';
import { indexMethods, planGoal, goalTargetXp10, rankForTop, xp10ForLevel, levelForXp10, bankValue, MAX_XP10 } from './planner.js';
import { store, players } from './store.js';
import { toSafeName, toDisplayName, checkName } from './api.js';
import { topPercent, formatPercent } from './totals.js';

// One method index per skill that has calculator data.
const INDEX = {};
for (const key of new Set(METHODS.map(m => m.skill))) INDEX[key] = indexMethods(METHODS.filter(m => m.skill === key));
export const hasCalculator = key => !!INDEX[key];

// Wording that depends on the skill.
const SKILL_TEXT = {
  herblore: { what: 'Potion', each: 'potion', bankHint: 'herbs, unfinished potions and secondaries' },
  runecraft: { what: 'Rune', each: 'essence', bankHint: 'rune essence' },
};
const textFor = key => SKILL_TEXT[key] || { what: 'Make', each: 'action', bankHint: 'the items it uses' };

// Cheap supplies that shouldn't hold a plan back (still shown as needed).
const DEFAULT_ASSUME = { herblore: ['vial_water'] };
const ASSUME_LABEL = { herblore: 'vials of water' };
const TARGET_TTL = 30 * 60e3;          // re-check who holds a rank after this long
const PROFILE_TTL = 5 * 60e3;

// Every unidentified herb is one "Unid herb" entry (they're all a plain "Herb"
// in-game). Banks saved by v2.0.0 kept each kind apart: fold those in.
export function mergeUnids(items) {
  const out = { ...items };
  let changed = false;
  for (const k of Object.keys(out)) {
    if (!k.startsWith('unidentified_') || k === UNID_HERBS.item) continue;
    out[UNID_HERBS.item] = (out[UNID_HERBS.item] || 0) + (Number(out[k]) || 0);
    delete out[k];
    changed = true;
  }
  return { changed, items: out };
}

// "1,500", "1.5k", "2m" -> number; '' -> 0; nonsense -> null
export function parseAmount(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/[\s,_]/g, '');
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.min(2_147_483_647, Math.floor(parseFloat(m[1]) * mult));
}

// 3405 -> "3,405", 15_120_000 -> "15.1M", 250_000 -> "250K"
export function gpShort(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  if (a >= 1e9) return sign + trim(a / 1e9, 2) + 'B';
  if (a >= 1e7) return sign + trim(a / 1e6, 1) + 'M';
  if (a >= 1e6) return sign + trim(a / 1e6, 2) + 'M';
  if (a >= 1e5) return sign + Math.round(a / 1e3) + 'K';
  if (a < 10 && a % 1) return sign + trim(a, 2);
  return sign + Math.round(a).toLocaleString();
}
const trim = (v, d) => v.toLocaleString(undefined, { maximumFractionDigits: d });

// XP in tenths, shown the way the game does (a decimal only when there is one).
export const xpText = x10 => (x10 % 10
  ? (x10 / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  : (x10 / 10).toLocaleString());

export function createPlanner(ctx) {
  const { api, totals, prices, esc, fmt, ago, iconImg, showMsg, errorText } = ctx;
  const $ = id => document.getElementById(id);
  const ui = store.get('planUi', {});
  const S = {
    account: store.get('plan.account', null) || ctx.defaultAccount?.() || null,
    profile: null,
    loading: false,
    error: null,
    newGoal: { skill: SKILL_BY_KEY.has(ui.newSkill) ? ui.newSkill : 'herblore', type: ['level', 'xp', 'rank', 'top'].includes(ui.newType) ? ui.newType : 'level' },
    open: new Set(Array.isArray(ui.open) ? ui.open : []),
    sort: ['level', 'xp', 'cheap'].includes(ui.sort) ? ui.sort : 'level',
    show: ['all', 'active', 'done'].includes(ui.show) ? ui.show : 'all',     // goal filter: status
    only: SKILL_BY_KEY.has(ui.only) ? ui.only : null,                        // goal filter: one skill
    visible: [],                                                              // goal ids shown, in order
    bankSkill: BANK_GROUPS[ui.bankSkill] ? ui.bankSkill : 'herblore',   // which skill the Bank and Prices tabs show
    rankLoading: new Set(),
    goalErr: {},
    tab: null,
  };
  const saveUi = () => store.set('planUi', { newSkill: S.newGoal.skill, newType: S.newGoal.type, open: [...S.open], sort: S.sort, show: S.show, only: S.only, bankSkill: S.bankSkill });

  // ── Storage per account ─────────────────────────────────────────────────
  const safe = () => (S.account ? toSafeName(S.account) : '');
  const goals = () => (safe() ? store.get('goals.' + safe(), []) : []);
  const saveGoals = list => { store.set('goals.' + safe(), list); ctx.onChange?.(); };
  function bank() {
    if (!safe()) return { items: {}, updated: 0 };
    const b = store.get('bank.' + safe(), { items: {}, updated: 0 });
    const merged = mergeUnids(b.items || {});
    if (merged.changed) { b.items = merged.items; store.set('bank.' + safe(), b); }
    return b;
  }
  const saveBank = b => { b.updated = Date.now(); store.set('bank.' + safe(), b); };
  function updateGoal(id, fn) {
    const list = goals();
    const g = list.find(x => x.id === id);
    if (!g) return;
    fn(g);
    saveGoals(list);
  }

  function setAccount(name) {
    const problem = checkName(name);
    if (problem) { showMsg('goals-msg', esc(problem), 'error'); return false; }
    S.account = toDisplayName(name);
    store.set('plan.account', S.account);
    S.profile = null;
    showMsg('goals-msg', '');
    loadProfile();
    return true;
  }

  // ── The account's XP ────────────────────────────────────────────────────
  async function loadProfile({ force = false } = {}) {
    if (!S.account || S.loading) return;
    const mine = p => p && p.safe === safe();
    const lookup = ctx.lookupProfile?.();
    if (!force && mine(lookup) && (!S.profile || lookup.fetchedAt > S.profile.fetchedAt)) S.profile = lookup;
    if (!force && mine(S.profile) && Date.now() - S.profile.fetchedAt < PROFILE_TTL) { rerender(); return; }
    S.loading = true; S.error = null; rerender();
    try {
      const p = await api.player(S.account, { force });
      if (!p) S.error = `No hiscores entry for <b>${esc(S.account)}</b>. Check the spelling; new players appear after logging out once.`;
      else if (p.safe === safe()) { S.profile = p; ctx.onProfile?.(p); }
    } catch (e) {
      S.error = errorText(e);
    } finally {
      S.loading = false;
      rerender();
    }
  }

  // Current XP in a skill. Below level 15 a skill isn't on the hiscores, so the
  // lowest level it can be is used (worked out from the total level).
  function currentOf(skillKey) {
    const p = S.profile;
    if (!p) return null;
    const skill = SKILL_BY_KEY.get(skillKey);
    const st = p.stats[skill.id];
    if (st) return { xp10: st.xp10 ?? st.xp * 10, level: st.level, rank: st.rank, ranked: true };
    const levels = {};
    for (const s of SKILLS) if (s.id && p.stats[s.id]) levels[s.key] = p.stats[s.id].level;
    const b = boundUnrankedLevels(levels, p.stats[0]?.level)[skillKey];
    const level = b ? b.min : 1;
    return { xp10: xp10ForLevel(level), level, rank: null, ranked: false, range: b };
  }

  // ── Goal targets ────────────────────────────────────────────────────────
  // { xp10, rank?, who?, at?, reached?, pending?, note? }
  function targetOf(goal, cur) {
    if (goal.type === 'level' || goal.type === 'xp') return { xp10: goalTargetXp10(goal) };
    const skill = SKILL_BY_KEY.get(goal.skill);
    let rank;
    if (goal.type === 'rank') rank = Math.max(1, Math.floor(goal.value));
    else {
      const t = totals.get(skill.id);
      if (!t) return { pending: true, note: 'Counting players…' };
      rank = rankForTop(goal.value, t.total);
    }
    if (cur?.rank && cur.rank <= rank) return { xp10: cur.xp10, rank, reached: true };
    const c = goal.target;
    const fresh = c && c.rank === rank && Date.now() - c.at < TARGET_TTL;
    if (!fresh && !S.goalErr[goal.id]) fetchRankTarget(goal, skill, rank);    // after an error, wait for Refresh
    if (c && c.rank === rank) return { xp10: c.xp10, rank, who: c.who, at: c.at };
    return { pending: true, rank, note: `Looking up who holds rank ${fmt(rank)}…` };
  }

  async function fetchRankTarget(goal, skill, rank) {
    const key = goal.id + ':' + rank;
    if (S.rankLoading.has(key)) return;
    S.rankLoading.add(key);
    delete S.goalErr[goal.id];
    try {
      const rows = await api.category(skill.id, rank, { priority: 'fg' });
      const row = rows.find(r => r.rank === rank);
      // Nobody at that rank yet: being ranked at all (level 15) is enough.
      const xp10 = row ? row.xp10 + 1 : xp10ForLevel(MIN_RANKED_LEVEL);
      updateGoal(goal.id, g => { g.target = { rank, xp10, at: Date.now(), who: row?.name || null }; });
    } catch (e) {
      S.goalErr[goal.id] = errorText(e);
    } finally {
      S.rankLoading.delete(key);
      rerender();
    }
  }

  function planFor(goal) {
    const cur = currentOf(goal.skill);
    const target = cur ? targetOf(goal, cur) : null;
    const ix = INDEX[goal.skill];
    if (!cur || !target || target.pending || !ix) return { cur, target, ix };
    const plan = planGoal(ix, {
      bank: bank().items,
      currentXp10: cur.xp10,
      targetXp10: target.reached ? cur.xp10 : target.xp10,
      excluded: new Set(goal.excluded || []),
      unlimited: new Set(goal.assume ?? DEFAULT_ASSUME[goal.skill] ?? []),
      useBank: goal.useBank !== false,
      fillId: goal.fillId,
      priceOf: prices.priceOf,
    });
    return { cur, target, ix, plan };
  }

  // Items a skill's plan can price (inputs down to buyable, and outputs).
  function skillItems(key) {
    const out = new Set();
    for (const g of BANK_GROUPS[key] || []) for (const i of g.items) out.add(i);
    for (const m of METHODS) if (m.skill === key) for (const i of [...Object.keys(m.in), ...Object.keys(m.out)]) out.add(i);
    return [...out];
  }
  function wantPrices(keys) {
    const items = new Set();
    for (const k of keys) for (const i of skillItems(k)) items.add(i);
    prices.want([...items]);
  }

  // ── Small HTML helpers ──────────────────────────────────────────────────
  function itemIcon(slug, small = false) {
    const it = ITEMS[slug];
    if (!it) return '';
    const size = small ? ICON_SIZE / 2 : ICON_SIZE;
    const x = (it.icon % ICONS_PER_ROW) * size, y = Math.floor(it.icon / ICONS_PER_ROW) * size;
    const bg = small ? `background-size:${ICONS_PER_ROW * size}px auto;` : '';
    return `<span class="item${small ? ' sm' : ''}" style="${bg}background-position:-${x}px -${y}px" role="img" aria-label="${esc(it.name)}" title="${esc(it.name)}"></span>`;
  }
  const itemName = slug => esc(ITEMS[slug]?.name || slug);
  const methodOut = m => Object.keys(m.out)[0];
  function priceTip(slug) {
    const i = prices.info(slug);
    if (!i) return 'No price yet';
    return `${gpShort(i.gp)} gp each · ${sourceText(i)}`;
  }
  function sourceText(i) {
    if (!i) return '';
    if (i.src === 'you') return 'your price';
    if (i.src === 'sales') return `median of ${i.n} sale${i.n === 1 ? '' : 's'}${i.last ? `, last ${ago(i.last)}` : ''}`;
    if (i.src === 'offers') return `median of ${i.n} open offer${i.n === 1 ? '' : 's'}`;
    if (i.src === 'dose') return '¾ of the 4-dose price';
    if (i.src === 'shop') return 'no trades: shop value';
    return '';
  }
  // "3,948 Ranarr weed" chips; with prices when known.
  function itemList(items, { priced = true, small = false, named = !small } = {}) {
    const entries = Object.entries(items).filter(([, n]) => n > 0);
    if (!entries.length) return '<span class="c-faint">nothing</span>';
    return entries.map(([slug, n]) => {
      const p = priced ? prices.gp(slug) : null;
      return `<span class="it-chip" title="${esc(ITEMS[slug]?.name || slug)}${priced ? '\n' + esc(priceTip(slug)) : ''}">${itemIcon(slug, small)}<b>${fmt(n)}</b>${named ? ' ' + itemName(slug) : ''}${p != null && named ? ` <span class="c-faint">(${gpShort(p * n)})</span>` : ''}</span>`;
    }).join('');
  }
  const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 100);
  // "700 × Prayer potion", or for a method counted in what it uses:
  // "5,000 essence → 25,000 Air runes"
  function actionText(m, runs, made) {
    if (!m.unit) return `<b>${fmt(runs)}</b> × ${esc(m.name)}`;
    const [item, n] = Object.entries(made || {})[0] || [methodOut(m), runs];
    return `<b>${fmt(runs)}</b> ${esc(m.unit)} → <b>${fmt(n)}</b> ${esc(n === 1 ? m.name : m.name + 's')}`;
  }
  // "×3", for runes that come more than one per essence at this level
  function multipleBadge(m, level) {
    if (!m.multiple) return '';
    const k = Math.floor(level / m.multiple) + 1;
    const next = (k) * m.multiple;
    const tip = `${k} per ${m.unit || 'action'} at level ${level}${next <= MAX_LEVEL ? `, ${k + 1} from level ${next}` : ''}`;
    return k > 1 || next <= MAX_LEVEL ? ` <span class="mult" title="${esc(tip)}">×${k}</span>` : '';
  }
  // Methods by group, the main way to train (kind xp) first: [[group, methods], ...]
  function groupsOf(methods) {
    const map = new Map();
    for (const m of [...methods].sort((a, b) => (a.kind === 'xp' ? 0 : 1) - (b.kind === 'xp' ? 0 : 1))) {
      if (!map.has(m.group)) map.set(m.group, []);
      map.get(m.group).push(m);
    }
    return [...map];
  }

  // ── Goals view ──────────────────────────────────────────────────────────
  // Moves a goal past its neighbour among the goals on screen, so it works the
  // same with a filter on.
  function moveGoal(id, dir) {
    const vi = S.visible.indexOf(id);
    const other = S.visible[vi + dir];
    if (vi < 0 || !other) return;
    const list = goals();
    const i = list.findIndex(g => g.id === id);
    if (i < 0) return;
    const [g] = list.splice(i, 1);
    const j = list.findIndex(x => x.id === other);
    list.splice(dir < 0 ? j : j + 1, 0, g);
    saveGoals(list);
  }

  function renderGoals() {
    renderAccount('plan-account', 'goals');
    renderNewGoal();
    const list = goals();
    const box = $('goals-list');
    if (!S.account) { box.innerHTML = ''; return; }
    if (!list.length) {
      box.innerHTML = `<div class="empty">No goals yet. Pick a skill above and set a level, XP, rank or top % to reach.<br>
        Herblore has the full planner (potions, bank and prices); more skills follow.</div>`;
      return;
    }
    // A goal set before your XP had loaded starts counting from the first XP seen.
    if (S.profile && list.some(g => g.startXp10 == null && currentOf(g.skill))) {
      for (const g of list) if (g.startXp10 == null) g.startXp10 = currentOf(g.skill)?.xp10 ?? null;
      saveGoals(list);
    }
    // Filter: by status and/or one skill. The order is yours (move goals up and down).
    const done = g => {
      const cur = currentOf(g.skill);
      const t = cur && targetOf(g, cur);
      return !!(t && !t.pending && (t.reached || t.xp10 <= cur.xp10));
    };
    const status = new Map(list.map(g => [g.id, done(g)]));
    const skills = [...new Set(list.map(g => g.skill))];
    if (S.only && !skills.includes(S.only)) S.only = null;
    const shown = list.filter(g => (S.show === 'all' || (S.show === 'done') === status.get(g.id)) && (!S.only || g.skill === S.only));
    S.visible = shown.map(g => g.id);
    const count = k => list.filter(g => k === 'all' || (k === 'done') === status.get(g.id)).length;
    const sBtn = (k, label) => `<button type="button" class="${S.show === k ? 'on' : ''}" data-gshow="${k}">${label} <span class="c-faint">${count(k)}</span></button>`;
    const anyOpen = shown.some(g => S.open.has(g.id) && hasCalculator(g.skill));
    const bar = list.length > 1 ? `<div class="goal-filter">
        <span class="c-muted small-note">Show</span>
        <div class="seg" role="group" aria-label="Show goals">${sBtn('all', 'All')}${sBtn('active', 'In progress')}${sBtn('done', 'Reached')}</div>
        ${skills.length > 1 ? `<div class="skill-picker mini" role="group" aria-label="Only one skill">${skills.map(k => {
          const sk = SKILL_BY_KEY.get(k);
          const on = S.only === k;
          return `<button type="button" class="skill-btn${on ? ' on' : ''}" data-gonly="${k}" title="${on ? 'Show every skill' : `Only ${esc(sk.name)}`}" aria-pressed="${on}">${iconImg(sk)}</button>`;
        }).join('')}</div>` : ''}
        <span class="grow"></span>
        ${shown.some(g => hasCalculator(g.skill)) ? `<button type="button" class="linkish" data-act="${anyOpen ? 'close-all' : 'open-all'}">${anyOpen ? 'Hide all plans' : 'Show all plans'}</button>` : ''}
      </div>` : '';
    box.innerHTML = bar + (shown.length
      ? shown.map((g, i) => goalCard(g, i === 0, i === shown.length - 1)).join('')
      : `<div class="empty">No goals match. <button type="button" class="linkish" data-act="show-all-goals">Show all goals</button></div>`);
    const keys = [...new Set(list.map(g => g.skill).filter(hasCalculator))];
    if (keys.length && S.profile) wantPrices(keys);
  }

  function renderAccount(id, where) {
    const el = $(id);
    const saved = players.saved(), recent = players.recent();
    const names = [...new Set([...saved, ...recent])];
    const p = S.profile;
    const status = !S.account ? ''
      : S.loading ? '<span class="pending">Fetching XP…</span>'
      : S.error ? `<span class="c-lose">${S.error}</span>`
      : p ? `XP from the hiscores ${ago(p.fetchedAt)}` : '';
    el.innerHTML = `<div class="card plan-account">
      <form class="inline" data-form="account" autocomplete="off">
        <span class="c-muted">Planning for</span>
        <input class="input small" name="account" maxlength="12" list="plan-names" value="${esc(S.account || '')}" placeholder="Your username" spellcheck="false" aria-label="Planning for">
        <datalist id="plan-names">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        <button class="btn small" type="submit">${S.account ? 'Switch' : 'Start'}</button>
      </form>
      ${S.account ? `<span class="acct-status">${status}</span>
      <button type="button" class="linkish" data-act="refresh-xp">Refresh XP</button>` : ''}
      ${where === 'bank' && S.account ? `<span class="c-faint">Each account has its own bank and goals.</span>` : ''}
    </div>`;
    if (!S.account) {
      el.innerHTML += `<div class="empty">Enter your username to plan goals. Your XP comes from the hiscores; goals and your bank stay in this browser.</div>`;
    }
  }

  function renderNewGoal() {
    const el = $('goal-new');
    if (!S.account) { el.innerHTML = ''; return; }
    const g = S.newGoal;
    const cur = currentOf(g.skill);
    const skill = SKILL_BY_KEY.get(g.skill);
    const tBtn = (t, label) => `<button type="button" class="${g.type === t ? 'on' : ''}" data-ntype="${t}">${label}</button>`;
    const placeholder = { level: 'Level (2–99)', xp: 'XP', rank: 'Rank', top: 'Top % (e.g. 10)' }[g.type];
    const suggestion = suggestValue(g.type, cur, skill);
    el.innerHTML = `<div class="card goal-new">
      <div class="skill-picker">${SKILL_IDS.map(id => {
        const s = SKILLS.find(x => x.id === id);
        return `<button type="button" class="skill-btn${s.key === g.skill ? ' on' : ''}" data-nskill="${s.key}" title="${esc(s.name)}${hasCalculator(s.key) ? ' (planner)' : ''}" aria-label="${esc(s.name)}" aria-pressed="${s.key === g.skill}">${iconImg(s)}${hasCalculator(s.key) ? '<span class="calc-dot"></span>' : ''}</button>`;
      }).join('')}</div>
      <form class="bar wrap" data-form="goal" autocomplete="off">
        <span class="goal-skill">${iconImg(skill)} ${esc(skill.name)}</span>
        <div class="seg" role="group" aria-label="Goal type">${tBtn('level', 'Level')}${tBtn('xp', 'XP')}${tBtn('rank', 'Rank')}${tBtn('top', 'Top %')}</div>
        <input class="input small num" name="value" inputmode="decimal" placeholder="${placeholder}" value="${suggestion ?? ''}" aria-label="${placeholder}">
        <button class="btn small" type="submit">Add goal</button>
        <span class="c-faint small-note">${cur ? currentLine(cur, skill) : S.profile ? '' : 'Your XP loads from the hiscores.'}</span>
      </form>
    </div>`;
  }

  function currentLine(cur, skill) {
    if (!cur.ranked) return `Now: level ${cur.range && cur.range.min !== cur.range.max ? `${cur.range.min}–${cur.range.max}` : cur.level} (below ${MIN_RANKED_LEVEL}, not on the hiscores)`;
    const t = totals.get(skill.id);
    const top = t ? topPercent(cur.rank, t.total) : null;
    return `Now: level ${cur.level} · ${xpText(cur.xp10)} XP · rank ${fmt(cur.rank)}${top != null ? ` · top ${formatPercent(top)}%` : ''}`;
  }

  function suggestValue(type, cur, skill) {
    if (!cur) return type === 'level' ? 99 : '';
    if (type === 'level') return Math.min(MAX_LEVEL, cur.level + 1);
    if (type === 'xp') return Math.round(xp10ForLevel(Math.min(MAX_LEVEL, cur.level + 1)) / 10);
    if (type === 'rank') return cur.rank ? Math.max(1, Math.floor(cur.rank * 0.8)) : '';
    const t = totals.get(skill.id);
    const top = cur.rank && t ? topPercent(cur.rank, t.total) : null;
    return top != null ? Math.max(0.1, Math.floor(top * 0.8 * 10) / 10) : 10;
  }

  function addGoal(value) {
    const g = S.newGoal;
    const v = g.type === 'top' ? parseFloat(String(value).replace(',', '.')) : parseAmount(value);
    const bad = msg => { showMsg('goals-msg', msg, 'error'); return false; };
    if (v == null || !Number.isFinite(v) || v <= 0) return bad('Enter a number for the goal.');
    if (g.type === 'level' && (v < 2 || v > MAX_LEVEL)) return bad('Levels go from 2 to 99.');
    if (g.type === 'xp' && v > MAX_XP10 / 10) return bad('XP stops at 200,000,000.');
    if (g.type === 'top' && v > 100) return bad('Top % is at most 100.');
    const cur = currentOf(g.skill);
    const name = SKILL_BY_KEY.get(g.skill).name;
    if (cur && g.type === 'level' && cur.ranked && v <= cur.level) return bad(`${esc(S.account)} is already level ${cur.level} in ${esc(name)}.`);
    if (cur && g.type === 'xp' && cur.ranked && v * 10 <= cur.xp10) return bad(`${esc(S.account)} already has ${xpText(cur.xp10)} ${esc(name)} XP.`);
    if (cur && g.type === 'rank' && cur.rank && cur.rank <= v) return bad(`${esc(S.account)} is already rank ${fmt(cur.rank)} in ${esc(name)}.`);
    if (cur && g.type === 'top' && cur.rank) {
      const t = totals.get(SKILL_BY_KEY.get(g.skill).id);
      const top = t ? topPercent(cur.rank, t.total) : null;
      if (top != null && top <= v) return bad(`${esc(S.account)} is already in the top ${formatPercent(top)}% in ${esc(name)}.`);
    }
    const goal = {
      id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      skill: g.skill, type: g.type, value: g.type === 'top' ? Math.round(v * 100) / 100 : Math.floor(v),
      created: Date.now(), startXp10: cur ? cur.xp10 : null,
    };
    const list = goals();
    list.push(goal);
    saveGoals(list);
    if (hasCalculator(g.skill)) S.open.add(goal.id);
    saveUi();
    showMsg('goals-msg', '');
    renderGoals();
    return true;
  }

  function goalTitle(goal, cur, target) {
    const t = totals.get(SKILL_BY_KEY.get(goal.skill).id);
    const topNow = cur?.rank && t ? topPercent(cur.rank, t.total) : null;
    if (goal.type === 'level') return `Level ${cur ? cur.level : '?'} → <b>${goal.value}</b>`;
    if (goal.type === 'xp') return `${cur ? xpText(cur.xp10) : '?'} → <b>${fmt(goal.value)}</b> XP`;
    if (goal.type === 'rank') return `Rank ${cur?.rank ? fmt(cur.rank) : 'none'} → <b>${fmt(goal.value)}</b>`;
    return `Top ${topNow != null ? formatPercent(topNow) + '%' : '?'} → <b>${formatPercent(goal.value)}%</b>${target?.rank ? ` <span class="c-faint">(rank ${fmt(target.rank)})</span>` : ''}`;
  }

  function goalCard(goal, first = true, last = true) {
    const skill = SKILL_BY_KEY.get(goal.skill);
    const { cur, target, ix, plan } = planFor(goal);
    const open = S.open.has(goal.id);
    let sub = '', bar = '', reached = false;
    if (!cur) sub = S.loading ? '<span class="pending">Loading your XP…</span>' : 'Your XP is not loaded.';
    else if (!target || target.pending) sub = `<span class="pending">${esc(target?.note || 'Working it out…')}</span>`;
    else {
      const toGo = Math.max(0, target.xp10 - cur.xp10);
      reached = target.reached || toGo === 0;
      const lvTo = levelForXp10(target.xp10);
      const levels = lvTo - cur.level;
      const who = target.who ? ` · beat ${esc(target.who)} (rank ${fmt(target.rank)}, checked ${ago(target.at)})` : '';
      sub = reached
        ? `<span class="c-win">Reached</span> · ${xpText(cur.xp10)} XP`
        : `${xpText(cur.xp10)} / ${xpText(target.xp10)} XP · <b>${xpText(toGo)}</b> XP to go${levels > 0 ? ` · ${levels} level${levels === 1 ? '' : 's'} (to ${lvTo})` : ''}${who}`;
      const start = goal.startXp10 ?? cur.xp10;
      const p = reached ? 100 : pct(cur.xp10 - start, target.xp10 - start);
      bar = `<div class="pbar goal-bar${reached ? ' maxed' : ''}" title="${p.toFixed(1)}% of the way since you set this goal"><div style="width:${p.toFixed(1)}%"></div></div>`;
      if (!cur.ranked) sub += ` <span class="c-faint">(${esc(skill.name)} is below ${MIN_RANKED_LEVEL}, so its lowest possible level is used)</span>`;
    }
    const err = S.goalErr[goal.id] ? `<div class="msg error">${S.goalErr[goal.id]}</div>` : '';
    const toggle = ix
      ? `<button type="button" class="btn small" data-act="toggle-plan" aria-expanded="${open}">${open ? 'Hide plan' : 'Plan'}</button>`
      : `<span class="c-faint small-note">The ${esc(skill.name)} calculator comes in a later update. This goal tracks your progress meanwhile.</span>`;
    return `<div class="card goal" data-goal="${goal.id}">
      <div class="goal-head">${iconImg(skill)} <span class="goal-name">${esc(skill.name)}</span>
        <span class="goal-title">${goalTitle(goal, cur, target)}</span>
        <span class="grow"></span>
        ${toggle}
        <span class="mv-group">
          <button type="button" class="mv" data-act="goal-up" title="Move up" aria-label="Move ${esc(skill.name)} goal up"${first ? ' disabled' : ''}>▲</button>
          <button type="button" class="mv" data-act="goal-down" title="Move down" aria-label="Move ${esc(skill.name)} goal down"${last ? ' disabled' : ''}>▼</button>
        </span>
        <button type="button" class="x" data-act="remove-goal" title="Remove this goal" aria-label="Remove goal">✕</button>
      </div>
      <div class="goal-sub">${sub}</div>
      ${bar}${err}
      ${ix && open && plan ? planHtml(goal, plan, ix, cur) : ''}
    </div>`;
  }

  // ── The plan for one goal ───────────────────────────────────────────────
  function planHtml(goal, plan, ix, cur) {
    const b = bank();
    const useBank = goal.useBank !== false;
    const assume = new Set(goal.assume ?? DEFAULT_ASSUME[goal.skill] ?? []);
    const bankCount = Object.values(b.items).filter(n => n > 0).length;
    const opts = `<div class="plan-opts">
      <label class="check"><input type="checkbox" data-gopt="useBank" ${useBank ? 'checked' : ''}> Use my bank</label>
      ${ASSUME_LABEL[goal.skill] ? `<label class="check" title="When on, running out of these never stops a plan; you still see how many you need."><input type="checkbox" data-gopt="assume" ${assume.size ? 'checked' : ''}> I'll buy ${ASSUME_LABEL[goal.skill]} as I go</label>` : ''}
      <span class="c-faint">${bankCount ? `${bankCount} kinds of item in your bank, updated ${ago(b.updated)}` : 'Your bank is empty'} ·</span>
      <button type="button" class="linkish" data-act="to-bank" data-skill="${goal.skill}">Edit bank</button>
    </div>`;
    return `<div class="plan">${opts}${useBank ? bankHtml(goal, plan, ix) : ''}${thenHtml(goal, plan, ix)}${tableHtml(goal, plan, ix, cur)}</div>`;
  }

  // Unid herbs can't be planned with (which herb they are is only known once
  // identified), so they get a note instead.
  function unidNote(goal) {
    const n = goal.skill === 'herblore' ? bank().items[UNID_HERBS.item] || 0 : 0;
    if (!n) return '';
    return `<div class="tip">${itemIcon(UNID_HERBS.item, true)} You also have <b>${fmt(n)}</b> unid herb${n === 1 ? '' : 's'}. Identify them first
      (${xpText(UNID_HERBS.xpMin)}–${xpText(UNID_HERBS.xpMax)} XP each, depending on the herb), then add the herbs to your bank.</div>`;
  }

  function bankHtml(goal, plan, ix) {
    const fb = plan.fromBank;
    if (!fb.steps.length) {
      return `<div class="plan-sec"><h4>From your bank</h4><div class="c-faint small-note">Nothing in your bank makes ${esc(SKILL_BY_KEY.get(goal.skill).name)} XP at your level yet.
        Add ${textFor(goal.skill).bankHint} in the <button type="button" class="linkish" data-act="to-bank" data-skill="${goal.skill}">Bank</button> tab.</div>${unidNote(goal)}</div>`;
    }
    const rows = fb.steps.map((s, i) => {
      const m = ix.byId.get(s.id);
      const subs = Object.entries(s.sub).map(([id, n]) => {
        const sm = ix.byId.get(id);
        return `${fmt(n)} × ${esc(sm.name)}${sm.xp > 0 ? ` <span class="c-level">+${xpText(n * sm.xp)} XP</span>` : ''}`;
      });
      const goalHere = fb.goalReached && fb.goalReached.index === i
        ? `<span class="goal-flag" title="Your goal is reached during this step">Goal after ${fmt(fb.goalReached.runs)}</span>` : '';
      return `<div class="step">${itemIcon(methodOut(m))}<div class="step-main">
          <div>${actionText(m, s.runs, s.made)} <span class="c-level">+${xpText(s.xp10)} XP</span> ${goalHere}</div>
          ${subs.length ? `<div class="c-faint small-note">incl. ${subs.join(', ')}</div>` : ''}
        </div></div>`;
    }).join('');
    const assumed = Object.keys(fb.assumed).length
      ? `<div class="tip">Also uses ${itemList(fb.assumed, { small: true, named: true })} that ${Object.keys(fb.assumed).length === 1 ? "isn't" : "aren't"} in your bank.</div>` : '';
    const reach = fb.goalReached ? `<span class="c-win">That reaches your goal.</span>` : '';
    return `<div class="plan-sec"><h4>From your bank <span class="c-level">+${xpText(fb.xp10)} XP</span> <span class="c-faint">→ level ${fb.endLevel}</span> ${reach}</h4>
      <div class="steps">${rows}</div>${assumed}${unidNote(goal)}</div>`;
  }

  function thenHtml(goal, plan, ix) {
    if (plan.remaining <= 0 || !plan.fill) return '';
    const f = plan.fill;
    const choices = ix.train.filter(m => !(goal.excluded || []).includes(m.id));
    const sel = `<select class="input small" data-gopt="fill" aria-label="Train with">${groupsOf(choices).map(([name, list]) =>
      `<optgroup label="${esc(name)}">${list.map(m => `<option value="${m.id}"${m.id === f.id ? ' selected' : ''}>${esc(m.name)} (lvl ${m.level}, ${xpText(m.xp)} XP)</option>`).join('')}</optgroup>`).join('')}</select>`;
    const segs = f.segments.map(s => {
      const m = ix.byId.get(s.id);
      return `<div class="step">${itemIcon(methodOut(m))}<div class="step-main"><div>${s.bridge ? 'First ' : ''}${actionText(m, s.runs, s.made)} <span class="c-level">+${xpText(s.xp10)} XP</span>${s.bridge ? ` <span class="c-faint">to reach level ${ix.byId.get(f.id).level}</span>` : ''}</div></div></div>`;
    }).join('');
    // Money: buying what's missing, and what the made items are worth.
    const made = {};
    for (const s of f.segments) for (const [item, n] of Object.entries(s.made)) made[item] = (made[item] || 0) + n;
    const worth = bankValue(made, prices.priceOf);
    const known = !f.costMissing.length && !worth.missing.length;
    const money = `<div class="money">
      <span>Buying it all: <b>${f.costMissing.length ? '?' : gpShort(f.cost)}</b> gp</span>
      <span>What you make is worth: <b>${worth.missing.length ? '?' : gpShort(worth.total)}</b> gp</span>
      ${known ? `<span>Net: <b class="${worth.total - f.cost >= 0 ? 'c-win' : 'c-lose'}">${worth.total - f.cost >= 0 ? '+' : ''}${gpShort(worth.total - f.cost)}</b> gp</span>` : `<span class="c-faint">(some prices are still unknown)</span>`}
    </div>`;
    const row = plan.table.find(r => r.id === f.id);
    const balance = row?.balance && goal.useBank !== false
      ? `<div class="tip">Tip: collect ${itemList(row.balance.collect, { small: true, named: true })} and your bank makes <b>${fmt(row.balance.runs)}</b> ${esc(ix.byId.get(f.id).name)} instead of ${fmt(row.have)}.</div>` : '';
    return `<div class="plan-sec"><h4>Then, to reach your goal: <span class="c-xp">${xpText(plan.remaining)} XP</span></h4>
      <div class="bar wrap"><span class="c-muted">Train with</span> ${sel}</div>
      <div class="steps">${segs}</div>
      <div class="collect"><span class="c-muted">To collect or buy:</span> ${itemList(f.buy)}</div>
      ${money}${balance}</div>`;
  }

  function unitNote(key, ix) {
    const each = textFor(key).each;
    const counted = ix.train.some(m => m.unit) ? ` Counts are in ${each}.` : '';
    return `To goal = how many on their own · From bank = how many your bank covers now · Profit is per ${each}, bought from scratch.${counted}`;
  }

  function tableHtml(goal, plan, ix, cur) {
    const excluded = new Set(goal.excluded || []);
    let rows = plan.table.map(r => ({ r, m: ix.byId.get(r.id) }));
    if (S.sort === 'xp') rows.sort((a, b) => b.m.xp - a.m.xp);
    else if (S.sort === 'cheap') rows.sort((a, b) => (a.r.econ.gpPerXp ?? Infinity) - (b.r.econ.gpPerXp ?? Infinity));
    const body = groupsOf(rows.map(x => x.m)).map(([gname]) => {
      const inGroup = rows.filter(x => x.m.group === gname);
      return `<tr class="grp"><td colspan="10">${esc(gname)}</td></tr>` + inGroup.map(({ r, m }) => {
        const e = r.econ;
        const chosen = plan.fill?.id === m.id;
        const profit = e.profit == null ? '<span class="c-faint">?</span>' : `<span class="${e.profit >= 0 ? 'c-win' : 'c-lose'}">${e.profit >= 0 ? '+' : ''}${gpShort(e.profit)}</span>`;
        const gpxp = e.gpPerXp == null ? '<span class="c-faint">?</span>' : `<span class="${e.gpPerXp <= 0 ? 'c-win' : ''}">${gpShort(e.gpPerXp)}</span>`;
        const title = `${m.name}: level ${m.level}, ${xpText(m.xp)} XP each` +
          `\nNeeds (from scratch): ${Object.entries(e.inputs).map(([k, n]) => `${n} ${ITEMS[k]?.name || k}`).join(', ')}` +
          (e.profit != null ? `\nCosts ${gpShort(e.cost)}, worth ${gpShort(e.value)}: ${e.profit >= 0 ? 'profit' : 'loss'} ${gpShort(Math.abs(e.profit))} each` : '');
        return `<tr class="${r.locked ? 'dim ' : ''}${chosen ? 'hl ' : ''}${excluded.has(m.id) ? 'off' : ''}" data-method="${m.id}" title="${esc(title)}">
          <td>${m.level}</td>
          <td class="l"><span class="sk-cell">${itemIcon(methodOut(m), true)} ${esc(m.name)}${multipleBadge(m, Math.max(cur?.level || 1, m.level))}</span></td>
          <td>${xpText(m.xp)}</td>
          <td>${r.needed ? fmt(r.needed) : '–'}</td>
          <td>${goal.useBank === false ? '–' : r.have ? `<span class="c-level">${fmt(r.have)}</span>` : '0'}</td>
          <td>${r.needed ? fmt(r.toMake) : '–'}</td>
          <td class="l">${r.needed ? itemList(r.collect, { small: true }) : ''}</td>
          <td>${profit}</td>
          <td>${gpxp}</td>
          <td class="c"><input type="checkbox" data-use="${m.id}" ${excluded.has(m.id) ? '' : 'checked'} title="Let the bank plan use this" aria-label="Use ${esc(m.name)} in the bank plan"></td>
        </tr>`;
      }).join('');
    }).join('');
    const sBtn = (k, label) => `<button type="button" class="${S.sort === k ? 'on' : ''}" data-tsort-plan="${k}">${label}</button>`;
    return `<div class="plan-sec"><h4>Every option <span class="c-faint">(on its own, from ${cur ? `level ${cur.level}` : 'now'}; click one to train with it)</span></h4>
      <div class="bar wrap"><span class="c-muted small-note">Sort</span><div class="seg">${sBtn('level', 'Level')}${sBtn('xp', 'XP each')}${sBtn('cheap', 'Cheapest XP')}</div>
        <span class="c-faint small-note">${unitNote(goal.skill, ix)}</span></div>
      <div class="table-wrap"><table class="grid plan-t">
        <thead><tr><th>Lvl</th><th class="l">${textFor(goal.skill).what}</th><th>XP</th><th>To goal</th><th>From bank</th><th>Still</th><th class="l">Collect</th><th>Profit</th><th>gp/XP</th><th title="Let the bank plan use this">Use</th></tr></thead>
        <tbody>${body}</tbody></table></div></div>`;
  }

  // Skill tabs on the Bank and Prices views, for the skills the planner covers.
  function skillSwitch() {
    const keys = Object.keys(BANK_GROUPS);
    if (keys.length < 2) return '';
    return `<div class="skill-switch" role="group" aria-label="Skill">${keys.map(k => {
      const sk = SKILL_BY_KEY.get(k);
      const on = k === S.bankSkill;
      return `<button type="button" class="tab skill-tab${on ? ' active' : ''}" data-bskill="${k}" aria-pressed="${on}">${iconImg(sk)} ${esc(sk.name)}</button>`;
    }).join('')}</div>`;
  }

  // ── Bank view ───────────────────────────────────────────────────────────
  function renderBank() {
    renderAccount('bank-account', 'bank');
    const body = $('bank-body');
    if (!S.account) { $('bank-head').innerHTML = ''; body.innerHTML = ''; return; }
    renderBankHead();
    const groups = BANK_GROUPS[S.bankSkill] || [];
    body.innerHTML = groups.map(g => `<div class="card bank-group"><h4>${esc(g.name)}</h4><div class="bank-grid">${g.items.map(bankCell).join('')}</div></div>`).join('');
    const items = Object.keys(bank().items);
    if (items.length) prices.want(items);
  }

  function renderBankHead() {
    const b = bank();
    const value = bankValue(b.items, prices.priceOf);
    const kinds = Object.values(b.items).filter(n => n > 0).length;
    const hint = {
      herblore: 'Unid herbs are one entry: every "Herb" in your bank, whatever it turns out to be.',
      runecraft: 'Rune essence is the only essence in this version of the game; pure essence came later.',
    }[S.bankSkill] || '';
    $('bank-head').innerHTML = `${skillSwitch()}<div class="bank-sum">
      <span>${kinds ? `<b>${kinds}</b> kind${kinds === 1 ? '' : 's'} of item` : 'Nothing entered yet'}${b.updated ? ` · updated ${ago(b.updated)}` : ''}</span>
      ${kinds ? `<span>Worth about <b class="c-xp">${gpShort(value.total)}</b> gp${value.missing.length ? ` <span class="c-faint">(${value.missing.length} without a price)</span>` : ''}</span>` : ''}
      <span class="grow"></span>
      <button type="button" class="btn small" data-act="bank-prices">Get prices</button>
      <button type="button" class="btn small danger" data-act="bank-clear">Clear bank</button>
    </div>
    <p class="note">Type what you have: 1500, 1.5k or 2m all work. Only the items the planner uses are listed; more skills come in later updates.
      ${hint}</p>`;
  }

  function bankCell(slug) {
    const n = bank().items[slug] || 0;
    const p = prices.gp(slug);
    return `<label class="bank-cell${n ? ' has' : ''}" title="${esc(ITEMS[slug].name)}\n${esc(priceTip(slug))}">
      ${itemIcon(slug)}
      <span class="bn">${itemName(slug)}</span>
      <input class="input small num" data-bank="${slug}" inputmode="decimal" value="${n ? fmt(n) : ''}" placeholder="0" aria-label="${itemName(slug)} in bank">
      <span class="bv" data-bv="${slug}">${n && p != null ? gpShort(n * p) : ''}</span>
    </label>`;
  }

  // ── Prices view ─────────────────────────────────────────────────────────
  function renderPrices() {
    const st = prices.status();
    const head = $('prices-head');
    const running = st.busy || st.queued;
    head.innerHTML = `${skillSwitch()}<div class="card">
      <div class="bar wrap">
        <button type="button" class="btn small" data-act="prices-refresh"${running ? ' disabled' : ''}>Check prices now</button>
        ${running ? `<button type="button" class="btn small" data-act="prices-stop">Stop</button><span class="busy">Checking ${fmt(Math.min(st.done + 1, st.total))} of ${fmt(st.total)}…</span>` : ''}
        ${st.error && !running ? `<span class="c-lose small-note">${esc(st.error)}${ctx.fullMarket ? '' : ' Prices work best inside LostKit.'}</span>` : ''}
      </div>
      <p class="note">Prices come from player listings on <a href="https://markets.lostcity.rs" target="_blank" rel="noopener">markets.lostcity.rs</a>:
        the median of recent sales where there are any, otherwise of open offers. ${ctx.fullMarket ? '' : 'In a normal browser only open offers can be read; LostKit also sees the sales. '}
        Items are checked one at a time and kept for 12 hours. Type your own price to override any of them.</p>
    </div>`;
    const groups = BANK_GROUPS[S.bankSkill] || [];
    $('prices-body').innerHTML = groups.map(g => `<div class="table-wrap price-wrap"><table class="grid prices-t">
      <thead><tr><th class="l">${esc(g.name)}</th><th>Price</th><th class="l">From</th><th class="l">Checked</th><th>Your price</th></tr></thead>
      <tbody>${g.items.filter(s => ITEMS[s] && !ITEMS[s].untradeable).map(priceRow).join('')}</tbody></table></div>`).join('');
  }

  function priceRow(slug) {
    const i = prices.info(slug);
    const at = prices.fetchedAt(slug);
    const own = prices.overrides[slug];
    return `<tr>
      <td class="l"><span class="sk-cell">${itemIcon(slug, true)} ${itemName(slug)}</span></td>
      <td>${i ? `<b>${gpShort(i.gp)}</b>` : '<span class="c-faint">–</span>'}</td>
      <td class="l small-note">${i ? esc(sourceText(i)) : at ? 'not traded' : '<span class="c-faint">not checked</span>'}</td>
      <td class="l small-note c-faint">${at ? ago(at) : ''}</td>
      <td><input class="input small num" data-price="${slug}" inputmode="decimal" value="${own != null ? own : ''}" placeholder="market" aria-label="Your price for ${itemName(slug)}"></td>
    </tr>`;
  }

  // ── Rendering glue ──────────────────────────────────────────────────────
  // Views are rebuilt as prices and XP arrive, so whatever field you're typing
  // in is found again afterwards, with its text and caret where they were.
  function fieldKey(el) {
    for (const a of ['bank', 'price', 'gopt', 'use']) if (el.dataset?.[a]) return `[data-${a}="${el.dataset[a]}"]`;
    const form = el.closest('[data-form]');
    if (form && el.name) return `[data-form="${form.dataset.form}"] [name="${el.name}"]`;
    return null;
  }
  function render(tab) {
    S.tab = tab;
    const view = $('view-' + tab);
    const a = document.activeElement;
    const key = a && view?.contains(a) && a.matches('input, select, textarea') ? fieldKey(a) : null;
    const goal = key && a.closest('[data-goal]')?.dataset.goal;
    const keep = key && { value: a.value, start: a.selectionStart, end: a.selectionEnd };
    if (tab === 'goals') renderGoals();
    if (tab === 'bank') renderBank();
    if (tab === 'prices') renderPrices();
    if (!keep) return;
    const scope = goal ? view.querySelector(`[data-goal="${goal}"]`) : view;
    const el = scope?.querySelector(key);
    if (!el) return;
    if (el.type !== 'checkbox' && el.tagName !== 'SELECT') el.value = keep.value;
    el.focus({ preventScroll: true });
    try { if (keep.start != null) el.setSelectionRange(keep.start, keep.end); } catch (e) { /* not a text field */ }
  }
  let rerenderTimer = null;
  // A button pressed while the view is rebuilt would lose its click: wait for
  // the press to finish. Same for an open drop-down, which would snap shut.
  let pressing = false;
  document.addEventListener('pointerdown', () => { pressing = true; }, true);
  document.addEventListener('pointerup', () => setTimeout(() => { pressing = false; }, 0), true);
  document.addEventListener('pointercancel', () => { pressing = false; }, true);
  function rerender() {
    if (!S.tab || $('view-' + S.tab)?.hidden) return;
    clearTimeout(rerenderTimer);
    if (pressing) { rerenderTimer = setTimeout(rerender, 250); return; }
    if (document.activeElement?.tagName === 'SELECT') { rerenderTimer = setTimeout(rerender, 1000); return; }
    rerenderTimer = setTimeout(() => render(S.tab), 30);
  }

  function show(tab) {
    render(tab);
    if (S.account && (tab === 'goals' || tab === 'bank')) loadProfile();
    if (tab === 'prices') wantPrices([S.bankSkill]);
  }

  // Price updates arrive one item at a time; redraw about once a second.
  let priceTimer = null;
  prices.addEventListener('update', () => {
    if (priceTimer) return;
    priceTimer = setTimeout(() => { priceTimer = null; rerender(); }, 1000);
  });

  // ── Events ──────────────────────────────────────────────────────────────
  function wire() {
    for (const id of ['view-goals', 'view-bank', 'view-prices']) {
      const root = $(id);
      root.addEventListener('submit', onSubmit);
      root.addEventListener('click', onClick);
      root.addEventListener('change', onChange);
      root.addEventListener('input', onInput);
    }
  }

  function onSubmit(e) {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'account') { if (setAccount(form.account.value)) render(S.tab); }
    if (form.dataset.form === 'goal') addGoal(form.value.value);
  }

  function onClick(e) {
    const t = e.target;
    const nskill = t.closest('[data-nskill]');
    if (nskill) { S.newGoal.skill = nskill.dataset.nskill; saveUi(); showMsg('goals-msg', ''); renderNewGoal(); return; }
    const ntype = t.closest('[data-ntype]');
    if (ntype) { S.newGoal.type = ntype.dataset.ntype; saveUi(); showMsg('goals-msg', ''); renderNewGoal(); return; }
    const bskill = t.closest('[data-bskill]');
    if (bskill) {
      S.bankSkill = bskill.dataset.bskill; saveUi();
      render(S.tab);
      if (S.tab === 'prices') wantPrices([S.bankSkill]);
      return;
    }
    const gshow = t.closest('[data-gshow]');
    if (gshow) { S.show = gshow.dataset.gshow; saveUi(); renderGoals(); return; }
    const gonly = t.closest('[data-gonly]');
    if (gonly) { S.only = S.only === gonly.dataset.gonly ? null : gonly.dataset.gonly; saveUi(); renderGoals(); return; }
    const psort = t.closest('[data-tsort-plan]');
    if (psort) { S.sort = psort.dataset.tsortPlan; saveUi(); renderGoals(); return; }
    const card = t.closest('[data-goal]');
    const methodRow = t.closest('tr[data-method]');
    if (card && methodRow && !t.closest('input')) {
      updateGoal(card.dataset.goal, g => { g.fillId = methodRow.dataset.method; });
      renderGoals();
      return;
    }
    const act = t.closest('[data-act]');
    if (!act) return;
    switch (act.dataset.act) {
      case 'refresh-xp': S.goalErr = {}; loadProfile({ force: true }); break;
      case 'goal-up':
      case 'goal-down': {
        moveGoal(card.dataset.goal, act.dataset.act === 'goal-up' ? -1 : 1);
        renderGoals();
        // keep the button under the keyboard, so pressing again keeps moving it
        document.querySelector(`[data-goal="${card.dataset.goal}"] [data-act="${act.dataset.act}"]:not([disabled])`)?.focus({ preventScroll: true });
        document.querySelector(`[data-goal="${card.dataset.goal}"]`)?.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'open-all':
      case 'close-all':
        for (const id of S.visible) {
          if (act.dataset.act === 'open-all') S.open.add(id); else S.open.delete(id);
        }
        saveUi(); renderGoals();
        break;
      case 'show-all-goals': S.show = 'all'; S.only = null; saveUi(); renderGoals(); break;
      case 'toggle-plan': {
        const id = card.dataset.goal;
        if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
        saveUi(); renderGoals();
        break;
      }
      case 'remove-goal':
        if (!act.dataset.armed) { act.dataset.armed = '1'; act.textContent = 'Remove?'; act.classList.add('armed'); break; }
        saveGoals(goals().filter(g => g.id !== card.dataset.goal));
        S.open.delete(card.dataset.goal); saveUi();
        renderGoals();
        break;
      case 'to-bank':
        if (BANK_GROUPS[act.dataset.skill]) { S.bankSkill = act.dataset.skill; saveUi(); }
        ctx.goTab('bank');
        break;
      case 'bank-prices': prices.want(Object.keys(bank().items), { force: true }); renderBankHead(); break;
      case 'bank-clear':
        if (!act.dataset.armed) { act.dataset.armed = '1'; act.textContent = 'Click again to clear'; break; }
        saveBank({ items: {} });
        renderBank();
        break;
      case 'prices-refresh': prices.want(skillItems(S.bankSkill), { force: true }); renderPrices(); break;
      case 'prices-stop': prices.stop(); renderPrices(); break;
    }
  }

  function onChange(e) {
    const t = e.target;
    const card = t.closest('[data-goal]');
    if (card && t.dataset.gopt) {
      const id = card.dataset.goal;
      updateGoal(id, g => {
        if (t.dataset.gopt === 'useBank') g.useBank = t.checked;
        if (t.dataset.gopt === 'assume') g.assume = t.checked ? (DEFAULT_ASSUME[g.skill] || []) : [];
        if (t.dataset.gopt === 'fill') g.fillId = t.value;
      });
      renderGoals();
      return;
    }
    if (card && t.dataset.use) {
      updateGoal(card.dataset.goal, g => {
        const set = new Set(g.excluded || []);
        if (t.checked) set.delete(t.dataset.use); else set.add(t.dataset.use);
        g.excluded = [...set];
      });
      renderGoals();
      return;
    }
    if (t.dataset.bank) {
      const n = parseAmount(t.value);
      if (n == null) { t.classList.add('bad'); return; }
      t.classList.remove('bad');
      const b = bank();
      if (n > 0) b.items[t.dataset.bank] = n; else delete b.items[t.dataset.bank];
      saveBank(b);
      t.value = n ? fmt(n) : '';
      onInput(e);
      renderBankHead();
      if (n > 0) prices.want([t.dataset.bank]);
      return;
    }
    if (t.dataset.price) {
      const v = t.value.trim() === '' ? null : parseAmount(t.value);
      if (v === undefined || (t.value.trim() !== '' && v == null)) { t.classList.add('bad'); return; }
      t.classList.remove('bad');
      prices.setOverride(t.dataset.price, v);
      return;
    }
  }

  // Live value next to a bank amount while typing.
  function onInput(e) {
    const t = e.target;
    if (!t.dataset.bank) return;
    const n = parseAmount(t.value);
    const p = prices.gp(t.dataset.bank);
    const out = document.querySelector(`[data-bv="${t.dataset.bank}"]`);
    if (out) out.textContent = n && p != null ? gpShort(n * p) : '';
    t.closest('.bank-cell')?.classList.toggle('has', !!n);
  }

  // ── What the rest of the app asks for ───────────────────────────────────
  // A small goal line for a Lookup tile, when that player is the one planned for.
  function tileGoal(profile, skill) {
    if (!profile || !S.account || profile.safe !== safe()) return '';
    const g = goals().find(x => x.skill === skill.key);
    if (!g) return '';
    const st = profile.stats[skill.id];
    const cur = st ? st.xp10 ?? st.xp * 10 : null;
    let text;
    if (g.type === 'level' || g.type === 'xp') {
      const target = goalTargetXp10(g);
      const left = cur == null ? null : Math.max(0, target - cur);
      text = `${g.type === 'level' ? `Goal ${g.value}` : `Goal ${gpShort(g.value)} XP`}${left != null ? (left ? ` · ${gpShort(Math.ceil(left / 10))} XP to go` : ' ✓') : ''}`;
    } else {
      text = g.type === 'rank' ? `Goal rank ${fmt(g.value)}` : `Goal top ${formatPercent(g.value)}%`;
    }
    return `<div class="goal-line" title="Goal set in the Goals tab">${esc(text)}</div>`;
  }

  function summary() {
    const accounts = store.keys().filter(k => k.startsWith('goals.'));
    const count = accounts.reduce((a, k) => a + (store.get(k, []).length || 0), 0);
    const banks = store.keys().filter(k => k.startsWith('bank.')).length;
    return { goals: count, banks };
  }

  wire();
  return {
    render, show, rerender, tileGoal, summary,
    get account() { return S.account; },
    setAccount,
    reset() { S.account = null; S.profile = null; S.open.clear(); },
  };
}
