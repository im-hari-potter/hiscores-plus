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
// feeds: an xp method whose product goes into another one (Crafting: a cut gem
// for a ring, molten glass for a vial). When a plan needs that product it stands
// in for a source: made on the way from what's in the bank, with its XP counted,
// and never put on a shopping list. Unticking it only stops it being made for
// its own sake: a ring you've left ticked still has its sapphire cut on the way.
// pays: inputs that are a fee (the tanner's coins). They're never taken from the
// bank and never hold a plan back; they're always a cost, at 1 gp each.
// magic: the Magic XP (in tenths) of the spell a method casts each time: an
// enchanted ring's row, or charging an orb on the way to a battlestaff. It isn't
// the skill's XP, so plans only report it (castsIn).
// opt: what a choice on the goal changes about a method (Smithing: a ring of
// forging, goldsmith gauntlets, where your bars come from). indexMethods applies
// the ones in use.
// through: a method that feeds, planned through from scratch as well, like a
// prep step, with its XP counted: the bars you smelt yourself on the way to a
// platebody. Then what's still to buy is ore, and it takes fewer platebodies.

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
// Amounts are whole numbers, except thread: a reel lasts five items, so an item
// takes 0.2 of one. These keep such sums exact; whole numbers pass through as
// they are.
const EPS = 1e-9;
const tidy = n => (Number.isInteger(n) ? n : Math.round(n * 1e6) / 1e6);
const amount = (runs, q) => (Number.isInteger(q) ? runs * q : tidy(runs * q));
const fits = (n, q) => (Number.isInteger(q) ? Math.floor(n / q) : Math.floor(n / q + EPS));

