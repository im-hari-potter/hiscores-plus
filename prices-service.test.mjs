// Run with:  node --test
// The price queue against a stubbed fetch: which route is used, what gets cached,
// and when it stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Prices, highAlch } from './prices.js';

const coins = n => ({ quantity: n, item: { slug: 'coins' } });
const sale = (p, day) => ({ type: 'sell', quantity: 1, soldAt: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, offers: [{ title: 'For each item:', items: [coins(p)] }] });
const page = (props, version = 'v1') => ({ component: 'items/show/page', version, props });
const html = p => `<div id="app" data-page="${JSON.stringify(p).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`;

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname + u.search, inertia: opts.headers?.['X-Inertia'] === 'true' });
    const r = await handler(u, opts);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status || 200, headers: { 'content-type': r.type || (typeof r.body === 'string' ? 'text/html' : 'application/json') } });
  };
  return calls;
}
const done = p => new Promise(res => {
  const check = () => (p.status().busy || p.status().queued ? setTimeout(check, 5) : res());
  check();
});

test('item pages: first by HTML (learning the version), then as JSON; 3-dose falls back to 4-dose', async () => {
  const calls = stubFetch(u => {
    const slug = u.pathname.split('/').pop();
    const props = slug === 'ranarr_weed'
      ? { item: { slug }, listings: { data: [] }, soldListings: { data: [sale(3000, 20), sale(3100, 21), sale(2900, 22)] } }
      : slug === '4doseprayerrestore'
        ? { item: { slug }, listings: { data: [] }, soldListings: { data: [sale(8000, 20)] } }
        : { item: { slug }, listings: { data: [] }, soldListings: { data: [] } };
    return { body: u.searchParams.get('type') === 'sell' || !calls.at(-1).inertia ? html(page(props)) : page(props), type: calls.at(-1).inertia ? 'application/json' : 'text/html' };
  });
  const p = new Prices({ origin: 'https://m.test', routes: ['page', 'api'], gapMs: 0 });
  p.want(['ranarr_weed', '3doseprayerrestore']);
  await done(p);
  assert.deepEqual(p.info('ranarr_weed').gp, 3000);
  assert.equal(p.info('ranarr_weed').src, 'sales');
  assert.equal(calls[0].inertia, false, 'first request is the HTML page');
  assert.equal(calls[1].inertia, true, 'then the JSON version with the learned tag');
  assert.equal(p.info('3doseprayerrestore').gp, 6000, '¾ of 8,000');
  assert.equal(p.info('3doseprayerrestore').src, 'dose');
  assert.ok(calls.some(c => c.path.includes('4doseprayerrestore')), 'the 4-dose was looked up');
});

test('high alch is 3/5 of an item\'s value, at least 1 coin, like the spell', () => {
  assert.equal(highAlch('snape_grass'), 6, 'value 10');
  assert.equal(highAlch('yew_longbow'), 768, 'value 1,280');
  assert.equal(highAlch('feather'), 1, 'value 2: 1.2 rounds down');
  assert.equal(highAlch('arrow_shaft'), 1, 'value 1: never less than 1 coin');
  assert.equal(highAlch('not_an_item'), null);
});

test('an item the market does not list is priced at high alch; your own price wins', async () => {
  stubFetch(() => ({ status: 404, body: 'nope' }));
  const p = new Prices({ origin: 'https://m.test', routes: ['page'], gapMs: 0 });
  assert.equal(p.info('snape_grass'), null, 'not checked yet: no price');
  p.want(['snape_grass']);
  await done(p);
  assert.deepEqual({ gp: p.info('snape_grass').gp, src: p.info('snape_grass').src, untraded: p.info('snape_grass').untraded }, { gp: 6, src: 'alch', untraded: true });
  p.setOverride('snape_grass', 450);
  assert.deepEqual(p.info('snape_grass'), { gp: 450, src: 'you' });
  p.setOverride('snape_grass', null);
  assert.equal(p.info('snape_grass').src, 'alch');
});

