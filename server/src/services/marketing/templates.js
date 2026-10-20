/**
 * Reusable email designs, and the images used in them.
 *
 * Starter templates ship with TaskFlow in the Soil Doctor brand (see
 * starters.js) and are copied, never edited in place. Saved templates are the
 * team's own: designed here, copied from a starter, saved from a campaign, or
 * uploaded as HTML or a TaskFlow export. Whatever their source, they are sent
 * through the brand frame, so every email follows the brand guideline.
 *
 * Images are kept in the database and served from a public address, because
 * mail apps fetch them; only PNG, JPEG, GIF and WebP are accepted (SVG can
 * carry scripts and most mail apps do not show it).
 */

import crypto from 'node:crypto';
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { cleanDesign, exportJson, prepareHtml, prepareJson } from '../../lib/emailImport.js';
import { publicBase } from './core.js';
import { CATEGORIES, STARTERS, STARTER_BY_KEY } from './starters.js';

export { STARTERS };

const words = (value, max = 300) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() ? { en: value.trim().slice(0, max), hi: '' } : null;
  if (typeof value === 'object') {
    const en = String(value.en || '').trim().slice(0, max);
    const hi = String(value.hi || '').trim().slice(0, max);
    return en || hi ? { en, hi } : null;
  }
  return null;
};
const category = (value) => String(value || 'GENERAL').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 40) || 'GENERAL';
const exampleCount = (design) => (design?.blocks || []).filter((b) => b.example).length;

export function getStarter(key) {
  const starter = STARTER_BY_KEY[key];
  if (!starter) throw notFound('Starter template not found');
  return starter;
}

export async function listTemplates({ includeArchived = false } = {}) {
  const { rows } = await query(
    `SELECT t.id, t.name, t.category, t.description, t.design, t.subject, t.preheader, t.source, t.is_archived,
            t.created_at, t.updated_at, u.full_name AS created_by_name
       FROM mkt_templates t LEFT JOIN users u ON u.id = t.created_by
      WHERE ($1 OR t.is_archived = FALSE) ORDER BY t.updated_at DESC`,
    [includeArchived],
  );
  return {
    starters: STARTERS.map((s) => ({
      key: s.key, name: s.name, category: s.category, description: s.description, design: s.design,
      subject: s.subject || null, preheader: s.preheader || null, examples: exampleCount(s.design),
    })),
    saved: rows.map((r) => ({ ...r, examples: exampleCount(r.design) })),
    categories: CATEGORIES,
  };
}

export async function getTemplate(id) {
  const { rows } = await query('SELECT * FROM mkt_templates WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Template not found');
  return rows[0];
}

/** A design as stored: known section types only and the frame settings the brand allows. */
function storedDesign(design) {
  try {
    return cleanDesign(design, { strict: true }).design;
  } catch (err) {
    throw badRequest(err.message === 'The file has no email design in it' ? 'The template has no design' : err.message);
  }
}

export async function saveTemplate(id, {
  name, category: cat, description, design, subject, preheader, is_archived: archived, source,
}, actor) {
  const clean = design === undefined ? undefined : storedDesign(design);
  if (!id) {
    if (!String(name || '').trim() || !clean) throw badRequest('Give the template a name and some content');
    const { rows } = await query(
      `INSERT INTO mkt_templates (name, category, description, design, subject, preheader, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [String(name).trim().slice(0, 200), category(cat), description ? String(description).slice(0, 500) : null, clean,
        words(subject), words(preheader), source ? String(source).slice(0, 80) : 'designed', actor.id],
    );
    return rows[0];
  }
  const { rows } = await query(
    `UPDATE mkt_templates SET name = COALESCE($2, name), category = COALESCE($3, category), description = COALESCE($4, description),
            design = COALESCE($5, design), is_archived = COALESCE($6, is_archived),
            subject = CASE WHEN $7 THEN $8::jsonb ELSE subject END,
            preheader = CASE WHEN $9 THEN $10::jsonb ELSE preheader END,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, String(name || '').trim().slice(0, 200) || null, cat ? category(cat) : null, description ?? null, clean ?? null, archived ?? null,
      subject !== undefined, subject !== undefined ? words(subject) : null, preheader !== undefined, preheader !== undefined ? words(preheader) : null],
  );
  if (!rows[0]) throw notFound('Template not found');
  return rows[0];
}

/** A starter copied into the team's templates, to change freely. */
export async function copyStarter(key, { name } = {}, actor) {
  const s = getStarter(key);
  return saveTemplate(null, {
    name: String(name || '').trim() || s.name, category: s.category, description: s.description,
    design: s.design, subject: s.subject, preheader: s.preheader, source: `starter:${s.key}`,
  }, actor);
}

