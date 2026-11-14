/**
 * Company phones running the TaskFlow Android app.
 *
 *   sign-in     the app's web page registers the phone with the person's normal
 *               login and receives a device token (stored hashed). The token
 *               only reaches the /device routes. Signing out, or an
 *               administrator handing the phone over, ends that sign-in: calls
 *               made before can still be sent, later ones are refused.
 *               Revoking a phone refuses everything.
 *   numbers     the app gets the numbers of the leads and contacts the person
 *               may see as salted hashes (a salt per person, per day), and the
 *               opted-out and "do not record" numbers the same way. It sends a
 *               call only when the number matches.
 *   call log    each entry becomes one call: attached to the call started from
 *               TaskFlow (or typed in by hand) within ten minutes, otherwise a
 *               new call. A number that is not a lead or contact in the
 *               person's scope is refused and nothing about it is stored.
 *   recording   the dialler's own file, picked up by the app; stored by
 *               callRecordings.js under the same rules as any recording
 *   mode        how each dialler app's recordings reach TaskFlow, confirmed by
 *               an administrator after testing that phone model
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { uploadDir } from '../../lib/uploads.js';
import { loadUser } from '../../middleware/auth.js';
import { notify } from '../activity.js';
import { recordAuditEvent } from '../audit.js';
import { crmAdmins, policyStatus } from './callingCare.js';
import { storeRecording } from './callRecordings.js';
import { createFollowUp } from './followups.js';
import { crmScope, localDate, normalizePhone, salesSettings, scopeCondition } from './core.js';
import { applyLength, countAttemptOnce, refreshCallTimeline } from './phoneCalls.js';

export const RECORDING_MODES = ['AUTOMATIC', 'SHARE_BY_HAND', 'NONE'];
// what is expected, before an administrator has confirmed it on a real phone
const EXPECTED_MODES = {
  'com.samsung.android.dialer': 'AUTOMATIC',
  'com.google.android.dialer': 'SHARE_BY_HAND',
};
const ENTRY_TYPES = ['OUTGOING', 'INCOMING', 'MISSED', 'REJECTED', 'BLOCKED', 'VOICEMAIL', 'OTHER'];
const ATTACH_WINDOW_MIN = 10;

// ---------------------------------------------------------------- hashing (the app does the same)

const hashSecret = () => process.env.CALL_HASH_SECRET || config.auth.jwtSecret;

/** The salt for one person on one day. */
export function daySalt(userId, day) {
  return crypto.createHmac('sha256', hashSecret()).update(`taskflow:numbers:${userId}:${day}`).digest('hex');
}

/** A number as the app compares it: HMAC-SHA256 of the normalised number, keyed by the day's salt. */
export function hashNumber(salt, number) {
  return crypto.createHmac('sha256', salt).update(String(number)).digest('hex');
}

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const INSTALL_ID = /^[A-Za-z0-9_-]{8,80}$/;

// ---------------------------------------------------------------- recording mode

export async function recordingModeFor(diallerPackage, runner = { query }) {
  if (!diallerPackage) return { mode: 'UNKNOWN', confirmed: false };
  const { rows } = await runner.query('SELECT mode, folder_hint, note FROM crm_dialler_modes WHERE package = $1', [diallerPackage]);
  if (rows[0]) return { mode: rows[0].mode, confirmed: true, folder_hint: rows[0].folder_hint, note: rows[0].note };
  return { mode: EXPECTED_MODES[diallerPackage] || 'UNKNOWN', confirmed: false };
}

export async function confirmDiallerMode({ package: pkg, mode, folderHint = null, note = null }, actor) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(String(pkg || ''))) throw badRequest('Give the dialler app\'s package name exactly as the phone reports it');
  if (!RECORDING_MODES.includes(mode)) throw badRequest('Choose automatic, shared by hand, or none');
  await query(
    `INSERT INTO crm_dialler_modes (package, mode, folder_hint, note, confirmed_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (package) DO UPDATE SET mode = EXCLUDED.mode, folder_hint = EXCLUDED.folder_hint, note = EXCLUDED.note,
            confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`,
    [pkg, mode, folderHint ? String(folderHint).slice(0, 300) : null, note ? String(note).slice(0, 500) : null, actor.id],
  );
  await recordAuditEvent(null, { action: 'DIALLER_MODE_CONFIRMED', entityType: 'SETTINGS', actorId: actor.id, summary: `${pkg}: ${mode}`, detail: { folderHint, note } });
  return recordingModeFor(pkg);
}

// ---------------------------------------------------------------- signing a phone in

