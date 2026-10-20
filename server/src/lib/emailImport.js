/**
 * Bringing in an email template made somewhere else — Mailchimp, Brevo,
 * Campaign Monitor, HubSpot, a designer's HTML file, or a TaskFlow export —
 * so it can be sent in the Soil Doctor brand.
 *
 * HTML: <style> rules are written onto the elements (mail apps drop most
 * <style> sections), other tools' merge tags become TaskFlow's, wide fixed
 * layouts are allowed to shrink on phones, images embedded in the file are
 * handed back to be hosted, and every colour and font moves onto the brand.
 * Anything that runs (scripts, forms, frames) is removed.
 *
 * Every step is reported in plain words, so the person uploading sees what
 * changed before the template is used.
 */

import { BLOCK_TYPES, GROUNDS, HEADER_STYLES, MERGE_TAGS, stripActiveHtml } from './emailRender.js';
import { brandifyHtml, hasEmoji } from './brand.js';

export const EXPORT_FORMAT = 'taskflow.email-template';
export const MAX_IMPORT_BLOCKS = 80;

const note = (tone, text) => ({ tone, text });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- merge tags from other tools

const FIELD_NAMES = {
  fname: 'first_name', firstname: 'first_name', first_name: 'first_name', prenom: 'first_name',
  lname: 'last_name', lastname: 'last_name', last_name: 'last_name', nom: 'last_name',
  email: 'email', email_address: 'email', company: 'organization', organization: 'organization', organisation: 'organization',
  city: 'city', state: 'state', country: 'country', jobtitle: 'designation', job_title: 'designation', designation: 'designation',
  unsub: 'unsubscribe_url', unsubscribe: 'unsubscribe_url', unsubscribe_link: 'unsubscribe_url', unsubscribe_link_all: 'unsubscribe_url', unsubscribe_url: 'unsubscribe_url',
  update_profile: 'preferences_url', preferences: 'preferences_url', email_preferences: 'preferences_url', preferences_url: 'preferences_url', manage_preferences: 'preferences_url',
  current_year: 'year', year: 'year', date: 'today', today: 'today',
};
// tags the frame already supplies (company, address, web version, forward links): dropped
const SUPPLIED = /^(list:.*|html:.*|mc:.*|mc_.*|archive|archive_link|mirror|forward|rewards|rewards_text|about_list|list_address|view_in_browser|web_version|webversion|site_url|subject)$/i;

const tagFor = (field, fallback) => `{{${field}${fallback ? `|${fallback.replace(/[{}]/g, '')}` : ''}}}`;

/**
 * Rewrites other tools' merge tags as TaskFlow's. Returns
 * { html, converted: [{ from, to }], removed: [tag], unknown: [tag] }.
 */
