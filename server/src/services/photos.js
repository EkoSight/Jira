/**
 * Profile photos.
 *
 *   - **Whose:** a person adds, changes and deletes their own. An
 *     administrator can remove one (with a reason the person is told) and can
 *     *suggest* one, which becomes theirs only if they accept it; accepting is
 *     the recorded agreement.
 *   - **Clean:** every picture is decoded and re-encoded here, so nothing
 *     hidden survives: no EXIF, no GPS location, no camera details. Rotation
 *     is applied to the pixels first.
 *   - **Stored:** square WebP at 64, 128, 256 and 512 px, plus the original
 *     (at most 2048 px, also re-encoded) that only its owner can see, under
 *     UPLOAD_DIR/photos/<person>/v<version>/. A new version gets a new folder;
 *     the old one is deleted. Deleting removes the folder.
 *   - **For recognising colleagues only:** photos are not read by attendance,
 *     check-in, payroll or performance, and nothing here compares faces.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { uploadDir } from '../lib/uploads.js';
import { isAdmin } from '../lib/permissions.js';
import { audit } from './attendance.js';
import { notify } from './activity.js';

export const PHOTO_SIZES = [64, 128, 256, 512];
export const MAX_UPLOAD_MB = 10;
export const PHOTO_NOTICE = 'Your photo helps colleagues recognise you. Everyone signed in to TaskFlow can see it. It is not used for attendance, pay or performance, and you can delete it at any time.';
const ACCEPTED = new Set(['jpeg', 'png', 'webp']);
const MIN_SIDE = 32;
const MAX_PIXELS = 50_000_000;

sharp.cache(false);

const root = () => path.join(uploadDir, 'photos');
const personDir = (userId) => path.join(root(), String(Number(userId)));
const versionDir = (userId, version) => path.join(personDir(userId), `v${Number(version)}`);
const proposalDir = (id) => path.join(root(), 'proposals', String(Number(id)));

const HEIC_HELP = 'This photo is in Apple\'s HEIC format, which TaskFlow cannot read here. On an iPhone, share it as a JPEG (or set Settings → Camera → Formats → Most Compatible), then choose it again.';

/** Reads a picture, refusing anything that is not a usable JPEG, PNG or WebP. */
async function inspect(buffer, label) {
  if (!buffer?.length) throw badRequest(`The ${label} is empty`);
  if (buffer.length > MAX_UPLOAD_MB * 1024 * 1024) throw badRequest(`The ${label} is larger than ${MAX_UPLOAD_MB} MB`);
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    // HEIC files start with an ftyp box naming a HEIF brand
    const brand = buffer.subarray(4, 12).toString('latin1');
    if (/ftyp(heic|heix|hevc|mif1|msf1)/.test(brand)) throw badRequest(HEIC_HELP, { code: 'HEIC' });
    throw badRequest(`The ${label} could not be read as a picture`, { code: 'NOT_AN_IMAGE' });
  }
  if (meta.format === 'heif') throw badRequest(HEIC_HELP, { code: 'HEIC' });
  if (!ACCEPTED.has(meta.format)) throw badRequest('Use a JPEG, PNG or WebP picture', { code: 'FORMAT' });
  const rotated = meta.orientation && meta.orientation >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  if (Math.min(width, height) < MIN_SIDE) throw badRequest(`That picture is too small (${width}×${height}); use one at least ${MIN_SIDE} pixels across`, { code: 'TOO_SMALL' });
  return { width, height, format: meta.format };
}

/**
 * The stored files for an upload: the square photo in every size, and the
 * original if one was sent. Every output is a fresh encode with no metadata.
 */
export async function processPhoto({ photo, original = null }) {
  const info = await inspect(photo, 'photo');
  const base = sharp(photo, { limitInputPixels: MAX_PIXELS }).rotate();
  const square = await base.resize(512, 512, { fit: 'cover', position: 'centre', withoutEnlargement: false }).toBuffer();
  const sizes = {};
  for (const size of PHOTO_SIZES) {
    sizes[size] = await sharp(square).resize(size, size).webp({ quality: size <= 64 ? 80 : 86, effort: 4 }).toBuffer();
  }
  let originalOut = null;
  if (original) {
    await inspect(original, 'original');
    originalOut = await sharp(original, { limitInputPixels: MAX_PIXELS }).rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 }).toBuffer();
  }
  return { sizes, original: originalOut, info };
}

function writeFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [size, buf] of Object.entries(files.sizes)) fs.writeFileSync(path.join(dir, `${size}.webp`), buf);
  if (files.original) fs.writeFileSync(path.join(dir, 'original.webp'), files.original);
}
const removeDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } };

const cleanEdit = (edit) => {
  if (!edit || typeof edit !== 'object') return {};
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
  const crop = edit.crop && typeof edit.crop === 'object'
    ? { x: num(edit.crop.x, 0, 1), y: num(edit.crop.y, 0, 1), size: num(edit.crop.size, 0, 2) } : undefined;
  const fixes = edit.fixes && typeof edit.fixes === 'object'
    ? Object.fromEntries(['light', 'colour', 'sharpen', 'background'].map((k) => [k, Boolean(edit.fixes[k])])) : undefined;
  return JSON.parse(JSON.stringify({ crop, angle: num(edit.angle, -45, 45), fixes, face: edit.face === undefined ? undefined : Boolean(edit.face) }));
};

/** A person's photo record, for themselves. */
export async function myPhoto(userId) {
  const { rows } = await query(
    `SELECT p.status, p.version, p.sizes, p.has_original, p.edit, p.consent_at, p.uploaded_by, u.full_name AS uploaded_by_name,
            p.removed_reason, p.removed_at, p.updated_at
       FROM user_photos p LEFT JOIN users u ON u.id = p.uploaded_by WHERE p.user_id = $1`,
    [userId],
  );
  const { rows: proposals } = await query(
    `SELECT pr.id, pr.note, pr.created_at, u.full_name AS proposed_by_name
       FROM user_photo_proposals pr LEFT JOIN users u ON u.id = pr.proposed_by
      WHERE pr.user_id = $1 AND pr.status = 'PENDING' ORDER BY pr.id DESC`,
    [userId],
  );
  return { photo: rows[0]?.status === 'ACTIVE' ? rows[0] : null, last: rows[0] || null, proposals, notice: PHOTO_NOTICE, sizes: PHOTO_SIZES, max_mb: MAX_UPLOAD_MB };
}

/** Makes these files the person's photo (their own upload, or an accepted suggestion). */
async function install(client, userId, files, { edit, uploadedBy, actorId, source }) {
  const { rows } = await client.query('SELECT version FROM user_photos WHERE user_id = $1 FOR UPDATE', [userId]);
  const { rows: u } = await client.query('SELECT photo_version FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!u[0]) throw notFound('Person not found');
  const version = Math.max(rows[0]?.version || 0, u[0].photo_version || 0) + 1;
  const dir = versionDir(userId, version);
  writeFiles(dir, files);
  await client.query(
    `INSERT INTO user_photos (user_id, status, version, sizes, has_original, edit, uploaded_by, consent_at, consent_notice, removed_by, removed_reason, removed_at, updated_at)
     VALUES ($1, 'ACTIVE', $2, $3, $4, $5, $6, now(), $7, NULL, NULL, NULL, now())
     ON CONFLICT (user_id) DO UPDATE SET status = 'ACTIVE', version = EXCLUDED.version, sizes = EXCLUDED.sizes, has_original = EXCLUDED.has_original,
       edit = EXCLUDED.edit, uploaded_by = EXCLUDED.uploaded_by, consent_at = now(), consent_notice = EXCLUDED.consent_notice,
       removed_by = NULL, removed_reason = NULL, removed_at = NULL, updated_at = now()`,
    [userId, version, Object.keys(files.sizes).map(Number), Boolean(files.original), JSON.stringify(cleanEdit(edit)), uploadedBy, PHOTO_NOTICE],
  );
  await client.query('UPDATE users SET photo_version = $2 WHERE id = $1', [userId, version]);
  await audit(client, {
    entityType: 'USER_PHOTO', entityId: userId, subjectUserId: userId, actorId, action: source,
    after: { version, sizes: Object.keys(files.sizes).map(Number), original_kept: Boolean(files.original), uploaded_by: uploadedBy }, source: 'photos',
  });
  return { version, dir };
}

/** Removes every older version's folder, keeping the current one. */
function pruneOld(userId, keepVersion) {
  const dir = personDir(userId);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) if (name !== `v${keepVersion}`) removeDir(path.join(dir, name));
}

/** A person saves their own photo. */
export async function saveOwnPhoto(user, { photo, original, edit }) {
  const files = await processPhoto({ photo, original });
  const result = await withTransaction((client) => install(client, user.id, files, { edit, uploadedBy: user.id, actorId: user.id, source: 'UPLOADED' }));
  pruneOld(user.id, result.version);
  // any suggestion waiting is no longer needed
  await query(`UPDATE user_photo_proposals SET status = 'WITHDRAWN', decided_at = now() WHERE user_id = $1 AND status = 'PENDING' RETURNING id`, [user.id])
    .then(({ rows }) => rows.forEach((r) => removeDir(proposalDir(r.id))));
  return { version: result.version, info: files.info };
}

