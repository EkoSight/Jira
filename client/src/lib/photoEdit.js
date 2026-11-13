/**
 * The photo editor's arithmetic: framing a face, straightening it, and the
 * gentle fixes. Pure functions over numbers and pixel arrays, so they are
 * tested without a browser. Nothing here changes the shape of a face or
 * smooths skin.
 *
 * A crop is { x, y, size }: its centre as a fraction of the picture's width
 * and height, and its side as a fraction of the picture's shorter side.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// head and shoulders: the detected face box (brows to chin) fills about 36%
// of the frame's height, its centre a little above the middle
const FACE_SHARE = 0.36;
const FACE_CENTRE_Y = 0.43;

/** The crop for a detected face, kept inside the picture. */
export function cropForFace(face, width, height) {
  const short = Math.min(width, height);
  const side = clamp(face.h / FACE_SHARE, Math.min(64, short), short);
  const cx = face.x + face.w / 2;
  const top = face.y + face.h / 2 - FACE_CENTRE_Y * side;
  return clampCrop({ x: cx / width, y: (top + side / 2) / height, size: side / short }, width, height);
}

/** No face found: a square from the middle, slightly high (where faces usually are). */
export function centreCrop(width, height) {
  const short = Math.min(width, height);
  const side = short * 0.9;
  return clampCrop({ x: 0.5, y: height > width ? 0.42 : 0.5, size: side / short }, width, height);
}

/** Keeps a crop's square inside the picture, moving it rather than shrinking it where possible. */
export function clampCrop(crop, width, height) {
  const short = Math.min(width, height);
  const size = clamp(crop.size, 0.15, 1);
  const side = size * short;
  const cx = clamp(crop.x * width, side / 2, width - side / 2);
  const cy = clamp(crop.y * height, side / 2, height - side / 2);
  return { x: cx / width, y: cy / height, size };
}

/** The crop in pixels: centre and side. */
export function cropPixels(crop, width, height) {
  const side = crop.size * Math.min(width, height);
  return { cx: crop.x * width, cy: crop.y * height, side };
}

/**
 * How far to turn the picture so the eyes are level, in degrees. Small tilts
 * (under 1°) are left alone, and no more than 15° is corrected.
 */
export function levelAngle(eyes) {
  if (!eyes?.left || !eyes?.right) return 0;
  // the person's right eye is on the left of the picture
  const [a, b] = eyes.right.x <= eyes.left.x ? [eyes.right, eyes.left] : [eyes.left, eyes.right];
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (Math.abs(deg) < 1) return 0;
  return clamp(deg, -15, 15);
}

/** The face nearest the middle and largest, for when one has to be chosen first. */
export function mainFace(faces, width, height) {
  if (!faces.length) return null;
  const score = (f) => f.w * f.h - Math.hypot(f.x + f.w / 2 - width / 2, f.y + f.h / 2 - height / 2) * 2;
  return [...faces].sort((p, q) => score(q) - score(p))[0];
}

// ---------------------------------------------------------------- the fixes

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Luminance percentiles over all pixels (or every nth, for speed). */
export function percentiles(data, ps, step = 1) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * step) { hist[Math.round(lum(data[i], data[i + 1], data[i + 2]))] += 1; n += 1; }
  return ps.map((p) => {
    const want = p * n;
    let seen = 0;
    for (let v = 0; v < 256; v += 1) { seen += hist[v]; if (seen >= want) return v; }
    return 255;
  });
}

/** Mean luminance (0–1) of the middle of the picture, where the face is. */
export function centreBrightness(data, width, height) {
  let sum = 0;
  let n = 0;
  const x0 = Math.floor(width * 0.3);
  const x1 = Math.ceil(width * 0.7);
  const y0 = Math.floor(height * 0.25);
  const y1 = Math.ceil(height * 0.65);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      sum += lum(data[i], data[i + 1], data[i + 2]);
      n += 1;
    }
  }
  return n ? sum / n / 255 : 0.5;
}

