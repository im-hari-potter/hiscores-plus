// Builds gamedata.js and items.png: the skill calculator data Skills+ plans with.
//
//   node build-data.mjs <Content checkout> <LostHQ 2004 checkout>
//
// Sources (both are checked out from GitHub, nothing is fetched here):
//   - Lost City's server content, LostCityRS/Content, branch 274 (MIT). Levels and
//     XP come straight from the configs the game server runs, so the numbers are the
//     game's own. XP is kept in tenths, the way the server stores it.
//   - LostHQ/2004 (GPL-3.0): item_data.json for names, ids and shop values, and
//     item_spritesheet.png for the 32x32 item icons.
// The output is committed, so the site itself never needs either checkout.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const sharp = createRequire(import.meta.url)('sharp');   // from NODE_PATH / a global install

const [CONTENT, LOSTHQ] = process.argv.slice(2);
if (!CONTENT || !LOSTHQ) {
  console.error('usage: node build-data.mjs <LostCityRS/Content checkout> <LostHQ/2004 checkout>');
  process.exit(1);
}
const scripts = p => join(CONTENT, 'scripts', p);

// ── Config parsing ─────────────────────────────────────────────────────────
// Blocks look like "[name]" followed by key=value lines; params are
// "param=<name>,<value>". Lines starting with // are comments.
function parseConfig(text) {
  const blocks = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const head = line.match(/^\[([^\]]+)\]$/);
    if (head) { cur = { name: head[1], props: {}, params: {} }; blocks.set(cur.name, cur); continue; }
    if (!cur) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq), value = line.slice(eq + 1);
    if (key === 'param') {
      const comma = value.indexOf(',');
      cur.params[value.slice(0, comma)] = value.slice(comma + 1);
    } else if (key === 'data') {
      (cur.data ||= []).push(value.split(','));
    } else cur.props[key] = value;
  }
  return blocks;
}
const readConfig = async path => parseConfig(await readFile(path, 'utf8'));

// ── Items ──────────────────────────────────────────────────────────────────
const itemList = JSON.parse(await readFile(join(LOSTHQ, 'js/itemdb/item_data.json'), 'utf8'));
const ITEM = new Map(itemList.map(i => [i.debugname, i]));
const need = name => {
  if (!ITEM.has(name)) throw new Error(`item ${name} is not in item_data.json`);
  return name;
};

// ── Herblore ───────────────────────────────────────────────────────────────
const methods = [];
const nameOverride = {};     // debugname -> clearer display name
const bankGroups = {};

