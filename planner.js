// Goal planning: how much XP a goal needs, what your bank already covers, and
// what's left to make or collect. No DOM here, so it runs in the page and in
// Node tests.
//
// All XP is in tenths (87.5 XP = 875), the unit the hiscores API and the game
// server use, so sums never drift.
//
// Methods come from gamedata.js. Each turns "in" items into "out" items, and has
// a kind:
//   xp     - what you train with
//   prep   - a step on the way (unfinished potions, grinding); a plan makes these
//            from their own inputs when they aren't in the bank
//   source - turns something already in the bank into an input (identifying
//            herbs, filling vials); used, but never put on a shopping list
// Any method with xp > 0 can be trained with, identifying herbs included.

import { XP_TABLE, MAX_LEVEL } from './skills.js';

export const MAX_XP10 = 2_000_000_000;       // 200m XP
const INF = Number.POSITIVE_INFINITY;

export const xp10ForLevel = level => (level <= 1 ? 0 : XP_TABLE[Math.min(Math.floor(level), MAX_LEVEL)] * 10);

export function levelForXp10(xp10) {
  for (let level = MAX_LEVEL; level > 1; level--) if (xp10 >= XP_TABLE[level] * 10) return level;
  return 1;
}

// ── Goals ─────────────────────────────────────────────────────────────────
// goal: { type: 'level' | 'xp' | 'rank' | 'top', value }
// Rank and top % goals mean "have more XP than whoever holds that rank now", so
// the caller looks that player's XP up (rankXp10) and the target is a tenth more.
export function goalTargetXp10(goal, { rankXp10 = null } = {}) {
  const v = Number(goal?.value);
  if (!Number.isFinite(v)) return null;
  if (goal.type === 'level') return xp10ForLevel(Math.max(2, Math.min(MAX_LEVEL, Math.floor(v))));
  if (goal.type === 'xp') return Math.max(0, Math.min(MAX_XP10, Math.round(v * 10)));
  if (goal.type === 'rank' || goal.type === 'top') return rankXp10 == null ? null : Math.min(MAX_XP10, rankXp10 + 1);
  return null;
}

// The rank that puts you in the top `pct` percent of `total` ranked players.
export const rankForTop = (pct, total) => Math.max(1, Math.floor((total * pct) / 100));

// ── Stock (a bank you can take from) ──────────────────────────────────────
export class Stock {
  constructor(items = {}) {
    this.q = new Map();
    for (const [k, v] of Object.entries(items)) if (v > 0) this.q.set(k, Math.floor(v));
  }
  have(item) { return this.q.get(item) || 0; }
  take(item, n) {
    const t = Math.min(this.have(item), n);
    if (t > 0) this.q.set(item, this.have(item) - t);
    return t;
  }
  add(item, n) { if (n > 0) this.q.set(item, this.have(item) + n); }
  clone() { const s = new Stock(); s.q = new Map(this.q); return s; }
  toObject() { return Object.fromEntries([...this.q].filter(([, v]) => v > 0)); }
}

// ── Method index ──────────────────────────────────────────────────────────
export function indexMethods(methods) {
  const byId = new Map(methods.map(m => [m.id, m]));
  const producers = new Map();        // item -> prep/source methods that make it
  for (const m of methods) {
    if (m.kind === 'xp') continue;
    for (const item of Object.keys(m.out)) {
      if (!producers.has(item)) producers.set(item, []);
      producers.get(item).push(m);
    }
  }
  const train = methods.filter(m => m.xp > 0);
  return { methods, byId, producers, train };
}

// ctx: { level, kinds: Set of producer kinds allowed, unlimited: Set of items }
const allowed = (p, ctx) => ctx.kinds.has(p.kind) && p.level <= ctx.level;

// How many of `item` the stock can provide, making more with allowed producers.
function avail(ix, item, stock, ctx, depth = 0) {
  if (ctx.unlimited.has(item)) return INF;
  let n = stock.have(item);
  if (depth > 6) return n;
  for (const p of ix.producers.get(item) || []) {
    if (allowed(p, ctx)) n += maxRuns(ix, p, stock, ctx, depth + 1) * p.out[item];
  }
  return n;
}

