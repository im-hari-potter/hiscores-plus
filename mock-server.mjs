// A stand-in for the Lost City hiscores API, for testing without touching the
// real one. Same paging rules (offset = max(rank - 21, 0), 21 rows), same
// "skills only ranked at 15+" rule, and the same 1-request-per-window limit
// with x-ratelimit-* headers and 429s. Also serves the site's files.
//
//   node mock-server.mjs [port]          RATE_MS=2000 by default
//   POST /__mock/bump?name=x&type=1&xp=500    give a player XP (for gains tests)
//   POST /__mock/grow?type=1&n=30             add n fresh players ranked in a skill
//
// It also stands in for markets.lostcity.rs under /market: item pages (HTML with
// the page data embedded, or JSON when asked with X-Inertia headers) and the JSON
// API. Prices are made up from each item's shop value. Some items have sales, some
// only open offers, 3-dose potions have nothing (so the 4-dose price is used).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS, levelForXp, xpForLevel } from './skills.js';
import { ITEMS } from './gamedata.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const RATE_MS = Number(process.env.RATE_MS || 2000);
const SKILL_IDS = SKILLS.filter(s => s.id !== 0).map(s => s.id);

// ── Synthetic players ─────────────────────────────────────────────────────
let seed = 20040518;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const FRACTION = { 1: .69, 2: .445, 3: .67, 4: .66, 5: .40, 6: .44, 7: .565, 8: .56, 9: .65, 10: .35, 11: .57, 12: .42, 13: .41, 14: .52, 15: .67, 16: .21, 17: .41, 18: .38, 21: .23 };
const accounts = new Map(); // safe -> { safe, xp: {id: xp}, date }
let clock = Date.parse('2025-01-01T00:00:00Z');

function addAccount(safe, xpById) {
  const xp = {};
  for (const id of SKILL_IDS) xp[id] = xpById[id] ?? (id === 4 ? xpForLevel(10) : 0);
  accounts.set(safe, { safe, xp, date: clock += 60_000 });
}

const COUNT = Number(process.env.ACCOUNTS || 20400);
for (let i = 0; i < COUNT; i++) {
  const activity = rnd() ** 2.2;
  const xp = {};
  for (const id of SKILL_IDS) {
    let level;
    if (rnd() < FRACTION[id]) level = Math.min(99, 15 + Math.floor(84 * Math.min(1, activity * (0.5 + rnd()))));
    else level = id === 4 ? 10 + Math.floor(rnd() * 5) : 1 + Math.floor(rnd() * 14 * activity);
    const base = xpForLevel(level), next = level < 99 ? xpForLevel(level + 1) : base + 1;
    xp[id] = level >= 99 ? base + Math.floor(rnd() * 3_000_000) : base + Math.floor(rnd() * (next - base));
  }
  addAccount('p' + i.toString(36), xp);
}

// Named players the tests use.
const named = {
  demo_main: { 1: 295920, 2: 61778, 3: 5352336, 4: 3789181, 5: 5354269, 6: 54168, 7: 5354803, 8: 1990230, 9: 7216518,
    10: 4893621, 11: 2197380, 12: 854147, 13: 4437659, 14: 941959, 15: 3410647, 16: 1196027, 17: 569601, 18: 4263105, 21: 669638 },
  vwangwang: Object.fromEntries(SKILL_IDS.map(id => [id, 13_034_431 + id * 1_234_567])),
  old_badger: Object.fromEntries(SKILL_IDS.map(id => [id, xpForLevel(50 + (id % 7)) + 100])),
  lowbie: { 1: xpForLevel(20) + 5, 3: xpForLevel(18) + 5, 4: xpForLevel(16) + 5, 8: xpForLevel(22), 9: xpForLevel(25), 2: xpForLevel(5), 6: xpForLevel(3), 7: xpForLevel(9) },
  pure_ranger: { 1: xpForLevel(40), 3: xpForLevel(55), 4: xpForLevel(60), 5: xpForLevel(80), 2: xpForLevel(1), 6: xpForLevel(13), 7: xpForLevel(45) },
};
for (const [safe, xp] of Object.entries(named)) addAccount(safe, xp);

// ── Rankings ──────────────────────────────────────────────────────────────
let rankings = null;
function rebuild() {
  rankings = {};
  const all = [...accounts.values()];
  for (const id of SKILL_IDS) {
    rankings[id] = all.filter(a => levelForXp(a.xp[id]) >= 15)
      .map(a => ({ a, level: levelForXp(a.xp[id]), value: a.xp[id] * 10 }))
      .sort((x, y) => y.value - x.value || x.a.date - y.a.date);
  }
  rankings[0] = all.map(a => {
    let level = 0, xp = 0;
    for (const id of SKILL_IDS) { level += levelForXp(a.xp[id]); xp += a.xp[id]; }
    return { a, level, value: xp * 10 };
  }).sort((x, y) => y.level - x.level || y.value - x.value || x.a.date - y.a.date);
  for (const id of Object.keys(rankings)) rankings[id].forEach((r, i) => { r.rank = i + 1; });
}
rebuild();

