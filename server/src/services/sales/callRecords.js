/**
 * Calls as records: each has one id, is recorded once however many times its
 * form is submitted, can be opened and corrected without becoming a second
 * call, and can be marked as an accidental repeat after a person has reviewed
 * it — kept and shown, just not counted.
 *
 *   submissions   a form sends a request id; the same id again returns the
 *                 first answer instead of recording another call
 *   edits         the note or length changed afterwards, with what it said
 *                 before, by whom and why; the call count does not move
 *   void/restore  "accidental repeat", with a reason; undoable
 *   review        a read-only list of suspected repeats for people to judge:
 *                 never deletes or merges anything
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { recordAuditEvent } from '../audit.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * Claims a submission inside the caller's transaction. Returns null when no
 * request id was sent, { fresh: true } the first time, and { previous } when
 * the same person already sent this one (a second, concurrent submission
 * waits for the first to finish, then sees it).
 */
export async function claimSubmission(client, userId, requestId, kind, leadId = null) {
  if (requestId === undefined || requestId === null || requestId === '') return null;
  if (!REQUEST_ID.test(String(requestId))) throw badRequest('The form sent an unusable request id; reload the page and try again');
  const { rows } = await client.query(
    `INSERT INTO crm_submissions (user_id, request_id, kind, lead_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, request_id) DO NOTHING RETURNING *`,
    [userId, requestId, kind, leadId],
  );
  if (rows[0]) return { fresh: true };
  const { rows: prev } = await client.query('SELECT * FROM crm_submissions WHERE user_id = $1 AND request_id = $2', [userId, requestId]);
  if (prev[0].kind !== kind) throw conflict('That request id was used for something else');
  return { previous: prev[0] };
}

/** Stores what a submission produced, so a repeat can be answered with it. */
export async function settleSubmission(client, userId, requestId, { callId = null, response = null }) {
  if (!requestId) return;
  await client.query(
    'UPDATE crm_submissions SET call_id = $3, response = $4 WHERE user_id = $1 AND request_id = $2',
    [userId, requestId, callId, response === null ? null : JSON.stringify(response)],
  );
}

// ---------------------------------------------------------------- reading

export const CALL_SELECT = `
  SELECT c.*, u.full_name AS agent_name, e.full_name AS edited_by_name, v.full_name AS voided_by_name,
         l.ref AS lead_ref, COALESCE(l.organization_name, l.contact_name) AS lead_name, (c.recording_ref IS NOT NULL) AS has_recording
    FROM crm_calls c
    LEFT JOIN users u ON u.id = c.agent_user_id
    LEFT JOIN users e ON e.id = c.edited_by
    LEFT JOIN users v ON v.id = c.voided_by
    LEFT JOIN crm_leads l ON l.id = c.lead_id`;

const shape = (c) => (c ? { ...c, recording_ref: undefined, counted: !c.voided_at } : c);

export async function callById(id, runner = { query }) {
  const { rows } = await runner.query(`${CALL_SELECT} WHERE c.id = $1`, [id]);
  return shape(rows[0] || null);
}

/** One call with everything about it: its edits, its timeline entries and the follow-ups it touched. */
export async function callDetail(id) {
  const call = await callById(id);
  if (!call) throw notFound('Call not found');
  const [edits, timeline, followups] = await Promise.all([
    query(`SELECT e.*, u.full_name AS edited_by_name FROM crm_call_edits e LEFT JOIN users u ON u.id = e.edited_by WHERE e.call_id = $1 ORDER BY e.edited_at, e.id`, [id]),
    query(`SELECT id, type, subject, occurred_at, created_at FROM crm_lead_activities WHERE call_id = $1 ORDER BY id`, [id]),
    query(`SELECT t.id, t.title, t.followup_kind, t.due_date, t.completed_at, t.followup_outcome FROM tasks t
            WHERE t.id = $2 OR (t.crm_lead_id = $3 AND t.completion_call_id = $1) ORDER BY t.id`,
    [id, call.follow_up_task_id ?? 0, call.lead_id ?? 0]),
  ]);
  return { call, edits: edits.rows, timeline: timeline.rows, followups: followups.rows };
}

