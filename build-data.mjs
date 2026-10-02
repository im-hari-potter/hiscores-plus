// Builds gamedata.js and items.png: the skill calculator data Skills+ plans with.
//
//   node build-data.mjs <Content checkout> <LostHQ 2004 checkout>
//
// Sources (both are checked out from GitHub, nothing is fetched here):
//   - Lost City's server content, LostCityRS/Content, branch 274 (MIT). Levels and
//     XP come straight from the configs the game server runs, so the numbers are the
//     game's own. XP is kept in tenths, the way the server stores it.
//   - LostHQ/2004 (GPL-3.0): item_data.json for names, ids and shop values,
//     item_spritesheet.png for the 32x32 item icons, and for Crafting the rows of
//     its calculator (js/calculators/crafting.js), checked against the server.
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
const saleGroups = {};       // things the market sells as one item that aren't a bank item (armour sets)
const places = {};           // skill -> a choice of place that changes what a step takes (which tanner)
const fixedPrices = {};      // item -> gp it's always worth (coins)
const virtualItems = {};     // those items: slug -> { id, name, cost, iconOf, parts }
const unidHerbs = {};        // the one entry every unidentified herb is counted under

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

  // Unidentified herbs are all a plain "Herb" in-game, one icon for every kind,
  // and the market trades them as one item (listed as the unidentified guam). So
  // they're one "Unid herb" entry: counted in the bank's value, left out of plans
  // until identified. Identifying gives this much XP, depending on the herb:
  const identifyXp = herbsUsed.map(({ herb }) => {
    const b = herbs.get(herb);
    if (!b || !unidOf.get(herb)) throw new Error(`no identify data for ${herb}`);
    return Number(b.params.identified_herb_exp ?? 0);
  });
  unidHerbs.item = need(unidOf.get('guam_leaf'));
  unidHerbs.xpMin = Math.min(...identifyXp);
  unidHerbs.xpMax = Math.max(...identifyXp);
  nameOverride[unidHerbs.item] = 'Unid herb';

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
    { name: 'Herbs', items: [...herbsUsed.map(h => h.herb), unidHerbs.item] },
    { name: 'Unfinished potions', items: herbsUsed.map(h => h.unf) },
    { name: 'Secondaries', items: [...new Set(potions.map(p => p.ingredient))] },
    { name: 'To grind', items: ground },
    { name: 'Supplies', items: ['vial_water', 'vial_empty'] },
    { name: 'Potions', items: potions.map(p => p.out) },
  ];
}

await herblore();

// ── Runecraft ──────────────────────────────────────────────────────────────
// One rune per altar, made from rune essence (pure essence isn't in this
// version). XP is per essence. Some runes come out more than one per essence as
// you level: runes per essence = floor(level / multiple) + 1, the server's own sum.
async function runecraft() {
  const rows = await readConfig(scripts('skill_runecraft/configs/runecraft.dbrow'));
  // The death altar's row is a placeholder in rev 274 (it came with a later quest).
  const SKIP = new Set(['runecraft_death']);
  const runes = [];
  for (const row of rows.values()) {
    if (SKIP.has(row.name)) continue;
    const d = Object.fromEntries((row.data || []).map(([k, ...v]) => [k, v.join(',')]));
    const rune = need(d.rune);
    runes.push({ rune, level: Number(d.level), xp: Number(d.experience), multiple: d.multiplier ? Number(d.multiplier) : null });
  }
  runes.sort((a, b) => a.level - b.level);
  for (const r of runes) {
    methods.push({
      id: `rc_${r.rune}`, skill: 'runecraft', group: 'Runes', kind: 'xp', unit: 'essence', units: 'essence',
      name: ITEM.get(r.rune).name, level: r.level, xp: r.xp,
      in: { [need('blankrune')]: 1 }, out: { [r.rune]: 1 },
      ...(r.multiple ? { multiple: r.multiple } : {}),
    });
  }
  bankGroups.runecraft = [
    { name: 'Essence', items: ['blankrune'] },
    { name: 'Runes', items: runes.map(r => r.rune) },
  ];
}

await runecraft();

// dbrow "data=key,a,b" lines -> { key: ['a', 'b'] } (the first line for each key)
function fields(row) {
  const d = {};
  for (const [k, ...v] of row.data || []) if (!(k in d)) d[k] = v;
  return d;
}
// A number the script itself uses, e.g. the XP per headless arrow.
function fromScript(text, re, what) {
  const m = text.match(re);
  if (!m) throw new Error(`can't find ${what} in the script`);
  return Number(m[1]);
}
function fromScriptText(text, re, what) {
  const m = text.match(re);
  if (!m) throw new Error(`can't find ${what} in the script`);
  return m[1];
}

// ── Woodcutting ────────────────────────────────────────────────────────────
// One method per tree, XP per log. Nothing goes in (just an axe, and in this
// version any axe works at any level), so these plans don't use the bank.
async function woodcutting() {
  const rows = await readConfig(scripts('skill_woodcutting/configs/trees.dbrow'));
  // Kharazi jungle trees belong to Legends' Quest, and burnt trees only give charcoal.
  const SKIP = new Set(['jungle_tree_table', 'burnt_tree_table']);
  const trees = [];
  for (const row of rows.values()) {
    if (SKIP.has(row.name)) continue;
    const d = fields(row);
    trees.push({ product: need(d.product[0]), level: Math.max(1, Number(d.levelrequired[0])), xp: Number(d.productexp[0]) });
  }
  trees.sort((a, b) => a.level - b.level || a.xp - b.xp);
  for (const t of trees) {
    methods.push({
      id: `wc_${t.product}`, skill: 'woodcutting', group: 'Trees', kind: 'xp',
      name: t.product === 'hollow_bark' ? 'Bark (hollow tree)' : ITEM.get(t.product).name,
      level: t.level, xp: t.xp, in: {}, out: { [t.product]: 1 },
    });
  }
}

await woodcutting();

// ── Firemaking ─────────────────────────────────────────────────────────────
// Logs carry their own level and XP. Achey tree logs have neither in this
// version (lighting them gives no XP), so they aren't listed.
async function firemaking() {
  const objs = await readConfig(scripts('skill_firemaking/configs/firemaking.obj'));
  const logs = [];
  for (const b of objs.values()) {
    if (b.params.productexp == null || b.params.levelrequire == null) continue;
    logs.push({ log: need(b.name), level: Math.max(1, Number(b.params.levelrequire)), xp: Number(b.params.productexp) });
  }
  logs.sort((a, b) => a.level - b.level);
  for (const l of logs) {
    methods.push({
      id: `fm_${l.log}`, skill: 'firemaking', group: 'Logs', kind: 'xp', tools: [need('tinderbox')],
      name: ITEM.get(l.log).name, level: l.level, xp: l.xp, in: { [l.log]: 1 }, out: {},
    });
  }
  bankGroups.firemaking = [{ name: 'Logs', items: logs.map(l => l.log) }];
}

await firemaking();