// How many times method m can be done from the stock (recipes are trees, so each
// input's supply can be worked out on its own).
export function maxRuns(ix, m, stock, ctx, depth = 0) {
  let runs = INF;
  for (const [item, q] of Object.entries(m.in)) {
    runs = Math.min(runs, Math.floor(avail(ix, item, stock, ctx, depth) / q));
    if (runs === 0) return 0;
  }
  return runs;
}

// Does m `runs` times, taking inputs from the stock and making what's missing
// with allowed producers. Only call with runs <= maxRuns. Returns the XP of every
// step (sub-steps included) and records them in log: { steps: {id: runs}, assumed: {item: n} }.
function perform(ix, m, runs, stock, ctx, log, depth = 0) {
  let xp = 0;
  for (const [item, q] of Object.entries(m.in)) {
    let missing = runs * q - stock.take(item, runs * q);
    for (const p of ix.producers.get(item) || []) {
      if (missing <= 0 || depth > 6) break;
      if (!allowed(p, ctx)) continue;
      const r = Math.min(Math.ceil(missing / p.out[item]), maxRuns(ix, p, stock, ctx, depth + 1));
      if (r <= 0) continue;
      xp += perform(ix, p, r, stock, ctx, log, depth + 1);
      missing -= stock.take(item, missing);
    }
    if (missing > 0) {
      if (!ctx.unlimited.has(item)) throw new Error(`perform: short of ${item}`);
      log.assumed[item] = (log.assumed[item] || 0) + missing;
    }
  }
  for (const [item, q] of Object.entries(m.out)) stock.add(item, runs * q);
  log.steps[m.id] = (log.steps[m.id] || 0) + runs;
  return xp + runs * m.xp;
}

// What doing m `runs` times needs beyond the stock, planned down to things you
// can buy or gather. Prep steps are expanded; sources only use what's there.
// Mutates stock. Returns { buy: {item: n}, steps: {id: runs}, xp }.
export function expand(ix, m, runs, stock, ctx) {
  const out = { buy: {}, steps: {}, xp: 0 };
  const go = (method, r, depth) => {
    out.steps[method.id] = (out.steps[method.id] || 0) + r;
    out.xp += r * method.xp;
    for (const [item, q] of Object.entries(method.in)) {
      let missing = r * q - stock.take(item, r * q);
      const makers = ix.producers.get(item) || [];
      for (const p of makers) {
        if (missing <= 0 || depth > 6 || p.kind !== 'source' || p.level > ctx.level) continue;
        const done = Math.min(Math.ceil(missing / p.out[item]), maxRuns(ix, p, stock, { ...ctx, kinds: BANK_KINDS }, depth + 1));
        if (done <= 0) continue;
        go(p, done, depth + 1);
        missing -= stock.take(item, missing);
      }
      const prep = depth <= 6 && makers.find(p => p.kind === 'prep');
      if (missing > 0 && prep) {
        go(prep, Math.ceil(missing / prep.out[item]), depth + 1);
        missing -= stock.take(item, missing);
      }
      if (missing > 0) out.buy[item] = (out.buy[item] || 0) + missing;
    }
    for (const [item, q] of Object.entries(method.out)) stock.add(item, r * q);
  };
  go(m, runs, 0);
  return out;
}
const BANK_KINDS = new Set(['prep', 'source']);

