// Run with:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, ITEMS, BANK_GROUPS, SALE_GROUPS, PLACES, CHOICES, UNID_HERBS, ICON_SHEET, MONSTERS, COMBAT_STYLES } from './gamedata.js';
import { BANK_ICON_SHEET } from './bankread-data.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mergeUnids, minorOf, choicesInUse, amountText, searchTerms, searchHit, hasCalculator } from './planner-ui.js';
import {
  xp10ForLevel, levelForXp10, goalTargetXp10, rankForTop, indexMethods, planBank, planGoal, planMix,
  methodEconomics, maxRuns, Stock, bankValue, outAt, madeOver, gathers, castsIn, xpEach, chanceUnits, sureLevel, chanceOf, WHOLE,
  averaged, exchangeXp, exchangeBatches,
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
  // kwuarm with nothing to go with: super strength (limpwurt root) or weapon poison (a blue dragon scale, ground), the one with more XP
  let fb = planGoal(ix, opts({ kwuarm: 200 })).fromBank;
  assert.deepEqual(evSteps(fb), [['hb_weapon_poison', 200, true, { blue_dragon_scale: 200 }]]);
  // unticked, the other one takes them; both unticked, the kwuarm stays
  fb = planGoal(ix, opts({ kwuarm: 200 }, { excluded: new Set(['hb_weapon_poison']) })).fromBank;
  assert.deepEqual(evSteps(fb), [['hb_3dose2strength', 200, true, { limpwurt_root: 200 }]]);
  assert.equal(fb.xp10, 200 * 1250);
  fb = planGoal(ix, opts({ kwuarm: 200 }, { excluded: new Set(['hb_weapon_poison', 'hb_3dose2strength']) })).fromBank;
  assert.deepEqual([fb.steps, fb.collect, fb.leftover.toObject()], [[], {}, { kwuarm: 200 }]);
  // (irits: super attacks get them before superantipoisons, whatever the XP: see the v2.7 test)
  fb = planGoal(ix, opts({ irit_leaf: 200 })).fromBank;
  assert.deepEqual(evSteps(fb), [['hb_3dose2attack', 200, true, { eye_of_newt: 200 }]]);
  fb = planGoal(ix, opts({ irit_leaf: 200 }, { excluded: new Set(['hb_3dose2attack']) })).fromBank;
  assert.deepEqual(evSteps(fb), [['hb_3dose2antipoison', 200, true, { unicorn_horn: 200 }]]);
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
  assert.deepEqual(evSteps(fb({ kwuarm: 200 })), [['hb_weapon_poison', 200, true, { blue_dragon_scale: 200, vial_water: 200 }]]);
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


// ── Mining (v2.6) ─────────────────────────────────────────────────────────
// The rows are LostHQ's Mining calculator, checked against the server's mining
// table when the data is built, plus limestone, which only the server has.
const mi = indexMethods(METHODS.filter(m => m.skill === 'mining'));
const miRocks = mi.train.filter(m => m.group === 'Rocks');      // (v2.7 added a second group: the ore for a bar)

test("mining: LostHQ's 13 rocks with their level and XP an ore, and limestone, which only the server has (v2.6)", () => {
  assert.deepEqual(miRocks.map(m => [m.name, m.level, m.xp / 10]), [
    ['Clay', 1, 5], ['Rune essence', 1, 5], ['Copper ore', 1, 17.5], ['Tin ore', 1, 17.5], ['Blurite ore', 10, 17.5], ['Limestone', 10, 26.5],
    ['Iron ore', 15, 35], ['Silver ore', 20, 40], ['Coal', 30, 50], ['Gold ore', 40, 65], ['Gem rock', 40, 65],
    ['Mithril ore', 55, 80], ['Adamantite ore', 70, 95], ['Runite ore', 85, 125],
  ]);
  assert.ok(mi.train.every(gathers), 'mining takes nothing in');
  assert.equal(BANK_GROUPS.mining, undefined, 'so it has no bank tab');
  assert.ok(mi.train.every(m => !m.tools));
  assert.deepEqual([...new Set(mi.train.map(m => m.group))], ['Rocks', 'Bars']);
  assert.match(mi.byId.get('mi_limestone').note, /Not on LostHQ's calculator/);
  // a gem rock gives one gem, by the server's chances out of 128
  const gem = mi.byId.get('mi_gemrock');
  assert.deepEqual(Object.fromEntries(Object.entries(gem.out).map(([k, n]) => [k, n * 128])),
    { uncut_opal: 60, uncut_jade: 30, uncut_red_topaz: 15, uncut_sapphire: 9, uncut_emerald: 5, uncut_ruby: 5, uncut_diamond: 4 });
  assert.equal(Object.values(gem.out).reduce((a, b) => a + b, 0), 1, 'one gem a rock');
  assert.equal(gem.icon, 'uncut_red_topaz', 'shown as the calculator shows it');
  assert.equal(gem.note, 'In Shilo Village. One gem a rock, by chance (out of 128): opal 60, jade 30, red topaz 15, sapphire 9, emerald 5, ruby 5, diamond 4.');
  for (const m of miRocks) if (m !== gem) assert.deepEqual(Object.values(m.out), [1], m.id);
});

test('mining: ores to mine and what they are worth, with no bank involved (v2.6)', () => {
  const toGo = xp10ForLevel(70) - xp10ForLevel(60);
  // (fillGroup, as the app passes it: with nothing picked a plan mines a rock, not a bar's worth of several)
  const plan = planGoal(mi, { bank: { coal: 5000, mithril_ore: 300 }, currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(70), fillGroup: 'Rocks', priceOf: k => ({ mithril_ore: 200 })[k] ?? null });
  assert.equal(plan.fromBank.steps.length, 0, 'ore in the bank gives no Mining XP');
  assert.equal(plan.fill.id, 'mi_mithril_ore', 'the most XP an ore at 60');
  assert.deepEqual(plan.fill.segments, [{ id: 'mi_mithril_ore', runs: Math.ceil(toGo / 800), xp10: Math.ceil(toGo / 800) * 800, made: { mithril_ore: Math.ceil(toGo / 800) } }]);
  assert.deepEqual(plan.fill.buy, {});
  const r = row(plan, 'mi_coal');
  assert.deepEqual([r.have, r.needed, r.toMake, r.collect, r.balance], [0, Math.ceil(toGo / 500), Math.ceil(toGo / 500), {}, null]);
  // a rock you can't mine yet: the best one at each level on the way. Limestone beats copper from 10 to 15.
  const low = planGoal(mi, { currentXp10: 0, targetXp10: xp10ForLevel(20), fillId: 'mi_iron_ore' });
  assert.deepEqual(low.fill.segments.map(s => [s.id, s.runs, s.toLevel]), [['mi_copper_ore', 66, 10], ['mi_limestone', 48, 15], ['mi_iron_ore', 59, undefined]]);
  // a gem rock is worth its chances: 60 opals in 128 at 128 gp are 60 gp a rock
  const gp = { uncut_opal: 128, uncut_jade: 256, uncut_red_topaz: 512, uncut_sapphire: 1280, uncut_emerald: 2560, uncut_ruby: 5120, uncut_diamond: 12800 };
  const e = methodEconomics(mi, mi.byId.get('mi_gemrock'), k => gp[k] ?? null);
  assert.deepEqual([e.inputs, e.cost, e.value, e.net], [{}, 0, 60 + 60 + 60 + 90 + 100 + 200 + 400, 970]);
  assert.equal(methodEconomics(mi, mi.byId.get('mi_gemrock'), k => (k === 'uncut_diamond' ? null : gp[k])).net, null, 'a gem with no price: unknown');
  const gems = planGoal(mi, { currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(60) + 128 * 650, fillId: 'mi_gemrock' });
  assert.deepEqual(gems.fill.segments[0].made, { uncut_opal: 60, uncut_jade: 30, uncut_red_topaz: 15, uncut_sapphire: 9, uncut_emerald: 5, uncut_ruby: 5, uncut_diamond: 4 }, '128 rocks, on average');
});

// ── Smithing (v2.6) ───────────────────────────────────────────────────────
// The rows are LostHQ's Smithing calculator: its smelting list and its anvil
// table for each metal, each checked against the server when the data is built.
const smAll = METHODS.filter(m => m.skill === 'smithing');
const sm = indexMethods(smAll);
const smith = (...opts) => indexMethods(smAll, { opts });      // with these choices in use
const SMITH_MINOR = minorOf('smithing');

test("smithing: LostHQ's smelting list and its anvil table for each metal (v2.6)", () => {
  const groups = ['Smelting', 'Bronze', 'Iron', 'Steel', 'Mithril', 'Adamant', 'Rune'];
  assert.deepEqual([...new Set(sm.train.map(m => m.group))], groups);
  assert.deepEqual(groups.map(g => sm.train.filter(m => m.group === g).length), [9, 22, 21, 24, 21, 21, 21]);
  const r = id => { const m = sm.byId.get(id); return [m.level, m.xp, m.in, m.out]; };
  // smelting: the server's level, XP and ore (iron: 2 ore a bar on average, since half fails)
  assert.deepEqual(sm.train.filter(m => m.group === 'Smelting').map(m => [m.name, m.level, m.xp, m.in]), [
    ['Bronze bar', 1, 62, { copper_ore: 1, tin_ore: 1 }], ['Iron bar', 15, 125, { iron_ore: 2 }], ['Elemental metal', 20, 80, { elemental_workshop_ore: 1, coal: 4 }],
    ['Silver bar', 20, 137, { silver_ore: 1 }], ['Steel bar', 30, 175, { iron_ore: 1, coal: 2 }], ['Gold bar', 40, 225, { gold_ore: 1 }],
    ['Mithril bar', 50, 300, { mithril_ore: 1, coal: 4 }], ['Adamantite bar', 70, 375, { adamantite_ore: 1, coal: 6 }], ['Runite bar', 85, 500, { runite_ore: 1, coal: 8 }],
  ]);
  // the anvil: XP is per bar, the same for everything a metal makes
  const perBar = { Bronze: 125, Iron: 250, Steel: 375, Mithril: 500, Adamant: 625, Rune: 750 };
  for (const m of sm.train.filter(x => x.group !== 'Smelting')) {
    const [bar, bars] = Object.entries(m.in)[0];
    assert.equal(Object.keys(m.in).length, 1, m.id);
    assert.equal(m.xp, bars * perBar[m.group], m.id);
    assert.ok(/_bar$/.test(bar) && sm.producers.get(bar)?.length === 1, `${m.id}: ${bar} is smelted by one row`);
  }
  assert.deepEqual(r('sm_bronze_dagger'), [1, 125, { bronze_bar: 1 }, { bronze_dagger: 1 }]);
  assert.deepEqual(r('sm_bronzecraftwire'), [4, 125, { bronze_bar: 1 }, { bronzecraftwire: 1 }]);
  assert.deepEqual(r('sm_iron_scimitar'), [20, 500, { iron_bar: 2 }, { iron_scimitar: 1 }]);
  assert.deepEqual(r('sm_steel_claws'), [43, 750, { steel_bar: 2 }, { steel_claws: 1 }]);
  assert.deepEqual(r('sm_studs'), [36, 375, { steel_bar: 1 }, { studs: 1 }]);
  assert.deepEqual(r('sm_mithril_kiteshield'), [62, 1500, { mithril_bar: 3 }, { mithril_kiteshield: 1 }]);
  assert.deepEqual(r('sm_adamnt_warhammer'), [79, 1875, { adamantite_bar: 3 }, { adamnt_warhammer: 1 }]);
  assert.deepEqual(['bronze', 'iron', 'steel', 'mithril', 'adamant', 'rune'].map(k => r(`sm_${k}_platebody`).slice(0, 2)),
    [[18, 625], [33, 1250], [48, 1875], [68, 2500], [88, 3125], [99, 3750]]);
  assert.deepEqual(r('sm_rune_platebody').slice(2), [{ runite_bar: 5 }, { rune_platebody: 1 }]);
  // more than one from a bar: counted in bars
  const many = sm.train.filter(m => Object.values(m.out)[0] > 1);
  assert.deepEqual([...new Set(many.map(m => [m.id.replace(/^sm_(bronze|iron|steel|mithril|adamant|rune)_/, ''), Object.values(m.out)[0]].join(' ')))].sort(),
    ['arrowheads 15', 'dart_tip 10', 'knife 5', 'sm_mcannonball 4', 'sm_nails 2']);
  assert.ok(many.every(m => m.unit === 'bar' && m.units === 'bars') && sm.train.filter(m => m.unit).length === many.length);
  // cannonballs come out of a furnace, with a mould; everything else off an anvil, with a hammer
  assert.deepEqual([r('sm_mcannonball'), sm.byId.get('sm_mcannonball').tools], [[35, 375, { steel_bar: 1 }, { mcannonball: 4 }], ['ammo_mould']]);
  assert.ok(sm.train.every(m => (m.group === 'Smelting' ? !m.tools : m.id === 'sm_mcannonball' || m.tools.join() === 'hammer')));
  assert.match(sm.byId.get('sm_mithril_dart_tip').note, /The Tourist Trap/);
  assert.match(sm.byId.get('sm_rune_claws').note, /Death Plateau/);
  // in the calculator's order
  assert.deepEqual(sm.train.filter(m => m.group === 'Steel').slice(4, 12).map(m => m.id),
    ['sm_steel_sword', 'sm_nails', 'sm_steel_dart_tip', 'sm_steel_scimitar', 'sm_steel_arrowheads', 'sm_mcannonball', 'sm_steel_longsword', 'sm_studs']);
  // the bank: ores, bars, the ring and runes, then what each metal makes
  assert.deepEqual(BANK_GROUPS.smithing.map(g => [g.name, g.items.length]), [['Ores and coal', 10], ['Bars', 9], ['Ring of forging and runes for Superheat', 3],
    ['Made: bronze', 22], ['Made: iron', 21], ['Made: steel', 24], ['Made: mithril', 21], ['Made: adamant', 21], ['Made: rune', 21]]);
  assert.deepEqual(BANK_GROUPS.smithing[0].items, ['copper_ore', 'tin_ore', 'iron_ore', 'elemental_workshop_ore', 'silver_ore', 'gold_ore', 'mithril_ore', 'adamantite_ore', 'runite_ore', 'coal']);
  assert.deepEqual(BANK_GROUPS.smithing[2].items, ['ring_of_forging', 'naturerune', 'firerune']);
});

test('smithing: the choices on a goal: where the bars come from, a ring of forging, goldsmith gauntlets (v2.6)', () => {
  assert.deepEqual(CHOICES.smithing.map(c => [c.id, c.label, c.options ? c.options.map(o => [o.id, o.name]) : null, c.unless || null]), [
    ['bars', 'Bars', [['buy', 'Buy them'], ['smelt', 'Smelt them'], ['superheat', 'Superheat them']], null],
    ['ring', 'Ring of forging', null, 'superheat'], ['gauntlets', 'Goldsmith gauntlets', null, null]]);
  assert.ok(CHOICES.smithing.every(c => c.tip.length > 40));
  const iron = ix => ix.byId.get('sm_iron_bar'), gold = ix => ix.byId.get('sm_gold_bar');
  // none in use: iron loses half its ore, gold is 22.5 XP, bars are bought
  assert.deepEqual([iron(sm).in, gold(sm).xp, sm.through, sm.batch], [{ iron_ore: 2 }, 225, false, 140]);
  assert.match(iron(sm).note, /Half the iron ore is lost in a furnace, so a bar takes 2 ore on average/);
  // a ring of forging: every ore a bar, and a bar's worth of the ring. The ring is 140 of those.
  assert.deepEqual(iron(smith('ring')).in, { iron_ore: 1, ring_of_forging_charge: 1 });
  assert.equal(iron(smith('ring')).note, "With a ring of forging every ore is a bar. A ring lasts 140 bars, and they're counted.");
  const worn = sm.byId.get('sm_ring_of_forging');
  assert.deepEqual([worn.kind, worn.xp, worn.in, worn.out, worn.name], ['prep', 0, { ring_of_forging: 1 }, { ring_of_forging_charge: 140 }, 'Ring of forging (140 bars)']);
  assert.deepEqual([ITEMS.ring_of_forging_charge.gp, ITEMS.ring_of_forging_charge.charge, ITEMS.ring_of_forging_charge.icon], [0, { of: 'ring_of_forging', per: 140 }, ITEMS.ring_of_forging.icon]);
  // goldsmith gauntlets: 2.5 times the XP, in whole tenths as the server works it out
  assert.equal(gold(smith('gauntlets')).xp, 562);
  assert.deepEqual(smAll.filter(m => m.opt?.gauntlets).map(m => m.id), ['sm_gold_bar']);
  // smelt them: the bars an anvil row takes are planned through. Silver, gold and elemental metal go into nothing here.
  const through = ix => ix.methods.filter(m => m.through).map(m => m.id);
  assert.deepEqual(through(smith('smelt')), ['sm_bronze_bar', 'sm_iron_bar', 'sm_steel_bar', 'sm_mithril_bar', 'sm_adamantite_bar', 'sm_runite_bar']);
  assert.deepEqual(smAll.filter(m => m.feeds).map(m => m.id), through(smith('smelt')));
  assert.equal(smith('smelt').through, true);
  assert.deepEqual(iron(smith('smelt')).in, { iron_ore: 2 }, 'at a furnace: half still fails');
  // superheat them: the spell's runes a bar, its Magic XP, and iron never fails. Elemental ore won't melt that way.
  const heat = smith('superheat');
  assert.deepEqual(through(heat), through(smith('smelt')));
  assert.deepEqual(iron(heat).in, { iron_ore: 1, naturerune: 1, firerune: 4 });
  assert.deepEqual([iron(heat).magic, iron(heat).spell, iron(heat).magicLevel], [530, 'Superheat Item', 43]);
  assert.match(iron(heat).note, /^Made with Superheat Item \(Magic 43\): 53 Magic XP each, on top of the Smithing XP\. It never fails: every iron ore is a bar, with no ring of forging\.$/);
  assert.deepEqual(heat.byId.get('sm_runite_bar').in, { runite_ore: 1, coal: 8, naturerune: 1, firerune: 4 });
  assert.deepEqual([gold(heat).in, gold(heat).xp, gold(heat).magic, !!gold(heat).through], [{ gold_ore: 1, naturerune: 1, firerune: 4 }, 225, 530, false]);
  assert.deepEqual(heat.byId.get('sm_elemental_workshop_bar'), sm.byId.get('sm_elemental_workshop_bar'));
  assert.deepEqual(smAll.filter(m => m.group === 'Smelting' && !m.opt?.superheat).map(m => m.id), ['sm_elemental_workshop_bar']);
  // together: gauntlets count when superheating, and a ring has nothing to do then
  assert.deepEqual([gold(smith('gauntlets', 'superheat')).xp, gold(smith('gauntlets', 'superheat')).in], [562, { gold_ore: 1, naturerune: 1, firerune: 4 }]);
  assert.match(gold(smith('gauntlets', 'superheat')).note, /^56\.2 XP with goldsmith gauntlets worn \(22\.5 without\)\. Made with Superheat Item/);
  assert.deepEqual(iron(smith('ring', 'superheat')).in, iron(heat).in);
  // as the app passes them: tick boxes, then the list; a ring is left out when you superheat; anything unknown is nothing
  const use = opts => choicesInUse({ skill: 'smithing', opts });
  assert.deepEqual(use(undefined), []);
  assert.deepEqual(use({ bars: 'buy' }), []);
  assert.deepEqual(use({ bars: 'smelt', ring: true }), ['ring', 'smelt']);
  assert.deepEqual(use({ bars: 'superheat', ring: true, gauntlets: true }), ['gauntlets', 'superheat']);
  assert.deepEqual(use({ bars: 'melt', ring: 0, gauntlets: true, other: true }), ['gauntlets']);
  assert.deepEqual(choicesInUse({ skill: 'crafting', opts: { bars: 'smelt', ring: true } }), []);
  // a method nothing changes is the very same one
  assert.equal(smith('ring', 'gauntlets', 'smelt').byId.get('sm_rune_platebody'), sm.byId.get('sm_rune_platebody'));
  // what never holds rounding up back: the ring, and the spell's runes
  assert.deepEqual([...SMITH_MINOR].sort(), ['firerune', 'naturerune', 'ring_of_forging']);
});

test('smithing: ore in your bank is smelted on the way to what it makes, and that XP counts (v2.6)', () => {
  // 100 runite ore, 800 coal and 7 bars at 99: 107 bars are 21 platebodies and a scimitar
  const bank = { runite_ore: 100, coal: 800, runite_bar: 7 };
  const res = planBank(sm, { bank, startXp10: xp10ForLevel(99) });
  assert.deepEqual(crSteps(res), [['sm_rune_platebody', 21, { sm_runite_bar: 98 }], ['sm_rune_scimitar', 1, { sm_runite_bar: 2 }]]);
  assert.equal(res.xp10, 21 * 3750 + 98 * 500 + 1500 + 2 * 500);
  assert.deepEqual(res.used, bank);
  // at 72 neither the ore nor the bars can be worked yet (85): they wait
  assert.deepEqual(planBank(sm, { bank, startXp10: xp10ForLevel(72) }).steps, []);
  // iron without a ring: 1,000 ore are 500 bars
  const iron = planBank(sm, { bank: { iron_ore: 1000 }, startXp10: xp10ForLevel(40) });
  assert.deepEqual(crSteps(iron), [['sm_iron_platebody', 100, { sm_iron_bar: 500 }]]);
  assert.equal(iron.xp10, 100 * 1250 + 500 * 125);
  // with coal as well, steel gets the ore first (more XP a platebody), as far as the coal goes
  const both = planBank(sm, { bank: { iron_ore: 1000, coal: 1200 }, startXp10: xp10ForLevel(72) });
  assert.deepEqual(crSteps(both), [['sm_steel_platebody', 120, { sm_steel_bar: 600 }], ['sm_iron_platebody', 40, { sm_iron_bar: 200 }]]);
  // unticking the smelting rows changes nothing about that: bars are still smelted on the way
  const smeltRows = new Set(sm.train.filter(m => m.group === 'Smelting').map(m => m.id));
  assert.deepEqual(crSteps(planBank(sm, { bank: { iron_ore: 1000, coal: 1200 }, startXp10: xp10ForLevel(72), excluded: smeltRows })), crSteps(both));
  // ore with nothing ticked to smith it into is smelted for its own sake
  const anvil = new Set(sm.train.filter(m => m.group !== 'Smelting').map(m => m.id));
  assert.deepEqual(crSteps(planBank(sm, { bank: { iron_ore: 1000, coal: 1200 }, startXp10: xp10ForLevel(72), excluded: anvil })), [['sm_steel_bar', 600, {}], ['sm_iron_bar', 200, {}]]);
  // each row on its own, and what rounding it up would take
  const plan = planGoal(sm, { bank: { iron_ore: 1000, coal: 1200 }, currentXp10: xp10ForLevel(72), targetXp10: xp10ForLevel(80), minor: SMITH_MINOR });
  assert.deepEqual([row(plan, 'sm_steel_platebody').have, row(plan, 'sm_steel_platebody').balance], [120, { runs: 200, collect: { coal: 800 } }]);
  assert.deepEqual([row(plan, 'sm_iron_platebody').have, row(plan, 'sm_iron_platebody').balance], [100, null]);
  assert.equal(plan.fill.id, 'sm_steel_platebody', 'carries on with what the bank mostly made');
  assert.deepEqual(plan.fill.buy, { steel_bar: plan.fill.segments[0].runs * 5 }, 'bars, when you buy them');
});

test('smithing: a ring of forging saves the iron ore, 140 bars a ring, and the rings are counted (v2.6)', () => {
  const ringed = smith('ring');
  const bank = { iron_ore: 1000, ring_of_forging: 3 };
  // three rings are 420 bars: 84 platebodies, and 580 ore left
  const res = planBank(ringed, { bank, startXp10: xp10ForLevel(40) });
  assert.deepEqual(crSteps(res), [['sm_iron_platebody', 84, { sm_ring_of_forging: 3, sm_iron_bar: 420 }]]);
  assert.deepEqual(res.leftover.toObject(), { iron_ore: 580, iron_platebody: 84 });
  assert.deepEqual(res.used, { iron_ore: 420, ring_of_forging: 3 });
  // no rings: no iron bars as it is (steel, which never fails, would still take the ore)
  assert.deepEqual(planBank(ringed, { bank: { iron_ore: 1000 }, startXp10: xp10ForLevel(40) }).steps, []);
  // each row on its own; rounding up, rings never decide, and the ones you're short of are collected
  const at = { bank, currentXp10: xp10ForLevel(40), targetXp10: xp10ForLevel(60), minor: SMITH_MINOR };
  const plan = planGoal(ringed, at);
  assert.deepEqual([row(plan, 'sm_iron_bar').have, row(plan, 'sm_iron_bar').balance], [420, { runs: 1000, collect: { ring_of_forging: 5 } }]);
  assert.deepEqual([row(plan, 'sm_iron_platebody').have, row(plan, 'sm_iron_platebody').balance], [84, { runs: 200, collect: { ring_of_forging: 5 } }]);
  const even = planGoal(ringed, { ...at, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(even), [['sm_iron_platebody', 200, false, { ring_of_forging: 5 }]]);
  assert.deepEqual(even.steps[0].sub, { sm_ring_of_forging: 8, sm_iron_bar: 1000 });
  assert.deepEqual(even.collect, { ring_of_forging: 5 });
  assert.deepEqual(even.leftover.toObject(), { ring_of_forging_charge: 120, iron_platebody: 200 }, "what's left of the eighth ring carries on");
  // rings alone call for nothing
  const alone = planGoal(ringed, { ...at, bank: { ring_of_forging: 10 }, roundUp: true }).fromBank;
  assert.deepEqual([alone.steps, alone.collect], [[], {}]);
  // still to make: whole rings, less what's left of the ore
  const still = row(plan, 'sm_iron_bar');
  assert.deepEqual(still.collect, { iron_ore: still.toMake - 580, ring_of_forging: Math.ceil(still.toMake / 140) });
  // one bar's share of a ring is a 140th of it, and it's costed that way
  const gp = { iron_ore: 100, ring_of_forging: 2800, iron_bar: 150, iron_platebody: 1000 };
  const e = methodEconomics(ringed, ringed.byId.get('sm_iron_bar'), k => gp[k] ?? null);
  assert.deepEqual(e.inputs, { iron_ore: 1, ring_of_forging: 1 / 140 });
  assert.ok(Math.abs(e.cost - 120) < 1e-9 && Math.abs(e.net - 30) < 1e-9);
  assert.deepEqual(methodEconomics(ringed, ringed.byId.get('sm_iron_platebody'), k => gp[k] ?? null).inputs, { iron_bar: 5 }, 'bars are bought: no ring in it');
  assert.deepEqual(methodEconomics(smith('ring', 'smelt'), ringed.byId.get('sm_iron_platebody'), k => gp[k] ?? null).inputs, { iron_ore: 5, ring_of_forging: 5 / 140 });
  assert.deepEqual([1 / 140, 5 / 140, 3 / 140, 0.2, 5, 2.5].map(amountText), ['1/140', '1/28', '0.021', '0.2', '5', '2.5']);
});

test("smithing: with your own bars smelted, what's still to buy is ore and coal, and the smelting XP counts (v2.6)", () => {
  const toGo = 10_000_000;                      // a million XP
  const at = { currentXp10: xp10ForLevel(99), targetXp10: xp10ForLevel(99) + toGo, fillId: 'sm_rune_platebody' };
  const PLATE = 'sm_rune_platebody', BAR = 'sm_runite_bar';
  // bars bought (the calculator's Smithing mode): 375 XP each
  const buy = planGoal(sm, at);
  assert.deepEqual(buy.fill.segments, [{ id: PLATE, runs: 2667, xp10: 2667 * 3750, made: { rune_platebody: 2667 } }]);
  assert.deepEqual(buy.fill.buy, { runite_bar: 13335 });
  assert.deepEqual([row(buy, PLATE).xp10, row(buy, PLATE).xpAll, row(buy, PLATE).needed], [3750, undefined, 2667]);
  assert.equal(xpEach(sm, sm.byId.get(PLATE)), 3750);
  // smelted (its Smelting + smithing mode): 375 + 5 × 50 = 625 XP each, so 1,600 do it
  const smelting = smith('smelt');
  const made = planGoal(smelting, at);
  assert.deepEqual(made.fill.segments, [{ id: PLATE, runs: 1600, xp10: toGo, made: { rune_platebody: 1600 }, sub: { [BAR]: 8000 } }]);
  assert.deepEqual(made.fill.buy, { runite_ore: 8000, coal: 64000 });
  assert.deepEqual(made.fill.steps, { [PLATE]: 1600, [BAR]: 8000 });
  const r = row(made, PLATE);
  assert.deepEqual([r.xp10, r.xpAll, r.needed, r.toMake, r.collect], [3750, 6250, 1600, 1600, { runite_ore: 8000, coal: 64000 }]);
  assert.deepEqual(r.econ.inputs, { runite_ore: 5, coal: 40 });
  assert.equal(xpEach(smelting, smelting.byId.get(PLATE)), 6250);
  assert.deepEqual([row(made, BAR).xpAll, row(made, BAR).needed], [undefined, 20000], 'smelting on its own is as it was');
  // every anvil row, the way the calculator works it out: ceil(XP / (its XP + bars × the bar's XP)), and the ore that takes
  for (const m of smelting.train.filter(x => x.group !== 'Smelting')) {
    const [bar, bars] = Object.entries(m.in)[0];
    const smelt = smelting.producers.get(bar)[0];
    const n = Math.ceil(toGo / (m.xp + bars * smelt.xp));
    const t = row(made, m.id);
    assert.equal(t.needed, n, m.id);
    assert.deepEqual(t.collect, Object.fromEntries(Object.entries(smelt.in).map(([ore, q]) => [ore, q * bars * n])), m.id);
    assert.equal(row(buy, m.id).needed, Math.ceil(toGo / m.xp), `${m.id}: bars bought`);
  }
  // gp per XP counts it too: 5 bars' ore and coal over 625 XP
  const gp = k => ({ runite_ore: 10000, coal: 150, rune_platebody: 38000 })[k] ?? null;
  const e = methodEconomics(smelting, smelting.byId.get(PLATE), gp);
  assert.deepEqual([e.cost, e.value, e.net, e.gpPerXp], [56000, 38000, -18000, 18000 / 625]);
  // bars and ore already in your bank: 3 bars make a warhammer as it is; the 50 ore have no coal, so they wait
  // for the rest of the plan, which buys 50 fewer
  const some = planGoal(smelting, { ...at, bank: { runite_bar: 3, runite_ore: 50 }, minor: SMITH_MINOR });
  assert.deepEqual(crSteps(some.fromBank), [['sm_rune_warhammer', 1, {}]]);
  assert.deepEqual(some.fill.segments.map(s => [s.id, s.runs, s.xp10, s.sub]), [[PLATE, 1600, 1600 * 6250, { [BAR]: 8000 }]]);
  assert.deepEqual(some.fill.buy, { runite_ore: 7950, coal: 64000 });
  // rounded up, that ore is smelted with coal to collect: 10 platebodies (3 bars and 47 ore) and a warhammer
  const even = planGoal(smelting, { ...at, bank: { runite_bar: 3, runite_ore: 50 }, minor: SMITH_MINOR, roundUp: true });
  assert.deepEqual(evSteps(even.fromBank), [[PLATE, 10, false, { coal: 376 }], ['sm_rune_warhammer', 1, true, { coal: 24 }]]);
  assert.deepEqual(even.fromBank.steps.map(s => s.sub), [{ [BAR]: 47 }, { [BAR]: 3 }]);
  // bars left over aren't smelted, so they add no XP: it takes more platebodies than from scratch
  const kept = planGoal(smelting, { ...at, bank: { runite_bar: 4004 }, excluded: new Set(smelting.train.map(m => m.id).filter(id => id !== PLATE)), useBank: true });
  assert.equal(kept.fromBank.steps[0].runs, 800);                       // 4,000 bars: 800 platebodies, 300,000 XP; 4 bars over
  const rest = toGo - 800 * 3750;
  const runs = kept.fill.segments[0].runs;
  assert.equal(runs, Math.ceil((rest + 4 * 500) / 6250), 'the 4 bars left save 4 smelts, 200 XP');
  assert.equal(kept.fill.segments[0].xp10, runs * 3750 + (runs * 5 - 4) * 500);
  assert.deepEqual(kept.fill.buy, { runite_ore: runs * 5 - 4, coal: (runs * 5 - 4) * 8 });
  // a level you don't have yet: the best on the way, by the XP that counts
  const low = planGoal(smith('smelt'), { currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(50), fillId: 'sm_steel_platebody' });
  assert.deepEqual(low.fill.segments.map(s => [s.id, s.toLevel]), [['sm_steel_dagger', 35], ['sm_steel_scimitar', 39], ['sm_steel_warhammer', 48], ['sm_steel_platebody', undefined]]);
  assert.ok(low.fill.segments.every(s => s.xp10 === s.runs * (smelting.byId.get(s.id).xp + smelting.byId.get(s.id).in.steel_bar * 175)));
  assert.deepEqual(Object.keys(low.fill.buy), ['iron_ore', 'coal']);
  // your own mix: the bars smelted for it count
  const mix = planMix(smelting, { [PLATE]: 100, [BAR]: 20 }, { startXp10: xp10ForLevel(99) });
  assert.deepEqual(mix.steps.map(s => [s.id, s.runs, s.xp10, s.sub]), [[BAR, 20, 20 * 500, undefined], [PLATE, 100, 100 * 6250, { [BAR]: 500 }]]);
  assert.deepEqual(mix.buy, { runite_ore: 520, coal: 4160 });
  assert.deepEqual(planMix(sm, { [PLATE]: 100 }, { startXp10: xp10ForLevel(99) }).steps.map(s => [s.xp10, s.sub, s.buy]), [[100 * 3750, undefined, { runite_bar: 500 }]]);
});

test('smithing: goldsmith gauntlets, and Superheat Item for the bars: its runes, its Magic XP, and iron that never fails (v2.6)', () => {
  // gold: 22.5 XP a bar, 56.2 with the gauntlets
  assert.equal(planBank(sm, { bank: { gold_ore: 500 }, startXp10: xp10ForLevel(40) }).xp10, 500 * 225);
  assert.equal(planBank(smith('gauntlets'), { bank: { gold_ore: 500 }, startXp10: xp10ForLevel(40) }).xp10, 500 * 562);
  // superheated: as far as the runes go as it is. 200 nature runes are 200 bars, every ore one of them.
  const heat = smith('superheat');
  const at = { bank: { iron_ore: 1000, naturerune: 200, firerune: 5000 }, currentXp10: xp10ForLevel(40), targetXp10: xp10ForLevel(60), minor: SMITH_MINOR };
  const now = planGoal(heat, at);
  assert.deepEqual(crSteps(now.fromBank), [['sm_iron_platebody', 40, { sm_iron_bar: 200 }]]);
  const casts = fb => castsIn(heat, fb.steps.flatMap(st => [[st.id, st.runs], ...Object.entries(st.sub)]));
  assert.deepEqual(casts(now.fromBank), { xp10: 200 * 530, level: 43, by: { sm_iron_bar: 200 } });
  assert.deepEqual(row(now, 'sm_iron_bar').balance, { runs: 1000, collect: { naturerune: 800 } }, 'the 5,000 fire runes are enough for 1,000');
  // the rest of the goal, superheated too: ore, runes, and the Magic XP of it
  const f = now.fill;
  const bars = f.steps.sm_iron_bar;
  assert.deepEqual(f.segments.map(s => [s.id, s.sub]), [['sm_iron_platebody', { sm_iron_bar: bars }]]);
  assert.equal(bars, f.segments[0].runs * 5);
  assert.deepEqual(f.buy, { iron_ore: bars - 800, naturerune: bars, firerune: bars * 4 - 4200 }, 'less the 800 ore and 4,200 fire runes left in the bank');
  assert.deepEqual(castsIn(heat, Object.entries(f.steps)), { xp10: bars * 530, level: 43, by: { sm_iron_bar: bars } });
  // rounded up, runes never hold it back: the 800 nature runes short are collected
  const even = planGoal(heat, { ...at, roundUp: true }).fromBank;
  assert.deepEqual(evSteps(even), [['sm_iron_platebody', 200, false, { naturerune: 800 }]]);
  assert.deepEqual(casts(even), { xp10: 1000 * 530, level: 43, by: { sm_iron_bar: 1000 } });
  // runes alone round nothing up
  const alone = planGoal(heat, { ...at, bank: { naturerune: 9000, firerune: 36000 }, roundUp: true }).fromBank;
  assert.deepEqual([alone.steps, alone.collect], [[], {}]);
  // gold, gauntlets and Superheat: the classic. 56.2 Smithing XP and 53 Magic XP a cast.
  const classic = smith('gauntlets', 'superheat');
  const gold = planGoal(classic, { bank: { gold_ore: 300, naturerune: 300, firerune: 1200 }, currentXp10: xp10ForLevel(40), targetXp10: xp10ForLevel(50) });
  assert.deepEqual(crSteps(gold.fromBank), [['sm_gold_bar', 300, {}]]);
  assert.equal(gold.fromBank.xp10, 300 * 562);
  assert.deepEqual(castsIn(classic, [['sm_gold_bar', 300]]), { xp10: 300 * 530, level: 43, by: { sm_gold_bar: 300 } });
  assert.deepEqual(gold.fill.buy, { gold_ore: gold.fill.segments[0].runs, naturerune: gold.fill.segments[0].runs, firerune: gold.fill.segments[0].runs * 4 });
  assert.equal(gold.fill.segments[0].runs, Math.ceil(gold.remaining / 562));
});

// ── v2.7 ───────────────────────────────────────────────────────────────────
const lines = fb => fb.steps.map(s => [s.id, s.runs]);

test('herblore: super attacks get the irits before superantipoisons, prayer potions the snape grass before fishing potions (v2.7)', () => {
  const SA = 'hb_3dose2attack', SAP = 'hb_3dose2antipoison', PP = 'hb_3doseprayerrestore', FP = 'hb_3dosefisherspotion';
  assert.deepEqual(ix.byId.get(SAP).after, [SA]);
  assert.deepEqual(ix.byId.get(FP).after, [PP]);
  assert.deepEqual(METHODS.filter(m => m.after && m.skill === 'herblore').map(m => m.id), [SAP, FP], "Herblore's only two");
  const at = { currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(99), unlimited: VIALS, minor: VIALS };
  const fb = (bank, more = {}) => planGoal(ix, { ...at, bank, ...more }).fromBank;

  // 1,000 irits, eyes of newt for 400 of them: those first, though a superantipoison is more XP
  const irits = { irit_leaf: 1000, eye_of_newt: 400, unicorn_horn_dust: 1000 };
  assert.deepEqual(lines(fb(irits)), [[SA, 400], [SAP, 600]]);
  assert.equal(fb(irits).xp10, 400 * 1000 + 600 * 1063);
  assert.equal(row(planGoal(ix, { ...at, bank: irits }), SAP).have, 1000, 'on its own it could take them all, as its row says');
  // with nothing to make super attacks of, or with them unticked, superantipoisons take the irits as before
  assert.deepEqual(lines(fb({ irit_leaf: 1000, unicorn_horn_dust: 1000 })), [[SAP, 1000]]);
  assert.deepEqual(lines(fb(irits, { excluded: new Set([SA]) })), [[SAP, 1000]]);
  // the one you picked to train with still goes first: that's your call
  assert.deepEqual(lines(fb(irits, { fillId: SAP })), [[SAP, 1000]]);
  assert.deepEqual(lines(fb(irits, { fillId: SA })), [[SA, 400], [SAP, 600]]);
  // below level 48 only super attacks can be made anyway; a level on, the rest become superantipoisons
  assert.deepEqual(lines(fb(irits, { currentXp10: xp10ForLevel(45) })), [[SA, 400], [SAP, 600]]);
  assert.deepEqual(lines(fb({ irit_leaf: 100, eye_of_newt: 40, unicorn_horn_dust: 100 }, { currentXp10: xp10ForLevel(45) })), [[SA, 40]], '4,000 XP is not level 48');

  // ranarrs and avantoes after the same snape grass
  const snape = { ranarr_weed: 254, avantoe: 994, snape_grass: 800 };
  assert.deepEqual(lines(fb(snape)), [[PP, 254], [FP, 546]]);
  assert.deepEqual(lines(fb(snape, { fillId: FP })), [[FP, 800]]);
  assert.deepEqual(lines(fb({ avantoe: 994, snape_grass: 800 })), [[FP, 800]]);

  // rounding up: spare irits become super attacks (eyes of newt to collect), spare snape grass prayer potions
  assert.deepEqual(evSteps(fb({ irit_leaf: 200 }, { roundUp: true })), [[SA, 200, true, { eye_of_newt: 200 }]]);
  assert.deepEqual(evSteps(fb({ snape_grass: 300 }, { roundUp: true })), [[PP, 300, true, { ranarr_weed: 300 }]]);
  assert.deepEqual(evSteps(fb(irits, { roundUp: true })), [[SA, 400, false, null], [SAP, 600, false, null], [SAP, 400, true, { irit_leaf: 400 }]]);
  // every other pair is still best XP first: kwuarm goes to weapon poison before super strength
  assert.deepEqual(lines(fb({ kwuarm: 100, limpwurt_root: 100, dragon_scale_dust: 60 })), [['hb_weapon_poison', 60], ['hb_3dose2strength', 40]]);
});

test('the bank plan in an order of your own: the top line gets the bank first, then down the list (v2.7)', () => {
  const SA = 'hb_3dose2attack', SAP = 'hb_3dose2antipoison', PP = 'hb_3doseprayerrestore', FP = 'hb_3dosefisherspotion';
  const WP = 'hb_weapon_poison', SS = 'hb_3dose2strength', SD = 'hb_3dose2defense';
  const at = { currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(99), unlimited: VIALS, minor: VIALS };
  const plan = (bank, more = {}) => planGoal(ix, { ...at, bank, ...more });
  const fb = (bank, more) => plan(bank, more).fromBank;
  const irits = { irit_leaf: 1000, eye_of_newt: 400, unicorn_horn_dust: 1000 };
  // your order beats the usual one, either way round
  assert.deepEqual(lines(fb(irits, { order: [SAP, SA] })), [[SAP, 1000]]);
  assert.deepEqual(lines(fb(irits, { order: [SA, SAP] })), [[SA, 400], [SAP, 600]]);
  // and it beats the one you picked to train with, when that one has a place in it
  assert.deepEqual(lines(fb(irits, { order: [SA, SAP], fillId: SAP })), [[SA, 400], [SAP, 600]]);
  // an empty order is no order
  assert.deepEqual(fb(irits, { order: [] }), fb(irits));
  assert.deepEqual(fb(irits, { order: ['hb_no_such_potion'] }), fb(irits));

  const bank = { ...irits, ranarr_weed: 254, avantoe: 994, snape_grass: 800, kwuarm: 605, limpwurt_root: 518, dragon_scale_dust: 300, cadantine: 472, white_berries: 200 };
  // as it is: best XP first, level by level
  assert.deepEqual(lines(fb(bank)), [[WP, 300], [SS, 305], [SA, 400], [SAP, 600], [PP, 254], [FP, 153], [SD, 200], [FP, 393]]);
  // prayer potions, then super strength (so the kwuarm goes there, not to weapon poison); the rest as usual, after them
  const mine = fb(bank, { order: [PP, SS] });
  assert.deepEqual(lines(mine).slice(0, 2), [[PP, 254], [SS, 518]]);
  assert.deepEqual(lines(mine).slice(2, 4), [[WP, 87], [FP, 546]], 'weapon poison gets the 87 kwuarm left; with the ranarrs gone, fishing potions the snape grass');
  assert.equal(mine.leftover.have('kwuarm'), 0);
  // what a line makes isn't what its row could make on its own: the table still says that
  assert.equal(row(plan(bank, { order: [PP, SS] }), WP).have, 300);
  assert.equal(row(plan(bank, { order: [PP, SS] }), WP).fromPlan, 87);
  // the one you picked, when it has no place in your order, comes after the ones that do
  assert.deepEqual(lines(fb(bank, { order: [PP], fillId: SD })).slice(0, 2), [[PP, 254], [WP, 300]], 'then best XP as usual, until super defence at level 66');
  // unticked lines stay out, wherever your order has them
  assert.deepEqual(lines(fb(bank, { order: [PP, SS], excluded: new Set([PP]) }))[0], [SS, 518]);

  // a line that needs a level you don't have yet: the ones below it only go as far as that level
  const bows = { bank: { yew_logs: 5000, bow_string: 5000, rune_dart_tip: 1000, feather: 1000 }, currentXp10: xp10ForLevel(80), targetXp10: xp10ForLevel(99), fillGroup: 'Bows' };
  assert.deepEqual(lines(planGoal(fl, bows).fromBank), [['fl_cs_yew_longbow', 5000], ['fl_dart_rune_dart', 1000]]);
  const first = planGoal(fl, { ...bows, order: ['fl_dart_rune_dart'] }).fromBank;
  const toLevel81 = Math.ceil((xp10ForLevel(81) - xp10ForLevel(80)) / fl.byId.get('fl_cs_yew_longbow').xp);
  assert.deepEqual(lines(first), [['fl_cs_yew_longbow', toLevel81], ['fl_dart_rune_dart', 1000], ['fl_cs_yew_longbow', 5000 - toLevel81]]);
  assert.equal(first.xp10, planGoal(fl, bows).fromBank.xp10, 'the same things made, in another order');

  // rounding up keeps to it too: the lines the bank makes, in your order, then what rounding up adds, in your order
  const up = plan(bank, { order: [PP, SS], roundUp: true });
  assert.deepEqual(up.fromBank.steps.filter(s => !s.rounded), mine.steps, 'the bank part is the plan as it is, in your order');
  assert.deepEqual(up.bankNow, mine);
  assert.ok(up.fromBank.steps.some(s => s.rounded), 'and something was rounded up');
  const usual = fb(bank, { roundUp: true }).steps.filter(s => s.rounded).map(s => s.id);
  const fishFirst = fb(bank, { order: [FP], roundUp: true }).steps.filter(s => s.rounded).map(s => s.id);
  assert.deepEqual(usual, [SD, SS, FP, SAP], 'rounded up best XP first, as usual');
  assert.equal(fishFirst[0], FP, 'in your order, fishing potions are rounded up first');
});

test('mining: by the bar, the ore a bar takes mined together: a steel bar is 1 iron ore and 2 coal (v2.7)', () => {
  const bars = mi.train.filter(m => m.group === 'Bars');
  assert.deepEqual(bars.map(m => [m.name, m.level, m.xp / 10, m.out]), [
    ['Bronze bar', 1, 35, { copper_ore: 1, tin_ore: 1 }],
    ['Iron bar', 15, 70, { iron_ore: 2 }],
    ['Iron bar (ring of forging)', 15, 35, { iron_ore: 1 }],
    ['Silver bar', 20, 40, { silver_ore: 1 }],
    ['Steel bar', 30, 135, { iron_ore: 1, coal: 2 }],
    ['Gold bar', 40, 65, { gold_ore: 1 }],
    ['Mithril bar', 55, 280, { mithril_ore: 1, coal: 4 }],
    ['Adamantite bar', 70, 395, { adamantite_ore: 1, coal: 6 }],
    ['Runite bar', 85, 525, { runite_ore: 1, coal: 8 }],
  ]);
  // each is the XP of its ores, at the level of the hardest one to mine; what the bar takes is Smithing's own recipe
  const rock = k => mi.byId.get(`mi_${k}`);
  const smelting = new Map(METHODS.filter(m => m.skill === 'smithing' && m.group === 'Smelting').map(m => [Object.keys(m.out)[0], m]));
  for (const m of bars) {
    const ores = Object.entries(m.out);
    assert.equal(m.xp, ores.reduce((a, [k, n]) => a + n * rock(k).xp, 0), m.id);
    assert.equal(m.level, Math.max(...ores.map(([k]) => rock(k).level)), m.id);
    assert.ok(gathers(m) && m.unit === 'bar' && m.units === 'bars' && m.lead === 'Ore for' && m.as.length === 2 && ITEMS[m.icon], m.id);
    const smelt = smelting.get(m.icon);
    const recipe = m.id === 'mi_bar_iron_bar_ring' ? smelt.opt.ring.in : smelt.in;
    assert.deepEqual(m.out, Object.fromEntries(Object.entries(recipe).filter(([k]) => ITEMS[k] && !ITEMS[k].charge)), `${m.id} is what Smithing smelts it from`);
    assert.match(m.note, new RegExp(`Smelting it takes Smithing ${smelt.level}\\.$`));
  }
  assert.ok(!bars.some(m => m.icon === 'elemental_workshop_bar'), 'elemental ore is dropped, not mined');
  assert.deepEqual(mi.byId.get('mi_bar_steel_bar').parts, [['iron ore', 350], ['2 coal', 1000]]);
  assert.match(mi.byId.get('mi_bar_iron_bar').note, /Half the ore is lost in a furnace, so a bar takes 2 on average/);
  assert.equal(mi.byId.get('mi_bar_silver_bar').parts, undefined, 'one ore: nothing to add up');

  // a plan by the bar: how many bars' worth, and how much of each ore that is
  const toGo = xp10ForLevel(70) - xp10ForLevel(60);
  const n = Math.ceil(toGo / 1350);
  const gp = { iron_ore: 100, coal: 150 };
  const plan = planGoal(mi, { currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(70), fillGroup: 'Rocks', fillId: 'mi_bar_steel_bar', priceOf: k => gp[k] ?? null });
  assert.deepEqual(plan.fill.segments, [{ id: 'mi_bar_steel_bar', runs: n, xp10: n * 1350, made: { iron_ore: n, coal: 2 * n } }]);
  assert.deepEqual(plan.fill.buy, {});
  assert.equal(row(plan, 'mi_bar_steel_bar').needed, n);
  assert.deepEqual([row(plan, 'mi_bar_steel_bar').econ.value, row(plan, 'mi_bar_steel_bar').econ.net], [100 + 2 * 150, 400], 'worth its ores');
  // nothing picked, a plan still mines a rock: a bar's row is several ores at once, so its XP isn't a rate
  assert.equal(planGoal(mi, { currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(70), fillGroup: 'Rocks' }).fill.id, 'mi_mithril_ore');
  // a bar you can't mine for yet: the best bar at each level on the way
  const low = planGoal(mi, { currentXp10: xp10ForLevel(25), targetXp10: xp10ForLevel(60), fillGroup: 'Rocks', fillId: 'mi_bar_mithril_bar' });
  assert.deepEqual(low.fill.segments.map(s => [s.id, s.toLevel]), [['mi_bar_iron_bar', 30], ['mi_bar_steel_bar', 55], ['mi_bar_mithril_bar', undefined]]);
  // in a mix: 100 steel bars' worth and 50 rune bars' worth
  const mix = planMix(mi, { mi_bar_steel_bar: 100, mi_bar_runite_bar: 50 }, { startXp10: xp10ForLevel(90) });
  assert.deepEqual(mix.made, { iron_ore: 100, coal: 200 + 400, runite_ore: 50 });
  assert.equal(mix.xp10, 100 * 1350 + 50 * 5250);
});

// ── Fishing (v2.7) ────────────────────────────────────────────────────────
// The rows are LostHQ's Fishing calculator, checked against the server's
// scripts when the data is built.
const fi = indexMethods(METHODS.filter(m => m.skill === 'fishing'));

test("fishing: LostHQ's 18 fish, with the gear each takes and a bait or a feather for a rod (v2.7)", () => {
  assert.deepEqual(fi.train.map(m => [m.name, m.level, m.xp / 10, m.tools[0], Object.keys(m.in)[0] || null]), [
    ['Raw shrimps', 1, 10, 'net', null], ['Raw karambwanji', 5, 5, 'net', null], ['Raw sardine', 5, 20, 'fishing_rod', 'fishing_bait'],
    ['Raw herring', 10, 30, 'fishing_rod', 'fishing_bait'], ['Raw anchovies', 15, 40, 'net', null], ['Raw mackerel', 16, 20, 'big_net', null],
    ['Raw trout', 20, 50, 'fly_fishing_rod', 'feather'], ['Raw cod', 23, 45, 'big_net', null], ['Raw pike', 25, 60, 'fishing_rod', 'fishing_bait'],
    ['Slimey eel', 28, 65, 'fishing_rod', 'fishing_bait'], ['Raw salmon', 30, 70, 'fly_fishing_rod', 'feather'], ['Raw tuna', 35, 80, 'harpoon', null],
    ['Raw lobster', 40, 90, 'lobster_pot', null], ['Raw bass', 46, 100, 'big_net', null], ['Raw swordfish', 50, 100, 'harpoon', null],
    ['Raw lava eel', 53, 60, 'oily_fishing_rod', 'fishing_bait'], ['Raw karambwan', 65, 105, 'tbwt_karambwan_vessel', null], ['Raw shark', 76, 110, 'harpoon', null],
  ]);
  assert.equal(fi.methods.length, 18, 'rows only: nothing is made on the way');
  assert.ok(fi.train.every(m => m.group === 'Fish' && m.tools.length === 1 && Object.values(m.out).length === 1 && Object.values(m.in).every(n => n === 1)));
  assert.equal(BANK_GROUPS.fishing, undefined, 'no bank tab: the gear is named, never counted');
  assert.ok(METHODS.filter(m => m.skill === 'fishing').flatMap(m => m.tools).every(k => ITEMS[k]));
  assert.equal(ITEMS.tbwt_karambwan_vessel.name, 'Karambwan vessel (empty)');
  // set aside: a big net's fish come with others, and four wait for a quest or a swamp
  assert.deepEqual(fi.train.filter(m => m.aside).map(m => m.id), ['fi_tbwt_raw_karambwanji', 'fi_raw_mackerel', 'fi_raw_cod', 'fi_mort_slimey_eel', 'fi_raw_bass', 'fi_raw_lava_eel', 'fi_tbwt_raw_karambwan']);
  assert.match(fi.byId.get('fi_raw_bass').note, /^A big net brings up several things at once: mackerel, cod \(from level 23\), bass \(from level 46\), and now and then leather boots, seaweed, leather gloves, oyster or casket\. Only the bass is counted here\.$/);
  assert.match(fi.byId.get('fi_tbwt_raw_karambwan').note, /Every try takes the raw karambwanji in your vessel, caught or not/);
});

test('fishing: fish to catch, the bait or feathers that takes, and what a plan picks at each level (v2.7)', () => {
  // (useBank: false, as the app passes it for a skill with no bank tab: feathers in a bank aren't a way to train)
  const at = (level, more = {}) => planGoal(fi, { currentXp10: xp10ForLevel(level), targetXp10: xp10ForLevel(level + 5), useBank: false, ...more });
  // nothing picked: the most XP a catch at your level, quest fish and the big net's aside
  const picks = [];
  for (let l = 1; l <= 94; l++) { const id = at(l).fill.id; if (picks[picks.length - 1]?.[1] !== id) picks.push([l, id]); }
  assert.deepEqual(picks, [[1, 'fi_raw_shrimp'], [5, 'fi_raw_sardine'], [10, 'fi_raw_herring'], [15, 'fi_raw_anchovies'], [20, 'fi_raw_trout'], [25, 'fi_raw_pike'],
    [30, 'fi_raw_salmon'], [35, 'fi_raw_tuna'], [40, 'fi_raw_lobster'], [50, 'fi_raw_swordfish'], [76, 'fi_raw_shark']]);
  // sharks from 81 to 90: a harpoon, and nothing to buy
  const toGo = xp10ForLevel(90) - xp10ForLevel(81);
  const sharks = planGoal(fi, { bank: { feather: 5000, raw_shark: 300 }, useBank: false, currentXp10: xp10ForLevel(81), targetXp10: xp10ForLevel(90) });
  assert.equal(sharks.fromBank.steps.length, 0, 'fish in the bank give no Fishing XP');
  assert.deepEqual(sharks.fill.segments, [{ id: 'fi_raw_shark', runs: Math.ceil(toGo / 1100), xp10: Math.ceil(toGo / 1100) * 1100, made: { raw_shark: Math.ceil(toGo / 1100) } }]);
  assert.deepEqual(sharks.fill.buy, {});
  // fly fishing: a feather a fish, listed to buy; a trout is worth what it sells for less its feather
  const gp = { raw_trout: 50, feather: 3, raw_salmon: 120 };
  const trout = at(20, { fillId: 'fi_raw_trout', priceOf: k => gp[k] ?? null });
  const n = Math.ceil((xp10ForLevel(25) - xp10ForLevel(20)) / 500);
  assert.deepEqual(trout.fill.buy, { feather: n });
  assert.equal(trout.fill.cost, 3 * n);
  assert.deepEqual([row(trout, 'fi_raw_trout').econ.cost, row(trout, 'fi_raw_trout').econ.value, row(trout, 'fi_raw_trout').econ.net], [3, 50, 47]);
  assert.deepEqual(row(trout, 'fi_raw_shrimp').econ.inputs, {});
  // a fish you can't catch yet: the best everyday one at each level on the way
  const low = planGoal(fi, { currentXp10: 0, targetXp10: xp10ForLevel(32), fillId: 'fi_raw_salmon', useBank: false });
  assert.deepEqual(low.fill.segments.map(s => [s.id, s.toLevel]), [['fi_raw_shrimp', 5], ['fi_raw_sardine', 10], ['fi_raw_herring', 15], ['fi_raw_anchovies', 20], ['fi_raw_trout', 25], ['fi_raw_pike', 30], ['fi_raw_salmon', undefined]]);
  const used = id => low.fill.segments.filter(s => s.id === id).reduce((a, s) => a + s.runs, 0);
  assert.deepEqual(low.fill.buy, { fishing_bait: used('fi_raw_sardine') + used('fi_raw_herring') + used('fi_raw_pike'), feather: used('fi_raw_trout') + used('fi_raw_salmon') });
  // one you pick is yours, quest fish or not
  assert.equal(at(70, { fillId: 'fi_tbwt_raw_karambwan' }).fill.id, 'fi_tbwt_raw_karambwan');
});

// ── Cooking (v2.7) ────────────────────────────────────────────────────────
// The rows are LostHQ's Cooking calculator, checked against the server's
// cooking table and scripts when the data is built.
const ckAll = METHODS.filter(m => m.skill === 'cooking');
const ck = indexMethods(ckAll);                                // on a range, burnt food counted
const cook = (...opts) => indexMethods(ckAll, { opts });       // with these choices in use
const ckPlain = cook('ignore');                                // burnt food left out, like the calculator

test("cooking: LostHQ's five tabs, row for row; the server's XP where they differ (v2.7)", () => {
  const rows = group => ckAll.filter(m => m.kind === 'xp' && m.group === group).map(m => [m.name, m.level, xpEach(ckPlain, ckPlain.byId.get(m.id)) / 10]);
  assert.deepEqual(rows('Fish'), [
    ['Karambwanji', 1, 10], ['Shrimps', 1, 30], ['Anchovies', 1, 30], ['Sardine', 1, 40], ['Cooked karambwan (poorly)', 1, 80], ['Cooked karambwan', 1, 190],
    ['Herring', 5, 50], ['Mackerel', 10, 60], ['Trout', 15, 70], ['Cod', 18, 75], ['Pike', 20, 80], ['Salmon', 25, 90], ['Cooked slimey eel', 28, 95],
    ['Tuna', 30, 100], ['Lobster', 40, 120], ['Bass', 43, 130], ['Swordfish', 45, 140], ['Lava eel', 53, 140], ['Shark', 80, 210], ['Sea turtle', 82, 211.3],
    ['Manta ray', 91, 216.3],                 // (LostHQ: 216.2)
  ]);
  assert.deepEqual(rows('Meat'), [
    ['Cooked meat', 1, 30], ['Cooked meat (rat meat)', 1, 30], ['Cooked meat (bear meat)', 1, 30], ['Cooked chicken', 1, 30], ['Cooked rabbit', 1, 30], ['Ugthanki meat', 1, 40],
    ['Thin snail meat', 12, 70], ['Lean snail meat', 17, 80], ['Fat snail meat', 22, 95],
    ['Cooked chompy', 30, 14],                // (LostHQ: 100)
    ['Wrapped oomlie', 50, 10],               // (the server's own: not on the calculator)
    ['Cooked oomlie wrap', 50, 30],
  ]);
  // a topped pizza is the calculator's whole job: the baking (143) and the topping
  assert.deepEqual(rows('Pies & pizza'), [
    ['Redberry pie', 10, 78], ['Meat pie', 20, 110], ['Apple pie', 30, 130], ['Plain pizza', 35, 143], ['Meat pizza', 45, 169], ['Anchovy pizza', 55, 182],
    ['Pineapple pizza', 65, 188],             // (LostHQ: 195)
  ]);
  assert.deepEqual(rows('Gnome'), [['Half baked bowl', 1, 3], ['Half baked crunchy', 1, 3], ['Half baked batta', 1, 3], ['Drunk dragon', 1, 60]]);
  assert.deepEqual(rows('Other'), [
    ['Swamp paste', 1, 2], ['Bread', 1, 40], ['Stew', 25, 117], ["Marinated j' bones", 30, 100], ["Marinated j' bones (burnt bones)", 30, 100],
    ['Jug of wine', 35, 110],                 // (LostHQ: 200)
    ['Cake', 40, 180], ['Chocolate cake', 50, 210], ['Pitta bread', 58, 40], ['Curry', 60, 280],
  ]);
  assert.deepEqual([...new Set(ck.train.map(m => m.group))], ['Fish', 'Meat', 'Pies & pizza', 'Gnome', 'Other']);
  // the topping and the chocolate are rows of their own XP; the bake before them is planned through
  assert.deepEqual(['ck_meat_pizza', 'ck_anchovie_pizza', 'ck_pineapple_pizza', 'ck_chocolate_cake'].map(id => ck.byId.get(id).xp), [260, 390, 450, 300]);
  assert.deepEqual(ckAll.filter(m => m.through).map(m => m.id), ['ck_plain_pizza', 'ck_cake']);
  assert.deepEqual(ckAll.filter(m => m.feeds).map(m => m.id), ['ck_anchovies', 'ck_cooked_meat', 'ck_cooked_meat_raw_rat_meat', 'ck_cooked_meat_raw_bear_meat', 'ck_wrapped_oomlie', 'ck_plain_pizza', 'ck_cake']);
  assert.match(ck.byId.get('ck_wrapped_oomlie').note, /Not on LostHQ's calculator/);
  // every item is known, and each bank item is in one group only
  for (const m of ckAll) for (const k of [...Object.keys(m.in), ...Object.keys(m.out), ...(m.tools || [])]) assert.ok(ITEMS[k], `${m.id}: ${k}`);
  const banked = BANK_GROUPS.cooking.flatMap(g => g.items);
  assert.equal(new Set(banked).size, banked.length);
  assert.deepEqual(BANK_GROUPS.cooking.map(g => g.name), ['Raw fish', 'Raw meat', 'Pies and bread', 'Pizza and cake', 'Stew, wine and the rest', 'Cooked: fish', 'Cooked: meat', 'Cooked: pies and pizza', 'Cooked: the rest']);
  assert.deepEqual([ITEMS.tbwt_poorly_cooked_karambwan.name, ITEMS.tbwt_cooked_karambwan.name], ['Cooked karambwan (poorly)', 'Cooked karambwan']);
});

test('cooking: what a pie, a pizza, a cake, a stew and a wine are made of is planned through (v2.7)', () => {
  const from = (id, n, more = {}) => expandFrom(ckPlain, id, n, more);
  function expandFrom(ix, id, n, { bank = {} } = {}) {
    const plan = planMix(ix, { [id]: n }, { startXp10: xp10ForLevel(99) });
    return [plan.buy, plan.steps[0].sub || {}];
  }
  // a redberry pie: flour and water make the dough, the dough goes in a dish, redberries fill it
  assert.deepEqual(from('ck_redberry_pie', 10), [{ pot_flour: 10, bucket_water: 10, piedish: 10, redberries: 10 },
    { ck_uncooked_redberry_pie: 10, ck_pie_shell: 10, ck_pastry_dough: 10 }]);
  assert.deepEqual(from('ck_meat_pie', 4)[0], { pot_flour: 4, bucket_water: 4, piedish: 4, cooked_meat: 4 }, 'cooked meat is bought, as the calculator has it');
  assert.deepEqual(from('ck_apple_pie', 4)[0], { pot_flour: 4, bucket_water: 4, piedish: 4, cooking_apple: 4 });
  assert.deepEqual(from('ck_bread', 7), [{ pot_flour: 7, bucket_water: 7 }, { ck_bread_dough: 7 }]);
  assert.deepEqual(from('ck_pitta_bread', 7)[0], { pot_flour: 7, bucket_water: 7 });
  // a pizza: a base, a tomato, cheese; the topping goes on once it's baked, and the baking counts
  assert.deepEqual(from('ck_plain_pizza', 5), [{ pot_flour: 5, bucket_water: 5, tomato: 5, cheese: 5 }, { ck_uncooked_pizza: 5, ck_incomplete_pizza: 5, ck_pizza_base: 5 }]);
  assert.deepEqual(from('ck_meat_pizza', 5), [{ pot_flour: 5, bucket_water: 5, tomato: 5, cheese: 5, cooked_meat: 5 },
    { ck_plain_pizza: 5, ck_uncooked_pizza: 5, ck_incomplete_pizza: 5, ck_pizza_base: 5 }]);
  assert.equal(planMix(ckPlain, { ck_meat_pizza: 5 }, { startXp10: xp10ForLevel(99) }).xp10, 5 * 1690);
  assert.deepEqual(from('ck_pineapple_pizza', 2)[0], { pot_flour: 2, bucket_water: 2, tomato: 2, cheese: 2, pineapple_ring: 2 });
  // a cake (its tin comes back), and chocolate on top
  assert.deepEqual(from('ck_cake', 3), [{ pot_flour: 3, egg: 3, bucket_milk: 3 }, { ck_uncooked_cake: 3 }]);
  assert.deepEqual(ck.byId.get('ck_cake').tools, ['cake_tin']);
  assert.deepEqual(from('ck_chocolate_cake', 3)[0], { pot_flour: 3, egg: 3, bucket_milk: 3, chocolate_bar: 3 });
  // stew, curry, wine, swamp paste, a gnome bowl
  assert.deepEqual(from('ck_stew', 6)[0], { bowl_water: 6, potato: 6, cooked_meat: 6 });
  assert.deepEqual(from('ck_curry', 6)[0], { bowl_water: 6, potato: 6, cooked_meat: 6, spicespot: 6 });
  assert.deepEqual(from('ck_jug_wine', 6)[0], { grapes: 6, jug_water: 6 });
  assert.deepEqual(from('ck_swamppaste', 6)[0], { swamp_tar: 6, pot_flour: 6 });
  assert.deepEqual(from('ck_half_baked_bowl', 6)[0], { gianne_dough: 6 });
  assert.deepEqual(ck.byId.get('ck_raw_gnomebowl').tools, ['gnomebowl_mould']);
  // a fish is one raw thing
  assert.deepEqual(from('ck_shark', 6), [{ raw_shark: 6 }, {}]);

  // from a bank: what's part-made counts, and a raw thing that goes into another is cooked on the way, its XP counted
  const bank = { uncooked_pizza: 20, pizza_base: 5, tomato: 5, cheese: 5, raw_beef: 30, piedish: 12, pot_flour: 12, bucket_water: 12 };
  const fb = planGoal(ckPlain, { bank, currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(80) }).fromBank;
  assert.deepEqual(fb.steps.map(s => [s.id, s.runs, s.sub]), [
    ['ck_plain_pizza', 25, { ck_incomplete_pizza: 5, ck_uncooked_pizza: 5 }],
    ['ck_meat_pie', 12, { ck_pastry_dough: 12, ck_pie_shell: 12, ck_cooked_meat: 12, ck_uncooked_meat_pie: 12 }],
    ['ck_cooked_meat', 18, {}],
    ['ck_meat_pizza', 18, {}],
  ]);
  assert.equal(fb.xp10, 25 * 1430 + 12 * (1100 + 300) + 18 * 300 + 18 * 260);
  assert.deepEqual(fb.leftover.toObject(), { plain_pizza: 7, meat_pie: 12, meat_pizza: 18 });
});

test('cooking: food burns by the server\'s own chances: by level, on a range or a fire, with cooking gauntlets (v2.7)', () => {
  // the roll the server makes: so many tries in 256 work at a level
  assert.equal(WHOLE, 256);
  assert.equal(chanceUnits([38, 332], 40), 22 + 132 + 1);         // a lobster at 40: floor(38*59/98) + floor(332*39/98) + 1
  assert.equal(chanceUnits([38, 332], 73), 254);
  assert.equal(chanceUnits([38, 332], 74), 256);
  assert.equal(chanceUnits([500, 500], 1), 256, 'never more than every time');
  assert.equal(chanceUnits([1, 232], 120), chanceUnits([1, 232], 99), 'a level above 99 counts as 99, as on the server');
  // the levels food stops burning at: the ones players know
  const stops = (ix, id) => { const m = ix.byId.get(id); return m.tries ? sureLevel(ix.byId.get(m.tries).roll, m.level) : m.level; };
  assert.deepEqual(['ck_shrimp', 'ck_sardine', 'ck_herring', 'ck_trout', 'ck_pike', 'ck_salmon', 'ck_tuna', 'ck_lobster', 'ck_bass', 'ck_swordfish', 'ck_shark'].map(id => stops(ck, id)),
    [34, 38, 41, 49, 54, 58, 63, 74, 80, 81, null], 'on a range; a shark never stops');
  assert.deepEqual(['ck_lobster', 'ck_swordfish', 'ck_shark'].map(id => stops(cook('gauntlets'), id)), [64, 81, 94]);
  assert.deepEqual(['ck_swordfish', 'ck_shark', 'ck_cod'].map(id => stops(cook('fire'), id)), [86, null, 51]);
  assert.equal(stops(ck, 'ck_cod'), 49);
  assert.equal(stops(cook('lumbridge'), 'ck_shrimp'), 31);
  // which chance applies: gauntlets before the Lumbridge range, before a fire or a range's own
  const roll = (ix, id) => ix.byId.get(ix.byId.get(id).tries)?.roll;
  assert.deepEqual(roll(ck, 'ck_shark'), [1, 232]);
  assert.deepEqual(roll(cook('fire'), 'ck_shark'), [1, 202]);
  assert.deepEqual(roll(cook('gauntlets'), 'ck_shark'), [15, 270]);
  assert.deepEqual(roll(cook('gauntlets', 'fire'), 'ck_shark'), [15, 270]);
  assert.deepEqual(roll(cook('lumbridge'), 'ck_shrimp'), [138, 532]);
  assert.deepEqual(roll(cook('lumbridge'), 'ck_shark'), [1, 232], 'Lumbridge\'s range is a range like any other for a shark');
  assert.deepEqual(roll(cook('fire'), 'ck_redberry_pie'), [98, 452], 'a pie needs a range whatever you pick');
  assert.equal(roll(cook('gauntlets', 'fire', 'ignore'), 'ck_shark'), undefined, 'left out: nothing burns');
  assert.equal(cook('ignore').byLevel, false);
  assert.equal(ck.byLevel, true);
  // what can't burn has no try: a lava eel, pitta bread, an oomlie in its leaf, swamp paste, the topping of a pizza
  for (const id of ['ck_lava_eel', 'ck_pitta_bread', 'ck_cooked_oomlie', 'ck_swamppaste', 'ck_meat_pizza', 'ck_drunk_dragon']) assert.equal(ck.byId.get(id).tries, undefined, id);
  assert.deepEqual(ckAll.filter(chanceOf).length, 42);
  // the choices a goal has, and the order they apply in: gauntlets, then where you cook, then leaving it out
  assert.deepEqual(CHOICES.cooking.map(c => [c.id, c.options?.map(o => o.id) ?? null]), [['heat', ['range', 'lumbridge', 'fire']], ['gauntlets', null], ['burnt', ['count', 'ignore']]]);
  assert.deepEqual(choicesInUse({ skill: 'cooking', opts: { heat: 'fire', gauntlets: true, burnt: 'ignore' } }), ['gauntlets', 'fire', 'ignore']);
  assert.deepEqual(choicesInUse({ skill: 'cooking', opts: { heat: 'range', burnt: 'count' } }), [], 'the first of each list is how it starts');
  assert.match(CHOICES.cooking[1].tip, /Lobsters stop burning at level 64 instead of 74; sharks stop burning at level 94 \(without, they never stop burning\)/);
});

test('cooking: a plan counts what burns, a level at a time: less XP from a bank, more raw food to collect (v2.7)', () => {
  // the plain sum to check against: what R raw things come to, level by level
  const expected = (chance, xpEachOne, R, x0) => {
    let xp = x0, left = R, done = 0;
    while (left > 0) {
      const L = levelForXp10(xp), p = chanceUnits(chance, L) / WHOLE;
      const n = Math.min(left, L >= 99 ? left : Math.max(1, Math.ceil((xp10ForLevel(L + 1) - xp) / (p * xpEachOne))));
      done += n * p; xp += n * p * xpEachOne; left -= n;
    }
    return done;
  };
  const at80 = { currentXp10: xp10ForLevel(80), targetXp10: xp10ForLevel(99), fillGroup: 'Fish' };
  const sharks = (ix, more = {}) => planGoal(ix, { ...at80, bank: { raw_shark: 2000 }, ...more });
  // 2,000 raw sharks at level 80 on a range: about 73 in 100 cook at first, a few more by the end
  const range = sharks(ck);
  // (every one of them goes on the range: the last raw shark too, though on average it's less than one more cooked)
  assert.deepEqual(range.fromBank.steps.map(s => [s.id, s.runs, s.sub]), [['ck_shark', 1473, { 'ck_shark~try': 2000 }]]);
  assert.ok(Math.abs(1473 - expected([1, 232], 2100, 2000, xp10ForLevel(80))) < 2);
  assert.equal(range.fromBank.xp10, 1473 * 2100);
  assert.deepEqual(range.fromBank.used, { raw_shark: 2000 }, 'none stays behind raw');
  assert.equal(range.fromBank.leftover.have('raw_shark'), 0);
  assert.equal(row(range, 'ck_shark').have, Math.floor((2000 * chanceUnits([1, 232], 80)) / WHOLE), 'its row: at your level now');
  // with cooking gauntlets more of them cook; on a fire fewer; left out, all of them, like the calculator
  assert.equal(sharks(cook('gauntlets')).fromBank.steps[0].runs, 1728);
  assert.equal(sharks(cook('fire')).fromBank.steps[0].runs, 1276);
  assert.deepEqual(sharks(ckPlain).fromBank.steps.map(s => [s.id, s.runs, s.sub]), [['ck_shark', 2000, {}]]);
  // from level 94 with gauntlets none burn: the same plan as with burning left out
  const top = { ...at80, bank: { raw_shark: 2000 }, currentXp10: xp10ForLevel(94) };
  assert.equal(planGoal(cook('gauntlets'), top).fromBank.steps[0].runs, 2000);
  assert.deepEqual(planGoal(cook('gauntlets'), top).fill.buy, planGoal(ckPlain, top).fill.buy);

  // (400 raw lobsters with gauntlets from 112,045 XP: 399 of them make the 340th lobster, and the 400th is cooked all the same)
  const gloved = planGoal(cook('gauntlets'), { bank: { raw_lobster: 400 }, currentXp10: 1120450, targetXp10: xp10ForLevel(60), fillGroup: 'Fish' });
  assert.deepEqual(gloved.fromBank.steps.map(s => [s.id, s.runs, s.sub]), [['ck_lobster', 340, { 'ck_lobster~try': 400 }]]);
  assert.ok(Math.abs(340 - expected([55, 368], 1200, 400, 1120450)) < 2);
  assert.equal(gloved.fill.segments[0].sub['ck_lobster~try'], gloved.fill.buy.raw_lobster, 'so the rest of the goal cooks what it buys, no more');
  // what's made for a pie on the way is finished the same: 40 pies' worth of everything is 40 pies in the oven
  const meatPies = planGoal(ck, { bank: { raw_beef: 40, pot_flour: 40, bucket_water: 40, piedish: 40 }, currentXp10: 1120450, targetXp10: xp10ForLevel(60), fillGroup: 'Fish' }).fromBank;
  assert.deepEqual(meatPies.steps.map(s => [s.id, s.sub['ck_meat_pie~try'], s.sub.ck_uncooked_meat_pie]), [['ck_meat_pie', 40, 40]]);
  assert.ok(meatPies.steps[0].runs < 40 && meatPies.steps[0].runs >= 36, `${meatPies.steps[0].runs} of the 40 come out`);
  assert.deepEqual(['raw_beef', 'pot_flour', 'bucket_water', 'piedish'].map(k => meatPies.leftover.have(k)), [0, 0, 0, 0]);

  // the rest of the goal: the same number cooked as the calculator says, and the raw sharks that takes
  const rest = range.fill;
  const cooked = rest.segments[0].runs;
  assert.equal(cooked, Math.ceil(range.remaining / 2100));
  assert.equal(rest.segments[0].sub['ck_shark~try'], rest.buy.raw_shark, 'every one bought is cooked');
  assert.ok(rest.buy.raw_shark > cooked * 1.1 && rest.buy.raw_shark < cooked * (WHOLE / chanceUnits([1, 232], 81)), 'more than are cooked; fewer than if you stayed level 81');
  assert.equal(row(range, 'ck_shark').toMake, cooked);
  assert.deepEqual(row(range, 'ck_shark').collect, rest.buy);
  assert.equal(row(range, 'ck_shark').needed, row(sharks(ckPlain), 'ck_shark').needed, 'to goal is in sharks cooked');
  // a shark costs the raw ones it takes at your level: 256 in 188 at level 80
  const e = methodEconomics(ck, ck.byId.get('ck_shark'), k => ({ raw_shark: 1000, shark: 1200 })[k] ?? null, { level: 80 });
  assert.ok(Math.abs(e.inputs.raw_shark - WHOLE / 188) < 1e-6 && e.net < 0, `${e.inputs.raw_shark} raw sharks a shark`);
  assert.ok(Math.abs(e.cost - (1000 * WHOLE) / 188) < 0.01 && Math.abs(e.net - (1200 - (1000 * WHOLE) / 188)) < 0.01, 'costed by that share exactly, not by a whole try more');
  assert.deepEqual(methodEconomics(ckPlain, ckPlain.byId.get('ck_shark'), k => ({ raw_shark: 1000, shark: 1200 })[k] ?? null, { level: 80 }).inputs, { raw_shark: 1 });

  // lobsters from 40: they stop burning at 74, so the further you go the fewer burn
  const lob = planGoal(ck, { bank: { raw_lobster: 5000 }, currentXp10: xp10ForLevel(40), targetXp10: xp10ForLevel(99), fillGroup: 'Fish' });
  assert.equal(lob.fromBank.steps.length, 1, 'one line, though it was made a level at a time');
  assert.ok(Math.abs(lob.fromBank.steps[0].runs - expected([38, 332], 1200, 5000, xp10ForLevel(40))) < 2);
  assert.equal(lob.fromBank.steps[0].sub['ck_lobster~try'], 5000);
  // something else first can save sharks: 500 lobsters take you up a level before the sharks go on
  const both = planGoal(ck, { ...at80, bank: { raw_shark: 2000, raw_lobster: 500 } }).fromBank;
  assert.deepEqual(both.steps.map(s => s.id), ['ck_lobster', 'ck_shark']);
  assert.ok(both.steps[1].runs > 1473);

  // a pie can burn too: the dough, the dish and the berries of the ones that do are counted
  const pies = planMix(ck, { ck_redberry_pie: 100 }, { startXp10: xp10ForLevel(10) });
  const tries = pies.steps[0].sub['ck_redberry_pie~try'];
  assert.ok(tries > 100, `${tries} tries for 100 pies`);
  assert.deepEqual(pies.buy, { pot_flour: tries, bucket_water: tries, piedish: tries, redberries: tries });
  assert.equal(pies.xp10, 100 * 780, 'XP is for the ones that come out');
  // a topped pizza: the bake can burn, the topping can't
  const pizza = planMix(ck, { ck_meat_pizza: 100 }, { startXp10: xp10ForLevel(45) });
  assert.equal(pizza.buy.cooked_meat, 100);
  assert.ok(pizza.buy.tomato > 100 && pizza.buy.tomato === pizza.steps[0].sub['ck_plain_pizza~try']);
  assert.equal(pizza.xp10, 100 * 1690);
});

test('cooking: nothing picked, a plan finishes with an everyday fish; quest food is yours to pick (v2.7)', () => {
  const at = (level, more = {}) => planGoal(ck, { currentXp10: xp10ForLevel(level), targetXp10: xp10ForLevel(level) + 1000, fillGroup: 'Fish', ...more });
  const picks = [];
  for (let l = 1; l <= 99; l++) { const id = at(l).fill.id; if (picks[picks.length - 1]?.[1] !== id) picks.push([l, id]); }
  assert.deepEqual(picks, [[1, 'ck_sardine'], [5, 'ck_herring'], [10, 'ck_mackerel'], [15, 'ck_trout'], [18, 'ck_cod'], [20, 'ck_pike'], [25, 'ck_salmon'], [30, 'ck_tuna'],
    [40, 'ck_lobster'], [43, 'ck_bass'], [45, 'ck_swordfish'], [80, 'ck_shark']]);
  assert.deepEqual(ck.train.filter(m => m.aside).map(m => m.id), ['ck_tbwt_cooked_karambwanji', 'ck_tbwt_poorly_cooked_karambwan', 'ck_tbwt_cooked_karambwan', 'ck_mort_slimey_eel_cooked', 'ck_lava_eel', 'ck_seaturtle', 'ck_mantaray']);
  assert.equal(at(90, { fillId: 'ck_tbwt_cooked_karambwan' }).fill.id, 'ck_tbwt_cooked_karambwan');
  // and what your bank holds is cooked whatever it is: a karambwan, thoroughly (190 XP) before poorly (80)
  assert.deepEqual(at(90, { bank: { tbwt_raw_karambwan: 50 } }).fromBank.steps.map(s => s.id), ['ck_tbwt_cooked_karambwan']);
  // a curry is the most XP there is; the app's fillGroup keeps a plan to fish all the same
  assert.equal(planGoal(ck, { currentXp10: xp10ForLevel(70), targetXp10: xp10ForLevel(71) }).fill.id, 'ck_curry');
});

test('the icon sheets are named with a stamp of their own contents, so positions and picture go together (v2.7)', () => {
  const stamp = file => createHash('sha1').update(readFileSync(new URL(`./${file}`, import.meta.url))).digest('hex').slice(0, 10);
  assert.equal(ICON_SHEET, `items.png?v=${stamp('items.png')}`);
  assert.equal(BANK_ICON_SHEET, `bankicons.png?v=${stamp('bankicons.png')}`);
});

test('crafting: an amulet of glory with no charges left is an item of its own (v2.7)', () => {
  assert.equal(ITEMS.amulet_of_glory.name, 'Amulet of glory (uncharged)');
  assert.equal(ITEMS.amulet_of_glory.id, 1704);
  const group = BANK_GROUPS.crafting.find(g => g.name === 'Made: enchanted jewellery').items;
  assert.deepEqual(group.slice(-2), ['amulet_of_glory', 'amulet_of_glory_4'], 'beside the charged one');
  assert.ok(!METHODS.some(m => m.in.amulet_of_glory || m.out.amulet_of_glory), 'banked and priced, not made: the row makes the charged one');
  // it's worth its own price in a bank
  assert.deepEqual(bankValue({ amulet_of_glory: 7, amulet_of_glory_4: 19 }, k => ({ amulet_of_glory: 100_000, amulet_of_glory_4: 110_000 })[k] ?? null), { total: 7 * 100_000 + 19 * 110_000, missing: [] });
});

// ── Thieving (v2.8) ───────────────────────────────────────────────────────
// The rows are LostHQ's Thieving calculator, checked against the server's
// tables and scripts when the data is built. Nothing goes in: no bank.
const th = indexMethods(METHODS.filter(m => m.skill === 'thieving'));
const rowsOf = (index, group) => index.train.filter(m => m.group === group).map(m => [m.name, m.level, m.xp / 10]);
// (coins are worth what they are: in the app the prices know, here the test says so)
const withCoins = gp => k => (k === 'coins' ? 1 : gp[k] ?? null);

test("thieving: LostHQ's NPCs, stalls, chests and doors, with the server's own where they differ (v2.8)", () => {
  assert.deepEqual([...new Set(th.train.map(m => m.group))], ['NPCs', 'Stalls', 'Chests', 'Doors']);
  assert.deepEqual(rowsOf(th, 'NPCs'), [['Man or woman', 1, 8], ['Farmer', 10, 14.5], ['Digsite workman', 25, 10.4], ['Warrior', 25, 26], ['Rogue', 32, 36.5], ['Guard', 40, 46.8],
    ['Fremennik citizen', 45, 65], ['Knight of Ardougne', 55, 84.3], ['Yanille watchman', 65, 137.5], ['Paladin', 70, 151.8], ['Gnome', 75, 198.3], ['Hero', 80, 273.3]]);
  assert.deepEqual(rowsOf(th, 'Stalls'), [['Bakery stall', 5, 16], ['Tea stall', 5, 16], ['Rock cake stall', 15, 6.5], ['Silk stall', 20, 24], ['Fur stall', 35, 36], ['Fur stall (Rellekka)', 35, 36],
    ['Fish stall (Rellekka)', 42, 42], ['Silver stall', 50, 54], ['Spice stall', 65, 81], ['Gem stall', 75, 16]]);
  assert.deepEqual(rowsOf(th, 'Chests'), [['10 coin chest', 13, 7.8], ['Nature rune chest', 28, 25], ['50 coin chest', 43, 125], ['Steel arrowtips chest', 47, 150], ['Blood rune chest', 59, 250], ['Ardougne castle chest', 72, 500]]);
  assert.deepEqual(rowsOf(th, 'Doors'), [['Ardougne house door (10 coin chest)', 1, 3.8], ['Ross house door', 13, 15], ['Ardougne house door (nature rune chest)', 16, 15], ['Magic axe hut door', 23, 25],
    ['Ardougne sewer gate', 31, 25], ['Pirate hideout door', 39, 35], ['Chaos Druid Tower door', 46, 37.5], ['Ardougne castle door', 61, 50], ['Yanille dungeon door', 82, 50]]);
  assert.equal(th.methods.length, 37, 'rows only: nothing is made on the way');
  assert.equal(BANK_GROUPS.thieving, undefined, 'no bank tab');
  assert.ok(th.train.every(m => Object.keys(m.in).length === 0 && m.kind === 'xp' && !m.chance), 'nothing goes in, and a failed theft is never counted as a try');
  // a lockpick for three doors and one chest: named, never used up
  assert.deepEqual(th.train.filter(m => m.tools).map(m => [m.id, ...m.tools]), [['th_chest_arrowtips', 'lockpick'], ['th_door_axe_hut', 'lockpick'], ['th_door_pirates', 'lockpick'], ['th_door_yanille', 'lockpick']]);
  // where the server and the calculator differ, the row says so
  const note = id => th.byId.get(id).note;
  assert.match(note('th_digworkman'), /LostHQ's calculator says level 10; the server asks for 25\.$/);
  assert.match(note('th_chest_10_coins'), /LostHQ's calculator says level 1; the server asks for 13\.$/);
  assert.equal(note('th_door_axe_hut'), "LostHQ's calculator says 22.5 XP; the server gives 25.");
  // and what only the server has
  const added = th.train.filter(m => /Not on LostHQ's calculator: the server's own level and XP\.$/.test(m.note || '')).map(m => m.id);
  assert.deepEqual(added, ['th_fremennik', 'th_stall_rockcake', 'th_door_house_10', 'th_door_house_nature']);
  // what waits for a quest isn't a plan's own pick
  assert.deepEqual(th.train.filter(m => m.aside).map(m => m.id), ['th_fremennik', 'th_stall_fur_rellekka', 'th_stall_fish_rellekka']);
  for (const m of th.train.filter(x => x.aside)) assert.match(m.note, /Once The Fremennik Trials is done\./, m.id);
  assert.match(note('th_door_ross'), /^In East Ardougne: the house north of the church/);
});

test('thieving: loot comes the way the server rolls for it, and a row is worth it (v2.8)', () => {
  const out = id => th.byId.get(id).out;
  // a pocket: every line rolled for on its own, from the last to the first, each out of what the ones before left of 128
  assert.deepEqual(out('th_man'), { coins: 3 });
  assert.deepEqual(out('th_farmer'), { coins: 9 * 123 / 128 }, '123 times in 128');
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);
  const rogue = out('th_rogue');
  assert.deepEqual(Object.keys(rogue), ['coins', 'airrune', 'jug_wine', 'lockpick', 'iron_dagger_p']);
  close(rogue.coins, 32.5);                     // 25 to 40, every time: its chance is all that's left
  close(rogue.airrune, 8 * 8 / 116); close(rogue.jug_wine, 6 / 122); close(rogue.lockpick, 5 / 127); close(rogue.iron_dagger_p, 1 / 128);
  const gnome = out('th_gnome');
  assert.equal(gnome.king_worm, 1, 'the first line is given every time');
  close(gnome.coins, 300 * 30 / 85); close(gnome.swamp_toad, 28 / 113); close(gnome.fire_orb, 2 / 128);
  assert.deepEqual(out('th_watchman'), { coins: 60, bread: 1 }, 'two lines of 128: both, always');
  assert.deepEqual(out('th_chest_castle'), { coins: 1000, raw_shark: 1, adamantite_ore: 1, uncut_sapphire: 1 });
  // a stall: one thing, by its weight
  assert.deepEqual(out('th_stall_bakery'), { cake: 0.65, bread: 0.25, chocolate_slice: 0.1 });
  assert.deepEqual(out('th_stall_fish_rellekka'), { raw_lobster: 0.05, raw_tuna: 0.25, raw_salmon: 0.7 });
  close(Object.values(out('th_stall_gem')).reduce((a, n) => a + n, 0), 1);
  // the Digsite workman has his own roll, out of 11; a specimen brush can't be traded, so it's not in what a theft is worth
  const dig = out('th_digworkman');
  close(dig.coins, 10 * 4 / 11); close(dig.rope, 1 / 11);
  assert.equal(dig.specimen_brush, undefined);
  assert.match(th.byId.get('th_digworkman').note, /specimen brush \(3 in 11\).*A specimen brush can't be traded/);
  assert.deepEqual(out('th_stall_rockcake'), {});
  assert.deepEqual(out('th_door_sewer'), {}, 'a lock gives nothing but XP');
  // said in words on the row
  assert.match(th.byId.get('th_rogue').note, /^Loot: 25 to 40 coins every time; now and then on top of that, 8 air runes \(8 in 116\), jug of wine \(6 in 122\), lockpick \(5 in 127\), iron dagger\(p\) \(1 in 128\)\. Caught: stunned for 5 seconds, hit for 2\.$/);
  assert.match(th.byId.get('th_farmer').note, /^Loot: 9 coins \(123 in 128\); otherwise nothing\./);
  assert.match(th.byId.get('th_chest_blood').note, /^Loot: 2 blood runes and 500 coins\. Empty for about 4 minutes after it's looted\. A second trap then teleports you away\.$/);
  assert.match(th.byId.get('th_stall_gem').note, /Empty for about 6 minutes after a theft\.$/);
  // what one is worth: coins as they are, the rest at its price
  const gp = withCoins({ airrune: 10, jug_wine: 50, lockpick: 100, iron_dagger_p: 300 });
  const e = methodEconomics(th, th.byId.get('th_rogue'), gp);
  assert.deepEqual([e.cost, e.inputs, e.missing], [0, {}, []]);
  close(e.value, 32.5 + 10 * 64 / 116 + 50 * 6 / 122 + 100 * 5 / 127 + 300 / 128);
  close(e.gpPerXp, -e.value / 36.5);
  assert.deepEqual(methodEconomics(th, th.byId.get('th_stall_gem'), gp).missing, ['uncut_sapphire', 'uncut_emerald', 'uncut_ruby', 'uncut_diamond'], 'no price yet: no guess');
  // coins are shown as the pile a stack that size is in the game, and are always worth 1 gp
  assert.deepEqual(['th_man', 'th_guard', 'th_hero', 'th_chest_castle', 'th_gnome', 'th_chest_nature'].map(id => th.byId.get(id).icon || null), ['coins_3', 'coins_25', 'coins_250', 'coins_1000', null, null]);
  assert.deepEqual([ITEMS.coins_25.name, ITEMS.coins.gp, ITEMS.coins_25.gp], ['Coins', 1, undefined]);
  assert.equal(th.byId.get('th_stall_fish_rellekka').icon, 'raw_salmon', 'a stall is shown as the likeliest thing it gives');
  assert.ok(th.train.filter(m => m.group === 'Doors').every(m => m.icon === 'lockpick'));
  for (const m of METHODS) if (m.icon) assert.ok(ITEMS[m.icon], `${m.id}: its icon ${m.icon}`);
});

test('thieving: how often a try works is the server\'s rolls, said and never counted (v2.8)', () => {
  // odds: [[low, high], …] as stat_random is given them; a trapped lock has two rolls to get past
  assert.deepEqual(th.byId.get('th_man').odds, [[180, 240]]);
  assert.deepEqual(th.byId.get('th_door_druid_tower').odds, [[220, 280], [8, 75]]);
  assert.deepEqual(th.train.filter(m => m.odds?.length === 2).map(m => m.id), ['th_door_ross', 'th_door_druid_tower', 'th_door_castle']);
  for (const m of th.train.filter(x => x.odds?.length === 2)) assert.match(m.note, /The lock has a trap that can go off first\./, m.id);
  assert.ok(th.train.filter(m => m.group === 'NPCs' || m.group === 'Doors').every(m => m.odds), 'pockets and locks can fail');
  assert.ok(th.train.filter(m => m.group === 'Stalls' || m.group === 'Chests').every(m => !m.odds), 'stalls and chests can\'t');
  assert.equal(chanceUnits([180, 240], 1), 181, 'a man at level 1: 181 times in 256');
  // a plan counts thefts that work: the XP to go over the XP of one, whatever the odds
  const plan = planGoal(th, { currentXp10: xp10ForLevel(55), targetXp10: xp10ForLevel(60), useBank: false, fillGroup: 'NPCs' });
  const toGo = xp10ForLevel(60) - xp10ForLevel(55);
  assert.deepEqual(plan.fill.segments, [{ id: 'th_knight', runs: Math.ceil(toGo / 843), xp10: Math.ceil(toGo / 843) * 843, made: { coins: 50 * Math.ceil(toGo / 843) } }]);
  assert.deepEqual(plan.fill.buy, {}, 'nothing to buy');
  assert.equal(th.byLevel, false);
});

test('thieving: nothing picked, a plan picks pockets, the best at each level; a mix and your own pick work as for Mining (v2.8)', () => {
  const at = (level, more = {}) => planGoal(th, { currentXp10: xp10ForLevel(level), targetXp10: xp10ForLevel(level) + 1000, useBank: false, fillGroup: 'NPCs', ...more });
  const picks = [];
  for (let l = 1; l <= 99; l++) { const id = at(l).fill.id; if (picks[picks.length - 1]?.[1] !== id) picks.push([l, id]); }
  assert.deepEqual(picks, [[1, 'th_man'], [10, 'th_farmer'], [25, 'th_warrior'], [32, 'th_rogue'], [40, 'th_guard'], [55, 'th_knight'], [65, 'th_watchman'], [70, 'th_paladin'], [75, 'th_gnome'], [80, 'th_hero']]);
  // (a chest is the most XP there is, and empty for minutes after: the app's fillGroup keeps a plan to pockets)
  assert.equal(planGoal(th, { currentXp10: xp10ForLevel(75), targetXp10: xp10ForLevel(76), useBank: false }).fill.id, 'th_chest_castle');
  // one you pick is yours: a quest's, a stall, a door
  assert.equal(at(50, { fillId: 'th_fremennik' }).fill.id, 'th_fremennik');
  assert.equal(at(50, { fillId: 'th_stall_silver' }).fill.segments[0].id, 'th_stall_silver');
  // one you can't do yet: the best pocket at each level on the way, the quest's left aside
  const low = planGoal(th, { currentXp10: xp10ForLevel(38), targetXp10: xp10ForLevel(60), useBank: false, fillGroup: 'NPCs', fillId: 'th_knight' });
  assert.deepEqual(low.fill.segments.map(s => [s.id, s.toLevel]), [['th_rogue', 40], ['th_guard', 55], ['th_knight', undefined]]);
  // a mix: 500 silk stalls, then guards for the rest; what it all brings in
  const gp = withCoins({ silk: 40 });
  const mix = planGoal(th, { currentXp10: xp10ForLevel(50), targetXp10: xp10ForLevel(55), useBank: false, fillGroup: 'NPCs', mix: { th_stall_silk: 500 }, priceOf: gp });
  assert.deepEqual(mix.fromMix.steps.map(s => [s.id, s.runs, s.xp10, s.gain.total]), [['th_stall_silk', 500, 120_000, 20_000]]);
  const rest = xp10ForLevel(55) - xp10ForLevel(50) - 120_000;
  assert.deepEqual([mix.fill.id, mix.fill.segments[0].runs], ['th_guard', Math.ceil(rest / 468)]);
  assert.deepEqual([row(mix, 'th_guard').needed, row(mix, 'th_guard').toMake], [Math.ceil((xp10ForLevel(55) - xp10ForLevel(50)) / 468), Math.ceil(rest / 468)]);
  assert.deepEqual([row(mix, 'th_guard').econ.net, row(mix, 'th_stall_silk').econ.net], [30, 40]);
  // a bank is never looked at
  assert.equal(planGoal(th, { bank: { lockpick: 5, coins: 100000 }, currentXp10: 0, targetXp10: 1000, fillGroup: 'NPCs' }).fromBank.steps.length, 0);
});

// ── Agility (v2.8) ────────────────────────────────────────────────────────
// Courses and shortcuts are LostHQ's Agility calculator's, checked against the
// server's scripts when the data is built. The Agility Arena is one row, a
// ticket: the XP on the way to it, and what it's exchanged for.
const agAll = METHODS.filter(m => m.skill === 'agility');
const ag = indexMethods(agAll);
const TIERS = [[1000, 3_200_000], [100, 280_000], [25, 65_000], [10, 24_800], [1, 2_400]];

test("agility: LostHQ's courses and shortcuts, with the server's own where they differ (v2.8)", () => {
  assert.deepEqual([...new Set(ag.train.map(m => m.group))], ['Courses', 'Shortcuts', 'Agility Arena']);
  assert.deepEqual(rowsOf(ag, 'Courses'), [['Gnome Stronghold course', 1, 86.5], ['Barbarian Outpost course', 35, 139.5], ['Wilderness course', 52, 571.4]]);
  assert.deepEqual(rowsOf(ag, 'Shortcuts'), [['A wooden log (Karamja)', 1, 4], ['Stepping stones (Karamja)', 1, 3], ['Crumbling wall (Falador)', 5, 12.5], ['Climbing rocks (Yanille)', 5, 25],
    ['Ropeswing (Brimhaven)', 10, 3], ['Monkeybars (Edgeville Dungeon)', 15, 20], ['Climbing rocks (Watchtower)', 18, 31], ['Log balance (Coal Trucks)', 20, 8.5],
    ['Balancing ledge (Yanille Dungeon)', 40, 22.5], ['Obstacle pipe (Yanille Dungeon)', 49, 7.5], ['Monkeybars (Yanille Dungeon)', 57, 20], ['Pile of rubble (Yanille Dungeon)', 67, 5.5]]);
  assert.equal(ag.methods.length, 18);                       // (v2.10: the arena has a third row)
  assert.equal(BANK_GROUPS.agility, undefined, 'no bank tab');
  assert.ok(agAll.every(m => Object.keys(m.in).length === 0 && Object.keys(m.out).length === 0), 'nothing goes in and nothing comes out: nothing to price');
  // a course is counted in laps: its obstacles in order and the bonus for the lap
  const lap = id => ag.byId.get(id);
  assert.deepEqual(lap('ag_gnome').parts, [['obstacles', 475], ['lap bonus', 390]]);
  assert.deepEqual(lap('ag_barbarian').parts, [['obstacles', 975], ['lap bonus', 420]], 'three crumbling walls, 12.5 XP each');
  assert.deepEqual(lap('ag_wilderness').parts, [['obstacles', 725], ['lap bonus', 4989]]);
  for (const m of ag.train.filter(x => x.group === 'Courses')) {
    assert.equal(m.parts.reduce((a, [, xp]) => a + xp, 0), m.xp, m.id);
    assert.deepEqual([m.unit, m.units, m.as], ['lap', 'laps', [`lap of the ${m.name}`, `laps of the ${m.name}`]], m.id);
  }
  // where the server and the calculator differ, the row says so
  assert.match(lap('ag_barbarian').note, /^7 obstacles in order, 3 of them crumbling walls, and the bonus for finishing the lap\. LostHQ's calculator counts one wall: 114\.5 XP\. The pipe into the course is 10 XP more, once a visit\.$/);
  assert.match(lap('ag_wilderness').note, /The ridge at its gate is 15 XP more each way, once a visit: LostHQ's calculator counts it in every lap \(586\.4 XP\)\.$/);
  assert.equal(lap('ag_wall_falador').note, "LostHQ's calculator says 0.5 XP; the server gives 12.5, the same as a wall of the Barbarian Outpost course.");
  assert.match(lap('ag_stones_karamja').note, /LostHQ's calculator says level 30; the server asks for none\.$/);
  // and what only the server has
  assert.deepEqual(ag.train.filter(m => /Not on LostHQ's calculator/.test(m.note || '')).map(m => m.id), ['ag_rocks_watchtower', 'ag_ledge_yanille', 'ag_pipe_yanille', 'ag_rubble_yanille']);
  // the ones you can slip on say how often they work; a slip can still give a little
  assert.deepEqual(ag.train.filter(m => m.odds).map(m => [m.id, ...m.odds[0]]), [['ag_log_karamja', 90, 250], ['ag_stones_karamja', 50, 253], ['ag_ledge_yanille', 65, 355], ['ag_bars_yanille', 36, 330]]);
  assert.match(lap('ag_log_karamja').note, /^A slip still gives 2 XP\./);
  assert.equal(sureLevel([65, 355], 40), 66, 'the Yanille ledge never fails from 66');
});

test('agility: nothing picked, a plan runs laps of the best course; the others are yours to pick (v2.8)', () => {
  const at = (level, more = {}) => planGoal(ag, { currentXp10: xp10ForLevel(level), targetXp10: xp10ForLevel(level) + 1000, useBank: false, fillGroup: 'Courses', ...more });
  const picks = [];
  for (let l = 1; l <= 99; l++) { const id = at(l).fill.id; if (picks[picks.length - 1]?.[1] !== id) picks.push([l, id]); }
  assert.deepEqual(picks, [[1, 'ag_gnome'], [35, 'ag_barbarian'], [52, 'ag_wilderness']]);
  // from level 30 to 60, picking the Wilderness course: the courses below it on the way
  const plan = planGoal(ag, { currentXp10: xp10ForLevel(30), targetXp10: xp10ForLevel(60), useBank: false, fillGroup: 'Courses', fillId: 'ag_wilderness' });
  assert.deepEqual(plan.fill.segments.map(s => [s.id, s.toLevel]), [['ag_gnome', 35], ['ag_barbarian', 52], ['ag_wilderness', undefined]]);
  const gnome = Math.ceil((xp10ForLevel(35) - xp10ForLevel(30)) / 865);
  assert.deepEqual([plan.fill.segments[0].runs, plan.fill.segments[0].made, plan.fill.buy], [gnome, {}, {}]);
  // a shortcut is counted one at a time
  assert.deepEqual(at(20, { fillId: 'ag_rocks_watchtower' }).fill.segments.map(s => [s.id, s.runs]), [['ag_rocks_watchtower', 4]]);
  // nothing has a price: every row nets nothing, whatever the prices say
  for (const r of at(60, { priceOf: () => 1000 }).table) assert.deepEqual([r.econ.net, r.econ.cost, r.econ.value], [0, 0, 0], r.id);
});

test('agility: Arena tickets are exchanged in batches, worth more the bigger they are (v2.8)', () => {
  const ticket = ag.byId.get('ag_ticket'), held = ag.byId.get('ag_ticket_held');
  assert.deepEqual(ticket.exchange, { own: 578, batches: TIERS });
  assert.deepEqual(held.exchange, { own: 0, batches: TIERS });
  assert.deepEqual([ticket.xp, ticket.parts, held.xp, held.aside, ticket.icon, ITEMS.agilityarena_ticket.untradeable], [2978, [['on the way', 578], ['exchanged', 2400]], 2400, 1, 'agilityarena_ticket', 1]);
  assert.match(ticket.note, /^A pillar's ticket, earned and exchanged for XP\. On average 3\.3 obstacles lie between one ticket pillar and the next: 57\.8 XP on the way\..*A pillar a minute at best.*Going in costs 200 coins\.$/);
  // the biggest batches they fill
  assert.deepEqual([1, 9, 10, 24, 25, 99, 100, 999, 1000, 1666, 2000].map(n => exchangeXp(TIERS, n)), [2400, 21_600, 24_800, 59_200, 65_000, 254_200, 280_000, 2_774_200, 3_200_000, 5_049_200, 6_400_000]);
  assert.deepEqual(exchangeBatches(TIERS, 1666), [[1000, 1], [100, 6], [25, 2], [10, 1], [1, 6]]);
  assert.deepEqual(exchangeBatches(TIERS, 0), []);
  assert.deepEqual([exchangeXp(TIERS, 0), exchangeXp(TIERS, -5), exchangeXp(TIERS, 10.9)], [0, 0, 24_800]);
  // that is the most any way of splitting them gives, and one more ticket never gives less
  const best = [0];
  for (let n = 1; n <= 2600; n++) best[n] = Math.max(...TIERS.filter(([size]) => size <= n).map(([size, xp]) => best[n - size] + xp));
  for (let n = 1; n <= 2600; n++) {
    assert.equal(exchangeXp(TIERS, n), best[n], `${n} tickets`);
    assert.ok(best[n] >= best[n - 1] + 2400, `${n} tickets`);
  }
  // 999 fall well short of what 1,000 give
  assert.equal(exchangeXp(TIERS, 1000) - exchangeXp(TIERS, 999), 425_800);
});

test("agility: the arena's three rows are named for what their XP is: all of it, the ticket's, the pillar's (v2.10)", () => {
  const arena = ag.train.filter(m => m.group === 'Agility Arena');
  assert.deepEqual(arena.map(m => [m.id, m.name, m.xp, !!m.aside]), [['ag_ticket', 'Total XP', 2978, false], ['ag_ticket_held', 'XP per ticket', 2400, true], ['ag_pillar', 'XP per pillar', 578, true]]);
  // (the ids of the first two are what they were, so a goal saved with one still has it)
  const pillar = ag.byId.get('ag_pillar');
  // Total XP is the other two together, at every batch's rate
  assert.equal(pillar.xp + ag.byId.get('ag_ticket_held').xp, ag.byId.get('ag_ticket').xp);
  for (const id of ['x1000', 'x100', 'x25', 'x10', 'x1']) {
    const pinned = indexMethods(agAll, { opts: [id] });
    assert.equal(pinned.byId.get('ag_pillar').xp + pinned.byId.get('ag_ticket_held').xp, pinned.byId.get('ag_ticket').xp, id);
    assert.equal(pinned.byId.get('ag_pillar').xp, 578, 'the way to a pillar gives what it gives, whatever its ticket goes on');
  }
  // the pillar alone: nothing to exchange, so nothing is pooled or pinned, and it's the icon and the note of the others
  assert.deepEqual([pillar.exchange, pillar.opt, pillar.parts, pillar.icon, pillar.level, pillar.in, pillar.out], [undefined, undefined, undefined, 'agilityarena_ticket', 1, {}, {}]);
  assert.match(pillar.note, /^Getting to a pillar alone: for when its ticket goes on herbs or another reward instead of XP\. On average 3\.3 obstacles lie between one ticket pillar and the next: 57\.8 XP on the way\./);
  assert.equal(averaged(ag, { currentXp10: 0, targetXp10: 1_000_000, fillId: 'ag_pillar' }).pool.counted, false, 'its tickets are kept: none in the plan to exchange');
  // a plan's lines say what they are
  assert.deepEqual(arena.map(m => m.as), [['Agility Arena ticket earned and exchanged', 'Agility Arena tickets earned and exchanged'],
    ['Agility Arena ticket exchanged', 'Agility Arena tickets exchanged'], ['Agility Arena pillar, its ticket kept', 'Agility Arena pillars, their tickets kept']]);
  assert.ok(arena.every(m => !m.unit), 'counted one at a time');
  // picked, it's planned like any other row: 578 tenths a pillar
  const plan = planGoal(ag, { currentXp10: 1_366_940, targetXp10: xp10ForLevel(70), useBank: false, fillGroup: 'Courses', fillId: 'ag_pillar' });
  assert.deepEqual(plan.fill.segments, [{ id: 'ag_pillar', runs: Math.ceil((xp10ForLevel(70) - 1_366_940) / 578), xp10: Math.ceil((xp10ForLevel(70) - 1_366_940) / 578) * 578, made: {} }]);
  // never what a plan picks by itself: with no usual group to go by, the best XP that isn't set aside
  assert.equal(planGoal(ag, { currentXp10: 0, targetXp10: 1000, useBank: false }).fill.id, 'ag_ticket');
  // in a mix beside tickets that are exchanged: only those are pooled
  const av = averaged(ag, { currentXp10: 0, targetXp10: 5_000_000, mix: { ag_pillar: 500, ag_ticket_held: 100 } });
  assert.deepEqual([av.pool.tickets, av.pool.batches, av.set.ag_pillar], [100, [[100, 1]], undefined]);
});

test('agility: a plan exchanges its tickets together, and counts each at the average of that (v2.8)', () => {
  const cur = 1_366_940, lvl70 = xp10ForLevel(70);            // level 53, as Old Badger is in the browser checks
  const plan = (goal, more = {}) => {
    const av = averaged(ag, { currentXp10: cur, targetXp10: lvl70, ...goal });
    const index = indexMethods(agAll, { set: av.set });
    return { av, index, plan: planGoal(index, { currentXp10: cur, targetXp10: lvl70, useBank: false, fillGroup: 'Courses', least: av.least, ...goal, ...more }) };
  };
  // the whole goal in tickets: the fewest that reach it, exchanged as 1 × 1,000, 6 × 100, 2 × 25, 1 × 10 and 6 singly
  const toGo = lvl70 - cur;
  const all = plan({ fillId: 'ag_ticket' });
  assert.deepEqual(all.av.pool, { tickets: 1666, each: 3031, batches: [[1000, 1], [100, 6], [25, 2], [10, 1], [1, 6]], counted: true, spare: 1666 * 578 + 5_049_200 - toGo });
  assert.ok(1666 * 578 + exchangeXp(TIERS, 1666) >= toGo && 1665 * 578 + exchangeXp(TIERS, 1665) < toGo, '1,666 is the fewest');
  assert.deepEqual(all.av.set, { ag_ticket: { xp: 3609, parts: [['on the way', 578], ['exchanged', 3031]] }, ag_ticket_held: { xp: 3031 } });
  assert.deepEqual(all.plan.fill.segments, [{ id: 'ag_ticket', runs: 1666, xp10: 1666 * 3609, made: {} }]);
  assert.ok(all.plan.fill.segments[0].xp10 >= toGo, 'rounded up to a tenth: never short of the goal');
  assert.equal(row(all.plan, 'ag_ticket').needed, 1666);
  assert.equal(all.index.exchanges, true);
  // not picked: its row in the table says what picking it would come to
  const none = plan({});
  assert.deepEqual([none.av.pool.counted, none.av.set.ag_ticket.xp, none.plan.fill.id, row(none.plan, 'ag_ticket').needed], [false, 3609, 'ag_wilderness', 1666]);
  // a goal just past what 999 tickets give takes the whole 1,000, and says how much that is over
  const edge = { targetXp10: cur + 999 * 578 + exchangeXp(TIERS, 999) + 10 };
  const whole = averaged(ag, { currentXp10: cur, fillId: 'ag_ticket', ...edge });
  assert.deepEqual([whole.pool.tickets, whole.pool.each, whole.pool.batches, whole.least, whole.pool.spare], [1000, 3200, [[1000, 1]], { ag_ticket: 1000 }, 1000 * 578 + 3_200_000 - (edge.targetXp10 - cur)]);
  const wholePlan = planGoal(indexMethods(agAll, { set: whole.set }), { currentXp10: cur, ...edge, useBank: false, fillGroup: 'Courses', fillId: 'ag_ticket', least: whole.least });
  assert.deepEqual([wholePlan.fill.segments[0].runs, wholePlan.fill.segments[0].xp10], [1000, 3_778_000], 'the average alone would say 888');
  assert.equal(Math.ceil((edge.targetXp10 - cur) / 3778), 888);
  // tickets you already have are in your mix, and are exchanged with the ones still to earn
  const saved = plan({ fillId: 'ag_ticket', mix: { ag_ticket_held: 600, ag_wilderness: 100 } });
  assert.deepEqual([saved.av.pool.tickets, saved.av.pool.batches, saved.av.pool.each, saved.av.least], [1600, [[1000, 1], [100, 6]], 3050, { ag_ticket: 1000 }]);
  assert.deepEqual(saved.plan.fromMix.steps.map(s => [s.id, s.runs, s.xp10]), [['ag_ticket_held', 600, 600 * 3050], ['ag_wilderness', 100, 571_400]]);
  assert.deepEqual([saved.plan.fill.segments[0].runs, saved.plan.fill.segments[0].xp10, row(saved.plan, 'ag_ticket').toMake], [1000, 1000 * 3628, 1000]);
  assert.ok(saved.plan.afterXp10 + saved.plan.fill.segments[0].xp10 >= lvl70);
  // tickets in a mix that's finished with a course: only those are exchanged
  const some = plan({ mix: { ag_ticket: 250 } });
  assert.deepEqual([some.av.pool.tickets, some.av.pool.batches, some.av.pool.each, some.av.least, some.av.pool.counted], [250, [[100, 2], [25, 2]], 2760, {}, true]);
  assert.deepEqual([some.plan.fromMix.steps[0].xp10, some.plan.fill.id], [250 * (578 + 2760), 'ag_wilderness']);
  // their average is rounded down to a tenth there, never up: 1,666 give 303.07 XP each, and counted at 303.1 the
  // laps after them could come out one short
  const just = { currentXp10: cur, targetXp10: cur + exchangeXp(TIERS, 1666) + 10 * 5714 + 100, mix: { ag_ticket_held: 1666 } };
  const under = averaged(ag, just);
  assert.deepEqual([under.pool.each, under.least, under.pool.spare, under.pool.counted], [3030, {}, 0, true]);
  const laps = planGoal(indexMethods(agAll, { set: under.set }), { ...just, useBank: false, fillGroup: 'Courses', least: under.least });
  assert.deepEqual([laps.fromMix.xp10, laps.fill.segments.map(s => [s.id, s.runs])], [1666 * 3030, [['ag_wilderness', 11]]], '10 laps would leave it 10 XP short');
  // 950 saved and a goal the 1,000 they'll make covers: at 320 each the mix alone looks like enough, and the
  // 50 that fill the batch are planned all the same (999 would be exchanged for far less)
  const near = { currentXp10: cur, targetXp10: cur + 3_000_000, fillId: 'ag_ticket', mix: { ag_ticket_held: 950 } };
  const fillUp = averaged(ag, near);
  assert.deepEqual([fillUp.pool.tickets, fillUp.pool.each, fillUp.least], [1000, 3200, { ag_ticket: 50 }]);
  assert.ok(exchangeXp(TIERS, 950) < 3_000_000 && 49 * 578 + exchangeXp(TIERS, 999) < 3_000_000);
  const fillPlan = planGoal(indexMethods(agAll, { set: fillUp.set }), { ...near, useBank: false, fillGroup: 'Courses', least: fillUp.least });
  assert.deepEqual([fillPlan.fromMix.xp10, fillPlan.fromMix.reached, fillPlan.remaining], [950 * 3200, true, 0]);
  assert.deepEqual(fillPlan.fill.segments, [{ id: 'ag_ticket', runs: 50, xp10: 50 * 3778, made: {} }]);
  assert.deepEqual([row(fillPlan, 'ag_ticket').toMake, row(fillPlan, 'ag_wilderness').toMake], [50, 0]);
  // (without tickets nothing is ever added to a goal the XP so far reaches)
  assert.equal(planGoal(ag, { currentXp10: cur, targetXp10: cur + 1000, useBank: false, fillGroup: 'Courses', mix: { ag_wilderness: 1 } }).fill, null);
  // a mix that already reaches the goal leaves nothing to add
  const done = averaged(ag, { currentXp10: cur, targetXp10: cur + 100_000, fillId: 'ag_ticket', mix: { ag_ticket: 40 } });
  assert.deepEqual([done.pool.tickets, done.least, done.pool.spare], [40, {}, 0]);
  // a goal already reached, and a skill with no tickets
  assert.deepEqual(averaged(ag, { currentXp10: cur, targetXp10: cur }).pool, { tickets: 0, each: 2400, batches: [], counted: false, spare: 0 });
  assert.equal(averaged(th, { currentXp10: 0, targetXp10: 1000 }), null);
  assert.equal(th.exchanges, false);
  // whatever the goal, the fewest tickets are exactly the ones that reach it
  let seed = 28;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 400; i++) {
    const need = 1 + rand(i % 4 ? 1_500_000 : 40_000_000), have = i % 3 ? 0 : rand(1500);
    const av = averaged(ag, { currentXp10: 0, targetXp10: need, fillId: 'ag_ticket', mix: have ? { ag_ticket_held: have } : null });
    const n = av.least.ag_ticket || 0, total = k => k * 578 + exchangeXp(TIERS, have + k);
    assert.ok(total(n) >= need && (n === 0 || total(n - 1) < need), `${need} XP with ${have} saved: ${n} more`);
    const p = planGoal(indexMethods(agAll, { set: av.set }), { currentXp10: 0, targetXp10: need, useBank: false, fillId: 'ag_ticket', mix: have ? { ag_ticket_held: have } : null, least: av.least });
    assert.equal(p.fill ? p.fill.segments[0].runs : 0, n, `${need} XP with ${have} saved`);
    assert.ok((p.fromMix?.xp10 || 0) + (p.fill?.segments[0].xp10 || 0) >= need);
  }
  // and with saved tickets finished with laps, what the tickets really give and the laps come to the goal
  for (let i = 0; i < 300; i++) {
    const have = 1 + rand(2600), given = exchangeXp(TIERS, have), goal = { currentXp10: cur, targetXp10: cur + given + 1 + rand(400_000), mix: { ag_ticket_held: have } };
    const av = averaged(ag, goal);
    const p = planGoal(indexMethods(agAll, { set: av.set }), { ...goal, useBank: false, fillGroup: 'Courses', least: av.least });
    assert.deepEqual([av.least, p.fill.id], [{}, 'ag_wilderness']);
    assert.ok(p.fromMix.xp10 <= given && given - p.fromMix.xp10 < have, `${have} saved: counted at no more than they give`);
    assert.ok(cur + given + p.fill.segments[0].xp10 >= goal.targetXp10, `${have} saved: the laps make up the rest`);
  }
});

test('agility: or every ticket at one batch\'s rate, a choice on the goal (v2.8)', () => {
  assert.deepEqual(CHOICES.agility.map(c => [c.id, c.label, c.options.map(o => [o.id, o.name])]), [['tickets', 'Tickets exchanged',
    [['best', 'In the biggest batches'], ['x1000', '1,000 at a time'], ['x100', '100 at a time'], ['x25', '25 at a time'], ['x10', '10 at a time'], ['x1', 'One at a time']]]]);
  assert.match(CHOICES.agility[0].tip, /240 XP for one, 248 XP each for 10, 260 XP each for 25, 280 XP each for 100, 320 XP each for 1,000\./);
  assert.deepEqual(choicesInUse({ skill: 'agility', opts: { tickets: 'x1000' } }), ['x1000']);
  assert.deepEqual(choicesInUse({ skill: 'agility', opts: { tickets: 'best' } }), [], 'the first is how it starts');
  assert.deepEqual(choicesInUse({ skill: 'agility' }), []);
  const rate = { x1000: 3200, x100: 2800, x25: 2600, x10: 2480, x1: 2400 };
  for (const [id, each] of Object.entries(rate)) {
    const pinned = indexMethods(agAll, { opts: [id] });
    assert.deepEqual([pinned.byId.get('ag_ticket').xp, pinned.byId.get('ag_ticket').parts, pinned.byId.get('ag_ticket_held').xp], [578 + each, [['on the way', 578], ['exchanged', each]], each], id);
    assert.equal(pinned.exchanges, false, 'nothing is pooled');
    assert.equal(averaged(pinned, { currentXp10: 0, targetXp10: 1_000_000, fillId: 'ag_ticket' }), null);
  }
  // saving up for 1,000: every ticket at 377.8 XP, the goal's size aside
  const pinned = indexMethods(agAll, { opts: ['x1000'] });
  const plan = planGoal(pinned, { currentXp10: 1_366_940, targetXp10: xp10ForLevel(70), useBank: false, fillGroup: 'Courses', fillId: 'ag_ticket' });
  assert.deepEqual(plan.fill.segments, [{ id: 'ag_ticket', runs: 1591, xp10: 1591 * 3778, made: {} }]);
  // the other rows are what they were
  assert.deepEqual(pinned.train.filter(m => !m.opt).map(m => m.xp), ag.train.filter(m => !m.opt).map(m => m.xp));
});

test('what only Thieving and Agility name is not what a bank is for (v2.8)', () => {
  // every item of the ten skills before them is still in the catalog, with the bank tabs as they were
  assert.deepEqual(Object.keys(BANK_GROUPS), ['herblore', 'runecraft', 'firemaking', 'fletching', 'crafting', 'smithing', 'cooking', 'prayer', 'magic']);      // (v2.9: Prayer and Magic have one)
  const banked = new Set(Object.values(BANK_GROUPS).flatMap(gs => gs.flatMap(g => g.items)));
  for (const k of ['silk', 'grey_wolf_fur', 'king_worm', 'lockpick', 'agilityarena_ticket', 'coins_25', 'rockcake']) assert.ok(ITEMS[k] && !banked.has(k), k);
  assert.ok(ITEMS.agilityarena_ticket.untradeable && ITEMS.rockcake.untradeable);
});

// ── Prayer (v2.9) ─────────────────────────────────────────────────────────
// Bones, buried from the bank like Firemaking's logs. The rows are LostHQ's
// Prayer calculator's, checked against the server when the data is built.
const pr = indexMethods(METHODS.filter(m => m.skill === 'prayer'));

test("prayer: LostHQ's bones, and the two the server has besides (v2.9)", () => {
  assert.deepEqual(rowsOf(pr, 'Bones'), [['Bones', 1, 4.5], ['Burnt bones', 1, 4.5], ['Bat bones', 1, 4.5], ['Wolf bones', 1, 4.5], ['Monkey bones', 1, 5],
    ['Big bones', 1, 15], ['Jogre bones', 1, 15], ['Shaikahan bones', 1, 25], ['Babydragon bones', 1, 30], ['Dragon bones', 1, 72]]);
  assert.equal(pr.methods.length, 10);
  assert.deepEqual(BANK_GROUPS.prayer, [{ name: 'Bones', items: ['bones', 'bones_burnt', 'bat_bones', 'wolf_bones', 'mm_normal_monkey_bones', 'big_bones', 'tbwt_jogre_bones', 'tbwt_beast_bones', 'babydragon_bones', 'dragon_bones'] }]);
  // a bone goes in and nothing comes out
  for (const m of pr.train) assert.deepEqual([m.kind, Object.values(m.in), m.out, m.id], ['xp', [1], {}, `pr_${Object.keys(m.in)[0]}`], m.id);
  // what only the server has says so
  assert.deepEqual(pr.train.filter(m => m.note).map(m => [m.id, m.note]), [
    ['pr_mm_normal_monkey_bones', "Dropped by the monkeys of Karamja. Not on LostHQ's calculator: the server's own XP."],
    ['pr_tbwt_beast_bones', "Dropped by the Shaikahan, east of Tai Bwo Wannai. Not on LostHQ's calculator: the server's own XP."]]);
  for (const k of BANK_GROUPS.prayer[0].items) assert.ok(ITEMS[k] && !ITEMS[k].untradeable, k);
  assert.equal(CHOICES.prayer, undefined);
});

test("prayer: a bank's bones are buried, the best first, and a plan carries on with what the bank mostly had (v2.9)", () => {
  const at = { currentXp10: xp10ForLevel(56), targetXp10: xp10ForLevel(60) };
  const plan = planGoal(pr, { ...at, bank: { dragon_bones: 120, big_bones: 900, bones: 40 } });
  assert.deepEqual(plan.fromBank.steps.map(s => [s.id, s.runs, s.xp10]), [['pr_dragon_bones', 120, 86_400], ['pr_big_bones', 900, 135_000], ['pr_bones', 40, 1_800]]);
  assert.deepEqual([plan.fromBank.xp10, plan.fromBank.endLevel, plan.fromBank.leftover.have('big_bones')], [223_200, 57, 0]);
  assert.deepEqual([plan.fill.id, plan.fill.segments[0].runs, plan.fill.buy], ['pr_big_bones', 4493, { big_bones: 4493 }]);
  assert.equal(Math.ceil((xp10ForLevel(60) - xp10ForLevel(56) - 223_200) / 150), 4493);
  // with nothing in the bank, the most XP a bone gives
  const empty = planGoal(pr, { ...at, bank: {} });
  assert.deepEqual([empty.fromBank.steps, empty.fill.id, empty.fill.segments[0].runs], [[], 'pr_dragon_bones', 1246]);
  // your own pick goes first, and the rest of the bank after it
  assert.deepEqual(planGoal(pr, { ...at, bank: { dragon_bones: 120, bones: 40 }, fillId: 'pr_bones' }).fromBank.steps.map(s => s.id), ['pr_bones', 'pr_dragon_bones']);
  // a bone costs what it costs: nothing comes back
  assert.deepEqual(methodEconomics(pr, pr.byId.get('pr_dragon_bones'), k => ({ dragon_bones: 2500 })[k] ?? null), { inputs: { dragon_bones: 1 }, cost: 2500, value: 0, missing: [], net: -2500, gpPerXp: 2500 / 72 });
  // one thing in, so there's nothing to round up
  assert.ok(pr.train.every(m => Object.keys(m.in).length === 1));
});

// ── Magic (v2.9) ──────────────────────────────────────────────────────────
// The rows are LostHQ's Magic calculator's, grouped by how you train with them
// and checked against the server's spell tables when the data is built. They
// stand on their own: nothing is shared with the Crafting and Smithing rows
// that cast the same spells on the way.
// (v2.10: besides the spells, what they're cast on can be made on the way from
// a bank: mgMade, Crafting's rows as sources. mgAll is the spells.)
const mgRows = METHODS.filter(m => m.skill === 'magic');
const mgAll = mgRows.filter(m => m.kind === 'xp');
const mgMade = mgRows.filter(m => m.kind !== 'xp');
const mg = indexMethods(mgRows);
const RUNES = { airrune: 10_000, firerune: 5000, chaosrune: 3000, naturerune: 2000, lawrune: 1000, cosmicrune: 100, waterrune: 800 };
const MG = { currentXp10: xp10ForLevel(50), targetXp10: xp10ForLevel(60), fillGroup: 'Combat', minor: minorOf('magic') };
const bankSteps = plan => plan.fromBank.steps.map(s => [s.id, s.runs]);

test("magic: LostHQ's spells by how you train with them, with the server's numbers where they differ (v2.9)", () => {
  assert.deepEqual([...new Set(mg.train.map(m => m.group))], ['Combat', 'Curses', 'Utility', 'Enchantment', 'Teleports']);
  assert.deepEqual(rowsOf(mg, 'Combat'), [['Wind Strike', 1, 5.5], ['Water Strike', 5, 7.5], ['Earth Strike', 9, 9.5], ['Fire Strike', 13, 11.5], ['Wind Bolt', 17, 13.5], ['Water Bolt', 23, 16.5],
    ['Earth Bolt', 29, 19.5], ['Fire Bolt', 35, 22.5], ['Crumble Undead', 39, 49], ['Wind Blast', 41, 25.5], ['Water Blast', 47, 28.5], ['Iban Blast', 50, 30], ['Earth Blast', 53, 31.5],
    ['Fire Blast', 59, 34.5], ['Saradomin Strike', 60, 35], ['Claws of Guthix', 60, 35], ['Flames of Zamorak', 60, 35], ['Wind Wave', 62, 36], ['Water Wave', 65, 37.5], ['Earth Wave', 70, 40], ['Fire Wave', 75, 42.5]]);
  assert.deepEqual(rowsOf(mg, 'Curses'), [['Confuse', 3, 13], ['Weaken', 11, 21], ['Curse', 19, 29], ['Bind', 20, 30], ['Snare', 50, 60], ['Vulnerability', 66, 76], ['Enfeeble', 73, 83], ['Entangle', 79, 89], ['Stun', 80, 90]]);
  assert.deepEqual(rowsOf(mg, 'Utility'), [['Bones to Bananas', 15, 25], ['Low Level Alchemy', 21, 31], ['Telekinetic Grab', 33, 43],
    ...['Bronze', 'Iron', 'Silver', 'Steel', 'Gold', 'Mithril', 'Adamantite', 'Runite'].map(b => [`Superheat Item: ${b} bar`, 43, 53]), ['High Level Alchemy', 55, 65], ['Charge', 80, 180]]);
  assert.deepEqual(rowsOf(mg, 'Enchantment'), [['Lvl-1 Enchant: Ring of recoil', 7, 17.5], ['Lvl-1 Enchant: Amulet of magic', 7, 17.5], ['Lvl-1 Enchant: Games necklace(8)', 7, 17.5],
    ['Lvl-2 Enchant: Ring of dueling(8)', 27, 37], ['Lvl-2 Enchant: Amulet of defence', 27, 37], ['Lvl-3 Enchant: Ring of forging', 49, 59], ['Lvl-3 Enchant: Amulet of strength', 49, 59],
    ['Charge Water Orb', 56, 66], ['Lvl-4 Enchant: Ring of life', 57, 67], ['Lvl-4 Enchant: Amulet of power', 57, 67], ['Charge Earth Orb', 60, 70], ['Charge Fire Orb', 63, 73], ['Charge Air Orb', 66, 76],
    ['Lvl-5 Enchant: Ring of wealth', 68, 78], ['Lvl-5 Enchant: Amulet of glory(4)', 68, 78]]);
  assert.deepEqual(rowsOf(mg, 'Teleports'), [['Varrock Teleport', 25, 35], ['Lumbridge Teleport', 31, 41], ['Falador Teleport', 37, 48], ['Camelot Teleport', 45, 55.5],
    ['Ardougne Teleport', 51, 61], ['Watchtower Teleport', 58, 68], ['Trollheim Teleport', 61, 68]]);
  assert.deepEqual([mgAll.length, mg.train.length, mg.methods.length], [65, 65, 86]);      // (v2.10: and 21 made on the way)
  // where the server and the calculator differ, the row says so
  const said = id => mg.byId.get(id).note.match(/LostHQ's calculator says [^;]+; the server gives [\d.]+\./)?.[0];
  assert.deepEqual(Object.fromEntries(mgAll.filter(m => /LostHQ's calculator says/.test(m.note || '')).map(m => [m.id, said(m.id)])), {
    mg_crumble_undead: "LostHQ's calculator says 24.5 XP; the server gives 49.", mg_enfeeble: "LostHQ's calculator says 89 XP; the server gives 83.",
    mg_entangle: "LostHQ's calculator says 90 XP; the server gives 89.", mg_stun: "LostHQ's calculator says 80 XP; the server gives 90.",
    mg_water_orb: "LostHQ's calculator says 56 XP; the server gives 66.", mg_falador_teleport: "LostHQ's calculator says 47 XP; the server gives 48." });
  // and what only the server has
  assert.deepEqual(mgAll.filter(m => /Not on LostHQ's calculator/.test(m.note || '')).map(m => m.id), ['mg_trollheim_teleport']);
  assert.equal(mg.byId.get('mg_trollheim_teleport').note, "Once Eadgar's Ruse is done. Not on LostHQ's calculator: the server's own level and XP.");
  assert.deepEqual(['mg_ardougne_teleport', 'mg_watchtower_teleport'].map(id => mg.byId.get(id).note), ['Once Plague City is done.', 'Once Watchtower is done.']);
});

test("magic: a cast takes the server's runes, and what it's cast on; every row is its own (v2.9)", () => {
  const takes = id => mg.byId.get(id).in, makes = id => mg.byId.get(id).out;
  assert.deepEqual(takes('mg_wind_strike'), { mindrune: 1, airrune: 1 });
  assert.deepEqual(takes('mg_fire_wave'), { bloodrune: 1, firerune: 7, airrune: 5 });
  assert.deepEqual(takes('mg_stun'), { soulrune: 1, waterrune: 12, earthrune: 12 });
  assert.deepEqual(takes('mg_camelot_teleport'), { airrune: 5, lawrune: 1 });
  assert.deepEqual([takes('mg_highlvl_alchemy'), takes('mg_lowlvl_alchemy')], [{ naturerune: 1, firerune: 5 }, { naturerune: 1, firerune: 3 }]);
  assert.deepEqual(takes('mg_charge'), { firerune: 3, bloodrune: 3, airrune: 3 });
  // alchemy counts the runes: what you alch, and its coins, aren't its business
  assert.deepEqual(makes('mg_highlvl_alchemy'), {});
  assert.match(mg.byId.get('mg_highlvl_alchemy').note, /^Any item will do: what you alch, and the coins it turns into \(60% of its shop value\), aren't counted here\.$/);
  assert.match(mg.byId.get('mg_lowlvl_alchemy').note, /\(40% of its shop value\)/);
  // Superheat Item: a row for each bar, the ore in and the bar out. One iron ore: the spell can't fail
  assert.deepEqual([takes('mg_superheat_steel_bar'), makes('mg_superheat_steel_bar')], [{ iron_ore: 1, coal: 2, naturerune: 1, firerune: 4 }, { steel_bar: 1 }]);
  assert.deepEqual([takes('mg_superheat_iron_bar'), makes('mg_superheat_iron_bar')], [{ iron_ore: 1, naturerune: 1, firerune: 4 }, { iron_bar: 1 }]);
  assert.deepEqual(takes('mg_superheat_runite_bar'), { runite_ore: 1, coal: 8, naturerune: 1, firerune: 4 });
  assert.equal(mg.byId.get('mg_superheat_iron_bar').note, "Needs Smithing 15. Never fails: one iron ore is a bar. With 2 coal on you the spell makes a steel bar of it instead. It gives the bar's Smithing XP too, which isn't counted here.");
  assert.equal(mg.byId.get('mg_superheat_bronze_bar').note, "It gives the bar's Smithing XP too, which isn't counted here.");
  // an enchant: a row for each thing it makes. A glory is what it's traded as, charged
  assert.deepEqual([takes('mg_enchant_ring_of_recoil'), makes('mg_enchant_ring_of_recoil')], [{ sapphire_ring: 1, waterrune: 1, cosmicrune: 1 }, { ring_of_recoil: 1 }]);
  assert.deepEqual([takes('mg_enchant_amulet_of_glory_4'), makes('mg_enchant_amulet_of_glory_4')], [{ strung_dragonstone_amulet: 1, earthrune: 15, waterrune: 15, cosmicrune: 1 }, { amulet_of_glory_4: 1 }]);
  assert.equal(mg.byId.get('mg_enchant_amulet_of_glory_4').note, 'Cast on a dragonstone amulet. It comes out uncharged: the Fountain of Heroes charges it for nothing.');
  assert.deepEqual([takes('mg_water_orb'), makes('mg_water_orb')], [{ stafforb: 1, waterrune: 30, cosmicrune: 3 }, { water_orb: 1 }]);
  // nothing here is a Crafting or Smithing row, and those are what they were: the spells they cast on the way are theirs
  assert.ok(mgRows.every(m => m.id.startsWith('mg_') && m.magic == null && !m.feeds && !m.through));
  assert.deepEqual(METHODS.filter(m => m.magic || Object.values(m.opt || {}).some(v => v.magic)).reduce((a, m) => ({ ...a, [m.skill]: (a[m.skill] || 0) + 1 }), {}), { crafting: 15, smithing: 8 });
  assert.equal(cr.byId.get('cr_ench_ring_of_recoil').magic, 175);
  assert.equal(sm.byId.get('sm_steel_bar').opt.superheat.magic, 530);
  // the Bank tab: the runes, then what each kind of spell is cast on and makes
  assert.deepEqual(BANK_GROUPS.magic.map(g => [g.name, g.items.length]), [['Runes', 13], ['Jewellery to enchant', 11], ['Ore to superheat', 9], ['Orbs to charge', 1],
    ['What jewellery and orbs are made of', 18], ['Made: enchanted jewellery', 12], ['Made: bars', 8], ['Made: orbs', 4]]);      // (v2.10: what they're made of)
  assert.deepEqual(BANK_GROUPS.magic[0].items, ['airrune', 'waterrune', 'earthrune', 'firerune', 'mindrune', 'bodyrune', 'cosmicrune', 'chaosrune', 'naturerune', 'lawrune', 'deathrune', 'bloodrune', 'soulrune']);
  const listed = new Set(BANK_GROUPS.magic.flatMap(g => g.items));
  for (const m of mgRows) for (const k of [...Object.keys(m.in), ...Object.keys(m.out)]) assert.ok(listed.has(k), `${m.id}: ${k}`);
});

test('magic: a staff stands in for its rune, a choice on the goal (v2.9)', () => {
  assert.deepEqual(CHOICES.magic.map(c => [c.id, c.label, c.options.map(o => [o.id, o.name])]), [
    ['staff', 'Staff', [['nostaff', 'None'], ['air', 'Air'], ['water', 'Water'], ['earth', 'Earth'], ['fire', 'Fire'], ['lava', 'Lava (earth and fire)']]],
    ['damage', 'Damage', [['nodamage', 'Leave it out'], ['halfdmg', 'Half the casts hit'], ['alldmg', 'Every cast hits']]]]);
  assert.match(CHOICES.magic[0].tip, /a staff of air, an air battlestaff or a mystic air staff for air runes;.*A lava battlestaff or a mystic lava staff for both earth and fire runes\./);
  assert.deepEqual(choicesInUse({ skill: 'magic', opts: { staff: 'lava', damage: 'alldmg' } }), ['lava', 'alldmg']);
  assert.deepEqual(choicesInUse({ skill: 'magic', opts: { staff: 'nostaff', damage: 'nodamage' } }), [], 'the first of each list is how it starts');
  const withStaff = id => indexMethods(mgRows, { opts: [id] });
  const air = withStaff('air'), fire = withStaff('fire'), lava = withStaff('lava');
  // its runes are no longer taken, however many; the staff is named to bring
  assert.deepEqual([air.byId.get('mg_fire_bolt').in, air.byId.get('mg_fire_bolt').tools], [{ chaosrune: 1, firerune: 4 }, ['staff_of_air']]);
  assert.deepEqual([fire.byId.get('mg_highlvl_alchemy').in, fire.byId.get('mg_highlvl_alchemy').tools], [{ naturerune: 1 }, ['staff_of_fire']]);
  assert.deepEqual(air.byId.get('mg_air_orb').in, { stafforb: 1, cosmicrune: 3 }, '30 air runes an orb');
  // a lava staff is two in one
  assert.deepEqual([lava.byId.get('mg_fire_strike').in, lava.byId.get('mg_earth_wave').in, lava.byId.get('mg_enchant_ring_of_life').in, lava.byId.get('mg_fire_strike').tools],
    [{ mindrune: 1, airrune: 2 }, { bloodrune: 1, airrune: 5 }, { diamond_ring: 1, cosmicrune: 1 }, ['lava_battlestaff']]);
  // a spell that takes none of them is what it was
  assert.deepEqual(fire.byId.get('mg_camelot_teleport'), mg.byId.get('mg_camelot_teleport'));
  // a spell cast with a staff of its own has no hand free for another
  assert.deepEqual(mgAll.filter(m => m.tools).map(m => [m.id, m.tools]), [['mg_iban_blast', ['ibanstaff']], ['mg_saradomin_strike', ['saradomin_staff']], ['mg_claws_of_guthix', ['guthix_staff']], ['mg_flames_of_zamorak', ['zamorak_staff']]]);
  for (const m of mgAll.filter(x => x.tools)) assert.deepEqual([air.byId.get(m.id).in, air.byId.get(m.id).tools], [m.in, m.tools], m.id);
  // every spell still takes something: no staff gives a rune a spell has no other rune beside
  for (const ix2 of [air, fire, lava, withStaff('water'), withStaff('earth')]) for (const m of ix2.train) assert.ok(Object.keys(m.in).length > 0 && !gathers(m), m.id);
  // a plan: no air runes to buy, and the staff to bring
  const plan = planGoal(air, { ...MG, bank: RUNES, fillId: 'mg_fire_bolt' });
  assert.deepEqual([bankSteps(plan)[0], Object.keys(plan.fill.buy)], [['mg_fire_bolt', 1250], ['chaosrune', 'firerune']]);
  // (v2.10: and the rest of the bank's runes are cast by themselves, with no air rune to hold them back)
  assert.deepEqual(bankSteps(plan).slice(1), [['mg_camelot_teleport', 1000], ['mg_water_bolt', 400], ['mg_wind_bolt', 1350]]);
  assert.deepEqual(methodEconomics(air, air.byId.get('mg_fire_bolt'), k => ({ chaosrune: 180, firerune: 48, airrune: 48 })[k] ?? null).cost, 180 + 4 * 48);
  assert.deepEqual(methodEconomics(mg, mg.byId.get('mg_fire_bolt'), k => ({ chaosrune: 180, firerune: 48, airrune: 48 })[k] ?? null).cost, 180 + 7 * 48);
});

test("magic: a combat spell's XP is for the cast, hit or miss; damage is a choice on the goal (v2.9)", () => {
  const half = indexMethods(mgRows, { opts: ['halfdmg'] }), every = indexMethods(mgRows, { opts: ['alldmg'] });
  // left out, it's the cast's: the most casts a goal can take, and what LostHQ's calculator shows
  assert.equal(mg.byId.get('mg_fire_strike').xp, 115);
  // every cast hitting: half the max hit on average, 2 XP a point (a Fire Strike's max is 8)
  assert.deepEqual([every.byId.get('mg_fire_strike').xp, every.byId.get('mg_fire_strike').parts], [195, [['the cast', 115], ['damage', 80]]]);
  assert.deepEqual([half.byId.get('mg_fire_strike').xp, half.byId.get('mg_fire_strike').parts], [155, [['the cast', 115], ['damage', 40]]]);
  assert.deepEqual([every.byId.get('mg_fire_wave').xp, every.byId.get('mg_iban_blast').xp, every.byId.get('mg_crumble_undead').xp], [425 + 200, 300 + 250, 490 + 80]);
  // every spell that does damage has it, the two binds that hit too; nothing else changes
  const hits = mgAll.filter(m => m.opt?.alldmg).map(m => m.id);
  assert.deepEqual(hits, [...mgAll.filter(m => m.group === 'Combat').map(m => m.id), 'mg_snare', 'mg_entangle']);
  for (const m of mgAll) {
    const max = Number(m.note?.match(/Max hit (\d+)/)?.[1] || 0);
    assert.equal(every.byId.get(m.id).xp, m.xp + max * 10, m.id);
    assert.equal(half.byId.get(m.id).xp, m.xp + max * 5, m.id);
    assert.deepEqual(every.byId.get(m.id).in, m.in, m.id);
  }
  assert.match(mg.byId.get('mg_fire_bolt').note, /^Max hit 12 \(15 with chaos gauntlets\): every point of damage is 2 XP on top of the cast's\. See Damage on the goal\.$/);
  assert.match(mg.byId.get('mg_crumble_undead').note, /^Only works on skeletons, zombies, ghosts and shades\. Max hit 8:/);
  assert.match(mg.byId.get('mg_saradomin_strike').note, /^Learnt in the Mage Arena, and cast with the staff of Saradomin in hand\. Hits up to 30 for a while after a Charge, with the god's cape worn too\. Max hit 20:/);
  assert.match(mg.byId.get('mg_iban_blast').note, /^Cast with Iban's staff in hand \(from the Underground Pass\): every cast takes one of the staff's charges\. Max hit 25:/);
  assert.match(CHOICES.magic[1].tip, /^A combat spell gives its XP for the cast, hit or miss, and 2 XP more for every point of damage\..*\(a Fire Strike: 11\.5 \+ 8\)/);
  // a curse gives its XP whether it takes hold or not, and can't be cast twice on the same target
  assert.equal(mg.byId.get('mg_curse').note, "Lowers your target's Defence. It can't be cast on one whose Defence is already lowered. The XP is for the cast, whether it takes hold or not.");
  assert.match(mg.byId.get('mg_bind').note, /^Holds your target for 5 seconds\. It can't be cast on one that's already held\./);
  // a goal takes fewer casts with damage counted, and both choices go together with a staff
  const casts = ix2 => planGoal(ix2, { ...MG, bank: {}, fillId: 'mg_fire_blast' }).fill.segments.map(s => [s.id, s.runs]);
  assert.deepEqual([casts(mg), casts(every)], [[['mg_water_blast', 1238], ['mg_earth_blast', 3533], ['mg_fire_blast', 749]], [['mg_water_blast', 830], ['mg_earth_blast', 2394], ['mg_fire_blast', 512]]]);
  assert.equal(Math.ceil((xp10ForLevel(53) - xp10ForLevel(50)) / 285), 1238);
  assert.equal(Math.ceil((xp10ForLevel(53) - xp10ForLevel(50)) / 425), 830);
  const both = indexMethods(mgRows, { opts: ['fire', 'halfdmg'] }).byId.get('mg_fire_bolt');
  assert.deepEqual([both.in, both.xp, both.tools], [{ chaosrune: 1, airrune: 3 }, 285, ['staff_of_fire']]);
});

test('magic: a curse, alchemy and the like wait to be asked: a bank casts one as your pick, or in your order (v2.9, v2.10)', () => {
  // of the 42 spells that take only runes, 22 wait: the curses, alchemy and the odd ones, and whatever needs a quest
  // or a staff of its own. (v2.10: the other 20, the teleports and combat spells anyone can cast, don't: see below.)
  const runesOnly = m => Object.keys(m.in).every(k => /rune$/.test(k));
  assert.equal(mgAll.filter(runesOnly).length, 42);
  for (const m of mgAll) assert.equal(!!m.asked, runesOnly(m) && (!!m.aside || !['Combat', 'Teleports'].includes(m.group)), m.id);
  assert.deepEqual(mgAll.filter(m => m.asked).map(m => m.group).reduce((a, g) => ({ ...a, [g]: (a[g] || 0) + 1 }), {}), { Combat: 5, Curses: 9, Utility: 5, Teleports: 3 });
  assert.deepEqual(mgAll.filter(m => m.asked && ['Combat', 'Teleports'].includes(m.group)).map(m => m.id),
    ['mg_crumble_undead', 'mg_iban_blast', 'mg_saradomin_strike', 'mg_claws_of_guthix', 'mg_flames_of_zamorak', 'mg_ardougne_teleport', 'mg_watchtower_teleport', 'mg_trollheim_teleport']);
  // nature and fire runes: alchemy's, and nothing a bank casts by itself
  const alchOnly = planGoal(mg, { ...MG, bank: { naturerune: 2000, firerune: 5000 } });
  assert.deepEqual([bankSteps(alchOnly), alchOnly.fromBank.xp10], [[], 0]);
  // (it could be cast, as its row says)
  assert.deepEqual(['mg_lowlvl_alchemy', 'mg_highlvl_alchemy'].map(id => row(alchOnly, id).have), [1666, 1000]);
  // the rest of the goal is the best combat spell at your level, and the bank's runes come off what it takes
  assert.deepEqual([alchOnly.fill.id, alchOnly.fill.segments.map(s => s.runs), alchOnly.fill.buy], ['mg_water_blast', [6050], { deathrune: 6050, waterrune: 18_150, airrune: 18_150 }]);
  // blood runes at level 60: a god spell's, which waits for its staff, and Wind Wave's two levels on. Law runes go
  // to Camelot, not to the teleports that wait for a quest
  const gods = planGoal(mg, { ...MG, currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(61), bank: { bloodrune: 500, firerune: 5000, airrune: 5000, lawrune: 100, waterrune: 500, earthrune: 500 } });
  assert.deepEqual([bankSteps(gods), gods.fromBank.leftover.have('bloodrune')], [[['mg_camelot_teleport', 100]], 500]);
  assert.deepEqual(['mg_flames_of_zamorak', 'mg_ardougne_teleport', 'mg_watchtower_teleport'].map(id => row(gods, id).have), [250, 50, 50]);
  // picked, it gets the bank first: as far as the scarcest rune goes. Then the runes it leaves are cast as usual
  const low = planGoal(mg, { ...MG, bank: RUNES, fillId: 'mg_lowlvl_alchemy' });
  assert.deepEqual(bankSteps(low), [['mg_lowlvl_alchemy', 1666], ['mg_camelot_teleport', 1000], ['mg_water_bolt', 400], ['mg_wind_bolt', 2100]]);
  assert.deepEqual([low.fill.segments.map(sg => [sg.id, sg.runs]), low.fill.buy], [[['mg_lowlvl_alchemy', 978]], { naturerune: 644, firerune: 2932 }]);
  // in your own order: cast from the bank, top first
  assert.deepEqual(bankSteps(planGoal(mg, { ...MG, bank: RUNES, order: ['mg_lowlvl_alchemy'] })), bankSteps(low));
  // one above your level waits for it, and the bank's own spells get you there (v2.10): 1,000 Camelot Teleports
  // and 436 Fire Bolts to level 55, then it's cast first
  const alch = planGoal(mg, { ...MG, bank: RUNES, fillId: 'mg_highlvl_alchemy' });
  assert.deepEqual(bankSteps(alch), [['mg_camelot_teleport', 1000], ['mg_fire_bolt', 436], ['mg_highlvl_alchemy', 651], ['mg_water_bolt', 400], ['mg_wind_bolt', 1446]]);
  assert.ok(MG.currentXp10 + 1000 * 555 + 435 * 225 < xp10ForLevel(55) && MG.currentXp10 + 1000 * 555 + 436 * 225 >= xp10ForLevel(55), '436 Fire Bolts reach 55');
  assert.deepEqual([alch.fill.locked, alch.fill.segments.map(sg => [sg.id, sg.runs]), alch.fill.buy, alch.fromBank.endLevel], [false, [['mg_highlvl_alchemy', 595]], { firerune: 2974 }, 58]);
  // unticked, it isn't cast even when asked
  assert.ok(!bankSteps(planGoal(mg, { ...MG, bank: RUNES, order: ['mg_lowlvl_alchemy'], excluded: new Set(['mg_lowlvl_alchemy']) })).some(([id]) => /alchemy/.test(id)));
  // with nothing asked, planBank never tries one as the lead
  assert.deepEqual(planBank(mg, { bank: { naturerune: 2000, firerune: 5000 }, startXp10: MG.currentXp10 }).steps, []);
  assert.deepEqual(planBank(mg, { bank: { naturerune: 2000, firerune: 5000 }, startXp10: MG.currentXp10, prefer: 'mg_lowlvl_alchemy', own: true }).steps.map(st => [st.id, st.runs]), [['mg_lowlvl_alchemy', 1666]]);
});

test("magic: a bank's runes go to teleports and combat spells by themselves, the best its runes and your level allow (v2.10)", () => {
  // law runes: Falador while the water runes last (3 air runes a law rune, where Camelot takes 5), then Camelot.
  // chaos runes: Fire Bolt, the best at level 50, while the fire runes last, then Wind Bolt. Every air rune is spent
  const plan = planGoal(mg, { ...MG, bank: RUNES });
  assert.deepEqual(bankSteps(plan), [['mg_falador_teleport', 800], ['mg_camelot_teleport', 200], ['mg_fire_bolt', 1250], ['mg_wind_bolt', 1425]]);
  assert.deepEqual([plan.fromBank.xp10, plan.fromBank.endLevel], [800 * 480 + 200 * 555 + 1250 * 225 + 1425 * 135, 56]);
  assert.deepEqual(plan.fromBank.leftover.toObject(), { chaosrune: 325, naturerune: 2000, cosmicrune: 100 }, 'the nature runes are alchemy\'s: it waits to be asked');
  assert.equal(800 * 3 + 200 * 5 + 1250 * 3 + 1425 * 2, RUNES.airrune);
  // (it's the most XP the bank holds: Camelot for every law rune would leave the bolts short of air)
  assert.ok(plan.fromBank.xp10 > 1000 * 555 + 1250 * 225 + 625 * 135);
  // the rest of the goal goes back to combat: the best spell at the level the bank leaves you (most of its XP was a teleport's)
  assert.deepEqual([plan.fill.id, plan.fill.segments.map(sg => sg.runs), plan.fill.buy], ['mg_earth_blast', [2399], { deathrune: 2399, earthrune: 9596, airrune: 7197 }]);
  // every rune kind goes to the highest spell it can cast: blood to Wind Wave, death to Fire Blast, chaos to Fire Bolt, mind to Fire Strike
  const tiers = planGoal(mg, { ...MG, currentXp10: xp10ForLevel(62), targetXp10: xp10ForLevel(70), bank: { airrune: 20_000, firerune: 20_000, mindrune: 500, chaosrune: 800, deathrune: 300, bloodrune: 100 } });
  assert.deepEqual(bankSteps(tiers), [['mg_wind_wave', 100], ['mg_fire_blast', 300], ['mg_fire_bolt', 800], ['mg_fire_strike', 500]]);
  // (where a combat spell is most of the bank's XP, the plan carries on with that)
  assert.equal(tiers.fill.id, 'mg_fire_bolt');
  // by your level: at 20 the death and blood runes wait, and the chaos runes are Wind Bolts until Fire Bolt comes at 35
  const young = planGoal(mg, { ...MG, currentXp10: xp10ForLevel(20), targetXp10: xp10ForLevel(40), bank: { airrune: 20_000, firerune: 20_000, mindrune: 500, chaosrune: 800, deathrune: 300, bloodrune: 100, lawrune: 50 } });
  assert.deepEqual([bankSteps(young), young.fromBank.endLevel], [[['mg_fire_strike', 500], ['mg_varrock_teleport', 50], ['mg_wind_bolt', 774], ['mg_fire_bolt', 26]], 35]);
  assert.deepEqual([young.fromBank.leftover.have('deathrune'), young.fromBank.leftover.have('bloodrune'), young.fromBank.leftover.have('chaosrune')], [300, 100, 0]);
  // your pick still goes first, and your own order before anything else
  assert.deepEqual(bankSteps(planGoal(mg, { ...MG, bank: RUNES, fillId: 'mg_fire_bolt' })), [['mg_fire_bolt', 1250], ['mg_camelot_teleport', 1000], ['mg_water_bolt', 400], ['mg_wind_bolt', 225]]);
  const order = planGoal(mg, { ...MG, bank: RUNES, order: ['mg_camelot_teleport', 'mg_wind_bolt'] });
  assert.deepEqual([bankSteps(order), order.fromBank.endLevel, order.fill.id], [[['mg_camelot_teleport', 1000], ['mg_wind_bolt', 2500]], 56, 'mg_earth_blast']);
  const wind = planGoal(mg, { ...MG, bank: RUNES, order: ['mg_wind_bolt'] });
  assert.deepEqual([bankSteps(wind), wind.fill.id], [[['mg_wind_bolt', 3000], ['mg_falador_teleport', 800], ['mg_camelot_teleport', 200]], 'mg_wind_bolt']);
  // unticked, a spell is left out and its runes go to the next best
  assert.deepEqual(bankSteps(planGoal(mg, { ...MG, bank: RUNES, excluded: new Set(['mg_camelot_teleport']) })), [['mg_falador_teleport', 800], ['mg_varrock_teleport', 200], ['mg_fire_bolt', 1200], ['mg_wind_bolt', 1700]]);
  assert.deepEqual(bankSteps(planGoal(mg, { ...MG, bank: RUNES, excluded: new Set(mgAll.filter(m => m.group === 'Teleports').map(m => m.id)) })), [['mg_fire_bolt', 1250], ['mg_water_bolt', 400], ['mg_wind_bolt', 1350]]);
  // a level on the way opens a spell cast on something: only as far as its level, then that first (it shares the air runes)
  const up = planGoal(mg, { ...MG, currentXp10: xp10ForLevel(64), targetXp10: xp10ForLevel(70), bank: { stafforb: 50, cosmicrune: 150, airrune: 20_000, lawrune: 2000 } });
  assert.deepEqual(bankSteps(up), [['mg_camelot_teleport', 1608], ['mg_air_orb', 50], ['mg_camelot_teleport', 392]]);
  assert.equal(Math.ceil((xp10ForLevel(66) - xp10ForLevel(64)) / 555), 1608);
});

test('magic: what you enchant, superheat or charge is planned from a bank by itself, and gets the runes first; iron ore goes to steel while there is coal (v2.9, v2.10)', () => {
  const bank = { ...RUNES, sapphire_ring: 300, iron_ore: 400, coal: 1000 };
  const plan = planGoal(mg, { ...MG, bank });
  // 400 ore and 1,000 coal are 400 steel bars; 100 cosmic runes enchant 100 of the rings. (v2.10: and the runes those
  // leave are cast by themselves. The rings' water runes aren't teleported away first, nor Superheat's fire runes cast as bolts.)
  assert.deepEqual(bankSteps(plan), [['mg_camelot_teleport', 1000], ['mg_superheat_steel_bar', 400], ['mg_fire_bolt', 850], ['mg_enchant_ring_of_recoil', 100], ['mg_water_bolt', 350], ['mg_wind_bolt', 875]]);
  assert.equal(plan.fromBank.xp10, 1000 * 555 + 400 * 530 + 850 * 225 + 100 * 175 + 350 * 165 + 875 * 135);
  assert.deepEqual(plan.fromBank.steps.map(st => st.made), [{}, { steel_bar: 400 }, {}, { ring_of_recoil: 100 }, {}, {}]);
  assert.equal(850 * 4 + 400 * 4, RUNES.firerune, 'the fire runes Superheat leaves');
  assert.equal(100 + 350 * 2, RUNES.waterrune, 'the water runes the rings leave');
  // after: the spells cast on something that share a rune with it. It waits while one of them can be cast
  const after = id => mg.byId.get(id).after;
  assert.deepEqual(after('mg_camelot_teleport'), ['mg_enchant_ring_of_dueling_8', 'mg_enchant_amulet_of_defence', 'mg_air_orb'], 'air runes');
  assert.deepEqual(after('mg_wind_strike'), after('mg_camelot_teleport'));
  assert.deepEqual(after('mg_falador_teleport').filter(id => !after('mg_camelot_teleport').includes(id)),
    ['mg_enchant_ring_of_recoil', 'mg_enchant_amulet_of_magic', 'mg_enchant_necklace_of_minigames_8', 'mg_water_orb', 'mg_enchant_ring_of_wealth', 'mg_enchant_amulet_of_glory_4'], 'and water runes');
  for (const m of mgAll) {
    const runesOnly = Object.keys(m.in).every(k => /rune$/.test(k));
    if (m.id === 'mg_superheat_iron_bar') continue;                       // (its own: below)
    assert.equal(!!m.after, runesOnly && !m.asked, m.id);
    for (const id of m.after || []) {
      const first = mg.byId.get(id);
      assert.ok(!Object.keys(first.in).every(k => /rune$/.test(k)) && Object.keys(first.in).some(k => /rune$/.test(k) && m.in[k]), `${m.id} after ${id}`);
    }
  }
  assert.deepEqual(mg.byId.get('mg_superheat_iron_bar').after, ['mg_superheat_steel_bar']);
  // with coal for 50, the other 350 are iron bars
  assert.deepEqual(bankSteps(planGoal(mg, { ...MG, bank: { ...RUNES, iron_ore: 400, coal: 100 } })).filter(([id]) => /superheat/.test(id)), [['mg_superheat_steel_bar', 50], ['mg_superheat_iron_bar', 350]]);
  // and the spell you train with is cast before any of it: Fire Bolt takes the fire runes, and none are left to superheat with
  const bolt = planGoal(mg, { ...MG, bank, fillId: 'mg_fire_bolt' });
  assert.deepEqual(bankSteps(bolt), [['mg_fire_bolt', 1250], ['mg_camelot_teleport', 1000], ['mg_enchant_ring_of_recoil', 100], ['mg_water_bolt', 350], ['mg_wind_bolt', 275]]);
  // an orb is charged where there are orbs
  assert.deepEqual(bankSteps(planGoal(mg, { ...MG, currentXp10: xp10ForLevel(66), targetXp10: xp10ForLevel(70), bank: { stafforb: 20, airrune: 10_000, cosmicrune: 100 } })), [['mg_air_orb', 20]]);
  // a row's worth: what comes out, less what goes in
  const price = k => ({ sapphire_ring: 900, ring_of_recoil: 1500, waterrune: 20, cosmicrune: 150 })[k] ?? null;
  assert.deepEqual(methodEconomics(mg, mg.byId.get('mg_enchant_ring_of_recoil'), price), { inputs: { sapphire_ring: 1, waterrune: 1, cosmicrune: 1 }, cost: 1070, value: 1500, missing: [], net: 430, gpPerXp: -430 / 17.5 });
});

test("magic: jewellery and orbs are made on the way from what a bank holds, where the Crafting level allows (v2.10)", () => {
  // Crafting's rows that lead to something a spell is cast on, as sources: made from the bank, never bought, no Magic XP
  assert.deepEqual(mgMade.map(m => [m.id, m.craft]), [['mg_made_sapphire_ring', 20], ['mg_made_sapphire_necklace', 20], ['mg_made_strung_sapphire_amulet', 24], ['mg_made_emerald_ring', 27],
    ['mg_made_strung_emerald_amulet', 31], ['mg_made_ruby_ring', 34], ['mg_made_diamond_ring', 43], ['mg_made_strung_ruby_amulet', 50], ['mg_made_dragonstone_ring', 55],
    ['mg_made_strung_diamond_amulet', 70], ['mg_made_strung_dragonstone_amulet', 80], ['mg_made_stafforb', 46], ['mg_made_ball_of_wool', 1], ['mg_made_sapphire', 20], ['mg_made_emerald', 27],
    ['mg_made_ruby', 34], ['mg_made_diamond', 43], ['mg_made_dragonstone', 55], ['mg_made_molten_glass', 1], ['mg_made_crystal_chest', 1], ['mg_made_join_keys', 1]]);
  for (const m of mgMade) {
    const from = cr.byId.get(m.id.replace('mg_made_', 'cr_'));
    assert.deepEqual([m.kind, m.xp, m.level, m.in, m.out, m.craft, m.gives?.crafting ?? 0, m.tools, m.name], ['source', 0, 1, from.in, from.out, from.level, from.xp, from.tools, from.name], m.id);
  }
  assert.ok(mgMade.every(m => !mg.train.includes(m)), 'not what you train with: no row in the table');
  // every non-rune thing an enchant or a Charge Orb takes can be made that way; ore is Smithing's, and isn't
  const makes = new Set(mgMade.flatMap(m => Object.keys(m.out)));
  for (const m of mgAll.filter(x => x.group === 'Enchantment')) for (const k of Object.keys(m.in)) assert.ok(/rune$/.test(k) || makes.has(k), `${m.id}: ${k}`);
  assert.ok(!makes.has('iron_ore') && !makes.has('gold_bar'));
  // gold bars, gems and cosmic runes: the gems are cut, set in rings, and the rings enchanted
  const mats = { gold_bar: 300, uncut_sapphire: 200, sapphire: 50, cosmicrune: 500, waterrune: 500, molten_glass: 100, airrune: 5000 };
  const plan = planGoal(mg, { ...MG, bank: mats });
  assert.deepEqual(plan.fromBank.steps, [{ id: 'mg_enchant_ring_of_recoil', runs: 250, xp10: 250 * 175, sub: { mg_made_sapphire: 200, mg_made_sapphire_ring: 250 }, made: { ring_of_recoil: 250 } }]);
  assert.deepEqual(plan.fromBank.used, { gold_bar: 250, uncut_sapphire: 200, sapphire: 50, cosmicrune: 250, waterrune: 250 });
  assert.deepEqual(['mg_enchant_ring_of_recoil', 'mg_enchant_necklace_of_minigames_8', 'mg_air_orb'].map(id => row(plan, id).have), [250, 250, 100], 'each on its own');
  // what the rest of a goal takes is bought as the thing itself: a list says the ring, not the gold bar
  const rest = planGoal(mg, { ...MG, bank: mats, fillId: 'mg_enchant_ring_of_recoil' });
  assert.deepEqual([rest.fill.segments.map(sg => [sg.id, sg.runs]), Object.keys(rest.fill.buy)], [[['mg_enchant_ring_of_recoil', 9602]], ['sapphire_ring', 'waterrune', 'cosmicrune']]);
  assert.deepEqual(methodEconomics(mg, mg.byId.get('mg_enchant_ring_of_recoil'), () => 10).inputs, { sapphire_ring: 1, waterrune: 1, cosmicrune: 1 });
  // the Crafting level decides what can be made: the page leaves out the rows above the account's (craft)
  const at = level => indexMethods(mgRows.filter(m => !(m.craft > level)));
  assert.deepEqual(bankSteps(planGoal(at(19), { ...MG, bank: mats })), [], 'a sapphire is cut at 20');
  assert.deepEqual(bankSteps(planGoal(at(20), { ...MG, bank: mats })), [['mg_enchant_ring_of_recoil', 250]]);
  // molten glass is blown into orbs at 46, and charged at Magic 66: 3 cosmic runes and 30 air runes each
  const high = { ...MG, currentXp10: xp10ForLevel(66), targetXp10: xp10ForLevel(70), bank: mats };
  assert.deepEqual(bankSteps(planGoal(at(45), high)), [['mg_enchant_ring_of_recoil', 250]]);
  const orbs = planGoal(at(46), high);
  assert.deepEqual(orbs.fromBank.steps.map(st => [st.id, st.runs, st.sub]), [['mg_air_orb', 100, { mg_made_stafforb: 100 }], ['mg_enchant_ring_of_recoil', 200, { mg_made_sapphire: 150, mg_made_sapphire_ring: 200 }]]);
  assert.equal(100 * 3 + 200, mats.cosmicrune, 'every cosmic rune is counted');
  // key halves are joined, the chest opened, its dragonstone cut and set: six rings of wealth from 4 loops, 9 teeth and 2 keys
  const keys = planGoal(mg, { ...MG, currentXp10: xp10ForLevel(68), targetXp10: xp10ForLevel(75), bank: { keyhalf1: 9, keyhalf2: 4, crystal_key: 2, gold_bar: 50, cosmicrune: 100, waterrune: 1000, earthrune: 1000 } });
  assert.deepEqual(keys.fromBank.steps.map(st => [st.id, st.runs, st.sub]), [['mg_enchant_ring_of_wealth', 6, { mg_made_join_keys: 4, mg_made_crystal_chest: 6, mg_made_dragonstone: 6, mg_made_dragonstone_ring: 6 }]]);
  // an amulet is strung with a ball of wool, spun on the way: wool finishes it, and never holds rounding up back
  assert.ok(minorOf('magic').has('ball_of_wool'));
  const amulets = planGoal(mg, { ...MG, bank: { gold_bar: 10, sapphire: 10, wool: 4, ball_of_wool: 2, cosmicrune: 50, waterrune: 50 }, excluded: new Set(['mg_enchant_ring_of_recoil', 'mg_enchant_necklace_of_minigames_8']) });
  assert.deepEqual(amulets.fromBank.steps.map(st => [st.id, st.runs, st.sub]), [['mg_enchant_amulet_of_magic', 6, { mg_made_ball_of_wool: 4, mg_made_strung_sapphire_amulet: 6 }]]);
  // Magic's rows are its own: Crafting's are what they were, and a Crafting plan doesn't see these
  assert.ok(cr.methods.every(m => !m.id.startsWith('mg_')) && mgRows.every(m => m.skill === 'magic'));
});

test('magic: rounding up: runes never hold an enchant back, and a spell that only takes runes goes as far as its most plentiful one (v2.9, v2.10)', () => {
  assert.deepEqual([...minorOf('magic')].sort(), [...BANK_GROUPS.magic[0].items, 'ball_of_wool'].sort(), 'every rune, and the wool an amulet is strung with (v2.10)');
  const bank = { ...RUNES, sapphire_ring: 300, iron_ore: 400, coal: 1000 };
  // your pick first, rounded up to the air runes (10,000 are 3,333 Fire Bolts): the chaos and fire runes it's short of are collected
  const bolt = planGoal(mg, { ...MG, bank: RUNES, fillId: 'mg_fire_bolt', roundUp: true });
  assert.deepEqual(bolt.fromBank.steps.map(st => [st.id, st.runs, st.collect]), [['mg_fire_bolt', 3333, { chaosrune: 333, firerune: 8332 }]]);
  assert.deepEqual([bolt.fromBank.collect, bolt.fill.segments[0].runs, bolt.fill.buy], [{ chaosrune: 333, firerune: 8332 }, 4330, { chaosrune: 4330, firerune: 17_320, airrune: 12_989 }]);
  // the bank as it is, for comparison, is in bankNow
  assert.deepEqual(bolt.bankNow.steps.map(st => [st.id, st.runs]), [['mg_fire_bolt', 1250], ['mg_camelot_teleport', 1000], ['mg_water_bolt', 400], ['mg_wind_bolt', 225]]);
  // what's cast on something: every ring is enchanted, the 200 cosmic runes short collected; spare runes call for no more rings
  const rings = planGoal(mg, { ...MG, bank, roundUp: true });
  assert.deepEqual(rings.fromBank.steps.map(st => [st.id, st.runs, !!st.rounded, st.collect]), [
    ['mg_camelot_teleport', 1000, false, undefined], ['mg_superheat_steel_bar', 400, false, undefined], ['mg_fire_bolt', 850, false, undefined],
    ['mg_enchant_ring_of_recoil', 300, false, { cosmicrune: 200 }], ['mg_water_bolt', 250, false, undefined], ['mg_wind_bolt', 975, false, undefined],
    ['mg_superheat_steel_bar', 100, true, { iron_ore: 100, firerune: 400 }]]);                    // (the 200 coal left over: one thing short)
  assert.ok(!rings.fromBank.steps.some(st => /enchant_(?!ring_of_recoil)/.test(st.id)), 'no emerald rings bought for the air runes');
  // (v2.10) a spell the bank casts by itself goes as far as the bank's runes and no further: spare runes alone don't
  // call for more runes. 325 chaos runes are left, and no fire or air runes are collected to cast them with
  const runes = planGoal(mg, { ...MG, bank: RUNES, roundUp: true });
  assert.deepEqual(runes.fromBank.steps.map(st => [st.id, st.runs, !!st.rounded, st.collect]), planGoal(mg, { ...MG, bank: RUNES }).fromBank.steps.map(st => [st.id, st.runs, false, undefined]));
  assert.deepEqual([runes.fromBank.collect, runes.fromBank.leftover.have('chaosrune')], [{}, 325]);
  // (once the rounding up is done, it's cast as usual again: the 999 bars rounded up take Magic from 61 to 62, where
  // the bank's blood runes are Wind Waves. Nothing is collected for those)
  const unlocked = planGoal(mg, { ...MG, fillGroup: null, currentXp10: xp10ForLevel(61), targetXp10: xp10ForLevel(70), roundUp: true,
    bank: { mithril_ore: 1000, coal: 4, naturerune: 1, firerune: 4, bloodrune: 100, airrune: 5000 } });
  assert.deepEqual(unlocked.fromBank.steps.map(st => [st.id, st.runs, !!st.rounded, st.collect]), [['mg_superheat_mithril_bar', 1, false, undefined],
    ['mg_superheat_mithril_bar', 999, true, { coal: 3996, firerune: 3996, naturerune: 999 }], ['mg_wind_wave', 100, true, undefined]]);
  assert.deepEqual([unlocked.bankNow.endLevel, unlocked.fromBank.endLevel, unlocked.fromBank.leftover.toObject()], [61, 62, { airrune: 4500, mithril_bar: 1000 }]);
  // the table's Round up column says the same of each row on its own
  assert.deepEqual(row(bolt, 'mg_fire_bolt').balance, { runs: 3333, collect: { chaosrune: 333, firerune: 8332 } });
  assert.deepEqual(row(rings, 'mg_enchant_ring_of_recoil').balance, { runs: 300, collect: { cosmicrune: 200 } });
  assert.equal(row(rings, 'mg_enchant_ring_of_dueling_8').balance, null, 'nothing to round up to');
  // gold bars with too few gems: the rings are rounded up to the bars, and the gems short of that collected
  const short = planGoal(mg, { ...MG, bank: { gold_bar: 300, sapphire: 250, cosmicrune: 500, waterrune: 500 }, roundUp: true, excluded: new Set(['mg_enchant_necklace_of_minigames_8']) });
  assert.deepEqual(short.fromBank.steps.map(st => [st.id, st.runs, !!st.rounded, st.collect, st.sub]).slice(0, 2), [
    ['mg_enchant_ring_of_recoil', 250, false, undefined, { mg_made_sapphire_ring: 250 }], ['mg_enchant_ring_of_recoil', 50, true, { sapphire: 50 }, { mg_made_sapphire_ring: 50 }]]);
});

test('magic: nothing picked, a plan finishes with the best combat spell; what waits for a quest, a staff or a target is yours to pick (v2.9)', () => {
  const at = (level, more = {}) => planGoal(mg, { currentXp10: xp10ForLevel(level), targetXp10: xp10ForLevel(level) + 100, bank: {}, fillGroup: 'Combat', ...more });
  const picks = [];
  for (let l = 1; l <= 99; l++) { const id = at(l).fill.id; if (picks[picks.length - 1]?.[1] !== id) picks.push([l, id]); }
  assert.deepEqual(picks, [[1, 'mg_wind_strike'], [5, 'mg_water_strike'], [9, 'mg_earth_strike'], [13, 'mg_fire_strike'], [17, 'mg_wind_bolt'], [23, 'mg_water_bolt'], [29, 'mg_earth_bolt'], [35, 'mg_fire_bolt'],
    [41, 'mg_wind_blast'], [47, 'mg_water_blast'], [53, 'mg_earth_blast'], [59, 'mg_fire_blast'], [62, 'mg_wind_wave'], [65, 'mg_water_wave'], [70, 'mg_earth_wave'], [75, 'mg_fire_wave']]);
  assert.deepEqual(mgAll.filter(m => m.aside).map(m => m.id), ['mg_crumble_undead', 'mg_iban_blast', 'mg_saradomin_strike', 'mg_claws_of_guthix', 'mg_flames_of_zamorak', 'mg_bones_to_bananas', 'mg_telekinetic_grab',
    ...['bronze', 'iron', 'silver', 'steel', 'gold', 'mithril', 'adamantite', 'runite'].map(b => `mg_superheat_${b}_bar`), 'mg_charge', 'mg_water_orb', 'mg_earth_orb', 'mg_fire_orb', 'mg_air_orb',
    'mg_ardougne_teleport', 'mg_watchtower_teleport', 'mg_trollheim_teleport']);
  // picked, they're planned like any other
  assert.deepEqual(at(60, { fillId: 'mg_crumble_undead' }).fill.segments.map(s => [s.id, s.runs]), [['mg_crumble_undead', 1]]);
  // a spell above your level: the spells of its own kind on the way, the best at each level, and none that's set aside
  const wave = planGoal(mg, { currentXp10: xp10ForLevel(50), targetXp10: xp10ForLevel(80), bank: {}, fillGroup: 'Combat', fillId: 'mg_fire_wave' });
  assert.deepEqual(wave.fill.segments.map(s => [s.id, s.toLevel]), [['mg_water_blast', 53], ['mg_earth_blast', 59], ['mg_fire_blast', 62], ['mg_wind_wave', 65], ['mg_water_wave', 70], ['mg_earth_wave', 75], ['mg_fire_wave', undefined]]);
  const glory = planGoal(mg, { currentXp10: xp10ForLevel(50), targetXp10: xp10ForLevel(70), bank: {}, fillGroup: 'Combat', fillId: 'mg_enchant_amulet_of_glory_4' });
  assert.deepEqual(glory.fill.segments.map(s => [s.id, s.toLevel]), [['mg_enchant_ring_of_forging', 57], ['mg_enchant_ring_of_life', 68], ['mg_enchant_amulet_of_glory_4', undefined]], 'no orbs on the way');
  const tele = planGoal(mg, { currentXp10: xp10ForLevel(40), targetXp10: xp10ForLevel(65), bank: {}, fillGroup: 'Combat', fillId: 'mg_trollheim_teleport' });
  assert.deepEqual(tele.fill.segments.map(s => [s.id, s.toLevel]), [['mg_falador_teleport', 45], ['mg_camelot_teleport', 61], ['mg_trollheim_teleport', undefined]], 'no teleport that waits for a quest');
});

test('a method takes less when a choice says so, and one that takes nothing but loose supplies is held to them (v2.9)', () => {
  // less: what a choice takes away; with in and add, in that order
  const spell = { id: 'x', skill: 't', group: 'G', kind: 'xp', name: 'X', level: 1, xp: 100, in: { a: 2, b: 1 }, out: {}, asked: 1,
    opt: { noA: { less: ['a'], tools: ['staff'] }, other: { in: { c: 1, a: 5 } }, plus: { add: { d: 1 } } } };
  const takes = opts => indexMethods([spell], { opts }).byId.get('x').in;
  assert.deepEqual([takes(['noA']), takes(['other', 'noA']), takes(['noA', 'plus']), takes(['noA', 'other'])], [{ b: 1 }, { c: 1 }, { b: 1, d: 1 }, { c: 1, a: 5 }]);
  assert.deepEqual(indexMethods([spell], { opts: ['noA'] }).byId.get('x').tools, ['staff']);
  assert.deepEqual(spell.in, { a: 2, b: 1 }, 'the data is left as it is');
  // asked: only as your pick or in your order. An item spell beside it is made by itself
  const ring = { id: 'r', skill: 't', group: 'G', kind: 'xp', name: 'R', level: 1, xp: 50, in: { ring: 1, a: 1 }, out: { done: 1 } };
  const ix2 = indexMethods([spell, ring]);
  const run = more => planBank(ix2, { bank: { a: 100, b: 10, ring: 30 }, startXp10: 0, ...more }).steps.map(s => [s.id, s.runs]);
  assert.deepEqual([run({}), run({ prefer: 'x', own: true }), run({ order: ['x'] })], [[['r', 30]], [['x', 10], ['r', 30]], [['x', 10], ['r', 30]]]);
  // rounding up with a and b as the cheap supplies: the ring is never held back by a, and x, which takes nothing else, goes by what's there of them
  const minor = new Set(['a', 'b']);
  const rounded = planGoal(ix2, { bank: { a: 100, b: 10, ring: 300 }, currentXp10: 0, targetXp10: 10_000_000, fillId: 'x', roundUp: true, minor });
  assert.deepEqual(rounded.fromBank.steps.map(s => [s.id, s.runs, s.collect]), [['x', 50, { b: 40 }], ['r', 300, { a: 300 }]], 'x: 100 of a are 50, with 40 more b');
  assert.ok(Number.isFinite(rounded.fromBank.xp10) && rounded.fromBank.xp10 === 50 * 100 + 300 * 50);
});

// ── Combat (v2.10) ────────────────────────────────────────────────────────
// Attack, Strength, Defence, Hitpoints and Ranged are trained on monsters: a
// row is a monster, counted in kills. A kill is the monster's hitpoints in
// damage, and what a point of damage gives is the server's own sum for the
// style. The monsters are the server's NPCs you can attack that are in the
// world; the rows are made in gamedata.js from MONSTERS and COMBAT_STYLES.
const KILLS = ['attack', 'strength', 'defence', 'hitpoints', 'ranged'];
const PREFIX = { attack: 'at', strength: 'st', defence: 'df', hitpoints: 'hp', ranged: 'rg' };
const fight = Object.fromEntries(KILLS.map(k => [k, indexMethods(METHODS.filter(m => m.skill === k))]));
const monster = id => MONSTERS.find(m => m.id === id);

test("combat: the monsters are the server's, each once, in bands of combat level (v2.10)", () => {
  assert.equal(MONSTERS.length, 315);
  assert.equal(new Set(MONSTERS.map(m => m.id)).size, MONSTERS.length);
  // by combat level, then name, then hitpoints
  for (let i = 1; i < MONSTERS.length; i++) {
    const a = MONSTERS[i - 1], b = MONSTERS[i];
    assert.ok(a.level < b.level || (a.level === b.level && (a.name.localeCompare(b.name) < 0 || (a.name === b.name && a.hp < b.hp))), `${a.id} before ${b.id}`);
  }
  assert.deepEqual(MONSTERS.reduce((a, m) => ({ ...a, [m.group]: (a[m.group] || 0) + 1 }), {}),
    { 'Level 1–10': 58, 'Level 11–20': 48, 'Level 21–30': 49, 'Level 31–50': 67, 'Level 51–80': 44, 'Level 81–110': 30, 'Level 111 and up': 19 });
  for (const m of MONSTERS) {
    const [lo, hi] = m.group === 'Level 111 and up' ? [111, Infinity] : m.group.match(/\d+/g).map(Number);
    assert.ok(m.level >= lo && m.level <= hi && m.hp > 0 && m.n >= 1 && Number.isInteger(m.hp) && Number.isInteger(m.n), m.id);
  }
  // the ones everybody knows: name, combat level, hitpoints, how many the world has, what they leave to bury
  const known = id => { const m = monster(id); return [m.name, m.level, m.hp, m.n, m.bones || null]; };
  assert.deepEqual(known('chicken_1'), ['Chicken', 1, 3, 65, 'bones']);
  assert.deepEqual(known('cow_2'), ['Cow', 2, 8, 52, 'bones']);
  assert.deepEqual(known('al_kharid_warrior_9'), ['Al-Kharid warrior', 9, 19, 9, 'bones']);
  assert.deepEqual(known('giant_28'), ['Giant', 28, 35, 27, 'big_bones']);
  assert.deepEqual(known('moss_giant_42'), ['Moss giant', 42, 60, 22, 'big_bones']);
  assert.deepEqual(known('lesser_demon_82'), ['Lesser demon', 82, 79, 34, null]);
  assert.deepEqual(known('fire_giant_86'), ['Fire giant', 86, 111, 15, 'big_bones']);
  assert.deepEqual(known('blue_dragon_111'), ['Blue dragon', 111, 105, 10, 'dragon_bones']);
  assert.deepEqual(known('king_black_dragon_276'), ['King black dragon', 276, 240, 1, 'dragon_bones']);
  // what turns up by turning into it is counted by what it was: 15 rocks and 19 small ones are 34 rock crabs
  assert.deepEqual(known('rock_crab_13'), ['Rock Crab', 13, 50, 34, null]);
  assert.deepEqual([monster('wolfman_88').n, monster('wolfwoman_88').n, monster('man_24').n, monster('woman_24').n], [13, 7, 13, 7], 'the werewolves are the citizens of Canifis');
  assert.equal(monster('kalphite_queen_333').n, 1, 'her two forms are one queen');
  // where the server and LostHQ's data differ, the server's: two skeletons whose level and hitpoints LostHQ has swapped
  assert.deepEqual([known('skeleton_21').slice(1, 3), known('skeleton_25').slice(1, 3)], [[21, 24], [25, 17]]);
  // the same name and level with different hitpoints: the id says which, and so does the row's name
  assert.deepEqual(MONSTERS.filter(m => m.twin).map(m => m.id), ['blood_blamish_snail_20_10', 'blood_blamish_snail_20_13', 'bruise_blamish_snail_20_12', 'bruise_blamish_snail_20_15', 'guard_37_40', 'guard_37_50']);
  for (const m of MONSTERS) assert.equal(m.id, `${m.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${m.level}${m.twin ? `_${m.hp}` : ''}`, m.id);
  // what they leave is something Prayer buries, or nothing
  const buried = new Set(pr.train.map(m => Object.keys(m.in)[0]));
  for (const m of MONSTERS) assert.ok(m.bones === undefined || buried.has(m.bones), m.id);
  assert.deepEqual(MONSTERS.reduce((a, m) => ({ ...a, [m.bones || 'none']: (a[m.bones || 'none'] || 0) + 1 }), {}),
    { bones: 200, none: 67, mm_normal_monkey_bones: 1, bat_bones: 2, wolf_bones: 11, big_bones: 26, babydragon_bones: 1, tbwt_jogre_bones: 1, dragon_bones: 5, tbwt_beast_bones: 1 });
});

test('combat: a monster with a catch says so, and is not what a plan picks by itself (v2.10)', () => {
  // a shadow of Mort'ton is its shade: only the shade has a row, which says so
  assert.ok(!MONSTERS.some(m => / Shadow$/.test(m.name)));
  assert.deepEqual(MONSTERS.filter(m => / Shade$/.test(m.name)).map(m => [m.name, m.level, m.hp, m.n, m.note]), [
    ['Loar Shade', 40, 38, 25, 'A Loar Shadow until you attack it, or it attacks you.'], ['Phrin Shade', 60, 56, 12, 'A Phrin Shadow until you attack it, or it attacks you.'],
    ['Riyl Shade', 80, 76, 16, 'A Riyl Shadow until you attack it, or it attacks you.'], ['Asyn Shade', 100, 90, 29, 'An Asyn Shadow until you attack it, or it attacks you.'],
    ['Fiyr Shade', 120, 110, 8, 'A Fiyr Shadow until you attack it, or it attacks you.']]);
  // a citizen of Canifis, a ghast, the Mage Arena's battle mages
  assert.equal(monster('man_24').note, 'A citizen of Canifis: your first hit turns it into a Wolfman (level 88, 100 hitpoints), unless you wield a Wolfbane dagger.');
  assert.equal(monster('woman_24').note, 'A citizen of Canifis: your first hit turns it into a Wolfwoman (level 88, 100 hitpoints), unless you wield a Wolfbane dagger.');
  assert.equal(monster('ghast_30').note, 'In Mort Myre: one has to be made visible with a druid pouch before you can attack it.');
  assert.deepEqual([monster('battle_mage_54').magic, monster('battle_mage_54').note], [1, "In the Mage Arena, once you've beaten Kolodion there. He allows only magical combat within it: no melee, no Ranged."]);
  assert.deepEqual(MONSTERS.filter(m => m.magic).map(m => m.id), ['battle_mage_54']);
  // a foe the server only lets you attack at some point of its quest
  assert.deepEqual(MONSTERS.filter(m => m.note === 'Its quest decides when you can attack it.').map(m => m.id),
    ['wormbrain_2', 'lucien_14', 'grip_22', 'delrith_27', 'temple_guardian_30', 'mercenary_captain_47', 'gorad_68', 'general_khazard_112']);
  // an XP rule of its own
  assert.deepEqual(MONSTERS.filter(m => m.mult != null || m.flat).map(m => [m.id, m.mult, m.flat, m.note]), [
    ['black_knight_titan_120', undefined, 1, 'The server gives 1 XP a point of damage for it, whatever your style (and Hitpoints XP as usual).'],
    ['chronozon_170', 25, undefined, 'The server gives 2.5% of the usual XP for it.']]);
  // kept standing by a script, not the map
  assert.deepEqual(MONSTERS.filter(m => /Ranging Guild|Taverley/.test(m.note || '')).map(m => [m.id, m.n]), [['suit_of_armour_19', 2], ['tower_archer_19', 6], ['tower_archer_34', 6], ['tower_archer_49', 6], ['tower_archer_64', 6]]);
  // aside: fewer than five in the world, a catch, or an XP rule of its own. 120 of the 315
  const catches = new Set(['man_24', 'woman_24', 'ghast_30', 'battle_mage_54']);
  for (const m of MONSTERS) assert.equal(!!m.aside, m.n < 5 || catches.has(m.id) || m.mult != null || !!m.flat || m.note === 'Its quest decides when you can attack it.', m.id);
  assert.deepEqual([MONSTERS.filter(m => m.aside).length, MONSTERS.filter(m => m.n < 5).length, MONSTERS.filter(m => m.n === 1).length], [120, 116, 76]);
  // (a shade, or a tower archer, is as good as any other)
  assert.ok(!monster('loar_shade_40').aside && !monster('tower_archer_34').aside && !monster('rock_crab_13').aside);
});

test("combat: what a point of damage gives is the server's sum for the style, and a kill is the monster's hitpoints of it (v2.10)", () => {
  assert.deepEqual(COMBAT_STYLES, {
    attack: [{ id: 'accurate', name: 'Accurate', gives: { attack: 400, hitpoints: 133 } }, { id: 'controlled', name: 'Controlled', gives: { attack: 133, strength: 133, defence: 133, hitpoints: 133 } }],
    strength: [{ id: 'aggressive', name: 'Aggressive', gives: { strength: 400, hitpoints: 133 } }, { id: 'controlled', name: 'Controlled', gives: { attack: 133, strength: 133, defence: 133, hitpoints: 133 } }],
    defence: [{ id: 'defensive', name: 'Defensive', gives: { defence: 400, hitpoints: 133 } }, { id: 'controlled', name: 'Controlled', gives: { attack: 133, strength: 133, defence: 133, hitpoints: 133 } },
      { id: 'longrange', name: 'Longrange (Ranged)', gives: { ranged: 200, defence: 200, hitpoints: 133 } }],
    hitpoints: [{ id: 'any', name: 'Any', gives: { hitpoints: 133 } }],
    ranged: [{ id: 'rapid', name: 'Accurate or Rapid', gives: { ranged: 400, hitpoints: 133 } }, { id: 'longrange', name: 'Longrange', gives: { ranged: 200, defence: 200, hitpoints: 133 } }],
  });
  // a row a monster in each of the five skills; the battle mages, which only Magic can hit, in Hitpoints alone
  assert.deepEqual(KILLS.map(k => fight[k].train.length), [314, 314, 314, 315, 314]);
  assert.deepEqual(KILLS.map(k => fight[k].methods.length), [314, 314, 314, 315, 314], 'nothing but monsters');
  assert.ok(KILLS.every(k => hasCalculator(k)));
  assert.ok(fight.hitpoints.byId.has('hp_battle_mage_54') && !fight.attack.byId.has('at_battle_mage_54') && !fight.ranged.byId.has('rg_battle_mage_54'));
  // a giant has 35 hitpoints: 140 XP in the skill its style trains, 46.5 Hitpoints XP (35 x 1.33, down to a tenth)
  const giant = fight.attack.byId.get('at_giant_28');
  assert.deepEqual(giant, { id: 'at_giant_28', skill: 'attack', group: 'Level 21–30', kind: 'xp', name: 'Giant (level 28)', short: 'Giant', level: 1, xp: 1400, gives: { hitpoints: 465 }, in: {}, out: {},
    cb: 28, hp: 35, n: 27, opt: { controlled: { xp: 465, gives: { strength: 465, defence: 465, hitpoints: 465 } } }, bones: 'big_bones' });
  assert.deepEqual(fight.defence.byId.get('df_giant_28').opt, { controlled: { xp: 465, gives: { attack: 465, strength: 465, hitpoints: 465 } }, longrange: { xp: 700, gives: { ranged: 700, hitpoints: 465 } } });
  assert.deepEqual([fight.ranged.byId.get('rg_giant_28').xp, fight.ranged.byId.get('rg_giant_28').opt], [1400, { longrange: { xp: 700, gives: { defence: 700, hitpoints: 465 } } }]);
  assert.deepEqual([fight.hitpoints.byId.get('hp_giant_28').xp, fight.hitpoints.byId.get('hp_giant_28').gives, fight.hitpoints.byId.get('hp_giant_28').opt], [465, {}, undefined]);
  // every row, from the monster and the style: the server's scale(rate, 100, damage x 10), then its multiplier
  const kill = (mon, skill, rate) => Math.floor((Math.floor((mon.hp * (mon.flat && skill !== 'hitpoints' ? 100 : rate)) / 10) * (mon.mult ?? 1000)) / 1000);
  let rows = 0;
  for (const skill of KILLS) {
    const [first, ...others] = COMBAT_STYLES[skill];
    for (const mon of MONSTERS) {
      const m = fight[skill].byId.get(`${PREFIX[skill]}_${mon.id}`);
      if (mon.magic && skill !== 'hitpoints') { assert.equal(m, undefined); continue; }
      rows++;
      const of = st => ({ xp: kill(mon, skill, st.gives[skill]), gives: Object.fromEntries(Object.entries(st.gives).filter(([k]) => k !== skill).map(([k, rate]) => [k, kill(mon, k, rate)])) });
      assert.deepEqual([m.xp, m.gives, m.opt], [of(first).xp, of(first).gives, others.length ? Object.fromEntries(others.map(st => [st.id, of(st)])) : undefined], m.id);
      assert.deepEqual([m.skill, m.group, m.kind, m.level, m.in, m.out, m.cb, m.hp, m.n, m.short, m.bones, m.aside, m.note], [skill, mon.group, 'xp', 1, {}, {}, mon.level, mon.hp, mon.n, mon.name, mon.bones, mon.aside, mon.note], m.id);
      assert.equal(m.name, `${mon.name} (level ${mon.level}${mon.twin ? `, ${mon.hp} hitpoints` : ''})`);
      // at 4 XP a point it's exact; at 1.33 never more than a tenth under
      if (!mon.mult && !mon.flat) assert.ok(m.xp === mon.hp * 40 || (m.xp <= mon.hp * 13.3 && m.xp > mon.hp * 13.3 - 1), m.id);
    }
  }
  assert.equal(rows, 314 * 4 + 315);
  assert.equal(METHODS.filter(m => KILLS.includes(m.skill)).length, rows);
  assert.equal(new Set(METHODS.map(m => m.id)).size, METHODS.length, 'every row has an id of its own');
  // the Black Knight Titan: 1 XP a point of damage whatever the style, Hitpoints as usual (142 hitpoints)
  const titan = id => fight[id.startsWith('df') ? 'defence' : id.startsWith('hp') ? 'hitpoints' : 'ranged'].byId.get(id);
  assert.deepEqual([titan('df_black_knight_titan_120').xp, titan('df_black_knight_titan_120').gives, titan('df_black_knight_titan_120').opt],
    [1420, { hitpoints: 1888 }, { controlled: { xp: 1420, gives: { attack: 1420, strength: 1420, hitpoints: 1888 } }, longrange: { xp: 1420, gives: { ranged: 1420, hitpoints: 1888 } } }]);
  assert.equal(titan('hp_black_knight_titan_120').xp, 1888);
  // Chronozon: a fortieth of the usual (60 hitpoints: 6 XP, not 240)
  assert.deepEqual([fight.strength.byId.get('st_chronozon_170').xp, fight.strength.byId.get('st_chronozon_170').gives], [60, { hitpoints: 19 }]);
  // nothing goes in and nothing comes out: no bank tab, nothing to price
  for (const k of KILLS) assert.equal(BANK_GROUPS[k], undefined, k);
  // a goal picks the style: the first is how it starts
  assert.deepEqual(KILLS.map(k => (CHOICES[k] || []).map(c => [c.id, c.label, c.options.map(o => o.id)])), [
    [['style', 'Style', ['accurate', 'controlled']]], [['style', 'Style', ['aggressive', 'controlled']]], [['style', 'Style', ['defensive', 'controlled', 'longrange']]], [], [['style', 'Style', ['rapid', 'longrange']]]]);
  assert.match(CHOICES.defence[0].tip, /^Every point of damage gives XP by the style you fight in\. Defensive: 4 Defence XP\. Controlled: 1\.33 XP each to Attack, Strength and Defence\. Longrange \(Ranged\): 2 XP each to Ranged and Defence\. Whatever the style, a point of damage is 1\.33 Hitpoints XP as well\./);
  assert.deepEqual(choicesInUse({ skill: 'attack', opts: { style: 'controlled' } }), ['controlled']);
  assert.deepEqual(choicesInUse({ skill: 'attack', opts: { style: 'accurate' } }), []);
  assert.deepEqual(choicesInUse({ skill: 'ranged', opts: { style: 'controlled' } }), [], 'not a style of Ranged');
  const controlled = indexMethods(METHODS.filter(m => m.skill === 'attack'), { opts: ['controlled'] });
  assert.deepEqual([controlled.byId.get('at_giant_28').xp, controlled.byId.get('at_giant_28').gives], [465, { strength: 465, defence: 465, hitpoints: 465 }]);
});

test('combat: a plan counts kills: the monster you pick, a mix of them, and nothing to buy (v2.10)', () => {
  // Attack 60 to 70 on moss giants: 60 hitpoints, 240 XP a kill
  const goal = { currentXp10: xp10ForLevel(60), targetXp10: xp10ForLevel(70), useBank: false };
  const toGo = xp10ForLevel(70) - xp10ForLevel(60);
  const moss = planGoal(fight.attack, { ...goal, fillId: 'at_moss_giant_42' });
  assert.deepEqual(moss.fill.segments, [{ id: 'at_moss_giant_42', runs: Math.ceil(toGo / 2400), xp10: Math.ceil(toGo / 2400) * 2400, made: {} }]);
  assert.deepEqual([moss.fill.buy, moss.fill.cost, moss.fill.locked, moss.fromBank.steps], [{}, 0, false, []]);
  assert.equal(row(moss, 'at_moss_giant_42').needed, Math.ceil(toGo / 2400));
  assert.deepEqual([row(moss, 'at_chicken_1').needed, row(moss, 'at_chicken_1').locked], [Math.ceil(toGo / 120), false], 'anything can be fought at any level');
  // Controlled: a third of it to Attack (1.33 a point), so three times the kills and a few more
  const shared = planGoal(indexMethods(METHODS.filter(m => m.skill === 'attack'), { opts: ['controlled'] }), { ...goal, fillId: 'at_moss_giant_42' });
  assert.equal(shared.fill.segments[0].runs, Math.ceil(toGo / 798));
  // a mix: 500 fire giants and 200 lesser demons count first, lowest XP first; the rest on the monster picked
  const mix = planGoal(fight.attack, { ...goal, fillId: 'at_moss_giant_42', mix: { at_fire_giant_86: 500, at_lesser_demon_82: 200 } });
  assert.deepEqual(mix.fromMix.steps.map(st => [st.id, st.runs, st.xp10, st.locked]), [['at_lesser_demon_82', 200, 200 * 3160, false], ['at_fire_giant_86', 500, 500 * 4440, false]]);
  assert.equal(mix.fill.segments[0].runs, Math.ceil((toGo - 200 * 3160 - 500 * 4440) / 2400));
  // nothing picked and no group to go by: the most XP a kill that isn't set aside (the page picks by combat level instead)
  const best = planGoal(fight.attack, goal).fill.id;
  assert.equal(best, 'at_black_demon_172');                  // (there are only four black dragons)
  assert.ok(!fight.attack.byId.get(best).aside && fight.attack.train.filter(m => !m.aside).every(m => m.xp <= fight.attack.byId.get(best).xp));
  // nothing has a price, whatever the prices say
  for (const r of planGoal(fight.ranged, { ...goal, priceOf: () => 1000 }).table) assert.deepEqual([r.econ.net, r.econ.cost, r.econ.value, r.have], [0, 0, 0, 0], r.id);
  // Hitpoints: 1.33 a point whatever you fight with. 79.8 XP a moss giant
  const hp = planGoal(fight.hitpoints, { ...goal, fillId: 'hp_moss_giant_42' });
  assert.equal(hp.fill.segments[0].runs, Math.ceil(toGo / 798));
});

test('combat: the search finds a monster by words of its name, and by its combat level (v2.10)', () => {
  const find = text => fight.attack.train.filter(m => searchHit(m.short.toLowerCase(), m.cb, searchTerms(text))).map(m => m.name);
  assert.deepEqual(find('giant'), ['Giant spider (level 2)', 'Giant rat (level 3)', 'Giant rat (level 6)', 'Blessed Giant rat (level 9)', 'Giant bat (level 27)', 'Giant spider (level 27)', 'Giant (level 28)',
    'Moss giant (level 42)', 'Ice giant (level 49)', 'Fire giant (level 86)']);
  assert.deepEqual(find('  MOSS  '), ['Moss giant (level 42)']);
  assert.deepEqual(find('skeleton 22'), ['Skeleton (level 22)']);
  assert.deepEqual(find('22 skel'), ['Skeleton (level 22)'], 'in any order');
  assert.deepEqual(find('28'), ['Giant (level 28)', 'Hobgoblin (level 28)', 'Kalphite Worker (level 28)', 'Pit Scorpion (level 28)', 'Soldier (level 28)', 'Terrorbird (level 28)', 'Tower guard (level 28)']);
  assert.deepEqual(find('8'), ['Barbarian woman (level 8)', 'Dark warrior (level 8)'], 'a number is a level, not part of one');
  assert.deepEqual(find('dragon'), ['Baby blue dragon (level 48)', 'Green dragon (level 79)', 'Blue dragon (level 111)', 'Red dragon (level 152)', 'Black dragon (level 227)', 'King black dragon (level 276)']);
  assert.deepEqual([find('zzz'), find('giant 500')], [[], []]);
  assert.equal(find('').length, 314, 'nothing typed: everything');
  assert.deepEqual([searchTerms(null), searchTerms('  '), searchTerms('Fire  Giant')], [[], [], ['fire', 'giant']]);
});