const DEVICE_INFO = ['maker', 'model', 'android_version', 'app_version', 'dialler_package'];

/** Registers (or re-registers) a phone for the signed-in person and returns its device token once. */
export async function registerDevice({ actor, installId, info = {}, assetLabel = null, simNumber = null }) {
  if (!INSTALL_ID.test(String(installId || ''))) throw badRequest('The app sent an unusable phone id');
  if (!hasPermission(actor, 'crm.activity.log')) throw forbidden('Calling from a company phone needs permission to log calls');
  return withTransaction(async (client) => {
    const values = DEVICE_INFO.map((k) => (info[k] === undefined || info[k] === null ? null : String(info[k]).slice(0, 120)));
    const { rows } = await client.query(
      `INSERT INTO crm_call_devices (install_id, maker, model, android_version, app_version, dialler_package, asset_label, sim_number, signed_in_user_id, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (install_id) DO UPDATE SET maker = COALESCE(EXCLUDED.maker, crm_call_devices.maker), model = COALESCE(EXCLUDED.model, crm_call_devices.model),
              android_version = COALESCE(EXCLUDED.android_version, crm_call_devices.android_version), app_version = COALESCE(EXCLUDED.app_version, crm_call_devices.app_version),
              dialler_package = COALESCE(EXCLUDED.dialler_package, crm_call_devices.dialler_package),
              asset_label = COALESCE(EXCLUDED.asset_label, crm_call_devices.asset_label), sim_number = COALESCE(EXCLUDED.sim_number, crm_call_devices.sim_number),
              signed_in_user_id = EXCLUDED.signed_in_user_id, last_seen_at = now(), updated_at = now()
       RETURNING *`,
      [installId, ...values, assetLabel ? String(assetLabel).slice(0, 80) : null, simNumber ? String(simNumber).slice(0, 40) : null, actor.id],
    );
    const device = rows[0];
    if (device.revoked_at) throw conflict('An administrator has blocked this phone. Ask them to allow it again.', { code: 'DEVICE_REVOKED' });
    // one sign-in per phone: an earlier one (this person's or someone else's) ends here
    await client.query(
      `UPDATE crm_call_device_sessions SET ended_at = now(), end_reason = 'REPLACED', ended_by = $2 WHERE device_id = $1 AND ended_at IS NULL`,
      [device.id, actor.id],
    );
    const token = crypto.randomBytes(32).toString('base64url');
    await client.query('INSERT INTO crm_call_device_sessions (device_id, user_id, token_hash) VALUES ($1, $2, $3)', [device.id, actor.id, tokenHash(token)]);
    await recordAuditEvent(client, {
      action: 'PHONE_SIGNED_IN', entityType: 'DEVICE', entityId: device.id, actorId: actor.id,
      summary: [device.maker, device.model, device.asset_label].filter(Boolean).join(' · ') || `Phone #${device.id}`,
    });
    return { device: { id: device.id, install_id: device.install_id }, token };
  });
}

/**
 * Who a device token belongs to. An ended sign-in still identifies the phone
 * and person (so earlier calls can be sent); `ended` says so.
 */
