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
//   source - turns something already in the bank into an input (filling vials);
//            used, but never put on a shopping list
// Any method with xp > 0 can be trained with. A method with no "in" at all is
// gathering (Woodcutting): the bank has nothing to give it.

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

// ── Outputs that grow with level ──────────────────────────────────────────
// What one action of m makes at `level`. Runecrafting makes more runes per
// essence as you level: floor(level / multiple) + 1, the server's own sum.
export function outAt(m, level) {
  if (!m.multiple) return m.out;
  const k = Math.floor(level / m.multiple) + 1;
  const out = {};
  for (const [item, q] of Object.entries(m.out)) out[item] = q * k;
  return out;
}

// What `runs` actions of m make, starting from startXp10, with the level (and so
// the runes per essence) going up on the way.
export function madeOver(m, runs, startXp10) {
  const made = {};
  const add = (out, n) => { for (const [item, q] of Object.entries(out)) made[item] = (made[item] || 0) + q * n; };
  if (!m.multiple || m.xp <= 0) { add(m.out, runs); return made; }
  let xp = startXp10, left = runs;
  while (left > 0) {
    const level = levelForXp10(xp);
    const n = level >= MAX_LEVEL ? left : Math.min(left, Math.max(1, Math.ceil((xp10ForLevel(level + 1) - xp) / m.xp)));
    add(outAt(m, level), n);
    xp += n * m.xp;
    left -= n;
  }
  return made;
}

// ── Method index ──────────────────────────────────────────────────────────
// Gathering takes nothing in (chopping a tree), so it never comes out of a bank.
export const gathers = m => Object.keys(m.in).length === 0;

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
  for (const [item, q] of Object.entries(outAt(m, ctx.level))) stock.add(item, runs * q);
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
    for (const [item, q] of Object.entries(outAt(method, ctx.level))) stock.add(item, r * q);
  };
  go(m, runs, 0);
  return out;
}
const BANK_KINDS = new Set(['prep', 'source']);

// ── Using the bank ────────────────────────────────────────────────────────
// Trains with what the bank holds until nothing more can be made.
// prefer: the method you picked to train with; it goes first whenever it can.
// With nothing picked, each method the bank can do is tried as the lead and the
// plan with the most XP wins. Best XP per action alone isn't enough once items
// are shared: feathers make 15 arrows from a log (42 XP) or one rune dart each
// (18.8 XP), and the darts are worth far more per feather.
export function planBank(ix, opts) {
  // Views redraw as prices arrive; the bank plan doesn't depend on prices, so
  // the last few are kept. (Callers only read the result.)
  const key = JSON.stringify([opts.bank || {}, opts.startXp10, opts.targetXp10 ?? null,
    [...(opts.excluded || [])].sort(), [...(opts.unlimited || [])].sort(), opts.prefer || null]);
  let memo = BANK_MEMO.get(ix);
  if (!memo) BANK_MEMO.set(ix, memo = new Map());
  if (memo.has(key)) return memo.get(key);

  let best = bankRun(ix, opts);
  if (!opts.prefer) {
    const stock = new Stock(opts.bank || {});
    const ctx = { level: MAX_LEVEL, kinds: BANK_KINDS, unlimited: opts.unlimited || new Set() };
    const excluded = opts.excluded || new Set();
    // Most XP per action first, so a tie keeps the plan that reads naturally.
    const leads = [...ix.train].sort((a, b) => b.xp - a.xp || a.level - b.level);
    for (const m of leads) {
      if (excluded.has(m.id) || gathers(m) || !maxRuns(ix, m, stock, ctx)) continue;
      const run = bankRun(ix, { ...opts, prefer: m.id });
      if (run.xp10 > best.xp10) best = run;
    }
  }
  memo.set(key, best);
  if (memo.size > 40) memo.delete(memo.keys().next().value);
  return best;
}
const BANK_MEMO = new WeakMap();

