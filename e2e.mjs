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
let running = '(before the first check)';      // the check a page problem happened in
const check = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) { results.push(['skip', name]); return; }
  running = name;
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
page.on('pageerror', e => problems.push(`pageerror: ${e.message} (during "${running}")${(e.stack || '').split('\n').slice(1, 7).map(l => `\n      ${l.trim()}`).join('')}`));
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
const requested = [];                         // every address the page asks for
page.on('request', r => requested.push(r.url()));

// The page redraws on its own (prices arriving, XP loaded), and Playwright reads a list of elements in two
// steps: it finds them, then it reads them. A redraw between the two leaves it reading the elements that were
// just replaced: off the page, where text has no line breaks and nothing has a size or a style. So those
// reads are done again when what they found was replaced under them.
{
  const Locator = Object.getPrototypeOf(page.locator('html'));
  for (const name of ['evaluate', 'evaluateAll']) {
    const read = Locator[name];
    Locator[name] = async function (fn, arg, ...rest) {
      const whole = new Function('found', 'arg', `return [].concat(found).every(el => el.isConnected)
        ? Promise.resolve((${fn})(found, arg)).then(got => ({ onPage: true, got })) : {};`);
      for (let tries = 0; tries < 200; tries++) { const r = await read.call(this, whole, arg, ...rest); if (r.onPage) return r.got; }
      throw new Error(`${this}: the page kept redrawing under this read`);
    };
  }
  Locator.allInnerTexts = function () { return this.evaluateAll(els => els.map(el => el.innerText)); };
  const box = Locator.boundingBox;
  Locator.boundingBox = async function (...a) {
    for (let tries = 0; ; tries++) { const b = await box.apply(this, a); if (b || tries > 200 || !(await this.isVisible())) return b; }
  };
}

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
// A plan table's row by the names of its columns ("From bank", "Gross from banked
// supplies"): which columns a table has depends on the skill and on what's
// switched on, so the checks ask for them by name. td(name) is the cell itself.
const rowBy = async (scope, id) => {
  const names = (await scope.locator('.plan-t thead th').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
  const tr = scope.locator(`tr[data-method="${id}"]`);
  const cells = (await tr.innerText()).split('\t').map(c => c.trim());
  const row = Object.fromEntries(names.map((n, i) => [n, cells[i]]));
  Object.defineProperty(row, 'td', { value: name => { assert.ok(names.includes(name), `no column ${name} in ${names.join(' | ')}`); return tr.locator('td').nth(names.indexOf(name)); } });
  return row;
};
const firstGoal = () => page.locator('.goal').first();

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
  // the skill buttons go in the hiscores' order, like the ones a new goal is picked with (v2.10.1)
  assert.deepEqual(await page.$$eval('#bank-head [data-bskill]', els => els.map(e => e.dataset.bskill)),
    ['all', 'prayer', 'magic', 'cooking', 'fletching', 'firemaking', 'crafting', 'smithing', 'herblore', 'runecraft']);
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
  // (v2.10.1: with the XP of each stage: from the bank, after rounding up, and in all once the supplies needed are made)
  assert.match(head.trim(), /^Use\s*Lvl\s*Potion\s*XP\s*Net\/item\s*gp\/XP\s*From bank\s*XP from\s*bank\s*Gross from\s*banked supplies\s*Round up\s*my supplies\s*XP after rounding\s*up my supplies\s*Net after rounding\s*up my supplies\s*Still needed\s*to goal\s*Supplies needed\s*Total XP after\s*supplies needed\s*Net after\s*buying supplies\s*Total net gp\s*toward goal$/);
  assert.doesNotMatch(head, /To goal/);
  assert.doesNotMatch(head, /even out/i);
  // Round up my supplies and Net after rounding up my supplies go together, with a dark line on each side
  const plant = page.locator('.goal >> nth=0 >> .plan-t');
  assert.match((await plant.locator('th.sep-l').innerText()).trim(), /^Round up\s*my supplies$/);
  assert.match(await plant.locator('th.sep-r').innerText(), /^Net after rounding\s*up my supplies$/);
  // the group's name sits above the potions' names, not under Use
  assert.deepEqual(await plant.locator('tr.grp').first().locator('td').evaluateAll(tds => tds.map(td => [td.colSpan, td.innerText.trim()])), [[2, ''], [15, 'Potions']]);
  assert.equal(await plant.locator('tr.grp td').nth(1).evaluate(td => Math.round(td.getBoundingClientRect().left)),
    await plant.locator('thead th').nth(2).evaluate(th => Math.round(th.getBoundingClientRect().left)), 'it starts where the Potion column does');
  const rowCount = await plant.locator('tr[data-method]').count();
  assert.equal(await plant.locator('tr[data-method] td.even.sep-l').count(), rowCount, 'every Round up my supplies cell has the line before it');
  assert.equal(await plant.locator('tr[data-method] td.sep-r').count(), rowCount, 'every Net after rounding up my supplies cell has the line after it');
  assert.deepEqual(await plant.locator('th.sep-l').evaluate(el => [getComputedStyle(el).borderLeftStyle, getComputedStyle(el).borderLeftColor]), ['solid', 'rgb(0, 0, 0)']);
  assert.deepEqual(await plant.locator('th.sep-r').evaluate(el => [getComputedStyle(el).borderRightStyle, getComputedStyle(el).borderRightColor]), ['solid', 'rgb(0, 0, 0)']);
  const cells = await rowBy(firstGoal(), 'hb_3doseprayerrestore');
  assert.equal(cells['From bank'], '700', 'from bank');
  assert.match(cells['Round up my supplies'], /^300\s*→\s*1,000$/, 'round up: 300 snape grass, and the bank covers 1,000');
  assert.equal(cells['Still needed to goal'], '4,251', 'still needed');
  assert.match(cells['Supplies needed'], /^3,951\s*4,251$/, 'collect: ranarr and snape grass; vials are bought as you go');
  // the XP of each stage: 700 from the bank, 1,000 once rounded up, and with the 4,251 still needed the goal's 432,925 and a little
  assert.deepEqual([cells['XP from bank'], cells['XP after rounding up my supplies'], cells['Total XP after supplies needed']], ['+61,250', '+87,500', '+433,212.5']);
  assert.equal(700 * 87.5 + 4251 * 87.5, 433212.5);
  assert.equal(await cells.td('XP from bank').getAttribute('title'), "Your bank plan makes 700 × Prayer potion: +61,250 XP, with what's made on the way: 700 × Ranarr potion (unf).");
  assert.equal(await cells.td('XP after rounding up my supplies').getAttribute('title'), '1,000 × Prayer potion, with your supplies rounded up: +87,500 XP.');
  assert.match(await cells.td('Total XP after supplies needed').getAttribute('title'), /^Everything your bank makes \(\+61,250 XP\) and 4,251 × Prayer potion \(\+371,962\.5 XP\): \+433,212\.5 XP in all, which takes you to [\d,.]+ XP \(level 78\)\.$/);
  // a potion the bank makes none of: nothing from the bank, and the same total by its own count
  const none = await rowBy(firstGoal(), 'hb_3dose1attack');
  assert.deepEqual([none['XP from bank'], none['XP after rounding up my supplies']], ['–', '–']);
  assert.match(none['Total XP after supplies needed'], /^\+43[23],\d{3}(\.\d)?$/);
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
  const attackOn = await rowBy(firstGoal(), 'hb_3dose1attack');
  const attack = { 10: attackOn['Still needed to goal'] };
  assert.equal(attackOn['Gross from banked supplies'], '–', 'the bank plan makes none of these');
  assert.match(attackOn['Supplies needed'], new RegExp(`^${attack[10]}\\s*${attack[10]}$`), 'collect: guam and eyes of newt for those');
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
  const cells = await rowBy(firstGoal(), 'hb_3dose2strength');
  assert.equal(cells['From bank'], '518', 'from bank');
  assert.match(cells['Round up my supplies'], /^87\s*→\s*605$/);
  assert.deepEqual([cells['XP from bank'], cells['XP after rounding up my supplies']], ['+64,750', '+75,625'], '518 and 605 super strength, 125 XP each');
  assert.equal(await row.locator('td.even').getAttribute('title'), 'Collect 87 Limpwurt root, and your bank covers 605 × Super strength instead of 518.');
  assert.match(await row.locator('td.even .it-chip').getAttribute('title'), /^Limpwurt root/);
  // the other way round: more limpwurt than kwuarm
  await setBank('herblore', { kwuarm: '500', limpwurt_root: '518' });
  await page.click('.tab[data-tab="goals"]');
  await row.waitFor();
  assert.match((await rowBy(firstGoal(), 'hb_3dose2strength'))['Round up my supplies'], /^18\s*→\s*518$/);
  assert.match(await row.locator('td.even .it-chip').getAttribute('title'), /^Kwuarm/);
  await page.screenshot({ path: `${SHOTS}/10c-round-up-column.png`, fullPage: true });
  await setBank('herblore', { kwuarm: '', limpwurt_root: '' });
  await page.click('.tab[data-tab="goals"]');
});

await check('prices: sales medians, placeholder prices fixed from notes, 4-dose fallback and your own price', async () => {
  const flat = t => t.replace(/\s+/g, ' ').trim();
  await page.click('.tab[data-tab="prices"]');
  // the very first time it opens on All: every item the planner prices, once each, A to Z (v2.10.1)
  await page.waitForSelector('#prices-head [data-bskill="all"].active');
  assert.equal(await page.locator('#prices-body table').count(), 1);
  assert.match(flat(await page.locator('#prices-body thead').innerText()), /^Every item Market all High alch all Your price$/);
  const listed = await page.$$eval('#prices-body [data-price]', els => els.map(e => [e.dataset.price, e.closest('tr').querySelector('a.mk').innerText.trim()]));
  assert.ok(listed.length > 500, `${listed.length} items`);
  assert.equal(new Set(listed.map(([slug]) => slug)).size, listed.length, 'each item once, though skills share them (logs, runes, ore)');
  const names = listed.map(([, name]) => name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })), 'A to Z');
  for (const slug of ['ranarr_weed', 'magic_logs', 'dragon_bones', 'naturerune', 'raw_shark', 'runite_ore', 'air_battlestaff']) assert.ok(listed.some(([s]) => s === slug), slug);
  assert.match(flat(await page.locator('#prices-head .note').innerText()), new RegExp(`All is every item the planner prices, ${listed.length} of them, A to Z\\. Opening it checks nothing`));
  assert.equal(flat(await page.locator('#prices-head .bulk').innerText()), 'Every item: Market High alch');
  // a skill's tab is that skill's lists, and it's the one remembered
  await page.click('#prices-head [data-bskill="herblore"]');
  await page.waitForSelector('#prices-head [data-bskill="herblore"].active');
  assert.equal(flat(await page.locator('#prices-head .bulk').innerText()), 'Every Herblore item: Market High alch');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.planUi')).priceView), 'herblore');
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
  // the skill buttons go in the hiscores' order here too, after All: the skills a new goal is picked from, less those with nothing to price (v2.10.1)
  const tabs = await page.$$eval('#prices-head [data-bskill]', els => els.map(e => e.dataset.bskill));
  assert.deepEqual(tabs, ['all', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'thieving', 'runecraft']);
  assert.deepEqual(tabs.slice(1), (await page.$$eval('#goal-new [data-nskill]', els => els.map(e => e.dataset.nskill))).filter(k => tabs.includes(k)), "the new goal's order");
  assert.equal(await page.locator('#prices-head [data-bskill="herblore"].active').count(), 1);
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
  const row = await rowBy(firstGoal(), 'hb_3doseprayerrestore');
  assert.doesNotMatch(Object.values(row).join(' '), /\?/);
  assert.equal(row['Gross from banked supplies'], `+${total}`, 'gross from banked supplies: its part of From your bank');
  assert.match(row['Net after rounding up my supplies'], /^[+−][\d.,]+[KM]?$/, 'net after rounding up my supplies');
  assert.match(row['Net after buying supplies'], /^[+−][\d.,]+[KM]?$/, 'net after buying supplies');
  assert.equal(row['Net after buying supplies'], money.match(/Net: ([+−]?[\d.,]+[KM]?) gp/)[1], 'the same as the plan\'s own Net for the potion you train with');
  assert.match(row['Total net gp toward goal'], /^[+−][\d.,]+[KM]?$/, 'total net gp toward goal');
  // the total net: what the bank makes of it before rounding up (the 700 prayer
  // potions under From your bank) plus the net after buying supplies
  const netTip = await row.td('Total net gp toward goal').getAttribute('title');
  assert.equal(netTip, `Gross from banked supplies ${row['Gross from banked supplies']} + net after buying supplies ${row['Net after buying supplies']}`);
  // one item's own net, in the row's tooltip: a loss is a net below zero
  const rowTip = await page.locator('tr[data-method="hb_3doseprayerrestore"]').getAttribute('title');
  assert.match(rowTip, new RegExp(`Costs [\\d.,]+[KM]?, worth [\\d.,]+[KM]?: net ${row['Net/item'].replace(/[+.]/g, '\\$&')} each$`), rowTip);
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
  const netCol = (await page.locator('.goal >> nth=0 >> .plan-t thead th').allInnerTexts()).findIndex(t => /Total net gp/.test(t));
  const nets = (await page.locator('.goal >> nth=0 >> tr[data-method]').allInnerTexts()).map(t => gp(t.split('\t')[netCol].trim()));
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
  // (the row as it is, to set beside what rounding up makes of it)
  const asItIs = await rowBy(goal, 'hb_3dose2strength');
  assert.deepEqual([asItIs['From bank'], asItIs['XP from bank'], asItIs['XP after rounding up my supplies']], ['518', '+64,750', '+75,625']);
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
  // the table (v2.10.1): the same columns, on or off. Gross from banked supplies stays the bank as it is (it used
  // to turn into "Net from bank, supplies rounded up", the same number as Net after rounding up my supplies);
  // rounding up shows in the columns after it
  const head = flat(await goal.locator('.plan-t thead').innerText());
  assert.match(head, /From bank XP from bank Gross from banked supplies Round up my supplies XP after rounding up my supplies Net after rounding up my supplies Still needed to goal Supplies needed Total XP after supplies needed Net after buying supplies Total net gp toward goal$/);
  assert.doesNotMatch(head, /Net from bank/);
  const ss = await rowBy(goal, 'hb_3dose2strength');
  for (const col of ['From bank', 'XP from bank', 'Gross from banked supplies', 'Round up my supplies', 'XP after rounding up my supplies', 'Net after rounding up my supplies']) {
    assert.equal(ss[col], asItIs[col], `${col}: as it was with Round up my supplies off`);
  }
  assert.match(ss['Round up my supplies'], /^87\s*→\s*605$/);
  assert.notEqual(ss['Gross from banked supplies'], ss['Net after rounding up my supplies'], 'no longer the same number twice');
  assert.match(await ss.td('Gross from banked supplies').getAttribute('title'),
    /^Your bank plan makes 518 × Super strength as your bank is, before rounding up: worth [\d.,]+[KM]?\. Your banked supplies are yours already\.$/);
  // what comes after follows the rounded-up plan: fewer still needed, and the same total XP to the goal
  const num = c => Number(c.replace(/[,+]/g, ''));
  assert.ok(num(ss['Still needed to goal']) < num(asItIs['Still needed to goal']), `${ss['Still needed to goal']} < ${asItIs['Still needed to goal']}`);
  assert.equal(num(ss['Total XP after supplies needed']), 163125 + num(ss['Still needed to goal']) * 125);
  assert.match(await ss.td('Total XP after supplies needed').getAttribute('title'),
    /^Everything your bank makes, supplies rounded up \(\+163,125 XP\) and [\d,]+ × Super strength \(\+[\d,.]+ XP\): \+[\d,.]+ XP in all, which takes you to [\d,.]+ XP \(level 78\)\.$/);
  // Total net counts the rounded-up plan's part: 605 less the 87 limpwurt collected (here the same as Net after rounding up)
  assert.equal(await ss.td('Total net gp toward goal').getAttribute('title'),
    `Your bank plan, with your supplies rounded up, makes 605 × Super strength: worth ${(await ss.td('Net after rounding up my supplies').getAttribute('title')).match(/worth ([\d.,]+[KM]?), less ([\d.,]+[KM]?) to collect/).slice(1).join(', less ')} to collect (${ss['Net after rounding up my supplies']}) + net after buying supplies ${ss['Net after buying supplies']}`);
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
  assert.match(flat(await goal.locator('.plan-t thead').innerText()), /From bank XP from bank Gross from banked supplies Round up my supplies/);
  await setBank('herblore', { kwuarm: '', limpwurt_root: '' });
  await page.click('.tab[data-tab="goals"]');
});

