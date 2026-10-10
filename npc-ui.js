// Planner+ monster views: the NPCs tab (the database: every monster's stats,
// the XP of a kill and what it drops) and Slayer goals (a plan of kills: the XP
// they give, the loot to expect, what you got, and how lucky that is).
//
// Slayer isn't in this version of the game yet. Its goals are where monster
// plans live meanwhile, so that when the skill comes its tasks are planned
// here, on what's already counted: loot.js (drops, chances, luck, XP), the
// bank, prices and goals. A skill goal trained on monsters (Attack, Strength,
// Defence, Hitpoints, Ranged) makes one for its kills with "Plan the loot".
//
// A Slayer goal: { id, skill: 'slayer', type: 'kills', value (kills planned),
// npc (a monster's id), style (KILL_STYLES), created, ring?, legends?, from?
// (the skill goal it was made for), done? (kills done), got? ({ item: how many
// you got }), banked? (what of got has gone into the bank) }.
// Created by planner-ui.js with what it shares (P).

import { SLAYER, SKILL_BY_KEY, MAX_LEVEL } from './skills.js';
import { ITEMS, MONSTERS, UNID_HERBS } from './gamedata.js';
import { NPC_INFO } from './npcdata.js';
import { killDrops, killXp, KILL_STYLES, atLeastOne, dryChance, killsFor, luck, rateText, styleOfSkillGoal, MONSTER_BY_ID } from './loot.js';
import { levelForXp10, MAX_XP10 } from './planner.js';
import { highAlch } from './prices.js';
import { store } from './store.js';

