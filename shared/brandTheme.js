/**
 * The organisation's colours, turned into every shade the app needs and
 * checked for readability. One file, used by the server (to refuse a colour
 * that cannot be made readable) and by the browser (to preview and apply it).
 *
 * From one colour it works out, for light and dark mode:
 *   brand          buttons and key fills
 *   on-brand       the text on them (white or near-black, whichever reads)
 *   brand-hover    a step towards the middle, for hover
 *   brand-pressed  a further step, for pressed
 *   brand-ink      the colour as text or links on the page
 *   brand-wash     a pale tint for selected rows and badges
 *   brand-border   a quiet border in the same hue
 *
 * The rules (WCAG 2.2 AA):
 *   text on a button, a link on the page, a badge on its tint, body text on a
 *   tint: at least 4.5:1;  a button against the page: at least 3:1.
 * A colour is refused when no text colour can make it readable, when it
 * barely stands out from the page, or when it could be mistaken for one of
 * the status colours (overdue, warning, done). The nearest shade of the same
 * hue that passes is offered instead.
 *
 * Shades are moved in OKLCH (perceived lightness, chroma, hue), so a darker
 * or lighter version keeps its hue.
 */

export const DEFAULT_BRANDING = Object.freeze({
  appName: 'TaskFlow',
  byline: 'by ekosight',
  primary: '#073F2A', // Soil Doctor deep green
  accent: '#8B5E3B', // Soil
});

// the grounds the app paints on, from styles.css
export const GROUNDS = Object.freeze({
  light: { surface: '#ffffff', plane: '#f4f5f7', surface2: '#f8f9fb', surface3: '#eef0f4', ink: '#0b0b0b' },
  dark: { surface: '#161b22', plane: '#0d1117', surface2: '#1c222b', surface3: '#232a35', ink: '#ffffff' },
});
const DARK_TEXT = '#0b0b0b';
const LIGHT_TEXT = '#ffffff';

// what the status colours mean; the brand must never look like one of them
export const STATUS_COLOURS = Object.freeze([
  ['#0ca30c', 'the green that means done or on track'],
  ['#fab219', 'the amber that means warning'],
  ['#ec835a', 'the orange that means serious'],
  ['#d03b3b', 'the red that means overdue or critical'],
]);

/** The accents a person may choose for themselves; each passes every check (tested). */
export const ACCENT_PRESETS = Object.freeze([
  { key: 'forest', label: 'Forest', hex: '#145A32' },
  { key: 'soil', label: 'Soil', hex: '#8B5E3B' },
  { key: 'deep-soil', label: 'Deep soil', hex: '#593C28' },
  { key: 'ocean', label: 'Ocean', hex: '#1F5E8C' },
  { key: 'plum', label: 'Plum', hex: '#6B3A7D' },
  { key: 'slate', label: 'Slate', hex: '#3D4B5C' },
]);

export const MIN_TEXT = 4.5;
export const MIN_UI = 3;
const MIN_STATUS_DISTANCE = 0.09; // OKLab distance; below this two colours read as the same family

// ---------------------------------------------------------------- colour maths