/** Deletes a person's photo: every size and the original. By an administrator, with a reason they are told. */
export async function removePhoto(userId, actor, { reason = null } = {}) {
  const byAdmin = actor.id !== Number(userId);
  if (byAdmin && !isAdmin(actor)) throw forbidden('Only an administrator can remove someone else\'s photo');
  if (byAdmin && (!reason || String(reason).trim().length < 3)) throw badRequest('Say why the photo is being removed; they will be told');
  const done = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT version FROM user_photos WHERE user_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [userId]);
    if (!rows[0]) return null;
    await client.query(
      `UPDATE user_photos SET status = $2, sizes = '{}', has_original = FALSE, edit = '{}'::jsonb, removed_by = $3, removed_reason = $4, removed_at = now(), updated_at = now()
        WHERE user_id = $1`,
      [userId, byAdmin ? 'REMOVED' : 'DELETED', actor.id, byAdmin ? String(reason).trim().slice(0, 300) : null],
    );
    await client.query('UPDATE users SET photo_version = NULL WHERE id = $1', [userId]);
    await audit(client, {
      entityType: 'USER_PHOTO', entityId: userId, subjectUserId: Number(userId), actorId: actor.id, action: byAdmin ? 'REMOVED_BY_ADMIN' : 'DELETED',
      reason: byAdmin ? String(reason).trim() : null, before: { version: rows[0].version }, source: 'photos',
    });
    if (byAdmin) {
      await notify(client, {
        userId: Number(userId), type: 'photo_removed', title: 'Your profile photo was removed',
        body: `${actor.full_name} removed it: ${String(reason).trim().slice(0, 200)}. You can add a different one in Settings → My account.`,
      });
    }
    return rows[0].version;
  });
  removeDir(personDir(userId));
  return { removed: done !== null };
}

