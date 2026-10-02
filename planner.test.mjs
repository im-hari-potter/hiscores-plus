// Run with:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, ITEMS, BANK_GROUPS, SALE_GROUPS, PLACES, UNID_HERBS } from './gamedata.js';
import { mergeUnids, minorOf } from './planner-ui.js';
import {
  xp10ForLevel, levelForXp10, goalTargetXp10, rankForTop, indexMethods, planBank, planGoal,
  methodEconomics, maxRuns, Stock, bankValue, outAt, madeOver, gathers, castsIn,
} from './planner.js';

const ix = indexMethods(METHODS.filter(m => m.skill === 'herblore'));
// (Runecraft tests at the end use their own index.)
const VIALS = new Set(['vial_water']);
const row = (plan, id) => plan.table.find(r => r.id === id);

test('the XP curve in tenths', () => {
  assert.equal(xp10ForLevel(78), 16_292_000);
  assert.equal(xp10ForLevel(1), 0);
  assert.equal(levelForXp10(16_292_000), 78);
  assert.equal(levelForXp10(16_291_999), 77);
  assert.equal(levelForXp10(11_962_500), 74);
});

test('goal targets', () => {
  assert.equal(goalTargetXp10({ type: 'level', value: 78 }), 16_292_000);
  assert.equal(goalTargetXp10({ type: 'xp', value: 1_000_000 }), 10_000_000);
  assert.equal(goalTargetXp10({ type: 'rank', value: 100 }, { rankXp10: 5_000_000 }), 5_000_001);
  assert.equal(goalTargetXp10({ type: 'top', value: 10 }), null, 'needs the XP of that rank');
  assert.equal(rankForTop(10, 4344), 434);
  assert.equal(rankForTop(0.01, 4344), 1);
});

test('every method only uses items the catalog knows, and XP is whole tenths', () => {
  for (const m of METHODS) {
    for (const k of [...Object.keys(m.in), ...Object.keys(m.out)]) assert.ok(ITEMS[k], `${m.id}: ${k}`);
    assert.ok(Number.isInteger(m.xp) && m.xp >= 0, m.id);
  }
  for (const g of BANK_GROUPS.herblore) for (const k of g.items) assert.ok(ITEMS[k], k);
  assert.equal(ix.byId.get('hb_3doseprayerrestore').xp, 875);
  assert.equal(ix.byId.get('hb_3dose2antipoison').xp, 1063);
  assert.deepEqual(UNID_HERBS, { item: 'unidentified_guam', xpMin: 25, xpMax: 150 });
  assert.equal(ITEMS.unidentified_guam.name, 'Unid herb');
  assert.ok(METHODS.every(m => !Object.keys(m.in).some(k => k.startsWith('unidentified_'))), 'no plan starts from unid herbs');
});

test("Ostap's example: 74 to 78 Herblore with 1,000 ranarr and 700 snape grass", () => {
  const plan = planGoal(ix, {
    bank: { ranarr_weed: 1000, snape_grass: 700 },
    currentXp10: 11_962_500,                  // 1,196,250 XP
    targetXp10: goalTargetXp10({ type: 'level', value: 78 }),
    unlimited: VIALS,
    fillId: 'hb_3doseprayerrestore',
  });
  assert.equal(plan.toGo, 4_329_500);         // 432,950 XP

  const r = row(plan, 'hb_3doseprayerrestore');
  assert.equal(r.needed, 4948, 'prayer potions to 78 with no bank');
  assert.equal(r.have, 700, 'what the bank makes now');
  assert.equal(r.toMake, 4248);
  assert.deepEqual(r.collect, { ranarr_weed: 3948, snape_grass: 4248 }, 'for the 4,248 still to make; vials are bought as you go');
  assert.deepEqual(r.balance, { runs: 1000, collect: { snape_grass: 300 } }, '300 snape grass uses up the ranarr');

  // The whole-bank plan: 700 prayer potions first, then 4,248 more.
  assert.equal(plan.fromBank.steps.length, 1);
  assert.equal(plan.fromBank.steps[0].id, 'hb_3doseprayerrestore');
  assert.equal(plan.fromBank.steps[0].runs, 700);
  assert.equal(plan.fromBank.xp10, 612_500);
  assert.deepEqual(plan.fromBank.assumed, { vial_water: 700 });
  assert.deepEqual(plan.fromBank.leftover.toObject(), { ranarr_weed: 300, '3doseprayerrestore': 700 });
  assert.equal(plan.fill.id, 'hb_3doseprayerrestore');
  assert.deepEqual(plan.fill.segments.map(s => s.runs), [4248]);
  assert.deepEqual(plan.fill.buy, { ranarr_weed: 3948, snape_grass: 4248 });
});

test('round up my supplies: 605 kwuarm and 518 limpwurt want 87 more limpwurt (v2.4.2)', () => {
  const opts = bank => ({ bank, currentXp10: xp10ForLevel(75), targetXp10: xp10ForLevel(78), unlimited: VIALS });
  let r = row(planGoal(ix, opts({ kwuarm: 605, limpwurt_root: 518, vial_water: 2230 })), 'hb_3dose2strength');
  assert.equal(r.have, 518);
  assert.deepEqual(r.balance, { runs: 605, collect: { limpwurt_root: 87 } });
  // the other way round, and with some of the kwuarm already made into unfinished potions
  r = row(planGoal(ix, opts({ kwuarm: 500, limpwurt_root: 518 })), 'hb_3dose2strength');
  assert.deepEqual(r.balance, { runs: 518, collect: { kwuarm: 18 } });
  r = row(planGoal(ix, opts({ kwuarm: 505, kwuarmvial: 100, limpwurt_root: 518 })), 'hb_3dose2strength');
  assert.deepEqual(r.balance, { runs: 605, collect: { limpwurt_root: 87 } });
  // nothing to round up once it pairs up, or with the bank left out
  assert.equal(row(planGoal(ix, opts({ kwuarm: 518, limpwurt_root: 518 })), 'hb_3dose2strength').balance, null);
  assert.equal(row(planGoal(ix, { ...opts({ kwuarm: 605, limpwurt_root: 518 }), useBank: false }), 'hb_3dose2strength').balance, null);
});

test('with the bank, Still and Collect come after all the XP it makes; without it, totals (v2.4.3)', () => {
  const bank = { kwuarm: 605, limpwurt_root: 518, avantoe: 403, snape_grass: 403, vial_water: 2230 };
  const opts = { bank, currentXp10: xp10ForLevel(75), targetXp10: xp10ForLevel(78), unlimited: VIALS };
  const plan = planGoal(ix, opts);
  assert.equal(plan.fromBank.xp10, 518 * 1250 + 403 * 1125, '518 super strength and 403 fishing potions');
  const left = plan.fromBank.leftover;
  assert.deepEqual([left.have('kwuarm'), left.have('vial_water')], [87, 2230 - 921]);
  const ss = row(plan, 'hb_3dose2strength');
  assert.equal(ss.needed, Math.ceil(plan.toGo / 1250), 'to goal: on its own, from your XP now');
  assert.equal(ss.have, 518);
  assert.equal(ss.toMake, Math.ceil(plan.remaining / 1250), 'still: after everything the bank makes');
  assert.ok(ss.toMake < ss.needed - ss.have, 'the fishing potions count too');
  assert.deepEqual(ss.collect, { kwuarm: ss.toMake - 87, limpwurt_root: ss.toMake }, 'with what\'s left in the bank');
  assert.equal(plan.fill.id, 'hb_3dose2strength');
  assert.deepEqual(plan.fill.buy, ss.collect, 'the same as the plan\'s own shopping list');
  const fish = row(plan, 'hb_3dosefisherspotion');
  assert.equal(fish.toMake, Math.ceil(plan.remaining / 1125));
  assert.deepEqual(fish.collect, { avantoe: fish.toMake, snape_grass: fish.toMake });
  // without the bank: everything from scratch
  const off = planGoal(ix, { ...opts, useBank: false });
  const t = row(off, 'hb_3dose2strength');
  assert.equal(t.toMake, t.needed);
  assert.deepEqual(t.collect, { kwuarm: t.needed, limpwurt_root: t.needed });
  // a bank that reaches the goal leaves nothing still to make
  const rich = row(planGoal(ix, { ...opts, bank: { kwuarm: 4000, limpwurt_root: 4000 } }), 'hb_3dose2strength');
  assert.deepEqual([rich.toMake, rich.collect], [0, {}]);
});

test('"I\'ll buy vials of water as I go": on, vials are left out of what to collect and of costs; off, they count (v2.4.4)', () => {
  const price = { kwuarm: 2000, limpwurt_root: 300, vial_water: 20, '3dose2strength': 3000 };
  const opts = { bank: { kwuarm: 605, limpwurt_root: 518, vial_water: 300 }, currentXp10: xp10ForLevel(75), targetXp10: xp10ForLevel(78), priceOf: k => price[k] ?? null, fillId: 'hb_3dose2strength' };
  const on = planGoal(ix, { ...opts, unlimited: VIALS });
  const off = planGoal(ix, { ...opts, unlimited: new Set() });
  assert.equal(on.fromBank.steps[0].runs, 518, 'on: vials never hold the bank back');
  assert.equal(off.fromBank.steps[0].runs, 300, 'off: only the 300 vials in the bank');
  assert.equal(on.fill.buy.vial_water, undefined);
  assert.ok(off.fill.buy.vial_water > 0);
  assert.equal(on.fill.cost, on.fill.buy.kwuarm * 2000 + on.fill.buy.limpwurt_root * 300, 'vials cost nothing here');
  const rOn = row(on, 'hb_3dose2strength'), rOff = row(off, 'hb_3dose2strength');
  assert.equal(rOn.collect.vial_water, undefined);
  assert.equal(rOff.collect.vial_water, rOff.toMake, 'off: every vial still to make');
  assert.deepEqual(rOn.econ.inputs, { kwuarm: 1, limpwurt_root: 1 });
  assert.equal(rOn.econ.net, 700, '3,000 − 2,000 − 300');
  assert.equal(rOff.econ.net, 680, 'and 20 for the vial');
});

test('totals per row: net after rounding up my supplies, and after collecting the rest (v2.4.4)', () => {
  const price = { kwuarm: 2000, limpwurt_root: 300, '3dose2strength': 3000, avantoe: 900, snape_grass: 50, '3dosefisherspotion': 1200 };
  const plan = planGoal(ix, {
    bank: { kwuarm: 605, limpwurt_root: 518, avantoe: 403, snape_grass: 403 },
    currentXp10: xp10ForLevel(75), targetXp10: xp10ForLevel(78), unlimited: VIALS, priceOf: k => price[k] ?? null,
  });
  const ss = row(plan, 'hb_3dose2strength');
  // what's in the bank is yours: 605 super strength for 87 limpwurt
  assert.deepEqual(ss.balance, { runs: 605, collect: { limpwurt_root: 87 } });
  assert.deepEqual(ss.gains.even, { total: 605 * 3000 - 87 * 300, value: 605 * 3000, cost: 87 * 300, missing: [] });
  const cost = ss.collect.kwuarm * 2000 + ss.collect.limpwurt_root * 300;
  assert.deepEqual(ss.gains.collect, { total: ss.toMake * 3000 - cost, value: ss.toMake * 3000, cost, missing: [] });
  // already even: what the bank makes of it, for nothing more
  const fish = row(plan, 'hb_3dosefisherspotion');
  assert.equal(fish.balance, null);
  assert.deepEqual(fish.gains.even, { total: 403 * 1200, value: 403 * 1200, cost: 0, missing: [] });
  // the total net: what the bank plan makes of it before rounding up (518, as
  // From your bank shows), plus the net after buying supplies. Not the net
  // after rounding up: the 87 kwuarm left over would count twice.
  assert.deepEqual(ss.gains.before, { total: 518 * 3000, value: 518 * 3000, cost: 0, missing: [] });
  assert.deepEqual([ss.fromPlan, fish.fromPlan, row(plan, 'hb_3dose1attack').fromPlan], [518, 403, 0], 'what the bank plan makes of each');
  assert.equal(ss.gains.net.total, 518 * 3000 + ss.gains.collect.total);
  assert.notEqual(ss.gains.net.total, ss.gains.even.total + ss.gains.collect.total);
  assert.equal(fish.gains.net.total, 403 * 1200 + fish.gains.collect.total);
  // nothing made from the bank: just the net after buying supplies
  assert.equal(row(plan, 'hb_3dose1attack').gains.before, null);
  assert.deepEqual(row(plan, 'hb_3dose1attack').gains.net.missing, row(plan, 'hb_3dose1attack').gains.collect.missing);
  // nothing for it in the bank: nothing to round up, nothing to show for it
  assert.equal(row(plan, 'hb_3dose1attack').balance, null);
  assert.equal(row(plan, 'hb_3dose1attack').gains.even, null);
  assert.ok(row(plan, 'hb_3dose1attack').gains.collect.missing.length, 'no prices for attack potions here');
  // without the bank there are no totals
  const off = row(planGoal(ix, { ...plan, bank: { kwuarm: 605 }, currentXp10: xp10ForLevel(75), targetXp10: xp10ForLevel(78), useBank: false }), 'hb_3dose2strength');
  assert.deepEqual(off.gains, { even: null, collect: null, before: null, net: null });
});

test('with the bank off, a mix you plan yourself goes first, from scratch (v2.4.6)', () => {
  const price = { ranarr_weed: 3000, snape_grass: 400, '3doseprayerrestore': 3800, irit_leaf: 900, eye_of_newt: 3, '3dose2attack': 1500 };
  const opts = { bank: { ranarr_weed: 1000 }, currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(78), unlimited: VIALS, priceOf: k => price[k] ?? null, useBank: false, fillId: 'hb_3doseprayerrestore' };
  const plan = planGoal(ix, { ...opts, mix: { hb_3dose2attack: 1000, hb_3doseprayerrestore: 2000, hb_3dose1magic: 0 } });
  const mix = plan.fromMix;
  assert.deepEqual(mix.steps.map(s => [s.id, s.runs]), [['hb_3doseprayerrestore', 2000], ['hb_3dose2attack', 1000]], 'lowest level first; none of a kind is left out');
  assert.equal(mix.xp10, 2000 * 875 + 1000 * 1000);
  assert.deepEqual(mix.buy, { ranarr_weed: 2000, snape_grass: 2000, irit_leaf: 1000, eye_of_newt: 1000 }, 'all bought: the bank is left out, and vials are bought as you go');
  assert.equal(mix.gain.total, 2000 * (3800 - 3400) + 1000 * (1500 - 903));
  assert.equal(mix.steps[0].gain.total, 2000 * 400);
  assert.equal(plan.afterXp10, xp10ForLevel(74) + mix.xp10);
  assert.equal(plan.remaining, plan.toGo - mix.xp10, 'the mix counts toward the goal');
  assert.equal(row(plan, 'hb_3dose2strength').toMake, Math.ceil(plan.remaining / 1250), 'still needed to goal: after the mix');
  assert.equal(row(plan, 'hb_3dose2strength').needed, Math.ceil(plan.toGo / 1250), 'to goal: on its own, as before');
  assert.deepEqual([row(plan, 'hb_3doseprayerrestore').planned, row(plan, 'hb_3dose2attack').planned, row(plan, 'hb_3dose2strength').planned], [2000, 1000, 0]);
  const rest = plan.fill.segments.at(-1).runs;
  assert.equal(plan.fill.buy.ranarr_weed, rest, 'the rest is planned from scratch too: the 1,000 ranarr in the bank are left out');
  // a level you won't have yet is flagged; enough XP before it clears that
  assert.equal(planGoal(ix, { ...opts, mix: { hb_3dose1magic: 100 } }).fromMix.steps[0].locked, true);
  assert.equal(planGoal(ix, { ...opts, mix: { hb_3dose1magic: 100, hb_3doseprayerrestore: 3000 } }).fromMix.steps[1].locked, false);
  // a mix past the goal reaches it
  const big = planGoal(ix, { ...opts, mix: { hb_3doseprayerrestore: 7000 } });
  assert.deepEqual([big.fromMix.reached, big.remaining, big.fill], [true, 0, null]);
  // with the bank in use, the mix waits
  assert.equal(planGoal(ix, { ...opts, useBank: true, mix: { hb_3dose2attack: 1000 } }).fromMix, null);
  assert.equal(planGoal(ix, { ...opts, mix: {} }).fromMix, null);
});

