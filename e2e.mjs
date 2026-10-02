// End-to-end check against the mock API.
//   RATE_MS=300 node mock-server.mjs 8787 &   then   node e2e.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // resolved from NODE_PATH / global install
import assert from 'node:assert/strict';
import { fakeBank } from './bankfake.mjs';
import { encodePng } from './testpng.mjs';
// (the addresses of the icon sheets this build names, and the XP table, to check what the page shows)
import { ICON_SHEET } from './gamedata.js';
import { BANK_ICON_SHEET } from './bankread-data.js';
import { xpForLevel, levelForXp } from './skills.js';

const BASE = process.env.BASE || 'http://localhost:8787';
const SHOTS = process.env.SHOTS || '/tmp';
const results = [];
// ONLY=<pattern>: run just the checks whose name matches (while writing one; the full run is what counts).
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
const check = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) { results.push(['skip', name]); return; }
  try { await fn(); results.push(['ok', name]); }
  catch (e) {
    // (with the line of this file it happened on)
    const at = (e.stack || '').match(/e2e\.mjs:(\d+):\d+/);
    results.push(['FAIL', name, `${at ? `line ${at[1]}: ` : ''}${e.message.split('\n').slice(0, 30).join(' | ')}`]);
  }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
const requested = [];                         // every address the page asks for
page.on('request', r => requested.push(r.url()));

const mockStats = async () => (await (await fetch(BASE + '/__mock/stats')).json());
const text = sel => page.locator(sel).first().innerText();

await page.goto(BASE + '/?api=local#lookup');
await page.waitForSelector('#view-lookup:not([hidden])');

await check('no LostKit banner when using the test API', async () => {
  assert.equal(await page.locator('#banner').isHidden(), true);
});

await check('lookup shows 20 tiles with LostKit numbers and Top %', async () => {
  await page.fill('#lookup-name', 'demo main');
  await page.click('#lookup-form button');
  await page.waitForSelector('.tile', { timeout: 15000 });
  assert.equal(await page.locator('.stats-grid .tile').count(), 20);
  assert.match(await text('.pc-name'), /Demo Main/);
  assert.match(await text('.pc-combat'), /Combat\s+86/);
  assert.match(await text('.pc-sub'), /Total level 1,460/);
  const attack = await page.locator('.tile').nth(1).innerText();
  assert.match(attack, /Level: 60/);
  assert.match(attack, /XP: 295,920/);
  assert.match(attack, /Next: 6,368 XP/);
  // Player counts come from the freshest of totals.json (the daily job) and the bundled seed.
  const counts = await page.evaluate(async () => {
    const files = await Promise.all(['totals.json', 'totals-seed.json'].map(f => fetch(f).then(r => r.ok ? r.json() : null).catch(() => null)));
    return files.filter(Boolean).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))[0].totals;
  });
  assert.match(attack, new RegExp(`Top [\\d.]+% of ${Number(counts['1']).toLocaleString('en-US')}`));
});
await page.screenshot({ path: `${SHOTS}/1-lookup.png`, fullPage: true });

await check('saving a player adds a chip', async () => {
  await page.click('.star');
  await page.waitForSelector('#lookup-chips .chip.saved');
  assert.match(await text('#lookup-chips'), /Demo Main/);
});

await check('combat filter shows 7 tiles, the formula and next-level hints', async () => {
  await page.click('#filter-seg [data-filter="combat"]');
  await page.waitForSelector('.combat-card');
  assert.equal(await page.locator('.stats-grid .tile').count(), 7);
  const card = await text('.combat-card');
  assert.match(card, /Combat level\s*86/);
  assert.doesNotMatch(card, /build/i);
  assert.ok(await page.locator('.combat-card .ico-combat').count() >= 1, 'crossed swords on the combat card');
  assert.match(card, /Attack \+1/);
  assert.match(card, /86\.75/);
});

await check('calculator what-if updates live', async () => {
  await page.click('.calc summary');
  await page.fill('[data-calc="attack"]', '99');
  await page.waitForFunction(() => document.querySelector('#cc-live').innerText.includes('What-if'));
  assert.match(await text('#cc-live'), /What-if combat level\s*99/);
  await page.click('[data-action="calc-reset"]');
  await page.waitForFunction(() => !document.querySelector('#cc-live').innerText.includes('What-if'));
});
await page.screenshot({ path: `${SHOTS}/2-combat.png`, fullPage: true });

await check('unranked combat skills give a combat range and bounded tiles', async () => {
  await page.fill('#lookup-name', 'lowbie');
  await page.click('#lookup-form button');
  await page.waitForFunction(() => document.querySelector('.pc-name')?.innerText.includes('Lowbie'), null, { timeout: 15000 });
  const combat = await text('.pc-combat');
  assert.match(combat, /Combat\s+\d+(–\d+)?/);
  assert.ok(await page.locator('.tile.unranked').count() >= 3);
});
await page.screenshot({ path: `${SHOTS}/3-lowbie-combat.png`, fullPage: true });
if (!ONLY) await page.click('#filter-seg [data-filter="all"]');

await check('compare 5 players with leaders highlighted', async () => {
  await page.click('.tab[data-tab="compare"]');
  for (const n of ['Demo Main', 'Vwangwang', 'Old Badger', 'Lowbie', 'Pure Ranger']) {
    await page.fill('#compare-name', n);
    await page.click('#compare-form button');
  }
  await page.waitForFunction(() => document.querySelectorAll('table.cmp th.p').length === 5 && !document.querySelector('table.cmp .pending'), null, { timeout: 30000 });
  assert.equal(await page.locator('table.cmp tbody tr').count(), 21); // combat + overall + 19 skills
  assert.ok(await page.locator('table.cmp td.best').count() >= 19);
  assert.match(await text('table.cmp tfoot'), /Skills led/);
  const combatRow = page.locator('table.cmp tr.combat');
  assert.doesNotMatch(await combatRow.innerText(), /melee|ranged|magic/i);
  assert.equal(await combatRow.locator('.ico-combat').count(), 1);
  assert.equal(await page.locator('table.cmp tr:not(.combat) .ico-combat').count(), 0);
  await page.fill('#compare-name', 'Zezima');
  await page.click('#compare-form button');
  assert.match(await text('#compare-msg'), /holds 5 players/);
});
await page.screenshot({ path: `${SHOTS}/4-compare.png`, fullPage: true });

await check('compare modes switch', async () => {
  await page.click('#compare-mode [data-mode="top"]');
  assert.match(await page.locator('table.cmp tbody tr').nth(2).innerText(), /Top [\d.]+%/);
  await page.click('#compare-mode [data-mode="xp"]');
  assert.match(await page.locator('table.cmp tbody tr').nth(2).innerText(), /295,920/);
  await page.click('#compare-mode [data-mode="level"]');
});

await check('compare sorts skills by a player, keeping Combat and Overall on top', async () => {
  await page.click('#compare-mode [data-mode="level"]');
  const skillNames = () => page.$$eval('table.cmp tbody tr', trs => trs.map(tr => tr.children[0].innerText.replace(/^\s*\d+\s*/, '').trim()));
  const levels = () => page.$$eval('table.cmp tbody tr', trs => trs.slice(2).map(tr => Number(tr.children[1].querySelector('.val').innerText.replace(/[^\d]/g, ''))));
  const positions = () => page.$$eval('table.cmp tbody tr', trs => trs.map(tr => {
    const p = tr.querySelector('.pos');
    return p ? [p.innerText.trim(), p.classList.contains('top10')] : null;
  }));
  let pos = await positions();
  assert.deepEqual(pos.slice(0, 3), [['', false], ['', false], ['1', false]], 'numbered 1.. from the first skill, no gold unsorted');
  await page.click('[data-csort="p:demo_main"]');
  assert.deepEqual((await skillNames()).slice(0, 2), ['Combat', 'Overall']);
  pos = await positions();
  assert.deepEqual(pos.slice(2).map(p => p[0]), Array.from({ length: 19 }, (_, i) => String(i + 1)), 'always 1 to 19 top to bottom');
  assert.equal(pos.slice(2).filter(p => p[1]).length, 10, 'top 10 picked out while sorted by a player');
  assert.equal(pos[11][1], true);
  assert.equal(pos[12][1], false);
  let lv = await levels();
  assert.deepEqual(lv, [...lv].sort((a, b) => b - a), 'highest level first');
  assert.match(await text('.sort-note'), /Demo Main's level, highest first/);
  await page.click('[data-csort="p:demo_main"]');
  lv = await levels();
  assert.deepEqual(lv, [...lv].sort((a, b) => a - b), 'lowest level first after a second click');
  await page.click('[data-csort="skill"]');
  const names = (await skillNames()).slice(2);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  await page.click('[data-csort-reset]');
  assert.equal((await skillNames())[2], 'Attack');
  assert.equal(await page.locator('.sort-note').count(), 0);
});
if (!ONLY) await page.click('[data-csort="p:demo_main"]');
await page.screenshot({ path: `${SHOTS}/4b-compare-sorted.png` });
if (!ONLY) await page.click('[data-csort-reset]');

await check('gains shows XP gained after the player trains', async () => {
  await fetch(BASE + '/__mock/bump?name=demo_main&type=1&xp=12345', { method: 'POST' });
  await fetch(BASE + '/__mock/bump?name=demo_main&type=15&xp=500000', { method: 'POST' });
  await page.click('.tab[data-tab="gains"]');
  await page.selectOption('#gains-player', 'Demo Main');
  await page.click('#gains-update');
  await page.waitForFunction(() => document.querySelector('#gains-result table.gains'), null, { timeout: 15000 });
  const t = await text('#gains-result');
  assert.match(t, /\+12,345/);
  assert.match(t, /\+500,000/);
  assert.match(t, /XP gained\s*\+512,345/);
  await page.check('#gains-hide-zero');
  const rows = await page.locator('#gains-result tbody tr').count();
  assert.ok(rows <= 3, `expected only changed rows, got ${rows}`);
});

await check('gains: snapshots can be listed and deleted one at a time', async () => {
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('lchs.snap.demo_main')).map(s => s.t));
  const before = await stored();
  assert.ok(before.length >= 2, `${before.length} snapshots`);
  assert.equal(await page.locator('.snap-list').count(), 0, 'not listed until asked for');
  await page.click('[data-action="gains-snaps"]');
  await page.waitForSelector('.snap-list');
  assert.equal(await page.locator('.snap-row').count(), before.length);
  assert.match(await page.locator('.snap-row').first().innerText(), /Total level [\d,]+ · [\d,]+ XP · latest/);
  assert.match(await page.locator('.snap-row').last().innerText(), /· first/);
  assert.match(await text('#gains-result .pc-foot'), new RegExp(`${before.length} snapshots stored for Demo Main in this browser[\\s\\S]*Hide snapshots[\\s\\S]*Delete this history`));
  // the oldest goes: one click arms it, the second deletes it
  const oldest = page.locator(`[data-action="gains-delete-one"][data-t="${before[0]}"]`);
  await oldest.click();
  assert.equal((await oldest.innerText()).trim(), 'Click again to delete');
  assert.deepEqual(await stored(), before, 'nothing deleted yet');
  await oldest.click();
  await page.waitForFunction(n => document.querySelectorAll('.snap-row').length === n, before.length - 1);
  assert.deepEqual(await stored(), before.slice(1), 'only that one is gone');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.snapIndex')).demo_main.count), before.length - 1);
  assert.equal(await page.inputValue('#gains-player'), 'Demo Main', 'the player and the rest of the history stay');
  await page.click('[data-action="gains-snaps"]');
  assert.equal(await page.locator('.snap-list').count(), 0);
});
await page.screenshot({ path: `${SHOTS}/5-gains.png`, fullPage: true });

await check('leaderboard pages, jumps to a rank and finds a player', async () => {
  await page.click('.tab[data-tab="leaders"]');
  await page.click('[data-lb-type="1"]');
  await page.waitForFunction(() => document.querySelectorAll('table.lb tbody tr').length === 21, null, { timeout: 15000 });
  assert.match(await text('#lb-page'), /Page 1 of/);
  await page.click('#lb-next');
  await page.waitForFunction(() => document.querySelector('table.lb tbody tr td')?.innerText === '22', null, { timeout: 15000 });
  await page.fill('#lb-rank', '1000');
  await page.click('#lb-rank-form button');
  await page.waitForFunction(() => document.querySelector('table.lb tr.hl td')?.innerText === '1,000', null, { timeout: 15000 });
  await page.fill('#lb-find', 'demo main');
  await page.click('#lb-find-form button');
  await page.waitForFunction(() => document.querySelector('table.lb tr.hl')?.innerText.includes('Demo Main'), null, { timeout: 15000 });
});
await page.screenshot({ path: `${SHOTS}/6-leaders.png`, fullPage: true });

await check('last page is short and corrects the player count for free', async () => {
  await page.click('#lb-last');
  // Seed says 14,138 for Attack; the mock has more, so this page is full and the count gets fixed from it only if short.
  await page.waitForFunction(() => !document.querySelector('#lb-last').disabled && document.querySelectorAll('table.lb tbody tr').length > 0, null, { timeout: 15000 });
  const mock = await mockStats();
  // Walk forward until a short page shows up; the head must then show the mock's exact total.
  for (let i = 0; i < 20; i++) {
    const n = await page.locator('table.lb tbody tr').count();
    if (n < 21) break;
    await page.click('#lb-next');
    await page.waitForTimeout(900);
  }
  await page.waitForFunction(t => document.querySelector('#leaders-head').innerText.includes(t), mock.totals['1'].toLocaleString('en-US'), { timeout: 15000 });
});

await check('leaderboard headers are plain (no sorting there)', async () => {
  await page.click('.tab[data-tab="leaders"]');
  await page.click('[data-lb-type="1"]');
  await page.waitForFunction(() => document.querySelectorAll('table.lb tbody tr').length > 0, null, { timeout: 15000 });
  assert.equal(await page.locator('table.lb [data-sort], table.lb .th-sort').count(), 0);
  const ranks = await page.$$eval('table.lb tbody tr', trs => trs.map(tr => Number(tr.children[0].innerText.replace(/[^\d]/g, ''))));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

await check('lookup tiles can be dragged into a new order that sticks', async () => {
  await page.click('.tab[data-tab="lookup"]');
  await page.fill('#lookup-name', 'demo main');
  await page.click('#lookup-form button');
  await page.waitForSelector('#tiles-grid .tile');
  const order = () => page.$$eval('#tiles-grid .tile', ts => ts.map(t => Number(t.dataset.id)));
  const before = await order();
  const src = await page.locator('#tiles-grid .tile[data-id="21"]').boundingBox();   // Runecraft
  const dst = await page.locator('#tiles-grid .tile[data-id="1"]').boundingBox();    // Attack
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2 + 20, src.y + src.height / 2, { steps: 4 });
  await page.mouse.move(dst.x + dst.width / 2 - 10, dst.y + dst.height / 2, { steps: 12 });
  await page.mouse.up();
  const after = await order();
  assert.notDeepEqual(after, before);
  assert.equal(after.indexOf(21), before.indexOf(1), 'Runecraft took Attack\'s place');
  await page.reload();
  await page.waitForSelector('#tiles-grid .tile');
  assert.deepEqual(await order(), after, 'order survives a reload');
  await page.click('[data-action="tiles-reset"]');
  assert.deepEqual(await order(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21]);
});

await check('lookup tiles sort by level/XP/rank/Top %, Overall first, and can be dragged after', async () => {
  await page.click('.tab[data-tab="lookup"]');
  await page.waitForSelector('#tiles-grid .tile');
  const tiles = () => page.$$eval('#tiles-grid .tile', ts => ts.map(t => ({ id: Number(t.dataset.id), text: t.innerText })));
  const lvl = t => Number((t.text.match(/Level: ([\d,]+)/) || [])[1]?.replace(/,/g, ''));
  assert.equal(await page.locator('#tiles-grid .pos').count(), 0, 'no position numbers on Lookup tiles');
  await page.click('[data-tsort="level"]');
  let ts = await tiles();
  assert.equal(ts[0].id, 0, 'Overall stays first');
  let levels = ts.slice(1).map(lvl);
  assert.deepEqual(levels, [...levels].sort((a, b) => b - a), 'highest level first');
  assert.match(await text('[data-tsort="level"]'), /▼/);
  await page.click('[data-tsort="level"]');
  levels = (await tiles()).slice(1).map(lvl);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'lowest first after a second click');
  await page.click('[data-tsort="xp"]');
  const xps = (await tiles()).slice(1).map(t => Number(t.text.match(/XP: ([\d,]+)/)[1].replace(/,/g, '')));
  assert.deepEqual(xps, [...xps].sort((a, b) => b - a));
  await page.screenshot({ path: `${SHOTS}/1b-lookup-sorted.png` });
  // drag after sorting: the sorted order becomes a layout you can adjust
  const sortedIds = (await tiles()).map(t => t.id);
  const a = await page.locator(`#tiles-grid .tile[data-id="${sortedIds[5]}"]`).boundingBox();
  const b = await page.locator(`#tiles-grid .tile[data-id="${sortedIds[2]}"]`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 15, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2 - 10, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  const afterDrag = (await tiles()).map(t => t.id);
  assert.equal(afterDrag[2], sortedIds[5], 'the dragged tile landed where it was dropped');
  assert.deepEqual([...afterDrag].sort((x, y) => x - y), [...sortedIds].sort((x, y) => x - y));
  assert.equal(await page.locator('.tiles-bar .seg button.on').count(), 0, 'no sort is active once you drag');
  await page.reload();
  await page.waitForSelector('#tiles-grid .tile');
  assert.deepEqual((await tiles()).map(t => t.id), afterDrag, 'the adjusted layout survives a reload');
  await page.click('[data-action="tiles-reset"]');
  assert.deepEqual((await tiles()).map(t => t.id), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21]);
});

await check('lookup: a recent name can be taken off the list, or the list cleared, and stays gone until you look them up again', async () => {
  await page.click('.tab[data-tab="lookup"]');
  const recent = () => page.$$eval('#lookup-chips .chip-group [data-chip]', cs => cs.map(c => c.dataset.chip));
  const lookUp = async (name, shown) => {
    await page.fill('#lookup-name', name);
    await page.click('#lookup-form button');
    await page.waitForFunction(n => document.querySelector('.pc-name')?.innerText.trim() === n, shown, { timeout: 15000 });
  };
  await lookUp('vwangwang', 'Vwangwang');
  await lookUp('old badger', 'Old Badger');
  await lookUp('lowbie', 'Lowbie');
  const before = await recent();
  assert.deepEqual(before.slice(0, 3), ['Lowbie', 'Old Badger', 'Vwangwang'], 'latest first');
  assert.ok(!before.includes('Demo Main'), 'a saved player is under Saved, not Recent');
  // each has a ✕ beside it: Old Badger goes, the rest stay as they were
  await page.click('#lookup-chips [data-unrecent="Old Badger"]');
  assert.deepEqual(await recent(), before.filter(n => n !== 'Old Badger'));
  assert.equal(await text('.pc-name'), 'Lowbie', 'taking a name off the list looks nobody up');
  // the one on screen can go too, and reopening the tool on it doesn't bring it back
  await page.click('#lookup-chips [data-unrecent="Lowbie"]');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.pc-name')?.innerText.trim() === 'Lowbie', null, { timeout: 15000 });
  assert.deepEqual(await recent(), before.filter(n => n !== 'Old Badger' && n !== 'Lowbie'));
  // neither does Compare fetching its players again
  await page.click('.tab[data-tab="compare"]');
  await page.waitForSelector('#compare-chips .chip');
  assert.ok(!(await page.$$eval('#compare-chips .chip-group [data-chip]', cs => cs.map(c => c.dataset.chip))).includes('Lowbie'));
  await page.click('.tab[data-tab="lookup"]');
  // looking someone up again does
  await lookUp('old badger', 'Old Badger');
  assert.equal((await recent())[0], 'Old Badger');
  await page.screenshot({ path: `${SHOTS}/1b-recent-names.png` });
  // Clear takes the whole list; saved players stay
  assert.equal((await text('#lookup-chips .chips-clear')).trim(), 'Clear');
  await page.click('#lookup-chips .chips-clear');
  assert.deepEqual(await recent(), []);
  assert.doesNotMatch(await text('#lookup-chips'), /Recent/);
  assert.match(await text('#lookup-chips'), /Demo Main/);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.recent'))), []);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.pc-name')?.innerText.trim() === 'Old Badger', null, { timeout: 15000 });
  assert.deepEqual(await recent(), [], 'still clear after a restart');
  // (Demo Main on screen again, for the checks that follow)
  await page.click('#lookup-chips .chip.saved');
  await page.waitForFunction(() => document.querySelector('.pc-name')?.innerText.trim() === 'Demo Main', null, { timeout: 15000 });
});

// ── Planner: Goals, Bank, Prices ────────────────────────────────────────
const goalText = () => page.locator('.goal').first().innerText();

await check('goals: a Herblore level goal shows the XP left from the hiscores', async () => {
  await page.click('.tab[data-tab="goals"]');
  await page.waitForSelector('#view-goals:not([hidden])');
  assert.equal(await page.locator('#filter-seg').isHidden(), true, 'All/Combat is hidden on planner tabs');
  await page.fill('#plan-account input[name=account]', 'demo main');
  await page.click('#plan-account button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#plan-account').innerText.includes('XP from the hiscores'), null, { timeout: 15000 });
  await page.click('[data-nskill="herblore"]');
  await page.click('[data-ntype="level"]');
  await page.fill('#goal-new input[name=value]', '78');
  await page.click('#goal-new button[type=submit]');
  await page.waitForSelector('.goal .plan');
  const t = await goalText();
  assert.match(t, /Level 74 → 78/);
  assert.match(t, /433,173 XP to go/);
  assert.match(t, /4 levels/);
});

await check('goals: a goal that is already reached is not added', async () => {
  await page.click('[data-nskill="woodcutting"]');
  await page.fill('#goal-new input[name=value]', '80');
  await page.click('#goal-new button[type=submit]');
  assert.match(await text('#goals-msg'), /already level 93 in Woodcutting/);
  assert.equal(await page.locator('.goal').count(), 1);
});

