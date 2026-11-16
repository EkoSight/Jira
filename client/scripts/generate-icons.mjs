// Draws the app's icons from TaskFlow's mark (public/brand/mark.svg; docs/TASKFLOW_MARK.md):
// the favicon, the installed-app icons, the Apple touch icon, the maskable icon, and the
// notification icons in public/icons. Run via `npm run icons` (also before `npm run build`).
//
// Uses sharp from the server's dependencies. Where it is not installed (a client-only
// build), the committed icons are kept as they are and the build carries on.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const mark = fs.readFileSync(path.join(pub, 'brand', 'mark.svg'));

let sharp;
try {
  sharp = createRequire(path.join(here, '..', '..', 'server', 'package.json'))('sharp');
} catch {
  console.log('[icons] sharp is not installed here; keeping the committed icons');
  process.exit(0);
}

const GREEN = '#073F2A';
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * The mark, `scale` of `size`, centred on a `size` square. The mark is a deep green
 * rounded tile; on a deep green background (Apple touch, maskable) its corners vanish,
 * so the phone's own shape is what people see.
 */
async function icon(size, { background = CLEAR, scale = 1 } = {}) {
  const inner = Math.round(size * scale);
  const art = await sharp(mark, { density: Math.max(72, Math.ceil((inner / 100) * 72 * 1.5)) })
    .resize(inner, inner, { fit: 'contain', background: CLEAR }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: art, gravity: 'centre' }]).png({ compressionLevel: 9 }).toBuffer();
}

const files = {
  'brand/favicon-48.png': [48],
  'brand/icon-192.png': [192],
  'brand/icon-512.png': [512],
  'brand/apple-touch-180.png': [180, { background: GREEN, scale: 1 }],
  'brand/maskable-512.png': [512, { background: GREEN, scale: 0.9 }],
  // notifications and older installs
  'icons/icon-192.png': [192],
  'icons/icon-512.png': [512],
  'icons/icon-maskable-512.png': [512, { background: GREEN, scale: 0.9 }],
};
for (const [file, [size, opts]] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(pub, file)), { recursive: true });
  fs.writeFileSync(path.join(pub, file), await icon(size, opts));
}
console.log(`[icons] drew ${Object.keys(files).length} icons from public/brand/mark.svg`);
