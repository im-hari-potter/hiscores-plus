// Run with:  node --test
// Reading a bank from a screenshot, on pretend screenshots painted the way the
// client draws the bank (bankfake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIcons, readBank, mergeReads, parseStack, findBank, reviewRows, pickRow, movedFrom } from './bankread.js';
import { BANK_ICONS, BANK_ICONS_PER_ROW, BANK_LAYOUT, STACK_FONT } from './bankread-data.js';
import { ITEMS, BANK_GROUPS, METHODS } from './gamedata.js';
import { fakeBank, atlas, crop } from './bankfake.mjs';

const icons = prepareIcons(atlas, BANK_ICONS, BANK_ICONS_PER_ROW);
const read = img => readBank(img, icons, STACK_FONT, BANK_LAYOUT);
const bySlot = r => Object.fromEntries(r.slots.map(s => [s.slot, s]));
const item = (merged, slug) => merged.items.find(i => i.slug === slug);

const BANK = [
  { slot: 0, icon: 'lawrune', count: 3960 },
  { slot: 1, icon: 'naturerune', count: 1524 },
  { slot: 2, icon: '1doseprayerrestore', count: 3309 },        // looks like a potion of ours, isn't a planner item (up to v2.8 a blood rune stood here: Magic's now)
  { slot: 3, icon: 'blankrune', count: 150_420 },              // shown as 150K
  { slot: 4, icon: 'bronze_arrow_5', count: 5000 },            // the icon of a big stack of arrows
  { slot: 5, icon: 'unidentified_guam', count: 25 },
  { slot: 6, icon: 'unidentified_ardrigal', count: 10 },       // another "Herb"
  { slot: 7, icon: 'unstrung_yew_longbow', count: 1 },         // one of a kind: no number
  { slot: 8, icon: 'yew_logs', count: 1044 },
  { slot: 9, icon: 'magic_logs', count: 973 },
  { slot: 10, icon: 'oak_logs', count: 12_000_000 },           // 12M
  { slot: 11, icon: 'feather', count: 1, stack: true },        // a stack of one shows "1"
  { slot: 48, icon: '3doseprayerrestore', count: 1536 },       // row 6: below the view at scroll 0
  { slot: 49, icon: 'vial_water', count: 1905 },
];

test('stack numbers: exact below 100K, rounded K and M above', () => {
  assert.deepEqual(parseStack('3960'), { text: '3960', count: 3960, min: 3960, max: 3960 });
  assert.deepEqual(parseStack('150K'), { text: '150K', count: 150000, min: 150000, max: 150999, approx: true });
  assert.deepEqual(parseStack('12M'), { text: '12M', count: 12e6, min: 12e6, max: 12999999, approx: true });
  assert.equal(parseStack('').count, null);
});

test('the font is the client\'s p11 (digits 8 high, K and M)', () => {
  assert.equal(STACK_FONT.height, 10);
  assert.deepEqual(Object.keys(STACK_FONT.glyphs), [...'0123456789KM']);
  assert.equal(STACK_FONT.glyphs['1'].mask, '010110010010010010010111');
});

test('finds the bank by its scrollbar, and how far it is scrolled', () => {
  const b = findBank(fakeBank({ items: [], scroll: 220 }), BANK_LAYOUT);
  assert.equal(b.viewX, 41);
  assert.equal(b.viewY, 59);
  assert.ok(b.scrollLo <= 220 && 220 <= b.scrollHi && b.scrollHi - b.scrollLo < 8);
  assert.equal(findBank(fakeBank({ items: [], width: 400 }), BANK_LAYOUT), null, 'no scrollbar, no bank');
});

