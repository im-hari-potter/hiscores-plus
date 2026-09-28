// Run by the GitHub Action (see .github/workflows/pages.yml) twice a day.
// Works out how many players are ranked in every hiscores category and writes
// totals.json, which the page reads for its "Top X%" numbers. One run
// here saves every user of the tool from doing ~200 slow requests themselves.
//
// Run it yourself with Node 18+:  node update-totals.mjs

import { readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { findTotal, PAGE_SIZE } from './totals-core.js';
import { CATEGORY_IDS, SKILL_BY_ID } from './skills.js';

const API = process.env.HISCORES_API || 'https://2004.lostcity.rs/api/hiscores';
const OUT = new URL('./totals.json', import.meta.url);
const SEED = new URL('./totals-seed.json', import.meta.url);
const HISTORY = new URL('./totals-history.csv', import.meta.url);
const REPO = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : 'local run';
const USER_AGENT = `LC-Hiscores-Plus totals job (${REPO})`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextAt = 0;
let requests = 0;

// One request at a time, paced by the API's own rate-limit headers.
async function getJson(path) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    let res;
    try {
      requests++;
      res = await fetch(API + path, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
    } catch (e) {
      nextAt = Date.now() + 5000 * attempt;
      console.warn(`network error on ${path}: ${e.message} (attempt ${attempt})`);
      continue;
    }
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2;
      nextAt = Date.now() + retryAfter * 1000 + 500;
      continue;
    }
    nextAt = res.headers.has('x-ratelimit-reset') && remaining <= 0
      ? Date.now() + Math.min(Math.max(reset * 1000 + 250, 1000), 10_000)
      : Date.now() + 2100;
    if (res.status >= 500) { nextAt += 5000 * attempt; continue; }
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json();
  }
  throw new Error(`${path}: gave up after repeated failures`);
}

async function readJson(url) {
  try { return JSON.parse(await readFile(url, 'utf8')); } catch (e) { return null; }
}

const previous = (await readJson(OUT)) || (await readJson(SEED)) || { totals: {} };
const totals = {};
const checked = {};
const started = Date.now();
let failures = 0;

// Overall first: every skill's total is at most the Overall total.
for (const id of CATEGORY_IDS) {
  const name = SKILL_BY_ID.get(id).name;
  const guess = Number(previous.totals?.[id]) || undefined;
  const upper = id !== 0 && totals[0] ? totals[0] + PAGE_SIZE : undefined;
  try {
    const res = await findTotal(async rank => {
      const rows = await getJson(`/category/${id}?rank=${rank}`);
      if (!Array.isArray(rows)) throw new Error('unexpected response');
      return rows;
    }, { guess, upper });
    totals[id] = res.total;
    checked[id] = new Date().toISOString();
    console.log(`${name.padEnd(12)} ${String(res.total).padStart(7)}  (${res.probes} requests${guess ? `, was ${guess}` : ''})`);
  } catch (e) {
    failures++;
    console.error(`${name}: ${e.message}`);
    if (Number.isFinite(guess)) { totals[id] = guess; checked[id] = previous.checked?.[id] || previous.updated; }
  }
}

if (failures === CATEGORY_IDS.length) {
  console.error('Every category failed; the API may be blocking this runner. Keeping the old file.');
  process.exit(1);
}

const out = {
  updated: new Date().toISOString(),
  source: 'github-action',
  note: 'Players ranked per hiscores category. A skill only has a hiscores row at level 15+.',
  totals,
  checked,
};
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');

// A running record of the player count, one line per run.
const header = 'updated,' + CATEGORY_IDS.map(id => SKILL_BY_ID.get(id).key).join(',') + '\n';
const exists = await access(HISTORY).then(() => true, () => false);
if (!exists) await writeFile(HISTORY, header);
await appendFile(HISTORY, out.updated + ',' + CATEGORY_IDS.map(id => totals[id] ?? '').join(',') + '\n');

console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s with ${requests} requests, ${failures} failed.`);
// Partial failures keep last run's number for that category; flag them without failing the deploy.
if (failures) console.log(`::warning::${failures} categories could not be refreshed this run and kept their previous totals.`);
