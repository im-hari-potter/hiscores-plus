// Live prices from markets.lostcity.rs, fetched slowly and kept for 12 hours.
//
// Inside LostKit the tool may read the market's item pages, which carry recent
// sales. Normal browsers can only use the market's JSON API, which has open
// offers but no sales. Either way, a price you type in wins, and the shop value
// is the last resort.
//
// Requests go one at a time with a pause between them: a handful of items a
// minute costs the market about as much as one person clicking around.

import { store } from './store.js';
import { ITEMS } from './gamedata.js';
import { priceFromPage, priceFromListings, pageFromHtml } from './prices-core.js';

export const LIVE_MARKET = 'https://markets.lostcity.rs';
const TTL_MS = 12 * 3600e3;
const FORMAT = 1;                       // bump to drop cached prices after a logic change

export class Prices extends EventTarget {
  // routes: 'page' (item pages with sales; LostKit only) and/or 'api' (JSON API)
  constructor({ origin = LIVE_MARKET, routes = ['page', 'api'], gapMs = 700, timeoutMs = 15000 } = {}) {
    super();
    this.origin = origin.replace(/\/+$/, '');
    this.routes = routes;
    this.gapMs = gapMs;
    this.timeoutMs = timeoutMs;
    this.cache = store.get('prices', {});
    if (this.cache._v !== FORMAT) this.cache = { _v: FORMAT };
    this.overrides = store.get('priceOverrides', {});
    this.queue = [];
    this.busy = false;
    this.progress = { done: 0, total: 0, failed: 0 };
    this.version = store.get('market.version', null);
    this.lastError = null;
  }

  // ── Reading ─────────────────────────────────────────────────────────────
  // { gp, src, n, last, at } for an item, or null. src: 'you' | 'sales' | 'offers' | 'dose' | 'shop'
  info(slug) {
    if (this.overrides[slug] != null) return { gp: this.overrides[slug], src: 'you' };
    const c = this.cache[slug];
    if (c && c.p != null) return { gp: c.p, src: c.src, n: c.n, last: c.last, at: c.at };
    // A 3-dose potion with no trades of its own: 3/4 of the 4-dose price.
    const dose = slug.match(/^3dose(.+)$/);
    const four = dose && this.cache['4dose' + dose[1]];
    if (four && four.p != null) return { gp: Math.round(four.p * 0.75), src: 'dose', n: four.n, last: four.last, at: four.at };
    const shop = ITEMS[slug]?.cost;
    if (shop != null && c) return { gp: shop, src: 'shop', at: c.at };   // looked up, nothing traded
    return null;
  }

  gp(slug) { return this.info(slug)?.gp ?? null; }

  // For planner.js: price per item, or null.
  priceOf = slug => this.gp(slug);

  fetchedAt(slug) { return this.cache[slug]?.at || 0; }
  isFresh(slug) { const c = this.cache[slug]; return !!c && Date.now() - c.at < TTL_MS; }

  setOverride(slug, gp) {
    if (gp == null || !(gp >= 0)) delete this.overrides[slug];
    else this.overrides[slug] = gp;
    store.set('priceOverrides', this.overrides);
    this.#emit();
  }

  status() {
    return { queued: this.queue.length, busy: this.busy, ...this.progress, error: this.lastError };
  }

  // ── Fetching ────────────────────────────────────────────────────────────
  // Queue items that have no fresh price (or all of them with force).
  want(slugs, { force = false } = {}) {
    let added = 0;
    for (const slug of new Set(slugs)) {
      if (!ITEMS[slug] || ITEMS[slug].untradeable) continue;
      if (!force && this.isFresh(slug)) continue;
      if (this.queue.includes(slug)) continue;
      this.queue.push(slug);
      added++;
    }
    if (added) {
      if (!this.busy) this.progress = { done: 0, total: 0, failed: 0 };
      this.progress.total += added;
      this.#emit();
      this.#pump();
    }
    return added;
  }

  stop() {
    this.progress.total -= this.queue.length;
    this.queue = [];
    this.#emit();
  }

  #emit() { this.dispatchEvent(new CustomEvent('update', { detail: this.status() })); }

