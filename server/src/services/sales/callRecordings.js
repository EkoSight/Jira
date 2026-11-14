/**
 * Call recordings kept by TaskFlow (from company phones; provider links are
 * handled elsewhere and are not touched here).
 *
 *   keep     only when recordings are switched on, and never for a call whose
 *            lead or contact asked not to be recorded
 *   check    the file must be audio TaskFlow can read; its length is measured
 *            here, never taken from the phone or the browser; a recording
 *            longer than the time since the call started is refused as
 *            probably another call's
 *   store    privately under UPLOAD_DIR/call-recordings, never served as a
 *            public file; one live recording per call
 *   play     through a short-lived link made for one person, after the same
 *            checks as before (own calls, or the recordings permission) and an
 *            audit entry; ranges are served so the player can seek
 *   keep for a dispute   an administrator can stop the retention rule for one
 *            recording, with a reason
 *   delete   after the retention period (calendar months from the call, India
 *            time): the file goes, the call and its row stay
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { uploadDir } from '../../lib/uploads.js';
import { recordAuditEvent } from '../audit.js';
import { recordingExtension, recordingInfo } from './audioLength.js';
import { salesSettings } from './core.js';
import { applyLength, refreshCallTimeline } from './phoneCalls.js';

const ROOT = 'call-recordings';
const LINK_MINUTES = 10;
// recording links are signed with their own key, so one can never pass as a sign-in token
const linkKey = () => crypto.createHmac('sha256', config.auth.jwtSecret).update('taskflow:call-recordings').digest('hex');

export const incomingDir = () => {
  const dir = path.join(uploadDir, ROOT, 'incoming');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const absolute = (stored) => {
  const resolved = path.resolve(uploadDir, stored);
  if (!resolved.startsWith(path.resolve(uploadDir, ROOT) + path.sep)) throw badRequest('Invalid recording reference');
  return resolved;
};

const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

const removeQuietly = async (file) => { if (file) await fsp.rm(file, { force: true }).catch(() => {}); };

/** Whether a call's lead or contact (or the call itself) has asked not to be recorded. */
export async function recordingObjection(runner, call) {
  if (call.no_recording) return 'They asked on this call not to be recorded';
  if (call.lead_id) {
    const { rows } = await runner.query('SELECT do_not_record FROM crm_leads WHERE id = $1', [call.lead_id]);
    if (rows[0]?.do_not_record) return 'This lead asked not to be recorded';
  }
  if (call.contact_id) {
    const { rows } = await runner.query('SELECT do_not_record FROM account_contacts WHERE id = $1', [call.contact_id]);
    if (rows[0]?.do_not_record) return 'This contact asked not to be recorded';
  }
  return null;
}

/**
 * Keeps a recording for a call. `filePath` is a file already on disk (an
 * upload); it is moved into storage or deleted, never left behind.
 */