test('each item keeps the price you pick for it: market, high alch or your own', async () => {
  const calls = stubFetch(u => {
    const slug = u.pathname.split('/').pop();
    return { body: html(page({ item: { slug }, listings: { data: [] }, soldListings: { data: [sale(3000, 20)] } })) };
  });
  const p = new Prices({ origin: 'https://m.test', routes: ['page'], gapMs: 0 });
  p.want(['ranarr_weed', 'yew_longbow']);
  await done(p);
  assert.equal(p.sourceOf('yew_longbow'), 'market', 'the market is the default');
  p.setSource('yew_longbow', 'alch');
  assert.deepEqual(p.info('yew_longbow'), { gp: 768, src: 'alch' });
  assert.equal(p.info('ranarr_weed').gp, 3000, 'only that item changed');
  assert.equal(p.market('yew_longbow').gp, 3000, 'the market\'s price is still there to compare');
  // items on high alch don't need the market, unless asked for all of them
  p.setSource('magic_longbow', 'alch');
  const asked = calls.length;
  assert.equal(p.want(['magic_longbow']), 0);
  assert.equal(calls.length, asked);
  assert.equal(p.want(['magic_longbow'], { all: true }), 1);
  await done(p);
  // 'yours' needs a price typed in; typing one picks it
  p.setSource('kwuarm', 'mine');
  assert.equal(p.sourceOf('kwuarm'), 'market');
  p.setOverride('kwuarm', 2500);
  assert.equal(p.sourceOf('kwuarm'), 'mine');
  assert.deepEqual(p.info('kwuarm'), { gp: 2500, src: 'you' });
  // picking for a whole list leaves your own prices be
  p.setSource(['kwuarm', 'ranarr_weed', 'snape_grass'], 'alch');
  assert.deepEqual(p.info('kwuarm'), { gp: 2500, src: 'you' });
  assert.deepEqual([p.sourceOf('ranarr_weed'), p.sourceOf('snape_grass')], ['alch', 'alch']);
  // picking another for that item itself keeps the typed price for later
  p.setSource('kwuarm', 'alch');
  assert.deepEqual(p.info('kwuarm'), { gp: 32, src: 'alch' });
  p.setSource('kwuarm', 'mine');
  assert.deepEqual(p.info('kwuarm'), { gp: 2500, src: 'you' });
  // clearing it goes back to the market
  p.setOverride('kwuarm', null);
  assert.equal(p.sourceOf('kwuarm'), 'market');
  p.setSource(['ranarr_weed', 'snape_grass', 'yew_longbow', 'magic_longbow'], 'market');
  assert.equal(p.info('ranarr_weed').src, 'sales');
});

test('your own price stays until you clear it, whatever the market says', async () => {
  stubFetch(u => {
    const slug = u.pathname.split('/').pop();
    return { body: html(page({ item: { slug }, listings: { data: [] }, soldListings: { data: [sale(3000, 20)] } })) };
  });
  const p = new Prices({ origin: 'https://m.test', routes: ['page'], gapMs: 0 });
  p.setOverride('ranarr_weed', 2750);
  p.want(['ranarr_weed'], { force: true });
  await done(p);
  assert.equal(p.cache.ranarr_weed.p, 3000, 'the market was checked');
  assert.deepEqual(p.info('ranarr_weed'), { gp: 2750, src: 'you' }, 'but your price is the one used');
  p.setOverride('ranarr_weed', null);
  assert.equal(p.info('ranarr_weed').src, 'sales');
});

test('the JSON API route (normal browsers): open offers', async () => {
  const offer = (p, type) => ({ type, quantity: 10, offers: [{ title: 'For each item:', items: [coins(p)] }] });
  stubFetch(u => {
    if (u.pathname === '/api/items') return { body: [{ id: 7, slug: 'eye_of_newt', name: 'Eye of newt', cost: 3 }] };
    if (u.pathname === '/api/items/7') return { body: { data: u.searchParams.get('type') === 'sell' ? [offer(40, 'sell'), offer(44, 'sell')] : [] } };
    return { status: 404, body: '' };
  });
  const p = new Prices({ origin: 'https://m.test', routes: ['api'], gapMs: 0 });
  p.want(['eye_of_newt']);
  await done(p);
  assert.deepEqual({ gp: p.info('eye_of_newt').gp, src: p.info('eye_of_newt').src, n: p.info('eye_of_newt').n }, { gp: 42, src: 'offers', n: 2 });
});

test('being turned away (429) stops the round instead of hammering on', async () => {
  const calls = stubFetch(() => ({ status: 429, body: 'slow down' }));
  const p = new Prices({ origin: 'https://m.test', routes: ['page', 'api'], gapMs: 0 });
  p.want(['guam_leaf', 'marentill', 'tarromin', 'harralander']);
  await done(p);
  assert.equal(calls.length, 1, 'one request, then it stopped');
  assert.match(p.status().error, /turning requests away/);
  assert.equal(p.info('guam_leaf'), null, 'nothing cached, so the next round tries again');
});

test('no connection at all stops the round too', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const p = new Prices({ origin: 'https://m.test', routes: ['page', 'api'], gapMs: 0 });
  p.want(['guam_leaf', 'marentill']);
  await done(p);
  assert.match(p.status().error, /could not be reached/);
  assert.equal(p.status().done, 1);
});

test('typed prices from before each item had its own choice are yours; the old switch is gone', () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
  try {
    mem.set('lchs.priceOverrides', JSON.stringify({ snape_grass: 450 }));
    mem.set('lchs.priceMode', JSON.stringify('alch'));               // v2.4.2: High alch for everything
    const p = new Prices({ origin: 'https://m.test' });
    assert.equal(p.sourceOf('snape_grass'), 'mine');
    assert.deepEqual(p.info('snape_grass'), { gp: 450, src: 'you' });
    assert.equal(p.sourceOf('kwuarm'), 'market', 'everything else starts on the market');
    assert.equal(mem.has('lchs.priceMode'), false);
    assert.deepEqual(JSON.parse(mem.get('lchs.priceUse')), { snape_grass: 'mine' });
    p.setSource('yew_longbow', 'alch');
    assert.equal(new Prices({ origin: 'https://m.test' }).sourceOf('yew_longbow'), 'alch', 'your pick sticks');
  } finally {
    delete globalThis.localStorage;
  }
});