export async function deviceContext(token) {
  if (!token) throw unauthorized('This phone is not signed in to TaskFlow');
  const { rows } = await query(
    `SELECT s.id AS session_id, s.user_id, s.started_at, s.ended_at, s.end_reason, d.*
       FROM crm_call_device_sessions s JOIN crm_call_devices d ON d.id = s.device_id WHERE s.token_hash = $1`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (!row) throw unauthorized('This phone is not signed in to TaskFlow');
  if (row.revoked_at || row.end_reason === 'REVOKED') {
    const err = unauthorized('An administrator has blocked this phone');
    err.details = { code: 'DEVICE_REVOKED' };
    throw err;
  }
  const user = await loadUser(row.user_id);
  if (!user?.is_active) throw unauthorized('This account is switched off');
  if (!hasPermission(user, 'crm.activity.log')) throw forbidden('This account may not log calls');
  await query('UPDATE crm_call_device_sessions SET last_used_at = now() WHERE id = $1', [row.session_id]);
  await query('UPDATE crm_call_devices SET last_seen_at = now() WHERE id = $1', [row.id]);
  return {
    user,
    device: row,
    session: { id: row.session_id, started_at: row.started_at, ended_at: row.ended_at, end_reason: row.end_reason },
    ended: Boolean(row.ended_at),
  };
}

function requireOpen(ctx) {
  if (ctx.ended) {
    const err = unauthorized('This phone was signed out of TaskFlow; sign in again');
    err.details = { code: 'SIGNED_OUT', reason: ctx.session.end_reason };
    throw err;
  }
}

/** Ends this phone's sign-in (the app signing out). */
export async function signOutDevice(ctx) {
  await query(`UPDATE crm_call_device_sessions SET ended_at = now(), end_reason = 'SIGNED_OUT', ended_by = $2 WHERE id = $1 AND ended_at IS NULL`, [ctx.session.id, ctx.user.id]);
  await query('UPDATE crm_call_devices SET signed_in_user_id = NULL, updated_at = now() WHERE id = $1 AND signed_in_user_id = $2', [ctx.device.id, ctx.user.id]);
  await recordAuditEvent(null, { action: 'PHONE_SIGNED_OUT', entityType: 'DEVICE', entityId: ctx.device.id, actorId: ctx.user.id });
  return { signed_out: true };
}

// ---------------------------------------------------------------- what the app is told

/** The app's settings, sent with every heartbeat. */
export async function deviceConfig(ctx) {
  const settings = await salesSettings();
  const calls = settings.calls || {};
  const mode = await recordingModeFor(ctx.device.dialler_package);
  const policy = await policyStatus(ctx.user.id, settings);
  return {
    user: { id: ctx.user.id, name: ctx.user.full_name },
    device: { id: ctx.device.id, asset_label: ctx.device.asset_label },
    signed_in: !ctx.ended,
    sync: calls.deviceSync !== false,
    recordings: calls.deviceRecordings === true,
    remove_phone_copy: calls.removePhoneCopy !== false,
    max_recording_mb: Number(calls.maxRecordingMb) || 50,
    recording_mode: mode,
    policy,
    calling_hours: calls.callingHours || null,
  };
}

/** The numbers the app may send, as salted hashes, with the opted-out and "do not record" ones. */
export async function deviceNumbers(ctx, now = new Date()) {
  requireOpen(ctx);
  const settings = await salesSettings();
  const day = localDate(now, settings.calendar?.timezone || 'Asia/Kolkata');
  const salt = daySalt(ctx.user.id, day);
  const scope = await crmScope(ctx.user);
  const p1 = [];
  const push1 = (v) => { p1.push(v); return `$${p1.length}`; };
  const leadScope = scopeCondition(scope, 'lead', 'l', push1);
  const { rows: leads } = await query(
    `SELECT DISTINCT l.phone_normalized AS n, l.do_not_record AS dnr FROM crm_leads l
      WHERE l.phone_normalized IS NOT NULL AND l.merged_into_id IS NULL AND ${leadScope}`, p1,
  );
  const p2 = [];
  const push2 = (v) => { p2.push(v); return `$${p2.length}`; };
  const accountScope = scopeCondition(scope, 'account', 'a', push2);
  const { rows: contacts } = await query(
    `SELECT DISTINCT c.phone_normalized AS n, c.do_not_record AS dnr FROM account_contacts c JOIN accounts a ON a.id = c.account_id
      WHERE c.phone_normalized IS NOT NULL AND c.is_active = TRUE AND a.is_archived = FALSE AND ${accountScope}`, p2,
  );
  const { rows: optouts } = await query(`SELECT address AS n FROM crm_optouts WHERE channel = 'CALL' AND lifted_at IS NULL`);
  const optedOut = new Set(optouts.map((r) => r.n));
  // numbers: leads and contacts in scope that may be called. opted_out: those in
  // scope that asked not to be called (the app refuses to dial them, and still
  // sends a call they make to the company). Both lists stay inside the scope.
  const callable = new Set();
  const stopped = new Set();
  const noRecord = new Set();
  for (const r of [...leads, ...contacts]) {
    (optedOut.has(r.n) ? stopped : callable).add(r.n);
    if (r.dnr) noRecord.add(r.n);
  }
  const h = (n) => hashNumber(salt, n);
  return {
    day, salt, algorithm: 'HMAC-SHA256(salt, normalised number)',
    numbers: [...callable].map(h),
    opted_out: [...stopped].map(h),
    no_record: [...noRecord].map(h),
    send_when: 'the number is in numbers or opted_out',
  };
}

/** The phone reports itself: what it is, what it may do, how setup went. */
export async function deviceHeartbeat(ctx, body = {}) {
  const info = body.info || {};
  const before = ctx.device.dialler_package;
  const dialler = info.dialler_package ? String(info.dialler_package).slice(0, 120) : before;
  await query(
    `UPDATE crm_call_devices SET maker = COALESCE($2, maker), model = COALESCE($3, model), android_version = COALESCE($4, android_version),
            app_version = COALESCE($5, app_version), dialler_package = COALESCE($6, dialler_package), permissions = COALESCE($7, permissions),
            folder_chosen = COALESCE($8, folder_chosen), work_sim = COALESCE($9, work_sim), setup = COALESCE($10, setup),
            last_error = $11, last_seen_at = now(), updated_at = now()
      WHERE id = $1`,
    [ctx.device.id, info.maker ?? null, info.model ?? null, info.android_version ?? null, info.app_version ?? null, dialler,
      body.permissions ? JSON.stringify(body.permissions) : null, typeof body.folder_chosen === 'boolean' ? body.folder_chosen : null,
      body.work_sim ? String(body.work_sim).slice(0, 80) : null, body.setup ? JSON.stringify(body.setup) : null,
      body.last_error ? String(body.last_error).slice(0, 300) : null],
  );
  if (before && dialler && before !== dialler) {
    await addWarning(ctx.device.id, 'DIALLER_CHANGED', `The default dialler changed from ${before} to ${dialler}`, ctx.user.id);
  }
  const fresh = (await query('SELECT * FROM crm_call_devices WHERE id = $1', [ctx.device.id])).rows[0];
  return deviceConfig({ ...ctx, device: fresh });
}

/** Adds a warning to a phone, telling the person and administrators at most once a day per kind. */
async function addWarning(deviceId, code, text, userId) {
  const { rows } = await query('SELECT warnings FROM crm_call_devices WHERE id = $1', [deviceId]);
  const list = Array.isArray(rows[0]?.warnings) ? rows[0].warnings : [];
  const today = localDate();
  const existing = list.find((w) => w.code === code);
  if (existing?.day === today) return false;
  const next = [...list.filter((w) => w.code !== code), { code, text, day: today, at: new Date().toISOString() }].slice(-10);
  await query('UPDATE crm_call_devices SET warnings = $2 WHERE id = $1', [deviceId, JSON.stringify(next)]);
  const people = new Set([userId, ...(await crmAdmins()).map((a) => a.id)].filter(Boolean));
  for (const id of people) await notify(null, { userId: id, type: 'crm_calling', title: `Phone #${deviceId}: ${text}` });
  return true;
}

// ---------------------------------------------------------------- the call log

/** The lead, or the organization's contact, a number belongs to, within what the person may see. */
async function matchInScope(client, scope, number) {
  const p1 = [number];
  const push1 = (v) => { p1.push(v); return `$${p1.length}`; };
  const { rows: contacts } = await client.query(
    `SELECT c.id AS contact_id, c.account_id,
            (SELECT o.id FROM opportunities o WHERE o.account_id = c.account_id AND o.status = 'ACTIVE' AND o.is_archived = FALSE
               ORDER BY (o.id = a.primary_opportunity_id) DESC, o.updated_at DESC LIMIT 1) AS opportunity_id, a.owner_user_id
       FROM account_contacts c JOIN accounts a ON a.id = c.account_id
      WHERE c.phone_normalized = $1 AND c.is_active = TRUE AND a.is_archived = FALSE AND ${scopeCondition(scope, 'account', 'a', push1)}
      ORDER BY c.is_primary DESC, c.id LIMIT 1`, p1,
  );
  if (contacts[0]) return { accountId: contacts[0].account_id, contactId: contacts[0].contact_id, opportunityId: contacts[0].opportunity_id, ownerId: contacts[0].owner_user_id };
  const p2 = [number];
  const push2 = (v) => { p2.push(v); return `$${p2.length}`; };
  const { rows: leads } = await client.query(
    `SELECT l.id, l.owner_user_id FROM crm_leads l
      WHERE l.phone_normalized = $1 AND l.merged_into_id IS NULL AND ${scopeCondition(scope, 'lead', 'l', push2)}
      ORDER BY (l.status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED','NURTURE')) DESC, l.captured_at DESC LIMIT 1`, p2,
  );
  if (leads[0]) return { leadId: leads[0].id, ownerId: leads[0].owner_user_id };
  return null;
}

const statusOf = (type, duration) => {
  const talked = duration > 0;
  if (type === 'OUTGOING') return { direction: 'OUTBOUND', status: talked ? 'COMPLETED' : 'NO_ANSWER', connected: talked };
  if (type === 'INCOMING') return { direction: 'INBOUND', status: talked ? 'COMPLETED' : 'NO_ANSWER', connected: talked };
  return { direction: 'INBOUND', status: 'NO_ANSWER', connected: false };
};

/** A missed call from a lead (or contact) becomes a "Call back" for its owner, once. */
async function missedCallFollowUp(client, call, match, number) {
  const ownerId = match.ownerId || call.agent_user_id;
  if (!ownerId) return null;
  const leadCond = call.lead_id ? 't.crm_lead_id = $1' : 't.account_id = $1';
  const { rows: open } = await client.query(
    `SELECT t.id FROM tasks t WHERE ${leadCond} AND t.followup_kind = 'CALLBACK' AND t.completed_at IS NULL AND t.is_archived = FALSE
        AND t.crm_cancel_reason IS NULL LIMIT 1`, [call.lead_id || call.account_id],
  );
  if (open[0]) return null;
  const { rows: oo } = await client.query(`SELECT 1 FROM crm_optouts WHERE channel = 'CALL' AND address = $1 AND lifted_at IS NULL`, [number]);
  const title = oo[0] ? 'Opted out earlier: they called you. Call back only because they called.' : 'Missed call: call them back';
  const task = await createFollowUp(client, {
    leadId: call.lead_id, accountId: call.lead_id ? null : call.account_id, opportunityId: call.lead_id ? null : call.opportunity_id,
    kind: 'CALLBACK', title, dueAt: new Date(Date.now() + 60_000).toISOString(), assigneeId: ownerId, priority: 'HIGH',
    notes: `Missed call at ${new Date(call.started_at).toISOString()}`, actor: null, origin: 'SYSTEM',
  });
  return task.id;
}

/** One call-log entry, in its own transaction. */
async function ingestEntry(ctx, scope, entry, now) {
  const type = ENTRY_TYPES.includes(String(entry.type || '').toUpperCase()) ? String(entry.type).toUpperCase() : 'OTHER';
  const started = new Date(entry.started_at);
  if (Number.isNaN(started.getTime())) return { status: 'REFUSED', reason: 'NO_TIME' };
  if (started.getTime() > now.getTime() + 5 * 60_000) return { status: 'REFUSED', reason: 'IN_THE_FUTURE' };
  if (ctx.ended && started > new Date(ctx.session.ended_at)) return { status: 'REFUSED', reason: 'SIGNED_OUT' };
  const duration = Math.max(0, Math.min(86_400, Math.round(Number(entry.duration_sec) || 0)));
  const number = normalizePhone(entry.number);
  if (!number) return { status: 'REFUSED', reason: 'NO_NUMBER' };
  const key = `${ctx.device.id}:${String(entry.log_id).slice(0, 80)}:${Math.floor(started.getTime() / 1000)}`;
  const shape = statusOf(type, duration);

  return withTransaction(async (client) => {
    const { rows: dup } = await client.query('SELECT id FROM crm_calls WHERE device_log_key = $1', [key]);
    if (dup[0]) return { status: 'DUPLICATE', call_id: dup[0].id };

    // the call this entry describes, when it was started from TaskFlow or typed in by hand
    let target = null;
    if (entry.call_id) {
      const { rows } = await client.query('SELECT * FROM crm_calls WHERE id = $1 FOR UPDATE', [Number(entry.call_id)]);
      const c = rows[0];
      if (c && c.agent_user_id === ctx.user.id && c.counterpart_normalized === number && !c.device_log_key) target = c;
    }
    if (!target && shape.direction === 'OUTBOUND') {
      const { rows } = await client.query(
        `SELECT * FROM crm_calls
          WHERE agent_user_id = $1 AND counterpart_normalized = $2 AND device_log_key IS NULL AND direction = 'OUTBOUND' AND voided_at IS NULL
            AND provider IN ('device', 'manual')
            AND COALESCE(dialled_at, started_at, created_at) BETWEEN $3::timestamptz - make_interval(mins => $4) AND $3::timestamptz + make_interval(mins => $4)
          ORDER BY abs(extract(epoch FROM COALESCE(dialled_at, started_at, created_at) - $3::timestamptz)) LIMIT 1 FOR UPDATE`,
        [ctx.user.id, number, started, ATTACH_WINDOW_MIN],
      );
      target = rows[0] || null;
    }
    let match = null;
    if (!target) {
      match = await matchInScope(client, scope, number);
      // not a lead or contact this person may see: nothing is stored
      if (!match) return { status: 'REFUSED', reason: 'NOT_A_LEAD' };
    }

    let call;
    if (target) {
      const fromPhone = target.provider === 'device';
      const { rows } = await client.query(
        `UPDATE crm_calls SET device_log_key = $2, device_id = $3, sim_label = $4, connected = $5,
                started_at = CASE WHEN $6 THEN $7 ELSE started_at END,
                status = CASE WHEN $6 THEN $8 ELSE status END,
                last_event_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [target.id, key, ctx.device.id, entry.sim ? String(entry.sim).slice(0, 80) : null, shape.connected, fromPhone, started, shape.status],
      );
      call = rows[0];
    } else {
      const { rows } = await client.query(
        `INSERT INTO crm_calls (provider, direction, status, from_number, to_number, counterpart_normalized, agent_user_id, lead_id, account_id,
                                contact_id, opportunity_id, started_at, device_id, device_log_key, sim_label, recorded_via, connected, created_by, last_event_at)
         VALUES ('device', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'DEVICE_SYNC', $15, $6, now()) RETURNING *`,
        [shape.direction, shape.status, shape.direction === 'INBOUND' ? number : null, shape.direction === 'OUTBOUND' ? number : null, number,
          ctx.user.id, match.leadId ?? null, match.accountId ?? null, match.contactId ?? null, match.opportunityId ?? null, started,
          ctx.device.id, key, entry.sim ? String(entry.sim).slice(0, 80) : null, shape.connected],
      );
      call = rows[0];
    }
    await applyLength(client, call.id, duration, 'DEVICE_LOG');
    call = (await client.query('SELECT * FROM crm_calls WHERE id = $1', [call.id])).rows[0];
    if (shape.direction === 'OUTBOUND') await countAttemptOnce(client, call);
    await refreshCallTimeline(client, call, ctx.user.id);
    let followUp = null;
    if (!shape.connected && shape.direction === 'INBOUND' && ['MISSED', 'REJECTED', 'INCOMING'].includes(type)) {
      // the call is kept even if its call-back cannot be filed (no department set, owner switched off…)
      await client.query('SAVEPOINT missed_call');
      try {
        followUp = await missedCallFollowUp(client, call, match || {}, number);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT missed_call');
        followUp = { error: err.message };
      }
    }
    return { status: target ? 'ATTACHED' : 'CREATED', call_id: call.id, follow_up_id: followUp };
  });
}

/** A batch of call-log entries from the phone. Each is handled on its own; one failing never stops the rest. */
export async function ingestCallLog(ctx, entries = [], now = new Date()) {
  const settings = await salesSettings();
  if (settings.calls?.deviceSync === false) throw conflict('Sending calls from phones is switched off in Settings → Calling', { code: 'SYNC_OFF' });
  const policy = await policyStatus(ctx.user.id, settings);
  if (!policy.acknowledged) throw conflict('Read and accept the company phone policy in the app first', { code: 'POLICY_NOT_ACKNOWLEDGED', version: policy.version });
  if (!Array.isArray(entries) || entries.length > 200) throw badRequest('Send between 1 and 200 entries at a time');
  const scope = await crmScope(ctx.user);
  const results = [];
  for (const entry of entries) {
    try {
      results.push({ log_id: entry.log_id, ...(await ingestEntry(ctx, scope, entry, now)) });
    } catch (err) {
      results.push({ log_id: entry.log_id, status: 'FAILED', reason: err.status ? err.message : 'Not processed' });
      if (!err.status) console.error('[taskflow] call log entry failed:', err.message);
    }
  }
  await query('UPDATE crm_call_devices SET last_sync_at = now(), last_error = NULL WHERE id = $1', [ctx.device.id]);
  await checkMissingRecordings(ctx);
  return { results };
}

/**
 * Three connected calls in a row with no recording, on a phone whose dialler
 * should save one, while recordings are on: usually auto-record was switched
 * off, Wi-Fi Calling was switched on, or ODialer stopped being the default.
 */
export async function checkMissingRecordings(ctx) {
  const settings = await salesSettings();
  if (settings.calls?.deviceRecordings !== true) return false;
  const mode = await recordingModeFor(ctx.device.dialler_package);
  if (mode.mode !== 'AUTOMATIC') return false;
  const { rows } = await query(
    `SELECT c.id, EXISTS (SELECT 1 FROM crm_call_recordings r WHERE r.call_id = c.id) AS has_recording,
            (c.no_recording OR COALESCE(l.do_not_record, FALSE) OR COALESCE(ac.do_not_record, FALSE)) AS objected
       FROM crm_calls c LEFT JOIN crm_leads l ON l.id = c.lead_id LEFT JOIN account_contacts ac ON ac.id = c.contact_id
      WHERE c.device_id = $1 AND c.connected = TRUE AND COALESCE(c.started_at, c.created_at) < now() - interval '30 minutes'
      ORDER BY COALESCE(c.started_at, c.created_at) DESC LIMIT 3`,
    [ctx.device.id],
  );
  const counted = rows.filter((r) => !r.objected);
  if (counted.length === 3 && counted.every((r) => !r.has_recording)) {
    return addWarning(ctx.device.id, 'NO_RECORDINGS', 'the last 3 connected calls had no recording', ctx.user.id);
  }
  return false;
}

/** A recording file sent by the app for one of its calls. */
export async function deviceRecording(ctx, { callId = null, logKey = null, filePath, originalName }) {
  let call = null;
  if (callId) call = (await query('SELECT id, agent_user_id, device_id, started_at FROM crm_calls WHERE id = $1', [callId])).rows[0];
  else if (logKey) call = (await query('SELECT id, agent_user_id, device_id, started_at FROM crm_calls WHERE device_log_key = $1', [`${ctx.device.id}:${logKey}`])).rows[0];
  if (!call || call.agent_user_id !== ctx.user.id) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw notFound('That call was not sent from this phone');
  }
  if (ctx.ended && call.started_at && new Date(call.started_at) > new Date(ctx.session.ended_at)) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw conflict('This phone was signed out before that call', { code: 'SIGNED_OUT' });
  }
  return storeRecording({ callId: call.id, filePath, originalName, source: 'DEVICE_SYNC', userId: ctx.user.id, deviceId: ctx.device.id });
}

// ---------------------------------------------------------------- administrators

/** Every company phone, what it is, who is signed in, and anything wrong with it. */
export async function listDevices() {
  const { rows } = await query(
    `SELECT d.*, u.full_name AS signed_in_name, rb.full_name AS revoked_by_name,
            (SELECT COUNT(*)::int FROM crm_call_recordings r WHERE r.device_id = d.id AND r.created_at > now() - interval '7 days') AS recordings_7_days,
            (SELECT COUNT(*)::int FROM crm_calls c WHERE c.device_id = d.id AND c.created_at > now() - interval '7 days') AS calls_7_days
       FROM crm_call_devices d LEFT JOIN users u ON u.id = d.signed_in_user_id LEFT JOIN users rb ON rb.id = d.revoked_by
      ORDER BY d.revoked_at NULLS FIRST, d.last_seen_at DESC NULLS LAST, d.id`,
  );
  const settings = await salesSettings();
  const out = [];
  for (const d of rows) {
    const mode = await recordingModeFor(d.dialler_package);
    const policy = d.signed_in_user_id ? await policyStatus(d.signed_in_user_id, settings) : null;
    out.push({
      ...d,
      recording_mode: mode,
      policy_acknowledged: policy?.acknowledged ?? null,
      not_synced_for_a_day: Boolean(d.signed_in_user_id) && (!d.last_sync_at || Date.now() - new Date(d.last_sync_at).getTime() > 86_400_000),
    });
  }
  const { rows: modes } = await query(
    `SELECT m.*, u.full_name AS confirmed_by_name FROM crm_dialler_modes m LEFT JOIN users u ON u.id = m.confirmed_by ORDER BY m.package`,
  );
  return { devices: out, dialler_modes: modes, expected_modes: EXPECTED_MODES };
}

/** "Hand this phone to someone else": the current sign-in ends; calls before stay with that person. */
export async function handOverDevice(deviceId, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_call_devices WHERE id = $1 FOR UPDATE', [deviceId]);
    if (!rows[0]) throw notFound('Phone not found');
    await client.query(`UPDATE crm_call_device_sessions SET ended_at = now(), end_reason = 'HANDED_OVER', ended_by = $2 WHERE device_id = $1 AND ended_at IS NULL`, [deviceId, actor.id]);
    await client.query('UPDATE crm_call_devices SET signed_in_user_id = NULL, warnings = \'[]\'::jsonb, updated_at = now() WHERE id = $1', [deviceId]);
    await recordAuditEvent(client, { action: 'PHONE_HANDED_OVER', entityType: 'DEVICE', entityId: deviceId, actorId: actor.id, detail: { from_user_id: rows[0].signed_in_user_id } });
    return { handed_over: true };
  });
}

/** Blocks a phone (its sign-ins end and nothing more is accepted from it), or allows it again. */
export async function revokeDevice(deviceId, { reason = null }, actor, { restore = false } = {}) {
  const why = String(reason || '').trim();
  if (!restore && why.length < 3) throw badRequest('Say why the phone is blocked (for example, "lost on 12 Nov")');
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_call_devices WHERE id = $1 FOR UPDATE', [deviceId]);
    if (!rows[0]) throw notFound('Phone not found');
    if (restore) {
      await client.query('UPDATE crm_call_devices SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL, updated_at = now() WHERE id = $1', [deviceId]);
    } else {
      await client.query(`UPDATE crm_call_device_sessions SET ended_at = COALESCE(ended_at, now()), end_reason = 'REVOKED', ended_by = $2 WHERE device_id = $1 AND (ended_at IS NULL OR end_reason <> 'REVOKED')`, [deviceId, actor.id]);
      await client.query('UPDATE crm_call_devices SET revoked_at = now(), revoked_by = $2, revoke_reason = $3, signed_in_user_id = NULL, updated_at = now() WHERE id = $1', [deviceId, actor.id, why.slice(0, 300)]);
    }
    await recordAuditEvent(client, { action: restore ? 'PHONE_ALLOWED' : 'PHONE_BLOCKED', entityType: 'DEVICE', entityId: deviceId, actorId: actor.id, summary: why || null });
    return { revoked: !restore };
  });
}

/** Names a phone ("Sales phone 3") so administrators can tell them apart. */
export async function labelDevice(deviceId, label, actor) {
  const { rowCount } = await query('UPDATE crm_call_devices SET asset_label = $2, updated_at = now() WHERE id = $1', [deviceId, String(label || '').trim().slice(0, 80) || null]);
  if (!rowCount) throw notFound('Phone not found');
  await recordAuditEvent(null, { action: 'PHONE_LABELLED', entityType: 'DEVICE', entityId: deviceId, actorId: actor.id, summary: label || null });
  return { labelled: true };
}

// ---------------------------------------------------------------- the app itself

const appKey = () => crypto.createHmac('sha256', config.auth.jwtSecret).update('taskflow:android-app').digest('hex');
const APP_DIR = 'android-app';

/** An administrator uploads a new release of the Android app (an APK). */
export async function saveAppRelease({ filePath, originalName, version, notes = null }, actor) {
  try {
    if (!/\.apk$/i.test(String(originalName || ''))) throw badRequest('Upload the Android app file (.apk)');
    if (!/^\d+\.\d+(\.\d+)?$/.test(String(version || ''))) throw badRequest('Give the version, for example 1.0.0');
    const buf = await fsp.readFile(filePath);
    if (buf.subarray(0, 2).toString('latin1') !== 'PK') throw badRequest('That file is not an Android app');
    const stored = path.join(APP_DIR, `taskflow-${version}-${crypto.randomBytes(4).toString('hex')}.apk`);
    await fsp.mkdir(path.join(uploadDir, APP_DIR), { recursive: true });
    await fsp.rename(filePath, path.join(uploadDir, stored));
    const { getSettings, updateSetting } = await import('../settings.js');
    const all = await getSettings();
    const sales = all.crm?.sales || {};
    const release = { version, notes: notes ? String(notes).slice(0, 1000) : null, file: stored, uploadedAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    await updateSetting('crm', { ...all.crm, sales: { ...sales, calls: { ...(sales.calls || {}), appRelease: release } } }, actor.id);
    await recordAuditEvent(null, { action: 'ANDROID_APP_RELEASED', entityType: 'SETTINGS', actorId: actor.id, summary: version, detail: { sha256: release.sha256 } });
    return release;
  } finally {
    await fsp.rm(filePath, { force: true }).catch(() => {});
  }
}

/** A download link for the current app, valid for 30 minutes. */
export async function appLink() {
  const release = (await salesSettings()).calls?.appRelease;
  if (!release?.file) return { version: null, url: null };
  const token = jwt.sign({ k: 'apk', f: release.file }, appKey(), { expiresIn: '30m' });
  return { version: release.version, notes: release.notes, sha256: release.sha256, url: `${config.apiPrefix}/s/app/${token}` };
}

export async function sendApp(token, res, next) {
  let p;
  try { p = jwt.verify(String(token), appKey()); } catch { throw notFound('This download link has expired; ask TaskFlow for a new one'); }
  if (p.k !== 'apk' || !String(p.f).startsWith(`${APP_DIR}${path.sep}`)) throw notFound('Not found');
  const file = path.resolve(uploadDir, p.f);
  if (!file.startsWith(path.resolve(uploadDir, APP_DIR) + path.sep)) throw notFound('Not found');
  res.set({ 'Content-Type': 'application/vnd.android.package-archive', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${path.basename(file).replace(/-[0-9a-f]{8}\.apk$/, '.apk')}"` });
  res.sendFile(file, (err) => { if (err && !res.headersSent) next(notFound('That version of the app is no longer kept')); });
}