test('unid herbs sit out of the plan until they are identified', () => {
  const res = planBank(ix, { bank: { unidentified_guam: 500, snape_grass: 10 }, startXp10: 11_962_500, unlimited: VIALS });
  assert.equal(res.steps.length, 0);
  assert.equal(res.leftover.have('unidentified_guam'), 500);
});

test('unid herbs saved one kind at a time (v2.0.0) become one Unid herb amount', () => {
  const old = { unidentified_guam: 5, unidentified_ranarr: 100, unidentified_torstol: 3, ranarr_weed: 7 };
  assert.deepEqual(mergeUnids(old), { changed: true, items: { unidentified_guam: 108, ranarr_weed: 7 } });
  assert.deepEqual(mergeUnids({ ranarr_weed: 7 }), { changed: false, items: { ranarr_weed: 7 } });
});

test('unfinished potions and empty vials in the bank count', () => {
  const s = new Stock({ ranarrvial: 5, ranarr_weed: 3, vial_empty: 2, snape_grass: 50 });
  const ctx = { level: 74, kinds: new Set(['prep', 'source']), unlimited: new Set() };
  assert.equal(maxRuns(ix, ix.byId.get('hb_3doseprayerrestore'), s, ctx), 7, '5 unf + 2 made (only 2 vials)');
  ctx.unlimited = VIALS;
  assert.equal(maxRuns(ix, ix.byId.get('hb_3doseprayerrestore'), s, ctx), 8);
});

test('a better potion is picked up as soon as its level is reached', () => {
  const start = xp10ForLevel(37);
  const res = planBank(ix, { bank: { ranarr_weed: 3000, snape_grass: 3000, white_berries: 3000 }, startXp10: start, unlimited: VIALS });
  assert.equal(res.steps[0].id, 'hb_3dose1defense', 'defence potions first, at 37');
  assert.equal(res.steps[1].id, 'hb_3doseprayerrestore', 'then prayer potions from 38');
  const defence = res.steps[0].runs;
  assert.ok(start + (defence - 1) * 750 < xp10ForLevel(38) && start + defence * 750 >= xp10ForLevel(38));
  assert.equal(res.steps[0].runs + res.steps[1].runs, 3000, 'every ranarr used');
});

test('the goal point is found inside a step', () => {
  const start = xp10ForLevel(74);
  const target = start + 100 * 875;
  const res = planBank(ix, { bank: { ranarr_weed: 1000, snape_grass: 1000 }, startXp10: start, targetXp10: target, unlimited: VIALS });
  assert.deepEqual(res.goalReached, { index: 0, runs: 100 });
});

test('excluded methods are left alone', () => {
  const res = planBank(ix, {
    bank: { avantoe: 50, snape_grass: 50, ranarr_weed: 50 }, startXp10: xp10ForLevel(74), unlimited: VIALS,
    excluded: new Set(['hb_3dosefisherspotion']),
  });
  assert.deepEqual(res.steps.map(s => s.id), ['hb_3doseprayerrestore']);
  assert.equal(res.leftover.have('avantoe'), 50);
});

test('finishing with a potion you cannot make yet plans the levels before it', () => {
  const plan = planGoal(ix, {
    bank: {}, currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(80), unlimited: VIALS,
    fillId: 'hb_3dosepotionofzamorak',
  });
  assert.equal(plan.fill.locked, true);
  assert.deepEqual(plan.fill.segments.map(s => [s.id, !!s.bridge, s.toLevel]), [
    ['hb_3doserangerspotion', true, 76],    // best potion at 74
    ['hb_3dose1magic', true, 78],           // better from 76
    ['hb_3dosepotionofzamorak', false, undefined],
  ]);
});

test('prices: cost, net and gp per XP of one action', () => {
  const price = { ranarr_weed: 3000, snape_grass: 400, vial_water: 5, '3doseprayerrestore': 3800 };
  const e = methodEconomics(ix, ix.byId.get('hb_3doseprayerrestore'), k => price[k] ?? null);
  assert.deepEqual(e.inputs, { ranarr_weed: 1, vial_water: 1, snape_grass: 1 });
  assert.equal(e.cost, 3405);
  assert.equal(e.value, 3800);
  assert.equal(e.net, 395);
  assert.ok(Math.abs(e.gpPerXp - (-395 / 87.5)) < 1e-9);
  const unknown = methodEconomics(ix, ix.byId.get('hb_3dose1magic'), k => price[k] ?? null);
  assert.equal(unknown.net, null);
  assert.ok(unknown.missing.includes('cactus_potato'));
  assert.deepEqual(bankValue({ ranarr_weed: 2, torstol: 1 }, k => price[k] ?? null), { total: 6000, missing: ['torstol'] });
});

test('a goal already reached plans nothing', () => {
  const plan = planGoal(ix, { bank: { ranarr_weed: 5 }, currentXp10: xp10ForLevel(80), targetXp10: xp10ForLevel(78) });
  assert.equal(plan.toGo, 0);
  assert.equal(plan.remaining, 0);
  assert.equal(plan.fill, null);
  assert.equal(row(plan, 'hb_3doseprayerrestore').needed, 0);
});

test('with no method picked, the plan carries on with what the bank was making', () => {
  const opts = { currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(78), unlimited: VIALS };
  const withBank = planGoal(ix, { ...opts, bank: { ranarr_weed: 100, snape_grass: 100 } });
  assert.equal(withBank.fill.id, 'hb_3doseprayerrestore');
  const empty = planGoal(ix, { ...opts, bank: {} });
  assert.equal(empty.fill.id, 'hb_3doserangerspotion', 'best XP at level 74');
  const excluded = planGoal(ix, { ...opts, bank: {}, excluded: new Set(['hb_3doserangerspotion']), fillId: 'hb_3doserangerspotion' });
  assert.equal(excluded.fill.id, 'hb_3dose1antidragon', 'an excluded pick falls back to the next best');
});

// ── Runecraft ─────────────────────────────────────────────────────────────
const rc = indexMethods(METHODS.filter(m => m.skill === 'runecraft'));

test('runecraft: XP per essence and runes per essence come from the server data', () => {
  assert.deepEqual(rc.train.map(m => [m.name, m.level, m.xp / 10]), [
    ['Air rune', 1, 5], ['Mind rune', 2, 5.5], ['Water rune', 5, 6], ['Earth rune', 9, 6.5], ['Fire rune', 14, 7],
    ['Body rune', 20, 7.5], ['Cosmic rune', 27, 8], ['Chaos rune', 35, 8.5], ['Nature rune', 44, 9], ['Law rune', 54, 9.5],
  ]);
  const air = rc.byId.get('rc_airrune'), nature = rc.byId.get('rc_naturerune'), law = rc.byId.get('rc_lawrune');
  assert.deepEqual([10, 11, 22, 99].map(l => outAt(air, l).airrune), [1, 2, 3, 10]);
  assert.deepEqual([90, 91, 99].map(l => outAt(nature, l).naturerune), [1, 2, 2]);
  assert.equal(outAt(law, 99).lawrune, 1, 'law runes are always one per essence');
});

test('runecraft: runes made go up as the level does on the way', () => {
  const air = rc.byId.get('rc_airrune');
  const start = xp10ForLevel(11) - 10 * 50;            // ten essences short of 11
  assert.deepEqual(madeOver(air, 30, start), { airrune: 10 * 1 + 20 * 2 });
  assert.deepEqual(madeOver(rc.byId.get('rc_lawrune'), 30, start), { lawrune: 30 });
});

test('runecraft: a bank of essence, best XP first or the rune you picked', () => {
  const opts = { bank: { blankrune: 5000 }, currentXp10: xp10ForLevel(44), targetXp10: xp10ForLevel(60) };
  const plan = planGoal(rc, opts);
  assert.equal(plan.fromBank.steps.length, 1);
  assert.equal(plan.fromBank.steps[0].id, 'rc_naturerune', 'best XP at 44');
  assert.equal(plan.fromBank.steps[0].runs, 5000);
  assert.equal(plan.fromBank.xp10, 5000 * 90);
  assert.deepEqual(plan.fromBank.steps[0].made, { naturerune: 5000 });
  assert.equal(plan.fill.id, 'rc_naturerune', 'carries on with nature runes');
  const left = xp10ForLevel(60) - xp10ForLevel(44) - 5000 * 90;
  assert.deepEqual(plan.fill.buy, { blankrune: Math.ceil(left / 90) });

  const air = planGoal(rc, { ...opts, fillId: 'rc_airrune' });
  assert.equal(air.fromBank.steps[0].id, 'rc_airrune', 'the bank goes to the rune you picked');
  assert.equal(air.fromBank.steps[0].made.airrune, 5000 * 5, '5 air runes per essence at 44');
  const row = air.table.find(r => r.id === 'rc_airrune');
  assert.equal(row.have, 5000);
  assert.equal(row.needed, Math.ceil((xp10ForLevel(60) - xp10ForLevel(44)) / 50));
  assert.deepEqual(row.collect, { blankrune: row.needed - 5000 });
});

test('runecraft: the rune you picked waits for its level, then takes over', () => {
  const plan = planGoal(rc, { bank: { blankrune: 20000 }, currentXp10: xp10ForLevel(50), targetXp10: xp10ForLevel(70), fillId: 'rc_lawrune' });
  assert.deepEqual(plan.fromBank.steps.map(s => s.id), ['rc_naturerune', 'rc_lawrune'], 'natures until 54, then laws');
  assert.equal(levelForXp10(xp10ForLevel(50) + plan.fromBank.steps[0].xp10), 54);
});

test('runecraft: net per essence counts the runes it makes at your level', () => {
  const price = { blankrune: 50, airrune: 10 };
  const e = methodEconomics(rc, rc.byId.get('rc_airrune'), k => price[k] ?? null, { level: 44 });
  assert.equal(e.value, 5 * 10);
  assert.equal(e.net, 0);
});

// ── Woodcutting ───────────────────────────────────────────────────────────
const wc = indexMethods(METHODS.filter(m => m.skill === 'woodcutting'));

test('woodcutting: trees, levels and XP per log from the server data', () => {
  assert.deepEqual(wc.train.map(m => [m.name, m.level, m.xp / 10]), [
    ['Logs', 1, 25], ['Achey tree logs', 1, 25], ['Oak logs', 15, 37.5], ['Willow logs', 30, 67.5],
    ['Bark (hollow tree)', 45, 82.5], ['Maple logs', 45, 100], ['Yew logs', 60, 175], ['Magic logs', 75, 250],
  ]);
  assert.ok(wc.train.every(gathers), 'chopping takes nothing in');
});

test('woodcutting: logs to chop, with no bank involved', () => {
  const opts = { bank: { willow_logs: 5000 }, currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(45) };
  const plan = planGoal(wc, opts);
  assert.equal(plan.fromBank.steps.length, 0, 'logs in the bank give no Woodcutting XP');
  assert.equal(plan.fill.id, 'wc_willow_logs', 'best XP per log at 30');
  const toGo = xp10ForLevel(45) - xp10ForLevel(30);
  assert.deepEqual(plan.fill.segments.map(s => s.runs), [Math.ceil(toGo / 675)]);
  assert.deepEqual(plan.fill.buy, {});
  assert.deepEqual(plan.fill.segments[0].made, { willow_logs: Math.ceil(toGo / 675) });
  const r = row(plan, 'wc_willow_logs');
  assert.equal(r.have, 0);
  assert.equal(r.needed, Math.ceil(toGo / 675));
  assert.deepEqual(r.collect, {});
  assert.equal(r.balance, null);

  const yews = planGoal(wc, { ...opts, targetXp10: xp10ForLevel(65), fillId: 'wc_yew_logs' });
  assert.deepEqual(yews.fill.segments.map(s => [s.id, s.toLevel]), [['wc_willow_logs', 45], ['wc_maple_logs', 60], ['wc_yew_logs', undefined]],
    'willows to 45, maples to 60, then yews');

  const e = methodEconomics(wc, wc.byId.get('wc_willow_logs'), k => ({ willow_logs: 30 })[k] ?? null);
  assert.equal(e.net, 30);
  assert.ok(Math.abs(e.gpPerXp - (-30 / 67.5)) < 1e-9, 'negative: you make money');
});

// ── Firemaking ────────────────────────────────────────────────────────────
const fm = indexMethods(METHODS.filter(m => m.skill === 'firemaking'));

test('firemaking: XP per log, and achey logs left out (no XP in this version)', () => {
  assert.deepEqual(fm.train.map(m => [m.name, m.level, m.xp]), [
    ['Logs', 1, 400], ['Oak logs', 15, 600], ['Willow logs', 30, 900], ['Maple logs', 45, 1350], ['Yew logs', 60, 2025], ['Magic logs', 75, 3038],
  ]);
  assert.ok(!METHODS.some(m => m.skill === 'firemaking' && m.in.achey_tree_logs));
  assert.deepEqual(BANK_GROUPS.firemaking, [{ name: 'Logs', items: ['logs', 'oak_logs', 'willow_logs', 'maple_logs', 'yew_logs', 'magic_logs'] }]);
});

test('firemaking: the bank burns its best logs first', () => {
  const plan = planGoal(fm, { bank: { willow_logs: 1000, logs: 500 }, currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(60) });
  assert.deepEqual(plan.fromBank.steps.map(s => [s.id, s.runs]), [['fm_willow_logs', 1000], ['fm_logs', 500]]);
  assert.equal(plan.fromBank.xp10, 1000 * 900 + 500 * 400);
  assert.deepEqual(plan.fromBank.steps[0].made, {}, 'burning makes nothing');
  assert.equal(plan.fill.id, 'fm_willow_logs');
  const price = { maple_logs: 25 };
  const e = methodEconomics(fm, fm.byId.get('fm_maple_logs'), k => price[k] ?? null);
  assert.equal(e.net, -25);
});

// ── Fletching ─────────────────────────────────────────────────────────────
const fl = indexMethods(METHODS.filter(m => m.skill === 'fletching'));

test('fletching: XP from the server data, whole jobs add up their steps', () => {
  const xp = id => fl.byId.get(id).xp;
  assert.equal(xp('fl_cut_unstrung_yew_longbow'), 750);
  assert.equal(xp('fl_str_willow_shortbow'), 332, 'stringing a willow shortbow is 33.2, cutting it 33.3');
  assert.equal(xp('fl_cs_willow_shortbow'), 665);
  assert.equal(xp('fl_shafts'), 75, '15 shafts from a log, 0.5 XP each');
  assert.equal(xp('fl_headless'), 10);
  assert.equal(xp('fl_logs_bronze_arrow'), 420, '42 XP per log, like the calculator sites');
  assert.equal(xp('fl_logs_rune_arrow'), 2100);
  assert.equal(xp('fl_dart_rune_dart'), 188);
  assert.deepEqual(fl.byId.get('fl_tips_opal').out, { opal_bolttips: 12 });
  for (const m of fl.train) if (m.parts) assert.equal(m.parts.reduce((a, [, x]) => a + x, 0), m.xp, m.id);
  assert.equal(ITEMS.unstrung_yew_longbow.name, 'Yew longbow (u)', 'the same name as the strung bow in-game, so marked');
});