/** The calls on a lead, newest first, each with its id; repeats marked as such are listed and flagged. */
export async function leadCalls(leadId) {
  const { rows } = await query(`${CALL_SELECT} WHERE c.lead_id = $1 ORDER BY COALESCE(c.started_at, c.created_at) DESC, c.id DESC`, [leadId]);
  return rows.map(shape);
}

// ---------------------------------------------------------------- correcting

function mayCorrect(actor, call) {
  return call.agent_user_id === actor.id || call.created_by === actor.id
    || hasPermission(actor, 'crm.manage.any') || hasPermission(actor, 'crm.assign');
}

/**
 * Corrects a call's note or length. The call keeps its id and count; every
 * change is kept with what it said before. The timeline entry shows the
 * corrected note and says it was edited.
 */
export async function editCall(id, { notes, durationSec, reason = null }, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_calls WHERE id = $1 FOR UPDATE', [id]);
    const call = rows[0];
    if (!call) throw notFound('Call not found');
    if (!mayCorrect(actor, call)) throw forbidden('Only the person who made the call, or someone who manages leads, can correct it');
    if (call.voided_at) throw conflict('This call was marked as an accidental repeat; restore it first');
    const changes = [];
    if (notes !== undefined) {
      const next = notes === null ? null : String(notes).trim().slice(0, 5000) || null;
      if (next !== (call.notes || null)) changes.push(['notes', call.notes, next]);
    }
    if (durationSec !== undefined) {
      const next = durationSec === null ? null : Math.max(0, Math.round(Number(durationSec)));
      if (next !== null && !Number.isFinite(next)) throw badRequest('Give the length in seconds');
      if (next !== call.duration_sec) changes.push(['duration_sec', call.duration_sec, next]);
    }
    if (!changes.length) return { call: await callById(id, client), changed: false };
    for (const [field, before, after] of changes) {
      await client.query(
        'INSERT INTO crm_call_edits (call_id, field, before, after, reason, edited_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, field, before === null || before === undefined ? null : String(before), after === null ? null : String(after), reason ? String(reason).slice(0, 500) : null, actor.id],
      );
    }
    const notesChange = changes.find(([f]) => f === 'notes');
    const durChange = changes.find(([f]) => f === 'duration_sec');
    await client.query(
      `UPDATE crm_calls SET notes = CASE WHEN $2 THEN $3 ELSE notes END,
              duration_sec = CASE WHEN $4 THEN $5::int ELSE duration_sec END,
              ended_at = CASE WHEN $4 AND $5::int IS NOT NULL AND started_at IS NOT NULL THEN started_at + make_interval(secs => $5::int) ELSE ended_at END,
              edited_at = now(), edited_by = $6, edit_count = edit_count + 1, updated_at = now()
        WHERE id = $1`,
      [id, Boolean(notesChange), notesChange?.[2] ?? null, Boolean(durChange), durChange?.[2] ?? null, actor.id],
    );
    // the timeline shows the call as it now reads; the edit history keeps the earlier wording
    if (notesChange) {
      await client.query(
        `UPDATE crm_lead_activities SET body = $2, meta = meta || jsonb_build_object('edited_at', now(), 'edit_count', $3::int) WHERE call_id = $1 AND type = 'CALL'`,
        [id, notesChange[2], call.edit_count + 1],
      );
      await client.query('UPDATE account_activities SET body = $2 WHERE call_id = $1', [id, notesChange[2]]);
    }
    await recordAuditEvent(client, { action: 'CALL_EDITED', entityType: 'CALL', entityId: id, actorId: actor.id, summary: changes.map(([f]) => f).join(', '), detail: { changes, reason } });
    return { call: await callById(id, client), changed: true };
  });
}

/**
 * Marks a call as an accidental repeat after a person has looked at it. It
 * stays on the lead, struck through, with who did it and why; it stops being
 * counted, and the lead's attempt count drops by one. Restoring undoes both.
 */
