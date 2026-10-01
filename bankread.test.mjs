// Run with:  node --test
// Reading a bank from a screenshot, on pretend screenshots painted the way the
// client draws the bank (bankfake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIcons, readBank, mergeReads, parseStack, findBank } from './bankread.js';
import { BANK_ICONS, BANK_ICONS_PER_ROW, BANK_LAYOUT, STACK_FONT } from './bankread-data.js';
import { ITEMS } from './gamedata.js';
import { fakeBank, atlas, crop } from './bankfake.mjs';

const icons = prepareIcons(atlas, BANK_ICONS, BANK_ICONS_PER_ROW);
const read = img => readBank(img, icons, STACK_FONT, BANK_LAYOUT);
const bySlot = r => Object.fromEntries(r.slots.map(s => [s.slot, s]));
const item = (merged, slug) => merged.items.find(i => i.slug === slug);

const BANK = [
  { slot: 0, icon: 'lawrune', count: 3960 },
  { slot: 1, icon: 'naturerune', count: 1524 },
  { slot: 2, icon: 'bloodrune', count: 3309 },                 // looks like a rune, isn't a planner item
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
  assert.equal(s[2].entry.other, 1, 'blood runes are something else');
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
  assert.equal(item(m, 'bloodrune'), undefined);
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
  assert.deepEqual(Object.keys(ITEMS).filter(k => !read.has(k)), []);
});
