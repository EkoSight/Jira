/**
 * Email designs → email-safe HTML and plain text, as pure functions, always
 * in the Soil Doctor brand.
 *
 * A design is { settings, blocks }. Every block's words can be given in
 * English and Hindi ({ en, hi }); each person gets their own language, or
 * English where only English was written. A block can carry a condition, so it
 * is shown only to some people (dynamic content).
 *
 * The brand is not optional: the frame (logo header, Paper card on a Sand or
 * Paper ground, footer), the type (Manrope; Source Serif 4 italic for quotes),
 * the pill buttons and rounded cards come from lib/brand.js, and any colour in
 * a design or in custom HTML is moved to the nearest brand colour. Older
 * designs are drawn the same way, so everything that goes out is on-brand.
 *
 * Nothing a contact typed can change the email's structure: text is escaped
 * first, formatting is applied to the template, and merge values go in last,
 * escaped for where they land (HTML or a link). Links are http(s), mailto or
 * tel only. The footer — who it is from, why they get it, how to stop — is
 * always added and cannot be removed.
 */

import { BRAND, FONTS, SCALE, TAGLINE, brandifyHtml, hasEmoji } from './brand.js';

export const BLOCK_TYPES = [
  'hero', 'heading', 'text', 'button', 'image', 'cards', 'stats', 'data', 'steps', 'details', 'quote', 'panel',
  'columns', 'pulse', 'divider', 'spacer', 'social', 'html',
];

export const MERGE_TAGS = [
  'first_name', 'last_name', 'full_name', 'email', 'organization', 'designation', 'city', 'state', 'country',
  'festival', 'campaign', 'today', 'year', 'unsubscribe_url', 'preferences_url',
];

const SOCIAL = {
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube', x: 'X', whatsapp: 'WhatsApp', website: 'Website',
};

/** The only choices a design makes about the frame: the header style and the ground. */
export const DEFAULT_SETTINGS = { header: 'light', ground: 'sand' };
export const HEADER_STYLES = ['light', 'dark', 'minimal'];
export const GROUNDS = ['sand', 'paper'];
export const BUTTON_STYLES = ['primary', 'secondary', 'gold', 'link'];
export const TONES = ['paper', 'sand', 'dark'];
export const TAG_TONES = ['good', 'info', 'warn'];

const DEFAULT_BRAND = {
  base: 'https://taskflow.ekosight.com/api/taskflow/m/brand',
  website: 'https://soildoctor.in',
  tagline: TAGLINE,
};

// ---------------------------------------------------------------- small helpers

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The words of a field in one language: { en, hi } or a plain string. */
export function pick(value, lang = 'en') {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value[lang] || value.en || value.hi || '';
  return String(value);
}

/** Whether a URL is one we are willing to put in an email. Merge tags may sit inside it. */
export function safeUrl(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  if (/^\{\{\s*(unsubscribe_url|preferences_url)\s*\}\}$/.test(value)) return value;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(value) && !/[\s<>"]/.test(value.replace(/\{\{[^}]*\}\}/g, ''))) return value;
  return null;
}

const MERGE = /\{\{\s*([a-z_]+(?:\.[a-z0-9_]+)?)\s*(?:\|([^}]*))?\}\}/gi;

/** The value of one merge tag for this person, or undefined when it has none. */
export function mergeValue(name, data = {}) {
  const key = String(name).toLowerCase();
  if (key.startsWith('custom.')) {
    const v = data.custom?.[key.slice(7)];
    return v === null || v === undefined || v === '' ? undefined : String(v);
  }
  if (key === 'full_name') {
    const full = [data.first_name, data.last_name].filter(Boolean).join(' ');
    return full || undefined;
  }
  if (key === 'today') return data.today;
  if (key === 'year') return data.year;
  const v = data[key];
  return v === null || v === undefined || v === '' ? undefined : String(v);
}

/** Replaces merge tags, encoding each value for where it goes. */
export function applyMerge(text, data, { mode = 'html' } = {}) {
  return String(text ?? '').replace(MERGE, (whole, name, fallback) => {
    const value = mergeValue(name, data);
    if (value === undefined) {
      // a fallback was written by staff and is already in the template's form
      return fallback !== undefined ? fallback.trim() : '';
    }
    if (mode === 'url') return /_url$/.test(name) ? value : encodeURIComponent(value);
    if (mode === 'text') return value;
    return escapeHtml(value);
  });
}

/** Merge tags used in a string, for checking a design before it is sent. */
export function mergeTagsIn(text) {
  return [...String(text ?? '').matchAll(MERGE)].map((m) => m[1].toLowerCase());
}

// ---------------------------------------------------------------- text formatting

/**
 * A small, safe formatting language for text: **bold**, *italic*,
 * [label](https://link), "- " list lines, blank line between paragraphs.
 * Returns HTML; `href` is called for every link so it can be tracked.
 */