await check('bank: amounts typed in are kept and valued', async () => {
  await page.click('.tab[data-tab="bank"]');
  await page.waitForSelector('#bank-head [data-bskill="all"].active');
  assert.match(await text('#bank-body'), /Nothing in your bank yet/, 'All shows what you have: nothing yet');
  await page.click('[data-bskill="herblore"]');
  await page.waitForSelector('[data-bank="ranarr_weed"]');
  await page.fill('[data-bank="ranarr_weed"]', '1k');
  await page.press('[data-bank="ranarr_weed"]', 'Tab');
  await page.fill('[data-bank="snape_grass"]', '700');
  await page.press('[data-bank="snape_grass"]', 'Tab');
  assert.equal(await page.inputValue('[data-bank="ranarr_weed"]'), '1,000', '1k is read as 1,000');
  assert.match(await text('#bank-head'), /2 kinds of Herblore item/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.bank.demo_main')));
  assert.deepEqual(stored.items, { ranarr_weed: 1000, snape_grass: 700 });
});

await check('bank: All shows everything you have; a skill tab shows only its items and their value', async () => {
  await page.click('[data-bskill="runecraft"]');
  await page.waitForSelector('[data-bank="blankrune"]');
  assert.match(await text('#bank-head'), /No Runecraft items yet/);
  await page.fill('[data-bank="naturerune"]', '100');
  await page.press('[data-bank="naturerune"]', 'Tab');
  assert.match(await text('#bank-head'), /1 kind of Runecraft item/);
  await page.click('[data-bskill="all"]');
  await page.waitForSelector('#bank-head [data-bskill="all"].active');
  assert.match(await text('#bank-head'), /3 kinds of item/);
  assert.deepEqual((await page.$$eval('#bank-body [data-bank]', els => els.map(e => e.dataset.bank))).sort(), ['naturerune', 'ranarr_weed', 'snape_grass']);
  // each tab shows what its items are worth, once prices are in
  await page.click('[data-act="bank-prices"]');
  await page.waitForFunction(() => document.querySelectorAll('#bank-head .skill-tab .sw-v').length >= 3, null, { timeout: 30000 });
  const worth = async k => page.locator(`#bank-head [data-bskill="${k}"] .sw-v`).innerText();
  assert.ok(await worth('all') && await worth('herblore') && await worth('runecraft'));
  assert.equal(await page.locator('#bank-head [data-bskill="firemaking"] .sw-v').count(), 0, 'no logs, no value');
  assert.match(await text('#bank-head'), /Worth about/);
  await page.click('[data-bskill="herblore"]');
  assert.match(await text('#bank-head'), /Herblore items are worth about/);
  await page.click('[data-bskill="runecraft"]');
  await page.fill('[data-bank="naturerune"]', '');
  await page.press('[data-bank="naturerune"]', 'Tab');
  await page.click('[data-bskill="herblore"]');
});
await page.screenshot({ path: `${SHOTS}/9-bank.png`, fullPage: true });

await check("goals: Ostap's example, 700 potions from the bank, 4,251 more and 300 snape grass to balance", async () => {
  await page.click('.tab[data-tab="goals"]');
  await page.waitForSelector('.goal .plan');
  const t = await goalText();
  assert.match(t, /700 × Prayer potion \+61,250 XP/);
  assert.match(t, /4,251 × Prayer potion/);
  assert.match(t, /3,951\s*Ranarr weed/);
  assert.match(t, /4,251\s*Snape grass/);
  assert.match(t, /collect\s*300\s*Snape grass[\s\S]*makes\s*1,000\s*Prayer potion instead of 700/);
  // with your bank: no To goal; what it makes, evens out, and what's still needed after it
  const head = await page.locator('.goal >> nth=0 >> .plan-t thead').innerText();
  assert.match(head.trim(), /^Use\s*Lvl\s*Potion\s*XP\s*Net\/item\s*gp\/XP\s*From bank\s*Gross from\s*banked supplies\s*Round up\s*my supplies\s*Net after rounding\s*up my supplies\s*Still needed\s*to goal\s*Supplies needed\s*Net after\s*buying supplies\s*Total net gp\s*toward goal$/);
  assert.doesNotMatch(head, /To goal/);
  assert.doesNotMatch(head, /even out/i);
  // Round up my supplies and Net after rounding up my supplies go together, with a dark line on each side
  const plant = page.locator('.goal >> nth=0 >> .plan-t');
  assert.match((await plant.locator('th.sep-l').innerText()).trim(), /^Round up\s*my supplies$/);
  assert.match(await plant.locator('th.sep-r').innerText(), /^Net after rounding\s*up my supplies$/);
  // the group's name sits above the potions' names, not under Use
  assert.deepEqual(await plant.locator('tr.grp').first().locator('td').evaluateAll(tds => tds.map(td => [td.colSpan, td.innerText.trim()])), [[2, ''], [12, 'Potions']]);
  assert.equal(await plant.locator('tr.grp td').nth(1).evaluate(td => Math.round(td.getBoundingClientRect().left)),
    await plant.locator('thead th').nth(2).evaluate(th => Math.round(th.getBoundingClientRect().left)), 'it starts where the Potion column does');
  const rowCount = await plant.locator('tr[data-method]').count();
  assert.equal(await plant.locator('tr[data-method] td.even.sep-l').count(), rowCount, 'every Round up my supplies cell has the line before it');
  assert.equal(await plant.locator('tr[data-method] td.sep-r').count(), rowCount, 'every Net after rounding up my supplies cell has the line after it');
  assert.deepEqual(await plant.locator('th.sep-l').evaluate(el => [getComputedStyle(el).borderLeftStyle, getComputedStyle(el).borderLeftColor]), ['solid', 'rgb(0, 0, 0)']);
  assert.deepEqual(await plant.locator('th.sep-r').evaluate(el => [getComputedStyle(el).borderRightStyle, getComputedStyle(el).borderRightColor]), ['solid', 'rgb(0, 0, 0)']);
  const row = await page.locator('tr[data-method="hb_3doseprayerrestore"]').innerText();
  const cells = row.split('\t').map(c => c.trim());
  assert.equal(cells[6], '700', 'from bank');
  assert.match(cells[8], /^300\s*→\s*1,000$/, 'round up: 300 snape grass, and the bank covers 1,000');
  assert.equal(cells[10], '4,251', 'still needed');
  assert.match(cells[11], /^3,951\s*4,251$/, 'collect: ranarr and snape grass; vials are bought as you go');
  // "I'll buy vials of water as I go" leaves them out of what to collect
  const collectLine = () => page.locator('.goal >> nth=0 >> .collect').first().innerText();
  assert.doesNotMatch(await collectLine(), /Vial/);
  await page.uncheck('.goal >> nth=0 >> input[data-gopt="assume"]');
  await page.waitForFunction(() => /[\d,]+\s*Vial of water/.test(document.querySelector('.goal .collect').innerText));
  assert.match(await goalText(), /Nothing in your bank makes Herblore XP/, 'no vials in the bank: it makes nothing');
  await page.check('.goal >> nth=0 >> input[data-gopt="assume"]');
  await page.waitForFunction(() => !/Vial/.test(document.querySelector('.goal .collect').innerText));
  assert.equal(await page.locator('tr[data-method="hb_3doseprayerrestore"] td.even').getAttribute('title'),
    'Collect 300 Snape grass, and your bank covers 1,000 × Prayer potion instead of 700.');
  assert.equal((await page.locator('tr[data-method="hb_3dose1attack"] td.even').innerText()).trim(), '–', 'nothing for it in the bank: nothing to round up');
});
await page.screenshot({ path: `${SHOTS}/10-goal-plan.png`, fullPage: true });

await check('item icons come from the sheet this release names, never a plain items.png a browser may still hold', async () => {
  // Where an icon sits is in gamedata.js, so the sheet has to be the one built with it: its address
  // carries a stamp of the picture. (After v2.6.0 a browser showed the new positions on the old sheet.)
  assert.match(ICON_SHEET, /^items\.png\?v=[0-9a-f]{10}$/);
  const icon = page.locator('.goal .plan .item').first();
  await icon.waitFor();
  const shown = await icon.evaluate(el => getComputedStyle(el).backgroundImage);
  assert.equal(shown, `url("${BASE}/${ICON_SHEET}")`);
  const sheets = requested.filter(u => /\/items\.png/.test(u));
  assert.ok(sheets.length > 0, 'the sheet was asked for');
  assert.deepEqual([...new Set(sheets)], [`${BASE}/${ICON_SHEET}`], 'and only by its stamped address');
  // the picture really is the one the stamp was made from
  const size = await page.evaluate(async url => { const b = await (await fetch(url)).arrayBuffer(); return b.byteLength; }, ICON_SHEET);
  assert.ok(size > 10000, `items.png is ${size} bytes`);
});

await check('goals: picking another potion and leaving the bank out change the plan', async () => {
  await page.click('tr[data-method="hb_3doserangerspotion"] td:nth-child(2)');
  await page.waitForFunction(() => /2,289 × Ranging potion/.test(document.querySelector('.goal').innerText));
  assert.equal(await page.inputValue('.goal select[data-gopt="fill"]'), 'hb_3doserangerspotion');
  await page.selectOption('.goal select[data-gopt="fill"]', 'hb_3doseprayerrestore');
  await page.waitForFunction(() => /4,251 × Prayer potion/.test(document.querySelector('.goal').innerText));
  // Still needed comes after everything the bank makes: 700 prayer potions
  // are 61,250 XP, the same as 2,450 attack potions
  const cellsOf = async id => (await page.locator(`.goal >> nth=0 >> tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
  const num = c => Number(c.replace(/,/g, ''));
  const attack = await cellsOf('hb_3dose1attack');
  assert.equal(attack[7], '–', 'the bank plan makes none of these');
  assert.match(attack[11], new RegExp(`^${attack[10]}\\s*${attack[10]}$`), 'collect: guam and eyes of newt for those');
  await page.uncheck('.goal input[data-gopt="useBank"]');
  await page.waitForFunction(() => !/From your bank/.test(document.querySelector('.goal').innerText));
  assert.match(await goalText(), /4,951 × Prayer potion/);
  // without the bank: how many to the goal, and nothing to collect
  const head = await page.locator('.goal >> nth=0 >> .plan-t thead').innerText();
  assert.match(head.trim(), /^Use\s*Lvl\s*Potion\s*XP\s*Net\/item\s*gp\/XP\s*To goal\s*Plan to\s*make$/);
  assert.equal(await page.locator('.goal >> nth=0 >> [data-tsort-plan="net"]').count(), 0, 'no Total net to sort by without the bank');
  assert.doesNotMatch(head, /From bank|Round up|Gross|using bank|Still|Supplies|buying|Total net/);
  const attackOff = await cellsOf('hb_3dose1attack');
  assert.equal(num(attack[10]), num(attackOff[6]) - 2450, `still needed ${attack[10]}, to goal ${attackOff[6]}`);
  assert.equal((await cellsOf('hb_3doseprayerrestore'))[6], '4,951');
  // a mix of your own, with the bank off: 1,000 attack potions and 2,000 prayer potions first
  await page.fill('.goal >> nth=0 >> [data-mix="hb_3dose1attack"]', '1k');
  await page.press('.goal >> nth=0 >> [data-mix="hb_3dose1attack"]', 'Tab');
  await page.fill('.goal >> nth=0 >> [data-mix="hb_3doseprayerrestore"]', '2000');
  await page.press('.goal >> nth=0 >> [data-mix="hb_3doseprayerrestore"]', 'Tab');
  await page.waitForFunction(() => /Your mix \+200,000 XP/.test(document.querySelector('.goal').innerText));
  const mixText = await goalText();
  assert.match(mixText, /1,000 × Attack potion \+25,000 XP/);
  assert.match(mixText, /2,000 × Prayer potion \+175,000 XP/);
  assert.match(mixText, /Then, to reach your goal: [\d,.]+ XP/);
  assert.match(mixText, /With your mix: [+−]?[\d.,]+[KM]? gp|some prices are still unknown/);
  assert.match(await page.locator('.goal >> nth=0 >> .plan-t thead').innerText(), /Plan to\s*make\s*Still needed\s*to goal/);
  const attackMix = await cellsOf('hb_3dose1attack');
  assert.equal(await page.inputValue('.goal >> nth=0 >> [data-mix="hb_3dose1attack"]'), '1,000', 'plan to make');
  assert.equal(num(attackMix[8]), num(attackMix[6]) - 8000, 'still needed to goal: 200,000 XP of mix is 8,000 attack potions fewer');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.goals.demo_main'))[0].mix), { hb_3dose1attack: 1000, hb_3doseprayerrestore: 2000 });
  await page.check('.goal input[data-gopt="useBank"]');
  await page.waitForFunction(() => /From your bank/.test(document.querySelector('.goal').innerText));
  // with the bank in use, the mix waits (it's kept for when the bank is off again)
  assert.doesNotMatch(await goalText(), /Your mix/);
  assert.equal(await page.locator('.goal >> nth=0 >> [data-mix]').count(), 0);
  await page.uncheck('.goal input[data-gopt="useBank"]');
  await page.waitForFunction(() => /Your mix \+200,000 XP/.test(document.querySelector('.goal').innerText));
  await page.click('.goal >> nth=0 >> [data-act="mix-clear"]');
  await page.waitForFunction(() => /Plan a mix of ways to train/.test(document.querySelector('.goal').innerText));
  await page.check('.goal input[data-gopt="useBank"]');
  await page.waitForFunction(() => /From your bank/.test(document.querySelector('.goal').innerText));
});

await check('goals: Round up my supplies, per potion (605 kwuarm and 518 limpwurt: collect 87 limpwurt)', async () => {
  await setBank('herblore', { kwuarm: '605', limpwurt_root: '518' });
  await page.click('.tab[data-tab="goals"]');
  const row = page.locator('.goal').first().locator('tr[data-method="hb_3dose2strength"]');
  await row.waitFor();
  const cells = (await row.innerText()).split('\t').map(c => c.trim());
  assert.equal(cells[6], '518', 'from bank');
  assert.match(cells[8], /^87\s*→\s*605$/);
  assert.equal(await row.locator('td.even').getAttribute('title'), 'Collect 87 Limpwurt root, and your bank covers 605 × Super strength instead of 518.');
  assert.match(await row.locator('td.even .it-chip').getAttribute('title'), /^Limpwurt root/);
  // the other way round: more limpwurt than kwuarm
  await setBank('herblore', { kwuarm: '500', limpwurt_root: '518' });
  await page.click('.tab[data-tab="goals"]');
  await row.waitFor();
  assert.match((await row.innerText()).split('\t')[8].trim(), /^18\s*→\s*518$/);
  assert.match(await row.locator('td.even .it-chip').getAttribute('title'), /^Kwuarm/);
  await page.screenshot({ path: `${SHOTS}/10c-round-up-column.png`, fullPage: true });
  await setBank('herblore', { kwuarm: '', limpwurt_root: '' });
  await page.click('.tab[data-tab="goals"]');
});

await check('prices: sales medians, placeholder prices fixed from notes, 4-dose fallback and your own price', async () => {
  await page.click('.tab[data-tab="prices"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('#prices-body').innerText;
    return /Ranarr weed\s*3,000\s*median of 6 sales/.test(t) && /Prayer potion\(3\)\s*[\d,.]+[KM]?\s*¾ of the 4-dose price/.test(t);
  }, null, { timeout: 60000 });
  await page.fill('[data-price="snape_grass"]', '450');
  await page.press('[data-price="snape_grass"]', 'Tab');
  await page.waitForSelector('[data-psrc="snape_grass"][value="mine"]:checked');
  assert.equal(await page.evaluate(() => window.__skills.prices.gp('snape_grass')), 450, 'typing a price picks it');
  const overrides = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.priceOverrides')));
  assert.deepEqual(overrides, { snape_grass: 450 });
});
await page.screenshot({ path: `${SHOTS}/11-prices.png`, fullPage: true });

await check('prices: each item uses the price you pick (market, high alch or yours), and it sticks', async () => {
  await page.click('.tab[data-tab="prices"]');
  await page.click('#prices-head [data-bskill="herblore"]');
  const row = slug => page.locator(`#prices-body tr:has([data-psrc="${slug}"])`);
  const on = async slug => (await row(slug).locator('td.pc.on input[type=radio]').getAttribute('value'));
  const gp = slug => page.evaluate(s => window.__skills.prices.gp(s), slug);
  await page.waitForFunction(() => /Strength potion\(3\)\s*\d+\s*no trades: high alch/.test(document.querySelector('#prices-body').innerText), null, { timeout: 60000 });
  assert.match(await row('ranarr_weed').innerText(), /Ranarr weed\s*3,000\s*median of 6 sales[^\n]*\s*15/, 'market and high alch side by side');
  assert.equal(await on('ranarr_weed'), 'market', 'the market by default');
  // one item
  await row('ranarr_weed').locator('[value="alch"]').click();
  await page.waitForFunction(() => window.__skills.prices.gp('ranarr_weed') === 15);
  assert.equal(await on('ranarr_weed'), 'alch');
  assert.equal(await gp('kwuarm') > 32, true, 'only that item changed');
  // a whole skill, then one list back: your own price stays
  await page.click('#prices-head [data-pall="alch"]');
  assert.deepEqual([await gp('kwuarm'), await gp('limpwurt_root'), await gp('snape_grass')], [32, 4, 450]);
  assert.equal(await on('snape_grass'), 'mine');
  await page.click('#prices-body table:has([data-psrc="guam_leaf"]) [data-pall="market"]');
  assert.equal(await on('kwuarm'), 'market');
  assert.equal(await on('limpwurt_root'), 'alch', 'other lists keep theirs');
  // "Your price" needs one typed in first
  await row('kwuarm').locator('[value="mine"]').click();
  assert.equal(await on('kwuarm'), 'market');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.price), 'kwuarm', 'the box to type it in');
  await page.screenshot({ path: `${SHOTS}/11b-prices-picks.png` });
  // the picks stick: a market check and a reload change nothing
  await page.click('[data-act="prices-refresh"]');
  await page.reload();
  await page.waitForSelector('[data-psrc="limpwurt_root"]');
  assert.deepEqual([await on('ranarr_weed'), await on('kwuarm'), await on('limpwurt_root'), await on('snape_grass')], ['market', 'market', 'alch', 'mine']);
  assert.equal(await page.inputValue('[data-price="snape_grass"]'), '450');
  assert.match(await page.getAttribute('[data-price="snape_grass"]', 'class'), /\bset\b/);
  // the plan uses them: limpwurt at high alch is 4 gp
  await page.click('.tab[data-tab="goals"]');
  await page.waitForSelector('.goal .plan');
  assert.match(await page.locator('.goal').first().locator('a.it-chip[href$="/items/limpwurt_root"]').first().getAttribute('title'), /4 gp each · high alch/);
  // back to the market for the rest of the checks
  await page.click('.tab[data-tab="prices"]');
  await page.click('#prices-head [data-pall="market"]');
  assert.deepEqual([await on('limpwurt_root'), await on('snape_grass')], ['market', 'mine']);
  // each item opens its page on the market (a new tab in a browser)
  const link = page.locator('#prices-body a.mk', { hasText: 'Ranarr weed' });
  assert.equal(await link.getAttribute('href'), 'https://markets.lostcity.rs/items/ranarr_weed');
  assert.equal(await link.getAttribute('target'), '_blank');
});

await check('goals: with prices known the plan shows cost, value, gross and net', async () => {
  await page.click('.tab[data-tab="goals"]');
  await page.waitForSelector('.goal .money');
  const money = await page.locator('.goal').first().locator('.money', { hasText: 'Buying it all' }).innerText();
  assert.match(money, /Buying it all: [\d.,]+[KM]? gp/);
  assert.match(money, /worth: [\d.,]+[KM]? gp/);
  assert.match(money, /Net: [+−][\d.,]+[KM]? gp/);
  // what the bank makes is its Gross (the supplies are already yours), one
  // line, with each step's own amount: here the 700 prayer potions
  const gross = await page.locator('.goal').first().locator('.money', { hasText: 'Gross:' }).innerText();
  assert.doesNotMatch(gross, /What you make is worth/);
  assert.match(gross, /your banked supplies are already yours/);
  const total = gross.match(/Gross: \+([\d.,]+[KM]?) gp/)?.[1];
  assert.ok(total, gross);
  const step = await page.locator('.goal').first().locator('.step', { hasText: '700 × Prayer potion' }).innerText();
  assert.match(step, new RegExp(`\\+61,250 XP · ${total.replace('.', '\\.')} gp \\([\\d.,]+[KM]? each\\)`), step);
  // and the table's totals have their numbers
  const row = (await page.locator('tr[data-method="hb_3doseprayerrestore"]').innerText()).split('\t').map(c => c.trim());
  assert.doesNotMatch(row.join(' '), /\?/);
  assert.equal(row[7], `+${total}`, 'gross from banked supplies: its part of From your bank');
  assert.match(row[9], /^[+−][\d.,]+[KM]?$/, 'net after rounding up my supplies');
  assert.match(row[12], /^[+−][\d.,]+[KM]?$/, 'net after buying supplies');
  assert.equal(row[12], money.match(/Net: ([+−]?[\d.,]+[KM]?) gp/)[1], 'the same as the plan\'s own Net for the potion you train with');
  assert.match(row[13], /^[+−][\d.,]+[KM]?$/, 'total net gp toward goal');
  // the total net: what the bank makes of it before rounding up (the 700 prayer
  // potions under From your bank) plus the net after buying supplies
  const netTip = await page.locator('tr[data-method="hb_3doseprayerrestore"] td').nth(13).getAttribute('title');
  assert.equal(netTip, `Gross from banked supplies ${row[7]} + net after buying supplies ${row[12]}`);
  // one item's own net, in the row's tooltip: a loss is a net below zero
  const rowTip = await page.locator('tr[data-method="hb_3doseprayerrestore"]').getAttribute('title');
  assert.match(rowTip, new RegExp(`Costs [\\d.,]+[KM]?, worth [\\d.,]+[KM]?: net ${row[4].replace(/[+.]/g, '\\$&')} each$`), rowTip);
  // Gross and Net only: the word profit is gone, tooltips included
  assert.doesNotMatch(await page.content(), /profit/i);
  // sort by Total net, after Cheapest XP: most gp toward the goal first
  const sorts = await page.locator('.goal >> nth=0 >> [data-tsort-plan]').allInnerTexts();
  assert.deepEqual(sorts.map(t => t.trim()), ['Level', 'XP each', 'Cheapest XP', 'Total net']);
  await page.click('.goal >> nth=0 >> [data-tsort-plan="net"]');
  const gp = t => {
    const m = t.replace(/,/g, '').match(/^([+−-]?)([\d.]+)([KMB]?)$/);
    if (!m) return null;
    const v = parseFloat(m[2]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[3]] || 1);
    return m[1] === '−' || m[1] === '-' ? -v : v;
  };
  const nets = (await page.locator('.goal >> nth=0 >> tr[data-method]').allInnerTexts()).map(t => gp(t.split('\t')[13].trim()));
  const known = nets.filter(v => v != null);
  assert.ok(known.length > 5, nets.join(' '));
  assert.deepEqual(known, [...known].sort((a, b) => b - a), 'most first');
  assert.deepEqual(nets.slice(0, known.length), known, 'rows without a total go last');
  assert.equal(await page.locator('.goal >> nth=0 >> [data-tsort-plan="net"].on').count(), 1);
  await page.click('.goal >> nth=0 >> [data-tsort-plan="level"]');
});

