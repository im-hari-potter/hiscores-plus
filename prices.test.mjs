// Run with:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { listingUnitPrice, priceFromPage, priceFromListings, screenPrices, noteAmounts, pageFromHtml, median } from './prices-core.js';

const coins = n => ({ quantity: n, item: { slug: 'coins', name: 'Coins' } });
const listing = (o = {}) => ({
  id: 1, type: 'sell', price: null, quantity: 100, notes: '', username: 'x', updatedAt: '2026-09-20T00:00:00Z',
  soldAt: null, deletedAt: null, pausedAt: null, offers: [{ title: 'For each item:', items: [coins(3000)] }], ...o,
});

test('unit price of a listing', () => {
  assert.equal(listingUnitPrice(listing()), 3000, '"For each item:" is per item');
  assert.equal(listingUnitPrice(listing({ offers: [{ title: 'For:', items: [coins(300000)] }] })), 3000, 'a lot price is divided');
  assert.equal(listingUnitPrice(listing({ quantity: 100000, offers: [{ title: 'For:', items: [coins(30000)] }] })), 0.3, 'bulk lots keep their fraction');
  assert.equal(listingUnitPrice(listing({ price: 2500 })), 2500, 'older listings carry a price each');
  assert.equal(listingUnitPrice(listing({ offers: [{ title: 'For:', items: [coins(5), { quantity: 1, item: { slug: 'santa_hat' } }] }] })), null, 'barter is not priced');
  assert.equal(listingUnitPrice(listing({ offers: [] })), null);
});

test('placeholder prices are fixed from the notes or dropped', () => {
  const e = [{ p: 3000 }, { p: 3100 }, { p: 2900 }, { p: 3, notes: '3k each pm me' }, { p: 1, notes: 'offers' }];
  const out = screenPrices(e);
  assert.deepEqual(out.map(x => x.p), [3000, 3100, 2900, 3000]);
  assert.ok(out[3].fromNotes);
  assert.deepEqual(noteAmounts('169m offer, or 1.5b').map(a => a.value), [169e6, 1.5e9]);
  assert.deepEqual(noteAmounts('13,000 each').map(a => a.value), [13000]);
});

test('an item page gives the median of recent sales, else of open offers', () => {
  const sold = [2800, 3000, 3100, 3300].map((p, i) => listing({ soldAt: `2026-09-2${i}T12:00:00Z`, offers: [{ title: 'For each item:', items: [coins(p)] }] }));
  const withSales = priceFromPage({ soldListings: { data: sold }, listings: { data: [listing({ offers: [{ title: 'For each item:', items: [coins(9999)] }] })] } });
  assert.equal(withSales.src, 'sales');
  assert.equal(withSales.p, 3050);
  assert.equal(withSales.n, 4);
  assert.equal(withSales.last, Date.parse('2026-09-23T12:00:00Z'));

  const offersOnly = priceFromPage({ soldListings: { data: [] }, listings: { data: [listing(), listing({ offers: [{ title: 'For each item:', items: [coins(3400)] }] }), listing({ pausedAt: '2026-09-01' })] } });
  assert.equal(offersOnly.src, 'offers');
  assert.equal(offersOnly.p, 3200);
  assert.equal(offersOnly.n, 2, 'paused listings are not offers');

  assert.equal(priceFromPage({ soldListings: { data: [] }, listings: { data: [] } }), null);
  assert.equal(priceFromListings([]), null);
  assert.equal(median([3, 1, 2]), 2);
});

test('the page data embedded in the HTML is read', () => {
  const page = { component: 'items/show/page', version: 'abc123', props: { item: { slug: 'ranarr_weed', name: "Ranarr's & <weed>" } } };
  const attr = JSON.stringify(page).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!DOCTYPE html><html><body><div id="app" data-page="${attr}"></div></body></html>`;
  assert.deepEqual(pageFromHtml(html), page);
  assert.equal(pageFromHtml('<html></html>'), null);
});
