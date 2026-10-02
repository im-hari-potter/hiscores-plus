// End-to-end check against the mock API.
//   RATE_MS=300 node mock-server.mjs 8787 &   then   node e2e.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // resolved from NODE_PATH / global install
import assert from 'node:assert/strict';
import { fakeBank } from './bankfake.mjs';
import { encodePng } from './testpng.mjs';

const BASE = process.env.BASE || 'http://localhost:8787';
const SHOTS = process.env.SHOTS || '/tmp';
const results = [];
const check = async (name, fn) => {
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
await page.click('#filter-seg [data-filter="all"]');

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
await page.click('[data-csort="p:demo_main"]');
await page.screenshot({ path: `${SHOTS}/4b-compare-sorted.png` });
await page.click('[data-csort-reset]');

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
    /Needs \(from scratch\): 1 Gold bar, 1 Sapphire, 1 Water rune, 1 Cosmic rune\nTools: Necklace mould\nEnchanted with Lvl-1 Enchant \(Magic 7\), which gives Magic XP, not Crafting XP\./);
  assert.match(await card.locator('tr[data-method="cr_ench_amulet_of_glory_4"]').getAttribute('title'),
    /Amulet of glory\(4\) \(make, string & enchant\): level 80, 154 XP each \(make 150 \+ string 4\)\nNeeds \(from scratch\): 1 Gold bar, 1 Dragonstone, 1 Ball of wool, 15 Earth rune, 15 Water rune, 1 Cosmic rune\nTools: Amulet mould\nEnchanted with Lvl-5 Enchant \(Magic 68\), which gives Magic XP, not Crafting XP\. Then charged at the Fountain of Heroes\./);
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
  assert.match(t, /1 other item the planner doesn't use was skipped/);
  assert.match(t, /not-a-bank\.png: no bank in this one/);
  assert.match(t, /Law rune\s*3,960/);
  assert.match(t, /Rune essence\s*≈150K/);
  assert.match(t, /Bronze arrow\s*5,000/);
  assert.match(t, /Unid herb or Lantadyme: they look the same\s*35/);
  assert.match(t, /Willow logs\s*814/);
  await page.locator('[data-shot="willow_logs"]').uncheck();
  await page.click('[data-act="shots-apply"]');
  await page.waitForSelector('#bank-msg:not([hidden])');
  assert.match(await text('#bank-msg'), /Bank updated from your screenshots: 4 items changed/);
  await page.click('[data-bskill="runecraft"]');
  assert.equal(await page.inputValue('[data-bank="lawrune"]'), '3,960');
  assert.equal(await page.inputValue('[data-bank="blankrune"]'), '150,000', 'the low end of 150K');
  await page.click('[data-bskill="herblore"]');
  assert.equal(await page.inputValue('[data-bank="unidentified_guam"]'), '35');
  assert.equal(await page.locator('#bank-shots .shots-result').count(), 0, 'back to the drop box');
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
await page.click('#settings-close');

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