await check('goals: Round up my supplies shows your bank with nothing left over, in place of the plan as it is', async () => {
  await setBank('herblore', { kwuarm: '605', limpwurt_root: '518' });
  await page.click('.tab[data-tab="goals"]');
  const goal = page.locator('.goal').first();
  const sec = goal.locator('.plan-sec').first();
  const flat = t => t.replace(/\s+/g, ' ').trim();
  await goal.locator('.step', { hasText: '518 × Super strength' }).waitFor();
  assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +126,000 XP → level 75');
  assert.equal(await goal.locator('.tip', { hasText: 'Tip: collect' }).count(), 1, 'the tip for the potion you train with');
  const box = goal.locator('input[data-gopt="roundUp"]');
  assert.equal(await box.isChecked(), false, 'off until you ask');
  // it sits right after Use my bank, before the other tick boxes
  assert.match(flat(await goal.locator('.plan-opts').innerText()), /^Use my bank Round up my supplies I'll buy vials of water as I go /);
  assert.match(await goal.locator('label:has(input[data-gopt="roundUp"])').getAttribute('title'), /^Off, the plan uses your bank as it is\. On, your supplies are rounded up/);
  await box.check();
  await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
  // One or the other: on, the plan is the rounded-up one alone. 1,000 prayer potions and 605 super
  // strength, where the bank as it is makes 700 and 518. (Prayer potions are the ones picked to train with, so they come first.)
  assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank, supplies rounded up +163,125 XP → level 76');
  const steps = (await sec.locator('.step').allInnerTexts()).map(flat);
  assert.equal(steps.length, 2, steps.join(' / '));
  assert.match(steps[0], /^1,000 × Prayer potion \+87,500 XP .*incl\. 1,000 × Ranarr potion \(unf\) collect 300 Snape grass$/);
  assert.match(steps[1], /^605 × Super strength \+75,625 XP .*incl\. 605 × Kwuarm potion \(unf\) collect 87 Limpwurt root$/);
  assert.doesNotMatch(flat(await sec.innerText()), /as it is|518 ×|700 ×/, 'not side by side with the plan as it is');
  assert.match(flat(await sec.locator('.collect').innerText()), /^To round up your supplies, collect: 300 Snape grass \([\d.,]+[KM]?\) 87 Limpwurt root \([\d.,]+[KM]?\)$/);
  const money = flat(await sec.locator('.money').innerText());
  assert.match(money, /^Gross: \+[\d.,]+[KM]? gp Rounding up your supplies: [\d.,]+[KM]? gp Net: [+−][\d.,]+[KM]? gp \(your banked supplies are already yours\)$/);
  // the rest of the goal comes after it, and the tip it replaces is gone
  assert.equal(await goal.locator('.tip', { hasText: 'Tip: collect' }).count(), 0);
  assert.match(await goalText(), /Then, to reach your goal: 270,048 XP/, '433,173 XP to go, less 163,125');
  // the table: each row on its own is as it was; the bank part of the totals is the rounded-up one
  const head = flat(await goal.locator('.plan-t thead').innerText());
  assert.match(head, /From bank Net from bank, supplies rounded up Round up my supplies Net after rounding up my supplies Still needed to goal/);
  assert.doesNotMatch(head, /Gross from/);
  const cellsOf = async id => (await goal.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
  const ss = await cellsOf('hb_3dose2strength');
  assert.equal(ss[6], '518', 'From bank');
  assert.match(ss[8], /^87\s*→\s*605$/, 'Round up my supplies');
  assert.equal(ss[7], ss[9], 'net from bank, supplies rounded up: 605 less 87 limpwurt, the same as its Net after rounding up my supplies');
  assert.match(await goal.locator('tr[data-method="hb_3dose2strength"] td').nth(7).getAttribute('title'),
    /^Your bank plan, with your supplies rounded up, makes 605 × Super strength: worth [\d.,]+[KM]?, less [\d.,]+[KM]? to collect\. Your banked supplies are yours already\.$/);
  assert.equal(await goal.locator('tr[data-method="hb_3dose2strength"] td').nth(13).getAttribute('title'),
    `Net from bank, supplies rounded up ${ss[7]} + net after buying supplies ${ss[12]}`);
  assert.match(flat(await goal.locator('.plan-sec').last().locator('.small-note').last().innerText()), /^Round up my supplies is on: the plan above is your bank with its supplies rounded up/);
  await page.screenshot({ path: `${SHOTS}/10e-round-up.png`, fullPage: true });
  // it's kept with the goal
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.goals.demo_main'))[0].roundUp), true);
  await page.click('.tab[data-tab="bank"]');
  await page.click('.tab[data-tab="goals"]');
  assert.equal(await goal.locator('input[data-gopt="roundUp"]').isChecked(), true);
  // with the bank left out there's nothing to round up: the tick box goes, and comes back ticked
  await goal.locator('input[data-gopt="useBank"]').uncheck();
  await page.waitForFunction(() => !/From your bank/.test(document.querySelector('.goal').innerText));
  assert.equal(await goal.locator('input[data-gopt="roundUp"]').count(), 0);
  await goal.locator('input[data-gopt="useBank"]').check();
  await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
  // off again: the plan as it is
  await goal.locator('input[data-gopt="roundUp"]').uncheck();
  await goal.locator('.step', { hasText: '518 × Super strength' }).waitFor();
  assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +126,000 XP → level 75');
  assert.match(flat(await goal.locator('.plan-t thead').innerText()), /From bank Gross from banked supplies Round up my supplies/);
  await setBank('herblore', { kwuarm: '', limpwurt_root: '' });
  await page.click('.tab[data-tab="goals"]');
});

await check('goals: rounded up, vials you count never hold a potion back; the ones you are short of are collected too', async () => {
  // 600 vials for 1,605 potions' worth of herbs
  await setBank('herblore', { kwuarm: '605', limpwurt_root: '518', vial_water: '600' });
  await page.click('.tab[data-tab="goals"]');
  const goal = page.locator('.goal').first();
  const sec = goal.locator('.plan-sec').first();
  const flat = t => t.replace(/\s+/g, ' ').trim();
  await goal.locator('.step', { hasText: '518 × Super strength' }).waitFor();
  assert.match(await goal.locator('label:has(input[data-gopt="roundUp"])').getAttribute('title'),
    /what to collect for it\. Vials of water never hold it back: what you're short of is collected too\.$/);
  // counted, and as it is: the vials run out during the prayer potions (picked, so they go first)
  await goal.locator('input[data-gopt="assume"]').uncheck();
  await goal.locator('.step', { hasText: '600 × Prayer potion' }).waitFor();
  assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +52,500 XP → level 75');
  assert.equal(await sec.locator('.step').count(), 1, 'no vials left for the super strength');
  // each row on its own: 600 vials make 518 super strength, and rounding up to 605 takes 5 more
  const cellsOf = async id => (await goal.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
  let ss = await cellsOf('hb_3dose2strength');
  assert.equal(ss[6], '518', 'From bank');
  assert.match(ss[8], /^87\s*5\s*→\s*605$/, 'Round up my supplies: 87 limpwurt root, and 5 vials');
  assert.equal(await goal.locator('tr[data-method="hb_3dose2strength"] td.even').getAttribute('title'),
    'Collect 87 Limpwurt root and 5 Vial of water, and your bank covers 605 × Super strength instead of 518.');
  const pp = await cellsOf('hb_3doseprayerrestore');
  assert.equal(pp[6], '600', 'From bank: the vials hold it back');
  assert.match(pp[8], /^300\s*400\s*→\s*1,000$/, 'Round up my supplies: 300 snape grass, and 400 vials');
  // rounded up: the potions you'd get buying vials as you go, all 605 super strength among them
  // (v2.5.0 left the 87 kwuarm over: with no vials left, they didn't count)
  await goal.locator('input[data-gopt="roundUp"]').check();
  await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
  assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank, supplies rounded up +163,125 XP → level 76');
  let steps = (await sec.locator('.step').allInnerTexts()).map(flat);
  assert.equal(steps.length, 2, steps.join(' / '));
  assert.match(steps[0], /^1,000 × Prayer potion \+87,500 XP .*incl\. 1,000 × Ranarr potion \(unf\) collect 300 Snape grass 400 Vial of water$/);
  assert.match(steps[1], /^605 × Super strength \+75,625 XP .*incl\. 605 × Kwuarm potion \(unf\) collect 87 Limpwurt root 605 Vial of water$/);
  assert.match(flat(await sec.locator('.collect').innerText()),
    /^To round up your supplies, collect: 300 Snape grass \([\d.,]+[KM]?\) 87 Limpwurt root \([\d.,]+[KM]?\) 1,005 Vial of water( \([\d.,]+[KM]?\))?$/, 'vials last');
  assert.equal(await sec.locator('.tip', { hasText: 'Also uses' }).count(), 0, 'collected, not bought as you go');
  assert.match(await goalText(), /Then, to reach your goal: 270,048 XP/);
  await page.screenshot({ path: `${SHOTS}/10f-round-up-vials-counted.png`, fullPage: true });
  // bought as you go: the same potions, and the vials leave the lists
  await goal.locator('input[data-gopt="assume"]').check();
  await page.waitForFunction(() => !/Vial of water \(/.test(document.querySelector('.goal .plan-sec .collect').innerText));
  assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank, supplies rounded up +163,125 XP → level 76');
  steps = (await sec.locator('.step').allInnerTexts()).map(flat);
  assert.match(steps[0], /^1,000 × Prayer potion \+87,500 XP .*collect 300 Snape grass$/);
  assert.match(steps[1], /^605 × Super strength \+75,625 XP .*collect 87 Limpwurt root$/);
  assert.match(flat(await sec.locator('.tip', { hasText: 'Also uses' }).innerText()), /^Also uses 1,005 Vial of water that isn't in your bank: you'll buy it as you go\.$/);
  await goal.locator('input[data-gopt="roundUp"]').uncheck();
  await goal.locator('.step', { hasText: '518 × Super strength' }).waitFor();
  await setBank('herblore', { kwuarm: '', limpwurt_root: '', vial_water: '' });
  await page.click('.tab[data-tab="goals"]');
});

await check('goals: a rank goal looks up who holds that rank', async () => {
  await page.click('[data-nskill="herblore"]');
  await page.click('[data-ntype="rank"]');
  await page.fill('#goal-new input[name=value]', '500');
  await page.click('#goal-new button[type=submit]');
  await page.waitForFunction(() => /beat .+ \(rank 500, checked/.test(document.querySelectorAll('.goal')[1]?.innerText || ''), null, { timeout: 15000 });
  assert.match(await page.locator('.goal').nth(1).innerText(), /Rank 568 → 500/);
});

await check('lookup tiles show the goal of the planned account', async () => {
  await page.click('.tab[data-tab="lookup"]');
  await page.fill('#lookup-name', 'demo main');
  await page.click('#lookup-form button');
  await page.waitForSelector('#tiles-grid .tile[data-id="16"] .goal-line', { timeout: 15000 });
  assert.match(await text('#tiles-grid .tile[data-id="16"] .goal-line'), /Goal 78 · 433K XP to go/);
  // and the tile's bar is the goal's, in place of the one to the next level: nothing gained since it was set
  const bars = await page.locator('#tiles-grid .tile[data-id="16"] .pbar').evaluateAll(els => els.map(e => [e.className, e.title, e.firstElementChild.style.width]));
  assert.deepEqual(bars, [['pbar goal-bar', '0.0% of the way to your goal since you set it (433,173 XP to go)', '0%']]);
  assert.match(await text('#tiles-grid .tile[data-id="16"]'), /Next: [\d,]+ XP\s*Goal 78/, 'the bar sits between the next level and the goal line');
  assert.match(await page.locator('#tiles-grid .tile[data-id="1"] .pbar').getAttribute('title'), /XP to level \d+/, 'no goal in Attack: its bar is still the next level');
  assert.equal(await page.locator('#tiles-grid .tile[data-id="1"] .pbar.goal-bar').count(), 0);
  // 10,000 XP into the goal: the bar moves (the goal remembers where it started)
  await page.evaluate(() => { const k = 'lchs.goals.demo_main'; const g = JSON.parse(localStorage.getItem(k)); g[0].startXp10 -= 100000; localStorage.setItem(k, JSON.stringify(g)); });
  await page.click('#lookup-form button');
  await page.waitForFunction(() => document.querySelector('#tiles-grid .tile[data-id="16"] .pbar.goal-bar')?.title.startsWith('2.3%'), null, { timeout: 15000 });
  assert.equal(await page.locator('#tiles-grid .tile[data-id="16"] .pbar.goal-bar > div').evaluate(el => el.style.width), '2.3%', '10,000 of 443,173');
  await page.evaluate(() => { const k = 'lchs.goals.demo_main'; const g = JSON.parse(localStorage.getItem(k)); g[0].startXp10 += 100000; localStorage.setItem(k, JSON.stringify(g)); });
  await page.fill('#lookup-name', 'old badger');
  await page.click('#lookup-form button');
  await page.waitForFunction(() => document.querySelector('.pc-name')?.innerText.includes('Old Badger'), null, { timeout: 15000 });
  assert.equal(await page.locator('.goal-line').count(), 0, "another player's tiles have no goal lines");
});

await check('goals: move up and down, and filter by status and skill', async () => {
  await page.click('.tab[data-tab="goals"]');
  await page.click('[data-nskill="woodcutting"]');
  await page.click('[data-ntype="level"]');
  await page.fill('#goal-new input[name=value]', '94');
  await page.click('#goal-new button[type=submit]');
  const order = () => page.$$eval('.goal', els => els.map(e => e.querySelector('.goal-name').innerText + ' ' + e.querySelector('.goal-title').innerText.split('→')[1].trim()));
  await page.waitForFunction(() => document.querySelectorAll('.goal').length === 3);
  assert.deepEqual(await order(), ['Herblore 78', 'Herblore 500', 'Woodcutting 94']);
  assert.equal(await page.locator('.goal').first().locator('[data-act="goal-up"]').isDisabled(), true, 'the first goal cannot go up');
  await page.locator('.goal').first().locator('[data-act="goal-down"]').click();
  assert.deepEqual(await order(), ['Herblore 500', 'Herblore 78', 'Woodcutting 94']);
  await page.locator('.goal').nth(2).locator('[data-act="goal-up"]').click();
  assert.deepEqual(await order(), ['Herblore 500', 'Woodcutting 94', 'Herblore 78']);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.goals.demo_main')).map(g => g.skill + ' ' + g.value));
  assert.deepEqual(stored, ['herblore 500', 'woodcutting 94', 'herblore 78'], 'the order is saved');
  // only one skill, and moving within that view skips the goals it hides
  await page.click('.goal-filter [data-gonly="herblore"]');
  assert.deepEqual(await order(), ['Herblore 500', 'Herblore 78']);
  await page.locator('.goal').nth(1).locator('[data-act="goal-up"]').click();
  assert.deepEqual(await order(), ['Herblore 78', 'Herblore 500']);
  await page.click('.goal-filter [data-gonly="herblore"]');
  assert.deepEqual(await order(), ['Herblore 78', 'Herblore 500', 'Woodcutting 94']);
  await page.click('[data-gshow="done"]');
  assert.equal(await page.locator('.goal').count(), 0);
  assert.match(await text('#goals-list'), /No goals match/);
  await page.click('[data-act="show-all-goals"]');
  assert.equal(await page.locator('.goal').count(), 3);
  assert.match(await text('.goal-filter'), /In progress\s*3/);
});

await check('bank: unid herbs are one entry, and older per-herb amounts are folded into it', async () => {
  await page.evaluate(() => {           // a bank saved by v2.0.0, one kind of unid at a time
    const b = JSON.parse(localStorage.getItem('lchs.bank.demo_main'));
    Object.assign(b.items, { unidentified_ranarr: 40, unidentified_torstol: 2 });
    localStorage.setItem('lchs.bank.demo_main', JSON.stringify(b));
  });
  await page.click('.tab[data-tab="bank"]');
  await page.waitForSelector('[data-bank="unidentified_guam"]');
  assert.equal(await page.inputValue('[data-bank="unidentified_guam"]'), '42');
  assert.equal(await page.locator('[data-bank^="unidentified_"]').count(), 1, 'one unid entry');
  assert.doesNotMatch(await text('#bank-body'), /Unidentified herbs/);
  const items = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.bank.demo_main')).items);
  assert.equal(items.unidentified_guam, 42);
  assert.equal(items.unidentified_ranarr, undefined);
  await page.click('.tab[data-tab="goals"]');
  await page.waitForFunction(() => /You also have\s*42\s*unid herbs\. Identify them first/.test(document.querySelector('.goal').innerText));
});

await check('runecraft: essence in the bank, runes per essence at your level, and a plan', async () => {
  await page.click('.tab[data-tab="bank"]');
  await page.click('[data-bskill="runecraft"]');
  await page.waitForSelector('[data-bank="blankrune"]');
  assert.match(await text('#bank-head'), /pure essence came later/);
  await page.fill('[data-bank="blankrune"]', '5k');
  await page.press('[data-bank="blankrune"]', 'Tab');
  await page.click('.tab[data-tab="goals"]');
  await page.click('[data-nskill="runecraft"]');
  await page.click('[data-ntype="level"]');
  await page.fill('#goal-new input[name=value]', '75');
  await page.click('#goal-new button[type=submit]');
  const card = page.locator('.goal', { hasText: 'Runecraft' });
  await card.locator('.plan').waitFor();
  const t = await card.innerText();
  assert.match(t, /Level 69 → 75/);
  assert.match(t, /5,000 essence → 5,000 Law runes \+47,500 XP/, 'best XP at 69 is law runes, one per essence');
  assert.match(t, /To collect or buy:[\s\S]*Rune essence/);
  const air = await card.locator('tr[data-method="rc_airrune"]').innerText();
  assert.match(air, /Air rune\s*×7/, '7 air runes per essence at 69');
  await card.locator('tr[data-method="rc_naturerune"] td:nth-child(2)').click();
  await page.waitForFunction(() => /5,000 essence → 5,000 Nature runes/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Runecraft'))?.innerText || ''));
  assert.match(await card.locator('.plan-t thead').innerText(), /Rune/);
  assert.doesNotMatch(await card.locator('.plan-t thead').innerText(), /round/i, 'essence alone has nothing to round up: neither of those columns');
  // the bank link on a Runecraft plan opens the Runecraft bank
  await card.locator('[data-act="to-bank"]').first().click();
  await page.waitForSelector('[data-bskill="runecraft"].active');
  await page.click('[data-bskill="herblore"]');
  await page.click('.tab[data-tab="goals"]');
});

const cardText = skill => page.evaluate(s => [...document.querySelectorAll('.goal')].find(g => g.querySelector('.goal-name')?.innerText === s)?.innerText || '', skill);
async function addGoal(skill, level) {
  await page.click('.tab[data-tab="goals"]');
  await page.click(`[data-nskill="${skill}"]`);
  await page.click('[data-ntype="level"]');
  await page.fill('#goal-new input[name=value]', String(level));
  await page.click('#goal-new button[type=submit]');
}
async function setBank(skill, amounts) {
  await page.click('.tab[data-tab="bank"]');
  await page.click(`[data-bskill="${skill}"]`);
  for (const [item, n] of Object.entries(amounts)) {
    await page.fill(`[data-bank="${item}"]`, n);
    await page.press(`[data-bank="${item}"]`, 'Tab');
  }
}
// Plans for another account (its XP comes from the hiscores; its goals and bank are its own).
async function planAs(name, shown) {
  await page.click('.tab[data-tab="goals"]');
  await page.fill('#plan-account input[name=account]', name);
  await page.click('#plan-account button[type=submit]');
  await page.waitForFunction(n => document.querySelector('#plan-account input[name=account]')?.value === n
    && document.querySelector('#plan-account').innerText.includes('XP from the hiscores'), shown, { timeout: 15000 });
}
const flat = t => t.replace(/\s+/g, ' ').trim();
// Takes a goal off the list (its ✕ asks twice), if it's there.
async function removeGoal(card) {
  await page.click('.tab[data-tab="goals"]');
  if (!(await card.count())) return;
  await card.locator('[data-act="remove-goal"]').click();
  await card.locator('[data-act="remove-goal"]').click();
}

await check('woodcutting: no bank, logs to chop and what they are worth', async () => {
  await addGoal('woodcutting', 95);           // (a Woodcutting 94 goal is there from the move test)
  const card = page.locator('.goal', { hasText: 'Level 93 → 95' });
  await card.locator('.plan').waitFor();
  const t = await card.innerText();
  assert.match(t, /Level 93 → 95/);
  assert.match(t, /any axe works at any level\), so this plan doesn't use your bank/);
  assert.doesNotMatch(t, /From your bank|Use my bank|To collect or buy|Buying it all/);
  assert.match(t, /To reach your goal: 1,555,040 XP/);
  assert.match(t, /6,221 × Magic logs \+1,555,250 XP/, 'most XP per log at 93');
  assert.match(t, /What you make is worth/);
  assert.equal(await card.locator('.plan-t thead th').count(), 7, 'no bank columns, but Plan to make');
  assert.deepEqual(await card.locator('tr.grp').first().locator('td').evaluateAll(tds => tds.map(td => td.colSpan)), [1, 6], 'the group\'s name starts above the logs\' names');
  assert.match(t, /Plan a mix of ways to train/);
  await card.locator('tr[data-method="wc_willow_logs"] td:nth-child(2)').click();
  await page.waitForFunction(() => /23,038 × Willow logs/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Level 93 → 95'))?.innerText || ''));
  await page.screenshot({ path: `${SHOTS}/10a-woodcutting.png`, fullPage: false });
});

await check('fletching: bows cut and strung from the bank, darts, and the table a group at a time', async () => {
  await setBank('fletching', { yew_logs: '1000', bow_string: '600', feather: '2k', rune_dart_tip: '500' });
  assert.match(await text('#bank-head'), /Unstrung bows are marked \(u\)/);
  assert.equal(await page.locator('#bank-head [data-bskill="woodcutting"]').count(), 0, 'no Woodcutting bank');
  await addGoal('fletching', 92);
  const card = page.locator('.goal', { hasText: 'Fletching' });
  await card.locator('.plan').waitFor();
  const t = await cardText('Fletching');
  assert.match(t, /Level 89 → 92/);
  assert.match(t, /From your bank \+129,400 XP/);
  assert.match(t, /600 × Yew longbow \(cut & string\) \+90,000 XP/);
  assert.match(t, /400 × Yew longbow \(u\) \+30,000 XP/);
  assert.match(t, /500 × Rune dart \+9,400 XP/);
  assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'fl_cs_yew_longbow', 'carries on with the bank\'s bows');
  assert.match(t, /9,962 × Yew longbow \(cut & string\)/);
  assert.match(t, /Also bring:\s*Knife/);
  assert.match(t, /Tip: collect[\s\S]*400[\s\S]*Bow string[\s\S]*makes\s+1,000\s+Yew longbow \(cut & string\) instead of 600/);
  assert.match(await card.locator('tr[data-method="fl_cs_yew_longbow"] td.even').innerText(), /^\s*400\s*→\s*1,000\s*$/, 'round up: 400 bow strings');
  assert.equal(await card.locator('select[data-gopt="fill"] optgroup').count(), 7);
  // Round up my supplies: one plan or the other. On, the 1,500 feathers left over take 1,500 rune
  // dart tips (2,000 darts in all), and the 400 bows that were only cut take 400 bow strings.
  const flat = s => s.replace(/\s+/g, ' ').trim();
  const sec = card.locator('.plan-sec').first();
  const own = (await sec.locator('.step').allInnerTexts()).map(flat);
  assert.equal(own.length, 3, own.join(' / '));
  assert.match(flat(await card.locator('.plan-opts').innerText()), /^Use my bank Round up my supplies /);
  await card.locator('input[data-gopt="roundUp"]').check();
  await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
  assert.match(flat(await sec.locator('h4').innerText()), /^From your bank, supplies rounded up \+187,600 XP → level \d+$/);
  const rounded = (await sec.locator('.step').allInnerTexts()).map(flat);
  assert.equal(rounded.length, 4, rounded.join(' / '));
  assert.deepEqual(rounded.slice(0, 2), own.slice(0, 2), 'the bows the bank cuts and strings are as they were');
  assert.match(rounded[2], /^2,000 × Rune dart \+37,600 XP .*collect 1,500 Rune dart tip$/);
  assert.match(rounded[3], /^400 × Yew longbow \(string\) \+30,000 XP .*collect 400 Bow string$/);
  assert.match(flat(await sec.locator('.collect').innerText()), /^To round up your supplies, collect: 1,500 Rune dart tip( \([\d.,]+[KM]?\))? 400 Bow string( \([\d.,]+[KM]?\))?$/);
  await page.screenshot({ path: `${SHOTS}/10b-fletching-round-up.png`, fullPage: true });
  await card.locator('input[data-gopt="roundUp"]').uncheck();
  await sec.locator('.step', { hasText: '500 × Rune dart' }).waitFor();
  assert.match(flat(await sec.locator('h4').innerText()), /^From your bank \+129,400 XP → level \d+$/);
  // the table shows one group at a time: the one you train with, until you pick
  assert.equal(await card.locator('.group-pick .chip.on').innerText(), 'Bows');
  assert.equal(await card.locator('tr[data-method]').count(), 12);
  await card.locator('[data-tgroup="Darts"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.goal .plan-t tr[data-method^="fl_dart"]').length === 6);
  assert.match(await card.locator('tr[data-method="fl_dart_rune_dart"]').innerText(), /81\s+Rune dart\s+18\.8\s+\S+\s+\S+\s+500\s/);
  await card.locator('[data-tgroup="all"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.goal .plan-t tr[data-method^="fl_"]').length === 63);
  await card.locator('tr[data-method="fl_logs_bronze_arrow"] td:nth-child(2)').click();
  await page.waitForFunction(() => /logs → [\d,]+ Bronze arrows/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Fletching'))?.innerText || ''));
  assert.match(await card.locator('tr[data-method="fl_logs_bronze_arrow"]').innerText(), /per log/);
  await page.screenshot({ path: `${SHOTS}/10b-fletching.png`, fullPage: true });
  await card.locator('[data-tgroup="Bows"]').click();
  await card.locator('select[data-gopt="fill"]').selectOption('fl_cs_yew_longbow');
});

await check('crafting: the calculator\'s four tabs, gems cut and glass made on the way, dragonhide and thread', async () => {
  const BANK = { gold_bar: '500', uncut_sapphire: '300', wool: '200', bucket_sand: '200', soda_ash: '150', dragonhide_green: '300', dragon_leather: '50' };
  await setBank('crafting', BANK);
  assert.match(await text('#bank-head'), /Hides are tanned before they're worked[\s\S]*The tanner's fee is counted[\s\S]*Key halves and crystal keys count as the uncut dragonstone/);
  assert.deepEqual((await page.locator('#bank-body .bank-group h4').allInnerTexts()).map(t => t.trim()),
    ['Leather and thread', 'Dragonhide', 'Gems', 'Crystal keys', 'Bars, wool and flax', 'Clay, sand and glass', 'Orbs and battlestaves', 'Runes for enchanting', 'Made: leather', 'Made: jewellery', 'Made: enchanted jewellery', 'Made: pottery, glass and staves']);
  assert.equal(await page.locator('#bank-body [data-slug^="set_"]').count(), 0, 'the market\'s sets aren\'t items in the game, so not in a bank');
  assert.match(await page.locator('#bank-body [data-slug="dragonhide_blue"]').innerText(), /Dragonhide \(blue\)/);
  assert.match(await page.locator('#bank-body [data-slug="unstrung_gold_amulet"]').innerText(), /Gold amulet \(u\)/);
  await addGoal('crafting', 95);
  const card = page.locator('.goal', { hasText: 'Crafting' });
  await card.locator('.plan').waitFor();
  assert.equal(await card.locator('input[data-gopt="roundUp"]').count(), 1, 'Round up my supplies is offered');
  assert.match((await card.locator('.plan-opts').innerText()).replace(/\s+/g, ' '), /^Use my bank Round up my supplies I'll buy thread as I go Tanner Al Kharid \(20 gp a dragonhide\) ?Canifis \(45 gp a dragonhide\)/);
  const t = await cardText('Crafting');
  assert.match(t, /Level 88 → 95/);
  assert.match(t, /I'll buy thread as I go/);
  // what the bank makes, with the steps on the way and their XP
  assert.match(t, /58 × Green d'hide set \(vambraces, chaps & body\) \+21,576 XP[^\n]*\s*incl\. 298 × Tan dragonhide \(green\)\n/, 'hides are tanned on the way, for no XP; 348 of them are 58 sets');
  assert.match(t, /1 × Dragonhide chaps \(green\) \+124 XP/, 'and the two hides left over');
  assert.match(t, /200 × Sapphire amulet \(make & string\) \+24,300 XP[^\n]*\s*incl\. 200 × Sapphire \(cut\) \+10,000 XP, 200 × Ball of wool \+500 XP/);
  assert.match(t, /100 × Sapphire amulet \(u\) \+11,500 XP[^\n]*\s*incl\. 100 × Sapphire \(cut\) \+5,000 XP/);
  assert.match(t, /150 × Unpowered orb \+10,875 XP[^\n]*\s*incl\. 150 × Molten glass \+3,000 XP/);
  assert.match(t, /200 × Gold amulet \(u\) \+6,000 XP/);
  assert.match(t, /From your bank \+74,375 XP/);
  // the tanner's fee for the 300 hides comes off the gross
  assert.match(t, /Gross: (\+[\d.,]+[KM]?|\?) gp\s*Tanner \(Al Kharid\): 6,000 gp/);
  assert.match(t, /Also uses\s*35\s*Thread\s*that isn't in your bank: you'll buy it as you go/, '175 items, a reel for every five');
  assert.match(t, /Also bring:\s*Amulet mould/);
  // the table: the calculator's tabs, one at a time, the one you train with first
  assert.deepEqual((await card.locator('.group-pick .chip').allInnerTexts()).map(x => x.trim()), ['Needle & thread', 'Jewellery', 'Pottery & glass', 'Spinning', 'All']);
  assert.equal((await card.locator('.group-pick .chip.on').innerText()).trim(), 'Jewellery');
  assert.equal(await card.locator('tr[data-method]').count(), 46, 'the calculator\'s 35, and the 11 enchanted ones');
  const head = await card.locator('.plan-t thead').innerText();
  assert.match(head.trim(), /^Use\s*Lvl\s*Item\s*XP\s*Net\/item\s*gp\/XP\s*From bank\s*Gross from\s*banked supplies\s*Round up\s*my supplies\s*Net after rounding\s*up my supplies\s*Still needed\s*to goal\s*Supplies needed\s*Net after\s*buying supplies\s*Total net gp\s*toward goal$/);
  assert.deepEqual(await card.locator('tr.grp').first().locator('td').evaluateAll(tds => tds.map(td => [td.colSpan, td.innerText.trim()])), [[2, ''], [12, 'Jewellery']]);
  const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
  const ring = await cells('cr_sapphire_ring');
  assert.deepEqual([ring[1], ring[2], ring[3], ring[6]], ['20', 'Sapphire ring', '40', '300'], 'from bank: 300 uncut sapphires count, cut on the way');
  assert.match(ring[8], /^200\s*→\s*500$/, 'round up: 200 more sapphires for the 500 gold bars');
  assert.match(ring[11], /^([\d,]+)\s*\1$/, 'supplies: a gold bar and a cut sapphire each, as the calculator lists them');
  assert.deepEqual((await cells('cr_sapphire_necklace')).slice(1, 4), ['20', 'Sapphire necklace', '55'], 'level 20, as the server has it');
  // the enchanted one, for what it sells as: the same Crafting XP, and the runes in its supplies
  const games = await cells('cr_ench_necklace_of_minigames_8');
  assert.deepEqual(games.slice(1, 4), ['20', 'Games necklace(8) (make & enchant)', '55']);
  assert.match(games[11], /^([\d,]+)\s*\1\s*\1\s*\1$/, 'a gold bar, a sapphire, a water rune and a cosmic rune each');
  assert.match(await card.locator('tr[data-method="cr_ench_necklace_of_minigames_8"]').getAttribute('title'),
    /Needs \(from scratch\): 1 Gold bar, 1 Sapphire, 1 Water rune, 1 Cosmic rune\nTools: Necklace mould\nEnchanted with Lvl-1 Enchant \(Magic 7\): 17\.5 Magic XP each, on top of the Crafting XP\./);
  assert.match(await card.locator('tr[data-method="cr_ench_amulet_of_glory_4"]').getAttribute('title'),
    /Amulet of glory\(4\) \(make, string & enchant\): level 80, 154 XP each \(make 150 \+ string 4\)\nNeeds \(from scratch\): 1 Gold bar, 1 Dragonstone, 1 Ball of wool, 15 Earth rune, 15 Water rune, 1 Cosmic rune\nTools: Amulet mould\nEnchanted with Lvl-5 Enchant \(Magic 68\): 78 Magic XP each, on top of the Crafting XP\. Then charged at the Fountain of Heroes\./);
  assert.match(await card.locator('tr[data-method="cr_strung_sapphire_amulet"]').getAttribute('title'), /level 24, 69 XP each \(make 65 \+ string 4\)\nNeeds \(from scratch\): 1 Gold bar, 1 Sapphire, 1 Ball of wool\nTools: Amulet mould/);
  // key halves and crystal keys: 9 teeth and 4 loops are 4 uncut dragonstones for now, and 5 loops round them up to 9
  await setBank('crafting', { keyhalf1: '9', keyhalf2: '4' });
  assert.match(await page.locator('#bank-body [data-slug="keyhalf1"]').innerText(), /Half of a key \(tooth\)/);
  assert.match(await page.locator('#bank-body [data-slug="keyhalf2"]').innerText(), /Half of a key \(loop\)/);
  await page.click('.tab[data-tab="goals"]');
  await card.locator('.step', { hasText: 'Join key halves' }).waitFor();
  assert.match(await cardText('Crafting'), /4 × Dragonstoneamulet \(make & string\) \+1,176 XP[^\n]*\s*incl\. 4 × Join key halves, 4 × Open the crystal chest, 4 × Dragonstone \(cut\) \+550 XP, 4 × Ball of wool \+10 XP/,
    'the halves are joined, the chest opened, the stones cut and strung on amulets: all on the way');
  const stone = await cells('cr_dragonstone');
  assert.equal(stone[6], '4', 'from bank: the 4 keys the halves make');
  assert.match(stone[8], /^5\s*→\s*9$/, 'round up: 5 more loops');
  assert.equal(await card.locator('tr[data-method="cr_dragonstone"] td.even').getAttribute('title'), 'Collect 5 Half of a key (loop), and your bank covers 9 × Dragonstone (cut) instead of 4.');
  assert.match(await card.locator('tr[data-method="cr_dragonstone"]').getAttribute('title'), /Needs \(from scratch\): 1 Uncut dragonstone\n/, 'bought as the uncut stone, like the calculator lists it');
  await setBank('crafting', { keyhalf1: '', keyhalf2: '' });
  await page.click('.tab[data-tab="goals"]');
  await card.locator('.step', { hasText: 'Gold amulet (u)' }).waitFor();
  await card.locator('[data-tgroup="all"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).querySelectorAll('.plan-t tr[data-method]').length === 88);
  await card.locator('[data-tgroup="Needle & thread"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).querySelectorAll('.plan-t tr[data-method]').length === 26);
  // a dragonhide set: the three pieces, which the market trades as one
  const set = await cells('cr_set_green_dhide');
  assert.deepEqual([set[1], set[2], set[3], set[6]], ['63', "Green d'hide set (vambraces, chaps & body)", '372', '58'], '350 hides and leather: 58 sets of six');
  assert.match(await card.locator('tr[data-method="cr_set_green_dhide"]').getAttribute('title'),
    /level 63, 372 XP each \(vambraces 62 \+ chaps 124 \+ body 186\)\nNeeds \(from scratch\): 6 Dragonhide \(green\), 120 Coins\nTools: Needle\nThe three pieces, which the market trades together as one set\./);
  // dragonhide: hides and leather both count; what to collect is the hide, as the calculator lists it, and the coins to tan it
  const body = await cells('cr_black_dragonhide_body');
  assert.deepEqual([body[1], body[2], body[3], body[6]], ['84', 'Dragonhide body (black)', '258', '0']);
  const [blackHides, blackCoins, ...noMore] = body[11].split(/\s+/).map(x => Number(x.replace(/,/g, '')));
  assert.deepEqual([blackCoins, noMore], [blackHides * 20, []], 'the hides and 20 coins each for the tanner: thread is bought as you go');
  assert.match(await card.locator('tr[data-method="cr_black_dragonhide_body"]').getAttribute('title'), /Needs \(from scratch\): 3 Dragonhide \(black\), 60 Coins\nTools: Needle/);
  assert.equal(await card.locator('tr[data-method="cr_black_dragonhide_body"] td').nth(11).locator('.it-chip').nth(1).getAttribute('title'), 'Coins: a fee paid on the way');
  assert.equal(await card.locator('tr[data-method="cr_black_dragonhide_body"] td').nth(11).locator('.it-chip .item').first().getAttribute('title'), 'Dragonhide (black)');
  assert.equal((await cells('cr_dragon_vambraces'))[6], '350', '300 hides and 50 leather');
  assert.match(await card.locator('tr[data-method="cr_leather_gloves"]').getAttribute('title'), /Needs \(from scratch\): 1 Leather\nTools: Needle/);
  await page.screenshot({ path: `${SHOTS}/10d-crafting.png`, fullPage: true });
  // thread counted: it's in the supplies, a reel for every five, and none in the bank means none made
  await card.locator('input[data-gopt="assume"]').uncheck();
  await page.waitForFunction(() => !/Thread is left out/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).innerText));
  const counted = await cells('cr_black_dragonhide_body');
  const [hides, coins, reels] = counted[11].split(/\s+/).map(x => Number(x.replace(/,/g, '')));
  assert.equal(reels, Math.ceil(hides / 3 / 5), `${hides} hides are ${hides / 3} bodies: ${reels} reels`);
  assert.equal(coins, hides * 20);
  assert.equal((await cells('cr_dragon_vambraces'))[6], '0', 'no thread in the bank');
  assert.match(await card.locator('tr[data-method="cr_leather_gloves"]').getAttribute('title'), /Needs \(from scratch\): 1 Leather, 0\.2 Thread/);
  await card.locator('input[data-gopt="assume"]').check();
  await page.waitForFunction(() => /Thread is left out: you'll buy it as you go/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).innerText));
  // the tanner in Canifis charges 45 a dragonhide: the fee, the costs and the supplies follow
  await card.locator('select[data-gopt="place"]').selectOption('canifis');
  await page.waitForFunction(() => /Tanner \(Canifis\): 13,500 gp/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).innerText));
  assert.match(await card.locator('tr[data-method="cr_black_dragonhide_body"]').getAttribute('title'), /Needs \(from scratch\): 3 Dragonhide \(black\), 135 Coins\n/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.goals.demo_main')).find(g => g.skill === 'crafting').place), 'canifis');
  await card.locator('select[data-gopt="place"]').selectOption('al_kharid');
  await page.waitForFunction(() => /Tanner \(Al Kharid\): 6,000 gp/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).innerText));
  // without the bank: a mix of your own; sapphires you cut go into the rings
  await card.locator('input[data-gopt="useBank"]').uncheck();
  await card.locator('[data-tgroup="Jewellery"]').click();
  await card.locator('[data-mix="cr_sapphire"]').fill('100');
  await card.locator('[data-mix="cr_sapphire"]').press('Tab');
  await card.locator('[data-mix="cr_sapphire_ring"]').fill('100');
  await card.locator('[data-mix="cr_sapphire_ring"]').press('Tab');
  await page.waitForFunction(() => /Your mix \+9,000 XP/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).innerText));
  const mix = await cardText('Crafting');
  assert.match(mix, /100 × Sapphire ring \+4,000 XP/);
  assert.match(mix, /100 × Sapphire \(cut\) \+5,000 XP/);
  const mixBuy = (await card.locator('.plan-sec', { hasText: 'Your mix' }).first().locator('.collect .it-chip').allInnerTexts()).map(x => x.replace(/\s+/g, ' ').trim());
  assert.equal(mixBuy.length, 2, mixBuy.join(' | '));
  assert.match(mixBuy[0], /^100 Gold bar/);
  assert.match(mixBuy[1], /^100 Uncut sapphire/, 'no cut sapphires to buy for the rings: the ones you cut go in');
  await card.locator('[data-act="mix-clear"]').click();
  await card.locator('input[data-gopt="useBank"]').check();
  await page.waitForFunction(() => /From your bank/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).innerText));
  // its prices: every item, by the bank's groups
  await page.click('.tab[data-tab="prices"]');
  await page.click('#prices-head [data-bskill="crafting"]');
  await page.waitForSelector('[data-price="dragonhide_green"]');
  assert.match(await text('#prices-body'), /Steel studs[\s\S]*Dragon leather \(black\)[\s\S]*Uncut dragonstone[\s\S]*Molten glass[\s\S]*Cosmic rune[\s\S]*Amulet of glory\(4\)[\s\S]*Air battlestaff[\s\S]*Dragonhide sets[\s\S]*Green d'hide set[\s\S]*Black d'hide set/);
  await page.waitForSelector('[data-price="set_red_dhide"]');
  // leave things as they were for the checks after this one
  await setBank('crafting', Object.fromEntries(Object.keys(BANK).map(k => [k, ''])));
  await page.click('.tab[data-tab="goals"]');
  await card.locator('[data-act="remove-goal"]').click();
  await card.locator('[data-act="remove-goal"]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.goal')].some(g => g.innerText.includes('Crafting')));
  await page.click('.tab[data-tab="prices"]');
  await page.click('#prices-head [data-bskill="herblore"]');
});

await check('crafting: orbs are charged on the way to battlestaves, runes are collected when rounding up, and the Magic XP is shown', async () => {
  const card = page.locator('.goal', { hasText: 'Crafting' });
  try {
    const flat = t => t.replace(/\s+/g, ' ').trim();
    await setBank('crafting', { molten_glass: '2000' });
    await addGoal('crafting', 95);
    const sec = card.locator('.plan-sec').first();
    await card.locator('.step', { hasText: '2,000 × Unpowered orb' }).waitFor();
    // as it is: the glass is blown into orbs, and that's all (no battlestaffs, no runes)
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +105,000 XP → level 88');
    assert.equal(await sec.locator('.step').count(), 1);
    assert.equal(await sec.locator('.tip.magic').count(), 0, 'nothing cast');
    await card.locator('[data-tgroup="Pottery & glass"]').click();
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
    const air = await cells('cr_air_battlestaff');
    assert.deepEqual([air[1], air[2], air[3], air[6]], ['66', 'Air battlestaff', '137.5', '0']);
    assert.match(air[8], /^2,000\s*60,000\s*6,000\s*→\s*2,000$/, 'round up: battlestaffs and the runes to charge the orbs');
    assert.equal(await card.locator('tr[data-method="cr_air_battlestaff"] td.even').getAttribute('title'),
      'Collect 2,000 Battlestaff, 60,000 Air rune and 6,000 Cosmic rune, and your bank covers 2,000 × Air battlestaff instead of 0.');
    assert.match(await card.locator('tr[data-method="cr_air_battlestaff"]').getAttribute('title'),
      /Air battlestaff: level 66, 137\.5 XP each\nNeeds \(from scratch\): 1 Unpowered orb, 30 Air rune, 3 Cosmic rune, 1 Battlestaff\nThe orb is an unpowered orb charged with Charge Air Orb \(Magic 66\): 76 Magic XP each\./);
    // the orbs in your bank count toward what's still needed: 2,000 fewer to buy than battlestaffs
    const [orbs, , , staffs] = air[11].split(/\s+/).map(x => Number(x.replace(/,/g, '')));
    assert.equal(staffs - orbs, 2000, air[11]);
    // rounded up: the orbs are charged and put on battlestaves, with the battlestaffs and runes to collect
    assert.match(await card.locator('label:has(input[data-gopt="roundUp"])').getAttribute('title'), /Thread, runes and balls of wool never hold it back: what you're short of is collected too\.$/);
    await card.locator('input[data-gopt="roundUp"]').check();
    await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank, supplies rounded up +380,000 XP → level 88');
    const steps = (await sec.locator('.step').allInnerTexts()).map(flat);
    assert.equal(steps.length, 2, steps.join(' / '));
    assert.match(steps[0], /^2,000 × Unpowered orb \+105,000 XP/);
    assert.match(steps[1], /^2,000 × Air battlestaff \+275,000 XP .*incl\. 2,000 × Charge air orb collect 2,000 Battlestaff 6,000 Cosmic rune 60,000 Air rune$/);
    assert.equal(flat(await sec.locator('.tip.magic').innerText()), 'Magic XP on the way: +152,000 XP from 2,000 × Charge Air Orb (Magic 66)');
    assert.match(flat(await sec.locator('.collect').innerText()), /^To round up your supplies, collect: 2,000 Battlestaff( \([\d.,]+[KM]?\))? 6,000 Cosmic rune( \([\d.,]+[KM]?\))? 60,000 Air rune( \([\d.,]+[KM]?\))?$/);
    await page.screenshot({ path: `${SHOTS}/10g-crafting-battlestaves.png`, fullPage: true });
    // the rest of the goal with air battlestaves: unpowered orbs and runes in the list, and its Magic XP
    await card.locator('select[data-gopt="fill"]').selectOption('cr_air_battlestaff');
    const then = card.locator('.plan-sec', { hasText: 'to reach your goal' }).first();
    await then.locator('.step', { hasText: 'Air battlestaff' }).waitFor();
    const buy = (await then.locator('.collect').first().locator('.it-chip').allInnerTexts()).map(flat);
    assert.deepEqual(buy.map(x => x.replace(/^[\d,]+ /, '').replace(/ \(.*$/, '')), ['Unpowered orb', 'Air rune', 'Cosmic rune', 'Battlestaff']);
    assert.match(flat(await then.locator('.tip.magic').innerText()), /^Magic XP on the way: \+[\d,.]+ XP from [\d,]+ × Charge Air Orb \(Magic 66\)$/);
    // hovering says what it does to your Magic level (Demo Main is Magic 90), where it's enough for one
    assert.match(await then.locator('.tip.magic').getAttribute('title'), /^Not part of the XP above: it's what the spells cast on the way give\. On its own it takes your Magic from 90 to 9\d\.$/);
    assert.equal(await sec.locator('.tip.magic').getAttribute('title'), "Not part of the XP above: it's what the spells cast on the way give.", '152,000 XP is no level at 90');
    // Only three enchanted pieces ticked (the gem-cutting rows unticked with the rest), uncut gems and too few
    // gold bars: as it is the bars go to the most XP; rounded up, the rest are made too, their gems cut on the way
    await card.locator('input[data-gopt="roundUp"]').uncheck();
    await setBank('crafting', { molten_glass: '', uncut_sapphire: '300', uncut_emerald: '250', ruby: '120', gold_bar: '100', cosmicrune: '500', firerune: '1000' });
    await page.click('.tab[data-tab="goals"]');
    await card.locator('[data-tgroup="Jewellery"]').click();
    const keep = ['cr_ench_necklace_of_minigames_8', 'cr_ench_ring_of_dueling_8', 'cr_ench_ring_of_forging'];
    await page.evaluate(keep => {
      const k = 'lchs.goals.demo_main', goals = JSON.parse(localStorage.getItem(k));
      const g = goals.find(x => x.skill === 'crafting');
      g.excluded = [...document.querySelectorAll('.goal tr[data-method]')].map(tr => tr.dataset.method).filter(id => !keep.includes(id));
      g.fillId = null;
      localStorage.setItem(k, JSON.stringify(goals));
    }, keep);
    await page.click('.tab[data-tab="bank"]');
    await page.click('.tab[data-tab="goals"]');
    await card.locator('.step', { hasText: '100 × Ring of forging (make & enchant)' }).waitFor();
    assert.equal(await sec.locator('.step').count(), 1, 'the gold bars are used up: nothing for the emeralds and sapphires, which stay uncut');
    assert.equal(await card.locator('input[data-use="cr_sapphire"]').isChecked(), false);
    assert.match(await card.locator('.plan-t thead th').first().getAttribute('title'), /What a ticked row needs is still made on the way/);
    assert.equal(flat(await sec.locator('.tip.magic').innerText()), 'Magic XP on the way: +5,900 XP from 100 × Lvl-3 Enchant (Magic 49)');
    await card.locator('input[data-gopt="roundUp"]').check();
    await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
    // (with the runes to be collected, rings of dueling can be made, and they get the gold bars in your bank:
    // an emerald cut and set is 122.5 XP a bar, a ruby ring 70)
    const made = (await sec.locator('.step').allInnerTexts()).map(flat);
    assert.equal(made.length, 3, made.join(' / '));
    assert.match(made[0], /^250 × Ring of dueling\(8\) \(make & enchant\) \+30,625 XP .*incl\. 250 × Emerald \(cut\) \+16,875 XP collect 150 Gold bar 750 Air rune$/, 'cut on the way, though Emerald (cut) is unticked');
    assert.match(made[1], /^120 × Ring of forging \(make & enchant\) \+8,400 XP .*collect 120 Gold bar$/);
    assert.match(made[2], /^300 × Games necklace\(8\) \(make & enchant\) \+31,500 XP .*incl\. 300 × Sapphire \(cut\) \+15,000 XP collect 300 Gold bar 300 Water rune 170 Cosmic rune$/);
    assert.equal(flat(await sec.locator('.tip.magic').innerText()),
      'Magic XP on the way: +21,580 XP from 250 × Lvl-2 Enchant (Magic 27), 120 × Lvl-3 Enchant (Magic 49), 300 × Lvl-1 Enchant (Magic 7)');
    assert.match(flat(await sec.locator('.collect').innerText()), /^To round up your supplies, collect: 570 Gold bar( \([\d.,]+[KM]?\))? 750 Air rune( \([\d.,]+[KM]?\))? 300 Water rune( \([\d.,]+[KM]?\))? 170 Cosmic rune( \([\d.,]+[KM]?\))?$/);
  } finally {
    // leave things as they were, whatever happened
    await setBank('crafting', { molten_glass: '', uncut_sapphire: '', uncut_emerald: '', ruby: '', gold_bar: '', cosmicrune: '', firerune: '' });
    await page.click('.tab[data-tab="goals"]');
    await card.locator('[data-act="remove-goal"]').click();
    await card.locator('[data-act="remove-goal"]').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.goal')].some(g => g.innerText.includes('Crafting')));
  }
});

await check('crafting: a spell above your Magic level says so in the Magic XP tip', async () => {
  // Old Badger: Crafting 56 (water battlestaves from 54), Magic 50 (Charge Water Orb takes Magic 56)
  await planAs('old badger', 'Old Badger');
  const card = page.locator('.goal', { hasText: 'Crafting' });
  try {
    await addGoal('crafting', 60);
    await card.locator('.plan').waitFor();
    assert.match(flat(await card.locator('.goal-title').innerText()), /Level 56 → 60/);
    await card.locator('select[data-gopt="fill"]').selectOption('cr_water_battlestaff');
    const then = card.locator('.plan-sec', { hasText: 'reach your goal' }).first();
    await then.locator('.step', { hasText: 'Water battlestaff' }).waitFor();
    const tip = then.locator('.tip.magic');
    assert.match(flat(await tip.innerText()), /^Magic XP on the way: \+[\d,.]+ XP from [\d,]+ × Charge Water Orb \(needs Magic 56: you're 50\)$/);
    assert.equal(flat(await tip.locator('.c-lose').innerText()), "(needs Magic 56: you're 50)");
    assert.equal(await tip.getAttribute('title'), "Not part of the XP above: it's what the spells cast on the way give.", "no level it takes you to: you can't cast it yet");
    await page.screenshot({ path: `${SHOTS}/10h-crafting-magic-too-low.png`, fullPage: true });
  } finally {
    // leave things as they were, whatever happened
    if (await card.count()) {
      await card.locator('[data-act="remove-goal"]').click();
      await card.locator('[data-act="remove-goal"]').click();
    }
    await planAs('demo main', 'Demo Main');
  }
});

// ── v2.7, planned for Old Badger: Herblore 52, Fishing 54, Cooking 51 (each with 100 XP into its level) ──
// A bank plan's lines as they read: "100 × Super attack +10,000 XP" (their worth in gp left out).
const planLines = sec => sec.locator('.steps > .step').evaluateAll(els => els.map(e => e.querySelector('.step-main > div').innerText.replace(/\s+/g, ' ').trim().replace(/ ·.*$/, '')));
// Drags one of a bank plan's lines onto another's place.
async function dragLine(sec, from, to) {
  // (scrolled to by hand: the plan is redrawn as prices arrive, and a redraw mid-wait would lose the element)
  await sec.locator('.steps').first().evaluate(el => el.scrollIntoView({ block: 'center' }));
  // (and looked for again when a redraw took the line away just then)
  const box = async id => {
    for (let tries = 0; tries < 30; tries++) {
      const found = await sec.locator(`.steps.movable > .step[data-step="${id}"]`).first().boundingBox().catch(() => null);
      if (found) return found;
      await page.waitForTimeout(100);
    }
    throw new Error(`no line of ${id} to drag`);
  };
  const a = await box(from), b = await box(to);
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + 60, b.y + (b.y < a.y ? 4 : b.height - 4), { steps: 14 });
  await page.mouse.up();
}
// A goal's card, by the skill named in its heading (a Herblore plan has "Fishing potion" in it too).
const goalCard = name => page.locator('.goal').filter({ has: page.locator('.goal-name', { hasText: new RegExp(`^${name}$`) }) });
const noGoalFor = name => page.waitForFunction(n => ![...document.querySelectorAll('.goal .goal-name')].some(el => el.innerText.trim() === n), name);
const goalOf = (account, skill) => page.evaluate(([a, k]) => JSON.parse(localStorage.getItem(`lchs.goals.${a}`) || '[]').find(g => g.skill === k), [account, skill]);
const HERBS = { irit_leaf: '100', eye_of_newt: '100', unicorn_horn_dust: '100', ranarr_weed: '60', snape_grass: '100', avantoe: '80' };

await check("goals: a potion waits for the more useful one its herb makes (super attack before superantipoison, prayer before fishing potion), and a bank plan's lines drag into an order of your own", async () => {
  await planAs('old badger', 'Old Badger');
  // 100 irits for super attacks (eye of newt) or superantipoison (unicorn horn dust); 100 snape grass for
  // prayer potions (60 ranarrs) or fishing potions (80 avantoe)
  await setBank('herblore', HERBS);
  await addGoal('herblore', 60);
  const card = goalCard('Herblore');
  const sec = card.locator('.plan-sec').first();
  await sec.locator('.step').first().waitFor();
  assert.equal(flat(await card.locator('.goal-title').innerText()), 'Level 52 → 60');
  // As it is: the irits go to super attacks and the snape grass to prayer potions first; fishing potions get
  // the 40 snape grass that leaves. (Up to v2.6.0 it was most XP first: fishing potions and superantipoison.)
  const USUAL = ['100 × Super attack +10,000 XP', '60 × Prayer potion +5,250 XP', '40 × Fishing potion +4,500 XP'];
  assert.deepEqual(await planLines(sec), USUAL);
  assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +19,750 XP → level 53');
  const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
  assert.deepEqual([(await cells('hb_3dose2antipoison'))[6], (await cells('hb_3dosefisherspotion'))[6]], ['100', '80'], 'From bank: what each would make on its own');
  // every line has a grip to drag it by, and the note under them says so, and what else the bank could make
  assert.equal(await sec.locator('.steps.movable > .step > .grip').count(), 3);
  assert.equal(flat(await sec.locator('.order-note').innerText()), 'Drag a line up or down to change what your bank is used for first. · 1 more your bank could make instead ▸');
  assert.equal((await goalOf('old_badger', 'herblore')).order, undefined);

  // Fishing potions dragged to the top: they get the snape grass first (80, as far as the avantoe goes), prayer potions the rest
  await dragLine(sec, 'hb_3dosefisherspotion', 'hb_3dose2attack');
  await sec.locator('.step', { hasText: '80 × Fishing potion' }).waitFor();
  const MINE = ['80 × Fishing potion +9,000 XP', '100 × Super attack +10,000 XP', '20 × Prayer potion +1,750 XP'];
  assert.deepEqual(await planLines(sec), MINE);
  assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +20,750 XP → level 53');
  assert.deepEqual((await goalOf('old_badger', 'herblore')).order, ['hb_3dosefisherspotion', 'hb_3dose2attack', 'hb_3doseprayerrestore']);
  assert.equal(flat(await sec.locator('.order-note').innerText()),
    'In your own order: your bank goes to the top line first, then down the list. Back to the usual order · 1 more your bank could make instead ▸');
  assert.match(flat(await card.locator('.plan-sec', { hasText: 'Then, to reach your goal' }).locator('h4').innerText()), /^Then, to reach your goal: 129,232 XP/, '149,982 to go, less 20,750');
  // the order is the goal's: still there after a restart
  await page.reload();
  await sec.locator('.step').first().waitFor({ timeout: 20000 });
  assert.deepEqual(await planLines(sec), MINE);

  // What else the bank could make: superantipoison, which the super attacks leave no irits for. A click puts it first.
  await sec.locator('[data-act="order-more"]').click();
  const chips = sec.locator('.order-more [data-first]');
  assert.deepEqual((await chips.allInnerTexts()).map(flat), ['Superantipoison 100']);
  assert.equal(await chips.first().getAttribute('title'), 'Your bank could make 100 × Superantipoison on its own. Click to use your bank for it first.');
  await page.screenshot({ path: `${SHOTS}/10l-bank-order.png`, fullPage: true });
  await chips.first().click();
  await sec.locator('.step', { hasText: '100 × Superantipoison' }).waitFor();
  assert.deepEqual(await planLines(sec), ['100 × Superantipoison +10,630 XP', '80 × Fishing potion +9,000 XP', '20 × Prayer potion +1,750 XP']);
  assert.deepEqual((await goalOf('old_badger', 'herblore')).order, ['hb_3dose2antipoison', 'hb_3dosefisherspotion', 'hb_3dose2attack', 'hb_3doseprayerrestore']);
  assert.deepEqual((await sec.locator('.order-more [data-first]').allInnerTexts()).map(flat), ['Super attack 100'], 'the super attacks are what it could make instead now');
  // a line dragged down: prayer potions above the fishing potions again
  await dragLine(sec, 'hb_3dosefisherspotion', 'hb_3doseprayerrestore');
  await sec.locator('.step', { hasText: '60 × Prayer potion' }).waitFor();
  assert.deepEqual(await planLines(sec), ['100 × Superantipoison +10,630 XP', '60 × Prayer potion +5,250 XP', '40 × Fishing potion +4,500 XP']);
  // Round up my supplies keeps to the order: the top line is rounded up like the rest
  await card.locator('input[data-gopt="roundUp"]').check();
  await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
  assert.equal((await planLines(sec))[0], '100 × Superantipoison +10,630 XP');
  await card.locator('input[data-gopt="roundUp"]').uncheck();
  await sec.locator('.step', { hasText: '60 × Prayer potion' }).waitFor();

  // Back to the usual order
  await sec.locator('[data-act="order-reset"]').click();
  await sec.locator('.step', { hasText: '100 × Super attack' }).waitFor();
  assert.deepEqual(await planLines(sec), USUAL);
  assert.equal((await goalOf('old_badger', 'herblore')).order, undefined);
  assert.equal(await sec.locator('[data-act="order-reset"]').count(), 0);
  // The potion you pick to train with still goes first, as it always did: fishing potions, picked, take the snape grass
  await card.locator('select[data-gopt="fill"]').selectOption('hb_3dosefisherspotion');
  await sec.locator('.step', { hasText: '80 × Fishing potion' }).waitFor();
  assert.deepEqual(await planLines(sec), MINE);
  await card.locator('select[data-gopt="fill"]').selectOption('hb_3doseprayerrestore');
  await sec.locator('.step', { hasText: '60 × Prayer potion' }).waitFor();
  // (then the most XP each: the fishing potions, which no longer wait once the ranarrs are used up)
  assert.deepEqual(await planLines(sec), ['60 × Prayer potion +5,250 XP', '40 × Fishing potion +4,500 XP', '100 × Super attack +10,000 XP']);
  assert.match(flat(await card.locator('.tip', { hasText: 'Tip: collect' }).innerText()), /^Tip: collect 40 Ranarr weed( \([\d.,]+[KM]?\))? and your bank makes 100 Prayer potion instead of 60\.$/);
  // ...a tip that goes while something above it in your order takes the snape grass first: 40 more ranarrs wouldn't make 100 then
  await dragLine(sec, 'hb_3dosefisherspotion', 'hb_3doseprayerrestore');
  await sec.locator('.step', { hasText: '80 × Fishing potion' }).waitFor();
  assert.deepEqual(await planLines(sec), ['80 × Fishing potion +9,000 XP', '20 × Prayer potion +1,750 XP', '100 × Super attack +10,000 XP']);
  assert.equal(await card.locator('.tip', { hasText: 'Tip: collect' }).count(), 0);
  await sec.locator('[data-act="order-reset"]').click();
  await sec.locator('.step', { hasText: '60 × Prayer potion' }).waitFor();
  assert.equal(await card.locator('.tip', { hasText: 'Tip: collect' }).count(), 1);
});

await check('goals: Edit moves the goalpost: a new target, or another kind of goal, with the plan and everything chosen for it kept', async () => {
  await planAs('old badger', 'Old Badger');
  const card = goalCard('Herblore');
  const sec = card.locator('.plan-sec').first();
  const title = async () => flat(await card.locator('.goal-title').innerText());
  const sub = async () => flat(await card.locator('.goal-sub').innerText());
  const edit = card.locator('[data-act="edit-goal"]');
  const form = card.locator('[data-form="edit-goal"]');
  const value = form.locator('[name=value]');
  try {
  await sec.locator('.step').first().waitFor();
  // What an edit must leave alone: the potion picked to train with (prayer potions, from the check before), an order
  // of its own (fishing potions dragged above them), a row unticked, and where the progress bar started (5,000 XP ago)
  await card.locator('select[data-gopt="fill"]').selectOption('hb_3doseprayerrestore');
  await sec.locator('.step', { hasText: '60 × Prayer potion' }).waitFor();
  await dragLine(sec, 'hb_3dosefisherspotion', 'hb_3doseprayerrestore');
  await sec.locator('.step', { hasText: '80 × Fishing potion' }).waitFor();
  await card.locator('input[data-use="hb_3dose1attack"]').uncheck();
  await page.evaluate(() => { const k = 'lchs.goals.old_badger', g = JSON.parse(localStorage.getItem(k)); g[0].startXp10 -= 50000; localStorage.setItem(k, JSON.stringify(g)); });
  await page.click('.tab[data-tab="bank"]');
  await page.click('.tab[data-tab="goals"]');
  await sec.locator('.step').first().waitFor();
  const before = await goalOf('old_badger', 'herblore');
  assert.deepEqual([before.type, before.value, before.fillId, before.order.length, before.excluded], ['level', 60, 'hb_3doseprayerrestore', 3, ['hb_3dose1attack']]);
  const lines = await planLines(sec);
  assert.equal(await title(), 'Level 52 → 60');
  assert.equal(await card.locator('.goal-bar').getAttribute('title'), '3.2% of the way since you set this goal', '5,000 of 154,982');

  // Edit sits beside the goal's title and opens a line under it, with the target ready to type over
  assert.equal(flat(await edit.innerText()), 'Edit');
  assert.equal(await edit.getAttribute('title'), "Change this goal's target: move the goalpost");
  assert.equal(await form.count(), 0);
  await edit.click();
  await form.waitFor();
  assert.equal(flat(await form.innerText()), 'Change this goal to Level XP Rank Top % Save Cancel Its plan, ticks and progress stay as they are.');
  assert.equal(await value.inputValue(), '60');
  assert.equal(flat(await form.locator('[data-etype].on').innerText()), 'Level');
  assert.deepEqual(await page.evaluate(() => [document.activeElement?.name, document.activeElement?.selectionStart, document.activeElement?.selectionEnd]), ['value', 0, 2], 'selected, ready to type over');
  // what you've typed stays through a redraw (prices arriving)
  await value.fill('65');
  await page.evaluate(() => window.__skills.prices.dispatchEvent(new CustomEvent('update', { detail: {} })));
  await page.waitForTimeout(600);
  assert.equal(await value.inputValue(), '65');
  // somewhere you already are isn't a goal: it says why, and nothing changes
  await value.fill('50');
  await value.press('Enter');
  await form.locator('.c-lose').waitFor();
  assert.equal(flat(await form.locator('.c-lose').innerText()), 'Old Badger is already level 52 in Herblore.');
  assert.equal(await value.inputValue(), '50');
  assert.equal(await title(), 'Level 52 → 60');
  await value.fill('120');
  await form.locator('button[type=submit]').click();
  await form.locator('.c-lose', { hasText: 'Levels go from 2 to 99.' }).waitFor();
  // the goalpost moved: level 70
  await value.fill('70');
  await value.press('Enter');
  await form.waitFor({ state: 'detached' });
  assert.equal(await title(), 'Level 52 → 70');
  assert.match(await sub(), /^123,760 \/ 737,627 XP · 613,867 XP to go · 18 levels \(to 70\)$/);
  assert.deepEqual(await goalOf('old_badger', 'herblore'), { ...before, value: 70 }, 'only the target changed');
  assert.deepEqual(await planLines(sec), lines, 'the bank plan is as it was');
  assert.equal(await card.locator('input[data-use="hb_3dose1attack"]').isChecked(), false);
  assert.match(flat(await card.locator('.plan-sec', { hasText: 'Then, to reach your goal' }).locator('h4').innerText()), /^Then, to reach your goal: 593,117 XP/, '613,867 to go, less the 20,750 the bank makes');
  assert.equal(await card.locator('.goal-bar').getAttribute('title'), '0.8% of the way since you set this goal', 'the 5,000 XP gained still count: of 618,867 now');

  // another kind of goal: an amount of XP. The box suggests the next level's
  await edit.click();
  await form.locator('[data-etype="xp"]').click();
  assert.equal(flat(await form.locator('[data-etype].on').innerText()), 'XP');
  assert.deepEqual([await value.inputValue(), await value.getAttribute('placeholder')], ['136594', 'XP']);
  await value.fill('200k');
  await value.press('Enter');
  await form.waitFor({ state: 'detached' });
  assert.equal(await title(), '123,760 → 200,000 XP');
  assert.match(await sub(), /^123,760 \/ 200,000 XP · 76,240 XP to go · 4 levels \(to 56\)$/);
  assert.deepEqual(await goalOf('old_badger', 'herblore'), { ...before, type: 'xp', value: 200000 });
  // Cancel, and Edit again, both close it with nothing changed
  await edit.click();
  await value.fill('5m');
  await form.locator('[data-act="edit-cancel"]').click();
  assert.equal(await form.count(), 0);
  await edit.click();
  assert.equal(await value.inputValue(), '200000', 'what was typed and cancelled is gone');
  await edit.click();
  assert.equal(await form.count(), 0);
  assert.equal(await title(), '123,760 → 200,000 XP');
  // a rank: who holds it is looked up, as for a new goal
  await edit.click();
  await form.locator('[data-etype="rank"]').click();
  await value.fill('500');
  await page.screenshot({ path: `${SHOTS}/10m-goal-edit.png` });
  await value.press('Enter');
  await page.waitForFunction(() => /beat .+ \(rank 500, checked/.test([...document.querySelectorAll('.goal')].find(g => g.querySelector('.goal-name')?.innerText.trim() === 'Herblore')?.innerText || ''), null, { timeout: 15000 });
  assert.match(await title(), /^Rank [\d,]+ → 500$/);
  assert.deepEqual(await planLines(sec), lines);
  // and back to the level it started as, for the checks that follow
  await edit.click();
  await form.locator('[data-etype="level"]').click();
  await value.fill('60');
  await value.press('Enter');
  await form.waitFor({ state: 'detached' });
  assert.equal(await title(), 'Level 52 → 60');
  const after = await goalOf('old_badger', 'herblore');
  assert.deepEqual({ ...after, target: undefined }, { ...before, target: undefined });
  } finally {
    // done with Herblore: the goal and its herbs go, whatever happened
    await removeGoal(card);
    await noGoalFor('Herblore');
    await setBank('herblore', Object.fromEntries(Object.keys(HERBS).map(k => [k, ''])));
  }
});

await check("fishing: no bank, the gear to bring and the bait or feathers to buy; a big net's fish are yours to pick", async () => {
  await planAs('old badger', 'Old Badger');
  await addGoal('fishing', 60);
  const card = goalCard('Fishing');
  try {
    await card.locator('.plan').waitFor();
    const t = flat(await card.innerText());
    assert.match(t, /Level 54 → 60/);
    assert.match(t, /Fishing only needs the gear for the spot, and a bait or a feather for every catch with a rod\. Those are listed to buy \(what's in your bank isn't counted\), so this plan doesn't use your bank\./);
    assert.doesNotMatch(t, /From your bank|Use my bank|Round up/);
    assert.match(t, /To reach your goal: 122,770 XP/);
    // Swordfish (level 50, 100 XP), not bass (level 46, 100 XP too): a big net brings up whatever it likes, so
    // its fish aren't what a plan picks by itself
    const plan = card.locator('.plan-sec', { hasText: 'To reach your goal' });
    assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'fi_raw_swordfish');
    assert.equal(flat(await plan.locator('.step').innerText()), '1,228 × Raw swordfish +122,800 XP');
    assert.equal(flat(await plan.locator('.collect', { hasText: 'Also bring' }).innerText()), 'Also bring: Harpoon');
    assert.equal(await plan.locator('.collect', { hasText: 'To collect or buy' }).count(), 0, 'a harpoon takes no bait');
    // every fish of the calculator, in one table (no groups to pick from)
    assert.deepEqual((await card.locator('.plan-t thead th').allInnerTexts()).map(flat), ['Lvl', 'Fish', 'XP', 'Net/item', 'gp/XP', 'To goal', 'Plan to make']);
    assert.deepEqual((await card.locator('tr[data-method] td:nth-child(2)').allInnerTexts()).map(flat),
      ['Raw shrimps', 'Raw karambwanji', 'Raw sardine', 'Raw herring', 'Raw anchovies', 'Raw mackerel', 'Raw trout', 'Raw cod', 'Raw pike', 'Slimey eel', 'Raw salmon', 'Raw tuna',
        'Raw lobster', 'Raw bass', 'Raw swordfish', 'Raw lava eel', 'Raw karambwan', 'Raw shark']);
    assert.equal(await card.locator('.group-pick').count(), 0);
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
    const tip = id => card.locator(`tr[data-method="${id}"]`).getAttribute('title');
    assert.deepEqual([(await cells('fi_raw_trout')).slice(0, 3), (await cells('fi_raw_trout'))[5]], [['20', 'Raw trout', '50'], '2,456']);
    assert.deepEqual((await cells('fi_raw_shark')).slice(0, 3), ['76', 'Raw shark', '110']);
    assert.match(await card.locator('tr[data-method="fi_raw_shark"]').getAttribute('class'), /\bdim\b/, 'above level 54');
    // what each takes: its gear, and a bait or a feather a catch with a rod
    assert.match(await tip('fi_raw_shrimp'), /^Raw shrimps: level 1, 10 XP each\nTools: Small fishing net/);
    assert.match(await tip('fi_raw_trout'), /^Raw trout: level 20, 50 XP each\nNeeds \(from scratch\): 1 Feather\nTools: Fly fishing rod/);
    assert.match(await tip('fi_raw_pike'), /^Raw pike: level 25, 60 XP each\nNeeds \(from scratch\): 1 Fishing bait\nTools: Fishing rod/);
    assert.match(await tip('fi_raw_lobster'), /^Raw lobster: level 40, 90 XP each\nTools: Lobster pot/);
    assert.match(await tip('fi_raw_lava_eel'), /^Raw lava eel: level 53, 60 XP each\nNeeds \(from scratch\): 1 Fishing bait\nTools: Oily fishing rod/);
    assert.match(await tip('fi_raw_bass'),
      /^Raw bass: level 46, 100 XP each\nTools: Big fishing net\nA big net brings up several things at once: mackerel, cod \(from level 23\), bass \(from level 46\), and now and then leather boots, seaweed, leather gloves, oyster or casket\. Only the bass is counted here\./);
    assert.match(await tip('fi_tbwt_raw_karambwan'),
      /^Raw karambwan: level 65, 105 XP each\nTools: Karambwan vessel \(empty\)\nTai Bwo Wannai Trio: once Lubufu has shown you how\. Every try takes the raw karambwanji in your vessel, caught or not; those aren't counted\./);
    // trout, picked: a feather each, and a fly fishing rod
    await card.locator('tr[data-method="fi_raw_trout"] td:nth-child(2)').click();
    await plan.locator('.step', { hasText: 'Raw trout' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '2,456 × Raw trout +122,800 XP');
    assert.match(flat(await plan.locator('.collect', { hasText: 'To collect or buy' }).innerText()), /^To collect or buy: 2,456 Feather( \([\d.,]+[KM]?\))?$/);
    assert.equal(flat(await plan.locator('.collect', { hasText: 'Also bring' }).innerText()), 'Also bring: Fly fishing rod');
    // a big net's fish can be picked, and a mix of your own planned: 500 bass first, then trout
    await card.locator('[data-mix="fi_raw_bass"]').fill('500');
    await card.locator('[data-mix="fi_raw_bass"]').press('Tab');
    await card.locator('.plan-sec', { hasText: 'Your mix +50,000 XP' }).waitFor();
    assert.match(flat(await card.locator('.plan-sec', { hasText: 'Your mix +50,000 XP' }).locator('.step').innerText()), /^500 × Raw bass \+50,000 XP/);
    assert.equal(flat(await card.locator('.plan-sec', { hasText: 'Then, to reach your goal' }).locator('.step').innerText()), '1,456 × Raw trout +72,800 XP');
    assert.match(flat(await card.locator('.plan-sec', { hasText: 'Then, to reach your goal' }).innerText()), /To collect or buy: 1,456 Feather/);
    await page.screenshot({ path: `${SHOTS}/10n-fishing.png`, fullPage: true });
    await card.locator('[data-act="mix-clear"]').click();
    // its prices: the fish, and the bait and feathers they take. No bank of its own
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="fishing"]');
    await page.waitForSelector('[data-price="raw_shark"]');
    assert.match(flat(await text('#prices-body')), /^Fish .*Raw shrimps.*Raw karambwan.*Raw shark.*Bait .*Fishing bait.*Feather/);
    await page.click('.tab[data-tab="bank"]');
    assert.equal(await page.locator('#bank-head [data-bskill="fishing"]').count(), 0);
    assert.equal(await page.locator('#bank-head [data-bskill="cooking"]').count(), 1);
  } finally {
    await removeGoal(card);
    await noGoalFor('Fishing');
  }
});

// The server's own roll for a cook (stat_random): its chances in 256 at a level, from the two numbers a food has.
const cookRoll = ([low, high], level) => Math.min(256, Math.floor((low * (99 - level)) / 98) + Math.floor((high * (level - 1)) / 98) + 1);
// What that comes to over a stretch, each level at its own chance (XP in whole XP): the food cooked from `raw`
// things, and the raw things `n` cooked take.
function cookedFrom(chance, xpEach, raw, xp) {
  let done = 0;
  while (raw > 0) {
    const level = levelForXp(Math.floor(xp)), p = cookRoll(chance, level) / 256;
    const n = level >= 99 ? raw : Math.min(raw, Math.max(1, Math.ceil((xpForLevel(level + 1) - xp) / (p * xpEach))));
    done += n * p; xp += n * p * xpEach; raw -= n;
  }
  return done;
}
function rawFor(chance, xpEach, n, xp) {
  let raw = 0;
  while (n > 0) {
    const level = levelForXp(Math.floor(xp)), p = cookRoll(chance, level) / 256;
    const k = level >= 99 ? n : Math.min(n, Math.max(1, Math.ceil((xpForLevel(level + 1) - xp) / xpEach)));
    raw += k / p; xp += k * xpEach; n -= k;
  }
  return raw;
}
const LOBSTER = [38, 332], LOBSTER_GAUNTLETS = [55, 368];        // (cooking_generic.dbrow: successchance, successchance_gauntlets)

await check("cooking: burnt food is counted by the server's chances, a level at a time; cooking gauntlets, a fire, and leaving it out", async () => {
  await planAs('old badger', 'Old Badger');
  const card = goalCard('Cooking');
  const sec = card.locator('.plan-sec').first();
  const then = card.locator('.plan-sec', { hasText: 'Then, to reach your goal' });
  const START = 112045;                         // Old Badger's Cooking XP: level 51
  const near = (shown, worked, what) => assert.ok(Math.abs(shown - worked) < 1.5, `${what}: the page says ${shown}, the server's chances come to ${worked.toFixed(2)}`);
  try {
    await setBank('cooking', { raw_lobster: '400' });
    assert.match(flat(await text('#bank-head')), /Raw fish and meat cook into food; a pie, a pizza, a cake, a stew or a wine is put together first.*Burnt food is counted on a Cooking goal, where you also say what you cook on\./);
    assert.deepEqual((await page.locator('#bank-body .bank-group h4').allInnerTexts()).map(flat),
      ['Raw fish', 'Raw meat', 'Pies and bread', 'Pizza and cake', 'Stew, wine and the rest', 'Cooked: fish', 'Cooked: meat', 'Cooked: pies and pizza', 'Cooked: the rest']);
    await addGoal('cooking', 60);
    await sec.locator('.step').first().waitFor();
    assert.equal(flat(await card.locator('.goal-title').innerText()), 'Level 51 → 60');
    // the choices: what you cook on, cooking gauntlets, and whether burnt food counts
    assert.match(flat(await card.locator('.plan-opts').innerText()), /^Use my bank Round up my supplies Cook on A range Lumbridge Castle's range A fire Cooking gauntlets Burnt food Count it Leave it out 1 kind of item in your bank/);
    assert.deepEqual([await card.locator('select[data-opt="heat"]').inputValue(), await card.locator('input[data-opt="gauntlets"]').isChecked(), await card.locator('select[data-opt="burnt"]').inputValue()], ['range', false, 'count']);
    assert.match(await card.locator('label:has(select[data-opt="heat"])').getAttribute('title'),
      /^Where you cook decides how often food burns\. A range: the usual\. Lumbridge Castle's range \(once Cook's Assistant is done\) burns less of 19 low-level foods\. A fire burns more cod, swordfish, shark, sea turtle and manta ray, and a little less ugthanki meat and lean snail meat; the rest burn the same\. Pies, pizzas, cakes and bread need a range whatever you pick\.$/);
    assert.equal(await card.locator('label:has(input[data-opt="gauntlets"])').getAttribute('title'),
      'On: lobster, swordfish and shark burn less. Lobsters stop burning at level 64 instead of 74; sharks stop burning at level 94 (without, they never stop burning).');
    assert.equal(await card.locator('label:has(select[data-opt="burnt"])').getAttribute('title'),
      "Count it: a plan allows for what burns, by the server's own chances at each level: more raw food to collect, and less XP from what's in your bank. Leave it out: every cook works, the way LostHQ's calculator counts.");

    // On a range from level 51, 188 lobsters in 256 cook: 27 in 100 burn. All 400 go on, and about 298 come out
    // (a few more than 400 × 188/256 = 293: two levels are gained on the way, and each burns less)
    assert.equal(cookRoll(LOBSTER, 51), 188);
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +35,760 XP → level 53');
    assert.match(flat(await sec.locator('.step').innerText()), /^298 × Lobster \+35,760 XP .*incl\. 400 Raw lobster cooked, about 102 burnt$/);
    near(298, cookedFrom(LOBSTER, 120, 400, START), 'lobsters from 400 raw');
    assert.equal(flat(await sec.locator('.step .c-lose').innerText()), 'about 102 burnt');
    // the rest of the goal: 1,050 lobsters, as the calculator says, and the 1,312 raw ones that takes
    assert.equal(flat(await then.locator('h4').innerText()).replace(/ Train with.*$/, ''), 'Then, to reach your goal: 125,937 XP');
    assert.equal(flat(await then.locator('.step').innerText()), '1,050 × Lobster +126,000 XP incl. 1,312 Raw lobster cooked, about 262 burnt');
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 1,312 Raw lobster( \([\d.,]+[KM]?\))?$/);
    near(1312, rawFor(LOBSTER, 120, 1050, START + 35760), 'raw lobsters for 1,050 more');
    // the table: Fish to start with; a row says how much burns at your level, and counts it
    assert.deepEqual((await card.locator('.group-pick .chip').allInnerTexts()).map(flat), ['Fish', 'Meat', 'Pies & pizza', 'Gnome', 'Other', 'All']);
    assert.equal(flat(await card.locator('.group-pick .chip.on').innerText()), 'Fish');
    assert.match(flat((await card.locator('.plan-t thead th').allInnerTexts()).join(' ')), /^Use Lvl Food XP Net\/item gp\/XP From bank /);
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => flat(c));
    const tip = id => card.locator(`tr[data-method="${id}"]`).getAttribute('title');
    const badge = id => card.locator(`tr[data-method="${id}"] .burn`);
    let lob = await cells('ck_lobster');
    assert.deepEqual([lob[1], lob[2], lob[3], lob[6], lob[10]], ['40', 'Lobster 27% burn', '120', '293', '1,050'], 'From bank is at your level now: 400 × 188/256');
    assert.match(lob[11], /^1,312\b/, 'Supplies needed: the raw ones');
    assert.equal(await badge('ck_lobster').getAttribute('title'), 'About 27 in 100 burn at level 51; none from level 74. Plans count them.');
    assert.match(await tip('ck_lobster'), /^Lobster: level 40, 120 XP each\nAbout 27 in 100 burn at level 51; none from level 74\. What it needs allows for that\.\nNeeds \(from scratch\): 1\.362 Raw lobster/);
    assert.equal(await badge('ck_trout').count(), 0, 'trout stopped burning at 49');
    assert.match(await tip('ck_trout'), /^Trout: level 15, 70 XP each\nNone burn at level 51 \(they stop at 49\)\.\nNeeds \(from scratch\): 1 Raw trout/);
    assert.equal(flat(await badge('ck_shark').innerText()), '27% burn');
    assert.equal(await badge('ck_shark').getAttribute('title'), 'About 27 in 100 burn at level 80; some always will. Plans count them.');
    assert.deepEqual([(await cells('ck_mantaray'))[3], (await cells('ck_lava_eel'))[2]], ['216.3', 'Lava eel'], "the server's manta ray XP; a lava eel never burns");
    assert.match(flat(await card.locator('.plan-sec').last().locator('.bar .small-note').last().innerText()),
      /Burnt food is counted: what a row takes allows for it at the level you are now\. A plan counts it a level at a time, so it burns a little less than its row says\.$/);
    await page.screenshot({ path: `${SHOTS}/10o-cooking.png`, fullPage: true });

    // Cooking gauntlets: 214 in 256 at level 51. About 340 of the 400 come out, and the rest of the goal takes fewer raw
    await card.locator('input[data-opt="gauntlets"]').check();
    await sec.locator('h4', { hasText: '+40,800 XP' }).waitFor();
    assert.equal(cookRoll(LOBSTER_GAUNTLETS, 51), 214);
    assert.match(flat(await sec.locator('.step').innerText()), /^340 × Lobster \+40,800 XP .*incl\. 400 Raw lobster cooked, about 60 burnt$/);
    near(340, cookedFrom(LOBSTER_GAUNTLETS, 120, 400, START), 'lobsters from 400 raw, with gauntlets');
    assert.equal(flat(await then.locator('.step').innerText()), '1,008 × Lobster +120,960 XP incl. 1,105 Raw lobster cooked, about 97 burnt');
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 1,105 Raw lobster/);
    near(1105, rawFor(LOBSTER_GAUNTLETS, 120, 1008, START + 40800), 'raw lobsters for 1,008 more, with gauntlets');
    assert.equal(flat(await badge('ck_lobster').innerText()), '16% burn');
    assert.equal(await badge('ck_lobster').getAttribute('title'), 'About 16 in 100 burn at level 51; none from level 64. Plans count them.');
    assert.equal(await badge('ck_shark').getAttribute('title'), 'About 14 in 100 burn at level 80; none from level 94. Plans count them.');
    assert.equal(flat(await badge('ck_swordfish').innerText()), '32% burn', 'no better than without, on a range');
    assert.deepEqual((await goalOf('old_badger', 'cooking')).opts, { gauntlets: true });
    await card.locator('input[data-opt="gauntlets"]').uncheck();
    await sec.locator('h4', { hasText: '+35,760 XP' }).waitFor();

    // A fire: lobsters the same; swordfish and sharks burn more, and cod doesn't stop until 51
    await card.locator('select[data-opt="heat"]').selectOption('fire');
    await page.waitForFunction(() => /39% burn/.test(document.querySelector('.goal tr[data-method="ck_swordfish"]')?.innerText || ''));
    assert.match(flat(await sec.locator('.step').innerText()), /^298 × Lobster \+35,760 XP .*incl\. 400 Raw lobster cooked, about 102 burnt$/);
    assert.deepEqual([flat(await badge('ck_lobster').innerText()), flat(await badge('ck_shark').innerText())], ['27% burn', '36% burn']);
    assert.match(await tip('ck_cod'), /None burn at level 51 \(they stop at 51\)\./);
    assert.match(await tip('ck_swordfish'), /About 39 in 100 burn at level 51; none from level 86\./);
    // Lumbridge Castle's range: kinder to low-level food (trout stop at 45 there), the same for lobsters
    await card.locator('select[data-opt="heat"]').selectOption('lumbridge');
    await page.waitForFunction(() => /they stop at 45/.test(document.querySelector('.goal tr[data-method="ck_trout"]')?.title || ''));
    assert.equal(flat(await badge('ck_lobster').innerText()), '27% burn');
    assert.deepEqual((await goalOf('old_badger', 'cooking')).opts, { heat: 'lumbridge' });
    await card.locator('select[data-opt="heat"]').selectOption('range');
    await page.waitForFunction(() => /they stop at 49/.test(document.querySelector('.goal tr[data-method="ck_trout"]')?.title || ''));

    // Leave it out: every cook works, as on LostHQ's calculator. No burnt food anywhere
    await card.locator('select[data-opt="burnt"]').selectOption('ignore');
    await sec.locator('h4', { hasText: '+48,000 XP' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +48,000 XP → level 54');
    assert.match(flat(await sec.locator('.step').innerText()), /^400 × Lobster \+48,000 XP/);
    assert.equal(flat(await then.locator('.step').innerText()), '948 × Lobster +113,760 XP');
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 948 Raw lobster/);
    assert.equal(await card.locator('.burn').count(), 0, 'no row says it burns');
    assert.doesNotMatch((await card.locator('.plan-sec .step').allInnerTexts()).join(' '), /burn/i);
    assert.doesNotMatch(flat(await card.locator('.plan-sec').last().locator('.bar .small-note').last().innerText()), /burn/i);
    lob = await cells('ck_lobster');
    assert.deepEqual([lob[2], lob[6], lob[10]], ['Lobster', '400', '948']);
    assert.match(await tip('ck_lobster'), /^Lobster: level 40, 120 XP each\nNeeds \(from scratch\): 1 Raw lobster/);
    assert.deepEqual((await goalOf('old_badger', 'cooking')).opts, { burnt: 'ignore' }, 'kept with the goal');
    await card.locator('select[data-opt="burnt"]').selectOption('count');
    await sec.locator('h4', { hasText: '+35,760 XP' }).waitFor();
    assert.equal((await goalOf('old_badger', 'cooking')).opts, undefined, 'counting is how it starts, so nothing is kept');
  } finally {
    await setBank('cooking', { raw_lobster: '' });
    await page.click('.tab[data-tab="goals"]');
  }
});

await check('cooking: a pie is put together on the way and every one goes in the oven; what cannot burn is cooked first; pizzas, cake and the choice of group', async () => {
  await planAs('old badger', 'Old Badger');
  const card = goalCard('Cooking');
  const sec = card.locator('.plan-sec').first();
  const then = card.locator('.plan-sec', { hasText: 'Then, to reach your goal' });
  const BANK = { raw_lobster: '400', raw_tuna: '300', raw_trout: '200', pot_flour: '50', bucket_water: '50', cooking_apple: '30', piedish: '30' };
  try {
    await setBank('cooking', BANK);
    await page.click('.tab[data-tab="goals"]');
    // (on a range, no gauntlets, burnt food counted: as a Cooking goal starts, whatever the check before left)
    await card.locator('.plan-opts').waitFor();
    await card.locator('select[data-opt="heat"]').selectOption('range');
    await card.locator('input[data-opt="gauntlets"]').uncheck();
    await card.locator('select[data-opt="burnt"]').selectOption('count');
    await sec.locator('.step', { hasText: 'Apple pie' }).waitFor();
    // Trout first: they can't burn at 51, and their 14,000 XP is a level gained before anything that can goes on.
    // Then by XP each. A pie's dough, shell and filling are made on the way; all 30 go in the oven (about 25 come
    // out), and the 20 pots of flour that leaves are bread
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +81,630 XP → level 56');
    const lines = (await sec.locator('.steps > .step').allInnerTexts()).map(x => flat(x).replace(/ · [^ ]+ gp( \([^)]*\))?/, ''));
    assert.deepEqual(lines, [
      '200 × Trout +14,000 XP',
      '25 × Apple pie +3,250 XP incl. 30 × Pastry dough, 30 × Pie shell, 30 × Uncooked apple pie, 30 Uncooked apple pie cooked, about 5 burnt',
      '304 × Lobster +36,480 XP incl. 400 Raw lobster cooked, about 96 burnt',
      '271 × Tuna +27,100 XP incl. 300 Raw tuna cooked, about 29 burnt',
      '20 × Bread +800 XP incl. 20 × Bread dough',
    ]);
    assert.equal(flat(await sec.locator('.order-note').innerText()), 'Drag a line up or down to change what your bank is used for first.');
    // the plan carries on with a fish, though the bank made pies and bread too
    assert.equal(flat(await card.locator('select[data-gopt="fill"] option:checked').innerText()), 'Lobster (lvl 40, 120 XP)');
    assert.equal(flat(await then.locator('.step').innerText()), '668 × Lobster +80,160 XP incl. 821 Raw lobster cooked, about 153 burnt');
    // lobsters dragged to the top: cooked at 51, more of them burn (298 where they were 304)
    await dragLine(sec, 'ck_lobster', 'ck_trout');
    await sec.locator('.step', { hasText: '298 × Lobster' }).waitFor();
    assert.deepEqual((await planLines(sec)).slice(0, 2), ['298 × Lobster +35,760 XP', '200 × Trout +14,000 XP']);
    await sec.locator('[data-act="order-reset"]').click();
    await sec.locator('.step', { hasText: '304 × Lobster' }).waitFor();

    // Pies & pizza: what each is made of, from scratch, with what burns on the way counted
    await card.locator('[data-tgroup="Pies & pizza"]').click();
    await card.locator('tr[data-method="ck_apple_pie"]').waitFor();
    const names = (await card.locator('tr[data-method] td:nth-child(3)').allInnerTexts()).map(x => flat(x).replace(/ (under )?\d+% burn$/, ''));
    assert.deepEqual(names, ['Redberry pie', 'Meat pie', 'Apple pie', 'Plain pizza', 'Meat pizza', 'Anchovy pizza', 'Pineapple pizza']);
    const tip = id => card.locator(`tr[data-method="${id}"]`).getAttribute('title');
    assert.match(await tip('ck_apple_pie'), /^Apple pie: level 30, 130 XP each\nAbout \d+ in 100 burn at level 51; none from level \d+\. What it needs allows for that\.\nNeeds \(from scratch\): [\d.]+ Pot of flour, [\d.]+ Bucket of water, [\d.]+ Pie dish, [\d.]+ Cooking apple/);
    assert.match(await tip('ck_meat_pizza'),
      /^Meat pizza: level 45, 26 XP each\nWith what's made on the way: 169 XP each \(143 of it from baking it\)\nNeeds \(from scratch\): 1\.261 Pot of flour, 1\.261 Bucket of water, 1\.261 Tomato, 1\.261 Cheese, 1 Cooked meat\nThe topping goes on a baked plain pizza: 26 XP for that, on top of the 143 for baking it\. Cooked chicken can go on instead\./);
    assert.equal((await card.locator('tr[data-method="ck_meat_pizza"]').innerText()).split('\t')[3].trim(), '169', 'its XP with the pizza baked on the way');
    assert.match(await tip('ck_pineapple_pizza'), /^Pineapple pizza: level 65, 45 XP each\nWith what's made on the way: 188 XP each \(143 of it from baking it\)\n/);
    assert.equal((await card.locator('tr[data-method="ck_pineapple_pizza"]').innerText()).split('\t')[3].trim(), '188', "the server's number (LostHQ's calculator has 195)");
    // the rest of the groups, and All
    await card.locator('[data-tgroup="Other"]').click();
    await card.locator('tr[data-method="ck_jug_wine"]').waitFor();
    assert.match(await tip('ck_jug_wine'), /^Jug of wine: level 35, 110 XP each/);
    await card.locator('[data-tgroup="Meat"]').click();
    await card.locator('tr[data-method="ck_cooked_chompy"]').waitFor();
    assert.match(await tip('ck_cooked_chompy'), /^Cooked chompy: level 30, 14 XP each/);
    await card.locator('[data-tgroup="all"]').click();
    await card.locator('tr[data-method="ck_shark"]').waitFor();
    assert.equal(await card.locator('tr[data-method]').count(), 54, 'Fish 21, Meat 12, Pies & pizza 7, Gnome 4, Other 10');
    assert.deepEqual((await card.locator('tr.grp').allInnerTexts()).map(flat), ['Fish', 'Meat', 'Pies & pizza', 'Gnome', 'Other']);
    await card.locator('[data-tgroup="Fish"]').click();
    // its prices: by the bank's groups
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="cooking"]');
    await page.waitForSelector('[data-price="raw_shark"]');
    assert.match(flat(await text('#prices-body')), /Raw fish .*Raw lobster.*Raw meat .*Raw beef.*Pies and bread .*Pot of flour.*Cooked: fish .*Lobster.*Cooked: pies and pizza .*Apple pie.*Cooked: the rest .*Jug of wine/);
  } finally {
    await setBank('cooking', Object.fromEntries(Object.keys(BANK).map(k => [k, ''])));
    await removeGoal(card);
    await noGoalFor('Cooking');
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="herblore"]');
  }
});

await check("thieving: no bank; pockets, stalls, chests and doors with the server's numbers, how often a theft works, and loot worth its coins", async () => {
  await planAs('old badger', 'Old Badger');
  await addGoal('thieving', 60);
  const card = goalCard('Thieving');
  try {
    await card.locator('.plan').waitFor();
    const t = flat(await card.innerText());
    assert.match(t, /Level 54 → 60/);
    assert.match(t, /Thieving takes nothing but a lockpick for some locks, so this plan doesn't use your bank\. Counts are thefts that work: one that fails gives no XP\./);
    assert.doesNotMatch(t, /From your bank|Use my bank|Round up|To collect or buy|Buying it all|Tickets exchanged/);
    assert.match(t, /To reach your goal: 122,770 XP/);
    // nothing picked: a pocket, the best one at level 54. (A chest is more XP and empty for minutes after;
    // Fremennik citizens, 65 XP at level 45, wait for a quest.) 30 coins a guard, and coins are worth what they are
    const plan = card.locator('.plan-sec', { hasText: 'To reach your goal' });
    assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'th_guard');
    assert.equal(flat(await plan.locator('.step').innerText()), '2,624 × Guard +122,803.2 XP');
    assert.match(flat(await plan.innerText()), /Loot: 30 coins\. Caught: stunned for 5 seconds, hit for 2\. Your loot is worth: 78,720 gp$/);
    assert.equal(await plan.locator('.step .item').getAttribute('title'), 'Coins', 'the pile a stack of 30 coins is in the game');
    // the calculator's four tabs, a group at a time
    assert.deepEqual((await card.locator('.plan-t thead th').allInnerTexts()).map(flat), ['Lvl', 'Target', 'XP', 'Net/item', 'gp/XP', 'To goal', 'Plan to make']);
    assert.deepEqual((await card.locator('.group-pick .chip').allInnerTexts()).map(flat), ['NPCs', 'Stalls', 'Chests', 'Doors', 'All']);
    assert.equal(flat(await card.locator('.group-pick .chip.on').innerText()), 'NPCs');
    const names = async () => (await card.locator('tr[data-method] td:nth-child(2)').allInnerTexts()).map(flat);
    assert.deepEqual(await names(), ['Man or woman', 'Farmer', 'Digsite workman', 'Warrior', 'Rogue', 'Guard', 'Fremennik citizen', 'Knight of Ardougne', 'Yanille watchman', 'Paladin', 'Gnome', 'Hero']);
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
    const tip = id => card.locator(`tr[data-method="${id}"]`).getAttribute('title');
    assert.deepEqual(await cells('th_knight'), ['55', 'Knight of Ardougne', '84.3', '+50', '−0.59', '1,457', ''], '50 coins a pocket: 0.59 gp made for every XP');
    assert.deepEqual((await cells('th_man')).slice(0, 5), ['1', 'Man or woman', '8', '+3', '−0.38']);
    assert.match(await card.locator('tr[data-method="th_knight"]').getAttribute('class'), /\bdim\b/, 'above level 54');
    // the server's level where it isn't the calculator's, and the rows only the server has
    assert.deepEqual((await cells('th_digworkman')).slice(0, 3), ['25', 'Digsite workman', '10.4']);
    assert.match(await tip('th_digworkman'), /A specimen brush can't be traded, so it isn't counted in what a theft is worth\. Caught: stunned for 5 seconds, hit for 1\. LostHQ's calculator says level 10; the server asks for 25\./);
    assert.match(await tip('th_fremennik'), /^Fremennik citizen: level 45, 65 XP each\nWorks about 58 in 100 tries at level 54; 94 in 100 at level 99\.\nLoot: 40 coins\. Caught: stunned for 5 seconds, hit for 2\. Once The Fremennik Trials is done\. Not on LostHQ's calculator: the server's own level and XP\./);
    // how often a pocket is picked at your level, by the server's roll; and its loot, as the server hands it out
    assert.match(await tip('th_rogue'),
      /^Rogue: level 32, 36\.5 XP each\nWorks about 64 in 100 tries at level 54; 94 in 100 at level 99\.\nLoot: 25 to 40 coins every time; now and then on top of that, 8 air runes \(8 in 116\), jug of wine \(6 in 122\), lockpick \(5 in 127\), iron dagger\(p\) \(1 in 128\)\. Caught: stunned for 5 seconds, hit for 2\./);
    assert.match(await tip('th_hero'), /^Hero: level 80, 273\.3 XP each\nWorks about 32 in 100 tries at level 80; 39 in 100 at level 99\.\nLoot: 200 to 300 coins every time/);
    assert.equal(await card.locator('tr[data-method="th_gnome"] .item').first().getAttribute('title'), 'King worm', 'what a gnome gives every time');
    // stalls: one thing by its weight, and how long one stays empty
    await card.locator('[data-tgroup="Stalls"]').click();
    await card.locator('tr[data-method="th_stall_gem"]').waitFor();
    assert.deepEqual(await names(), ['Bakery stall', 'Tea stall', 'Rock cake stall', 'Silk stall', 'Fur stall', 'Fur stall (Rellekka)', 'Fish stall (Rellekka)', 'Silver stall', 'Spice stall', 'Gem stall']);
    assert.match(await tip('th_stall_gem'), /^Gem stall: level 75, 16 XP each\nLoot: one of uncut sapphire \(105 in 128\), uncut emerald \(17 in 128\), uncut ruby \(5 in 128\) or uncut diamond \(1 in 128\)\. Empty for about 6 minutes after a theft\./);
    assert.match(await tip('th_stall_rockcake'), /^Rock cake stall: level 15, 6\.5 XP each\nLoot: rock cake\. A rock cake can't be traded.*In Gu'Tanoth, the ogres' city\. Not on LostHQ's calculator/);
    assert.deepEqual((await cells('th_stall_rockcake')).slice(2, 5), ['6.5', '+0', '0']);
    assert.equal(await card.locator('tr[data-method="th_stall_fish_rellekka"] .item').first().getAttribute('title'), 'Raw salmon', '14 times in 20');
    // chests: everything in them, every time
    await card.locator('[data-tgroup="Chests"]').click();
    await card.locator('tr[data-method="th_chest_castle"]').waitFor();
    assert.deepEqual(await names(), ['10 coin chest', 'Nature rune chest', '50 coin chest', 'Steel arrowtips chest', 'Blood rune chest', 'Ardougne castle chest']);
    assert.deepEqual((await cells('th_chest_10_coins')).slice(0, 5), ['13', '10 coin chest', '7.8', '+10', '−1.28']);
    assert.match(await tip('th_chest_10_coins'), /Empty for about 9 seconds after it's looted\. LostHQ's calculator says level 1; the server asks for 13\./);
    assert.match(await tip('th_chest_castle'), /^Ardougne castle chest: level 72, 500 XP each\nLoot: 1,000 coins, raw shark, adamantite ore and uncut sapphire\. Empty for about 8 minutes after it's looted\. A second trap then teleports you away\./);
    assert.match(await tip('th_chest_arrowtips'), /^Steel arrowtips chest: level 47, 150 XP each\nTools: Lockpick\nLoot: 5 steel arrowtips and 20 coins\./);
    // doors: a lock gives nothing but XP; some want a lockpick, some have a trap to get past first
    await card.locator('[data-tgroup="Doors"]').click();
    await card.locator('tr[data-method="th_door_yanille"]').waitFor();
    assert.deepEqual(await names(), ['Ardougne house door (10 coin chest)', 'Ross house door', 'Ardougne house door (nature rune chest)', 'Magic axe hut door', 'Ardougne sewer gate',
      'Pirate hideout door', 'Chaos Druid Tower door', 'Ardougne castle door', 'Yanille dungeon door']);
    assert.match(await tip('th_door_druid_tower'), /^Chaos Druid Tower door: level 46, 37\.5 XP each\nWorks about 17 in 100 tries at level 54; 30 in 100 at level 99\.\nThe lock has a trap that can go off first\./);
    assert.match(await tip('th_door_axe_hut'), /^Magic axe hut door: level 23, 25 XP each\nWorks about 41 in 100 tries at level 54; 69 in 100 at level 99\.\nTools: Lockpick\nLostHQ's calculator says 22\.5 XP; the server gives 25\./);
    assert.match(await tip('th_door_house_10'), /East of the market in East Ardougne: the house with a 10 coin chest\. Not on LostHQ's calculator/);
    await card.locator('tr[data-method="th_door_axe_hut"] td:nth-child(2)').click();
    await plan.locator('.step', { hasText: 'Magic axe hut door' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '4,911 × Magic axe hut door +122,775 XP');
    assert.equal(flat(await plan.locator('.collect', { hasText: 'Also bring' }).innerText()), 'Also bring: Lockpick');
    assert.doesNotMatch(flat(await plan.innerText()), /is worth|Net:/, 'nothing comes of a lock but XP');
    // a mix of your own: 500 pieces of silk first, then guards for the rest
    await card.locator('select[data-gopt="fill"]').selectOption('th_guard');
    await plan.locator('.step', { hasText: 'Guard' }).waitFor();
    await card.locator('[data-tgroup="Stalls"]').click();
    await card.locator('[data-mix="th_stall_silk"]').fill('500');
    await card.locator('[data-mix="th_stall_silk"]').press('Tab');
    await card.locator('.plan-sec', { hasText: 'Your mix +12,000 XP' }).waitFor();
    assert.match(flat(await card.locator('.plan-sec', { hasText: 'Your mix +12,000 XP' }).locator('.step').innerText()), /^500 × Silk stall \+12,000 XP/);
    assert.equal(flat(await card.locator('.plan-sec', { hasText: 'Then, to reach your goal' }).locator('.step').innerText()), '2,367 × Guard +110,775.6 XP');
    assert.match(flat(await card.locator('.plan-sec', { hasText: 'Then, to reach your goal' }).innerText()), /Your loot is worth: 71,010 gp/);
    await page.screenshot({ path: `${SHOTS}/10p-thieving.png`, fullPage: true });
    await card.locator('[data-act="mix-clear"]').click();
    // its prices: the loot, but for coins. No bank of its own
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="thieving"]');
    await page.waitForSelector('[data-price="silk"]');
    assert.match(flat(await text('#prices-body')), /^Loot .*Spade.*Lockpick.*King worm.*Silk.*Grey wolf fur.*Uncut diamond.*Adamantite ore/);
    assert.equal(await page.locator('[data-price="coins"], [data-price="coins_25"], [data-price="rockcake"]').count(), 0, 'coins are 1 gp each, and a rock cake can\'t be traded');
    await page.click('.tab[data-tab="bank"]');
    assert.equal(await page.locator('#bank-head [data-bskill="thieving"]').count(), 0);
  } finally {
    await removeGoal(card);
    await noGoalFor('Thieving');
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="herblore"]');
    await page.click('.tab[data-tab="goals"]');
  }
});

await check('agility: no bank and nothing to price; laps of a course; an Agility Arena ticket at the average of the batches a plan exchanges, or pinned to one', async () => {
  await planAs('old badger', 'Old Badger');
  await addGoal('agility', 70);
  const card = goalCard('Agility');
  try {
    await card.locator('.plan').waitFor();
    const t = flat(await card.innerText());
    assert.match(t, /Level 53 → 70/);
    assert.match(t, /Agility takes nothing and makes nothing to sell, so this plan doesn't use your bank or any prices\./);
    assert.doesNotMatch(t, /From your bank|Use my bank|Round up|To collect or buy|Buying it all|is worth|Net\/item|gp\/XP|Cheapest XP/);
    assert.match(t, /To reach your goal: 600,933 XP/);
    // nothing picked: laps of the best course at level 53
    const plan = card.locator('.plan-sec', { hasText: /reach your goal|fill the batch/ });
    assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'ag_wilderness');
    assert.equal(flat(await plan.locator('.step').innerText()), '1,052 laps of the Wilderness course +601,112.8 XP');
    assert.equal(flat(await card.locator('select[data-gopt="fill"] option:checked').innerText()), 'Wilderness course (lvl 52, 571.4 XP per lap)');
    assert.match(flat(await plan.innerText()), /5 obstacles in order, and the bonus for finishing the lap\. The ridge at its gate is 15 XP more each way, once a visit: LostHQ's calculator counts it in every lap \(586\.4 XP\)\.$/);
    assert.equal(await plan.locator('.money').count(), 0, 'no money to speak of');
    assert.equal(await plan.locator('.step .item.blank .ico-agility').count(), 1, 'no item to show: the skill\'s icon in its place');
    // courses, shortcuts and the arena, with no money columns
    assert.deepEqual((await card.locator('.plan-t thead th').allInnerTexts()).map(flat), ['Lvl', 'Course or obstacle', 'XP', 'To goal', 'Plan to make']);
    assert.deepEqual((await card.locator('.bar .seg button').allInnerTexts()).map(flat), ['Level', 'XP each']);
    assert.deepEqual((await card.locator('.group-pick .chip').allInnerTexts()).map(flat), ['Courses', 'Shortcuts', 'Agility Arena', 'All']);
    const names = async () => (await card.locator('tr[data-method] td:nth-child(2)').allInnerTexts()).map(flat);
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => flat(c));
    const tip = id => card.locator(`tr[data-method="${id}"]`).getAttribute('title');
    assert.deepEqual(await names(), ['Gnome Stronghold course per lap', 'Barbarian Outpost course per lap', 'Wilderness course per lap']);
    assert.deepEqual(await cells('ag_barbarian'), ['35', 'Barbarian Outpost course per lap', '139.5', '4,308', ''], 'three crumbling walls a lap, where the calculator counts one (114.5)');
    assert.equal(await tip('ag_barbarian'), 'Barbarian Outpost course: level 35, 139.5 XP per lap (obstacles 97.5 + lap bonus 42)\n7 obstacles in order, 3 of them crumbling walls, and the bonus for finishing the lap. '
      + "LostHQ's calculator counts one wall: 114.5 XP. The pipe into the course is 10 XP more, once a visit.");
    assert.equal(await tip('ag_gnome'), 'Gnome Stronghold course: level 1, 86.5 XP per lap (obstacles 47.5 + lap bonus 39)\n7 obstacles in order, and the bonus for finishing the lap.');
    assert.match(flat(await card.locator('.plan-sec').last().locator('.bar .small-note').last().innerText()), /^To goal = how many on their own · Plan to make = your mix of ways to train\. A row marked "per lap" counts laps\.$/);
    await card.locator('[data-tgroup="Shortcuts"]').click();
    await card.locator('tr[data-method="ag_rubble_yanille"]').waitFor();
    assert.deepEqual(await names(), ['A wooden log (Karamja)', 'Stepping stones (Karamja)', 'Crumbling wall (Falador)', 'Climbing rocks (Yanille)', 'Ropeswing (Brimhaven)', 'Monkeybars (Edgeville Dungeon)',
      'Climbing rocks (Watchtower)', 'Log balance (Coal Trucks)', 'Balancing ledge (Yanille Dungeon)', 'Obstacle pipe (Yanille Dungeon)', 'Monkeybars (Yanille Dungeon)', 'Pile of rubble (Yanille Dungeon)']);
    assert.deepEqual((await cells('ag_wall_falador')).slice(0, 3), ['5', 'Crumbling wall (Falador)', '12.5']);
    assert.equal(await tip('ag_wall_falador'), "Crumbling wall (Falador): level 5, 12.5 XP each\nLostHQ's calculator says 0.5 XP; the server gives 12.5, the same as a wall of the Barbarian Outpost course.");
    assert.equal(await tip('ag_stones_karamja'), "Stepping stones (Karamja): level 1, 3 XP each\nWorks about 62 in 100 tries at level 53; 99 in 100 at level 99.\nA slip still gives 1 XP. LostHQ's calculator says level 30; the server asks for none.");
    assert.equal(await tip('ag_ledge_yanille'), "Balancing ledge (Yanille Dungeon): level 40, 22.5 XP each\nWorks about 86 in 100 tries at level 53; every time from level 66.\nNot on LostHQ's calculator: the server's own level and XP.");
    assert.match(await card.locator('tr[data-method="ag_bars_yanille"]').getAttribute('class'), /\bdim\b/, 'level 57');
    // the Agility Arena: one row, a ticket. Its XP on the way, and what the tickets of this goal are exchanged for on average
    await card.locator('[data-tgroup="Agility Arena"]').click();
    await card.locator('tr[data-method="ag_ticket"]').waitFor();
    assert.deepEqual(await names(), ['Agility Arena ticket', 'Arena ticket you already have']);
    assert.deepEqual(await cells('ag_ticket'), ['1', 'Agility Arena ticket', '360.9', '1,666', '']);
    assert.match(await tip('ag_ticket'), /^Agility Arena ticket: level 1, 360\.9 XP each \(on the way 57\.8 \+ exchanged 303\.1\)\nOn average 3\.3 obstacles lie between one ticket pillar and the next: 57\.8 XP on the way\. Below level 40 some are shut and the way round is longer, so it's a little more\. A pillar a minute at best: the first one you tag gives no ticket, and neither does the one after a pillar you miss\. Going in costs 200 coins\.$/);
    assert.equal(await card.locator('.tip', { hasText: 'Arena tickets' }).count(), 0, 'no tickets in the plan yet');
    await card.locator('tr[data-method="ag_ticket"] td:nth-child(2)').click();
    await plan.locator('.step', { hasText: 'Agility Arena ticket' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '1,666 × Agility Arena ticket +601,259.4 XP');
    const tickets = plan.locator('.tip', { hasText: 'Arena tickets' });
    assert.equal(flat(await tickets.innerText()), 'Arena tickets: the 1,666 in this plan are exchanged together, as 1 × 1,000, 6 × 100, 2 × 25, 1 × 10 and 6 on their own: 303.1 XP each on average.');
    assert.equal(await plan.locator('.step .item').getAttribute('title'), 'Agility arena ticket');
    // the batch is a choice on the goal: pinned to 1,000 at a time, every ticket is 377.8 XP whatever the plan's size
    const batch = card.locator('select[data-opt="tickets"]');
    assert.deepEqual((await batch.locator('option').allInnerTexts()).map(flat), ['In the biggest batches', '1,000 at a time', '100 at a time', '25 at a time', '10 at a time', 'One at a time']);
    assert.match(await card.locator('label:has(select[data-opt="tickets"])').getAttribute('title'), /240 XP for one, 248 XP each for 10, 260 XP each for 25, 280 XP each for 100, 320 XP each for 1,000\./);
    await batch.selectOption('x1000');
    await plan.locator('.step', { hasText: '1,591' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '1,591 × Agility Arena ticket +601,079.8 XP');
    assert.equal(flat(await tickets.innerText()), 'Arena tickets: counted at 320 XP each, as exchanged 1,000 at a time. This plan has 1,591: the last 591 give theirs with the next full 1,000.');
    assert.deepEqual((await cells('ag_ticket')).slice(2, 4), ['377.8', '1,591']);
    assert.deepEqual((await goalOf('old_badger', 'agility')).opts, { tickets: 'x1000' });
    await batch.selectOption('x1');
    await plan.locator('.step', { hasText: '2,018' }).waitFor();
    assert.equal(flat(await tickets.innerText()), 'Arena tickets: counted at 240 XP each, as exchanged one at a time.');
    await batch.selectOption('best');
    await plan.locator('.step', { hasText: '1,666' }).waitFor();
    assert.equal((await goalOf('old_badger', 'agility')).opts, undefined, 'the first of the list is how it starts: nothing to keep');
    // tickets you've saved are typed in under Plan to make, and exchanged with the ones still to earn: 600 saved and
    // 100 laps of the Wilderness course leave 1,000 to earn, one batch of 1,000 and six of 100 in all
    await card.locator('[data-mix="ag_ticket_held"]').fill('600');
    await card.locator('[data-mix="ag_ticket_held"]').press('Tab');
    await card.locator('.plan-sec', { hasText: 'Your mix' }).locator('.step').first().waitFor();
    await card.locator('[data-tgroup="Courses"]').click();
    await card.locator('[data-mix="ag_wilderness"]').fill('100');
    await card.locator('[data-mix="ag_wilderness"]').press('Tab');
    await card.locator('.plan-sec', { hasText: 'Your mix +240,140 XP' }).waitFor();
    assert.deepEqual((await card.locator('.plan-sec', { hasText: 'Your mix' }).locator('.step').allInnerTexts()).map(flat), ['600 × Arena ticket you already have +183,000 XP', '100 laps of the Wilderness course +57,140 XP']);
    assert.match(flat(await plan.locator('h4').innerText()), /^Then, to reach your goal: 360,793 XP$/);
    assert.equal(flat(await plan.locator('.step').innerText()), '1,000 × Agility Arena ticket +362,800 XP');
    assert.equal(flat(await tickets.innerText()), "Arena tickets: the 1,600 in this plan are exchanged together, as 1 × 1,000 and 6 × 100: 305 XP each on average. That's 2,007 XP more than your goal needs: the batch has to be whole.");
    await page.screenshot({ path: `${SHOTS}/10q-agility.png`, fullPage: true });
    // 1,950 saved: at 320 each they'd cover the goal, but only as two whole thousands. The 50 that fill the batch are planned
    await card.locator('[data-act="mix-clear"]').click();
    await card.locator('[data-tgroup="Agility Arena"]').click();
    await card.locator('[data-mix="ag_ticket_held"]').fill('1950');
    await card.locator('[data-mix="ag_ticket_held"]').press('Tab');
    await card.locator('.plan-sec', { hasText: 'Your mix +624,000 XP' }).waitFor();
    assert.doesNotMatch(flat(await card.locator('.plan-sec', { hasText: 'Your mix +624,000 XP' }).locator('h4').innerText()), /That reaches your goal/);
    assert.match(flat(await plan.locator('h4').innerText()), /^Then, to fill the batch$/);
    assert.equal(flat(await plan.locator('.step').innerText()), '50 × Agility Arena ticket +18,890 XP');
    assert.equal(flat(await tickets.innerText()), "Arena tickets: the 2,000 in this plan are exchanged together, as 2 × 1,000: 320 XP each. That's 41,957 XP more than your goal needs: the batch has to be whole.");
    assert.deepEqual([(await cells('ag_ticket'))[5], (await cells('ag_ticket_held'))[5]], ['50', '–']);
    // only what's in the mix when the rest is laps: 250 tickets are two batches of 100 and two of 25
    await card.locator('[data-act="mix-clear"]').click();
    await card.locator('select[data-gopt="fill"]').selectOption('ag_wilderness');
    await card.locator('[data-tgroup="Agility Arena"]').click();
    await card.locator('[data-mix="ag_ticket"]').fill('250');
    await card.locator('[data-mix="ag_ticket"]').press('Tab');
    const mix = card.locator('.plan-sec', { hasText: 'Your mix +83,450 XP' });
    await mix.waitFor();
    assert.equal(flat(await mix.locator('.tip', { hasText: 'Arena tickets' }).innerText()), 'Arena tickets: the 250 in this plan are exchanged together, as 2 × 100 and 2 × 25: 276 XP each on average.');
    assert.equal(flat(await plan.locator('.step').innerText()), '906 laps of the Wilderness course +517,688.4 XP');
    assert.equal(await plan.locator('.tip', { hasText: 'Arena tickets' }).count(), 0, 'said once, where the tickets are');
    await card.locator('[data-act="mix-clear"]').click();
    // nothing to price: no Prices tab, and no bank of its own
    await page.click('.tab[data-tab="prices"]');
    assert.equal(await page.locator('#prices-head [data-bskill="agility"]').count(), 0);
    assert.equal(await page.locator('#prices-head [data-bskill="thieving"]').count(), 1);
    await page.click('.tab[data-tab="bank"]');
    assert.equal(await page.locator('#bank-head [data-bskill="agility"]').count(), 0);
  } finally {
    await removeGoal(card);
    await noGoalFor('Agility');
  }
});

// (back to Demo Main for the checks that follow, whatever happened above)
try { await planAs('demo main', 'Demo Main'); } catch (e) { results.push(['FAIL', 'back to Demo Main after the Old Badger checks', e.message.split('\n')[0]]); }

await check('mining: no bank, rocks to mine and what they are worth; limestone, a gem rock by its chances, and ore by the bar (steel: 2 coal to 1 iron)', async () => {
  const flat = t => t.replace(/\s+/g, ' ').trim();
  await addGoal('mining', 90);
  const card = page.locator('.goal', { hasText: 'Mining' });
  try {
    await card.locator('.plan').waitFor();
    const t = await card.innerText();
    assert.match(t, /Level 86 → 90/);           // (the Gains check trained 500,000 Mining XP)
    assert.match(t, /Mining only needs a pickaxe you have the level for \(bronze and iron from level 1, steel 6, mithril 21, adamant 31, rune 41\), so this plan doesn't use your bank\./);
    assert.doesNotMatch(t, /From your bank|Use my bank|To collect or buy|Buying it all|Also bring/);
    assert.match(t, /To reach your goal: 1,435,685 XP/);
    assert.match(t, /11,486 × Runite ore \+1,435,750 XP/, 'the most XP an ore at 86');
    assert.match(t, /What you make is worth/);
    // every rock of the calculator, and limestone
    const names = await card.locator('tr[data-method] td:nth-child(2)').allInnerTexts();
    assert.deepEqual(names.map(x => x.trim()), ['Clay', 'Rune essence', 'Copper ore', 'Tin ore', 'Blurite ore', 'Limestone', 'Iron ore', 'Silver ore', 'Coal', 'Gold ore', 'Gem rock', 'Mithril ore', 'Adamantite ore', 'Runite ore']);
    assert.deepEqual((await card.locator('.plan-t thead th').allInnerTexts()).map(flat), ['Lvl', 'Rock or bar', 'XP', 'Net/item', 'gp/XP', 'To goal', 'Plan to make']);
    // rocks are what the table shows, and what a plan picks, until you ask for bars
    assert.deepEqual((await card.locator('.group-pick .chip').allInnerTexts()).map(flat), ['Rocks', 'Bars', 'All']);
    assert.equal(flat(await card.locator('.group-pick .chip.on').innerText()), 'Rocks');
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
    assert.deepEqual((await cells('mi_limestone')).slice(0, 3), ['10', 'Limestone', '26.5']);
    assert.deepEqual([(await cells('mi_limestone'))[5], (await cells('mi_coal'))[5]], ['54,177', '28,714'], 'To goal: 1,435,685 XP at 26.5 and at 50 each');
    assert.match(await card.locator('tr[data-method="mi_limestone"]').getAttribute('title'), /Limestone: level 10, 26\.5 XP each\nNot on LostHQ's calculator: the server's own level and XP\./);
    // a gem rock: shown as the calculator shows it, and worth its chances
    assert.equal(await card.locator('tr[data-method="mi_gemrock"] .item').first().getAttribute('title'), 'Uncut red topaz');
    assert.match(await card.locator('tr[data-method="mi_gemrock"]').getAttribute('title'), /Gem rock: level 40, 65 XP each\nIn Shilo Village\. One gem a rock, by chance \(out of 128\): opal 60, jade 30, red topaz 15, sapphire 9, emerald 5, ruby 5, diamond 4\./);
    await card.locator('select[data-gopt="fill"]').selectOption('mi_gemrock');
    await card.locator('.step', { hasText: 'Gem rock' }).waitFor();
    assert.match(flat(await card.innerText()), /22,088 × Gem rock \+1,435,720 XP In Shilo Village\. One gem a rock, by chance/);
    // Bars: the ore a bar takes, mined in the furnace's own proportions. Steel is 1 iron ore and 2 coal
    await card.locator('[data-tgroup="Bars"]').click();
    await card.locator('tr[data-method="mi_bar_steel_bar"]').waitFor();
    assert.deepEqual((await card.locator('tr[data-method] td:nth-child(2)').allInnerTexts()).map(x => flat(x).replace(/ per bar$/, '')),
      ['Bronze bar', 'Iron bar', 'Iron bar (ring of forging)', 'Silver bar', 'Steel bar', 'Gold bar', 'Mithril bar', 'Adamantite bar', 'Runite bar']);
    const steel = await cells('mi_bar_steel_bar');
    assert.deepEqual([steel[0], flat(steel[1]), steel[2], steel[5]], ['30', 'Steel bar per bar', '135', '10,635'], '35 XP for the iron ore and 100 for the coal; 1,435,685 XP at 135 a bar');
    assert.match(await card.locator('tr[data-method="mi_bar_steel_bar"]').getAttribute('title'),
      /^Steel bar: level 30, 135 XP per bar \(iron ore 35 \+ 2 coal 100\)\nMine 1 iron ore and 2 coal for each bar\. Smelting it takes Smithing 30\./);
    assert.deepEqual([(await cells('mi_bar_mithril_bar'))[2], (await cells('mi_bar_adamantite_bar'))[2], (await cells('mi_bar_runite_bar'))[2]], ['280', '395', '525'], '4, 6 and 8 coal a bar');
    // iron loses half its ore in a furnace: 2 ore a bar, or 1 with a ring of forging (a row of its own)
    assert.deepEqual([(await cells('mi_bar_iron_bar'))[2], (await cells('mi_bar_iron_bar_ring'))[2]], ['70', '35']);
    assert.match(await card.locator('tr[data-method="mi_bar_iron_bar"]').getAttribute('title'), /Mine 2 iron ore for each bar\. Half the ore is lost in a furnace, so a bar takes 2 on average/);
    await card.locator('tr[data-method="mi_bar_steel_bar"] td:nth-child(2)').click();
    await card.locator('.step', { hasText: 'steel bars' }).waitFor();
    assert.equal(flat(await card.locator('.plan-sec', { hasText: 'To reach your goal' }).locator('.step').innerText()),
      'Ore for 10,635 steel bars: 10,635 Iron ore + 21,270 Coal +1,435,725 XP');
    assert.equal(flat(await card.locator('select[data-gopt="fill"] option:checked').innerText()), 'Steel bar (lvl 30, 135 XP per bar)');
    assert.deepEqual(await card.locator('select[data-gopt="fill"] optgroup').evaluateAll(gs => gs.map(g => `${g.label} ${g.children.length}`)), ['Rocks 14', 'Bars 9']);
    assert.match(flat(await card.locator('.plan-sec').last().locator('.bar .small-note').last().innerText()), /A row marked "per bar" counts bars\.$/);
    // in a mix too: 1,000 steel bars' worth first, the rest after
    await card.locator('[data-mix="mi_bar_steel_bar"]').fill('1000');
    await card.locator('[data-mix="mi_bar_steel_bar"]').press('Tab');
    await card.locator('.plan-sec', { hasText: 'Your mix +135,000 XP' }).waitFor();
    // (by its XP: once ore and coal have a price, the section after it says "With your mix" too)
    assert.match(flat(await card.locator('.plan-sec', { hasText: 'Your mix +135,000 XP' }).locator('.step').innerText()), /^Ore for 1,000 steel bars: 1,000 Iron ore \+ 2,000 Coal \+135,000 XP/);
    assert.equal(flat(await card.locator('.plan-sec', { hasText: 'Then, to reach your goal' }).locator('.step').innerText()),
      'Ore for 9,635 steel bars: 9,635 Iron ore + 19,270 Coal +1,300,725 XP');
    await page.screenshot({ path: `${SHOTS}/10k-mining-bars.png`, fullPage: true });
    await card.locator('[data-act="mix-clear"]').click();
    // its prices: what it makes, the gems among them
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="mining"]');
    await page.waitForSelector('[data-price="runite_ore"]');
    assert.match(flat(await text('#prices-body')), /Ores and gems.*Clay.*Rune essence.*Limestone.*Coal.*Uncut opal.*Uncut diamond.*Runite ore/);
    assert.equal(await page.locator('#bank-head [data-bskill="mining"], #bank-body [data-bskill="mining"]').count(), 0);
  } finally {
    await page.click('.tab[data-tab="goals"]');
    if (await card.count()) {
      await card.locator('[data-act="remove-goal"]').click();
      await card.locator('[data-act="remove-goal"]').click();
    }
    await page.waitForFunction(() => ![...document.querySelectorAll('.goal')].some(g => g.innerText.includes('Mining')));
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="herblore"]');
  }
});

await check('smithing: ore is smelted on the way; bars bought, smelted or superheated; a ring of forging and goldsmith gauntlets', async () => {
  const flat = t => t.replace(/\s+/g, ' ').trim();
  const BANK = { iron_ore: '1000', coal: '1200', ring_of_forging: '3', gold_ore: '500', naturerune: '300', firerune: '5000' };
  const card = page.locator('.goal', { hasText: 'Smithing' });
  try {
    await setBank('smithing', BANK);
    // the Smithing bank: ores, bars, the ring and the runes, then what each metal makes
    assert.deepEqual((await page.locator('#bank-body .bank-group h4, #bank-body .group-title, #bank-body h4').allInnerTexts()).map(flat).filter(Boolean).slice(0, 4),
      ['Ores and coal', 'Bars', 'Ring of forging and runes for Superheat', 'Made: bronze']);
    await addGoal('smithing', 80);
    const sec = card.locator('.plan-sec').first();
    await card.locator('.step', { hasText: 'Steel platebody' }).first().waitFor();
    const steps = async () => (await sec.locator('.step').allInnerTexts()).map(flat);
    const then = card.locator('.plan-sec', { hasText: 'reach your goal' }).first();
    // The choices: where the bars come from (bought, to start with), a ring of forging, goldsmith gauntlets
    assert.match(flat(await card.locator('.plan-opts').innerText()), /^Use my bank Round up my supplies Bars Buy them Smelt them Superheat them Ring of forging Goldsmith gauntlets \d+ kinds of item in your bank/);
    assert.equal(await card.locator('select[data-opt="bars"]').inputValue(), 'buy');
    assert.match(await card.locator('label:has(select[data-opt="bars"])').getAttribute('title'), /^Buy them: what's still to buy is bars .*Superheat them: the same, made with Superheat Item \(Magic 43\): a nature rune and 4 fire runes a bar, 53 Magic XP each, and iron never fails\.$/);
    assert.match(await card.locator('label:has(input[data-opt="ring"])').getAttribute('title'), /one lasts 140 bars.*an iron bar takes 2 ore on average\.$/);
    // As it is: steel gets the ore first, as far as the coal goes; iron loses half its ore; gold is 22.5 XP
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +51,750 XP → level 73');
    let st = await steps();
    assert.equal(st.length, 3, st.join(' / '));
    assert.match(st[0], /^120 × Steel platebody \+33,000 XP .*incl\. 600 × Steel bar \+10,500 XP$/);
    assert.match(st[1], /^40 × Iron platebody \+7,500 XP .*incl\. 200 × Iron bar \+2,500 XP$/);
    assert.match(st[2], /^500 × Gold bar \+11,250 XP/);
    assert.equal(await sec.locator('.tip.magic').count(), 0);
    // the rest: steel platebodies, with the bars to buy and a hammer
    assert.match(flat(await then.locator('.step').innerText()), /^5,293 × Steel platebody \+992,437\.5 XP$/);
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 26,465 Steel bar/);
    assert.match(flat(await then.innerText()), /Also bring: Hammer/);
    // the table: a tab a metal, steel's showing; things made several to a bar are counted in bars
    const chips = async () => (await card.locator('.group-pick .chip').allInnerTexts()).map(x => x.trim());
    const METALS = ['Smelting', 'Bronze', 'Iron', 'Steel', 'Mithril', 'Adamant', 'Rune', 'All'];
    assert.deepEqual(await chips(), METALS);
    assert.equal((await card.locator('.group-pick .chip.on').innerText()).trim(), 'Steel');
    // ...in that order whatever the table is sorted by (v2.6.0 put them in the order of the sorted rows)
    for (const sort of ['xp', 'cheap', 'net', 'level']) {
      await card.locator(`[data-tsort-plan="${sort}"]`).click();
      await card.locator(`[data-tsort-plan="${sort}"].on`).waitFor();
      assert.deepEqual(await chips(), METALS, `sorted by ${sort}`);
      await card.locator('[data-tgroup="all"]').click();
      assert.deepEqual(await chips(), METALS, `sorted by ${sort}, showing All`);
      await card.locator('[data-tgroup="Steel"]').click();
    }
    assert.equal(await card.locator('tr[data-method]').count(), 24);
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
    assert.deepEqual((await cells('sm_steel_platebody')).slice(1, 4), ['48', 'Steel platebody', '187.5']);
    assert.match((await cells('sm_steel_arrowheads'))[2], /^Steel arrowtips\s*per bar$/);
    assert.match(await card.locator('tr[data-method="sm_mcannonball"]').getAttribute('title'), /Cannonball: level 35, 37\.5 XP per bar\nNeeds \(from scratch\): 1 Steel bar\nTools: Ammo mould\nMade at a furnace, not an anvil, with an ammo mould \(from Dwarf Cannon\)\./);
    assert.match(await card.locator('tr[data-method="sm_steel_claws"]').getAttribute('title'), /Tools: Hammer\nClaws can be smithed once Death Plateau is done\./);
    assert.match(flat(await card.locator('.plan-sec').last().locator('.bar .small-note').last().innerText()), /A row marked "per bar" counts bars\.$/);

    // Smelt them: ore and coal to buy, and the smelting XP counts, so it takes fewer
    await card.locator('select[data-opt="bars"]').selectOption('smelt');
    await then.locator('.step', { hasText: '3,609 × Steel platebody' }).waitFor();
    assert.match(flat(await then.locator('.step').innerText()), /^3,609 × Steel platebody \+992,475 XP incl\. 18,045 × Steel bar \+315,787\.5 XP$/);
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 18,045 Iron ore( \([\d.,]+[KM]?\))? 36,090 Coal/);
    assert.match(flat(await card.locator('select[data-gopt="fill"] option:checked').innerText()), /^Steel platebody \(lvl 48, 275 XP\)$/);
    assert.deepEqual((await cells('sm_steel_platebody')).slice(1, 4), ['48', 'Steel platebody', '275'], 'the XP with its five bars smelted');
    assert.match(await card.locator('tr[data-method="sm_steel_platebody"]').getAttribute('title'),
      /Steel platebody: level 48, 187\.5 XP each\nWith what's made on the way: 275 XP each \(87\.5 of it from your own bars\)\nNeeds \(from scratch\): 5 Iron ore, 10 Coal\nTools: Hammer/);
    assert.match(flat(await card.locator('.plan-sec').last().locator('.bar .small-note').last().innerText()), /XP and counts include the bars you make on the way\.$/);
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +51,750 XP → level 73', 'your bank makes the same either way');

    // Superheat them: the runes too, the Magic XP, and no ring to tick. The bank goes as far as its 300 nature runes.
    await card.locator('select[data-opt="bars"]').selectOption('superheat');
    await sec.locator('h4', { hasText: '+16,500 XP' }).waitFor();
    assert.equal(await card.locator('input[data-opt="ring"]').count(), 0, 'iron never fails that way');
    st = await steps();
    assert.equal(st.length, 1, st.join(' / '));
    assert.match(st[0], /^60 × Steel platebody \+16,500 XP .*incl\. 300 × Steel bar \+5,250 XP$/);
    assert.equal(flat(await sec.locator('.tip.magic').innerText()), 'Magic XP on the way: +15,900 XP from 300 × Superheat Item (Magic 43)');
    assert.match(flat(await then.locator('.step').innerText()), /^3,737 × Steel platebody \+1,027,675 XP incl\. 18,685 × Steel bar \+326,987\.5 XP$/);
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 17,985 Iron ore( \([\d.,]+[KM]?\))? 36,770 Coal( \([\d.,]+[KM]?\))? 18,685 Nature rune( \([\d.,]+[KM]?\))? 70,940 Fire rune/);
    assert.equal(flat(await then.locator('.tip.magic').innerText()), 'Magic XP on the way: +990,305 XP from 18,685 × Superheat Item (Magic 43)');
    assert.match(await card.locator('label:has(input[data-gopt="roundUp"])').getAttribute('title'), /Rings of forging and runes never hold it back: what you're short of is collected too\.$/);
    // rounded up, the runes short are collected: all 1,000 ore become steel, with the coal for it
    await card.locator('input[data-gopt="roundUp"]').check();
    await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
    st = await steps();
    assert.match(st[0], /^120 × Steel platebody \+33,000 XP .*incl\. 600 × Steel bar \+10,500 XP collect 300 Nature rune$/);
    assert.match(flat(await sec.locator('.collect').innerText()), /^To round up your supplies, collect: .*Nature rune/);
    await page.screenshot({ path: `${SHOTS}/10i-smithing-superheat.png`, fullPage: true });
    await card.locator('input[data-gopt="roundUp"]').uncheck();

    // Back to buying bars, with a ring of forging and goldsmith gauntlets: the 400 ore left for iron are 400 bars,
    // out of the 3 rings in the bank, and gold is 56.2 XP
    await card.locator('select[data-opt="bars"]').selectOption('buy');
    await card.locator('input[data-opt="ring"]').check();
    await card.locator('input[data-opt="gauntlets"]').check();
    await sec.locator('h4', { hasText: '+76,100 XP' }).waitFor();
    st = await steps();
    assert.equal(st.length, 3, st.join(' / '));
    assert.match(st[1], /^80 × Iron platebody \+15,000 XP .*incl\. 3 × Ring of forging \(140 bars\), 400 × Iron bar \+5,000 XP$/);
    assert.match(st[2], /^500 × Gold bar \+28,100 XP/);
    await card.locator('[data-tgroup="Smelting"]').click();
    assert.deepEqual((await card.locator('tr[data-method] td:nth-child(3)').allInnerTexts()).map(x => x.trim()),
      ['Bronze bar', 'Iron bar', 'Elemental metal', 'Silver bar', 'Steel bar', 'Gold bar', 'Mithril bar', 'Adamantite bar', 'Runite bar']);
    const iron = await cells('sm_iron_bar');
    assert.deepEqual([iron[1], iron[3], iron[6]], ['15', '12.5', '420'], '3 rings: 420 bars from the bank on its own');
    assert.match(iron[8], /^5\s*→\s*1,000$/);
    assert.equal(await card.locator('tr[data-method="sm_iron_bar"] td.even').getAttribute('title'), 'Collect 5 Ring of forging, and your bank covers 1,000 × Iron bar instead of 420.');
    assert.match(await card.locator('tr[data-method="sm_iron_bar"]').getAttribute('title'),
      /Iron bar: level 15, 12\.5 XP each\nNeeds \(from scratch\): 1 Iron ore, 1\/140 Ring of forging\nWith a ring of forging every ore is a bar\. A ring lasts 140 bars, and they're counted\./);
    assert.equal((await cells('sm_gold_bar'))[3], '56.2');
    await page.screenshot({ path: `${SHOTS}/10j-smithing-ring.png`, fullPage: true });
    // the choices are kept with the goal
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.goals.demo_main')).find(g => g.skill === 'smithing').opts);
    assert.deepEqual(kept, { ring: true, gauntlets: true }, 'buying bars is how it starts, so it isn\'t kept');
    // its prices: by the bank's groups
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="smithing"]');
    await page.waitForSelector('[data-price="runite_ore"]');
    assert.match(flat(await text('#prices-body')), /Ores and coal.*Copper ore.*Coal.*Bars.*Runite bar.*Ring of forging and runes for Superheat.*Nature rune.*Made: bronze.*Bronze wire.*Made: steel.*Cannonball.*Steel studs.*Made: rune.*Rune platebody/);
  } finally {
    // leave things as they were, whatever happened
    await setBank('smithing', Object.fromEntries(Object.keys(BANK).map(k => [k, ''])));
    await page.click('.tab[data-tab="goals"]');
    if (await card.count()) {
      await card.locator('[data-act="remove-goal"]').click();
      await card.locator('[data-act="remove-goal"]').click();
    }
    await page.waitForFunction(() => ![...document.querySelectorAll('.goal')].some(g => g.innerText.includes('Smithing')));
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="herblore"]');
  }
});

await check('firemaking: the bank\'s logs burn toward the goal, best first', async () => {
  await setBank('firemaking', { willow_logs: '10k' });
  assert.match(await text('#bank-head'), /Achey tree logs aren't listed/);
  await addGoal('firemaking', 75);
  const card = page.locator('.goal', { hasText: 'Firemaking' });
  await card.locator('.plan').waitFor();
  const t = await cardText('Firemaking');
  assert.match(t, /1,000 × Yew logs \+202,500 XP/, 'the yew logs from the Fletching tab: one bank');
  assert.match(t, /10,000 × Willow logs \+900,000 XP\s*Goal after 1,709/);
  assert.match(t, /That reaches your goal/);
  assert.doesNotMatch(t, /Then, to reach your goal/);
  // one thing to a fire: nothing to round up, so no tick box for it
  assert.equal(await card.locator('input[data-gopt="roundUp"]').count(), 0);
});

await check('prices: Woodcutting has a prices tab for its logs', async () => {
  await page.click('.tab[data-tab="prices"]');
  await page.click('[data-bskill="woodcutting"]');
  await page.waitForSelector('[data-price="magic_logs"]');
  assert.match(await text('#prices-body'), /Bark/);
  await page.click('.tab[data-tab="bank"]');
  await page.waitForSelector('#bank-head [data-bskill="firemaking"].active');    // the Bank tab keeps its own
  await page.click('.tab[data-tab="goals"]');
});

await check('bank: read from screenshots, review, then update', async () => {
  await page.click('.tab[data-tab="bank"]');
  await page.waitForSelector('#bank-shots .shots-drop');
  assert.match(await text('#bank-shots'), /Pictures › LostKit Screenshots/);
  const shot = (name, opts) => ({ name, mimeType: 'image/png', buffer: encodePng(fakeBank(opts)) });
  const items = [
    { slot: 0, icon: 'lawrune', count: 3960 },
    { slot: 1, icon: 'bloodrune', count: 3309 },
    { slot: 2, icon: 'blankrune', count: 150420 },
    { slot: 3, icon: 'bronze_arrow_5', count: 5000 },
    { slot: 4, icon: 'unidentified_guam', count: 25 },
    { slot: 5, icon: 'unidentified_ardrigal', count: 10 },
    { slot: 6, icon: 'chisel', count: 1 },                        // tools and thread aren't added to your bank
    { slot: 7, icon: 'thread', count: 643 },
    { slot: 48, icon: 'willow_logs', count: 814 },
  ];
  await page.setInputFiles('#shots-file', [
    shot('screenshot-1.png', { items, scroll: 0 }),
    shot('screenshot-2.png', { items, scroll: 120 }),
    shot('not-a-bank.png', { items: [], width: 400 }),
  ]);
  await page.waitForSelector('#bank-shots .shots-result', { timeout: 45000 });
  const t = await text('#bank-shots');
  assert.match(t, /From 2 screenshots: 5 of your planner items/);
  assert.match(t, /3 other items the planner doesn't count were skipped \(tools and thread among them\)/);
  assert.equal(await page.locator('[data-shot="chisel"], [data-shot="thread"]').count(), 0);
  assert.match(t, /not-a-bank\.png: no bank in this one/);
  assert.match(t, /Law rune\s*3,960/);
  assert.match(t, /Rune essence\s*≈150K/);
  assert.match(t, /Bronze arrow\s*5,000/);
  // lantadyme looks just like an unid herb, so that stack has the choice; an unid herb with an icon of its own doesn't
  assert.equal(await page.locator('[data-shot-as="unidentified_guam@0"]').inputValue(), 'unidentified_guam');
  assert.deepEqual(await page.locator('[data-shot-as="unidentified_guam@0"] option').allInnerTexts(), ['Unid herb', 'Lantadyme']);
  assert.match(await page.locator('.shot-row', { has: page.locator('[data-shot="unidentified_guam@0"]') }).innerText(), /\s25\s/);
  assert.match(await page.locator('.shot-row', { has: page.locator('[data-shot="unidentified_guam"]') }).innerText(), /^\s*Unid herb\s*10\s*$/);
  assert.doesNotMatch(t, /look exactly like another item/, 'no nudge for unid herbs');
  assert.match(t, /Willow logs\s*814/);
  await page.locator('[data-shot="willow_logs"]').uncheck();
  // the list is redrawn as prices arrive: what you unticked stays unticked
  await page.evaluate(() => window.__skills.prices.dispatchEvent(new CustomEvent('update', { detail: {} })));
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('[data-shot="willow_logs"]').isChecked(), false);
  await page.click('[data-act="shots-apply"]');
  await page.waitForSelector('#bank-msg:not([hidden])');
  assert.match(await text('#bank-msg'), /Bank updated from your screenshots: 4 items changed/);
  await page.click('[data-bskill="runecraft"]');
  assert.equal(await page.inputValue('[data-bank="lawrune"]'), '3,960');
  assert.equal(await page.inputValue('[data-bank="blankrune"]'), '150,000', 'the low end of 150K');
  await page.click('[data-bskill="herblore"]');
  assert.equal(await page.inputValue('[data-bank="unidentified_guam"]'), '35');
  assert.equal(await page.locator('#bank-shots .shots-result').count(), 0, 'back to the drop box');
  // the icons it compares with come from the sheet its data names, by its stamped address (as items.png does)
  assert.match(BANK_ICON_SHEET, /^bankicons\.png\?v=[0-9a-f]{10}$/);
  assert.deepEqual([...new Set(requested.filter(u => /\/bankicons\.png/.test(u)))], [`${BASE}/${BANK_ICON_SHEET}`]);
});

await check('bank: a stack that looks exactly like two items asks which it is: soda ash, not ashes', async () => {
  const flat = t => t.replace(/\s+/g, ' ').trim();
  const saved = await page.evaluate(() => localStorage.getItem('lchs.bank.demo_main'));
  // as v2.5.0 left it: the soda ash filed under Ashes (54 more of it have been collected since)
  await setBank('herblore', { ashes: '1180' });
  const items = [
    { slot: 0, icon: 'gold_bar', count: 300 },
    { slot: 1, icon: 'ashes', count: 1234 },                     // soda ash and ashes are drawn the same
    { slot: 2, icon: 'ring_of_recoil', count: 500 },             // so are a sapphire ring and a ring of recoil
    { slot: 3, icon: 'keyhalf1', count: 9 },
  ];
  const shot = { name: 'screenshot-4.png', mimeType: 'image/png', buffer: encodePng(fakeBank({ items })) };
  const rowOf = key => page.locator('.shot-row', { has: page.locator(`[data-shot="${key}"]`) });
  await page.setInputFiles('#shots-file', [shot]);
  await page.waitForSelector('#bank-shots .shots-result', { timeout: 45000 });
  assert.match(flat(await text('#bank-shots .note')), /2 of them look exactly like another item \(soda ash and ashes, a sapphire ring and a ring of recoil\): pick which each is from its drop-down\. Your pick is kept for next time\.$/);
  // soda ash until you say otherwise. The whole bank was read and nothing else in it could be the
  // ashes an earlier read filed, so they are this stack
  const ash = page.locator('[data-shot-as="ashes@0"]');
  assert.equal(await ash.inputValue(), 'soda_ash');
  assert.deepEqual(await ash.locator('option').allInnerTexts(), ['Ashes', 'Soda ash']);
  assert.match(flat(await rowOf('ashes@0').innerText()), /1,234 was 1,180 under Ashes$/);
  assert.doesNotMatch(flat(await page.locator('.shot-clear').first().innerText()), /Ashes/, 'not among the items to clear: it moves');
  assert.match(await rowOf('ashes@0').getAttribute('class'), /\btwin\b/);
  const ring = page.locator('[data-shot-as="ring_of_recoil@0"]');
  assert.equal(await ring.inputValue(), 'ring_of_recoil', 'the enchanted one, as a bank mostly holds');
  assert.match(flat(await rowOf('gold_bar').innerText()), /^Gold bar 300 was 0$/);
  assert.equal(await rowOf('gold_bar').locator('select').count(), 0);
  // opening a drop-down doesn't untick its line
  await ash.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-shot="ashes@0"]').isChecked(), true);
  // these are sapphire rings
  await ring.selectOption('sapphire_ring');
  await page.waitForFunction(() => document.querySelector('[data-shot-as="ring_of_recoil@0"]')?.value === 'sapphire_ring');
  assert.equal(await ash.inputValue(), 'soda_ash', 'the other pick is kept through the redraw');
  await page.screenshot({ path: `${SHOTS}/9c-bank-lookalikes.png`, fullPage: true });
  await page.click('[data-act="shots-apply"]');
  await page.waitForSelector('#bank-msg:not([hidden])');
  assert.match(await text('#bank-msg'), /Bank updated from your screenshots: 5 items changed/, 'soda ash, the ashes it moved from, sapphire rings, gold bars and key teeth');
  await page.click('[data-bskill="crafting"]');
  assert.equal(await page.inputValue('[data-bank="soda_ash"]'), '1,234');
  assert.equal(await page.inputValue('[data-bank="sapphire_ring"]'), '500');
  assert.equal(await page.inputValue('[data-bank="ring_of_recoil"]'), '');
  await page.click('[data-bskill="herblore"]');
  assert.equal(await page.inputValue('[data-bank="ashes"]'), '', 'moved to soda ash');
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.bank.demo_main')).twins);
  assert.deepEqual([kept.ashes, kept.ring_of_recoil], [['soda_ash'], ['sapphire_ring']], 'your picks, for next time');
  // the same screenshot again: your picks are remembered, and nothing changes
  await page.setInputFiles('#shots-file', [shot]);
  await page.waitForSelector('#bank-shots .shots-result', { timeout: 45000 });
  assert.equal(await page.locator('[data-shot-as="ashes@0"]').inputValue(), 'soda_ash');
  assert.equal(await page.locator('[data-shot-as="ring_of_recoil@0"]').inputValue(), 'sapphire_ring');
  assert.match(flat(await rowOf('ashes@0').innerText()), /1,234 same$/);
  assert.equal(await page.locator('.shot-row.changed').count(), 0);
  // it was ashes after all: it moves back
  await page.locator('[data-shot-as="ashes@0"]').selectOption('ashes');
  await page.waitForFunction(() => /was under Soda ash/.test(document.querySelector('#bank-shots').innerText));
  await page.click('[data-act="shots-apply"]');
  await page.waitForSelector('#bank-msg:not([hidden])');
  await page.click('[data-bskill="herblore"]');
  assert.equal(await page.inputValue('[data-bank="ashes"]'), '1,234');
  await page.click('[data-bskill="crafting"]');
  assert.equal(await page.inputValue('[data-bank="soda_ash"]'), '');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.bank.demo_main')).twins.ashes), ['ashes']);
  // (the bank as it was, for the checks that follow)
  await page.evaluate(v => localStorage.setItem('lchs.bank.demo_main', v), saved);
  await page.click('[data-bskill="herblore"]');
});

await check('bank: an uncharged amulet of glory is an item of its own; stacks that look like a glory get a drop-down each', async () => {
  const saved = await page.evaluate(() => localStorage.getItem('lchs.bank.demo_main'));
  try {
    await page.click('.tab[data-tab="bank"]');
    // a charged glory, an uncharged one and a strung dragonstone amulet are drawn the same: three such stacks
    const items = [
      { slot: 0, icon: 'amulet_of_glory_4', count: 3 },
      { slot: 1, icon: 'gold_bar', count: 300 },
      { slot: 2, icon: 'amulet_of_glory_4', count: 12 },
      { slot: 3, icon: 'amulet_of_glory_4', count: 5 },
    ];
    const shot = { name: 'screenshot-5.png', mimeType: 'image/png', buffer: encodePng(fakeBank({ items })) };
    await page.setInputFiles('#shots-file', [shot]);
    await page.waitForSelector('#bank-shots .shots-result', { timeout: 45000 });
    const picks = () => page.locator('[data-shot-as^="amulet_of_glory_4@"]').evaluateAll(els => els.map(e => e.value));
    // one of each until you say otherwise, in the order a bank is most likely to hold them
    assert.deepEqual(await picks(), ['amulet_of_glory_4', 'amulet_of_glory', 'strung_dragonstone_amulet']);
    assert.deepEqual(await page.locator('[data-shot-as="amulet_of_glory_4@1"] option').allInnerTexts(), ['Amulet of glory(4)', 'Amulet of glory (uncharged)', 'Dragonstoneamulet']);
    assert.match(flat(await text('#bank-shots .note')), /3 of them look exactly like another item .*: pick which each is from its drop-down\. Your pick is kept for next time\.$/);
    assert.match(flat(await page.locator('.shot-row', { has: page.locator('[data-shot="amulet_of_glory_4@1"]') }).innerText()), /or Amulet of glory \(fewer charges\): they look the same 12 was 0$/);
    // the first stack is the uncharged ones here, and the second the charged
    await page.locator('[data-shot-as="amulet_of_glory_4@0"]').selectOption('amulet_of_glory');
    await page.waitForFunction(() => document.querySelector('[data-shot-as="amulet_of_glory_4@0"]')?.value === 'amulet_of_glory');
    await page.locator('[data-shot-as="amulet_of_glory_4@1"]').selectOption('amulet_of_glory_4');
    await page.waitForFunction(() => document.querySelector('[data-shot-as="amulet_of_glory_4@1"]')?.value === 'amulet_of_glory_4');
    assert.deepEqual(await picks(), ['amulet_of_glory', 'amulet_of_glory_4', 'strung_dragonstone_amulet']);
    await page.screenshot({ path: `${SHOTS}/9d-bank-glory.png`, fullPage: true });
    await page.click('[data-act="shots-apply"]');
    await page.waitForSelector('#bank-msg:not([hidden])');
    // each lands under its own entry: the uncharged one sits just before the charged one in the Crafting bank
    await page.click('[data-bskill="crafting"]');
    await page.waitForSelector('[data-bank="amulet_of_glory"]');
    assert.deepEqual([await page.inputValue('[data-bank="amulet_of_glory"]'), await page.inputValue('[data-bank="amulet_of_glory_4"]'), await page.inputValue('[data-bank="strung_dragonstone_amulet"]')], ['3', '12', '5']);
    const made = await page.locator('#bank-body .bank-group', { hasText: 'Made: enchanted jewellery' }).locator('[data-bank]').evaluateAll(els => els.map(e => e.dataset.bank));
    assert.deepEqual(made.slice(-2), ['amulet_of_glory', 'amulet_of_glory_4']);
    assert.match(flat(await page.locator('#bank-body .bank-group', { hasText: 'Made: enchanted jewellery' }).innerText()), /Amulet of glory \(uncharged\).*Amulet of glory\(4\)/);
    // read again, the picks are remembered: nothing to change
    await page.setInputFiles('#shots-file', [shot]);
    await page.waitForSelector('#bank-shots .shots-result', { timeout: 45000 });
    assert.deepEqual(await picks(), ['amulet_of_glory', 'amulet_of_glory_4', 'strung_dragonstone_amulet']);
    assert.equal(await page.locator('.shot-row.changed').count(), 0);
    await page.click('[data-act="shots-discard"]');
    // it has a price of its own, and the Crafting row still makes the charged one
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="crafting"]');
    await page.waitForSelector('[data-price="amulet_of_glory"]');
    assert.equal(await page.locator('[data-price="amulet_of_glory"], [data-price="amulet_of_glory_4"]').count(), 2);
    assert.match(flat(await page.locator('#prices-body tr:has([data-price="amulet_of_glory"])').innerText()), /^Amulet of glory \(uncharged\) /);
  } finally {
    // (the bank as it was, for the checks that follow)
    await page.evaluate(v => localStorage.setItem('lchs.bank.demo_main', v), saved);
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="herblore"]');
    await page.click('.tab[data-tab="bank"]');
    await page.click('[data-bskill="herblore"]');
  }
});

await check('bank: Choose screenshots opens the picker in Pictures and reads what you pick', async () => {
  const png = encodePng(fakeBank({ items: [{ slot: 0, icon: 'lawrune', count: 4000 }] })).toString('base64');
  await page.evaluate(b64 => {
    window.__picked = null;
    window.showOpenFilePicker = async opts => {
      window.__picked = { id: opts.id, startIn: opts.startIn, multiple: opts.multiple };
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return [{ getFile: async () => new File([bytes], 'screenshot-picked.png', { type: 'image/png' }) }];
    };
  }, png);
  await page.click('[data-act="shots-pick"]');
  await page.waitForSelector('#bank-shots .shots-result', { timeout: 45000 });
  assert.deepEqual(await page.evaluate(() => window.__picked), { id: 'lostkit-screenshots', startIn: 'pictures', multiple: true });
  assert.match(await text('#bank-shots'), /Law rune\s*4,000/);
  await page.click('[data-act="shots-discard"]');
  await page.evaluate(() => { delete window.showOpenFilePicker; });
});

await check('bank: All is in the order your bank has in-game, drags into your own, and goes back', async () => {
  await page.click('.tab[data-tab="bank"]');
  await page.click('[data-bskill="all"]');
  await page.waitForSelector('#bank-all-grid .bank-cell');
  const order = () => page.$$eval('#bank-all-grid .bank-cell', cs => cs.map(c => c.dataset.slug));
  const inGame = ['lawrune', 'blankrune', 'bronze_arrow', 'unidentified_guam'];
  const before = await order();
  assert.deepEqual(before.slice(0, 4), inGame, 'the screenshots\' order first');
  assert.match(await text('#bank-body'), /In the order they have in your bank/);
  const drag = async (from, to) => {
    const a = await page.locator(`#bank-all-grid .bank-cell[data-slug="${from}"] .bn`).boundingBox();
    const b = await page.locator(`#bank-all-grid .bank-cell[data-slug="${to}"] .item`).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
  };
  const tabsBefore = ctx.pages().length, urlBefore = page.url();
  await drag('unidentified_guam', 'lawrune');                     // by its name, which is a market link
  await page.waitForTimeout(300);
  assert.equal(ctx.pages().length, tabsBefore, 'dragging by the name doesn\'t open the market');
  assert.equal(page.url(), urlBefore);
  const mine = await order();
  assert.deepEqual(mine.slice(0, 4), ['unidentified_guam', 'lawrune', 'blankrune', 'bronze_arrow']);
  assert.deepEqual([...mine].sort(), [...before].sort(), 'same items');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.bank || null), null, 'letting go doesn\'t start typing in an amount');
  assert.match(await text('#bank-body'), /Your own order/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.bank.demo_main')));
  assert.deepEqual(stored.order, mine);
  assert.deepEqual([stored.slots.lawrune, stored.slots.blankrune, stored.slots.bronze_arrow, stored.slots.unidentified_guam], [0, 2, 3, 4]);
  await page.reload();
  await page.waitForSelector('#bank-all-grid .bank-cell');
  assert.deepEqual(await order(), mine, 'your order survives a reload');
  // a click on an item's name opens its market page (in a browser, a new tab)
  await ctx.route('https://markets.lostcity.rs/**', route => route.fulfill({ contentType: 'text/html', body: '<title>market</title>' }));
  const [market] = await Promise.all([ctx.waitForEvent('page'), page.click('#bank-all-grid .bank-cell[data-slug="lawrune"] a.bn')]);
  await market.waitForLoadState();
  assert.match(market.url(), /markets\.lostcity\.rs\/items\/lawrune$/);
  await market.close();
  await ctx.unroute('https://markets.lostcity.rs/**');
  // amounts can still be typed in
  await page.fill('#bank-all-grid [data-bank="lawrune"]', '4k');
  await page.press('#bank-all-grid [data-bank="lawrune"]', 'Tab');
  assert.equal(await page.inputValue('#bank-all-grid [data-bank="lawrune"]'), '4,000');
  // most valuable first, and a drag there makes it your order
  await page.click('[data-allsort="value"]');
  const worth = await page.$$eval('#bank-all-grid .bank-cell .bv', vs => vs.map(v => {
    const m = v.innerText.trim().replace(/,/g, '').match(/^([\d.]+)([KMB]?)$/);
    return m ? parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1) : -1;
  }));
  assert.deepEqual(worth, [...worth].sort((a, b) => b - a), 'most valuable first');
  const sorted = await order();
  await drag(sorted[3], sorted[0]);
  assert.equal(await page.locator('[data-allsort="yours"].on').count(), 1, 'dragging makes it your own order');
  assert.equal((await order())[0], sorted[3]);
  // new screenshots offer to put it back in the bank's order
  const shot = encodePng(fakeBank({ items: [
    { slot: 0, icon: 'bronze_arrow_5', count: 5000 },
    { slot: 1, icon: 'lawrune', count: 4000 },
    { slot: 2, icon: 'blankrune', count: 150420 },
    { slot: 3, icon: 'unidentified_guam', count: 35 },
  ] }));
  await page.setInputFiles('#shots-file', [{ name: 'screenshot-3.png', mimeType: 'image/png', buffer: shot }]);
  await page.waitForSelector('#bank-shots .shots-result', { timeout: 45000 });
  assert.equal(await page.locator('#shots-order').isChecked(), true);
  await page.click('[data-act="shots-apply"]');
  await page.waitForSelector('#bank-all-grid .bank-cell');
  assert.match(await text('#bank-msg'), /All is in your bank's order again/);
  assert.deepEqual((await order()).slice(0, 4), ['bronze_arrow', 'lawrune', 'blankrune', 'unidentified_guam'], 'the new screenshots\' order');
  assert.match(await text('#bank-body'), /In the order they have in your bank/);
  // drag, then back to the bank's order without new screenshots
  await drag('blankrune', 'bronze_arrow');
  assert.equal((await order())[0], 'blankrune');
  await page.click('[data-act="bank-order-reset"]');
  assert.deepEqual((await order()).slice(0, 4), ['bronze_arrow', 'lawrune', 'blankrune', 'unidentified_guam']);
  assert.equal(await page.locator('[data-act="bank-order-reset"]').count(), 0);
  await page.screenshot({ path: `${SHOTS}/9b-bank-all.png`, fullPage: true });
});

await check('planner tabs fit a narrow window', async () => {
  await page.setViewportSize({ width: 340, height: 800 });
  for (const tab of ['goals', 'bank', 'prices']) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForSelector(`#view-${tab}:not([hidden])`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${tab}: horizontal overflow ${overflow}px`);
  }
  await page.screenshot({ path: `${SHOTS}/12-narrow-goals.png`, fullPage: false });
  await page.setViewportSize({ width: 1000, height: 900 });
});

await check('settings shows totals and makes a backup that restores', async () => {
  await page.click('#settings-btn');
  await page.waitForSelector('#settings[open]');
  assert.equal(await page.locator('#totals-table tbody tr').count(), 20);
  await page.click('#backup-copy');
  await page.waitForFunction(() => !document.querySelector('#settings-msg').hidden);
  const backup = await page.evaluate(() => {
    const data = {};
    for (const k of Object.keys(localStorage)) if (k.startsWith('lchs.')) data[k] = localStorage.getItem(k);
    return data;
  });
  assert.ok(Object.keys(backup).some(k => k.startsWith('lchs.snap.demo_main')));
  assert.ok(backup['lchs.goals.demo_main'] && backup['lchs.bank.demo_main'], 'goals and bank are stored');
  if (await page.locator('#restore-box').isHidden()) await page.click('#backup-restore-toggle');
  const exported = await page.evaluate(async () => (await import('./store.js')).exportBackup());
  const parsed = JSON.parse(exported);
  assert.ok(parsed.data['goals.demo_main']?.length >= 2, 'goals are in the backup');
  assert.equal(parsed.data['bank.demo_main']?.items?.ranarr_weed, 1000, 'the bank is in the backup');
  assert.equal(parsed.data.prices, undefined, 'the price cache is left out');
  await page.fill('#restore-text', exported);
  await page.click('#restore-go');
  assert.match(await text('#settings-msg'), /Restored/);
});
await page.screenshot({ path: `${SHOTS}/7-settings.png` });
if (!ONLY) await page.click('#settings-close');

await check('narrow window still works', async () => {
  await page.setViewportSize({ width: 340, height: 800 });
  await page.click('.tab[data-tab="lookup"]');
  await page.click('#lookup-chips .chip.saved');
  await page.waitForSelector('.tile');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
});
await page.screenshot({ path: `${SHOTS}/8-narrow.png`, fullPage: true });

await check('page reload restores the view from the URL', async () => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.click('.tab[data-tab="compare"]');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('table.cmp th.p').length === 5 && !document.querySelector('table.cmp .pending'), null, { timeout: 40000 });
});

await check('two open copies of the tool take turns instead of tripping the limit', async () => {
  const before = (await mockStats()).limited;
  const other = await ctx.newPage();
  await other.goto(BASE + '/?api=local#leaders/2/1');
  await page.click('.tab[data-tab="compare"]');
  await Promise.all([
    page.click('#compare-refresh'),
    other.click('#lb-next').then(() => other.click('#lb-next')).then(() => other.click('#lb-next')),
  ]);
  await page.waitForFunction(() => !document.querySelector('table.cmp .pending'), null, { timeout: 40000 });
  await other.waitForFunction(() => document.querySelector('#lb-page').innerText.startsWith('Page 4'), null, { timeout: 40000 });
  await other.waitForFunction(() => document.querySelectorAll('table.lb tbody tr').length === 21, null, { timeout: 40000 });
  const after = (await mockStats()).limited;
  assert.equal(after - before, 0, `${after - before} requests were rate-limited`);
  await other.close();
});

await check('inside LostKit an item opens its market page right in the tool\'s tab', async () => {
  const c = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LostKit/2.9.0 Chrome/144.0.0.0 Electron/40.2.1 Safari/537.36' });
  const p2 = await c.newPage();
  await p2.goto(BASE + '/?api=local#prices');
  await p2.waitForSelector('#prices-body a.mk');
  const link = p2.locator('#prices-body a.mk[href$="/items/kwuarm"]');
  assert.match(await link.innerText(), /^\s*Kwuarm\s*$/);
  assert.equal(await link.getAttribute('target'), null, 'same tab: LostKit\'s back button comes back');
  assert.match(await p2.locator('#prices-head').innerText(), /LostKit's ◀ button brings you back here/);
  await c.close();
});

await check('in a normal browser the page falls back to the relay on its own site', async () => {
  const c = await browser.newContext();
  const p2 = await c.newPage();
  await p2.goto(BASE + '/#lookup');                  // no ?api=local: the straight route fails here, the relay answers
  await p2.fill('#lookup-name', 'old badger');
  await p2.click('#lookup-form button');
  await p2.waitForSelector('.tile', { timeout: 20000 });
  assert.equal(await p2.locator('#banner').isHidden(), true);
  const route = await p2.evaluate(() => JSON.parse(localStorage.getItem('lchs.api.route')).route);
  assert.match(route, /localhost:8787\/api\/hiscores$/);
  await c.close();
});

await check('without a relay, a browser shows why it cannot read the hiscores', async () => {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const root = new URL('.', import.meta.url);
  const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', otf: 'font/otf' };
  const plain = createServer(async (req, res) => {            // like GitHub Pages: files only
    const path = new URL(req.url, 'http://x').pathname.slice(1) || 'index.html';
    try { const body = await readFile(new URL(path, root)); res.writeHead(200, { 'Content-Type': types[path.split('.').pop()] || 'text/plain' }); res.end(body); }
    catch (e) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<h1>404</h1>'); }
  }).listen(8799);
  const c = await browser.newContext();
  const p2 = await c.newPage();
  await p2.goto('http://localhost:8799/#lookup');
  await p2.fill('#lookup-name', 'old badger');
  await p2.click('#lookup-form button');
  await p2.waitForSelector('#banner:not([hidden])', { timeout: 20000 });
  assert.match(await p2.locator('#banner').innerText(), /LostKit/);
  await c.close();
  plain.close();
});

// Stale counts: pretend the bundled file is old; the page should re-measure every
// category in the background using the old numbers as starting points.
await check('stale player counts are re-measured in the background', async () => {
  const ctx2 = await browser.newContext();
  const p3 = await ctx2.newPage();
  p3.on('pageerror', e => problems.push('pageerror(p3): ' + e.message));
  await p3.route('**/totals.json', route => route.fulfill({ status: 404, body: 'gone' }));   // as if the daily job never ran
  await p3.route('**/totals-seed.json', async route => {
    const res = await route.fetch();
    const json = await res.json();
    json.updated = '2026-01-01T00:00:00Z';
    await route.fulfill({ response: res, json });
  });
  const before = (await mockStats()).api;
  await p3.goto(BASE + '/?api=local#leaders/0/1');
  const mock = await mockStats();
  await p3.waitForFunction(() => document.querySelector('#status-totals').innerText.includes('just now') ||
    document.querySelector('#status-totals').innerText.includes('min ago'), null, { timeout: 120000 });
  const stored = await p3.evaluate(() => JSON.parse(localStorage.getItem('lchs.totals')));
  for (const [id, t] of Object.entries(mock.totals)) assert.equal(stored[id]?.t, t, `category ${id}: ${stored[id]?.t} vs ${t}`);
  const used = (await mockStats()).api - before;
  results.push(['info', `re-measuring 20 categories took ${used} requests`]);
  await ctx2.close();
});

const finalStats = await mockStats();
results.push(['info', `mock API: ${finalStats.api} requests, ${finalStats.limited} rate-limited`]);
results.push(['info', problems.length ? 'page problems:\n  ' + problems.join('\n  ') : 'no page errors']);
await browser.close();

for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '— ' + r[2] : '');
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