test('reads items, counts and lookalikes from a whole screenshot', () => {
  const r = read(fakeBank({ items: BANK }));
  assert.equal(r.ok, true);
  assert.equal(r.scroll, 0);
  const s = bySlot(r);
  assert.equal(s[0].entry.slug, 'lawrune'); assert.equal(s[0].count, 3960);
  assert.equal(s[2].entry.other, 1, 'a one-dose potion is something else');
  assert.equal(s[3].count, 150000); assert.equal(s[3].approx, true);
  assert.equal(s[4].entry.of, 'bronze_arrow'); assert.equal(s[4].count, 5000);
  assert.equal(s[7].entry.slug, 'unstrung_yew_longbow'); assert.equal(s[7].count, 1);
  assert.equal(s[8].entry.slug, 'yew_logs'); assert.equal(s[9].entry.slug, 'magic_logs');
  assert.equal(s[10].count, 12e6);
  assert.equal(s[11].count, 1);
  assert.equal(s[48], undefined, 'row 6 is below the view');
  for (const x of r.slots) assert.equal(x.dist, 0, 'painted from the same icons');
});

test('several screenshots: slots are the bank\'s own, so overlaps count once', () => {
  const top = read(fakeBank({ items: BANK, scroll: 0 }));
  const lower = read(fakeBank({ items: BANK, scroll: 100 }));
  assert.equal(lower.scroll, 100);
  const m = mergeReads([top, lower]);
  assert.equal(item(m, 'lawrune').count, 3960);
  assert.equal(item(m, 'unidentified_guam').count, 35, 'every unid herb is one entry');
  assert.deepEqual(item(m, 'unidentified_guam').also, ['lantadyme'], 'lantadyme looks just like one');
  assert.equal(item(m, 'bronze_arrow').count, 5000);
  assert.equal(item(m, '3doseprayerrestore').count, 1536, 'from the scrolled one');
  assert.deepEqual([item(m, 'blankrune').min, item(m, 'blankrune').max], [150000, 150999]);
  assert.equal(item(m, '1doseprayerrestore'), undefined);
  assert.equal(m.others, 1);
  assert.equal(m.complete, true, 'every slot up to the first empty one was seen');
  assert.equal(mergeReads([lower]).complete, false, 'the top of the bank wasn\'t');
});

test('a crop of the bank window reads the same', () => {
  const full = fakeBank({ items: BANK, scroll: 37 });
  const r = read(crop(full, 20, 30, 480, 270));
  assert.equal(r.ok, true);
  assert.equal(r.scroll, 37);
  assert.deepEqual(r.slots.map(s => [s.slot, s.entry?.slug, s.count]), read(full).slots.map(s => [s.slot, s.entry?.slug, s.count]));
});

test('a different brightness setting bends colours, and is allowed for', () => {
  const r = read(fakeBank({ items: BANK, brightness: 1.25 }));
  assert.ok(Math.abs(r.brightness - 1.25) < 0.06, `measured ${r.brightness}`);
  const s = bySlot(r);
  assert.equal(s[8].entry.slug, 'yew_logs');
  assert.equal(s[9].entry.slug, 'magic_logs');
  assert.equal(s[0].entry.slug, 'lawrune');
});