test('fletching: logs and bow strings are cut and strung first, the rest cut', () => {
  const plan = planGoal(fl, { bank: { yew_logs: 2000, bow_string: 1500 }, currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(85) });
  assert.deepEqual(plan.fromBank.steps.map(s => [s.id, s.runs]), [['fl_cs_yew_longbow', 1500], ['fl_cut_unstrung_yew_longbow', 500]]);
  assert.equal(plan.fromBank.xp10, 1500 * 1500 + 500 * 750);
  const r = row(plan, 'fl_cs_yew_longbow');
  assert.equal(r.have, 1500);
  assert.deepEqual(r.balance, { runs: 2000, collect: { bow_string: 500 } });
  assert.equal(plan.fill.id, 'fl_cs_yew_longbow', 'carries on cutting and stringing');
  assert.ok(plan.fill.buy.yew_logs > 0 && plan.fill.buy.yew_logs === plan.fill.buy.bow_string);
});

test('fletching: shafts, feathers and arrowtips are worked through step by step', () => {
  const res = planBank(fl, { bank: { arrow_shaft: 300, feather: 300, steel_arrowheads: 300 }, startXp10: xp10ForLevel(30) });
  assert.deepEqual(res.steps.map(s => [s.id, s.runs]), [['fl_headless', 300], ['fl_arrow_steel_arrow', 300]]);
  assert.equal(res.xp10, 300 * 10 + 300 * 50);
  const logs = planBank(fl, { bank: { logs: 100, feather: 1500, bronze_arrowheads: 1500 }, startXp10: 0 });
  assert.deepEqual(logs.steps[0], { id: 'fl_logs_bronze_arrow', runs: 100, xp10: 100 * 420, sub: {}, made: { bronze_arrow: 1500 } });
});

test('fletching: feathers go where they give the most XP (rune darts over bronze arrows)', () => {
  const bank = { feather: 1500, rune_dart_tip: 1500, logs: 100, bronze_arrowheads: 1500 };
  const res = planBank(fl, { bank, startXp10: xp10ForLevel(81) });
  assert.deepEqual(res.steps[0], { id: 'fl_dart_rune_dart', runs: 1500, xp10: 1500 * 188, sub: {}, made: { rune_dart: 1500 } });
  const arrowsFirst = planBank(fl, { bank, startXp10: xp10ForLevel(81), prefer: 'fl_logs_bronze_arrow' });
  assert.equal(arrowsFirst.steps[0].id, 'fl_logs_bronze_arrow', 'unless you pick the arrows');
  assert.ok(res.xp10 > arrowsFirst.xp10);
});

test('fletching: with nothing picked the plan finishes with bows, and bridges with bows', () => {
  const opts = { bank: {}, currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(80), fillGroup: 'Bows' };
  assert.equal(planGoal(fl, opts).fill.id, 'fl_cs_yew_longbow');
  assert.equal(planGoal(fl, { ...opts, fillGroup: null }).fill.id, 'fl_logs_adamant_arrow', 'most XP per action otherwise');
  const magic = planGoal(fl, { ...opts, targetXp10: xp10ForLevel(90), fillId: 'fl_cs_magic_longbow' });
  const segs = magic.fill.segments;
  assert.deepEqual(segs.map(s => s.id), ['fl_cs_yew_longbow', 'fl_cs_magic_shortbow', 'fl_cs_magic_longbow'], 'bows all the way');
  assert.deepEqual(magic.fill.buy, { yew_logs: segs[0].runs, bow_string: segs[0].runs + segs[1].runs + segs[2].runs, magic_logs: segs[1].runs + segs[2].runs });
});

test('fletching: logs cut from the bank don\'t make cutting the rest of the plan', () => {
  const plan = planGoal(fl, { bank: { yew_logs: 1000 }, currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(80), fillGroup: 'Bows' });
  assert.deepEqual(plan.fromBank.steps.map(s => [s.id, s.runs]), [['fl_cut_unstrung_yew_longbow', 1000]]);
  assert.equal(plan.fill.id, 'fl_cs_yew_longbow', 'the rest: bows, cut and strung');
  const strung = planGoal(fl, { bank: { yew_logs: 1000, bow_string: 1000 }, currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(90), fillGroup: 'Bows' });
  assert.equal(strung.fill.id, 'fl_cs_yew_longbow', 'carries on with the bank\'s bows, though magic bows are better by 80');
});

test('fletching: the balance tip counts 15 feathers and arrowtips to a log', () => {
  const plan = planGoal(fl, { bank: { logs: 300, feather: 6000, iron_arrowheads: 3000 }, currentXp10: xp10ForLevel(89), targetXp10: xp10ForLevel(92) });
  const r = row(plan, 'fl_logs_iron_arrow');
  assert.equal(r.have, 200, '3,000 arrowtips is 200 logs\' worth');
  assert.deepEqual(r.balance, { runs: 400, collect: { logs: 100, iron_arrowheads: 3000 } }, 'the feathers would do 400 logs');
});

// ── Crafting ──────────────────────────────────────────────────────────────
// The rows are LostHQ's Crafting calculator; the numbers below are the ones on
// its page (levels, XP per item, ingredients), with XP in tenths. Where the
// server differs, the server's number is the one used.
const cr = indexMethods(METHODS.filter(m => m.skill === 'crafting'));
const crCanifis = indexMethods(METHODS.filter(m => m.skill === 'crafting'), { at: 'canifis' });
const THREAD = new Set(['thread']);
const crSteps = res => res.steps.map(s => [s.id, s.runs, s.sub]);
// (rounding up) [id, how many, made after the bank's own steps?, collected for it]
const evSteps = res => res.steps.map(s => [s.id, s.runs, !!s.rounded, s.collect || null]);
// Rows added for what they sell as: dragonhide sets and enchanted jewellery.
const forSale = m => /^cr_(set|ench)_/.test(m.id);
const calcRows = cr.train.filter(m => !forSale(m));

test('crafting: every row of LostHQ\'s calculator, tab by tab, with its level, XP and ingredients (the server\'s where they differ)', () => {
  const tabs = ['Needle & thread', 'Jewellery', 'Pottery & glass', 'Spinning'];
  assert.deepEqual(tabs.map(g => calcRows.filter(m => m.group === g).length), [22, 35, 14, 2]);
  assert.equal(calcRows.length, 73);
  const r = id => { const m = cr.byId.get(id); return [m.level, m.xp, m.in]; };
  assert.deepEqual(r('cr_leather_gloves'), [1, 138, { leather: 1, thread: 0.2 }]);
  assert.deepEqual(r('cr_hardleather_body'), [28, 350, { hard_leather: 1, thread: 0.2 }]);
  assert.deepEqual(r('cr_coif'), [38, 370, { leather: 1, thread: 0.2 }]);
  assert.deepEqual(r('cr_studded_body'), [41, 400, { leather_armour: 1, studs: 1 }]);
  assert.deepEqual(r('cr_studded_chaps'), [44, 420, { leather_chaps: 1, studs: 1 }]);
  assert.deepEqual(r('cr_dragonhide_chaps'), [60, 1240, { dragon_leather: 2, thread: 0.2 }]);
  assert.deepEqual(r('cr_black_dragonhide_body'), [84, 2580, { dragon_leather_black: 3, thread: 0.2 }]);
  assert.deepEqual(r('cr_opal'), [1, 150, { uncut_opal: 1 }]);
  assert.deepEqual(r('cr_gold_ring'), [5, 150, { gold_bar: 1 }]);
  assert.deepEqual(r('cr_nostringstar'), [16, 500, { silver_bar: 1 }]);
  assert.deepEqual(r('cr_stringstar'), [16, 540, { silver_bar: 1, ball_of_wool: 1 }]);
  assert.deepEqual(r('cr_silver_sickle'), [18, 500, { silver_bar: 1 }]);
  assert.deepEqual(r('cr_emerald'), [27, 675, { uncut_emerald: 1 }]);
  assert.deepEqual(r('cr_sapphire_necklace'), [20, 550, { gold_bar: 1, sapphire: 1 }], 'level 20, as the server has it (the calculator says 22)');
  assert.deepEqual(r('cr_dragonstone_necklace'), [72, 1050, { gold_bar: 1, dragonstone: 1 }]);
  assert.deepEqual(r('cr_strung_dragonstone_amulet'), [80, 1540, { gold_bar: 1, dragonstone: 1, ball_of_wool: 1 }]);
  assert.deepEqual(r('cr_pot_unfired'), [1, 63, { softclay: 1 }]);
  assert.deepEqual(r('cr_pot_empty'), [1, 126, { softclay: 1 }]);
  assert.deepEqual(r('cr_molten_glass'), [1, 200, { bucket_sand: 1, soda_ash: 1 }]);
  assert.deepEqual(r('cr_vial_empty'), [33, 350, { molten_glass: 1 }]);
  assert.deepEqual(r('cr_stafforb'), [46, 525, { molten_glass: 1 }]);
  assert.deepEqual(r('cr_air_battlestaff'), [66, 1375, { air_orb: 1, battlestaff: 1 }]);
  assert.deepEqual(r('cr_ball_of_wool'), [1, 25, { wool: 1 }]);
  assert.deepEqual(r('cr_bow_string'), [10, 150, { flax: 1 }]);
  // in the calculator's order, tab by tab
  assert.deepEqual(calcRows.slice(0, 3).map(m => m.id), ['cr_leather_gloves', 'cr_leather_boots', 'cr_leather_cowl']);
  assert.deepEqual(calcRows.filter(m => m.group === 'Jewellery').slice(0, 5).map(m => m.id), ['cr_opal', 'cr_gold_ring', 'cr_gold_necklace', 'cr_unstrung_gold_amulet', 'cr_strung_gold_amulet']);
});

test('crafting: whole jobs add up their steps, tools are named, and same-named items are told apart', () => {
  for (const m of cr.train) if (m.parts) assert.equal(m.parts.reduce((a, [, x]) => a + x, 0), m.xp, m.id);
  assert.deepEqual(cr.byId.get('cr_piedish').parts, [['shape', 150], ['fire', 100]]);
  assert.deepEqual(cr.byId.get('cr_strung_gold_amulet').parts, [['make', 300], ['string', 40]], 'stringing is always 4 XP');
  assert.equal(cr.byId.get('cr_strung_gold_amulet').name, 'Gold amulet (make & string)');
  assert.equal(cr.byId.get('cr_pot_empty').name, 'Pot (shape & fire)');
  assert.equal(cr.byId.get('cr_sapphire').name, 'Sapphire (cut)');
  const tools = id => cr.byId.get(id).tools;
  assert.deepEqual([tools('cr_coif'), tools('cr_ruby'), tools('cr_ruby_ring'), tools('cr_ruby_necklace'), tools('cr_unstrung_ruby_amulet'), tools('cr_strung_ruby_amulet')],
    [['needle'], ['chisel'], ['ring_mould'], ['necklace_mould'], ['amulet_mould'], ['amulet_mould']]);
  assert.deepEqual([tools('cr_nostringstar'), tools('cr_silver_sickle'), tools('cr_vial_empty'), tools('cr_studded_body')], [['holy_symbol_mould'], ['sickle_mould'], ['glassblowingpipe'], undefined]);
  assert.equal(ITEMS.unstrung_gold_amulet.name, 'Gold amulet (u)');
  assert.equal(ITEMS.strung_gold_amulet.name, 'Gold amulet');
  assert.deepEqual(['dragonhide_blue', 'dragon_leather_blue', 'blue_dragonhide_body', 'blue_dragon_vambraces'].map(k => ITEMS[k].name),
    ['Dragonhide (blue)', 'Dragon leather (blue)', 'Dragonhide body (blue)', 'Dragon vambraces (blue)']);
  assert.equal(ITEMS.dragon_vambraces.name, 'Dragon vambraces (green)');
  // every item a row takes or makes can be typed into the bank (but for the market's sets, which aren't items
  // in the game, and coins, which are a fee and not a supply)
  const banked = new Set(BANK_GROUPS.crafting.flatMap(g => g.items));
  for (const m of cr.methods) for (const k of [...Object.keys(m.in), ...Object.keys(m.out)]) assert.ok(banked.has(k) || ITEMS[k].set || ITEMS[k].gp != null, k);
});

test('crafting: how many to a goal, and the materials, as the calculator works them out', () => {
  // 0 XP to level 2 (83 XP): 7 leather gloves at 13.8, with 7 leather and 2 reels of thread (0.2 each, rounded up)
  const plan = planGoal(cr, { bank: {}, currentXp10: 0, targetXp10: xp10ForLevel(2), useBank: false });
  const gloves = row(plan, 'cr_leather_gloves');
  assert.equal(gloves.needed, 7);
  assert.deepEqual(gloves.collect, { leather: 7, thread: 1.4 }, 'shown as 2 reels: what to collect is whole ones');
  // level 62 to 70: 124,029.6 XP short of 737,627
  const hi = planGoal(cr, { bank: {}, currentXp10: xp10ForLevel(62), targetXp10: xp10ForLevel(70), useBank: false, unlimited: THREAD });
  const toGo = xp10ForLevel(70) - xp10ForLevel(62);
  const staves = Math.ceil(toGo / 1250);
  assert.equal(row(hi, 'cr_fire_battlestaff').needed, staves);
  // (the calculator's fire orb is an unpowered orb charged on the way: see the Charge Orb test)
  assert.deepEqual(row(hi, 'cr_fire_battlestaff').collect, { stafforb: staves, firerune: 30 * staves, cosmicrune: 3 * staves, battlestaff: staves });
  // dragonhide: the calculator's ingredient is the hide (it's tanned on the way, 20 coins each in Al Kharid), 3 to a body;
  // thread left out when you buy it as you go
  assert.deepEqual(row(hi, 'cr_dragonhide_body').collect, { dragonhide_green: 3 * Math.ceil(toGo / 1860), coins: 60 * Math.ceil(toGo / 1860) });
  assert.deepEqual(row(hi, 'cr_dragonhide_body').econ.inputs, { dragonhide_green: 3, coins: 60 });
  // a ring from scratch takes the cut gem, as the calculator lists it
  assert.deepEqual(row(hi, 'cr_sapphire_ring').econ.inputs, { gold_bar: 1, sapphire: 1 });
  assert.deepEqual(row(hi, 'cr_stafforb').econ.inputs, { molten_glass: 1 });
  assert.deepEqual(row(hi, 'cr_studded_body').econ.inputs, { leather_armour: 1, studs: 1 });
});

