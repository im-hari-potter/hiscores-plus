// End-to-end check against the mock API.
//   RATE_MS=300 node test/mock-server.mjs 8787 &   then   node test/e2e.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // resolved from NODE_PATH / global install
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787';
const SHOTS = process.env.SHOTS || '/tmp';
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 3).join(' | ')]); }
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
  assert.match(await text('.pc-combat'), /Combat 86/);
  assert.match(await text('.pc-sub'), /Total level 1,460/);
  const attack = await page.locator('.tile').nth(1).innerText();
  assert.match(attack, /Level: 60/);
  assert.match(attack, /XP: 295,920/);
  assert.match(attack, /Next: 6,368 XP/);
  assert.match(attack, /Top [\d.]+% of 14,138/);
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
  assert.match(card, /Melee build/);
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
  assert.match(combat, /Combat \d+(–\d+)?/);
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
  if (await page.locator('#restore-box').isHidden()) await page.click('#backup-restore-toggle');
  const exported = await page.evaluate(async () => (await import('./js/store.js')).exportBackup());
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

await check('outside LostKit the banner explains why lookups fail', async () => {
  const p2 = await ctx.newPage();
  await p2.goto(BASE + '/#lookup');
  await p2.waitForSelector('#banner:not([hidden])');
  assert.match(await p2.locator('#banner').innerText(), /inside LostKit/);
  await p2.close();
});

// Stale counts: pretend the bundled file is old; the page should re-measure every
// category in the background using the old numbers as starting points.
await check('stale player counts are re-measured in the background', async () => {
  const ctx2 = await browser.newContext();
  const p3 = await ctx2.newPage();
  p3.on('pageerror', e => problems.push('pageerror(p3): ' + e.message));
  await p3.route('**/data/totals-seed.json', async route => {
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
