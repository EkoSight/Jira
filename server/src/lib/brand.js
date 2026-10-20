/**
 * The Soil Doctor brand, as the email renderer and template checks use it.
 * Source: the Soil Doctor design language and tokens v1.0 (October 2026).
 *
 * Every outgoing email is built from these values. Colours that come in from
 * elsewhere — an older design, a template uploaded from another tool, custom
 * HTML — are moved to the nearest brand colour, and fonts to the brand's, so
 * nothing off-brand can be sent.
 */

export const BRAND = {
  deepGreen: '#073F2A',
  forest: '#145A32',
  ink: '#101510',
  body: '#4C554B',
  muted: '#6B746A',
  paper: '#FFFDF7',
  sand: '#F7F3E8',
  sandHover: '#EFE9D8',
  mint: '#B8E6D2',
  aqua: '#D7F3F7',
  gold: '#D8A63A',
  wheat: '#F3E6C4',
  wheatInk: '#5E4214',
  straw: '#EFE6C8',
  sky: '#9DDCF8',
  leaf: '#AED252',
  soil: '#8B5E3B',
  deepSoil: '#593C28',
  white: '#FFFFFF',
  line: '#E7E5DD', // rgba(16,21,16,0.09) on Paper, as a solid colour mail apps understand
  lineStrong: '#D9D8D0',
  onDarkBody: '#CCD5CC', // rgba(255,253,247,0.78) on Deep Green
  onDarkLine: '#2A5845',
};

export const PALETTE = Object.values(BRAND);

/** The data-viz scale, low to high: Soil Brown → Gold → Straw → Mint → Forest. */
export const SCALE = [BRAND.soil, BRAND.gold, BRAND.straw, BRAND.mint, BRAND.forest];

export const FONTS = {
  // Manrope for everything; Noto Sans Devanagari carries Hindi
  sans: "Manrope, 'Noto Sans Devanagari', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  hindi: "'Noto Sans Devanagari', Manrope, 'Nirmala UI', Mangal, 'Segoe UI', Arial, sans-serif",
  // Source Serif 4 italic, for testimonial quotes only
  quote: "'Source Serif 4', Georgia, 'Times New Roman', serif",
  link: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Noto+Sans+Devanagari:wght@400;600;700;800&family=Source+Serif+4:ital,opsz,wght@1,8..60,400;1,8..60,500&display=swap',
};

export const BRAND_NAME = 'Soil Doctor';
export const TAGLINE = 'Turning soil data into farmer prosperity';

// the images mail apps fetch: served by TaskFlow under /m/brand
export const BRAND_FILES = ['lockup-ink.png', 'lockup-paper.png', 'mark-96.png', 'mark-192.png', 'dot.png', 'pulse.png', 'watermark.png'];

// ---------------------------------------------------------------- colour

