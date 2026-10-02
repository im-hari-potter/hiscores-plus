// Skills+ planner views: Goals, Bank and Prices.
//
// Goals and the bank belong to one account (the "planning for" name), stored
// per account so alts can have their own. The maths lives in planner.js; this
// file only turns it into LostKit-style panels.

import { SKILLS, SKILL_BY_KEY, SKILL_IDS, MIN_RANKED_LEVEL, MAX_LEVEL, boundUnrankedLevels } from './skills.js';
import { ITEMS, METHODS, BANK_GROUPS, SALE_GROUPS, PLACES, CHOICES, ICONS_PER_ROW, ICON_SIZE, ICON_SHEET, UNID_HERBS } from './gamedata.js';
import { indexMethods, planGoal, goalTargetXp10, rankForTop, xp10ForLevel, levelForXp10, bankValue, minorLast, castsIn, xpEach, chanceUnits, sureLevel, WHOLE, MAX_XP10 } from './planner.js';
import { store, players } from './store.js';
import { toSafeName, toDisplayName, checkName } from './api.js';
import { topPercent, formatPercent } from './totals.js';
import { sortable } from './sortable.js';
import { LIVE_MARKET, highAlch } from './prices.js';

// One method index per skill that has calculator data.
const INDEX = {};
for (const key of new Set(METHODS.map(m => m.skill))) INDEX[key] = indexMethods(METHODS.filter(m => m.skill === key));
export const hasCalculator = key => !!INDEX[key];
// Where a skill has a choice of place (which tanner), the index for the one
// picked: the first is the default, and what INDEX holds.
const placeOf = goal => {
  const options = PLACES[goal.skill]?.options || [];
  return options.find(o => o.id === goal.place) || options[0] || null;
};
// The choices a skill's goals have (Smithing: where your bars come from, a ring
// of forging, goldsmith gauntlets), and the ones a goal has in use, in the order
// they apply: the tick boxes, then what was picked from a list. A choice another
// one makes pointless is left out (a ring of forging, when you superheat).
export function choicesInUse(goal) {
  const all = CHOICES[goal.skill] || [];
  const set = goal.opts || {};
  const lists = all.filter(c => c.options).map(c => (c.options.slice(1).some(o => o.id === set[c.id]) ? set[c.id] : null)).filter(Boolean);
  const ticks = all.filter(c => !c.options && set[c.id] && !(c.unless && lists.includes(c.unless))).map(c => c.id);
  return [...ticks, ...lists];
}
const PLACED = {};
function indexFor(goal) {
  const place = placeOf(goal);
  const at = place && place !== PLACES[goal.skill].options[0] ? place.id : null;
  const opts = choicesInUse(goal);
  if (!at && !opts.length) return INDEX[goal.skill];
  return (PLACED[`${goal.skill}|${at || ''}|${opts.join('+')}`] ||= indexMethods(METHODS.filter(m => m.skill === goal.skill), { at, opts }));
}
// Skills whose plans start from the bank (Woodcutting only needs an axe).
const usesBank = key => !!BANK_GROUPS[key];

// Wording that depends on the skill.
const SKILL_TEXT = {
  herblore: { what: 'Potion', each: 'potion', bankHint: 'herbs, unfinished potions and secondaries' },
  runecraft: { what: 'Rune', each: 'essence', bankHint: 'rune essence' },
  woodcutting: { what: 'Logs', each: 'log', noBank: 'Woodcutting only needs an axe (in this version any axe works at any level), so this plan doesn\'t use your bank.' },
  firemaking: { what: 'Logs', each: 'log', bankHint: 'logs' },
  fletching: { what: 'Item', each: 'action', bankHint: 'logs, bow strings, feathers and arrowtips' },
  crafting: { what: 'Item', each: 'item', bankHint: 'leather, gems, bars, glass or whatever else you craft with' },
  // (made: what the Prices tab calls the things a skill with no bank makes, when it isn't `what`)
  mining: { what: 'Rock or bar', each: 'ore', made: 'Ores and gems', noBank: 'Mining only needs a pickaxe you have the level for (bronze and iron from level 1, steel 6, mithril 21, adamant 31, rune 41), so this plan doesn\'t use your bank.' },
  // (onTheWay and own: what a row's XP and counts take in besides its own, where a step before it is planned through)
  smithing: { what: 'Item', each: 'item', bankHint: 'ore, coal or bars', onTheWay: 'the bars you make on the way', own: 'your own bars' },
  // (takes: what the Prices tab calls what a skill with no bank uses up; net: what Net/item is, when it isn't just what one sells for)
  fishing: { what: 'Fish', each: 'fish', made: 'Fish', takes: 'Bait', net: 'what one fish sells for, less the bait or feather it takes',
    noBank: 'Fishing only needs the gear for the spot, and a bait or a feather for every catch with a rod. Those are listed to buy (what\'s in your bank isn\'t counted), so this plan doesn\'t use your bank.' },
  cooking: { what: 'Food', each: 'item', bankHint: 'raw fish, raw meat, or what a pie, a pizza or a cake is made of', onTheWay: 'the pizza or cake you bake on the way', own: 'baking it' },
};
const textFor = key => SKILL_TEXT[key] || { what: 'Make', each: 'action', bankHint: 'the items it uses' };

// Cheap supplies that shouldn't hold a plan back (still shown as needed).
const DEFAULT_ASSUME = { herblore: ['vial_water'], crafting: ['thread'] };
const ASSUME_LABEL = { herblore: 'vials of water', crafting: 'thread' };
// "Vials of water are", "thread is"
const ASSUME_ONE = { crafting: true };
// Runes the spells on the way take (enchanting jewellery, charging orbs, and
// Superheat Item when that's how you make your bars: a choice, so it's in opt).
const SPELL_RUNES = {};
for (const m of METHODS) {
  for (const v of [m, ...Object.values(m.opt || {})]) {
    if (!v.magic) continue;
    for (const k of Object.keys({ ...(v.in || m.in), ...(v.add || {}) })) if (/rune$/.test(k)) (SPELL_RUNES[m.skill] ||= new Set()).add(k);
  }
}
// What an item is finished with, rather than made of: the wool an amulet is
// strung with. And what's worn while you work: a ring of forging.
const FINISHING = { crafting: ['ball_of_wool'], smithing: ['ring_of_forging'] };
// Round up my supplies never lets these hold it back, and never rounds up to
// them: the supplies above (bought as you go or not), those runes and the
// finishing. Herbs with no vials left are still made into potions, emeralds
// with no runes into rings of dueling, dragonstones with no wool into amulets
// of glory; what's short of them is collected with the rest. And 60 spare balls
// of wool don't call for 60 more dragonstones.
export const minorOf = key => new Set([...(DEFAULT_ASSUME[key] || []), ...(SPELL_RUNES[key] || []), ...(FINISHING[key] || [])]);
// "Vials of water never hold it back", for the tooltip
const MINOR_TEXT = { herblore: 'Vials of water never hold', crafting: 'Thread, runes and balls of wool never hold', smithing: 'Rings of forging and runes never hold' };
// Read from a screenshot but not added to your bank: tools (a plan names them,
// it never counts them), and thread.
const TOOLS = new Set(METHODS.flatMap(m => m.tools || []));
const NOT_BANKED = new Set([...TOOLS, 'thread']);
// Two items with the very same icon: which one a screenshot's stack is read as
// until you say otherwise. Soda ash is banked for glass far more often than
// ashes are kept. (Up to v2.5.0 it was filed under Ashes without asking.)
// Every raw meat has one icon, and cooked meat looks like ugthanki meat and
// rabbit: beef and plain cooked meat are the ones banks hold.
const LIKELIER_TWIN = { ashes: 'soda_ash', raw_ugthanki_meat: 'raw_beef', cooked_ugthanki_meat: 'cooked_meat' };
// With no method picked and nothing in the bank to go on, plans finish with the
// classic way to train: bows, cut and strung, for Fletching.
// For Mining it's a rock: a bar's row is several ores at once, so its XP says
// nothing about how fast it is.
// For Cooking a fish: a curry is the most XP there is, and nobody trains on it.
const DEFAULT_FILL_GROUP = { fletching: 'Bows', mining: 'Rocks', cooking: 'Fish' };
// Every bank item in the order of the skill tabs and their groups.
const SKILL_ORDER = new Map([...new Set(Object.values(BANK_GROUPS).flatMap(gs => gs.flatMap(g => g.items)))].map((s, i) => [s, i]));
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
// What to collect is whole items: thread goes 0.2 at a time (a reel lasts five
// items), and 13.2 reels to collect is 14.
const whole = n => (Number.isInteger(n) ? n : Math.ceil(n - 1e-9));

// An amount one item takes, for a tooltip: 5, 0.2 (thread), or a share of
// something that lasts many (a ring of forging: 1/140 a bar, 1/28 a platebody).
export function amountText(n) {
  if (Number.isInteger(n) || Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-9) return String(n);
  const d = 1 / n;
  if (n < 1 && Math.abs(d - Math.round(d)) < 1e-6) return `1/${Math.round(d)}`;
  return String(Math.round(n * 1000) / 1000);
}