export class Stock {
  constructor(items = {}) {
    this.q = new Map();
    for (const [k, v] of Object.entries(items)) if (v > 0) this.q.set(k, Math.floor(v));
  }
  have(item) { return this.q.get(item) || 0; }
  take(item, n) {
    const t = Math.min(this.have(item), n);
    if (t > 0) this.q.set(item, tidy(this.have(item) - t));
    return t;
  }
  add(item, n) { if (n > 0) this.q.set(item, tidy(this.have(item) + n)); }
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

// What the choices in use make of a method: each one's opt entry, in order. in:
// what it takes instead; add: what it takes besides; note: said in place of the
// method's own (several are joined); anything else (xp, through, magic…) is set.
function withOptions(m, opts) {
  if (!m.opt) return m;
  let out = m;
  const notes = [];
  for (const key of opts) {
    const v = m.opt[key];
    if (!v) continue;
    const { in: instead, add, note, ...rest } = v;
    out = { ...out, ...rest, in: { ...(instead || out.in), ...(add || {}) } };
    if (note) notes.push(note);
  }
  return out === m || !notes.length ? out : { ...out, note: notes.join(' ') };
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// at: a place whose prices to use where a step has a choice (the Canifis tanner).
// opts: the choices in use ([ids], in the order they apply: see a method's opt).
export function indexMethods(methods, { at = null, opts = null } = {}) {
  if (at) methods = methods.map(m => (m.at?.[at] ? { ...m, in: { ...m.in, ...m.at[at] } } : m));
  if (opts && opts.length) methods = methods.map(m => withOptions(m, opts));
  const byId = new Map(methods.map(m => [m.id, m]));
  const producers = new Map();        // item -> prep/source methods that make it, and xp ones that feed
  for (const m of methods) {
    if (m.kind === 'xp' && !m.feeds) continue;
    for (const item of Object.keys(m.out)) {
      if (!producers.has(item)) producers.set(item, []);
      producers.get(item).push(m);
    }
  }
  const train = methods.filter(m => m.xp > 0);
  const fees = new Set(methods.flatMap(m => m.pays || []));
  // batch: a step on the way that makes several at once (a ring of forging is
  // 140 bars' worth) is costed over that many, so its share per item comes out right.
  let batch = 1;
  for (const list of producers.values()) for (const p of list) for (const n of Object.values(p.out)) if (Number.isInteger(n) && n > 1) batch = (batch * n) / gcd(batch, n);
  return { methods, byId, producers, train, feeds: methods.some(m => m.feeds), fees, through: methods.some(m => m.through), batch };
}
// A fee is worth what it is: a coin is 1 gp.
const priced = (ix, priceOf) => (ix.fees.size ? item => (ix.fees.has(item) ? 1 : priceOf(item)) : priceOf);
const feesOnly = (ix, items) => Object.fromEntries(Object.entries(items).filter(([item]) => ix.fees.has(item)));

// ctx: { level, kinds: Set of producer kinds allowed, unlimited: Set of items,
//        excluded: Set of method ids you've unticked (carried along; what's
//        made on the way doesn't look at it) }
// A feeding method counts as a source, ticked or not: unticking a row says not
// to make it for its own sake, and what a ticked row needs is still made on the
// way. (Up to v2.5.1 unticking stopped that too, so unticking Sapphire (cut)
// left uncut sapphires out of the rings as well.)
// (through: planned through from scratch too, so it counts as a prep step)
const producerKind = p => (p.through ? 'prep' : p.feeds ? 'source' : p.kind);
const allowed = (p, ctx) => ctx.kinds.has(producerKind(p)) && p.level <= ctx.level;

// How many of `item` the stock can provide, making more with allowed producers.
function avail(ix, item, stock, ctx, depth = 0) {
  if (ctx.unlimited.has(item) || ix.fees.has(item)) return INF;
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
    runs = Math.min(runs, fits(avail(ix, item, stock, ctx, depth), q));
    if (runs === 0) return 0;
  }
  return runs;
}

// Rounding up: how many of m its most plentiful ingredient would make, if the
// others were collected to match. What's made on the way from the bank counts
// rounded up too (sources, and methods that feed): 9 key teeth and 4 loops are
// 9 crystal keys' worth. Prep steps count as they are.
export function mostRuns(ix, m, stock, ctx, depth = 0) {
  let top = 0;
  for (const [item, q] of Object.entries(m.in)) {
    const n = fits(availMost(ix, item, stock, ctx, depth), q);
    if (Number.isFinite(n) && n > top) top = n;
  }
  return top;
}
function availMost(ix, item, stock, ctx, depth = 0) {
  if (ctx.unlimited.has(item) || ix.fees.has(item)) return INF;
  let n = stock.have(item);
  if (depth > 6) return n;
  for (const p of ix.producers.get(item) || []) {
    if (allowed(p, ctx)) n += (producerKind(p) === 'source' || p.through ? mostRuns : maxRuns)(ix, p, stock, ctx, depth + 1) * p.out[item];
  }
  return n;
}

// Does m `runs` times, taking inputs from the stock and making what's missing
// with allowed producers. Only call with runs <= maxRuns. Returns the XP of every
// step (sub-steps included) and records them in log: { steps: {id: runs}, assumed: {item: n} }.
function perform(ix, m, runs, stock, ctx, log, depth = 0) {
  let xp = 0;
  for (const [item, q] of Object.entries(m.in)) {
    const want = amount(runs, q);
    if (ix.fees.has(item)) { log.assumed[item] = (log.assumed[item] || 0) + want; continue; }     // paid, not taken from the bank
    let missing = tidy(want - stock.take(item, want));
    for (const p of ix.producers.get(item) || []) {
      if (missing <= EPS || depth > 6) break;
      if (!allowed(p, ctx)) continue;
      const r = Math.min(Math.ceil(missing / p.out[item]), maxRuns(ix, p, stock, ctx, depth + 1));
      if (r <= 0) continue;
      xp += perform(ix, p, r, stock, ctx, log, depth + 1);
      missing = tidy(missing - stock.take(item, missing));
    }
    if (missing > EPS) {
      if (!ctx.unlimited.has(item)) throw new Error(`perform: short of ${item}`);
      log.assumed[item] = (log.assumed[item] || 0) + missing;
    }
  }
  for (const [item, q] of Object.entries(outAt(m, ctx.level))) stock.add(item, runs * q);
  log.steps[m.id] = (log.steps[m.id] || 0) + runs;
  return xp + runs * m.xp;
}

// What doing m `runs` times needs beyond the stock, planned down to things you
// can buy or gather. Prep steps are expanded; sources (and methods that feed)
// only use what's there. With ctx.most they're rounded up instead: made as many
// times as their most plentiful ingredient allows, the rest of what they take
// bought (5 loops for the 9 teeth). Fees are always bought.
// Mutates stock. Returns { buy: {item: n}, steps: {id: runs}, xp }.
export function expand(ix, m, runs, stock, ctx) {
  const out = { buy: {}, steps: {}, xp: 0 };
  const go = (method, r, depth) => {
    out.steps[method.id] = (out.steps[method.id] || 0) + r;
    out.xp += r * method.xp;
    for (const [item, q] of Object.entries(method.in)) {
      const want = amount(r, q);
      if (ix.fees.has(item)) { out.buy[item] = tidy((out.buy[item] || 0) + want); continue; }
      let missing = tidy(want - stock.take(item, want));
      const makers = ix.producers.get(item) || [];
      for (const p of makers) {
        if (missing <= EPS || depth > 6 || producerKind(p) !== 'source' || p.level > ctx.level) continue;
        const done = Math.min(Math.ceil(missing / p.out[item]), (ctx.most ? mostRuns : maxRuns)(ix, p, stock, { ...ctx, kinds: BANK_KINDS }, depth + 1));
        if (done <= 0) continue;
        go(p, done, depth + 1);
        missing = tidy(missing - stock.take(item, missing));
      }
      const prep = depth <= 6 && makers.find(p => producerKind(p) === 'prep');
      if (missing > EPS && prep) {
        go(prep, Math.ceil(missing / prep.out[item]), depth + 1);
        missing = tidy(missing - stock.take(item, missing));
      }
      if (missing > EPS) out.buy[item] = tidy((out.buy[item] || 0) + missing);
    }
    for (const [item, q] of Object.entries(outAt(method, ctx.level))) stock.add(item, r * q);
  };
  go(m, runs, 0);
  return out;
}
const BANK_KINDS = new Set(['prep', 'source']);

// The XP one action of m gives from scratch, with what's planned through on the
// way counted: a rune platebody and the five bars smelted for it. It's the
// method's own XP unless the index plans its feeders through (ix.through).
const EACH = new WeakMap();
const NONE = new Set();
export function xpEach(ix, m) {
  if (!ix.through) return m.xp;
  let memo = EACH.get(ix);
  if (!memo) EACH.set(ix, memo = new Map());
  if (!memo.has(m.id)) memo.set(m.id, expand(ix, m, 1, new Stock(), { level: MAX_LEVEL, unlimited: NONE }).xp);
  return memo.get(m.id);
}
// The fewest actions of m that give `need` XP, made from the stock (left as it
// is) and planned through beyond it. Bars already in the stock aren't smelted,
// so they add nothing: it can take more than from scratch, never more than the
// method's own XP asks for.
function fewest(ix, m, need, stock, ctx) {
  let hi = Math.max(1, Math.ceil(need / m.xp));
  if (!ix.through) return hi;
  let lo = Math.max(1, Math.ceil(need / xpEach(ix, m)));
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (expand(ix, m, mid, stock.clone(), ctx).xp >= need) hi = mid; else lo = mid + 1;
  }
  return lo;
}

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
    [...(opts.excluded || [])].sort(), [...(opts.unlimited || [])].sort(), opts.prefer || null, opts.roundUp || null,
    [...(opts.minor || [])].sort()]);
  let memo = BANK_MEMO.get(ix);
  if (!memo) BANK_MEMO.set(ix, memo = new Map());
  if (memo.has(key)) return memo.get(key);

  let best = bankRun(ix, opts), led = opts.prefer || null;
  if (!opts.prefer && !opts.roundUp) {
    const stock = new Stock(opts.bank || {});
    const excluded = opts.excluded || new Set();
    const ctx = { level: MAX_LEVEL, kinds: BANK_KINDS, unlimited: opts.unlimited || new Set(), excluded };
    // Most XP per action first, so a tie keeps the plan that reads naturally.
    const leads = [...ix.train].sort((a, b) => b.xp - a.xp || a.level - b.level);
    for (const m of leads) {
      if (excluded.has(m.id) || gathers(m) || !maxRuns(ix, m, stock, ctx)) continue;
      const run = bankRun(ix, { ...opts, prefer: m.id });
      if (run.xp10 > best.xp10) { best = run; led = m.id; }
    }
  }
  LED.set(best, led);
  memo.set(key, best);
  if (memo.size > 40) memo.delete(memo.keys().next().value);
  return best;
}
const BANK_MEMO = new WeakMap();
const LED = new WeakMap();                    // a bank plan -> the method that went first in it, if one did