test('every planner item but lantadyme has an icon to be read by', () => {
  const read = new Set(BANK_ICONS.flatMap(e => [e.of || e.slug, ...(e.also || [])]));
  // (v2.8) What only Thieving and Agility name is not read: loot, a lockpick, an Agility Arena ticket. No plan
  // takes those from a bank, so they'd only be lines to check. Everything the other skills use still is.
  const NO_BANK = new Set(['thieving', 'agility']);
  const named = m => [...Object.keys(m.in), ...Object.keys(m.out), ...(m.tools || []), ...(m.icon ? [m.icon] : [])];
  const banked = new Set([...METHODS.filter(m => !NO_BANK.has(m.skill)).flatMap(named), ...Object.values(BANK_GROUPS).flatMap(gs => gs.flatMap(g => g.items))]);
  for (const k of [...banked]) if (/^3dose/.test(k) && ITEMS[k.replace(/^3dose/, '4dose')]) banked.add(k.replace(/^3dose/, '4dose'));
  // (the market's armour sets aren't items in the game, so never in a bank; coins are a fee or loot here, not a bank item)
  assert.deepEqual(Object.keys(ITEMS).filter(k => banked.has(k) && !read.has(k) && !ITEMS[k].set && ITEMS[k].gp == null), []);
  const ours = new Set(BANK_ICONS.filter(e => !e.other).flatMap(e => [e.of || e.slug, ...(e.also || [])]));
  const onlyNew = Object.keys(ITEMS).filter(k => !banked.has(k) && !ITEMS[k].set && !ITEMS[k].charge);
  assert.deepEqual(onlyNew.filter(k => ours.has(k)), [], 'none of them is read as a planner item');
  assert.ok(['silk', 'king_worm', 'lockpick', 'agilityarena_ticket', 'coins_25'].every(k => onlyNew.includes(k)));
  // (v2.9) Prayer's bones and the staves Magic's own spells are cast with are read now, with what looks like them:
  // 929 icons, where v2.7 and v2.8 had 921. Death, blood and soul runes were lookalikes before, and are Magic's now.
  assert.equal(BANK_ICONS.length, 929);
  for (const k of ['bones', 'big_bones', 'dragon_bones', 'wolf_bones', 'bones_burnt', 'deathrune', 'bloodrune', 'soulrune']) assert.ok(BANK_ICONS.some(e => e.slug === k && !e.other && !e.of), k);
  // (a staff a choice has you bring is named, never counted: not read)
  for (const k of ['staff_of_air', 'staff_of_fire', 'lava_battlestaff']) assert.ok(ITEMS[k] && !ours.has(k), k);
  assert.ok(!BANK_ICONS.some(e => (e.of || e.slug) === 'coins' && !e.other), 'a stack of coins is not read as a planner item');
});

test('an item that looks exactly like another says so (v2.5)', () => {
  const entry = slug => BANK_ICONS.find(e => e.slug === slug);
  // enchanted jewellery is the plain piece with a spell on it: read as the enchanted one (likelier in a bank), the plain one noted
  assert.deepEqual(entry('amulet_of_glory_4'), { slug: 'amulet_of_glory_4', also: ['amulet_of_glory', 'strung_dragonstone_amulet'], like: ['Amulet of glory (fewer charges)'] });
  assert.deepEqual(entry('ring_of_dueling_8'), { slug: 'ring_of_dueling_8', also: ['emerald_ring'], like: ['Ring of dueling (fewer charges)'] });
  assert.deepEqual(entry('necklace_of_minigames_8'), { slug: 'necklace_of_minigames_8', also: ['sapphire_necklace'], like: ['Games necklace (fewer charges)'] });
  assert.deepEqual(entry('ring_of_recoil'), { slug: 'ring_of_recoil', also: ['sapphire_ring'] });
  assert.equal(entry('strung_dragonstone_amulet'), undefined);
  // things the planner doesn't use that you could well have in a bank are named
  assert.deepEqual(entry('battlestaff').like, ['Dramen staff', 'Staff']);
  assert.deepEqual(entry('air_battlestaff').like, ['Staff of air', 'Mystic air staff']);
  // (v2.7: a jug of wine and an unfermented one are Cooking's now: a choice, where they were only named)
  assert.deepEqual(entry('wine_of_zamorak'), { slug: 'wine_of_zamorak', also: ['jug_wine', 'jug_unfermented_wine'], like: ['Half full wine jug', 'Jug of bad wine'] });
  assert.equal(entry('lawrune').like, undefined, 'not quest and minigame pieces (a board game\'s law rune)');
  // (v2.7) the very same name and picture is nothing to point out: Tutorial Island's raw shrimps and pot of flour,
  // an incomplete stew with the meat in first. "Fewer charges" is only said of things that have charges
  assert.deepEqual([entry('raw_shrimp'), entry('pot_flour'), entry('stew1')], [{ slug: 'raw_shrimp' }, { slug: 'pot_flour' }, { slug: 'stew1' }]);
  for (const e of BANK_ICONS) for (const n of e.like || []) if (/\(fewer charges\)$/.test(n)) assert.match(ITEMS[e.slug].name, /\(\d+\)$/, `${e.slug}: ${n}`);
  assert.equal(entry('unidentified_guam').like, undefined, 'unid herbs have their own note');
  const m = mergeReads([read(fakeBank({ items: [{ slot: 0, icon: 'amulet_of_glory_4', count: 3 }, { slot: 1, icon: 'ashes', count: 40 }, { slot: 2, icon: 'gold_bar', count: 500 }] }))]);
  assert.deepEqual([item(m, 'amulet_of_glory_4').also, item(m, 'amulet_of_glory_4').like], [['amulet_of_glory', 'strung_dragonstone_amulet'], ['Amulet of glory (fewer charges)']]);
  assert.deepEqual(item(m, 'ashes').also, ['soda_ash'], 'soda ash looks just like ashes');
  assert.equal(item(m, 'gold_bar').like, undefined);
});