  async #pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const slug = this.queue.shift();
        try {
          const res = await this.#lookup(slug);
          this.cache[slug] = { p: res?.p ?? null, src: res?.src || 'none', n: res?.n || 0, last: res?.last || null, at: Date.now() };
          this.lastError = null;
          // A 3-dose potion nobody trades: look at the 4-dose next.
          const dose = !res && slug.match(/^3dose(.+)$/);
          if (dose && ITEMS['4dose' + dose[1]] && !this.isFresh('4dose' + dose[1]) && !this.queue.includes('4dose' + dose[1])) {
            this.queue.unshift('4dose' + dose[1]);
            this.progress.total++;
          }
        } catch (e) {
          this.progress.failed++;
          this.lastError = e.message || String(e);
          if (e.fatal) { this.progress.total -= this.queue.length; this.queue = []; }
        }
        this.progress.done++;
        store.set('prices', this.cache);
        this.#emit();
        if (this.queue.length) await sleep(this.gapMs);
      }
    } finally {
      this.busy = false;
      this.#emit();
    }
  }

  async #lookup(slug) {
    let lastErr = null;
    for (const route of this.routes) {
      try {
        return route === 'page' ? await this.#fromPage(slug) : await this.#fromApi(slug);
      } catch (e) {
        lastErr = e;
        if (e.notFound) return null;      // the market doesn't list this item
        if (e.refused) break;
      }
    }
    const err = new Error(lastErr?.message || 'The market could not be reached.');
    err.fatal = lastErr?.network || lastErr?.refused;   // can't connect, or told to stop: stop for now
    throw err;
  }

  // Item page: sales first, then open buy offers, then open sell offers.
  async #fromPage(slug) {
    const page = await this.#page(`/items/${encodeURIComponent(slug)}`);
    const found = priceFromPage(page.props);
    if (found) return found;
    await sleep(this.gapMs);
    const sell = await this.#page(`/items/${encodeURIComponent(slug)}?type=sell`);
    return priceFromListings(sell.props?.listings?.data);
  }

  async #page(path) {
    // The light JSON version, when we know the site's current version tag...
    if (this.version) {
      try {
        const res = await this.#get(path, { 'X-Inertia': 'true', 'X-Inertia-Version': this.version, 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, application/xhtml+xml' });
        if (res.ok && (res.headers.get('content-type') || '').includes('json')) return await res.json();
        if (res.status === 404) throw Object.assign(new Error('not listed'), { notFound: true });
      } catch (e) { if (e.notFound || e.refused) throw e; /* fall through to the HTML page */ }
    }
    // ...otherwise the HTML page, which works whatever the version and tells us the tag.
    const res = await this.#get(path, { Accept: 'text/html' });
    if (res.status === 404) throw Object.assign(new Error('not listed'), { notFound: true });
    if (!res.ok) throw new Error(`The market answered ${res.status}.`);
    const page = pageFromHtml(await res.text());
    if (!page) throw new Error('The market page could not be read.');
    if (page.version && page.version !== this.version) { this.version = page.version; store.set('market.version', page.version); }
    return page;
  }

  // JSON API: find the item's id, then its open offers (sell side, then buy side).
  async #fromApi(slug) {
    const search = await this.#json(`/api/items?q=${encodeURIComponent(slug)}&include_unlisted=1`);
    const item = Array.isArray(search) ? search.find(i => i.slug === slug) : null;
    if (!item) throw Object.assign(new Error('not listed'), { notFound: true });
    for (const type of ['sell', 'buy']) {
      await sleep(this.gapMs);
      const page = await this.#json(`/api/items/${item.id}?type=${type}`);
      const found = priceFromListings(page?.data || (Array.isArray(page) ? page : []));
      if (found) return found;
    }
    return null;
  }

  async #json(path) {
    const res = await this.#get(path, { Accept: 'application/json' });
    if (res.status === 404) throw Object.assign(new Error('not listed'), { notFound: true });
    if (!res.ok) throw new Error(`The market answered ${res.status}.`);
    return res.json();
  }

  async #get(path, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.origin + path, { headers, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
      // Being told to slow down (or turned away) ends this round; the next one starts later.
      if (res.status === 429 || res.status === 403) {
        throw Object.assign(new Error(`The market is turning requests away right now (${res.status}). Try again later.`), { refused: true });
      }
      return res;
    } catch (e) {
      if (e.refused) throw e;
      throw Object.assign(new Error(ctrl.signal.aborted ? 'The market took too long to answer.' : 'The market could not be reached from here.'), { network: true });
    } finally {
      clearTimeout(timer);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
