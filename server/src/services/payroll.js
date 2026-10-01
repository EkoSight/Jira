/**
 * The monthly closing: Draft → In review → Approved → Locked → Export.
 *
 * TaskFlow produces an attendance-adjusted salary estimate for payroll to use.
 * It does not pay anyone, transfer money, or calculate tax, PF or ESI.
 *
 * Every transition re-runs the calculation and compares it with the snapshot
 * taken when the month was submitted. If the underlying data has changed in
 * between, the transition stops and says so, rather than approving numbers
 * nobody looked at. A locked month is never edited; reopening supersedes it
 * with a new version and keeps the old one.
 */

import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from './attendance.js';
import { computePayroll, fingerprint, livePayroll, monthBounds } from './attendanceLedger.js';

export const PAYROLL_STATUS_LABEL = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  LOCKED: 'Locked',
  SUPERSEDED: 'Superseded',
};

export const ACTIONS = ['submit', 'approve', 'lock', 'return', 'reopen'];

/** Who is in payroll for a month: active people, plus anyone with a row already. */
export async function payrollPeople(month) {
  const { first } = monthBounds(month);
  const { rows } = await query(
    `SELECT id FROM users WHERE is_active
     UNION SELECT user_id FROM payroll_results WHERE month = $1
     ORDER BY 1`,
    [first],
  );
  return rows.map((r) => r.id);
}

/** A person's month as payroll sees it: frozen if approved or locked, live otherwise. */
export async function payrollView(month, userId) {
  const { first } = monthBounds(month);
  const row = await livePayroll(first, userId);
  if (row && ['APPROVED', 'LOCKED'].includes(row.status) && row.snapshot) {
    return { ...row.snapshot, record: shapeRecord(row), frozen: true };
  }
  const result = await computePayroll(userId, first);
  if (!result) return null;
  return { ...result, record: row ? shapeRecord(row) : null, frozen: false };
}

const shapeRecord = (row) => ({
  id: row.id, version: row.version, status: row.status, status_label: PAYROLL_STATUS_LABEL[row.status],
  policy_id: row.policy_id, submitted_at: row.submitted_at, submitted_by: row.submitted_by,
  approved_at: row.approved_at, approved_by: row.approved_by, locked_at: row.locked_at, locked_by: row.locked_by,
  reopened_at: row.reopened_at, reopen_reason: row.reopen_reason, export_count: row.export_count,
});

export async function history(month, userId) {
  const { first } = monthBounds(month);
  const { rows } = await query(
    `SELECT p.id, p.version, p.status, p.submitted_at, p.approved_at, p.locked_at, p.reopened_at, p.reopen_reason,
            p.export_count, sb.full_name AS submitted_by_name, ab.full_name AS approved_by_name,
            lb.full_name AS locked_by_name, rb.full_name AS reopened_by_name,
            p.snapshot -> 'salary' -> 'attendance_adjusted_earnings' AS earnings
       FROM payroll_results p
       LEFT JOIN users sb ON sb.id = p.submitted_by LEFT JOIN users ab ON ab.id = p.approved_by
       LEFT JOIN users lb ON lb.id = p.locked_by LEFT JOIN users rb ON rb.id = p.reopened_by
      WHERE p.month = $1 AND p.user_id = $2 ORDER BY p.version DESC`,
    [first, userId],
  );
  return rows;
}

async function snapshotOf(userId, month) {
  const result = await computePayroll(userId, month);
  if (!result) throw notFound('Person not found');
  return { ...result, fingerprint: fingerprint(result), computed_at: new Date().toISOString() };
}

function assertReady(result) {
  if (result.status === 'READY') return;
  const reasons = [
    ...result.setup.map((s) => s.label),
    ...result.blockers.map((b) => BLOCKER_TEXT[b] || b),
  ];
  throw conflict(`This month cannot move on yet: ${reasons.join('; ')}`, { setup: result.setup, blockers: result.blockers });
}

export const BLOCKER_TEXT = {
  MONTH_NOT_OVER: 'the month has not ended',
  UNRECORDED: 'scheduled days with no attendance and no review',
  MISSING_CHECKOUT: 'missing check-outs',
  PENDING_LEAVE: 'leave requests still pending',
  EXTRA_PENDING: 'extra time not yet reviewed',
};