const MAX_KILLS = 10_000_000;
const STAT_NAMES = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'];
const BONUS_NAMES = { attackbonus: 'Attack', strengthbonus: 'Strength', rangebonus: 'Ranged', stabdefence: 'Stab defence', slashdefence: 'Slash defence', crushdefence: 'Crush defence', rangedefence: 'Ranged defence', magicdefence: 'Magic defence' };
const BANDS = [...new Set(MONSTERS.map(m => m.group))];
const monsterName = m => `${m.name} (level ${m.level})`;
// "at_fire_giant_86" -> "fire_giant_86": a combat skill's row and its monster
export const monsterOfMethod = id => (/^(at|st|df|hp|rg)_/.test(id) ? id.slice(3) : null);
export const isSlayerGoal = g => g?.skill === SLAYER.key;
// A goal's style, one a kill of it can be fought in (only Magic hurts a battle mage).
function styleFor(npc, style) {
  if (killXp(npc, style)) return style;
  return KILL_STYLES.find(s => killXp(npc, s.id))?.id || 'accurate';
}
// How sure: 0.2084 -> "21%", 0.0004 -> "0.04%", 0.99996 -> "99.996%"
export function chanceText(p) {
  if (p >= 1) return '100%';
  if (p <= 0) return '0%';
  const x = p * 100;
  if (x < 0.0001) return 'under 0.0001%';
  if (x >= 99.5) { for (let d = 1; d <= 6; d++) { const t = x.toFixed(d); if (Number(t) < 100) return `${t.replace(/0+$/, '').replace(/\.$/, '')}%`; } return '>99.9999%'; }
  if (x >= 10) return `${Math.round(x)}%`;
  if (x >= 1) return `${x.toFixed(1).replace(/\.0$/, '')}%`;
  if (x >= 0.01) return `${x.toPrecision(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
  return `${x.toPrecision(1)}%`;
}
// "about 1 in 5", "about 1 in 1,240"
export function oneIn(p) {
  if (p <= 0) return 'never';
  if (p >= 0.5) return null;
  const n = 1 / p;
  return `about 1 in ${n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 10 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')}`;
}
// "1.56 ×": kills against the drop rate's kills
const timesText = x => `${x >= 10 ? Math.round(x) : x.toFixed(2).replace(/\.?0+$/, '')} ×`;

// What going dry means, in words: "Rune scimitar: 200 kills without one is 1.56 ×
// the drop rate (1/128). Going this dry happens to 21% of players (about 1 in 4.8)."
export function drySentence(name, p, kills) {
  if (!(p > 0) || p >= 1 || !(kills > 0)) return '';
  const dry = dryChance(p, kills);
  const one = oneIn(dry);
  return `${name}: ${kills.toLocaleString('en-US')} kill${kills === 1 ? '' : 's'} without one is ${timesText(kills * p)} the drop rate (${rateText(p)}). Going this dry happens to ${chanceText(dry)} of players${one ? ` (${one})` : ''}.`;
}

export function createNpcUi(P) {
  const { esc, fmt, gpShort, xpText, iconImg, itemIcon, itemName, marketLink, priceTip, prices, S, $ } = P;
  // ── Prefs of the NPCs tab ───────────────────────────────────────────────
  const saved = store.get('npcUi', {});
  const N = {
    q: '',
    band: BANDS.includes(saved.band) ? saved.band : null,
    sort: ['level', 'name', 'xp', 'loot', 'hp'].includes(saved.sort) ? saved.sort : 'level',
    dir: saved.dir === -1 ? -1 : 1,
    style: KILL_STYLES.some(s => s.id === saved.style) ? saved.style : 'accurate',
    ring: !!saved.ring,
    legends: !!saved.legends,
    open: null,                       // the monster shown on its own, or null for the list
    kills: {},                        // monster id -> kills typed into its Plan kills box
  };
  const saveNpcUi = () => store.set('npcUi', { band: N.band, sort: N.sort, dir: N.dir, style: N.style, ring: N.ring, legends: N.legends });
  // A goal's loot read from screenshots, waiting for you to check it: goal id -> { busy | error | rows, … }
  const shots = new Map();
  // A goal's dry checker: goal id -> { item, kills }
  const dryPick = new Map();
  // A goal's loot table sort: goal id -> 'value' | 'chance' | 'name'
  const lootSort = new Map();

  // ── Drops and their worth ───────────────────────────────────────────────
  // (worked out once for each monster and pair of options)
  const DROPS = new Map();
  function dropsOf(npc, { ring = false, legends = false } = {}) {
    const key = `${npc}|${ring ? 1 : 0}${legends ? 1 : 0}`;
    if (!DROPS.has(key)) DROPS.set(key, killDrops(npc, { ring, legends }));
    return DROPS.get(key);
  }
  // An item's worth for loot: its price, and nothing for what can't be sold
  // (a quest item; a clue scroll is worth nothing at the market).
  const untradeable = slug => !!ITEMS[slug]?.untradeable && (ITEMS[slug]?.gp == null || !!ITEMS[slug]?.clue);
  const worthOf = slug => (untradeable(slug) ? 0 : prices.priceOf(slug));
  // For the database list, where most prices haven't been checked: high alch stands in.
  const roughWorth = slug => { const p = worthOf(slug); return p != null ? { gp: p, rough: false } : { gp: highAlch(slug) || 0, rough: true }; };
  // The average loot of a kill: { total, missing (no price), rough (high alch stood in) }
  function lootValue(drops, rough = false) {
    let total = 0, roughOnes = 0;
    const missing = [];
    for (const [slug, d] of drops) {
      if (rough) { const w = roughWorth(slug); total += d.q * w.gp; if (w.rough && d.q * w.gp > 0) roughOnes++; continue; }
      const gp = worthOf(slug);
      if (gp == null) { missing.push(slug); continue; }
      total += d.q * gp;
    }
    return { total, missing, rough: roughOnes };
  }
  // Which items to ask the market for: a monster's drops that can be sold.
  const sellable = drops => [...drops.keys()].filter(s => !untradeable(s) && ITEMS[s]?.gp == null);

  // "150", "2–12", "150 or 37": how many one drop of it is
  function amountText(d) {
    const counts = new Set();
    let lo = Infinity, hi = 0;
    for (const part of d.parts) {
      const [a, b] = Array.isArray(part.count) ? part.count : [part.count, part.count];
      counts.add(a === b ? fmt(a) : `${fmt(a)}–${fmt(b)}`);
      lo = Math.min(lo, a); hi = Math.max(hi, b);
    }
    const list = [...counts];
    // (coins come in many amounts: from the least to the most)
    return list.length > 3 ? `${fmt(lo)}–${fmt(hi)}` : list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}` : list[0];
  }
  // Where an item comes from, for its tooltip: "Rare drop table (1/128 of kills): 20/128 of its rolls …"
  const FROM = { main: 'its own drop table', always: 'every kill', clue: 'a clue scroll (members, while you hold none)', randomherb: 'the herb table', randomjewel: 'the gem table', ultrarare_getitem: 'the rare drop table', megararetable: 'the mega rare table', randomjunk: 'the junk table' };
  function fromText(d) {
    const by = new Map();
    for (const part of d.parts) by.set(part.from, (by.get(part.from) || 0) + part.p);
    return [...by].map(([from, p]) => `${rateText(p)} from ${FROM[from] || from}`).join('; ');
  }
  const noted = d => d.parts.some(x => x.noted);

  // ── Shared bits ─────────────────────────────────────────────────────────
  const goalOf = id => P.goals().find(g => g.id === id) || null;
  const kills = text => P.parseAmount(text);
  // A monster from what's typed: "Fire giant (level 86)", "fire giant", "giant 86"
  function findMonster(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return { problem: 'Pick a monster: type part of its name, or its name and level.' };
    const exact = MONSTERS.find(m => monsterName(m).toLowerCase() === t || m.id === t);
    if (exact) return { id: exact.id };
    const terms = P.searchTerms(t);
    const hits = MONSTERS.filter(m => P.searchHit(m.name.toLowerCase(), m.level, terms));
    const named = hits.filter(m => m.name.toLowerCase() === t);
    if (named.length === 1) return { id: named[0].id };
    if (hits.length === 1) return { id: hits[0].id };
    if (!hits.length) return { problem: `No monster matches <b>${esc(text)}</b>. Try part of its name, or its combat level.` };
    const list = (named.length ? named : hits).slice(0, 6).map(m => esc(monsterName(m)));
    return { problem: `Which one? ${list.join(', ')}${hits.length > 6 ? ` and ${hits.length - 6} more` : ''}. Pick it from the list, or add its level.` };
  }
  const datalist = id => `<datalist id="${id}">${MONSTERS.map(m => `<option value="${esc(monsterName(m))}">`).join('')}</datalist>`;
  const styleSelect = (attr, value, npc = null) => `<select class="input small" ${attr} aria-label="Fighting style">${KILL_STYLES.map(s => {
    const ok = !npc || !!killXp(npc, s.id);
    return `<option value="${s.id}"${s.id === value ? ' selected' : ''}${ok ? '' : ' disabled'}>${esc(s.name)}${ok ? '' : ' (not on this monster)'}</option>`;
  }).join('')}</select>`;
  // "+444 Attack XP, +147.6 Hitpoints XP"
  const xpList = (xp, n = 1, unit = '') => Object.entries(xp || {}).filter(([, x]) => x > 0)
    .map(([k, x]) => `<b class="c-xp">+${xpText(x * n)}</b> ${esc(SKILL_BY_KEY.get(k)?.name || k)}${unit}`).join(', ');
  const info = id => NPC_INFO[id] || null;
  const ticks = t => `${t} tick${t === 1 ? '' : 's'} (${(t * 0.6).toFixed(1).replace(/\.0$/, '')} s)`;

  // The monster's own numbers: stats, how it fights, where it is.
  function monsterFacts(m) {
    const i = info(m.id);
    if (!i) return '';
    const stats = STAT_NAMES.map((name, k) => `<span class="nf-stat" title="${esc(name)}">${iconImg(SKILL_BY_KEY.get(name.toLowerCase()))}<b>${fmt(i.stats[k])}</b></span>`).join('');
    const bonus = Object.entries(i.bonus || {}).filter(([, v]) => v).map(([k, v]) => `${BONUS_NAMES[k] || k} ${v > 0 ? '+' : ''}${v}`);
    const facts = [
      `Attacks with ${esc(i.style || 'crush')}`,
      i.speed ? `every ${ticks(i.speed)}` : '',
      i.aggressive ? '<b>aggressive</b>' : '',
      i.respawn ? `back ${ticks(i.respawn)} after a kill` : '',
      i.size > 1 ? `${i.size} by ${i.size} squares` : '',
      m.n === 1 ? 'one of a kind' : `${fmt(m.n)} in the world${i.under ? ', most of them under ground' : ''}`,
    ].filter(Boolean);
    const bones = m.bones ? `Leaves ${itemName(m.bones)}` : 'Leaves nothing to bury';
    return `<div class="nf">
      <div class="nf-stats">${stats}</div>
      <div class="c-faint small-note">${facts.join(' · ')} · ${bones}${bonus.length ? `<br>Bonuses: ${esc(bonus.join(', '))}` : ''}</div>
      ${i.examine ? `<div class="nf-examine c-muted small-note">“${esc(i.examine)}”</div>` : ''}
      ${m.note ? `<div class="c-faint small-note">* ${esc(m.note)}</div>` : ''}
    </div>`;
  }

  // ── The NPCs tab ────────────────────────────────────────────────────────
  function renderNpcs() {
    P.renderAccount('npcs-account', 'npcs');
    const body = $('npcs-body');
    if (!body) return;
    const m = N.open && MONSTER_BY_ID.get(N.open);
    if (m) { body.innerHTML = npcPage(m); return; }
    N.open = null;
    body.innerHTML = npcList();
    applyNpcSearch();
  }

  // Every monster: a row each, with the XP and loot of a kill.
  function npcList() {
    const opts = { ring: N.ring, legends: N.legends };
    const rows = MONSTERS.map(m => {
      const xp = killXp(m.id, N.style);
      const xpOwn = xp ? Object.values(xp).reduce((a, x) => a + x, 0) : -1;
      const drops = dropsOf(m.id, opts);
      const value = lootValue(drops, true);
      return { m, xp, xpOwn, drops, value };
    });
    const by = {
      level: (a, b) => a.m.level - b.m.level || a.m.name.localeCompare(b.m.name),
      name: (a, b) => a.m.name.localeCompare(b.m.name) || a.m.level - b.m.level,
      xp: (a, b) => b.xpOwn - a.xpOwn || a.m.level - b.m.level,
      loot: (a, b) => b.value.total - a.value.total || a.m.level - b.m.level,
      hp: (a, b) => b.m.hp - a.m.hp || a.m.level - b.m.level,
    }[N.sort];
    rows.sort((a, b) => by(a, b) * (N.sort === 'level' || N.sort === 'name' ? N.dir : 1));
    const style = KILL_STYLES.find(s => s.id === N.style);
    const tr = ({ m, xp, drops, value }) => {
      // the three drops worth most on average (what a kill is mostly worth)
      const best = [...drops].map(([slug, d]) => [slug, d, d.q * roughWorth(slug).gp]).filter(([, , v]) => v > 0).sort((a, b) => b[2] - a[2]).slice(0, 4);
      const title = `${monsterName(m)}: ${fmt(m.hp)} hitpoints${m.n === 1 ? ', one of a kind' : `, ${fmt(m.n)} in the world`}${m.note ? `\n${m.note}` : ''}\nClick for its stats, every drop and a plan of kills.`;
      return `<tr data-npc="${m.id}" data-find="${esc(m.name.toLowerCase())}" data-cb="${m.level}" data-grp="${esc(m.group)}" title="${esc(title)}">
        <td>${m.level}</td>
        <td class="l"><span class="sk-cell"><button type="button" class="linkish npc-name" data-npc-open="${m.id}">${esc(m.name)}</button>${m.note ? ' <span class="catch" aria-hidden="true">*</span>' : ''}</span></td>
        <td>${fmt(m.hp)}</td>
        <td class="l">${xp ? `<span class="small-note">${xpList(xp)}</span>` : '<span class="c-faint small-note">Magic only</span>'}</td>
        <td title="${esc(value.rough ? `${value.rough} of its drops have no market price checked yet: their high alch stands in. Its own page checks them.` : 'The average loot of a kill at your prices')}">${value.total ? `${value.rough ? '≈' : ''}${gpShort(value.total)}` : '<span class="c-faint">–</span>'}</td>
        <td class="l npc-best">${best.map(([slug, d]) => `<span title="${esc(`${ITEMS[slug]?.name || slug}: ${rateText(d.p)} a kill`)}">${itemIcon(slug, true)}</span>`).join('')}</td>
        <td><button type="button" class="btn small" data-npc-open="${m.id}" data-npc-plan="1" title="Open it, with a plan of kills to add as a Slayer goal">Plan kills</button></td>
      </tr>`;
    };
    const groups = N.sort === 'level' ? BANDS : [null];
    // (every row is there, for the search to show: applyNpcSearch hides what the band leaves out)
    const body = groups.map(g => {
      const list = g ? rows.filter(r => r.m.group === g) : rows;
      return (g ? `<tr class="grp" data-grp="${esc(g)}"><td colspan="7">${esc(g)}</td></tr>` : '') + list.map(tr).join('');
    }).join('');
    const sBtn = (k, label, tip) => `<button type="button" class="${N.sort === k ? 'on' : ''}" data-npc-sort="${k}" title="${esc(tip)}" aria-pressed="${N.sort === k}">${label}${N.sort === k && (k === 'level' || k === 'name') ? (N.dir === 1 ? ' ▲' : ' ▼') : ''}</button>`;
    const band = (g, label) => `<button type="button" class="chip${(N.band || 'all') === g ? ' on' : ''}" data-npc-band="${esc(g)}" aria-pressed="${(N.band || 'all') === g}">${esc(label)}</button>`;
    return `<div class="card npc-db">
      <div class="bar wrap find-bar"><input class="input small find-in" type="search" data-npc-search="1" value="${esc(N.q)}" placeholder="Search monsters: a name, or a combat level" aria-label="Search monsters" autocomplete="off" spellcheck="false">
        <span class="c-faint small-note" data-npc-found></span></div>
      <div class="group-pick" role="group" aria-label="Combat levels">${BANDS.map(g => band(g, g)).join('')}${band('all', 'All')}</div>
      <div class="bar wrap">
        <span class="c-muted small-note">XP in</span> ${styleSelect('data-npc-style="1"', N.style)}
        <label class="check" title="A ring of wealth makes the gem table's rolls land on a gem more often (from 1 in 128 rolls of nothing to none)"><input type="checkbox" data-npc-opt="ring"${N.ring ? ' checked' : ''}> Ring of wealth</label>
        <label class="check" title="With Legends' Quest done, the gem table's rarest roll is the mega rare table instead of a talisman"><input type="checkbox" data-npc-opt="legends"${N.legends ? ' checked' : ''}> Legends' Quest done</label>
        <span class="grow"></span>
        <span class="c-muted small-note">Sort</span><div class="seg">${sBtn('level', 'Level', 'By combat level (again: the other way)')}${sBtn('name', 'Name', 'A to Z (again: Z to A)')}${sBtn('xp', 'XP a kill', 'Most XP a kill first, in the style picked')}${sBtn('loot', 'Loot a kill', 'Most loot a kill first, at your prices (high alch where none is checked yet)')}${sBtn('hp', 'HP', 'Most hitpoints first')}</div>
      </div>
      <p class="note">Every monster, ${fmt(MONSTERS.length)} of them, with the server's own numbers: its stats, the XP a kill gives (a point of damage is 4 XP to the style's skill and 1.33 to Hitpoints) and its drop table, read from the server's scripts and checked against <a href="https://2004.losthq.rs/?p=npcdb" target="_blank" rel="noopener">LostHQ's NPC database</a> (where the two differ, the server's is used). Drops assume a members world. Loot a kill is the average at your prices; ≈ where some drops have no market price checked yet (their high alch stands in). Click a monster for every drop and a plan of kills.</p>
      <div class="table-wrap"><table class="grid npc-t" data-band="${esc(N.band || '')}">
        <thead><tr><th title="Combat level">Lvl</th><th class="l">Monster</th><th title="Hitpoints: a kill is this much damage">HP</th><th class="l" title="${esc(`The XP of a kill: ${style.name}`)}">XP a kill</th><th title="The average loot of a kill">Loot a kill</th><th class="l" title="What a kill is mostly worth">Best drops</th><th></th></tr></thead>
        <tbody>${body}</tbody></table></div>
    </div>`;
  }

  // The list's search: rows shown or hidden where they stand (typing never redraws it).
  function applyNpcSearch() {
    const table = document.querySelector('#npcs-body table.npc-t');
    if (!table) return;
    const terms = P.searchTerms(N.q);
    const band = table.dataset.band;
    const groups = new Set();
    let n = 0;
    for (const tr of table.querySelectorAll('tr[data-npc]')) {
      const on = terms.length ? P.searchHit(tr.dataset.find, tr.dataset.cb, terms) : !band || tr.dataset.grp === band;
      tr.hidden = !on;
      if (on) { n++; groups.add(tr.dataset.grp); }
    }
    for (const tr of table.querySelectorAll('tr.grp')) tr.hidden = !groups.has(tr.dataset.grp);
    const out = document.querySelector('[data-npc-found]');
    if (out) out.textContent = !terms.length ? '' : n ? `${fmt(n)} found, whatever their level` : 'No monster matches that. Try part of its name, or its combat level.';
    for (const chip of document.querySelectorAll('#npcs-body [data-npc-band]')) {
      const on = !terms.length && chip.dataset.npcBand === (band || 'all');
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', String(on));
    }
  }

  // One monster: its numbers, the XP of a kill in each style, every drop, and a plan of kills.
  function npcPage(m) {
    const opts = { ring: N.ring, legends: N.legends };
    const drops = dropsOf(m.id, opts);
    prices.want(sellable(drops));
    const value = lootValue(drops);
    const xpRows = KILL_STYLES.map(s => {
      const xp = killXp(m.id, s.id);
      return `<tr${s.id === N.style ? ' class="hl"' : ''}><td class="l">${esc(s.name)}</td><td class="l">${xp ? xpList(xp) : '<span class="c-faint">can\'t be used on it</span>'}</td></tr>`;
    }).join('');
    const typed = N.kills[m.id] ?? '';
    const plans = P.goals().filter(g => isSlayerGoal(g) && g.npc === m.id);
    const account = P.account();
    const planBox = !account
      ? `<p class="note">Enter your username above to plan kills: a plan is a Slayer goal of that account's.</p>`
      : `<form class="bar wrap" data-form="npc-plan" autocomplete="off">
          <span class="c-muted">Plan</span>
          <input class="input small num" name="kills" inputmode="numeric" placeholder="Kills" value="${esc(String(typed))}" aria-label="Kills to plan" data-npc-kills="${m.id}">
          <span class="c-muted">kills in</span> ${styleSelect('name="style"', styleFor(m.id, N.style), m.id)}
          <button class="btn small" type="submit">Add a Slayer goal</button>
          <span class="c-faint small-note">For ${esc(account)}: the XP, the loot to expect and the chance of each drop over those kills, then what you get.</span>
        </form>
        ${plans.length ? `<div class="c-faint small-note">Already planned: ${plans.map(g => `<button type="button" class="linkish" data-act="npc-goto" data-goal-id="${g.id}">${fmt(g.value)} kills</button>`).join(', ')}</div>` : ''}`;
    return `<div class="card npc-page" data-npc-page="${m.id}">
      <div class="npc-head"><button type="button" class="linkish" data-act="npc-back">‹ All monsters</button>
        <h3>${esc(m.name)} <span class="c-faint">level ${m.level}</span></h3><span class="grow"></span>
        <span class="c-muted small-note">${fmt(m.hp)} hitpoints</span></div>
      ${monsterFacts(m)}
      <div class="plan-sec"><h4>Plan kills</h4>${planBox}</div>
      <div class="plan-sec"><h4>XP a kill</h4>
        <div class="table-wrap"><table class="grid xp-t"><thead><tr><th class="l">Style</th><th class="l">XP</th></tr></thead><tbody>${xpRows}</tbody></table></div>
        <div class="c-faint small-note">A point of damage is 4 XP to the style's skill (Controlled: 1.33 to each of Attack, Strength and Defence; Longrange: 2 to Ranged and Defence) and 1.33 to Hitpoints, whatever the style. Magic is the 2 XP a point of damage only: each cast's own XP depends on the spell.</div>
      </div>
      <div class="plan-sec"><h4>Drops <span class="c-faint">(a kill is worth ${value.missing.length ? 'about' : ''} <b>${gpShort(value.total)}</b> gp on average${value.missing.length ? `, ${value.missing.length} without a price yet` : ''})</span></h4>
        <div class="bar wrap">
          <label class="check"><input type="checkbox" data-npc-opt="ring"${N.ring ? ' checked' : ''}> Ring of wealth</label>
          <label class="check"><input type="checkbox" data-npc-opt="legends"${N.legends ? ' checked' : ''}> Legends' Quest done</label>
          <span class="c-faint small-note">Members world. A clue scroll drops only while you hold none.</span>
        </div>
        ${dropTable(drops, null)}
      </div>
    </div>`;
  }

  // A monster's drops: per kill, or over a plan's kills (n) with what you got after done.
  // goal: a Slayer goal (its loot table), or null (the NPCs tab)
  function dropTable(drops, goal) {
    const n = goal ? goal.value : 1;
    const done = goal ? goal.done || 0 : 0;
    const got = goal?.got || {};
    const sort = goal ? lootSort.get(goal.id) || 'value' : 'value';
    const list = [...drops].map(([slug, d]) => ({ slug, d, gp: worthOf(slug) }));
    const val = x => (x.gp == null ? -1 : x.d.q * x.gp);
    if (sort === 'value') list.sort((a, b) => val(b) - val(a) || b.d.p - a.d.p);
    else if (sort === 'chance') list.sort((a, b) => b.d.p - a.d.p || val(b) - val(a));
    else list.sort((a, b) => itemName(a.slug).localeCompare(itemName(b.slug)));
    // ...and anything you got that it doesn't drop (typed in by hand before the monster was changed)
    const extra = goal ? Object.keys(got).filter(s => got[s] > 0 && !drops.has(s)) : [];
    const head = goal
      ? `<th class="l">Item</th><th title="The chance a kill drops it, as the drop table has it">A kill</th><th title="How many one drop is">Each drop</th><th title="How many on average in ${esc(fmt(n))} kills">Expected</th><th class="wrap" title="The chance of at least one in ${esc(fmt(n))} kills">At least one<br>in ${esc(gpShort(n))}</th><th title="Expected, at your prices">Value</th>${done ? `<th class="wrap sep-l" title="How many on average after the ${esc(fmt(done))} kills you've done">Expected<br>after ${esc(gpShort(done))}</th><th class="wrap" title="What you got: type it in, or − and + by one drop">You got</th><th class="l" title="How what you got compares with other players after as many kills">Luck</th>` : `<th class="wrap sep-l" title="What you got: type it in, or − and + by one drop">You got</th>`}`
      : `<th class="l">Item</th><th title="The chance a kill drops it, as the drop table has it">A kill</th><th title="How many one drop is">Each drop</th><th title="How many a kill gives on average">Average</th><th title="The kills it takes for an even chance of one, and for 9 in 10">Kills for 50% / 90%</th><th title="The average a kill gives, at your prices">Value a kill</th>`;
    const row = ({ slug, d, gp }) => {
      const it = ITEMS[slug];
      const name = `${itemIcon(slug, true)} ${itemName(slug)}${noted(d) ? ' <span class="c-faint small-note">(noted)</span>' : ''}`;
      const title = `${it?.name || slug}: ${fromText(d)}${untradeable(slug) ? '\nCan\'t be traded: not counted in the value.' : `\n${priceTip(slug)}`}`;
      const link = untradeable(slug) || it?.gp != null ? `<span class="sk-cell">${name}</span>` : `<a class="sk-cell mk" ${marketLink(slug)}>${name}</a>`;
      const value = untradeable(slug) ? '<span class="c-faint">–</span>' : gp == null ? '<span class="c-faint">?</span>' : gpShort(d.q * n * gp);
      if (!goal) {
        const half = killsFor(d.p, 0.5), most = killsFor(d.p, 0.9);
        return `<tr title="${esc(title)}"><td class="l">${link}</td><td>${esc(rateText(d.p))}</td><td>${esc(amountText(d))}</td><td>${amt(d.q)}</td><td>${d.p >= 1 ? '1' : `${fmt(half)} / ${fmt(most)}`}</td><td>${value}</td></tr>`;
      }
      const at1 = atLeastOne(d.p, n);
      let doneCells = '';
      if (done) {
        const g = got[slug] || 0;
        doneCells = `<td class="sep-l">${amt(d.q * done)}</td><td class="got">${gotBox(slug, g, d)}</td><td class="l small-note">${luckText(slug, d, done, g)}</td>`;
      } else doneCells = `<td class="got sep-l">${gotBox(slug, got[slug] || 0, d)}</td>`;
      return `<tr title="${esc(title)}" data-loot="${slug}"><td class="l">${link}</td><td>${esc(rateText(d.p))}</td><td>${esc(amountText(d))}</td><td>${amt(d.q * n)}</td><td>${d.p >= 1 ? '–' : chanceText(at1)}</td><td>${value}</td>${doneCells}</tr>`;
    };
    const extraRows = extra.map(slug => `<tr data-loot="${slug}" title="${esc(`${ITEMS[slug]?.name || slug}: not something this monster drops`)}"><td class="l"><span class="sk-cell">${itemIcon(slug, true)} ${itemName(slug)} <span class="c-faint small-note">(not its drop)</span></span></td><td colspan="5"></td>${done ? `<td class="sep-l"></td><td class="got">${gotBox(slug, got[slug], null)}</td><td></td>` : `<td class="got sep-l">${gotBox(slug, got[slug], null)}</td>`}</tr>`).join('');
    const sBtn = (k, label) => `<button type="button" class="${sort === k ? 'on' : ''}" data-loot-sort="${k}" aria-pressed="${sort === k}">${label}</button>`;
    return `${goal ? `<div class="bar wrap"><span class="c-muted small-note">Sort</span><div class="seg">${sBtn('value', 'Value')}${sBtn('chance', 'Chance')}${sBtn('name', 'A to Z')}</div></div>` : ''}
      <div class="table-wrap"><table class="grid loot-t"><thead><tr>${head}</tr></thead><tbody>${list.map(row).join('')}${extraRows}</tbody></table></div>`;
  }
  // an amount on average: whole numbers as they are, small ones to two places
  const amt = x => (x >= 100 ? fmt(Math.round(x)) : x >= 10 ? x.toFixed(1).replace(/\.0$/, '') : x >= 0.01 ? x.toFixed(2).replace(/\.?0+$/, '') : x > 0 ? x.toPrecision(1) : '0');
  // − and + go a drop at a time: an item every drop of which is the same amount (a rune scimitar), else one
  const stepOf = d => (d?.one > 0 ? d.one : 1);
  function gotBox(slug, n, d) {
    const name = ITEMS[slug]?.name || slug;
    return `<span class="got-box"><button type="button" class="mv" data-got-step="-${stepOf(d)}" data-slug="${slug}" title="One drop fewer" aria-label="One ${esc(name)} drop fewer"${n > 0 ? '' : ' disabled'}>−</button><input class="input small num" data-got="${slug}" inputmode="numeric" value="${n ? fmt(n) : ''}" placeholder="0" aria-label="${esc(name)} you got"><button type="button" class="mv" data-got-step="${stepOf(d)}" data-slug="${slug}" title="One drop more" aria-label="One ${esc(name)} drop more">+</button></span>`;
  }
  // How lucky what you got is, after done kills: in drops where every drop is the same amount, else in the amount.
  function luckText(slug, d, done, got) {
    if (d.p >= 1 && d.one) return got === d.one * done ? '<span class="c-faint">every kill</span>' : '';
    if (!got) {
      const dry = dryChance(d.p, done);
      const x = done * d.p;
      const tip = drySentence(ITEMS[slug]?.name || slug, d.p, done);
      if (x < 1) return `<span class="c-faint" title="${esc(tip)}">none yet: ${chanceText(dry)} go this long</span>`;
      return `<span class="${dry < 0.1 ? 'c-lose' : ''}" title="${esc(tip)}">dry ${esc(timesText(x))} rate · ${chanceText(dry)} go this dry</span>`;
    }
    const l = luck(d, done, got);
    const what = l.drops ? `${fmt(l.count)} drop${l.count === 1 ? '' : 's'} (${amt(l.expectedDrops)} expected)` : `${fmt(got)} (${amt(l.expected)} expected)`;
    const tip = `${what} after ${fmt(done)} kills. ${chanceText(l.fewer)} of players would have fewer, ${chanceText(l.more)} more.`;
    if (l.fewer > 0.5) return `<span class="c-win" title="${esc(tip)}">luckier than ${chanceText(l.fewer)}</span>`;
    if (l.more > 0.5) return `<span class="c-lose" title="${esc(tip)}">${chanceText(l.more)} get more</span>`;
    return `<span title="${esc(tip)}">about as expected</span>`;
  }

  // ── Slayer goals ────────────────────────────────────────────────────────
  function addSlayerGoal({ npc, value, style, from = null, ring = false, legends = false }) {
    const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const goal = { id, skill: SLAYER.key, type: 'kills', value, npc, style: styleFor(npc, style), created: Date.now(), ...(from ? { from } : {}), ...(ring ? { ring: true } : {}), ...(legends ? { legends: true } : {}) };
    const list = P.goals();
    list.push(goal);
    P.saveGoals(list);
    S.open.add(id);
    P.saveUi();
    return goal;
  }
  // The new goal's form, under the skill buttons, when Slayer is picked.
  function newGoalHtml(picker) {
    const d = S.newSlayer || (S.newSlayer = { npc: '', kills: '' });
    return `<div class="card goal-new">
      ${picker}
      <form class="bar wrap" data-form="goal" autocomplete="off">
        <span class="goal-skill">${iconImg(SLAYER)} Slayer</span>
        <input class="input small npc-in" name="npc" list="npc-names" value="${esc(d.npc)}" placeholder="Monster: a name, or a name and level" aria-label="Monster" spellcheck="false">
        ${datalist('npc-names')}
        <input class="input small num" name="value" inputmode="numeric" value="${esc(d.kills)}" placeholder="Kills" aria-label="Kills">
        <button class="btn small" type="submit">Add goal</button>
        <span class="c-faint small-note">A plan of kills: the XP they give, the loot to expect and the chance of each drop, then what you get. Slayer isn't in this version of the game yet: its tasks will be planned here when it comes. Or find a monster on the <button type="button" class="linkish" data-act="npc-tab">NPCs</button> tab.</span>
      </form>
    </div>`;
  }
  function addFromForm(form) {
    const found = findMonster(form.npc.value);
    const n = kills(form.value.value);
    S.newSlayer = { npc: form.npc.value, kills: form.value.value };
    if (found.problem) return { problem: found.problem };
    if (!(n > 0)) return { problem: 'How many kills? Type a number, like 500 or 1.5k.' };
    if (n > MAX_KILLS) return { problem: `That's more kills than this plans for (${fmt(MAX_KILLS)} at most).` };
    const goal = addSlayerGoal({ npc: found.id, value: Math.floor(n), style: N.style, ring: N.ring, legends: N.legends });
    S.newSlayer = { npc: '', kills: '' };
    return { goal };
  }

  // A skill goal's monster line: "Plan the loot" makes a Slayer goal of its kills,
  // or opens the one it made.
  function planLootButton(goal, methodId, runs) {
    const npc = monsterOfMethod(methodId);
    if (!npc || !info(npc) || !(runs > 0)) return '';
    const mine = P.goals().find(g => isSlayerGoal(g) && g.from === goal.id && g.npc === npc);
    const m = MONSTER_BY_ID.get(npc);
    if (!mine) {
      return ` <button type="button" class="linkish small-note plan-loot" data-act="npc-plan-loot" data-npc="${npc}" data-kills="${runs}" title="${esc(`Add a Slayer goal for these ${fmt(runs)} kills: the XP, the drops to expect and their value, and what you actually get`)}">Plan the loot</button>`;
    }
    const same = mine.value === runs;
    return ` <button type="button" class="linkish small-note plan-loot" data-act="npc-goto" data-goal-id="${mine.id}" title="${esc(`Your Slayer goal for ${fmt(mine.value)} ${m.name} kills`)}">Loot plan${same ? '' : ` (${fmt(mine.value)} kills)`}</button>${same ? '' : ` <button type="button" class="linkish small-note" data-act="npc-sync" data-goal-id="${mine.id}" data-kills="${runs}" title="Make that Slayer goal these kills">make it ${fmt(runs)}</button>`}`;
  }
  function planLootFor(goal, npc, runs) {
    const mine = P.goals().find(g => isSlayerGoal(g) && g.from === goal.id && g.npc === npc);
    if (mine) return mine;
    const style = styleOfSkillGoal(goal.skill, goal.opts?.style);
    return addSlayerGoal({ npc, value: runs, style, from: goal.id, ring: N.ring, legends: N.legends });
  }

  // Reached: as many kills done as planned.
  const reached = g => (g.done || 0) >= g.value;

  // The card on the Goals tab.
  function goalCard(goal, first, last) {
    const m = MONSTER_BY_ID.get(goal.npc);
    const open = S.open.has(goal.id);
    const editing = S.editing?.id === goal.id;
    const done = Math.min(goal.done || 0, MAX_KILLS);
    const opts = { ring: !!goal.ring, legends: !!goal.legends };
    let sub = '', bar = '', plan = '';
    const title = m ? `${esc(m.name)} <span class="c-faint">(level ${m.level})</span> · ${fmt(done)} / <b>${fmt(goal.value)}</b> kills` : 'A monster no longer in the data';
    if (m) {
      const drops = dropsOf(m.id, opts);
      prices.want(sellable(drops));
      const value = lootValue(drops);
      const xp = killXp(m.id, goal.style) || {};
      const xpLine = xpList(xp, goal.value, ' XP');
      const from = goal.from && P.goals().find(g => g.id === goal.from);
      const fromText = from ? ` · for your <button type="button" class="linkish" data-act="npc-goto" data-goal-id="${from.id}">${esc(SKILL_BY_KEY.get(from.skill)?.name || from.skill)} goal</button>` : '';
      const left = goal.value - done;
      sub = reached(goal)
        ? `<span class="c-win">Reached</span> · ${fmt(done)} kills · ${xpLine}${fromText}`
        : `<b>${fmt(left)}</b> kill${left === 1 ? '' : 's'} to go · ${xpLine} · loot about <b>${value.missing.length ? '≈' : ''}${gpShort(value.total * goal.value)}</b> gp${fromText}`;
      const p = Math.min(100, (done / goal.value) * 100);
      bar = `<div class="pbar goal-bar${reached(goal) ? ' maxed' : ''}" title="${p.toFixed(1)}% of the kills done"><div style="width:${p.toFixed(1)}%"></div></div>`;
      if (open) plan = planHtml(goal, m, drops, value);
    }
    return `<div class="card goal slayer-goal" data-goal="${goal.id}">
      <div class="goal-head">${iconImg(SLAYER)} <span class="goal-name">Slayer</span>
        <span class="goal-title">${title}</span>
        <button type="button" class="linkish small-note" data-act="edit-goal" aria-expanded="${editing}" title="Change this goal: the monster or the kills">Edit</button>
        <span class="grow"></span>
        ${m ? `<button type="button" class="btn small" data-act="toggle-plan" aria-expanded="${open}">${open ? `Hide ${P.PLAN_LABEL}` : P.PLAN_LABEL}</button>` : ''}
        <span class="mv-group">
          <button type="button" class="mv" data-act="goal-up" title="Move up" aria-label="Move Slayer goal up"${first ? ' disabled' : ''}>▲</button>
          <button type="button" class="mv" data-act="goal-down" title="Move down" aria-label="Move Slayer goal down"${last ? ' disabled' : ''}>▼</button>
        </span>
        <button type="button" class="x" data-act="remove-goal" title="Remove this goal" aria-label="Remove goal">✕</button>
      </div>
      ${editing ? editHtml(goal) : ''}
      <div class="goal-sub">${sub}</div>
      ${bar}
      ${plan}
    </div>`;
  }

  // Moving the goalpost: another monster, or another number of kills. What you got stays.
  function editHtml(goal) {
    const e = S.editing;
    const m = MONSTER_BY_ID.get(goal.npc);
    const npcText = e.npc ?? (m ? monsterName(m) : '');
    const value = e.draft ?? goal.value;
    return `<form class="bar wrap goal-edit" data-form="edit-goal" autocomplete="off">
      <span class="c-muted small-note">Change this goal to</span>
      <input class="input small npc-in" name="npc" list="npc-names-edit" value="${esc(npcText)}" aria-label="Monster" spellcheck="false">
      ${datalist('npc-names-edit')}
      <input class="input small num" name="value" inputmode="numeric" value="${esc(String(value))}" aria-label="Kills">
      <span class="c-muted small-note">kills</span>
      <button class="btn small" type="submit">Save</button>
      <button type="button" class="linkish" data-act="edit-cancel">Cancel</button>
      ${e.problem ? `<span class="c-lose small-note">${e.problem}</span>` : '<span class="c-faint small-note">Your kills done and what you got stay as they are.</span>'}
    </form>`;
  }
  function saveEdit(goal, form) {
    const e = S.editing;
    const found = findMonster(form.npc.value);
    const n = kills(form.value.value);
    e.npc = form.npc.value; e.draft = form.value.value;
    if (found.problem) { e.problem = found.problem; return false; }
    if (!(n > 0) || n > MAX_KILLS) { e.problem = `Kills go from 1 to ${fmt(MAX_KILLS)}.`; return false; }
    P.updateGoal(goal.id, g => {
      if (g.npc !== found.id) { g.npc = found.id; g.style = styleFor(found.id, g.style); }
      g.value = Math.floor(n);
    });
    S.editing = null;
    return true;
  }

  // The plan: options, kills done, the XP, the loot table, what you got and the dry checker.
  function planHtml(goal, m, drops, value) {
    const done = goal.done || 0;
    const got = goal.got || {};
    const style = goal.style || 'accurate';
    const xp = killXp(m.id, style) || {};
    // XP, and the level each skill gets to (from your XP now)
    const xpLines = Object.entries(xp).filter(([, x]) => x > 0).map(([k, x]) => {
      const cur = P.currentOf(k);
      const total = x * goal.value, left = x * Math.max(0, goal.value - done);
      const to = cur?.ranked ? levelForXp10(Math.min(MAX_XP10, cur.xp10 + left)) : 0;
      return `<div class="step">${iconImg(SKILL_BY_KEY.get(k))}<div class="step-main"><b class="c-xp">+${xpText(total)}</b> ${esc(SKILL_BY_KEY.get(k).name)} XP <span class="c-faint">(${xpText(x)} a kill)</span>${to > (cur?.level || 0) ? ` <span class="c-faint">· the ${fmt(Math.max(0, goal.value - done))} still to do take you from level ${cur.level} to ${to}</span>` : ''}</div></div>`;
    }).join('');
    const bones = m.bones && drops.get(m.bones);
    const bury = bones ? `<div class="c-faint small-note">Their ${itemName(m.bones)}: <b class="c-xp">+${xpText(Math.round(bones.q * goal.value * (P.buryXp(m.bones) || 0)))}</b> Prayer XP if you bury them all.</div>` : '';
    const priced = value.missing.length === 0;
    const totalGot = Object.entries(got).reduce((a, [s, n]) => { const p = worthOf(s); return p == null ? a : a + p * n; }, 0);
    const gotMissing = Object.keys(got).filter(s => got[s] > 0 && worthOf(s) == null);
    const toBank = bankDiff(goal);
    const anyGot = Object.values(got).some(n => n > 0);
    const shot = shots.get(goal.id);
    const hidden = S.tableOff.has(goal.id);
    return `<div class="plan slayer-plan">
      <div class="plan-opts">
        <span class="c-muted">Fight in</span> ${styleSelect('data-sopt="style"', style, m.id)}
        <label class="check" title="A ring of wealth makes the gem table's rolls land on a gem more often"><input type="checkbox" data-sopt="ring"${goal.ring ? ' checked' : ''}> Ring of wealth</label>
        <label class="check" title="With Legends' Quest done, the gem table's rarest roll is the mega rare table instead of a talisman"><input type="checkbox" data-sopt="legends"${goal.legends ? ' checked' : ''}> Legends' Quest done</label>
        <button type="button" class="linkish" data-act="npc-show" data-npc="${m.id}">${esc(m.name)} on the NPCs tab</button>
      </div>
      ${monsterFacts(m)}
      <div class="plan-sec"><h4>Your kills</h4>
        <div class="bar wrap kills-bar">
          <span class="c-muted">Kills done</span>
          <span class="got-box"><button type="button" class="mv" data-done-step="-1" title="One kill fewer" aria-label="One kill fewer"${done > 0 ? '' : ' disabled'}>−</button><input class="input small num" data-done="1" inputmode="numeric" value="${done ? fmt(done) : ''}" placeholder="0" aria-label="Kills done"><button type="button" class="mv" data-done-step="1" title="One kill more" aria-label="One kill more">+</button></span>
          <span class="c-faint">of ${fmt(goal.value)}${done < goal.value ? ` · ${fmt(goal.value - done)} to go` : ''}</span>
        </div>
      </div>
      <div class="plan-sec"><h4>XP from ${fmt(goal.value)} kills</h4><div class="steps">${xpLines || '<span class="c-faint">None in this style.</span>'}</div>${bury}</div>
      <div class="plan-sec"><h4>Loot from ${fmt(goal.value)} kills: about <span class="c-xp">${priced ? '' : '≈'}${gpShort(value.total * goal.value)}</span> gp <span class="c-faint">(${gpShort(value.total)} a kill${priced ? '' : `; ${value.missing.length} without a price yet`})</span>
          <button type="button" class="linkish small-note" data-act="table-toggle" aria-expanded="${!hidden}">${hidden ? 'Show table' : 'Hide table'}</button></h4>
        ${hidden ? '' : `<div class="c-faint small-note">Expected: the average over ${fmt(goal.value)} kills. At least one: the chance of one or more in that many. ${done ? `After your ${fmt(done)} kills: what's to be expected, what you got, and how lucky that is.` : 'Type in your kills done above to compare what you get with what\'s to be expected.'} − and + change what you got by one drop.</div>
        ${dropTable(drops, goal)}`}
        <div class="money">
          ${done ? `<span>Expected after ${fmt(done)} kills: <b>${priced ? '' : '≈'}${gpShort(value.total * done)}</b> gp</span>` : ''}
          ${anyGot ? `<span>You got: <b class="c-xp">${gpShort(totalGot)}</b> gp${gotMissing.length ? ` <span class="c-faint">(${gotMissing.length} without a price)</span>` : ''}</span>` : ''}
        </div>
        <div class="bar wrap">
          <button type="button" class="btn small" data-act="loot-pick" title="Read what you got from screenshots of your inventory">Read loot from screenshots</button>
          ${toBank.any ? `<button type="button" class="btn small" data-act="loot-bank" title="${esc(toBank.text)}">${toBank.less ? 'Update my bank' : 'Add to my bank'}</button>` : anyGot ? '<span class="c-faint small-note">What you got is in your bank.</span>' : ''}
          ${anyGot ? '<button type="button" class="linkish small-note" data-act="loot-clear">Clear what you got</button>' : ''}
        </div>
        ${shot ? shotsHtml(goal, shot) : ''}
      </div>
      ${dryHtml(goal, drops)}
    </div>`;
  }

  // What "Add to my bank" does: what you got less what's gone into the bank already.
  function bankDiff(goal) {
    const got = goal.got || {}, banked = goal.banked || {};
    const out = {};
    for (const slug of new Set([...Object.keys(got), ...Object.keys(banked)])) {
      if (ITEMS[slug]?.clue || !ITEMS[slug]) continue;           // (a clue scroll is read, not banked)
      const d = (got[slug] || 0) - (banked[slug] || 0);
      if (d) out[slug] = d;
    }
    const adds = Object.entries(out).filter(([, n]) => n > 0), less = Object.entries(out).filter(([, n]) => n < 0);
    const say = list => list.map(([s, n]) => `${fmt(Math.abs(n))} ${ITEMS[s]?.name || s}`).join(', ');
    const text = [adds.length ? `Adds ${say(adds)} to your bank.` : '', less.length ? `Takes ${say(less)} back out (you got fewer than you'd added).` : ''].filter(Boolean).join(' ');
    return { out, any: adds.length + less.length > 0, less: less.length > 0, text };
  }
  function toBank(goal) {
    const diff = bankDiff(goal);
    if (!diff.any) return 0;
    const b = P.bank();
    for (const [slug, n] of Object.entries(diff.out)) {
      const key = slug;
      const next = Math.max(0, (b.items[key] || 0) + n);
      if (next > 0) b.items[key] = next; else delete b.items[key];
    }
    P.saveBank(b);
    P.updateGoal(goal.id, g => { g.banked = Object.fromEntries(Object.entries(g.got || {}).filter(([s, n]) => n > 0 && !ITEMS[s]?.clue)); });
    return Object.keys(diff.out).length;
  }

  // The dry checker: any drop, any number of kills without it.
  function dryHtml(goal, drops) {
    const rare = [...drops].filter(([, d]) => d.p < 1 && d.p > 0);
    if (!rare.length) return '';
    const pick = dryPick.get(goal.id) || {};
    // (the rarest drop worth the most, to start with)
    const start = rare.map(([s, d]) => [s, d, (worthOf(s) || 0) * d.q]).sort((a, b) => b[2] - a[2] || a[1].p - b[1].p)[0][0];
    const slug = drops.has(pick.item) && drops.get(pick.item).p < 1 ? pick.item : start;
    const d = drops.get(slug);
    const k = pick.kills ?? (goal.done && !(goal.got?.[slug] > 0) ? goal.done : Math.round(1 / d.p) * 2);
    const sentence = k > 0 ? drySentence(ITEMS[slug]?.name || slug, d.p, k) : '';
    const opts = rare.sort((a, b) => itemName(a[0]).localeCompare(itemName(b[0]))).map(([s, x]) => `<option value="${s}"${s === slug ? ' selected' : ''}>${esc(ITEMS[s]?.name || s)} (${esc(rateText(x.p))})</option>`).join('');
    return `<div class="plan-sec dry"><h4>How dry is dry?</h4>
      <div class="bar wrap"><select class="input small" data-dry-item="1" aria-label="Drop">${opts}</select>
        <span class="c-muted">after</span> <input class="input small num" data-dry-kills="1" inputmode="numeric" value="${k ? fmt(k) : ''}" placeholder="Kills" aria-label="Kills without it"> <span class="c-muted">kills without one</span></div>
      <div class="dry-out">${sentence ? `<span>${esc(sentence)}</span>` : '<span class="c-faint">Type how many kills.</span>'}
        <span class="c-faint small-note">${esc(`An even chance of one takes ${fmt(killsFor(d.p, 0.5))} kills; 9 players in 10 have one by ${fmt(killsFor(d.p, 0.9))}, and 99 in 100 by ${fmt(killsFor(d.p, 0.99))}.`)}</span></div>
    </div>`;
  }

  // ── Loot from screenshots ───────────────────────────────────────────────
  // Each screenshot is a trip's loot, read from the inventory (the bank can be
  // open: its side panel is the inventory). What a monster doesn't drop is left
  // out; you check the rest, then it's added to what you got.
  async function readLoot(goalId, files) {
    const goal = goalOf(goalId);
    if (!goal) return;
    const seen = new Set();
    const list = [...files].filter(f => f && (/^image\//.test(f.type) || /\.png$/i.test(f.name || ''))).filter(f => {
      const key = `${f.name}|${f.size}|${f.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!list.length) { shots.set(goalId, { error: 'That isn\'t a picture. Use the PNG screenshots LostKit saves.' }); P.renderGoals(); return; }
    shots.set(goalId, { busy: list.length });
    P.renderGoals();
    try {
      const { B, D, icons } = await P.getReader();
      const reads = [];
      for (const f of list) {
        const name = f.name || 'Pasted picture';
        try {
          const bmp = await createImageBitmap(f);
          const r = B.readInventory(P.pixelsOf(bmp, bmp.width, bmp.height), icons, D.STACK_FONT);
          bmp.close?.();
          reads.push({ name, ...r });
        } catch (e) {
          reads.push({ name, ok: false, why: 'unreadable' });
        }
      }
      const sum = B.sumReads(reads.filter(r => r.ok));
      const drops = dropsOf(goal.npc, { ring: !!goal.ring, legends: !!goal.legends });
      // Two items with one icon: the one this monster drops, where only one of them is.
      const rows = B.reviewRows(sum, { likelier: P.LIKELIER_TWIN });
      for (const r of rows) {
        if (!r.choices) continue;
        const its = r.choices.filter(c => drops.has(c));
        if (its.length === 1) r.slug = its[0];
      }
      const keep = rows.filter(r => drops.has(r.slug) || r.choices?.some(c => drops.has(c)));
      const skipped = rows.filter(r => !keep.includes(r));
      shots.set(goalId, { reads, rows: keep, skipped, others: sum.others, unknown: sum.unknown, off: new Set() });
      prices.want(keep.map(r => r.slug));
    } catch (e) {
      shots.set(goalId, { error: e?.message || String(e) });
    }
    P.renderGoals();
  }
  function shotsHtml(goal, sh) {
    if (sh.error) return `<div class="msg error">${esc(sh.error)} <button type="button" class="linkish" data-act="loot-discard">Close</button></div>`;
    if (sh.busy) return `<div class="shots-drop"><span class="busy">Reading ${sh.busy} screenshot${sh.busy === 1 ? '' : 's'}…</span></div>`;
    const m = MONSTER_BY_ID.get(goal.npc);
    const bad = sh.reads.filter(r => !r.ok);
    const ok = sh.reads.length - bad.length;
    const problems = bad.map(r => `<li><b>${esc(r.name)}</b>: ${r.why === 'no-inventory' ? 'nothing in an inventory in this one.' : 'couldn\'t open this picture.'}</li>`).join('');
    const got = goal.got || {};
    const rows = sh.rows.map(it => {
      const read = it.approx ? `≈${esc(gpShort(it.count))}` : fmt(it.count);
      const name = it.choices
        ? `<select class="input small shot-as" data-loot-as="${it.key}" aria-label="Which item this is" title="These look exactly the same in the game: pick the one this is">${it.choices.map(c => `<option value="${c}"${c === it.slug ? ' selected' : ''}>${itemName(c)}</option>`).join('')}</select>`
        : itemName(it.slug);
      const unsure = it.unsure ? ' <span class="shot-check" title="A close call between items that look alike: check this one">check</span>' : '';
      return `<label class="shot-row"><input type="checkbox" data-loot-shot="${it.key}"${sh.off.has(it.key) ? '' : ' checked'}>
        ${itemIcon(it.slug, true)} <span class="shot-name">${name}${unsure}</span>
        <span class="shot-n">+${read}</span><span class="shot-was c-faint">${got[it.slug] ? `you have ${fmt(got[it.slug])}` : ''}</span></label>`;
    }).join('');
    const skipped = sh.skipped.length + sh.others + sh.unknown;
    const names = [...new Set(sh.skipped.map(r => ITEMS[r.slug]?.name || r.slug))];
    return `<div class="card shots-result loot-shots" data-drop="1">
      <div class="shots-title">From ${ok} screenshot${ok === 1 ? '' : 's'}: ${sh.rows.length} kind${sh.rows.length === 1 ? '' : 's'} of ${esc(m?.name || 'its')} loot</div>
      <p class="note">Each screenshot counts as a trip's loot, added to what you've got. ${skipped ? `${fmt(skipped)} other slot${skipped === 1 ? '' : 's'} ${skipped === 1 ? 'was' : 'were'} left out${names.length ? `: ${esc(names.slice(0, 8).join(', '))}${names.length > 8 ? ' …' : ''}, which ${esc(m?.name || 'it')} doesn't drop` : ''}.` : ''} Untick anything that wasn't from these kills.</p>
      ${problems ? `<ul class="shot-problems">${problems}</ul>` : ''}
      ${rows ? `<div class="shot-list">${rows}</div>` : `<p class="c-faint">None of what ${esc(m?.name || 'it')} drops is in these screenshots.</p>`}
      <div class="bar wrap">
        ${rows ? '<button type="button" class="btn small" data-act="loot-apply">Add to what I got</button>' : ''}
        <button type="button" class="btn small" data-act="loot-discard">${rows ? 'Discard' : 'Close'}</button>
      </div>
    </div>`;
  }
  function applyLoot(goalId) {
    const sh = shots.get(goalId);
    if (!sh?.rows) return 0;
    let n = 0;
    P.updateGoal(goalId, g => {
      const got = { ...(g.got || {}) };
      for (const r of sh.rows) {
        if (sh.off.has(r.key)) continue;
        got[r.slug] = (got[r.slug] || 0) + r.count;
        n++;
      }
      g.got = got;
    });
    shots.delete(goalId);
    return n;
  }

  // ── Events (called by planner-ui.js; true when handled) ─────────────────
  function onClick(e, act) {
    const t = e.target;
    const card = t.closest('[data-goal]');
    const goal = card && goalOf(card.dataset.goal);
    // the NPCs tab
    const openBtn = t.closest('[data-npc-open]');
    if (openBtn) { showNpc(openBtn.dataset.npcOpen, !!openBtn.dataset.npcPlan); return true; }
    const sort = t.closest('[data-npc-sort]');
    if (sort) {
      const k = sort.dataset.npcSort;
      if (N.sort === k && (k === 'level' || k === 'name')) N.dir = -N.dir; else { N.sort = k; N.dir = 1; }
      saveNpcUi(); renderNpcs();
      return true;
    }
    const band = t.closest('[data-npc-band]');
    if (band) { N.band = band.dataset.npcBand === 'all' ? null : band.dataset.npcBand; N.q = ''; saveNpcUi(); renderNpcs(); return true; }
    const npcRow = t.closest('tr[data-npc]');
    if (npcRow && !t.closest('a, button, input, select')) { showNpc(npcRow.dataset.npc); return true; }
    // a Slayer goal's plan
    if (goal && isSlayerGoal(goal)) {
      const step = t.closest('[data-got-step]');
      if (step) {
        const slug = step.dataset.slug, by = Number(step.dataset.gotStep);
        P.updateGoal(goal.id, g => {
          const got = { ...(g.got || {}) };
          const n = Math.max(0, (got[slug] || 0) + by);
          if (n > 0) got[slug] = n; else delete got[slug];
          g.got = got;
        });
        P.renderGoals();
        return true;
      }
      const dstep = t.closest('[data-done-step]');
      if (dstep) {
        P.updateGoal(goal.id, g => { g.done = Math.min(MAX_KILLS, Math.max(0, (g.done || 0) + Number(dstep.dataset.doneStep))); if (!g.done) delete g.done; });
        P.renderGoals();
        return true;
      }
      const ls = t.closest('[data-loot-sort]');
      if (ls) { lootSort.set(goal.id, ls.dataset.lootSort); P.renderGoals(); return true; }
    }
    if (!act) return false;
    switch (act.dataset.act) {
      case 'npc-back': showNpc(null); return true;
      case 'npc-tab': P.goTab('npcs'); return true;
      case 'npc-show': showNpc(act.dataset.npc); P.goTab('npcs'); return true;
      case 'npc-plan-loot': {
        const from = goal;
        if (!from) return true;
        const made = planLootFor(from, act.dataset.npc, Number(act.dataset.kills));
        P.showMsg('goals-msg', `A Slayer goal for <b>${fmt(made.value)}</b> ${esc(MONSTER_BY_ID.get(made.npc).name)} kills: <button type="button" class="linkish" data-act="npc-goto" data-goal-id="${made.id}">see its loot plan</button>.`, 'ok');
        P.renderGoals();
        return true;
      }
      case 'npc-goto': goTo(act.dataset.goalId); return true;
      case 'npc-sync': P.updateGoal(act.dataset.goalId, g => { g.value = Number(act.dataset.kills); }); P.renderGoals(); return true;
      case 'loot-pick': if (goal) pickLoot(goal.id); return true;
      case 'loot-apply': if (goal) { const n = applyLoot(goal.id); P.showMsg('goals-msg', `${n} line${n === 1 ? '' : 's'} added to what you got.`, 'ok'); P.renderGoals(); } return true;
      case 'loot-discard': if (goal) { shots.delete(goal.id); P.renderGoals(); } return true;
      case 'loot-bank': if (goal) { const n = toBank(goal); P.showMsg('goals-msg', `Your bank is updated: ${n} item${n === 1 ? '' : 's'} from your ${esc(MONSTER_BY_ID.get(goal.npc)?.name || '')} loot. <button type="button" class="linkish" data-act="to-bank" data-skill="slayer">See it</button>`, 'ok'); P.renderGoals(); } return true;
      case 'loot-clear':
        if (!goal) return true;
        if (!act.dataset.armed) { act.dataset.armed = '1'; act.textContent = 'Click again to clear'; return true; }
        P.updateGoal(goal.id, g => { delete g.got; });
        P.renderGoals();
        return true;
    }
    return false;
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.npcStyle) { N.style = t.value; saveNpcUi(); renderNpcs(); return true; }
    if (t.dataset.npcOpt) { N[t.dataset.npcOpt] = t.checked; saveNpcUi(); renderNpcs(); return true; }
    const card = t.closest('[data-goal]');
    const goal = card && goalOf(card.dataset.goal);
    if (!goal || !isSlayerGoal(goal)) return false;
    if (t.dataset.sopt) {
      P.updateGoal(goal.id, g => {
        if (t.dataset.sopt === 'style') g.style = t.value;
        else if (t.checked) g[t.dataset.sopt] = true; else delete g[t.dataset.sopt];
      });
      P.renderGoals();
      return true;
    }
    if (t.dataset.got) {
      const n = P.parseAmount(t.value);
      if (n == null) { t.classList.add('bad'); return true; }
      t.classList.remove('bad');
      P.updateGoal(goal.id, g => {
        const got = { ...(g.got || {}) };
        if (n > 0) got[t.dataset.got] = n; else delete got[t.dataset.got];
        g.got = got;
      });
      P.entered(P.renderGoals);
      return true;
    }
    if (t.dataset.done) {
      const n = P.parseAmount(t.value);
      if (n == null || n > MAX_KILLS) { t.classList.add('bad'); return true; }
      t.classList.remove('bad');
      P.updateGoal(goal.id, g => { if (n > 0) g.done = Math.floor(n); else delete g.done; });
      P.entered(P.renderGoals);
      return true;
    }
    if (t.dataset.dryItem) { dryPick.set(goal.id, { item: t.value }); P.renderGoals(); return true; }
    if (t.dataset.dryKills) {
      const n = P.parseAmount(t.value);
      if (n == null) { t.classList.add('bad'); return true; }
      dryPick.set(goal.id, { ...(dryPick.get(goal.id) || {}), kills: Math.min(MAX_KILLS, n) });
      P.entered(P.renderGoals);
      return true;
    }
    const sh = shots.get(goal.id);
    if (sh?.rows) {
      if (t.dataset.lootShot) { if (t.checked) sh.off.delete(t.dataset.lootShot); else sh.off.add(t.dataset.lootShot); return true; }
      if (t.dataset.lootAs) { const r = sh.rows.find(x => x.key === t.dataset.lootAs); if (r && r.choices?.includes(t.value)) r.slug = t.value; P.renderGoals(); return true; }
    }
    return false;
  }
  function onInput(e) {
    const t = e.target;
    if (t.dataset.npcSearch) { N.q = t.value; applyNpcSearch(); return true; }
    if (t.dataset.npcKills) { N.kills[t.dataset.npcKills] = t.value; return true; }
    if (S.editing && t.closest('[data-form="edit-goal"]') && t.name === 'npc') { S.editing.npc = t.value; return true; }
    // (what's typed into a new Slayer goal survives a redraw)
    if (S.newGoal.skill === SLAYER.key && t.closest('[data-form="goal"]') && (t.name === 'npc' || t.name === 'value')) { (S.newSlayer ||= { npc: '', kills: '' })[t.name === 'npc' ? 'npc' : 'kills'] = t.value; return false; }
    return false;
  }
  function onSubmit(form) {
    if (form.dataset.form !== 'npc-plan') return false;
    const page = form.closest('[data-npc-page]');
    const npc = page?.dataset.npcPage;
    const n = P.parseAmount(form.kills.value);
    if (!npc) return true;
    if (!(n > 0) || n > MAX_KILLS) { P.showMsg('npcs-msg', `How many kills? Type a number from 1 to ${fmt(MAX_KILLS)}, like 500 or 1.5k.`, 'error'); return true; }
    const goal = addSlayerGoal({ npc, value: Math.floor(n), style: form.style.value, ring: N.ring, legends: N.legends });
    delete N.kills[npc];
    P.showMsg('npcs-msg', '');
    goTo(goal.id);
    return true;
  }

  // ── Moving around ───────────────────────────────────────────────────────
  // (id: a monster, or none for the list)
  function showNpc(id, plan = false) {
    N.open = id && MONSTER_BY_ID.has(id) ? id : null;
    if (S.tab === 'npcs' && !$('view-npcs')?.hidden) { renderNpcs(); P.routeChanged(); window.scrollTo({ top: 0 }); }
    if (plan && N.open) document.querySelector('#npcs-body [data-npc-kills]')?.focus();
  }
  // A goal on the Goals tab, its plan open, in view (shown whatever the filter).
  function goTo(id) {
    const g = goalOf(id);
    if (!g) return;
    S.open.add(id);
    if (S.only && S.only !== g.skill) S.only = null;
    if (S.show !== 'all') S.show = 'all';
    P.saveUi();
    if (S.tab !== 'goals') P.goTab('goals'); else P.renderGoals();
    requestAnimationFrame(() => document.querySelector(`[data-goal="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  // Screenshots for a goal's loot: the same picker as the Bank tab's.
  let lootFor = null;
  async function pickLoot(goalId) {
    lootFor = goalId;
    const files = await P.pickFiles();
    if (files === 'input') return;                 // the plain file button: its change event reads them
    if (files?.length) readLoot(goalId, files);
  }
  function onLootFiles(files) { if (lootFor && files?.length) readLoot(lootFor, files); }

  return {
    renderNpcs, goalCard, newGoalHtml, addFromForm, editHtml, saveEdit, planLootButton,
    onClick, onChange, onInput, onSubmit, onLootFiles, readLoot,
    reached, showNpc,
    get open() { return N.open; },
    // (prices a goal's card wants)
    sellableOf: goal => sellable(dropsOf(goal.npc, { ring: !!goal.ring, legends: !!goal.legends })),
  };
}
