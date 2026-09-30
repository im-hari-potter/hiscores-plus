// Talking to the Lost City hiscores API.
//
// The API allows one request per ~2 seconds per person (it answers with
// x-ratelimit-limit: 1 and x-ratelimit-reset: 2), so every request goes
// through one queue. Things you clicked on ("fg") always go before background
// work ("bg", e.g. refreshing percentile totals).

import { apiXp } from './skills.js';

export const LIVE_API = 'https://2004.lostcity.rs/api/hiscores';

export class ApiError extends Error {
  /** kind: 'blocked' | 'network' | 'ratelimited' | 'server' | 'badname' | 'cancelled' */
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export const isElectron = () => /Electron\//.test(navigator.userAgent);

// ── Names ─────────────────────────────────────────────────────────────────
// The game stores names in base 37: a-z, 0-9 and "_" (any other character,
// spaces included, becomes "_"), at most 12 characters. Same rules as the
// server, so "Old Badger", "old_badger" and "OLD BADGER" are one player.
const BASE37 = '_abcdefghijklmnopqrstuvwxyz0123456789';

export function toSafeName(name) {
  const s = String(name ?? '').trim();
  let value = 0n;
  for (let i = 0; i < s.length && i < 12; i++) {
    const c = s.charCodeAt(i);
    value *= 37n;
    if (c >= 65 && c <= 90) value += BigInt(c - 64);
    else if (c >= 97 && c <= 122) value += BigInt(c - 96);
    else if (c >= 48 && c <= 57) value += BigInt(c - 48 + 27);
  }
  if (value <= 0n || value % 37n === 0n) return '';
  let out = '';
  while (value > 0n) {
    out = BASE37[Number(value % 37n)] + out;
    value /= 37n;
  }
  return out;
}

export function toDisplayName(name) {
  const safe = toSafeName(name) || String(name ?? '');
  return safe.replace(/_/g, ' ').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export function checkName(input) {
  const s = String(input ?? '').trim();
  if (!s) return 'Enter a player name.';
  if (s.length > 12) return 'Names are at most 12 characters.';
  if (!/^[A-Za-z0-9 _-]+$/.test(s)) return 'Names only use letters, numbers and spaces.';
  if (!toSafeName(s)) return 'That is not a valid name.';
  return null;
}

// ── Profiles ──────────────────────────────────────────────────────────────
// A profile is what we keep for one lookup of one player.
//   stats: { [categoryId]: { level, xp, xp10, rank } }  (skills below 15 are absent)
//   xp10 is the exact XP in tenths, as the API sends it (the planner uses it).
export function parseProfile(name, rows, fetchedAt = Date.now()) {
  const stats = {};
  for (const r of rows) {
    const type = Number(r.type);
    if (!Number.isFinite(type)) continue;
    stats[type] = { level: Number(r.level), xp: apiXp(r.value), xp10: Math.floor(Number(r.value)), rank: Number(r.rank) };
  }
  return { safe: toSafeName(name), name: toDisplayName(name), stats, fetchedAt };
}

// ── The queue ─────────────────────────────────────────────────────────────
// `routes` are the ways to reach the API, tried in order until one works:
//   - straight to 2004.lostcity.rs (always works inside LostKit; in a normal
//     browser only if Lost City allows other websites to read it)
//   - a relay on this page's own site, at ./api/hiscores (set up by the
//     _redirects file when the site is hosted on Netlify)
// The route that worked is remembered for a day.
const ROUTE_KEY = 'lchs.api.route';
const ROUTE_TTL = 24 * 3600e3;

export class HiscoresApi extends EventTarget {
  constructor({ routes = [LIVE_API], minGapMs = 2100, cacheMs = 60_000, timeoutMs = 20_000 } = {}) {
    super();
    this.routes = routes.map(r => r.replace(/\/+$/, ''));
    this.route = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(ROUTE_KEY) || 'null');
      const i = saved ? this.routes.indexOf(saved.route) : -1;
      if (i >= 0 && Date.now() - saved.at < ROUTE_TTL) this.route = i;
    } catch (e) { /* no storage */ }
    this.minGapMs = minGapMs;
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;
    this.queues = { fg: [], bg: [] };
    this.nextAt = 0;
    this.pumping = false;
    this.active = null;
    this.cache = new Map();      // path -> { at, data }
    this.inflight = new Map();   // path -> promise
    this.stats = { requests: 0, limited: 0 };
  }

  get base() { return this.routes[this.route]; }

  status() {
    return {
      fg: this.queues.fg.length + (this.active?.priority === 'fg' ? 1 : 0),
      bg: this.queues.bg.length + (this.active?.priority === 'bg' ? 1 : 0),
      waitMs: Math.max(0, this.nextAt - Date.now()),
    };
  }

  #emit() { this.dispatchEvent(new CustomEvent('queue', { detail: this.status() })); }

