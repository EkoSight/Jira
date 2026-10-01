/**
 * Putting attendance right without rewriting history.
 *
 * An employee asks; someone else decides. Approving writes the corrected times
 * onto the session marked MANUALLY_REGULARIZED, keeps the original values in
 * the correction's `before` and in the audit log, and never invents a
 * location. A pending request stays pending — it is never treated as approved.
 */

import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { clock } from '../lib/attendanceCalc.js';
import { effectivePermissions } from '../lib/permissions.js';
import { notify } from './activity.js';
import { currentPolicy } from './attendancePolicy.js';
import {
  SESSION_COLUMNS, addDays, assertReviewer, audit, cutoffFor, dateIn, instantAt, settleMissingCheckouts,
} from './attendance.js';
import { isLocked } from './attendanceLedger.js';

export const CORRECTION_KINDS = {
  MISSED_CHECK_IN: 'Missed check-in',
  MISSED_CHECK_OUT: 'Missed check-out',
  WRONG_TIME: 'Wrong time recorded',
  TECHNICAL: 'Location or technical problem',
  FIELD_DUTY: 'Field duty / working away from office',
  REOPEN: 'Reopen today’s attendance',
};

const MAX_BACK_DAYS = 62;

/** Who can decide attendance corrections for this person. */
export async function attendanceReviewers(userId) {
  const { rows } = await query(
    `SELECT u.id, u.role, u.extra_permissions, u.revoked_permissions,
            EXISTS (SELECT 1 FROM employee_work_profiles p WHERE p.user_id = $1 AND p.reporting_manager_id = u.id) AS manages,
            EXISTS (SELECT 1 FROM attendance_team_access a JOIN users s ON s.department_id = a.department_id
                     WHERE a.manager_id = u.id AND s.id = $1) AS has_team_access
       FROM users u WHERE u.is_active AND u.id <> $1`,
    [userId],
  );
  return rows.filter((u) => {
    const perms = effectivePermissions(u);
    if (!perms.includes('attendance.approve')) return false;
    return perms.includes('attendance.all') || (perms.includes('attendance.team') && (u.manages || u.has_team_access));
  }).map((u) => u.id);
}

const snapshot = (s) => (s ? {
  status: s.status, check_in_at: s.check_in_at, check_out_at: s.check_out_at,
  check_in_source: s.check_in_source, check_out_source: s.check_out_source, regularized: s.regularized,
} : null);

/** "18:40" on a work date (optionally the next calendar day) → an instant. */
function toInstant(workDate, hhmm, nextDay, timezone) {
  if (!hhmm) return null;
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) throw badRequest('Give times as HH:MM');
  const seconds = clock(hhmm);
  if (seconds >= 86_400) throw badRequest('Give times as HH:MM within the day');
  return instantAt(nextDay ? addDays(workDate, 1) : workDate, seconds, timezone);
}