test('crafting: every bank item is read as itself, lookalikes told apart by colour, at any brightness (v2.5)', () => {
  // dragonhide in four colours, eight gems cut and uncut, rings, necklaces and amulets: the same shapes, different colours
  const kept = new Map(BANK_ICONS.flatMap(e => (e.also || []).map(a => [a, e.slug])));
  const all = [...new Set(BANK_GROUPS.crafting.flatMap(g => g.items))];
  assert.ok(all.length > 100);
  for (const brightness of [1, 1.25]) {
    for (let i = 0; i < all.length; i += 48) {
      const batch = all.slice(i, i + 48);
      const s = bySlot(read(fakeBank({ items: batch.map((slug, k) => ({ slot: k, icon: kept.get(slug) || slug, count: 100 + k })), brightness })));
      batch.forEach((slug, k) => {
        assert.equal(s[k]?.entry?.slug, kept.get(slug) || slug, `${slug} at brightness ${brightness}`);
        assert.equal(s[k].count, 100 + k);
      });
    }
  }
});

// ── The review: which of two look-alikes a stack is (v2.5.1) ────────────────
const merged = items => mergeReads([read(fakeBank({ items }))]);
const picked = rows => rows.map(r => [r.key, r.slug, r.count]);
const LIKELIER = { ashes: 'soda_ash' };
const UNID = 'unidentified_guam';

test('review: one line for an item; an icon two planner items share is a line a slot, with a choice (v2.5.1)', () => {
  const m = merged([{ slot: 0, icon: 'gold_bar', count: 500 }, { slot: 1, icon: 'ashes', count: 1234 }, { slot: 2, icon: 'uncut_sapphire', count: 100 }]);
  assert.deepEqual(item(m, 'ashes').parts, [{ slot: 1, count: 1234, min: 1234, max: 1234, approx: false, unsure: false, shared: true }]);
  assert.equal(item(m, 'gold_bar').parts[0].shared, false);
  const rows = reviewRows(m, { likelier: LIKELIER });
  assert.deepEqual(picked(rows), [['gold_bar', 'gold_bar', 500], ['ashes@0', 'soda_ash', 1234], ['uncut_sapphire', 'uncut_sapphire', 100]]);
  const [bar, ash] = rows;
  assert.equal(bar.choices, undefined, 'nothing to choose');
  assert.deepEqual([ash.icon, ash.choices, ash.slots, ash.min, ash.max], ['ashes', ['ashes', 'soda_ash'], [1], 1234, 1234]);
  // an item with an icon of its own reads as before
  const { parts, ...whole } = item(m, 'gold_bar');
  assert.deepEqual(bar, { key: 'gold_bar', ...whole });
});

