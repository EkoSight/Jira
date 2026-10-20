/**
 * Email designs → email-safe HTML and plain text, as pure functions.
 *
 * A design is { settings, blocks }. Every block's words can be given in
 * English and Hindi ({ en, hi }); each person gets their own language, or
 * English where only English was written. A block can carry a condition, so it
 * is shown only to some people (dynamic content).
 *
 * Nothing a contact typed can change the email's structure: text is escaped
 * first, formatting is applied to the template, and merge values go in last,
 * escaped for where they land (HTML or a link). Links are http(s), mailto or
 * tel only. The footer — who it is from, why they get it, how to stop — is
 * always added and cannot be removed.
 */

export const BLOCK_TYPES = ['heading', 'text', 'image', 'button', 'divider', 'spacer', 'columns', 'social', 'html'];

export const MERGE_TAGS = [
  'first_name', 'last_name', 'full_name', 'email', 'organization', 'designation', 'city', 'state', 'country',
  'festival', 'campaign', 'today', 'year', 'unsubscribe_url', 'preferences_url',
];

const SOCIAL = {
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube', x: 'X', whatsapp: 'WhatsApp', website: 'Website',
};

export const DEFAULT_SETTINGS = {
  background: '#eef2ee',
  contentBackground: '#ffffff',
  textColor: '#1f2a24',
  mutedColor: '#5b6b61',
  linkColor: '#1f7a4d',
  brandColor: '#1f7a4d',
  width: 600,
  logo: null,
};

