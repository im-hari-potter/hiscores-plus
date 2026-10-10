// The loot of kills: what a monster drops and how likely, worked out from its
// drop table (npcdata.js, read from the server's scripts), and the XP its kills
// give. Kept free of any DOM code: the NPC database, Slayer plans and, once the
// Slayer skill comes to the game, its tasks all count with this.
//
// One kill is independent parts: everything in "always"; one row of the main
// table (rows exclude each other, and the entries of a row are each their own
// roll: a shared table's row in turn); and, in members worlds while you hold no
// clue, a clue scroll one kill in so many. So for each item a kill can give:
//   q  the amount it gives on average,
//   m2 the average of the amount squared (for how far a total strays),
//   p  the chance a kill gives any at all,
//   one: the amount when every drop of it is the same (a rune scimitar: 1),
//        so that drops can be counted (for luck); null when amounts vary.

import { DROP_TABLES, SHARED_DROPS, NPC_INFO } from './npcdata.js';
import { METHODS, MONSTERS } from './gamedata.js';

export const MONSTER_BY_ID = new Map(MONSTERS.map(m => [m.id, m]));
export const npcInfo = id => NPC_INFO[id] || null;

// ── A table's rows ──────────────────────────────────────────────────────────
// (the gem table has a form for each of: a ring of wealth worn, Legends' Quest
// done, under ground)
function sharedTable(name, { ring = false, legends = false, under = false } = {}) {
  const t = SHARED_DROPS[name];
  if (!t) throw new Error(`loot: no shared table ${name}`);
  if (!t.variants) return t;
  return t.variants[[ring && 'ring', legends && 'legends', under && 'under'].filter(Boolean).join(',')];
}
const isTable = e => typeof e[0] === 'string' && e[0].startsWith('~');
// (an item as the bank counts it: every herb from the herb table is the one Unid herb)
const banked = (slug, table) => (table === 'randomherb' && SHARED_DROPS.randomherb.bank ? SHARED_DROPS.randomherb.bank : slug);

// The amount one entry gives: { mean, m2 } of a number or a range (each whole number as likely)
function amount(count) {
  if (Array.isArray(count)) {
    const [lo, hi] = count, n = hi - lo + 1, mean = (lo + hi) / 2;
    return { mean, m2: (n * n - 1) / 12 + mean * mean, fixed: lo === hi ? lo : null };
  }
  return { mean: count, m2: count * count, fixed: count };
}

// One roll of a table (or of a monster's main table), item by item:
// Map(slug -> { q, m2, p, one, parts: [{ from, w, p, count, noted }] })
// from: where it comes from ('main' or a shared table's name).
function rollOf(table, opts, from, depth = 0) {
  if (depth > 6) throw new Error('loot: tables nested too deep');
  const out = new Map();
  const total = table.rows.reduce((a, [w]) => a + w, 0);
  if (total !== table.of) throw new Error(`loot: a table's rows come to ${total}, not ${table.of}`);
  // per row: each entry's own per-item { q, m2, none } (none: chance it gives none of that item)
  for (const [w, entries] of table.rows) {
    const pr = w / table.of;
    if (!entries.length) continue;
    const row = new Map();          // slug -> { q, m2var, none, one, parts }
    for (const e of entries) {
      const items = isTable(e) ? rollOf(sharedTable(e[0].slice(1), opts), opts, e[0].slice(1), depth + 1) : single(e, from);
      for (const [slug, d] of items) {
        const r = row.get(slug) || { q: 0, varSum: 0, none: 1, one: d.one, parts: [] };
        r.q += d.q;
        r.varSum += d.m2 - d.q * d.q;            // (entries of a row are independent: variances add)
        r.none *= 1 - d.p;
        if (r.one !== d.one) r.one = null;
        r.parts.push(...d.parts.map(x => ({ ...x, p: x.p * pr })));
        row.set(slug, r);
      }
    }
    for (const [slug, r] of row) {
      const o = out.get(slug) || { q: 0, m2: 0, p: 0, one: r.one, parts: [] };
      o.q += pr * r.q;
      o.m2 += pr * (r.varSum + r.q * r.q);
      o.p += pr * (1 - r.none);                  // (rows exclude each other)
      if (o.one !== r.one) o.one = null;
      o.parts.push(...r.parts);
      out.set(slug, o);
    }
  }
  return out;
}
function single([slug, count, noted], from) {
  const a = amount(count);
  const key = banked(slug, from);
  return new Map([[key, { q: a.mean, m2: a.m2, p: 1, one: a.fixed, parts: [{ from, slug, p: 1, count, ...(noted ? { noted: true } : {}) }] }]]);
}