test('review: soda ash rather than ashes, until you say otherwise; a stack an earlier read filed under Ashes moves over (v2.5.1)', () => {
  const m = merged([{ slot: 0, icon: 'ashes', count: 1234 }]);
  const first = opts => reviewRows(m, { likelier: LIKELIER, ...opts })[0].slug;
  assert.equal(first({}), 'soda_ash', 'banked for glass far more often than ashes are kept');
  assert.equal(reviewRows(m)[0].slug, 'ashes', "nothing likelier given: the icon's own name");
  // v2.5.0 filed it under Ashes without asking, so ashes in your bank say nothing
  assert.equal(first({ bank: { ashes: 1234 } }), 'soda_ash');
  assert.equal(first({ bank: { ashes: 1234, soda_ash: 900 } }), 'soda_ash');
  // what you said last time is kept, whichever it was
  assert.equal(first({ memory: { ashes: ['ashes'] } }), 'ashes');
  assert.equal(first({ memory: { ashes: ['soda_ash'] }, bank: { ashes: 50 } }), 'soda_ash');
  assert.equal(first({ memory: { ashes: ['gold_bar'] } }), 'soda_ash', 'a pick that is not one of the two is ignored');
  assert.equal(first({ memory: { ashes: ['ashes', 'soda_ash'] } }), 'soda_ash', 'two stacks then, one now: the picks may not line up, so they are left');

  // the same amount under Ashes, none under Soda ash: the same stack, moved over
  const rows = reviewRows(m, { likelier: LIKELIER, bank: { ashes: 1234 } });
  assert.deepEqual(movedFrom(rows, { ashes: 1234 }), { 'ashes@0': 'ashes' });
  assert.deepEqual(movedFrom(rows, { ashes: 1200 }), {}, 'another amount: not this stack, as far as a part of the bank shows');
  assert.deepEqual(movedFrom(rows, { ashes: 1200 }, { complete: true }), { 'ashes@0': 'ashes' }, 'the whole bank was read and nothing in it is ashes');
  assert.deepEqual(movedFrom(rows, { ashes: 1234, soda_ash: 10 }), {}, 'soda ash is in your bank already');
  assert.deepEqual(movedFrom(rows, { ashes: 1234, soda_ash: 10 }, { complete: true }), {});
  assert.deepEqual(movedFrom(rows, {}), {});
  // picked as ashes after all: nothing moves
  assert.equal(pickRow(rows, 'ashes@0', 'ashes'), true);
  assert.equal(rows[0].slug, 'ashes');
  assert.deepEqual(movedFrom(rows, { ashes: 1234 }), {});
  assert.equal(pickRow(rows, 'ashes@0', 'ashes'), false, 'already that');
  assert.equal(pickRow(rows, 'ashes@0', 'gold_bar'), false, 'not one of the two');
  assert.equal(pickRow(rows, 'nothing', 'ashes'), false);
  // 100K and up the bank shows a rounded amount: yours fits if it is in the range
  const big = reviewRows(merged([{ slot: 0, icon: 'ashes', count: 150_420 }]), { likelier: LIKELIER });
  assert.deepEqual(movedFrom(big, { ashes: 150_420 }), { 'ashes@0': 'ashes' });
  assert.deepEqual(movedFrom(big, { ashes: 151_000 }), {});
});

test('review: both in the bank are a line each, and picking one swaps the other (v2.5.1)', () => {
  const m = merged([{ slot: 0, icon: 'ashes', count: 40 }, { slot: 5, icon: 'ashes', count: 1234 }]);
  assert.equal(item(m, 'ashes').count, 1274, 'mergeReads still adds the slots up');
  let rows = reviewRows(m, { likelier: LIKELIER });
  assert.deepEqual(picked(rows), [['ashes@0', 'soda_ash', 40], ['ashes@1', 'ashes', 1234]], 'one of each: a bank holds one stack of an item');
  assert.deepEqual(rows.map(r => r.slots), [[0], [5]]);
  assert.equal(pickRow(rows, 'ashes@0', 'ashes'), true);
  assert.deepEqual(picked(rows), [['ashes@0', 'ashes', 40], ['ashes@1', 'soda_ash', 1234]], 'swapped');
  // remembered in the bank's order, while it shows as many stacks
  rows = reviewRows(m, { likelier: LIKELIER, memory: { ashes: ['ashes', 'soda_ash'] } });
  assert.deepEqual(picked(rows), [['ashes@0', 'ashes', 40], ['ashes@1', 'soda_ash', 1234]]);
  // the one whose amount you typed in is that one, wherever it sits
  rows = reviewRows(m, { likelier: LIKELIER, bank: { soda_ash: 1234 } });
  assert.deepEqual(picked(rows), [['ashes@0', 'ashes', 40], ['ashes@1', 'soda_ash', 1234]]);
  assert.deepEqual(movedFrom(rows, { soda_ash: 1234 }), {});
  // Once you've said which is which, the amounts in your bank tell them apart when a picture shows
  // only one of the two: its very amount, else the nearer one
  const one = n => reviewRows(merged([{ slot: 7, icon: 'ashes', count: n }]), { likelier: LIKELIER, memory: { ashes: ['soda_ash', 'ashes'] }, bank: { soda_ash: 1234, ashes: 40 } })[0].slug;
  assert.equal(one(40), 'ashes');
  assert.equal(one(1234), 'soda_ash');
  assert.equal(one(55), 'ashes', 'nearer 40 than 1,234');
  assert.equal(one(900), 'soda_ash');
  // (before you have, ashes in your bank prove nothing: v2.5.0 filed soda ash there)
  assert.equal(reviewRows(merged([{ slot: 7, icon: 'ashes', count: 40 }]), { likelier: LIKELIER, bank: { soda_ash: 1234, ashes: 40 } })[0].slug, 'soda_ash');
  // one more stack than last time: the amounts place the ones you have
  rows = reviewRows(m, { likelier: LIKELIER, memory: { ashes: ['soda_ash'] }, bank: { soda_ash: 1234 } });
  assert.deepEqual(picked(rows), [['ashes@0', 'ashes', 40], ['ashes@1', 'soda_ash', 1234]]);
  assert.deepEqual(movedFrom(reviewRows(m, { likelier: LIKELIER }), { ashes: 40 }, { complete: true }), {}, 'a line says it is ashes');
});

