import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCENT_PRESETS, DEFAULT_BRANDING, GROUNDS, MIN_TEXT, MIN_UI, buildPalette, checkBranding, colourProblems, contrast, nearestPassing, themeCss,
} from '../../shared/brandTheme.js';
import {
  applyFixes, centreCrop, clampCrop, cropForFace, cropPixels, fixColour, fixLight, levelAngle, mainFace, percentiles, sharpen,
} from '../src/lib/photoEdit.js';
import { photoSizeFor } from '../src/lib/photos.js';

// every combination the app paints, in both modes
function assertReadable(palette, label) {
  for (const mode of ['light', 'dark']) {
    const p = palette[mode];
    const g = GROUNDS[mode];
    assert.ok(contrast(p['--on-brand'], p['--brand']) >= MIN_TEXT, `${label} ${mode}: button text`);
    assert.ok(contrast(p['--on-brand'], p['--brand-hover']) >= MIN_TEXT, `${label} ${mode}: button text on hover`);
    assert.ok(contrast(p['--brand'], g.surface) >= MIN_UI, `${label} ${mode}: button against the page`);
    for (const ground of [g.surface, g.plane, g.surface2, g.surface3, p['--brand-wash']]) {
      assert.ok(contrast(p['--brand-ink'], ground) >= MIN_TEXT, `${label} ${mode}: link on ${ground}`);
    }
    assert.ok(contrast(g.ink, p['--brand-wash']) >= MIN_TEXT, `${label} ${mode}: text on the pale tint`);
    assert.ok(contrast(p['--on-accent'], p['--accent']) >= MIN_TEXT, `${label} ${mode}: text on the accent`);
  }
}

test('the Soil Doctor defaults pass every check in light and dark mode', () => {
  const r = checkBranding(DEFAULT_BRANDING);
  assert.equal(r.ok, true);
  assertReadable(r.palette, 'default');
  assert.equal(r.palette.light['--brand'], '#073F2A');
  assert.equal(r.palette.light['--on-brand'], '#ffffff');
  assert.match(themeCss(r.palette), /:root\[data-theme='dark'\]\{--brand:/);
});

test('every accent a person can choose passes, in both modes', () => {
  for (const p of ACCENT_PRESETS) {
    assert.deepEqual(colourProblems(p.hex), [], p.label);
    assertReadable(buildPalette(p.hex, DEFAULT_BRANDING.accent), p.label);
  }
});

test('colours that cannot be read are refused, with the nearest passing shade offered', () => {
  // the old blue: white text 4.42:1
  assert.ok(colourProblems('#2a78d6').some((p) => p.code === 'TEXT_ON_FILL'));
  // Sky and Leaf: buttons that would vanish into a white page
  for (const light of ['#9DDCF8', '#AED252']) {
    assert.ok(colourProblems(light).some((p) => p.code === 'FILL_ON_PAGE'), light);
    const s = nearestPassing(light);
    assert.deepEqual(colourProblems(s), [], `${light} → ${s}`);
    assertReadable(buildPalette(s, DEFAULT_BRANDING.accent), s);
  }
  // looks like a status colour: refused even though it reads
  assert.ok(colourProblems('#D03B3B').some((p) => p.code === 'LOOKS_LIKE_STATUS'));
  assert.ok(colourProblems('#0CA30C').some((p) => p.code === 'LOOKS_LIKE_STATUS'));
  assert.ok(colourProblems('not a colour').some((p) => p.code === 'NOT_A_COLOUR'));
});

test('a dark brand colour is lightened for dark mode so buttons still stand out', () => {
  const p = buildPalette('#073F2A', '#8B5E3B');
  assert.notEqual(p.dark['--brand'], '#073F2A');
  assert.ok(contrast(p.dark['--brand'], GROUNDS.dark.surface) >= MIN_UI);
});

test('a face is framed head-and-shoulders, kept inside the picture', () => {
  const crop = cropForFace({ x: 300, y: 200, w: 200, h: 240 }, 800, 1000);
  const px = cropPixels(crop, 800, 1000);
  assert.ok(Math.abs(240 / px.side - 0.36) < 0.01, 'face fills about a third of the frame');
  assert.ok(px.cx - px.side / 2 >= 0 && px.cx + px.side / 2 <= 800);
  assert.ok(px.cy - px.side / 2 >= 0 && px.cy + px.side / 2 <= 1000);
  // a face at the very edge is framed by moving the square in, not by cutting it
  const edge = cropPixels(cropForFace({ x: 0, y: 0, w: 120, h: 140 }, 800, 600), 800, 600);
  assert.ok(edge.cx - edge.side / 2 >= -0.001 && edge.cy - edge.side / 2 >= -0.001);
  // no face: the middle, slightly high on a portrait photo
  const c = centreCrop(600, 900);
  assert.ok(c.y < 0.5);
  assert.deepEqual(clampCrop({ x: 2, y: -1, size: 5 }, 100, 100), { x: 0.5, y: 0.5, size: 1 });
});

test('the eye line straightens a tilted face; small tilts are left alone', () => {
  assert.equal(levelAngle({ right: { x: 100, y: 100 }, left: { x: 200, y: 100.5 } }), 0);
  const a = levelAngle({ right: { x: 100, y: 100 }, left: { x: 200, y: 117.6 } });
  assert.ok(a > 9 && a < 11);
  assert.equal(levelAngle({ right: { x: 100, y: 100 }, left: { x: 150, y: 200 } }), 15, 'at most 15°');
  assert.equal(levelAngle(null), 0);
  const faces = [{ x: 0, y: 0, w: 40, h: 40 }, { x: 380, y: 280, w: 120, h: 120 }];
  assert.equal(mainFace(faces, 900, 700), faces[1]);
});

// a flat grey-ish picture with a dim, slightly blue cast
const flat = (w, h, rgb) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const v = (i % 7) * 6;
    data.set([rgb[0] + v, rgb[1] + v, rgb[2] + v, 255], i * 4);
  }
  return { data, width: w, height: h };
};