// ── Using the bank ────────────────────────────────────────────────────────
// Trains with what the bank holds, best XP per action first, until nothing more
// can be made. Stops to re-think whenever a better method unlocks on the way.
export function planBank(ix, { bank = {}, startXp10, targetXp10 = null, excluded = new Set(), unlimited = new Set() }) {
  const stock = new Stock(bank);
  const log = { steps: {}, assumed: {} };
  const steps = [];                           // [{ id, runs, xp10, sub: {id: runs} }] in order
  let xp = startXp10;
  let goalReached = null;                     // { step index, runs into that step }
  const usable = ix.train.filter(m => !excluded.has(m.id));

  for (let guard = 0; guard < 400; guard++) {
    const level = levelForXp10(xp);
    const ctx = { level, kinds: BANK_KINDS, unlimited };
    let best = null, bestRuns = 0;
    for (const m of usable) {
      if (m.level > level) continue;
      if (best && m.xp < best.xp) continue;
      const r = maxRuns(ix, m, stock, ctx);
      if (r > 0 && (!best || m.xp > best.xp || (m.xp === best.xp && m.level < best.level))) { best = m; bestRuns = r; }
    }
    if (!best) break;

    // A better method that unlocks later and could be made from this bank: only go
    // as far as its level, then look again.
    let runs = bestRuns;
    const better = usable.filter(m => m.level > level && m.xp > best.xp &&
      maxRuns(ix, m, stock, { level: m.level, kinds: BANK_KINDS, unlimited }) > 0);
    if (better.length) {
      const unlock = Math.min(...better.map(m => m.level));
      runs = Math.max(1, Math.min(runs, Math.ceil((xp10ForLevel(unlock) - xp) / best.xp)));
    }

    const before = { ...log.steps };
    const gained = perform(ix, best, runs, stock, ctx, log);
    const sub = {};
    for (const [id, n] of Object.entries(log.steps)) {
      const d = n - (before[id] || 0);
      if (d > 0 && id !== best.id) sub[id] = d;
    }
    if (goalReached == null && targetXp10 != null && xp + gained >= targetXp10) {
      const per = gained / runs;
      goalReached = { index: steps.length, runs: Math.max(1, Math.ceil((targetXp10 - xp) / per)) };
    }
    const last = steps[steps.length - 1];
    if (last && last.id === best.id) {
      last.runs += runs; last.xp10 += gained;
      for (const [id, n] of Object.entries(sub)) last.sub[id] = (last.sub[id] || 0) + n;
      if (goalReached && goalReached.index === steps.length) { goalReached.index = steps.length - 1; goalReached.runs += last.runs - runs; }
    } else {
      steps.push({ id: best.id, runs, xp10: gained, sub });
    }
    xp += gained;
  }

  // What came out of the bank: the difference between the bank and what's left,
  // counting only things that went down.
  const used = {};
  for (const [item, n] of Object.entries(bank)) {
    const d = Math.floor(n) - stock.have(item);
    if (d > 0) used[item] = d;
  }
  return {
    steps, used, assumed: log.assumed, leftover: stock,
    xp10: xp - startXp10, endXp10: xp, endLevel: levelForXp10(xp), goalReached,
  };
}

// ── Prices ────────────────────────────────────────────────────────────────
// priceOf(item) -> gp per item, or null when unknown.
function valueOf(items, priceOf) {
  let total = 0, missing = [];
  for (const [item, n] of Object.entries(items)) {
    if (!n) continue;
    const p = priceOf(item);
    if (p == null) missing.push(item);
    else total += p * n;
  }
  return { total, missing };
}

// Economics of one action of m, bought from scratch: what goes in (down to buyable
// items), what comes out, profit, and gp per XP (negative = you make money).
export function methodEconomics(ix, m, priceOf, { level = MAX_LEVEL, unlimited = new Set() } = {}) {
  const need = expand(ix, m, 1, new Stock(), { level, unlimited });
  const cost = valueOf(need.buy, priceOf);
  const value = valueOf(m.out, priceOf);
  const known = !cost.missing.length && !value.missing.length;
  const profit = value.total - cost.total;
  return {
    inputs: need.buy,
    cost: cost.total, value: value.total, missing: [...cost.missing, ...value.missing],
    profit: known ? profit : null,
    gpPerXp: known && m.xp > 0 ? -profit / (m.xp / 10) : null,
  };
}

