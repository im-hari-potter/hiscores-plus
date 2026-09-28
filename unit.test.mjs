// Run with:  node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { findTotal, pageOfRank, rankParamForPage, pageCount } from '../js/totals-core.js';
import {
  xpForLevel, levelForXp, combatLevel, combatBreakdown, levelsToNextCombat,
  boundUnrankedLevels, combatFromProfile, levelProgress, apiXp,
} from '../js/skills.js';

// Behaves like the live endpoint: offset = max(P - 21, 0), limit 21.
function fakeProbe(total, counter) {
  return async P => {
    counter.n++;
    const offset = Math.max(P - 21, 0);
    const rows = [];
    for (let r = offset + 1; r <= Math.min(offset + 21, total); r++) rows.push({ rank: r });
    return rows;
  };
}

test('findTotal is exact for many totals and hint combinations', async () => {
  const totals = [0, 1, 2, 5, 20, 21, 22, 40, 41, 42, 43, 63, 64, 100, 999, 1000, 8164, 14138, 20482, 50000, 123457];
  for (const T of totals) {
    const variants = [
      {},
      { guess: T },
      { guess: T + 3 },
      { guess: Math.max(1, T - 7) },
      { guess: T + 500 },
      { guess: Math.max(1, T - 500) },
      { guess: T * 2 + 1 },
      { lower: Math.max(0, T - 1) },
      { lower: Math.floor(T / 3) },
      { upper: T + 1000 },
      { upper: Math.max(0, T - 50) },               // stale upper hint
      { lower: T + 40 },                            // stale lower hint (list shrank)
      { lower: Math.floor(T / 2), upper: T * 3 + 5, guess: T + 12 },
    ];
    for (const opts of variants) {
      const c = { n: 0 };
      const res = await findTotal(fakeProbe(T, c), opts);
      assert.equal(res.total, T, `T=${T} opts=${JSON.stringify(opts)} got ${JSON.stringify(res)}`);
      assert.ok(res.probes <= 40, `too many probes (${res.probes}) for T=${T} ${JSON.stringify(opts)}`);
    }
  }
});

test('findTotal is cheap when the guess is close', async () => {
  for (const [T, guess, max] of [[20482, 20482, 1], [20482, 20475, 1], [20482, 20400, 6], [14138, 14000, 4], [9115, 9200, 6]]) {
    const c = { n: 0 };
    const res = await findTotal(fakeProbe(T, c), { guess });
    assert.equal(res.total, T);
    assert.ok(res.probes <= max, `T=${T} guess=${guess} took ${res.probes} probes`);
  }
});

test('findTotal from scratch with the Overall total as a ceiling stays around log2', async () => {
  const c = { n: 0 };
  const res = await findTotal(fakeProbe(9115, c), { upper: 20482 });
  assert.equal(res.total, 9115);
  assert.ok(res.probes <= 11, `took ${res.probes}`);
});

test('paging helpers', () => {
  assert.equal(pageOfRank(1), 1);
  assert.equal(pageOfRank(21), 1);
  assert.equal(pageOfRank(22), 2);
  assert.equal(rankParamForPage(1), 21);
  assert.equal(rankParamForPage(3), 63);
  assert.equal(pageCount(20482), 976);
  assert.equal(pageCount(0), 1);
});

test('XP table matches known 2004 values', () => {
  assert.equal(xpForLevel(1), 0);
  assert.equal(xpForLevel(2), 83);
  assert.equal(xpForLevel(10), 1154);
  assert.equal(xpForLevel(15), 2411);
  assert.equal(xpForLevel(50), 101333);
  assert.equal(xpForLevel(60), 273742);
  assert.equal(xpForLevel(92), 6517253);
  assert.equal(xpForLevel(99), 13034431);
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(82), 1);
  assert.equal(levelForXp(83), 2);
  assert.equal(levelForXp(13034430), 98);
  assert.equal(levelForXp(13034431), 99);
  assert.equal(levelForXp(200000000), 99);
  assert.equal(apiXp(24120), 2412);
  assert.equal(apiXp(24129), 2412);
});

test('screenshot numbers: Attack 60 with 295,920 XP needs 6,368 more', () => {
  const p = levelProgress(60, 295920);
  assert.equal(p.remaining, 6368);
  const hp = levelProgress(86, 3789181);
  assert.equal(hp.remaining, 183113);
});