export async function getCorrection(id) {
  const { rows } = await query(
    `SELECT c.*, u.full_name, u.department_id, r.full_name AS reviewer_name
       FROM attendance_corrections c JOIN users u ON u.id = c.user_id
       LEFT JOIN users r ON r.id = c.reviewer_id
      WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Correction request not found');
  return rows[0];
}

export async function createCorrection(actor, input, now = new Date()) {
  const { config } = await currentPolicy();
  const today = dateIn(config.timezone, now);
  const workDate = input.work_date;
  const kind = input.kind;
  if (!CORRECTION_KINDS[kind]) throw badRequest('Choose what needs correcting');
  if (!workDate || workDate > today) throw badRequest('Corrections are for today or earlier');
  if (workDate < addDays(today, -MAX_BACK_DAYS)) throw badRequest(`Corrections can go back ${MAX_BACK_DAYS} days`);
  const reason = String(input.reason || '').trim();
  if (reason.length < 5) throw badRequest('Explain what happened — a sentence is enough');
  if (await isLocked(actor.id, workDate)) throw conflict('Payroll for that month is locked. Ask payroll to reopen it.');

  await settleMissingCheckouts(actor.id, now);
  const { rows: sessions } = await query(`SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = $1 AND work_date = $2`, [actor.id, workDate]);
  const session = sessions[0] || null;

  const proposedIn = toInstant(workDate, input.check_in, false, config.timezone);
  const proposedOut = toInstant(workDate, input.check_out, Boolean(input.check_out_next_day), config.timezone);

  if (kind === 'REOPEN') {
    if (!session || session.status !== 'COMPLETED' || workDate !== today) throw badRequest('Only today’s completed attendance can be reopened');
  } else if (kind === 'MISSED_CHECK_OUT') {
    if (!session) throw badRequest('There is no check-in that day — use “Missed check-in” and give both times');
    if (!proposedOut) throw badRequest('Give the time you finished');
  } else if (kind === 'WRONG_TIME') {
    if (!proposedIn && !proposedOut) throw badRequest('Give the corrected time');
  } else if (!proposedIn && !session) {
    throw badRequest('Give the time you started');
  }
  for (const [label, t] of [['start', proposedIn], ['finish', proposedOut]]) {
    if (t && t > now) throw badRequest(`The ${label} time cannot be in the future`);
  }
  const effectiveIn = proposedIn || (session?.check_in_at ? new Date(session.check_in_at) : null);
  if (proposedOut && effectiveIn && proposedOut <= effectiveIn) throw badRequest('The finish time must be after the start time');
  if (proposedOut && proposedOut > cutoffFor(workDate, config)) throw badRequest('A finish time that late belongs to the next day — tick “next day” only for times after midnight and before the cutoff');

  const { rows: pending } = await query(
    `SELECT id FROM attendance_corrections WHERE user_id = $1 AND work_date = $2 AND status = 'PENDING'`,
    [actor.id, workDate],
  );
  if (pending[0]) throw conflict('You already have a correction waiting for that day', { correction_id: pending[0].id });

  const id = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO attendance_corrections (user_id, session_id, work_date, kind, proposed_check_in, proposed_check_out, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $1) RETURNING id`,
      [actor.id, session?.id || null, workDate, kind, proposedIn, proposedOut, reason],
    );
    await audit(client, {
      entityType: 'ATTENDANCE_CORRECTION', entityId: rows[0].id, subjectUserId: actor.id, actorId: actor.id,
      action: 'REQUESTED', reason, after: { kind, work_date: workDate, proposed_check_in: proposedIn, proposed_check_out: proposedOut },
    });
    for (const reviewerId of await attendanceReviewers(actor.id)) {
      await notify(client, {
        userId: reviewerId, type: 'attendance_correction',
        title: `${actor.full_name} asked to correct attendance for ${workDate}`,
        body: CORRECTION_KINDS[kind],
      });
    }
    return rows[0].id;
  });
  return getCorrection(id);
}

