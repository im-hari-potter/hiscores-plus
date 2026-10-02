// Builds gamedata.js and items.png: the skill calculator data Skills+ plans with.
//
//   node build-data.mjs <Content checkout> <LostHQ 2004 checkout>
//
// Sources (both are checked out from GitHub, nothing is fetched here):
//   - Lost City's server content, LostCityRS/Content, branch 274 (MIT). Levels and
//     XP come straight from the configs the game server runs, so the numbers are the
//     game's own. XP is kept in tenths, the way the server stores it.
//   - LostHQ/2004 (GPL-3.0): item_data.json for names, ids and shop values,
//     item_spritesheet.png for the 32x32 item icons, and for Crafting, Mining and
//     Smithing the rows of its calculators (js/calculators/), checked against
//     the server.
// The output is committed, so the site itself never needs either checkout.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

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
const unchargedOf = {};      // a charged item -> the same thing with no charges left, a bank item of its own (an amulet of glory)

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

  // Two potions that share an ingredient: when a bank can make either, the one
  // named first gets it first (Ostap's call, v2.7: the one worth having), and
  // the other waits until that one can't be made. Super attacks get the irits
  // before superantipoisons, prayer potions the snape grass before fishing
  // potions. (An order of your own, dragged on the goal, overrides it.)
  const FIRST = [['3dose2attack', '3dose2antipoison'], ['3doseprayerrestore', '3dosefisherspotion']];
  const potionRow = out => methods.find(m => m.id === `hb_${out}`) || (() => { throw new Error(`herblore: no potion ${out}`); })();
  const leaves = m => Object.keys(m.in).flatMap(k => { const u = methods.find(x => x.kind === 'prep' && x.out[k]); return u ? Object.keys(u.in) : [k]; });
  for (const [first, then] of FIRST) {
    const a = potionRow(first), b = potionRow(then);
    if (!leaves(a).some(k => k !== 'vial_water' && leaves(b).includes(k))) throw new Error(`herblore: ${first} and ${then} share no ingredient`);
    (b.after ||= []).push(a.id);
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
      // What the spell itself makes is the uncharged one: not what a row makes
      // (it's traded charged), but banks hold them, so it's an item of its own.
      if (charged.has(to)) {
        unchargedOf[final] = need(to);
        nameOverride[to] = `${ITEM.get(to).name} (uncharged)`;
      }
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
    { name: 'Made: enchanted jewellery', items: enchanted.flatMap(k => (unchargedOf[k] ? [unchargedOf[k], k] : [k])) },
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

// A LostHQ calculator's tables: the part of its script before runCalc, which
// only sets them up (what else is there are functions for its own page).
async function calculatorTables(file, names) {
  const src = await readFile(join(LOSTHQ, 'js/calculators', file), 'utf8');
  const end = src.indexOf('function runCalc');
  if (end < 0) throw new Error(`${file}: can't find where its tables end`);
  return new Function(`${src.slice(0, end)}\nreturn { ${names.join(', ')} };`)();
}

// ── Mining ─────────────────────────────────────────────────────────────────
// One method per rock, XP per ore. Nothing goes in (only a pickaxe you have the
// level for), so these plans don't use the bank. The rows are LostHQ's Mining
// calculator (js/calculators/mining.js), each checked against the server's
// mining table, plus the one rock that table has and the calculator leaves
// out: limestone (it's on the map, at level 10). A gem rock gives one gem by
// chance, so what it makes is the server's chances for each.
const miningNotes = [];
const minedRocks = new Map();                 // ore -> { level, xp }: what a rock gives, for the bar rows (miningBars)
async function mining() {
  const dir = p => scripts('skill_mining/' + p);
  const x10 = xp => Math.round(xp * 10);
  const { ores: calc } = await calculatorTables('mining.js', ['ores']);

  // The server's rocks: what each gives, the level it takes, the XP an ore.
  // (Not a way to train: the rocks of the Tourist Trap's mining camp.)
  const SKIP = new Set(['desertrescue_rock']);
  const GEM_ROCK = 'gemrock';                 // the calculator's key for it, and the server's name for the rock
  const rocks = new Map();                    // what comes out (or gemrock) -> { level, xp }
  for (const row of (await readConfig(dir('configs/mine.dbrow'))).values()) {
    if (SKIP.has(row.name)) continue;
    const d = fields(row);
    const key = d.rock_output ? d.rock_output[0] : d.rock[0];
    const r = { level: Number(d.rock_level[0]), xp: Number(d.rock_exp[0]) };
    const seen = rocks.get(key);
    if (seen && (seen.level !== r.level || seen.xp !== r.xp)) throw new Error(`mining: two rocks give ${key}, with different levels or XP`);
    rocks.set(key, r);
  }
  if (!rocks.has(GEM_ROCK)) throw new Error('mining: no gem rock on the server');
  // A gem rock: one roll on the gem rock table.
  const table = (await readConfig(dir('configs/gem_rock_table.dbrow'))).get('gem_rock_table');
  const total = Number(table.data.find(([k]) => k === 'total')[1]);
  const gems = table.data.filter(([k]) => k === 'drop').map(([, item, count, weight]) => ({ item: need(item), count: Number(count), weight: Number(weight) }));
  if (!gems.length || gems.reduce((a, g) => a + g.weight, 0) !== total) throw new Error("mining: the gem rock table's chances don't add up");

  // The calculator's rows, checked; a rock only the server has stops the build
  // until it's been looked at and listed here.
  const SERVER_ONLY = new Set(['limestone']);
  for (const [key, row] of Object.entries(calc)) {
    const r = rocks.get(key);
    if (!r) throw new Error(`mining: the server has no rock for the calculator's ${key}`);
    if (r.level !== row.level || r.xp !== x10(row.xp)) throw new Error(`mining ${key}: the calculator says level ${row.level}, ${row.xp} XP; the server level ${r.level}, ${r.xp / 10} XP`);
  }
  const order = Object.keys(calc);
  for (const key of rocks.keys()) {
    if (key in calc) continue;
    if (!SERVER_ONLY.has(key)) throw new Error(`mining: the server has a rock the calculator doesn't (${key}): look at it, then list it`);
    // by level, after the calculator's rows of that level
    const at = order.findIndex(o => rocks.get(o).level > rocks.get(key).level);
    order.splice(at < 0 ? order.length : at, 0, key);
    miningNotes.push(`${ITEM.get(need(key)).name}: level ${rocks.get(key).level}, ${rocks.get(key).xp / 10} XP on the server; not in LostHQ's calculator (added)`);
  }

  // Pickaxes: the app says which level each takes, so the build checks it still holds.
  const PICKS = { bronze_pickaxe: 0, iron_pickaxe: 0, steel_pickaxe: 6, mithril_pickaxe: 21, adamant_pickaxe: 31, rune_pickaxe: 41 };
  const picks = await readConfig(dir('configs/pickaxes.obj'));
  for (const [pick, level] of Object.entries(PICKS)) {
    if (Number(picks.get(pick)?.params.levelrequire) !== level) throw new Error(`mining: the ${pick} no longer takes level ${level}; the app's wording says it does`);
  }
  if ([...picks.values()].filter(b => b.params.mining_rate).length !== Object.keys(PICKS).length) throw new Error('mining: the server has a pickaxe the app does not name');

  const chance = g => `${ITEM.get(g.item).name.replace(/^Uncut /, '').toLowerCase()} ${g.weight}`;
  const NOTES = {
    [GEM_ROCK]: `In Shilo Village. One gem a rock, by chance (out of ${total}): ${gems.map(chance).join(', ')}.`,
    limestone: "Not on LostHQ's calculator: the server's own level and XP.",
  };
  for (const [key, r] of rocks) if (key !== GEM_ROCK) minedRocks.set(key, r);
  for (const key of order) {
    const r = rocks.get(key);
    const gem = key === GEM_ROCK;
    methods.push({
      id: `mi_${key}`, skill: 'mining', group: 'Rocks', kind: 'xp',
      name: gem ? 'Gem rock' : ITEM.get(need(key)).name, level: r.level, xp: r.xp, in: {},
      out: gem ? Object.fromEntries(gems.map(g => [g.item, (g.count * g.weight) / total])) : { [key]: 1 },
      // (the calculator shows a gem rock as an uncut red topaz)
      ...(gem ? { icon: need('uncut_red_topaz') } : {}),
      ...(NOTES[key] ? { note: NOTES[key] } : {}),
    });
  }
}

await mining();

// ── Smithing ───────────────────────────────────────────────────────────────
// The rows are LostHQ's Smithing calculator (js/calculators/smithing.js): its
// smelting list, and its anvil table for each metal, in its order. Every row is
// checked against the server's own tables; a difference stops the build.
//
// A bar you smelt feeds the anvil rows, the way a cut gem feeds a ring: with ore
// in your bank a plan smelts it on the way, and that XP counts.
//
// Three things the calculator has as extra rows or modes are a choice on the
// goal here (CHOICES), since you either do the thing or you don't:
//   bars      - where your bars come from. Buy them: what's still to buy is
//               bars (the calculator's Smithing mode). Smelt them: it's ore and
//               coal, and the smelting XP counts (its Smelting + smithing
//               mode). Superheat them: the same, made with the Superheat Item
//               spell: its runes a bar, Magic XP on top, and iron never fails.
//   ring      - a ring of forging: every iron ore becomes a bar, and a ring
//               lasts 140 bars. Without one half the ore is lost in a furnace,
//               so a bar takes 2 ore on average (the calculator's "No Ring of
//               Forging" row).
//   gauntlets - goldsmith gauntlets: 2.5 times the XP for a gold bar (the
//               calculator's "Gauntlets" row).
// A method's opt says what each choice changes about it.
const smithingNotes = [];
const smeltedBars = [];      // the bars a furnace makes, in the calculator's order: { bar, in, level, lost } (for miningBars)
const choices = {};          // skill -> the choices a goal has: [{ id, label, tip }]
const chargeItems = {};      // what a worn item gives while it lasts: slug -> { id, name, of, per }
async function smithing() {
  const dir = p => scripts('skill_smithing/' + p);
  const x10 = xp => Math.round(xp * 10);
  const name = k => nameOverride[k] || ITEM.get(need(k)).name;
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const { smithingXP: calc, smeltingXP: calcSmelt } = await calculatorTables('smithing.js', ['smithingXP', 'smeltingXP']);
  // (objects are compared whatever order their keys come in)
  const text = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
  const differ = (what, calcValue, serverValue) => {
    if (text(calcValue) !== text(serverValue)) throw new Error(`smithing ${what}: the calculator says ${text(calcValue)}, the server ${text(serverValue)}`);
  };

  // ── The server's side ──
  // Smelting: a bar from its ore, some with coal, at a furnace.
  const smelts = new Map();                   // bar -> { level, xp, in }
  for (const b of (await readConfig(dir('configs/smelting/smelting.struct'))).values()) {
    const p = b.params;
    smelts.set(need(p.product), { level: Number(p.levelrequired), xp: Number(p.productexp),
      in: { [need(p.ingredient)]: Number(p.bar_count), ...(p.ingredient_secondary ? { [need(p.ingredient_secondary)]: Number(p.ingredient_secondary_count) } : {}) } });
  }
  const smeltScript = await readFile(dir('scripts/smelting/smelting.rs2'), 'utf8');
  // Iron: with a ring of forging worn it always works (and the ring loses a
  // charge); without, one try in two fails and the ore is gone.
  const iron = smeltScript.match(/if \(\$product = (\w+)\) \{[^}]*?inv_total\(worn, (\w+)\) > 0[^}]*?~lose_charge_ring_of_forging;\s*\} else if \(randominc\((\d+)\) = 1\)/);
  if (!iron || iron[1] !== 'iron_bar') throw new Error("smithing: can't read how iron ore fails in the furnace");
  const ring = need(iron[2]);
  if (Number(iron[3]) !== 1) throw new Error('smithing: iron no longer fails one try in two');
  const orePerBar = 2;                        // on average, with one try in two failing
  const ringBars = fromScript(await readFile(scripts('general/scripts/enchanted_jewellry/ring_of_forging.rs2'), 'utf8'),
    /%ring_of_forging >= (\d+)/, 'how many bars a ring of forging lasts');
  // Gold: goldsmith gauntlets scale the XP.
  const gold = smeltScript.match(/if \(\$product = (\w+) & inv_total\(worn, (\w+)\) > 0\) \{\s*\$xp = scale\((\d+), (\d+), \$xp\)/);
  if (!gold || gold[1] !== 'gold_bar') throw new Error("smithing: can't read what the goldsmith gauntlets do");
  const gauntlets = need(gold[2]);
  const gauntletXp = Math.floor((smelts.get('gold_bar').xp * Number(gold[3])) / Number(gold[4]));      // the engine's scale(): whole tenths

  // Superheat Item: smelts one bar anywhere, for its runes. The same Smithing XP
  // (gauntlets and all), Magic XP on top, and no furnace for the iron to fail in.
  const spell = fields((await readConfig(scripts('skill_magic/configs/magic_spells.dbrow'))).get('magic_spell_superheat') || {});
  if (!spell.runesrequired) throw new Error("smithing: can't find the Superheat Item spell");
  const superheat = { spell: 'Superheat Item', magic: Number(spell.experience[0]), magicLevel: Number(spell.levelrequired[0]), runes: {} };
  for (let i = 0; i + 1 < spell.runesrequired.length; i += 2) if (spell.runesrequired[i] !== 'null') superheat.runes[need(spell.runesrequired[i])] = Number(spell.runesrequired[i + 1]);
  if (!(superheat.magic > 0) || !(superheat.magicLevel > 0) || !Object.keys(superheat.runes).length) throw new Error("smithing: can't read the Superheat Item spell");
  const heatScript = await readFile(scripts('skill_magic/scripts/spells/superheat.rs2'), 'utf8');
  if (/randominc/.test(heatScript)) throw new Error('smithing: Superheat Item can fail now; the data says it never does');
  if (!/\$smith_xp = struct_param\(\$bar_struct, productexp\)/.test(heatScript)) throw new Error("smithing: Superheat Item no longer gives the bar's own Smithing XP");
  if (!new RegExp(`\\$bar = gold_bar & inv_total\\(worn, ${gold[2]}\\) > 0\\) \\{\\s*\\$smith_xp = scale\\(${gold[3]}, ${gold[4]}, \\$smith_xp\\)`).test(heatScript)) throw new Error("smithing: the gauntlets no longer count for Superheat Item");
  const noHeat = [...heatScript.matchAll(/if\(\$ore1 = (\w+)\) \{\s*mes\("Even this spell is not hot enough/g)].map(m => m[1]);   // ores it won't melt

  // Cannonballs: a steel bar poured into an ammo mould at a furnace.
  const ballScript = await readFile(dir('scripts/smelting/cannonballs.rs2'), 'utf8');
  const ballMade = ballScript.match(/inv_del\(inv, (\w+), (\d+)\);\s*inv_add\(inv, (\w+), (\d+)\);/);
  if (!ballMade) throw new Error("smithing: can't read what a cannonball takes");
  const ball = {
    item: need(ballMade[3]), count: Number(ballMade[4]), bar: need(ballMade[1]), bars: Number(ballMade[2]),
    level: fromScript(ballScript, /stat\(smithing\) < (\d+)/, 'the level for cannonballs'),
    xp: fromScript(ballScript, /stat_advance\(smithing, (\d+)\)/, 'the XP for cannonballs'),
    mould: need(fromScriptText(ballScript, /inv_total\(inv, (\w+)\) < 1\) \{\s*mes\("You need a cannonball mould/, 'the mould for cannonballs')),
  };

  // The elemental bar: smelted at the Elemental Workshop's own furnace. The
  // server asks for a Smithing level only to work the bars (the calculator's 20).
  const ew = await readFile(scripts('quests/quest_elemental_workshop/scripts/quest_elemental_workshop.rs2'), 'utf8');
  const furnace = ew.slice(ew.indexOf('[oplocu,elemental_workshop_furnace]')).split(/\n\[/)[0];
  const smeltPart = furnace.slice(furnace.indexOf('if($last_useitem = elemental_workshop_ore)'));
  const elemental = {
    bar: need(fromScriptText(smeltPart, /inv_add\(inv, (\w+), 1\)/, 'the elemental bar')),
    in: Object.fromEntries([...smeltPart.matchAll(/inv_del\(inv, (\w+), (\d+)\)/g)].map(m => [need(m[1]), Number(m[2])])),
    xp: fromScript(smeltPart, /stat_advance\(smithing, (\d+)\)/, 'the XP for an elemental bar'),
    level: fromScript(ew, /stat\(smithing\) < (\d+)\) \{\s*~mesbox\("You need a Smithing level of at least \d+ to work elemental bars/, 'the level for elemental bars'),
  };

  // The anvil: what each bar makes, how many bars it takes and how many come
  // out. XP is per bar, the same for everything a metal makes.
  const perBar = new Map([...(await readConfig(dir('configs/smithing/smithing.struct'))).values()].map(b => [b.params.namedobj, Number(b.params.xpperbar)]));
  const anvil = new Map();                    // product -> { bar, bars, count, level, xp }
  for (const row of (await readConfig(dir('configs/smithing/smithing.dbrow'))).values()) {
    const d = fields(row);
    const bar = d.bar[0], bars = Number(d.bar_amount[0]);
    if (!perBar.has(bar)) throw new Error(`smithing: no XP per bar for ${bar}`);
    anvil.set(need(d.product[0]), { bar: need(bar), bars, count: Number(d.product_amount[0]), level: Number(d.levelrequired[0]), xp: bars * perBar.get(bar) });
  }
  const anvilScript = await readFile(dir('scripts/smithing/smithing.rs2'), 'utf8');
  // Two kinds of thing need a quest done first; the row's tooltip says so.
  if (!/_dart_tip\s*:\s*if \(%desertrescue < \^desertrescue_learned_darts\)/.test(anvilScript)) throw new Error("smithing: dart tips no longer wait for The Tourist Trap");
  if (!/if\(%death_equiproom < \^death_complete\) \{\s*if_sethide\(smithing:claws_layer, true\)/.test(anvilScript)) throw new Error('smithing: claws no longer wait for Death Plateau');
  const hammer = need(fromScriptText(anvilScript, /inv_total\(inv, (\w+)\) < 1\) \{\s*~mesbox\("You need a hammer/, 'the hammer'));
  const questNote = key => (/_dart_tip$/.test(key) ? 'Dart tips can be smithed once The Tourist Trap is done.' : /_claws$/.test(key) ? 'Claws can be smithed once Death Plateau is done.' : null);

  // ── The calculator's rows ──
  const SMELT = 'Smelting';
  const METAL = { bronze_bar: 'Bronze', iron_bar: 'Iron', steel_bar: 'Steel', mithril_bar: 'Mithril', adamantite_bar: 'Adamant', runite_bar: 'Rune' };
  for (const bar of Object.keys(calc)) if (!METAL[bar]) throw new Error(`smithing.js has a metal this script doesn't know: ${bar}`);
  const charge = 'ring_of_forging_charge';    // a bar's worth of a ring of forging
  chargeItems[charge] = { id: 1_000_101, name: `${ITEM.get(ring).name} charge`, of: ring, per: ringBars };
  const smelted = [];                          // bars, in the calculator's order
  for (const [key, row] of Object.entries(calcSmelt)) {
    // its two extra rows are choices here; they're checked all the same
    if (key === 'iron_bar_no_forging') {
      differ('iron without a ring', [row.level, x10(row.xp), row.ingredients], [smelts.get('iron_bar').level, smelts.get('iron_bar').xp, { iron_ore: orePerBar }]);
      continue;
    }
    if (key === 'gold_smithgauntlets') {
      differ('gold with gauntlets', [row.level, x10(row.xp), row.ingredients], [smelts.get('gold_bar').level, gauntletXp, smelts.get('gold_bar').in]);
      continue;
    }
    const s = key === elemental.bar ? elemental : smelts.get(key);
    if (!s) throw new Error(`smithing: the server smelts no ${key}`);
    differ(key, [row.level, x10(row.xp), row.ingredients], [s.level, s.xp, s.in]);
    smelted.push(key);
    // (lost: the ore a bar takes on average where a furnace can lose it, iron's 2)
    smeltedBars.push({ bar: key, in: s.in, level: s.level, ...(key === 'iron_bar' ? { lost: { iron_ore: orePerBar }, ring } : {}) });
    const m = { id: `sm_${key}`, skill: 'smithing', group: SMELT, kind: 'xp', name: name(key), level: s.level, xp: s.xp, in: s.in, out: { [key]: 1 } };
    if (key === 'iron_bar') {
      m.in = { [need('iron_ore')]: orePerBar };
      m.note = `Half the iron ore is lost in a furnace, so a bar takes ${orePerBar} ore on average. A ring of forging or Superheat Item saves it all: see Ring of forging and Bars on the goal.`;
      m.opt = { ring: { in: { ...s.in, [charge]: 1 }, note: `With a ring of forging every ore is a bar. A ring lasts ${ringBars} bars, and they're counted.` } };
    }
    if (key === 'gold_bar') {
      m.note = `With goldsmith gauntlets it's ${gauntletXp / 10} XP: tick Goldsmith gauntlets on the goal.`;
      m.opt = { gauntlets: { xp: gauntletXp, note: `${gauntletXp / 10} XP with goldsmith gauntlets worn (${s.xp / 10} without).` } };
    }
    if (key === elemental.bar) m.note = "Elemental Workshop: smelted at the workshop's own furnace. The ore is dropped by the rock elementals there.";
    // Superheated: the server's own ingredients (one iron ore: it can't fail) and the spell's runes.
    if (!Object.keys(s.in).some(k => noHeat.includes(k))) {
      m.opt = { ...m.opt, superheat: { ...(same(m.in, s.in) ? {} : { in: s.in }), add: superheat.runes, magic: superheat.magic, spell: superheat.spell, magicLevel: superheat.magicLevel,
        note: `Made with ${superheat.spell} (Magic ${superheat.magicLevel}): ${superheat.magic / 10} Magic XP each, on top of the Smithing XP.${key === 'iron_bar' ? ' It never fails: every iron ore is a bar, with no ring of forging.' : ''}` } };
    }
    methods.push(m);
  }
  for (const key of smelts.keys()) {
    // (the 'perfect' gold of Family Crest is a quest item)
    if (!smelted.includes(key) && key !== 'perfect_gold_bar') throw new Error(`smithing: the server smelts ${key}, which the calculator doesn't list`);
  }
  // The ring: worn, it's used up a bar at a time. A step on the way, so plans
  // count whole rings and what's left of one carries on.
  methods.push({ id: `sm_${ring}`, skill: 'smithing', group: 'Ring of forging', kind: 'prep', name: `${ITEM.get(ring).name} (${ringBars} bars)`, level: 1, xp: 0,
    in: { [ring]: 1 }, out: { [charge]: ringBars } });

  const made = {};                             // group -> what its rows make
  const seen = new Set();
  for (const [bar, rows] of Object.entries(calc)) {
    const group = METAL[bar];
    made[group] = [];
    for (const [key, row] of Object.entries(rows)) {
      let a = anvil.get(key), furnaceJob = false;
      if (!a && key === ball.item) { a = { bar: ball.bar, bars: ball.bars, count: ball.count, level: ball.level, xp: ball.xp }; furnaceJob = true; }
      if (!a) throw new Error(`smithing: the server makes no ${key}`);
      differ(key, [bar, row.bars, row.level, x10(row.xp)], [a.bar, a.bars, a.level, a.xp]);
      seen.add(key);
      made[group].push(key);
      const note = furnaceJob ? 'Made at a furnace, not an anvil, with an ammo mould (from Dwarf Cannon).' : questNote(key);
      methods.push({
        id: `sm_${key}`, skill: 'smithing', group, kind: 'xp', tools: [furnaceJob ? ball.mould : hammer],
        // more than one from a bar is counted in bars: "100 bars → 1,500 Bronze arrowtips"
        ...(a.count > 1 ? { unit: 'bar', units: 'bars' } : {}),
        name: name(key), level: a.level, xp: a.xp, in: { [a.bar]: a.bars }, out: { [key]: a.count },
        ...(note ? { note } : {}),
      });
    }
  }
  for (const key of anvil.keys()) if (!seen.has(key)) throw new Error(`smithing: the server makes ${key}, which the calculator doesn't list`);

  // A bar an anvil row takes feeds it: with ore in your bank a plan smelts it
  // on the way. When you make your own bars (smelted or superheated) it's
  // planned through from scratch too: ore and coal on the list, and the
  // smelting XP counted.
  const mine = methods.filter(m => m.skill === 'smithing');
  const inputs = new Set(mine.flatMap(m => Object.keys(m.in)));
  for (const m of mine) {
    if (m.group !== SMELT || !Object.keys(m.out).some(k => inputs.has(k))) continue;
    m.feeds = 1;
    m.opt = { ...m.opt, smelt: { through: 1 }, ...(m.opt?.superheat ? { superheat: { ...m.opt.superheat, through: 1 } } : {}) };
  }

  const runeText = Object.entries(superheat.runes).map(([k, n]) => `${n === 1 ? (/^[aeiou]/i.test(ITEM.get(k).name) ? 'an' : 'a') : n} ${ITEM.get(k).name.toLowerCase()}${n === 1 ? '' : 's'}`).join(' and ');
  // A choice with options is a list to pick from (the first is how it starts,
  // and changes nothing); one without is a tick box. unless: a choice that makes
  // this one pointless, so it's left out then.
  choices.smithing = [
    { id: 'bars', label: 'Bars', options: [{ id: 'buy', name: 'Buy them' }, { id: 'smelt', name: 'Smelt them' }, { id: 'superheat', name: 'Superheat them' }],
      tip: `Buy them: what's still to buy is bars (ore in your bank is still smelted on the way, at a furnace). Smelt them: it's ore and coal, and the smelting XP counts toward your goal. ` +
        `Superheat them: the same, made with ${superheat.spell} (Magic ${superheat.magicLevel}): ${runeText} a bar, ${superheat.magic / 10} Magic XP each, and iron never fails.` },
    { id: 'ring', label: 'Ring of forging', unless: 'superheat',
      tip: `On: every iron ore is a bar, and rings of forging are counted (one lasts ${ringBars} bars). Off: half the iron ore is lost in a furnace, so an iron bar takes ${orePerBar} ore on average.` },
    { id: 'gauntlets', label: 'Goldsmith gauntlets',
      tip: `On: a gold bar gives ${gauntletXp / 10} XP. Off: ${smelts.get('gold_bar').xp / 10} XP.` },
  ];

  // The Bank tab: ores, bars, the ring and the runes, then what each metal makes.
  const coal = need('coal');
  const ores = [...new Set(smelted.flatMap(k => Object.keys((k === elemental.bar ? elemental : smelts.get(k)).in)))].filter(k => k !== coal).concat(coal);
  bankGroups.smithing = [
    { name: 'Ores and coal', items: ores },
    { name: 'Bars', items: smelted },
    { name: 'Ring of forging and runes for Superheat', items: [ring, ...Object.keys(superheat.runes)] },
    ...Object.entries(made).map(([group, items]) => ({ name: `Made: ${group.toLowerCase()}`, items })),
  ];
  smithingNotes.push(`${smelted.length} bars, ${seen.size} anvil and furnace rows; a ring of forging lasts ${ringBars} bars; gold with gauntlets ${gauntletXp / 10} XP; ${superheat.spell}: Magic ${superheat.magicLevel}, ${runeText}, ${superheat.magic / 10} Magic XP (not: ${noHeat.map(k => ITEM.get(k)?.name || k).join(', ')})`);
}

await smithing();

// ── Mining, by the bar ─────────────────────────────────────────────────────
// A second way to count Mining (v2.7): the ore a bar takes, mined together. A
// steel bar is 1 iron ore and 2 coal, so its row is the XP of all three and a
// plan says how much of each to mine. One row for every bar a furnace makes
// from ore you can mine (the server's smelting table, as Smithing has it); an
// iron bar twice, since a furnace loses half the ore without a ring of forging.
// Counted in bars; nothing goes in, like the rocks.
function miningBars() {
  const lower = k => ITEM.get(k).name.toLowerCase();
  const amount = (k, n) => `${n === 1 ? '' : `${n} `}${lower(k)}`;                // "iron ore", "2 coal"
  const listed = takes => Object.entries(takes).map(([k, n]) => `${n} ${lower(k)}`).join(' and ');
  const row = (id, bar, takes, level, label, note) => {
    const rocks = Object.keys(takes).map(k => minedRocks.get(k));
    const one = `${lower(bar)}${label ? ` (${label})` : ''}`;
    methods.push({
      id, skill: 'mining', group: 'Bars', kind: 'xp', unit: 'bar', units: 'bars',
      // "Ore for 8,400 steel bars: 8,400 Iron ore + 16,800 Coal"
      lead: 'Ore for', as: [one, `${lower(bar)}s${label ? ` (${label})` : ''}`],
      name: `${ITEM.get(bar).name}${label ? ` (${label})` : ''}`,
      level: Math.max(...rocks.map(r => r.level)),
      xp: Object.entries(takes).reduce((a, [k, n]) => a + n * minedRocks.get(k).xp, 0),
      in: {}, out: takes, icon: need(bar),
      ...(Object.keys(takes).length > 1 || Object.values(takes)[0] > 1 ? { parts: Object.entries(takes).map(([k, n]) => [amount(k, n), n * minedRocks.get(k).xp]) } : {}),
      note: `Mine ${listed(takes)} for each bar. ${note ? `${note} ` : ''}Smelting it takes Smithing ${level}.`,
    });
  };
  let made = 0;
  for (const b of smeltedBars) {
    if (!Object.keys(b.in).every(k => minedRocks.has(k))) continue;             // (elemental ore is dropped, not mined)
    made++;
    if (!b.lost) { row(`mi_bar_${b.bar}`, b.bar, b.in, b.level); continue; }
    const ringName = ITEM.get(b.ring).name.toLowerCase();
    row(`mi_bar_${b.bar}`, b.bar, b.lost, b.level, '', `Half the ore is lost in a furnace, so a bar takes ${Object.values(b.lost)[0]} on average: with a ${ringName} or Superheat Item, see the row below.`);
    row(`mi_bar_${b.bar}_ring`, b.bar, b.in, b.level, ringName, `With a ${ringName} worn, or made with Superheat Item, every ore is a bar.`);
  }
  if (made !== smeltedBars.length - 1) throw new Error(`mining: expected a row for every bar but the elemental one, found ${made} of ${smeltedBars.length}`);
  miningNotes.push(`${methods.filter(m => m.skill === 'mining' && m.group === 'Bars').length} bar rows (the ore a bar takes, mined together)`);
}
miningBars();

// ── Fishing ────────────────────────────────────────────────────────────────
// One method per fish, XP per catch. The rows are LostHQ's Fishing calculator
// (js/calculators/fishing.js), each checked against the server, where a fish's
// XP is in its fishing struct (or in the script, for what a big net or a
// karambwan vessel brings up) and its level in the script of its spot.
// A rod uses up a bait, or a fly rod a feather, with every catch: that goes
// in, so a plan lists it. Nothing else takes anything, and like Mining no bank
// is involved: the gear is named, never counted.
const fishingNotes = [];
const outOfTheWay = new Set();                // fish only a quest or an out-of-the-way spot gives (set aside, here and in Cooking)
async function fishing() {
  const dir = p => scripts('skill_fishing/' + p);
  const x10 = xp => Math.round(xp * 10);
  const { readdir } = await import('node:fs/promises');
  const { fishes: calc } = await calculatorTables('fishing.js', ['fishes']);

  // ── The server's side ──
  // A fish's XP: the struct its obj names. (Any obj file: the lava eel's is with its quest.)
  const structs = await readConfig(dir('configs/fishing.struct'));
  const structXp = new Map();
  for (const f of (await readdir(scripts(''), { recursive: true })).filter(f => f.endsWith('.obj'))) {
    const text = await readFile(scripts(f), 'utf8');
    if (!text.includes('fishing_struct')) continue;
    for (const b of parseConfig(text).values()) {
      if (!b.params.fishing_struct) continue;
      const st = structs.get(b.params.fishing_struct);
      if (!st) throw new Error(`fishing: ${b.name} names a struct that isn't there`);
      structXp.set(b.name, Number(st.params.productexp));
    }
  }
  // The spots' scripts, block by block ([label,x], [proc,x], [opnpc1,x] …).
  const blocks = [];
  for (const f of await readdir(dir('scripts/fishing_spots'))) {
    const text = (await readFile(dir('scripts/fishing_spots/' + f), 'utf8')).replace(/\/\/[^\n]*/g, '');
    for (const part of text.split(/^(?=\[)/m)) {
      const h = part.match(/^\[(\w+),([^\]]+)\]/);
      if (h) blocks.push({ kind: h[1], name: h[2], body: part.slice(h[0].length) });
    }
  }
  const procs = new Map(blocks.filter(b => b.kind === 'proc').map(b => [b.name, b]));
  const calledProcs = b => [...b.body.matchAll(/~(\w+)/g)].map(m => procs.get(m[1])).filter(Boolean);
  const levelIn = body => { const m = body.match(/stat\(fishing\) < (\d+)/); return m ? Number(m[1]) : null; };
  // the level a block asks for (itself, or the proc that checks for it); none: level 1
  const levelOf = b => levelIn(b.body) ?? calledProcs(b).map(p => levelIn(p.body)).find(l => l != null) ?? 1;
  // the gear it asks for
  const gearOf = b => (b.body.match(/~check_fish_equipment\((\w+)\)/) || [])[1]
    || calledProcs(b).map(p => (p.body.match(/inv_total\(inv, (\w+)\) < 1/) || [])[1]).find(Boolean) || null;
  const caught = new Map();                  // fish -> { level, xp, gear, bait }
  const put = (fish, c, where) => {
    if (!(c.xp > 0) || !c.gear) throw new Error(`fishing: can't read ${fish} in ${where}`);
    const seen = caught.get(fish);
    if (seen && seen.xp !== c.xp) throw new Error(`fishing: ${fish} gives ${seen.xp} and ${c.xp} XP`);
    // (caught in more than one place, shrimps at the karambwanji spot too: the lowest level is the fish's)
    if (!seen || c.level < seen.level) caught.set(fish, c);
    else if (c.level === seen.level && (c.gear !== seen.gear || c.bait !== seen.bait)) throw new Error(`fishing: ${fish} is caught two ways at level ${c.level}`);
  };
  const CATCH = /inv_add\(inv, (\w+), 1\);\s*(?:mes\("[^"]*"\);\s*)?stat_advance\(fishing, (\d+)\)/g;
  for (const b of blocks) {
    if (b.kind === 'proc') continue;
    const level = levelOf(b), gear = gearOf(b);
    // a roll for one fish or two; the second has a level of its own
    for (const m of b.body.matchAll(/(if \(stat\(fishing\) >= (\d+)\) \{\s*)?~fish_roll(?:_loc)?\(([^)]*)\)/g)) {
      const args = m[3].split(',').map(a => a.trim());
      const [fish1, fish2] = args, bait = args[args.length - 1] === 'null' ? null : args[args.length - 1];
      if (fish1 !== 'null') put(fish1, { level, xp: structXp.get(fish1), gear, bait }, b.name);
      if (fish2 !== 'null') {
        if (!m[2]) throw new Error(`fishing: ${fish2} has no level in ${b.name}`);
        put(fish2, { level: Number(m[2]), xp: structXp.get(fish2), gear, bait }, b.name);
      }
    }
    // a net that brings up several things, each on a roll of its own, some from a higher level
    for (const call of b.body.matchAll(/~(fish_roll_\w+);/g)) {
      const p = procs.get(call[1]);
      if (!p) continue;
      let from = level;
      for (const m of p.body.matchAll(new RegExp(`if \\(\\$level < (\\d+)\\) \\{\\s*return;|${CATCH.source}`, 'g'))) {
        if (m[1]) from = Number(m[1]); else put(m[2], { level: from, xp: Number(m[3]), gear, bait: null, several: true }, p.name);
      }
    }
    // caught without the shared roll (Tai Bwo Wannai's two)
    for (const m of b.body.matchAll(CATCH)) put(m[1], { level, xp: Number(m[2]), gear, bait: null }, b.name);
  }
  // A karambwan takes the raw karambwanji in the vessel with every try, caught or not.
  const vesselLoaded = caught.get('tbwt_raw_karambwan')?.gear;
  const karambwan = (blocks.find(b => b.name === 'attempt_fish_karambwan') || {}).body || '';
  const vessel = (karambwan.match(new RegExp(`inv_del\\(inv, ${vesselLoaded}, 1\\);\\s*inv_add\\(inv, (\\w+), 1\\);`)) || [])[1];
  if (!vessel || (karambwan.match(new RegExp(`inv_del\\(inv, ${vesselLoaded}, 1\\)`, 'g')) || []).length !== 2) throw new Error("fishing: can't read what a karambwan try takes");
  if (!/%tbwt_lubufu < \^tbwt_lubufu_complete/.test(karambwan)) throw new Error('fishing: karambwan no longer wait for Lubufu');

  // ── The calculator's rows ──
  // What a big net brings up besides fish: not a way to train, so not rows.
  const NOT_FISH = new Set(['leather_boots', 'seaweed', 'leather_gloves', 'oystershell', 'casket']);
  for (const [key, row] of Object.entries(calc)) {
    const c = caught.get(key);
    if (!c) throw new Error(`fishing: the server catches no ${key}`);
    if (c.level !== row.level || c.xp !== x10(row.xp)) throw new Error(`fishing ${key}: the calculator says level ${row.level}, ${row.xp} XP; the server level ${c.level}, ${c.xp / 10} XP`);
  }
  for (const key of caught.keys()) {
    if (!(key in calc) && !NOT_FISH.has(key)) throw new Error(`fishing: the server catches ${key}, which the calculator doesn't list: look at it, then list it`);
  }
  // Tai Bwo Wannai Trio's two, the lava eel of Heroes' Quest (an oily rod, and it can't be traded), and Mort Myre's swamp eel.
  const ASIDE = new Set(['tbwt_raw_karambwanji', 'tbwt_raw_karambwan', 'raw_lava_eel', 'mort_slimey_eel']);
  for (const k of ASIDE) { if (!caught.has(k)) throw new Error(`fishing: no ${k} to set aside`); outOfTheWay.add(k); }
  const netted = [...caught].filter(([k, c]) => c.several && !NOT_FISH.has(k)).sort((a, b) => a[1].level - b[1].level);
  const extras = [...caught].filter(([k, c]) => c.several && NOT_FISH.has(k)).map(([k]) => need(k));
  const lower = k => ITEM.get(k).name.toLowerCase();
  const fish = k => lower(k).replace(/^raw /, '');
  nameOverride[need(vessel)] = `${ITEM.get(vessel).name} (empty)`;
  for (const [key] of Object.entries(calc)) {
    const c = caught.get(key);
    const gear = key === 'tbwt_raw_karambwan' ? need(vessel) : need(c.gear);
    const note = c.several
      ? `A big net brings up several things at once: ${netted.map(([k, n]) => `${fish(k)}${n.level > netted[0][1].level ? ` (from level ${n.level})` : ''}`).join(', ')}, and now and then ${extras.map(lower).join(', ').replace(/, ([^,]*)$/, ' or $1')}. Only the ${fish(key)} is counted here.`
      : key === 'tbwt_raw_karambwan' ? `Tai Bwo Wannai Trio: once Lubufu has shown you how. Every try takes the ${lower('tbwt_raw_karambwanji')} in your vessel, caught or not; those aren't counted.`
      : null;
    // aside: not what a plan trains with unless you pick it. A big net's fish come
    // with others, so the XP of one says little; the rest wait for a quest.
    const aside = c.several || ASIDE.has(key);
    methods.push({
      id: `fi_${key}`, skill: 'fishing', group: 'Fish', kind: 'xp', tools: [gear],
      name: ITEM.get(need(key)).name, level: c.level, xp: c.xp,
      in: c.bait ? { [need(c.bait)]: 1 } : {}, out: { [key]: 1 },
      ...(aside ? { aside: 1 } : {}), ...(note ? { note } : {}),
    });
  }
  fishingNotes.push(`${Object.keys(calc).length} fish; a bait or feather a catch for ${[...caught.values()].filter(c => c.bait).length} of them; a big net also brings up ${extras.map(lower).join(', ')} (not rows)`);
}

await fishing();

// ── Cooking ────────────────────────────────────────────────────────────────
// The rows are LostHQ's Cooking calculator (js/calculators/cooking.js): its five
// tabs, in its order. Every row is checked against the server: its cooking
// table, and its scripts for what isn't cooked on a fire or a range (a wine, a
// pizza's topping, a chocolate cake, a chompy on its spit). Where the two differ
// the server's number is used and the difference printed; one this script
// hasn't seen before stops it.
//
// What the calculator leaves to you comes from the server too:
//   - what a row is made of. A fish or a piece of meat is one raw thing. A pie,
//     a pizza, a cake, a stew and a wine are put together first; those steps
//     have no XP, so they're planned through, like unfinished potions.
//   - a topped pizza and a chocolate cake are the calculator's whole job (baked,
//     then topped). Here the baking is a row of its own that feeds the topping
//     row and is planned through, so the XP comes to the same.
//   - burning. A cook can fail, and how often is the server's own, by level:
//     on a fire, on a range, on Lumbridge Castle's range, with cooking gauntlets
//     worn. A row's chance is [low, high], what stat_random is given; a plan
//     counts the raw food that takes on average. CHOICES says which applies.
const cookingNotes = [];
async function cooking() {
  const dir = p => scripts('skill_cooking/' + p);
  const x10 = xp => Math.round(xp * 10);
  const name = k => nameOverride[k] || ITEM.get(need(k)).name;
  const lower = k => name(k).toLowerCase();
  const { cookingXp: calc } = await calculatorTables('cooking.js', ['cookingXp']);
  const TABS = { fish: 'Fish', meat: 'Meat', pies: 'Pies & pizza', gnome: 'Gnome', other: 'Other' };
  for (const tab of Object.keys(calc)) if (!TABS[tab]) throw new Error(`cooking.js has a tab this script doesn't know: ${tab}`);

  // Where the server and the calculator differ: the server's is used.
  const KNOWN = { jug_wine: { xp: 1100 }, cooked_chompy: { xp: 140 }, mantaray: { xp: 2163 }, pineapple_pizza: { xp: 1880 } };
  const check = (key, what, calcValue, serverValue) => {
    if (calcValue === serverValue) return;
    if (KNOWN[key]?.[what] !== serverValue) throw new Error(`cooking ${key}: the calculator says ${what} ${calcValue}, the server ${serverValue}`);
    cookingNotes.push(`${ITEM.get(key).name}: ${what} ${what === 'xp' ? serverValue / 10 : serverValue} (the server, used) vs ${what === 'xp' ? calcValue / 10 : calcValue} (LostHQ's calculator)`);
  };

  // ── The server's side ──
  // The cooking table: what a raw thing cooks into, its level and XP, and its
  // chances of not burning.
  const table = [...(await readConfig(dir('configs/cooking_source/cooking_generic.dbrow'))).values()].map(row => ({ row: row.name, ...fields(row) }));
  const byCooked = new Map();
  for (const r of table) {
    if (!r.cooked || r.cooked[0] === 'null' || !(Number(r.experience?.[0]) > 0)) continue;
    (byCooked.get(r.cooked[0]) || byCooked.set(r.cooked[0], []).get(r.cooked[0])).push(r);
  }
  const cookScript = await readFile(dir('scripts/cooking.rs2'), 'utf8');
  // How the script picks a chance, which the data below relies on: a range's
  // own where it has one; gauntlets before Lumbridge's range; 1,1 always works.
  const relies = [
    [/if \(\$cooking_source = cooking_oven\) \{[\s\S]*?if \(\$low_range > null \| \$high_range > null\) \{\s*\$low = \$low_range;/, "a range's own chance"],
    [/if \(inv_total\(worn, (\w+)\) > 0 & \(\$low_gauntlets > null \| \$high_gauntlets > null\)\) \{\s*\$low = \$low_gauntlets;[\s\S]*?\} else if \(loc_type = (\w+) & \(\$low_cookomatic > null \| \$high_cookomatic > null\)\)/, 'gauntlets before the Lumbridge range'],
    [/\} else if \(\$low = 1 & \$high = 1\) \{\s*\$passes_roll = true;\s*\} else \{\s*\$passes_roll = stat_random\(cooking, \$low, \$high\);/, 'the roll'],
  ].map(([re, what]) => cookScript.match(re) || (() => { throw new Error(`cooking: can't find ${what} in the script`); })());
  const gauntlets = need(relies[1][1]);
  if (!(await readFile(scripts('quests/quest_cook/configs/quest_cook.loc'), 'utf8')).includes(`[${relies[1][2]}]`)) throw new Error("cooking: the Lumbridge range isn't the Cook's Assistant one any more");
  // stat_random's sum: the chances in 256 of a try working at a level
  const unitsAt = ([low, high], level) => Math.min(256, Math.floor((low * (99 - level)) / 98) + Math.floor((high * (level - 1)) / 98) + 1);
  const pair = v => (v ? v.map(Number) : null);
  const never = (c, level) => !c || (c[0] === 1 && c[1] === 1) || unitsAt(c, level) >= 256;      // never burns from that level on
  const sameChance = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  // A row's chances: chance (on a range, or a fire where that's all it cooks
  // on), and what each choice makes of it.
  const chances = (r, level) => {
    const base = pair(r.successchance), onRange = pair(r.successchance_range), lumbridge = pair(r.successchance_cookomatic), worn = pair(r.successchance_gauntlets);
    const fireOnly = !!r.cantcookmessage_range, rangeOnly = !!r.cantcookmessage_fire;
    if (!base) throw new Error(`cooking: ${r.row} has no chance of success`);
    const usual = fireOnly ? base : onRange || base;
    const opt = {};
    if (!fireOnly && !rangeOnly && onRange && !sameChance(onRange, base)) opt.fire = { chanceAt: base };
    if (!fireOnly && lumbridge) opt.lumbridge = { chanceAt: lumbridge };
    if (worn) opt.gauntlets = { chanceWorn: worn };
    const any = [usual, base, lumbridge, worn].some(c => c && !never(c, level));
    if (!any) return { fireOnly, rangeOnly };
    opt.ignore = { chance: null, chanceAt: null, chanceWorn: null };
    return { chance: usual, opt, fireOnly, rangeOnly };
  };

  const made = { Fish: [], Meat: [], 'Pies & pizza': [], Gnome: [], Other: [] };
  const raws = { Fish: [], Meat: [] };
  const mine = [];                            // every Cooking method, rows and steps
  const push = m => { mine.push(m); methods.push(m); return m; };
  // A row that's one thing cooked on a fire or a range.
  const cookRow = (tab, key, r, more = {}) => {
    const group = TABS[tab];
    const level = Math.max(1, Number(r.levelrequired[0]));
    const c = chances(r, level);
    const from = need(r.uncooked[0]);
    made[group].push(key);
    if (raws[group]) raws[group].push(from);
    const where = c.rangeOnly ? 'Needs a range: it can\'t be cooked on a fire.' : c.fireOnly ? 'Warmed over a fire: a range won\'t do.' : null;
    const note = [more.note, where].filter(Boolean).join(' ');
    const { note: _n, id: idOf, ...rest } = more;
    return push({
      id: idOf || `ck_${key}`, skill: 'cooking', group, kind: 'xp',
      name: name(key), level, xp: Number(r.experience[0]), in: { [from]: 1 }, out: { [need(key)]: 1 },
      ...(r.additional ? { tools: [need(r.additional[0])] } : {}),
      ...(c.chance ? { chance: c.chance, opt: c.opt } : {}),
      ...rest, ...(note ? { note } : {}),
    });
  };
  const serverRows = key => byCooked.get(key) || (() => { throw new Error(`cooking: the server cooks no ${key}`); })();
  const seen = new Set();
  const generic = (tab, key, row, more) => {
    const rows = serverRows(key);
    for (const r of rows) seen.add(r.row);
    check(key, 'level', row.level, Math.max(1, Number(rows[0].levelrequired[0])));
    check(key, 'xp', x10(row.xp), Number(rows[0].experience[0]));
    return rows.map((r, i) => cookRow(tab, key, r, i ? { ...more, id: `ck_${key}_${r.uncooked[0]}`, name: `${name(key)} (${lower(r.uncooked[0]).replace(/^raw /, '')})` } : more));
  };
  const step = (id, product, takes, more = {}) => push({ id, skill: 'cooking', group: 'Preparing', kind: 'prep', name: name(product), level: 1, xp: 0,
    in: Object.fromEntries(Object.entries(takes).map(([k, n]) => [need(k), n])), out: { [need(product)]: 1 }, ...more });
  // What a script's label takes from the inventory and puts in it (named items only).
  const label = (text, what) => {
    const i = text.indexOf(`[label,${what}]`);
    if (i < 0) throw new Error(`cooking: can't find ${what} in the script`);
    const body = text.slice(i + 1).split(/\n\[/)[0];
    return { body, takes: [...body.matchAll(/inv_del\(inv, (\w+), 1\)/g)].map(m => m[1]), gives: [...body.matchAll(/inv_add\(inv, (\w+), 1\)/g)].map(m => m[1]) };
  };
  const expect = (what, got, want) => {
    if (JSON.stringify([...got].sort()) !== JSON.stringify([...want].sort())) throw new Error(`cooking ${what}: the script has ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  const levelIn = (body, what) => fromScript(body, /stat\(cooking\) < (\d+)/, `the level for ${what}`);

  // Names: two karambwans and two lots of jogre bones share a name in-game.
  nameOverride.tbwt_poorly_cooked_karambwan = `${ITEM.get(need('tbwt_poorly_cooked_karambwan')).name} (poorly)`;
  for (const k of ['tbwt_burnt_jogre_bones_marinated_in_karambwanji', 'tbwt_burnt_jogre_bones_in_raw_karambwanji_paste']) nameOverride[k] = `${ITEM.get(need(k)).name} (burnt bones)`;

  // ── Steps with no XP, from the scripts ──
  // Dough: a pot of flour and water (a bucket; a jug works too in the game).
  const doughScript = await readFile(dir('scripts/cooking_inv/scripts/dough/dough.rs2'), 'utf8');
  const doughs = [...label(doughScript, 'dough_interface').body.matchAll(/\$choice = (\w+);/g)].map(m => m[1]);
  expect('dough', doughs, ['bread_dough', 'pastry_dough', 'pizza_base', 'uncooked_pitta_bread']);
  expect('dough takes', label(doughScript, 'dough_interface').takes, ['pot_flour']);
  const water = need('bucket_water'), flour = need('pot_flour');
  if (!(await readConfig(scripts('general_use/configs/water_sources.obj'))).get(water)?.params.is_water_source) throw new Error('cooking: a bucket of water no longer makes dough');
  for (const d of doughs) step(`ck_${d}`, d, { [flour]: 1, [water]: 1 });
  // Pies: dough in a dish, then the filling (each needs its level to fill).
  const pieScript = await readFile(dir('scripts/cooking_inv/scripts/pies/pies.rs2'), 'utf8');
  expect('pie shell', [label(pieScript, 'make_pie_shell').takes, label(pieScript, 'make_pie_shell').gives].flat(), ['pastry_dough', 'piedish', 'pie_shell']);
  step('ck_pie_shell', 'pie_shell', { pastry_dough: 1, piedish: 1 });
  expect('uncooked pie', label(pieScript, 'make_uncooked_pie').takes, ['pie_shell']);
  const pieStructs = await readConfig(dir('configs/cooking_inv/configs/pies/pies.struct'));
  const pizzaStructs = await readConfig(dir('configs/cooking_inv/configs/pizza/pizza.struct'));
  // which ingredient fills which pie, and tops which pizza: named on the ingredient's obj
  const fillings = new Map(), toppings = new Map();
  const { readdir } = await import('node:fs/promises');
  for (const f of (await readdir(scripts(''), { recursive: true })).filter(f => f.endsWith('.obj'))) {
    const text = await readFile(scripts(f), 'utf8');
    if (!/uncooked_pie_struct|pizza_topping_struct/.test(text)) continue;
    for (const b of parseConfig(text).values()) {
      if (b.params.uncooked_pie_struct) (fillings.get(b.params.uncooked_pie_struct) || fillings.set(b.params.uncooked_pie_struct, []).get(b.params.uncooked_pie_struct)).push(b.name);
      if (b.params.pizza_topping_struct) (toppings.get(b.params.pizza_topping_struct) || toppings.set(b.params.pizza_topping_struct, []).get(b.params.pizza_topping_struct)).push(b.name);
    }
  }
  // (where two things do, the first of these is the one a plan lists; the other is in the row's note)
  const FIRST = ['cooked_meat', 'pineapple_ring'];
  const pick = list => [...list].sort((a, b) => FIRST.includes(b) - FIRST.includes(a));
  const others = list => (list.length > 1 ? ` ${list.slice(1).map(k => name(k)).join(' or ')} can go on instead.` : '');
  const pieOf = new Map();                    // uncooked pie -> { level, filling: [..] }
  for (const [st, list] of fillings) {
    const b = pieStructs.get(st);
    if (!b) throw new Error(`cooking: no pie struct ${st}`);
    pieOf.set(b.params.product, { level: Number(b.params.levelrequired), filling: pick(list) });
    step(`ck_${b.params.product}`, b.params.product, { pie_shell: 1, [pick(list)[0]]: 1 }, { level: Number(b.params.levelrequired) });
  }
  // Pizza: a base, a tomato, then cheese (from level 35).
  const pizzaScript = await readFile(dir('scripts/cooking_inv/scripts/pizza/pizza.rs2'), 'utf8');
  const tomatoed = label(pizzaScript, 'make_incomplete_pizza'), cheesed = label(pizzaScript, 'make_uncooked_pizza');
  expect('incomplete pizza', [tomatoed.takes, tomatoed.gives].flat(), ['tomato', 'pizza_base', 'incomplete_pizza']);
  expect('uncooked pizza', [cheesed.takes, cheesed.gives].flat(), ['cheese', 'incomplete_pizza', 'uncooked_pizza']);
  step('ck_incomplete_pizza', 'incomplete_pizza', { pizza_base: 1, tomato: 1 }, { level: levelIn(tomatoed.body, 'a pizza') });
  step('ck_uncooked_pizza', 'uncooked_pizza', { incomplete_pizza: 1, cheese: 1 }, { level: levelIn(cheesed.body, 'a pizza') });
  // Cake: flour, an egg and milk in a tin (the tin comes back when it's baked).
  const cakeScript = await readFile(dir('scripts/cooking_inv/scripts/cakes/cakes.rs2'), 'utf8');
  const mixed = label(cakeScript, 'make_uncooked_cake');
  expect('uncooked cake', [mixed.takes, mixed.gives].flat(), ['pot_flour', 'egg', 'bucket_milk', 'cake_tin', 'pot_empty', 'uncooked_cake', 'bucket_empty']);
  step('ck_uncooked_cake', 'uncooked_cake', { [flour]: 1, egg: 1, bucket_milk: 1 }, { tools: [need('cake_tin')] });
  // Stew: a potato in a bowl of water, then meat; a curry is that with spice.
  const stewScript = await readFile(dir('scripts/cooking_inv/scripts/stew/stew.rs2'), 'utf8');
  const started = label(stewScript, 'make_incomplete_stew'), stewed = label(stewScript, 'make_uncooked_stew'), spiced = label(stewScript, 'make_curry');
  expect('incomplete stew', [started.takes, started.gives].flat(), ['bowl_water', 'stew2', 'stew1']);
  expect('uncooked stew', stewed.gives, ['uncooked_stew']);
  if (!/\[opheldu,potato\]\s*switch_obj \(last_useitem\) \{\s*case bowl_water : @make_incomplete_stew/.test(stewScript)) throw new Error('cooking: a potato no longer starts a stew');
  const meatScript = await readFile(dir('scripts/cooking_inv/scripts/meat/cooked_meat.rs2'), 'utf8');
  const stewMeat = pick(['cooked_meat', 'cooked_chicken'].filter(k => new RegExp(`\\[opheldu,${k}\\][\\s\\S]*?case stew1 : @make_uncooked_stew`).test(meatScript)));
  if (!stewMeat.length) throw new Error('cooking: no meat goes into a stew');
  expect('curry', [spiced.takes, spiced.gives].flat(), ['uncooked_stew', 'spicespot', 'uncooked_curry']);
  step('ck_stew1', 'stew1', { bowl_water: 1, potato: 1 }, { level: levelIn(started.body, 'a stew') });
  step('ck_uncooked_stew', 'uncooked_stew', { stew1: 1, [stewMeat[0]]: 1 }, { level: levelIn(stewed.body, 'a stew') });
  step('ck_uncooked_curry', 'uncooked_curry', { uncooked_stew: 1, spicespot: 1 });
  // Wine: grapes squeezed into a jug of water; it ferments on its own.
  const wineScript = await readFile(dir('scripts/cooking_inv/scripts/wine/wine.rs2'), 'utf8');
  const squeezed = label(wineScript, 'make_wine');
  expect('wine', [squeezed.takes, squeezed.gives].flat(), ['grapes', 'jug_water', 'jug_unfermented_wine']);
  step('ck_jug_unfermented_wine', 'jug_unfermented_wine', { grapes: 1, jug_water: 1 }, { level: levelIn(squeezed.body, 'wine') });
  const ferment = wineScript.match(/if \(stat_random\(cooking, (\d+), (\d+)\) = true\) \{\s*inv_add\(inv, (\w+), 1\);\s*stat_advance\(cooking, (\d+)\);\s*\} else \{[^}]*inv_add\(inv, (\w+), 1\);/);
  if (!ferment) throw new Error("cooking: can't read how wine ferments");
  // Swamp paste: swamp tar and flour.
  const pasted = label(await readFile(scripts('quests/quest_seaslug/scripts/quest_seaslug.rs2'), 'utf8'), 'make_swamp_paste');
  expect('raw swamp paste', [pasted.takes, pasted.gives].flat(), ['swamp_tar', 'pot_flour', 'pot_empty', 'rawswamppaste']);
  step('ck_rawswamppaste', 'rawswamppaste', { swamp_tar: 1, [flour]: 1 });
  // Gnome cooking: Gianne dough shaped in a mould, a tray or a tin (which you get back at the end).
  const gnomeStructs = await readConfig(dir('configs/gnome_cooking/gnome_cooking.struct'));
  const gnomeObjs = await readConfig(dir('configs/gnome_cooking/gnome_cooking.obj'));
  expect('raw gnome food', label(await readFile(dir('scripts/gnome_cooking/gianne_dough.rs2'), 'utf8'), 'make_raw_gnome').takes, ['gianne_dough']);
  const shapedIn = new Map();                 // raw gnome food -> the tin it's shaped in
  for (const b of gnomeObjs.values()) {
    const st = b.params.gnome_cooking_struct && gnomeStructs.get(b.params.gnome_cooking_struct);
    if (st?.params.product) shapedIn.set(st.params.product, b.name);
  }

  // ── The calculator's rows ──
  const NOTES = {
    tbwt_cooked_karambwan: 'Cooked thoroughly: a choice you have once Tai Bwo Wannai Trio is done. Before that a karambwan comes out poorly cooked.',
    tbwt_poorly_cooked_karambwan: 'How a karambwan comes out until Tai Bwo Wannai Trio is done.',
    tbwt_cooked_karambwanji: 'Burnt, it turns to ashes.',
    lava_eel: null,
    cooked_ugthanki_meat: null,
  };
  for (const [tab, rows] of Object.entries(calc)) {
    for (const [key, row] of Object.entries(rows)) {
      if (byCooked.has(key)) {
        const from = byCooked.get(key)[0].uncooked[0];
        const tin = shapedIn.get(from);
        if (tin) step(`ck_${from}`, from, { gianne_dough: 1 }, { tools: [need(tin)] });
        generic(tab, key, row, NOTES[key] ? { note: NOTES[key] } : {});
      } else if (key === 'cooked_chompy') {
        // roasted on an ogre spit, by its own script
        const chompy = await readFile(scripts('quests/quest_chompybird/scripts/raw_chompy.rs2'), 'utf8');
        const roast = label(chompy, 'cook_chompy_offquest');
        const roll = roast.body.match(/stat_random\(cooking, (\d+), (\d+)\)/);
        const spit = chompy.slice(chompy.indexOf('[oplocu,chompybird_spitroast_empty]')).split(/\n\[/)[0];
        if (!roll || !roast.takes.includes('raw_chompy') || !roast.gives.includes(key)) throw new Error("cooking: can't read how a chompy is roasted");
        if (!/%chompybird = \^chompybird_complete\) \{\s*@cook_chompy_offquest/.test(spit)) throw new Error('cooking: a chompy no longer waits for Big Chompy Bird Hunting');
        const level = levelIn(spit, 'a chompy'), xp = fromScript(roast.body, /stat_advance\(cooking, (\d+)\)/, 'the XP for a chompy');
        check(key, 'level', row.level, level);
        check(key, 'xp', x10(row.xp), xp);
        made[TABS[tab]].push(key);
        raws[TABS[tab]].push(need('raw_chompy'));
        const chance = [Number(roll[1]), Number(roll[2])];
        push({ id: `ck_${key}`, skill: 'cooking', group: TABS[tab], kind: 'xp', name: name(key), level, xp, in: { raw_chompy: 1 }, out: { [need(key)]: 1 },
          ...(never(chance, level) ? {} : { chance, opt: { ignore: { chance: null, chanceAt: null, chanceWorn: null } } }),
          note: 'Roasted on an ogre spit-roast, once Big Chompy Bird Hunting is done: not on a fire or a range, so those choices change nothing.' });
      } else if ([...toppings.keys()].some(st => pizzaStructs.get(st)?.params.product === key)) {
        // a topped pizza: the plain one (its own row, above), then the topping
        const [st, list] = [...toppings].find(([t]) => pizzaStructs.get(t).params.product === key);
        const p = pizzaStructs.get(st).params;
        const base = mine.find(m => m.id === 'ck_plain_pizza') || (() => { throw new Error('cooking: the plain pizza has to come before the topped ones'); })();
        const topped = label(pizzaScript, 'make_pizza_with_topping');
        expect('topped pizza', topped.takes, ['plain_pizza']);
        const topping = pick(list);
        check(key, 'level', row.level, Number(p.levelrequired));
        check(key, 'xp', x10(row.xp), base.xp + Number(p.productexp));
        made[TABS[tab]].push(key);
        push({ id: `ck_${key}`, skill: 'cooking', group: TABS[tab], kind: 'xp', name: name(key), level: Number(p.levelrequired), xp: Number(p.productexp),
          in: { plain_pizza: 1, [need(topping[0])]: 1 }, out: { [need(key)]: 1 },
          note: `The topping goes on a baked plain pizza: ${Number(p.productexp) / 10} XP for that, on top of the ${base.xp / 10} for baking it.${others(topping)}` });
      } else if (key === 'chocolate_cake') {
        const iced = label(cakeScript, 'make_chocolate_cake');
        const base = mine.find(m => m.id === 'ck_cake') || (() => { throw new Error('cooking: the cake has to come before the chocolate cake'); })();
        expect('chocolate cake', [iced.takes, iced.gives].flat(), ['cake', 'chocolate_cake']);
        const level = levelIn(iced.body, 'a chocolate cake'), xp = fromScript(iced.body, /stat_advance\(cooking, (\d+)\)/, 'the XP for a chocolate cake');
        if (!/\[opheldu,chocolate_bar\][\s\S]*?case cake : @make_chocolate_cake/.test(cakeScript) || !/\[opheldu,chocolate_dust\][\s\S]*?case cake : @make_chocolate_cake/.test(cakeScript)) throw new Error('cooking: chocolate no longer goes on a cake');
        check(key, 'level', row.level, level);
        check(key, 'xp', x10(row.xp), base.xp + xp);
        made[TABS[tab]].push(key);
        push({ id: `ck_${key}`, skill: 'cooking', group: TABS[tab], kind: 'xp', name: name(key), level, xp, in: { cake: 1, [need('chocolate_bar')]: 1 }, out: { [need(key)]: 1 },
          note: `Chocolate goes on a baked cake: ${xp / 10} XP for that, on top of the ${base.xp / 10} for baking it. ${name('chocolate_dust')} can go on instead.` });
      } else if (key === ferment[3]) {
        // wine: made by squeezing, the XP when it has fermented (or it goes bad)
        const level = levelIn(squeezed.body, 'wine'), xp = Number(ferment[4]);
        check(key, 'level', row.level, level);
        check(key, 'xp', x10(row.xp), xp);
        made[TABS[tab]].push(key);
        const chance = [Number(ferment[1]), Number(ferment[2])];
        push({ id: `ck_${key}`, skill: 'cooking', group: TABS[tab], kind: 'xp', name: name(key), level, xp, in: { jug_unfermented_wine: 1 }, out: { [need(key)]: 1 },
          ...(never(chance, level) ? {} : { chance, opt: { ignore: { chance: null, chanceAt: null, chanceWorn: null } } }),
          note: `Grapes squeezed into a jug of water. The XP comes when it has fermented, a few seconds on; it can go bad instead (${lower(need(ferment[5]))}), which is counted like a burn. No fire or range in it, so those choices change nothing.` });
      } else throw new Error(`cooking: the server has no ${key}`);
    }
  }
  // Wrapping an oomlie: a step with XP of its own, which the calculator leaves out.
  const oomlie = label(await readFile(dir('scripts/cooking_inv/scripts/oomlie_bird_meat/oomlie_bird_meat.rs2'), 'utf8'), 'make_oomlie_wrap');
  expect('oomlie wrap', [oomlie.takes, oomlie.gives].flat(), ['palm_leaf', 'raw_oomlie', 'wrapped_oomlie']);
  const wrapXp = fromScript(oomlie.body, /stat_advance\(cooking, (\d+)\)/, 'the XP for wrapping an oomlie');
  const wrapAt = mine.findIndex(m => m.id === 'ck_cooked_oomlie');
  if (wrapAt < 0 || mine[wrapAt].in.wrapped_oomlie !== 1) throw new Error('cooking: the oomlie wrap is no longer what gets cooked');
  const wrap = { id: 'ck_wrapped_oomlie', skill: 'cooking', group: TABS.meat, kind: 'xp', name: name('wrapped_oomlie'), level: levelIn(oomlie.body, 'an oomlie wrap'), xp: wrapXp,
    in: { raw_oomlie: 1, palm_leaf: 1 }, out: { wrapped_oomlie: 1 }, note: `Not on LostHQ's calculator: wrapping the meat in a palm leaf gives ${wrapXp / 10} XP on the server, before it's cooked.` };
  mine.splice(wrapAt, 0, wrap);
  methods.splice(methods.indexOf(mine[wrapAt + 1]), 0, wrap);
  raws.Meat.splice(raws.Meat.indexOf('wrapped_oomlie'), 0, need('raw_oomlie'), need('palm_leaf'));
  cookingNotes.push(`${name('wrapped_oomlie')}: ${wrapXp / 10} XP on the server; not in LostHQ's calculator (added)`);

  // Every row of the server's table that gives XP has a row here; so has every
  // script that gives Cooking XP, or it's one of these, looked at and left out.
  for (const r of table) if (Number(r.experience?.[0]) > 0 && r.cooked?.[0] !== 'null' && !seen.has(r.row)) throw new Error(`cooking: the server cooks ${r.cooked[0]} (${r.row}), which the calculator doesn't list: look at it, then list it`);
  const LEFT_OUT = {
    'skill_cooking/scripts/gnome_cooking/gnome_battas.rs2': 'finishing a gnome batta', 'skill_cooking/scripts/gnome_cooking/gnome_bowls.rs2': 'finishing a gnome bowl',
    'skill_cooking/scripts/gnome_cooking/gnome_food_finish.rs2': 'garnishing gnome food', 'skill_cooking/scripts/gnome_cooking/gnome_cocktail_finish.rs2': 'finishing a gnome cocktail',
    'skill_cooking/scripts/cooking_inv/scripts/ugthanki_kebab/ugthanki_kebab.rs2': 'an ugthanki kebab', 'areas/area_gnome/scripts/gnome_restaurant.rs2': 'gnome restaurant deliveries',
    'quests/quest_tbwt/scripts/tbwt_jogre_bones.rs2': 'pasting jogre bones',
    'areas/area_karamja/scripts/tbwt_tinsay_final.rs2': 'a quest reward', 'quests/quest_hero/scripts/quest_hero.rs2': 'a quest reward', 'quests/quest_cook/scripts/quest_cook.rs2': 'a quest reward',
    'quests/quest_chompybird/scripts/quest_chompybird.rs2': 'a quest reward', 'quests/quest_fluffs/scripts/quest_fluffs.rs2': 'a quest reward', '_test/scripts/cheats/cheat_maxme.rs2': 'a test cheat',
  };
  const USED = ['skill_cooking/scripts/cooking.rs2', 'skill_cooking/scripts/cooking_inv/scripts/cakes/cakes.rs2', 'skill_cooking/scripts/cooking_inv/scripts/oomlie_bird_meat/oomlie_bird_meat.rs2',
    'skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2', 'skill_cooking/scripts/cooking_inv/scripts/pizza/pizza.rs2', 'quests/quest_chompybird/scripts/raw_chompy.rs2'];
  for (const f of (await readdir(scripts(''), { recursive: true })).filter(f => f.endsWith('.rs2'))) {
    const file = f.replace(/\\/g, '/');
    if (USED.includes(file) || LEFT_OUT[file]) continue;
    if ((await readFile(scripts(f), 'utf8')).includes('stat_advance(cooking')) throw new Error(`cooking: ${file} gives Cooking XP and isn't accounted for: look at it, then list it`);
  }

  // A row whose product another row or step uses feeds it: with the raw thing
  // in your bank it's cooked on the way, and that XP counts. The two bakes the
  // calculator folds into a topped pizza and a chocolate cake are planned
  // through from scratch as well.
  const inputs = new Set(mine.flatMap(m => Object.keys(m.in)));
  for (const m of mine) if (m.kind === 'xp' && Object.keys(m.out).some(k => inputs.has(k))) m.feeds = 1;
  for (const id of ['ck_plain_pizza', 'ck_cake']) {
    const m = mine.find(x => x.id === id);
    if (!m?.feeds) throw new Error(`cooking: ${id} no longer feeds a row`);
    m.through = 1;
  }
  // aside: not what a plan trains with unless you pick it (or your bank holds
  // it). Quest food, and the two fish no fishing spot gives (only the trawler):
  // otherwise a karambwan, 190 XP at level 1, would be every plan's own pick.
  const fished = new Set(methods.filter(m => m.skill === 'fishing').flatMap(m => Object.keys(m.out)).filter(k => !outOfTheWay.has(k)));
  for (const m of mine) if (m.group === TABS.fish && !fished.has(Object.keys(m.in)[0])) m.aside = 1;
  const aside = mine.filter(m => m.aside).map(m => m.id);
  const ASIDE = ['ck_tbwt_cooked_karambwanji', 'ck_tbwt_poorly_cooked_karambwan', 'ck_tbwt_cooked_karambwan', 'ck_mort_slimey_eel_cooked', 'ck_lava_eel', 'ck_seaturtle', 'ck_mantaray'];
  if (JSON.stringify(aside) !== JSON.stringify(ASIDE)) throw new Error(`cooking: the fish set aside are ${aside.join(', ')}: look at them, then list them`);
  // A chance belongs to a row that cooks one thing: plans count on it.
  for (const m of mine) if (m.chance && (Object.keys(m.in).length !== 1 || Object.values(m.in)[0] !== 1 || m.kind !== 'xp')) throw new Error(`cooking: ${m.id} has a chance but isn't one thing cooked`);

  // The choices on a goal: where you cook, gauntlets, and whether burnt food is counted.
  const rows = mine.filter(m => m.chance);
  const stops = (m, c) => { for (let l = m.level; l <= 99; l++) if (never(c, l)) return l; return null; };
  const eg = id => mine.find(m => m.id === id) || (() => { throw new Error(`cooking: no ${id} to give as an example`); })();
  const shark = eg('ck_shark'), lobster = eg('ck_lobster');
  const stopText = l => (l == null ? 'never stop burning' : `stop burning at level ${l}`);
  // a fire against a range, at the level a food is first cooked: which burns more of it
  const list = ms => ms.map(m => m.name.toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' and $1');
  const onFire = rows.filter(m => m.opt.fire);
  const worse = onFire.filter(m => unitsAt(m.opt.fire.chanceAt, m.level) < unitsAt(m.chance, m.level)), better = onFire.filter(m => !worse.includes(m));
  if (!worse.length || worse.length + better.length !== onFire.length) throw new Error("cooking: can't say what a fire burns more of");
  choices.cooking = [
    { id: 'heat', label: 'Cook on', options: [{ id: 'range', name: 'A range' }, { id: 'lumbridge', name: "Lumbridge Castle's range" }, { id: 'fire', name: 'A fire' }],
      tip: `Where you cook decides how often food burns. A range: the usual. Lumbridge Castle's range (once Cook's Assistant is done) burns less of ${rows.filter(m => m.opt.lumbridge).length} low-level foods. ` +
        `A fire burns more ${list(worse)}${better.length ? `, and a little less ${list(better)}` : ''}; the rest burn the same. Pies, pizzas, cakes and bread need a range whatever you pick.` },
    { id: 'gauntlets', label: 'Cooking gauntlets',
      tip: `On: ${rows.filter(m => m.opt.gauntlets).map(m => m.name.toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' and $1')} burn less. Lobsters ${stopText(stops(lobster, lobster.opt.gauntlets.chanceWorn))} instead of ${stops(lobster, lobster.chance)}; sharks ${stopText(stops(shark, shark.opt.gauntlets.chanceWorn))} (without, they ${stopText(stops(shark, shark.chance))}).` },
    { id: 'burnt', label: 'Burnt food', options: [{ id: 'count', name: 'Count it' }, { id: 'ignore', name: 'Leave it out' }],
      tip: "Count it: a plan allows for what burns, by the server's own chances at each level: more raw food to collect, and less XP from what's in your bank. Leave it out: every cook works, the way LostHQ's calculator counts." },
  ];

  // The Bank tab: what goes in, by kind, then what comes out.
  const group = (label2, items) => ({ name: label2, items: [...new Set(items)].map(need) });
  const ins = id => Object.keys(mine.find(m => m.id === id).in);
  bankGroups.cooking = [
    group('Raw fish', raws.Fish),
    group('Raw meat', raws.Meat),
    group('Pies and bread', [flour, water, 'bread_dough', 'pastry_dough', 'piedish', 'pie_shell', ...[...pieOf].flatMap(([pie, p]) => [p.filling[0], pie]), 'uncooked_pitta_bread'].filter(k => !mine.some(x => x.kind === 'xp' && x.out[k]))),
    group('Pizza and cake', ['pizza_base', 'tomato', 'incomplete_pizza', 'cheese', 'uncooked_pizza', ...mine.filter(m => m.in.plain_pizza).flatMap(m => Object.keys(m.in).filter(k => k !== 'plain_pizza' && !mine.some(x => x.kind === 'xp' && x.out[k]))),
      'egg', 'bucket_milk', 'uncooked_cake', 'chocolate_bar']),
    group('Stew, wine and the rest', ['bowl_water', 'potato', 'stew1', 'uncooked_stew', 'spicespot', 'uncooked_curry', 'grapes', 'jug_water', 'jug_unfermented_wine', 'swamp_tar', 'rawswamppaste',
      'gianne_dough', ...made.Gnome.flatMap(k => ins(`ck_${k}`)), ...['ck_tbwt_jogre_bones_marinated_in_karambwanji', 'ck_tbwt_burnt_jogre_bones_marinated_in_karambwanji'].flatMap(ins)]),
    group('Cooked: fish', made.Fish),
    group('Cooked: meat', made.Meat),
    group('Cooked: pies and pizza', made['Pies & pizza']),
    group('Cooked: the rest', [...made.Gnome, ...made.Other]),
  ];
  const listed = new Set(bankGroups.cooking.flatMap(g => g.items));
  for (const k of new Set(mine.flatMap(m => [...Object.keys(m.in), ...Object.keys(m.out)]))) if (!listed.has(k)) throw new Error(`cooking: ${k} is used but isn't in a bank group`);
  if (listed.size !== bankGroups.cooking.reduce((a, g) => a + g.items.length, 0)) throw new Error('cooking: an item is in two bank groups');
  cookingNotes.push(`${mine.filter(m => m.kind === 'xp').length} rows, ${mine.filter(m => m.kind === 'prep').length} steps; ${rows.length} can burn (${rows.filter(m => m.opt.fire).length} with another chance on a fire, ${rows.filter(m => m.opt.lumbridge).length} less on the Lumbridge range, ${rows.filter(m => m.opt.gauntlets).length} less with gauntlets)`);
  cookingNotes.push(`left out, as the calculator does: ${[...new Set(Object.values(LEFT_OUT))].filter(v => !/quest reward|cheat/.test(v)).join(', ')}`);
}

await cooking();

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

const names = [...used].filter(k => !virtualItems[k] && !chargeItems[k]).map(need).sort((a, b) => ITEM.get(a).id - ITEM.get(b).id);

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
// A sheet's address carries a stamp of its contents. Where an icon sits is in
// the data, so the two have to come from the same build: with the stamp in the
// address the data names, a browser can't pair new positions with a sheet it
// kept from an earlier release (which showed every icon wrong after v2.6.0
// until its cache ran out).
const stamped = async (file, png) => {
  await writeFile(file, png);
  return `${file}?v=${createHash('sha1').update(png).digest('hex').slice(0, 10)}`;
};
const iconSheet = await stamped('items.png', await sharp(atlas, { raw: { width: PER_ROW * SIZE, height: rows * SIZE, channels: 4 } })
  .png({ compressionLevel: 9, palette: false }).toBuffer());

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
// What a worn item gives while it lasts (a ring of forging's 140 bars): not an
// item you hold, so it's worth nothing and never bought. Plans count the ring.
for (const [slug, v] of Object.entries(chargeItems)) {
  items[slug] = { id: v.id, name: v.name, cost: 0, members: 1, icon: items[v.of].icon, gp: 0, charge: { of: v.of, per: v.per } };
}

const out = `// Generated by build-data.mjs. Do not edit by hand; change the script and re-run it.
// Levels and XP come from Lost City's server content (LostCityRS/Content, rev 274, MIT);
// XP is in tenths, like the server keeps it. Item names, ids and shop values are from
// LostHQ's item database (GPL-3.0). The rows of Crafting, Mining and Smithing are those
// of LostHQ's calculators (GPL-3.0), checked against the server. RuneScape is (c) Jagex Ltd.
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
// opt: what a choice on the goal changes about a method (CHOICES names them):
// { choice: { in (what it takes instead), add (what it takes besides), xp, note,
// magic/spell/magicLevel, through } }. through: a method that feeds is planned
// through from scratch as well, like a prep step, and its XP counts (bars you
// smelt yourself). icon: the item a method is shown as, when it isn't the first
// thing it makes (a gem rock; the bar a Mining row mines the ore for).
// lead and as: a row counted in what its output is for, with the words to say so
// (lead "Ore for", as ["steel bar", "steel bars"]: "Ore for 400 steel bars: …").
// after: methods that share an ingredient with this one and get it first when a
// bank can make either (Herblore: super attacks before superantipoisons).
// aside: not what a plan trains with unless you pick it or your bank holds it
// (quest food; a big net's fish). chance: a method that can fail, as [low,
// high], what the server's roll is given: how often it works depends on your
// level (Cooking: food burns), and plans count the tries it takes. A goal's
// choices can set chanceAt (another fire) and chanceWorn (cooking gauntlets),
// which go before it.
// An item with gp is always worth that (a coin is 1 gp): no market price. One
// with charge is what a worn item gives while it lasts (a ring of forging's 140
// bars): a step on the way turns the item into them, so plans count whole rings.

export const GAME_REVISION = 274;
export const ICON_SIZE = ${SIZE};
export const ICONS_PER_ROW = ${PER_ROW};
// The icon sheet these positions are for: its address, with a stamp of its
// contents, so a browser never pairs them with a sheet from another release.
export const ICON_SHEET = ${JSON.stringify(iconSheet)};

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

// Choices a goal has in a skill, each changing what some methods take or give
// (a method's "opt"). One with options is a list to pick from: the first is how
// it starts and changes nothing. One without is a tick box, off to start.
// unless: a choice that makes this one pointless, so it's left out then.
export const CHOICES = ${JSON.stringify(choices, null, 2)};
`;
await writeFile('gamedata.js', out);
console.log(`gamedata.js: ${methods.length} methods, ${names.length} items; items.png ${PER_ROW * SIZE}x${rows * SIZE}`);
for (const note of craftingNotes) console.log(`  crafting: ${note}`);
for (const note of miningNotes) console.log(`  mining: ${note}`);
for (const note of smithingNotes) console.log(`  smithing: ${note}`);
for (const note of fishingNotes) console.log(`  fishing: ${note}`);
for (const note of cookingNotes) console.log(`  cooking: ${note}`);

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
        const ours = items[kept.slug].name, theirs = ITEM.get(slug).name;
        // (the very same name and picture is the same thing as far as a bank shows: Tutorial Island's raw
        // shrimps and pot of flour, an incomplete stew with the meat in before the potato. Nothing to say.)
        if (theirs === ITEM.get(kept.slug).name) return;
        const twin = bare(theirs) === bare(ours) ? `${bare(ours)} (fewer charges)` : bare(theirs);
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
  // An amulet of glory with no charges left looks the same again: it's the next
  // guess, before the plain dragonstone amulet.
  const enchantedFirst = methods.filter(m => m.id.startsWith('cr_ench_')).map(m => Object.keys(m.out)[0]).flatMap(k => (unchargedOf[k] ? [k, unchargedOf[k]] : [k]));
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
  const bankSheet = await stamped('bankicons.png', await sharp(bAtlas, { raw: { width: PER_ROW * SIZE, height: bRows * SIZE, channels: 4 } })
    .png({ compressionLevel: 9, palette: false }).toBuffer());

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
// (its address, stamped with its contents: this list and the sheet go together)
export const BANK_ICON_SHEET = ${JSON.stringify(bankSheet)};
export const BANK_ICONS = [
${entries.map(({ e }) => '  ' + JSON.stringify(e)).join(',\n')},
];
`);
  const counts = entries.reduce((a, { e }) => { a[e.of ? 'variants' : e.other ? 'others' : 'ours']++; return a; }, { ours: 0, variants: 0, others: 0 });
  console.log(`bankread-data.js: ${entries.length} icons (${counts.ours} planner items, ${counts.variants} variants, ${counts.others} lookalikes); bankicons.png ${PER_ROW * SIZE}x${bRows * SIZE}`);
}

await bankScreenshots();