test('crafting: what one row makes feeds the next: gems are cut and wool is spun on the way, and their XP counts', () => {
  const res = planBank(cr, { bank: { gold_bar: 500, uncut_sapphire: 300, wool: 200 }, startXp10: xp10ForLevel(30), unlimited: THREAD });
  assert.deepEqual(crSteps(res), [
    ['cr_strung_sapphire_amulet', 200, { cr_sapphire: 200, cr_ball_of_wool: 200 }],
    ['cr_unstrung_sapphire_amulet', 100, { cr_sapphire: 100 }],
    ['cr_unstrung_gold_amulet', 200, {}],
  ]);
  assert.equal(res.steps[0].xp10, 200 * (690 + 500 + 25), 'amulet 69 + cutting 50 + spinning 2.5');
  assert.equal(res.xp10, 200 * 1215 + 100 * (650 + 500) + 200 * 300);
  assert.deepEqual(res.steps[0].made, { strung_sapphire_amulet: 200 }, 'the cut sapphires went into the amulets');
  assert.deepEqual(res.leftover.toObject(), { strung_sapphire_amulet: 200, unstrung_sapphire_amulet: 100, unstrung_gold_amulet: 200 });
  // the table: each row on its own counts the uncut gems too, and Round up my supplies knows about them
  const plan = planGoal(cr, { bank: { gold_bar: 500, uncut_sapphire: 300, wool: 200 }, currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(50), unlimited: THREAD });
  assert.equal(row(plan, 'cr_sapphire').have, 300);
  assert.equal(row(plan, 'cr_sapphire_ring').have, 300, '500 bars, 300 sapphires once cut');
  assert.deepEqual(row(plan, 'cr_sapphire_ring').balance, { runs: 500, collect: { sapphire: 200 } });
  assert.deepEqual(row(plan, 'cr_strung_sapphire_amulet').balance, { runs: 500, collect: { sapphire: 200, ball_of_wool: 300 } });
  assert.equal(row(plan, 'cr_strung_sapphire_amulet').fromPlan, 200);
  assert.equal(row(plan, 'cr_sapphire').fromPlan, 0, 'cut on the way: their worth is in the amulets');
  // the rest of the goal is bought as the calculator lists it
  assert.equal(plan.fill.id, 'cr_strung_sapphire_amulet');
  const n = plan.fill.segments[0].runs;
  assert.deepEqual(plan.fill.buy, { gold_bar: n, sapphire: n, ball_of_wool: n });
});

test('crafting: leather is made into bodies and chaps for the studs, molten glass for the orbs', () => {
  const studs = planBank(cr, { bank: { leather: 100, studs: 30 }, startXp10: xp10ForLevel(45), unlimited: THREAD });
  assert.deepEqual(crSteps(studs), [['cr_studded_chaps', 30, { cr_leather_chaps: 30 }], ['cr_coif', 70, {}]]);
  assert.equal(studs.xp10, 30 * (420 + 270) + 70 * 370);
  assert.deepEqual(studs.assumed, { thread: 20 }, '100 items, a reel for every five');
  const glass = planGoal(cr, { bank: { bucket_sand: 200, soda_ash: 150 }, currentXp10: xp10ForLevel(46), targetXp10: xp10ForLevel(50), unlimited: THREAD });
  assert.deepEqual(crSteps(glass.fromBank), [['cr_stafforb', 150, { cr_molten_glass: 150 }]]);
  assert.equal(glass.fromBank.xp10, 150 * (525 + 200));
  assert.deepEqual(glass.fromBank.leftover.toObject(), { bucket_sand: 50, stafforb: 150 });
  assert.equal(row(glass, 'cr_vial_empty').have, 150);
  assert.deepEqual(row(glass, 'cr_molten_glass').balance, { runs: 200, collect: { soda_ash: 50 } });
  assert.deepEqual(row(glass, 'cr_stafforb').balance, { runs: 200, collect: { soda_ash: 50 } }, 'rounding up looks through the glass made on the way');
  const still = row(glass, 'cr_molten_glass').toMake;
  assert.deepEqual(row(glass, 'cr_molten_glass').collect, { bucket_sand: still - 50, soda_ash: still }, 'the sand left over is used first');
  assert.deepEqual(row(glass, 'cr_stafforb').collect, { molten_glass: row(glass, 'cr_stafforb').toMake });
});

test("crafting: unticking a row only stops it being made for its own sake: it's still made on the way to a ticked one (v2.5.2)", () => {
  const bank = { gold_bar: 200, uncut_sapphire: 300, wool: 200 };
  const at = { bank, startXp10: xp10ForLevel(30), unlimited: THREAD };
  // everything ticked: 200 amulets, cutting and spinning on the way, then the 100 sapphires left are cut for their XP
  assert.deepEqual(crSteps(planBank(cr, at)), [['cr_strung_sapphire_amulet', 200, { cr_sapphire: 200, cr_ball_of_wool: 200 }], ['cr_sapphire', 100, {}]]);
  // Sapphire (cut) and Ball of wool unticked: the amulets are made just the same, and the sapphires left over stay uncut
  const res = planBank(cr, { ...at, excluded: new Set(['cr_sapphire', 'cr_ball_of_wool']) });
  assert.deepEqual(crSteps(res), [['cr_strung_sapphire_amulet', 200, { cr_sapphire: 200, cr_ball_of_wool: 200 }]]);
  assert.equal(res.xp10, 200 * (690 + 500 + 25), 'the XP made on the way counts');
  assert.equal(res.leftover.have('uncut_sapphire'), 100);
  // (up to v2.5.1 unticking it kept uncut sapphires out of the jewellery as well)
  const plan = planGoal(cr, { bank, currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(50), unlimited: THREAD, excluded: new Set(['cr_sapphire']) });
  assert.equal(row(plan, 'cr_sapphire_ring').have, 200);
  assert.deepEqual(row(plan, 'cr_sapphire_ring').balance, { runs: 300, collect: { gold_bar: 100 } });
  assert.ok(!plan.fromBank.steps.some(st => st.id === 'cr_sapphire'), 'not a step of its own');
  // to keep the uncut sapphires, untick what would use them
  const kept = planBank(cr, { ...at, excluded: new Set(cr.train.filter(m => m.in.sapphire).map(m => m.id).concat('cr_sapphire')) });
  assert.equal(kept.leftover.have('uncut_sapphire'), 300);
  // glass, orbs and key halves are the same: Molten glass, Unpowered orb and Dragonstone (cut) unticked,
  // sand and soda ash still become orbs for the battlestaves, and key halves dragonstones for the ring
  const chain = planBank(cr, { bank: { bucket_sand: 50, soda_ash: 50, battlestaff: 50, cosmicrune: 150, airrune: 1500, keyhalf1: 9, keyhalf2: 4, gold_bar: 10 },
    startXp10: xp10ForLevel(70), unlimited: THREAD, excluded: new Set(['cr_molten_glass', 'cr_stafforb', 'cr_dragonstone', 'cr_gold_ring', 'cr_gold_necklace', 'cr_unstrung_gold_amulet']) });
  assert.deepEqual(crSteps(chain), [
    ['cr_air_battlestaff', 50, { cr_molten_glass: 50, cr_stafforb: 50, cr_charge_air_orb: 50 }],
    ['cr_dragonstone_ring', 4, { cr_join_keys: 4, cr_crystal_chest: 4, cr_dragonstone: 4 }],
  ]);
});

test('crafting: dragonhide is tanned on the way; dragon leather in the bank goes first', () => {
  const bank = { dragonhide_green: 300, dragon_leather: 50 };
  const res = planBank(cr, { bank, startXp10: xp10ForLevel(63), unlimited: THREAD });
  assert.deepEqual(crSteps(res), [['cr_set_green_dhide', 58, { cr_tan_dragonhide_green: 298 }], ['cr_dragonhide_chaps', 1, { cr_tan_dragonhide_green: 2 }]]);
  assert.equal(res.xp10, 58 * 3720 + 1240, 'tanning gives no XP');
  // (vambraces, chaps and bodies all give the same XP a hide, so sets or bodies come to the same)
  const bodies = planBank(cr, { bank, startXp10: xp10ForLevel(63), unlimited: THREAD, excluded: new Set(['cr_set_green_dhide']) });
  assert.deepEqual(crSteps(bodies), [['cr_dragonhide_body', 116, { cr_tan_dragonhide_green: 298 }], ['cr_dragonhide_chaps', 1, { cr_tan_dragonhide_green: 2 }]]);
  assert.equal(bodies.xp10, res.xp10);
  assert.equal(cr.byId.get('cr_tan_dragonhide_green').kind, 'prep');
  assert.ok(!cr.train.some(m => m.group === 'Tanning'), 'not a way to train');
  const plan = planGoal(cr, { bank, currentXp10: xp10ForLevel(63), targetXp10: xp10ForLevel(70), unlimited: THREAD });
  assert.equal(row(plan, 'cr_dragon_vambraces').have, 350, 'hides and leather alike');
});

test("crafting: the tanner's fee is counted, Al Kharid's or the dearer one in Canifis (v2.5)", () => {
  // the server's fees a hide: leather 1, hard leather 3, dragonhide 20 in Al Kharid; 2, 5 and 45 in Canifis
  const tan = (ix, id) => { const m = ix.byId.get(id); return [m.kind, m.xp, m.in, m.out]; };
  assert.deepEqual(tan(cr, 'cr_tan_dragonhide_black'), ['prep', 0, { dragonhide_black: 1, coins: 20 }, { dragon_leather_black: 1 }]);
  assert.deepEqual(tan(cr, 'cr_tan_leather'), ['source', 0, { cow_hide: 1, coins: 1 }, { leather: 1 }]);
  assert.deepEqual(tan(cr, 'cr_tan_hard_leather'), ['source', 0, { cow_hide: 1, coins: 3 }, { hard_leather: 1 }]);
  assert.deepEqual(['cr_tan_dragonhide_black', 'cr_tan_leather', 'cr_tan_hard_leather'].map(id => crCanifis.byId.get(id).in.coins), [45, 2, 5]);
  assert.deepEqual(PLACES.crafting.options.map(o => [o.id, o.name, o.short]), [['al_kharid', 'Al Kharid', '20 gp a dragonhide'], ['canifis', 'Canifis', '45 gp a dragonhide']]);
  assert.equal(PLACES.crafting.options[1].note, 'leather 2 gp, hard leather 5 gp, dragonhide 45 gp a hide');
  assert.equal(ITEMS.coins.gp, 1, 'a coin is always 1 gp');
  assert.deepEqual([...cr.fees], ['coins']);
  assert.equal(ix.fees.size, 0, 'no fees in Herblore');

  // From the bank: the fee is paid, not taken from it, and never holds the plan back.
  const bank = { dragonhide_green: 300, dragon_leather: 50, coins: 5 };
  const res = planBank(cr, { bank, startXp10: xp10ForLevel(63), unlimited: THREAD });
  assert.deepEqual(crSteps(res), [['cr_set_green_dhide', 58, { cr_tan_dragonhide_green: 298 }], ['cr_dragonhide_chaps', 1, { cr_tan_dragonhide_green: 2 }]]);
  assert.deepEqual(res.steps.map(s => s.paid), [{ coins: 298 * 20 }, { coins: 2 * 20 }]);
  assert.deepEqual(res.paid, { coins: 300 * 20 });
  assert.deepEqual(res.assumed, { thread: 35 }, 'the fee is apart from what you buy as you go');
  assert.equal(res.leftover.have('coins'), 5, 'coins in a bank are left alone');
  assert.deepEqual(planBank(crCanifis, { bank, startXp10: xp10ForLevel(63), unlimited: THREAD }).paid, { coins: 300 * 45 });
  assert.equal(planBank(cr, { bank: { dragon_leather: 50 }, startXp10: xp10ForLevel(63), unlimited: THREAD }).paid, undefined, 'leather needs no tanner');

  // The money. A coin needs no price: it's 1 gp.
  const price = { dragonhide_green: 2000, set_green_dhide: 30000, dragonhide_chaps: 9000, dragonhide_body: 12000 };
  const opts = { bank, currentXp10: xp10ForLevel(63), targetXp10: xp10ForLevel(70), unlimited: THREAD, priceOf: k => price[k] ?? null };
  const plan = planGoal(cr, opts);
  const set = row(plan, 'cr_set_green_dhide'), body = row(plan, 'cr_dragonhide_body');
  assert.deepEqual(set.econ.inputs, { dragonhide_green: 6, coins: 120 });
  assert.equal(set.econ.cost, 6 * 2000 + 120);
  assert.equal(set.econ.net, 30000 - 6 * 2000 - 120);
  // what the bank plan makes of it, and the fee for the 298 hides tanned for it
  assert.deepEqual(set.gains.before, { total: 58 * 30000 - 5960, value: 58 * 30000, cost: 5960, missing: [] });
  assert.equal(set.gains.net.total, set.gains.before.total + set.gains.collect.total);
  // on its own the bank makes 116 bodies, tanning 298 hides for them
  assert.equal(body.have, 116);
  assert.equal(body.balance, null);
  assert.deepEqual(body.gains.even, { total: 116 * 12000 - 5960, value: 116 * 12000, cost: 5960, missing: [] });
  // the rest of the goal: hides, and the coins to tan them
  const n = plan.fill.segments[0].runs;
  assert.equal(plan.fill.id, 'cr_set_green_dhide');
  assert.deepEqual(plan.fill.buy, { dragonhide_green: 6 * n, coins: 120 * n });
  assert.equal(plan.fill.cost, 6 * n * 2000 + 120 * n);
  // Canifis: the same plan, 45 a hide
  const far = planGoal(crCanifis, opts);
  assert.equal(row(far, 'cr_set_green_dhide').econ.cost, 6 * 2000 + 270);
  assert.equal(row(far, 'cr_set_green_dhide').gains.before.cost, 298 * 45);
  assert.equal(far.fromBank.xp10, plan.fromBank.xp10);
  // a mix: the fee is part of what each step takes
  const mix = planGoal(cr, { ...opts, useBank: false, mix: { cr_dragonhide_body: 10 } }).fromMix;
  assert.deepEqual(mix.buy, { dragonhide_green: 30, coins: 600 });
  assert.equal(mix.gain.total, 10 * 12000 - 30 * 2000 - 600);

  // Cowhide is tanned when it's in your bank; from scratch a row takes leather, as the calculator lists it.
  const cow = planGoal(cr, { bank: { cow_hide: 100, leather: 10 }, currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(40), unlimited: THREAD });
  assert.deepEqual(crSteps(cow.fromBank), [['cr_hardleather_body', 100, { cr_tan_hard_leather: 100 }], ['cr_leather_chaps', 10, {}]]);
  assert.deepEqual(cow.fromBank.paid, { coins: 300 }, '3 gp a hide for hard leather');
  const gloves = row(cow, 'cr_leather_gloves');
  assert.equal(gloves.have, 110, '10 leather and 100 cowhides');
  assert.deepEqual(gloves.econ.inputs, { leather: 1 });
  assert.deepEqual(gloves.collect, { leather: gloves.toMake });
  assert.equal(row(planGoal(crCanifis, { bank: { cow_hide: 100 }, currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(40), unlimited: THREAD, priceOf: () => 100 }), 'cr_leather_gloves').gains.even.cost, 200, '2 gp a hide in Canifis');
});

