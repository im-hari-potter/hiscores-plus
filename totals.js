// How many players are ranked in each category, i.e. the bottom half of
// "Top X%". Sources, freshest wins:
//   data/totals.json       written twice a day by the GitHub Action
//   data/totals-seed.json  shipped with the tool
//   localStorage           anything this browser measured itself
// When everything is older than STALE_MS (the Action isn't running), the tool
// measures stale categories itself, slowly, behind anything you click on.

import { findTotal, PAGE_SIZE } from './totals-core.js';
import { CATEGORY_IDS } from './skills.js';
import { store } from './store.js';

export const STALE_MS = 36 * 3600e3;

export class Totals extends EventTarget {
  constructor(api) {
    super();
    this.api = api;
    this.data = {};          // id -> { total, at, source }
    this.job = null;         // { ids, done, current, cancelled }
    this.loaded = this.#load();
  }

  async #load() {
    for (const [file, source] of [['data/totals.json', 'daily job'], ['data/totals-seed.json', 'bundled']]) {
      try {
        const res = await fetch(file, { cache: 'no-cache' });
        if (!res.ok) continue;
        const json = await res.json();
        const at = Date.parse(json.updated);
        if (!Number.isFinite(at) || !json.totals) continue;
        for (const [id, total] of Object.entries(json.totals)) {
          const checked = Date.parse(json.checked?.[id] ?? '') || at;
          this.#offer(Number(id), Number(total), checked, source);
        }
      } catch (e) { /* missing file or offline: fine */ }
    }
    const local = store.get('totals', {});
    for (const [id, v] of Object.entries(local)) this.#offer(Number(id), v.t, v.at, 'this browser');
    this.#emit();
  }

  #offer(id, total, at, source) {
    if (!Number.isFinite(total) || total < 0 || !Number.isFinite(at)) return;
    const cur = this.data[id];
    if (!cur || at > cur.at) this.data[id] = { total, at, source };
  }

  #record(id, total) {
    this.data[id] = { total, at: Date.now(), source: 'this browser' };
    const local = store.get('totals', {});
    local[id] = { t: total, at: this.data[id].at };
    store.set('totals', local);
    this.#emit(id);
  }

  #emit(id = null) { this.dispatchEvent(new CustomEvent('update', { detail: { id, job: this.jobStatus() } })); }

  get(id) { return this.data[id] || null; }

  // The total to divide by for someone at `rank`. A total that is older than
  // the player's rank can't be right, so the rank itself is the floor.
  for(id, rank) {
    const e = this.data[id];
    if (!e) return null;
    return rank > e.total ? { ...e, total: rank, floor: true } : e;
  }

  isStale(id) {
    const e = this.data[id];
    return !e || Date.now() - e.at > STALE_MS;
  }

  newest() {
    const ats = CATEGORY_IDS.map(id => this.data[id]?.at).filter(Number.isFinite);
    return ats.length ? Math.min(...ats) : null; // the oldest category decides how fresh "all" is
  }

  // A leaderboard page that comes back short tells us the exact total for free.
  observePage(id, rows) {
    if (rows.length > 0 && rows.length < PAGE_SIZE) {
      const last = rows[rows.length - 1].rank;
      if (!this.data[id] || this.data[id].total !== last || this.isStale(id)) this.#record(id, last);
    }
  }

  jobStatus() {
    if (!this.job) return null;
    return { done: this.job.done, count: this.job.ids.length, current: this.job.current };
  }

  // Measure the given categories (all stale ones when ids is omitted).
  async refresh({ ids, force = false } = {}) {
    await this.loaded;
    if (this.job) return this.job.promise;
    const list = (ids || CATEGORY_IDS).filter(id => force || this.isStale(id));
    if (!list.length) return;
    // Overall first: every skill's total is below it, which makes a good ceiling.
    list.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : 0));
    const job = { ids: list, done: 0, current: null, cancelled: false };
    this.job = job;
    job.promise = (async () => {
      try {
        for (const id of list) {
          if (job.cancelled) break;
          job.current = id;
          this.#emit();
          const known = this.data[id]?.total;
          const overall = this.data[0];
          const upper = id !== 0 && overall && Date.now() - overall.at < 3600e3 ? overall.total + PAGE_SIZE : undefined;
          try {
            const res = await findTotal(
              rank => this.api.category(id, rank, { priority: 'bg', cacheMs: 30_000 }),
              { guess: known, upper },
            );
            this.#record(id, res.total);
          } catch (e) {
            if (e.kind === 'cancelled') break;
            if (e.kind === 'blocked') { job.error = e; break; }
            // Anything else: leave this one as it was and move on.
          }
          job.done++;
          this.#emit();
        }
      } finally {
        this.job = null;
        this.#emit();
      }
    })();
    return job.promise;
  }

  cancel() {
    if (!this.job) return;
    this.job.cancelled = true;
    this.api.cancelBackground();
  }
}

// Rank as a share of everyone ranked, in percent: rank 165 of 20,482 -> 0.806.
export function topPercent(rank, total) {
  if (!Number.isFinite(rank) || !Number.isFinite(total) || total <= 0 || rank <= 0) return null;
  return Math.min(100, (rank / total) * 100);
}

// 45.3 / 5.62 / 0.81 / 0.068 - two significant digits below 1%, in the viewer's number format.
export function formatPercent(p) {
  if (p == null) return '';
  if (p >= 10) return p.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (p >= 1) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return p.toLocaleString(undefined, { maximumSignificantDigits: 2 });
}