test('light and contrast lift a dark photo gently; colour balance pulls a tint towards neutral', () => {
  const dark = flat(40, 40, [40, 44, 60]);
  const before = percentiles(dark.data, [0.5])[0];
  fixLight(dark.data, 40, 40);
  const after = percentiles(dark.data, [0.5])[0];
  assert.ok(after > before + 20, `${before} → ${after}`);
  assert.ok(after < 230, 'not blown out');
  const blue = flat(20, 20, [90, 100, 150]);
  const r = fixColour(blue.data);
  assert.ok(r.gains[2] < 1 && r.gains[0] > 1, 'blue reduced, red raised');
  assert.ok(r.gains.every((g) => g >= 0.9 && g <= 1.12));
  // a strongly coloured scene (a red curtain everywhere) is left alone
  const curtain = flat(20, 20, [190, 30, 30]);
  assert.equal(fixColour(curtain.data).skipped, true);
  // a well-lit face is left almost as it is
  const fine = flat(40, 40, [110, 105, 100]);
  const mid = percentiles(fine.data, [0.5])[0];
  fixLight(fine.data, 40, 40);
  assert.ok(Math.abs(percentiles(fine.data, [0.5])[0] - mid) < 25, 'no big change to a good photo');
  // sharpening keeps the size and leaves a flat area alone
  const solid = { data: new Uint8ClampedArray(9 * 4).fill(120), width: 3, height: 3 };
  assert.deepEqual([...sharpen(solid.data, 3, 3)].filter((_, i) => i % 4 !== 3), Array(27).fill(120));
  // everything off: nothing changes
  const untouched = flat(10, 10, [10, 20, 30]);
  const copy = new Uint8ClampedArray(untouched.data);
  applyFixes(untouched, { light: false, colour: false, sharpen: false });
  assert.deepEqual(untouched.data, copy);
});

test('the stored photo size is the smallest that stays sharp on screen', () => {
  assert.equal(photoSizeFor(22, 1), 64);
  assert.equal(photoSizeFor(30, 2), 64);
  assert.equal(photoSizeFor(44, 2), 128);
  assert.equal(photoSizeFor(88, 2), 256);
  assert.equal(photoSizeFor(300, 3), 512);
});