export function normaliseHex(value) {
  const m = String(value ?? '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${h.toUpperCase()}`;
}

const toRgb = (hex) => {
  const h = normaliseHex(hex).slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function luminance(hex) {
  const [r, g, b] = toRgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const round2 = (n) => Math.floor(n * 100) / 100;

function toOklab(hex) {
  const [r, g, b] = toRgb(hex).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function toOklch(hex) {
  const [L, a, b] = toOklab(hex);
  return { l: L, c: Math.hypot(a, b), h: Math.atan2(b, a) };
}

/** A colour from OKLCH, with chroma reduced until it fits the screen's colours. */
export function fromOklch({ l, c, h }) {
  const L = Math.min(1, Math.max(0, l));
  const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let lo = 0;
  let hi = c;
  let best = oklabToLinear([L, 0, 0]);
  if (inGamut(oklabToLinear([L, c * Math.cos(h), c * Math.sin(h)]))) best = oklabToLinear([L, c * Math.cos(h), c * Math.sin(h)]);
  else {
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      const rgb = oklabToLinear([L, mid * Math.cos(h), mid * Math.sin(h)]);
      if (inGamut(rgb)) { lo = mid; best = rgb; } else hi = mid;
    }
  }
  return toHex(best.map((v) => gam(Math.min(1, Math.max(0, v)))));
}

/** How far apart two colours look (OKLab distance; 0.02 is about the smallest visible step). */
export function distance(a, b) {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const withL = (hex, l) => { const o = toOklch(hex); return fromOklch({ ...o, l }); };
const capChroma = (hex, l, cap) => { const o = toOklch(hex); return fromOklch({ l, c: Math.min(o.c, cap), h: o.h }); };

/** Moves a colour's lightness in steps until test() passes; null if it never does. */
function stepUntil(hex, direction, test, { step = 0.004, limit = 1 } = {}) {
  const start = toOklch(hex);
  for (let l = start.l; l >= 0 && l <= 1; l += direction * step) {
    const candidate = fromOklch({ ...start, l });
    if (test(candidate)) return candidate;
    if (Math.abs(l - start.l) > limit) break;
  }
  return null;
}

/** White or near-black, whichever reads on this colour; white wins a tie above 4.5. */
export function textOn(hex) {
  const white = contrast(LIGHT_TEXT, hex);
  const dark = contrast(DARK_TEXT, hex);
  if (white >= MIN_TEXT) return { text: LIGHT_TEXT, ratio: white };
  if (dark >= MIN_TEXT) return { text: DARK_TEXT, ratio: dark };
  return white >= dark ? { text: LIGHT_TEXT, ratio: white } : { text: DARK_TEXT, ratio: dark };
}

// ---------------------------------------------------------------- the shades

/** A colour's shades for one mode, each checked. Problems name what fails. */
function shades(hex, mode) {
  const g = GROUNDS[mode];
  const grounds = [g.surface, g.plane, g.surface2, g.surface3];
  const problems = [];
  let fill = hex;
  if (mode === 'dark') {
    // a button must stand out from the dark page: lighten until it does
    if (contrast(fill, g.surface) < MIN_UI) fill = stepUntil(fill, +1, (c) => contrast(c, g.surface) >= MIN_UI && textOn(c).ratio >= MIN_TEXT) || fill;
    if (textOn(fill).ratio < MIN_TEXT) fill = stepUntil(fill, +1, (c) => textOn(c).ratio >= MIN_TEXT) || fill;
  }
  const on = textOn(fill);
  if (on.ratio < MIN_TEXT) problems.push({ code: 'TEXT_ON_FILL', ratio: round2(on.ratio), message: `Neither white nor black text is easy to read on it (best ${round2(on.ratio)}:1; needs ${MIN_TEXT}:1).` });
  if (contrast(fill, g.surface) < MIN_UI) problems.push({ code: 'FILL_ON_PAGE', ratio: round2(contrast(fill, g.surface)), message: `Buttons in it would barely stand out from the ${mode === 'dark' ? 'dark' : 'white'} page (${round2(contrast(fill, g.surface))}:1; needs ${MIN_UI}:1).` });

  // hover and pressed: towards the middle, keeping the text readable
  const towards = luminance(on.text) > 0.5 ? -1 : +1; // white text: go darker; dark text: go lighter
  const nudge = (amount) => {
    const o = toOklch(fill);
    const moved = fromOklch({ ...o, l: o.l + towards * amount * (mode === 'dark' ? -1 : 1) });
    return contrast(on.text, moved) >= MIN_TEXT ? moved : fromOklch({ ...o, l: o.l - towards * amount * (mode === 'dark' ? -1 : 1) });
  };
  const hover = nudge(0.05);
  const pressed = nudge(0.09);

  // tint for selected rows and badges
  const o = toOklch(hex);
  const wash = mode === 'light' ? capChroma(hex, 0.955, 0.035) : capChroma(hex, 0.3, 0.05);
  const border = mode === 'light' ? capChroma(hex, 0.82, 0.08) : capChroma(hex, 0.46, 0.08);

  // the colour as text: darker on light pages, lighter on dark ones, until it reads on every ground and its tint
  const readsEverywhere = (c) => [...grounds, wash].every((ground) => contrast(c, ground) >= MIN_TEXT);
  const ink = readsEverywhere(hex) ? normaliseHex(hex) : (stepUntil(hex, mode === 'light' ? -1 : +1, readsEverywhere) || (mode === 'light' ? '#000000' : '#FFFFFF'));
  if (contrast(g.ink, wash) < MIN_TEXT) problems.push({ code: 'TEXT_ON_WASH', message: 'Text on its pale tint would be hard to read.' });

  return {
    vars: { fill: normaliseHex(fill), on: on.text, hover, pressed, ink, wash, border },
    ratios: { textOnFill: round2(on.ratio), fillOnPage: round2(contrast(fill, g.surface)), inkOnPage: round2(Math.min(...grounds.map((x) => contrast(ink, x)))), inkOnWash: round2(contrast(ink, wash)), textOnWash: round2(contrast(g.ink, wash)) },
    problems,
    lightness: o.l,
  };
}

/** The nearest shade of the same hue that passes everything, or null. */
export function nearestPassing(hex) {
  const clean = normaliseHex(hex);
  if (!clean) return null;
  const passes = (c) => colourProblems(c).length === 0;
  if (passes(clean)) return clean;
  const darker = stepUntil(clean, -1, passes, { step: 0.003 });
  const lighter = stepUntil(clean, +1, passes, { step: 0.003 });
  if (darker && lighter) return distance(darker, clean) <= distance(lighter, clean) ? darker : lighter;
  return darker || lighter;
}

/** What is wrong with a colour as the brand (or accent) colour; empty when it passes. */
export function colourProblems(hex) {
  const clean = normaliseHex(hex);
  if (!clean) return [{ code: 'NOT_A_COLOUR', message: 'Choose a colour (for example #073F2A).' }];
  const problems = [...shades(clean, 'light').problems, ...shades(clean, 'dark').problems.map((p) => ({ ...p, message: `In dark mode: ${p.message}` }))];
  for (const [status, meaning] of STATUS_COLOURS) {
    if (distance(clean, status) < MIN_STATUS_DISTANCE) {
      problems.push({ code: 'LOOKS_LIKE_STATUS', message: `It is close to ${meaning}; people could mistake one for the other.` });
    }
  }
  return problems;
}

/**
 * The check behind Settings → Branding: each colour's problems, the nearest
 * passing shade for any that fail, and the palette that would be applied.
 */
export function checkBranding({ primary, accent }) {
  const result = { ok: true, primary: null, accent: null };
  for (const [key, value] of [['primary', primary], ['accent', accent]]) {
    const problems = colourProblems(value);
    result[key] = { value: normaliseHex(value), problems, suggestion: problems.length ? nearestPassing(value) : null };
    if (problems.length) result.ok = false;
  }
  if (result.ok) result.palette = buildPalette(primary, accent);
  return result;
}

/** The CSS variables for both modes. */
export function buildPalette(primary, accent) {
  const out = {};
  for (const mode of ['light', 'dark']) {
    const p = shades(normaliseHex(primary), mode);
    const a = shades(normaliseHex(accent), mode);
    out[mode] = {
      '--brand': p.vars.fill,
      '--on-brand': p.vars.on,
      '--brand-hover': p.vars.hover,
      '--brand-pressed': p.vars.pressed,
      '--brand-ink': p.vars.ink,
      '--brand-wash': p.vars.wash,
      '--brand-border': p.vars.border,
      '--accent': a.vars.fill,
      '--on-accent': a.vars.on,
      '--accent-ink': a.vars.ink,
      '--accent-wash': a.vars.wash,
      '--series-1': p.vars.fill,
      '--series-2': a.vars.fill,
    };
    out[`${mode}Ratios`] = { primary: p.ratios, accent: a.ratios };
  }
  return out;
}

/** The palette as a style sheet, for the browser. */
export function themeCss(palette) {
  const block = (vars) => Object.entries(vars).map(([k, v]) => `${k}:${v};`).join('');
  return `:root{${block(palette.light)}}:root[data-theme='dark']{${block(palette.dark)}}`;
}

/** A person's accent preset, or null for the organisation's. */
export const accentPreset = (key) => ACCENT_PRESETS.find((p) => p.key === key) || null;