export async function storeRecording({ callId, filePath, originalName, source, userId, deviceId = null, now = new Date() }) {
  // where the file was moved to, until the transaction that records it commits
  let placed = null;
  try {
    const settings = await salesSettings();
    const calls = settings.calls || {};
    if (calls.deviceRecordings !== true) throw conflict('Recordings are switched off in Settings → Calling', { code: 'RECORDINGS_OFF' });
    const ext = recordingExtension(originalName);
    if (!ext) throw badRequest('Use a call recording file: m4a, mp3, aac, amr, 3gp, ogg, opus or wav', { code: 'TYPE' });
    const stat = await fsp.stat(filePath);
    const maxMb = Number(calls.maxRecordingMb) || 50;
    if (stat.size <= 0) throw badRequest('The file is empty', { code: 'EMPTY' });
    if (stat.size > maxMb * 1024 * 1024) throw badRequest(`The file is larger than ${maxMb} MB`, { code: 'TOO_LARGE' });
    const sha256 = await sha256File(filePath);
    const buffer = await fsp.readFile(filePath);
    let info;
    try {
      info = await recordingInfo(buffer, ext);
    } catch {
      throw badRequest('TaskFlow could not read this file as a call recording', { code: 'UNREADABLE' });
    }
    return await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM crm_calls WHERE id = $1 FOR UPDATE', [callId]);
      const call = rows[0];
      if (!call) throw notFound('Call not found');
      if (call.agent_user_id !== userId) throw forbidden('Only the person who made the call can add its recording');
      const objection = await recordingObjection(client, call);
      if (objection) throw conflict(`${objection}; the recording is not kept`, { code: 'DO_NOT_RECORD' });
      const { rows: existing } = await client.query('SELECT * FROM crm_call_recordings WHERE call_id = $1 AND deleted_at IS NULL', [callId]);
      if (existing[0]) {
        if (existing[0].sha256 === sha256) return { recording: shape(existing[0]), duplicate: true, sha256 };
        throw conflict(`Call #${callId} already has a recording`, { code: 'ALREADY_HAS_RECORDING' });
      }
      const started = new Date(call.started_at || call.dialled_at || call.created_at);
      const elapsed = (now.getTime() - started.getTime()) / 1000;
      if (info.seconds > elapsed + 120) {
        throw badRequest(
          `This recording is ${Math.round(info.seconds / 60)} min long, but call #${call.id} started ${Math.max(0, Math.round(elapsed / 60))} min ago: it is probably a different call's recording`,
          { code: 'WRONG_FILE', length_sec: info.seconds },
        );
      }
      const stored = path.join(ROOT, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'),
        `${call.id}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
      await fsp.mkdir(path.dirname(absolute(stored)), { recursive: true });
      await fsp.rename(filePath, absolute(stored));
      placed = absolute(stored);
      const { rows: inserted } = await client.query(
        `INSERT INTO crm_call_recordings (call_id, storage_path, mime, bytes, sha256, length_sec, source, original_name, device_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [call.id, stored, info.mime, stat.size, sha256, info.seconds, source, String(originalName || '').slice(0, 200), deviceId, userId],
      );
      await applyLength(client, call.id, info.seconds, 'RECORDING');
      const fresh = (await client.query('SELECT * FROM crm_calls WHERE id = $1', [call.id])).rows[0];
      if (fresh.outcome_at || fresh.status !== 'DIALLED') await refreshCallTimeline(client, fresh, userId);
      await recordAuditEvent(client, {
        action: 'CALL_RECORDING_ADDED', entityType: 'CALL', entityId: call.id, actorId: userId,
        summary: `${source.toLowerCase().replace('_', ' ')} · ${info.seconds} s`, detail: { recording_id: inserted[0].id, source, bytes: stat.size, device_id: deviceId },
      });
      return { recording: shape(inserted[0]), duplicate: false, sha256 };
    });
  } catch (err) {
    // nothing was recorded: neither the upload nor a moved copy is kept
    await removeQuietly(placed);
    throw err;
  } finally {
    await removeQuietly(filePath);
  }
}

const shape = (r) => ({
  id: r.id, call_id: r.call_id, length_sec: r.length_sec, source: r.source, mime: r.mime, bytes: r.bytes, sha256: r.sha256,
  created_at: r.created_at, hold_reason: r.hold_reason, hold_at: r.hold_at,
});

async function liveRecording(callId) {
  const { rows } = await query(
    `SELECT r.*, c.agent_user_id, c.lead_id, c.account_id, c.opportunity_id FROM crm_call_recordings r JOIN crm_calls c ON c.id = r.call_id
      WHERE r.call_id = $1 AND r.deleted_at IS NULL`,
    [callId],
  );
  return rows[0] || null;
}

/**
 * A link to play (or download) a call's recording, valid for ten minutes and
 * only for this person. Your own calls, or anyone's with the recordings
 * permission; downloading needs the permission. Each is audited.
 */
export async function recordingLink(callId, actor, { download = false } = {}) {
  const rec = await liveRecording(callId);
  if (!rec) throw notFound('No recording is kept for this call');
  const others = hasPermission(actor, 'crm.recordings');
  if (rec.agent_user_id !== actor.id && !others) throw forbidden('Recordings of other people’s calls need the recordings permission');
  if (download && !others) throw forbidden('Downloading a recording needs the recordings permission');
  await recordAuditEvent(null, {
    action: download ? 'CALL_RECORDING_DOWNLOADED' : 'CALL_RECORDING_PLAYED', entityType: 'CALL', entityId: rec.call_id, actorId: actor.id,
    detail: { recording_id: rec.id },
  });
  const token = jwt.sign({ k: 'rec', r: rec.id, c: rec.call_id, u: actor.id, d: download ? 1 : 0 }, linkKey(), { expiresIn: `${LINK_MINUTES}m` });
  return { url: `${config.apiPrefix}/s/recordings/${token}`, expires_in: LINK_MINUTES * 60, length_sec: rec.length_sec, mime: rec.mime };
}