await check('goals: Hide unused items takes the rows unticked under Use out of the table, and says how many (v2.10.1)', async () => {
  await page.click('.tab[data-tab="goals"]');
  const goal = page.locator('.goal').first();
  const flat = t => t.replace(/\s+/g, ' ').trim();
  await goal.locator('.plan-t').waitFor();
  const box = () => goal.locator('input[data-topt="hideOff"]');
  const label = async () => flat(await goal.locator('label.hide-off').innerText());
  const rows = () => goal.locator('tr[data-method]').evaluateAll(trs => trs.map(tr => tr.dataset.method));
  try {
    // beside Sort, off until you ask
    assert.deepEqual([await box().isChecked(), await label()], [false, 'Hide unused items']);
    assert.equal(await goal.locator('.plan-sec').last().locator('.bar .seg + label.hide-off').count(), 1, 'right after the Sort buttons');
    assert.match(await goal.locator('label.hide-off').getAttribute('title'), /^Leave the rows you've unticked under Use out of the table\. Untick this to see them again\./);
    const all = await rows();
    // unticked rows stay in the table, dimmed, until they're hidden
    for (const id of ['hb_3dose1attack', 'hb_3doseantipoison']) await goal.locator(`input[data-use="${id}"]`).uncheck();
    await page.waitForFunction(() => document.querySelectorAll('.goal tr.off').length === 2);
    assert.deepEqual(await rows(), all);
    await box().check();
    await page.waitForFunction(n => document.querySelector('.goal').querySelectorAll('tr[data-method]').length === n, all.length - 2);
    assert.deepEqual(await rows(), all.filter(id => !['hb_3dose1attack', 'hb_3doseantipoison'].includes(id)));
    assert.equal(await label(), 'Hide unused items (2 hidden)');
    assert.equal(await goal.locator('tr.off').count(), 0);
    // unticking another takes it out at once (a click: the box is gone with its row before it can be looked at again)
    await goal.locator('input[data-use="hb_3dose1strength"]').click();
    await page.waitForFunction(n => document.querySelector('.goal').querySelectorAll('tr[data-method]').length === n, all.length - 3);
    assert.equal(await label(), 'Hide unused items (3 hidden)');
    // with the bank left out the Use boxes are still there, and so is this
    await goal.locator('input[data-gopt="useBank"]').uncheck();
    await page.waitForFunction(() => !/From your bank/.test(document.querySelector('.goal').innerText));
    assert.deepEqual([(await rows()).length, await label()], [all.length - 3, 'Hide unused items (3 hidden)']);
    await goal.locator('input[data-gopt="useBank"]').check();
    await page.waitForFunction(() => /From your bank/.test(document.querySelector('.goal').innerText));
    // it's one switch, remembered: every plan's table follows it
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.planUi')).hideOff), true);
    const boxes = await page.locator('input[data-topt="hideOff"]').evaluateAll(els => els.map(el => el.checked));
    assert.ok(boxes.length >= 1 && boxes.every(Boolean), JSON.stringify(boxes));
    // off again: the unticked rows are back, to be ticked again
    await box().uncheck();
    await page.waitForFunction(n => document.querySelector('.goal').querySelectorAll('tr[data-method]').length === n, all.length);
    assert.deepEqual([await rows(), await label(), await goal.locator('tr.off').count()], [all, 'Hide unused items', 3]);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.planUi')).hideOff), false);
  } finally {
    if (await box().isChecked()) await box().uncheck();
    for (const id of ['hb_3dose1attack', 'hb_3doseantipoison', 'hb_3dose1strength']) await goal.locator(`input[data-use="${id}"]`).check();
    await page.waitForFunction(() => document.querySelectorAll('.goal tr.off').length === 0);
    if (!(await goal.locator('input[data-gopt="useBank"]').isChecked())) await goal.locator('input[data-gopt="useBank"]').check();
  }
});

await check("goals: a plan's table can be hidden, one plan at a time or all at once; the rest of the plan stays (v2.10.1)", async () => {
  await page.click('.tab[data-tab="goals"]');
  const goal = page.locator('.goal').first();
  const flat = t => t.replace(/\s+/g, ' ').trim();
  await goal.locator('.plan-t').waitFor();
  const id = await goal.getAttribute('data-goal');
  const head = async () => flat(await goal.locator('.plan-sec').last().locator('h4').innerText());
  try {
    assert.match(await head(), /^Every option \(on its own, from level \d+; click one to train with it\) Hide table$/);
    const before = flat(await goal.locator('.plan-sec').first().innerText());
    await goal.locator('[data-act="table-toggle"]').click();
    await page.waitForFunction(() => !document.querySelector('.goal .plan-t'));
    // only the heading is left of it, with the way back; the plan's own lines are as they were
    assert.equal(await head(), 'Every option (the table is hidden) Show table');
    assert.equal(await goal.locator('[data-tsort-plan], [data-topt], .group-pick, table').count(), 0);
    assert.equal(flat(await goal.locator('.plan-sec').first().innerText()), before);
    assert.equal(await goal.locator('select[data-gopt="fill"]').count(), 1, 'Train with still picks what to make');
    // it's remembered with the goal
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.planUi')).tableOff), [id]);
    await page.click('.tab[data-tab="bank"]');
    await page.click('.tab[data-tab="goals"]');
    assert.equal(await head(), 'Every option (the table is hidden) Show table');
    await goal.locator('[data-act="table-toggle"]').click();
    await goal.locator('.plan-t').waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.planUi')).tableOff), []);
    // all at once, for the plans that are open: beside Hide all plans, on a line of their own under the filter (there once there's more than one goal, v2.10.3)
    await addGoal('firemaking', 99);
    const fire = page.locator('.goal').filter({ has: page.locator('.goal-name', { hasText: /^Firemaking$/ }) });
    await fire.locator('.plan-t').waitFor();
    // (a skill with nothing to round up: the XP from its bank and the total, and no rounded-up columns between)
    assert.match(flat(await fire.locator('.plan-t thead').innerText()), /^Use Lvl \w+ XP Net\/item gp\/XP From bank XP from bank Gross from banked supplies Still needed to goal Supplies needed Total XP after supplies needed Net after buying supplies Total net gp toward goal$/);
    assert.equal(flat(await page.locator('.goal-links [data-act="tables-off"]').innerText()), 'Hide all tables');
    assert.equal(flat(await page.locator('#goals-list > .goal-links').innerText()), 'Hide all plans Hide all tables');
    const tops = await page.$$eval('#goals-list > .goal-links .linkish', els => els.map(e => Math.round(e.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1, `side by side, on one line: ${tops}`);
    assert.equal(await page.locator('.goal-filter .linkish').count(), 0, 'not in the filter row');
    await page.click('.goal-links [data-act="tables-off"]');
    await page.waitForFunction(() => !document.querySelector('.goal .plan-t'));
    assert.equal(await page.locator('.goal .plan').count() >= 2, true, 'the plans stay open');
    assert.equal(flat(await page.locator('.goal-links [data-act="tables-on"]').innerText()), 'Show all tables');
    // one shown again is enough for the bar to offer hiding them all
    await fire.locator('[data-act="table-toggle"]').click();
    await fire.locator('.plan-t').waitFor();
    assert.equal(await page.locator('.goal-links [data-act="tables-off"]').count(), 1);
    await page.click('.goal-links [data-act="tables-off"]');
    await page.waitForFunction(() => !document.querySelector('.goal .plan-t'));
    await page.click('.goal-links [data-act="tables-on"]');
    await goal.locator('.plan-t').waitFor();
    await fire.locator('.plan-t').waitFor();
    // a goal taken off the list is forgotten here too
    await fire.locator('[data-act="table-toggle"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lchs.planUi')).tableOff.length === 1);
    await fire.locator('[data-act="remove-goal"]').click();
    await fire.locator('[data-act="remove-goal"]').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.goal .goal-name')].some(el => el.innerText.trim() === 'Firemaking'));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.planUi')).tableOff), []);
  } finally {
    const fire = page.locator('.goal').filter({ has: page.locator('.goal-name', { hasText: /^Firemaking$/ }) });
    if (await fire.count()) { await fire.locator('[data-act="remove-goal"]').click(); await fire.locator('[data-act="remove-goal"]').click(); }
    // (whatever happened, every table is shown again for the checks that follow)
    for (let i = 0; i < 20 && await page.locator('[data-act="table-toggle"][aria-expanded="false"]').count(); i++) await page.locator('[data-act="table-toggle"][aria-expanded="false"]').first().click();
  }
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
  assert.match(ss[9], /^87\s*5\s*→\s*605$/, 'Round up my supplies: 87 limpwurt root, and 5 vials');
  assert.equal(await goal.locator('tr[data-method="hb_3dose2strength"] td.even').getAttribute('title'),
    'Collect 87 Limpwurt root and 5 Vial of water, and your bank covers 605 × Super strength instead of 518.');
  const pp = await cellsOf('hb_3doseprayerrestore');
  assert.equal(pp[6], '600', 'From bank: the vials hold it back');
  assert.match(pp[9], /^300\s*400\s*→\s*1,000$/, 'Round up my supplies: 300 snape grass, and 400 vials');
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
  assert.match(head.trim(), /^Use\s*Lvl\s*Item\s*XP\s*Net\/item\s*gp\/XP\s*From bank\s*XP from\s*bank\s*Gross from\s*banked supplies\s*Round up\s*my supplies\s*XP after rounding\s*up my supplies\s*Net after rounding\s*up my supplies\s*Still needed\s*to goal\s*Supplies needed\s*Total XP after\s*supplies needed\s*Net after\s*buying supplies\s*Total net gp\s*toward goal$/);
  assert.deepEqual(await card.locator('tr.grp').first().locator('td').evaluateAll(tds => tds.map(td => [td.colSpan, td.innerText.trim()])), [[2, ''], [15, 'Jewellery']]);
  const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
  const ring = await cells('cr_sapphire_ring');
  assert.deepEqual([ring[1], ring[2], ring[3], ring[6]], ['20', 'Sapphire ring', '40', '300'], 'from bank: 300 uncut sapphires count, cut on the way');
  assert.match(ring[9], /^200\s*→\s*500$/, 'round up: 200 more sapphires for the 500 gold bars');
  assert.match(ring[13], /^([\d,]+)\s*\1$/, 'supplies: a gold bar and a cut sapphire each, as the calculator lists them');
  // (v2.10.1) the XP of those stages, the cuts on the way included: 300 rings and their 300 cuts as the bank is, 500 and 300 rounded up
  assert.deepEqual([ring[7], ring[10]], ['–', `+${(500 * 40 + 300 * 50).toLocaleString('en')}`], 'the bank plan makes necklaces, not rings; on its own, rounded up: 500 rings and the 300 cuts');
  assert.deepEqual((await cells('cr_sapphire_necklace')).slice(1, 4), ['20', 'Sapphire necklace', '55'], 'level 20, as the server has it');
  // the enchanted one, for what it sells as: the same Crafting XP, and the runes in its supplies
  const games = await cells('cr_ench_necklace_of_minigames_8');
  assert.deepEqual(games.slice(1, 4), ['20', 'Games necklace(8) (make & enchant)', '55']);
  assert.match(games[13], /^([\d,]+)\s*\1\s*\1\s*\1$/, 'a gold bar, a sapphire, a water rune and a cosmic rune each');
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
  assert.match(stone[9], /^5\s*→\s*9$/, 'round up: 5 more loops');
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
  const [blackHides, blackCoins, ...noMore] = body[13].split(/\s+/).map(x => Number(x.replace(/,/g, '')));
  assert.deepEqual([blackCoins, noMore], [blackHides * 20, []], 'the hides and 20 coins each for the tanner: thread is bought as you go');
  assert.match(await card.locator('tr[data-method="cr_black_dragonhide_body"]').getAttribute('title'), /Needs \(from scratch\): 3 Dragonhide \(black\), 60 Coins\nTools: Needle/);
  assert.equal(await card.locator('tr[data-method="cr_black_dragonhide_body"] td').nth(13).locator('.it-chip').nth(1).getAttribute('title'), 'Coins: a fee paid on the way');
  assert.equal(await card.locator('tr[data-method="cr_black_dragonhide_body"] td').nth(13).locator('.it-chip .item').first().getAttribute('title'), 'Dragonhide (black)');
  assert.equal((await cells('cr_dragon_vambraces'))[6], '350', '300 hides and 50 leather');
  assert.match(await card.locator('tr[data-method="cr_leather_gloves"]').getAttribute('title'), /Needs \(from scratch\): 1 Leather\nTools: Needle/);
  await page.screenshot({ path: `${SHOTS}/10d-crafting.png`, fullPage: true });
  // thread counted: it's in the supplies, a reel for every five, and none in the bank means none made
  await card.locator('input[data-gopt="assume"]').uncheck();
  await page.waitForFunction(() => !/Thread is left out/.test([...document.querySelectorAll('.goal')].find(g => g.innerText.includes('Crafting')).innerText));
  const counted = await cells('cr_black_dragonhide_body');
  const [hides, coins, reels] = counted[13].split(/\s+/).map(x => Number(x.replace(/,/g, '')));
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
    assert.match(air[9], /^2,000\s*60,000\s*6,000\s*→\s*2,000$/, 'round up: battlestaffs and the runes to charge the orbs');
    assert.equal(await card.locator('tr[data-method="cr_air_battlestaff"] td.even').getAttribute('title'),
      'Collect 2,000 Battlestaff, 60,000 Air rune and 6,000 Cosmic rune, and your bank covers 2,000 × Air battlestaff instead of 0.');
    assert.match(await card.locator('tr[data-method="cr_air_battlestaff"]').getAttribute('title'),
      /Air battlestaff: level 66, 137\.5 XP each\nNeeds \(from scratch\): 1 Unpowered orb, 30 Air rune, 3 Cosmic rune, 1 Battlestaff\nThe orb is an unpowered orb charged with Charge Air Orb \(Magic 66\): 76 Magic XP each\./);
    // the orbs in your bank count toward what's still needed: 2,000 fewer to buy than battlestaffs
    const [orbs, , , staffs] = air[13].split(/\s+/).map(x => Number(x.replace(/,/g, '')));
    assert.equal(staffs - orbs, 2000, air[13]);
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