/** One transition for one person's month. */
export async function transition(actor, month, userId, action, { reason } = {}) {
  if (!ACTIONS.includes(action)) throw badRequest('Unknown payroll action');
  const { first } = monthBounds(month);
  const row = await livePayroll(first, userId);
  const status = row?.status || 'DRAFT';
  const subject = Number(userId);

  if (['approve', 'lock'].includes(action) && subject === actor.id) {
    throw forbidden('You cannot approve or lock your own pay');
  }

  return withTransaction(async (client) => {
    const log = (act, before, after) => audit(client, {
      entityType: 'PAYROLL', entityId: `${first}:${subject}`, subjectUserId: subject, actorId: actor.id,
      action: act, reason: reason || null, before, after,
    });

    if (action === 'submit') {
      if (status !== 'DRAFT') throw conflict(`This month is ${PAYROLL_STATUS_LABEL[status].toLowerCase()}, not a draft`);
      const snap = await snapshotOf(subject, first);
      assertReady(snap);
      if (row) {
        await client.query(
          `UPDATE payroll_results SET status = 'IN_REVIEW', snapshot = $2, policy_id = $3, submitted_by = $4,
                  submitted_at = now(), updated_at = now() WHERE id = $1`,
          [row.id, JSON.stringify(snap), snap.policy_id, actor.id],
        );
      } else {
        await client.query(
          `INSERT INTO payroll_results (month, user_id, version, status, policy_id, snapshot, submitted_by, submitted_at)
           VALUES ($1, $2, 1, 'IN_REVIEW', $3, $4, $5, now())`,
          [first, subject, snap.policy_id, JSON.stringify(snap), actor.id],
        );
      }
      await log('SUBMITTED', { status }, { status: 'IN_REVIEW', earnings: snap.salary?.attendance_adjusted_earnings ?? null });
      return { status: 'IN_REVIEW' };
    }

    if (action === 'approve' || action === 'lock') {
      const from = action === 'approve' ? 'IN_REVIEW' : 'APPROVED';
      const to = action === 'approve' ? 'APPROVED' : 'LOCKED';
      if (status !== from) throw conflict(`Only a month that is ${PAYROLL_STATUS_LABEL[from].toLowerCase()} can be ${action === 'approve' ? 'approved' : 'locked'}`);
      const fresh = await snapshotOf(subject, first);
      if (fresh.fingerprint !== row.snapshot?.fingerprint) {
        throw conflict('Attendance, leave or salary for this month changed after it was submitted. Send it back and submit again.', { code: 'CHANGED_SINCE_SUBMIT' });
      }
      const column = action === 'approve' ? 'approved' : 'locked';
      await client.query(
        `UPDATE payroll_results SET status = $2, ${column}_by = $3, ${column}_at = now(), updated_at = now() WHERE id = $1`,
        [row.id, to, actor.id],
      );
      await log(to, { status }, { status: to });
      return { status: to };
    }

    if (action === 'return') {
      if (!['IN_REVIEW', 'APPROVED'].includes(status)) throw conflict('Only a month in review or approved can be sent back');
      if (!String(reason || '').trim()) throw badRequest('Say why it is being sent back');
      await client.query(
        `UPDATE payroll_results SET status = 'DRAFT', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1`,
        [row.id],
      );
      await log('RETURNED', { status }, { status: 'DRAFT' });
      return { status: 'DRAFT' };
    }

    // reopen
    if (status !== 'LOCKED') throw conflict('Only a locked month can be reopened');
    if (!String(reason || '').trim()) throw badRequest('Reopening a locked month needs a reason on record');
    await client.query(
      `UPDATE payroll_results SET status = 'SUPERSEDED', reopened_by = $2, reopened_at = now(), reopen_reason = $3, updated_at = now()
        WHERE id = $1`,
      [row.id, actor.id, reason.trim()],
    );
    await client.query(
      `INSERT INTO payroll_results (month, user_id, version, status, policy_id)
       VALUES ($1, $2, $3, 'DRAFT', $4)`,
      [first, subject, row.version + 1, row.policy_id],
    );
    await log('REOPENED', { status, version: row.version }, { status: 'DRAFT', version: row.version + 1 });
    return { status: 'DRAFT', version: row.version + 1 };
  });
}

/** The locked results for a month, for the payroll export. */
export async function lockedResults(month) {
  const { first } = monthBounds(month);
  const { rows } = await query(
    `SELECT p.*, u.full_name, u.email, d.name AS department_name
       FROM payroll_results p JOIN users u ON u.id = p.user_id LEFT JOIN departments d ON d.id = u.department_id
      WHERE p.month = $1 AND p.status = 'LOCKED' ORDER BY u.full_name`,
    [first],
  );
  return rows;
}

export async function markExported(actor, ids, month) {
  if (!ids.length) return;
  await query('UPDATE payroll_results SET export_count = export_count + 1 WHERE id = ANY($1::int[])', [ids]);
  await audit(null, {
    entityType: 'PAYROLL_EXPORT', entityId: monthBounds(month).first, actorId: actor.id, action: 'EXPORTED',
    after: { result_ids: ids },
  });
}