test('crafting: key halves and crystal keys count as the uncut dragonstone the crystal chest gives (v2.5)', () => {
  assert.deepEqual(['keyhalf1', 'keyhalf2', 'crystal_key'].map(k => ITEMS[k].name), ['Half of a key (tooth)', 'Half of a key (loop)', 'Crystal key']);
  const src = id => { const m = cr.byId.get(id); return [m.kind, m.xp, m.in, m.out]; };
  assert.deepEqual(src('cr_join_keys'), ['source', 0, { keyhalf1: 1, keyhalf2: 1 }, { crystal_key: 1 }]);
  assert.deepEqual(src('cr_crystal_chest'), ['source', 0, { crystal_key: 1 }, { uncut_dragonstone: 1 }]);
  assert.deepEqual(BANK_GROUPS.crafting.find(g => g.name === 'Crystal keys').items, ['keyhalf1', 'keyhalf2', 'crystal_key']);
  assert.ok(!cr.train.some(m => m.group === 'Crystal keys'), 'no XP in it: not a way to train');

  // Ostap's example: 9 teeth and 4 loops are 4 uncut dragonstones for now, and 5 more loops round them up to 9.
  const price = { keyhalf1: 9000, keyhalf2: 6000, dragonstone: 15000, uncut_dragonstone: 14000, gold_bar: 300 };
  const opts = { bank: { keyhalf1: 9, keyhalf2: 4 }, currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(70), unlimited: THREAD, priceOf: k => price[k] ?? null };
  const plan = planGoal(cr, opts);
  assert.deepEqual(crSteps(plan.fromBank), [['cr_dragonstone', 4, { cr_join_keys: 4, cr_crystal_chest: 4 }]]);
  assert.equal(plan.fromBank.xp10, 4 * 1375, 'the XP is in the cutting');
  assert.deepEqual(plan.fromBank.leftover.toObject(), { keyhalf1: 5, dragonstone: 4 });
  const cut = row(plan, 'cr_dragonstone');
  assert.equal(cut.have, 4);
  assert.deepEqual(cut.balance, { runs: 9, collect: { keyhalf2: 5 } });
  assert.deepEqual(cut.gains.even, { total: 9 * 15000 - 5 * 6000, value: 9 * 15000, cost: 5 * 6000, missing: [] });
  assert.deepEqual(cut.gains.before, { total: 4 * 15000, value: 4 * 15000, cost: 0, missing: [] });
  // from scratch it's bought as the uncut stone, like the calculator lists it: keys are only used from your bank
  assert.deepEqual(cut.econ.inputs, { uncut_dragonstone: 1 });
  assert.deepEqual(cut.collect, { uncut_dragonstone: cut.toMake });
  // a ring takes a gold bar as well
  assert.equal(row(plan, 'cr_dragonstone_ring').have, 0);
  assert.deepEqual(row(plan, 'cr_dragonstone_ring').balance, { runs: 9, collect: { gold_bar: 9, keyhalf2: 5 } });
  // whole keys and uncut stones in the bank add up with them
  const more = planGoal(cr, { ...opts, bank: { keyhalf1: 9, keyhalf2: 4, crystal_key: 2, uncut_dragonstone: 3, gold_bar: 20 } });
  assert.equal(row(more, 'cr_dragonstone').have, 9);
  assert.deepEqual(row(more, 'cr_dragonstone').balance, { runs: 14, collect: { keyhalf2: 5 } });
  assert.deepEqual(crSteps(more.fromBank).slice(0, 2), [['cr_dragonstone', 9, { cr_join_keys: 4, cr_crystal_chest: 6 }], ['cr_dragonstone_ring', 9, {}]],
    '4 keys joined, 6 chests opened, 9 stones cut, then set in rings');
  // Round up my supplies: the 5 loops are collected, and the teeth left over are used
  const up = planGoal(cr, { ...opts, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(up).slice(0, 2), [['cr_dragonstone', 4, false, null], ['cr_dragonstone', 5, true, { keyhalf2: 5 }]]);
  assert.equal(up.collect.keyhalf2, 5);
  assert.equal(up.leftover.have('keyhalf1'), 0);
  // unticking the cutting leaves the keys alone
  const off = planGoal(cr, { ...opts, excluded: new Set(['cr_dragonstone']) });
  assert.deepEqual(off.fromBank.steps, []);
});

test('crafting: a reel of thread lasts five items, when you count it', () => {
  const bank = { dragonhide_green: 300, dragon_leather: 50, thread: 10 };
  const plan = planGoal(cr, { bank, currentXp10: xp10ForLevel(63), targetXp10: xp10ForLevel(70) });
  assert.deepEqual(crSteps(plan.fromBank), [['cr_dragonhide_body', 50, { cr_tan_dragonhide_green: 100 }]], '10 reels: 50 bodies');
  assert.equal(plan.fromBank.leftover.have('thread'), 0);
  const body = row(plan, 'cr_dragonhide_body');
  assert.equal(body.have, 50);
  assert.deepEqual(body.balance, { runs: 116, collect: { thread: 13.2 }, paid: { coins: 298 * 20 } }, '23.2 reels for 116 bodies, 10 in the bank (shown as 14); the tanner is paid for the 298 hides');
  assert.deepEqual(body.collect, { dragonhide_green: 3 * body.toMake - 200, coins: 60 * body.toMake, thread: body.toMake / 5 });
  for (const [reels, items] of [[1, 5], [3, 15], [7, 35], [29, 145], [333, 1665]]) {
    const r = planBank(cr, { bank: { leather: 5000, thread: reels }, startXp10: 0 });
    assert.equal(r.steps.reduce((a, s) => a + s.runs, 0), items, `${reels} reels`);
    assert.equal(r.leftover.have('thread'), 0);
    assert.equal(r.leftover.have('leather'), 5000 - items);
  }
  assert.deepEqual(crSteps(planBank(cr, { bank: { leather: 5000, thread: 3 }, startXp10: 0 })), [['cr_leather_gloves', 15, {}]]);
  // with "I'll buy thread as I go" it never holds a plan back, and is left out of what to collect
  const on = planGoal(cr, { bank, currentXp10: xp10ForLevel(63), targetXp10: xp10ForLevel(70), unlimited: THREAD });
  assert.equal(row(on, 'cr_dragonhide_body').have, 116);
  assert.equal(row(on, 'cr_dragonhide_body').balance, null);
  assert.equal(row(on, 'cr_dragonhide_body').collect.thread, undefined);
});

test('crafting: a better row is switched to as soon as its level is reached, counting the XP made on the way', () => {
  // You picked amulets (level 24) at level 23, 737 XP short: 8 sapphire necklaces get you there
  // (55, plus 50 for each sapphire cut), not the 14 it would take without the cutting.
  const bank = { gold_bar: 100, uncut_sapphire: 100 };
  const res = planBank(cr, { bank, startXp10: xp10ForLevel(23), unlimited: THREAD, prefer: 'cr_unstrung_sapphire_amulet' });
  assert.deepEqual(crSteps(res), [['cr_sapphire_necklace', 8, { cr_sapphire: 8 }], ['cr_unstrung_sapphire_amulet', 92, { cr_sapphire: 92 }]]);
  assert.ok(xp10ForLevel(23) + 7 * 1050 < xp10ForLevel(24) && xp10ForLevel(23) + 8 * 1050 >= xp10ForLevel(24));
  // With nothing picked, the plan with the most XP wins: cut them all first (that alone
  // passes level 24), and every sapphire goes into an amulet.
  const free = planBank(cr, { bank, startXp10: xp10ForLevel(23), unlimited: THREAD });
  assert.deepEqual(crSteps(free), [['cr_sapphire', 100, {}], ['cr_unstrung_sapphire_amulet', 100, {}]]);
  assert.ok(free.xp10 > res.xp10);
});

test('crafting: in a mix, what one row makes for another is used rather than bought as well', () => {
  const price = { uncut_sapphire: 300, sapphire: 3000, gold_bar: 3600, sapphire_ring: 10800 };
  const plan = planGoal(cr, { useBank: false, bank: { gold_bar: 999 }, mix: { cr_sapphire: 100, cr_sapphire_ring: 100 }, unlimited: THREAD,
    currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(40), priceOf: k => price[k] ?? null });
  const mix = plan.fromMix;
  assert.deepEqual(mix.steps.map(s => [s.id, s.runs, s.buy]), [
    ['cr_sapphire_ring', 100, { gold_bar: 100, sapphire: 100 }],          // each step on its own, from scratch
    ['cr_sapphire', 100, { uncut_sapphire: 100 }],
  ]);
  assert.equal(mix.xp10, 100 * 400 + 100 * 500);
  assert.deepEqual(mix.buy, { gold_bar: 100, uncut_sapphire: 100 }, 'the sapphires you cut go into the rings');
  assert.deepEqual(mix.made, { sapphire_ring: 100 });
  assert.equal(mix.gain.total, 100 * (10800 - 3600 - 300));
  assert.equal(mix.gain.total, mix.steps.reduce((a, s) => a + s.gain.total, 0), 'the same net either way');
  // more rings than sapphires cut: the rest is bought
  const more = planGoal(cr, { useBank: false, mix: { cr_sapphire: 40, cr_sapphire_ring: 100 }, currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(40) }).fromMix;
  assert.deepEqual(more.buy, { gold_bar: 100, sapphire: 60, uncut_sapphire: 40 });
  assert.deepEqual(more.made, { sapphire_ring: 100 });
});

test('crafting: dragonhide sets, the three pieces the market trades as one (v2.5)', () => {
  const set = id => { const m = cr.byId.get(id); return [m.level, m.xp, m.in, m.out, m.parts]; };
  assert.deepEqual(set('cr_set_green_dhide'), [63, 3720, { dragon_leather: 6, thread: 0.6 }, { set_green_dhide: 1 }, [['vambraces', 620], ['chaps', 1240], ['body', 1860]]]);
  assert.deepEqual(set('cr_set_blue_dhide').slice(0, 3), [71, 4200, { dragon_leather_blue: 6, thread: 0.6 }]);
  assert.deepEqual(set('cr_set_red_dhide').slice(0, 3), [77, 4680, { dragon_leather_red: 6, thread: 0.6 }]);
  assert.deepEqual(set('cr_set_black_dhide').slice(0, 3), [84, 5160, { dragon_leather_black: 6, thread: 0.6 }]);
  // a set is its three rows added up: XP, hides and thread
  for (const [id, parts] of [['cr_set_green_dhide', ['cr_dragon_vambraces', 'cr_dragonhide_chaps', 'cr_dragonhide_body']], ['cr_set_black_dhide', ['cr_black_dragon_vambraces', 'cr_black_dragonhide_chaps', 'cr_black_dragonhide_body']]]) {
    const m = cr.byId.get(id), rows = parts.map(p => cr.byId.get(p));
    assert.equal(m.xp, rows.reduce((a, r) => a + r.xp, 0));
    assert.equal(m.level, Math.max(...rows.map(r => r.level)), 'the body\'s level');
    assert.deepEqual(Object.values(m.in), [rows.reduce((a, r) => a + Object.values(r.in)[0], 0), 0.6]);
    assert.deepEqual(m.parts.map(([, x]) => x), rows.map(r => r.xp));
  }
  // the market's own item: its slug and name, worth its pieces put together, and never in a bank
  assert.deepEqual(ITEMS.set_red_dhide, { id: 1000003, name: "Red d'hide set", cost: 20010, members: 1, icon: ITEMS.red_dragonhide_body.icon, set: ['red_dragon_vambraces', 'red_dragonhide_chaps', 'red_dragonhide_body'] });
  assert.equal(ITEMS.set_red_dhide.cost, ITEMS.red_dragon_vambraces.cost + ITEMS.red_dragonhide_chaps.cost + ITEMS.red_dragonhide_body.cost);
  assert.deepEqual(SALE_GROUPS.crafting, [{ name: 'Dragonhide sets', items: ['set_green_dhide', 'set_blue_dhide', 'set_red_dhide', 'set_black_dhide'] }]);
  assert.ok(!BANK_GROUPS.crafting.some(g => g.items.some(k => ITEMS[k].set)));
  // priced as a set: what one set sells for, less six hides (thread bought as you go)
  const price = { set_green_dhide: 30000, dragonhide_green: 2000, dragonhide_body: 12000 };
  const plan = planGoal(cr, { bank: {}, useBank: false, unlimited: THREAD, currentXp10: xp10ForLevel(63), targetXp10: xp10ForLevel(70), priceOf: k => price[k] ?? null });
  assert.deepEqual(row(plan, 'cr_set_green_dhide').econ.inputs, { dragonhide_green: 6, coins: 120 });
  assert.equal(row(plan, 'cr_set_green_dhide').econ.net, 30000 - 6 * 2000 - 6 * 20, 'less the tanner\'s fee');
  assert.equal(row(plan, 'cr_dragonhide_body').econ.net, 12000 - 3 * 2000 - 3 * 20);
  assert.equal(row(plan, 'cr_set_green_dhide').needed, Math.ceil((xp10ForLevel(70) - xp10ForLevel(63)) / 3720));
});

test('crafting: enchanted jewellery, for what it sells as: the runes are counted, the Crafting XP is the plain one\'s (v2.5)', () => {
  const r = id => { const m = cr.byId.get(id); return [m.level, m.xp, m.in, m.out]; };
  // the server's enchant spells: Lvl-1 a water rune, Lvl-2 3 air, Lvl-3 5 fire, Lvl-4 10 earth, Lvl-5 15 earth and 15 water, and a cosmic rune each
  assert.deepEqual(r('cr_ench_ring_of_recoil'), [20, 400, { gold_bar: 1, sapphire: 1, waterrune: 1, cosmicrune: 1 }, { ring_of_recoil: 1 }]);
  assert.deepEqual(r('cr_ench_necklace_of_minigames_8'), [20, 550, { gold_bar: 1, sapphire: 1, waterrune: 1, cosmicrune: 1 }, { necklace_of_minigames_8: 1 }]);
  assert.deepEqual(r('cr_ench_ring_of_dueling_8'), [27, 550, { gold_bar: 1, emerald: 1, airrune: 3, cosmicrune: 1 }, { ring_of_dueling_8: 1 }]);
  assert.deepEqual(r('cr_ench_amulet_of_strength'), [50, 890, { gold_bar: 1, ruby: 1, ball_of_wool: 1, firerune: 5, cosmicrune: 1 }, { amulet_of_strength: 1 }]);
  assert.deepEqual(r('cr_ench_ring_of_life'), [43, 850, { gold_bar: 1, diamond: 1, earthrune: 10, cosmicrune: 1 }, { ring_of_life: 1 }]);
  assert.deepEqual(r('cr_ench_amulet_of_glory_4'), [80, 1540, { gold_bar: 1, dragonstone: 1, ball_of_wool: 1, earthrune: 15, waterrune: 15, cosmicrune: 1 }, { amulet_of_glory_4: 1 }]);
  const ench = cr.train.filter(m => m.id.startsWith('cr_ench_'));
  assert.deepEqual(ench.map(m => ITEMS[Object.keys(m.out)[0]].name), ['Ring of recoil', 'Games necklace(8)', 'Amulet of magic', 'Ring of dueling(8)', 'Amulet of defence',
    'Ring of forging', 'Ring of life', 'Amulet of strength', 'Ring of wealth', 'Amulet of power', 'Amulet of glory(4)']);
  // each sits right after the row it's made from, with that row's level, XP and tools
  for (const m of ench) {
    const before = cr.train[cr.train.indexOf(m) - 1];
    assert.deepEqual([m.level, m.xp, m.tools, m.group, m.parts], [before.level, before.xp, before.tools, 'Jewellery', before.parts], m.id);
    for (const [k, n] of Object.entries(before.in)) assert.equal(m.in[k], n);
    assert.match(m.note, /^Enchanted with Lvl-[1-5] Enchant \(Magic \d+\): [\d.]+ Magic XP each, on top of the Crafting XP\./);
  }
  // the Magic XP of one cast, from the same spells (in tenths): 17.5, 37, 59, 67 and 78
  const cast = id => { const m = cr.byId.get(id); return [m.spell, m.magicLevel, m.magic]; };
  assert.deepEqual(cast('cr_ench_necklace_of_minigames_8'), ['Lvl-1 Enchant', 7, 175]);
  assert.deepEqual(cast('cr_ench_ring_of_dueling_8'), ['Lvl-2 Enchant', 27, 370]);
  assert.deepEqual(cast('cr_ench_ring_of_forging'), ['Lvl-3 Enchant', 49, 590]);
  assert.deepEqual(cast('cr_ench_ring_of_life'), ['Lvl-4 Enchant', 57, 670]);
  assert.deepEqual(cast('cr_ench_amulet_of_glory_4'), ['Lvl-5 Enchant', 68, 780]);
  assert.equal(cr.byId.get('cr_ench_ring_of_dueling_8').note, 'Enchanted with Lvl-2 Enchant (Magic 27): 37 Magic XP each, on top of the Crafting XP.');
  assert.equal(cr.byId.get('cr_emerald_ring').magic, undefined);
  assert.match(cr.byId.get('cr_ench_amulet_of_glory_4').note, /Magic 68\).*Then charged at the Fountain of Heroes\.$/);
  assert.equal(cr.byId.get('cr_ench_ring_of_dueling_8').name, 'Ring of dueling(8) (make & enchant)');
  assert.equal(cr.byId.get('cr_ench_amulet_of_glory_4').name, 'Amulet of glory(4) (make, string & enchant)');
  // the money: what the enchanted one sells for, less the bar, the gem, the wool and the runes
  const price = { gold_bar: 500, dragonstone: 20000, ball_of_wool: 50, earthrune: 10, waterrune: 8, cosmicrune: 150, amulet_of_glory_4: 40000, strung_dragonstone_amulet: 25000 };
  const plan = planGoal(cr, { bank: {}, useBank: false, currentXp10: xp10ForLevel(80), targetXp10: xp10ForLevel(85), priceOf: k => price[k] ?? null });
  const glory = row(plan, 'cr_ench_amulet_of_glory_4'), plain = row(plan, 'cr_strung_dragonstone_amulet');
  assert.equal(plain.econ.net, 25000 - 500 - 20000 - 50);
  assert.equal(glory.econ.cost, 500 + 20000 + 50 + 15 * 10 + 15 * 8 + 150);
  assert.equal(glory.econ.net, 40000 - glory.econ.cost);
  assert.equal(glory.needed, plain.needed, 'the same Crafting XP each');
  assert.deepEqual(glory.collect, { gold_bar: glory.needed, dragonstone: glory.needed, ball_of_wool: glory.needed, earthrune: 15 * glory.needed, waterrune: 15 * glory.needed, cosmicrune: glory.needed });
});