test('combat level formula', () => {
  const fresh = { attack: 1, strength: 1, defence: 1, hitpoints: 10, ranged: 1, prayer: 1, magic: 1 };
  assert.equal(combatLevel(fresh), 3);
  const maxed = { attack: 99, strength: 99, defence: 99, hitpoints: 99, ranged: 99, prayer: 99, magic: 99 };
  assert.equal(combatLevel(maxed), 126);
  // The account in the screenshots: base 38 + melee 48.75 = 86.75.
  const shot = { attack: 60, strength: 90, defence: 45, hitpoints: 86, ranged: 90, prayer: 43, magic: 90 };
  const b = combatBreakdown(shot);
  assert.equal(combatLevel(shot), 86);
  assert.equal(b.level, 86);
  assert.equal(b.style, 'melee');
  assert.equal(b.base, 38);
  assert.equal(b.melee, 48.75);
  const next = levelsToNextCombat(shot);
  assert.deepEqual(next, { attack: 1, strength: 1, defence: 1, hitpoints: 1, ranged: null, prayer: 1, magic: null });
});

test('levelsToNextCombat for melee-only builds', () => {
  const pure = { attack: 60, strength: 85, defence: 1, hitpoints: 80, ranged: 1, prayer: 1, magic: 1 };
  const next = levelsToNextCombat(pure);
  assert.ok(next.attack >= 1 && next.attack <= 4);
  assert.ok(next.strength >= 1 && next.strength <= 4);
});

test('unranked skills are bounded by the total level', () => {
  // Everything ranked except Prayer; total level says Prayer must be 7.
  const levels = { attack: 40, strength: 40, defence: 40, hitpoints: 40, ranged: 20, magic: 30, cooking: 30,
    woodcutting: 30, fletching: 20, fishing: 30, firemaking: 30, crafting: 20, smithing: 20, mining: 30,
    herblore: 15, agility: 20, thieving: 20, runecraft: 20 };
  const seen = Object.values(levels).reduce((a, b) => a + b, 0);
  const bounds = boundUnrankedLevels(levels, seen + 7);
  assert.deepEqual(bounds.prayer, { min: 7, max: 7 });
  const c = combatFromProfile(levels, seen + 7);
  assert.equal(c.min, c.max);
  assert.equal(c.exact, true);

  // Two missing skills sharing 20 levels: each is between 6 and 14.
  const two = { ...levels }; delete two.runecraft;
  const b2 = boundUnrankedLevels(two, seen - 20 + 20);
  assert.deepEqual(b2.prayer, { min: 6, max: 14 });
  assert.deepEqual(b2.runecraft, { min: 6, max: 14 });

  // Hitpoints never goes below 10.
  const noHp = { ...levels }; delete noHp.hitpoints;
  const b3 = boundUnrankedLevels(noHp, undefined);
  assert.deepEqual(b3.hitpoints, { min: 10, max: 14 });
});

test('findTotal fuzz: random totals and random (possibly wrong) hints', async () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let worst = 0;
  for (let i = 0; i < 3000; i++) {
    const T = Math.floor(rnd() ** 3 * 60000);
    const opts = {};
    if (rnd() < 0.5) opts.guess = Math.max(1, Math.floor(T * (0.5 + rnd())));
    if (rnd() < 0.4) opts.lower = Math.floor(T * (rnd() * 1.1));      // sometimes above T (stale)
    if (rnd() < 0.4) opts.upper = Math.floor(T * (0.9 + rnd()));      // sometimes below T (stale)
    const c = { n: 0 };
    const res = await findTotal(fakeProbe(T, c), opts);
    assert.equal(res.total, T, `T=${T} ${JSON.stringify(opts)} -> ${JSON.stringify(res)}`);
    worst = Math.max(worst, res.probes);
  }
  assert.ok(worst <= 45, `worst case ${worst} probes`);
});

test('findTotal copes with the list growing during the search', async () => {
  for (const start of [0, 5, 500, 20000]) {
    let T = start;
    const probe = async P => { T += 3; const offset = Math.max(P - 21, 0); const rows = [];
      for (let r = offset + 1; r <= Math.min(offset + 21, T); r++) rows.push({ rank: r }); return rows; };
    const res = await findTotal(probe, {});
    assert.ok(res.total >= start && res.total <= T, `start=${start} got ${res.total}, final T=${T}`);
    assert.ok(res.probes < 60);
  }
});