// One way through the bank: the pick first whenever it can be made, otherwise
// best XP per action. Stops to re-think whenever a better method unlocks.
//
// roundUp (Round up my supplies): { first: the method you picked to train with,
// if you did, also: [method ids] }. Rounding a method up means making it as many
// times as its most plentiful ingredient allows, and collecting whatever else
// that takes (it's listed). The one you picked is rounded up from the start: it
// goes first whenever it can, and now it can. The rest of the bank is used as
// usual; then what that leaves is rounded up: first with the methods the plan
// made (and those in also), then with anything else that's no more than one
// ingredient short, best XP first. After that, the rest as usual. Steps after
// the bank's own are marked rounded.
// minor: the cheap supplies (vials of water, thread). Rounding up, they never
// hold anything back, from the first step on: the plan is the one you'd get
// buying them as you go. When you count them instead, what it uses beyond your
// bank is collected like the rest (and not in assumed).
function bankRun(ix, { bank = {}, startXp10, targetXp10 = null, excluded = new Set(), unlimited: counting = new Set(), prefer = null, roundUp = null, minor = null }) {
  const unlimited = roundUp ? looseWith(counting, minor) : counting;
  const counted = [...unlimited].filter(k => !counting.has(k));      // cheap supplies you count: collected when short
  const stock = new Stock(bank);
  const log = { steps: {}, assumed: {} };
  const steps = [];                           // [{ id, runs, xp10, sub: {id: runs}, made: {item: n} }] in order
  let xp = startXp10;
  let goalReached = null;                     // { step index, runs into that step }
  const all = ix.train.filter(m => !excluded.has(m.id) && !gathers(m));
  // Rounding up, in stages: 0 the bank as usual, 1 rounding up what that made,
  // 2 rounding up what else is an ingredient short, 3 as usual again.
  let stage = 0, pool = null;                 // pool: the methods being rounded up in stages 1 and 2
  const first = (roundUp && all.find(m => m.id === roundUp.first)) || null;
  const rounding = m => stage === 1 || stage === 2 || m === first;
  const collected = {};
  const most = (m, c) => mostRuns(ix, m, stock, c);
  const can = (m, c) => (rounding(m) ? most(m, c) : maxRuns(ix, m, stock, c));
  const nextStage = () => {
    stage++;
    const mine = new Set([...(roundUp.also || []), ...steps.map(s => s.id)]);
    if (stage === 1) pool = all.filter(m => mine.has(m.id));
    if (stage === 2) {
      // Whatever level it takes: it only gets made once you're there.
      const any = { level: MAX_LEVEL, kinds: BANK_KINDS, unlimited, excluded };
      const short = m => Object.entries(m.in).filter(([item, q]) => fits(availMost(ix, item, stock, any), q) === 0).length;
      pool = all.filter(m => !mine.has(m.id) && short(m) <= 1 && most(m, any) > 0);
    }
  };
  // Makes m n times; rounding up, what's short for that is collected first.
  // Returns [XP, how many were made].
  const make = (m, n, stk, c, lg, got) => {
    if (rounding(m)) {
      const short = without(expand(ix, m, n, stk.clone(), { level: c.level, unlimited, excluded, most: true }).buy, [...unlimited, ...ix.fees]);
      for (const [item, k] of Object.entries(short)) { stk.add(item, k); if (got) got[item] = tidy((got[item] || 0) + k); }
      n = Math.min(n, maxRuns(ix, m, stk, c));      // (a step on the way that needs a higher level: none in the data)
      if (n <= 0) return [0, 0];
    }
    return [perform(ix, m, n, stk, c, lg), n];
  };

  for (let guard = 0; guard < 400; guard++) {
    const level = levelForXp10(xp);
    const ctx = { level, kinds: BANK_KINDS, unlimited, excluded };
    const usable = stage === 1 || stage === 2 ? pool : all;
    const pick = usable.find(m => m.id === prefer) || null;
    let best = null, bestRuns = 0;
    if (pick && pick.xp > 0 && pick.level <= level) {
      const r = can(pick, ctx);
      if (r > 0) { best = pick; bestRuns = r; }
    }
    if (!best) {
      for (const m of usable) {
        if (m.level > level) continue;
        if (best && m.xp < best.xp) continue;
        const r = can(m, ctx);
        if (r > 0 && (!best || m.xp > best.xp || (m.xp === best.xp && m.level < best.level))) { best = m; bestRuns = r; }
      }
    }
    if (!best) {
      if (!roundUp || stage === 3) break;
      nextStage();
      continue;
    }

    // A better method (or the one you picked) that unlocks later and could be made
    // from this bank: only go as far as its level, then look again.
    let runs = bestRuns;
    if (best !== pick) {
      const better = usable.filter(m => m.level > level && (m.xp > best.xp || m === pick) &&
        can(m, { level: m.level, kinds: BANK_KINDS, unlimited, excluded }) > 0);
      if (better.length) {
        const unlock = Math.min(...better.map(m => m.level));
        const toUnlock = xp10ForLevel(unlock) - xp;
        runs = Math.max(1, Math.min(runs, Math.ceil(toUnlock / best.xp)));
        // What's made on the way (gems cut for the rings) gives XP too, so it
        // can take fewer: the fewest that get there.
        if (ix.feeds && runs > 1) {
          const xpOf = n => make(best, n, stock.clone(), ctx, { steps: {}, assumed: {} }, null)[0];
          if (xpOf(runs) > runs * best.xp) {
            let lo = 1, hi = runs;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (xpOf(mid) >= toUnlock) hi = mid; else lo = mid + 1;
            }
            runs = lo;
          }
        }
      }
    }

    const before = { ...log.steps }, usedBefore = { ...log.assumed };
    const got = {};                             // collected for this step (rounding up)
    const [gained, did] = make(best, runs, stock, ctx, log, got);
    const beyond = item => tidy((log.assumed[item] || 0) - (usedBefore[item] || 0));     // used that wasn't in the bank
    for (const item of counted) { const d = beyond(item); if (d > EPS) got[item] = tidy((got[item] || 0) + d); }
    for (const [item, n] of Object.entries(got)) collected[item] = tidy((collected[item] || 0) + n);
    const paid = {};                            // fees this step paid (the tanner's)
    for (const item of ix.fees) { const d = beyond(item); if (d > 0) paid[item] = d; }
    if (!did) { usable.splice(usable.indexOf(best), 1); continue; }
    runs = did;
    const made = madeOver(best, runs, xp);
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
    if (last && last.id === best.id && !last.rounded === !stage) {
      last.runs += runs; last.xp10 += gained;
      for (const [id, n] of Object.entries(sub)) last.sub[id] = (last.sub[id] || 0) + n;
      for (const [item, n] of Object.entries(made)) last.made[item] = (last.made[item] || 0) + n;
      for (const [item, n] of Object.entries(got)) (last.collect ||= {})[item] = tidy((last.collect[item] || 0) + n);
      for (const [item, n] of Object.entries(paid)) (last.paid ||= {})[item] = (last.paid[item] || 0) + n;
      if (goalReached && goalReached.index === steps.length) { goalReached.index = steps.length - 1; goalReached.runs += last.runs - runs; }
    } else {
      steps.push({ id: best.id, runs, xp10: gained, sub, made, ...(stage ? { rounded: true } : {}),
        ...(Object.keys(got).length ? { collect: got } : {}), ...(Object.keys(paid).length ? { paid } : {}) });
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
  // What it used that wasn't in the bank: things you buy as you go (assumed), and fees paid.
  const paid = feesOnly(ix, log.assumed);
  if (counted.length) for (const s of steps) if (s.collect) s.collect = minorLast(s.collect, minor);
  return {
    steps, used, assumed: without(log.assumed, [...ix.fees, ...counted]), leftover: stock,
    xp10: xp - startXp10, endXp10: xp, endLevel: levelForXp10(xp), goalReached,
    ...(Object.keys(paid).length ? { paid } : {}),
    ...(roundUp ? { collect: counted.length ? minorLast(collected, minor) : collected } : {}),
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
// The cheap supplies (minor: vials of water, thread) never hold rounding up
// back, whether you buy them as you go or count them: herbs with no vials left
// are still made into potions. Counted, the ones you're short of are collected
// with the rest. looseWith: what never holds a rounded-up plan back.
const looseWith = (unlimited, minor) => (minor && [...minor].some(k => !unlimited.has(k)) ? new Set([...unlimited, ...minor]) : unlimited);
// In a list of what to collect, they go last.
export const minorLast = (items, minor) => (!minor || !minor.size ? items
  : Object.fromEntries(Object.entries(items).sort(([a], [b]) => minor.has(a) - minor.has(b))));

// Economics of one action of m, bought from scratch: what goes in (down to buyable
// items), what comes out, the net (worth less cost: negative is a loss), and gp
// per XP (negative = you make money).
export function methodEconomics(ix, m, priceOf, { level = MAX_LEVEL, unlimited = new Set() } = {}) {
  priceOf = priced(ix, priceOf);
  // (over a batch where a step on the way makes several at once: a ring of
  // forging's share of one bar is a 140th of a ring, not a whole one)
  const n = ix.batch || 1;
  const all = without(expand(ix, m, n, new Stock(), { level, unlimited }).buy, unlimited);
  const need = n === 1 ? all : Object.fromEntries(Object.entries(all).map(([item, q]) => [item, q / n]));
  const cost = valueOf(need, priceOf);
  const value = valueOf(outAt(m, level), priceOf);
  const known = !cost.missing.length && !value.missing.length;
  const net = value.total - cost.total;
  const xp = xpEach(ix, m);
  return {
    inputs: need,
    cost: cost.total, value: value.total, missing: [...cost.missing, ...value.missing],
    net: known ? net : null,
    gpPerXp: known && xp > 0 ? -net / (xp / 10) : null,
  };
}

// ── A mix you plan yourself ───────────────────────────────────────────────
// With the bank left out: how many of each you mean to make ({ method id: n }),
// made from scratch, lowest level first so the XP on the way counts. Each
// step says if it needs a level you won't have by then.
export function planMix(ix, mix, { startXp10, targetXp10 = null, unlimited = new Set(), priceOf = () => null } = {}) {
  priceOf = priced(ix, priceOf);
  const picks = Object.entries(mix || {})
    .map(([id, n]) => [ix.byId.get(id), Math.floor(Number(n))])
    .filter(([m, n]) => m && m.xp > 0 && n > 0)
    .sort(([a], [b]) => a.level - b.level || a.xp - b.xp);
  let xp = startXp10;
  const buy = {}, made = {};
  const steps = picks.map(([m, runs]) => {
    const level = levelForXp10(xp);
    const out = madeOver(m, runs, xp);
    const e = expand(ix, m, runs, new Stock(), { level: MAX_LEVEL, unlimited });
    const need = without(e.buy, unlimited);
    for (const [k, n] of Object.entries(need)) buy[k] = (buy[k] || 0) + n;
    for (const [k, n] of Object.entries(out)) made[k] = (made[k] || 0) + n;
    const casts = castsIn(ix, Object.entries(e.steps));
    // (bars smelted on the way count, when you make your own)
    const gained = ix.through ? e.xp : runs * m.xp;
    const step = { id: m.id, runs, xp10: gained, made: out, buy: need, gain: gainOf(out, need, priceOf), levelAt: level, locked: m.level > level,
      ...(casts ? { casts: casts.by } : {}), ...(ix.through ? subOf(e.steps, m.id) : {}) };
    xp += gained;
    return step;
  });
  // What one row of your mix makes for another (sapphires you cut, then set in
  // rings) is used, not bought as well. Each step still shows its own, from scratch.
  for (const step of steps) {
    if (!ix.byId.get(step.id).feeds) continue;
    for (const item of Object.keys(step.made)) {
      const n = Math.min(buy[item] || 0, made[item] || 0);
      if (n <= 0) continue;
      if ((buy[item] -= n) <= 0) delete buy[item];
      if ((made[item] -= n) <= 0) delete made[item];
    }
  }
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
//         mix (with the bank left out: how many of each you plan to make),
//         roundUp (Round up my supplies: after the bank plan, what it leaves
//         in your bank is used up too, with what's missing for that collected),
//         minor (Set of the cheap supplies, vials of water and thread: rounding
//         up, they never hold anything back, bought as you go or not) }
export function planGoal(ix, opts) {
  const {
    bank = {}, currentXp10, targetXp10, excluded = new Set(), unlimited = new Set(),
    useBank = true, fillId = null, fillGroup = null, mix = null, roundUp = false, minor = null,
  } = opts;
  const loose = looseWith(unlimited, minor);    // what never holds rounding up back
  const priceOf = priced(ix, opts.priceOf || (() => null));
  const level = levelForXp10(currentXp10);
  const toGo = Math.max(0, targetXp10 - currentXp10);

  // The method a plan trains with once the bank is used up: the one you picked;
  // not chosen yet, it carries on with what the bank was mostly making, else the
  // best XP you can get at that level.
  const choices = ix.train.filter(m => !excluded.has(m.id));
  const methodFor = (fb, lvl) => {
    const mainFromBank = fb.steps
      .filter(s => ix.byId.get(s.id).kind === 'xp' && !excluded.has(s.id))
      .sort((a, b) => b.xp10 - a.xp10)[0];
    // With a usual way to train (bows for Fletching), the bank's method only
    // carries on if it's one of those: leftover logs cut into bows (u) don't
    // make cutting the plan for the rest of the goal.
    const inGroup = g => choices.filter(m => m.group === g);
    const main = mainFromBank && ix.byId.get(mainFromBank.id);
    return (fillId && !excluded.has(fillId) && ix.byId.get(fillId))
      || (main && (!fillGroup || main.group === fillGroup) && main)
      || (fillGroup && bestAt(inGroup(fillGroup), lvl))
      || main
      || bestAt(choices, lvl) || choices[0];
  };

  // Your bank, or with it left out, nothing at all: the plan starts from scratch.
  const bankNow = useBank
    ? planBank(ix, { bank, startXp10: currentXp10, targetXp10, excluded, unlimited, prefer: fillId })
    : { steps: [], used: {}, assumed: {}, leftover: new Stock(), xp10: 0, endXp10: currentXp10, endLevel: level, goalReached: null };
  // Round up my supplies: the same plan, then what it leaves in your bank rounded
  // up (the steps marked rounded). What that takes beyond the bank is collected
  // (fromBank.collect). The one you picked to train with is rounded up from the
  // start; not picked, the one the plan carries on with joins in at the end even
  // if your bank can't make any of it yet.
  // (Counting your vials, it starts from the plan you'd get buying them as you go.)
  const usual = useBank && roundUp && loose !== unlimited
    ? planBank(ix, { bank, startXp10: currentXp10, targetXp10, excluded, unlimited: loose, prefer: fillId }) : bankNow;
  const lead = useBank && roundUp ? methodFor(usual, usual.endLevel) || null : null;
  const fromBank = useBank && roundUp
    ? planBank(ix, { bank, startXp10: currentXp10, targetXp10, excluded, unlimited, prefer: LED.get(usual) || null,
      roundUp: { first: lead && lead.id === fillId ? fillId : null, also: lead ? [lead.id] : [] }, minor })
    : bankNow;
  // Without the bank, a mix you plan yourself goes first.
  const fromMix = !useBank && mix && Object.values(mix).some(n => n > 0)
    ? planMix(ix, mix, { startXp10: currentXp10, targetXp10, unlimited, priceOf }) : null;

  // Then: what's still missing, with the method you pick.
  const afterXp = fromMix ? fromMix.endXp10 : fromBank.endXp10;
  const afterLevel = levelForXp10(afterXp);
  const remaining = Math.max(0, targetXp10 - afterXp);
  let fill = null;
  if (remaining > 0) {
    // (rounded up, it's the same method as without)
    const method = lead || methodFor(fromBank, afterLevel);
    if (method) {
      const stock = fromBank.leftover.clone();
      const segments = [];
      let xp = afterXp;
      const all = {}, steps = {};
      const scratch = { level: MAX_LEVEL, unlimited, excluded };
      // One stretch: the fewest of m that give `need` XP, made from what's left
      // over and bought beyond it. When you make your own bars (ix.through) the
      // ones smelted on the way count, so it takes fewer, and the stretch says so.
      const stretch = (m, need, bridge) => {
        const runs = fewest(ix, m, need, stock, scratch);
        const e = expand(ix, m, runs, stock, scratch);
        for (const [k, n] of Object.entries(e.buy)) all[k] = (all[k] || 0) + n;
        for (const [k, n] of Object.entries(e.steps)) steps[k] = (steps[k] || 0) + n;
        const gained = ix.through ? e.xp : runs * m.xp;
        segments.push({ id: m.id, runs, xp10: gained, ...(bridge ? { bridge: true, toLevel: levelForXp10(xp + gained) } : {}), made: madeOver(m, runs, xp),
          ...(ix.through ? subOf(e.steps, m.id) : {}) });
        xp += gained;
      };
      // A method you can't do yet needs others to get you to its level first: the
      // best one at each level on the way (willows to 45, maples to 60, then
      // yews), of the same sort where there is one (bows before bows).
      const each = m => xpEach(ix, m);
      if (method.level > afterLevel) {
        const others = choices.filter(m => m.id !== method.id);
        const same = others.filter(m => m.group === method.group);
        const pool = bestAt(same, afterLevel, each) ? same : others;
        const upTo = Math.min(targetXp10, xp10ForLevel(method.level));
        while (xp < upTo) {
          const lv = levelForXp10(xp);
          const bridge = bestAt(pool, lv, each);
          if (!bridge) break;
          const better = pool.filter(m => m.level > lv && each(m) > each(bridge)).map(m => m.level);
          const stop = Math.min(upTo, better.length ? xp10ForLevel(Math.min(...better)) : upTo);
          stretch(bridge, stop - xp, true);
        }
      }
      if (xp < targetXp10) stretch(method, targetXp10 - xp, false);
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
  // gross before any rounding up.
  const bankMade = new Map(), bankRuns = new Map(), bankCollect = new Map();     // (bankCollect: collected for it, and fees paid)
  if (useBank) {
    for (const st of fromBank.steps) {
      const acc = bankMade.get(st.id) || {};
      for (const [item, n] of Object.entries(st.made || {})) acc[item] = (acc[item] || 0) + n;
      bankMade.set(st.id, acc);
      bankRuns.set(st.id, (bankRuns.get(st.id) || 0) + st.runs);
      // what was collected for it (rounding up) and paid in fees, which come off what it's worth
      for (const taken of [st.collect, st.paid]) {
        if (!taken) continue;
        const got = bankCollect.get(st.id) || {};
        for (const [item, n] of Object.entries(taken)) got[item] = tidy((got[item] || 0) + n);
        bankCollect.set(st.id, got);
      }
    }
  }
  const table = ix.train.map(m => {
    // (from scratch, with the bars smelted on the way counted when you make your own)
    const each = xpEach(ix, m);
    const needed = toGo > 0 ? Math.ceil(toGo / each) : 0;
    const lvl = Math.max(level, m.level);
    const ctx = { level: lvl, kinds: BANK_KINDS, unlimited, excluded };
    const have = useBank && !gathers(m) ? maxRuns(ix, m, bankStock, ctx) : 0;
    // Still needed: after everything the bank (or your mix) makes; with neither, all of them.
    const still = !useBank && !fromMix ? needed : remaining > 0 ? fewest(ix, m, remaining, after, { level: MAX_LEVEL, unlimited, excluded }) : 0;
    const collect = without(expand(ix, m, still, after.clone(), { level: MAX_LEVEL, unlimited, excluded }).buy, unlimited);
    // Balance: the most you could make if every ingredient matched your most
    // plentiful one, and what that would take. (In actions: a log of arrows
    // takes 15 feathers.)
    let balance = null;
    // (fees paid on the way to those: the tanner's)
    const paidFor = n => (ix.fees.size && n > 0 && Number.isFinite(n)
      ? feesOnly(ix, expand(ix, m, n, bankStock.clone(), { level: MAX_LEVEL, unlimited: loose, excluded, most: true }).buy) : {});
    if (useBank && !gathers(m)) {
      const most = mostRuns(ix, m, bankStock, loose === unlimited ? ctx : { ...ctx, unlimited: loose });
      if (most > have) {
        const extra = without(expand(ix, m, most, bankStock.clone(), { level: MAX_LEVEL, unlimited: loose, excluded, most: true }).buy, [...unlimited, ...ix.fees]);
        const paid = paidFor(most);
        if (Object.keys(extra).length) balance = { runs: most, collect: minorLast(extra, minor), ...(Object.keys(paid).length ? { paid } : {}) };
      }
    }
    // Totals, counting what's in your bank as already yours: what the bank
    // makes of it once rounded up, less what rounding up takes (Net after
    // rounding up my supplies); and what the rest of the goal makes, less what's
    // still to collect (Net after buying supplies).
    const made = n => times(outAt(m, lvl), n);
    const gains = {
      even: !useBank || gathers(m) ? null
        : balance ? gainOf(made(balance.runs), { ...balance.collect, ...balance.paid }, priceOf)
        : have > 0 && Number.isFinite(have) ? gainOf(made(have), paidFor(have), priceOf) : null,
      collect: useBank && still > 0 ? gainOf(made(still), collect, priceOf) : null,
    };
    // The total net toward the goal: what the bank plan makes of it, before
    // rounding up (Gross from banked supplies), plus the net after buying the
    // supplies still needed. (Net after rounding up would count what rounding up
    // takes twice: the supplies left in the bank go to the ones still needed
    // as well.)
    gains.before = bankMade.has(m.id) ? gainOf(bankMade.get(m.id), bankCollect.get(m.id) || {}, priceOf) : null;
    gains.net = gains.before || gains.collect ? {
      total: (gains.before?.total || 0) + (gains.collect?.total || 0),
      missing: [...(gains.before?.missing || []), ...(gains.collect?.missing || [])],
    } : null;
    return {
      id: m.id, level: m.level, xp10: m.xp, ...(each !== m.xp ? { xpAll: each } : {}), locked: m.level > level,
      needed, have: Math.min(have, Number.MAX_SAFE_INTEGER), fromPlan: bankRuns.get(m.id) || 0, toMake: still,
      planned: !useBank ? Math.max(0, Math.floor(Number(mix?.[m.id]) || 0)) : 0,
      collect, balance, gains,
      econ: methodEconomics(ix, m, priceOf, { level: lvl, unlimited }),
    };
  });

  return {
    level, toGo, fromBank, fromMix, afterXp10: afterXp, afterLevel, remaining, fill, table,
    // rounded up: what the bank makes as it is, to set beside it
    ...(useBank && roundUp ? { bankNow } : {}),
  };
}

// Highest XP per action among methods you can do at `level` (xpOf: the XP that
// counts, when it isn't just the method's own).
function bestAt(methods, level, xpOf = m => m.xp) {
  let best = null;
  for (const m of methods) if (m.level <= level && m.xp > 0 && (!best || xpOf(m) > xpOf(best))) best = m;
  return best;
}
// What was made on the way to a step: { sub: { method id: runs } }, or nothing.
function subOf(steps, id) {
  const sub = Object.fromEntries(Object.entries(steps).filter(([k]) => k !== id));
  return Object.keys(sub).length ? { sub } : {};
}

// Total value of a bank (items with no known price are listed separately).
export function bankValue(bank, priceOf) {
  return valueOf(bank, priceOf);
}

// The spells cast on the way, and the Magic XP they give. counts: [[method id,
// how many]] (a plan's steps and what was made on the way to them). Returns
// null when there are none, else { xp10, level (the highest Magic level it
// takes), by: { method id: casts } }.
export function castsIn(ix, counts) {
  const by = {};
  let xp10 = 0, level = 0;
  for (const [id, n] of counts) {
    const m = ix.byId.get(id);
    if (!m || !m.magic || !(n > 0)) continue;
    by[id] = (by[id] || 0) + n;
    xp10 += m.magic * n;
    level = Math.max(level, m.magicLevel || 0);
  }
  return xp10 > 0 ? { xp10, level, by } : null;
}