export async function voidCall(id, { reason }, actor, { restore = false } = {}) {
  if (!hasPermission(actor, 'crm.audit') && !hasPermission(actor, 'crm.assign')) throw forbidden('Marking a call as a repeat needs the audit or assign permission');
  const why = String(reason || '').trim();
  if (!restore && why.length < 3) throw badRequest('Say why this call is a repeat (for example, "same call saved twice at 17:15")');
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_calls WHERE id = $1 FOR UPDATE', [id]);
    const call = rows[0];
    if (!call) throw notFound('Call not found');
    if (!restore && call.voided_at) return { call: await callById(id, client), changed: false };
    if (restore && !call.voided_at) return { call: await callById(id, client), changed: false };
    await client.query(
      restore
        ? 'UPDATE crm_calls SET voided_at = NULL, voided_by = NULL, void_reason = NULL, updated_at = now() WHERE id = $1'
        : 'UPDATE crm_calls SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now() WHERE id = $1',
      restore ? [id] : [id, actor.id, why.slice(0, 500)],
    );
    await client.query(
      'INSERT INTO crm_call_edits (call_id, field, before, after, reason, edited_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, 'counted', restore ? 'no' : 'yes', restore ? 'yes' : 'no', restore ? (why || 'Restored') : why, actor.id],
    );
    await client.query(
      `UPDATE crm_lead_activities SET meta = meta || jsonb_build_object('voided', $2::boolean) WHERE call_id = $1 AND type = 'CALL'`,
      [id, !restore],
    );
    if (call.lead_id && call.direction === 'OUTBOUND') {
      await client.query(
        `UPDATE crm_leads SET call_attempts = GREATEST(call_attempts + $2, 0), updated_at = now() WHERE id = $1`,
        [call.lead_id, restore ? 1 : -1],
      );
    }
    await recordAuditEvent(client, { action: restore ? 'CALL_RESTORED' : 'CALL_VOIDED', entityType: 'CALL', entityId: id, actorId: actor.id, summary: why || null });
    return { call: await callById(id, client), changed: true };
  });
}

// ---------------------------------------------------------------- reviewing suspected repeats

const fingerprint = (text) => (text ? crypto.createHash('sha256').update(String(text).trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 10) : null);

/**
 * Every call entry on some leads (or since a date), and the groups that look
 * like repeats: the same lead and person within a short window. Read only:
 * runs inside the caller's (read-only) transaction or on its own, and never
 * changes, merges or deletes anything.
 *
 *   entries  calls (with their id), timeline "call" entries with no call
 *            record, and completed Call follow-ups
 *   groups   LIKELY_ACCIDENTAL (same outcome and note, seconds apart),
 *            DIFFERENT_NOTES (a correction saved as a new call, most likely),
 *            NEEDS_A_PERSON (anything else)
 */
