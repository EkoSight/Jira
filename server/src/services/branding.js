/**
 * The organisation's branding: the app's name, its colours and its logos.
 *
 *   - **Colours** are checked by shared/brandTheme.js, the same rules the
 *     browser previews with. A colour that cannot be made readable, or that
 *     looks like a status colour, is refused with the nearest passing shade.
 *   - **Logos** an administrator uploads: a mark, a wordmark, and dark-mode
 *     versions of each. Until then the Soil Doctor ones bundled with TaskFlow
 *     are used. An SVG is checked for anything that could run (scripts, event
 *     handlers, external links, embedded pages) and refused if it has any; it
 *     is also served with a policy that would stop a script anyway. Pictures
 *     are re-encoded.
 *   - **Icons** (favicon, Apple touch, PWA and maskable) are made from the mark.
 *   - **History:** every save is kept, so Undo can restore the one before, and
 *     every change is in the audit trail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { query, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { uploadDir } from '../lib/uploads.js';
import { DEFAULT_SETTINGS, getSettings, updateSetting } from './settings.js';
import { audit } from './attendance.js';
import { DEFAULT_BRANDING, buildPalette, checkBranding, normaliseHex } from '../../../shared/brandTheme.js';

const BUNDLED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/brand');
const DEFAULT_ASSETS = {
  mark: { file: path.join(BUNDLED, 'soil-doctor-mark.svg'), mime: 'image/svg+xml' },
  markDark: null,
  wordmark: { file: path.join(BUNDLED, 'soil-doctor-wordmark.webp'), mime: 'image/webp' },
  wordmarkDark: null,
};
export const ASSET_KINDS = ['mark', 'markDark', 'wordmark', 'wordmarkDark'];
export const ICONS = {
  'favicon-32.png': { size: 32 },
  'favicon-48.png': { size: 48 },
  'apple-touch-180.png': { size: 180, background: '#FFFFFF', scale: 0.84 },
  'icon-192.png': { size: 192 },
  'icon-512.png': { size: 512 },
  'maskable-512.png': { size: 512, background: '#FFFFFF', scale: 0.72 },
};
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const brandDir = () => path.join(uploadDir, 'branding');

const clean = (b) => ({
  version: Number(b.version) || 1,
  appName: String(b.appName || DEFAULT_BRANDING.appName).slice(0, 40),
  byline: String(b.byline ?? DEFAULT_BRANDING.byline).slice(0, 60),
  primary: normaliseHex(b.primary) || DEFAULT_BRANDING.primary,
  accent: normaliseHex(b.accent) || DEFAULT_BRANDING.accent,
  assets: Object.fromEntries(ASSET_KINDS.map((k) => [k, b.assets?.[k] || null])),
});

export async function currentBranding() {
  const all = await getSettings();
  return clean(all.branding || DEFAULT_SETTINGS.branding);
}

const assetUrl = (prefix, kind, b) => {
  const a = b.assets[kind];
  if (!a && !DEFAULT_ASSETS[kind]) return null;
  return `${prefix}/branding/assets/${kind}?v=${a?.v || `default-${b.version}`}`;
};

/** What every screen needs, signed in or not: name, colours, logos, icons. */
export async function publicBranding(prefix) {
  const b = await currentBranding();
  return {
    version: b.version,
    appName: b.appName,
    byline: b.byline,
    primary: b.primary,
    accent: b.accent,
    palette: buildPalette(b.primary, b.accent),
    assets: Object.fromEntries(ASSET_KINDS.map((k) => [k, assetUrl(prefix, k, b)])),
    assetTypes: Object.fromEntries(ASSET_KINDS.map((k) => [k, (b.assets[k] || DEFAULT_ASSETS[k])?.mime || null])),
    custom: Object.fromEntries(ASSET_KINDS.map((k) => [k, Boolean(b.assets[k])])),
    icons: Object.fromEntries(Object.keys(ICONS).map((name) => [name, `${prefix}/branding/icons/${name}?v=${b.assets.mark?.v || 'default'}`])),
  };
}

