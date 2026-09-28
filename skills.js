// Skills, the XP curve and the combat formula.
// Kept free of any DOM code so the same file runs in the page, in Node tests
// and in the GitHub Action.

export const SKILLS = [
  { id: 0,  key: 'overall',     name: 'Overall',     icon: 'stats' },
  { id: 1,  key: 'attack',      name: 'Attack',      icon: 'attack',      combat: true },
  { id: 2,  key: 'defence',     name: 'Defence',     icon: 'defence',     combat: true },
  { id: 3,  key: 'strength',    name: 'Strength',    icon: 'strength',    combat: true },
  { id: 4,  key: 'hitpoints',   name: 'Hitpoints',   icon: 'hitpoints',   combat: true },
  { id: 5,  key: 'ranged',      name: 'Ranged',      icon: 'ranged',      combat: true },
  { id: 6,  key: 'prayer',      name: 'Prayer',      icon: 'prayer',      combat: true },
  { id: 7,  key: 'magic',       name: 'Magic',       icon: 'magic',       combat: true },
  { id: 8,  key: 'cooking',     name: 'Cooking',     icon: 'cooking' },
  { id: 9,  key: 'woodcutting', name: 'Woodcutting', icon: 'woodcutting' },
  { id: 10, key: 'fletching',   name: 'Fletching',   icon: 'fletching' },
  { id: 11, key: 'fishing',     name: 'Fishing',     icon: 'fishing' },
  { id: 12, key: 'firemaking',  name: 'Firemaking',  icon: 'firemaking' },
  { id: 13, key: 'crafting',    name: 'Crafting',    icon: 'crafting' },
  { id: 14, key: 'smithing',    name: 'Smithing',    icon: 'smithing' },
  { id: 15, key: 'mining',      name: 'Mining',      icon: 'mining' },
  { id: 16, key: 'herblore',    name: 'Herblore',    icon: 'herblore' },
  { id: 17, key: 'agility',     name: 'Agility',     icon: 'agility' },
  { id: 18, key: 'thieving',    name: 'Thieving',    icon: 'thieving' },
  // 19 and 20 are unused slots in the 2004 skill list, hence the gap.
  { id: 21, key: 'runecraft',   name: 'Runecraft',   icon: 'runecraft' },
];

export const SKILL_BY_ID = new Map(SKILLS.map(s => [s.id, s]));
export const SKILL_BY_KEY = new Map(SKILLS.map(s => [s.key, s]));
export const CATEGORY_IDS = SKILLS.map(s => s.id);            // 0..18, 21
export const SKILL_IDS = CATEGORY_IDS.filter(id => id !== 0); // the 19 real skills
export const COMBAT_KEYS = ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer', 'magic'];
export const COMBAT_IDS = SKILLS.filter(s => s.combat).map(s => s.id);

// A skill only gets a hiscores row once it reaches this level (server rule).
export const MIN_RANKED_LEVEL = 15;
export const MAX_LEVEL = 99;

// XP needed for each level, straight from the 2004 formula.
// XP_TABLE[level] = XP required to reach that level (index 0 unused).
export const XP_TABLE = (() => {
  const table = new Array(MAX_LEVEL + 1).fill(0);
  let points = 0;
  for (let level = 1; level < MAX_LEVEL; level++) {
    points += Math.floor(level + 300 * Math.pow(2, level / 7));
    table[level + 1] = Math.floor(points / 4);
  }
  return table;
})();

export function xpForLevel(level) {
  if (level <= 1) return 0;
  return XP_TABLE[Math.min(level, MAX_LEVEL)];
}

export function levelForXp(xp) {
  for (let level = MAX_LEVEL; level > 1; level--) {
    if (xp >= XP_TABLE[level]) return level;
  }
  return 1;
}

// The API stores XP * 10 so it can keep tenths; the game shows the whole part.
export const apiXp = value => Math.floor(Number(value) / 10);