export async function callReview({ leadIds = null, since = null, windowSeconds = 120 } = {}, runner = { query }) {
  if (!leadIds?.length && !since) throw badRequest('Name the leads, or a date to start from');
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const leadFilter = leadIds?.length ? `lead_id = ANY(${push(leadIds.map(Number))}::int[])` : 'TRUE';
  const sinceFilter = since ? push(since) : null;
  const { rows: calls } = await runner.query(
    `SELECT c.id, c.lead_id, c.agent_user_id, u.full_name AS agent_name, c.direction, c.status, c.outcome, c.duration_sec, c.notes,
            c.started_at, c.created_at, c.provider, c.logged_manually, c.recorded_via, c.request_id, c.follow_up_task_id, c.voided_at, c.edit_count
       FROM crm_calls c LEFT JOIN users u ON u.id = c.agent_user_id
      WHERE c.lead_id IS NOT NULL AND ${leadFilter.replace('lead_id', 'c.lead_id')} ${sinceFilter ? `AND c.created_at >= ${sinceFilter}::date` : ''}
      ORDER BY c.lead_id, c.created_at, c.id`,
    params,
  );
  const { rows: bare } = await runner.query(
    `SELECT a.id AS activity_id, a.lead_id, a.actor_id AS agent_user_id, u.full_name AS agent_name, a.outcome, a.subject, a.body AS notes,
            a.occurred_at AS started_at, a.created_at, a.task_id
       FROM crm_lead_activities a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.type = 'CALL' AND a.call_id IS NULL AND ${leadFilter.replace('lead_id', 'a.lead_id')} ${sinceFilter ? `AND a.created_at >= ${sinceFilter}::date` : ''}
      ORDER BY a.lead_id, a.created_at, a.id`,
    params,
  );
  const entries = [
    ...calls.map((c) => ({
      kind: 'CALL', call_id: c.id, lead_id: c.lead_id, agent_user_id: c.agent_user_id, agent_name: c.agent_name, outcome: c.outcome || c.status,
      duration_sec: c.duration_sec, notes_fingerprint: fingerprint(c.notes), notes_preview: c.notes ? String(c.notes).slice(0, 80) : null,
      started_at: c.started_at, created_at: c.created_at,
      recorded_via: c.recorded_via || (c.provider !== 'manual' ? `PROVIDER:${c.provider}` : 'UNKNOWN (before this release)'),
      request_id: c.request_id, follow_up_task_id: c.follow_up_task_id, counted: !c.voided_at, edit_count: c.edit_count,
    })),
    ...bare.map((a) => ({
      kind: 'TIMELINE_ONLY', call_id: null, activity_id: a.activity_id, lead_id: a.lead_id, agent_user_id: a.agent_user_id, agent_name: a.agent_name,
      outcome: a.outcome, notes_fingerprint: fingerprint(a.notes), notes_preview: a.notes ? String(a.notes).slice(0, 80) : null,
      started_at: a.started_at, created_at: a.created_at, recorded_via: a.task_id ? 'FOLLOWUP_COMPLETED (no call record)' : 'TIMELINE_ACTIVITY (no call record)',
      task_id: a.task_id, counted: false,
    })),
  ].sort((a, b) => a.lead_id - b.lead_id || new Date(a.created_at) - new Date(b.created_at));

  const groups = [];
  let current = null;
  for (const e of entries) {
    const near = current && current.lead_id === e.lead_id && current.agent_user_id === e.agent_user_id
      && (new Date(e.created_at) - new Date(current.entries[current.entries.length - 1].created_at)) / 1000 <= windowSeconds;
    if (near) current.entries.push(e);
    else {
      if (current?.entries.length > 1) groups.push(current);
      current = { lead_id: e.lead_id, agent_user_id: e.agent_user_id, entries: [e] };
    }
  }
  if (current?.entries.length > 1) groups.push(current);
  for (const g of groups) {
    const counted = g.entries.filter((e) => e.kind === 'CALL');
    const same = (k) => new Set(counted.map((e) => e[k] ?? '')).size === 1;
    const spread = (new Date(g.entries[g.entries.length - 1].created_at) - new Date(g.entries[0].created_at)) / 1000;
    g.seconds_apart = Math.round(spread * 1000) / 1000;
    g.verdict = counted.length > 1 && same('notes_fingerprint') && same('outcome') && spread <= 30 ? 'LIKELY_ACCIDENTAL'
      : counted.length > 1 && !same('notes_fingerprint') ? 'DIFFERENT_NOTES'
        : 'NEEDS_A_PERSON';
    g.advice = {
      LIKELY_ACCIDENTAL: 'The same outcome and note, seconds apart: probably one call saved more than once. A manager can mark the extra ones as accidental repeats.',
      DIFFERENT_NOTES: 'Different notes close together: probably a correction saved as a new call, or two real calls. Ask the person before changing anything.',
      NEEDS_A_PERSON: 'Mixed entries (for example a call and a completed follow-up). Look at each before changing anything.',
    }[g.verdict];
  }
  return { generated_at: new Date().toISOString(), window_seconds: windowSeconds, entries, groups, changed_nothing: true };
}