export async function decideCorrection(reviewer, id, { decision, note }, now = new Date()) {
  const correction = await getCorrection(id);
  if (correction.status !== 'PENDING') throw conflict('This request has already been decided');
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw badRequest('Approve or reject');
  await assertReviewer(reviewer, correction.user_id, 'attendance.approve');
  if (decision === 'REJECTED' && !String(note || '').trim()) throw badRequest('Say why it is rejected');
  if (await isLocked(correction.user_id, correction.work_date)) throw conflict('Payroll for that month is locked — reopen it first');

  const { config } = await currentPolicy();
  await settleMissingCheckouts(correction.user_id, now);

  return withTransaction(async (client) => {
    let before = null;
    let after = null;
    if (decision === 'APPROVED') {
      const { rows } = await client.query(
        `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = $1 AND work_date = $2 FOR UPDATE`,
        [correction.user_id, correction.work_date],
      );
      const session = rows[0] || null;
      before = snapshot(session);

      if (correction.kind === 'REOPEN') {
        if (!session || session.status !== 'COMPLETED') throw conflict('That attendance is no longer completed — nothing to reopen');
        await client.query(
          `UPDATE attendance_sessions SET status = 'OPEN', check_out_at = NULL, check_out_lat = NULL, check_out_lng = NULL,
                  check_out_accuracy_m = NULL, check_out_location_at = NULL, check_out_source = NULL,
                  check_out_request_id = NULL, regularized = TRUE, updated_at = now()
            WHERE id = $1`,
          [session.id],
        );
      } else {
        const newIn = correction.proposed_check_in || session?.check_in_at || null;
        const newOut = correction.proposed_check_out || session?.check_out_at || null;
        if (!newIn) throw conflict('There is no start time to work from');
        const status = newOut ? 'COMPLETED' : cutoffFor(correction.work_date, config) <= now ? 'MISSING_CHECKOUT' : 'OPEN';
        if (session) {
          await client.query(
            `UPDATE attendance_sessions
                SET check_in_at = $2, check_out_at = $3, status = $4, regularized = TRUE,
                    check_in_source = CASE WHEN $5 THEN 'MANUALLY_REGULARIZED' ELSE check_in_source END,
                    check_out_source = CASE WHEN $6 THEN 'MANUALLY_REGULARIZED' ELSE check_out_source END,
                    updated_at = now()
              WHERE id = $1`,
            [session.id, newIn, newOut, status, Boolean(correction.proposed_check_in), Boolean(correction.proposed_check_out)],
          );
        } else {
          await client.query(
            `INSERT INTO attendance_sessions (user_id, work_date, status, check_in_at, check_in_source,
                check_out_at, check_out_source, regularized)
             VALUES ($1, $2, $3, $4, 'MANUALLY_REGULARIZED', $5, $6, TRUE)`,
            [correction.user_id, correction.work_date, status, newIn, newOut, newOut ? 'MANUALLY_REGULARIZED' : null],
          );
        }
      }
      const { rows: updated } = await client.query(
        `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = $1 AND work_date = $2`,
        [correction.user_id, correction.work_date],
      );
      after = snapshot(updated[0]);
    }

    await client.query(
      `UPDATE attendance_corrections SET status = $2, reviewer_id = $3, reviewed_at = now(), review_note = $4,
              before = $5, after = $6 WHERE id = $1`,
      [id, decision, reviewer.id, note?.trim() || null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
    );
    await audit(client, {
      entityType: 'ATTENDANCE_CORRECTION', entityId: id, subjectUserId: correction.user_id, actorId: reviewer.id,
      action: decision, reason: note || null, before, after,
    });
    await notify(client, {
      userId: correction.user_id, type: 'attendance_correction',
      title: `Your attendance correction for ${correction.work_date} was ${decision === 'APPROVED' ? 'approved' : 'not approved'}`,
      body: note || null,
    });
    return { id, status: decision, session: after };
  }).catch((err) => {
    if (err?.code === '23505') throw conflict('This would leave two open attendance sessions — the person must check out of the other first');
    throw err;
  });
}

export async function cancelCorrection(actor, id) {
  const correction = await getCorrection(id);
  if (correction.user_id !== actor.id) throw forbidden('This is not your request');
  if (correction.status !== 'PENDING') throw conflict('Only a pending request can be withdrawn');
  await withTransaction(async (client) => {
    await client.query(`UPDATE attendance_corrections SET status = 'CANCELLED' WHERE id = $1`, [id]);
    await audit(client, { entityType: 'ATTENDANCE_CORRECTION', entityId: id, subjectUserId: actor.id, actorId: actor.id, action: 'CANCELLED' });
  });
  return getCorrection(id);
}

// ---------------------------------------------------------------- reviewer decisions about days

/** Confirm a scheduled day nobody recorded as an unapproved absence — or clear it. */
export async function reviewDay(reviewer, { user_id: userId, work_date: workDate, decision, note }, now = new Date()) {
  await assertReviewer(reviewer, userId, 'attendance.approve');
  const { config } = await currentPolicy();
  if (workDate >= dateIn(config.timezone, now)) throw badRequest('Only past days can be reviewed');
  if (await isLocked(userId, workDate)) throw conflict('Payroll for that month is locked — reopen it first');
  const { rows: before } = await query('SELECT * FROM attendance_day_reviews WHERE user_id = $1 AND work_date = $2', [userId, workDate]);

  await withTransaction(async (client) => {
    if (decision === 'CLEAR') {
      // the table holds only the current decision; the earlier one stays in the audit log
      await client.query('DELETE FROM attendance_day_reviews WHERE user_id = $1 AND work_date = $2', [userId, workDate]);
    } else if (decision === 'UNAPPROVED_ABSENCE') {
      if (!String(note || '').trim()) throw badRequest('Say how this was confirmed');
      const { rows: s } = await client.query('SELECT 1 FROM attendance_sessions WHERE user_id = $1 AND work_date = $2', [userId, workDate]);
      if (s[0]) throw conflict('There is attendance recorded that day — it is not an absence');
      await client.query(
        `INSERT INTO attendance_day_reviews (user_id, work_date, decision, note, reviewer_id)
         VALUES ($1, $2, 'UNAPPROVED_ABSENCE', $3, $4)
         ON CONFLICT (user_id, work_date) DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note,
           reviewer_id = EXCLUDED.reviewer_id, reviewed_at = now()`,
        [userId, workDate, note.trim(), reviewer.id],
      );
      await notify(client, {
        userId, type: 'attendance_review',
        title: `${workDate} was recorded as an unapproved absence`,
        body: 'If this is wrong, request a correction or apply for leave for that day.',
      });
    } else {
      throw badRequest('Choose a decision');
    }
    await audit(client, {
      entityType: 'ATTENDANCE_DAY', entityId: `${userId}:${workDate}`, subjectUserId: userId, actorId: reviewer.id,
      action: decision, reason: note || null, before: before[0] || null,
    });
  });
}

/** Decide whether a day's post-shift time may offset a shortfall. */
export async function reviewExtra(reviewer, { user_id: userId, work_date: workDate, status, eligible_seconds: eligible, reason }) {
  await assertReviewer(reviewer, userId, 'attendance.extra.review');
  if (!['ELIGIBLE', 'REJECTED'].includes(status)) throw badRequest('Mark it eligible or not eligible');
  if (status === 'REJECTED' && !String(reason || '').trim()) throw badRequest('Say why the extra time does not count');
  if (eligible !== undefined && eligible !== null && (!Number.isInteger(eligible) || eligible < 0)) {
    throw badRequest('Eligible time is a whole number of seconds');
  }
  if (await isLocked(userId, workDate)) throw conflict('Payroll for that month is locked — reopen it first');
  const { rows: before } = await query('SELECT * FROM extra_time_reviews WHERE user_id = $1 AND work_date = $2', [userId, workDate]);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO extra_time_reviews (user_id, work_date, status, eligible_seconds, reason, reviewer_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, work_date) DO UPDATE SET status = EXCLUDED.status, eligible_seconds = EXCLUDED.eligible_seconds,
         reason = EXCLUDED.reason, reviewer_id = EXCLUDED.reviewer_id, reviewed_at = now()`,
      [userId, workDate, status, eligible ?? null, reason?.trim() || null, reviewer.id],
    );
    await audit(client, {
      entityType: 'EXTRA_TIME', entityId: `${userId}:${workDate}`, subjectUserId: userId, actorId: reviewer.id,
      action: status, reason: reason || null, before: before[0] || null, after: { status, eligible_seconds: eligible ?? null },
    });
  });
}
