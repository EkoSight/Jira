/**
 * Calls made on company phones, one record per call.
 *
 *   start      tapping Call creates the call first ("a session": DIALLED),
 *              after the calling rules allow it, then the phone dials
 *   describe   "How did the call go?" (or Log call on a deal) fills in that same
 *              call instead of adding another
 *   report     the Android app adds what the phone measured (phoneDevices.js)
 *   length     the best source wins: the phone's call log, then the
 *              recording's own length, then typed, then estimated; a person's
 *              later correction (callRecords.editCall) is kept as corrected
 *   close      a started call nobody described by the end of the day is closed
 *              as "Dialled, outcome not given"
 *
 * The lead's attempt count changes exactly once per call (attempt_counted),
 * whichever of the phone or the person reports it first.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { claimSubmission, settleSubmission } from './callRecords.js';
import { callPermit } from './callRules.js';
import { callOnTimeline } from './comms.js';
import { normalizePhone, salesSettings } from './core.js';

export const LENGTH_SOURCES = ['DEVICE_LOG', 'RECORDING', 'TYPED', 'ESTIMATED', 'CORRECTED'];
export const LENGTH_RANK = { ESTIMATED: 1, TYPED: 2, RECORDING: 3, DEVICE_LOG: 4, CORRECTED: 5 };

/** A stored recording on a call, for SQL lists. */
export const HAS_STORED_RECORDING = (alias = 'c') => `EXISTS (SELECT 1 FROM crm_call_recordings rr WHERE rr.call_id = ${alias}.id AND rr.deleted_at IS NULL)`;

/**
 * Sets a call's length from a source, when that source is better than the one
 * the call has. `duration_sec` follows, so every older reader sees the best
 * known length. Returns whether it changed.
 */
export async function applyLength(client, callId, seconds, source) {
  if (seconds === null || seconds === undefined || seconds === '' || !Number.isFinite(Number(seconds))) return false;
  if (!LENGTH_RANK[source]) throw new Error(`unknown length source ${source}`);
  const sec = Math.max(0, Math.round(Number(seconds)));
  const { rows } = await client.query('SELECT duration_source FROM crm_calls WHERE id = $1 FOR UPDATE', [callId]);
  const current = rows[0]?.duration_source;
  if (current && (LENGTH_RANK[current] || 0) >= LENGTH_RANK[source]) return false;
  await client.query(
    `UPDATE crm_calls SET talk_sec = $2::int, duration_sec = $2::int, duration_source = $3,
            ended_at = CASE WHEN started_at IS NOT NULL THEN started_at + make_interval(secs => $2::int) ELSE ended_at END, updated_at = now()
      WHERE id = $1`,
    [callId, sec, source],
  );
  return true;
}

/**
 * Puts a call on the lead's (or organization's) timeline once, and keeps that
 * one entry up to date as the call is described or reported.
 */
