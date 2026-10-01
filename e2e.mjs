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
  catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 30).join(' | ')]); }
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
  await page.waitForSelector('[data-bank="ranarr_weed"]');
  await page.fill('[data-bank="ranarr_weed"]', '1k');
  await page.press('[data-bank="ranarr_weed"]', 'Tab');
  await page.fill('[data-bank="snape_grass"]', '700');
  await page.press('[data-bank="snape_grass"]', 'Tab');
  assert.equal(await page.inputValue('[data-bank="ranarr_weed"]'), '1,000', '1k is read as 1,000');
  assert.match(await text('#bank-head'), /2 kinds of item/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.bank.demo_main')));
  assert.deepEqual(stored.items, { ranarr_weed: 1000, snape_grass: 700 });
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
  const row = await page.locator('tr[data-method="hb_3doseprayerrestore"]').innerText();
  const cells = row.split('\t').map(c => c.trim());
  assert.equal(cells[3], '4,951', 'to goal');
  assert.equal(cells[4], '700', 'from bank');
  assert.equal(cells[5], '4,251', 'still to make');
});
await page.screenshot({ path: `${SHOTS}/10-goal-plan.png`, fullPage: true });

await check('goals: picking another potion and leaving the bank out change the plan', async () => {
  await page.click('tr[data-method="hb_3doserangerspotion"] td:nth-child(2)');
  await page.waitForFunction(() => /2,289 × Ranging potion/.test(document.querySelector('.goal').innerText));
  assert.equal(await page.inputValue('.goal select[data-gopt="fill"]'), 'hb_3doserangerspotion');
  await page.selectOption('.goal select[data-gopt="fill"]', 'hb_3doseprayerrestore');
  await page.waitForFunction(() => /4,251 × Prayer potion/.test(document.querySelector('.goal').innerText));
  await page.uncheck('.goal input[data-gopt="useBank"]');
  await page.waitForFunction(() => !/From your bank/.test(document.querySelector('.goal').innerText));
  assert.match(await goalText(), /4,951 × Prayer potion/);
  await page.check('.goal input[data-gopt="useBank"]');
  await page.waitForFunction(() => /From your bank/.test(document.querySelector('.goal').innerText));
});

await check('prices: sales medians, placeholder prices fixed from notes, 4-dose fallback and your own price', async () => {
  await page.click('.tab[data-tab="prices"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('#prices-body').innerText;
    return /Ranarr weed\s*3,000\s*median of 6 sales/.test(t) && /Prayer potion\(3\)\s*[\d,.]+[KM]?\s*¾ of the 4-dose price/.test(t);
  }, null, { timeout: 60000 });
  await page.fill('[data-price="snape_grass"]', '450');
  await page.press('[data-price="snape_grass"]', 'Tab');
  await page.waitForFunction(() => /Snape grass\s*450\s*your price/.test(document.querySelector('#prices-body').innerText));
  const overrides = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.priceOverrides')));
  assert.deepEqual(overrides, { snape_grass: 450 });
});
await page.screenshot({ path: `${SHOTS}/11-prices.png`, fullPage: true });

await check('goals: with prices known the plan shows cost, value and profit', async () => {
  await page.click('.tab[data-tab="goals"]');
  await page.waitForSelector('.goal .money');
  const money = await page.locator('.goal .money').innerText();
  assert.match(money, /Buying it all: [\d.,]+[KM]? gp/);
  assert.match(money, /worth: [\d.,]+[KM]? gp/);
  assert.match(money, /Net: [+−][\d.,]+[KM]? gp/);
  assert.doesNotMatch(await page.locator('tr[data-method="hb_3doseprayerrestore"]').innerText(), /\?/);
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
  assert.equal(await card.locator('.plan-t thead th').count(), 6, 'no bank columns');
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
  assert.equal(await card.locator('select[data-gopt="fill"] optgroup').count(), 7);
  // the table shows one group at a time: the one you train with, until you pick
  assert.equal(await card.locator('.group-pick .chip.on').innerText(), 'Bows');
  assert.equal(await card.locator('tr[data-method]').count(), 12);
  await card.locator('[data-tgroup="Darts"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.goal .plan-t tr[data-method^="fl_dart"]').length === 6);
  assert.match(await card.locator('tr[data-method="fl_dart_rune_dart"]').innerText(), /81\s+Rune dart\s+18\.8\s+[\d,]+\s+500\s/);
  await card.locator('[data-tgroup="all"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.goal .plan-t tr[data-method^="fl_"]').length === 63);
  await card.locator('tr[data-method="fl_logs_bronze_arrow"] td:nth-child(2)').click();
  await page.waitForFunction(() => /logs → [\d,]+ Bronze arrows/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Fletching'))?.innerText || ''));
  assert.match(await card.locator('tr[data-method="fl_logs_bronze_arrow"]').innerText(), /per log/);
  await page.screenshot({ path: `${SHOTS}/10b-fletching.png`, fullPage: true });
  await card.locator('[data-tgroup="Bows"]').click();
  await card.locator('select[data-gopt="fill"]').selectOption('fl_cs_yew_longbow');
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
});

await check('prices: Woodcutting has a prices tab for its logs', async () => {
  await page.click('.tab[data-tab="prices"]');
  await page.click('[data-bskill="woodcutting"]');
  await page.waitForSelector('[data-price="magic_logs"]');
  assert.match(await text('#prices-body'), /Bark/);
  await page.click('.tab[data-tab="bank"]');
  await page.waitForSelector('[data-bskill="herblore"].active');
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
  await page.waitForSelector('#bank-shots .shots-result', { timeout: 20000 });
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
