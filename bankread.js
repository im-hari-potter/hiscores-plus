// Reading the bank from a screenshot. LostKit's screenshot key saves the game
// canvas pixel for pixel, so the bank can be read back the way the client drew it:
//   - where: the bank's scrollbar is drawn in fixed colours, which gives the
//     item grid's place in the picture and how far the bank is scrolled;
//   - what: each slot's icon outline is drawn in one fixed colour (1, near
//     black), so its shape is exact whatever the brightness setting. The shape
//     narrows the slot to items that look alike; colour picks among them;
//   - how many: the stack number, yellow p11 digits drawn over the icon's top
//     left ("150K" from 100,000 up, "12M" from 10 million up).
// It works on the whole game screenshot or a crop of the bank window.
// No DOM here: an image is { width, height, data } with RGBA bytes.

const OUTLINE = 1;                  // the icon outline colour
const SHADOW = 0x302020;            // the icon drop shadow
const YELLOW = 0xffff00;            // stack numbers…
const BLACK = 0x000000;             // …and their shadow
const TRACK = 0x23201b, GRIP = 0x4d4233, GRIP_HI = 0x766654, GRIP_LO = 0x332d25;
const BAR = new Set([TRACK, GRIP, GRIP_HI, GRIP_LO]);
const TEXT_ROWS = 9;                // stack numbers (and their shadow) stay above this row

const at = (img, x, y) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return -1;
  const p = (y * img.width + x) * 4;
  return (img.data[p] << 16) | (img.data[p + 1] << 8) | img.data[p + 2];
};

// ── Icons ─────────────────────────────────────────────────────────────────
// atlas: the bankicons.png pixels; entries: BANK_ICONS from bankread-data.js.
export function prepareIcons(atlas, entries, perRow, size = 32) {
  const list = entries.map((e, n) => {
    const ox = (n % perRow) * size, oy = Math.floor(n / perRow) * size;
    const outline = [], colour = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = ((oy + y) * atlas.width + ox + x) * 4;
        if (!atlas.data[p + 3]) continue;
        const c = (atlas.data[p] << 16) | (atlas.data[p + 1] << 8) | atlas.data[p + 2];
        if (c === OUTLINE) outline.push(y * size + x);
        else if (c !== SHADOW) colour.push([y * size + x, atlas.data[p], atlas.data[p + 1], atlas.data[p + 2]]);
      }
    }
    return { e, outline, upper: outline.filter(i => i < TEXT_ROWS * size), colour };
  });
  // Indexed by the outline below the stack number, which text never covers.
  const byLower = new Map();
  for (const ic of list) {
    const key = ic.outline.filter(i => i >= TEXT_ROWS * size).join(',');
    (byLower.get(key) || byLower.set(key, []).get(key)).push(ic);
  }
  return { list, byLower, size };
}

// ── Where the bank is ─────────────────────────────────────────────────────
// The scrollbar is 16 pixels wide, as tall as the bank's view, in fixed colours
// (its arrows use them too). The grip's place gives the scroll to within a few
// pixels; the icons pin it down exactly (readBank).
export function findBank(img, layout) {
  const { viewW, viewH, scrollHeight } = layout;
  for (let x = 0; x + 16 <= img.width; x++) {
    let run = 0, start = 0;
    for (let y = 0; y <= img.height; y++) {
      if (y < img.height && BAR.has(at(img, x, y))) { if (!run) start = y; run++; continue; }
      if (run >= viewH - 34 && run <= viewH) {
        const top = run >= viewH - 2 ? start : start - 16;     // with or without the arrows
        const mid = top + 16 + 4;
        let wide = true;
        for (let i = 0; i < 16 && wide; i++) if (!BAR.has(at(img, x + i, mid))) wide = false;
        if (wide && top >= 0) {
          // grip: the first row down the middle that isn't track
          let gripTop = top + 16;
          while (gripTop < top + viewH - 16 && at(img, x + 7, gripTop) === TRACK) gripTop++;
          const gripY = gripTop - top - 16;
          const room = viewH - 32 - Math.max(8, Math.floor(((viewH - 32) * viewH) / scrollHeight));
          const span = scrollHeight - viewH;
          const lo = Math.max(0, Math.ceil((gripY * span) / room));
          const hi = Math.min(span, Math.ceil(((gripY + 1) * span) / room) - 1);
          return { barX: x, viewX: x - viewW, viewY: top, scrollLo: lo, scrollHi: Math.max(lo, hi) };
        }
      }
      run = 0;
    }
  }
  return null;
}