test('crafting: the bank makes the plain one unless you pick the enchanted one and have the runes (v2.5)', () => {
  const bank = { gold_bar: 100, dragonstone: 100, earthrune: 1500, waterrune: 1500, cosmicrune: 60 };
  const plain = planBank(cr, { bank, startXp10: xp10ForLevel(60), unlimited: THREAD });
  assert.deepEqual(crSteps(plain), [['cr_dragonstone_ring', 100, {}]], 'the same XP either way, so the runes are left alone');
  const picked = planBank(cr, { bank, startXp10: xp10ForLevel(60), unlimited: THREAD, prefer: 'cr_ench_ring_of_wealth' });
  assert.deepEqual(crSteps(picked), [['cr_ench_ring_of_wealth', 60, {}], ['cr_dragonstone_ring', 40, {}]], '60 cosmic runes: 60 rings of wealth');
  assert.equal(picked.xp10, plain.xp10);
  assert.deepEqual(picked.leftover.toObject(), { earthrune: 600, waterrune: 600, ring_of_wealth: 60, dragonstone_ring: 40 });
  // uncut dragonstones are cut on the way for the enchanted ring too
  const cut = planBank(cr, { bank: { gold_bar: 10, uncut_dragonstone: 10, earthrune: 150, waterrune: 150, cosmicrune: 10 }, startXp10: xp10ForLevel(60), unlimited: THREAD, prefer: 'cr_ench_ring_of_wealth' });
  assert.deepEqual(crSteps(cut), [['cr_ench_ring_of_wealth', 10, { cr_dragonstone: 10 }]]);
  assert.equal(cut.xp10, 10 * (1000 + 1375));
  // Round up my supplies says which runes are short
  const plan = planGoal(cr, { bank, currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(65), unlimited: THREAD });
  assert.equal(row(plan, 'cr_ench_ring_of_wealth').have, 60);
  assert.deepEqual(row(plan, 'cr_ench_ring_of_wealth').balance, { runs: 100, collect: { cosmicrune: 40 } });
  assert.equal(row(plan, 'cr_dragonstone_ring').have, 100);
});

test("crafting: a battlestaff's orb is charged on the way: the spell's runes are counted, and unpowered orbs or molten glass in your bank are used (v2.5.2)", () => {
  // the server's Charge Orb spells: an unpowered orb, 30 of the element's runes and 3 cosmic runes. No Crafting XP: a step on the way
  const step = id => { const m = cr.byId.get(id); return [m.kind, m.xp, m.in, m.out, m.spell, m.magicLevel, m.magic]; };
  assert.deepEqual(step('cr_charge_water_orb'), ['prep', 0, { stafforb: 1, waterrune: 30, cosmicrune: 3 }, { water_orb: 1 }, 'Charge Water Orb', 56, 660]);
  assert.deepEqual(step('cr_charge_earth_orb'), ['prep', 0, { stafforb: 1, earthrune: 30, cosmicrune: 3 }, { earth_orb: 1 }, 'Charge Earth Orb', 60, 700]);
  assert.deepEqual(step('cr_charge_fire_orb'), ['prep', 0, { stafforb: 1, firerune: 30, cosmicrune: 3 }, { fire_orb: 1 }, 'Charge Fire Orb', 63, 730]);
  assert.deepEqual(step('cr_charge_air_orb'), ['prep', 0, { stafforb: 1, airrune: 30, cosmicrune: 3 }, { air_orb: 1 }, 'Charge Air Orb', 66, 760]);
  assert.ok(!cr.train.some(m => m.id.startsWith('cr_charge_')), 'not a way to train Crafting, so not a row');
  // the rows themselves are the calculator's: an orb and a battlestaff
  assert.deepEqual(cr.byId.get('cr_air_battlestaff').in, { air_orb: 1, battlestaff: 1 });
  assert.match(cr.byId.get('cr_air_battlestaff').note, /^The orb is an unpowered orb charged with Charge Air Orb \(Magic 66\): 76 Magic XP each\./);
  assert.equal(cr.byId.get('cr_stafforb').feeds, 1, 'unpowered orbs are blown on the way, like gems are cut');

  // from scratch: the unpowered orb and the runes stand in for the orb, in the list and in the money
  const price = { battlestaff: 7000, stafforb: 400, air_orb: 1500, airrune: 5, cosmicrune: 100, air_battlestaff: 9500 };
  const at = { currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(80), unlimited: THREAD, priceOf: k => price[k] ?? null };
  const scratch = planGoal(cr, { ...at, bank: {}, useBank: false });
  const air = row(scratch, 'cr_air_battlestaff');
  assert.deepEqual(air.econ.inputs, { stafforb: 1, airrune: 30, cosmicrune: 3, battlestaff: 1 });
  assert.equal(air.econ.cost, 400 + 30 * 5 + 3 * 100 + 7000);
  assert.equal(air.econ.net, 9500 - 7850);
  assert.deepEqual(air.collect, { stafforb: air.needed, airrune: 30 * air.needed, cosmicrune: 3 * air.needed, battlestaff: air.needed });

  // from the bank: charged orbs first, then unpowered orbs, then molten glass blown on the way (52.5 XP each),
  // as far as the runes go (600 cosmic and 6,000 air charge 200)
  const bank = { air_orb: 100, stafforb: 50, molten_glass: 200, battlestaff: 1000, cosmicrune: 600, airrune: 6000 };
  const res = planBank(cr, { bank, startXp10: xp10ForLevel(70), unlimited: THREAD });
  assert.deepEqual(crSteps(res), [['cr_air_battlestaff', 300, { cr_stafforb: 150, cr_charge_air_orb: 200 }], ['cr_stafforb', 50, {}]]);
  assert.equal(res.xp10, 300 * 1375 + 150 * 525 + 50 * 525, 'the orbs blown on the way count');
  assert.deepEqual(res.leftover.toObject(), { stafforb: 50, battlestaff: 700, air_battlestaff: 300 });
  // with no runes in the bank the orbs can't be charged: the glass is only blown
  assert.deepEqual(crSteps(planBank(cr, { bank: { molten_glass: 200, battlestaff: 1000 }, startXp10: xp10ForLevel(70), unlimited: THREAD })), [['cr_stafforb', 200, {}]]);
  // Unpowered orb unticked: the orbs are still blown on the way to a battlestaff
  assert.deepEqual(crSteps(planBank(cr, { bank: { ...bank, air_orb: 0, stafforb: 0 }, startXp10: xp10ForLevel(70), unlimited: THREAD, excluded: new Set(['cr_stafforb']) })),
    [['cr_air_battlestaff', 200, { cr_stafforb: 200, cr_charge_air_orb: 200 }]]);

  // the rest of a goal counts the glass too: 2,000 molten glass are 2,000 fewer orbs to buy
  const goal = planGoal(cr, { ...at, bank: { molten_glass: 2000 }, fillId: 'cr_air_battlestaff' });
  assert.deepEqual(crSteps(goal.fromBank), [['cr_stafforb', 2000, {}]]);
  const n = goal.fill.segments[0].runs;
  assert.deepEqual(goal.fill.segments.map(x => x.id), ['cr_air_battlestaff']);
  assert.deepEqual(goal.fill.buy, { stafforb: n - 2000, airrune: 30 * n, cosmicrune: 3 * n, battlestaff: n });
  assert.deepEqual(row(goal, 'cr_air_battlestaff').collect, goal.fill.buy);
});

test('crafting: the Magic XP of the spells cast on the way is added up (v2.5.2)', () => {
  // 200 orbs charged on the way to 300 air battlestaves
  const res = planBank(cr, { bank: { air_orb: 100, stafforb: 250, battlestaff: 1000, cosmicrune: 600, airrune: 6000 }, startXp10: xp10ForLevel(70), unlimited: THREAD });
  const counts = fb => fb.steps.flatMap(st => [[st.id, st.runs], ...Object.entries(st.sub)]);
  assert.deepEqual(castsIn(cr, counts(res)), { xp10: 200 * 760, level: 66, by: { cr_charge_air_orb: 200 } });
  // enchanted jewellery: the row itself is the cast
  const rings = planBank(cr, { bank: { gold_bar: 100, emerald: 60, dragonstone: 10, airrune: 500, cosmicrune: 100, earthrune: 150, waterrune: 150 }, startXp10: xp10ForLevel(60), unlimited: THREAD,
    excluded: new Set(cr.train.filter(m => m.group === 'Jewellery' && !m.magic).map(m => m.id)) });
  assert.deepEqual(crSteps(rings), [['cr_ench_ring_of_wealth', 10, {}], ['cr_ench_ring_of_dueling_8', 60, {}]]);
  assert.deepEqual(castsIn(cr, counts(rings)), { xp10: 10 * 780 + 60 * 370, level: 68, by: { cr_ench_ring_of_wealth: 10, cr_ench_ring_of_dueling_8: 60 } });
  // nothing cast: nothing to report
  assert.equal(castsIn(cr, counts(planBank(cr, { bank: { gold_bar: 100, emerald: 60 }, startXp10: xp10ForLevel(60), unlimited: THREAD }))), null);
  assert.equal(castsIn(ix, [['hb_3dose2strength', 500]]), null);
  // a mix you plan yourself says what it casts, and a goal's remaining part lists it in its steps
  const plan = planGoal(cr, { bank: {}, useBank: false, currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(80), unlimited: THREAD,
    mix: { cr_air_battlestaff: 100, cr_ench_ring_of_dueling_8: 50, cr_emerald_ring: 20 }, fillId: 'cr_fire_battlestaff' });
  assert.deepEqual(plan.fromMix.steps.map(st => [st.id, st.casts]), [['cr_ench_ring_of_dueling_8', { cr_ench_ring_of_dueling_8: 50 }], ['cr_emerald_ring', undefined], ['cr_air_battlestaff', { cr_charge_air_orb: 100 }]]);
  const runs = plan.fill.segments[0].runs;
  assert.deepEqual(castsIn(cr, Object.entries(plan.fill.steps)), { xp10: runs * 730, level: 63, by: { cr_charge_fire_orb: runs } });
});

// ── Round up my supplies (the toggle) ─────────────────────────────────────

test('round up my supplies, on: after the bank plan, what it leaves is used up too, and what that takes is collected (v2.5)', () => {
  const price = { kwuarm: 2000, limpwurt_root: 300, '3dose2strength': 3000, ranarr_weed: 4000, snape_grass: 400, '3doseprayerrestore': 6000 };
  const opts = {
    bank: { kwuarm: 605, limpwurt_root: 518, ranarr_weed: 1000, snape_grass: 700 },
    currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(78), unlimited: VIALS, priceOf: k => price[k] ?? null,
  };
  const now = planGoal(ix, opts), even = planGoal(ix, { ...opts, roundUp: true });
  // as it is: 518 super strength and 700 prayer potions
  assert.deepEqual(evSteps(now.fromBank), [['hb_3dose2strength', 518, false, null], ['hb_3doseprayerrestore', 700, false, null]]);
  assert.equal(now.fromBank.xp10, 518 * 1250 + 700 * 875);
  assert.equal(now.bankNow, undefined, 'only the rounded-up plan carries the plan as it is');
  assert.equal(now.fromBank.collect, undefined);
  // rounded up: the same steps first, then the 87 kwuarm and 300 ranarr left over
  assert.deepEqual(evSteps(even.fromBank), [
    ['hb_3dose2strength', 518, false, null], ['hb_3doseprayerrestore', 700, false, null],
    ['hb_3dose2strength', 87, true, { limpwurt_root: 87 }], ['hb_3doseprayerrestore', 300, true, { snape_grass: 300 }],
  ]);
  assert.deepEqual(even.fromBank.collect, { limpwurt_root: 87, snape_grass: 300 });
  assert.equal(even.fromBank.xp10, 605 * 1250 + 1000 * 875, 'the XP of the rounded-up amounts: 605 and 1,000');
  assert.deepEqual(even.fromBank.leftover.toObject(), { '3dose2strength': 605, '3doseprayerrestore': 1000 }, 'nothing left over');
  assert.deepEqual(even.bankNow, now.fromBank, 'what the bank makes as it is, to set beside it');
  // the rest of the goal comes after it, with the same method
  assert.equal(even.remaining, now.remaining - (87 * 1250 + 300 * 875));
  assert.equal(even.fill.id, now.fill.id);
  assert.ok(even.fill.segments[0].runs < now.fill.segments[0].runs);
  // each row on its own is as it was; what the plan makes of it, and its net, are the rounded-up ones
  for (const r of even.table) {
    const r0 = row(now, r.id);
    assert.deepEqual([r.have, r.balance, r.needed, r.gains.even], [r0.have, r0.balance, r0.needed, r0.gains.even], r.id);
    assert.ok(r.toMake <= r0.toMake, r.id);
  }
  const ss = row(even, 'hb_3dose2strength');
  assert.equal(ss.fromPlan, 605);
  assert.deepEqual(ss.gains.before, { total: 605 * 3000 - 87 * 300, value: 605 * 3000, cost: 87 * 300, missing: [] }, 'less the limpwurt collected for it');
  assert.deepEqual(row(now, 'hb_3dose2strength').gains.before, { total: 518 * 3000, value: 518 * 3000, cost: 0, missing: [] });
  assert.equal(ss.gains.net.total, ss.gains.before.total + ss.gains.collect.total);
  // with the bank left out there's nothing to round up
  const off = planGoal(ix, { ...opts, useBank: false, roundUp: true });
  assert.equal(off.bankNow, undefined);
  assert.deepEqual(off.fromBank.steps, []);
});

test('round up my supplies, on: with nothing to collect it is the plan as it is (v2.5)', () => {
  const opts = { bank: { kwuarm: 518, limpwurt_root: 518, ranarr_weed: 700, snape_grass: 700 }, currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(78), unlimited: VIALS };
  const now = planGoal(ix, opts), even = planGoal(ix, { ...opts, roundUp: true });
  assert.deepEqual(even.fromBank.steps, now.fromBank.steps);
  assert.deepEqual(even.fromBank.collect, {});
  assert.equal(even.fromBank.xp10, now.fromBank.xp10);
  // gold bars the bank already uses up aren't rounded up with gems it doesn't have
  const craft = { bank: { gold_bar: 1000, sapphire: 300, emerald: 200 }, currentXp10: xp10ForLevel(40), targetXp10: xp10ForLevel(60), unlimited: THREAD };
  const c0 = planGoal(cr, craft), c1 = planGoal(cr, { ...craft, roundUp: true });
  assert.deepEqual(c1.fromBank.steps, c0.fromBank.steps);
  assert.deepEqual(c1.fromBank.collect, {});
});