test('review: enchanted jewellery by default, the plain piece once you have typed it in (v2.5.1)', () => {
  const one = merged([{ slot: 0, icon: 'ring_of_recoil', count: 500 }]);
  const first = (m, opts) => picked(reviewRows(m, { likelier: LIKELIER, ...opts })).map(r => r[1]);
  assert.deepEqual(first(one, {}), ['ring_of_recoil'], 'what a bank mostly holds');
  assert.deepEqual(first(one, { bank: { ring_of_recoil: 500 } }), ['ring_of_recoil']);
  // a read never files a stack under the plain name without asking, so that amount is yours
  assert.deepEqual(first(one, { bank: { sapphire_ring: 500 } }), ['sapphire_ring']);
  assert.deepEqual(first(one, { bank: { sapphire_ring: 480 } }), ['sapphire_ring'], 'whatever the amount');
  assert.deepEqual(movedFrom(reviewRows(one, { bank: { sapphire_ring: 480 } }), { sapphire_ring: 480 }), {});
  // both: one of each, the plain one by its amount
  const two = merged([{ slot: 3, icon: 'ring_of_recoil', count: 500 }, { slot: 9, icon: 'ring_of_recoil', count: 2 }]);
  assert.deepEqual(first(two, {}), ['ring_of_recoil', 'sapphire_ring']);
  assert.deepEqual(first(two, { bank: { sapphire_ring: 500 } }), ['sapphire_ring', 'ring_of_recoil']);
  assert.deepEqual(first(two, { bank: { sapphire_ring: 2 } }), ['ring_of_recoil', 'sapphire_ring']);
  // a third stack with that icon (a ring of recoil part used): it adds to one of the two, or you untick it
  const three = merged([{ slot: 0, icon: 'ring_of_recoil', count: 1 }, { slot: 1, icon: 'ring_of_recoil', count: 1 }, { slot: 2, icon: 'ring_of_recoil', count: 300 }]);
  assert.deepEqual(first(three, {}), ['ring_of_recoil', 'sapphire_ring', 'ring_of_recoil']);
  // lookalikes the planner doesn't use stay named on the line
  const glory = reviewRows(merged([{ slot: 0, icon: 'amulet_of_glory_4', count: 3 }]))[0];
  assert.deepEqual([glory.choices, glory.like], [['amulet_of_glory_4', 'amulet_of_glory', 'strung_dragonstone_amulet'], ['Amulet of glory (fewer charges)']]);
});