/** The file to send for one size of a person's current photo, or null. */
export async function photoPath(userId, version, size) {
  if (!PHOTO_SIZES.includes(Number(size))) return null;
  const { rows } = await query(`SELECT version FROM user_photos WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
  if (!rows[0] || (version && Number(version) !== rows[0].version)) return null;
  const file = path.join(versionDir(userId, rows[0].version), `${Number(size)}.webp`);
  return fs.existsSync(file) ? { file, version: rows[0].version } : null;
}

/** The kept original, for its owner only. */
export async function originalPath(userId) {
  const { rows } = await query(`SELECT version, has_original FROM user_photos WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
  if (!rows[0]?.has_original) return null;
  const file = path.join(versionDir(userId, rows[0].version), 'original.webp');
  return fs.existsSync(file) ? file : null;
}

/** Who has a photo, and which version: what every screen needs to show faces. */
export async function photoVersions() {
  const { rows } = await query('SELECT id, photo_version AS v FROM users WHERE photo_version IS NOT NULL');
  return rows;
}

// ---------------------------------------------------------------- suggested by an administrator

/** An administrator suggests a photo; it waits for the person, who is told. */
export async function proposePhoto(targetUserId, actor, { photo, original, edit, note }) {
  if (!isAdmin(actor)) throw forbidden('Only an administrator can suggest a photo for someone');
  if (actor.id === Number(targetUserId)) throw badRequest('Add your own photo in My account');
  const { rows: target } = await query('SELECT id, is_active FROM users WHERE id = $1', [targetUserId]);
  if (!target[0]?.is_active) throw notFound('Person not found');
  const files = await processPhoto({ photo, original });
  return withTransaction(async (client) => {
    // one suggestion at a time: an earlier one waiting is withdrawn
    const { rows: old } = await client.query(
      `UPDATE user_photo_proposals SET status = 'WITHDRAWN', decided_at = now() WHERE user_id = $1 AND status = 'PENDING' RETURNING id`, [targetUserId],
    );
    old.forEach((r) => removeDir(proposalDir(r.id)));
    const { rows } = await client.query(
      `INSERT INTO user_photo_proposals (user_id, proposed_by, note, edit, has_original) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [targetUserId, actor.id, note ? String(note).trim().slice(0, 300) : null, JSON.stringify(cleanEdit(edit)), Boolean(files.original)],
    );
    writeFiles(proposalDir(rows[0].id), files);
    await audit(client, {
      entityType: 'USER_PHOTO', entityId: targetUserId, subjectUserId: Number(targetUserId), actorId: actor.id, action: 'SUGGESTED',
      after: { proposal_id: rows[0].id }, reason: note || null, source: 'photos',
    });
    await notify(client, {
      userId: Number(targetUserId), type: 'photo_suggested', title: `${actor.full_name} suggested a profile photo for you`,
      body: 'It is not used until you accept it. Open Settings → My account to see it, then use it or decline.',
    });
    return { id: rows[0].id };
  });
}

async function pendingProposal(client, id) {
  const { rows } = await client.query('SELECT * FROM user_photo_proposals WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Suggestion not found');
  if (rows[0].status !== 'PENDING') throw conflict('That suggestion was already decided');
  return rows[0];
}

const readProposalFiles = (id) => {
  const dir = proposalDir(id);
  const sizes = Object.fromEntries(PHOTO_SIZES.map((s) => [s, fs.readFileSync(path.join(dir, `${s}.webp`))]));
  const originalFile = path.join(dir, 'original.webp');
  return { sizes, original: fs.existsSync(originalFile) ? fs.readFileSync(originalFile) : null };
};

/** The person accepts or declines a suggested photo. Accepting is their recorded agreement. */
export async function decideProposal(id, user, accept) {
  const result = await withTransaction(async (client) => {
    const p = await pendingProposal(client, id);
    if (p.user_id !== user.id) throw notFound('Suggestion not found');
    await client.query(`UPDATE user_photo_proposals SET status = $2, decided_at = now() WHERE id = $1`, [id, accept ? 'ACCEPTED' : 'DECLINED']);
    if (!accept) {
      await audit(client, { entityType: 'USER_PHOTO', entityId: user.id, subjectUserId: user.id, actorId: user.id, action: 'SUGGESTION_DECLINED', after: { proposal_id: id }, source: 'photos' });
      if (p.proposed_by) await notify(client, { userId: p.proposed_by, type: 'photo_suggestion', title: `${user.full_name} declined the suggested photo` });
      return { declined: true };
    }
    const installed = await install(client, user.id, readProposalFiles(id), { edit: p.edit, uploadedBy: p.proposed_by, actorId: user.id, source: 'SUGGESTION_ACCEPTED' });
    if (p.proposed_by) await notify(client, { userId: p.proposed_by, type: 'photo_suggestion', title: `${user.full_name} accepted the suggested photo` });
    return { accepted: true, version: installed.version };
  });
  removeDir(proposalDir(id));
  if (result.version) pruneOld(user.id, result.version);
  return result;
}

/** The administrator who suggested it, or any administrator, withdraws a waiting suggestion. */
export async function withdrawProposal(id, actor) {
  if (!isAdmin(actor)) throw forbidden('Only an administrator can withdraw a suggestion');
  await withTransaction(async (client) => {
    const p = await pendingProposal(client, id);
    await client.query(`UPDATE user_photo_proposals SET status = 'WITHDRAWN', decided_at = now() WHERE id = $1`, [id]);
    await audit(client, { entityType: 'USER_PHOTO', entityId: p.user_id, subjectUserId: p.user_id, actorId: actor.id, action: 'SUGGESTION_WITHDRAWN', after: { proposal_id: id }, source: 'photos' });
  });
  removeDir(proposalDir(id));
  return { withdrawn: true };
}

/** A suggestion's picture: for the person it is for, and administrators. */
export async function proposalPath(id, viewer, size = 256) {
  const { rows } = await query(`SELECT user_id, status FROM user_photo_proposals WHERE id = $1`, [id]);
  const p = rows[0];
  if (!p || p.status !== 'PENDING' || (p.user_id !== viewer.id && !isAdmin(viewer))) return null;
  const file = path.join(proposalDir(id), `${PHOTO_SIZES.includes(Number(size)) ? Number(size) : 256}.webp`);
  return fs.existsSync(file) ? file : null;
}

/** Suggestions waiting, for administrators. */
export async function pendingProposals() {
  const { rows } = await query(
    `SELECT pr.id, pr.user_id, u.full_name, pr.created_at, b.full_name AS proposed_by_name
       FROM user_photo_proposals pr JOIN users u ON u.id = pr.user_id LEFT JOIN users b ON b.id = pr.proposed_by
      WHERE pr.status = 'PENDING' ORDER BY pr.created_at DESC`,
  );
  return rows;
}
