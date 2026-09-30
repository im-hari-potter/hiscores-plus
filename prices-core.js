// Turning markets.lostcity.rs listings into one price per item. No DOM here, so
// it runs in the page and in Node tests.
//
// The market is a board of player offers, not an exchange. A listing is someone
// buying or selling a quantity of an item, paid for with a bundle of items
// (usually just coins). Sellers mark a listing sold when the trade happens.
// Only offers paid purely in coins are priced. The approach follows LostKit's
// own price check (GPL-3.0): judge prices against the median, and read the
// notes when a number looks like a placeholder ("169 coins" + "169m in notes").

export const OUTLIER_FACTOR = 20;

// Price per item of a listing, or null when it isn't a plain coin price.
export function listingUnitPrice(l) {
  if (!l) return null;
  const qty = Math.max(1, Number(l.quantity) || 1);
  if (l.price != null && Number(l.price) > 0) return Number(l.price);       // older listings: price each
  const offers = Array.isArray(l.offers) ? l.offers : [];
  if (offers.length !== 1) return null;
  const items = Array.isArray(offers[0].items) ? offers[0].items : [];
  if (items.length !== 1 || items[0]?.item?.slug !== 'coins') return null;
  const coins = Number(items[0].quantity);
  if (!(coins > 0)) return null;
  const each = String(offers[0].title || '').trim().toLowerCase().startsWith('for each');
  const raw = each ? coins : coins / qty;
  return raw < 10 ? Math.round(raw * 1000) / 1000 : Math.round(raw);   // bulk lots can be under 1 gp each
}

export const isLive = l => l && !l.soldAt && !l.deletedAt && !l.pausedAt;

export function median(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Amounts the way players write them: 169m, 1.5b, 250k, 13,000.
export function noteAmounts(notes) {
  const out = [];
  const text = String(notes || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(bil(?:lion)?|mil(?:lion)?|b|m|k)?\b/gi)) {
    const n = parseFloat(m[1]);
    if (!(n > 0)) continue;
    const u = (m[2] || '').toLowerCase().charAt(0);
    out.push({ value: Math.round(n * (u === 'b' ? 1e9 : u === 'm' ? 1e6 : u === 'k' ? 1e3 : 1)), mantissa: n, scaled: !!u });
  }
  return out;
}

// Keeps prices that sit near the going rate. One far out is checked against its
// notes; if they don't explain it, it's left out rather than guessed at.
export function screenPrices(entries) {
  const ref = entries.length >= 3 ? median(entries.map(e => e.p)) : null;
  if (ref == null) return entries;
  const near = v => v >= ref / OUTLIER_FACTOR && v <= ref * OUTLIER_FACTOR;
  const out = [];
  for (const e of entries) {
    if (near(e.p)) { out.push(e); continue; }
    const amounts = noteAmounts(e.notes).filter(a => a.scaled && near(a.value));
    const same = amounts.find(a => Math.round(a.mantissa) === Math.round(e.p));
    const fix = same || (amounts.length === 1 ? amounts[0] : null);
    if (fix) out.push({ ...e, p: fix.value, fromNotes: true });
  }
  return out;
}

// One price from an item page's props ({ item, listings, soldListings }).
//   sales  - median of the most recent coin sales (up to 10 on the first page)
//   offers - median of the open coin offers on the page
// Returns { p, src, n, last } or null when the page has neither.
export function priceFromPage(props) {
  if (!props) return null;
  const sold = (props.soldListings?.data || [])
    .filter(l => l.soldAt)
    .map(l => ({ p: listingUnitPrice(l), t: Date.parse(l.soldAt), notes: l.notes }))
    .filter(e => e.p > 0);
  const sales = screenPrices(sold);
  if (sales.length) {
    return { p: roundPrice(median(sales.map(e => e.p))), src: 'sales', n: sales.length, last: Math.max(...sales.map(e => e.t).filter(Number.isFinite)) };
  }
  return priceFromListings(props.listings?.data || []);
}

// Median of open offers (from an item page or the JSON API).
export function priceFromListings(listings) {
  const live = (listings || []).filter(isLive)
    .map(l => ({ p: listingUnitPrice(l), t: Date.parse(l.updatedAt), notes: l.notes }))
    .filter(e => e.p > 0);
  const offers = screenPrices(live);
  if (!offers.length) return null;
  return { p: roundPrice(median(offers.map(e => e.p))), src: 'offers', n: offers.length, last: Math.max(...offers.map(e => e.t).filter(Number.isFinite), 0) || null };
}

const roundPrice = p => (p < 10 ? Math.round(p * 100) / 100 : Math.round(p));

// The page embeds its data as HTML-escaped JSON in data-page="...".
export function pageFromHtml(html) {
  const m = String(html).match(/data-page="([^"]*)"/);
  if (!m) return null;
  const json = m[1].replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(json);
}