test('review: any stack that looks like an unid herb can be said to be lantadyme (v2.5.1)', () => {
  const m = merged([
    { slot: 0, icon: 'unidentified_guam', count: 25 }, { slot: 1, icon: 'unidentified_guam', count: 642 },
    { slot: 2, icon: 'unidentified_ardrigal', count: 10 }, { slot: 3, icon: 'unidentified_guam', count: 7 },
  ]);
  assert.equal(item(m, UNID).count, 684, 'every unid herb is one entry');
  const opts = { likelier: LIKELIER, repeat: [UNID] };
  let rows = reviewRows(m, opts);
  // every stack that looks just like lantadyme has the choice; an unid herb with an icon of its own doesn't
  assert.deepEqual(picked(rows), [[`${UNID}@0`, UNID, 25], [`${UNID}@1`, UNID, 642], [`${UNID}@2`, UNID, 7], [UNID, UNID, 10]]);
  assert.deepEqual(rows.map(r => r.choices), [[UNID, 'lantadyme'], [UNID, 'lantadyme'], [UNID, 'lantadyme'], undefined]);
  assert.deepEqual(rows[3].slots, [2]);
  // several can be unid herbs, so saying one is lantadyme leaves the others be
  assert.equal(pickRow(rows, `${UNID}@1`, 'lantadyme', [UNID]), true);
  assert.deepEqual(picked(rows).map(r => r[1]), [UNID, 'lantadyme', UNID, UNID]);
  // ...and saying another is, moves it (one stack of lantadyme)
  assert.equal(pickRow(rows, `${UNID}@2`, 'lantadyme', [UNID]), true);
  assert.deepEqual(picked(rows).map(r => r[1]), [UNID, UNID, 'lantadyme', UNID]);
  assert.equal(pickRow(rows, `${UNID}@2`, UNID, [UNID]), true);
  assert.deepEqual(picked(rows).map(r => r[1]), [UNID, UNID, UNID, UNID]);
  // lantadyme you typed in: the stack of that amount is it; with no such stack, they're all unid herbs
  assert.deepEqual(picked(reviewRows(m, { ...opts, bank: { lantadyme: 642 } })).map(r => r[1]), [UNID, 'lantadyme', UNID, UNID]);
  assert.deepEqual(picked(reviewRows(m, { ...opts, bank: { lantadyme: 600 } })).map(r => r[1]), [UNID, UNID, UNID, UNID]);
  // remembered while the bank shows as many of them
  assert.deepEqual(picked(reviewRows(m, { ...opts, memory: { [UNID]: [UNID, 'lantadyme', UNID] } })).map(r => r[1]), [UNID, 'lantadyme', UNID, UNID]);
  assert.deepEqual(picked(reviewRows(m, { ...opts, memory: { [UNID]: [UNID, 'lantadyme'] } })).map(r => r[1]), [UNID, UNID, UNID, UNID]);
  // an earlier read counted the lantadyme as unid herbs: a lone stack of that amount moves over
  const lone = reviewRows(merged([{ slot: 0, icon: 'unidentified_guam', count: 642 }]), opts);
  pickRow(lone, `${UNID}@0`, 'lantadyme', [UNID]);
  assert.deepEqual(movedFrom(lone, { [UNID]: 642 }), { [`${UNID}@0`]: UNID });
  // with other unid herbs beside it, they're simply counted again
  rows = reviewRows(m, opts);
  pickRow(rows, `${UNID}@1`, 'lantadyme', [UNID]);
  assert.deepEqual(movedFrom(rows, { [UNID]: 684 }), {});
  assert.deepEqual(movedFrom(rows, { [UNID]: 684 }, { complete: true }), {});
  // ...also when the only other one has an icon of its own
  const pair = reviewRows(merged([{ slot: 0, icon: 'unidentified_guam', count: 642 }, { slot: 1, icon: 'unidentified_ardrigal', count: 10 }]), opts);
  pickRow(pair, `${UNID}@0`, 'lantadyme', [UNID]);
  assert.deepEqual(picked(pair), [[`${UNID}@0`, 'lantadyme', 642], [UNID, UNID, 10]]);
  assert.deepEqual(movedFrom(pair, { [UNID]: 642 }, { complete: true }), {}, 'unid herbs are still in the bank');
});