async function write(next, action, actor, detail = {}) {
  const value = { ...clean(next), version: (Number(next.version) || 1) + 1 };
  await updateSetting('branding', value, actor.id);
  await withTransaction(async (client) => {
    await client.query('INSERT INTO branding_history (value, action, saved_by) VALUES ($1, $2, $3)', [JSON.stringify(value), action, actor.id]);
    await audit(client, { entityType: 'BRANDING', entityId: 'organisation', actorId: actor.id, action, after: { ...detail, appName: value.appName, primary: value.primary, accent: value.accent }, source: 'branding' });
  });
  return value;
}

/** Saves the name and colours. Colours that fail the checks are refused with suggestions. */
export async function saveBranding(changes, actor) {
  const b = await currentBranding();
  const next = { ...b };
  if (changes.appName !== undefined) {
    const name = String(changes.appName).replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 40) throw badRequest('The app name is 2 to 40 characters');
    next.appName = name;
  }
  if (changes.byline !== undefined) next.byline = String(changes.byline || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (changes.primary !== undefined) next.primary = changes.primary;
  if (changes.accent !== undefined) next.accent = changes.accent;
  const check = checkBranding({ primary: next.primary, accent: next.accent });
  if (!check.ok) {
    throw badRequest('Some colours would be hard to read', {
      code: 'COLOUR_CHECK',
      primary: { problems: check.primary.problems, suggestion: check.primary.suggestion },
      accent: { problems: check.accent.problems, suggestion: check.accent.suggestion },
    });
  }
  next.primary = check.primary.value;
  next.accent = check.accent.value;
  return write(next, 'SAVE', actor);
}

/** Back to the Soil Doctor defaults: name, colours and logos. Uploaded files are kept on disk for the record. */
export async function resetBranding(actor) {
  const b = await currentBranding();
  return write({ ...DEFAULT_SETTINGS.branding, version: b.version }, 'RESET', actor);
}

/** Restores what was saved before the last change. */
export async function undoBranding(actor) {
  const b = await currentBranding();
  const { rows } = await query('SELECT value FROM branding_history ORDER BY id DESC LIMIT 2');
  if (rows.length === 0) throw badRequest('Nothing to undo yet');
  const previous = rows.length === 2 ? rows[1].value : DEFAULT_SETTINGS.branding;
  return write({ ...previous, version: b.version }, 'UNDO', actor);
}