export function formatText(source, { href = (u) => u, data = {}, linkColor = BRAND.deepGreen, strong = BRAND.ink, gap = 14 } = {}) {
  const escaped = escapeHtml(source);
  const inline = (line) => line
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
      const safe = safeUrl(url.replace(/&amp;/g, '&'));
      if (!safe) return label;
      const target = href(safe);
      return `<a href="${escapeHtml(applyMerge(target, data, { mode: 'url' }))}" style="color:${linkColor};font-weight:700;text-decoration:underline">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, `<strong style="color:${strong};font-weight:800">$1</strong>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

  const paragraphs = escaped.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const html = paragraphs.map((p) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
      const items = lines.map((l) => `<li style="margin:0 0 6px">${inline(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('');
      return `<ul style="margin:0 0 ${gap}px;padding-left:22px">${items}</ul>`;
    }
    return `<p style="margin:0 0 ${gap}px">${lines.map(inline).join('<br>')}</p>`;
  }).join('');
  return applyMerge(html, data);
}

/** The same text as plain text, links written out. */
export function plainText(source, { href = (u) => u, data = {} } = {}) {
  const withLinks = String(source ?? '').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const safe = safeUrl(url);
    return safe ? `${label} (${applyMerge(href(safe), data, { mode: 'url' })})` : label;
  });
  return applyMerge(withLinks.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2'), data, { mode: 'text' });
}

// ---------------------------------------------------------------- dynamic content

/**
 * Whether a block is shown to this person.
 *   { type: 'language', value: 'hi' }
 *   { type: 'tag', op: 'has' | 'not_has', value: 'dealer' }
 *   { type: 'audience', op: 'is' | 'is_not', value: <audience id> }
 *   { type: 'field', key: 'district', op: 'is' | 'is_not' | 'contains' | 'empty' | 'not_empty', value }
 *   { type: 'crm', value: 'LEAD' | 'CUSTOMER' | 'PARTNER' | 'NONE' }
 */
export function showBlock(condition, person = {}) {
  if (!condition || !condition.type) return true;
  const value = String(condition.value ?? '').toLowerCase();
  const op = condition.op || 'is';
  switch (condition.type) {
    case 'language': return (person.language || 'en') === condition.value;
    case 'tag': {
      const has = (person.tags || []).map((t) => String(t).toLowerCase()).includes(value);
      return op === 'not_has' ? !has : has;
    }
    case 'audience': {
      const member = (person.audience_ids || []).map(Number).includes(Number(condition.value));
      return op === 'is_not' ? !member : member;
    }
    case 'crm': {
      const type = person.account_type || 'NONE';
      return op === 'is_not' ? type !== condition.value : type === condition.value;
    }
    case 'field': {
      const raw = condition.key?.startsWith('custom.') ? person.custom?.[condition.key.slice(7)] : person[condition.key];
      const text = raw === null || raw === undefined ? '' : String(raw).toLowerCase();
      if (op === 'empty') return text === '';
      if (op === 'not_empty') return text !== '';
      if (op === 'contains') return text.includes(value);
      if (op === 'is_not') return text !== value;
      return text === value;
    }
    default: return true;
  }
}

// ---------------------------------------------------------------- links in a design

const LINK_KEYS = new Set(['href', 'url', 'button_href']);
const TEXT_KEYS = new Set(['text', 'title', 'lead', 'eyebrow', 'note', 'quote', 'caption', 'value', 'label', 'link_text', 'button_text', 'role', 'name']);

/** Every link a design can send, in either language — for tracking and checks. */
export function designLinks(design) {
  const found = new Set();
  const fromText = (value) => {
    for (const lang of ['en', 'hi']) {
      for (const m of pick(value, lang).matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
        const safe = safeUrl(m[1]);
        if (safe) found.add(safe);
      }
    }
  };
  const visit = (node, key = '') => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n)); return; }
    if (typeof node === 'string') {
      if (LINK_KEYS.has(key) && safeUrl(node)) found.add(safeUrl(node));
      else if (TEXT_KEYS.has(key)) fromText(node);
      return;
    }
    if (typeof node !== 'object') return;
    if (key === 'html') {
      for (const lang of ['en', 'hi']) for (const m of pick(node, lang).matchAll(/href="([^"]+)"/g)) if (safeUrl(m[1])) found.add(safeUrl(m[1]));
      return;
    }
    if (TEXT_KEYS.has(key) && ('en' in node || 'hi' in node)) { fromText(node); return; }
    if (key === 'condition') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'html' && typeof v === 'string') { for (const m of v.matchAll(/href="([^"]+)"/g)) if (safeUrl(m[1])) found.add(safeUrl(m[1])); continue; }
      visit(v, k);
    }
  };
  (design?.blocks || []).forEach((b) => visit(b));
  return [...found].filter((u) => !/^\{\{/.test(u) && !/^(mailto|tel):/i.test(u));
}

// ---------------------------------------------------------------- staff-written HTML

const ACTIVE_TAGS = 'script|style|iframe|frame|frameset|object|embed|form|input|button|textarea|select|base|meta|link|svg|math';

/**
 * Staff-written HTML without anything that runs: scripts, frames, forms,
 * event handlers and javascript: links. Mail apps drop these anyway; the
 * preview inside TaskFlow must never run them.
 */
export function stripActiveHtml(value) {
  let out = String(value || '');
  // repeated until nothing changes, so a tag split around another (<scr<script>ipt>) cannot survive
  for (let i = 0; i < 10; i += 1) {
    const before = out;
    out = out
      .replace(new RegExp(`<\\s*(${ACTIVE_TAGS})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, 'gi'), '')
      .replace(new RegExp(`<\\s*\\/?\\s*(${ACTIVE_TAGS})\\b[^>]*>`, 'gi'), '')
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|src|action|formaction)\s*=\s*("|')?\s*(javascript|vbscript|data):[^"'\s>]*\2?/gi, '$1="#"');
    if (out === before) break;
  }
  return out;
}

// ---------------------------------------------------------------- rendering

const FOOTER_WORDS = {
  en: { why: 'You are receiving this because', unsubscribe: 'Unsubscribe', preferences: 'Update your preferences' },
  hi: { why: 'आपको यह ईमेल इसलिए मिला क्योंकि', unsubscribe: 'सदस्यता समाप्त करें', preferences: 'अपनी पसंद बदलें' },
};

const LEVEL_WORDS = {
  en: ['Very low', 'Low', 'Medium', 'Adequate', 'High'],
  hi: ['बहुत कम', 'कम', 'मध्यम', 'पर्याप्त', 'अधिक'],
};
const LEVEL_TONE = ['warn', 'warn', 'info', 'good', 'good'];
const TAG_COLORS = {
  good: [BRAND.mint, BRAND.deepGreen],
  info: [BRAND.aqua, BRAND.deepGreen],
  warn: [BRAND.wheat, BRAND.wheatInk],
};

