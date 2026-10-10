// Paints a pretend bank screenshot for the tests, the way the client draws one
// (see bankread.js): the scrollbar, icons at their slots, and stack numbers in
// the p11 font, black one pixel down and right, then yellow.
import { readFileSync } from 'node:fs';
import { decodePng } from './testpng.mjs';
import { BANK_ICONS, BANK_ICONS_PER_ROW, BANK_LAYOUT, STACK_FONT } from './bankread-data.js';

export const atlas = decodePng(readFileSync(new URL('./bankicons.png', import.meta.url)));
const TRACK = 0x23201b, GRIP = 0x4d4233, GRIP_HI = 0x766654, GRIP_LO = 0x332d25;

// items: [{ slot, icon (a BANK_ICONS slug), count }]; brightness bends icon colours
export function fakeBank({ items, scroll = 0, width = 765, height = 503, viewX = 41, viewY = 59, brightness = 1 }) {
  const L = BANK_LAYOUT;
  const img = { width, height, data: Buffer.alloc(width * height * 4) };
  const set = (x, y, c, clip = null) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (clip && (y < clip[0] || y >= clip[1])) return;
    const p = (y * width + x) * 4;
    img.data[p] = c >> 16; img.data[p + 1] = (c >> 8) & 255; img.data[p + 2] = c & 255; img.data[p + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, (x + y) % 7 ? 0x483e33 : 0x494034);

  // scrollbar (arrows painted plain; the reader only needs the colours)
  const bx = viewX + L.viewW, h = L.viewH;
  const fill = (x, y, w, hh, c) => { for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c); };
  fill(bx, viewY, 16, 16, GRIP);
  fill(bx, viewY + h - 16, 16, 16, GRIP);
  fill(bx, viewY + 16, 16, h - 32, TRACK);
  const grip = Math.max(8, Math.floor(((h - 32) * h) / L.scrollHeight));
  const gy = viewY + 16 + Math.floor(((h - grip - 32) * scroll) / (L.scrollHeight - h));
  fill(bx, gy, 16, grip, GRIP);
  fill(bx, gy, 2, grip, GRIP_HI); fill(bx, gy, 16, 2, GRIP_HI);
  fill(bx + 14, gy + 1, 2, grip - 1, GRIP_LO); fill(bx, gy + grip - 2, 16, 2, GRIP_LO);

  const clip = [viewY, viewY + h];
  const curve = c => (brightness === 1 ? c : Math.round(256 * Math.pow(c / 256, brightness)));
  for (const it of items) {
    const n = BANK_ICONS.findIndex(e => e.slug === it.icon);
    if (n < 0) throw new Error(`no icon ${it.icon}`);
    const col = it.slot % L.cols, row = Math.floor(it.slot / L.cols);
    const sx = viewX + L.gridX + col * L.pitchX, sy = viewY + L.gridY + row * L.pitchY - scroll;
    const ox = (n % BANK_ICONS_PER_ROW) * 32, oy = Math.floor(n / BANK_ICONS_PER_ROW) * 32;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const p = ((oy + y) * atlas.width + ox + x) * 4;
        if (!atlas.data[p + 3]) continue;
        let c = (atlas.data[p] << 16) | (atlas.data[p + 1] << 8) | atlas.data[p + 2];
        if (c !== 1 && c !== 0x302020) c = (curve(c >> 16) << 16) | (curve((c >> 8) & 255) << 8) | curve(c & 255);
        set(sx + x, sy + y, c, clip);
      }
    }
    if (it.count !== 1 || it.stack) {
      const text = it.count < 100000 ? String(it.count) : it.count < 10000000 ? Math.floor(it.count / 1000) + 'K' : Math.floor(it.count / 1000000) + 'M';
      drawString(text, sx + 1, sy + 10, 0x000000, set, clip);
      drawString(text, sx, sy + 9, 0xffff00, set, clip);
    }
  }
  return img;
}

// A pretend screenshot with things in the inventory (and the bank open too, with
// bank: [...] as fakeBank's items). items: [{ slot (0 to 27), icon, count, stack }].
// x, y: where the first slot is (the game canvas has it at 569, 213).
export function fakeInventory({ items, bank = null, width = 765, height = 503, x = 569, y = 213, brightness = 1 }) {
  const img = bank ? fakeBank({ items: bank, width, height, brightness }) : { width, height, data: Buffer.alloc(width * height * 4) };
  const set = (px, py, c) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const p = (py * width + px) * 4;
    img.data[p] = c >> 16; img.data[p + 1] = (c >> 8) & 255; img.data[p + 2] = c & 255; img.data[p + 3] = 255;
  };
  // the side panel's stone, a little uneven (and the rest of the canvas, when there's no bank)
  if (!bank) for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) set(px, py, (px * 3 + py) % 11 ? 0x3e3529 : 0x4a4035);
  for (let py = y - 8; py < y + 6 * 36 + 32 + 8; py++) for (let px = x - 16; px < x + 3 * 42 + 32 + 16; px++) set(px, py, (px + 2 * py) % 9 ? 0x3e3529 : 0x2f281f);
  const curve = c => (brightness === 1 ? c : Math.round(256 * Math.pow(c / 256, brightness)));
  for (const it of items) {
    const n = BANK_ICONS.findIndex(e => e.slug === it.icon);
    if (n < 0) throw new Error(`no icon ${it.icon}`);
    const sx = x + (it.slot % 4) * 42, sy = y + Math.floor(it.slot / 4) * 36;
    const ox = (n % BANK_ICONS_PER_ROW) * 32, oy = Math.floor(n / BANK_ICONS_PER_ROW) * 32;
    for (let j = 0; j < 32; j++) {
      for (let i = 0; i < 32; i++) {
        const p = ((oy + j) * atlas.width + ox + i) * 4;
        if (!atlas.data[p + 3]) continue;
        let c = (atlas.data[p] << 16) | (atlas.data[p + 1] << 8) | atlas.data[p + 2];
        if (c !== 1 && c !== 0x302020) c = (curve(c >> 16) << 16) | (curve((c >> 8) & 255) << 8) | curve(c & 255);
        set(sx + i, sy + j, c);
      }
    }
    if (it.count !== 1 || it.stack) {
      const text = it.count < 100000 ? String(it.count) : it.count < 10000000 ? Math.floor(it.count / 1000) + 'K' : Math.floor(it.count / 1000000) + 'M';
      drawString(text, sx + 1, sy + 10, 0x000000, set, null);
      drawString(text, sx, sy + 9, 0xffff00, set, null);
    }
  }
  return img;
}

function drawString(text, x, y, colour, set, clip) {
  y -= STACK_FONT.height;
  for (const ch of text) {
    const g = STACK_FONT.glyphs[ch];
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (g.mask[j * g.w + i] === '1') set(x + g.offX + i, y + g.offY + j, colour, clip);
    x += g.adv;
  }
}

// A piece of an image (a crop of the bank window).
export function crop(img, x, y, w, h) {
  const out = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  for (let j = 0; j < h; j++) img.data.copy(out.data, j * w * 4, ((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4);
  return out;
}
