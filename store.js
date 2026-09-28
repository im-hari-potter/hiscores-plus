// Everything the tool remembers lives in this browser's localStorage, under
// keys starting with "lchs.". Inside LostKit that storage survives restarts.
// Every access is wrapped: storage can be full, disabled or cleared.

import { CATEGORY_IDS } from './skills.js';
import { toSafeName, toDisplayName } from './api.js';

const PREFIX = 'lchs.';

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
  },
  keys() {
    try { return Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)); }
    catch (e) { return []; }
  },
};

// ── Saved and recent players ──────────────────────────────────────────────
const MAX_SAVED = 30;
const MAX_RECENT = 10;

export const players = {
  saved() { return store.get('saved', []); },
  isSaved(name) {
    const safe = toSafeName(name);
    return this.saved().some(n => toSafeName(n) === safe);
  },
  toggleSaved(name) {
    const safe = toSafeName(name);
    const list = this.saved();
    const i = list.findIndex(n => toSafeName(n) === safe);
    if (i >= 0) list.splice(i, 1);
    else list.push(toDisplayName(name));
    store.set('saved', list.slice(0, MAX_SAVED));
    return i < 0;
  },
  recent() { return store.get('recent', []); },
  pushRecent(name) {
    const safe = toSafeName(name);
    const list = this.recent().filter(n => toSafeName(n) !== safe);
    list.unshift(toDisplayName(name));
    store.set('recent', list.slice(0, MAX_RECENT));
  },
  clearRecent() { store.set('recent', []); },
};

// ── Snapshots (XP gain tracking) ──────────────────────────────────────────
// One key per player: "snap.<safe name>" -> [{ t, s }], oldest first.
// s is aligned with CATEGORY_IDS; each entry is [level, xp, rank] or 0 when
// the skill had no hiscores row (below level 15) at the time.
const MAX_SNAPSHOTS = 300;
const KEEP_UNCHANGED_AFTER_MS = 20 * 3600e3; // store an unchanged profile at most ~daily (for rank history)

const encode = stats => CATEGORY_IDS.map(id => (stats[id] ? [stats[id].level, stats[id].xp, stats[id].rank] : 0));
export const decode = s => {
  const stats = {};
  CATEGORY_IDS.forEach((id, i) => { if (s[i]) stats[id] = { level: s[i][0], xp: s[i][1], rank: s[i][2] }; });
  return stats;
};

export const snapshots = {
  index() { return store.get('snapIndex', {}); },

  list(name) {
    const safe = toSafeName(name);
    return store.get('snap.' + safe, []).map(snap => ({ t: snap.t, stats: decode(snap.s) }));
  },

  // Saves the profile unless nothing changed since the last snapshot.
  // Returns the previous snapshot (if any) so the caller can show gains.
  add(profile) {
    const safe = profile.safe;
    if (!safe) return { saved: false, previous: null };
    const key = 'snap.' + safe;
    const list = store.get(key, []);
    const last = list[list.length - 1] || null;
    const s = encode(profile.stats);
    const sameXp = last && last.s.length === s.length &&
      s.every((v, i) => (v ? v[1] : -1) === (last.s[i] ? last.s[i][1] : -1));
    const previous = last ? { t: last.t, stats: decode(last.s) } : null;
    if (sameXp && profile.fetchedAt - last.t < KEEP_UNCHANGED_AFTER_MS) return { saved: false, previous };

    list.push({ t: profile.fetchedAt, s });
    // Over the cap: drop the second-oldest, so the very first snapshot survives.
    while (list.length > MAX_SNAPSHOTS) list.splice(1, 1);
    let ok = store.set(key, list);
    if (!ok) { // storage full: thin this player's history and retry once
      while (list.length > 20) list.splice(1, 1);
      ok = store.set(key, list);
    }
    const index = this.index();
    index[safe] = { name: profile.name, count: list.length, last: profile.fetchedAt };
    store.set('snapIndex', index);
    return { saved: ok, previous };
  },

  remove(name) {
    const safe = toSafeName(name);
    store.remove('snap.' + safe);
    const index = this.index();
    delete index[safe];
    store.set('snapIndex', index);
  },

  tracked() {
    return Object.entries(this.index())
      .map(([safe, v]) => ({ safe, name: v.name || toDisplayName(safe), count: v.count || 0, last: v.last || 0 }))
      .sort((a, b) => b.last - a.last);
  },
};

// ── Backup ────────────────────────────────────────────────────────────────
export function exportBackup() {
  const data = {};
  for (const key of store.keys()) {
    if (key === 'totals') continue; // cheap to rebuild, not worth carrying around
    data[key] = store.get(key, null);
  }
  return JSON.stringify({ app: 'lc-hiscores-plus', version: 1, exported: new Date().toISOString(), data });
}

// Merges a backup into what is already here. Returns a short summary.
export function importBackup(text) {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.app !== 'lc-hiscores-plus' || typeof parsed.data !== 'object') {
    throw new Error('That does not look like a Hiscores+ backup.');
  }
  let snaps = 0, playersAdded = 0;
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key.startsWith('snap.') && Array.isArray(value)) {
      const current = store.get(key, []);
      const byTime = new Map(current.map(s => [s.t, s]));
      for (const s of value) if (s && Number.isFinite(s.t) && Array.isArray(s.s) && !byTime.has(s.t)) { byTime.set(s.t, s); snaps++; }
      const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
      while (merged.length > MAX_SNAPSHOTS) merged.splice(1, 1);
      store.set(key, merged);
      const safe = key.slice(5);
      const index = snapshots.index();
      index[safe] = { name: index[safe]?.name || toDisplayName(safe), count: merged.length, last: merged[merged.length - 1]?.t || 0 };
      store.set('snapIndex', index);
    } else if (key === 'saved' && Array.isArray(value)) {
      for (const name of value) if (!players.isSaved(name)) { players.toggleSaved(name); playersAdded++; }
    } else if (key === 'prefs' && value && typeof value === 'object') {
      store.set('prefs', { ...store.get('prefs', {}), ...value });
    }
  }
  return { snaps, playersAdded };
}