export async function refreshCallTimeline(client, call, actorId) {
  const reached = call.status === 'COMPLETED' && (call.talk_sec ?? call.duration_sec ?? 1) > 0 && !['NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'NOT_GIVEN'].includes(call.outcome);
  const minutes = call.duration_sec ? ` (${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s)` : '';
  const said = call.outcome && call.outcome !== 'NOT_GIVEN' ? call.outcome : call.status === 'DIALLED' ? 'dialled' : call.status;
  const subject = `${call.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} call${minutes}: ${String(said).toLowerCase().replace(/_/g, ' ')}`;
  if (call.lead_id) {
    const { rows } = await client.query('SELECT id FROM crm_lead_activities WHERE call_id = $1 LIMIT 1', [call.id]);
    if (rows[0]) {
      await client.query(
        'UPDATE crm_lead_activities SET subject = $2, body = $3, outcome = $4 WHERE call_id = $1',
        [call.id, subject, call.notes, reached ? 'COMPLETED' : 'ATTEMPTED'],
      );
      return;
    }
  }
  if (call.account_id) {
    await client.query('UPDATE account_activities SET subject = $2, body = $3 WHERE call_id = $1', [call.id, subject, call.notes]);
  }
  await callOnTimeline(client, call, actorId);
}

/** The number to dial for a lead or a contact when the screen did not send one. */
async function numberFor(client, { phone, leadId, contactId }) {
  if (phone) return phone;
  if (leadId) return (await client.query('SELECT phone FROM crm_leads WHERE id = $1', [leadId])).rows[0]?.phone || null;
  if (contactId) return (await client.query('SELECT phone FROM account_contacts WHERE id = $1', [contactId])).rows[0]?.phone || null;
  return null;
}

/**
 * Starts a call: checks the calling rules, then records the call as DIALLED,
 * before the phone dials. The same request id twice returns the first call.
 */
export async function startCall({
  actor, phone = null, leadId = null, accountId = null, contactId = null, opportunityId = null, via = 'DIALLER',
  requestId = null, overrideReason = null, at = new Date(),
}) {
  if (!leadId && !accountId && !contactId && !opportunityId) throw badRequest('Say which lead, organization, contact or deal the call is for');
  return withTransaction(async (client) => {
    const claim = await claimSubmission(client, actor.id, requestId, 'CALL_START', leadId);
    if (claim?.previous) return { ...(claim.previous.response || {}), duplicate: true };
    let account = accountId;
    let deal = opportunityId;
    if (leadId) {
      const { rows } = await client.query('SELECT status, merged_into_id FROM crm_leads WHERE id = $1', [leadId]);
      if (!rows[0]) throw notFound('Lead not found');
      if (rows[0].merged_into_id) throw conflict('This lead was merged into another; call from that one');
      if (rows[0].status === 'CONVERTED') throw conflict('This lead became a deal; call from the deal');
      account = null;
      deal = null;
    }
    if (deal && !account) account = (await client.query('SELECT account_id FROM opportunities WHERE id = $1', [deal])).rows[0]?.account_id ?? null;
    if (contactId) {
      const { rows } = await client.query('SELECT account_id FROM account_contacts WHERE id = $1', [contactId]);
      if (!rows[0]) throw notFound('Contact not found');
      if (account && rows[0].account_id !== account) throw badRequest('That contact belongs to a different organization');
      account = rows[0].account_id;
    }
    const number = await numberFor(client, { phone, leadId, contactId });
    const permit = await callPermit({ phone: number, leadId, overrideReason, at, runner: client });
    const { rows } = await client.query(
      `INSERT INTO crm_calls (provider, direction, status, to_number, counterpart_normalized, agent_user_id, lead_id, account_id, contact_id,
                              opportunity_id, started_at, dialled_at, created_by, request_id, recorded_via, hours_override_reason, callback_reason)
       VALUES ('device', 'OUTBOUND', 'DIALLED', $1, $2, $3, $4, $5, $6, $7, $8, $8, $3, $9, $10, $11, $12) RETURNING *`,
      [number, permit.phone, actor.id, leadId, account, contactId, deal, at, requestId || null,
        via === 'ANDROID_APP' ? 'ANDROID_APP' : 'DIALLER', permit.hoursOverrideReason, permit.callbackReason],
    );
    const call = rows[0];
    const result = {
      call: { id: call.id, dialled_at: call.dialled_at, phone: permit.phone, lead_id: leadId, account_id: account, contact_id: contactId, opportunity_id: deal },
      callback_reason: permit.callbackReason,
      hours_override_reason: permit.hoursOverrideReason,
      recording: await recordingStateFor(client, call),
    };
    await settleSubmission(client, actor.id, requestId, { callId: call.id, response: result });
    return result;
  });
}

/** Whether this call will be recorded, and the sentence to say first. */
export async function recordingStateFor(client, call) {
  const settings = await salesSettings();
  const on = settings.calls?.deviceRecordings === true;
  let objected = Boolean(call.no_recording);
  if (call.lead_id) objected = objected || Boolean((await client.query('SELECT do_not_record FROM crm_leads WHERE id = $1', [call.lead_id])).rows[0]?.do_not_record);
  if (call.contact_id) objected = objected || Boolean((await client.query('SELECT do_not_record FROM account_contacts WHERE id = $1', [call.contact_id])).rows[0]?.do_not_record);
  return { on, objected, kept: on && !objected };
}

/**
 * Fills in a started call with what the person says happened. Returns the
 * call. A second description is refused: corrections go through the call's
 * own correction (which keeps history).
 */
export async function describeCall(client, callId, { actor, outcome, notes = null, durationSec = null, durationSource = 'TYPED', leadId = null, accountId = null }) {
  const { rows } = await client.query('SELECT * FROM crm_calls WHERE id = $1 FOR UPDATE', [callId]);
  const call = rows[0];
  if (!call) throw notFound('Call not found');
  if (call.provider !== 'device') throw conflict('Only a call started from TaskFlow can be described this way');
  if (call.agent_user_id !== actor.id) throw forbidden('This call was made by someone else');
  if (leadId && call.lead_id !== leadId) throw conflict('That call was to a different lead');
  if (accountId && call.account_id && call.account_id !== accountId) throw conflict('That call was to a different organization');
  if (call.outcome_at) throw conflict(`Call #${call.id} was already described; correct it from the call instead`, { code: 'ALREADY_DESCRIBED', call_id: call.id });
  if (call.voided_at) throw conflict('This call was marked as an accidental repeat');
  // the phone's report, when there is one, stays the call's status; the person's outcome sits beside it
  const status = call.status === 'DIALLED' ? (outcome === 'NO_ANSWER' ? 'NO_ANSWER' : outcome === 'BUSY' ? 'BUSY' : 'COMPLETED') : call.status;
  await client.query(
    `UPDATE crm_calls SET outcome = $2, notes = COALESCE($3, notes), status = $4, outcome_at = now(), session_closed_at = NULL, updated_at = now()
      WHERE id = $1`,
    [callId, outcome, notes, status],
  );
  if (durationSec !== null && durationSec !== undefined) await applyLength(client, callId, durationSec, durationSource === 'ESTIMATED' ? 'ESTIMATED' : 'TYPED');
  const fresh = (await client.query('SELECT * FROM crm_calls WHERE id = $1', [callId])).rows[0];
  await refreshCallTimeline(client, fresh, actor.id);
  return fresh;
}

/**
 * The person's own started call on this lead (or organization, or deal) that
 * nobody has described yet, from the last 12 hours. A form saved without
 * naming its call fills this one in rather than adding a second record.
 */
export async function pendingCallFor(client, { actorId, leadId = null, accountId = null, opportunityId = null, hours = 12 }) {
  if (!actorId || (!leadId && !accountId && !opportunityId)) return null;
  const cond = leadId ? 'c.lead_id = $2' : opportunityId ? 'c.opportunity_id = $2' : 'c.account_id = $2';
  const { rows } = await client.query(
    `SELECT c.id FROM crm_calls c
      WHERE c.agent_user_id = $1 AND ${cond} AND c.provider = 'device' AND c.direction = 'OUTBOUND'
        AND c.outcome_at IS NULL AND c.voided_at IS NULL
        AND COALESCE(c.started_at, c.dialled_at) > now() - make_interval(hours => $3)
      ORDER BY COALESCE(c.started_at, c.dialled_at) DESC LIMIT 1 FOR UPDATE`,
    [actorId, leadId || opportunityId || accountId, hours],
  );
  return rows[0]?.id ?? null;
}

/** Counts the call on its lead's attempts if nothing has yet. Returns whether it did. */
export async function countAttemptOnce(client, call) {
  if (!call.lead_id || call.direction !== 'OUTBOUND') return false;
  const { rowCount } = await client.query('UPDATE crm_calls SET attempt_counted = TRUE WHERE id = $1 AND attempt_counted = FALSE', [call.id]);
  if (!rowCount) return false;
  const at = call.started_at || call.dialled_at || new Date();
  await client.query(
    `UPDATE crm_leads SET call_attempts = call_attempts + 1, last_called_at = GREATEST(COALESCE(last_called_at, $2), $2), updated_at = now() WHERE id = $1`,
    [call.lead_id, at],
  );
  return true;
}

const PENDING_SELECT = `
  SELECT c.id, c.direction, c.status, c.connected, c.talk_sec, c.duration_source, c.dialled_at, c.started_at, c.lead_id, c.account_id,
         c.contact_id, c.opportunity_id, c.to_number, c.from_number, c.recorded_via, c.callback_reason, c.hours_override_reason,
         l.ref AS lead_ref, COALESCE(l.organization_name, l.contact_name, a.name) AS about, ac.full_name AS contact_name,
         c.outcome, c.no_recording, (l.do_not_record IS TRUE OR ac.do_not_record IS TRUE) AS do_not_record,
         EXISTS (SELECT 1 FROM crm_call_recordings r WHERE r.call_id = c.id AND r.deleted_at IS NULL) AS has_recording
    FROM crm_calls c
    LEFT JOIN crm_leads l ON l.id = c.lead_id
    LEFT JOIN accounts a ON a.id = c.account_id
    LEFT JOIN account_contacts ac ON ac.id = c.contact_id`;

/** Calls a person started (or the phone reported) that still need "how did it go". */
export async function pendingCalls(userId) {
  const { rows } = await query(
    `${PENDING_SELECT}
      WHERE c.agent_user_id = $1 AND c.provider = 'device' AND c.outcome_at IS NULL AND c.session_closed_at IS NULL AND c.voided_at IS NULL
        AND (c.direction = 'OUTBOUND' OR c.connected = TRUE)
      ORDER BY COALESCE(c.started_at, c.dialled_at) DESC LIMIT 50`,
    [userId],
  );
  return rows;
}

/** A person's own calls of the last day, newest first: for "Which call is this?". */
export async function recentCalls(userId, { hours = 24 } = {}) {
  const { rows } = await query(
    `${PENDING_SELECT}
      WHERE c.agent_user_id = $1 AND c.voided_at IS NULL AND COALESCE(c.started_at, c.dialled_at, c.created_at) > now() - make_interval(hours => $2)
      ORDER BY COALESCE(c.started_at, c.dialled_at, c.created_at) DESC LIMIT 50`,
    [userId, hours],
  );
  return rows;
}

/** What the call panel shows while a call is going on, and after. */
export async function liveCall(callId) {
  const { rows } = await query(
    `SELECT c.id, c.status, c.connected, c.talk_sec, c.duration_source, c.dialled_at, c.started_at, c.ended_at, c.outcome, c.outcome_at,
            c.no_recording, c.agent_user_id, c.lead_id, c.account_id, c.contact_id, c.session_closed_at, c.device_id,
            r.length_sec AS recording_length_sec, (r.id IS NOT NULL) AS has_recording
       FROM crm_calls c
       LEFT JOIN crm_call_recordings r ON r.call_id = c.id AND r.deleted_at IS NULL
      WHERE c.id = $1`,
    [callId],
  );
  if (!rows[0]) throw notFound('Call not found');
  return rows[0];
}

/**
 * Started calls nobody described, from before today: closed as "Dialled,
 * outcome not given". Nothing is counted for them unless the phone reported
 * the call (that report counts it itself).
 */
export async function closeStaleSessions(now = new Date()) {
  const settings = await salesSettings();
  const tz = settings.calendar?.timezone || 'Asia/Kolkata';
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE crm_calls SET session_closed_at = $1, outcome = COALESCE(outcome, 'NOT_GIVEN'), updated_at = now()
        WHERE provider = 'device' AND outcome_at IS NULL AND session_closed_at IS NULL
          AND COALESCE(started_at, dialled_at) < date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2
        RETURNING *`,
      [now, tz],
    );
    // a call the phone reported is on the timeline already; refresh its words
    for (const call of rows) if (call.status !== 'DIALLED') await refreshCallTimeline(client, call, call.agent_user_id);
    return rows.length;
  });
}

/** Normalises a number for comparing a call with a call-log entry. */
export const sameNumber = (a, b) => {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  return Boolean(x && y && x === y);
};