// ── A kill ──────────────────────────────────────────────────────────────────
// opts: { ring: a ring of wealth worn, legends: Legends' Quest done }
// Map(slug -> { q, m2, p, one, parts }), most valuable first is up to the caller.
export function killDrops(monsterId, opts = {}) {
  const info = NPC_INFO[monsterId];
  if (!info) return new Map();
  const t = DROP_TABLES[info.drops];
  const o = { ...opts, under: !!info.under };
  const parts = [];
  for (const e of t.always || []) parts.push(isTable(e) ? rollOf(sharedTable(e[0].slice(1), o), o, e[0].slice(1)) : single(e, 'always'));
  if (t.rows) parts.push(rollOf(t, o, 'main'));
  if (t.clue) {
    const slug = `clue_scroll_${t.clue[0]}`;
    parts.push(new Map([[slug, { q: 1 / t.clue[1], m2: 1 / t.clue[1], p: 1 / t.clue[1], one: 1, parts: [{ from: 'clue', slug, p: 1 / t.clue[1], count: 1 }] }]]));
  }
  // (the parts are independent: means and variances add, chances of none multiply)
  const out = new Map();
  for (const part of parts) {
    for (const [slug, d] of part) {
      const x = out.get(slug) || { q: 0, varSum: 0, none: 1, one: d.one, parts: [] };
      x.q += d.q;
      x.varSum += d.m2 - d.q * d.q;
      x.none *= 1 - d.p;
      if (x.one !== d.one) x.one = null;
      x.parts.push(...d.parts);
      out.set(slug, x);
    }
  }
  return new Map([...out].map(([slug, x]) => [slug, { q: x.q, m2: x.varSum + x.q * x.q, p: 1 - x.none, one: x.one, parts: x.parts }]));
}

// Every item a monster can drop, as the bank counts it
export function dropSlugs(monsterId, opts = {}) { return [...killDrops(monsterId, opts).keys()]; }

// What a kill is worth: the average loot at the prices given. priceOf(slug) -> gp or null.
// { total, missing: [slugs without a price] }
export function killValue(drops, priceOf) {
  let total = 0;
  const missing = [];
  for (const [slug, d] of drops) {
    const gp = priceOf(slug);
    if (gp == null) { missing.push(slug); continue; }
    total += d.q * gp;
  }
  return { total, missing };
}

// ── Over many kills ─────────────────────────────────────────────────────────
// The chance of at least one in k kills, and of none (going that dry).
export const atLeastOne = (p, k) => (p >= 1 ? (k > 0 ? 1 : 0) : 1 - Math.pow(1 - p, k));
export const dryChance = (p, k) => (p >= 1 ? (k > 0 ? 0 : 1) : Math.pow(1 - p, k));
// The kills it takes for a chance of at least one: 50% "on average", 90% "most players"
export const killsFor = (p, chance) => (p >= 1 ? 1 : p <= 0 ? Infinity : Math.ceil(Math.log(1 - chance) / Math.log(1 - p)));