// ── Fletching ──────────────────────────────────────────────────────────────
// Every step gives XP, so besides each step on its own (cut a bow, string it,
// tip an arrow) there are the whole jobs the calculator sites show: a bow cut and
// strung from a log, and arrows made from a log, feathers and arrowtips.
// Arrows, darts and bolts are counted one at a time (the game makes up to 15 or
// 10 per click and gives XP for each).
async function fletching() {
  const dir = p => scripts('skill_fletching/' + p);
  const bowRows = [...(await readConfig(dir('configs/cut_logs/cut_logs.dbrow'))).values()].map(fields);
  const strRows = [...(await readConfig(dir('configs/stringing/bows.dbrow'))).values()].map(fields);
  const arrowRows = [...(await readConfig(dir('configs/arrows/arrows.dbrow'))).values()].map(fields);
  const dartRows = [...(await readConfig(dir('configs/darts/darts.dbrow'))).values()].map(fields);
  const boltRows = [...(await readConfig(dir('configs/bolts/bolts.dbrow'))).values()].map(fields);
  const boltObjs = await readConfig(dir('configs/bolts/bolts.obj'));
  const cutScript = await readFile(dir('scripts/cut_logs.rs2'), 'utf8');
  const arrowScript = await readFile(dir('scripts/arrows.rs2'), 'utf8');

  const name = k => ITEM.get(k).name;
  const knife = need('knife'), string = need('bow_string'), feather = need('feather');
  const shaft = need('arrow_shaft'), headless = need('headless_arrow');

  // Bows: cutting a log gives a bow that's the same name as the strung one in
  // this version, so the unstrung ones are marked (u) here.
  const stringing = new Map(strRows.map(r => [r.item[0], { bow: need(r.product[0]), level: Number(r.level[0]), xp: Number(r.experience[0]) }]));
  const bows = [];
  for (const r of bowRows) {
    const log = need(r.log[0]);
    for (const kind of ['shortbow', 'longbow']) {
      const [unstrung, level, xp] = r[kind];
      const s = stringing.get(unstrung);
      if (!s) throw new Error(`no stringing row for ${unstrung}`);
      nameOverride[need(unstrung)] = `${name(unstrung)} (u)`;
      bows.push({ log, unstrung, cutLevel: Number(level), cutXp: Number(xp), ...s });
    }
  }
  bows.sort((a, b) => a.cutLevel - b.cutLevel || a.cutXp - b.cutXp);
  for (const b of bows) {
    methods.push({
      id: `fl_cs_${b.bow}`, skill: 'fletching', group: 'Bows', kind: 'xp', tools: [knife],
      name: `${name(b.bow)} (cut & string)`, level: Math.max(b.cutLevel, b.level), xp: b.cutXp + b.xp,
      in: { [b.log]: 1, [string]: 1 }, out: { [b.bow]: 1 }, parts: [['cut', b.cutXp], ['string', b.xp]],
    });
  }
  for (const b of bows) {
    methods.push({
      id: `fl_cut_${b.unstrung}`, skill: 'fletching', group: 'Unstrung bows', kind: 'xp', tools: [knife],
      name: nameOverride[b.unstrung], level: b.cutLevel, xp: b.cutXp,
      in: { [b.log]: 1 }, out: { [b.unstrung]: 1 },
    });
  }
  for (const b of bows) {
    methods.push({
      id: `fl_str_${b.bow}`, skill: 'fletching', group: 'Stringing', kind: 'xp',
      name: `${name(b.bow)} (string)`, level: b.level, xp: b.xp,
      in: { [b.unstrung]: 1, [string]: 1 }, out: { [b.bow]: 1 },
    });
  }

  // Arrows: a normal log makes 15 shafts; a feather makes a shaft a headless
  // arrow; an arrowtip makes that an arrow. XP is the script's own.
  const shafts = Number(bowRows.find(r => r.log[0] === 'logs').shafts[0]);
  const shaftXp = shafts * fromScript(cutScript, /\$fletching_experience = multiply\(\$shaft_count, (\d+)\)/, 'XP per arrow shaft');
  const headlessXp = fromScript(arrowScript, /stat_advance\(fletching, multiply\(\$arrow_count, (\d+)\)\);\s*inv_add\(inv, headless_arrow/, 'XP per headless arrow');
  const arrows = arrowRows.map(r => ({ tips: need(r.item[0]), arrow: need(r.product[0]), level: Number(r.level[0]), xp: Number(r.experience[0]) }))
    .sort((a, b) => a.level - b.level);
  methods.push({
    id: 'fl_logs_headless', skill: 'fletching', group: 'Arrows from logs', kind: 'xp', tools: [knife],
    unit: 'log', units: 'logs', name: 'Headless arrows (from logs)', level: 1, xp: shaftXp + shafts * headlessXp,
    in: { logs: 1, [feather]: shafts }, out: { [headless]: shafts },
    parts: [[`${shafts} shafts`, shaftXp], [`${shafts} feathers`, shafts * headlessXp]],
  });
  for (const a of arrows) {
    methods.push({
      id: `fl_logs_${a.arrow}`, skill: 'fletching', group: 'Arrows from logs', kind: 'xp', tools: [knife],
      unit: 'log', units: 'logs', name: `${name(a.arrow)}s (from logs)`, level: a.level,
      xp: shaftXp + shafts * (headlessXp + a.xp),
      in: { logs: 1, [feather]: shafts, [a.tips]: shafts }, out: { [a.arrow]: shafts },
      parts: [[`${shafts} shafts`, shaftXp], [`${shafts} feathers`, shafts * headlessXp], [`${shafts} arrowtips`, shafts * a.xp]],
    });
  }
  methods.push({
    id: 'fl_shafts', skill: 'fletching', group: 'Arrows', kind: 'xp', tools: [knife],
    unit: 'log', units: 'logs', name: 'Arrow shafts', level: 1, xp: shaftXp,
    in: { logs: 1 }, out: { [shaft]: shafts },
  });
  methods.push({
    id: 'fl_headless', skill: 'fletching', group: 'Arrows', kind: 'xp',
    name: name(headless), level: 1, xp: headlessXp,
    in: { [shaft]: 1, [feather]: 1 }, out: { [headless]: 1 },
  });
  for (const a of arrows) {
    methods.push({
      id: `fl_arrow_${a.arrow}`, skill: 'fletching', group: 'Arrows', kind: 'xp',
      name: name(a.arrow), level: a.level, xp: a.xp,
      in: { [headless]: 1, [a.tips]: 1 }, out: { [a.arrow]: 1 },
    });
  }

  // Darts: a dart tip and a feather.
  const darts = dartRows.map(r => ({ tip: need(r.item[0]), dart: need(r.product[0]), level: Number(r.level[0]), xp: Number(r.experience[0]) }))
    .sort((a, b) => a.level - b.level);
  for (const d of darts) {
    methods.push({
      id: `fl_dart_${d.dart}`, skill: 'fletching', group: 'Darts', kind: 'xp',
      name: name(d.dart), level: d.level, xp: d.xp,
      in: { [d.tip]: 1, [feather]: 1 }, out: { [d.dart]: 1 },
    });
  }

  // Bolts: gems and pearls are chiselled into bolt tips (Fletching XP per gem),
  // and tips go on plain bolts.
  const tipItems = new Set([...boltObjs.keys()]);
  const bolt = need('bolt');
  const UNITS = { opal: ['opal', 'opals'], smalloysterpearls: ['oyster pearl', 'oyster pearls'], bigoysterpearls: ['oyster pearls', 'oyster pearls'] };
  const boltSteps = boltRows.map(r => ({ from: need(r.item[0]), to: need(r.product[0]), count: Number(r.product[1]), level: Number(r.level[0]), xp: Number(r.experience[0]) }));
  const tipSteps = boltSteps.filter(s => !tipItems.has(s.from)).sort((a, b) => a.level - b.level || a.count - b.count);
  const boltMade = boltSteps.filter(s => tipItems.has(s.from)).sort((a, b) => a.level - b.level);
  for (const s of tipSteps) {
    const [unit, units] = UNITS[s.from] || [name(s.from).toLowerCase(), name(s.from).toLowerCase() + 's'];
    const several = tipSteps.filter(t => t.to === s.to).length > 1;
    methods.push({
      id: `fl_tips_${s.from}`, skill: 'fletching', group: 'Bolts', kind: 'xp', tools: [need('chisel')],
      unit, units, name: several ? `${name(s.to)} (${name(s.from).toLowerCase()})` : name(s.to), level: s.level, xp: s.xp,
      in: { [s.from]: 1 }, out: { [s.to]: s.count },
    });
  }
  for (const s of boltMade) {
    methods.push({
      id: `fl_bolt_${s.to}`, skill: 'fletching', group: 'Bolts', kind: 'xp',
      name: name(s.to), level: s.level, xp: s.xp,
      in: { [bolt]: 1, [s.from]: 1 }, out: { [s.to]: 1 },
    });
  }

  bankGroups.fletching = [
    { name: 'Logs', items: [...new Set(bows.map(b => b.log))] },
    { name: 'Bow strings and unstrung bows', items: [string, ...bows.map(b => b.unstrung)] },
    { name: 'Arrows', items: [feather, shaft, headless, ...arrows.map(a => a.tips)] },
    { name: 'Dart tips', items: darts.map(d => d.tip) },
    { name: 'Bolts', items: [bolt, ...new Set(tipSteps.map(s => s.from)), ...new Set(boltMade.map(s => s.from))] },
    { name: 'Made', items: [...bows.map(b => b.bow), ...arrows.map(a => a.arrow), ...darts.map(d => d.dart), ...boltMade.map(s => s.to)] },
  ];
}

await fletching();

// ── Crafting ───────────────────────────────────────────────────────────────
// The rows are LostHQ's Crafting calculator (js/calculators/crafting.js): its
// four tabs, in its order, with the level, XP and ingredients it lists. Every
// row is checked against the server's own configs, which also say what the
// calculator leaves out: the tool a row needs, how the XP of a whole job splits
// (shaping and firing a pot, making and stringing an amulet), and that
// dragonhide is worked as dragon leather, tanned from the hide the calculator
// lists. A difference the check doesn't know about stops the build.
//
// Two kinds of row are added for what they sell as (their Crafting XP is the
// calculator's, row for row):
//   - enchanted jewellery (a ring of dueling, an amulet of glory): the row it's
//     made from, plus the runes of the server's enchant spell. Enchanting gives
//     Magic XP, not Crafting XP.
//   - dragonhide sets: vambraces, chaps and body, which markets.lostcity.rs
//     trades as one item (its ItemSetsSeeder; not an item in the game).
// And one step the calculator leaves to you: the orb a battlestaff takes is an
// unpowered orb charged with a Charge Orb spell (the spell's runes; Magic XP).
// It's a step on the way, so a plan with no charged orbs lists the unpowered
// orbs and runes, and unpowered orbs or molten glass in your bank count.
const craftingNotes = [];
async function crafting() {
  const dir = p => scripts('skill_crafting/' + p);
  const name = k => nameOverride[k] || ITEM.get(need(k)).name;
  const x10 = xp => Math.round(xp * 10);
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

  // The calculator's table: { tab: { item: { xp, level, ingredients } } }
  const src = await readFile(join(LOSTHQ, 'js/calculators/crafting.js'), 'utf8');
  const end = src.indexOf('function runCalc');
  if (end < 0) throw new Error("crafting.js: can't find where the table ends");
  const calc = new Function(`${src.slice(0, end)}\nreturn craftingXP;`)();
  const TABS = { needle_thread: 'Needle & thread', jewellery: 'Jewellery', pottery_glass: 'Pottery & glass', spinning: 'Spinning' };
  for (const tab of Object.keys(calc)) if (!TABS[tab]) throw new Error(`crafting.js has a tab this script doesn't know: ${tab}`);

  // Where the server and the calculator differ, the server's number is used (it's
  // what the game does) and the difference is printed. One this script hasn't
  // seen before stops it, so it gets looked at.
  const KNOWN = { sapphire_necklace: { level: 20 } };
  const server = {};           // key -> { level, xp }: the server's, where it differs
  const check = (key, what, calcValue, serverValue) => {
    if (calcValue === serverValue) return;
    if (KNOWN[key]?.[what] !== serverValue) throw new Error(`crafting ${key}: the calculator says ${what} ${calcValue}, the server ${serverValue}`);
    (server[key] ||= {})[what] = serverValue;
    craftingNotes.push(`${ITEM.get(key).name}: ${what} ${serverValue} (the server, used) vs ${calcValue} (LostHQ's calculator)`);
  };

  // ── The server's side ──
  const byProduct = (blocks, pick) => new Map([...blocks.values()].filter(b => b.params.product).map(b => [b.params.product, pick(b.params, b)]));
  // Leather and dragon leather (needle and thread; a reel of thread lasts five items)
  const leather = new Map(), colours = new Map();
  for (const row of (await readConfig(dir('configs/leather/leather.dbrow'))).values()) {
    const d = fields(row);
    if (d.product) leather.set(d.product[0], { level: Number(d.levelrequired[0]), xp: Number(d.productexp[0]), from: d.leather[0], count: Number(d.leather[1]) });
    else if (d.color) colours.set(d.leather[0], { colour: d.color[0].toLowerCase(), items: d.interface_items });
  }
  const leatherScript = await readFile(dir('scripts/leather/leather.rs2'), 'utf8');
  const threadUses = fromScript(leatherScript, /if \(%thread_used > (\d+)\)/, 'how long a reel of thread lasts') + 1;
  // Hides are tanned at a tanner, for a fee per hide: cowhide into leather or hard
  // leather, dragonhide into dragon leather. Two tanners, each with its prices:
  // Al Kharid's, and the dearer one in Canifis (the server's werewolftanner).
  const tanner = await readFile(scripts('areas/area_alkharid/scripts/tanner.rs2'), 'utf8');
  const hideOf = new Map([...tanner.matchAll(/@tan_dragonhide\((\w+), (\w+), 1\)/g)].map(m => [m[2], m[1]]));
  const cowhide = need(fromScriptText(tanner, /~tan_leather\((\w+), leather, \$cost/, 'the hide tanned into leather'));
  if (fromScriptText(tanner, /~tan_leather\((\w+), hard_leather, \$cost/, 'the hide tanned into hard leather') !== cowhide) throw new Error('crafting: hard leather is tanned from another hide');
  const fees = Object.fromEntries((await readFile(scripts('areas/area_alkharid/configs/tanner.constant'), 'utf8'))
    .split(/\r?\n/).map(l => l.match(/^\^(\w+)_cost\s*=\s*(\d+)/)).filter(Boolean).map(m => [m[1], Number(m[2])]));
  const TANNERS = [['al_kharid', 'Al Kharid', 'tanner'], ['canifis', 'Canifis', 'werewolftanner']].map(([id, place, npc]) => {
    const fee = kind => fees[`${npc}_${kind}`] ?? (() => { throw new Error(`crafting: no ${kind} fee for the ${place} tanner`); })();
    return { id, name: place, leather: fee('soft_leather'), hard_leather: fee('hard_leather'), dragonhide: fee('dragonhide') };
  });
  if (!/npc_type = werewolftanner/.test(tanner)) throw new Error("crafting: can't see which tanner charges the dearer fees");
  const coins = need('coins');
  // What a tanning step pays: Al Kharid's fee in its "in", the other tanners' in "at".
  const feeIn = kind => ({ in: { [coins]: TANNERS[0][kind] }, at: Object.fromEntries(TANNERS.slice(1).map(t => [t.id, { [coins]: t[kind] }])) });
  const studded = byProduct(await readConfig(dir('configs/studded/studded.struct')), p => ({ level: Number(p.levelrequired), xp: Number(p.productexp), from: p.ingredient }));
  // Gems, cut with a chisel
  const gems = new Map([...(await readConfig(dir('configs/gem/gem.dbrow'))).values()].map(fields)
    .map(d => [d.cut_gem[0], { uncut: d.uncut_gem[0], level: Number(d.level[0]), xp: Number(d.experience[0]), canSmash: !!d.success_rate }]));
  // Gold and silver, cast in a mould at a furnace; amulets and symbols are then strung
  const jewel = byProduct(await readConfig(dir('configs/jewellery/jewellery.struct')), p => ({
    level: Number(p.levelrequired), xp: Number(p.productexp), gem: p.gem || null, strung: p.strung || null, mould: p.mould || null }));
  const stringXp = fromScript(await readFile(dir('scripts/jewellery/stringing.rs2'), 'utf8'), /stat_advance\(crafting, (\d+)\)/, 'the XP for stringing an amulet');
  const strungFrom = new Map([...jewel].filter(([, j]) => j.strung).map(([unstrung, j]) => [j.strung, { unstrung, ...j }]));
  const mouldFor = (key, j) => need(j.mould || (/_ring$/.test(key) ? 'ring_mould' : /_necklace$/.test(key) ? 'necklace_mould' : /amulet$/.test(key) ? 'amulet_mould' : (() => { throw new Error(`no mould for ${key}`); })()));
  // Pottery: shaped on a wheel (processexp), then fired in an oven (productexp)
  const potStructs = await readConfig(dir('configs/pottery/pottery.struct'));
  const unfired = new Map(), fired = new Map();
  for (const b of (await readConfig(dir('configs/pottery/pottery.obj'))).values()) {
    const st = potStructs.get(b.params.crafting_pottery_struct);
    if (!st?.params.product) continue;
    const p = { level: Number(st.params.levelrequire), shape: Number(st.params.processexp), fire: Number(st.params.productexp) };
    unfired.set(b.name, p);
    fired.set(st.params.product, p);
  }
  // Glass: sand and soda ash melted at a furnace, then blown with a pipe
  const glass = byProduct(await readConfig(dir('configs/glass/glass.struct')), p => ({ level: Number(p.levelrequire ?? 1), xp: Number(p.productexp) }));
  const glassScript = await readFile(dir('scripts/glass/glass.rs2'), 'utf8');
  const smelt = glassScript.slice(glassScript.indexOf('[label,smelt_glass]')).split(/\n\[/)[0];
  const moltenXp = fromScript(smelt, /inv_add\(inv, molten_glass, 1\);[\s\S]*?stat_advance\(crafting, (\d+)\)/, 'the XP for molten glass');
  const moltenIn = Object.fromEntries([...smelt.matchAll(/inv_del\(inv, (\w+), 1\)/g)].map(m => [m[1], 1]));
  const staves = byProduct(await readConfig(dir('configs/battlestaves/battlestaves.struct')), p => ({ level: Number(p.levelrequire), xp: Number(p.productexp), orb: p.ingredient }));
  const spun = byProduct(await readConfig(dir('configs/spinning/spinning.struct')), p => ({ level: Number(p.levelrequire ?? 1), xp: Number(p.productexp), from: p.ingredient }));

  // Names: dragonhide items of every colour share a name in-game, and so do an
  // amulet and its unstrung self, so the colour and (u) are added.
  for (const [leatherItem, { colour, items }] of colours) {
    const hide = hideOf.get(leatherItem);
    if (!hide) throw new Error(`no hide is tanned into ${leatherItem}`);
    for (const k of [hide, leatherItem, ...items]) nameOverride[need(k)] = `${ITEM.get(k).name} (${colour})`;
  }
  for (const [strung, j] of strungFrom) {
    if (ITEM.get(need(strung)).name === ITEM.get(need(j.unstrung)).name) nameOverride[j.unstrung] = `${ITEM.get(j.unstrung).name} (u)`;
  }

  // ── The calculator's rows ──
  const needle = need('needle'), thread = need('thread'), wool = need('ball_of_wool');
  const made = { 'Needle & thread': [], Jewellery: [], 'Pottery & glass': [], Spinning: [] };
  const add = (tab, key, row, m) => {
    for (const k of [key, ...Object.keys(m.in)]) need(k);
    made[TABS[tab]].push(key);
    methods.push({ id: `cr_${key}`, skill: 'crafting', group: TABS[tab], kind: 'xp', ...(m.tools ? { tools: m.tools } : {}),
      name: m.name || name(key), level: server[key]?.level ?? row.level, xp: server[key]?.xp ?? x10(row.xp), in: m.in, out: { [key]: 1 }, ...(m.parts ? { parts: m.parts } : {}) });
  };
  const expect = (key, row, ingredients) => {
    if (!same(row.ingredients, ingredients)) throw new Error(`crafting ${key}: the calculator lists ${JSON.stringify(row.ingredients)}, the server takes ${JSON.stringify(ingredients)}`);
  };

  for (const [key, row] of Object.entries(calc.needle_thread)) {
    if (leather.has(key)) {
      const s = leather.get(key);
      check(key, 'level', row.level, s.level);
      check(key, 'xp', x10(row.xp), s.xp);
      // the calculator lists the hide; the server works the leather tanned from it
      expect(key, row, { [hideOf.get(s.from) || s.from]: s.count, [thread]: 1 / threadUses });
      add('needle_thread', key, row, { tools: [needle], in: { [s.from]: s.count, [thread]: 1 / threadUses } });
    } else if (studded.has(key)) {
      const s = studded.get(key);
      check(key, 'level', row.level, s.level);
      check(key, 'xp', x10(row.xp), s.xp);
      expect(key, row, { [s.from]: 1, studs: 1 });
      add('needle_thread', key, row, { in: { [s.from]: 1, studs: 1 } });
    } else throw new Error(`crafting: the server has no ${key}`);
  }

  for (const [key, row] of Object.entries(calc.jewellery)) {
    if (gems.has(key)) {
      const g = gems.get(key);
      check(key, 'level', row.level, g.level);
      check(key, 'xp', x10(row.xp), g.xp);
      expect(key, row, { [g.uncut]: 1 });
      add('jewellery', key, row, { tools: [need('chisel')], name: `${name(key)} (cut)`, in: { [g.uncut]: 1 } });
    } else if (jewel.has(key)) {
      const j = jewel.get(key);
      check(key, 'level', row.level, j.level);
      check(key, 'xp', x10(row.xp), j.xp);
      const bar = Object.keys(row.ingredients).find(k => /_bar$/.test(k));
      expect(key, row, { [bar]: 1, ...(j.gem ? { [j.gem]: 1 } : {}) });
      add('jewellery', key, row, { tools: [mouldFor(key, j)], in: { [bar]: 1, ...(j.gem ? { [j.gem]: 1 } : {}) } });
    } else if (strungFrom.has(key)) {
      // the whole job: made, then strung with a ball of wool
      const j = strungFrom.get(key);
      check(key, 'level', row.level, j.level);
      check(key, 'xp', x10(row.xp), j.xp + stringXp);
      const bar = Object.keys(row.ingredients).find(k => /_bar$/.test(k));
      const ins = { [bar]: 1, ...(j.gem ? { [j.gem]: 1 } : {}), [wool]: 1 };
      expect(key, row, ins);
      add('jewellery', key, row, { tools: [mouldFor(j.unstrung, j)], name: `${name(key)} (make & string)`, in: ins, parts: [['make', j.xp], ['string', stringXp]] });
    } else throw new Error(`crafting: the server has no ${key}`);
  }

  for (const [key, row] of Object.entries(calc.pottery_glass)) {
    if (unfired.has(key)) {
      const p = unfired.get(key);
      check(key, 'level', row.level, p.level);
      check(key, 'xp', x10(row.xp), p.shape);
      expect(key, row, { softclay: 1 });
      add('pottery_glass', key, row, { in: { softclay: 1 } });
    } else if (fired.has(key)) {
      // the whole job: shaped on the wheel, then fired
      const p = fired.get(key);
      check(key, 'level', row.level, p.level);
      check(key, 'xp', x10(row.xp), p.shape + p.fire);
      expect(key, row, { softclay: 1 });
      add('pottery_glass', key, row, { name: `${name(key)} (shape & fire)`, in: { softclay: 1 }, parts: [['shape', p.shape], ['fire', p.fire]] });
    } else if (glass.has(key)) {
      const g = glass.get(key);
      check(key, 'level', row.level, g.level);
      check(key, 'xp', x10(row.xp), g.xp);
      expect(key, row, { molten_glass: 1 });
      add('pottery_glass', key, row, { tools: [need('glassblowingpipe')], in: { molten_glass: 1 } });
    } else if (key === 'molten_glass') {
      check(key, 'level', row.level, 1);
      check(key, 'xp', x10(row.xp), moltenXp);
      expect(key, row, moltenIn);
      add('pottery_glass', key, row, { in: moltenIn });
    } else if (staves.has(key)) {
      const s = staves.get(key);
      check(key, 'level', row.level, s.level);
      check(key, 'xp', x10(row.xp), s.xp);
      expect(key, row, { [s.orb]: 1, battlestaff: 1 });
      add('pottery_glass', key, row, { in: { [s.orb]: 1, battlestaff: 1 } });
    } else throw new Error(`crafting: the server has no ${key}`);
  }

  for (const [key, row] of Object.entries(calc.spinning)) {
    const s = spun.get(key);
    if (!s) throw new Error(`crafting: the server has no ${key}`);
    check(key, 'level', row.level, s.level);
    check(key, 'xp', x10(row.xp), s.xp);
    expect(key, row, { [s.from]: 1 });
    add('spinning', key, row, { in: { [s.from]: 1 } });
  }

  // ── Rows for what's sold ──
  const after = (baseId, m) => methods.splice(methods.findIndex(x => x.id === baseId) + 1, 0, m);
  const rowOf = key => methods.find(m => m.id === `cr_${key}`) || (() => { throw new Error(`crafting: no row makes ${key}`); })();

  // Dragonhide sets. The slug and name are the market's (set_green_dhide,
  // "Green d'hide set"); the pieces are the game's own, colour by colour.
  const sets = [];
  for (const [leatherItem, { colour, items }] of colours) {
    const pieces = items.map(rowOf).sort((a, b) => a.level - b.level);       // vambraces, chaps, body
    const slug = `set_${colour}_dhide`;
    virtualItems[slug] = {
      id: 1_000_001 + sets.length, name: `${colour[0].toUpperCase()}${colour.slice(1)} d'hide set`,
      cost: pieces.reduce((a, m) => a + ITEM.get(Object.keys(m.out)[0]).cost, 0),
      iconOf: Object.keys(pieces[pieces.length - 1].out)[0], parts: pieces.map(m => Object.keys(m.out)[0]),
    };
    const short = m => ITEM.get(Object.keys(m.out)[0]).name.replace(/^Dragon(hide)? /, '');
    sets.push(slug);
    after(pieces[pieces.length - 1].id, {
      id: `cr_${slug}`, skill: 'crafting', group: TABS.needle_thread, kind: 'xp', tools: [needle],
      name: `${virtualItems[slug].name} (${short(pieces[0])}, ${short(pieces[1])} & ${short(pieces[2])})`,
      level: Math.max(...pieces.map(m => m.level)), xp: pieces.reduce((a, m) => a + m.xp, 0),
      in: { [leatherItem]: pieces.reduce((a, m) => a + m.in[leatherItem], 0), [thread]: pieces.length / threadUses },
      out: { [slug]: 1 }, parts: pieces.map(m => [short(m), m.xp]),
      note: 'The three pieces, which the market trades together as one set.',
    });
  }

  // Enchanted jewellery: the server's enchant spells say what becomes what, and
  // the runes one cast takes. An amulet of glory is then charged at the Fountain
  // of Heroes (no cost), which is how it's traded.
  const spells = await readConfig(scripts('skill_magic/configs/magic_spells.dbrow'));
  const fountain = await readFile(scripts('areas/areas_heroes_guild/scripts/fountain_of_heroes.rs2'), 'utf8');
  const charged = new Map();
  for (const m of fountain.matchAll(/if \(([^)]*)\) \{[\s\S]*?inv_setslot\(inv, \$slot, (\w+), 1\)/g)) {
    for (const from of m[1].matchAll(/last_useitem = (\w+)/g)) charged.set(from[1], m[2]);
  }
  // What one cast of a spell takes, and the Magic XP it gives (magic, in tenths;
  // spell and magicLevel name it). Crafting XP isn't touched by it.
  const xpText = xp10 => String(xp10 / 10);
  const cast = (d, spell) => {
    const runes = {};
    for (let i = 0; i + 1 < d.runesrequired.length; i += 2) if (d.runesrequired[i] !== 'null') runes[need(d.runesrequired[i])] = Number(d.runesrequired[i + 1]);
    const magic = Number(d.experience[0]), magicLevel = Number(d.levelrequired[0]);
    if (!(magic > 0) || !(magicLevel > 0) || !Object.keys(runes).length) throw new Error(`crafting: can't read the ${spell} spell`);
    return { runes, magic, magicLevel, spell };
  };
  const enchanted = [];
  for (const row of spells.values()) {
    const lvl = row.name.match(/^magic_spell_enchant_level(\d)$/);
    if (!lvl) continue;
    const c = cast(fields(row), `Lvl-${lvl[1]} Enchant`);
    for (const [, from, to] of row.data.filter(([k]) => k === 'convertobj')) {
      const base = rowOf(from);
      const final = need(charged.get(to) || to);
      enchanted.push(final);
      after(base.id, {
        id: `cr_ench_${final}`, skill: 'crafting', group: base.group, kind: 'xp', ...(base.tools ? { tools: base.tools } : {}),
        name: `${ITEM.get(final).name} (${base.parts ? 'make, string & enchant' : 'make & enchant'})`,
        level: base.level, xp: base.xp, in: { ...base.in, ...c.runes }, out: { [final]: 1 }, ...(base.parts ? { parts: base.parts } : {}),
        magic: c.magic, spell: c.spell, magicLevel: c.magicLevel,
        note: `Enchanted with ${c.spell} (Magic ${c.magicLevel}): ${xpText(c.magic)} Magic XP each, on top of the Crafting XP.${charged.has(to) ? ' Then charged at the Fountain of Heroes.' : ''}`,
      });
    }
  }
  if (enchanted.length !== 11) throw new Error(`crafting: expected 11 enchanted items, found ${enchanted.length}`);

  // Orbs: an unpowered orb is charged at an obelisk with a Charge Orb spell. No
  // Crafting XP in it, so it's a step on the way, like an unfinished potion.
  const charging = [];
  for (const row of spells.values()) {
    const el = row.name.match(/^magic_spell_charge_(\w+)_orb$/);
    if (!el) continue;
    const c = cast(fields(row), `Charge ${el[1][0].toUpperCase()}${el[1].slice(1)} Orb`);
    for (const [, from, to] of row.data.filter(([k]) => k === 'convertobj')) {
      charging.push({ id: `cr_charge_${need(to)}`, skill: 'crafting', group: 'Charging orbs', kind: 'prep',
        name: `Charge ${ITEM.get(to).name.toLowerCase()}`, level: 1, xp: 0,
        in: { [need(from)]: 1, ...c.runes }, out: { [to]: 1 }, magic: c.magic, spell: c.spell, magicLevel: c.magicLevel });
    }
  }
  const orbOf = new Map(charging.map(m => [Object.keys(m.out)[0], m]));
  for (const [staff, s] of staves) {
    const m = orbOf.get(s.orb);
    if (!m) throw new Error(`crafting: no Charge Orb spell makes the ${s.orb} a ${staff} takes`);
    if (!rowOf(Object.keys(m.in)[0])) throw new Error(`crafting: no row makes what's charged into ${s.orb}`);
    // the battlestaff's own row says so, where its tooltip is
    rowOf(staff).note = `The orb is an unpowered orb charged with ${m.spell} (Magic ${m.magicLevel}): ${xpText(m.magic)} Magic XP each. A plan with no ${ITEM.get(s.orb).name.toLowerCase()}s lists the unpowered orbs and runes.`;
  }
  if (charging.length !== staves.size) throw new Error(`crafting: expected ${staves.size} Charge Orb spells, found ${charging.length}`);

  // A row whose product another row uses (a cut sapphire, molten glass, a ball
  // of wool, a leather body for studding) feeds it: with those in your bank the
  // plan makes them on the way, and their XP counts.
  const mine = methods.filter(m => m.skill === 'crafting');
  const inputs = new Set([...mine, ...charging].flatMap(m => Object.keys(m.in)));
  for (const m of mine) if (Object.keys(m.out).some(k => inputs.has(k))) m.feeds = 1;
  methods.push(...charging);

  // Tanning: no XP, so it's a step on the way, like an unfinished potion, and the
  // tanner's fee is part of it (pays: coins never come out of your bank and never
  // hold a plan back; they're a cost). Dragonhide is planned through, since the
  // calculator lists the hide. Leather it lists as leather, so cowhide is only
  // tanned when it's in your bank (a source).
  const leathers = [...colours.keys()].filter(k => inputs.has(k));
  for (const leatherItem of leathers) {
    const hide = hideOf.get(leatherItem);
    const fee = feeIn('dragonhide');
    methods.push({ id: `cr_tan_${hide}`, skill: 'crafting', group: 'Tanning', kind: 'prep',
      name: `Tan ${nameOverride[hide][0].toLowerCase()}${nameOverride[hide].slice(1)}`, level: 1, xp: 0,
      in: { [hide]: 1, ...fee.in }, out: { [leatherItem]: 1 }, pays: [coins], at: fee.at });
  }
  for (const kind of ['leather', 'hard_leather']) {
    const fee = feeIn(kind);
    methods.push({ id: `cr_tan_${kind}`, skill: 'crafting', group: 'Tanning', kind: 'source',
      name: `Tan cowhide (${ITEM.get(need(kind)).name.toLowerCase()})`, level: 1, xp: 0,
      in: { [cowhide]: 1, ...fee.in }, out: { [kind]: 1 }, pays: [coins], at: fee.at });
  }

  // Crystal keys: the two halves join into a key, and the crystal chest in
  // Taverley always has an uncut dragonstone in it (the rest of its loot is
  // luck, and isn't counted). No XP, and only used from your bank: sources.
  const keyScript = await readFile(scripts('areas/area_taverly/scripts/crystal_key.rs2'), 'utf8');
  const joining = keyScript.slice(keyScript.indexOf('[label,join_keys]'));
  const halves = [...joining.matchAll(/inv_del\(inv, (\w+), 1\)/g)].map(m => need(m[1]));
  const key = need(fromScriptText(joining, /inv_add\(inv, (\w+), 1\)/, 'what the key halves make'));
  if (halves.length !== 2) throw new Error(`crafting: expected two key halves, found ${halves.length}`);
  const chest = await readFile(scripts('areas/area_taverly/scripts/crystal_chest.rs2'), 'utf8');
  const reward = chest.slice(chest.indexOf('[label,crystal_chest_reward]'));
  const always = fromScriptText(reward.split('def_int $random')[0], /inv_add\(inv, (\w+), 1\)/, 'what the crystal chest always gives');
  if (!new RegExp(`inv_del\\(inv, ${key}, 1\\)`).test(chest)) throw new Error("crafting: the crystal chest doesn't take the key");
  if (!inputs.has(always)) throw new Error(`crafting: nothing is made from the chest's ${always}`);
  // (both halves are "Half of a key" in-game; tooth and loop are what players call them, and the later game too)
  nameOverride[halves[0]] = `${ITEM.get(halves[0]).name} (tooth)`;
  nameOverride[halves[1]] = `${ITEM.get(halves[1]).name} (loop)`;
  methods.push({ id: 'cr_join_keys', skill: 'crafting', group: 'Crystal keys', kind: 'source', name: 'Join key halves', level: 1, xp: 0,
    in: Object.fromEntries(halves.map(k => [k, 1])), out: { [key]: 1 } });
  methods.push({ id: 'cr_crystal_chest', skill: 'crafting', group: 'Crystal keys', kind: 'source', name: 'Open the crystal chest', level: 1, xp: 0,
    in: { [key]: 1 }, out: { [always]: 1 }, note: "The chest's other loot is luck, and isn't counted." });

  // The Bank tab: what goes in, by kind, then what comes out, tab by tab.
  const cutGems = Object.keys(calc.jewellery).filter(k => gems.has(k));
  const supplies = [
    { name: 'Leather and thread', items: [cowhide, 'leather', 'hard_leather', thread, 'studs'] },
    { name: 'Dragonhide', items: leathers.flatMap(k => [hideOf.get(k), k]) },
    { name: 'Gems', items: [...cutGems.map(k => gems.get(k).uncut), ...cutGems] },
    { name: 'Crystal keys', items: [...halves, key] },
    { name: 'Bars, wool and flax', items: ['gold_bar', 'silver_bar', 'wool', wool, 'flax'] },
    { name: 'Clay, sand and glass', items: ['softclay', ...Object.keys(moltenIn), 'molten_glass'] },
    { name: 'Orbs and battlestaves', items: ['battlestaff', ...Object.keys(calc.pottery_glass).filter(k => staves.has(k)).map(k => staves.get(k).orb)] },
    { name: 'Runes for enchanting', items: [...new Set(mine.filter(m => m.id.startsWith('cr_ench_')).flatMap(m => Object.keys(m.in)).filter(k => /rune$/.test(k)))].sort((a, b) => (b === 'cosmicrune') - (a === 'cosmicrune')) },
  ];
  const listed = new Set(supplies.flatMap(g => g.items));
  for (const k of inputs) if (!listed.has(k) && !mine.some(m => m.out[k])) throw new Error(`crafting: ${k} goes in but isn't in a bank group`);
  const rest = tab => made[tab].filter(k => !listed.has(k));
  bankGroups.crafting = [
    ...supplies,
    { name: 'Made: leather', items: rest('Needle & thread') },
    { name: 'Made: jewellery', items: rest('Jewellery') },
    { name: 'Made: enchanted jewellery', items: enchanted },
    { name: 'Made: pottery, glass and staves', items: [...rest('Pottery & glass'), ...rest('Spinning')] },
  ];
  // Priced, but not a bank item: the market's sets.
  saleGroups.crafting = [{ name: 'Dragonhide sets', items: sets }];
  // Where there's a choice of place: the tanner, which sets the fee.
  places.crafting = {
    label: 'Tanner',
    options: TANNERS.map(t => ({ id: t.id, name: t.name, short: `${t.dragonhide} gp a dragonhide`, note: `leather ${t.leather} gp, hard leather ${t.hard_leather} gp, dragonhide ${t.dragonhide} gp a hide` })),
  };
  fixedPrices[coins] = 1;
  // Gems that can smash when cut (the calculator counts every cut as a success).
  craftingNotes.push(`can smash when cut (not counted, like the calculator): ${cutGems.filter(k => gems.get(k).canSmash).map(k => ITEM.get(k).name).join(', ')}`);
}

await crafting();

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

const names = [...used].filter(k => !virtualItems[k]).map(need).sort((a, b) => ITEM.get(a).id - ITEM.get(b).id);

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
    ...(fixedPrices[name] != null ? { gp: fixedPrices[name] } : {}),
    icon: n,
  };
});
// The market's sets: no icon of their own, so they borrow their biggest piece's.
for (const [slug, v] of Object.entries(virtualItems)) {
  items[slug] = { id: v.id, name: v.name, cost: v.cost, members: 1, icon: items[v.iconOf].icon, set: v.parts };
}

const out = `// Generated by build-data.mjs. Do not edit by hand; change the script and re-run it.
// Levels and XP come from Lost City's server content (LostCityRS/Content, rev 274, MIT);
// XP is in tenths, like the server keeps it. Item names, ids and shop values are from
// LostHQ's item database (GPL-3.0). Crafting's rows are LostHQ's Crafting calculator
// (GPL-3.0), checked against the server. RuneScape is (c) Jagex Ltd.
//
// A method turns "in" items into "out" items (no "in" at all: gathering, like
// Woodcutting). unit/units, when set, is what one action uses (one essence, one
// log). multiple: makes floor(level / multiple) + 1 of each output per action
// (runes per essence as Runecraft levels up). parts: the XP of each step of a
// whole job (cut, then string). tools: needed, never used up. An amount in "in"
// is a whole number, except thread: a reel lasts five items (0.2 each). kind:
//   xp     - an action you train with (it gives XP)
//   prep   - a step you do on the way (unfinished potions, grinding, tanning):
//            planned through
//   source - turns something you already have into an input (filling vials):
//            used when it's in your bank, never put on a shopping list
// feeds: an xp method whose product another one uses (a cut gem for a ring):
// a plan makes it on the way from what's in your bank, like a source, and its
// XP counts. note: a line for the row's tooltip (what else it takes).
// magic: the Magic XP (in tenths) of the spell a method casts each time, on top
// of its own XP: enchanting a ring, or charging an orb on the way to a
// battlestaff (spell: its name; magicLevel: the Magic level it takes).
// pays: inputs that are a fee (the tanner's coins): never taken from a bank,
// never holding a plan back, always a cost. at: what the step takes instead at
// another place (the Canifis tanner's fee); PLACES names the choice.
// An item with gp is always worth that (a coin is 1 gp): no market price.

export const GAME_REVISION = 274;
export const ICON_SIZE = ${SIZE};
export const ICONS_PER_ROW = ${PER_ROW};

export const ITEMS = ${JSON.stringify(items, null, 0).replace(/\},"/g, '},\n  "').replace(/^\{/, '{\n  ').replace(/\}$/, '\n}')};

export const METHODS = [
${methods.map(m => '  ' + JSON.stringify(m)).join(',\n')},
];

// Unidentified herbs: one bank entry (the market's unid listing), and the XP
// identifying one gives, in tenths, lowest and highest across the herbs.
export const UNID_HERBS = ${JSON.stringify(unidHerbs)};

// What the Bank tab lists for each skill, in groups.
export const BANK_GROUPS = ${JSON.stringify(bankGroups, null, 2)};

// What the Prices tab lists besides: things the market trades as one item that
// aren't an item in the game, so never in a bank (a set of dragonhide armour;
// its ITEMS entry has set: the pieces).
export const SALE_GROUPS = ${JSON.stringify(saleGroups, null, 2)};

// Where a skill has a choice of place that changes what a step takes: the
// tanner (the first is the default; a method's "at" has the others' amounts).
export const PLACES = ${JSON.stringify(places, null, 2)};
`;
await writeFile('gamedata.js', out);
console.log(`gamedata.js: ${methods.length} methods, ${names.length} items; items.png ${PER_ROW * SIZE}x${rows * SIZE}`);
for (const note of craftingNotes) console.log(`  crafting: ${note}`);

// ── Bank screenshots ───────────────────────────────────────────────────────
// What bankread.js needs to read a bank from a screenshot, loaded only when one
// is read: the bank's layout, the font stack numbers are drawn in, and the
// icons to compare slots with (bankicons.png).
//
// Icons are matched on their outline first: the client draws it in one fixed
// colour (1, near black), so a shape is exact whatever the brightness setting.
// Colour then picks the item among the same shape. So the icon set holds every
// planner item, the icons arrows and bolts switch to in bigger stacks, and
// every other item with one of those outlines, so a lookalike (a 4-dose potion,
// a quest herb) is recognised as something else instead of taken for ours.
async function bankScreenshots() {
  // Layout, from the bank interface: the scrolling layer and the item grid in it.
  const bankIf = await readConfig(scripts('interface_bank/interfaces/bank_main.if'));
  const grid = bankIf.get('inv');
  const view = bankIf.get(grid.props.layer);
  const [marginX, marginY] = grid.props.margin.split(',').map(Number);
  const layout = {
    cols: Number(grid.props.width), rows: Number(grid.props.height),
    pitchX: 32 + marginX, pitchY: 32 + marginY,
    gridX: Number(grid.props.x), gridY: Number(grid.props.y),         // grid inside the scrolling view
    viewW: Number(view.props.width), viewH: Number(view.props.height), scrollHeight: Number(view.props.scroll),
  };

  // Stack numbers: the client's p11 font, rebuilt from fonts/p11_full.png the
  // way the engine packs it (each 20x20 cell cropped to its pixels) and the
  // client loads it (spacing worked out from the edge columns).
  const fontPng = await sharp(join(CONTENT, 'fonts/p11_full.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [cellW, cellH] = (await readFile(join(CONTENT, 'fonts/meta/p11_full.opt'), 'ascii')).trim().split('x').map(Number);
  const glyph = c => {
    const tx = (c % 16) * cellW, ty = Math.floor(c / 16) * cellH;
    const on = (x, y) => { const p = ((ty + y) * fontPng.info.width + tx + x) * 4; return !(fontPng.data[p] === 0xff && fontPng.data[p + 1] === 0 && fontPng.data[p + 2] === 0xff); };
    let l = cellW, t = cellH, r = -1, b = -1;
    for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) if (on(x, y)) { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); }
    if (r < 0) return { offX: 0, offY: 0, w: cellW, h: cellH, adv: cellW + 2, mask: '' };
    const w = r - l + 1, h = b - t + 1;
    let mask = '';
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask += on(l + x, t + y) ? '1' : '0';
    let offX = 1, adv = w + 2;
    const k = Math.floor(h / 7);
    let s = 0;
    for (let y = k; y < h; y++) s += Number(mask[y * w]);
    if (s <= k) { adv--; offX = 0; }
    s = 0;
    for (let y = k; y < h; y++) s += Number(mask[w + y * w - 1]);
    if (s <= k) adv--;
    return { offX, offY: t, w, h, adv, mask };
  };
  let height = 0;
  for (let c = 0; c < 128; c++) height = Math.max(height, glyph(c).h);
  const font = { height, glyphs: Object.fromEntries([...'0123456789KM'].map(ch => [ch, glyph(ch.charCodeAt(0))])) };

  // Count variants: the icon a stack switches to (count1=bronze_arrow_2,2 …).
  const variants = new Map();               // variant -> base item
  const { readdir } = await import('node:fs/promises');
  const objFiles = (await readdir(scripts(''), { recursive: true })).filter(f => f.endsWith('.obj'));
  for (const f of objFiles) {
    for (const block of (await readConfig(scripts(f))).values()) {
      if (!items[block.name] || fixedPrices[block.name] != null) continue;      // (coins aren't read: they're a fee here, not a bank item)
      for (const [k, v] of Object.entries(block.props)) if (/^count\d+$/.test(k)) variants.set(need(v.split(',')[0]), block.name);
    }
  }

  // Outlines of every icon on LostHQ's sheet.
  const iconPixels = id => {
    const sx = (id % 64) * SIZE, sy = Math.floor(id / 64) * SIZE, px = Buffer.alloc(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) sheet.copy(px, y * SIZE * 4, ((sy + y) * sheetMeta.width + sx) * 4, ((sy + y) * sheetMeta.width + sx + SIZE) * 4);
    return px;
  };
  const outlineOf = px => {
    const k = [];
    for (let i = 0; i < SIZE * SIZE; i++) if (px[i * 4 + 3] && px[i * 4] === 0 && px[i * 4 + 1] === 0 && px[i * 4 + 2] === 1) k.push(i);
    return k.length >= 8 ? k.join(',') : null;
  };
  const byOutline = new Map();
  for (const it of itemList) {
    if (it.id >= (sheetMeta.width / SIZE) * (sheetMeta.height / SIZE)) continue;
    const key = outlineOf(iconPixels(it.id));
    if (key) (byOutline.get(key) || byOutline.set(key, []).get(key)).push(it.debugname);
  }

  // The icon set: ours first, then variants, then lookalikes. An icon that is
  // pixel for pixel another one already in the set adds nothing and is left out;
  // when it's one of ours it's noted under also, since a screenshot can't tell
  // them apart (lantadyme has no colour of its own in this version, so it looks
  // like any unid herb). When it's something the planner doesn't use that you
  // could well have in a bank (an amulet of glory is a dragonstone amulet with
  // a spell on it; a jug of wine looks like wine of Zamorak), its name is noted
  // under like, so the review can say the two look the same.
  const unidKey = outlineOf(iconPixels(ITEM.get(unidHerbs.item).id));
  const entries = [];
  const seen = new Map();                    // pixels -> entry
  // Twins worth naming: tradeable ones, and the Dramen staff (a quest reward
  // most banks hold). Not other quest and minigame pieces, which would only add noise.
  const KEEPSAKES = new Set(['dramen_staff']);
  const add = (slug, extra = {}) => {
    const px = iconPixels(ITEM.get(slug).id);
    const key = px.toString('base64');
    if (!outlineOf(px)) return;
    if (seen.has(key)) {
      const kept = seen.get(key);
      if (items[slug] && slug !== kept.slug && !kept.also?.includes(slug)) (kept.also ||= []).push(slug);
      else if (!items[slug] && items[kept.slug] && !kept.of && kept.slug !== unidHerbs.item && !slug.startsWith('cert_')
        && (ITEM.get(slug).tradeable === true || KEEPSAKES.has(slug))) {
        // "Ring of dueling(7)" … "(1)" are one name; beside the (8) they're the same ring, part used
        const bare = n => n.replace(/\s*\(\d+\)$/, '');
        const ours = items[kept.slug].name;
        const twin = bare(ITEM.get(slug).name) === bare(ours) ? `${bare(ours)} (fewer charges)` : bare(ITEM.get(slug).name);
        if (twin !== ours && !kept.like?.includes(twin)) (kept.like ||= []).push(twin);
      }
      return;
    }
    const e = { slug, ...extra };
    seen.set(key, e);
    entries.push({ e, px });
  };
  // Enchanted jewellery looks exactly like the plain piece it's made from. In a
  // bank it's far more often the enchanted one (a ring of dueling, not an emerald
  // ring), so that's what such an icon is read as; the plain one is noted under also.
  const enchantedFirst = methods.filter(m => m.id.startsWith('cr_ench_')).map(m => Object.keys(m.out)[0]);
  for (const name of [...enchantedFirst, ...names]) if (fixedPrices[name] == null) add(name);
  for (const [v, base] of variants) add(v, { of: base });
  const ours = new Set(entries.map(x => x.e.slug));
  for (const { px } of [...entries]) {
    for (const other of byOutline.get(outlineOf(px)) || []) {
      if (ours.has(other)) continue;
      // every unidentified herb is the same "Herb": counted as the one unid entry
      const unid = outlineOf(px) === unidKey && other.startsWith('unidentified_');
      add(other, unid ? { of: unidHerbs.item } : { other: 1 });
    }
  }

  const bRows = Math.ceil(entries.length / PER_ROW);
  const bAtlas = Buffer.alloc(PER_ROW * SIZE * bRows * SIZE * 4);
  entries.forEach(({ px }, n) => {
    const dx = (n % PER_ROW) * SIZE, dy = Math.floor(n / PER_ROW) * SIZE;
    for (let y = 0; y < SIZE; y++) px.copy(bAtlas, ((dy + y) * PER_ROW * SIZE + dx) * 4, y * SIZE * 4, (y + 1) * SIZE * 4);
  });
  await sharp(bAtlas, { raw: { width: PER_ROW * SIZE, height: bRows * SIZE, channels: 4 } })
    .png({ compressionLevel: 9, palette: false }).toFile('bankicons.png');

  await writeFile('bankread-data.js', `// Generated by build-data.mjs. Do not edit by hand; change the script and re-run it.
// What bankread.js reads a bank screenshot with. Layout from Lost City's bank
// interface and font from fonts/p11_full.png (LostCityRS/Content, MIT); icons
// in bankicons.png from LostHQ's item sheet (GPL-3.0). RuneScape is (c) Jagex Ltd.

// The bank's item grid, inside a view that scrolls (sizes in pixels).
export const BANK_LAYOUT = ${JSON.stringify(layout)};

// Stack numbers: glyphs of the p11 font. mask is row by row, '1' = drawn.
export const STACK_FONT = ${JSON.stringify(font)};

// bankicons.png, ${PER_ROW} per row, in this order. slug: a planner item, or with
// of: an icon of that item (a bigger stack of arrows, any unid herb), or with
// other: an item the planner doesn't use that looks like one it does.
// also: other planner items with the very same icon; like: names of items the
// planner doesn't use that have it too (an amulet of glory, a jug of wine).
export const BANK_ICONS_PER_ROW = ${PER_ROW};
export const BANK_ICONS = [
${entries.map(({ e }) => '  ' + JSON.stringify(e)).join(',\n')},
];
`);
  const counts = entries.reduce((a, { e }) => { a[e.of ? 'variants' : e.other ? 'others' : 'ours']++; return a; }, { ours: 0, variants: 0, others: 0 });
  console.log(`bankread-data.js: ${entries.length} icons (${counts.ours} planner items, ${counts.variants} variants, ${counts.others} lookalikes); bankicons.png ${PER_ROW * SIZE}x${bRows * SIZE}`);
}

await bankScreenshots();
