// Run with:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, ITEMS, BANK_GROUPS, UNID_HERBS } from './gamedata.js';
import { mergeUnids } from './planner-ui.js';
import {
  xp10ForLevel, levelForXp10, goalTargetXp10, rankForTop, indexMethods, planBank, planGoal,
  methodEconomics, maxRuns, Stock, bankValue, outAt, madeOver,
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
  assert.deepEqual(r.collect, { ranarr_weed: 3948, snape_grass: 4248, vial_water: 4948 });
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
  assert.deepEqual(plan.fill.buy, { ranarr_weed: 3948, snape_grass: 4248, vial_water: 4248 });
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
  assert.equal(plan.fill.segments.length, 2);
  assert.equal(plan.fill.segments[0].bridge, true);
  assert.equal(plan.fill.segments[0].id, 'hb_3doserangerspotion', 'best potion available at 74');
  assert.equal(plan.fill.segments[1].id, 'hb_3dosepotionofzamorak');
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