// Progress through the current level, for the "Next: X XP" line and the bar.
export function levelProgress(level, xp) {
  if (level >= MAX_LEVEL) return { maxed: true, remaining: 0, pct: 100 };
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = next - base;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((xp - base) / span) * 100)) : 0;
  return { maxed: false, remaining: Math.max(0, next - xp), pct, nextLevel: level + 1 };
}

// Combat level, written exactly the way the Lost City server computes it
// (same operations in the same order), so the floating point lands the same.
export function combatLevel(l) {
  const base = 0.25 * (l.defence + l.hitpoints + Math.floor(l.prayer / 2));
  const melee = 0.325 * (l.attack + l.strength);
  const range = 0.325 * (Math.floor(l.ranged / 2) + l.ranged);
  const magic = 0.325 * (Math.floor(l.magic / 2) + l.magic);
  return Math.floor(base + Math.max(melee, range, magic));
}

// The same numbers, unrounded, for showing how the level is made up.
export function combatBreakdown(l) {
  const base = 0.25 * (l.defence + l.hitpoints + Math.floor(l.prayer / 2));
  const melee = 0.325 * (l.attack + l.strength);
  const range = 0.325 * (Math.floor(l.ranged / 2) + l.ranged);
  const magic = 0.325 * (Math.floor(l.magic / 2) + l.magic);
  const best = Math.max(melee, range, magic);
  const style = best === melee ? 'melee' : best === range ? 'ranged' : 'magic';
  const exact = base + best;
  const level = Math.floor(exact);
  return { base, melee, range, magic, style, exact, level, progress: exact - level };
}

// For each combat skill: how many more levels (alone) push combat up by one.
// null when that skill can't do it before 99.
export function levelsToNextCombat(l) {
  const current = combatLevel(l);
  const out = {};
  for (const key of COMBAT_KEYS) {
    out[key] = null;
    for (let add = 1; l[key] + add <= MAX_LEVEL; add++) {
      if (combatLevel({ ...l, [key]: l[key] + add }) > current) { out[key] = add; break; }
    }
  }
  return out;
}

// Skills below 15 have no hiscores row, so their level is unknown. The Overall
// row still carries the true total level, which pins those skills down a bit:
// together they must add up to (total level - the levels we can see).
// Returns per-skill { min, max } for every skill that is missing.
export function boundUnrankedLevels(rankedLevels, totalLevel) {
  const missing = SKILLS.filter(s => s.id !== 0 && rankedLevels[s.key] == null);
  const bounds = {};
  for (const s of missing) {
    bounds[s.key] = { min: s.key === 'hitpoints' ? 10 : 1, max: MIN_RANKED_LEVEL - 1 };
  }
  if (!Number.isFinite(totalLevel) || missing.length === 0) return bounds;

  const seen = SKILLS.reduce((sum, s) => sum + (s.id !== 0 && rankedLevels[s.key] != null ? rankedLevels[s.key] : 0), 0);
  const leftover = totalLevel - seen;
  const sumMin = missing.reduce((a, s) => a + bounds[s.key].min, 0);
  const sumMax = missing.reduce((a, s) => a + bounds[s.key].max, 0);
  if (leftover < sumMin || leftover > sumMax) return bounds; // data out of step, keep the loose bounds
  for (const s of missing) {
    const b = bounds[s.key];
    const lo = Math.max(b.min, leftover - (sumMax - b.max));
    const hi = Math.min(b.max, leftover - (sumMin - b.min));
    bounds[s.key] = { min: lo, max: hi };
  }
  return bounds;
}

// Combat level for a hiscores profile. When a combat skill is below 15 the
// answer can be a range; min === max means it is exact.
export function combatFromProfile(levels, totalLevel) {
  const bounds = boundUnrankedLevels(levels, totalLevel);
  const low = {}, high = {};
  for (const key of COMBAT_KEYS) {
    if (levels[key] != null) { low[key] = high[key] = levels[key]; }
    else { low[key] = bounds[key].min; high[key] = bounds[key].max; }
  }
  const exact = COMBAT_KEYS.every(k => low[k] === high[k]);
  return { min: combatLevel(low), max: combatLevel(high), exact, low, high, bounds };
}