const safeName = s => String(s).trim().toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 12).replace(/^_+/, '');

// ── HTTP ──────────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.otf': 'font/otf', '.csv': 'text/csv' };
let windowEnds = 0;
export const counters = { api: 0, limited: 0, market: 0 };

// ── Market stand-in ───────────────────────────────────────────────────────
const MARKET_VERSION = 'mock-v1';
const marketItems = Object.entries(ITEMS).filter(([, it]) => !it.untradeable)
  .map(([slug, it], i) => ({ id: 1000 + i, game_id: it.id, name: it.name, slug, cost: it.cost, isSet: false }));
const marketBySlug = new Map(marketItems.map(i => [i.slug, i]));
const COIN = { id: 1, game_id: 995, name: 'Coins', slug: 'coins', cost: 1 };
const MULT = { ranarr_weed: 120, snape_grass: 40, '4doseprayerrestore': 30 };
function marketPrice(slug) {
  const it = marketBySlug.get(slug);
  return Math.max(1, Math.round(it.cost * (MULT[slug] || 12)));
}
function listing(id, item, type, unit, { soldDaysAgo = null, qty = 100, each = true, notes = '' } = {}) {
  const day = 864e5;
  return {
    id, type, price: null, quantity: qty, notes, username: 'trader' + (id % 17), item,
    offers: [{ id, listingId: id, title: each ? 'For each item:' : 'For:', items: [{ id, listingOfferId: id, quantity: each ? unit : unit * qty, item_id: 1, item: COIN }] }],
    updatedAt: new Date(Date.now() - 2 * day).toISOString(),
    soldAt: soldDaysAgo == null ? null : new Date(Date.now() - soldDaysAgo * day).toISOString(),
    deletedAt: null, pausedAt: null, canManage: false,
  };
}
// 3-dose potions: nothing. Unfinished potions and unidentified herbs: offers only.
function marketListings(slug) {
  const item = marketBySlug.get(slug);
  const p = marketPrice(slug);
  if (/^3dose/.test(slug)) return { sold: [], buy: [], sell: [] };
  const offersOnly = /vial$|^unidentified_/.test(slug) && slug !== 'vial_water';
  const sold = offersOnly ? [] : [0.95, 1, 1.05, 1.02, 0.98].map((f, i) => listing(10 * item.id + i, item, i % 2 ? 'buy' : 'sell', Math.round(p * f), { soldDaysAgo: i + 1 }));
  // one placeholder price the screening has to see through
  if (!offersOnly && slug === 'ranarr_weed') sold.push(listing(10 * item.id + 7, item, 'sell', 3, { soldDaysAgo: 6, notes: `${Math.round(p / 1000)}k each` }));
  const buy = [listing(10 * item.id + 8, item, 'buy', Math.round(p * 0.9))];
  const sell = [listing(10 * item.id + 9, item, 'sell', Math.round(p * 1.1), { each: false, qty: 50 })];
  return { sold, buy, sell };
}
const paged = (data, name = 'page') => ({ data, links: [], meta: { current_page: 1, last_page: 1, per_page: 20, total: data.length, next_page_url: null, path: name } });