const hex = (value) => {
  const m = String(value || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

// OKLab, so "nearest" means nearest to the eye
function oklab([r, g, b]) {
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const NEUTRALS = [BRAND.ink, BRAND.body, BRAND.muted, BRAND.paper, BRAND.sand, BRAND.sandHover, BRAND.white, BRAND.line, BRAND.lineStrong];
const ACCENTS = PALETTE.filter((c) => !NEUTRALS.includes(c) && c !== BRAND.onDarkBody && c !== BRAND.onDarkLine);
const lab = (c) => oklab(hex(c));
const chroma = ([, a, b]) => Math.sqrt(a * a + b * b);

function nearestIn(list, target) {
  let best = list[0];
  let bestD = Infinity;
  for (const c of list) {
    const [l, a, b] = lab(c);
    // hue and colourfulness count twice as much as lightness
    const d = (target[0] - l) ** 2 + 2 * ((target[1] - a) ** 2 + (target[2] - b) ** 2);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * The brand colour nearest to any colour, or `fallback` when it is not a
 * colour. Greys go to the brand's neutrals; colours to its accents.
 */
export function nearestBrandColor(value, fallback = BRAND.ink) {
  const rgb = hex(value);
  if (!rgb) return fallback;
  const target = oklab(rgb);
  return nearestIn(chroma(target) < 0.035 ? NEUTRALS : ACCENTS, target);
}

export const isBrandColor = (value) => {
  const rgb = hex(value);
  return Boolean(rgb) && PALETTE.some((c) => hex(c).every((v, i) => v === rgb[i]));
};

const NAMED = { black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00', orange: '#FFA500', gray: '#808080', grey: '#808080', navy: '#000080', purple: '#800080' };

/**
 * Moves every colour and font in a piece of HTML onto the brand. Returns
 * { html, report: { colors: [{ from, to, count }], fonts, emoji } }.
 */
export function brandifyHtml(source) {
  const changed = new Map();
  let fonts = 0;
  const note = (from, to) => {
    if (from.toLowerCase() === to.toLowerCase()) return;
    const key = `${from.toLowerCase()}→${to}`;
    changed.set(key, { from: from.toLowerCase(), to, count: (changed.get(key)?.count || 0) + 1 });
  };
  const text = String(source || '');
  // the colour the design uses most for accents is its "primary": it becomes Deep Green
  const counts = new Map();
  for (const m of text.matchAll(/(^|[^&\w/])#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const c = `#${m[2].toLowerCase()}`;
    const rgb = hex(c);
    if (rgb && chroma(oklab(rgb)) >= 0.035 && !isBrandColor(c)) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const expand = (c) => { const rgb = hex(c); return rgb ? `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}` : c; };
  const toBrand = (original) => {
    if (isBrandColor(original)) return original;
    const to = primary && expand(original.toLowerCase()) === expand(primary) ? BRAND.deepGreen : nearestBrandColor(original, null);
    if (!to) return original;
    note(original, to);
    return to;
  };
  let html = text
    // #rgb and #rrggbb (not inside a URL fragment or an entity)
    .replace(/(^|[^&\w/])#([0-9a-f]{6}|[0-9a-f]{3})\b/gi, (whole, pre, h) => `${pre}${toBrand(`#${h}`)}`)
    // rgb() and rgba(): the colour moves, its transparency stays
    .replace(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)/gi, (whole, r, g, b, a) => {
      const from = `#${[r, g, b].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}`;
      const to = toBrand(from);
      if (a === undefined || Number(a) >= 1) return to;
      const rgb = hex(to);
      return `rgba(${rgb.join(',')},${a})`;
    })
    // named colours in style values and colour attributes
    .replace(/((?:color|background(?:-color)?|border(?:-[a-z]+)?)\s*:\s*[^;"']*?)\b(black|white|red|green|blue|yellow|orange|gr[ae]y|navy|purple)\b/gi, (whole, pre, name) => `${pre}${toBrand(NAMED[name.toLowerCase()])}`)
    .replace(/\b(bgcolor|color)\s*=\s*("|')(black|white|red|green|blue|yellow|orange|gr[ae]y|navy|purple)\2/gi, (whole, attr, q, name) => `${attr}=${q}${toBrand(NAMED[name.toLowerCase()])}${q}`);
  // fonts: serif faces become the quote face, everything else Manrope
  html = html
    .replace(/font-family\s*:\s*([^;"]+)/gi, (whole, value) => {
      fonts += 1;
      return `font-family:${/serif|georgia|times|garamond|playfair|merriweather/i.test(value) && !/sans-serif/i.test(value) ? FONTS.quote.replace(/"/g, "'") : FONTS.sans.replace(/"/g, "'")}`;
    })
    .replace(/<font\b([^>]*)\bface\s*=\s*("[^"]*"|'[^']*')/gi, (whole, pre) => { fonts += 1; return `<font${pre}face="Manrope, Arial, sans-serif"`; });
  return { html, report: { colors: [...changed.values()].sort((a, b) => b.count - a.count), fonts, emoji: hasEmoji(html) } };
}

const EMOJI = /\p{Extended_Pictographic}/u;
// emoji written as HTML entities (&#x1F33E;) count too
const entities = (text) => text.replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, n) => {
  const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
});
export const hasEmoji = (text) => EMOJI.test(entities(String(text || '')).replace(/[©®™]/g, ''));