// XP in tenths, shown the way the game does (a decimal only when there is one).
export const xpText = x10 => (x10 % 10
  ? (x10 / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  : (x10 / 10).toLocaleString());

// A tiny key/value store in IndexedDB, for what localStorage can't hold (the
// file the screenshot picker last opened). Any failure just means "not saved".
const idb = (() => {
  let db = null;
  const open = () => db || (db = new Promise((resolve, reject) => {
    const req = indexedDB.open('skills-plus', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = (mode, fn) => open().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  }));
  return {
    get: key => run('readonly', st => st.get(key)).catch(() => null),
    set: (key, value) => run('readwrite', st => st.put(value, key)).catch(() => null),
  };
})();

export function createPlanner(ctx) {
  const { api, totals, prices, esc, fmt, ago, iconImg, showMsg, errorText } = ctx;
  const $ = id => document.getElementById(id);
  // Item icons come from the sheet the data names, stamp and all: where an icon
  // sits is in ITEMS, so the two must be from the same release. (A browser that
  // still held the last release's items.png showed every icon wrong after
  // v2.6.0.) The stylesheet's plain items.png is only what's there before this.
  const sheet = document.createElement('style');
  sheet.textContent = `.item { background-image: url('${ICON_SHEET}'); }`;
  document.head.appendChild(sheet);
  const ui = store.get('planUi', {});
  const S = {
    account: store.get('plan.account', null) || ctx.defaultAccount?.() || null,
    profile: null,
    loading: false,
    error: null,
    newGoal: { skill: SKILL_BY_KEY.has(ui.newSkill) ? ui.newSkill : 'herblore', type: ['level', 'xp', 'rank', 'top'].includes(ui.newType) ? ui.newType : 'level' },
    open: new Set(Array.isArray(ui.open) ? ui.open : []),
    sort: ['level', 'xp', 'cheap', 'net'].includes(ui.sort) ? ui.sort : 'level',
    show: ['all', 'active', 'done'].includes(ui.show) ? ui.show : 'all',     // goal filter: status
    only: SKILL_BY_KEY.has(ui.only) ? ui.only : null,                        // goal filter: one skill
    visible: [],                                                              // goal ids shown, in order
    bankView: ui.bankView === 'all' || BANK_GROUPS[ui.bankView] ? ui.bankView : 'all',   // Bank tab: everything, or one skill's items
    allSort: ui.allSort === 'value' ? 'value' : 'yours',                     // Bank tab, All: your order or most valuable first
    bankSkill: INDEX[ui.bankSkill] ? ui.bankSkill : 'herblore',         // Prices tab: which skill
    tgroup: ui.tgroup && typeof ui.tgroup === 'object' ? ui.tgroup : {},     // plan table: which group, per skill
    rankLoading: new Set(),
    goalErr: {},
    tab: null,
    more: new Set(),                          // goals showing what else their bank could make
    editing: null,                            // the goal being changed: { id, type, draft, problem }
  };
  // The All view's items can be dragged into your own order (not by their
  // amount box, which is for typing). Set up in wire().
  let bankDrag = null;
  // So can the lines under From your bank: the top one gets your bank first.
  let stepDrag = null;
  const saveUi = () => store.set('planUi', { newSkill: S.newGoal.skill, newType: S.newGoal.type, open: [...S.open], sort: S.sort, show: S.show, only: S.only, bankSkill: S.bankSkill, bankView: S.bankView, allSort: S.allSort, tgroup: S.tgroup });
  // The items of one skill's bank tab, or of the whole bank ('all'), that you have.
  function bankSubset(items, view) {
    const list = view === 'all' ? Object.keys(items) : [...new Set((BANK_GROUPS[view] || []).flatMap(g => g.items))];
    const out = {};
    for (const slug of list) if (items[slug] > 0 && ITEMS[slug]) out[slug] = items[slug];
    return out;
  }

  // The All view's order: yours (items dragged around), else the order they
  // have in your bank in-game (slots, from screenshots), else the skill tabs'
  // order. Items an order doesn't know yet go after the ones it does.
  function allOrder(b, slugs) {
    const slot = b.slots || {};
    const at = s => slot[s] ?? Infinity;
    const tab = s => SKILL_ORDER.get(s) ?? Infinity;
    const base = [...slugs].sort((x, y) => (at(x) - at(y)) || (tab(x) - tab(y)) || x.localeCompare(y));
    if (!Array.isArray(b.order)) return base;
    const have = new Set(slugs);
    const mine = b.order.filter(s => have.has(s));
    const placed = new Set(mine);
    return [...mine, ...base.filter(s => !placed.has(s))];
  }

  // ── Storage per account ─────────────────────────────────────────────────
  const safe = () => (S.account ? toSafeName(S.account) : '');
  const goals = () => (safe() ? store.get('goals.' + safe(), []) : []);
  const saveGoals = list => { store.set('goals.' + safe(), list); ctx.onChange?.(); };
  function bank() {
    if (!safe()) return { items: {}, updated: 0 };
    const b = store.get('bank.' + safe(), { items: {}, updated: 0 });
    const merged = mergeUnids(b.items || {});
    // (tools that a screenshot read into it up to v2.5.1: a plan never counts them)
    const tools = Object.keys(merged.items).filter(k => TOOLS.has(k));
    for (const k of tools) { delete merged.items[k]; if (b.slots) delete b.slots[k]; }
    if (merged.changed || tools.length) { b.items = merged.items; store.set('bank.' + safe(), b); }
    return b;
  }
  const saveBank = b => { b.updated = Date.now(); store.set('bank.' + safe(), b); };
  // Moving items around isn't a change to what you have: 'updated' stays.
  const saveLayout = b => store.set('bank.' + safe(), b);
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
    const ix = INDEX[goal.skill] && indexFor(goal);
    if (!cur || !target || target.pending || !ix) return { cur, target, ix };
    const plan = planGoal(ix, {
      bank: bank().items,
      currentXp10: cur.xp10,
      targetXp10: target.reached ? cur.xp10 : target.xp10,
      excluded: new Set(goal.excluded || []),
      unlimited: new Set(goal.assume ?? DEFAULT_ASSUME[goal.skill] ?? []),
      useBank: goal.useBank !== false && usesBank(goal.skill),
      fillId: goal.fillId,
      fillGroup: DEFAULT_FILL_GROUP[goal.skill] || null,
      priceOf: prices.priceOf,
      mix: goal.mix || null,
      roundUp: !!goal.roundUp && goal.useBank !== false && usesBank(goal.skill) && hasEven(ix),
      minor: minorOf(goal.skill),
      order: Array.isArray(goal.order) && goal.order.length ? goal.order : null,
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
  // What the Prices tab lists for a skill: its bank groups and what the market
  // sells as one item (a set of dragonhide armour), or for a skill with no bank
  // (Woodcutting) what it makes.
  function priceGroups(key) {
    if (BANK_GROUPS[key]) return [...BANK_GROUPS[key], ...(SALE_GROUPS[key] || [])];
    const made = [...new Set(METHODS.filter(m => m.skill === key).flatMap(m => Object.keys(m.out)))];
    // (and what it uses up: Fishing's bait and feathers)
    const used = [...new Set(METHODS.filter(m => m.skill === key).flatMap(m => Object.keys(m.in)))].filter(k => !made.includes(k));
    return [{ name: textFor(key).made || textFor(key).what, items: made }, ...(used.length ? [{ name: textFor(key).takes || 'Supplies', items: used }] : [])];
  }
  function wantPrices(keys, opts) {
    const items = new Set();
    for (const k of keys) for (const i of skillItems(k)) items.add(i);
    prices.want([...items], opts);
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
  // An item's page on the market. LostKit opens it right in this tab (its ◀
  // button comes back here); a browser opens a new tab.
  const marketLink = slug => `href="${esc(`${LIVE_MARKET}/items/${encodeURIComponent(slug)}`)}"${ctx.inLostKit ? '' : ' target="_blank" rel="noopener"'}`;
  // The item that stands for a method: what it makes (a gem rock says which of
  // its gems), or for burning logs, the logs.
  const methodItem = m => m.icon || Object.keys(m.out)[0] || Object.keys(m.in)[0];
  const plural = (name, n) => (n === 1 || /s$/i.test(name) ? name : name + 's');
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
    if (i.src === 'alch') return i.untraded ? 'no trades: high alch' : 'high alch';
    return '';
  }
  // "3,948 Ranarr weed" chips; with prices when known.
  function itemList(items, { priced = true, small = false, named = !small } = {}) {
    const entries = Object.entries(items).filter(([, n]) => n > 1e-9).map(([slug, n]) => [slug, whole(n)]);
    if (!entries.length) return '<span class="c-faint">nothing</span>';
    return entries.map(([slug, n]) => {
      if (ITEMS[slug]?.gp != null) return `<span class="it-chip" title="${esc(ITEMS[slug].name)}: a fee paid on the way">${itemIcon(slug, small)}<b>${fmt(n)}</b>${named ? ' ' + itemName(slug) : ''}</span>`;
      const p = priced ? prices.gp(slug) : null;
      return `<a class="it-chip mk" ${marketLink(slug)} title="${esc(ITEMS[slug]?.name || slug)}${priced ? '\n' + esc(priceTip(slug)) : ''}\nClick to open it on the market">${itemIcon(slug, small)}<b>${fmt(n)}</b>${named ? ' ' + itemName(slug) : ''}${p != null && named ? ` <span class="c-faint">(${gpShort(p * n)})</span>` : ''}</a>`;
    }).join('');
  }
  const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 100);
  // "700 × Prayer potion", or for a method counted in what it uses:
  // "5,000 essence → 25,000 Air runes", "100 logs → 1,500 Bronze arrows"
  // or for one counted in what its output is for: "Ore for 400 steel bars: 400 Iron ore + 800 Coal"
  function actionText(m, runs, made) {
    if (m.lead) {
      const out = Object.entries(made || {}).filter(([, n]) => n > 0).map(([item, n]) => `<b>${fmt(n)}</b> ${itemName(item)}`).join(' + ');
      return `${esc(m.lead)} <b>${fmt(runs)}</b> ${esc(m.as[runs === 1 ? 0 : 1])}${out ? `: ${out}` : ''}`;
    }
    if (!m.unit) return `<b>${fmt(runs)}</b> × ${esc(m.name)}`;
    const [item, n] = Object.entries(made || {})[0] || [methodItem(m), runs];
    const unit = runs === 1 ? m.unit : m.units || m.unit + 's';
    return `<b>${fmt(runs)}</b> ${esc(unit)} → <b>${fmt(n)}</b> ${esc(plural(ITEMS[item]?.name || m.name, n))}`;
  }
  // "cut 75 + string 75", for a whole job made of steps
  const partsText = m => (m.parts ? m.parts.map(([what, x]) => `${what} ${xpText(x)}`).join(' + ') : '');
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

  const arm = btn => { btn.dataset.armed = '1'; btn.textContent = 'Remove?'; btn.classList.add('armed'); };
  function renderGoals() {
    if (stepDrag?.hold()) return;          // don't pull a plan's lines out from under a drag
    renderAccount('plan-account', 'goals');
    renderNewGoal();
    const list = goals();
    const box = $('goals-list');
    if (!S.account) { box.innerHTML = ''; return; }
    if (!list.length) {
      const names = Object.keys(INDEX).map(k => SKILL_BY_KEY.get(k).name);
      const which = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      box.innerHTML = `<div class="empty">No goals yet. Pick a skill above and set a level, XP, rank or top % to reach.<br>
        ${esc(which)} ${names.length > 1 ? 'have' : 'has'} the full planner (marked with a dot); more skills follow.</div>`;
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
    // (a "Remove?" waiting for its second click stays that way through a redraw)
    const armed = box.querySelector('[data-act="remove-goal"][data-armed]')?.closest('[data-goal]')?.dataset.goal;
    box.innerHTML = bar + (shown.length
      ? shown.map((g, i) => goalCard(g, i === 0, i === shown.length - 1)).join('')
      : `<div class="empty">No goals match. <button type="button" class="linkish" data-act="show-all-goals">Show all goals</button></div>`);
    const again = armed && [...box.querySelectorAll('[data-goal]')].find(c => c.dataset.goal === armed)?.querySelector('[data-act="remove-goal"]');
    if (again) arm(again);
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
    const placeholder = TARGET_HINT[g.type];
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

  // A goal's target as typed, checked: { value }, or { problem } (HTML) when it
  // isn't a number, is out of range or is somewhere you already are.
  function readTarget(skillKey, type, text) {
    const v = type === 'top' ? parseFloat(String(text).replace(',', '.')) : parseAmount(text);
    const bad = problem => ({ problem });
    if (v == null || !Number.isFinite(v) || v <= 0) return bad('Enter a number for the goal.');
    if (type === 'level' && (v < 2 || v > MAX_LEVEL)) return bad('Levels go from 2 to 99.');
    if (type === 'xp' && v > MAX_XP10 / 10) return bad('XP stops at 200,000,000.');
    if (type === 'top' && v > 100) return bad('Top % is at most 100.');
    const cur = currentOf(skillKey);
    const name = SKILL_BY_KEY.get(skillKey).name;
    if (cur && type === 'level' && cur.ranked && v <= cur.level) return bad(`${esc(S.account)} is already level ${cur.level} in ${esc(name)}.`);
    if (cur && type === 'xp' && cur.ranked && v * 10 <= cur.xp10) return bad(`${esc(S.account)} already has ${xpText(cur.xp10)} ${esc(name)} XP.`);
    if (cur && type === 'rank' && cur.rank && cur.rank <= v) return bad(`${esc(S.account)} is already rank ${fmt(cur.rank)} in ${esc(name)}.`);
    if (cur && type === 'top' && cur.rank) {
      const t = totals.get(SKILL_BY_KEY.get(skillKey).id);
      const top = t ? topPercent(cur.rank, t.total) : null;
      if (top != null && top <= v) return bad(`${esc(S.account)} is already in the top ${formatPercent(top)}% in ${esc(name)}.`);
    }
    return { value: type === 'top' ? Math.round(v * 100) / 100 : Math.floor(v) };
  }

  function addGoal(value) {
    const g = S.newGoal;
    const read = readTarget(g.skill, g.type, value);
    if (read.problem) { showMsg('goals-msg', read.problem, 'error'); return false; }
    const cur = currentOf(g.skill);
    const goal = {
      id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      skill: g.skill, type: g.type, value: read.value,
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

  // Moving the goalpost: a goal's type and target changed in place. Everything
  // else about it stays: its plan, what's ticked, your order, and where its
  // progress bar started.
  function saveGoalEdit(id, text) {
    const goal = goals().find(g => g.id === id);
    const e = S.editing;
    if (!goal || !e || e.id !== id) return;
    const read = readTarget(goal.skill, e.type, text);
    if (read.problem) { e.problem = read.problem; e.draft = text; renderGoals(); return; }
    updateGoal(id, g => {
      if (g.type !== e.type || g.value !== read.value) delete g.target;      // (whoever held the rank it was after)
      g.type = e.type; g.value = read.value;
    });
    delete S.goalErr[id];
    S.editing = null;
    renderGoals();
  }
  const TARGET_HINT = { level: 'Level (2–99)', xp: 'XP', rank: 'Rank', top: 'Top % (e.g. 10)' };
  function goalEditHtml(goal, cur, skill) {
    const e = S.editing;
    const tBtn = (t, label) => `<button type="button" class="${e.type === t ? 'on' : ''}" data-etype="${t}" aria-pressed="${e.type === t}">${label}</button>`;
    const value = e.draft ?? (e.type === goal.type ? goal.value : suggestValue(e.type, cur, skill) ?? '');
    return `<form class="bar wrap goal-edit" data-form="edit-goal" autocomplete="off">
      <span class="c-muted small-note">Change this goal to</span>
      <div class="seg" role="group" aria-label="Goal type">${tBtn('level', 'Level')}${tBtn('xp', 'XP')}${tBtn('rank', 'Rank')}${tBtn('top', 'Top %')}</div>
      <input class="input small num" name="value" inputmode="decimal" placeholder="${TARGET_HINT[e.type]}" value="${esc(String(value))}" aria-label="${TARGET_HINT[e.type]}">
      <button class="btn small" type="submit">Save</button>
      <button type="button" class="linkish" data-act="edit-cancel">Cancel</button>
      ${e.problem ? `<span class="c-lose small-note">${e.problem}</span>` : '<span class="c-faint small-note">Its plan, ticks and progress stay as they are.</span>'}
    </form>`;
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
    const editing = S.editing?.id === goal.id;
    return `<div class="card goal" data-goal="${goal.id}">
      <div class="goal-head">${iconImg(skill)} <span class="goal-name">${esc(skill.name)}</span>
        <span class="goal-title">${goalTitle(goal, cur, target)}</span>
        <button type="button" class="linkish small-note" data-act="edit-goal" aria-expanded="${editing}" title="Change this goal's target: move the goalpost">Edit</button>
        <span class="grow"></span>
        ${toggle}
        <span class="mv-group">
          <button type="button" class="mv" data-act="goal-up" title="Move up" aria-label="Move ${esc(skill.name)} goal up"${first ? ' disabled' : ''}>▲</button>
          <button type="button" class="mv" data-act="goal-down" title="Move down" aria-label="Move ${esc(skill.name)} goal down"${last ? ' disabled' : ''}>▼</button>
        </span>
        <button type="button" class="x" data-act="remove-goal" title="Remove this goal" aria-label="Remove goal">✕</button>
      </div>
      ${editing ? goalEditHtml(goal, cur, skill) : ''}
      <div class="goal-sub">${sub}</div>
      ${bar}${err}
      ${ix && open && plan ? planHtml(goal, plan, ix, cur) : ''}
    </div>`;
  }

  // ── The plan for one goal ───────────────────────────────────────────────
  function planHtml(goal, plan, ix, cur) {
    if (!usesBank(goal.skill)) {
      return `<div class="plan"><div class="plan-opts"><span class="c-faint">${esc(textFor(goal.skill).noBank || '')}</span></div>
        ${mixHtml(goal, plan, ix)}${thenHtml(goal, plan, ix)}${tableHtml(goal, plan, ix, cur)}</div>`;
    }
    const b = bank();
    const useBank = goal.useBank !== false;
    const assume = new Set(goal.assume ?? DEFAULT_ASSUME[goal.skill] ?? []);
    const bankCount = Object.values(b.items).filter(n => n > 0).length;
    const opts = `<div class="plan-opts">
      <label class="check"><input type="checkbox" data-gopt="useBank" ${useBank ? 'checked' : ''}> Use my bank</label>
      ${useBank && hasEven(ix) ? `<label class="check" title="${esc(roundUpTip(goal.skill))}"><input type="checkbox" data-gopt="roundUp" ${goal.roundUp ? 'checked' : ''}> Round up my supplies</label>` : ''}
      ${ASSUME_LABEL[goal.skill] ? `<label class="check" title="${ASSUME_ONE[goal.skill] ? "When on, it never holds a plan back, and it's left out of what to collect and of costs." : "When on, these never hold a plan back, and they're left out of what to collect and of costs."}"><input type="checkbox" data-gopt="assume" ${assume.size ? 'checked' : ''}> I'll buy ${ASSUME_LABEL[goal.skill]} as I go</label>` : ''}
      ${placeHtml(goal)}${choicesHtml(goal)}
      <span class="c-faint">${bankCount ? `${bankCount} kind${bankCount === 1 ? '' : 's'} of item in your bank, updated ${ago(b.updated)}` : 'Your bank is empty'} ·</span>
      <button type="button" class="linkish" data-act="to-bank" data-skill="${goal.skill}">Edit bank</button>
    </div>`;
    return `<div class="plan">${opts}${useBank ? bankHtml(goal, plan, ix) : mixHtml(goal, plan, ix)}${thenHtml(goal, plan, ix)}${tableHtml(goal, plan, ix, cur)}</div>`;
  }

  // Unid herbs can't be planned with (which herb they are is only known once
  // identified), so they get a note instead.
  function unidNote(goal) {
    const n = goal.skill === 'herblore' ? bank().items[UNID_HERBS.item] || 0 : 0;
    if (!n) return '';
    return `<div class="tip">${itemIcon(UNID_HERBS.item, true)} You also have <b>${fmt(n)}</b> unid herb${n === 1 ? '' : 's'}. Identify them first
      (${xpText(UNID_HERBS.xpMin)}–${xpText(UNID_HERBS.xpMax)} XP each, depending on the herb), then add the herbs to your bank.</div>`;
  }

  // " · 2.99M gp (4,271 each)": what a step makes is worth, item by item.
  function worthText(made) {
    const parts = Object.entries(made || {}).filter(([, n]) => n > 0).map(([item, n]) => {
      const p = prices.gp(item);
      const each = Object.keys(made).length > 1 ? ` ${itemName(item)}` : '';
      return p == null ? `<span class="c-faint">? gp${each}</span>`
        : `<b>${gpShort(p * n)}</b> gp${each} <span class="c-faint">(${gpShort(p)} each)</span>`;
    });
    return parts.length ? ` <span class="c-faint">·</span> <span class="step-gp" title="What these sell for">${parts.join(' + ')}</span>` : '';
  }

  // Which tanner: its fees are counted wherever hides are tanned on the way.
  function placeHtml(goal) {
    const choice = PLACES[goal.skill];
    if (!choice) return '';
    const mine = placeOf(goal);
    const tip = `Whose fee is counted where hides are tanned on the way. ${choice.options.map(o => `${o.name}: ${o.note}.`).join(' ')}`;
    return `<label class="check" title="${esc(tip)}">${esc(choice.label)} <select class="input small" data-gopt="place" aria-label="${esc(choice.label)}">${choice.options.map(o =>
      `<option value="${o.id}"${o === mine ? ' selected' : ''}>${esc(o.name)} (${esc(o.short)})</option>`).join('')}</select></label>`;
  }

  // The choices a skill's goals have: a list to pick from, or a tick box.
  function choicesHtml(goal) {
    const set = goal.opts || {};
    const inUse = choicesInUse(goal);
    return (CHOICES[goal.skill] || []).map(c => {
      if (c.options) {
        const mine = c.options.find(o => o.id === set[c.id]) || c.options[0];
        return `<label class="check" title="${esc(c.tip)}">${esc(c.label)} <select class="input small" data-gopt="opt" data-opt="${c.id}" aria-label="${esc(c.label)}">${c.options.map(o =>
          `<option value="${o.id}"${o === mine ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`;
      }
      if (c.unless && inUse.includes(c.unless)) return '';
      return `<label class="check" title="${esc(c.tip)}"><input type="checkbox" data-gopt="opt" data-opt="${c.id}" ${set[c.id] ? 'checked' : ''}> ${esc(c.label)}</label>`;
    }).join('');
  }

  // "Round up my supplies": the plan with what your bank leaves over used up too.
  const ROUND_UP_TIP = "Off, the plan uses your bank as it is. On, your supplies are rounded up: what your bank would leave over is used up too, " +
    "with whatever is missing for that collected. First for what your bank already makes, then for anything else that's one ingredient short " +
    '(best XP first; untick a row to leave it out). If you picked what to train with, that one is rounded up first. ' +
    'You see the XP your bank holds then, and what to collect for it.';
  // "Vials of water never hold it back: ..."
  const roundUpTip = key => (MINOR_TEXT[key] ? `${ROUND_UP_TIP} ${MINOR_TEXT[key]} it back: what you're short of is collected too.` : ROUND_UP_TIP);

  // The Magic XP of the spells cast on the way (enchanting, charging orbs), as a
  // tip under a plan. counts: [[method id, how many]]. A spell above your Magic
  // level says so: that part of the plan waits for it.
  function magicTip(ix, counts) {
    const mg = castsIn(ix, counts);
    if (!mg) return '';
    // Your Magic level. Off the hiscores (under level 15) only the most it can be is known.
    const cur = currentOf('magic');
    const most = !cur ? null : cur.ranked ? cur.level : cur.range ? cur.range.max : null;
    const youAre = cur && !cur.ranked && cur.range && cur.range.min < cur.range.max ? `you're ${most} at most` : `you're ${most}`;
    // (one line a spell: Lvl-1 Enchant makes rings of recoil and games necklaces alike)
    const spells = new Map();
    for (const [id, n] of Object.entries(mg.by)) { const m = ix.byId.get(id); spells.set(m.spell, { n: (spells.get(m.spell)?.n || 0) + n, level: m.magicLevel }); }
    const casts = [...spells].map(([spell, c]) => `${fmt(c.n)} × ${esc(spell)} ${most != null && most < c.level
      ? `<span class="c-lose">(needs Magic ${c.level}: ${youAre})</span>`
      : `<span class="c-faint">(Magic ${c.level})</span>`}`);
    // What it does to your Magic level, when you can cast all of it.
    const after = cur?.ranked && cur.level >= mg.level ? levelForXp10(Math.min(MAX_XP10, cur.xp10 + mg.xp10)) : 0;
    const title = `Not part of the XP above: it's what the spells cast on the way give.${after > (cur?.level || 0) ? ` On its own it takes your Magic from ${cur.level} to ${after}.` : ''}`;
    // (one span: a tip lays its children out in a row, which would set the commas apart)
    return `<div class="tip magic" title="${title}"><span>Magic XP on the way: <b class="c-xp">+${xpText(mg.xp10)} XP</b> from ${casts.join(', ')}</span></div>`;
  }

  // With your supplies rounded up, each thing is one line: what your bank makes
  // of it together with what rounding up adds.
  function roundedSteps(fb, minor) {
    const lines = [], first = new Map();
    for (const s of fb.steps) {
      const to = s.rounded ? first.get(s.id) : undefined;
      if (to === undefined) {
        if (!first.has(s.id)) first.set(s.id, lines.length);
        lines.push({ ...s, sub: { ...s.sub }, made: { ...s.made }, collect: { ...(s.collect || {}) } });
        continue;
      }
      const t = lines[to];
      t.runs += s.runs; t.xp10 += s.xp10;
      for (const [k, n] of Object.entries(s.sub)) t.sub[k] = (t.sub[k] || 0) + n;
      for (const [k, n] of Object.entries(s.made || {})) t.made[k] = (t.made[k] || 0) + n;
      for (const [k, n] of Object.entries(s.collect || {})) t.collect[k] = (t.collect[k] || 0) + n;
    }
    for (const l of lines) l.collect = minorLast(l.collect, minor);
    return lines;
  }

  // "500 × Runite bar +25,000 XP": what was made on the way to a step.
  // What can burn says how many tries it took: "2,000 Raw shark cooked, about 272 burnt".
  // step: the step they were made for ({ id, runs }).
  const subsOf = (ix, sub, step) => Object.entries(sub || {}).map(([id, n]) => {
    const sm = ix.byId.get(id);
    if (sm.roll) {
      const burnt = n - (sm.of === step?.id ? step.runs : sub[sm.of] || 0);
      return burnt > 0 ? `${fmt(n)} ${itemName(Object.keys(sm.in)[0])} cooked, <span class="c-lose">about ${fmt(burnt)} burnt</span>` : '';
    }
    return `${fmt(n)} × ${esc(sm.name)}${sm.xp > 0 ? ` <span class="c-level">+${xpText(n * sm.xp)} XP</span>` : ''}`;
  }).filter(Boolean);
  // How often a row's cook fails at a level, with the goal's choices: null when
  // it can't. { burn (a share, 0 to 1), from (the level it stops at, or null) }
  const burnOf = (ix, m, level) => {
    const roll = m.tries && ix.byId.get(m.tries)?.roll;
    return roll ? { burn: 1 - chanceUnits(roll, Math.max(level, m.level)) / WHOLE, from: sureLevel(roll, m.level) } : null;
  };
  const pctText = share => (share <= 0 ? '0' : share < 0.01 ? 'under 1' : String(Math.round(share * 100)));
  // "14% burn", beside a row's name, while it still burns at your level
  function burnBadge(ix, m, level) {
    const b = burnOf(ix, m, level);
    if (!b || b.burn <= 0) return '';
    const at = Math.max(level, m.level);
    return ` <span class="burn" title="${esc(`About ${pctText(b.burn)} in 100 burn at level ${at}${b.from ? `; none from level ${b.from}` : '; some always will'}. Plans count them.`)}">${pctText(b.burn)}% burn</span>`;
  }
  function bankHtml(goal, plan, ix) {
    const fb = plan.fromBank;
    const rounded = !!plan.bankNow;             // Round up my supplies is on
    if (!fb.steps.length) {
      return `<div class="plan-sec"><h4>From your bank${rounded ? ', supplies rounded up' : ''}</h4><div class="c-faint small-note">Nothing in your bank makes ${esc(SKILL_BY_KEY.get(goal.skill).name)} XP at your level yet.
        Add ${textFor(goal.skill).bankHint} in the <button type="button" class="linkish" data-act="to-bank" data-skill="${goal.skill}">Bank</button> tab.</div>${unidNote(goal)}</div>`;
    }
    const steps = rounded ? roundedSteps(fb, minorOf(goal.skill)) : fb.steps;
    // Where the goal is reached. Rounded up, the lines are counted in the order shown.
    let goalAt = rounded ? null : fb.goalReached;
    if (rounded && fb.goalReached) {
      let left = plan.toGo;
      steps.some((s, i) => {
        if (s.xp10 >= left) { goalAt = { index: i, runs: Math.max(1, Math.ceil(left / (s.xp10 / s.runs))) }; return true; }
        left -= s.xp10;
        return false;
      });
    }
    // The lines can be dragged into an order of your own (with two or more things to order).
    const lineIds = [...new Set(steps.map(s => s.id))];
    const movable = lineIds.length > 1;
    const rows = steps.map((s, i) => {
      const m = ix.byId.get(s.id);
      const subs = subsOf(ix, s.sub, s);
      const goalHere = goalAt && goalAt.index === i
        ? `<span class="goal-flag" title="Your goal is reached during this step">Goal after ${fmt(goalAt.runs)}</span>` : '';
      const collect = s.collect && Object.keys(s.collect).length
        ? `<div class="c-faint small-note round-note">collect ${itemList(s.collect, { small: true, named: true, priced: false })}</div>` : '';
      return `<div class="step" data-step="${s.id}">${movable ? '<span class="grip" aria-hidden="true"></span>' : ''}${itemIcon(methodItem(m))}<div class="step-main">
          <div>${actionText(m, s.runs, s.made)} <span class="c-level">+${xpText(s.xp10)} XP</span>${worthText(s.made)} ${goalHere}</div>
          ${subs.length ? `<div class="c-faint small-note">incl. ${subs.join(', ')}</div>` : ''}
          ${collect}
        </div></div>`;
    }).join('');
    const toCollect = rounded && Object.keys(fb.collect || {}).length ? fb.collect : null;
    const roundCost = toCollect ? bankValue(toCollect, prices.priceOf) : null;
    const fee = fb.paid ? bankValue(fb.paid, prices.priceOf) : null;            // the tanner's
    const one = Object.keys(fb.assumed).length === 1;
    const assumed = Object.keys(fb.assumed).length
      ? `<div class="tip">Also uses ${itemList(fb.assumed, { small: true, named: true, priced: false })} that ${one ? "isn't" : "aren't"} in your bank: you'll buy ${one ? 'it' : 'them'} as you go.</div>` : '';
    // What it all makes is worth (each step shows its own part). Your banked
    // supplies are yours already, so that's the gross; what was collected to
    // round up, and fees paid on the way, come off for the net.
    const made = {};
    for (const s of fb.steps) for (const [item, n] of Object.entries(s.made || {})) made[item] = (made[item] || 0) + n;
    const worth = bankValue(made, prices.priceOf);
    const known = !worth.missing.length && !(roundCost && roundCost.missing.length);
    const net = worth.total - (roundCost ? roundCost.total : 0) - (fee ? fee.total : 0);
    const place = placeOf(goal);
    const money = !Object.keys(made).length ? '' : `<div class="money">
      <span>Gross: <b class="c-win">${worth.missing.length ? '?' : `+${gpShort(worth.total)}`}</b> gp</span>
      ${toCollect ? `<span>Rounding up your supplies: <b>${roundCost.missing.length ? '?' : gpShort(roundCost.total)}</b> gp</span>` : ''}
      ${fee ? `<span title="${esc(place ? `${place.name}: ${place.note}` : '')}">${esc(PLACES[goal.skill]?.label || 'Fees')}${place ? ` (${esc(place.name)})` : ''}: <b>${gpShort(fee.total)}</b> gp</span>` : ''}
      ${!toCollect && !fee ? '' : known ? `<span>Net: <b class="${net >= 0 ? 'c-win' : 'c-lose'}">${signed(net)}</b> gp</span>` : ''}
      <span class="c-faint">${known ? '(your banked supplies are already yours)' : '(some prices are still unknown)'}</span>
    </div>`;
    const reach = fb.goalReached ? `<span class="c-win">That reaches your goal.</span>` : '';
    const magic = magicTip(ix, fb.steps.flatMap(s => [[s.id, s.runs], ...Object.entries(s.sub)]));
    const collectLine = !rounded ? '' : toCollect
      ? `<div class="collect"><span class="c-muted">To round up your supplies, collect:</span> ${itemList(toCollect)}</div>`
      : `<div class="c-faint small-note">Nothing to collect: your bank leaves nothing over.</div>`;
    return `<div class="plan-sec"><h4>From your bank${rounded ? ', supplies rounded up' : ''} <span class="c-level">+${xpText(fb.xp10)} XP</span> <span class="c-faint">→ level ${fb.endLevel}</span> ${reach}</h4>
      <div class="steps${movable ? ' movable' : ''}">${rows}</div>${orderHtml(goal, plan, ix, lineIds)}${collectLine}${money}${magic}${assumed}${unidNote(goal)}</div>`;
  }

  // Under the bank plan's lines: that they can be dragged, your own order once
  // you have one (and the way back), and what else your bank could make: things
  // the lines above leave nothing for. Clicking one puts it first.
  function orderHtml(goal, plan, ix, lineIds) {
    const fb = plan.fromBank;
    const own = Array.isArray(goal.order) && goal.order.some(id => lineIds.includes(id));
    const excluded = new Set(goal.excluded || []);
    const others = plan.table.filter(r => r.have > 0 && r.level <= fb.endLevel && !lineIds.includes(r.id) && !excluded.has(r.id));
    if (lineIds.length < 2 && !own && !others.length) return '';
    const open = S.more.has(goal.id) && others.length > 0;
    const note = own ? `In your own order: your bank goes to the top line first, then down the list. <button type="button" class="linkish" data-act="order-reset">Back to the usual order</button>`
      : lineIds.length > 1 ? 'Drag a line up or down to change what your bank is used for first.' : '';
    const more = others.length ? `<button type="button" class="linkish" data-act="order-more" aria-expanded="${open}" title="Things your bank could make with the supplies the lines above use">${others.length} more your bank could make instead ${open ? '▾' : '▸'}</button>` : '';
    const chips = !open ? '' : `<div class="order-more"><span class="c-faint small-note">Click one to put it first:</span>${others.map(r => {
      const m = ix.byId.get(r.id);
      return `<button type="button" class="chip" data-first="${m.id}" title="${esc(`Your bank could make ${count(m, r.have)} on its own. Click to use your bank for it first.`)}">${itemIcon(methodItem(m), true)} ${esc(m.name)} <span class="c-faint">${fmt(r.have)}</span></button>`;
    }).join('')}</div>`;
    return `<div class="c-faint small-note order-note">${[note, more].filter(Boolean).join(' <span class="c-faint">·</span> ')}</div>${chips}`;
  }

  // With your bank left out: a mix you plan yourself, typed into the table's
  // Plan to make column. Made lowest level first, everything bought.
  function mixHtml(goal, plan, ix) {
    const mx = plan.fromMix;
    if (!mx) {
      return `<div class="plan-sec"><h4>Your mix</h4><div class="c-faint small-note">Plan a mix of ways to train: type how many of each you'll make in the
        table's <b>Plan to make</b> column below. Their XP counts toward your goal, and the rest is planned after them.</div></div>`;
    }
    const gp = g => (g.missing.length ? '<span class="c-faint">?</span>' : `<b class="${g.total >= 0 ? 'c-win' : 'c-lose'}">${signed(g.total)}</b>`);
    const rows = mx.steps.map(st => {
      const m = ix.byId.get(st.id);
      const lock = st.locked ? ` <span class="c-lose small-note" title="Made in level order, you'd only be level ${st.levelAt} when you get to these">needs level ${m.level}</span>` : '';
      const subs = subsOf(ix, st.sub, st);
      return `<div class="step">${itemIcon(methodItem(m))}<div class="step-main">
          <div>${actionText(m, st.runs, st.made)} <span class="c-level">+${xpText(st.xp10)} XP</span> <span class="c-faint">·</span> net ${gp(st.gain)} gp${lock}</div>
          ${subs.length ? `<div class="c-faint small-note">incl. ${subs.join(', ')}</div>` : ''}
        </div></div>`;
    }).join('');
    const g = mx.gain;
    const buys = Object.values(mx.buy).some(n => n > 0);
    const money = `<div class="money">
      ${buys ? `<span>Buying it all: <b>${g.missing.length ? '?' : gpShort(g.cost)}</b> gp</span>` : ''}
      <span>What you make is worth: <b>${g.missing.length ? '?' : gpShort(g.value)}</b> gp</span>
      <span>Net: ${gp(g)} gp</span>
    </div>`;
    const reach = mx.reached ? `<span class="c-win">That reaches your goal.</span>` : '';
    return `<div class="plan-sec"><h4>Your mix <span class="c-level">+${xpText(mx.xp10)} XP</span> <span class="c-faint">→ level ${mx.endLevel}</span> ${reach}
        <button type="button" class="linkish small-note" data-act="mix-clear">Clear the mix</button></h4>
      <div class="steps">${rows}</div>
      ${buys ? `<div class="collect"><span class="c-muted">To collect or buy:</span> ${itemList(mx.buy)}</div>` : ''}
      ${money}${magicTip(ix, mx.steps.flatMap(st => Object.entries(st.casts || {})))}</div>`;
  }

  function thenHtml(goal, plan, ix) {
    if (plan.remaining <= 0 || !plan.fill) return '';
    const f = plan.fill;
    const bankShown = usesBank(goal.skill) && goal.useBank !== false;
    const choices = ix.train.filter(m => !(goal.excluded || []).includes(m.id));
    const sel = `<select class="input small" data-gopt="fill" aria-label="Train with">${groupsOf(choices).map(([name, list]) =>
      `<optgroup label="${esc(name)}">${list.map(m => `<option value="${m.id}"${m.id === f.id ? ' selected' : ''}>${esc(m.name)} (lvl ${m.level}, ${xpText(xpEach(ix, m))} XP${m.unit ? ` per ${esc(m.unit)}` : ''})</option>`).join('')}</optgroup>`).join('')}</select>`;
    // "First 1,234 × Willow logs to reach level 45", "Then …"
    const segs = f.segments.map((s, i) => {
      const m = ix.byId.get(s.id);
      const lead = f.segments.length > 1 ? (i === 0 ? 'First ' : 'Then ') : '';
      // (your own bars, made on the way: their XP is part of the stretch's)
      const subs = subsOf(ix, s.sub, s);
      return `<div class="step">${itemIcon(methodItem(m))}<div class="step-main"><div>${lead}${actionText(m, s.runs, s.made)} <span class="c-level">+${xpText(s.xp10)} XP</span>${s.bridge && s.toLevel ? ` <span class="c-faint">to reach level ${s.toLevel}</span>` : ''}</div>
        ${subs.length ? `<div class="c-faint small-note">incl. ${subs.join(', ')}</div>` : ''}</div></div>`;
    }).join('');
    // Money: buying what's missing, and what the made items are worth.
    const made = {};
    for (const s of f.segments) for (const [item, n] of Object.entries(s.made)) made[item] = (made[item] || 0) + n;
    const worth = bankValue(made, prices.priceOf);
    const buys = Object.values(f.buy).some(n => n > 0), makes = Object.values(made).some(n => n > 0);
    const known = !f.costMissing.length && !worth.missing.length;
    const money = `<div class="money">
      ${buys ? `<span>Buying it all: <b>${f.costMissing.length ? '?' : gpShort(f.cost)}</b> gp</span>` : ''}
      ${makes ? `<span>What you make is worth: <b>${worth.missing.length ? '?' : gpShort(worth.total)}</b> gp</span>` : ''}
      ${buys && makes ? (known ? `<span>Net: <b class="${worth.total - f.cost >= 0 ? 'c-win' : 'c-lose'}">${worth.total - f.cost >= 0 ? '+' : ''}${gpShort(worth.total - f.cost)}</b> gp</span>` : `<span class="c-faint">(some prices are still unknown)</span>`) : ''}
      ${plan.fromMix && known && !plan.fromMix.gain.missing.length ? `<span>With your mix: <b class="${worth.total - f.cost + plan.fromMix.gain.total >= 0 ? 'c-win' : 'c-lose'}">${signed(worth.total - f.cost + plan.fromMix.gain.total)}</b> gp</span>` : ''}
    </div>`;
    // Tools the chosen method needs (never used up)
    const tools = [...new Set(f.segments.flatMap(s => ix.byId.get(s.id).tools || []))];
    const toolLine = tools.length ? `<div class="collect"><span class="c-muted">Also bring:</span> ${tools.map(t => `<a class="it-chip mk" ${marketLink(t)} title="Open ${itemName(t)} on the market">${itemIcon(t, true)} ${itemName(t)}</a>`).join('')}</div>` : '';
    // What else the chosen method takes (a Magic level to enchant with)
    const notes = [...new Set(f.segments.map(s => ix.byId.get(s.id).note).filter(Boolean))];
    const noteLine = notes.map(n => `<div class="c-faint small-note">${esc(n)}</div>`).join('');
    const row = plan.table.find(r => r.id === f.id);
    const fm = ix.byId.get(f.id);
    // A method counted in what it uses says what comes out: "6,000 Iron arrows instead of 3,000"
    const each = fm.unit ? Object.values(fm.out)[0] : 1;
    // (only while the plan makes of it what it would on its own: in an order of your
    // own something above it may take the snape grass first, and the tip would promise too much)
    const balance = row?.balance && bankShown && !plan.bankNow && row.fromPlan >= row.have
      ? `<div class="tip">Tip: collect ${itemList(row.balance.collect, { small: true, named: true })} and your bank makes <b>${fmt(row.balance.runs * each)}</b> ${esc(fm.unit ? plural(ITEMS[methodItem(fm)]?.name || fm.name, 2) : fm.name)} instead of ${fmt(row.have * each)}.</div>` : '';
    return `<div class="plan-sec"><h4>${bankShown || plan.fromMix ? 'Then, to' : 'To'} reach your goal: <span class="c-xp">${xpText(plan.remaining)} XP</span></h4>
      <div class="bar wrap"><span class="c-muted">Train with</span> ${sel}</div>
      <div class="steps">${segs}</div>
      ${buys ? `<div class="collect"><span class="c-muted">To collect or buy:</span> ${itemList(f.buy)}</div>` : ''}
      ${toolLine}${noteLine}${money}${magicTip(ix, Object.entries(f.steps))}${balance}</div>`;
  }

  function unitNote(key, ix, mixed, { bankOn, even, assumed, mix, whatIf }) {
    const each = textFor(key).each;
    const units = [...new Set(ix.train.map(m => m.units || ''))];
    // (some rows counted in what they use: logs for arrows, bars for arrowtips; or in what they're for: the bar some ore makes)
    const [unit, many] = ix.train.filter(m => m.unit).map(m => [m.unit, m.units || m.unit + 's'])[0] || [];
    const counted = units.length === 1 && units[0] ? ` Counts are in ${units[0]}.` : mixed ? ` A row marked "per ${unit}" counts ${many}.` : '';
    if (!usesBank(key)) return `To goal = how many on their own · Plan to make = your mix of ways to train${mix ? ' · Still needed to goal = after your mix' : ''} · Net/item is ${textFor(key).net || `what one ${each} sells for`}.${mixed ? counted : ''}`;
    // (bars you make yourself: their XP is in the XP column and in every count)
    const own = (ix.through ? ` XP and counts include ${textFor(key).onTheWay || "what's made on the way"}.` : '')
      + (ix.byLevel ? ' Burnt food is counted: what a row takes allows for it at the level you are now. A plan counts it a level at a time, so it burns a little less than its row says.' : '');
    const left = (!assumed ? '' : ASSUME_ONE[key]
      ? ` ${assumed[0].toUpperCase() + assumed.slice(1)} is left out: you'll buy it as you go.`
      : ` ${assumed[0].toUpperCase() + assumed.slice(1)} are left out: you'll buy them as you go.`) + own;
    if (!bankOn) return `To goal = how many on their own, from your XP now · Plan to make = your mix of ways to train${mix ? ' · Still needed to goal = after your mix' : ''} · Net/item is per ${each}, bought from scratch.${counted}${left}`;
    // Round up my supplies is on
    if (whatIf) return `Round up my supplies is on: the plan above is your bank with its supplies rounded up · From bank, Round up my supplies and Net after rounding up my supplies = each on its own, from your bank as it is · Still needed to goal and Supplies needed = after everything your bank makes, supplies rounded up · Total net = net from bank, supplies rounded up (what your bank plan makes of it then, less what that takes to collect) + net after buying supplies · Net/item is per ${each}, bought from scratch.${counted}${left}`;
    return `From bank = what your bank makes of it now${even ? ' · Round up my supplies = what to collect so nothing in your bank is left over · Net after rounding up my supplies = what your bank makes of it then, less what that takes to collect' : ''} · Still needed to goal and Supplies needed = after everything your bank makes · Total net = gross from banked supplies (what your bank plan makes of it, before rounding up) + net after buying supplies · Net/item is per ${each}, bought from scratch.${counted}${left}`;
  }

  // A row's tooltip line about burning, with the goal's choices in use.
  function burnLine(ix, m, level) {
    const b = burnOf(ix, m, level);
    if (!b) return '';
    const at = Math.max(level, m.level);
    return b.burn > 0
      ? `\nAbout ${pctText(b.burn)} in 100 burn at level ${at}${b.from ? `; none from level ${b.from}` : '; some always will'}. What it needs allows for that.`
      : `\nNone burn at level ${at} (they stop at ${b.from}).`;
  }

  // "Round up my supplies": what to collect so every ingredient in your bank gets used. Your
  // most plentiful one decides how many you could make (605 kwuarm and 518
  // limpwurt: collect 87 limpwurt, and the bank covers 605 instead of 518).
  const EVEN_TIP = 'Round up my supplies: what to collect so nothing in your bank is left over. Your most plentiful ingredient decides how many you could make.';
  // Only where something takes two or more things (not essence or logs on their own).
  const hasEven = ix => ix.train.some(m => Object.keys(m.in).length > 1);
  function evenTd(m, r) {
    const b = r.balance;
    if (!b) return '<td class="l even sep-l"><span class="c-faint">–</span></td>';
    const names = Object.entries(b.collect).filter(([, n]) => n > 0).map(([k, n]) => `${fmt(whole(n))} ${ITEMS[k]?.name || k}`);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    const tip = `Collect ${list}, and your bank covers ${count(m, b.runs)} instead of ${fmt(r.have)}.`;
    return `<td class="l even sep-l" title="${esc(tip)}"><span class="even-in">${itemList(b.collect, { small: true })}</span> <span class="c-faint">→</span> <b class="c-level">${fmt(b.runs)}</b></td>`;
  }

  // A total in gp, or why there isn't one.
  function gainTd(g, tip, cls = '') {
    const td = cls ? `<td class="${cls}"` : '<td';
    if (!g) return `${td}><span class="c-faint">–</span></td>`;
    if (g.missing.length) return `${td} title="${esc(`No price yet for ${g.missing.map(k => ITEMS[k]?.name || k).join(', ')}`)}"><span class="c-faint">?</span></td>`;
    return `${td} title="${esc(tip(g))}"><span class="${g.total >= 0 ? 'c-win' : 'c-lose'}">${g.total >= 0 ? '+' : ''}${gpShort(g.total)}</span></td>`;
  }
  const count = (m, n) => (m.unit ? `${fmt(n)} ${n === 1 ? m.unit : m.units || m.unit + 's'}` : `${fmt(n)} × ${m.name}`);
  const signed = n => `${n >= 0 ? '+' : ''}${gpShort(n)}`;

  // Columns: what each one gives (XP, net per item, gp per XP), then either
  // how many to the goal (your bank left out), or, with your bank in use, what
  // it makes of each, what rounds its supplies up, and what's still needed and to collect
  // after all of it, with the totals those come to.
  function tableHtml(goal, plan, ix, cur) {
    const excluded = new Set(goal.excluded || []);
    const bankCols = usesBank(goal.skill);
    const bankOn = bankCols && goal.useBank !== false;
    const evenCol = bankOn && hasEven(ix);
    const whatIf = bankOn && !!plan.bankNow;          // Round up my supplies is on
    const assumed = goal.assume ?? DEFAULT_ASSUME[goal.skill] ?? [];
    let rows = plan.table.map(r => ({ r, m: ix.byId.get(r.id) }));
    // Sorting by total net needs the bank's columns; without them it's by level.
    const sort = S.sort === 'net' && !bankOn ? 'level' : S.sort;
    const net = r => (r.gains.net && !r.gains.net.missing.length ? r.gains.net.total : -Infinity);
    if (sort === 'xp') rows.sort((a, b) => (b.r.xpAll ?? b.m.xp) - (a.r.xpAll ?? a.m.xp));
    else if (sort === 'cheap') rows.sort((a, b) => (a.r.econ.gpPerXp ?? Infinity) - (b.r.econ.gpPerXp ?? Infinity));
    else if (sort === 'net') rows.sort((a, b) => net(b.r) - net(a.r));
    // More than one group (Fletching, Mining's rocks and bars): show one at a
    // time, the one you train with unless you pick. The buttons keep the
    // data's own order whatever the sort (Smithing: Smelting, Bronze … Rune);
    // with every group shown, the table's sections follow the sort.
    const groups = groupsOf(rows.map(x => x.m)).map(([g]) => g);
    const groupOrder = groupsOf(plan.table.map(r => ix.byId.get(r.id))).map(([g]) => g);
    let shown = null;
    if (groupOrder.length > 1) {
      const pick = S.tgroup[goal.skill];
      const fillGroup = plan.fill ? ix.byId.get(plan.fill.id)?.group : ix.byId.get(plan.fromBank.steps[0]?.id)?.group;
      shown = pick === 'all' ? null : groupOrder.includes(pick) ? pick : fillGroup || groupOrder[0];
    }
    const mixed = new Set(ix.train.map(m => m.unit || '')).size > 1;
    const cur1 = cur?.level || 1;
    // [header, cell] for each column, in order
    const columns = [
      ['<th>Lvl</th>', (r, m) => `<td>${m.level}</td>`],
      [`<th class="l">${textFor(goal.skill).what}</th>`, (r, m) => `<td class="l"><span class="sk-cell">${itemIcon(methodItem(m), true)} ${esc(m.name)}${multipleBadge(m, Math.max(cur1, m.level))}${burnBadge(ix, m, cur1)}${mixed && m.unit ? ` <span class="per">per ${esc(m.unit)}</span>` : ''}</span></td>`],
      // (with your own bars made on the way, their XP is in it)
      ['<th>XP</th>', (r, m) => `<td>${xpText(r.xpAll ?? m.xp)}</td>`],
      ['<th title="What one sells for, less what it takes, bought from scratch">Net/item</th>', r => {
        const e = r.econ;
        return `<td>${e.net == null ? '<span class="c-faint">?</span>' : `<span class="${e.net >= 0 ? 'c-win' : 'c-lose'}">${signed(e.net)}</span>`}</td>`;
      }],
      ['<th title="gp per XP: what each XP costs you (negative: you make money)">gp/XP</th>', r => {
        const e = r.econ;
        return `<td>${e.gpPerXp == null ? '<span class="c-faint">?</span>' : `<span class="${e.gpPerXp <= 0 ? 'c-win' : ''}">${gpShort(e.gpPerXp)}</span>`}</td>`;
      }],
    ];
    if (!bankOn) {
      columns.push(['<th title="How many on their own, from your XP now">To goal</th>', r => `<td>${r.needed ? fmt(r.needed) : '–'}</td>`]);
      columns.push(['<th class="wrap" title="Your mix: how many of each you plan to make. Their XP counts toward your goal, and the rest is planned after them.">Plan to<br>make</th>',
        (r, m) => `<td><input class="input small num mix-in" data-mix="${m.id}" inputmode="decimal" value="${r.planned ? fmt(r.planned) : ''}" placeholder="0" aria-label="How many ${esc(m.name)} you plan to make" title="How many you plan to make"></td>`]);
      if (plan.fromMix) columns.push(['<th class="wrap" title="How many more to reach your goal, after your mix">Still needed<br>to goal</th>', r => `<td>${r.toMake ? fmt(r.toMake) : '–'}</td>`]);
    } else {
      columns.push(['<th title="What your bank makes of it now">From bank</th>', r => `<td>${r.have ? `<span class="c-level">${fmt(r.have)}</span>` : '0'}</td>`]);
      // (a fee paid on the way, the tanner's, isn't part of a gross: it comes off in Total net)
      const fees = PLACES[goal.skill] ? `the ${PLACES[goal.skill].label.toLowerCase()}'s fee` : 'fees';
      columns.push([whatIf
        ? '<th class="wrap" title="What your bank plan makes of it with your supplies rounded up (as From your bank shows) is worth, less what that takes to collect. It\'s the bank part of Total net.">Net from bank,<br>supplies rounded up</th>'
        : '<th class="wrap" title="Gross from your already banked supplies: what your bank plan makes of it, as From your bank shows, before any rounding up. It\'s the bank part of Total net.">Gross from<br>banked supplies</th>',
        (r, m) => gainTd(whatIf || !r.gains.before ? r.gains.before : { ...r.gains.before, total: r.gains.before.value }, g => (whatIf
          ? `Your bank plan, with your supplies rounded up, makes ${count(m, r.fromPlan)}: worth ${gpShort(g.value)}${g.cost ? `, less ${gpShort(g.cost)} to collect${ix.fees.size ? ' and in fees' : ''}` : ''}. Your banked supplies are yours already.`
          : `Your bank plan makes ${count(m, r.fromPlan)} (From your bank): worth ${gpShort(g.value)}. Your banked supplies are yours already.${g.cost ? ` (${gpShort(g.cost)} for ${fees} comes off in Total net.)` : ''}`))]);
      // Round up my supplies, and what your bank's supplies come to then (only
      // where something takes two or more things, like an unf potion and a
      // secondary). A line on each side sets the two apart.
      if (evenCol) {
        columns.push([`<th class="l wrap sep-l" title="${esc(EVEN_TIP)}">Round up<br>my supplies</th>`, (r, m) => evenTd(m, r)]);
        columns.push(['<th class="wrap sep-r" title="What your bank makes of it once your supplies are rounded up is worth, less what rounding up takes to collect. Your banked supplies are yours already.">Net after rounding<br>up my supplies</th>',
          (r, m) => gainTd(r.gains.even, g => `${count(m, r.balance ? r.balance.runs : r.have)}: worth ${gpShort(g.value)}${g.cost ? `, less ${gpShort(g.cost)} ${r.balance && Object.keys(r.balance.collect).length ? `to collect${r.balance.paid ? ' and in fees' : ''}` : `for ${fees}`}` : ''}. Your banked supplies are yours already.`, 'sep-r')]);
      }
      columns.push(['<th class="wrap" title="How many more to reach your goal, after everything your bank makes">Still needed<br>to goal</th>', r => `<td>${r.toMake ? fmt(r.toMake) : '–'}</td>`]);
      columns.push(['<th class="l" title="What those take, beyond what\'s left in your bank">Supplies needed</th>', r => `<td class="l">${r.toMake ? itemList(r.collect, { small: true }) : ''}</td>`]);
      columns.push(['<th class="wrap" title="What the ones still needed are worth, less what their supplies cost">Net after<br>buying supplies</th>',
        (r, m) => gainTd(r.gains.collect, g => `${count(m, r.toMake)}: worth ${gpShort(g.value)}, less ${gpShort(g.cost)} for supplies.`)]);
      const bankPart = whatIf ? 'Net from bank, supplies rounded up' : 'Gross from banked supplies';
      columns.push([`<th class="wrap" title="${bankPart}${whatIf ? ',' : ''} plus net after buying supplies: the gp it all comes to on the way to your goal">Total net gp<br>toward goal</th>`,
        r => gainTd(r.gains.net, () => {
          const b = r.gains.before;
          const bank = whatIf || !b?.cost ? `${bankPart} ${signed(b?.total || 0)}` : `${bankPart} ${signed(b.value)}, less ${gpShort(b.cost)} for ${fees},`;
          return `${bank} + net after buying supplies ${signed(r.gains.collect?.total || 0)}`;
        })]);
    }
    // Use comes first, where it can't scroll out of sight: untick anything you
    // don't plan to make.
    if (bankCols) {
      columns.unshift(['<th title="Let the bank plan make this. Untick anything you don\'t plan to make. (What a ticked row needs is still made on the way: a ring\'s sapphire is cut even with Sapphire (cut) unticked.)">Use</th>',
        (r, m) => `<td class="c"><input type="checkbox" data-use="${m.id}" ${excluded.has(m.id) ? '' : 'checked'} title="Let the bank plan make this" aria-label="Use ${esc(m.name)} in the bank plan"></td>`]);
    }
    const nameCol = columns.findIndex(([head]) => head.includes(`>${textFor(goal.skill).what}<`));
    const body = groups.filter(g => !shown || g === shown).map(gname => {
      const inGroup = rows.filter(x => x.m.group === gname);
      // (the group's name sits above the names, not under Use)
      return `<tr class="grp">${nameCol > 0 ? `<td colspan="${nameCol}"></td>` : ''}<td colspan="${columns.length - Math.max(0, nameCol)}">${esc(gname)}</td></tr>` + inGroup.map(({ r, m }) => {
        const e = r.econ;
        const chosen = plan.fill?.id === m.id;
        const per = m.unit ? ` per ${m.unit}` : ' each';
        const needs = Object.entries(e.inputs).map(([k, n]) => `${amountText(n)} ${ITEMS[k]?.name || k}`).join(', ');
        const title = `${m.name}: level ${m.level}, ${xpText(m.xp)} XP${per}${m.parts ? ` (${partsText(m)})` : ''}` +
          (r.xpAll ? `\nWith what's made on the way: ${xpText(r.xpAll)} XP${per} (${xpText(r.xpAll - m.xp)} of it from ${textFor(goal.skill).own || "what's made on the way"})` : '') +
          burnLine(ix, m, cur1) +
          (needs ? `\nNeeds (from scratch): ${needs}` : '') +
          (m.tools?.length ? `\nTools: ${m.tools.map(t => ITEMS[t]?.name || t).join(', ')}` : '') +
          (m.note ? `\n${m.note}` : '') +
          (e.net != null ? `\nCosts ${gpShort(e.cost)}, worth ${gpShort(e.value)}: net ${signed(e.net)}${per}` : '');
        return `<tr class="${r.locked ? 'dim ' : ''}${chosen ? 'hl ' : ''}${excluded.has(m.id) ? 'off' : ''}" data-method="${m.id}" title="${esc(title)}">
          ${columns.map(([, cell]) => cell(r, m)).join('')}
        </tr>`;
      }).join('');
    }).join('');
    const sBtn = (k, label, tip = '') => `<button type="button" class="${sort === k ? 'on' : ''}" data-tsort-plan="${k}"${tip ? ` title="${esc(tip)}"` : ''}>${label}</button>`;
    const gBtn = (g, label) => `<button type="button" class="chip${(shown || 'all') === g ? ' on' : ''}" data-tgroup="${esc(g)}" aria-pressed="${(shown || 'all') === g}">${esc(label)}</button>`;
    const groupBar = groupOrder.length > 1 ? `<div class="group-pick" role="group" aria-label="Which options">${groupOrder.map(g => gBtn(g, g)).join('')}${gBtn('all', 'All')}</div>` : '';
    return `<div class="plan-sec"><h4>Every option <span class="c-faint">(on its own, from ${cur ? `level ${cur.level}` : 'now'}; click one to train with it)</span></h4>
      ${groupBar}
      <div class="bar wrap"><span class="c-muted small-note">Sort</span><div class="seg">${sBtn('level', 'Level')}${sBtn('xp', 'XP each')}${sBtn('cheap', 'Cheapest XP')}${bankOn ? sBtn('net', 'Total net', 'Most gp toward your goal first (Total net gp toward goal)') : ''}</div>
        <span class="c-faint small-note">${unitNote(goal.skill, ix, mixed, { bankOn, even: evenCol, assumed: assumed.length ? ASSUME_LABEL[goal.skill] : null, mix: !!plan.fromMix, whatIf })}</span></div>
      <div class="table-wrap"><table class="grid plan-t">
        <thead><tr>${columns.map(([th]) => th).join('')}</tr></thead>
        <tbody>${body}</tbody></table></div></div>`;
  }

  // Skill tabs on the Bank and Prices views, for the skills the planner covers
  // (the Bank tab leaves out skills that don't use it).
  function skillSwitch(keys, current, { all = false, values = null } = {}) {
    if (keys.length < 2 && !all) return '';
    const worth = k => (values?.[k] ? ` <span class="sw-v">${gpShort(values[k])}</span>` : '');
    const tab = (k, label) => `<button type="button" class="tab skill-tab${k === 'all' ? ' all-tab' : ''}${k === current ? ' active' : ''}" data-bskill="${k}" aria-pressed="${k === current}">${label}${worth(k)}</button>`;
    return `<div class="skill-switch" role="group" aria-label="Skill">${all ? tab('all', 'All') : ''}${keys.map(k => {
      const sk = SKILL_BY_KEY.get(k);
      return tab(k, `${iconImg(sk)} ${esc(sk.name)}`);
    }).join('')}</div>`;
  }

  // ── Reading the bank from screenshots ───────────────────────────────────
  // The reader (bankread.js, its data and icons) loads the first time it's used.
  let reader = null;
  async function getReader() {
    if (reader) return reader;
    const [B, D] = await Promise.all([import('./bankread.js'), import('./bankread-data.js')]);
    const atlas = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(pixelsOf(img, img.naturalWidth, img.naturalHeight));
      img.onerror = () => reject(new Error('The icons for reading screenshots didn\'t load. Reload the page and try again.'));
      img.src = D.BANK_ICON_SHEET || 'bankicons.png';
    });
    reader = { B, D, icons: B.prepareIcons(atlas, D.BANK_ICONS, D.BANK_ICONS_PER_ROW) };
    return reader;
  }
  function pixelsOf(source, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0);
    return g.getImageData(0, 0, w, h);
  }

  // Choosing screenshots. Where the browser has the newer file picker (LostKit
  // does), it opens in the folder you last picked from, which is remembered in
  // IndexedDB; the first time, in Pictures, where LostKit Screenshots is. Pages
  // can't name a folder themselves. Elsewhere it's the plain file button.
  async function pickScreenshots() {
    if (typeof window.showOpenFilePicker === 'function') {
      const last = await idb.get('shotsFile');
      try {
        const handles = await window.showOpenFilePicker({
          id: 'lostkit-screenshots', multiple: true, startIn: last || 'pictures',
          types: [{ description: 'Screenshots', accept: { 'image/png': ['.png'] } }],
        });
        if (!handles.length) return;
        idb.set('shotsFile', handles[0]);
        readShots(await Promise.all(handles.map(h => h.getFile())));
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return;          // closed without picking
        if (last) idb.set('shotsFile', null);           // forget a folder that's gone
      }
    }
    $('shots-file')?.click();
  }

  // files: screenshots (File or Blob). Results wait in S.shots for you to apply.
  async function readShots(files) {
    const list = [...files].filter(f => f && (/^image\//.test(f.type) || /\.png$/i.test(f.name || '')));
    if (!list.length) { S.shots = { error: 'That isn\'t a picture. Use the PNG screenshots LostKit saves.' }; renderShots(); return; }
    showMsg('bank-msg', '');
    S.shots = { busy: list.length };
    renderShots();
    try {
      const { B, D, icons } = await getReader();
      list.sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0));      // later screenshots win
      const reads = [];
      for (const f of list) {
        const name = f.name || 'Pasted picture';
        try {
          const bmp = await createImageBitmap(f);
          const r = B.readBank(pixelsOf(bmp, bmp.width, bmp.height), icons, D.STACK_FONT, D.BANK_LAYOUT);
          bmp.close?.();
          reads.push({ name, ...r });
        } catch (e) {
          reads.push({ name, ok: false, why: 'unreadable' });
        }
      }
      const merged = B.mergeReads(reads.filter(r => r.ok));
      const b = bank();
      const read = B.reviewRows(merged, { bank: b.items, memory: b.twins, likelier: LIKELIER_TWIN, repeat: [UNID_HERBS.item] });
      const rows = read.filter(r => !NOT_BANKED.has(r.slug));
      // off: lines you've unticked. (Kept here: the view is redrawn as prices arrive.) left: tools and thread, not added.
      S.shots = { reads, merged, off: new Set(), rows, left: read.length - rows.length };
      prices.want(S.shots.rows.flatMap(r => r.choices || [r.slug]));
    } catch (e) {
      S.shots = { error: e?.message || String(e) };
    }
    renderShots();
  }

  function renderShots() {
    const el = $('bank-shots');
    if (!el) return;
    if (!S.account) { el.innerHTML = ''; return; }
    const sh = S.shots;
    const pick = `<button type="button" class="btn small" data-act="shots-pick">Choose screenshots</button>
      <input type="file" id="shots-file" accept="image/png,image/*" multiple hidden>`;
    if (!sh || sh.error) {
      el.innerHTML = `<div class="card shots-drop" data-drop="1">
        <div class="shots-title">Read your bank from screenshots</div>
        <p class="note">Open your bank in LostKit and press the screenshot key. If your bank scrolls, scroll and take another until you've covered it.
          LostKit saves them in <b>Pictures › LostKit Screenshots</b>. Drop them here, paste one, or ${pick}</p>
        ${sh?.error ? `<div class="msg error">${esc(sh.error)}</div>` : ''}
      </div>`;
      return;
    }
    if (sh.busy) {
      el.innerHTML = `<div class="card shots-drop"><span class="busy">Reading ${sh.busy} screenshot${sh.busy === 1 ? '' : 's'}…</span></div>`;
      return;
    }
    const m = sh.merged;
    const b = bank().items;
    const bad = sh.reads.filter(r => !r.ok);
    const okCount = sh.reads.length - bad.length;
    const problems = bad.map(r => `<li><b>${esc(r.name)}</b>: ${r.why === 'no-bank' ? 'no bank in this one. Open your bank before pressing the screenshot key.' : 'couldn\'t open this picture.'}</li>`).join('');
    const moved = reader.B.movedFrom(sh.rows, b, { complete: m.complete });
    const lines = shotLines(sh.rows, b);
    const first = new Set();
    const rows = sh.rows.map(it => {
      const { cur, next, approx, min, max } = lines.get(it.slug);
      const read = it.approx ? `≈${esc(gpShort(it.count))}` : fmt(it.count);
      const tip = it.approx ? `The bank shows rounded amounts from 100K up: this is between ${fmt(it.min)} and ${fmt(it.max)}.${approx && cur >= min && cur <= max ? ' Your amount is in that range, so it\'s kept.' : ''}` : '';
      // the same icon as another item: one of ours (you pick which), or one the planner doesn't use (like)
      const likes = (it.like || []).map(n => esc(n));
      const twins = it.choices ? [] : (it.also || []).map(a => itemName(a));
      const also = twins.length + likes.length ? ` <span class="c-faint small-note">or ${[...twins, ...likes].join(', ')}: they look the same</span>` : '';
      const unsure = it.unsure ? ` <span class="shot-check" title="A close call between items that look alike: check this one">check</span>` : '';
      const name = it.choices
        ? `<select class="input small shot-as" data-shot-as="${it.key}" aria-label="Which item this is" title="These look exactly the same in the game: pick the one this is. Your pick is kept for next time.">${it.choices.map(c =>
          `<option value="${c}"${c === it.slug ? ' selected' : ''}>${itemName(c)}</option>`).join('')}</select>`
        : itemName(it.slug);
      // one "was" for an item, on its first line
      const lead = !first.has(it.slug);
      first.add(it.slug);
      // (a stack an earlier read filed under the item it looks like: "was under Ashes", with the amount if it's another)
      const from = moved[it.key];
      const was = from ? `was ${b[from] === it.count ? '' : `${fmt(b[from])} `}under ${itemName(from)}`
        : !lead ? '' : next === cur ? 'same' : `was ${fmt(cur)}`;
      // (any unid herb could be lantadyme, which looks just like one: its drop-down is there, without the nudge)
      const nudge = it.choices && it.icon !== UNID_HERBS.item;
      return `<label class="shot-row${next !== cur ? ' changed' : ''}${nudge ? ' twin' : ''}">
        <input type="checkbox" data-shot="${it.key}"${sh.off.has(it.key) ? '' : ' checked'}>
        ${itemIcon(it.slug, true)} <span class="shot-name">${name}${also}${unsure}</span>
        <span class="shot-n" title="${esc(tip)}">${read}</span>
        <span class="shot-was c-faint">${was}</span>
      </label>`;
    }).join('');
    const twinCount = sh.rows.filter(r => r.choices && r.icon !== UNID_HERBS.item).length;
    const twinNote = twinCount ? ` <b class="c-level">${twinCount === 1 ? 'One of them looks' : `${twinCount} of them look`} exactly like another item</b> (soda ash and ashes, a sapphire ring and a ring of recoil): pick which ${twinCount === 1 ? 'it is' : 'each is'} from its drop-down. Your pick is kept for next time.` : '';
    const gone = Object.values(moved);
    const skipped = m.others + m.unknown + (sh.left || 0);
    const missing = m.complete ? Object.keys(b).filter(slug => b[slug] > 0 && !lines.has(slug) && !gone.includes(slug) && !NOT_BANKED.has(slug)) : [];
    el.innerHTML = `<div class="card shots-result" data-drop="1">
      <div class="shots-title">From ${okCount} screenshot${okCount === 1 ? '' : 's'}: ${lines.size} of your planner items</div>
      <p class="note">${fmt(m.seen)} bank slots read${m.complete ? ', the whole bank' : ''}. ${skipped ? `${fmt(skipped)} other item${skipped === 1 ? '' : 's'} the planner doesn't count ${skipped === 1 ? 'was' : 'were'} skipped${sh.left ? ' (tools and thread among them)' : ''}.` : ''}
        Items cut off at the top or bottom edge are skipped too, so let screenshots overlap a little.${twinNote}</p>
      ${problems ? `<ul class="shot-problems">${problems}</ul>` : ''}
      ${rows ? `<div class="shot-list">${rows}</div>` : '<p class="c-faint">None of the items the planner uses are in these screenshots.</p>'}
      ${missing.length ? `<label class="check shot-clear"><input type="checkbox" id="shots-clear"${sh.clear ? ' checked' : ''}> Also clear ${missing.length} item${missing.length === 1 ? '' : 's'} that ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} in your bank anymore: ${missing.map(itemName).join(', ')}</label>` : ''}
      ${rows && Array.isArray(bank().order) ? `<label class="check shot-clear"><input type="checkbox" id="shots-order"${sh.keepOrder ? '' : ' checked'}> Put the All view back in your bank's order (you've moved items around there)</label>` : ''}
      <div class="bar wrap">
        ${rows ? `<button type="button" class="btn small" data-act="shots-apply">Update my bank</button>` : ''}
        <button type="button" class="btn small" data-act="shots-discard">${rows ? 'Discard' : 'Close'}</button>
        <span class="c-faint small-note">Only the ticked items change; everything else in your bank stays as it is.</span>
        <span class="grow"></span>${pick}
      </div>
    </div>`;
  }

  // What the review's lines come to, item by item: { slug -> { count, min, max,
  // approx, cur (in your bank now), next (after updating), slots } }. Lines of
  // one item add up (unid herbs in several slots). only: the lines that count.
  function shotLines(rows, b, only = () => true) {
    const out = new Map();
    for (const r of rows) {
      if (!only(r)) continue;
      const t = out.get(r.slug) || { count: 0, min: 0, max: 0, approx: false, slots: [] };
      t.count += r.count; t.min += r.min; t.max += r.max;
      t.approx ||= !!r.approx;
      t.slots.push(...(r.slots || []));
      out.set(r.slug, t);
    }
    for (const [slug, t] of out) {
      t.cur = b[slug] || 0;
      // 100K and up the bank shows rounded: an amount of yours in that range is kept
      t.next = t.approx && t.cur >= t.min && t.cur <= t.max ? t.cur : t.count;
    }
    return out;
  }

  function applyShots() {
    const sh = S.shots;
    if (!sh?.merged) return;
    const m = sh.merged;
    const b = bank();
    const on = r => !sh.off.has(r.key);
    const all = shotLines(sh.rows, b.items);                   // every line read, ticked or not
    const lines = shotLines(sh.rows, b.items, on);
    let changed = 0;
    // a stack that was filed under the other item with its icon moves over
    const moved = reader.B.movedFrom(sh.rows, b.items, { complete: m.complete });
    for (const r of sh.rows) {
      const from = on(r) && moved[r.key];
      if (!from || !(b.items[from] > 0)) continue;
      delete b.items[from];
      if (b.slots) delete b.slots[from];
      changed++;
    }
    for (const [slug, t] of lines) {
      if (t.next !== t.cur) changed++;
      if (t.next > 0) b.items[slug] = t.next; else delete b.items[slug];
    }
    if (sh.clear && m.complete) {
      for (const slug of Object.keys(b.items)) if (!all.has(slug) && !NOT_BANKED.has(slug)) { delete b.items[slug]; changed++; }
    }
    // Where each item is in the bank, for the All view's order. Screenshots of
    // the whole bank replace what was known; a part of it updates what it shows.
    const slots = m.complete ? {} : { ...(b.slots || {}) };
    for (const [slug, t] of all) {
      if (!t.slots.length) continue;
      if (lines.has(slug)) slots[slug] = Math.min(...lines.get(slug).slots);
      else if (b.slots?.[slug] != null) slots[slug] = b.slots[slug];
    }
    b.slots = slots;
    // which of two look-alikes each stack is, for next time
    const twins = { ...(b.twins || {}) };
    for (const r of sh.rows) if (r.choices) twins[r.icon] = sh.rows.filter(x => x.icon === r.icon).map(x => x.slug);
    if (Object.keys(twins).length) b.twins = twins;
    const reordered = Array.isArray(b.order) && !sh.keepOrder && !!$('shots-order');
    if (reordered) delete b.order;
    saveBank(b);
    S.shots = null;
    showMsg('bank-msg', `Bank updated from your screenshots: ${changed} item${changed === 1 ? '' : 's'} changed.${reordered ? ' All is in your bank\'s order again.' : ''}`, 'ok');
    renderBank();
  }

  // ── Bank view ───────────────────────────────────────────────────────────
  function renderBank() {
    if (bankDrag?.hold()) return;          // don't pull items out from under a drag
    renderAccount('bank-account', 'bank');
    renderShots();
    const body = $('bank-body');
    if (!S.account) { $('bank-head').innerHTML = ''; body.innerHTML = ''; return; }
    renderBankHead();
    if (S.bankView === 'all') {
      // Everything you have: in your order (drag items around), or most valuable first.
      const b = bank();
      const have = bankSubset(b.items, 'all');
      const worth = slug => { const p = prices.gp(slug); return p == null ? -1 : p * have[slug]; };
      const byValue = S.allSort === 'value';
      const list = byValue
        ? Object.keys(have).sort((x, y) => worth(y) - worth(x) || itemName(x).localeCompare(itemName(y)))
        : allOrder(b, Object.keys(have));
      const own = Array.isArray(b.order), inGame = list.some(slug => b.slots?.[slug] != null);
      const note = byValue ? 'Drag an item to make this your own order.'
        : own ? 'Your own order. Drag items to move them.'
        : inGame ? 'In the order they have in your bank, from your screenshots. Drag items to move them.'
        : 'Drag items to move them. Reading your bank from screenshots puts them in the order they have in-game.';
      const oBtn = (k, label) => `<button type="button" class="${S.allSort === k ? 'on' : ''}" data-allsort="${k}" aria-pressed="${S.allSort === k}">${label}</button>`;
      const reset = own && !byValue ? `<button type="button" class="linkish" data-act="bank-order-reset">${inGame ? 'Back to your bank\'s order' : 'Reset order'}</button>` : '';
      body.innerHTML = list.length
        ? `<div class="card bank-group"><div class="bank-all-head"><h4>Everything you have</h4>
            <div class="seg" role="group" aria-label="Order">${oBtn('yours', 'Your order')}${oBtn('value', 'Most valuable')}</div>
            <span class="c-faint small-note">${note}</span>${reset}</div>
            <div class="bank-grid movable" id="bank-all-grid">${list.map(bankCell).join('')}</div></div>`
        : `<div class="empty">Nothing in your bank yet. Read it from screenshots above, or pick a skill to type in what you have.</div>`;
    } else {
      const groups = BANK_GROUPS[S.bankView] || [];
      body.innerHTML = groups.map(g => `<div class="card bank-group"><h4>${esc(g.name)}</h4><div class="bank-grid">${g.items.map(bankCell).join('')}</div></div>`).join('');
    }
    const items = Object.keys(bank().items);
    if (items.length) prices.want(items);
  }

  function renderBankHead() {
    const b = bank();
    const view = S.bankView;
    const sub = bankSubset(b.items, view);
    const value = bankValue(sub, prices.priceOf);
    const kinds = Object.keys(sub).length;
    const values = {};
    for (const k of ['all', ...Object.keys(BANK_GROUPS)]) {
      const v = bankValue(bankSubset(b.items, k), prices.priceOf).total;
      if (v > 0) values[k] = v;
    }
    const skillName = view === 'all' ? '' : SKILL_BY_KEY.get(view).name;
    const hint = {
      all: 'Showing everything you have. Pick a skill to see just its items and their value, and to type in ones you don\'t have yet. Items used by two skills (logs) count toward both.',
      herblore: 'Unid herbs are one entry: every "Herb" in your bank, whatever it turns out to be.',
      runecraft: 'Rune essence is the only essence in this version of the game; pure essence came later.',
      firemaking: 'Achey tree logs aren\'t listed: lighting them gives no XP in this version. Your logs are shared with Fletching (it\'s one bank).',
      fletching: 'Unstrung bows are marked (u); in-game they have the same name as the strung bow. Feathers count for both arrows and darts.',
      cooking: 'Raw fish and meat cook into food; a pie, a pizza, a cake, a stew or a wine is put together first, and anything on the way counts (flour and water, dough, a pie shell). Burnt food is counted on a Cooking goal, where you also say what you cook on. Dough takes a bucket of water here; in the game a jug does too. Cooked meat and anchovies are food and a filling or topping: one entry each. Your raw fish are the ones Fishing catches (it\'s one bank).',
      crafting: 'Hides are tanned before they\'re worked: type in hides or leather, and both are used. The tanner\'s fee is counted (pick the tanner on a Crafting goal). Key halves and crystal keys count as the uncut dragonstone the crystal chest always gives (its other loot is luck, and isn\'t counted). Dragonhide\'s colour is added in brackets, the two key halves are told apart as tooth and loop, and unstrung amulets are marked (u), since in-game those share a name. Dragonhide sets are priced on the Prices tab: in a bank they\'re their three pieces. Bow strings, vials and runes are shared with other skills (it\'s one bank).',
    }[view] || '';
    $('bank-head').innerHTML = `${skillSwitch(Object.keys(BANK_GROUPS), view, { all: true, values })}<div class="bank-sum">
      <span>${kinds ? `<b>${kinds}</b> kind${kinds === 1 ? '' : 's'} of ${skillName ? esc(skillName) + ' ' : ''}item` : skillName ? `No ${esc(skillName)} items yet` : 'Nothing entered yet'}${b.updated ? ` · updated ${ago(b.updated)}` : ''}</span>
      ${kinds ? `<span>${skillName ? `${esc(skillName)} items are worth` : 'Worth'} about <b class="c-xp">${gpShort(value.total)}</b> gp${value.missing.length ? ` <span class="c-faint">(${value.missing.length} without a price)</span>` : ''}</span>` : ''}
      <span class="grow"></span>
      <button type="button" class="btn small" data-act="bank-prices">Get prices</button>
      <button type="button" class="btn small danger" data-act="bank-clear">Clear bank</button>
    </div>
    <p class="note">Type what you have: 1500, 1.5k or 2m all work. Click an item's name to open it on the market. Only the items the planner uses are listed; more skills come in later updates.
      ${hint}</p>`;
  }

  function bankCell(slug) {
    const n = bank().items[slug] || 0;
    const p = prices.gp(slug);
    return `<label class="bank-cell${n ? ' has' : ''}" data-slug="${slug}" title="${esc(ITEMS[slug].name)}\n${esc(priceTip(slug))}">
      ${itemIcon(slug)}
      <a class="bn mk" ${marketLink(slug)} draggable="false" title="Open ${itemName(slug)} on the market">${itemName(slug)}</a>
      <input class="input small num" data-bank="${slug}" inputmode="decimal" value="${n ? fmt(n) : ''}" placeholder="0" aria-label="${itemName(slug)} in bank">
      <span class="bv" data-bv="${slug}">${n && p != null ? gpShort(n * p) : ''}</span>
    </label>`;
  }

  // ── Prices view ─────────────────────────────────────────────────────────
  // Each item uses the price you pick for it, and keeps it: the market's (the
  // default), high alch, or yours (typing one in picks it). A whole list or
  // skill can be switched at once; that leaves prices you typed in be.
  function priceItems(list) { return list.filter(s => ITEMS[s] && !ITEMS[s].untradeable); }
  function renderPrices() {
    const st = prices.status();
    const head = $('prices-head');
    const running = st.busy || st.queued;
    const skill = SKILL_BY_KEY.get(S.bankSkill).name;
    head.innerHTML = `${skillSwitch(Object.keys(INDEX), S.bankSkill)}<div class="card">
      <div class="bar wrap">
        <button type="button" class="btn small" data-act="prices-refresh"${running ? ' disabled' : ''}>Check prices now</button>
        ${running ? `<button type="button" class="btn small" data-act="prices-stop">Stop</button><span class="busy">Checking ${fmt(Math.min(st.done + 1, st.total))} of ${fmt(st.total)}…</span>` : ''}
        ${st.error && !running ? `<span class="c-lose small-note">${esc(st.error)}${ctx.fullMarket ? '' : ' Prices work best inside LostKit.'}</span>` : ''}
        <span class="grow"></span>
        <span class="bulk"><span class="c-muted small-note">Every ${esc(skill)} item:</span>
          <button type="button" class="btn small" data-pall="market" title="Use the market's price for every ${esc(skill)} item (prices you typed in stay)">Market</button>
          <button type="button" class="btn small" data-pall="alch" title="Use high alch for every ${esc(skill)} item (prices you typed in stay)">High alch</button></span>
      </div>
      <p class="note">Pick the price each item uses, and it sticks: the <b>market</b>'s, <b>high alch</b> (what High Level Alchemy gives: 3/5 of its value), or <b>your own</b> (type it in).
        Market prices are the median of recent sales on <a href="https://markets.lostcity.rs" target="_blank" rel="noopener">markets.lostcity.rs</a>, otherwise of open offers, and high alch for items nobody trades.
        ${ctx.fullMarket ? '' : 'In a normal browser only open offers can be read; LostKit also sees the sales. '}They're checked one at a time and kept for 12 hours.
        Click an item to open it on the market${ctx.inLostKit ? ' (LostKit\'s ◀ button brings you back here)' : ''}.</p>
    </div>`;
    const groups = priceGroups(S.bankSkill);
    const allBtn = (use, gi, what) => `<button type="button" class="linkish th-all" data-pall="${use}" data-pgroup="${gi}" title="Use ${what} for every item in this list (prices you typed in stay)">all</button>`;
    $('prices-body').innerHTML = groups.map((g, gi) => `<div class="table-wrap price-wrap"><table class="grid prices-t">
      <thead><tr><th class="l">${esc(g.name)}</th>
        <th class="l">Market ${allBtn('market', gi, 'the market\'s price')}</th>
        <th class="l">High alch ${allBtn('alch', gi, 'high alch')}</th>
        <th class="l">Your price</th></tr></thead>
      <tbody>${priceItems(g.items).map(priceRow).join('')}</tbody></table></div>`).join('');
  }

  function priceRow(slug) {
    const use = prices.sourceOf(slug);
    const own = prices.overrides[slug];
    const m = prices.market(slug);
    const at = prices.fetchedAt(slug);
    const name = ITEMS[slug]?.name || slug;
    const pick = (value, label) => `<input type="radio" name="pu-${slug}" value="${value}" data-psrc="${slug}"${use === value ? ' checked' : ''} aria-label="${esc(`${label} for ${name}`)}">`;
    const market = m
      ? `<b>${gpShort(m.gp)}</b><span class="src">${esc(m.untraded ? 'no trades: high alch' : sourceText(m))}${at && !m.untraded ? ` · checked ${ago(at)}` : ''}</span>`
      : `<span class="c-faint">${at ? 'not traded' : 'not checked yet'}</span>`;
    return `<tr>
      <td class="l"><a class="sk-cell mk" ${marketLink(slug)} title="${esc(`Open ${name} on the market`)}">${itemIcon(slug, true)} ${itemName(slug)}</a></td>
      <td class="l pc${use === 'market' ? ' on' : ''}"><label class="pick">${pick('market', 'Market price')}<span>${market}</span></label></td>
      <td class="l pc${use === 'alch' ? ' on' : ''}"><label class="pick">${pick('alch', 'High alch')}<b>${gpShort(highAlch(slug))}</b></label></td>
      <td class="l pc${use === 'mine' ? ' on' : ''}"><label class="pick">${pick('mine', 'Your price')}</label><input class="input small num${own != null ? ' set' : ''}" data-price="${slug}" inputmode="decimal" value="${own != null ? own : ''}" placeholder="type one" aria-label="Your price for ${esc(name)}" title="${own != null ? 'Your price. Clear the box to go back to the market\'s' : 'Type a price to use it for this item'}"></td>
    </tr>`;
  }

  // ── Rendering glue ──────────────────────────────────────────────────────
  // Views are rebuilt as prices and XP arrive, so whatever field you're typing
  // in is found again afterwards, with its text and caret where they were.
  function fieldKey(el) {
    if (el.dataset?.psrc) return `[data-psrc="${el.dataset.psrc}"][value="${el.value}"]`;
    for (const a of ['bank', 'price', 'gopt', 'use', 'mix', 'shot']) if (el.dataset?.[a]) return `[data-${a}="${el.dataset[a]}"]`;
    if (el.dataset?.shotAs) return `[data-shot-as="${el.dataset.shotAs}"]`;
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
    if (el.type !== 'checkbox' && el.type !== 'radio' && el.tagName !== 'SELECT') el.value = keep.value;
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
    // (and look again when it's time: a press may have started in between)
    rerenderTimer = setTimeout(() => (pressing ? rerender() : render(S.tab)), 30);
  }

  function show(tab) {
    render(tab);
    if (S.account && (tab === 'goals' || tab === 'bank')) loadProfile();
    if (tab === 'prices') wantPrices([S.bankSkill], { all: true });   // shows the market's price beside the others
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
    bankDrag = sortable({
      root: $('view-bank'),
      item: '#bank-all-grid .bank-cell',
      skip: 'input',
      onDrop(cell) {
        const b = bank();
        b.order = [...cell.parentNode.children].map(c => c.dataset.slug).filter(Boolean);
        saveLayout(b);
        if (S.allSort !== 'yours') { S.allSort = 'yours'; saveUi(); }   // it's your own order now
      },
      onEnd({ dropped, stale }) { if (dropped || stale) renderBank(); },
    });
    // A bank plan's lines, dragged into your own order: what's on screen, top
    // first, then whatever your order held that isn't on screen now.
    stepDrag = sortable({
      root: $('view-goals'),
      item: '.steps.movable > .step',
      skip: 'a, button, input, select',
      onDrop(step) {
        const card = step.closest('[data-goal]');
        if (!card) return;
        const shown = [...new Set([...step.parentNode.children].map(el => el.dataset.step).filter(Boolean))];
        updateGoal(card.dataset.goal, g => { g.order = [...shown, ...(Array.isArray(g.order) ? g.order : []).filter(id => !shown.includes(id))]; });
      },
      onEnd({ dropped, stale }) { if (dropped || stale) renderGoals(); },
    });
    // Screenshots dropped or pasted on the Bank tab. A file dropped anywhere else
    // on the page is ignored rather than opened in place of the tool.
    const onBank = () => S.tab === 'bank' && !$('view-bank')?.hidden && S.account;
    const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
    document.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const zone = onBank() && e.target.closest?.('#view-bank');
      e.dataTransfer.dropEffect = zone ? 'copy' : 'none';
      $('bank-shots')?.firstElementChild?.classList.toggle('drag', !!zone);
    });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) $('bank-shots')?.firstElementChild?.classList.remove('drag'); });
    document.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      $('bank-shots')?.firstElementChild?.classList.remove('drag');
      if (onBank() && e.target.closest?.('#view-bank')) readShots(e.dataTransfer.files);
    });
    document.addEventListener('paste', e => {
      if (!onBank() || e.target.closest?.('input, textarea')) return;
      const files = [...(e.clipboardData?.files || [])].filter(f => /^image\//.test(f.type));
      if (files.length) { e.preventDefault(); readShots(files); }
    });
  }

  function onSubmit(e) {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'account') { if (setAccount(form.account.value)) render(S.tab); }
    if (form.dataset.form === 'goal') addGoal(form.value.value);
    if (form.dataset.form === 'edit-goal') saveGoalEdit(form.closest('[data-goal]')?.dataset.goal, form.value.value);
  }

  function onClick(e) {
    const t = e.target;
    const nskill = t.closest('[data-nskill]');
    if (nskill) { S.newGoal.skill = nskill.dataset.nskill; saveUi(); showMsg('goals-msg', ''); renderNewGoal(); return; }
    const ntype = t.closest('[data-ntype]');
    if (ntype) { S.newGoal.type = ntype.dataset.ntype; saveUi(); showMsg('goals-msg', ''); renderNewGoal(); return; }
    const bskill = t.closest('[data-bskill]');
    if (bskill) {
      const k = bskill.dataset.bskill;
      if (S.tab === 'prices') { if (INDEX[k]) S.bankSkill = k; } else S.bankView = k;
      saveUi();
      render(S.tab);
      if (S.tab === 'prices') wantPrices([S.bankSkill], { all: true });
      return;
    }
    const allsort = t.closest('[data-allsort]');
    if (allsort) { S.allSort = allsort.dataset.allsort === 'value' ? 'value' : 'yours'; saveUi(); renderBank(); return; }
    const pall = t.closest('[data-pall]');
    if (pall) {
      const groups = priceGroups(S.bankSkill);
      const gi = pall.dataset.pgroup;
      const items = priceItems(gi != null ? groups[Number(gi)]?.items || [] : groups.flatMap(g => g.items));
      prices.setSource(items, pall.dataset.pall);
      renderPrices();
      return;
    }
    const gshow = t.closest('[data-gshow]');
    if (gshow) { S.show = gshow.dataset.gshow; saveUi(); renderGoals(); return; }
    const gonly = t.closest('[data-gonly]');
    if (gonly) { S.only = S.only === gonly.dataset.gonly ? null : gonly.dataset.gonly; saveUi(); renderGoals(); return; }
    const psort = t.closest('[data-tsort-plan]');
    if (psort) { S.sort = psort.dataset.tsortPlan; saveUi(); renderGoals(); return; }
    const card = t.closest('[data-goal]');
    const etype = t.closest('[data-etype]');
    if (etype && S.editing) { S.editing = { id: S.editing.id, type: etype.dataset.etype }; renderGoals(); return; }
    const tgroup = t.closest('[data-tgroup]');
    if (tgroup && card) {
      const skill = goals().find(g => g.id === card.dataset.goal)?.skill;
      if (skill) { S.tgroup = { ...S.tgroup, [skill]: tgroup.dataset.tgroup }; saveUi(); renderGoals(); }
      return;
    }
    const first = t.closest('[data-first]');
    if (first && card) {
      const id = first.dataset.first;
      updateGoal(card.dataset.goal, g => { g.order = [id, ...(Array.isArray(g.order) ? g.order : []).filter(x => x !== id)]; });
      renderGoals();
      return;
    }
    const methodRow = t.closest('tr[data-method]');
    if (card && methodRow && !t.closest('input, a')) {
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
        if (!act.dataset.armed) { arm(act); break; }
        saveGoals(goals().filter(g => g.id !== card.dataset.goal));
        S.open.delete(card.dataset.goal); saveUi();
        if (S.editing?.id === card.dataset.goal) S.editing = null;
        renderGoals();
        break;
      case 'edit-goal': {
        const g = goals().find(x => x.id === card.dataset.goal);
        S.editing = !g || S.editing?.id === g.id ? null : { id: g.id, type: g.type };
        renderGoals();
        if (S.editing) {
          const input = document.querySelector(`[data-goal="${g.id}"] [data-form="edit-goal"] [name="value"]`);
          input?.focus({ preventScroll: true });
          input?.select();
        }
        break;
      }
      case 'edit-cancel': S.editing = null; renderGoals(); break;
      case 'to-bank':
        if (BANK_GROUPS[act.dataset.skill]) { S.bankView = act.dataset.skill; saveUi(); }
        ctx.goTab('bank');
        break;
      case 'bank-prices': prices.want(Object.keys(bank().items), { force: true }); renderBankHead(); break;
      case 'mix-clear':
        updateGoal(card.dataset.goal, g => { delete g.mix; });
        renderGoals();
        break;
      case 'order-reset':
        updateGoal(card.dataset.goal, g => { delete g.order; });
        renderGoals();
        break;
      case 'order-more':
        if (S.more.has(card.dataset.goal)) S.more.delete(card.dataset.goal); else S.more.add(card.dataset.goal);
        renderGoals();
        break;
      case 'bank-order-reset': {
        const b = bank();
        delete b.order;
        saveLayout(b);
        renderBank();
        break;
      }
      case 'shots-pick': pickScreenshots(); break;
      case 'shots-apply': applyShots(); break;
      case 'shots-discard': S.shots = null; renderShots(); break;
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
    if (t.id === 'shots-file') { if (t.files?.length) readShots(t.files); return; }
    // The screenshot review: what's ticked, and which look-alike a line is.
    if (S.shots?.rows) {
      if (t.id === 'shots-clear') { S.shots.clear = t.checked; return; }
      if (t.id === 'shots-order') { S.shots.keepOrder = !t.checked; return; }
      if (t.dataset.shot) { if (t.checked) S.shots.off.delete(t.dataset.shot); else S.shots.off.add(t.dataset.shot); return; }
      if (t.dataset.shotAs) {
        if (reader.B.pickRow(S.shots.rows, t.dataset.shotAs, t.value, [UNID_HERBS.item])) { render('bank'); }
        return;
      }
    }
    const card = t.closest('[data-goal]');
    if (card && t.dataset.gopt) {
      const id = card.dataset.goal;
      updateGoal(id, g => {
        if (t.dataset.gopt === 'useBank') g.useBank = t.checked;
        if (t.dataset.gopt === 'assume') g.assume = t.checked ? (DEFAULT_ASSUME[g.skill] || []) : [];
        if (t.dataset.gopt === 'fill') g.fillId = t.value;
        if (t.dataset.gopt === 'roundUp') g.roundUp = t.checked;
        if (t.dataset.gopt === 'place') g.place = t.value;
        if (t.dataset.gopt === 'opt') {
          // a tick box that's on, or anything but the first of a list; the rest isn't kept
          const c = (CHOICES[g.skill] || []).find(x => x.id === t.dataset.opt);
          const v = !c ? null : c.options ? (c.options.slice(1).some(o => o.id === t.value) ? t.value : null) : (t.checked || null);
          const opts = { ...(g.opts || {}) };
          if (v) opts[t.dataset.opt] = v; else delete opts[t.dataset.opt];
          if (Object.keys(opts).length) g.opts = opts; else delete g.opts;
        }
      });
      renderGoals();
      return;
    }
    if (card && t.dataset.mix) {
      const n = parseAmount(t.value);
      if (n == null) { t.classList.add('bad'); return; }
      t.classList.remove('bad');
      updateGoal(card.dataset.goal, g => {
        g.mix = { ...(g.mix || {}) };
        if (n > 0) g.mix[t.dataset.mix] = n; else delete g.mix[t.dataset.mix];
        if (!Object.keys(g.mix).length) delete g.mix;
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
      renderPrices();
      return;
    }
    if (t.dataset.psrc) {
      const slug = t.dataset.psrc;
      if (t.value === 'mine' && prices.overrides[slug] == null) {     // nothing typed in yet: type it first
        renderPrices();
        document.querySelector(`[data-price="${slug}"]`)?.focus();
        return;
      }
      prices.setSource(slug, t.value);
      renderPrices();
      return;
    }
  }

  // Live value next to a bank amount while typing.
  function onInput(e) {
    const t = e.target;
    // (what's typed into a goal being changed survives a redraw)
    if (S.editing && t.name === 'value' && t.closest('[data-form="edit-goal"]')) { S.editing.draft = t.value; return; }
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

  // The tile's bar, once that skill has a goal: how far along the goal is (as on
  // the Goals tab: since you set it), in place of the bar to the next level.
  function tileGoalBar(profile, skill) {
    if (!profile || !S.account || profile.safe !== safe()) return '';
    const g = goals().find(x => x.skill === skill.key);
    const st = profile.stats[skill.id];
    if (!g || !st) return '';
    const cur = st.xp10 ?? st.xp * 10;
    // (a rank or top % goal: the XP of whoever holds that rank, once it's been looked up)
    const target = g.type === 'level' || g.type === 'xp' ? goalTargetXp10(g) : g.target?.xp10;
    if (target == null) return '';
    const reached = cur >= target;
    const start = g.startXp10 ?? cur;
    const p = reached ? 100 : pct(cur - start, target - start);
    const left = Math.max(0, Math.ceil((target - cur) / 10));
    const tip = reached ? 'Goal reached' : `${p.toFixed(1)}% of the way to your goal since you set it (${fmt(left)} XP to go)`;
    return `<div class="pbar goal-bar${reached ? ' maxed' : ''}" title="${esc(tip)}"><div style="width:${p.toFixed(1)}%"></div></div>`;
  }

  function summary() {
    const accounts = store.keys().filter(k => k.startsWith('goals.'));
    const count = accounts.reduce((a, k) => a + (store.get(k, []).length || 0), 0);
    const banks = store.keys().filter(k => k.startsWith('bank.')).length;
    return { goals: count, banks };
  }

  wire();
  return {
    render, show, rerender, tileGoal, tileGoalBar, summary,
    get account() { return S.account; },
    setAccount,
    reset() { S.account = null; S.profile = null; S.open.clear(); },
  };
}