/**
 * A template made elsewhere: an HTML file (from Mailchimp, Brevo, a designer)
 * or a TaskFlow export (.json). Returns { template, report } — the report
 * says, in plain words, what was changed to fit the brand.
 */
export async function importTemplate({ content, filename = '', name = '', category: cat = '' }, actor) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
  if (!text.trim()) throw badRequest('The file is empty');
  const looksJson = /\.json$/i.test(filename) || /^\s*[[{]/.test(text);

  if (looksJson) {
    let data;
    try { data = prepareJson(text); } catch (err) { throw badRequest(err.message); }
    if (!data.design.blocks.length) throw badRequest('The file has no sections TaskFlow can use');
    const template = await saveTemplate(null, {
      name: String(name).trim() || data.name || 'Imported template', category: cat || data.category || 'GENERAL',
      description: data.description, design: data.design, subject: data.subject, preheader: data.preheader, source: 'upload:json',
    }, actor);
    return { template, report: data.report };
  }

  if (!/<[a-z!]/i.test(text)) throw badRequest('Upload an HTML file (.html) or a TaskFlow template (.json)');
  const prepared = prepareHtml(text, { filename });
  let { html } = prepared;
  // images that were inside the file are hosted, so mail apps can fetch them
  let failed = 0;
  for (const image of prepared.images) {
    try {
      const asset = await saveAsset({ buffer: image.buffer, filename: `${prepared.name}-image` }, actor);
      html = html.split(image.token).join(asset.url);
    } catch {
      failed += 1;
      html = html.split(image.token).join('');
    }
  }
  if (failed) prepared.report.notes.push({ tone: 'warn', text: `${failed} embedded image${failed === 1 ? ' was' : 's were'} not a PNG, JPEG, GIF or WebP under 2 MB and ${failed === 1 ? 'was' : 'were'} left out.` });
  if (!html.replace(/<[^>]+>/g, '').trim() && !/<img\b/i.test(html)) throw badRequest('The file has no email content in it');
  if (Buffer.byteLength(html) > 900 * 1024) throw badRequest('The template is too large to send (over 900 KB once prepared). Gmail cuts off emails over about 100 KB.');

  const template = await saveTemplate(null, {
    name: String(name).trim() || prepared.name, category: cat || 'GENERAL',
    description: `Uploaded from ${String(filename || 'an HTML file').slice(0, 120)}`,
    design: { settings: { header: 'minimal', ground: 'sand' }, blocks: [{ type: 'html', full: true, html }] },
    subject: prepared.subject || null, preheader: prepared.preheader || null, source: 'upload:html',
  }, actor);
  return { template, report: prepared.report };
}

export const exportTemplate = (template) => exportJson(template);
export const exportStarter = (key) => exportJson({ ...getStarter(key) });

// ---------------------------------------------------------------- images

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Checks the file really is the image type it claims, from its first bytes. */
export function sniffImage(buffer) {
  const b = buffer || Buffer.alloc(0);
  if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function saveAsset({ buffer, filename }, actor) {
  if (!buffer?.length) throw badRequest('No image was received');
  if (buffer.length > MAX_IMAGE_BYTES) throw badRequest('Images can be up to 2 MB; make it smaller and try again');
  const mime = sniffImage(buffer);
  if (!mime) throw badRequest('Use a PNG, JPEG, GIF or WebP image');
  const base = String(filename || 'image').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  const name = `${base}.${IMAGE_TYPES[mime]}`;
  const { rows } = await query(
    `INSERT INTO mkt_assets (public_id, filename, mime, size, data, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, public_id, filename, mime, size, created_at`,
    [crypto.randomBytes(12).toString('base64url'), name, mime, buffer.length, buffer, actor.id],
  );
  return { ...rows[0], url: assetUrl(rows[0]) };
}

export const assetUrl = (asset) => `${publicBase()}/a/${asset.public_id}/${encodeURIComponent(asset.filename)}`;

export async function listAssets() {
  const { rows } = await query(
    `SELECT a.id, a.public_id, a.filename, a.mime, a.size, a.created_at, u.full_name AS created_by_name
       FROM mkt_assets a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC LIMIT 300`,
  );
  return rows.map((a) => ({ ...a, url: assetUrl(a) }));
}

export async function readAsset(publicId) {
  const { rows } = await query('SELECT mime, data, filename FROM mkt_assets WHERE public_id = $1', [publicId]);
  return rows[0] || null;
}
