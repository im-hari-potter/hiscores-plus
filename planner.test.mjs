// Run with:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, ITEMS, BANK_GROUPS, UNID_HERBS } from './gamedata.js';
import { mergeUnids } from './planner-ui.js';
import {
  xp10ForLevel, levelForXp10, goalTargetXp10, rankForTop, indexMethods, planBank, planGoal,
  methodEconomics, maxRuns, Stock, bankValue, outAt, madeOver, gathers,
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

test('even out: 605 kwuarm and 518 limpwurt want 87 more limpwurt (v2.4.2)', () => {
  const opts = bank => ({ bank, currentXp10: xp10ForLevel(75), targetXp10: xp10ForLevel(78), unlimited: VIALS });
  let r = row(planGoal(ix, opts({ kwuarm: 605, limpwurt_root: 518, vial_water: 2230 })), 'hb_3dose2strength');
  assert.equal(r.have, 518);
  assert.deepEqual(r.balance, { runs: 605, collect: { limpwurt_root: 87 } });
  // the other way round, and with some of the kwuarm already made into unfinished potions
  r = row(planGoal(ix, opts({ kwuarm: 500, limpwurt_root: 518 })), 'hb_3dose2strength');
  assert.deepEqual(r.balance, { runs: 518, collect: { kwuarm: 18 } });
  r = row(planGoal(ix, opts({ kwuarm: 505, kwuarmvial: 100, limpwurt_root: 518 })), 'hb_3dose2strength');
  assert.deepEqual(r.balance, { runs: 605, collect: { limpwurt_root: 87 } });
  // nothing to even out once it pairs up, or with the bank left out
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
  assert.equal(rOn.econ.profit, 700, '3,000 − 2,000 − 300');
  assert.equal(rOff.econ.profit, 680, 'and 20 for the vial');
});

test('total profits per row: after evening out, and after collecting the rest (v2.4.4)', () => {
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
  // the total net: the two together
  assert.equal(ss.gains.net.total, ss.gains.even.total + ss.gains.collect.total);
  assert.equal(fish.gains.net.total, fish.gains.even.total + fish.gains.collect.total);
  // nothing for it in the bank: nothing to show for that part
  assert.equal(row(plan, 'hb_3dose1attack').gains.even, null);
  assert.ok(row(plan, 'hb_3dose1attack').gains.collect.missing.length, 'no prices for attack potions here');
  // without the bank there are no totals
  const off = row(planGoal(ix, { ...plan, bank: { kwuarm: 605 }, currentXp10: xp10ForLevel(75), targetXp10: xp10ForLevel(78), useBank: false }), 'hb_3dose2strength');
  assert.deepEqual(off.gains, { even: null, collect: null, net: null });
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

test('prices: cost, profit and gp per XP of one action', () => {
  const price = { ranarr_weed: 3000, snape_grass: 400, vial_water: 5, '3doseprayerrestore': 3800 };
  const e = methodEconomics(ix, ix.byId.get('hb_3doseprayerrestore'), k => price[k] ?? null);
  assert.deepEqual(e.inputs, { ranarr_weed: 1, vial_water: 1, snape_grass: 1 });
  assert.equal(e.cost, 3405);
  assert.equal(e.value, 3800);
  assert.equal(e.profit, 395);
  assert.ok(Math.abs(e.gpPerXp - (-395 / 87.5)) < 1e-9);
  const unknown = methodEconomics(ix, ix.byId.get('hb_3dose1magic'), k => price[k] ?? null);
  assert.equal(unknown.profit, null);
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

test('runecraft: profit per essence counts the runes it makes at your level', () => {
  const price = { blankrune: 50, airrune: 10 };
  const e = methodEconomics(rc, rc.byId.get('rc_airrune'), k => price[k] ?? null, { level: 44 });
  assert.equal(e.value, 5 * 10);
  assert.equal(e.profit, 0);
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
  assert.equal(e.profit, 30);
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
  assert.equal(e.profit, -25);
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