// ── Stack numbers ─────────────────────────────────────────────────────────
// The client draws the number twice, black one pixel down and right, then
// yellow, with its baseline 9 pixels below the slot's top.
export function readStack(img, x, y, font) {
  // Screenshots from other tools can have the number a pixel off the icon, so
  // a pixel or two up and down is tried too.
  for (const dy of [0, -1, 1, -2, 2]) {
    const got = readText(img, x, y + dy, font);
    if (got && /^\d+[KM]?$/.test(got)) return parseStack(got);
  }
  return parseStack('');
}

function readText(img, x, y, font) {
  const glyphs = GLYPHS.get(font) || GLYPHS.set(font, Object.entries(font.glyphs).map(([ch, g]) => ({ ch, ...g, bits: [...g.mask].map(Number) }))).get(font);
  const top = y + 9 - font.height;
  let cx = x, text = '';
  for (let guard = 0; guard < 12; guard++) {
    let best = null;
    for (const g of glyphs) {
      let ok = true, n = 0;
      for (let j = 0; j < g.h && ok; j++) {
        for (let i = 0; i < g.w; i++) {
          const yellow = at(img, cx + g.offX + i, top + g.offY + j) === YELLOW;
          if (g.bits[j * g.w + i]) { if (!yellow) { ok = false; break; } n++; }
          else if (yellow) { ok = false; break; }
        }
      }
      if (ok && (!best || n > best.n)) best = { g, n };
    }
    if (!best) break;
    text += best.g.ch;
    cx += best.g.adv;
  }
  return text;
}
const GLYPHS = new WeakMap();

// "1234" -> exact; "150K" -> 150,000 to 150,999; "12M" -> 12,000,000 to 12,999,999
export function parseStack(text) {
  const m = /^(\d+)([KM]?)$/.exec(text);
  if (!m) return { text: '', count: null };
  const n = Number(m[1]);
  if (!m[2]) return { text, count: n, min: n, max: n };
  const unit = m[2] === 'K' ? 1e3 : 1e6;
  return { text, count: n * unit, min: n * unit, max: n * unit + unit - 1, approx: true };
}

