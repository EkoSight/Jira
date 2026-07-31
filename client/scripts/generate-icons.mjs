// Generates the PWA icon PNGs with zlib only — no image dependency to install.
// Run via `npm run icons` (also runs automatically before `npm run build`).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

const BG = hex('#0f172a');
const ACCENT = hex('#2a78d6');
const WHITE = [255, 255, 255];

/**
 * Icon artwork: three stacked "cards" of decreasing width — a board column —
 * with the top card in the brand blue.
 */
function makeIcon(size, { maskable = false } = {}) {
  const pad = maskable ? size * 0.18 : size * 0.1;
  const radius = maskable ? 0 : size * 0.22;
  const inner = size - pad * 2;

  const cards = [
    { y: 0.06, w: 1.0, h: 0.22, color: ACCENT },
    { y: 0.39, w: 0.78, h: 0.22, color: WHITE },
    { y: 0.72, w: 0.55, h: 0.22, color: WHITE },
  ];

  const inRoundedRect = (x, y, rx, ry, rw, rh, r) => {
    if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false;
    const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
    const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  return encodePng(size, (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;

    const onBackground = maskable || inRoundedRect(px, py, 0, 0, size, size, radius);
    if (!onBackground) return [0, 0, 0, 0];

    for (const card of cards) {
      const cardX = pad;
      const cardY = pad + inner * card.y;
      const cardW = inner * card.w;
      const cardH = inner * card.h;
      if (inRoundedRect(px, py, cardX, cardY, cardW, cardH, cardH * 0.28)) {
        return [...card.color, card.color === WHITE ? 235 : 255];
      }
    }
    return [...BG, 255];
  });
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), makeIcon(192));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makeIcon(512));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), makeIcon(512, { maskable: true }));
console.log('[icons] wrote icon-192, icon-512, icon-maskable-512 to public/icons');