  #useRoute(i) {
    this.route = i;
    try { localStorage.setItem(ROUTE_KEY, JSON.stringify({ route: this.routes[i], at: Date.now() })); } catch (e) { /* ignore */ }
  }

  // GET a path under the API (e.g. "/player/zezima"); resolves to parsed JSON.
  get(path, { priority = 'fg', cacheMs = this.cacheMs, force = false } = {}) {
    const hit = this.cache.get(path);
    if (!force && hit && Date.now() - hit.at < cacheMs) return Promise.resolve(hit.data);
    const pending = this.inflight.get(path);
    if (pending) {
      // Someone asked for the same thing already; a foreground ask promotes it.
      if (priority === 'fg') this.#promote(path);
      return pending;
    }
    const promise = new Promise((resolve, reject) => {
      this.queues[priority].push({ path, priority, resolve, reject, attempts: 0 });
    }).finally(() => this.inflight.delete(path));
    this.inflight.set(path, promise);
    this.#emit();
    this.#pump();
    return promise;
  }

  #promote(path) {
    const i = this.queues.bg.findIndex(item => item.path === path);
    if (i >= 0) {
      const [item] = this.queues.bg.splice(i, 1);
      item.priority = 'fg';
      this.queues.fg.push(item);
      this.#emit();
    }
  }

  // Drop queued background work (e.g. when a totals refresh is stopped).
  cancelBackground() {
    const dropped = this.queues.bg.splice(0);
    for (const item of dropped) item.reject(new ApiError('cancelled', 'Cancelled'));
    this.#emit();
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queues.fg.length || this.queues.bg.length) {
        const wait = this.nextAt - Date.now();
        if (wait > 0) { this.#emit(); await sleep(wait); continue; } // re-check: fg may have arrived
        const item = this.queues.fg.shift() || this.queues.bg.shift();
        this.active = item;
        this.#emit();
        await this.#run(item);
        this.active = null;
      }
    } finally {
      this.pumping = false;
      this.#emit();
    }
  }

  // If the tool is open in more than one tab or window, they share one rate
  // limit (it's per connection), so they take turns: a Web Lock makes them go
  // one at a time, and the next allowed moment is shared in storage.
  async #run(item) {
    const shared = 'lchs.api.nextAt';
    const turn = async () => {
      let other = 0;
      try { other = Number(localStorage.getItem(shared)) || 0; } catch (e) { /* storage blocked */ }
      const wait = Math.min(other, Date.now() + 15_000) - Date.now();
      if (wait > 0) await sleep(wait);
      try { await this.#send(item); }
      finally { try { localStorage.setItem(shared, String(this.nextAt)); } catch (e) { /* ignore */ } }
    };
    if (navigator.locks?.request) await navigator.locks.request('lchs-api', turn);
    else await turn();
  }

  // This route can't be used from here: move on to the next one, if any.
  #nextRoute(item) {
    if (this.route < this.routes.length - 1) {
      this.#useRoute(this.route + 1);
      this.queues[item.priority].unshift(item);
      return true;
    }
    return false;
  }

  async #send(item) {
    item.attempts++;
    this.stats.requests++;
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.base + item.path, { headers: { Accept: 'application/json' }, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      clearTimeout(timer);
      this.nextAt = Date.now() + (ctrl.signal.aborted ? this.minGapMs : 300);
      // A browser refusing a cross-site read looks exactly like this, so try the next route.
      if (!ctrl.signal.aborted && this.#nextRoute(item)) return;
      if (item.priority === 'bg' && item.attempts < 3) { this.queues.bg.push(item); return; }
      item.reject(!isElectron() && !ctrl.signal.aborted
        ? new ApiError('blocked', 'This browser is not allowed to read the Lost City hiscores from this address.')
        : new ApiError('network', ctrl.signal.aborted ? 'The hiscores API took too long to answer.' : 'Could not reach the hiscores API.'));
      return;
    }
    clearTimeout(timer);

    // A relay that isn't set up answers with the host's own 404 page.
    const type = res.headers.get('content-type') || '';
    if ((res.status === 404 || res.status === 405) && !type.includes('json')) {
      this.nextAt = Date.now() + 300;
      if (this.#nextRoute(item)) return;
      item.reject(new ApiError('blocked', 'This browser is not allowed to read the Lost City hiscores from this address.', res.status));
      return;
    }

    // Pace the next request from what the API told us, or fall back to the known limit.
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.status === 429) {
      this.stats.limited++;
      const ms = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500) + 300;
      this.nextAt = Date.now() + Math.min(ms, 15_000);
      if (item.attempts < 6) { this.queues[item.priority].unshift(item); return; }
      item.reject(new ApiError('ratelimited', 'The hiscores API is busy. Try again in a moment.', 429));
      return;
    }
    if (res.headers.has('x-ratelimit-reset') && Number.isFinite(reset) && Number.isFinite(remaining)) {
      this.nextAt = remaining > 0 ? Date.now() + 50 : Date.now() + Math.min(Math.max(reset * 1000 + 150, 500), 10_000);
    } else {
      this.nextAt = started + this.minGapMs;
    }

    if (!res.ok) {
      if (item.priority === 'bg' && item.attempts < 3 && res.status >= 500) { this.queues.bg.push(item); return; }
      item.reject(new ApiError('server', `The hiscores API answered ${res.status}.`, res.status));
      return;
    }
    try {
      const data = await res.json();
      this.cache.set(item.path, { at: Date.now(), data });
      if (this.routes.length > 1) this.#useRoute(this.route);   // remember what worked
      item.resolve(data);
    } catch (e) {
      if (this.#nextRoute(item)) return;   // e.g. an HTML page where JSON was expected
      item.reject(new ApiError('server', 'The hiscores API sent something unreadable.'));
    }
  }

  // ── Endpoints ───────────────────────────────────────────────────────────

  // Resolves to a profile, or null when the name has no hiscores entry.
  async player(name, opts = {}) {
    const safe = toSafeName(name);
    if (!safe) throw new ApiError('badname', 'That is not a valid name.');
    const rows = await this.get(`/player/${encodeURIComponent(safe)}`, opts);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return parseProfile(name, rows);
  }

  // The 21 ranks ending at `rank` (the API's own paging).
  async category(type, rank, opts = {}) {
    const rows = await this.get(`/category/${type}?rank=${Math.max(1, Math.floor(rank))}`, opts);
    if (!Array.isArray(rows)) return [];
    return rows.map(r => ({
      safe: toSafeName(r.username),
      name: toDisplayName(r.username),
      level: Number(r.level),
      xp: apiXp(r.value),
      xp10: Math.floor(Number(r.value)),
      rank: Number(r.rank),
    }));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