test('round up my supplies, on: things your bank can\'t make yet join in when they\'re one ingredient short, best XP first (v2.5)', () => {
  const opts = (bank, more = {}) => ({ bank, currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(78), unlimited: VIALS, roundUp: true, ...more });
  // irit with nothing to go with: super attack (eye of newt) or superantipoison (unicorn horn), the one with more XP
  let fb = planGoal(ix, opts({ irit_leaf: 200 })).fromBank;
  assert.deepEqual(evSteps(fb), [['hb_3dose2antipoison', 200, true, { unicorn_horn: 200 }]]);
  // unticked, the other one takes them; both unticked, the irit stays
  fb = planGoal(ix, opts({ irit_leaf: 200 }, { excluded: new Set(['hb_3dose2antipoison']) })).fromBank;
  assert.deepEqual(evSteps(fb), [['hb_3dose2attack', 200, true, { eye_of_newt: 200 }]]);
  assert.equal(fb.xp10, 200 * 1000);
  fb = planGoal(ix, opts({ irit_leaf: 200 }, { excluded: new Set(['hb_3dose2antipoison', 'hb_3dose2attack']) })).fromBank;
  assert.deepEqual([fb.steps, fb.collect, fb.leftover.toObject()], [[], {}, { irit_leaf: 200 }]);
  // a potion you can't make yet waits for its level: cadantine stays at 60...
  fb = planGoal(ix, { ...opts({ cadantine: 50, eye_of_newt: 20 }), currentXp10: xp10ForLevel(60) }).fromBank;
  assert.deepEqual(evSteps(fb), [['hb_3dose2attack', 20, true, { irit_leaf: 20 }]]);
  assert.equal(fb.leftover.have('cadantine'), 50);
  // ...and is used once the XP on the way gets you to 66
  fb = planGoal(ix, { ...opts({ cadantine: 50, eye_of_newt: 5000, white_berries: 40 }), currentXp10: xp10ForLevel(60) }).fromBank;
  assert.deepEqual(evSteps(fb), [
    ['hb_3dose2attack', 2226, true, { irit_leaf: 2226 }], ['hb_3dose2defense', 50, true, { white_berries: 10 }], ['hb_3dose2attack', 2774, true, { irit_leaf: 2774 }],
  ]);
  assert.ok(xp10ForLevel(60) + 2226 * 1000 >= xp10ForLevel(66) && xp10ForLevel(60) + 2225 * 1000 < xp10ForLevel(66), 'super attack up to level 66');
  // two ingredients short stays out: feathers alone make headless arrows from logs, not arrows with their tips as well
  fb = planGoal(fl, { bank: { feather: 10000 }, currentXp10: xp10ForLevel(80), targetXp10: xp10ForLevel(85), fillGroup: 'Bows', roundUp: true }).fromBank;
  assert.deepEqual(evSteps(fb), [['fl_logs_headless', 666, true, { logs: 666 }], ['fl_dart_adamant_dart', 10, true, { adamant_dart_tip: 10 }]]);
  // balls of wool alone string a symbol (silver bars), not a gem amulet (a gold bar and a gem)
  fb = planGoal(cr, { bank: { ball_of_wool: 500 }, currentXp10: xp10ForLevel(85), targetXp10: xp10ForLevel(90), unlimited: THREAD, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(fb), [['cr_stringstar', 500, true, { silver_bar: 500 }]]);
});

test('round up my supplies, on: what the bank made on the way is finished too: bows strung, gems set, glass blown (v2.5)', () => {
  const bows = { bank: { bow_string: 2521, magic_logs: 973, yew_logs: 1044, maple_logs: 1034 }, currentXp10: xp10ForLevel(89), targetXp10: xp10ForLevel(92), fillGroup: 'Bows' };
  const now = planGoal(fl, bows), even = planGoal(fl, { ...bows, roundUp: true });
  // the strings run out at 504 maple longbows, so 530 are only cut: 530 bow strings finish them
  assert.deepEqual(evSteps(even.fromBank), [
    ['fl_cs_magic_longbow', 973, false, null], ['fl_cs_yew_longbow', 1044, false, null], ['fl_cs_maple_longbow', 504, false, null],
    ['fl_cut_unstrung_maple_longbow', 530, false, null], ['fl_str_maple_longbow', 530, true, { bow_string: 530 }],
  ]);
  assert.deepEqual(even.fromBank.steps.filter(s => !s.rounded), now.fromBank.steps, 'the bank part is the plan as it is');
  assert.deepEqual(even.fromBank.collect, { bow_string: 530 });
  assert.equal(even.fromBank.xp10 - now.fromBank.xp10, 530 * fl.byId.get('fl_str_maple_longbow').xp);
  assert.deepEqual(even.fromBank.leftover.toObject(), { magic_longbow: 973, yew_longbow: 1044, maple_longbow: 1034 });
  // shafts, feathers and arrowtips: the arrows the bank is making are made of all the feathers
  const arrows = planGoal(fl, { bank: { feather: 5000, arrow_shaft: 2000, bronze_arrowheads: 1000 }, currentXp10: xp10ForLevel(80), targetXp10: xp10ForLevel(85), fillGroup: 'Bows', roundUp: true }).fromBank;
  assert.deepEqual(arrows.collect, { bronze_arrowheads: 4000, arrow_shaft: 3000 });
  assert.deepEqual(arrows.leftover.toObject(), { bronze_arrow: 5000 });
  // uncut gems are cut by the bank, then set (gold bars); orbs get battlestaves; sand gets soda ash, and the glass is blown
  const craft = planGoal(cr, { bank: { uncut_sapphire: 500, air_orb: 200, bucket_sand: 300 }, currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(75), unlimited: THREAD, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(craft), [
    ['cr_sapphire', 500, false, null],
    ['cr_air_battlestaff', 200, true, { battlestaff: 200 }], ['cr_unstrung_sapphire_amulet', 500, true, { gold_bar: 500 }],
    ['cr_stafforb', 300, true, { soda_ash: 300 }],
  ]);
  assert.deepEqual(craft.steps[3].sub, { cr_molten_glass: 300 }, 'the glass is made on the way, with the soda ash collected for it');
  assert.deepEqual(craft.leftover.toObject(), { air_battlestaff: 200, unstrung_sapphire_amulet: 500, stafforb: 300 });
});

test('round up my supplies, on: the one you picked to train with is rounded up first (v2.5)', () => {
  // picked, magic longbows take all the bow strings: 1,548 more magic logs. The other logs are cut, then strung.
  const bows = { bank: { bow_string: 2521, magic_logs: 973, yew_logs: 1044, maple_logs: 1034 }, currentXp10: xp10ForLevel(89), targetXp10: xp10ForLevel(92), fillGroup: 'Bows', fillId: 'fl_cs_magic_longbow' };
  const now = planGoal(fl, bows), even = planGoal(fl, { ...bows, roundUp: true });
  assert.deepEqual(row(now, 'fl_cs_magic_longbow').balance, { runs: 2521, collect: { magic_logs: 1548 } }, 'what its Round up my supplies says');
  assert.deepEqual(evSteps(even.fromBank), [
    ['fl_cs_magic_longbow', 2521, false, { magic_logs: 1548 }],
    ['fl_cut_unstrung_yew_longbow', 1044, false, null], ['fl_cut_unstrung_maple_longbow', 1034, false, null],
    ['fl_str_yew_longbow', 1044, true, { bow_string: 1044 }], ['fl_str_maple_longbow', 1034, true, { bow_string: 1034 }],
  ]);
  assert.deepEqual(even.fromBank.collect, { magic_logs: 1548, bow_string: 2078 });
  assert.ok(even.fromBank.xp10 > now.fromBank.xp10);
  assert.equal(even.fill.id, 'fl_cs_magic_longbow');
  // a glory needs wool and runes the bank doesn't have, so as it is the gold and dragonstones go into plain amulets
  const glory = { bank: { gold_bar: 500, dragonstone: 120, cosmicrune: 60 }, currentXp10: xp10ForLevel(88), targetXp10: xp10ForLevel(95), unlimited: THREAD };
  const picked = planGoal(cr, { ...glory, fillId: 'cr_ench_amulet_of_glory_4', roundUp: true });
  assert.deepEqual(crSteps(picked.bankNow), [['cr_unstrung_dragonstone_amulet', 120, {}], ['cr_unstrung_gold_amulet', 380, {}]]);
  assert.deepEqual(evSteps(picked.fromBank), [
    ['cr_ench_amulet_of_glory_4', 500, false, { dragonstone: 380, ball_of_wool: 500, earthrune: 7500, waterrune: 7500, cosmicrune: 440 }],
  ]);
  assert.deepEqual(row(picked, 'cr_ench_amulet_of_glory_4').balance.collect, picked.fromBank.collect, 'what its Round up my supplies says');
  // not picked, the plain amulets use it all up: 60 cosmic runes alone are three ingredients short of anything
  const free = planGoal(cr, { ...glory, roundUp: true });
  assert.deepEqual(free.fromBank.steps, free.bankNow.steps);
  assert.deepEqual(free.fromBank.collect, {});
});

test("round up my supplies, on: vials you count never hold it back, and the ones you're short of are collected too (v2.5.1)", () => {
  // 800 vials for 959 potions' worth of herbs. (As v2.5.0 had it, the vials ran out and the 38 cadantine
  // and 87 kwuarm left over weren't rounded up: only potions with their second ingredient left over were.)
  const bank = { kwuarm: 605, limpwurt_root: 518, ranarr_weed: 254, snape_grass: 403, cadantine: 100, white_berries: 62, vial_water: 500, vial_empty: 300 };
  const opts = { bank, currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(78), minor: VIALS };
  const SD = 'hb_3dose2defense', SS = 'hb_3dose2strength', PP = 'hb_3doseprayerrestore';
  const counted = planGoal(ix, { ...opts, roundUp: true });
  // as it is, the vials go to the best XP first and run out during the prayer potions
  assert.deepEqual(evSteps(counted.bankNow), [[SD, 62, false, null], [SS, 518, false, null], [PP, 220, false, null]]);
  assert.deepEqual(counted.bankNow, planGoal(ix, opts).fromBank);
  // rounded up, nothing waits for a vial: every herb and second ingredient is used, and 308 vials join the list
  assert.deepEqual(evSteps(counted.fromBank), [
    [SD, 62, false, null], [SS, 518, false, null], [PP, 254, false, { vial_water: 34 }],
    [SD, 38, true, { white_berries: 38, vial_water: 38 }], [SS, 87, true, { limpwurt_root: 87, vial_water: 87 }], [PP, 149, true, { ranarr_weed: 149, vial_water: 149 }],
  ]);
  assert.deepEqual(Object.entries(counted.fromBank.collect), [['white_berries', 38], ['limpwurt_root', 87], ['ranarr_weed', 149], ['vial_water', 308]], 'vials last');
  assert.deepEqual(counted.fromBank.assumed, {}, 'collected, not bought as you go');
  assert.deepEqual(counted.fromBank.leftover.toObject(), { '3dose2defense': 100, '3dose2strength': 605, '3doseprayerrestore': 403 }, 'nothing left over');
  assert.equal(counted.fromBank.xp10, 100 * 1500 + 605 * 1250 + 403 * 875);
  assert.equal(counted.fromBank.steps.reduce((n, s) => n + (s.sub.hb_fill_vial || 0), 0), 300, 'the empty vials are filled first');
  // it's the plan you get buying vials as you go: the same potions, with the vials left off the list
  const bought = planGoal(ix, { ...opts, unlimited: VIALS, roundUp: true });
  const noVials = ([id, runs, rounded, collect]) => {
    const rest = Object.fromEntries(Object.entries(collect || {}).filter(([k]) => k !== 'vial_water'));
    return [id, runs, rounded, Object.keys(rest).length ? rest : null];
  };
  assert.deepEqual(evSteps(counted.fromBank).map(noVials), evSteps(bought.fromBank));
  assert.deepEqual(bought.fromBank.collect, { white_berries: 38, limpwurt_root: 87, ranarr_weed: 149 });
  assert.deepEqual(bought.fromBank.assumed, { vial_water: 308 });
  assert.equal(bought.fromBank.xp10, counted.fromBank.xp10);
  // the money counts the vials collected, and the rest of the goal comes after it all
  const priced = planGoal(ix, { ...opts, roundUp: true, priceOf: k => ({ vial_water: 10, limpwurt_root: 300, '3dose2strength': 3000 })[k] ?? null });
  assert.deepEqual(row(priced, SS).gains.before, { total: 605 * 3000 - 87 * 300 - 87 * 10, value: 605 * 3000, cost: 87 * 300 + 87 * 10, missing: [] });
  assert.equal(counted.remaining, xp10ForLevel(78) - xp10ForLevel(74) - counted.fromBank.xp10);

  const fb = (b, more = {}) => planGoal(ix, { ...opts, bank: b, roundUp: true, ...more }).fromBank;
  // no vials at all: what your bank makes but for the vials comes first, as if you bought them as you go
  assert.deepEqual(evSteps(fb({ kwuarm: 605, limpwurt_root: 518 })), [[SS, 518, false, { vial_water: 518 }], [SS, 87, true, { limpwurt_root: 87, vial_water: 87 }]]);
  // one ingredient short, not counting the vials
  assert.deepEqual(evSteps(fb({ irit_leaf: 200 })), [['hb_3dose2antipoison', 200, true, { unicorn_horn: 200, vial_water: 200 }]]);
  // the one you picked
  assert.deepEqual(evSteps(fb({ lantadyme: 100, blue_dragon_scale: 40, vial_water: 60 }, { fillId: 'hb_3dose1antidragon' })),
    [['hb_3dose1antidragon', 100, false, { blue_dragon_scale: 60, vial_water: 40 }]]);
  // unfinished potions need no vial
  assert.deepEqual(evSteps(fb({ kwuarmvial: 50, kwuarm: 30, limpwurt_root: 10 })), [[SS, 10, false, null], [SS, 70, true, { limpwurt_root: 70, vial_water: 30 }]]);
  // vials alone round nothing up
  const vialsOnly = fb({ vial_water: 500, vial_empty: 200 });
  assert.deepEqual([vialsOnly.steps, vialsOnly.collect, vialsOnly.leftover.toObject()], [[], {}, { vial_water: 500, vial_empty: 200 }]);
});

test("round up my supplies: each row's own amount counts herbs with no vials left, too (v2.5.1)", () => {
  const at = { currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(78), minor: VIALS };
  const SS = 'hb_3dose2strength';
  // 120 kwuarm, 100 limpwurt and 30 vials: 30 now; rounded up 120, for 20 limpwurt and the 90 vials
  let r = row(planGoal(ix, { ...at, bank: { kwuarm: 120, limpwurt_root: 100, vial_water: 30 } }), SS);
  assert.equal(r.have, 30);
  assert.deepEqual(r.balance, { runs: 120, collect: { limpwurt_root: 20, vial_water: 90 } });
  assert.deepEqual(Object.keys(r.balance.collect), ['limpwurt_root', 'vial_water'], 'vials last');
  // only the vials short
  r = row(planGoal(ix, { ...at, bank: { kwuarm: 100, limpwurt_root: 100, vial_water: 30 } }), SS);
  assert.deepEqual([r.have, r.balance], [30, { runs: 100, collect: { vial_water: 70 } }]);
  // enough vials: as it was
  r = row(planGoal(ix, { ...at, bank: { kwuarm: 605, limpwurt_root: 518, vial_water: 2000 } }), SS);
  assert.deepEqual([r.have, r.balance], [518, { runs: 605, collect: { limpwurt_root: 87 } }]);
  // bought as you go, they're left out as ever, and naming them changes nothing
  const bank = { kwuarm: 120, limpwurt_root: 100, vial_water: 30, ranarr_weed: 50, snape_grass: 80 };
  for (const roundUp of [false, true]) {
    const base = { bank, currentXp10: xp10ForLevel(74), targetXp10: xp10ForLevel(78), unlimited: VIALS, roundUp };
    assert.deepEqual(planGoal(ix, { ...base, minor: VIALS }), planGoal(ix, base));
  }
  r = row(planGoal(ix, { ...at, bank, unlimited: VIALS }), SS);
  assert.deepEqual([r.have, r.balance], [100, { runs: 120, collect: { limpwurt_root: 20 } }]);
  // with the tick box off, counted vials hold the plan back as they always did
  const off = planGoal(ix, { ...at, bank });
  assert.deepEqual(evSteps(off.fromBank), [[SS, 30, false, null]]);
  assert.deepEqual(off.fromBank, planGoal(ix, { bank, currentXp10: at.currentXp10, targetXp10: at.targetXp10 }).fromBank);
});

test('crafting: thread you count never decides what is rounded up; short of it, it is collected (v2.5.1)', () => {
  const at = { currentXp10: xp10ForLevel(20), targetXp10: xp10ForLevel(40), minor: THREAD };
  const CHAPS = 'cr_leather_chaps';
  // 10 leather and one reel (five items' worth): 5 chaps as it is, all 10 rounded up, for one more reel
  let plan = planGoal(cr, { ...at, bank: { leather: 10, thread: 1 }, roundUp: true });
  assert.deepEqual(evSteps(plan.bankNow), [[CHAPS, 5, false, null]]);
  assert.deepEqual(evSteps(plan.fromBank), [[CHAPS, 10, false, { thread: 1 }]]);
  assert.deepEqual(plan.fromBank.collect, { thread: 1 });
  assert.deepEqual([row(plan, CHAPS).have, row(plan, CHAPS).balance], [5, { runs: 10, collect: { thread: 1 } }]);
  // 3 leather and 100 reels: the thread isn't what you round up to (v2.5.0 collected 497 leather for it)
  plan = planGoal(cr, { ...at, bank: { leather: 3, thread: 100 }, roundUp: true });
  assert.deepEqual(evSteps(plan.fromBank), [[CHAPS, 3, false, null]]);
  assert.deepEqual(plan.fromBank.collect, {});
  assert.equal(plan.fromBank.leftover.have('thread'), 99.4);
  assert.equal(row(plan, CHAPS).balance, null);
  // thread alone rounds nothing up
  plan = planGoal(cr, { ...at, currentXp10: xp10ForLevel(63), targetXp10: xp10ForLevel(70), bank: { thread: 100 }, roundUp: true });
  assert.deepEqual([plan.fromBank.steps, plan.fromBank.collect], [[], {}]);
  // dragon leather and no thread at all: made as if you bought it as you go, with the thread to collect
  plan = planGoal(cr, { ...at, currentXp10: xp10ForLevel(63), targetXp10: xp10ForLevel(70), bank: { dragon_leather: 30 }, excluded: new Set(['cr_set_green_dhide']), roundUp: true });
  assert.deepEqual(evSteps(plan.fromBank), [['cr_dragonhide_body', 10, false, { thread: 2 }]]);
  assert.deepEqual(plan.bankNow.steps, []);
});

test('round up my supplies: in Crafting, runes and the wool for stringing are collected as needed and never decide (v2.5.2)', () => {
  assert.deepEqual([...minorOf('crafting')].sort(), ['airrune', 'ball_of_wool', 'cosmicrune', 'earthrune', 'firerune', 'thread', 'waterrune']);
  assert.deepEqual([...minorOf('herblore')], ['vial_water']);
  assert.deepEqual([...minorOf('fletching')], []);
  const minor = minorOf('crafting');
  // Ostap's five: the enchanted pieces he makes, everything else in Jewellery unticked (gems are still cut)
  const FIVE = ['cr_ench_necklace_of_minigames_8', 'cr_ench_ring_of_dueling_8', 'cr_ench_ring_of_forging', 'cr_ench_ring_of_life', 'cr_ench_amulet_of_glory_4'];
  const excluded = new Set(cr.train.filter(m => m.group === 'Jewellery' && !FIVE.includes(m.id) && !m.feeds).map(m => m.id));
  const [GAMES, DUEL, FORGE, LIFE, GLORY] = FIVE;
  // 200 gold bars for 790 gems, and no air runes at all
  const bank = { sapphire: 300, emerald: 250, ruby: 120, diamond: 80, dragonstone: 40, gold_bar: 200, ball_of_wool: 100,
    cosmicrune: 500, waterrune: 2000, earthrune: 2000, firerune: 1000 };
  const opts = { bank, currentXp10: xp10ForLevel(82), targetXp10: xp10ForLevel(90), unlimited: THREAD, excluded, minor };
  const now = planGoal(cr, opts), even = planGoal(cr, { ...opts, roundUp: true });
  // as it is, the gold bars go to the most XP first and run out: nothing for the emeralds and sapphires
  assert.deepEqual(evSteps(now.fromBank), [[GLORY, 40, false, null], [LIFE, 80, false, null], [FORGE, 80, false, null]]);
  assert.equal(now.fromBank.leftover.have('gold_bar'), 0);
  // rounded up they're all made, with the gold bars and the runes to collect. (v2.5.0 left the emeralds and
  // sapphires out: short of gold bars and of runes was two things short. And 60 spare balls of wool asked for 60 dragonstones.)
  assert.deepEqual(evSteps(even.fromBank), [
    [GLORY, 40, false, null], [LIFE, 80, false, null], [FORGE, 80, false, null],
    [FORGE, 40, true, { gold_bar: 40 }],
    [GAMES, 300, true, { gold_bar: 300, cosmicrune: 40 }],
    [DUEL, 250, true, { gold_bar: 250, cosmicrune: 250, airrune: 750 }],
  ]);
  assert.deepEqual(even.fromBank.collect, { gold_bar: 590, cosmicrune: 290, airrune: 750 });
  assert.deepEqual(castsIn(cr, even.fromBank.steps.map(st => [st.id, st.runs])),
    { xp10: 40 * 780 + 80 * 670 + 120 * 590 + 300 * 175 + 250 * 370, level: 68, by: { [GLORY]: 40, [LIFE]: 80, [FORGE]: 120, [GAMES]: 300, [DUEL]: 250 } });
  assert.equal(even.fromBank.leftover.have('ball_of_wool'), 60, 'spare wool is left alone');
  // each row on its own says the same: 250 emeralds, 200 gold bars and no air runes round up to 250
  assert.equal(row(now, DUEL).have, 0, 'no air runes: none as it is');
  assert.deepEqual(row(now, DUEL).balance, { runs: 250, collect: { gold_bar: 50, airrune: 750 } });
  assert.deepEqual(row(now, GAMES).balance, { runs: 300, collect: { gold_bar: 100 } });

  // dragonstones with no gold bars and no wool are amulets of glory all the same; uncut gems and key halves on the way
  const raw = planGoal(cr, { ...opts, bank: { uncut_dragonstone: 20, keyhalf1: 9, keyhalf2: 4, uncut_emerald: 100 }, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(raw), [
    ['cr_dragonstone', 24, false, null], ['cr_emerald', 100, false, null],
    ['cr_dragonstone', 5, true, { keyhalf2: 5 }],
    [GLORY, 29, true, { gold_bar: 29, ball_of_wool: 29, waterrune: 435, cosmicrune: 29, earthrune: 435 }],
    [DUEL, 100, true, { gold_bar: 100, cosmicrune: 100, airrune: 300 }],
  ]);
  // runes or wool alone round nothing up
  for (const b of [{ cosmicrune: 600, airrune: 9000 }, { ball_of_wool: 500 }, { thread: 100, cosmicrune: 50 }]) {
    const fb = planGoal(cr, { bank: b, currentXp10: xp10ForLevel(82), targetXp10: xp10ForLevel(90), minor, roundUp: true }).fromBank;
    assert.deepEqual([fb.steps, fb.collect], [[], {}], JSON.stringify(b));
  }
});

test('crafting: with only the enchanted pieces ticked, uncut gems and key halves still go into them (v2.5.2)', () => {
  // What Ostap saw in v2.5.0, every row but his five unticked (the gem-cutting rows with them): "it got glorys,
  // ring of life and ring of forging right", but not the uncut dragonstones and other uncut stones, the key halves,
  // or the emeralds and sapphires for rings of dueling and games necklaces, "rounding up didn't show them either".
  // Unticking Dragonstone (cut) had stopped the cutting altogether.
  const FIVE = ['cr_ench_necklace_of_minigames_8', 'cr_ench_ring_of_dueling_8', 'cr_ench_ring_of_forging', 'cr_ench_ring_of_life', 'cr_ench_amulet_of_glory_4'];
  const [GAMES, DUEL, FORGE, LIFE, GLORY] = FIVE;
  const excluded = new Set(cr.train.filter(m => !FIVE.includes(m.id)).map(m => m.id));
  for (const id of ['cr_dragonstone', 'cr_emerald', 'cr_sapphire', 'cr_molten_glass']) assert.ok(excluded.has(id), id);
  const bank = { uncut_dragonstone: 20, dragonstone: 10, uncut_emerald: 100, uncut_sapphire: 150, ruby: 60, diamond: 40, keyhalf1: 9, keyhalf2: 4,
    soda_ash: 500, gold_bar: 100, cosmicrune: 500, waterrune: 500, airrune: 500, firerune: 500, earthrune: 500, ball_of_wool: 50 };
  const opts = { bank, currentXp10: xp10ForLevel(85), targetXp10: xp10ForLevel(90), unlimited: THREAD, excluded, minor: minorOf('crafting') };
  // As it is: the 100 gold bars go to the most XP first, as far as the runes go (500 water runes are 33 glories,
  // and they leave no earth runes for rings of life). The uncut dragonstones are cut, 3 of them out of the crystal chest.
  const now = planGoal(cr, opts).fromBank;
  assert.deepEqual(crSteps(now), [
    [GLORY, 33, { cr_join_keys: 3, cr_crystal_chest: 3, cr_dragonstone: 23 }],
    [FORGE, 60, {}],
    [GAMES, 5, { cr_sapphire: 5 }],
    [DUEL, 2, { cr_emerald: 2 }],
  ]);
  assert.equal(now.leftover.have('gold_bar'), 0, 'the gold bars are what runs out');
  assert.equal(now.xp10, 33 * 1540 + 23 * 1375 + 60 * 700 + 5 * (550 + 500) + 2 * (550 + 675), 'the cutting on the way counts');
  // Rounded up: every gem and key half is used, with the gold bars, the 5 loop halves and the runes to collect.
  const even = planGoal(cr, { ...opts, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(even), [
    [GLORY, 34, false, { waterrune: 10, earthrune: 10 }], [LIFE, 40, false, { earthrune: 400 }], [FORGE, 26, false, null],
    [GLORY, 5, true, { gold_bar: 5, keyhalf2: 5, waterrune: 75, earthrune: 75 }],
    [FORGE, 34, true, { gold_bar: 34 }],
    [GAMES, 150, true, { gold_bar: 150, waterrune: 150 }],
    [DUEL, 100, true, { gold_bar: 100 }],
  ]);
  assert.deepEqual(even.collect, { gold_bar: 289, keyhalf2: 5, waterrune: 235, earthrune: 485 });
  assert.deepEqual(even.steps.map(st => st.sub), [
    { cr_join_keys: 4, cr_crystal_chest: 4, cr_dragonstone: 24 }, {}, {},
    { cr_join_keys: 5, cr_crystal_chest: 5, cr_dragonstone: 5 }, {}, { cr_sapphire: 150 }, { cr_emerald: 100 },
  ]);
  for (const k of ['uncut_dragonstone', 'uncut_emerald', 'uncut_sapphire', 'ruby', 'diamond', 'dragonstone', 'keyhalf1', 'keyhalf2', 'gold_bar']) assert.equal(even.leftover.have(k), 0, k);
  // (nothing ticked is made of glass, so the soda ash stays)
  assert.equal(even.leftover.have('soda_ash'), 500);
  // and each row on its own: all 100 emeralds count toward rings of dueling, all 150 sapphires toward games necklaces
  const plan = planGoal(cr, opts);
  assert.equal(row(plan, DUEL).have, 100);
  assert.equal(row(plan, GAMES).have, 100, 'as far as the gold bars go');
  assert.deepEqual(row(plan, GAMES).balance, { runs: 150, collect: { gold_bar: 50 } });
});

test('round up my supplies: 2,000 molten glass round up to 2,000 unpowered orbs and 2,000 battlestaves (v2.5.2)', () => {
  const minor = minorOf('crafting');
  const opts = { currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(80), unlimited: THREAD, minor };
  const AIR = 'cr_air_battlestaff', ORB = 'cr_stafforb';
  // as it is the glass is blown into orbs, and that's all: no battlestaffs, no runes
  const now = planGoal(cr, { ...opts, bank: { molten_glass: 2000 } });
  assert.deepEqual(evSteps(now.fromBank), [[ORB, 2000, false, null]]);
  assert.deepEqual(row(now, AIR).balance, { runs: 2000, collect: { battlestaff: 2000, airrune: 60000, cosmicrune: 6000 } }, "the row's own Round up");
  // rounded up, the orbs are charged and put on battlestaves: the battlestaffs and the runes are what to collect
  const even = planGoal(cr, { ...opts, bank: { molten_glass: 2000 }, roundUp: true });
  assert.deepEqual(evSteps(even.fromBank), [[ORB, 2000, false, null], [AIR, 2000, true, { battlestaff: 2000, cosmicrune: 6000, airrune: 60000 }]]);
  assert.deepEqual(even.fromBank.steps[1].sub, { cr_charge_air_orb: 2000 });
  assert.equal(even.fromBank.xp10, 2000 * 525 + 2000 * 1375);
  assert.deepEqual(castsIn(cr, even.fromBank.steps.flatMap(st => [[st.id, st.runs], ...Object.entries(st.sub)])), { xp10: 2000 * 760, level: 66, by: { cr_charge_air_orb: 2000 } });
  assert.deepEqual(even.fromBank.leftover.toObject(), { air_battlestaff: 2000 });
  // with battlestaffs for some, those come first (the glass is blown on the way), and the runes are collected for them too
  const some = planGoal(cr, { ...opts, bank: { molten_glass: 2000, battlestaff: 500 }, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(some), [
    [AIR, 500, false, { cosmicrune: 1500, airrune: 15000 }], [ORB, 1500, false, null],
    [AIR, 1500, true, { battlestaff: 1500, cosmicrune: 4500, airrune: 45000 }],
  ]);
  assert.deepEqual(some.steps[0].sub, { cr_stafforb: 500, cr_charge_air_orb: 500 });
  assert.deepEqual(some.collect, { battlestaff: 1500, cosmicrune: 6000, airrune: 60000 });
  // sand without soda ash is too far from a battlestaff to round up to one: it's glass, then orbs
  const sand = planGoal(cr, { ...opts, bank: { bucket_sand: 300 }, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(sand), [[ORB, 300, true, { soda_ash: 300 }]]);
});