// ── The whole plan for one goal ───────────────────────────────────────────
// opts: { bank, currentXp10, targetXp10, excluded (Set of method ids),
//         unlimited (Set of items that never hold you back, e.g. vials of water),
//         useBank, fillId (method to finish with), priceOf }
export function planGoal(ix, opts) {
  const {
    bank = {}, currentXp10, targetXp10, excluded = new Set(), unlimited = new Set(),
    useBank = true, fillId = null, priceOf = () => null,
  } = opts;
  const level = levelForXp10(currentXp10);
  const toGo = Math.max(0, targetXp10 - currentXp10);

  const fromBank = useBank
    ? planBank(ix, { bank, startXp10: currentXp10, targetXp10, excluded, unlimited })
    : { steps: [], used: {}, assumed: {}, leftover: new Stock(bank), xp10: 0, endXp10: currentXp10, endLevel: level, goalReached: null };

  // Then: what's still missing, with the method you pick.
  const afterXp = fromBank.endXp10;
  const afterLevel = levelForXp10(afterXp);
  const remaining = Math.max(0, targetXp10 - afterXp);
  let fill = null;
  if (remaining > 0) {
    const choices = ix.train.filter(m => !excluded.has(m.id));
    // Not chosen yet: carry on with what the bank was mostly making, else the
    // best XP you can get at that level.
    const mainFromBank = fromBank.steps
      .filter(s => ix.byId.get(s.id).kind === 'xp' && !excluded.has(s.id))
      .sort((a, b) => b.xp10 - a.xp10)[0];
    let method = (fillId && !excluded.has(fillId) && ix.byId.get(fillId))
      || (mainFromBank && ix.byId.get(mainFromBank.id))
      || bestAt(choices, afterLevel) || choices[0];
    if (method) {
      const stock = fromBank.leftover.clone();
      const segments = [];
      let xp = afterXp;
      // A method you can't do yet needs another one to get you to its level first.
      if (method.level > afterLevel) {
        const bridge = bestAt(choices.filter(m => m.id !== method.id), afterLevel);
        const upTo = Math.min(targetXp10, xp10ForLevel(method.level));
        if (bridge && upTo > xp) {
          const runs = Math.ceil((upTo - xp) / bridge.xp);
          segments.push({ id: bridge.id, runs, xp10: runs * bridge.xp, bridge: true });
          xp += runs * bridge.xp;
        }
      }
      if (xp < targetXp10) {
        const runs = Math.ceil((targetXp10 - xp) / method.xp);
        segments.push({ id: method.id, runs, xp10: runs * method.xp });
      }
      const buy = {}, steps = {};
      for (const s of segments) {
        const e = expand(ix, ix.byId.get(s.id), s.runs, stock, { level: MAX_LEVEL, unlimited });
        for (const [k, n] of Object.entries(e.buy)) buy[k] = (buy[k] || 0) + n;
        for (const [k, n] of Object.entries(e.steps)) steps[k] = (steps[k] || 0) + n;
      }
      const cost = valueOf(buy, priceOf);
      fill = { id: method.id, locked: method.level > afterLevel, segments, buy, steps, cost: cost.total, costMissing: cost.missing };
    }
  }

  // One row per method: what it takes on its own (like the calculator sites),
  // plus what your bank covers for it.
  const bankStock = new Stock(bank);
  const table = ix.train.map(m => {
    const needed = toGo > 0 ? Math.ceil(toGo / m.xp) : 0;
    const ctx = { level: Math.max(level, m.level), kinds: BANK_KINDS, unlimited };
    const have = useBank ? maxRuns(ix, m, bankStock, ctx) : 0;
    const collect = expand(ix, m, needed, bankStock.clone(), { level: MAX_LEVEL, unlimited }).buy;
    // Balance: the most you could make if every ingredient matched your most
    // plentiful one, and what that would take.
    let balance = null;
    if (useBank) {
      const limits = Object.keys(m.in).map(item => avail(ix, item, bankStock, ctx)).filter(Number.isFinite);
      const most = limits.length ? Math.max(...limits) : 0;
      if (most > have) {
        const extra = expand(ix, m, most, bankStock.clone(), { level: MAX_LEVEL, unlimited }).buy;
        for (const item of unlimited) delete extra[item];
        if (Object.keys(extra).length) balance = { runs: most, collect: extra };
      }
    }
    return {
      id: m.id, level: m.level, xp10: m.xp, locked: m.level > level,
      needed, have: Math.min(have, Number.MAX_SAFE_INTEGER), toMake: Math.max(0, needed - have),
      collect, balance,
      econ: methodEconomics(ix, m, priceOf, { unlimited: new Set() }),
    };
  });

  return { level, toGo, fromBank, afterXp10: afterXp, afterLevel, remaining, fill, table };
}

// Highest XP per action among methods you can do at `level`.
function bestAt(methods, level) {
  let best = null;
  for (const m of methods) if (m.level <= level && m.xp > 0 && (!best || m.xp > best.xp)) best = m;
  return best;
}

// Total value of a bank (items with no known price are listed separately).
export function bankValue(bank, priceOf) {
  return valueOf(bank, priceOf);
}