// How what you got after k kills compares with what's to be expected: the
// share of players who'd have had less, and who'd have had more. Drops are
// counted where every drop of an item is the same amount (exact, binomial);
// otherwise the total amount is compared (a normal curve, which is close for
// totals of many drops). { expected, drops: whether counted in drops, fewer, more }
export function luck(d, kills, got) {
  const expected = d.q * kills;
  if (d.one && d.one > 0 && d.p < 1) {
    const n = Math.round(got / d.one);
    return { expected, drops: true, count: n, expectedDrops: d.p * kills, fewer: binomCdf(n - 1, kills, d.p), more: 1 - binomCdf(n, kills, d.p) };
  }
  const sd = Math.sqrt(Math.max(0, d.m2 - d.q * d.q) * kills);
  if (!sd) return { expected, drops: false, fewer: got > expected ? 1 : 0, more: got < expected ? 1 : 0 };
  const z0 = (got - 0.5 - expected) / sd, z1 = (got + 0.5 - expected) / sd;
  return { expected, drops: false, fewer: phi(z0), more: 1 - phi(z1) };
}
// P(X <= k), X ~ Binomial(n, p): summed in logs, so it stays exact for big n and small p
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p), lq = Math.log1p(-p);
  let term = n * lq;                 // P(X = 0)
  let sum = Math.exp(term);
  for (let i = 1; i <= k; i++) {
    term += Math.log((n - i + 1) / i) + lp - lq;
    sum += Math.exp(term);
  }
  return Math.min(1, sum);
}
// the normal curve's share below z (Abramowitz and Stegun 7.1.26, good to about 1e-7)
export function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// A chance a kill as the game's tables say it: "Always", "5/128", "1/16,384";
// an item from several rows, which no one fraction says: "about 1/9.7".
export function rateText(p, parts = []) {
  if (p >= 1 - 1e-12) return 'Always';
  if (p <= 0) return 'Never';
  for (const den of [1, 2, 4, 8, 16, 32, 64, 65, 128, 129, 138, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152]) {
    const num = p * den;
    if (Math.abs(num - Math.round(num)) < 1e-7 && Math.round(num) >= 1) {
      let n = Math.round(num), d = den;
      while (n % 2 === 0 && d % 2 === 0) { n /= 2; d /= 2; }
      return `${n.toLocaleString('en-US')}/${d.toLocaleString('en-US')}`;
    }
  }
  const one = 1 / p;
  return `about 1/${one >= 100 ? Math.round(one).toLocaleString('en-US') : one >= 10 ? one.toFixed(1) : one.toFixed(2)}`;
}

// ── XP ──────────────────────────────────────────────────────────────────────
// The styles a kill can be fought in, with where its XP goes. Melee and Ranged
// are the combat planners' own rows (so every rule of the server's is in: a
// monster's own XP multiplier, the Black Knight Titan's flat XP); Magic counts
// the 2 XP a point of damage only (each cast's own XP depends on the spell).
export const KILL_STYLES = [
  { id: 'accurate', name: 'Accurate (Attack)', row: 'at' },
  { id: 'aggressive', name: 'Aggressive (Strength)', row: 'st' },
  { id: 'defensive', name: 'Defensive (Defence)', row: 'df' },
  { id: 'controlled', name: 'Controlled (Attack, Strength, Defence)', row: 'at', opt: 'controlled' },
  { id: 'rapid', name: 'Ranged: Accurate or Rapid', row: 'rg' },
  { id: 'longrange', name: 'Ranged: Longrange (Ranged, Defence)', row: 'rg', opt: 'longrange' },
  { id: 'magic', name: 'Magic (damage XP only)', magic: true },
];
const METHOD_BY_ID = new Map(METHODS.filter(m => /^(at|st|df|hp|rg)_/.test(m.id)).map(m => [m.id, m]));
// XP a kill, in tenths: { skill: tenths }. null when the style can't be used on it
// (only Magic works on a battle mage).
export function killXp(monsterId, styleId) {
  const mon = MONSTER_BY_ID.get(monsterId);
  const style = KILL_STYLES.find(s => s.id === styleId) || KILL_STYLES[0];
  if (!mon) return null;
  if (style.magic) {
    const hp = METHOD_BY_ID.get(`hp_${monsterId}`);
    // (2 XP a point of damage; a monster's own multiplier as its rows have it; the Titan's flat 1 XP)
    const base = mon.flat ? mon.hp * 10 : Math.floor(mon.hp * 20 * (mon.mult || 1000) / 1000);
    return { magic: base, hitpoints: hp ? hp.xp : 0 };
  }
  const m = METHOD_BY_ID.get(`${style.row}_${monsterId}`);
  if (!m) return null;
  const o = style.opt ? m.opt?.[style.opt] : null;
  if (style.opt && !o) return null;
  return { [m.skill]: (o || m).xp, ...((o || m).gives || {}) };
}
// (a combat skill goal's style, as a kill style: the Slayer plan its kills make starts with it)
export function styleOfSkillGoal(skill, styleOpt) {
  if (skill === 'attack') return styleOpt === 'controlled' ? 'controlled' : 'accurate';
  if (skill === 'strength') return styleOpt === 'controlled' ? 'controlled' : 'aggressive';
  if (skill === 'defence') return styleOpt === 'controlled' ? 'controlled' : styleOpt === 'longrange' ? 'longrange' : 'defensive';
  if (skill === 'ranged') return styleOpt === 'longrange' ? 'longrange' : 'rapid';
  return 'accurate';
}