// One way through the bank: the pick first whenever it can be made, otherwise
// best XP per action. Stops to re-think whenever a better method unlocks.
function bankRun(ix, { bank = {}, startXp10, targetXp10 = null, excluded = new Set(), unlimited = new Set(), prefer = null }) {
  const stock = new Stock(bank);
  const log = { steps: {}, assumed: {} };
  const steps = [];                           // [{ id, runs, xp10, sub: {id: runs}, made: {item: n} }] in order
  let xp = startXp10;
  let goalReached = null;                     // { step index, runs into that step }
  const usable = ix.train.filter(m => !excluded.has(m.id) && !gathers(m));
  const pick = usable.find(m => m.id === prefer) || null;

  for (let guard = 0; guard < 400; guard++) {
    const level = levelForXp10(xp);
    const ctx = { level, kinds: BANK_KINDS, unlimited };
    let best = null, bestRuns = 0;
    if (pick && pick.xp > 0 && pick.level <= level) {
      const r = maxRuns(ix, pick, stock, ctx);
      if (r > 0) { best = pick; bestRuns = r; }
    }
    if (!best) {
      for (const m of usable) {
        if (m.level > level) continue;
        if (best && m.xp < best.xp) continue;
        const r = maxRuns(ix, m, stock, ctx);
        if (r > 0 && (!best || m.xp > best.xp || (m.xp === best.xp && m.level < best.level))) { best = m; bestRuns = r; }
      }
    }
    if (!best) break;

    // A better method (or the one you picked) that unlocks later and could be made
    // from this bank: only go as far as its level, then look again.
    let runs = bestRuns;
    if (best !== pick) {
      const better = usable.filter(m => m.level > level && (m.xp > best.xp || m === pick) &&
        maxRuns(ix, m, stock, { level: m.level, kinds: BANK_KINDS, unlimited }) > 0);
      if (better.length) {
        const unlock = Math.min(...better.map(m => m.level));
        runs = Math.max(1, Math.min(runs, Math.ceil((xp10ForLevel(unlock) - xp) / best.xp)));
      }
    }

    const made = madeOver(best, runs, xp);
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
      for (const [item, n] of Object.entries(made)) last.made[item] = (last.made[item] || 0) + n;
      if (goalReached && goalReached.index === steps.length) { goalReached.index = steps.length - 1; goalReached.runs += last.runs - runs; }
    } else {
      steps.push({ id: best.id, runs, xp10: gained, sub, made });
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

// What `made` is worth less what `buy` costs: { total, value, cost, missing }.
function gainOf(made, buy, priceOf) {
  const value = valueOf(made, priceOf), cost = valueOf(buy, priceOf);
  return { total: value.total - cost.total, value: value.total, cost: cost.total, missing: [...value.missing, ...cost.missing] };
}
// Things you said you'll buy as you go (vials of water) are left out of what to
// collect and of costs.
function without(items, leaveOut) {
  const out = { ...items };
  for (const k of leaveOut) delete out[k];
  return out;
}
const times = (out, n) => Object.fromEntries(Object.entries(out).map(([item, q]) => [item, q * n]));

// Economics of one action of m, bought from scratch: what goes in (down to buyable
// items), what comes out, profit, and gp per XP (negative = you make money).
export function methodEconomics(ix, m, priceOf, { level = MAX_LEVEL, unlimited = new Set() } = {}) {
  const need = without(expand(ix, m, 1, new Stock(), { level, unlimited }).buy, unlimited);
  const cost = valueOf(need, priceOf);
  const value = valueOf(outAt(m, level), priceOf);
  const known = !cost.missing.length && !value.missing.length;
  const profit = value.total - cost.total;
  return {
    inputs: need,
    cost: cost.total, value: value.total, missing: [...cost.missing, ...value.missing],
    profit: known ? profit : null,
    gpPerXp: known && m.xp > 0 ? -profit / (m.xp / 10) : null,
  };
}

// ── A mix you plan yourself ───────────────────────────────────────────────
// With the bank left out: how many of each you mean to make ({ method id: n }),
// made from scratch, lowest level first so the XP on the way counts. Each
// step says if it needs a level you won't have by then.
export function planMix(ix, mix, { startXp10, targetXp10 = null, unlimited = new Set(), priceOf = () => null } = {}) {
  const picks = Object.entries(mix || {})
    .map(([id, n]) => [ix.byId.get(id), Math.floor(Number(n))])
    .filter(([m, n]) => m && m.xp > 0 && n > 0)
    .sort(([a], [b]) => a.level - b.level || a.xp - b.xp);
  let xp = startXp10;
  const buy = {}, made = {};
  const steps = picks.map(([m, runs]) => {
    const level = levelForXp10(xp);
    const out = madeOver(m, runs, xp);
    const need = without(expand(ix, m, runs, new Stock(), { level: MAX_LEVEL, unlimited }).buy, unlimited);
    for (const [k, n] of Object.entries(need)) buy[k] = (buy[k] || 0) + n;
    for (const [k, n] of Object.entries(out)) made[k] = (made[k] || 0) + n;
    const step = { id: m.id, runs, xp10: runs * m.xp, made: out, buy: need, gain: gainOf(out, need, priceOf), levelAt: level, locked: m.level > level };
    xp += runs * m.xp;
    return step;
  });
  return {
    steps, buy, made, gain: gainOf(made, buy, priceOf),
    xp10: xp - startXp10, endXp10: xp, endLevel: levelForXp10(xp),
    reached: targetXp10 != null && steps.length > 0 && xp >= targetXp10,
  };
}

// ── The whole plan for one goal ───────────────────────────────────────────
// opts: { bank, currentXp10, targetXp10, excluded (Set of method ids),
//         unlimited (Set of items you'll buy as you go, e.g. vials of water: they
//         never hold a plan back, and are left out of what to collect and costs),
//         useBank, fillId (method to finish with), fillGroup (the group to pick
//         from when nothing is chosen, e.g. bows for Fletching), priceOf,
//         mix (with the bank left out: how many of each you plan to make) }
export function planGoal(ix, opts) {
  const {
    bank = {}, currentXp10, targetXp10, excluded = new Set(), unlimited = new Set(),
    useBank = true, fillId = null, fillGroup = null, priceOf = () => null, mix = null,
  } = opts;
  const level = levelForXp10(currentXp10);
  const toGo = Math.max(0, targetXp10 - currentXp10);

  // Your bank, or with it left out, nothing at all: the plan starts from scratch.
  const fromBank = useBank
    ? planBank(ix, { bank, startXp10: currentXp10, targetXp10, excluded, unlimited, prefer: fillId })
    : { steps: [], used: {}, assumed: {}, leftover: new Stock(), xp10: 0, endXp10: currentXp10, endLevel: level, goalReached: null };
  // Without the bank, a mix you plan yourself goes first.
  const fromMix = !useBank && mix && Object.values(mix).some(n => n > 0)
    ? planMix(ix, mix, { startXp10: currentXp10, targetXp10, unlimited, priceOf }) : null;

  // Then: what's still missing, with the method you pick.
  const afterXp = fromMix ? fromMix.endXp10 : fromBank.endXp10;
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
    // With a usual way to train (bows for Fletching), the bank's method only
    // carries on if it's one of those: leftover logs cut into bows (u) don't
    // make cutting the plan for the rest of the goal.
    const inGroup = g => choices.filter(m => m.group === g);
    const main = mainFromBank && ix.byId.get(mainFromBank.id);
    let method = (fillId && !excluded.has(fillId) && ix.byId.get(fillId))
      || (main && (!fillGroup || main.group === fillGroup) && main)
      || (fillGroup && bestAt(inGroup(fillGroup), afterLevel))
      || main
      || bestAt(choices, afterLevel) || choices[0];
    if (method) {
      const stock = fromBank.leftover.clone();
      const segments = [];
      let xp = afterXp;
      // A method you can't do yet needs others to get you to its level first: the
      // best one at each level on the way (willows to 45, maples to 60, then
      // yews), of the same sort where there is one (bows before bows).
      if (method.level > afterLevel) {
        const others = choices.filter(m => m.id !== method.id);
        const same = others.filter(m => m.group === method.group);
        const pool = bestAt(same, afterLevel) ? same : others;
        const upTo = Math.min(targetXp10, xp10ForLevel(method.level));
        while (xp < upTo) {
          const lv = levelForXp10(xp);
          const bridge = bestAt(pool, lv);
          if (!bridge) break;
          const better = pool.filter(m => m.level > lv && m.xp > bridge.xp).map(m => m.level);
          const stop = Math.min(upTo, better.length ? xp10ForLevel(Math.min(...better)) : upTo);
          const runs = Math.ceil((stop - xp) / bridge.xp);
          segments.push({ id: bridge.id, runs, xp10: runs * bridge.xp, bridge: true, toLevel: levelForXp10(xp + runs * bridge.xp), made: madeOver(bridge, runs, xp) });
          xp += runs * bridge.xp;
        }
      }
      if (xp < targetXp10) {
        const runs = Math.ceil((targetXp10 - xp) / method.xp);
        segments.push({ id: method.id, runs, xp10: runs * method.xp, made: madeOver(method, runs, xp) });
      }
      const all = {}, steps = {};
      for (const s of segments) {
        const e = expand(ix, ix.byId.get(s.id), s.runs, stock, { level: MAX_LEVEL, unlimited });
        for (const [k, n] of Object.entries(e.buy)) all[k] = (all[k] || 0) + n;
        for (const [k, n] of Object.entries(e.steps)) steps[k] = (steps[k] || 0) + n;
      }
      const buy = without(all, unlimited);
      const cost = valueOf(buy, priceOf);
      fill = { id: method.id, locked: method.level > afterLevel, segments, buy, steps, cost: cost.total, costMissing: cost.missing };
    }
  }

  // One row per method: how many on its own (like the calculator sites), and
  // what your bank covers for it. With the bank in use, "still" and "collect"
  // come after everything the bank plan makes: the XP left after it, made with
  // what's left in the bank. Without it they're the totals, from scratch.
  const bankStock = new Stock(bank);
  const after = useBank ? fromBank.leftover : new Stock();
  // What the bank plan makes of each method, as From your bank shows it: the
  // profit before any evening out.
  const bankMade = new Map(), bankRuns = new Map();
  if (useBank) {
    for (const st of fromBank.steps) {
      const acc = bankMade.get(st.id) || {};
      for (const [item, n] of Object.entries(st.made || {})) acc[item] = (acc[item] || 0) + n;
      bankMade.set(st.id, acc);
      bankRuns.set(st.id, (bankRuns.get(st.id) || 0) + st.runs);
    }
  }
  const table = ix.train.map(m => {
    const needed = toGo > 0 ? Math.ceil(toGo / m.xp) : 0;
    const lvl = Math.max(level, m.level);
    const ctx = { level: lvl, kinds: BANK_KINDS, unlimited };
    const have = useBank && !gathers(m) ? maxRuns(ix, m, bankStock, ctx) : 0;
    // Still needed: after everything the bank (or your mix) makes; with neither, all of them.
    const still = !useBank && !fromMix ? needed : remaining > 0 ? Math.ceil(remaining / m.xp) : 0;
    const collect = without(expand(ix, m, still, after.clone(), { level: MAX_LEVEL, unlimited }).buy, unlimited);
    // Balance: the most you could make if every ingredient matched your most
    // plentiful one, and what that would take. (In actions: a log of arrows
    // takes 15 feathers.)
    let balance = null;
    if (useBank && !gathers(m)) {
      const limits = Object.entries(m.in).map(([item, q]) => Math.floor(avail(ix, item, bankStock, ctx) / q)).filter(Number.isFinite);
      const most = limits.length ? Math.max(...limits) : 0;
      if (most > have) {
        const extra = without(expand(ix, m, most, bankStock.clone(), { level: MAX_LEVEL, unlimited }).buy, unlimited);
        if (Object.keys(extra).length) balance = { runs: most, collect: extra };
      }
    }
    // Totals, counting what's in your bank as already yours (gross): what the
    // bank makes of it once evened out, less what evening out takes; and what
    // the rest of the goal makes, less what's still to collect.
    const made = n => times(outAt(m, lvl), n);
    const gains = {
      even: !useBank || gathers(m) ? null
        : balance ? gainOf(made(balance.runs), balance.collect, priceOf)
        : have > 0 && Number.isFinite(have) ? gainOf(made(have), {}, priceOf) : null,
      collect: useBank && still > 0 ? gainOf(made(still), collect, priceOf) : null,
    };
    // The total net toward the goal: what the bank plan makes of it, before
    // evening out, plus the profit after buying the supplies still needed.
    // (Gross after using bank would count what evening out takes twice: the
    // supplies left in the bank go to the ones still needed as well.)
    gains.before = bankMade.has(m.id) ? gainOf(bankMade.get(m.id), {}, priceOf) : null;
    gains.net = gains.before || gains.collect ? {
      total: (gains.before?.total || 0) + (gains.collect?.total || 0),
      missing: [...(gains.before?.missing || []), ...(gains.collect?.missing || [])],
    } : null;
    return {
      id: m.id, level: m.level, xp10: m.xp, locked: m.level > level,
      needed, have: Math.min(have, Number.MAX_SAFE_INTEGER), fromPlan: bankRuns.get(m.id) || 0, toMake: still,
      planned: !useBank ? Math.max(0, Math.floor(Number(mix?.[m.id]) || 0)) : 0,
      collect, balance, gains,
      econ: methodEconomics(ix, m, priceOf, { level: lvl, unlimited }),
    };
  });

  return { level, toGo, fromBank, fromMix, afterXp10: afterXp, afterLevel, remaining, fill, table };
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