// ---------------------------------------------------------------- small helpers

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const COLOR = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const color = (value, fallback) => (COLOR.test(String(value || '')) ? value : fallback);

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
 * A small, safe formatting language for text blocks: **bold**, *italic*,
 * [label](https://link), "- " list lines, blank line between paragraphs.
 * Returns HTML; `href` is called for every link so it can be tracked.
 */
export function formatText(source, { href = (u) => u, data = {}, linkColor = DEFAULT_SETTINGS.linkColor } = {}) {
  const escaped = escapeHtml(source);
  const inline = (line) => line
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
      const safe = safeUrl(url.replace(/&amp;/g, '&'));
      if (!safe) return label;
      const target = href(safe);
      return `<a href="${escapeHtml(applyMerge(target, data, { mode: 'url' }))}" style="color:${linkColor};text-decoration:underline">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

  const paragraphs = escaped.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const html = paragraphs.map((p) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
      const items = lines.map((l) => `<li style="margin:0 0 6px">${inline(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('');
      return `<ul style="margin:0 0 14px;padding-left:22px">${items}</ul>`;
    }
    return `<p style="margin:0 0 14px">${lines.map(inline).join('<br>')}</p>`;
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
  const visit = (block) => {
    if (!block) return;
    if (block.href && safeUrl(block.href)) found.add(safeUrl(block.href));
    if (block.text) fromText(block.text);
    for (const link of block.links || []) if (safeUrl(link.url)) found.add(safeUrl(link.url));
    for (const column of block.columns || []) {
      if (column.href && safeUrl(column.href)) found.add(safeUrl(column.href));
      if (column.text) fromText(column.text);
      if (column.button_href && safeUrl(column.button_href)) found.add(safeUrl(column.button_href));
    }
    if (block.type === 'html') {
      for (const m of String(block.html || '').matchAll(/href="([^"]+)"/g)) if (safeUrl(m[1])) found.add(safeUrl(m[1]));
    }
  };
  (design?.blocks || []).forEach(visit);
  if (design?.settings?.logo?.href && safeUrl(design.settings.logo.href)) found.add(safeUrl(design.settings.logo.href));
  return [...found].filter((u) => !/^\{\{/.test(u) && !/^(mailto|tel):/i.test(u));
}

// ---------------------------------------------------------------- rendering

/**
 * Staff-written HTML without anything that runs: scripts, frames, forms,
 * event handlers and javascript: links. Mail apps drop these anyway; the
 * preview inside TaskFlow must never run them.
 */
const ACTIVE_TAGS = 'script|style|iframe|frame|frameset|object|embed|form|input|button|textarea|select|base|meta|link|svg|math';

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

const FONT = {
  en: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  hi: "'Noto Sans Devanagari', 'Nirmala UI', Mangal, 'Segoe UI', Arial, sans-serif",
};

const FOOTER_WORDS = {
  en: { why: 'You are receiving this because', unsubscribe: 'Unsubscribe', preferences: 'Update your preferences' },
  hi: { why: 'आपको यह ईमेल इसलिए मिला क्योंकि', unsubscribe: 'सदस्यता समाप्त करें', preferences: 'अपनी पसंद बदलें' },
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
 */
export function renderEmail(design, {
  person = {}, lang = 'en', data = {}, track = {}, footer = {}, preheader = '', subject = '',
} = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(design?.settings || {}) };
  const width = Math.min(Math.max(Number(s.width) || 600, 480), 720);
  const text = color(s.textColor, DEFAULT_SETTINGS.textColor);
  const muted = color(s.mutedColor, DEFAULT_SETTINGS.mutedColor);
  const link = color(s.linkColor, DEFAULT_SETTINGS.linkColor);
  const brand = color(s.brandColor, DEFAULT_SETTINGS.brandColor);
  const font = FONT[lang] || FONT.en;
  const merged = { ...person, ...data };
  const href = (url) => (track.href ? track.href(url) : url);
  const words = FOOTER_WORDS[lang] || FOOTER_WORDS.en;

  const html = [];
  const textOut = [];
  const pad = 'padding:0 32px';

  const linkAttr = (url) => escapeHtml(applyMerge(href(url), merged, { mode: 'url' }));

  const renderBlock = (block) => {
    if (!block || !BLOCK_TYPES.includes(block.type) || !showBlock(block.condition, person)) return;
    const align = ['left', 'center', 'right'].includes(block.align) ? block.align : 'left';
    switch (block.type) {
      case 'heading': {
        const words_ = pick(block.text, lang);
        if (!words_) return;
        const size = block.level === 2 ? 20 : 26;
        html.push(`<tr><td style="${pad};padding-top:8px;padding-bottom:6px;text-align:${align}"><h${block.level === 2 ? 2 : 1} style="margin:0 0 10px;font-size:${size}px;line-height:1.25;color:${text};font-weight:700">${applyMerge(escapeHtml(words_), merged)}</h${block.level === 2 ? 2 : 1}></td></tr>`);
        textOut.push(plainText(words_, { data: merged }).toUpperCase(), '');
        return;
      }
      case 'text': {
        const words_ = pick(block.text, lang);
        if (!words_) return;
        html.push(`<tr><td style="${pad};text-align:${align};font-size:16px;line-height:1.6;color:${text}">${formatText(words_, { href, data: merged, linkColor: link })}</td></tr>`);
        textOut.push(plainText(words_, { href, data: merged }), '');
        return;
      }
      case 'image': {
        const src = /^https?:\/\//i.test(block.src || '') ? block.src : null;
        if (!src) return;
        const alt = escapeHtml(pick(block.alt, lang));
        const w = Math.min(Number(block.width) || width - 64, width - 64);
        const img = `<img src="${escapeHtml(src)}" alt="${alt}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;margin:${align === 'center' ? '0 auto' : '0'}">`;
        const target = safeUrl(block.href);
        html.push(`<tr><td style="${pad};padding-bottom:14px;text-align:${align}">${target ? `<a href="${linkAttr(target)}">${img}</a>` : img}</td></tr>`);
        if (alt) textOut.push(`[${pick(block.alt, lang)}]`, '');
        return;
      }
      case 'button': {
        const label = pick(block.text, lang);
        const target = safeUrl(block.href);
        if (!label || !target) return;
        const bg = color(block.color, brand);
        html.push(`<tr><td style="${pad};padding-top:4px;padding-bottom:18px;text-align:${align}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table"><tr><td style="border-radius:6px;background:${bg}"><a href="${linkAttr(target)}" style="display:inline-block;padding:12px 26px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${applyMerge(escapeHtml(label), merged)}</a></td></tr></table></td></tr>`);
        textOut.push(`${plainText(label, { data: merged })}: ${applyMerge(href(target), merged, { mode: 'url' })}`, '');
        return;
      }
      case 'divider':
        html.push(`<tr><td style="${pad};padding-top:6px;padding-bottom:18px"><div style="border-top:1px solid #dde4de;height:1px;line-height:1px">&nbsp;</div></td></tr>`);
        textOut.push('----', '');
        return;
      case 'spacer': {
        const h = Math.min(Math.max(Number(block.height) || 24, 4), 120);
        html.push(`<tr><td style="height:${h}px;line-height:${h}px;font-size:1px">&nbsp;</td></tr>`);
        return;
      }
      case 'columns': {
        const cols = (block.columns || []).slice(0, 2);
        if (!cols.length) return;
        const cells = cols.map((c) => {
          const parts = [];
          if (/^https?:\/\//i.test(c.image || '')) parts.push(`<img src="${escapeHtml(c.image)}" alt="${escapeHtml(pick(c.alt, lang))}" width="250" style="display:block;width:100%;max-width:250px;height:auto;border:0;margin-bottom:10px">`);
          if (pick(c.title, lang)) parts.push(`<div style="font-size:17px;font-weight:700;margin-bottom:6px;color:${text}">${applyMerge(escapeHtml(pick(c.title, lang)), merged)}</div>`);
          if (pick(c.text, lang)) parts.push(`<div style="font-size:15px;line-height:1.55;color:${text}">${formatText(pick(c.text, lang), { href, data: merged, linkColor: link })}</div>`);
          const btn = safeUrl(c.button_href);
          if (btn && pick(c.button_text, lang)) parts.push(`<a href="${linkAttr(btn)}" style="color:${link};font-weight:600">${applyMerge(escapeHtml(pick(c.button_text, lang)), merged)} →</a>`);
          textOut.push([pick(c.title, lang), plainText(pick(c.text, lang), { href, data: merged }), btn ? `${pick(c.button_text, lang)}: ${applyMerge(href(btn), merged, { mode: 'url' })}` : ''].filter(Boolean).join('\n'), '');
          return `<td class="tf-col" width="${Math.floor(100 / cols.length)}%" valign="top" style="padding:0 8px 16px">${parts.join('')}</td>`;
        });
        html.push(`<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells.join('')}</tr></table></td></tr>`);
        return;
      }
      case 'social': {
        const items = (block.links || []).filter((l) => safeUrl(l.url));
        if (!items.length) return;
        const links = items.map((l) => `<a href="${linkAttr(safeUrl(l.url))}" style="color:${link};text-decoration:none;margin:0 8px;font-size:14px">${escapeHtml(SOCIAL[l.network] || l.label || 'Link')}</a>`);
        html.push(`<tr><td style="${pad};padding-bottom:16px;text-align:center">${links.join(' · ')}</td></tr>`);
        textOut.push(items.map((l) => `${SOCIAL[l.network] || l.label || 'Link'}: ${l.url}`).join('\n'), '');
        return;
      }
      case 'html': {
        const raw = stripActiveHtml(pick(block.html, lang));
        if (!raw) return;
        // staff-written HTML: links still tracked, merge values still escaped
        const tracked = raw.replace(/href="([^"]+)"/g, (whole, url) => {
          const safe = safeUrl(url);
          return safe ? `href="${linkAttr(safe)}"` : 'href="#"';
        });
        html.push(`<tr><td style="${pad}">${applyMerge(tracked, merged)}</td></tr>`);
        textOut.push(applyMerge(raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), merged, { mode: 'text' }), '');
        return;
      }
      default:
    }
  };

  (design?.blocks || []).forEach(renderBlock);

  // ---- the footer every email carries
  const unsubscribe = data.unsubscribe_url || '#';
  const preferences = data.preferences_url || '#';
  const company = escapeHtml(footer.company || '');
  const address = escapeHtml(footer.address || '');
  const reason = escapeHtml(pick(footer.reason, lang) || '');
  const footerHtml = `<tr><td style="padding:22px 32px 30px;border-top:1px solid #e3e9e4;font-size:12px;line-height:1.6;color:${muted};text-align:center">
${company ? `<div style="font-weight:600">${company}</div>` : ''}${address ? `<div>${address}</div>` : ''}
${reason ? `<div style="margin-top:8px">${words.why} ${reason}</div>` : ''}
<div style="margin-top:8px"><a href="${escapeHtml(unsubscribe)}" style="color:${muted};text-decoration:underline">${words.unsubscribe}</a> · <a href="${escapeHtml(preferences)}" style="color:${muted};text-decoration:underline">${words.preferences}</a></div>
</td></tr>`;
  textOut.push('--', [footer.company, footer.address].filter(Boolean).join(', '));
  if (footer.reason) textOut.push(`${words.why} ${pick(footer.reason, lang)}`);
  textOut.push(`${words.unsubscribe}: ${unsubscribe}`, `${words.preferences}: ${preferences}`);

  const logo = s.logo && /^https?:\/\//i.test(s.logo.src || '')
    ? `<tr><td style="padding:26px 32px 10px;text-align:center">${safeUrl(s.logo.href) ? `<a href="${linkAttr(safeUrl(s.logo.href))}">` : ''}<img src="${escapeHtml(s.logo.src)}" alt="${escapeHtml(s.logo.alt || footer.company || '')}" width="${Math.min(Number(s.logo.width) || 160, 300)}" style="height:auto;border:0;display:inline-block">${safeUrl(s.logo.href) ? '</a>' : ''}</td></tr>`
    : '<tr><td style="height:26px;line-height:26px;font-size:1px">&nbsp;</td></tr>';

  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;opacity:0">${applyMerge(escapeHtml(preheader), merged)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`
    : '';
  const pixel = track.openPixel
    ? `<img src="${escapeHtml(track.openPixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0">`
    : '';

  const document = `<!DOCTYPE html>
<html lang="${lang === 'hi' ? 'hi' : 'en'}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(applyMerge(subject, merged, { mode: 'text' }))}</title>
<style>
  body{margin:0;padding:0;-webkit-text-size-adjust:100%}
  a{color:${link}}
  @media (max-width:${width + 20}px){ .tf-wrap{width:100%!important} .tf-col{display:block!important;width:100%!important} }
</style>
</head>
<body style="margin:0;padding:0;background:${color(s.background, DEFAULT_SETTINGS.background)}">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${color(s.background, DEFAULT_SETTINGS.background)}">
<tr><td align="center" style="padding:24px 10px">
<table role="presentation" class="tf-wrap" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:${width}px;max-width:100%;background:${color(s.contentBackground, DEFAULT_SETTINGS.contentBackground)};border-radius:10px;font-family:${font};color:${text}">
${logo}
${html.join('\n')}
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

/** What to fix or think about before a design goes out. */
export function checkDesign(design, { subject = '', subjectHi = '', languages = ['en'], customKeys = [] } = {}) {
  const problems = [];
  const warnings = [];
  const blocks = design?.blocks || [];
  if (!blocks.length) problems.push('The email has no content');
  if (!String(subject).trim()) problems.push('The subject line is empty');
  if (languages.includes('hi') && !String(subjectHi || '').trim()) warnings.push('No Hindi subject line: Hindi readers will get the English one');

  const known = new Set([...MERGE_TAGS, ...customKeys.map((k) => `custom.${k}`)]);
  const texts = [subject, subjectHi];
  const walk = (block) => {
    for (const key of ['text', 'alt', 'title', 'button_text', 'html']) {
      if (block[key] !== undefined) texts.push(pick(block[key], 'en'), pick(block[key], 'hi'));
    }
    if (block.type === 'image' && !/^https?:\/\//i.test(block.src || '')) problems.push('An image block has no picture');
    if (block.type === 'image' && !pick(block.alt, 'en')) warnings.push('An image has no description (alt text) for people who cannot see images');
    if (block.type === 'button' && (!pick(block.text, 'en') || !safeUrl(block.href))) problems.push('A button needs both words and a link');
    if (languages.includes('hi') && ['heading', 'text', 'button'].includes(block.type) && block.text && typeof block.text === 'object' && block.text.en && !block.text.hi) {
      warnings.push(`A ${block.type} block has no Hindi version: Hindi readers will see the English`);
    }
    (block.columns || []).forEach(walk);
  };
  blocks.forEach(walk);
  for (const t of texts) for (const tag of mergeTagsIn(t)) if (!known.has(tag)) problems.push(`Unknown merge tag {{${tag}}}`);
  for (const url of designLinks(design)) if (/^http:\/\//i.test(url)) warnings.push(`A link is not secure (http): ${url}`);
  if (/[A-Z]{6,}/.test(subject) && subject === subject.toUpperCase()) warnings.push('A subject in capitals is more likely to be filtered as spam');
  if (/!{2,}/.test(subject)) warnings.push('Several exclamation marks make spam filtering more likely');
  if (SPAMMY.test(subject)) warnings.push('The subject uses words spam filters look for');
  if (String(subject).length > 90) warnings.push('The subject is long; phones show about the first 40 characters');
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}