/**
 * Light and contrast: stretch the tones a little (ignoring the darkest and
 * brightest 1%), then, only if the face is clearly too dark or too bright,
 * bring it towards the middle. A well-lit photo is left almost as it is.
 * Both steps are gentle and mixed with the original.
 */
export function fixLight(data, width, height) {
  const [lo, hi] = percentiles(data, [0.01, 0.99], 2);
  const range = Math.max(hi - lo, 1);
  const stretch = range < 230 ? 255 / range : 1;
  const mix = 0.6;
  // after the stretch, how bright is the face?
  const faceL = clamp((centreBrightness(data, width, height) * 255 - lo) * stretch / 255, 0.02, 0.98);
  // a face between 38% and 66% brightness is fine as it is
  const target = faceL < 0.38 ? 0.46 : faceL > 0.66 ? 0.6 : faceL;
  const gamma = clamp(Math.log(target) / Math.log(faceL), 0.7, 1.4);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v += 1) {
    const stretched = clamp((v - lo) * stretch, 0, 255) / 255;
    const curved = stretched ** gamma * 255;
    lut[v] = v + (curved - v) * mix;
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  return { lo, hi, gamma: Math.round(gamma * 100) / 100 };
}

/**
 * Colour balance: pull an overall tint (a blue shade, a yellow bulb) towards
 * neutral, gently. Only near-neutral pixels are measured, so a strongly
 * coloured background (a red curtain, a green field) does not shift the face;
 * with too few of them, nothing is changed.
 */
export function fixColour(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let seen = 0;
  for (let i = 0; i < data.length; i += 8) {
    seen += 1;
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    const l = lum(data[i], data[i + 1], data[i + 2]);
    if (l < 40 || l > 225 || (max - min) / max > 0.45) continue;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
  }
  if (n < seen * 0.05) return { gains: [1, 1, 1], skipped: true };
  const avg = (r + g + b) / (3 * n);
  const mix = 0.6;
  const gains = [r, g, b].map((c) => 1 + (clamp(avg / (c / n || 1), 0.9, 1.12) - 1) * mix);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(data[i] * gains[0], 0, 255);
    data[i + 1] = clamp(data[i + 1] * gains[1], 0, 255);
    data[i + 2] = clamp(data[i + 2] * gains[2], 0, 255);
  }
  return { gains: gains.map((x) => Math.round(x * 1000) / 1000) };
}

/** Light sharpening: an unsharp mask over a 3×3 neighbourhood. Returns a new array. */
export function sharpen(data, width, height, amount = 0.3) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            sum += data[(yy * width + xx) * 4 + c];
            n += 1;
          }
        }
        out[i + c] = data[i + c] + (data[i + c] - sum / n) * amount;
      }
      out[i + 3] = data[i + 3];
    }
  }
  return out;
}

export const DEFAULT_FIXES = Object.freeze({ light: true, colour: true, sharpen: true, background: false });
export const FIX_LABELS = [
  ['light', 'Light and contrast'],
  ['colour', 'Colour balance'],
  ['sharpen', 'Sharpen slightly'],
  ['background', 'Soften the background'],
];

/** Applies the chosen pixel fixes in place (the background softening is drawn separately). */
export function applyFixes(image, fixes) {
  const { data, width, height } = image;
  const report = {};
  if (fixes.colour) report.colour = fixColour(data);
  if (fixes.light) report.light = fixLight(data, width, height);
  if (fixes.sharpen) data.set(sharpen(data, width, height));
  return report;
}

/** Whether a picture is too small to look sharp as a profile photo. */
export const looksSmall = (width, height) => Math.min(width, height) < 256;

export const HEIC_HELP = 'This photo is in Apple\'s HEIC format, which this browser cannot open. On an iPhone, share it as a JPEG (or set Settings → Camera → Formats → Most Compatible), then choose it again.';
export const isHeic = (file) => /hei[cf]/i.test(file?.type || '') || /\.hei[cf]$/i.test(file?.name || '');