/** Sends the file behind a recording link; the player may ask for ranges. */
export async function sendRecording(token, res, next) {
  let p;
  try {
    p = jwt.verify(String(token), linkKey());
  } catch {
    throw notFound('This recording link has expired; open the recording again');
  }
  if (p.k !== 'rec') throw notFound('Not found');
  const { rows } = await query('SELECT * FROM crm_call_recordings WHERE id = $1 AND deleted_at IS NULL', [p.r]);
  const rec = rows[0];
  if (!rec) throw notFound('This recording is no longer kept');
  const ext = path.extname(rec.storage_path);
  res.set({
    'Cache-Control': 'no-store, private',
    'Content-Type': rec.mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${p.d ? 'attachment' : 'inline'}; filename="call-${rec.call_id}${ext}"`,
  });
  res.sendFile(absolute(rec.storage_path), { acceptRanges: true, cacheControl: false, lastModified: false, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) next(notFound('This recording is no longer kept'));
  });
}

/** Deletes a call's kept recording (the file), leaving the record that it existed. */
export async function deleteRecording(client, callId, { reason, actorId = null }) {
  const { rows } = await client.query(
    `UPDATE crm_call_recordings SET deleted_at = now(), delete_reason = $2, deleted_by = $3
      WHERE call_id = $1 AND deleted_at IS NULL RETURNING id, storage_path`,
    [callId, reason, actorId],
  );
  for (const r of rows) await removeQuietly(absolute(r.storage_path));
  return rows.length;
}

/** "Keep: needed for a dispute", with a reason; or lifts it. Administrators only. */
export async function holdRecording(callId, { reason = null }, actor, { release = false } = {}) {
  if (!hasPermission(actor, 'crm.settings')) throw forbidden('Keeping a recording past its retention needs the CRM settings permission');
  const why = String(reason || '').trim();
  if (!release && why.length < 3) throw badRequest('Say why the recording is needed (for example, the complaint it is about)');
  const rec = await liveRecording(callId);
  if (!rec) throw notFound('No recording is kept for this call');
  await query(
    release
      ? 'UPDATE crm_call_recordings SET hold_reason = NULL, hold_by = NULL, hold_at = NULL WHERE id = $1'
      : 'UPDATE crm_call_recordings SET hold_reason = $2, hold_by = $3, hold_at = now() WHERE id = $1',
    release ? [rec.id] : [rec.id, why.slice(0, 500), actor.id],
  );
  await recordAuditEvent(null, {
    action: release ? 'CALL_RECORDING_HOLD_LIFTED' : 'CALL_RECORDING_HELD', entityType: 'CALL', entityId: callId, actorId: actor.id,
    summary: release ? (why || 'Hold lifted') : why, detail: { recording_id: rec.id },
  });
  return { held: !release };
}

/**
 * Deletes recordings whose call is older than the retention period, in
 * calendar months from the call's start in the calendar's time zone. A
 * recording kept for a dispute is skipped. Returns how many were deleted.
 */
export async function runRecordingRetention(now = new Date()) {
  const settings = await salesSettings();
  const months = Math.max(1, Number(settings.calls?.recordingRetentionMonths) || 6);
  const tz = settings.calendar?.timezone || 'Asia/Kolkata';
  const { rows } = await query(
    `SELECT r.id, r.call_id, r.storage_path FROM crm_call_recordings r JOIN crm_calls c ON c.id = r.call_id
      WHERE r.deleted_at IS NULL AND r.hold_at IS NULL
        AND (COALESCE(c.started_at, c.dialled_at, r.created_at) AT TIME ZONE $3) + make_interval(months => $2) <= ($1::timestamptz AT TIME ZONE $3)
      ORDER BY r.id LIMIT 500`,
    [now, months, tz],
  );
  let deleted = 0;
  for (const r of rows) {
    const { rowCount } = await query(
      `UPDATE crm_call_recordings SET deleted_at = now(), delete_reason = 'RETENTION' WHERE id = $1 AND deleted_at IS NULL AND hold_at IS NULL`, [r.id],
    );
    if (rowCount) {
      await removeQuietly(absolute(r.storage_path));
      deleted += 1;
    }
  }
  if (deleted) {
    await recordAuditEvent(null, {
      action: 'CALL_RECORDINGS_RETENTION', entityType: 'SETTINGS', summary: `${deleted} recording(s) deleted after ${months} months`,
      detail: { months, call_ids: rows.map((r) => r.call_id) },
    });
  }
  return deleted;
}