await check("crafting: soda ash to battlestaves: every stage is made on the way with its XP said, and a stage the bank is short for stops it there (709 soda ash and 686 battlestaffs, v2.10.1)", async () => {
  // Demo Main is Crafting 88 (air battlestaves from 66) and Magic 90
  const card = page.locator('.goal', { hasText: 'Crafting' });
  const EMPTY = { soda_ash: '', bucket_sand: '', battlestaff: '', cosmicrune: '', airrune: '' };
  try {
    const flat = t => t.replace(/\s+/g, ' ').trim();
    // soda ash and battlestaffs alone: a molten glass takes a bucket of sand too, so nothing is made as the bank is
    await setBank('crafting', { soda_ash: '709', battlestaff: '686' });
    await addGoal('crafting', 95);
    const sec = card.locator('.plan-sec').first();
    await card.locator('.plan-t').waitFor();
    assert.match(flat(await sec.innerText()), /^From your bank Nothing in your bank makes Crafting XP at your level yet\./);
    await card.locator('[data-tgroup="Pottery & glass"]').click();
    // the table says what's missing, row by row: sand for the glass; sand and runes for the staves the 686 battlestaffs make
    let glass = await rowBy(card, 'cr_molten_glass');
    assert.deepEqual([glass['From bank'], glass['XP from bank'], flat(glass['Round up my supplies']), glass['XP after rounding up my supplies']], ['0', '–', '709 → 709', '+14,180']);
    assert.equal(await glass.td('Round up my supplies').getAttribute('title'), 'Collect 709 Bucket of sand, and your bank covers 709 × Molten glass instead of 0.');
    let staff = await rowBy(card, 'cr_air_battlestaff');
    assert.equal(await staff.td('Round up my supplies').getAttribute('title'),
      'Collect 686 Bucket of sand, 20,580 Air rune and 2,058 Cosmic rune, and your bank covers 686 × Air battlestaff instead of 0.');
    assert.equal(staff['XP after rounding up my supplies'], '+144,060');
    // rounded up, the whole chain is planned and what it takes is listed: sand for all 709, and 23 more battlestaffs for the orbs left over
    await card.locator('input[data-gopt="roundUp"]').check();
    await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank, supplies rounded up +148,890 XP → level 88');
    const whole = (await sec.locator('.step').allInnerTexts()).map(flat);
    assert.equal(whole.length, 2, whole.join(' / '));
    assert.match(whole[0], /^709 × Air battlestaff \+147,222\.5 XP .*incl\. 686 × Molten glass \+13,720 XP, 686 × Unpowered orb \+36,015 XP, 709 × Charge air orb collect 686 Bucket of sand 23 Battlestaff 2,127 Cosmic rune 21,270 Air rune$/);
    assert.match(whole[1], /^23 × Unpowered orb \+1,667\.5 XP .*incl\. 23 × Molten glass \+460 XP collect 23 Bucket of sand$/);
    assert.match(flat(await sec.locator('.collect').innerText()), /^To round up your supplies, collect: 709 Bucket of sand( \([\d.,]+[KM]?\))? 23 Battlestaff( \([\d.,]+[KM]?\))? 2,127 Cosmic rune( \([\d.,]+[KM]?\))? 21,270 Air rune( \([\d.,]+[KM]?\))?$/);
    // (the table's bank columns stay the bank's own: nothing, as it is)
    staff = await rowBy(card, 'cr_air_battlestaff');
    assert.deepEqual([staff['From bank'], staff['XP from bank'], staff['Gross from banked supplies']], ['0', '–', '–']);
    await card.locator('input[data-gopt="roundUp"]').uncheck();
    await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor({ state: 'detached' });
    // with the sand: the glass is made and blown, 709 orbs; the battlestaffs wait for the runes that charge an orb
    await setBank('crafting', { bucket_sand: '709' });
    await page.click('.tab[data-tab="goals"]');
    await card.locator('.step', { hasText: '709 × Unpowered orb' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +51,402.5 XP → level 88');
    assert.match(flat(await sec.locator('.step').innerText()), /^709 × Unpowered orb \+51,402\.5 XP .*incl\. 709 × Molten glass \+14,180 XP$/);
    // with the runes too: 686 air battlestaves through every stage, each with its XP, then the 23 soda ash left become orbs
    await setBank('crafting', { cosmicrune: '3000', airrune: '30000' });
    await page.click('.tab[data-tab="goals"]');
    await card.locator('.step', { hasText: '686 × Air battlestaff' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +145,727.5 XP → level 88');
    const steps = (await sec.locator('.step').allInnerTexts()).map(flat);
    assert.equal(steps.length, 2, steps.join(' / '));
    assert.match(steps[0], /^686 × Air battlestaff \+144,060 XP .*incl\. 686 × Molten glass \+13,720 XP, 686 × Unpowered orb \+36,015 XP, 686 × Charge air orb$/);
    assert.match(steps[1], /^23 × Unpowered orb \+1,667\.5 XP .*incl\. 23 × Molten glass \+460 XP$/);
    assert.equal(686 * (20 + 52.5 + 137.5) + 23 * (20 + 52.5), 145727.5);
    assert.equal(flat(await sec.locator('.tip.magic').innerText()), 'Magic XP on the way: +52,136 XP from 686 × Charge Air Orb (Magic 66)');
    // the table's XP from bank says the same, stage by stage in its tooltip; a row made only on the way has none of its own
    await card.locator('[data-tgroup="Pottery & glass"]').click();
    const air = await rowBy(card, 'cr_air_battlestaff'), orb = await rowBy(card, 'cr_stafforb');
    glass = await rowBy(card, 'cr_molten_glass');
    assert.deepEqual([air['From bank'], air['XP from bank'], flat(air['Round up my supplies']), air['XP after rounding up my supplies']], ['686', '+144,060', '23 → 709', '+148,890']);
    assert.equal(await air.td('XP from bank').getAttribute('title'),
      "Your bank plan makes 686 × Air battlestaff: +144,060 XP, with what's made on the way: 686 × Molten glass (+13,720 XP), 686 × Unpowered orb (+36,015 XP), 686 × Charge air orb.");
    assert.deepEqual([orb['From bank'], orb['XP from bank'], orb['XP after rounding up my supplies']], ['709', '+1,667.5', '+51,402.5']);
    assert.deepEqual([glass['From bank'], glass['XP from bank'], glass['XP after rounding up my supplies']], ['709', '–', '+14,180']);
    // (and where the rest went: a stage made on the way is counted in the row it was made for, and its own cell says so)
    assert.equal(await orb.td('XP from bank').getAttribute('title'),
      "Your bank plan makes 23 × Unpowered orb: +1,667.5 XP, with what's made on the way: 23 × Molten glass (+460 XP). Another 686 are made on the way to Air battlestaff: +36,015 XP, counted in that row's XP from bank.");
    assert.equal(await glass.td('XP from bank').getAttribute('title'),
      "709 are made on the way (686 for Air battlestaff and 23 for Unpowered orb): +14,180 XP, counted in those rows' XP from bank.");
    assert.equal(13720 + 36015 + 94325 + 460 + 1207.5, 145727.5, 'every stage, once');
    await page.screenshot({ path: `${SHOTS}/10v-battlestaff-chain.png`, fullPage: true });
    // rounded up: the 23 orbs left over go on battlestaves too, with 23 more battlestaffs to collect
    await card.locator('input[data-gopt="roundUp"]').check();
    await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank, supplies rounded up +148,890 XP → level 88');
    assert.match(flat(await sec.locator('.collect').innerText()), /^To round up your supplies, collect: 23 Battlestaff( \([\d.,]+[KM]?\))?$/);
    assert.equal((await rowBy(card, 'cr_air_battlestaff'))['XP from bank'], '+144,060', "the bank's own, rounded up or not");
  } finally {
    // leave things as they were, whatever happened
    await setBank('crafting', EMPTY);
    await page.click('.tab[data-tab="goals"]');
    if (await card.count()) {
      if (await card.locator('input[data-gopt="roundUp"]').count() && await card.locator('input[data-gopt="roundUp"]').isChecked()) await card.locator('input[data-gopt="roundUp"]').uncheck();
      await card.locator('[data-act="remove-goal"]').click();
      await card.locator('[data-act="remove-goal"]').click();
      await page.waitForFunction(() => ![...document.querySelectorAll('.goal')].some(g => g.innerText.includes('Crafting')));
    }
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
    assert.deepEqual([lob[1], lob[2], lob[3], lob[6], lob[12]], ['40', 'Lobster 27% burn', '120', '293', '1,050'], 'From bank is at your level now: 400 × 188/256');
    assert.match(lob[13], /^1,312\b/, 'Supplies needed: the raw ones');
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
    assert.deepEqual([lob[2], lob[6], lob[12]], ['Lobster', '400', '948']);
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

await check("agility: no bank and nothing to price; laps of a course; the Agility Arena's Total XP, XP per ticket and XP per pillar, a ticket at the average of the batches a plan exchanges or pinned to one", async () => {
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
    // the Agility Arena: three rows, named for the XP they count (v2.10). Total XP is a ticket earned and exchanged: its XP
    // on the way, and what the tickets of this goal are exchanged for on average. XP per ticket is the exchange alone,
    // XP per pillar the way there alone
    await card.locator('[data-tgroup="Agility Arena"]').click();
    await card.locator('tr[data-method="ag_ticket"]').waitFor();
    assert.deepEqual(await names(), ['Total XP', 'XP per ticket', 'XP per pillar']);
    assert.deepEqual(await cells('ag_ticket'), ['1', 'Total XP', '360.9', '1,666', '']);
    assert.deepEqual(await cells('ag_ticket_held'), ['1', 'XP per ticket', '303.1', '1,983', '']);
    assert.deepEqual(await cells('ag_pillar'), ['1', 'XP per pillar', '57.8', '10,397', '']);
    const WAY = "On average 3\\.3 obstacles lie between one ticket pillar and the next: 57\\.8 XP on the way\\. Below level 40 some are shut and the way round is longer, so it's a little more\\. A pillar a minute at best: the first one you tag gives no ticket, and neither does the one after a pillar you miss\\. Going in costs 200 coins\\.";
    assert.match(await tip('ag_ticket'), new RegExp(`^Total XP: level 1, 360\\.9 XP each \\(on the way 57\\.8 \\+ exchanged 303\\.1\\)\\nA pillar's ticket, earned and exchanged for XP\\. ${WAY}$`));
    assert.match(await tip('ag_pillar'), new RegExp(`^XP per pillar: level 1, 57\\.8 XP each\\nGetting to a pillar alone: for when its ticket goes on herbs or another reward instead of XP\\. ${WAY}$`));
    assert.equal(await tip('ag_ticket_held'), "XP per ticket: level 1, 303.1 XP each\nFor tickets you've saved up: only what they're exchanged for counts. Type how many you have under Plan to make.");
    assert.deepEqual((await card.locator('select[data-gopt="fill"] optgroup[label="Agility Arena"] option').allInnerTexts()).map(flat), ['Total XP (lvl 1, 360.9 XP)', 'XP per ticket (lvl 1, 303.1 XP)', 'XP per pillar (lvl 1, 57.8 XP)']);
    assert.equal(await card.locator('.tip', { hasText: 'Arena tickets' }).count(), 0, 'no tickets in the plan yet');
    // the pillars alone, for when the tickets go on herbs: nothing is exchanged, so nothing is said of batches
    await card.locator('tr[data-method="ag_pillar"] td:nth-child(2)').click();
    await plan.locator('.step', { hasText: 'their tickets kept' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '10,397 Agility Arena pillars, their tickets kept +600,946.6 XP');
    assert.equal(await card.locator('.tip', { hasText: 'Arena tickets' }).count(), 0);
    assert.match(flat(await plan.innerText()), /Getting to a pillar alone: for when its ticket goes on herbs or another reward instead of XP\./);
    assert.equal((await goalOf('old_badger', 'agility')).fillId, 'ag_pillar');
    await card.locator('tr[data-method="ag_ticket"] td:nth-child(2)').click();
    await plan.locator('.step', { hasText: 'earned and exchanged' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '1,666 Agility Arena tickets earned and exchanged +601,259.4 XP');
    const tickets = plan.locator('.tip', { hasText: 'Arena tickets' });
    assert.equal(flat(await tickets.innerText()), 'Arena tickets: the 1,666 in this plan are exchanged together, as 1 × 1,000, 6 × 100, 2 × 25, 1 × 10 and 6 on their own: 303.1 XP each on average.');
    assert.equal(await plan.locator('.step .item').getAttribute('title'), 'Agility arena ticket');
    // the batch is a choice on the goal: pinned to 1,000 at a time, every ticket is 377.8 XP whatever the plan's size
    const batch = card.locator('select[data-opt="tickets"]');
    assert.deepEqual((await batch.locator('option').allInnerTexts()).map(flat), ['In the biggest batches', '1,000 at a time', '100 at a time', '25 at a time', '10 at a time', 'One at a time']);
    assert.match(await card.locator('label:has(select[data-opt="tickets"])').getAttribute('title'), /240 XP for one, 248 XP each for 10, 260 XP each for 25, 280 XP each for 100, 320 XP each for 1,000\./);
    await batch.selectOption('x1000');
    await plan.locator('.step', { hasText: '1,591' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '1,591 Agility Arena tickets earned and exchanged +601,079.8 XP');
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
    assert.deepEqual((await card.locator('.plan-sec', { hasText: 'Your mix' }).locator('.step').allInnerTexts()).map(flat), ['600 Agility Arena tickets exchanged +183,000 XP', '100 laps of the Wilderness course +57,140 XP']);
    assert.match(flat(await plan.locator('h4').innerText()), /^Then, to reach your goal: 360,793 XP$/);
    assert.equal(flat(await plan.locator('.step').innerText()), '1,000 Agility Arena tickets earned and exchanged +362,800 XP');
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
    assert.equal(flat(await plan.locator('.step').innerText()), '50 Agility Arena tickets earned and exchanged +18,890 XP');
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
    // pillars in a mix beside tickets you hold: only the tickets are exchanged, the pillars' are kept
    await card.locator('[data-tgroup="Agility Arena"]').click();
    await card.locator('[data-mix="ag_pillar"]').fill('200');
    await card.locator('[data-mix="ag_pillar"]').press('Tab');
    await card.locator('.plan-sec', { hasText: 'Your mix +11,560 XP' }).waitFor();
    await card.locator('[data-mix="ag_ticket_held"]').fill('100');
    await card.locator('[data-mix="ag_ticket_held"]').press('Tab');
    const kept = card.locator('.plan-sec', { hasText: 'Your mix +39,560 XP' });
    await kept.waitFor();
    assert.deepEqual((await kept.locator('.step').allInnerTexts()).map(flat), ['200 Agility Arena pillars, their tickets kept +11,560 XP', '100 Agility Arena tickets exchanged +28,000 XP']);
    assert.equal(flat(await kept.locator('.tip', { hasText: 'Arena tickets' }).innerText()), 'Arena tickets: the 100 in this plan are exchanged together, as 1 × 100: 280 XP each.');
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

await check('prayer: bones are buried from the bank, the best first; the two bones the server has besides; look-alike bones in a screenshot', async () => {
  await planAs('old badger', 'Old Badger');
  const card = goalCard('Prayer');
  const BANK = { dragon_bones: '120', big_bones: '900', bones: '40' };
  const saved = await page.evaluate(() => localStorage.getItem('lchs.bank.old_badger'));
  try {
    await setBank('prayer', BANK);
    assert.deepEqual((await page.locator('#bank-body .bank-group h4').allInnerTexts()).map(flat), ['Bones']);
    assert.equal(await page.locator('#bank-body [data-bank]').count(), 10);
    await addGoal('prayer', 60);
    await card.locator('.plan').waitFor();
    const t = flat(await card.innerText());
    assert.match(t, /Level 56 → 60/);
    // a bank skill like Firemaking: one thing goes in, so there's nothing to round up, and no choices
    assert.match(flat(await card.locator('.plan-opts').innerText()), /^Use my bank 3 kinds of item in your bank/);
    assert.equal(await card.locator('input[data-gopt="roundUp"], .plan-opts select').count(), 0);
    const sec = card.locator('.plan-sec').first();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +22,320 XP → level 57');
    assert.deepEqual((await sec.locator('.step').allInnerTexts()).map(x => flat(x).replace(/ · .*$/, '')), ['120 × Dragon bones +8,640 XP', '900 × Big bones +13,500 XP', '40 × Bones +180 XP']);
    // the rest of the goal in the bones the bank mostly had
    const then = card.locator('.plan-sec', { hasText: 'Then, to reach your goal' });
    assert.match(flat(await then.locator('h4').innerText()), /^Then, to reach your goal: 67,282 XP$/);
    assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'pr_big_bones');
    assert.equal(flat(await then.locator('.step').innerText()), '4,486 × Big bones +67,290 XP');
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 4,486 Big bones/);
    // every bone, least XP first: LostHQ's eight, and the two the server drops besides
    const names = async () => (await card.locator('tr[data-method] td:nth-child(3)').allInnerTexts()).map(flat);
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
    const tip = id => card.locator(`tr[data-method="${id}"]`).getAttribute('title');
    assert.deepEqual(await names(), ['Bones', 'Burnt bones', 'Bat bones', 'Wolf bones', 'Monkey bones', 'Big bones', 'Jogre bones', 'Shaikahan bones', 'Babydragon bones', 'Dragon bones']);
    assert.equal(await card.locator('.group-pick').count(), 0, 'one group: nothing to pick');
    assert.deepEqual((await card.locator('.plan-t thead th').allInnerTexts()).map(flat).slice(0, 7), ['Use', 'Lvl', 'Bones', 'XP', 'Net/item', 'gp/XP', 'From bank']);
    assert.doesNotMatch(flat(await card.locator('.plan-t thead').innerText()), /Round up/);
    const dragon = await cells('pr_dragon_bones');
    assert.deepEqual([dragon[1], dragon[2], dragon[3], dragon[6]], ['1', 'Dragon bones', '72', '120']);
    assert.match(await tip('pr_mm_normal_monkey_bones'), /^Monkey bones: level 1, 5 XP each\nNeeds \(from scratch\): 1 Monkey bones\nDropped by the monkeys of Karamja\. Not on LostHQ's calculator: the server's own XP\./);
    assert.match(await tip('pr_tbwt_beast_bones'), /^Shaikahan bones: level 1, 25 XP each\n.*\nDropped by the Shaikahan, east of Tai Bwo Wannai\. Not on LostHQ's calculator: the server's own XP\./);
    // picked, dragon bones finish the goal
    await card.locator('tr[data-method="pr_dragon_bones"] td:nth-child(3)').click();
    await then.locator('.step', { hasText: 'Dragon bones' }).waitFor();
    assert.equal(flat(await then.locator('.step').innerText()), '935 × Dragon bones +67,320 XP');
    assert.deepEqual((await sec.locator('.step').allInnerTexts()).map(x => flat(x).replace(/ \+.*$/, '')), ['120 × Dragon bones', '900 × Big bones', '40 × Bones'], 'the bank as before: dragon bones were first already');
    await page.screenshot({ path: `${SHOTS}/10r-prayer.png`, fullPage: true });
    // its prices, and its tab on the Bank
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="prayer"]');
    await page.waitForSelector('[data-price="dragon_bones"]');
    assert.match(flat(await text('#prices-body')), /^Bones .*Bones.*Burnt bones.*Bat bones.*Wolf bones.*Monkey bones.*Big bones.*Jogre bones.*Shaikahan bones.*Babydragon bones.*Dragon bones/);
    // a screenshot: big, jogre and baby dragon bones are one picture, and so are dragon and Shaikahan bones
    await page.click('.tab[data-tab="bank"]');
    const items = [{ slot: 0, icon: 'big_bones', count: 950 }, { slot: 1, icon: 'dragon_bones', count: 130 }, { slot: 2, icon: 'wolf_bones', count: 7 }];
    await page.setInputFiles('#shots-file', [{ name: 'bones.png', mimeType: 'image/png', buffer: encodePng(fakeBank({ items })) }]);
    await page.waitForSelector('#bank-shots .shots-result', { timeout: 45000 });
    const big = page.locator('[data-shot-as="big_bones@0"]'), drag = page.locator('[data-shot-as="dragon_bones@0"]');
    assert.deepEqual([await big.inputValue(), await big.locator('option').allInnerTexts()], ['big_bones', ['Big bones', 'Babydragon bones', 'Jogre bones']]);
    assert.deepEqual([await drag.inputValue(), await drag.locator('option').allInnerTexts()], ['dragon_bones', ['Dragon bones', 'Shaikahan bones']]);
    assert.equal(await page.locator('.shot-row', { has: page.locator('[data-shot="wolf_bones"]') }).locator('select').count(), 0, 'wolf bones have a colour of their own');
    await big.selectOption('babydragon_bones');
    await page.waitForFunction(() => document.querySelector('[data-shot-as="big_bones@0"]')?.value === 'babydragon_bones');
    await page.click('[data-act="shots-apply"]');
    await page.waitForSelector('#bank-msg:not([hidden])');
    await page.click('[data-bskill="prayer"]');
    assert.deepEqual([await page.inputValue('[data-bank="babydragon_bones"]'), await page.inputValue('[data-bank="dragon_bones"]'), await page.inputValue('[data-bank="wolf_bones"]')], ['950', '130', '7']);
  } finally {
    await page.evaluate(v => (v == null ? localStorage.removeItem('lchs.bank.old_badger') : localStorage.setItem('lchs.bank.old_badger', v)), saved);
    await page.click('.tab[data-tab="bank"]');
    await page.click('[data-bskill="herblore"]');
    await removeGoal(card);
    await noGoalFor('Prayer');
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="herblore"]');
    await page.click('.tab[data-tab="goals"]');
  }
});

await check("magic: spells by how you train with them, each with its own runes; a bank's runes go to teleports and combat spells by themselves, a curse or alchemy waits to be picked; jewellery made on the way; a staff, damage and rounding up", async () => {
  await planAs('old badger', 'Old Badger');
  const card = goalCard('Magic');
  const saved = await page.evaluate(() => localStorage.getItem('lchs.bank.old_badger'));
  try {
    // nature and fire runes: alchemy's, and nothing a bank casts by itself
    await setBank('magic', { naturerune: '2000', firerune: '5000' });
    // the Magic bank: the runes, then what each kind of spell is cast on (or what that's made of: v2.10) and makes
    assert.deepEqual((await page.locator('#bank-body .bank-group h4').allInnerTexts()).map(flat),
      ['Runes', 'Jewellery to enchant', 'Ore to superheat', 'Orbs to charge', 'What jewellery and orbs are made of', 'Made: enchanted jewellery', 'Made: bars', 'Made: orbs']);
    assert.deepEqual(await page.locator('#bank-body .bank-group', { hasText: 'What jewellery and orbs are made of' }).locator('[data-bank]').evaluateAll(els => els.map(el => el.dataset.bank)),
      ['uncut_sapphire', 'uncut_emerald', 'uncut_ruby', 'uncut_diamond', 'uncut_dragonstone', 'sapphire', 'emerald', 'ruby', 'diamond', 'dragonstone', 'keyhalf1', 'keyhalf2', 'crystal_key', 'wool', 'ball_of_wool',
        'bucket_sand', 'soda_ash', 'molten_glass']);
    assert.match(flat(await text('#bank-head')), /A Magic goal casts your runes as the best teleport and combat spell they allow\. Jewellery and orbs can be entered as what they're made of \(gold bars, gems, molten glass\)/);
    await addGoal('magic', 60);
    await card.locator('.plan').waitFor();
    assert.match(flat(await card.innerText()), /Level 50 → 60/);
    // the choices on the goal: a staff and what to count of the damage
    assert.match(flat(await card.locator('.plan-opts').innerText()), /^Use my bank Round up my supplies Staff None Air Water Earth Fire Lava \(earth and fire\) Damage Leave it out Half the casts hit Every cast hits 2 kinds of item in your bank/);
    assert.match(await card.locator('label:has(select[data-opt="staff"])').getAttribute('title'), /^A staff in your hand stands in for its rune, however many a spell takes: a staff of air, an air battlestaff or a mystic air staff for air runes;/);
    assert.match(await card.locator('label:has(select[data-opt="damage"])').getAttribute('title'), /^A combat spell gives its XP for the cast, hit or miss, and 2 XP more for every point of damage\./);
    const sec = card.locator('.plan-sec').first();
    const then = card.locator('.plan-sec', { hasText: 'to reach your goal' }).first();
    const steps = async () => (await sec.locator('.step').allInnerTexts()).map(x => flat(x).replace(/ · .*$/, ''));
    // alchemy waits to be asked: its runes alone don't say you mean it
    assert.equal(flat(await sec.innerText()), "From your bank Nothing in your bank is used by itself yet. Your bank's runes go to the best teleport and combat spell they allow by themselves. "
      + "A curse, alchemy and the like wait to be asked: click a spell in the table below to train with it, and your bank's runes go to it first.");
    // the rest of the goal: the best combat spell at level 50
    assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'mg_water_blast');
    assert.equal(flat(await then.locator('.step').innerText()), '6,046 × Water Blast +172,311 XP');
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 6,046 Death rune( \([\d.,]+[KM]?\))? 18,138 Water rune( \([\d.,]+[KM]?\))? 18,138 Air rune/);
    assert.equal(await then.locator('.step .item.sprite').getAttribute('title'), 'Water Blast', "the spell's own icon");
    // law and chaos runes are cast by themselves (v2.10): the best teleports and bolts the runes beside them allow at
    // level 50. Falador while the water runes last (it takes fewer air runes than Camelot), Fire Bolt while the fire runes do
    await setBank('magic', { airrune: '10000', chaosrune: '3000', lawrune: '1000', cosmicrune: '100', waterrune: '800' });
    await page.click('.tab[data-tab="goals"]');
    await sec.locator('.step', { hasText: 'Falador Teleport' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +96,862.5 XP → level 56');
    assert.deepEqual(await steps(), ['800 × Falador Teleport +38,400 XP', '200 × Camelot Teleport +11,100 XP', '1,250 × Fire Bolt +28,125 XP', '1,425 × Wind Bolt +19,237.5 XP']);
    assert.equal(await card.locator('.tip.magic, .tip.crafting').count(), 0);
    // the rest of the goal goes back to combat: the best spell at the level the bank leaves you
    assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'mg_earth_blast');
    assert.equal(flat(await then.locator('.step').innerText()), '2,396 × Earth Blast +75,474 XP');
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 2,396 Death rune( \([\d.,]+[KM]?\))? 9,584 Earth rune( \([\d.,]+[KM]?\))? 7,188 Air rune/);
    assert.equal(await then.locator('.tip', { hasText: 'Tip: collect' }).count(), 0, "the bank's air runes are spent above: no promise of Earth Blasts from them");
    // five kinds of spell, one at a time: combat's showing
    const names = async () => (await card.locator('tr[data-method] td:nth-child(3)').allInnerTexts()).map(flat);
    const cells = async id => (await card.locator(`tr[data-method="${id}"]`).innerText()).split('\t').map(c => c.trim());
    const tip = id => card.locator(`tr[data-method="${id}"]`).getAttribute('title');
    assert.deepEqual((await card.locator('.group-pick .chip').allInnerTexts()).map(x => x.trim()), ['Combat', 'Curses', 'Utility', 'Enchantment', 'Teleports', 'All']);
    assert.equal(await card.locator('.group-pick .chip.on').innerText(), 'Combat');
    assert.deepEqual(await names(), ['Wind Strike', 'Water Strike', 'Earth Strike', 'Fire Strike', 'Wind Bolt', 'Water Bolt', 'Earth Bolt', 'Fire Bolt', 'Crumble Undead', 'Wind Blast', 'Water Blast', 'Iban Blast',
      'Earth Blast', 'Fire Blast', 'Saradomin Strike', 'Claws of Guthix', 'Flames of Zamorak', 'Wind Wave', 'Water Wave', 'Earth Wave', 'Fire Wave']);
    assert.deepEqual((await card.locator('.plan-t thead th').allInnerTexts()).map(flat).slice(0, 7), ['Use', 'Lvl', 'Spell', 'XP', 'Net/item', 'gp/XP', 'From bank']);
    assert.equal(await card.locator('tr[data-method="mg_fire_bolt"] .item.sprite.sm').count(), 1);
    // a row: what the bank's runes could cast of it on its own, and what the server says of it
    let bolt = await cells('mg_fire_bolt');
    assert.deepEqual([bolt[1], bolt[2], bolt[3], bolt[6]], ['35', 'Fire Bolt', '22.5', '1,250']);
    assert.match(await tip('mg_fire_bolt'), /^Fire Bolt: level 35, 22\.5 XP each\nNeeds \(from scratch\): 1 Chaos rune, 4 Fire rune, 3 Air rune\nMax hit 12 \(15 with chaos gauntlets\): every point of damage is 2 XP on top of the cast's\. See Damage on the goal\./);
    assert.match(await tip('mg_crumble_undead'), /^Crumble Undead: level 39, 49 XP each\n.*\nOnly works on skeletons, zombies, ghosts and shades\. Max hit 8: .* LostHQ's calculator says 24\.5 XP; the server gives 49\./);
    assert.match(await tip('mg_saradomin_strike'), /\nTools: Staff of saradomin\nLearnt in the Mage Arena, and cast with the staff of Saradomin in hand\./);
    // what's cast on something gets the runes first: iron ore goes to steel while there's coal, and 100 cosmic runes enchant
    // 100 rings. Their fire and water runes aren't cast away as bolts and teleports before them
    await setBank('magic', { sapphire_ring: '300', iron_ore: '400', coal: '1000' });
    await page.click('.tab[data-tab="goals"]');
    await sec.locator('.step', { hasText: 'Steel bar' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +115,162.5 XP → level 57');
    assert.deepEqual(await steps(), ['1,000 × Camelot Teleport +55,500 XP', '400 × Superheat Item: Steel bar +21,200 XP', '850 × Fire Bolt +19,125 XP', '100 × Lvl-1 Enchant: Ring of recoil +1,750 XP',
      '350 × Water Bolt +5,775 XP', '875 × Wind Bolt +11,812.5 XP']);
    assert.equal(flat(await then.locator('.step').innerText()), '1,815 × Earth Blast +57,172.5 XP');
    // picked, a spell gets the bank before anything else: 5,000 fire runes are 1,250 Fire Bolts, and leave none to superheat with
    await card.locator('tr[data-method="mg_fire_bolt"] td:nth-child(3)').click();
    await sec.locator('h4', { hasText: '+94,862.5 XP' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +94,862.5 XP → level 56');
    assert.deepEqual(await steps(), ['1,250 × Fire Bolt +28,125 XP', '1,000 × Camelot Teleport +55,500 XP', '100 × Lvl-1 Enchant: Ring of recoil +1,750 XP', '350 × Water Bolt +5,775 XP', '275 × Wind Bolt +3,712.5 XP']);
    assert.equal(flat(await then.locator('.step').innerText()), '3,443 × Fire Bolt +77,467.5 XP');
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 2,318 Chaos rune( \([\d.,]+[KM]?\))? 13,772 Fire rune( \([\d.,]+[KM]?\))? 10,329 Air rune/);
    assert.doesNotMatch(flat(await then.innerText()), /Also bring/);
    // a staff of fire: no fire runes in anything, so the bank's chaos runes all go to Fire Bolt and the ore is superheated after all
    await card.locator('select[data-opt="staff"]').selectOption('fire');
    await sec.locator('h4', { hasText: '+101,550 XP' }).waitFor();
    assert.deepEqual(await steps(), ['3,000 × Fire Bolt +67,500 XP', '200 × Camelot Teleport +11,100 XP', '400 × Superheat Item: Steel bar +21,200 XP', '100 × Lvl-1 Enchant: Ring of recoil +1,750 XP']);
    assert.equal(flat(await then.locator('.step').innerText()), '3,145 × Fire Bolt +70,762.5 XP');
    assert.match(flat(await then.locator('.collect').first().innerText()), /^To collect or buy: 3,145 Chaos rune( \([\d.,]+[KM]?\))? 9,435 Air rune/);
    assert.match(flat(await then.innerText()), /Also bring: Staff of fire/);
    assert.match(await tip('mg_fire_bolt'), /\nNeeds \(from scratch\): 1 Chaos rune, 3 Air rune\nTools: Staff of fire\n/);
    assert.deepEqual((await goalOf('old_badger', 'magic')).opts, { staff: 'fire' });
    // damage counted: every cast for half its max hit (12), 2 XP a point
    await card.locator('select[data-opt="damage"]').selectOption('alldmg');
    await sec.locator('h4', { hasText: '+137,550 XP' }).waitFor();
    assert.equal(flat(await then.locator('.step').innerText()), '1,008 × Fire Bolt +34,776 XP');
    bolt = await cells('mg_fire_bolt');
    assert.equal(bolt[3], '34.5');
    assert.match(await tip('mg_fire_bolt'), /^Fire Bolt: level 35, 34\.5 XP each \(the cast 22\.5 \+ damage 12\)\n/);
    assert.deepEqual((await goalOf('old_badger', 'magic')).opts, { staff: 'fire', damage: 'alldmg' });
    await page.screenshot({ path: `${SHOTS}/10s-magic.png`, fullPage: true });
    await card.locator('select[data-opt="damage"]').selectOption('nodamage');
    await card.locator('select[data-opt="staff"]').selectOption('nostaff');
    await sec.locator('h4', { hasText: '+94,862.5 XP' }).waitFor();
    assert.equal((await goalOf('old_badger', 'magic')).opts, undefined, 'the first of each list is how it starts: nothing to keep');
    // rounded up: the spell you train with goes as far as its most plentiful rune (10,000 air runes: 3,333), and runes
    // never hold back what's cast on something: all 300 rings, the cosmic runes short collected. Nothing else is cast:
    // spare runes alone don't call for more
    assert.match(await card.locator('label:has(input[data-gopt="roundUp"])').getAttribute('title'), /Runes and balls of wool never hold it back: what you're short of is collected too\.$/);
    await card.locator('input[data-gopt="roundUp"]').check();
    await sec.locator('h4', { hasText: 'supplies rounded up' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank, supplies rounded up +106,742.5 XP → level 57');
    const rounded = (await sec.locator('.step').allInnerTexts()).map(flat);
    assert.equal(rounded.length, 3, rounded.join(' / '));
    assert.match(rounded[0], /^3,333 × Fire Bolt \+74,992\.5 XP collect\s?333 Chaos rune\s?8,332 Fire rune$/);
    assert.match(rounded[1], /^500 × Superheat Item: Steel bar \+26,500 XP .*collect\s?100 Iron ore\s?2,000 Fire rune$/);
    assert.match(rounded[2], /^300 × Lvl-1 Enchant: Ring of recoil \+5,250 XP .*collect\s?200 Cosmic rune$/);
    assert.match(flat(await sec.locator('.collect').innerText()), /^To round up your supplies, collect: 100 Iron ore.* 333 Chaos rune.* 10,332 Fire rune.* 200 Cosmic rune/);
    await card.locator('input[data-gopt="roundUp"]').uncheck();
    await sec.locator('h4', { hasText: '+94,862.5 XP' }).waitFor();
    // a spell above your level waits for it, and the bank's own spells get you there (v2.10): teleports and steel bars
    // to level 55, then High Level Alchemy before anything else
    await card.locator('[data-tgroup="Utility"]').click();
    assert.deepEqual(await names(), ['Bones to Bananas', 'Low Level Alchemy', 'Telekinetic Grab', ...['Bronze', 'Iron', 'Silver', 'Steel', 'Gold', 'Mithril', 'Adamantite', 'Runite'].map(b => `Superheat Item: ${b} bar`), 'High Level Alchemy', 'Charge']);
    assert.match(await tip('mg_highlvl_alchemy'), /^High Level Alchemy: level 55, 65 XP each\nNeeds \(from scratch\): 1 Nature rune, 5 Fire rune\nAny item will do: what you alch, and the coins it turns into \(60% of its shop value\), aren't counted here\./);
    assert.match(await tip('mg_superheat_steel_bar'), /^Superheat Item: Steel bar: level 43, 53 XP each\nNeeds \(from scratch\): 1 Iron ore, 2 Coal, 1 Nature rune, 4 Fire rune\nNeeds Smithing 30\. It gives the bar's Smithing XP too, which isn't counted here\./);
    await card.locator('tr[data-method="mg_highlvl_alchemy"] td:nth-child(3)').click();
    await sec.locator('.step', { hasText: 'High Level Alchemy' }).waitFor();
    assert.deepEqual(await steps(), ['1,000 × Camelot Teleport +55,500 XP', '184 × Superheat Item: Steel bar +9,752 XP', '852 × High Level Alchemy +55,380 XP', '1 × Superheat Item: Steel bar +53 XP',
      '100 × Lvl-1 Enchant: Ring of recoil +1,750 XP', '350 × Water Bolt +5,775 XP', '2,150 × Wind Bolt +29,025 XP']);
    assert.deepEqual((await then.locator('.step').allInnerTexts()).map(flat), ['232 × High Level Alchemy +15,080 XP']);
    // the other kinds
    await card.locator('[data-tgroup="Curses"]').click();
    assert.deepEqual(await names(), ['Confuse', 'Weaken', 'Curse', 'Bind', 'Snare', 'Vulnerability', 'Enfeeble', 'Entangle', 'Stun']);
    assert.match(await tip('mg_stun'), /^Stun: level 80, 90 XP each\n.*\nLowers your target's Attack\. It can't be cast on one whose Attack is already lowered\. The XP is for the cast, whether it takes hold or not\. LostHQ's calculator says 80 XP; the server gives 90\./);
    await card.locator('[data-tgroup="Enchantment"]').click();
    assert.deepEqual((await names()).slice(0, 4).concat((await names()).slice(-2)), ['Lvl-1 Enchant: Ring of recoil', 'Lvl-1 Enchant: Amulet of magic', 'Lvl-1 Enchant: Games necklace(8)', 'Lvl-2 Enchant: Ring of dueling(8)',
      'Lvl-5 Enchant: Ring of wealth', 'Lvl-5 Enchant: Amulet of glory(4)']);
    assert.equal((await names()).length, 15);
    assert.deepEqual((await cells('mg_enchant_ring_of_recoil')).slice(1, 4).concat((await cells('mg_enchant_ring_of_recoil'))[6]), ['7', 'Lvl-1 Enchant: Ring of recoil', '17.5', '100']);
    assert.match(await tip('mg_water_orb'), /^Charge Water Orb: level 56, 66 XP each\nNeeds \(from scratch\): 1 Unpowered orb, 30 Water rune, 3 Cosmic rune\nCast at the Obelisk of Water, with an unpowered orb on you\. LostHQ's calculator says 56 XP; the server gives 66\./);
    await card.locator('[data-tgroup="Teleports"]').click();
    assert.deepEqual(await names(), ['Varrock Teleport', 'Lumbridge Teleport', 'Falador Teleport', 'Camelot Teleport', 'Ardougne Teleport', 'Watchtower Teleport', 'Trollheim Teleport']);
    assert.match(await tip('mg_trollheim_teleport'), /\nOnce Eadgar's Ruse is done\. Not on LostHQ's calculator: the server's own level and XP\./);
    assert.deepEqual((await cells('mg_camelot_teleport')).slice(1, 4).concat((await cells('mg_camelot_teleport'))[6]), ['45', 'Camelot Teleport', '55.5', '1,000']);
    // made on the way (v2.10): a bank of gold bars, gems and molten glass. Old Badger's Crafting is 56: the sapphires are cut
    // and set in rings on the way, and the cosmic runes counted for them. (The glass waits: Charge Air Orb is Magic 66.)
    await page.evaluate(() => {
      const b = JSON.parse(localStorage.getItem('lchs.bank.old_badger'));
      b.items = { gold_bar: 300, uncut_sapphire: 200, sapphire: 50, cosmicrune: 500, waterrune: 500, molten_glass: 100, airrune: 5000 };
      localStorage.setItem('lchs.bank.old_badger', JSON.stringify(b));
    });
    await card.locator('select[data-gopt="fill"]').selectOption('mg_water_blast');
    await page.click('.tab[data-tab="bank"]');
    await page.click('.tab[data-tab="goals"]');
    await sec.locator('.step', { hasText: 'Ring of recoil' }).waitFor();
    assert.equal(flat(await sec.locator('h4').innerText()), 'From your bank +4,375 XP → level 50');
    assert.match(flat(await sec.locator('.step').innerText()), /^250 × Lvl-1 Enchant: Ring of recoil \+4,375 XP .*incl\. 200 × Sapphire \(cut\), 250 × Sapphire ring$/);
    // that Crafting XP is Crafting's: said under the plan, not counted in it (200 cuts at 50, 250 rings at 40)
    assert.equal(flat(await sec.locator('.tip.crafting').innerText()), 'Crafting XP on the way: +20,000 XP from 200 × Sapphire (cut), 250 × Sapphire ring');
    assert.match(await sec.locator('.tip.crafting').getAttribute('title'), /^Not part of the XP above: it's what making these on the way gives your Crafting\./);
    await card.locator('[data-tgroup="Enchantment"]').click();
    const recoil = await cells('mg_enchant_ring_of_recoil');
    assert.deepEqual([recoil[6], flat(recoil[9])], ['250', '50 → 300'], 'From bank; and rounded up to the gold bars, with 50 sapphires to collect');
    assert.equal((await cells('mg_air_orb'))[6], '100', 'the glass is 100 orbs, once Magic is 66');
    // what the rest of a goal takes is still the ring itself
    assert.match(await tip('mg_enchant_ring_of_recoil'), /\nNeeds \(from scratch\): 1 Sapphire ring, 1 Water rune, 1 Cosmic rune\n/);
    // its prices: by the bank's groups
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="magic"]');
    await page.waitForSelector('[data-price="soulrune"]');
    assert.match(flat(await text('#prices-body')), /^Runes .*Air rune.*Soul rune.*Jewellery to enchant .*Sapphire ring.*Ore to superheat .*Coal.*Orbs to charge .*Unpowered orb.*What jewellery and orbs are made of .*Uncut sapphire.*Molten glass.*Made: enchanted jewellery .*Ring of recoil.*Made: bars .*Runite bar.*Made: orbs .*Air orb/);
  } finally {
    await page.evaluate(v => (v == null ? localStorage.removeItem('lchs.bank.old_badger') : localStorage.setItem('lchs.bank.old_badger', v)), saved);
    await page.click('.tab[data-tab="bank"]');
    await page.click('[data-bskill="herblore"]');
    await removeGoal(card);
    await noGoalFor('Magic');
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="herblore"]');
    await page.click('.tab[data-tab="goals"]');
  }
});

// (back to Demo Main for the checks that follow, whatever happened above)
try { await planAs('demo main', 'Demo Main'); } catch (e) { results.push(['FAIL', 'back to Demo Main after the Old Badger checks', e.message.split('\n')[0]]); }

// (as Old Badger, whose XP nothing in this run changes: Attack 51, Strength 53, Defence 52, Hitpoints 54, Ranged 55, Prayer 56,
// Magic 50, so combat level 67)
await check('combat: Attack is trained on monsters: kills to the goal, the usual monster for your combat level, the style, and what else a kill gives', async () => {
  await planAs('old badger', 'Old Badger');
  await addGoal('attack', 60);
  const card = goalCard('Attack');
  try {
    await card.locator('.plan').waitFor();
    const t = flat(await card.innerText());
    assert.match(t, /Level 51 → 60/);
    assert.match(t, /A kill counts as the monster's hitpoints in damage, however many hits that takes\. Food, gear and drops aren't counted, so this plan doesn't use your bank or any prices\./);
    assert.doesNotMatch(t, /From your bank|Use my bank|Round up|To collect or buy|Buying it all|is worth|Net\/item|gp\/XP|Cheapest XP|Plan to make/);
    assert.match(t, /To reach your goal: 161,697 XP/);
    // no monster picked: the most XP a kill among those no more than half your combat level (67: a rock crab, level 13, 50 hitpoints)
    const plan = card.locator('.plan-sec', { hasText: 'To reach your goal' });
    const fill = card.locator('select[data-gopt="fill"]');
    assert.equal(await fill.inputValue(), 'at_rock_crab_13');
    assert.equal(flat(await plan.locator('.step').innerText()), '809 × Rock Crab (level 13) +161,800 XP');
    assert.equal(flat(await plan.locator('.bar .small-note').innerText()), 'Not your pick yet: the most XP a kill among monsters no more than half your combat level (67). Pick yours here, or find it in the table below.');
    assert.equal((await goalOf('old_badger', 'attack')).fillId, undefined, 'nothing is kept until you pick');
    assert.equal(await plan.locator('.step .item.blank .ico-attack').count(), 1, "no item to show: the skill's icon in its place");
    assert.equal(await plan.locator('.money').count(), 0, 'no money to speak of');
    // the list under Train with: every monster, by band of combat level, with its level, hitpoints and the XP of a kill
    assert.deepEqual(await fill.locator('optgroup').evaluateAll(els => els.map(el => [el.label, el.children.length])),
      [['Level 1–10', 58], ['Level 11–20', 48], ['Level 21–30', 49], ['Level 31–50', 67], ['Level 51–80', 43], ['Level 81–110', 30], ['Level 111 and up', 19]]);
    assert.equal(flat(await fill.locator('option:checked').innerText()), 'Rock Crab (level 13, 50 HP, 200 XP)');
    assert.deepEqual((await fill.locator('optgroup[label="Level 31–50"] option').allInnerTexts()).map(flat).filter(x => /^Guard \(/.test(x)), ['Guard (level 37, 40 HP, 160 XP)', 'Guard (level 37, 50 HP, 200 XP)'], 'the same name and level: the hitpoints say which');
    // what else those kills give: Hitpoints XP on every point of damage, with the level it takes you to. (A rock crab leaves nothing to bury.)
    const also = plan.locator('.tip.kills');
    assert.equal(flat(await also.innerText()), 'Also from these kills: +53,798.5 Hitpoints XP (level 54 → 57).');
    assert.match(await also.getAttribute('title'), /^Not part of the XP above\. Every point of damage gives 1\.33 Hitpoints XP as well, whatever your style;/);
    assert.equal(809 * 665, 537985);
    // the style is a choice on the goal. Controlled: 1.33 XP a point to each of Attack, Strength and Defence, so three times the kills and a few more
    const style = card.locator('select[data-opt="style"]');
    assert.deepEqual((await style.locator('option').allInnerTexts()).map(flat), ['Accurate', 'Controlled']);
    assert.match(await card.locator('label:has(select[data-opt="style"])').getAttribute('title'), /^Every point of damage gives XP by the style you fight in\. Accurate: 4 Attack XP\. Controlled: 1\.33 XP each to Attack, Strength and Defence\. Whatever the style, a point of damage is 1\.33 Hitpoints XP as well\./);
    await style.selectOption('controlled');
    await plan.locator('.step', { hasText: '2,432' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '2,432 × Rock Crab (level 13) +161,728 XP');
    assert.equal(flat(await fill.locator('option:checked').innerText()), 'Rock Crab (level 13, 50 HP, 66.5 XP)');
    assert.equal(flat(await also.innerText()), 'Also from these kills: +161,728 Strength XP (level 53 → 60), +161,728 Defence XP (level 52 → 60) and +161,728 Hitpoints XP (level 54 → 61).');
    assert.deepEqual((await goalOf('old_badger', 'attack')).opts, { style: 'controlled' });
    await style.selectOption('accurate');
    await plan.locator('.step', { hasText: '809' }).waitFor();
    assert.equal((await goalOf('old_badger', 'attack')).opts, undefined, 'the first of the list is how it starts: nothing to keep');
    // the table: a monster a row, its combat level and hitpoints, the XP of a kill and the kills to the goal. No money columns
    assert.deepEqual((await card.locator('.plan-t thead th').allInnerTexts()).map(flat), ['Lvl', 'Monster', 'HP', 'XP', 'To goal', 'Plan to kill']);
    assert.deepEqual(await card.locator('.plan-t thead th').evaluateAll(ths => ths.map(th => th.title).slice(0, 4)), ['Combat level', '', 'Hitpoints: a kill is this much damage', 'Attack XP a kill, in the style you picked']);
    assert.deepEqual((await card.locator('.bar .seg button').allInnerTexts()).map(flat), ['Level', 'XP each']);
    assert.match(flat(await card.locator('.plan-sec').last().locator('h4').innerText()), /^Every monster \(on its own, from level 51; click one to train on it\) Hide table$/);
    assert.equal(flat(await card.locator('.plan-sec').last().locator('.bar .small-note').last().innerText()),
      'Lvl = combat level · HP = hitpoints: a kill is that much damage · XP = what a kill gives in the style you picked · To goal = kills of it alone · Plan to kill = your mix of monsters.');
    // (a row's cells, shown or not: the search and the bands only hide rows)
    const cells = id => card.locator(`tr[data-method="${id}"]`).evaluate(tr => [...tr.cells].map(td => td.textContent.replace(/\s+/g, ' ').trim()));
    const tip = id => card.locator(`tr[data-method="${id}"]`).getAttribute('title');
    assert.deepEqual(await cells('at_rock_crab_13'), ['13', 'Rock Crab', '50', '200', '809', '']);
    assert.match(await card.locator('tr[data-method="at_rock_crab_13"]').getAttribute('class'), /\bhl\b/);
    assert.equal(await tip('at_rock_crab_13'), 'Rock Crab (level 13): 50 hitpoints, 200 Attack XP a kill\nA kill also gives 66.5 Hitpoints XP\nLeaves nothing to bury\n34 in the world.');
    assert.deepEqual(await cells('at_moss_giant_42'), ['42', 'Moss giant', '60', '240', '674', '']);
    assert.equal(await tip('at_moss_giant_42'), 'Moss giant (level 42): 60 hitpoints, 240 Attack XP a kill\nA kill also gives 79.8 Hitpoints XP\nLeaves Big bones: 15 Prayer XP if you bury them\n22 in the world.');
    assert.equal(await tip('at_lesser_demon_82'), 'Lesser demon (level 82): 79 hitpoints, 316 Attack XP a kill\nA kill also gives 105 Hitpoints XP\nLeaves nothing to bury\n34 in the world.');
    assert.equal(await tip('at_king_black_dragon_276'), 'King black dragon (level 276): 240 hitpoints, 960 Attack XP a kill\nA kill also gives 319.2 Hitpoints XP\nLeaves Dragon bones: 72 Prayer XP if you bury them\nOne of a kind.');
    // a monster with a catch is marked, and its row says what
    assert.deepEqual(await cells('at_loar_shade_40'), ['40', 'Loar Shade *', '38', '152', '1,064', '']);
    assert.match(await tip('at_loar_shade_40'), /\n25 in the world\.\nA Loar Shadow until you attack it, or it attacks you\.$/);
    assert.match(await tip('at_man_24'), /\nA citizen of Canifis: your first hit turns it into a Wolfman \(level 88, 100 hitpoints\), unless you wield a Wolfbane dagger\.$/);
    assert.match(await tip('at_black_knight_titan_120'), /^Black Knight Titan \(level 120\): 142 hitpoints, 142 Attack XP a kill\nA kill also gives 188\.8 Hitpoints XP\n.*\nOne of a kind\.\nThe server gives 1 XP a point of damage for it, whatever your style \(and Hitpoints XP as usual\)\.$/s);
    assert.equal(await card.locator('tr[data-method="at_battle_mage_54"]').count(), 0, 'only Magic works in the Mage Arena');
    // nothing to price and nothing banked: no tab on Prices or Bank
    await page.click('.tab[data-tab="prices"]');
    assert.equal(await page.locator('#prices-head [data-bskill="attack"], #prices-head [data-bskill="hitpoints"], #prices-head [data-bskill="ranged"]').count(), 0);
    await page.click('.tab[data-tab="bank"]');
    assert.equal(await page.locator('#bank-head [data-bskill="attack"], #bank-head [data-bskill="strength"], #bank-head [data-bskill="defence"]').count(), 0);
    await page.click('.tab[data-tab="goals"]');
    await page.screenshot({ path: `${SHOTS}/10t-combat.png`, fullPage: true });
  } finally {
    await removeGoal(card);
    await noGoalFor('Attack');
  }
});

await check('combat: a monster is found by its name or its combat level, or browsed by band; typing a search never redraws the plan; a mix is planned in kills', async () => {
  await planAs('old badger', 'Old Badger');
  await addGoal('attack', 60);
  const card = goalCard('Attack');
  try {
    await card.locator('.plan').waitFor();
    const plan = card.locator('.plan-sec', { hasText: /reach your goal/ });
    const shown = async () => (await card.locator('tr[data-method]:not([hidden])').evaluateAll(trs => trs.map(tr => `${tr.cells[1].innerText.trim()} ${tr.cells[0].innerText.trim()}`)));
    const heads = async () => (await card.locator('tr.grp:not([hidden])').allInnerTexts()).map(flat);
    const found = () => card.locator('[data-found]').innerText();
    const search = card.locator('[data-search]');
    // every monster is in the table; the band of the monster you train on is what shows
    assert.deepEqual((await card.locator('.group-pick .chip').allInnerTexts()).map(flat), ['Level 1–10', 'Level 11–20', 'Level 21–30', 'Level 31–50', 'Level 51–80', 'Level 81–110', 'Level 111 and up', 'All']);
    assert.equal(flat(await card.locator('.group-pick .chip.on').innerText()), 'Level 11–20');
    assert.deepEqual([await card.locator('tr[data-method]').count(), (await shown()).length, await heads()], [314, 48, ['Level 11–20']]);
    assert.equal(await search.getAttribute('placeholder'), 'Search monsters: a name, or a combat level');
    // part of a name: every band is searched, and each match sits under its band
    await card.evaluate(el => { el.mark = true; });
    await search.fill('giant');
    assert.deepEqual(await shown(), ['Giant spider 2', 'Giant rat 3', 'Giant rat 6', 'Blessed Giant rat 9', 'Giant bat 27', 'Giant spider 27', 'Giant 28', 'Moss giant 42', 'Ice giant 49', 'Fire giant 86']);
    assert.deepEqual(await heads(), ['Level 1–10', 'Level 21–30', 'Level 31–50', 'Level 81–110']);
    assert.equal(await found(), '10 found, whatever their level');
    assert.equal(await card.locator('.group-pick .chip.on').count(), 0, 'no band is the one shown while you search');
    // a name and a combat level, in any order and any case
    await search.fill('Skeleton 22');
    assert.deepEqual([await shown(), await found()], [['Skeleton 22'], '1 found, whatever their level']);
    await search.fill('28');
    assert.deepEqual(await shown(), ['Giant 28', 'Hobgoblin 28', 'Kalphite Worker 28', 'Pit Scorpion 28', 'Soldier 28', 'Terrorbird 28', 'Tower guard 28'], 'a number is a combat level');
    await search.fill('zzz');
    assert.deepEqual([await shown(), await heads(), await found()], [[], [], 'No monster matches that. Try part of its name, or its combat level.']);
    // typing is all on the page as it is: nothing was redrawn, so the box never loses a letter
    assert.equal(await card.evaluate(el => el.mark), true, 'the goal is the one that was there before the search');
    // a redraw (your XP read again) keeps what's typed and what's found
    await search.fill('fire g');
    assert.deepEqual(await shown(), ['Fire giant 86']);
    await page.evaluate(() => { document.querySelector('#goals-list').firstElementChild.mark = true; });
    await search.focus();
    await page.click('[data-act="refresh-xp"]');
    await page.waitForFunction(() => !document.querySelector('#goals-list').firstElementChild.mark, null, { timeout: 10000 });
    assert.deepEqual([await search.inputValue(), await shown(), await found()], ['fire g', ['Fire giant 86'], '1 found, whatever their level']);
    // click the monster found to train on it: the plan is in fire giants (111 hitpoints, 444 XP a kill), and it's your pick now
    await card.locator('tr[data-method="at_fire_giant_86"] td:nth-child(2)').click();
    await plan.locator('.step', { hasText: 'Fire giant' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '365 × Fire giant (level 86) +162,060 XP');
    assert.equal((await goalOf('old_badger', 'attack')).fillId, 'at_fire_giant_86');
    assert.equal(await plan.locator('.bar .small-note').count(), 0, 'your pick: nothing to say about how it was come by');
    assert.deepEqual([await search.inputValue(), await shown()], ['fire g', ['Fire giant 86']], 'the search stays as it was');
    // a band's button ends the search and shows the band
    await card.locator('[data-tgroup="Level 81–110"]').click();
    await card.locator('tr[data-method="at_lesser_demon_82"]:not([hidden])').waitFor();
    assert.deepEqual([await search.inputValue(), (await shown()).length, await heads(), await found()], ['', 30, ['Level 81–110'], '']);
    assert.equal(flat(await card.locator('.group-pick .chip.on').innerText()), 'Level 81–110');
    await card.locator('[data-tgroup="all"]').click();
    await card.locator('tr[data-method="at_chicken_1"]:not([hidden])').waitFor();
    assert.deepEqual([(await shown()).length, (await heads()).length], [314, 7]);
    // sorted by XP each, the most hitpoints come first
    await card.locator('[data-tsort-plan="xp"]').click();
    await page.waitForFunction(() => document.querySelector('.goal tr[data-method]')?.dataset.method === 'at_kalphite_queen_333');
    assert.deepEqual((await shown()).slice(0, 3), ['Kalphite Queen 333', 'King black dragon 276', 'Black dragon 227']);
    await card.locator('[data-tsort-plan="level"]').click();
    await page.waitForFunction(() => document.querySelector('.goal tr[data-method]')?.dataset.method === 'at_chicken_1');
    // picked from the list under Train with, too
    await card.locator('select[data-gopt="fill"]').selectOption('at_ice_giant_49');
    await plan.locator('.step', { hasText: 'Ice giant' }).waitFor();
    assert.equal(flat(await plan.locator('.step').innerText()), '578 × Ice giant (level 49) +161,840 XP');
    // what those kills give besides, and the bones they leave
    assert.equal(flat(await plan.locator('.tip.kills').innerText()), 'Also from these kills: +53,811.8 Hitpoints XP (level 54 → 57). They leave 578 Big bones: +8,670 Prayer XP if you bury them.');
    // a mix of monsters, typed under Plan to kill: 200 fire giants first, the rest on ice giants
    assert.match(flat(await card.locator('.plan-sec', { has: page.locator('h4', { hasText: /^Your mix/ }) }).innerText()), /^Your mix Plan a mix of monsters: type how many of each you'll kill in the table's Plan to kill column below\. Their XP counts toward your goal, and the rest is planned after them\.$/);
    await search.fill('fire giant');
    const box = card.locator('[data-mix="at_fire_giant_86"]');
    assert.deepEqual([await box.getAttribute('aria-label'), await box.getAttribute('title')], ['How many Fire giant (level 86) you plan to kill', 'How many you plan to kill']);
    await box.fill('200');
    await box.press('Enter');
    const mix = card.locator('.plan-sec', { hasText: 'Your mix +88,800 XP' });
    await mix.waitFor();
    assert.equal(flat(await mix.locator('.step').innerText()), '200 × Fire giant (level 86) +88,800 XP');
    assert.equal(flat(await mix.locator('.tip.kills').innerText()), 'Also from these kills: +29,520 Hitpoints XP (level 54 → 55). They leave 200 Big bones: +3,000 Prayer XP if you bury them.');
    assert.match(flat(await plan.locator('h4').innerText()), /^Then, to reach your goal: 72,897 XP$/);
    assert.equal(flat(await plan.locator('.step').innerText()), '261 × Ice giant (level 49) +73,080 XP');
    assert.deepEqual((await card.locator('.plan-t thead th').allInnerTexts()).map(flat), ['Lvl', 'Monster', 'HP', 'XP', 'To goal', 'Plan to kill', 'Still needed to goal']);
    assert.deepEqual([await search.inputValue(), await shown()], ['fire giant', ['Fire giant 86']], 'still searching after the redraw');
    await card.locator('[data-act="mix-clear"]').click();
    await card.locator('.plan-sec', { hasText: 'Plan a mix of monsters' }).waitFor();
  } finally {
    await removeGoal(card);
    await noGoalFor('Attack');
    await page.evaluate(() => { const ui = JSON.parse(localStorage.getItem('lchs.planUi') || '{}'); if (ui.tgroup) { delete ui.tgroup.attack; localStorage.setItem('lchs.planUi', JSON.stringify(ui)); } });
  }
});

await check('combat: Strength, Defence, Hitpoints and Ranged, each with its own styles; Hitpoints counts 1.33 XP a point whatever you fight with', async () => {
  await planAs('old badger', 'Old Badger');
  try {
    // Strength: Aggressive, or Controlled
    await addGoal('strength', 54);
    let card = goalCard('Strength');
    await card.locator('.plan').waitFor();
    assert.deepEqual((await card.locator('select[data-opt="style"] option').allInnerTexts()).map(flat), ['Aggressive', 'Controlled']);
    assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'st_rock_crab_13');
    assert.match(flat(await card.locator('.plan-opts').innerText()), /^A kill counts as the monster's hitpoints in damage, however many hits that takes\. Food, gear and drops aren't counted, so this plan doesn't use your bank or any prices\. Style Aggressive Controlled$/);
    assert.equal(await card.locator('tr[data-method]').count(), 314);
    await removeGoal(card);
    await noGoalFor('Strength');
    // Defence: Defensive, Controlled, or Ranged's Longrange (2 XP a point each to Ranged and Defence)
    await addGoal('defence', 60);
    card = goalCard('Defence');
    await card.locator('.plan').waitFor();
    const style = card.locator('select[data-opt="style"]');
    assert.deepEqual((await style.locator('option').allInnerTexts()).map(flat), ['Defensive', 'Controlled', 'Longrange (Ranged)']);
    const then = card.locator('.plan-sec', { hasText: 'To reach your goal' });
    assert.match(flat(await then.locator('h4').innerText()), /^To reach your goal: 149,982 XP$/);
    assert.equal(flat(await then.locator('.step').innerText()), '750 × Rock Crab (level 13) +150,000 XP');
    await style.selectOption('longrange');
    await then.locator('.step', { hasText: '1,500' }).waitFor();
    assert.equal(flat(await then.locator('.step').innerText()), '1,500 × Rock Crab (level 13) +150,000 XP');
    assert.equal(flat(await then.locator('.tip.kills').innerText()), 'Also from these kills: +150,000 Ranged XP (level 55 → 61) and +99,750 Hitpoints XP (level 54 → 59).');
    assert.match(flat(await card.locator('.plan-opts').innerText()), /Food, gear, ammunition and drops aren't counted/);
    assert.equal(await card.locator('tr[data-method="df_rock_crab_13"]').getAttribute('title'), 'Rock Crab (level 13): 50 hitpoints, 100 Defence XP a kill\nA kill also gives 100 Ranged XP and 66.5 Hitpoints XP\nLeaves nothing to bury\n34 in the world.');
    await removeGoal(card);
    await noGoalFor('Defence');
    // Ranged: Accurate or Rapid (4 XP a point), or Longrange
    await addGoal('ranged', 60);
    card = goalCard('Ranged');
    await card.locator('.plan').waitFor();
    assert.deepEqual((await card.locator('select[data-opt="style"] option').allInnerTexts()).map(flat), ['Accurate or Rapid', 'Longrange']);
    assert.match(flat(await card.locator('.plan-opts').innerText()), /Ammunition, food, gear and drops aren't counted/);
    assert.equal(flat(await card.locator('select[data-gopt="fill"] option:checked').innerText()), 'Rock Crab (level 13, 50 HP, 200 XP)');
    await removeGoal(card);
    await noGoalFor('Ranged');
    // Hitpoints: no style to pick. 1.33 XP a point of damage: a rock crab's 50 hitpoints are 66.5 XP, a moss giant's 60 are 79.8.
    // The battle mages of the Mage Arena are here and nowhere else: only Magic can hit them
    await addGoal('hitpoints', 60);
    card = goalCard('Hitpoints');
    await card.locator('.plan').waitFor();
    assert.equal(await card.locator('select[data-opt="style"]').count(), 0);
    assert.match(flat(await card.locator('.plan-opts').innerText()), /Food, gear, ammunition, runes and drops aren't counted, so this plan doesn't use your bank or any prices\.$/);
    assert.equal(flat(await card.locator('select[data-gopt="fill"] option:checked').innerText()), 'Rock Crab (level 13, 50 HP, 66.5 XP)');
    assert.equal(await card.locator('tr[data-method]').count(), 315);
    const hp = card.locator('.plan-sec', { hasText: 'To reach your goal' });
    assert.match(flat(await hp.locator('h4').innerText()), /^To reach your goal: 122,770 XP$/);
    assert.equal(flat(await hp.locator('.step').innerText()), '1,847 × Rock Crab (level 13) +122,825.5 XP');
    assert.equal(await hp.locator('.tip.kills').count(), 0, 'no other skill is said to gain (that depends on how you fight), and a rock crab leaves nothing');
    await card.locator('select[data-gopt="fill"]').selectOption('hp_moss_giant_42');
    await hp.locator('.step', { hasText: 'Moss giant' }).waitFor();
    assert.equal(flat(await hp.locator('.step').innerText()), '1,539 × Moss giant (level 42) +122,812.2 XP');
    assert.equal(flat(await hp.locator('.tip.kills').innerText()), 'These kills leave 1,539 Big bones: +23,085 Prayer XP if you bury them.');
    await card.locator('[data-search]').fill('battle');
    assert.deepEqual(await card.locator('tr[data-method]:not([hidden])').evaluateAll(trs => trs.map(tr => [...tr.cells].slice(0, 4).map(td => td.innerText.replace(/\s+/g, ' ').trim()))), [['54', 'Battle mage *', '120', '159.6']]);
    assert.match(await card.locator('tr[data-method="hp_battle_mage_54"]').getAttribute('title'), /\nIn the Mage Arena, once you've beaten Kolodion there\. He allows only magical combat within it: no melee, no Ranged\.$/);
  } finally {
    for (const name of ['Strength', 'Defence', 'Ranged', 'Hitpoints']) { await removeGoal(goalCard(name)); await noGoalFor(name); }
  }
});

await check("goals: Combat level is a goal like a skill's: picked with the first button, before Attack, with a level to reach; its card has its progress and is moved, changed and removed like any goal; its Plan (Calculator) is the full calculator, starting from your goals, with what-ifs that change none of them; nothing shows by itself; a combat skill's goals come with it; each combat plan keeps its tip (v2.10.2). Its plan says first what each kind of level takes to reach it from your levels now, or from a what-if, which stays with the goal until reset; the tips are one line; the two rows of buttons have titles (v2.10.3)", async () => {
  const combat = () => page.locator('.goal.combat-goal');
  const live = () => combat().locator('.gc-live');
  const tipOf = async name => flat(await goalCard(name).locator('.tip.combat').innerText());
  const names = async () => (await page.locator('.goal .goal-name').allInnerTexts()).map(flat);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('lchs.goals.old_badger') || '[]'));
  const addCombat = async level => {
    await page.click('#goal-new [data-nskill="combat"]');
    await page.fill('#goal-new input[name=value]', String(level));
    await page.click('#goal-new button[type=submit]');
  };
  await planAs('old badger', 'Old Badger');
  const saved = await page.evaluate(() => localStorage.getItem('lchs.goals.old_badger'));
  try {
    // Old Badger: Attack 51, Strength 53, Defence 52, Hitpoints 54, Ranged 55, Prayer 56, Magic 50: combat 67.3
    assert.deepEqual(JSON.parse(saved || '[]').filter(g => ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer', 'magic', 'combat'].includes(g.skill)), [], 'no goal of an earlier check is left in a combat skill');
    // goals in combat skills bring no card of their own anymore (up to v2.10.1 one came before the first of them)
    await addGoal('cooking', 60);
    await goalCard('Cooking').waitFor();
    await addGoal('attack', 60);
    await goalCard('Attack').waitFor();
    assert.equal(await page.locator('#goals-combat, [data-combat], .combat-goal, .gc-live, [data-gcalc], [data-act="combat-toggle"]').count(), 0, 'nothing about the combat level by itself');
    assert.deepEqual(await names(), ['Cooking', 'Attack']);
    // the goal's own plan still says what it adds: 9 Attack levels are 2.925, and the 3 Hitpoints levels its 809 rock crabs give, 0.75
    // (one line: how much this goal adds, 2.925 for its Attack and 0.75 for its kills' Hitpoints; the how is in its tooltip, v2.10.3)
    assert.equal(await tipOf('Attack'), 'Combat level: this goal adds +3.68 (67 → 70).');
    assert.match(await goalCard('Attack').locator('.tip.combat').getAttribute('title'), /^Counted from your levels now: Attack 51 → 60, and what its kills give besides: Hitpoints 54 → 57\. Your combat level is a quarter of Defence \+ Hitpoints \+ half your Prayer, plus 0\.325 of the best of Attack \+ Strength,.* Bones aren't counted\. A Combat level goal \(the first of the buttons a goal is picked with\) combines all your goals, and its calculator lets you try other levels\.$/);
    assert.equal(await goalCard('Attack').locator('.plan > .tip.combat + .plan-sec table.plan-t').count(), 1, "under the plan's own lines, above the table");
    assert.equal(await goalCard('Attack').locator('[data-topt]').count(), 0, 'no Hide unused items where there are no Use boxes');
    // the two rows of buttons say what they're for: setting a goal, and the goals set (v2.10.3)
    assert.equal(flat(await page.locator('#goal-new .row-title').innerText()), 'Set a goal Pick a skill or your combat level, then what to reach. Each goal gets its own Plan (Calculator).');
    assert.equal(flat(await page.locator('#goals-list > .goals-title').innerText()), 'Your goals');
    assert.equal(await page.locator('#goals-list > .goals-title + .goal-filter + .goal-links').count(), 1);

    // it's picked like a skill: the first of the buttons, before Attack
    const picker = await page.locator('#goal-new [data-nskill]').evaluateAll(els => els.map(el => [el.dataset.nskill, el.title]));
    assert.deepEqual(picker.slice(0, 3), [['combat', 'Combat level'], ['attack', 'Attack'], ['defence', 'Defence']]);
    assert.equal(await page.locator('#goal-new [data-nskill="combat"] .ico-combat').count(), 1, 'the crossed swords');
    await page.click('#goal-new [data-nskill="combat"]');
    await page.waitForSelector('#goal-new [data-nskill="combat"].on');
    assert.equal(await page.locator('#goal-new [data-nskill].on').count(), 1);
    // a level is the only kind of goal it has; the next one is suggested, and what your goals already come to is said
    assert.equal(flat(await page.locator('#goal-new form').innerText()), 'Combat level Level Add goal Now: level 67 · your skill goals reach 70');
    assert.equal(await page.locator('#goal-new [data-ntype]').count(), 0, 'no XP, Rank or Top %');
    assert.deepEqual([await page.inputValue('#goal-new input[name=value]'), await page.locator('#goal-new input[name=value]').getAttribute('placeholder')], ['68', 'Level (up to 126)']);
    for (const [typed, says] of [['67', 'Old Badger is already combat level 67.'], ['127', 'Combat level goals go from 4 to 126.'], ['x', 'Enter a number for the goal.']]) {
      await page.fill('#goal-new input[name=value]', typed);
      await page.click('#goal-new button[type=submit]');
      assert.equal(flat(await text('#goals-msg')), says);
      assert.equal(await combat().count(), 0);
    }
    await addCombat(72);
    await combat().waitFor();
    assert.equal(await page.locator('#goals-msg').isHidden(), true);
    // a goal among the goals: where a new one goes, with a goal's buttons and its progress since it was set
    assert.deepEqual(await names(), ['Cooking', 'Attack', 'Combat level']);
    assert.equal(await combat().locator('.goal-head .ico-combat').count(), 1);
    assert.equal(flat(await combat().locator('.goal-head').innerText()), 'Combat level Level 67 → 72 Edit Hide Plan (Calculator) ▲ ▼ ✕');
    assert.equal(flat(await combat().locator('.goal-sub').innerText()), 'Level 67 now · 5 levels to go · your skill goals reach 70 (Attack 60, Hitpoints 57 from their kills): 2 more to find');
    assert.equal(await combat().locator('.goal-bar').getAttribute('title'), '0.0% of the way since you set this goal');
    const mine = (await stored()).at(-1);
    assert.deepEqual([mine.skill, mine.type, mine.value, Math.round(mine.startCb * 1000)], ['combat', 'level', 72, 67300], 'kept with the other goals; its bar starts from 67.3');
    // the first button stays picked, like a skill's, and suggests the same again
    assert.equal(await page.locator('#goal-new [data-nskill="combat"].on').count(), 1);

    // its Plan (Calculator), open as a new goal's is. First what the goal takes, from the levels now (not after the other goals),
    // kind by kind and each enough by itself: Attack or Strength, Defence or Hitpoints (levels shared between the two), Prayer, Ranged, Magic (v2.10.3)
    const lines = async () => (await live().locator('.cc-line').allInnerTexts()).map(flat);
    const needsHead = async () => flat(await combat().locator('.gc-needs .cc-goal-head').innerText());
    const needs = async () => (await combat().locator('.gc-needs .need').allInnerTexts()).map(flat);
    assert.equal(await combat().locator('.combat-plan > .gc-needs + .gc-live').count(), 1, 'above the calculator');
    assert.equal(await needsHead(), 'To reach 72 from your levels now (67.30), any one of these:');
    // (4.7 more: 15 Attack or Strength levels at 0.325, 19 Defence or Hitpoints at a quarter, Ranged or Magic to 80 to pass melee, Prayer to 94)
    assert.deepEqual(await needs(), ['Attack 66 or Strength 68 +15', 'Defence 71 or Hitpoints 73 +19', 'Ranged 80 +25', 'Magic 80 +30', 'Prayer 94 +38']);
    assert.equal(flat(await combat().locator('.gc-needs > .cc-goal > .cc-line').innerText()), 'Each is enough by itself. Levels from more than one add up too.');
    assert.equal(await combat().locator('.gc-needs .need').first().getAttribute('title'),
      "Attack and Strength count the same (melee, 0.325 of a combat level a level while it's your best style): 15 more levels between them, like Attack 51 → 66 or Strength 53 → 68.");
    assert.deepEqual(await page.evaluate(async () => (await import('./skills.js')).combatNeeds({ attack: 51, strength: 53, defence: 52, hitpoints: 54, ranged: 55, prayer: 56, magic: 50 }, 72)),
      { melee: 15, base: 19, prayer: 38, ranged: 25, magic: 30 });
    // then the calculator, from your goals: how the level is made up and how it compares to the goal, with nothing about the level after it
    assert.equal(flat(await live().locator('.cc-head').innerText()), "Combat level once your goals are reached 70 +3 from Old Badger's 67");
    assert.deepEqual(await lines(), ['Base: ¼ × (Defence 52 + Hitpoints 57 + half of Prayer 56 = 28) = 34.25',
      'Plus the best of: Melee 0.325 × (Attack 60 + Strength 53) = 36.725 · Ranged 0.325 × (55 + half 27) = 26.65 · Magic 0.325 × (50 + half 25) = 24.375',
      '= 70.975, rounded down to 70: 2 short of your goal of 72.']);
    assert.equal(await live().locator('.cc-next, .need').count(), 0, 'no "any one of these gets" the next level');
    // the boxes start from your goals: Attack 60 is the Attack goal's, Hitpoints 57 what its kills give
    const boxes = () => combat().locator('[data-gcalc]').evaluateAll(els => els.map(el => [el.dataset.gcalc, el.value]));
    assert.deepEqual(await boxes(), [['attack', '60'], ['strength', '53'], ['defence', '52'], ['hitpoints', '57'], ['ranged', '55'], ['prayer', '56'], ['magic', '50']]);
    assert.equal(flat(await combat().locator('.calc .small-note').innerText()), "Combat calculator: it starts from Old Badger's levels, with your goals reached and what their kills give besides. Type a level to try it: that changes none of your goals, and it stays (with this goal) until you reset it.");
    const reset = () => combat().locator('[data-act="combat-reset"]');
    assert.equal(await reset().isDisabled(), true);
    assert.equal(flat(await reset().innerText()), 'Reset to your goals');
    // type a level to try it: the calculator follows as you type, the box keeps the cursor, and no goal changes (the what-if is kept with this one)
    const goalsBefore = JSON.stringify(await stored());
    await combat().locator('[data-gcalc="defence"]').fill('70');
    await page.waitForFunction(() => /What-if/.test(document.querySelector('.combat-goal .gc-live').innerText));
    assert.equal(flat(await live().locator('.cc-head').innerText()), "What-if combat level 75 +8 from Old Badger's 67");
    assert.equal((await lines())[2], "= 75.475, rounded down to 75: that's your goal of 72 and more.");
    // (what the goal takes now goes by the what-if: these levels are enough)
    assert.equal(flat(await combat().locator('.gc-needs').innerText()), 'Your what-if levels reach 72 (75).');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.gcalc), 'defence');
    assert.equal(await reset().isDisabled(), false);
    const afterTyping = await stored();
    assert.deepEqual(afterTyping.find(g => g.skill === 'combat').what, { defence: 70 }, 'kept with the goal');
    assert.equal(JSON.stringify(afterTyping.map(({ what, ...g }) => g)), JSON.stringify(JSON.parse(goalsBefore).map(({ what, ...g }) => g)), 'a what-if is not a goal: no other goal changes, and no Defence goal appears');
    assert.deepEqual(await names(), ['Cooking', 'Attack', 'Combat level']);
    assert.equal(flat(await combat().locator('.goal-sub').innerText()), 'Level 67 now · 5 levels to go · your skill goals reach 70 (Attack 60, Hitpoints 57 from their kills): 2 more to find', "the card's own line stays your goals'");
    // an Attack goal's level typed over, too: the goal keeps its own
    await combat().locator('[data-gcalc="attack"]').fill('99');
    await page.waitForFunction(() => /What-if combat level\s+88\b/.test(document.querySelector('.combat-goal .gc-live').innerText));
    assert.equal(flat(await goalCard('Attack').locator('.goal-title').innerText()), 'Level 51 → 60');
    await combat().locator('[data-gcalc="attack"]').fill('60');
    // typed back to what it started from, there's nothing to reset
    await combat().locator('[data-gcalc="defence"]').fill('52');
    await page.waitForFunction(() => !/What-if/.test(document.querySelector('.combat-goal .gc-live').innerText));
    assert.equal(await reset().isDisabled(), true);
    // it is Lookup's card: with the levels the hiscores have typed in, the same sums
    await combat().locator('[data-gcalc="attack"]').fill('51');
    await combat().locator('[data-gcalc="hitpoints"]').fill('54');
    await page.waitForFunction(() => /67\.30/.test(document.querySelector('.combat-goal .gc-live').innerText));
    assert.equal(flat(await live().locator('.cc-head').innerText()), "What-if combat level 67 +0 from Old Badger's 67");
    const here = await lines();
    assert.equal(here[2], '= 67.30, rounded down to 67: 5 short of your goal of 72.');
    assert.equal(await needsHead(), 'To reach 72 from your what-if levels (67.30), any one of these:');
    assert.deepEqual(await needs(), ['Attack 66 or Strength 68 +15', 'Defence 71 or Hitpoints 73 +19', 'Ranged 80 +25', 'Magic 80 +30', 'Prayer 94 +38']);
    await page.click('.tab[data-tab="lookup"]');
    await page.fill('#lookup-name', 'old badger');
    await page.click('#lookup-form button');
    await page.waitForFunction(() => document.querySelector('.pc-name')?.innerText.includes('Old Badger'), null, { timeout: 15000 });
    await page.click('#filter-seg [data-filter="combat"]');
    await page.waitForFunction(() => /67\.30/.test(document.querySelector('#cc-live')?.innerText || ''));
    const lookup = (await page.locator('#cc-live .cc-line').allInnerTexts()).map(flat);
    // (Lookup's has no goal to be short of: it says what gets the next level, as it always did)
    assert.equal(lookup[2], '= 67.30, rounded down to 67. Any one of these gets 68:');
    assert.deepEqual((await page.locator('#cc-live .cc-next .need').allInnerTexts()).map(flat), ['Attack +3', 'Strength +3', 'Defence +3', 'Hitpoints +3', 'Prayer +6', 'Ranged +17', 'Magic +22']);
    await page.click('#filter-seg [data-filter="all"]');
    await page.click('.tab[data-tab="goals"]');
    await live().waitFor();
    assert.deepEqual(here.slice(0, 2), lookup.slice(0, 2));
    // a level out of range is brought back into it when you leave the box
    await combat().locator('[data-gcalc="defence"]').fill('70');
    await combat().locator('[data-gcalc="prayer"]').fill('150');
    await combat().locator('[data-gcalc="prayer"]').press('Tab');
    assert.equal(await combat().locator('[data-gcalc="prayer"]').inputValue(), '99');
    // what's typed stays through a redraw, and with the plan shut and opened again
    await combat().evaluate(el => { el.mark = true; });
    await page.click('[data-act="refresh-xp"]');
    await page.waitForFunction(() => { const el = document.querySelector('.goal.combat-goal'); return el && !el.mark; }, null, { timeout: 10000 });
    const typedNow = async () => Object.fromEntries((await boxes()).filter(([k]) => ['defence', 'prayer', 'attack'].includes(k)));
    assert.deepEqual(await typedNow(), { attack: '51', defence: '70', prayer: '99' });
    await combat().locator('[data-act="toggle-plan"]').click();
    await page.waitForFunction(() => !document.querySelector('.combat-goal .gc-live'));
    assert.equal(flat(await combat().locator('[data-act="toggle-plan"]').innerText()), 'Plan (Calculator)');
    await combat().locator('[data-act="toggle-plan"]').click();
    await live().waitFor();
    assert.deepEqual(await typedNow(), { attack: '51', defence: '70', prayer: '99' });
    // and through a reload: it sticks until it's reset (v2.10.3)
    assert.deepEqual((await stored()).find(g => g.skill === 'combat').what, { attack: 51, hitpoints: 54, defence: 70, prayer: 99 });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#plan-account')?.innerText.includes('XP from the hiscores'), null, { timeout: 15000 });
    await live().waitFor();
    assert.deepEqual(await typedNow(), { attack: '51', defence: '70', prayer: '99' });
    assert.match(flat(await live().locator('.cc-head').innerText()), /^What-if combat level /);
    // Reset puts back your goals' values
    await reset().click();
    await page.waitForFunction(() => !/What-if/.test(document.querySelector('.combat-goal .gc-live').innerText));
    assert.equal((await stored()).find(g => g.skill === 'combat').what, undefined);
    assert.equal(await needsHead(), 'To reach 72 from your levels now (67.30), any one of these:');
    assert.deepEqual(await boxes(), [['attack', '60'], ['strength', '53'], ['defence', '52'], ['hitpoints', '57'], ['ranged', '55'], ['prayer', '56'], ['magic', '50']]);
    assert.equal(flat(await live().locator('.cc-head').innerText()), "Combat level once your goals are reached 70 +3 from Old Badger's 67");
    assert.equal(await reset().isDisabled(), true);
    // a goal changed or added shows in it at once: a Prayer goal of 60 is two more halves of a quarter
    await addGoal('prayer', 60);
    await goalCard('Prayer').waitFor();
    assert.equal(await tipOf('Prayer'), 'Combat level: this goal adds +0.5.');
    assert.deepEqual((await boxes()).find(([k]) => k === 'prayer'), ['prayer', '60']);
    assert.equal(flat(await combat().locator('.goal-sub').innerText()), 'Level 67 now · 5 levels to go · your skill goals reach 71 (Attack 60, Hitpoints 57 from their kills, Prayer 60): 1 more to find');
    assert.equal((await lines())[2], '= 71.475, rounded down to 71: 1 short of your goal of 72.');
    assert.equal(await needsHead(), 'To reach 72 from your levels now (67.30), any one of these:', 'still from the levels now, whatever the other goals');
    await combat().evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `${SHOTS}/10u-combat-goal.png`, fullPage: false });
    await removeGoal(goalCard('Prayer'));
    await noGoalFor('Prayer');

    // narrowed to one skill: a combat skill's goals come with it, a skill that has nothing to do with combat leaves it out
    assert.deepEqual(await page.$$eval('.goal-filter [data-gonly]', els => els.map(e => [e.dataset.gonly, e.title])),
      [['cooking', 'Only Cooking'], ['attack', 'Only Attack, with your Combat level goal'], ['combat', 'Only Combat level']]);
    await page.click('[data-gonly="attack"]');
    await page.waitForFunction(() => document.querySelectorAll('.goal').length === 2);
    assert.deepEqual(await names(), ['Attack', 'Combat level']);
    await page.click('[data-gonly="attack"]');
    await page.click('[data-gonly="cooking"]');
    await page.waitForFunction(() => document.querySelectorAll('.goal').length === 1);
    assert.deepEqual(await names(), ['Cooking']);
    await page.click('[data-gonly="cooking"]');
    await page.click('[data-gonly="combat"]');
    await page.waitForFunction(() => document.querySelectorAll('.goal').length === 1);
    assert.deepEqual(await names(), ['Combat level']);
    await page.click('[data-gonly="combat"]');
    await page.waitForFunction(() => document.querySelectorAll('.goal').length === 3);
    // moved like any goal, and it stays where it's put
    await combat().locator('[data-act="goal-up"]').click();
    assert.deepEqual(await names(), ['Cooking', 'Combat level', 'Attack']);
    assert.deepEqual((await stored()).map(g => g.skill), ['cooking', 'combat', 'attack']);
    await combat().locator('[data-act="goal-up"]').click();
    assert.deepEqual(await names(), ['Combat level', 'Cooking', 'Attack']);
    assert.equal(await combat().locator('[data-act="goal-up"]').isDisabled(), true);
    await combat().locator('[data-act="goal-down"]').click();
    await combat().locator('[data-act="goal-down"]').click();
    assert.deepEqual(await names(), ['Cooking', 'Attack', 'Combat level']);
    // changed like any goal: Edit moves the goalpost, a level being all it can be
    await combat().locator('[data-act="edit-goal"]').click();
    const edit = combat().locator('[data-form="edit-goal"]');
    await edit.waitFor();
    assert.equal(flat(await edit.innerText()), 'Change this goal to Level Save Cancel Its progress stays as it is, and so does what you typed into its calculator.');
    assert.equal(await edit.locator('[data-etype]').count(), 0);
    assert.equal(await edit.locator('[name=value]').inputValue(), '72');
    await edit.locator('[name=value]').fill('60');
    await edit.locator('[name=value]').press('Enter');
    assert.equal(flat(await combat().locator('[data-form="edit-goal"] .c-lose').innerText()), 'Old Badger is already combat level 67.');
    await combat().locator('[data-form="edit-goal"] [name=value]').fill('70');
    await combat().locator('[data-form="edit-goal"] [name=value]').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.combat-goal [data-form="edit-goal"]'));
    assert.equal(flat(await combat().locator('.goal-title').innerText()), 'Level 67 → 70');
    assert.equal(flat(await combat().locator('.goal-sub').innerText()), "Level 67 now · 3 levels to go · your skill goals reach 70 (Attack 60, Hitpoints 57 from their kills): that's this goal");
    assert.equal((await lines())[2], "= 70.975, rounded down to 70: that's your goal of 70.");
    assert.equal(await needsHead(), 'To reach 70 from your levels now (67.30), any one of these:');
    assert.deepEqual(await needs(), ['Attack 60 or Strength 62 +9', 'Defence 63 or Hitpoints 65 +11', 'Ranged 76 +21', 'Prayer 78 +22', 'Magic 76 +26']);
    // Hide all plans and Show all plans take it along with the others
    await page.click('[data-act="close-all"]');
    await page.waitForFunction(() => !document.querySelector('.gc-live') && !document.querySelector('.goal .plan'));
    assert.equal(flat(await combat().innerText()), "Combat level Level 67 → 70 Edit Plan (Calculator) ▲ ▼ ✕ Level 67 now · 3 levels to go · your skill goals reach 70 (Attack 60, Hitpoints 57 from their kills): that's this goal");
    assert.equal(await page.locator('[data-gcalc]').count(), 0, 'the calculator is its plan: shut with it');
    await page.click('[data-act="open-all"]');
    await live().waitFor();
    await goalCard('Attack').locator('.plan').waitFor();
    // two of them: each has its own target and its own what-ifs
    await addCombat(80);
    await page.waitForFunction(() => document.querySelectorAll('.goal.combat-goal').length === 2);
    await combat().first().locator('[data-gcalc="strength"]').fill('99');
    await page.waitForFunction(() => /What-if/.test(document.querySelector('.combat-goal .gc-live').innerText));
    assert.deepEqual(await combat().evaluateAll(cards => cards.map(c => [c.querySelector('.goal-title').innerText.replace(/\s+/g, ' ').trim(), c.querySelector('[data-gcalc="strength"]').value, /What-if/.test(c.querySelector('.gc-live').innerText)])),
      [['Level 67 → 70', '99', true], ['Level 67 → 80', '53', false]]);
    assert.equal(flat(await combat().nth(1).locator('.gc-live .cc-line').last().innerText()), '= 70.975, rounded down to 70: 10 short of your goal of 80.');
    // (each by its own levels: the first's what-if is enough for its 70; the second goes from the levels now, and Defence and Hitpoints would both pass 99 alone)
    assert.equal(flat(await combat().first().locator('.gc-needs').innerText()), 'Your what-if levels reach 70 (85).');
    assert.deepEqual((await combat().nth(1).locator('.gc-needs .need').allInnerTexts()).map(flat), ['Attack 91 or Strength 93 +40', 'Ranged 96 +41', 'Magic 96 +46', 'Defence and Hitpoints +51']);
    // (a kind that can't get there alone is said, and why: Prayer even at 99 is short)
    assert.equal(flat(await combat().nth(1).locator('.gc-needs .cc-line').innerText()), 'Each is enough by itself. Levels from more than one add up too. Not enough alone, even at 99: Prayer.');
    // a what-if with melee ahead: Attack is at 99, so its levels go to Strength; Ranged and Magic at 99 would stay behind melee
    for (const [k, v] of [['attack', '99'], ['strength', '50'], ['defence', '1']]) await combat().nth(1).locator(`[data-gcalc="${k}"]`).fill(v);
    await page.waitForFunction(() => /what-if/.test(document.querySelectorAll('.combat-goal')[1].querySelector('.gc-needs').innerText));
    assert.equal(flat(await combat().nth(1).locator('.gc-needs .cc-goal-head').innerText()), 'To reach 80 from your what-if levels (69.925), any one of these:');
    assert.deepEqual((await combat().nth(1).locator('.gc-needs .need').allInnerTexts()).map(flat), ['Strength 81 +31', 'Defence 42 or Hitpoints 98 +41']);
    assert.equal(flat(await combat().nth(1).locator('.gc-needs .cc-line').innerText()), "Each is enough by itself. Levels from more than one add up too. Ranged and Magic don't count here: even at 99 they'd stay behind your melee. Not enough alone, even at 99: Prayer.");
    assert.equal(await combat().nth(1).locator('.gc-needs .need').first().getAttribute('title'), 'Attack and Strength count the same (melee, 0.325 of a combat level a level while it\'s your best style): 31 more levels between them, like Strength 50 → 81 (Attack stops at 99).');
    await combat().nth(1).locator('[data-act="combat-reset"]').click();
    await page.waitForFunction(() => /from your levels now/.test(document.querySelectorAll('.combat-goal')[1].querySelector('.gc-needs').innerText));
    assert.deepEqual((await combat().nth(1).locator('.gc-needs .need').allInnerTexts()).map(flat), ['Attack 91 or Strength 93 +40', 'Ranged 96 +41', 'Magic 96 +46', 'Defence and Hitpoints +51']);
    // removed like any goal (and what was typed into it goes with it)
    await removeGoal(combat().nth(1));
    await page.waitForFunction(() => document.querySelectorAll('.goal.combat-goal').length === 1);
    await removeGoal(combat());
    await noGoalFor('Combat level');
    assert.equal(await page.locator('.combat-goal, .gc-live, [data-gcalc]').count(), 0);
    assert.deepEqual((await stored()).map(g => g.skill), ['cooking', 'attack']);

    // a goal that's reached: said like a skill's, and counted with the reached ones
    await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('lchs.goals.old_badger'));
      list.push({ id: 'gcbdone', skill: 'combat', type: 'level', value: 60, created: Date.now(), startCb: 50 });
      localStorage.setItem('lchs.goals.old_badger', JSON.stringify(list));
    });
    await page.click('.tab[data-tab="bank"]');
    await page.click('.tab[data-tab="goals"]');
    await combat().waitFor();
    assert.equal(flat(await combat().locator('.goal-sub').innerText()), 'Reached · level 67');
    assert.match(await combat().locator('.goal-bar').getAttribute('class'), /\bmaxed\b/);
    assert.match(flat(await page.locator('.goal-filter [data-gshow="done"]').innerText()), /^Reached 1$/);
    await combat().locator('[data-act="toggle-plan"]').click();
    await live().waitFor();
    assert.equal(flat(await live().locator('.cc-line').last().innerText()), "= 70.975, rounded down to 70: that's your goal of 60 and more.");
    assert.equal(flat(await combat().locator('.gc-needs').innerText()), 'Your levels now already reach 60 (67).');
    // the goals' own buttons follow In progress and Reached: a skill shows only with a goal among those (v2.10.3)
    const icons = () => page.$$eval('.goal-filter [data-gonly]', els => els.map(e => e.dataset.gonly));
    assert.deepEqual(await icons(), ['cooking', 'attack', 'combat']);
    await page.click('[data-gshow="active"]');
    await page.waitForFunction(() => document.querySelectorAll('.goal').length === 2);
    assert.deepEqual(await icons(), ['cooking', 'attack'], 'the reached Combat level goal has no button under In progress');
    await page.click('[data-gonly="attack"]');
    await page.waitForFunction(() => document.querySelectorAll('.goal').length === 1);
    await page.click('[data-gshow="done"]');
    await page.waitForFunction(() => document.querySelectorAll('.goal').length === 1 && document.querySelector('.goal.combat-goal'));
    assert.deepEqual(await icons(), [], 'one skill among the reached: no buttons, and Only Attack is let go of');
    await page.click('[data-gshow="all"]');
    await page.waitForFunction(() => document.querySelectorAll('.goal').length === 3);
    assert.deepEqual(await icons(), ['cooking', 'attack', 'combat']);
    assert.equal(await page.locator('[data-gonly].on').count(), 0);
    await removeGoal(combat());
    await noGoalFor('Combat level');

    await removeGoal(goalCard('Attack'));
    await noGoalFor('Attack');
    await removeGoal(goalCard('Cooking'));
    await noGoalFor('Cooking');
    // an account with combat skills off the hiscores: a range, and the card and its calculator say why
    await planAs('lowbie', 'Lowbie');
    const lowSaved = await page.evaluate(() => localStorage.getItem('lchs.goals.lowbie'));
    try {
      await addGoal('attack', 30);
      await goalCard('Attack').waitFor();
      assert.match(await tipOf('Attack'), /^Combat level: this goal adds (\+[\d.]+( \(at least \d+ → \d+\))?|nothing)\.$/);
      await page.click('#goal-new [data-nskill="combat"]');
      assert.match(flat(await page.locator('#goal-new form').innerText()), /^Combat level Level Add goal Now: level \d+–\d+( · your skill goals reach \d+)?$/);
      await page.click('#goal-new button[type=submit]');
      await combat().waitFor();
      assert.match(flat(await combat().locator('.goal-title').innerText()), /^Level \d+–\d+ → \d+$/);
      assert.match(flat(await combat().locator('.goal-sub').innerText()), /^Level \d+–\d+ now · \d+ levels? to go · .*\(some combat skills are below 15, so their lowest possible levels are used\)$/);
      assert.match(flat(await live().innerText()), /Some combat skills are below 15, so they're not on the hiscores\. Their lowest possible levels are used below, and you can change them in the calculator\./);
    } finally {
      await page.evaluate(v => (v == null ? localStorage.removeItem('lchs.goals.lowbie') : localStorage.setItem('lchs.goals.lowbie', v)), lowSaved);
    }
  } finally {
    await planAs('old badger', 'Old Badger');
    await page.evaluate(v => (v == null ? localStorage.removeItem('lchs.goals.old_badger') : localStorage.setItem('lchs.goals.old_badger', v)), saved);
    await planAs('demo main', 'Demo Main');
    // (the button a new goal's skill is picked with: back on a skill)
    await page.click('#goal-new [data-nskill="herblore"]');
  }
});

await check('goals: every skill has its planner: no dot on the skill picker, and nothing said about skills to come', async () => {
  await page.click('.tab[data-tab="goals"]');
  assert.equal(await page.locator('.calc-dot').count(), 0);
  // every skill's button is its name, and its goal gets a plan
  const picker = await page.locator('#goal-new [data-nskill]').evaluateAll(els => els.map(el => [el.dataset.nskill, el.title, el.getAttribute('aria-label'), el.children.length]));
  // (the combat level first, which is a goal too, then the 19 skills)
  assert.equal(picker.length, 20);
  for (const [key, title, label, kids] of picker) assert.deepEqual([title, kids, /\(planner\)/.test(title)], [label, 1, false], key);
  assert.deepEqual(picker.map(p => p[1]), ['Combat level', 'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining',
    'Herblore', 'Agility', 'Thieving', 'Runecraft']);
  const mod = await page.evaluate(async () => { const m = await import('./planner-ui.js'); const s = await import('./skills.js'); return s.SKILLS.filter(x => x.id).map(x => [x.key, m.hasCalculator(x.key)]); });
  assert.ok(mod.length === 19 && mod.every(([, has]) => has), JSON.stringify(mod.filter(([, has]) => !has)));
  // an account with no goals: how to start, and no list of skills that have a planner or of those still to come
  await planAs('pure ranger', 'Pure Ranger');
  try {
    assert.equal(flat(await text('#goals-list')), 'Your goals No goals yet. Pick a skill above and set a level, XP, rank or top % to reach. The first button is your combat level.');
    await page.click('.tab[data-tab="bank"]');
    await page.click('[data-bskill="herblore"]');
    const note = flat(await page.locator('#bank-head .note').innerText());
    assert.match(note, /Only the items the planner uses are listed\. /);
    for (const where of ['#view-goals', '#view-bank', '#view-prices', '#settings']) {
      assert.doesNotMatch(await page.locator(where).evaluate(el => el.textContent), /later update|more skills|skills follow|marked with a dot|comes in a later/i, where);
    }
  } finally {
    await planAs('demo main', 'Demo Main');
  }
});

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
    assert.match(iron[9], /^5\s*→\s*1,000$/);
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

await check("a number half typed is left alone: the page's own redraws wait until it's entered (a price, an amount to make, a bank amount)", async () => {
  // Prices arriving redraw the page about once a second, and a field that's redrawn hands in what it holds so
  // far (the browser's doing). Up to v2.8.0 a price or an amount typed slowly was taken half typed, the cursor
  // left the field, and the redraw that was under way gave up with an error.
  const seen = problems.length;
  const card = goalCard('Mining');
  const stored = key => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), key);
  // every Smithing price again: some nine seconds of them, one at a time
  const refresh = async () => {
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="smithing"]');
    if (await page.locator('[data-act="prices-stop"]').count()) await page.click('[data-act="prices-stop"]');
    await page.click('[data-act="prices-refresh"]');
  };
  // typed and left there for two redraws' time: is it the very field that was typed in, holding the cursor?
  const typed = async (field, keys) => {
    await field.click();
    await page.keyboard.type(keys);
    await page.evaluate(() => { document.activeElement.typedHere = true; });
    await page.waitForTimeout(2300);
    assert.match(await text('#status-api'), /Prices [\d,]+\/[\d,]+/, 'prices were arriving all the while');
    return page.evaluate(() => [document.activeElement.typedHere === true, document.activeElement.value]);
  };
  try {
    await addGoal('mining', 90);
    await card.locator('.plan').waitFor();
    await card.locator('[data-tgroup="Bars"]').click();
    // a price of your own
    await refresh();
    assert.deepEqual(await typed(page.locator('[data-price="iron_bar"]'), '123'), [true, '123']);
    assert.equal((await stored('lchs.priceOverrides'))?.iron_bar, undefined, 'not taken half typed');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lchs.priceOverrides') || '{}').iron_bar === 123);
    assert.equal(await page.locator('[data-psrc="iron_bar"][value="mine"]').isChecked(), true, 'entered: it is the price in use');
    // an amount to make
    await refresh();
    await page.click('.tab[data-tab="goals"]');
    assert.deepEqual(await typed(card.locator('[data-mix="mi_bar_steel_bar"]'), '1000'), [true, '1000']);
    assert.equal((await goalOf('demo_main', 'mining')).mix, undefined, 'not taken half typed');
    assert.equal(await card.locator('.plan-sec', { hasText: 'Your mix +' }).count(), 0);
    await page.keyboard.press('Enter');
    await card.locator('.plan-sec', { hasText: 'Your mix +135,000 XP' }).waitFor();
    assert.deepEqual((await goalOf('demo_main', 'mining')).mix, { mi_bar_steel_bar: 1000 });
    // (and the redraws that waited come now)
    await page.evaluate(() => { document.querySelector('#goals-list').firstElementChild.waited = true; });
    await page.waitForFunction(() => !document.querySelector('#goals-list').firstElementChild.waited, null, { timeout: 5000 });
    // a bank amount
    await refresh();
    await page.click('.tab[data-tab="bank"]');
    await page.click('[data-bskill="smithing"]');
    assert.deepEqual(await typed(page.locator('[data-bank="iron_ore"]'), '250'), [true, '250']);
    assert.equal((await stored('lchs.bank.demo_main'))?.items?.iron_ore, undefined, 'not taken half typed');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lchs.bank.demo_main')).items.iron_ore === 250);
    assert.deepEqual(problems.slice(seen).filter(p => p.startsWith('pageerror')), [], 'and nothing went wrong on the page');
  } finally {
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="smithing"]');
    if (await page.locator('[data-act="prices-stop"]').count()) await page.click('[data-act="prices-stop"]');
    await page.fill('[data-price="iron_bar"]', '');
    await page.press('[data-price="iron_bar"]', 'Enter');
    await page.click('#prices-head [data-bskill="herblore"]');
    await setBank('smithing', { iron_ore: '' });
    await page.click('[data-bskill="herblore"]');
    await removeGoal(card);
    await noGoalFor('Mining');
  }
});

await check('an amount or a price entered by clicking elsewhere: the click lands too (the next box takes the cursor, a row is picked, a group opens)', async () => {
  // Up to v2.8.0 the page was redrawn the moment the field was left, under the click that left it: the
  // amount was taken, and what was clicked had to be clicked again.
  const card = goalCard('Mining');
  const box = id => card.locator(`[data-mix="${id}"]`);
  const mix = async () => (await goalOf('demo_main', 'mining')).mix;
  const focused = () => page.evaluate(() => document.activeElement.dataset.mix || document.activeElement.dataset.price || document.activeElement.tagName);
  try {
    await addGoal('mining', 90);
    await card.locator('.plan').waitFor();
    await card.locator('[data-tgroup="Bars"]').click();
    // the next amount box: it has the cursor, and what's typed next goes into it
    await box('mi_bar_bronze_bar').click();
    await page.keyboard.type('100');
    await box('mi_bar_iron_bar').click();
    await card.locator('.plan-sec', { hasText: 'Your mix +' }).waitFor();
    assert.deepEqual(await mix(), { mi_bar_bronze_bar: 100 }, 'the amount is entered');
    assert.equal(await focused(), 'mi_bar_iron_bar', 'and the box that was clicked has the cursor');
    assert.equal(await box('mi_bar_bronze_bar').inputValue(), '100');
    await page.keyboard.type('50');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lchs.goals.demo_main')).find(g => g.skill === 'mining').mix?.mi_bar_iron_bar === 50);
    assert.deepEqual(await mix(), { mi_bar_bronze_bar: 100, mi_bar_iron_bar: 50 });
    // a row of the table: it's the one to train with
    await box('mi_bar_gold_bar').click();
    await page.keyboard.type('7');
    await card.locator('tr[data-method="mi_bar_steel_bar"] td:nth-child(2)').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lchs.goals.demo_main')).find(g => g.skill === 'mining').fillId === 'mi_bar_steel_bar');
    assert.equal(await card.locator('select[data-gopt="fill"]').inputValue(), 'mi_bar_steel_bar');
    assert.equal((await mix()).mi_bar_gold_bar, 7);
    // a group of the table: it opens
    await box('mi_bar_gold_bar').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('8');
    await card.locator('[data-tgroup="Rocks"]').click();
    await card.locator('.group-pick .chip.on', { hasText: 'Rocks' }).waitFor();
    assert.equal((await mix()).mi_bar_gold_bar, 8);
    // and a price: the next price box has the cursor
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="smithing"]');
    await page.locator('[data-price="iron_bar"]').click();
    await page.keyboard.type('123');
    await page.locator('[data-price="steel_bar"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lchs.priceOverrides') || '{}').iron_bar === 123);
    await page.locator('[data-psrc="iron_bar"][value="mine"]:checked').waitFor();
    assert.equal(await focused(), 'steel_bar');
  } finally {
    await page.click('.tab[data-tab="prices"]');
    await page.click('#prices-head [data-bskill="smithing"]');
    await page.fill('[data-price="iron_bar"]', '');
    await page.press('[data-price="iron_bar"]', 'Enter');
    await page.click('#prices-head [data-bskill="herblore"]');
    await removeGoal(card);
    await noGoalFor('Mining');
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
    { slot: 1, icon: '1doseprayerrestore', count: 3309 },        // not a planner item (a blood rune stood here up to v2.8: Magic's now)
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

await check("lookup: the last player looked up is back when the Lookup tab opens, whichever tab the tool opened on; a name you look up while it's on its way is the one that stays (v2.10.3)", async () => {
  const last = await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.prefs')).lastLookup);
  assert.ok(last, 'someone was looked up earlier in the run');
  const fresh = async hash => {
    await page.goto('about:blank');
    await page.goto(BASE + '/?api=local' + hash);
    await page.waitForSelector('.tabs .tab.active');
  };
  const shown = () => page.evaluate(() => document.querySelector('.pc-name')?.innerText.trim() || null);
  // the tool opening on Goals (LostKit reopens it where it was left), then the Lookup tab: no lookup to do again
  await fresh('#goals');
  await page.waitForFunction(() => document.querySelector('#plan-account')?.innerText.includes('XP from the hiscores'), null, { timeout: 15000 });
  assert.equal(await shown(), null);
  await page.click('.tab[data-tab="lookup"]');
  await page.waitForFunction(n => document.querySelector('.pc-name')?.innerText.includes(n), last, { timeout: 15000 });
  assert.equal(await page.inputValue('#lookup-name'), last);
  assert.equal(await page.locator('#lookup-result .empty').count(), 0, 'not the empty page');
  // the same opening with no address at all
  await fresh('');
  await page.click('.tab[data-tab="lookup"]');
  await page.waitForFunction(n => document.querySelector('.pc-name')?.innerText.includes(n), last, { timeout: 15000 });
  // a name looked up while that one's on its way: the one you asked for is the one that stays
  const other = /old badger/i.test(last) ? ['demo main', 'Demo Main'] : ['old badger', 'Old Badger'];
  await fresh('#goals');
  await page.click('.tab[data-tab="lookup"]');
  await page.fill('#lookup-name', other[0]);
  await page.click('#lookup-form button');
  await page.waitForFunction(n => document.querySelector('.pc-name')?.innerText.includes(n), other[1], { timeout: 15000 });
  await page.waitForTimeout(2500);
  assert.equal(await shown(), other[1]);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lchs.prefs')).lastLookup), other[1]);
  // (back as it was)
  await page.fill('#lookup-name', last);
  await page.click('#lookup-form button');
  await page.waitForFunction(n => document.querySelector('.pc-name')?.innerText.includes(n), last, { timeout: 15000 });
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
  // (a first visit: All, which checks no prices by being opened)
  assert.equal(await p2.locator('#prices-head [data-bskill="all"].active').count(), 1);
  await p2.waitForTimeout(1500);
  assert.deepEqual(await p2.evaluate(() => { const st = window.__skills.prices.status(); return [st.busy, st.queued, st.total]; }), [false, 0, 0]);
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
// (an error thrown on the page fails the run, whichever check it happened in; what the console says is passed on)
results.push(problems.length ? [problems.some(p => p.startsWith('pageerror')) ? 'FAIL' : 'info', 'page problems:\n  ' + problems.join('\n  ')] : ['info', 'no page errors']);
await browser.close();

for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '— ' + r[2] : '');
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