function marketRoute(req, url, res) {
  counters.market++;
  const json = (status, body, headers = {}) => send(res, status, JSON.stringify(body), { 'Content-Type': 'application/json', ...headers });
  // (decoded: a slug can hold a '+', sent as %2B, like the Blamish snail shells' 'shellround_red+black')
  const path = (() => { try { return decodeURIComponent(url.pathname.replace(/^\/market/, '')); } catch { return ''; } })();
  if (path === '/api/items') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    if (!q) return json(200, []);
    const hits = marketItems.filter(i => i.slug.includes(q.replace(/ /g, '_')) || i.name.toLowerCase().includes(q))
      .sort((a, b) => (a.slug === q ? -1 : b.slug === q ? 1 : a.name.length - b.name.length)).slice(0, 5);
    return json(200, hits);
  }
  let m = path.match(/^\/api\/items\/(\d+)$/);
  if (m) {
    const it = marketItems.find(i => i.id === Number(m[1]));
    if (!it) return json(404, { message: 'Not found' });
    const side = url.searchParams.get('type') === 'sell' ? 'sell' : 'buy';
    return json(200, paged(marketListings(it.slug)[side]));
  }
  m = path.match(/^\/items\/([a-z0-9_+]+)$/);
  if (m) {
    const it = marketBySlug.get(m[1]);
    const inertia = req.headers['x-inertia'] === 'true';
    if (!it) return inertia ? json(404, { component: 'errors/index/page', props: { status: 404 }, version: MARKET_VERSION }) : send(res, 404, '<html>404</html>', { 'Content-Type': 'text/html' });
    if (inertia && req.headers['x-inertia-version'] !== MARKET_VERSION) return send(res, 409, '', { 'X-Inertia-Location': url.href });
    const side = url.searchParams.get('type') === 'sell' ? 'sell' : 'buy';
    const l = marketListings(it.slug);
    const page = { component: 'items/show/page', url: url.pathname + url.search, version: MARKET_VERSION,
      props: { item: it, listingType: side, listings: paged(l[side]), soldListings: paged(l.sold, 'sold') } };
    if (inertia) return json(200, page, { 'X-Inertia': 'true', Vary: 'X-Inertia' });
    const attr = JSON.stringify(page).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return send(res, 200, `<!DOCTYPE html><html><head><title>${it.name}</title></head><body><div id="app" data-page="${attr}"></div></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  return send(res, 404, 'not found');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/__mock/')) {
    if (url.pathname === '/__mock/bump') {
      const a = accounts.get(safeName(url.searchParams.get('name')));
      if (!a) return send(res, 404, 'no such player');
      a.xp[Number(url.searchParams.get('type'))] += Number(url.searchParams.get('xp'));
      rebuild();
      return send(res, 200, 'ok');
    }
    if (url.pathname === '/__mock/grow') {
      const type = Number(url.searchParams.get('type'));
      const n = Number(url.searchParams.get('n') || 10);
      for (let i = 0; i < n; i++) addAccount('g' + Date.now().toString(36) + i, { [type]: xpForLevel(15) });
      rebuild();
      return send(res, 200, 'ok');
    }
    if (url.pathname === '/__mock/stats') {
      return send(res, 200, JSON.stringify({ ...counters, totals: Object.fromEntries(Object.entries(rankings).map(([k, v]) => [k, v.length])) }), { 'Content-Type': 'application/json' });
    }
  }

  if (url.pathname.startsWith('/market/')) return marketRoute(req, url, res);

  if (url.pathname.startsWith('/api/hiscores/')) {
    counters.api++;
    const now = Date.now();
    if (now < windowEnds) {
      counters.limited++;
      if (process.env.LOG_429) console.log(`429 ${url.pathname}${url.search} (${windowEnds - now} ms early) ua=${(req.headers['referer'] || '').slice(0, 60)}`);
      return send(res, 429, '', { 'Retry-After': '1', 'X-RateLimit-Limit': '1', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Math.max(1, Math.ceil((windowEnds - now) / 1000))) });
    }
    windowEnds = now + RATE_MS;
    const rl = { 'X-RateLimit-Limit': '1', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(RATE_MS / 1000), 'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After' };
    const m = url.pathname.match(/^\/api\/hiscores\/(player|category)\/([^/]+)$/);
    if (!m) return send(res, 404, 'not found', rl);
    if (m[1] === 'player') {
      const safe = safeName(decodeURIComponent(m[2]));
      const out = [];
      for (const [id, list] of Object.entries(rankings)) {
        const row = list.find(r => r.a.safe === safe);
        if (row) out.push({ type: Number(id), level: row.level, value: row.value, rank: row.rank });
      }
      out.sort((x, y) => x.type - y.type);
      return send(res, 200, JSON.stringify(out), rl);
    }
    const list = rankings[Number(m[2])];
    if (!list) return send(res, 200, '[]', rl);
    const rank = Number(url.searchParams.get('rank')) || 0;
    const offset = Math.max(rank - 21, 0);
    const rows = list.slice(offset, offset + 21).map(r => ({ username: r.a.safe, level: r.level, value: r.value, rank: r.rank }));
    return send(res, 200, JSON.stringify(rows), rl);
  }

  // Static files
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) return send(res, 403, 'no');
  try {
    const body = await readFile(file);
    send(res, 200, body, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  } catch (e) {
    send(res, 404, 'not found');
  }
});

server.listen(PORT, () => {
  console.log(`mock API + site on http://localhost:${PORT}  (rate window ${RATE_MS} ms)`);
  console.log('totals:', JSON.stringify(Object.fromEntries(Object.entries(rankings).map(([k, v]) => [k, v.length]))));
});