// ── Reading one screenshot ────────────────────────────────────────────────
// Returns { ok, scroll, brightness, slots: [{ slot, row, col, entry, count, … }],
// empty: [slot …], unknown } or { ok: false, why } when there's no bank in the picture.
export function readBank(img, icons, font, layout) {
  const bank = findBank(img, layout);
  if (!bank) return { ok: false, why: 'no-bank' };
  const { cols, rows, pitchX, pitchY, gridX, gridY, viewH } = layout;
  const size = icons.size;
  const slotAt = (c, r, scroll) => [bank.viewX + gridX + c * pitchX, bank.viewY + gridY + r * pitchY - scroll];
  const visible = scroll => {
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const [x, y] = slotAt(c, r, scroll);
        if (y >= bank.viewY && y + size <= bank.viewY + viewH && x >= 0 && y >= 0 && x + size <= img.width && y + size <= img.height) out.push({ slot: r * cols + c, row: r, col: c, x, y });
      }
    }
    return out;
  };
  const outlineIn = (x, y) => {
    const out = [];
    for (let i = 0; i < size * size; i++) if (at(img, x + (i % size), y + Math.floor(i / size)) === OUTLINE) out.push(i);
    return out;
  };
  const shapeMatches = s => {
    const lower = s.outline.filter(i => i >= TEXT_ROWS * size).join(',');
    return (icons.byLower.get(lower) || []).filter(ic => {
      // the top rows: the outline where the stack number doesn't cover it
      for (const i of ic.upper) {
        if (s.set.has(i)) continue;
        const v = at(img, s.x + (i % size), s.y + Math.floor(i / size));
        if (v !== YELLOW && v !== BLACK) return false;
      }
      for (const i of s.outline) if (i < TEXT_ROWS * size && !ic.upper.includes(i)) return false;
      return true;
    });
  };

  // The scroll within the grip's few pixels (and a few either side, for
  // pictures from other tools): the one where the most slots have an icon
  // shape we know, then where the most stack numbers sit exactly in place.
  let best = null;
  const span = layout.scrollHeight - viewH;
  for (let scroll = Math.max(0, bank.scrollLo - 3); scroll <= Math.min(span, bank.scrollHi + 3); scroll++) {
    const slots = visible(scroll).map(s => { const outline = outlineIn(s.x, s.y); return { ...s, outline, set: new Set(outline) }; });
    let score = 0;
    for (const s of slots) {
      if (!s.outline.length) continue;
      if (shapeMatches(s).length) score += 1000;
      if (readText(img, s.x, s.y, font)) score++;
    }
    if (!best || score > best.score) best = { scroll, slots, score };
  }

  // Colour: the closest of the same shape. The brightness setting bends every
  // colour the same way (a power curve); when colours are off overall, the
  // curve that makes the slots fit their icons best is found and allowed for.
  const read = best.slots.filter(s => s.outline.length).map(s => ({ s, shape: shapeMatches(s) }));
  const distance = (ic, s, k, step = 1) => {
    let d = 0, n = 0;
    for (let j = 0; j < ic.colour.length; j += step) {
      const [i, r, g, b] = ic.colour[j];
      const v = at(img, s.x + (i % size), s.y + Math.floor(i / size));
      if (i < TEXT_ROWS * size && (v === YELLOW || v === BLACK)) continue;
      d += Math.abs(curve(r, k) - ((v >> 16) & 255)) + Math.abs(curve(g, k) - ((v >> 8) & 255)) + Math.abs(curve(b, k) - (v & 255));
      n++;
    }
    return n ? d / n : Infinity;
  };
  const fit = (k, step) => {
    let total = 0, n = 0;
    for (const { s, shape } of read) {
      let m = Infinity;
      for (const ic of shape) m = Math.min(m, distance(ic, s, k, step));
      if (m < Infinity) { total += Math.min(m, 80); n++; }
    }
    return n ? total / n : Infinity;
  };
  let k = 1;
  let bestFit = fit(1, 3);
  if (bestFit > 6) {
    for (let kk = 0.6; kk <= 1.66; kk += 0.05) { const f = fit(kk, 3); if (f < bestFit) { bestFit = f; k = kk; } }
    for (let kk = k - 0.04; kk <= k + 0.041; kk += 0.01) { const f = fit(kk, 2); if (f < bestFit) { bestFit = f; k = kk; } }
  }
  const picks = read.map(({ s, shape }) => {
    let top = null, second = Infinity;
    for (const ic of shape) {
      const d = distance(ic, s, k);
      if (!top || d < top.d) { second = top ? top.d : second; top = { ic, d }; } else if (d < second) second = d;
    }
    return { s, top, second };
  });

  const slots = [];
  let unknown = 0;
  for (const { s, top, second } of picks) {
    const stack = readStack(img, s.x, s.y, font);
    const count = stack.text ? stack : { text: '', count: 1, min: 1, max: 1 };
    if (!top || top.d > 40) { unknown++; slots.push({ slot: s.slot, row: s.row, col: s.col, entry: null, ...count }); continue; }
    slots.push({ slot: s.slot, row: s.row, col: s.col, entry: top.ic.e, dist: top.d, margin: second - top.d, ...count });
  }
  const empty = best.slots.filter(s => !s.outline.length).map(s => s.slot);
  return { ok: true, scroll: best.scroll, brightness: k, slots, empty, unknown };
}
const curve = (c, k) => (k === 1 ? c : 256 * Math.pow(c / 256, k));

// ── Several screenshots ───────────────────────────────────────────────────
// Slots are the bank's own, so screenshots that overlap don't count twice. A
// later screenshot wins for a slot it shows again.
export function mergeReads(reads) {
  const bySlot = new Map(), empty = new Set();
  for (const r of reads) {
    if (!r.ok) continue;
    for (const s of r.slots) { bySlot.set(s.slot, s); empty.delete(s.slot); }
    for (const e of r.empty) if (!bySlot.has(e)) empty.add(e);
  }
  const items = new Map();          // slug -> { count, min, max, approx, slots, also }
  let others = 0, unknown = 0;
  for (const s of [...bySlot.values()].sort((a, b) => a.slot - b.slot)) {
    if (!s.entry) { unknown++; continue; }
    if (s.entry.other) { others++; continue; }
    const slug = s.entry.of || s.entry.slug;
    const it = items.get(slug) || { slug, count: 0, min: 0, max: 0, approx: false, unsure: false, slots: [], also: s.entry.also || [] };
    it.count += s.count; it.min += s.min; it.max += s.max;
    it.approx ||= !!s.approx;
    // a close call between lookalikes (oak or magic logs), worth a look
    it.unsure ||= s.margin < 2 || s.dist > 15;
    it.slots.push(s.slot);
    items.set(slug, it);
  }
  // The bank keeps items together from the first slot, so it's all been seen
  // once every slot up to the first empty one has.
  const firstEmpty = Math.min(...empty, Infinity);
  let complete = Number.isFinite(firstEmpty);
  for (let i = 0; complete && i < firstEmpty; i++) if (!bySlot.has(i)) complete = false;
  return { items: [...items.values()], others, unknown, seen: bySlot.size, complete };
}