async function herblore() {
  const herbs = await readConfig(scripts('skill_herblore/configs/herbs.obj'));
  const brews = await readConfig(scripts('skill_herblore/configs/brewing/brew_potion.struct'));
  const identify = await readFile(scripts('skill_herblore/scripts/identifying/identify.rs2'), 'utf8');
  const grindHerb = await readConfig(scripts('skill_herblore/configs/grinding/grindables.obj'));
  const grindCake = await readConfig(scripts('skill_cooking/configs/cooking_inv/configs/cakes/cakes.obj'));

  // Potions that are quest-only, untradeable or a second route to the same potion.
  const SKIP = new Set(['eadgar_ground_troll_thistle_potion', 'blamish_oil', 'mort_serum3_ashesvial', 'ashesvial',
    'snakeweed_mixture', 'ardrigal_mixture']);

  const brew = [...brews.values()].map(b => ({
    key: b.name,
    level: Number(b.params.brew_potion_level ?? 3),
    xp: Number(b.params.brew_potion_exp ?? 0),
    ingredient: b.params.brew_potion_ingredient,
    solvent: b.params.brew_potion_solvent,
    out: b.params.brew_potion_mixture,
  })).filter(b => !SKIP.has(b.key));

  const potions = brew.filter(b => b.xp > 0);
  const unfByMixture = new Map(brew.filter(b => b.xp === 0 && b.solvent === 'vial_water').map(b => [b.out, b]));
  const unfUsed = new Set(potions.map(p => p.solvent).filter(s => unfByMixture.has(s)));

  // unidentified herb -> clean herb, from the Identify option's script
  const unidOf = new Map();
  for (const m of identify.matchAll(/\[opheld1,(\w+)\]\s*~attempt_identify_herb\((\w+)/g)) unidOf.set(m[2], m[1]);

  // Grinding (no level, no XP; needs a pestle and mortar)
  const grind = new Map();
  for (const blocks of [grindHerb, grindCake]) {
    for (const b of blocks.values()) if (b.params.grindable_ingredient_refined) grind.set(b.params.grindable_ingredient_refined, b.name);
  }

  // Herbs that end up in a potion with XP, lowest level first.
  const herbsUsed = [...unfUsed].map(mixture => {
    const u = unfByMixture.get(mixture);
    return { herb: need(u.ingredient), unf: need(mixture), level: u.level };
  }).sort((a, b) => a.level - b.level);
  // "Ranarr weed" -> "Ranarr potion (unf)", "Irit leaf" -> "Irit potion (unf)"
  const shortHerb = herb => ITEM.get(herb).name.replace(/ leaf$/i, '').replace(/^Ranarr weed$/i, 'Ranarr');
  for (const { herb, unf, level } of herbsUsed) {
    nameOverride[unf] = `${shortHerb(herb)} potion (unf)`;
    methods.push({
      id: `hb_unf_${herb}`, skill: 'herblore', group: 'Unfinished potions', kind: 'prep',
      name: nameOverride[unf], level, xp: 0,
      in: { [herb]: 1, [need('vial_water')]: 1 }, out: { [unf]: 1 },
    });
  }

  for (const { herb } of herbsUsed) {
    const b = herbs.get(herb);
    const unid = unidOf.get(herb);
    if (!b || !unid) throw new Error(`no identify data for ${herb}`);
    need(unid);
    nameOverride[unid] = `${ITEM.get(herb).name} (unid)`;
    methods.push({
      id: `hb_id_${herb}`, skill: 'herblore', group: 'Identify herbs', kind: 'source',
      name: `Identify ${ITEM.get(herb).name.toLowerCase()}`,
      level: Number(b.params.identified_herb_level ?? 3), xp: Number(b.params.identified_herb_exp ?? 0),
      in: { [unid]: 1 }, out: { [herb]: 1 },
    });
  }

  const secondaries = new Set();
  potions.sort((a, b) => a.level - b.level);
  for (const p of potions) {
    if (!unfByMixture.has(p.solvent)) throw new Error(`potion ${p.key} starts from ${p.solvent}, not an unfinished potion`);
    secondaries.add(need(p.ingredient));
    const outName = ITEM.get(need(p.out)).name.replace(/\s*\(\d\)$/, '');
    methods.push({
      id: `hb_${p.out}`, skill: 'herblore', group: 'Potions', kind: 'xp',
      name: outName, level: p.level, xp: p.xp,
      in: { [p.solvent]: 1, [p.ingredient]: 1 }, out: { [p.out]: 1 },
    });
  }

  // Empty vials in the bank count toward vials of water (fill them at any water source).
  methods.push({
    id: 'hb_fill_vial', skill: 'herblore', group: 'Supplies', kind: 'source',
    name: 'Fill vials with water', level: 1, xp: 0,
    in: { [need('vial_empty')]: 1 }, out: { vial_water: 1 },
  });

  const ground = [];
  for (const s of secondaries) {
    const from = grind.get(s);
    if (!from) continue;
    need(from);
    ground.push(from);
    methods.push({
      id: `hb_grind_${from}`, skill: 'herblore', group: 'Grinding', kind: 'prep', tools: ['pestle_and_mortar'],
      name: `Grind ${ITEM.get(from).name.toLowerCase()}`, level: 1, xp: 0,
      in: { [from]: 1 }, out: { [s]: 1 },
    });
  }

  bankGroups.herblore = [
    { name: 'Herbs', items: herbsUsed.map(h => h.herb) },
    { name: 'Unidentified herbs', items: herbsUsed.map(h => unidOf.get(h.herb)) },
    { name: 'Unfinished potions', items: herbsUsed.map(h => h.unf) },
    { name: 'Secondaries', items: [...new Set(potions.map(p => p.ingredient))] },
    { name: 'To grind', items: ground },
    { name: 'Supplies', items: ['vial_water', 'vial_empty'] },
    { name: 'Potions', items: potions.map(p => p.out) },
  ];
}

await herblore();

// ── Catalog of every item the data mentions ───────────────────────────────
const used = new Set();
for (const m of methods) {
  for (const k of Object.keys(m.in)) used.add(k);
  for (const k of Object.keys(m.out)) used.add(k);
  for (const k of m.tools || []) used.add(k);
}
for (const groups of Object.values(bankGroups)) for (const g of groups) for (const k of g.items) used.add(k);
// Potions are made as 3 doses but often traded as 4; keep the 4-dose items so a
// price can be scaled from them when the 3-dose has no trades.
for (const k of [...used]) {
  const m = k.match(/^3dose(.+)$/);
  if (m && ITEM.has('4dose' + m[1])) used.add('4dose' + m[1]);
}

const names = [...used].map(need).sort((a, b) => ITEM.get(a).id - ITEM.get(b).id);

// ── Icon atlas ─────────────────────────────────────────────────────────────
const PER_ROW = 16, SIZE = 32;
const sheetMeta = await sharp(join(LOSTHQ, 'img/item_spritesheet.png')).metadata();
const sheet = await sharp(join(LOSTHQ, 'img/item_spritesheet.png')).ensureAlpha().raw().toBuffer();
const rows = Math.ceil(names.length / PER_ROW);
const atlas = Buffer.alloc(PER_ROW * SIZE * rows * SIZE * 4);
names.forEach((name, n) => {
  const id = ITEM.get(name).id;
  const sx = (id % 64) * SIZE, sy = Math.floor(id / 64) * SIZE;
  const dx = (n % PER_ROW) * SIZE, dy = Math.floor(n / PER_ROW) * SIZE;
  for (let y = 0; y < SIZE; y++) {
    const from = ((sy + y) * sheetMeta.width + sx) * 4;
    sheet.copy(atlas, ((dy + y) * PER_ROW * SIZE + dx) * 4, from, from + SIZE * 4);
  }
});
await sharp(atlas, { raw: { width: PER_ROW * SIZE, height: rows * SIZE, channels: 4 } })
  .png({ compressionLevel: 9, palette: false }).toFile('items.png');

// ── gamedata.js ────────────────────────────────────────────────────────────
const items = {};
names.forEach((name, n) => {
  const i = ITEM.get(name);
  items[name] = {
    id: i.id,
    name: nameOverride[name] || i.name,
    cost: i.cost ?? 0,
    ...(i.members ? { members: 1 } : {}),
    ...(i.tradeable === true ? {} : { untradeable: 1 }),
    icon: n,
  };
});

const out = `// Generated by build-data.mjs. Do not edit by hand; change the script and re-run it.
// Levels and XP come from Lost City's server content (LostCityRS/Content, rev 274, MIT);
// XP is in tenths, like the server keeps it. Item names, ids and shop values are from
// LostHQ's item database (GPL-3.0). RuneScape is (c) Jagex Ltd.
//
// A method turns "in" items into "out" items. kind:
//   xp     - an action you train with (it gives XP)
//   prep   - a step you do on the way (unfinished potions, grinding): planned through
//   source - turns something you already have into an input (identifying herbs):
//            used when it's in your bank, never put on a shopping list

export const GAME_REVISION = 274;
export const ICON_SIZE = ${SIZE};
export const ICONS_PER_ROW = ${PER_ROW};

export const ITEMS = ${JSON.stringify(items, null, 0).replace(/\},"/g, '},\n  "').replace(/^\{/, '{\n  ').replace(/\}$/, '\n}')};

export const METHODS = [
${methods.map(m => '  ' + JSON.stringify(m)).join(',\n')},
];

// What the Bank tab lists for each skill, in groups.
export const BANK_GROUPS = ${JSON.stringify(bankGroups, null, 2)};
`;
await writeFile('gamedata.js', out);
console.log(`gamedata.js: ${methods.length} methods, ${names.length} items; items.png ${PER_ROW * SIZE}x${rows * SIZE}`);