/**
 * Renders a design for one person.
 *
 *   person      the contact's fields, tags, custom values, audience_ids, account_type
 *   lang        'en' | 'hi'
 *   data        extra merge values (festival, campaign, today, year, unsubscribe_url, preferences_url)
 *   track       { openPixel: url | null, href: (url) => tracked url }
 *   footer      { company, address, reason }
 *   preheader   preview text shown by inboxes
 *   brand       { base: where the brand images are served, website, tagline }
 */
export function renderEmail(design, {
  person = {}, lang = 'en', data = {}, track = {}, footer = {}, preheader = '', subject = '', brand: brandOptions = {},
} = {}) {
  const brand = { ...DEFAULT_BRAND, ...brandOptions };
  const s = { ...DEFAULT_SETTINGS, ...(design?.settings || {}) };
  const headerStyle = HEADER_STYLES.includes(s.header) ? s.header : 'light';
  const ground = s.ground === 'paper' ? BRAND.paper : BRAND.sand;
  const hi = lang === 'hi';
  const font = hi ? FONTS.hindi : FONTS.sans;
  // Devanagari is never tracked tight or set in capitals
  const tight = (em) => (hi ? '0' : `${em}em`);
  const merged = { ...person, ...data };
  const href = (url) => (track.href ? track.href(url) : url);
  const linkAttr = (url) => escapeHtml(applyMerge(href(url), merged, { mode: 'url' }));
  const words = FOOTER_WORDS[lang] || FOOTER_WORDS.en;
  const img = (file) => `${brand.base}/${file}`;
  const t = (value) => applyMerge(escapeHtml(pick(value, lang)), merged);
  const rich = (value, opts = {}) => formatText(pick(value, lang), { href, data: merged, ...opts });
  const plain = (value) => plainText(pick(value, lang), { href, data: merged });

  const html = [];
  const textOut = [];
  const row = (inner, { top = 0, bottom = 18, side = 36, cls = 'tf-pad' } = {}) => `<tr><td class="${cls}" style="padding:${top}px ${side}px ${bottom}px ${side}px">${inner}</td></tr>`;

  const eyebrow = (value, { dark = false, center = false } = {}) => {
    const words_ = pick(value, lang);
    if (!words_) return '';
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 ${center ? 'auto' : '0'} 12px"><tr>
<td style="padding-right:8px;vertical-align:middle"><img src="${img('dot.png')}" width="14" height="14" alt="" style="display:block;border:0"></td>
<td style="vertical-align:middle;font-family:${font};font-size:12px;line-height:1.2;font-weight:800;letter-spacing:${hi ? '0' : '0.1em'};${hi ? '' : 'text-transform:uppercase;'}color:${dark ? BRAND.mint : BRAND.forest}">${t(value)}</td></tr></table>`;
  };

  /** A pill button that Outlook draws too. */
  const button = (b, { dark = false, align = 'left' } = {}) => {
    if (!b) return '';
    const label = pick(b.text, lang);
    const target = safeUrl(b.href);
    if (!label || !target) return '';
    const style = BUTTON_STYLES.includes(b.style) ? b.style : dark ? 'gold' : 'primary';
    const words_ = t(b.text);
    if (style === 'link') {
      const arrow = /→\s*$/.test(label) ? '' : ' →';
      return `<a href="${linkAttr(target)}" style="font-family:${font};font-size:15px;font-weight:700;color:${dark ? BRAND.mint : BRAND.deepGreen};text-decoration:none">${words_}${arrow}</a>`;
    }
    const [bg, fg, border] = {
      primary: [BRAND.deepGreen, BRAND.paper, BRAND.deepGreen],
      secondary: [dark ? BRAND.deepGreen : BRAND.paper, dark ? BRAND.paper : BRAND.ink, dark ? BRAND.onDarkLine : BRAND.lineStrong],
      gold: [BRAND.gold, BRAND.ink, BRAND.gold],
    }[style];
    const width = Math.min(520, Math.max(150, Math.round(label.length * 9.2 + 56)));
    return `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${linkAttr(target)}" style="height:48px;v-text-anchor:middle;width:${width}px" arcsize="50%" strokecolor="${border}" fillcolor="${bg}"><w:anchorlock/><center style="color:${fg};font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${words_}</center></v:roundrect><![endif]--><!--[if !mso]><!--><a href="${linkAttr(target)}" style="display:inline-block;background:${bg};color:${fg};border:1px solid ${border};border-radius:999px;padding:15px 26px;font-family:${font};font-size:15px;line-height:1;font-weight:700;text-decoration:none;mso-hide:all;text-align:${align === 'center' ? 'center' : 'left'}">${words_}</a><!--<![endif]-->`;
  };
  const buttons = (list, opts) => {
    const parts = list.map((b) => button(b, opts)).filter(Boolean);
    if (!parts.length) return '';
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${opts.align === 'center' ? '0 auto' : '0'}"><tr>${parts.map((p, i) => `<td style="padding:${i ? '0 0 0 10px' : '0'};vertical-align:middle">${p}</td>`).join('')}</tr></table>`;
  };
  const buttonText = (b) => (b && pick(b.text, lang) && safeUrl(b.href) ? `${plain(b.text)}: ${applyMerge(href(safeUrl(b.href)), merged, { mode: 'url' })}` : '');

  const tag = (words_, tone = 'good') => {
    if (!words_) return '';
    const [bg, fg] = TAG_COLORS[tone] || TAG_COLORS.good;
    return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:4px 11px;font-family:${font};font-size:12px;line-height:1.3;font-weight:800">${applyMerge(escapeHtml(words_), merged)}</span>`;
  };

  const heading = (value, { size = 30, color = BRAND.ink, highlight = null, highlightColor = BRAND.deepGreen, center = false, level = 1 } = {}) => {
    let inner = t(value);
    const phrase = pick(highlight, lang);
    if (phrase && inner.includes(escapeHtml(phrase))) {
      inner = inner.replace(escapeHtml(phrase), `<span style="color:${highlightColor}">${escapeHtml(phrase)}</span>`);
    }
    const tagName = level === 1 ? 'h1' : 'h2';
    return `<${tagName} class="tf-h${size >= 34 ? 'x' : level}" style="margin:0 0 14px;font-family:${font};font-size:${size}px;line-height:${hi ? 1.35 : size >= 30 ? 1.06 : 1.2};font-weight:800;letter-spacing:${tight(size >= 30 ? -0.035 : -0.02)};color:${color};text-align:${center ? 'center' : 'left'}">${inner}</${tagName}>`;
  };

  const bodyStyle = (dark, size = 16) => `font-family:${font};font-size:${size}px;line-height:1.6;color:${dark ? BRAND.onDarkBody : BRAND.body}`;
  const toneBg = (tone) => (tone === 'dark' ? BRAND.deepGreen : tone === 'sand' ? BRAND.sand : BRAND.paper);

  const renderBlock = (block) => {
    if (!block || !BLOCK_TYPES.includes(block.type) || !showBlock(block.condition, person)) return;
    const align = ['left', 'center', 'right'].includes(block.align) ? block.align : 'left';
    const center = align === 'center';
    switch (block.type) {
      case 'hero': {
        const tone = TONES.includes(block.tone) ? block.tone : 'sand';
        const dark = tone === 'dark';
        const inner = [
          eyebrow(block.eyebrow, { dark, center }),
          heading(block.title, { size: 38, color: dark ? BRAND.paper : BRAND.ink, highlight: block.highlight, highlightColor: dark ? BRAND.mint : BRAND.deepGreen, center }),
          pick(block.text, lang) ? `<div style="${bodyStyle(dark, 18)};text-align:${align}">${rich(block.text, { strong: dark ? BRAND.paper : BRAND.ink, linkColor: dark ? BRAND.mint : BRAND.deepGreen })}</div>` : '',
          buttons([block.button, block.button2], { dark, align }),
          /^https?:\/\//i.test(block.image?.src || '') ? `<div style="padding-top:26px"><img src="${escapeHtml(block.image.src)}" alt="${escapeHtml(pick(block.image.alt, lang))}" width="568" style="display:block;width:100%;max-width:568px;height:auto;border:0;border-radius:18px"></div>` : '',
        ].join('');
        const bg = dark ? `background:${BRAND.deepGreen} url('${img('watermark.png')}') no-repeat right bottom;background-size:280px auto` : `background:${toneBg(tone)}`;
        html.push(`<tr><td class="tf-hero" style="${bg};padding:44px 36px 40px;text-align:${align}">${inner}</td></tr>`);
        textOut.push(...[pick(block.eyebrow, lang), plain(block.title).toUpperCase(), plain(block.text), buttonText(block.button), buttonText(block.button2)].filter(Boolean), '');
        html.push('<tr><td style="height:22px;line-height:22px;font-size:1px">&nbsp;</td></tr>');
        return;
      }
      case 'heading': {
        if (!pick(block.text, lang)) return;
        html.push(row(`${eyebrow(block.eyebrow, { center })}${heading(block.text, { size: block.level === 2 ? 22 : 30, level: block.level === 2 ? 2 : 1, center, highlight: block.highlight })}`, { top: 8, bottom: 4 }));
        textOut.push(plain(block.text).toUpperCase(), '');
        return;
      }
      case 'text': {
        if (!pick(block.text, lang)) return;
        html.push(row(`<div style="${bodyStyle(false)};text-align:${align}">${rich(block.text)}</div>`, { bottom: 4 }));
        textOut.push(plain(block.text), '');
        return;
      }
      case 'button': {
        const b = button(block, { align });
        if (!b) return;
        html.push(row(`<div style="text-align:${align}">${b}</div>`, { top: 4, bottom: 22 }));
        textOut.push(buttonText(block), '');
        return;
      }
      case 'image': {
        const src = /^https?:\/\//i.test(block.src || '') ? block.src : null;
        if (!src) return;
        const alt = escapeHtml(pick(block.alt, lang));
        const picture = `<img src="${escapeHtml(src)}" alt="${alt}" width="568" style="display:block;width:100%;max-width:568px;height:auto;border:0;border-radius:18px;margin:0 auto">`;
        const target = safeUrl(block.href);
        const caption = pick(block.caption, lang) ? `<div style="font-family:${font};font-size:13px;line-height:1.5;color:${BRAND.muted};padding-top:8px;text-align:${align}">${t(block.caption)}</div>` : '';
        html.push(row(`${target ? `<a href="${linkAttr(target)}">${picture}</a>` : picture}${caption}`, { bottom: 20 }));
        if (alt) textOut.push(`[${pick(block.alt, lang)}]`, '');
        return;
      }
      case 'cards':
      case 'columns': {
        // "columns" is the older two-column block; it is drawn as cards
        const items = block.type === 'columns'
          ? (block.columns || []).slice(0, 2).map((c) => ({ title: c.title, text: c.text, image: c.image ? { src: c.image, alt: c.alt } : null, link_text: c.button_text, href: c.button_href }))
          : (block.items || []).slice(0, 6);
        const visible = items.filter((c) => pick(c.title, lang) || pick(c.text, lang));
        if (!visible.length) return;
        const bg = block.type === 'cards' && block.tone === 'sand' ? BRAND.sand : BRAND.paper;
        const card = (c) => {
          const parts = [];
          if (/^https?:\/\//i.test(c.image?.src || '')) parts.push(`<img src="${escapeHtml(c.image.src)}" alt="${escapeHtml(pick(c.image.alt, lang))}" width="252" style="display:block;width:100%;height:auto;border:0;border-radius:18px;margin-bottom:14px">`);
          const inner = [];
          if (pick(c.tag, lang)) inner.push(`<div style="padding-bottom:10px">${tag(pick(c.tag, lang), TAG_TONES.includes(c.tag_tone) ? c.tag_tone : 'good')}</div>`);
          if (pick(c.title, lang)) inner.push(`<div style="font-family:${font};font-size:20px;line-height:1.25;font-weight:800;letter-spacing:${tight(-0.02)};color:${BRAND.ink};padding-bottom:8px">${t(c.title)}</div>`);
          if (pick(c.text, lang)) inner.push(`<div style="${bodyStyle(false, 15)}">${rich(c.text, { gap: 10 })}</div>`);
          const link = safeUrl(c.href);
          if (link && pick(c.link_text, lang)) inner.push(`<a href="${linkAttr(link)}" style="font-family:${font};font-size:15px;font-weight:700;color:${BRAND.deepGreen};text-decoration:none">${t(c.link_text)}${/→\s*$/.test(pick(c.link_text, lang)) ? '' : ' →'}</a>`);
          textOut.push([pick(c.tag, lang), plain(c.title), plain(c.text), link && pick(c.link_text, lang) ? `${plain(c.link_text)}: ${applyMerge(href(link), merged, { mode: 'url' })}` : ''].filter(Boolean).join('\n'), '');
          return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border:1px solid ${BRAND.line};border-radius:24px"><tr><td style="padding:12px">${parts.join('')}<div style="padding:${parts.length ? '0 8px 10px' : '14px 10px 12px'}">${inner.join('')}</div></td></tr></table>`;
        };
        const perRow = block.layout === 'stack' || visible.length === 1 ? 1 : 2;
        const rows = [];
        for (let i = 0; i < visible.length; i += perRow) {
          const cells = visible.slice(i, i + perRow);
          rows.push(`<tr>${cells.map((c, j) => `<td class="tf-col" width="${perRow === 2 ? '50%' : '100%'}" valign="top" style="padding:0 ${perRow === 2 && j === 0 ? '7px' : '0'} 14px ${perRow === 2 && j === 1 ? '7px' : '0'}">${card(c)}</td>`).join('')}${perRow === 2 && cells.length === 1 ? '<td class="tf-col" width="50%">&nbsp;</td>' : ''}</tr>`);
        }
        html.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>`, { side: 22, bottom: 8 }));
        return;
      }
      case 'stats': {
        const items = (block.items || []).filter((i) => pick(i.value, lang)).slice(0, 4);
        if (!items.length) return;
        const cells = items.map((i) => `<td class="tf-col" width="${items.length === 1 ? '100%' : '50%'}" valign="top" style="padding:0 0 18px"><div style="font-family:${font};font-size:30px;line-height:1.1;font-weight:800;letter-spacing:${tight(-0.03)};color:${BRAND.gold};font-variant-numeric:tabular-nums">${t(i.value)}</div><div style="font-family:${font};font-size:12.5px;line-height:1.4;font-weight:600;color:${BRAND.mint};padding-top:4px">${t(i.label)}</div></td>`);
        const grid = [];
        for (let i = 0; i < cells.length; i += 2) grid.push(`<tr>${cells.slice(i, i + 2).join('')}${i + 1 >= cells.length && cells.length > 1 ? '<td class="tf-col" width="50%">&nbsp;</td>' : ''}</tr>`);
        const inner = [
          eyebrow(block.eyebrow, { dark: true }),
          pick(block.title, lang) ? heading(block.title, { size: 22, level: 2, color: BRAND.paper }) : '',
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px">${grid.join('')}</table>`,
          pick(block.note, lang) ? `<div style="${bodyStyle(true, 13)}">${t(block.note)}</div>` : '',
        ].join('');
        html.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.deepGreen};border-radius:24px"><tr><td style="padding:28px 28px 12px">${inner}</td></tr></table>`, { side: 22, bottom: 22 }));
        textOut.push(...[pick(block.eyebrow, lang), plain(block.title)].filter(Boolean), ...items.map((i) => `${plain(i.value)} — ${plain(i.label)}`), '');
        return;
      }
      case 'data': {
        const rows = (block.rows || []).filter((r) => pick(r.label, lang)).slice(0, 12);
        if (!rows.length) return;
        const levelWords = LEVEL_WORDS[lang] || LEVEL_WORDS.en;
        const lines = rows.map((r) => {
          const level = Math.min(5, Math.max(1, Math.round(Number(r.level) || 3)));
          const width = level * 20;
          const status = pick(r.status, lang) || levelWords[level - 1];
          return `<tr>
<td class="tf-data-label" style="padding:8px 10px 8px 0;font-family:${font};font-size:13.5px;font-weight:700;color:${BRAND.ink};white-space:nowrap">${t(r.label)}</td>
<td width="100%" style="padding:8px 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.sandHover};border-radius:999px"><tr><td width="${width}%" style="background:${SCALE[level - 1]};height:8px;line-height:8px;font-size:1px;border-radius:999px">&nbsp;</td>${width < 100 ? `<td width="${100 - width}%" style="height:8px;line-height:8px;font-size:1px">&nbsp;</td>` : ''}</tr></table></td>
<td style="padding:8px 10px;font-family:${font};font-size:13.5px;font-weight:800;color:${BRAND.ink};white-space:nowrap;font-variant-numeric:tabular-nums">${t(r.value)}</td>
<td style="padding:8px 0;white-space:nowrap">${tag(status, LEVEL_TONE[level - 1])}</td></tr>`;
        }).join('');
        const inner = [
          eyebrow(block.eyebrow),
          pick(block.title, lang) ? `<div style="font-family:${font};font-size:20px;line-height:1.25;font-weight:800;letter-spacing:${tight(-0.02)};color:${BRAND.ink};padding-bottom:10px">${t(block.title)}</div>` : '',
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${lines}</table>`,
          pick(block.note, lang) ? `<div style="font-family:${font};font-size:13px;line-height:1.5;color:${BRAND.muted};padding-top:10px">${t(block.note)}</div>` : '',
        ].join('');
        html.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.sand};border-radius:18px"><tr><td style="padding:22px 22px 18px">${inner}</td></tr></table>`, { side: 22, bottom: 22 }));
        textOut.push(...[pick(block.eyebrow, lang), plain(block.title)].filter(Boolean), ...rows.map((r) => `${plain(r.label)}: ${plain(r.value)} (${pick(r.status, lang) || levelWords[Math.min(5, Math.max(1, Math.round(Number(r.level) || 3))) - 1]})`), '');
        return;
      }
      case 'steps': {
        const items = (block.items || []).filter((i) => pick(i.title, lang) || pick(i.text, lang)).slice(0, 8);
        if (!items.length) return;
        const lines = items.map((i, n) => `<tr><td valign="top" style="padding:0 14px 16px 0;width:34px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="width:32px;height:32px;background:${BRAND.deepGreen};border-radius:999px;font-family:${FONTS.sans};font-size:14px;font-weight:800;color:${BRAND.paper};line-height:32px">${n + 1}</td></tr></table></td><td valign="top" style="padding:4px 0 16px"><div style="font-family:${font};font-size:17px;line-height:1.3;font-weight:800;color:${BRAND.ink};padding-bottom:4px">${t(i.title)}</div><div style="${bodyStyle(false, 15)}">${rich(i.text, { gap: 6 })}</div></td></tr>`).join('');
        html.push(row(`${eyebrow(block.eyebrow)}${pick(block.title, lang) ? heading(block.title, { size: 22, level: 2 }) : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${lines}</table>`, { top: 8, bottom: 8 }));
        textOut.push(...[plain(block.title)].filter(Boolean), ...items.map((i, n) => `${n + 1}. ${plain(i.title)} — ${plain(i.text)}`), '');
        return;
      }
      case 'details': {
        const items = (block.items || []).filter((i) => pick(i.label, lang) && pick(i.value, lang)).slice(0, 8);
        if (!items.length) return;
        const cells = items.map((i) => `<td class="tf-col" width="50%" valign="top" style="padding:0 10px 14px 0"><div style="font-family:${font};font-size:11px;line-height:1.3;font-weight:800;letter-spacing:${hi ? '0' : '0.08em'};${hi ? '' : 'text-transform:uppercase;'}color:${BRAND.muted};padding-bottom:4px">${t(i.label)}</div><div style="font-family:${font};font-size:16px;line-height:1.4;font-weight:700;color:${BRAND.ink}">${t(i.value)}</div></td>`);
        const grid = [];
        for (let i = 0; i < cells.length; i += 2) grid.push(`<tr>${cells.slice(i, i + 2).join('')}${i + 1 >= cells.length ? '<td class="tf-col" width="50%">&nbsp;</td>' : ''}</tr>`);
        html.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.sand};border-radius:18px"><tr><td style="padding:20px 22px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${grid.join('')}</table></td></tr></table>`, { side: 22, bottom: 22 }));
        textOut.push(...items.map((i) => `${plain(i.label)}: ${plain(i.value)}`), '');
        return;
      }
      case 'quote': {
        if (!pick(block.text, lang)) return;
        const photo = /^https?:\/\//i.test(block.photo || '') ? `<td style="padding-right:12px;vertical-align:middle"><img src="${escapeHtml(block.photo)}" width="44" height="44" alt="" style="display:block;border:0;border-radius:999px"></td>` : '';
        const inner = [
          pick(block.outcome, lang) ? `<div style="padding-bottom:16px">${tag(pick(block.outcome, lang), 'good')}</div>` : '',
          `<div style="font-family:${hi ? FONTS.hindi : FONTS.quote};font-style:${hi ? 'normal' : 'italic'};font-size:20px;line-height:1.5;color:${BRAND.ink};padding-bottom:18px">“${t(block.text)}”</div>`,
          pick(block.name, lang) ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${photo}<td style="vertical-align:middle"><div style="font-family:${font};font-size:15px;font-weight:800;color:${BRAND.ink}">${t(block.name)}</div>${pick(block.role, lang) ? `<div style="font-family:${font};font-size:13px;color:${BRAND.muted}">${t(block.role)}</div>` : ''}</td></tr></table>` : '',
        ].join('');
        const bg = block.tone === 'sand' ? BRAND.sand : BRAND.paper;
        html.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border:1px solid ${BRAND.line};border-radius:24px"><tr><td style="padding:26px 26px 24px">${inner}</td></tr></table>`, { side: 22, bottom: 22 }));
        textOut.push([pick(block.outcome, lang), `“${plain(block.text)}”`, [plain(block.name), plain(block.role)].filter(Boolean).join(', ')].filter(Boolean).join('\n'), '');
        return;
      }
      case 'panel': {
        if (!pick(block.title, lang) && !pick(block.text, lang)) return;
        const inner = [
          eyebrow(block.eyebrow, { dark: true, center }),
          pick(block.title, lang) ? heading(block.title, { size: 28, color: BRAND.paper, highlight: block.highlight, highlightColor: BRAND.mint, center }) : '',
          pick(block.text, lang) ? `<div style="${bodyStyle(true)};text-align:${align}">${rich(block.text, { strong: BRAND.paper, linkColor: BRAND.mint })}</div>` : '',
          buttons([block.button ? { style: 'gold', ...block.button } : null, block.link ? { style: 'link', ...block.link } : null], { dark: true, align }),
        ].join('');
        html.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.deepGreen} url('${img('watermark.png')}') no-repeat right bottom;background-size:260px auto;border-radius:28px"><tr><td class="tf-panel" style="padding:40px 32px 38px;text-align:${align}">${inner}</td></tr></table>`, { side: 22, bottom: 22 }));
        textOut.push(...[pick(block.eyebrow, lang), plain(block.title), plain(block.text), buttonText(block.button), buttonText(block.link)].filter(Boolean), '');
        return;
      }
      case 'pulse':
        html.push(row(`<img src="${img('pulse.png')}" width="568" alt="" style="display:block;width:100%;max-width:568px;height:auto;border:0">`, { top: 6, bottom: 20 }));
        return;
      case 'divider':
        html.push(row(`<div style="border-top:1px solid ${BRAND.line};height:1px;line-height:1px;font-size:1px">&nbsp;</div>`, { top: 8, bottom: 22 }));
        textOut.push('----', '');
        return;
      case 'spacer': {
        const h = Math.min(Math.max(Number(block.height) || 24, 4), 120);
        html.push(`<tr><td style="height:${h}px;line-height:${h}px;font-size:1px">&nbsp;</td></tr>`);
        return;
      }
      case 'social': {
        const items = (block.links || []).filter((l) => safeUrl(l.url));
        if (!items.length) return;
        const links = items.map((l) => `<a href="${linkAttr(safeUrl(l.url))}" style="font-family:${font};color:${BRAND.deepGreen};text-decoration:none;font-weight:700;font-size:14px">${escapeHtml(SOCIAL[l.network] || l.label || 'Link')}</a>`);
        html.push(row(`<div style="text-align:center">${links.join(`<span style="color:${BRAND.lineStrong}">&nbsp;&nbsp;·&nbsp;&nbsp;</span>`)}</div>`, { top: 4, bottom: 22 }));
        textOut.push(items.map((l) => `${SOCIAL[l.network] || l.label || 'Link'}: ${l.url}`).join('\n'), '');
        return;
      }
      case 'html': {
        const raw = stripActiveHtml(pick(block.html, lang));
        if (!raw) return;
        // whatever it was written with, it goes out in the brand's colours and fonts
        const { html: branded } = brandifyHtml(raw);
        const tracked = branded.replace(/href="([^"]+)"/g, (whole, url) => {
          const safe = safeUrl(url);
          return safe ? `href="${linkAttr(safe)}"` : 'href="#"';
        });
        html.push(block.full ? `<tr><td style="padding:0 0 18px">${applyMerge(tracked, merged)}</td></tr>` : row(`<div style="${bodyStyle(false)}">${applyMerge(tracked, merged)}</div>`));
        textOut.push(applyMerge(raw.replace(/<(br|\/p|\/tr|\/h\d|\/div)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim(), merged, { mode: 'text' }), '');
        return;
      }
      default:
    }
  };

  (design?.blocks || []).forEach(renderBlock);

  // ---- the header: the lockup, always
  const site = safeUrl(brand.website);
  const linkTo = (inner) => (site ? `<a href="${escapeHtml(site)}" style="text-decoration:none">${inner}</a>` : inner);
  let headerOutside = '';
  let headerInside = '';
  if (headerStyle === 'dark') {
    headerInside = `<tr><td style="background:${BRAND.deepGreen};padding:24px 36px">${linkTo(`<img src="${img('lockup-paper.png')}" width="150" height="45" alt="Soil Doctor by ekosight" style="display:block;border:0;width:150px;height:auto">`)}</td></tr>`;
  } else if (headerStyle === 'minimal') {
    headerOutside = `<tr><td style="padding:6px 10px 16px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-right:8px;vertical-align:middle">${linkTo(`<img src="${img('mark-96.png')}" width="26" height="26" alt="" style="display:block;border:0">`)}</td><td style="vertical-align:middle;font-family:${FONTS.sans};font-size:15px;font-weight:800;letter-spacing:-0.01em;color:${BRAND.ink}">Soil Doctor</td></tr></table></td></tr>`;
  } else {
    headerOutside = `<tr><td style="padding:4px 10px 18px">${linkTo(`<img src="${img('lockup-ink.png')}" width="150" height="45" alt="Soil Doctor by ekosight" style="display:block;border:0;width:150px;height:auto">`)}</td></tr>`;
  }

  // ---- the footer every email carries
  const unsubscribe = data.unsubscribe_url || '#';
  const preferences = data.preferences_url || '#';
  const company = escapeHtml(footer.company || '');
  const address = escapeHtml(footer.address || '');
  const reason = escapeHtml(pick(footer.reason, lang) || '');
  const small = `font-family:${font};font-size:12.5px;line-height:1.6;color:${BRAND.muted}`;
  const footerHtml = `<tr><td style="padding:26px 24px 8px;text-align:center">
<img src="${img('mark-96.png')}" width="30" height="30" alt="" style="display:inline-block;border:0">
${brand.tagline ? `<div style="font-family:${FONTS.sans};font-size:13px;line-height:1.5;font-weight:700;color:${BRAND.ink};padding-top:8px">${escapeHtml(brand.tagline)}</div>` : ''}
<div style="${small};padding-top:8px">${company ? `<span style="font-weight:700;color:${BRAND.body}">${company}</span>` : ''}${company && address ? ' · ' : ''}${address}</div>
${reason ? `<div style="${small};padding-top:6px">${words.why} ${reason}</div>` : ''}
<div style="${small};padding-top:10px"><a href="${escapeHtml(unsubscribe)}" style="color:${BRAND.deepGreen};font-weight:700;text-decoration:underline">${words.unsubscribe}</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${escapeHtml(preferences)}" style="color:${BRAND.deepGreen};font-weight:700;text-decoration:underline">${words.preferences}</a></div>
</td></tr>`;
  textOut.push('--', [footer.company, footer.address].filter(Boolean).join(', '));
  if (footer.reason) textOut.push(`${words.why} ${pick(footer.reason, lang)}`);
  textOut.push(`${words.unsubscribe}: ${unsubscribe}`, `${words.preferences}: ${preferences}`);

  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${ground};opacity:0">${applyMerge(escapeHtml(preheader), merged)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`
    : '';
  const pixel = track.openPixel
    ? `<img src="${escapeHtml(track.openPixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0">`
    : '';
  const hasHero = (design?.blocks || [])[0]?.type === 'hero';

  const document = `<!DOCTYPE html>
<html lang="${hi ? 'hi' : 'en'}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(applyMerge(subject, merged, { mode: 'text' }))}</title>
<!--[if !mso]><!--><link href="${FONTS.link}" rel="stylesheet"><!--<![endif]-->
<!--[if mso]><style>table,td,div,p,a,span,h1,h2{font-family:Arial,sans-serif!important}</style><![endif]-->
<style>
  body{margin:0;padding:0;-webkit-text-size-adjust:100%;background:${ground}}
  a{color:${BRAND.deepGreen}}
  @media (max-width:660px){
    .tf-wrap{width:100%!important}
    .tf-col{display:block!important;width:100%!important;padding-left:0!important;padding-right:0!important}
    .tf-pad{padding-left:22px!important;padding-right:22px!important}
    .tf-hero{padding:34px 22px 30px!important}
    .tf-panel{padding:32px 22px!important}
    .tf-hx{font-size:30px!important}
    .tf-h1{font-size:26px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${ground}">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${ground}">
<tr><td align="center" style="padding:28px 12px 32px">
<table role="presentation" class="tf-wrap" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%">
${headerOutside}
<tr><td style="background:${BRAND.paper};border:1px solid ${BRAND.line};border-radius:28px;overflow:hidden">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${font};color:${BRAND.body}">
${headerInside}
${hasHero ? '' : '<tr><td style="height:30px;line-height:30px;font-size:1px">&nbsp;</td></tr>'}
${html.join('\n')}
<tr><td style="height:12px;line-height:12px;font-size:1px">&nbsp;</td></tr>
</table>
</td></tr>
${footerHtml}
</table>
${pixel}
</td></tr>
</table>
</body>
</html>`;

  return {
    html: document,
    text: textOut.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

// ---------------------------------------------------------------- checks before sending

const SPAMMY = /\b(free money|100% free|act now|guaranteed|risk[- ]free|click here|winner|cash prize|urgent)\b/i;
// blocks whose example figures must never go out: every number must earn its place
const NUMBERS_BLOCKS = { stats: 'figures', data: 'data', quote: 'testimonial', details: 'details' };
const DARK = (b) => (b.type === 'hero' && b.tone === 'dark') || b.type === 'stats' || b.type === 'panel';

const allStrings = (node, out = []) => {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => allStrings(n, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) if (k !== 'type' && k !== 'condition') allStrings(v, out);
  return out;
};

/** What to fix or think about before a design goes out, including the brand rules. */
export function checkDesign(design, { subject = '', subjectHi = '', languages = ['en'], customKeys = [] } = {}) {
  const problems = [];
  const warnings = [];
  const blocks = design?.blocks || [];
  if (!blocks.length) problems.push('The email has no content');
  if (!String(subject).trim()) problems.push('The subject line is empty');
  if (languages.includes('hi') && !String(subjectHi || '').trim()) warnings.push('No Hindi subject line: Hindi readers will get the English one');

  const known = new Set([...MERGE_TAGS, ...customKeys.map((k) => `custom.${k}`)]);
  const texts = [subject, subjectHi];
  let examples = 0;
  let gold = 0;
  blocks.forEach((block, i) => {
    texts.push(...allStrings(block));
    if (block.type === 'image' && !/^https?:\/\//i.test(block.src || '')) problems.push('An image block has no picture');
    if (block.type === 'image' && !pick(block.alt, 'en')) warnings.push('An image has no description (alt text) for people who cannot see images');
    if (block.type === 'button' && (!pick(block.text, 'en') || !safeUrl(block.href))) problems.push('A button needs both words and a link');
    for (const b of [block.button, block.button2, block.link]) {
      if (b && (pick(b.text, 'en') || b.href) && (!pick(b.text, 'en') || !safeUrl(b.href))) problems.push('A button needs both words and a link');
    }
    if (languages.includes('hi') && ['heading', 'text', 'button'].includes(block.type) && block.text && typeof block.text === 'object' && block.text.en && !block.text.hi) {
      warnings.push(`A ${block.type} block has no Hindi version: Hindi readers will see the English`);
    }
    if (block.example) {
      if (NUMBERS_BLOCKS[block.type]) problems.push(`The ${NUMBERS_BLOCKS[block.type]} block still has the template’s example ${block.type === 'quote' ? 'quote' : block.type === 'details' ? 'details' : 'numbers'}: put in real ones or delete it`);
      else examples += 1;
    }
    if (block.type === 'stats' || block.type === 'panel' || block.button?.style === 'gold' || block.style === 'gold') gold += 1;
    if (i > 0 && DARK(block) && DARK(blocks[i - 1])) warnings.push('Two Deep Green sections sit next to each other; the brand alternates Paper, Sand and Deep Green');
    if (block.type === 'html') warnings.push('Custom HTML is sent in the brand’s colours and fonts automatically: check the preview');
    (block.columns || []).forEach((c) => texts.push(...allStrings(c)));
  });
  if (examples) warnings.push(`${examples} block${examples === 1 ? ' still has' : 's still have'} the template’s example wording`);
  if (gold > 2) warnings.push('Gold is used more than twice; the brand keeps it to about one accent per screen');
  if (texts.some(hasEmoji)) problems.push('The brand guideline says no emoji: remove them from the subject and content');
  for (const text of texts) for (const tag of mergeTagsIn(text)) if (!known.has(tag)) problems.push(`Unknown merge tag {{${tag}}}`);
  for (const url of designLinks(design)) if (/^http:\/\//i.test(url)) warnings.push(`A link is not secure (http): ${url}`);
  if (/[A-Z]{6,}/.test(subject) && subject === subject.toUpperCase()) warnings.push('A subject in capitals is more likely to be filtered as spam');
  if (/!{2,}/.test(subject)) warnings.push('Several exclamation marks make spam filtering more likely');
  if (SPAMMY.test(subject)) warnings.push('The subject uses words spam filters look for');
  if (String(subject).length > 90) warnings.push('The subject is long; phones show about the first 40 characters');
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}