export async function brandingHistory(limit = 20) {
  const { rows } = await query(
    `SELECT h.id, h.action, h.saved_at, u.full_name AS saved_by_name, h.value->>'appName' AS app_name, h.value->>'primary' AS primary, h.value->>'accent' AS accent
       FROM branding_history h LEFT JOIN users u ON u.id = h.saved_by ORDER BY h.id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

// ---------------------------------------------------------------- logos

const FORBIDDEN_SVG = [
  [/<script[\s>]/i, 'a script'],
  [/<foreignObject[\s>]/i, 'an embedded page'],
  [/<(iframe|embed|object|audio|video|animate\w*|set)[\s>]/i, 'embedded content or animation'],
  [/\son[a-z]+\s*=/i, 'an event handler'],
  [/javascript:/i, 'a script link'],
  [/<!(DOCTYPE|ENTITY)/i, 'a document type declaration'],
  [/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(png|jpeg|webp);base64,)/i, 'a link to something outside the file'],
  [/url\(\s*["']?\s*(?!#)/i, 'a reference to something outside the file'],
  [/@import/i, 'an imported style sheet'],
];

/** An uploaded SVG, refused if anything in it could run or reach outside; metadata is dropped. */
export function cleanSvg(buffer) {
  const text = buffer.toString('utf8');
  if (!/<svg[\s>]/i.test(text)) throw badRequest('That is not an SVG file');
  for (const [pattern, what] of FORBIDDEN_SVG) {
    if (pattern.test(text)) throw badRequest(`The SVG contains ${what}; export it again as a plain drawing`, { code: 'UNSAFE_SVG' });
  }
  return Buffer.from(text.replace(/<metadata[\s\S]*?<\/metadata>/gi, '').replace(/<\?xml[^>]*\?>\s*/i, ''), 'utf8');
}

/** Stores an uploaded logo: an SVG as is (once checked), a picture re-encoded as PNG. */
export async function uploadAsset(kind, file, actor) {
  if (!ASSET_KINDS.includes(kind)) throw notFound('Unknown logo');
  if (!file?.buffer?.length) throw badRequest('Attach the file');
  if (file.buffer.length > MAX_ASSET_BYTES) throw badRequest('Logos are at most 2 MB');
  const isSvg = /svg/i.test(file.mimetype) || /<svg[\s>]/i.test(file.buffer.subarray(0, 2048).toString('utf8'));
  let data;
  let mime;
  let ext;
  if (isSvg) {
    data = cleanSvg(file.buffer);
    try { await sharp(data).metadata(); } catch { throw badRequest('That SVG could not be drawn'); }
    mime = 'image/svg+xml';
    ext = 'svg';
  } else {
    let meta;
    try { meta = await sharp(file.buffer, { limitInputPixels: 40_000_000 }).metadata(); } catch { throw badRequest('That file could not be read as a picture'); }
    if (!['png', 'jpeg', 'webp'].includes(meta.format)) throw badRequest('Use an SVG, PNG, JPEG or WebP file');
    data = await sharp(file.buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    mime = 'image/png';
    ext = 'png';
  }
  fs.mkdirSync(brandDir(), { recursive: true });
  const v = crypto.randomBytes(6).toString('hex');
  const name = `${kind}-${v}.${ext}`;
  fs.writeFileSync(path.join(brandDir(), name), data);
  const b = await currentBranding();
  const value = await write({ ...b, assets: { ...b.assets, [kind]: { name, mime, v } } }, 'ASSET', actor, { asset: kind, file: name });
  return { kind, mime, version: value.version };
}

/** Goes back to the bundled logo for this kind. */
export async function clearAsset(kind, actor) {
  if (!ASSET_KINDS.includes(kind)) throw notFound('Unknown logo');
  const b = await currentBranding();
  return write({ ...b, assets: { ...b.assets, [kind]: null } }, 'ASSET', actor, { asset: kind, file: null });
}

/** The file for a logo: the uploaded one, or the bundled one. */
export async function assetFile(kind) {
  if (!ASSET_KINDS.includes(kind)) return null;
  const b = await currentBranding();
  const a = b.assets[kind];
  if (a) {
    const file = path.join(brandDir(), path.basename(a.name));
    if (fs.existsSync(file)) return { file, mime: a.mime };
  }
  return DEFAULT_ASSETS[kind] && fs.existsSync(DEFAULT_ASSETS[kind].file) ? DEFAULT_ASSETS[kind] : null;
}

/** An icon made from the current mark, cached on disk per mark version. */
export async function iconFile(name) {
  const spec = ICONS[name];
  if (!spec) return null;
  const b = await currentBranding();
  const key = b.assets.mark?.v || 'default';
  const dir = path.join(brandDir(), 'icons', key);
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return file;
  const mark = await assetFile('mark');
  if (!mark) return null;
  const inner = Math.round(spec.size * (spec.scale || 1));
  const drawn = await sharp(mark.file, { density: 600 }).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const canvas = sharp({
    create: { width: spec.size, height: spec.size, channels: 4, background: spec.background || { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: drawn, gravity: 'centre' }]).png();
  fs.mkdirSync(dir, { recursive: true });
  await canvas.toFile(file);
  return file;
}

/** The installed app's manifest, with the current name, colour and icons. */
export async function manifest(prefix) {
  const b = await publicBranding(prefix);
  return {
    name: `${b.appName}${b.byline ? ` ${b.byline}` : ''}`,
    short_name: b.appName,
    description: `${b.appName}: day to day work across every ekosight team`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    categories: ['productivity', 'business'],
    background_color: '#ffffff',
    theme_color: b.palette.light['--brand'],
    icons: [
      { src: b.icons['icon-192.png'], sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: b.icons['icon-512.png'], sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: b.icons['maskable-512.png'], sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // a call recording shared from the phone's own recordings opens "Which call is this?"
    share_target: {
      action: '/share-recording',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: { files: [{ name: 'recording', accept: ['audio/*', '.m4a', '.amr', '.3gp', '.3ga', '.aac', '.mp3', '.ogg', '.opus', '.wav'] }] },
    },
    shortcuts: [
      { name: 'My tasks', short_name: 'My tasks', url: '/my-tasks' },
      { name: 'Board', short_name: 'Board', url: '/board' },
      { name: 'Dashboard', short_name: 'Dashboard', url: '/' },
    ],
  };
}
