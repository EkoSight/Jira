/**
 * Draws the app's launcher icons and splash screens from TaskFlow's brand mark
 * (client/public/brand/mark.svg), so the app looks like TaskFlow and changes
 * with it. Run again after the mark changes: `npm run icons`.
 *
 * Uses sharp from the server's dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const require = createRequire(path.join(root, 'server/package.json'));
const sharp = require('sharp');

const mark = fs.readFileSync(path.join(root, 'client/public/brand/mark.svg'));
const res = path.join(here, '../android/app/src/main/res');
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/** The mark, `size` pixels wide, centred on a `canvas`-pixel square. */
async function onCanvas(canvas, size, background, round = false) {
  const art = await sharp(mark, { density: 512 }).resize(size, size, { fit: 'contain', background: CLEAR }).png().toBuffer();
  let base = sharp({ create: { width: canvas, height: canvas, channels: 4, background } });
  const layers = [];
  if (round) {
    const r = canvas / 2;
    layers.push({ input: Buffer.from(`<svg width="${canvas}" height="${canvas}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`), blend: 'dest-in' });
  }
  base = base.composite([{ input: art, gravity: 'center' }]);
  const flat = await base.png().toBuffer();
  return layers.length ? sharp(flat).composite(layers).png().toBuffer() : flat;
}

for (const [dpi, scale] of Object.entries(DENSITY)) {
  const dir = path.join(res, `mipmap-${dpi}`);
  // legacy icons, 48 dp: the mark on white, a little margin
  const legacy = Math.round(48 * scale);
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), await onCanvas(legacy, Math.round(legacy * 0.84), WHITE));
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), await onCanvas(legacy, Math.round(legacy * 0.84), WHITE, true));
  // adaptive foreground, 108 dp: the mark inside the 66 dp safe zone, on the white background colour
  const fg = Math.round(108 * scale);
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), await onCanvas(fg, Math.round(64 * scale), CLEAR));
}

// splash screens: the same sizes Capacitor made, white, with the mark in the middle
const splashes = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f === 'splash.png') splashes.push(p); } };
walk(res);
for (const file of splashes) {
  const { width, height } = await sharp(file).metadata();
  const size = Math.round(Math.min(width, height) * 0.28);
  const art = await sharp(mark, { density: 512 }).resize(size, size, { fit: 'contain', background: CLEAR }).png().toBuffer();
  const out = await sharp({ create: { width, height, channels: 4, background: WHITE } }).composite([{ input: art, gravity: 'center' }]).png().toBuffer();
  fs.writeFileSync(file, out);
}
console.log(`icons for ${Object.keys(DENSITY).length} densities, ${splashes.length} splash screens`);