export function convertMergeTags(source) {
  const converted = new Map();
  const removed = new Set();
  const unknown = new Set();
  const keep = (from, to) => { converted.set(from, to); return to; };
  let html = String(source || '');

  // Mailchimp conditionals: the rewards badge goes; other conditions keep their content
  html = html.replace(/\*\|\s*IF:REWARDS\s*\|\*[\s\S]*?\*\|\s*END:IF\s*\|\*/gi, () => { removed.add('*|REWARDS|*'); return ''; });
  html = html.replace(/\*\|\s*(IF|IFNOT|ELSEIF|ELSE|END):?[^|]*\|\*/gi, (whole) => { removed.add(whole.replace(/\s+/g, '')); return ''; });

  // Mailchimp *|FNAME|*, *|UNSUB|*, *|DATE:Y|*
  html =html.replace(/\*\|\s*([A-Z0-9_:]+)\s*\|\*/gi, (whole, name) => {
    const field = FIELD_NAMES[name.toLowerCase()] || (/^date:/i.test(name) ? 'today' : null);
    if (field) return keep(whole, tagFor(field));
    if (SUPPLIED.test(name)) { removed.add(whole); return ''; }
    unknown.add(whole);
    return '';
  });

  // Campaign Monitor [firstname,fallback=friend] and <unsubscribe>…</unsubscribe>
  html = html.replace(/\[(firstname|lastname|fullname|email)(?:\s*,\s*fallback\s*=\s*([^\]]*))?\]/gi, (whole, name, fallback) => {
    const field = name.toLowerCase() === 'fullname' ? 'full_name' : FIELD_NAMES[name.toLowerCase()];
    return keep(whole, tagFor(field, fallback?.trim()));
  });
  html = html.replace(/<(unsubscribe|preferences)\b[^>]*>([\s\S]*?)<\/\1>/gi, (whole, kind, words) => {
    const to = `<a href="{{${kind === 'unsubscribe' ? 'unsubscribe_url' : 'preferences_url'}}}">${words}</a>`;
    keep(`<${kind}>`, `{{${kind === 'unsubscribe' ? 'unsubscribe_url' : 'preferences_url'}}}`);
    return to;
  });
  html = html.replace(/<(webversion|forwardtoafriend)\b[^>]*>[\s\S]*?<\/\1>/gi, (whole, kind) => { removed.add(`<${kind}>`); return ''; });

  // HubSpot / Jinja statements cannot run here
  html = html.replace(/\{%[\s\S]*?%\}/g, (whole) => { removed.add(whole.length > 40 ? `${whole.slice(0, 37)}…` : whole); return ''; });

  // Brevo {{ contact.FIRSTNAME | default : 'there' }}, HubSpot {{ contact.firstname }}, {{ unsubscribe_link }}
  html = html.replace(/\{\{\s*([A-Za-z_][\w.]*)\s*(?:\|\s*default\s*:?\s*\(?\s*(?:"([^"]*)"|'([^']*)')\s*\)?\s*)?\}\}/g, (whole, rawName, fb1, fb2) => {
    const name = rawName.toLowerCase();
    if (MERGE_TAGS.includes(name) || name.startsWith('custom.')) return whole;
    const bare = name.replace(/^(contact|recipient|subscriber|params|person|user)\./, '');
    const field = FIELD_NAMES[bare];
    if (field) return keep(whole, tagFor(field, fb1 ?? fb2));
    if (SUPPLIED.test(bare)) { removed.add(whole); return ''; }
    unknown.add(whole);
    return whole;
  });

  return { html, converted: [...converted].map(([from, to]) => ({ from, to })), removed: [...removed], unknown: [...unknown] };
}

// ---------------------------------------------------------------- CSS onto elements

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param']);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const setAttr = (attrs, name, value) => {
  const re = new RegExp(`(^|\\s)${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  const safe = String(value).replace(/"/g, "'");
  return re.test(attrs) ? attrs.replace(re, `$1${name}="${safe}"`) : `${attrs} ${name}="${safe}"`;
};

/** The rules of <style> sections, in the order they apply; at-rules are counted, not kept. */
export function parseCss(css) {
  const text = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(import|charset|namespace)[^;{]*;/gi, '');
  const rules = [];
  let atRules = 0;
  let unsupported = 0;
  let order = 0;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth) { if (text[j] === '{') depth += 1; else if (text[j] === '}') depth -= 1; j += 1; }
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith('@')) { atRules += 1; continue; }
    const declarations = body.split(';').map((d) => d.trim()).filter((d) => /^[a-z-]+\s*:/i.test(d))
      .map((d) => { const k = d.indexOf(':'); return [d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim()]; });
    if (!declarations.length) continue;
    for (const selector of prelude.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (/[:[~+]/.test(selector)) { unsupported += 1; continue; }
      const compounds = selector.replace(/\s*>\s*/g, ' ').split(/\s+/).map((part) => {
        const m = part.match(/^([a-z][a-z0-9]*|\*)?((?:[#.][\w-]+)*)$/i);
        if (!m || (!m[1] && !m[2])) return null;
        return {
          tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null,
          id: (m[2].match(/#([\w-]+)/) || [])[1] || null,
          classes: [...m[2].matchAll(/\.([\w-]+)/g)].map((c) => c[1]),
        };
      });
      if (compounds.some((c) => !c)) { unsupported += 1; continue; }
      const last = compounds[compounds.length - 1];
      if (['html', 'head', 'body'].includes(last.tag)) continue;
      const specificity = compounds.reduce((s, c) => s + (c.id ? 100 : 0) + c.classes.length * 10 + (c.tag ? 1 : 0), 0);
      rules.push({ compounds, declarations, specificity, order: order += 1 });
    }
  }
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  return { rules, atRules, unsupported };
}

const matches = (c, el) => (!c.tag || c.tag === el.tag) && (!c.id || c.id === el.id) && c.classes.every((k) => el.classes.includes(k));

function ruleApplies(rule, el, ancestors) {
  const { compounds } = rule;
  if (!matches(compounds[compounds.length - 1], el)) return false;
  let a = ancestors.length - 1;
  for (let k = compounds.length - 2; k >= 0; k -= 1) {
    while (a >= 0 && !matches(compounds[k], ancestors[a])) a -= 1;
    if (a < 0) return false;
    a -= 1;
  }
  return true;
}

/** Writes the <style> rules of a document onto its elements. Element styles still win. */
export function inlineCss(html) {
  const css = [...String(html).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).join('\n');
  const { rules, atRules, unsupported } = parseCss(css);
  if (!rules.length) return { html, inlined: 0, atRules, unsupported };
  const stack = [];
  let inlined = 0;
  const out = String(html).replace(TAG, (whole, closing, rawTag, attrs, selfClosing) => {
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      return whole;
    }
    const el = { tag, id: attr(attrs, 'id'), classes: (attr(attrs, 'class') || '').split(/\s+/).filter(Boolean) };
    const applied = new Map();
    for (const rule of rules) {
      if (ruleApplies(rule, el, stack)) for (const [k, v] of rule.declarations) applied.set(k, v);
    }
    if (!VOID.has(tag) && !selfClosing && !['style', 'script'].includes(tag)) stack.push(el);
    if (!applied.size) return whole;
    inlined += 1;
    const own = attr(attrs, 'style');
    const style = [...applied].map(([k, v]) => `${k}:${v}`).join(';') + (own ? `;${own}` : '');
    return `<${rawTag}${setAttr(attrs, 'style', style)}${selfClosing ? ' /' : ''}>`;
  });
  return { html: out, inlined, atRules, unsupported };
}

// ---------------------------------------------------------------- layout

/** Fixed widths of 480px and up become "up to that width", so the layout shrinks on phones. */
export function fluidWidths(html) {
  return String(html).replace(/<(table|td|th|div|img|center)\b([^>]*)>/gi, (whole, tag, attrs) => {
    let a = attrs;
    let max = null;
    const w = attr(a, 'width');
    if (w && /^\d+$/.test(w) && Number(w) >= 480) { max = Number(w); a = setAttr(a, 'width', '100%'); }
    const style = attr(a, 'style');
    let s = style || '';
    s = s.replace(/(^|;)\s*min-width\s*:\s*(\d+)px/gi, (m, pre, n) => (Number(n) >= 480 ? pre : m));
    s = s.replace(/(^|;)\s*width\s*:\s*(\d+)px/gi, (m, pre, n) => {
      if (Number(n) < 480) return m;
      max = max || Number(n);
      return `${pre}width:100%`;
    });
    s = s.replace(/;\s*;+/g, ';').replace(/^\s*;\s*/, '');
    if (max && !/max-width/i.test(s)) s = `${s ? `${s.replace(/;\s*$/, '')};` : ''}max-width:${max}px${tag.toLowerCase() === 'img' ? ';height:auto' : ''}`;
    if (s !== (style || '')) a = setAttr(a, 'style', s);
    return a === attrs ? whole : `<${tag}${a}>`;
  });
}

// ---------------------------------------------------------------- the whole document

const decode = (text) => String(text || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|zwnj|zwj|#847|#8203|#8204|#160|shy|#173);/gi, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/[͏​-‍ ­]/g, ' ')
  .replace(/\s+/g, ' ').trim();

const ACTIVE = /<\s*(script|iframe|frame|object|embed|form|input|button|textarea|select)\b/gi;

/**
 * Prepares an uploaded HTML template. Images embedded in the file come back
 * in `images` with a placeholder in their place, for the caller to host.
 * Returns { html, name, subject, preheader, images, report }.
 */
export function prepareHtml(source, { filename = '' } = {}) {
  let html = String(source || '').replace(/^﻿/, '');
  const notes = [];
  // the title is often the subject line, merge tags and all
  const title = convertMergeTags(decode((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')).html.trim();
  const titleName = title.replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').replace(/[\s,:–-]+$/, '').trim();

  const active = (html.match(ACTIVE) || []).length;

  // styles onto elements, then everything outside <body> goes
  const inline = inlineCss(html);
  html = inline.html;
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  if (body) html = body[1];
  else html = html.replace(/<!doctype[^>]*>/gi, '').replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '').replace(/<\/?(html|body)\b[^>]*>/gi, '');

  // the hidden preview text: TaskFlow writes its own from the template's preview text
  let preheader = '';
  html = html.replace(/<(div|span|td|p)\b([^>]*style\s*=\s*("|')[^"']*display\s*:\s*none[^"']*\3[^>]*)>([\s\S]*?)<\/\1>/i, (whole, tag, attrs, q, inner) => {
    const words = decode(inner);
    if (!words || words.length > 300 || /<(table|img)\b/i.test(inner)) return whole;
    preheader = words;
    return '';
  });

  const tags = convertMergeTags(html);
  html = tags.html;

  // images inside the file: mail apps will not show them, so they are hosted
  const images = [];
  html = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)("|')data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)\2/gi, (whole, pre, q, mime, data) => {
    const token = `tf-embedded-image-${images.length}`;
    images.push({ token, mime: mime.toLowerCase().replace('jpg', 'jpeg'), buffer: Buffer.from(data.replace(/\s+/g, ''), 'base64') });
    return `${pre}"${token}"`;
  });

  html = fluidWidths(stripActiveHtml(html));
  const branded = brandifyHtml(html);
  html = branded.html.trim();

  const srcs = [...html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => m[2] ?? m[3] ?? '');
  const relative = [...new Set(srcs.filter((s) => s && !/^(https?:|cid:|tf-embedded-image-|\{\{)/i.test(s)))];
  const insecure = srcs.filter((s) => /^http:\/\//i.test(s)).length;
  const ownUnsubscribe = /\{\{\s*unsubscribe_url\s*\}\}/.test(html);

  // what changed, in plain words
  if (inline.inlined) notes.push(note('good', `Styles were written onto ${plural(inline.inlined, 'element')}, so mail apps that ignore style sections still show the layout.`));
  if (inline.atRules) notes.push(note('info', `${plural(inline.atRules, 'responsive or font rule')} (@media, @font-face) ${inline.atRules === 1 ? 'was' : 'were'} left out; wide layouts now shrink to fit phones instead.`));
  if (inline.unsupported) notes.push(note('info', `${plural(inline.unsupported, 'style rule')} for hover states and other effects mail apps do not support ${inline.unsupported === 1 ? 'was' : 'were'} left out.`));
  if (branded.report.colors.length) {
    const total = branded.report.colors.reduce((n, c) => n + c.count, 0);
    notes.push(note('good', `${plural(total, 'colour')} moved onto the Soil Doctor palette (${branded.report.colors.slice(0, 4).map((c) => `${c.from} → ${c.to}`).join(', ')}${branded.report.colors.length > 4 ? ', …' : ''}).`));
  }
  if (branded.report.fonts) notes.push(note('good', `Fonts set in ${plural(branded.report.fonts, 'place')} now use Manrope, the brand typeface.`));
  if (tags.converted.length) notes.push(note('good', `Merge tags converted: ${tags.converted.slice(0, 5).map((c) => `${c.from} → ${c.to}`).join(', ')}${tags.converted.length > 5 ? ', …' : ''}.`));
  if (tags.removed.length) notes.push(note('info', `Removed tags TaskFlow adds itself or cannot use (${tags.removed.slice(0, 4).join(', ')}${tags.removed.length > 4 ? ', …' : ''}). The Soil Doctor footer, company address and unsubscribe link are added to every email.`));
  if (tags.unknown.length) notes.push(note('warn', `These merge tags are not known to TaskFlow: ${tags.unknown.slice(0, 6).join(', ')}. Replace them with TaskFlow tags such as {{first_name}} before sending.`));
  if (preheader) notes.push(note('good', 'The hidden preview text was kept as the template’s preview text.'));
  if (images.length) notes.push(note('good', `${plural(images.length, 'image')} embedded in the file will be hosted so mail apps can show ${images.length === 1 ? 'it' : 'them'}.`));
  if (relative.length) notes.push(note('warn', `${plural(relative.length, 'image')} point${relative.length === 1 ? 's' : ''} to files that were not uploaded (${relative.slice(0, 3).join(', ')}${relative.length > 3 ? ', …' : ''}). Upload ${relative.length === 1 ? 'it' : 'them'} under Images and change the address in the designer.`));
  if (insecure) notes.push(note('warn', `${plural(insecure, 'image')} load${insecure === 1 ? 's' : ''} over http; some mail apps block these. Use https addresses.`));
  if (active) notes.push(note('info', `${plural(active, 'script, form or embedded frame', 'scripts, forms or embedded frames')} ${active === 1 ? 'was' : 'were'} removed; mail apps do not run them.`));
  if (branded.report.emoji) notes.push(note('warn', 'The template uses emoji. The brand guideline does not allow them; remove them before sending.'));
  if (ownUnsubscribe) notes.push(note('info', 'The template has its own unsubscribe link; it now works, and the Soil Doctor footer adds one too, so you may remove the template’s.'));
  const kb = Math.round(Buffer.byteLength(html) / 1024);
  if (kb > 100) notes.push(note('warn', `The email is ${kb} KB; Gmail cuts off messages over about 100 KB. Simplify the layout or remove sections.`));
  notes.push(note('info', 'The Soil Doctor header and footer are added around the template; check the preview and remove any other logo from it.'));

  const fromName = String(filename || '').replace(/\.[^.]*$/, '').replace(/[-_]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
  // a title built around a merge tag ("Offer for *|FNAME|*") reads badly as a name; the file name does better
  const name = (title.includes('{{') && fromName ? fromName : titleName || fromName) || 'Uploaded template';
  return {
    html,
    name: name.slice(0, 200),
    subject: title && title.length <= 150 ? title : '',
    preheader: preheader.slice(0, 250),
    images,
    report: {
      kind: 'html',
      notes,
      colors: branded.report.colors,
      fonts: branded.report.fonts,
      merge_tags: tags.converted,
      unknown_tags: tags.unknown,
      inlined: inline.inlined,
      images: { embedded: images.length, relative, insecure },
      emoji: branded.report.emoji,
      size_kb: kb,
    },
  };
}

// ---------------------------------------------------------------- designs (JSON)

const isWords = (v) => typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v) && ('en' in v || 'hi' in v));
const words = (v, max = 300) => {
  if (typeof v === 'string') return { en: v.slice(0, max), hi: '' };
  if (v && typeof v === 'object') return { en: String(v.en || '').slice(0, max), hi: String(v.hi || '').slice(0, max) };
  return null;
};

/**
 * A design from elsewhere made safe to keep: known block types only, the
 * frame settings TaskFlow allows, custom HTML in the brand. Returns
 * { design, dropped: [type], branded: { colors } }.
 */
export function cleanDesign(design, { strict = false } = {}) {
  if (!design || typeof design !== 'object' || !Array.isArray(design.blocks)) throw new Error('The file has no email design in it');
  const dropped = [];
  const colors = [];
  const settings = design.settings || {};
  const blocks = [];
  for (const block of design.blocks.slice(0, MAX_IMPORT_BLOCKS)) {
    if (!block || typeof block !== 'object' || !BLOCK_TYPES.includes(block.type)) {
      if (strict) throw new Error(`Unknown section type: ${block?.type || 'none'}`);
      dropped.push(String(block?.type || 'unknown'));
      continue;
    }
    if (block.type === 'html') {
      const fix = (value) => {
        const { html, report } = brandifyHtml(stripActiveHtml(value));
        colors.push(...report.colors);
        return html;
      };
      const html = typeof block.html === 'string' ? fix(block.html) : { en: fix(block.html?.en || ''), hi: fix(block.html?.hi || '') };
      blocks.push({ ...block, html });
    } else blocks.push(block);
  }
  if (design.blocks.length > MAX_IMPORT_BLOCKS) dropped.push(`${design.blocks.length - MAX_IMPORT_BLOCKS} more sections`);
  return {
    design: {
      settings: {
        header: HEADER_STYLES.includes(settings.header) ? settings.header : 'light',
        ground: GROUNDS.includes(settings.ground) ? settings.ground : 'sand',
      },
      blocks,
    },
    dropped,
    colors,
  };
}

/** Reads a TaskFlow export, or a bare design, from JSON text. */
export function prepareJson(text) {
  let data;
  try { data = JSON.parse(String(text || '').replace(/^﻿/, '')); } catch { throw new Error('The file is not valid JSON'); }
  const t = data?.format === EXPORT_FORMAT ? data.template : data?.design ? data : { design: data };
  if (data?.format === EXPORT_FORMAT && Number(data.version) > 1) throw new Error('This file was exported by a newer version of TaskFlow');
  const { design, dropped, colors } = cleanDesign(t?.design);
  const notes = [];
  notes.push(note('good', `${plural(design.blocks.length, 'section')} imported.`));
  if (dropped.length) notes.push(note('warn', `Left out sections TaskFlow does not know: ${[...new Set(dropped)].join(', ')}.`));
  if (colors.length) notes.push(note('good', `${plural(colors.reduce((n, c) => n + c.count, 0), 'colour')} in custom HTML moved onto the Soil Doctor palette.`));
  if (hasEmoji(JSON.stringify(design))) notes.push(note('warn', 'The template uses emoji. The brand guideline does not allow them; remove them before sending.'));
  if (design.blocks.some((b) => b.example)) notes.push(note('info', 'Some sections still hold example figures or wording; replace them before sending.'));
  return {
    design,
    name: typeof t.name === 'string' ? t.name.slice(0, 200) : '',
    category: typeof t.category === 'string' ? t.category : '',
    description: typeof t.description === 'string' ? t.description.slice(0, 500) : '',
    subject: isWords(t.subject) ? words(t.subject, 300) : null,
    preheader: isWords(t.preheader) ? words(t.preheader, 300) : null,
    report: { kind: 'json', notes, dropped, colors },
  };
}

/** A template as a file another TaskFlow can import. */
export function exportJson(template) {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    template: {
      name: template.name,
      category: template.category || 'GENERAL',
      description: template.description || '',
      subject: template.subject || null,
      preheader: template.preheader || null,
      design: template.design,
    },
  };
}

export const slug = (name) => String(name || 'template').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'template';
