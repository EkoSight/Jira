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
import { audit, dateIn, holidaysBetween } from './attendance.js';
import { PENDING_LEAVE, computePayroll, fingerprint, livePayroll, monthBounds } from './attendanceLedger.js';
import { getPolicyFor } from './attendancePolicy.js';
import { eligibilityFor, leaveReviewers } from './leave.js';

export const PAYROLL_STATUS_LABEL = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  LOCKED: 'Locked',
  SUPERSEDED: 'Superseded',
};

export const ACTIONS = ['submit', 'approve', 'lock', 'return', 'reopen'];

/**
 * Who is in payroll for a month: everyone whose employment overlaps it, plus
 * anyone with a saved result for it (history stays reachable whatever has
 * changed since).
 *
 * Employment is judged by the work profile's joining and exit dates, not by
 * whether the account is active today: a person who left on the 12th is still
 * in that month, and someone joining next month is not in this one. Where the
 * dates are missing nothing is guessed — an active person is listed with a
 * setup exception, and a deactivated account without an exit date is listed
 * only if it has attendance or leave in the month (also with an exception).
 */
export async function payrollPeople(month) {
  const { first, last } = monthBounds(month);
  const { rows } = await query(
    `SELECT u.id FROM users u
       LEFT JOIN employee_work_profiles p ON p.user_id = u.id
      WHERE (p.joining_date IS NULL OR p.joining_date <= $2)
        AND (p.exit_date IS NULL OR p.exit_date >= $1)
        AND (u.is_active
             OR p.exit_date IS NOT NULL
             OR EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.user_id = u.id AND s.work_date BETWEEN $1 AND $2)
             OR EXISTS (SELECT 1 FROM leave_requests l WHERE l.user_id = u.id AND l.status IN ('APPROVED_PAID', 'APPROVED_UNPAID')
                         AND l.end_date >= $1 AND l.start_date <= $2))
     UNION SELECT user_id FROM payroll_results WHERE month = $1
     ORDER BY 1`,
    [first, last],
  );
  return rows.map((r) => r.id);
}

/** People left out of a month's payroll, and why — so nobody disappears silently. */
export async function payrollExclusions(month) {
  const { first, last } = monthBounds(month);
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.is_active, p.joining_date, p.exit_date,
            CASE WHEN p.joining_date > $2 THEN 'JOINS_LATER'
                 WHEN p.exit_date < $1 THEN 'LEFT_EARLIER'
                 ELSE 'DEACTIVATED_NO_EXIT_DATE' END AS reason
       FROM users u LEFT JOIN employee_work_profiles p ON p.user_id = u.id
      WHERE u.id NOT IN (SELECT user_id FROM payroll_results WHERE month = $1)
        AND (p.joining_date > $2 OR p.exit_date < $1
             OR (NOT u.is_active AND p.exit_date IS NULL
                 AND NOT EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.user_id = u.id AND s.work_date BETWEEN $1 AND $2)
                 AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.user_id = u.id AND l.status IN ('APPROVED_PAID', 'APPROVED_UNPAID')
                                  AND l.end_date >= $1 AND l.start_date <= $2)))
      ORDER BY u.full_name`,
    [first, last],
  );
  return rows;
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
  throw conflict(`This month cannot move on yet: ${reasons.join('; ')}`, { code: 'NOT_READY', setup: result.setup, blockers: result.blockers });
}

export const BLOCKER_TEXT = {
  MONTH_NOT_OVER: 'the month has not ended',
  UNRECORDED: 'scheduled days with no attendance and no review',
  MISSING_CHECKOUT: 'missing check-outs',
  PENDING_LEAVE: 'leave requests still pending',
  EXTRA_PENDING: 'extra time not yet reviewed',
  ACCOUNTING_CHECK: 'a day whose figures do not add up — report it; it is not paid on as it stands',
};

const ACTION_TARGET = { submit: 'IN_REVIEW', approve: 'APPROVED', lock: 'LOCKED', return: 'DRAFT', reopen: 'DRAFT' };
const ACTION_BY = { submit: 'submitted_by', approve: 'approved_by', lock: 'locked_by' };

/** Payroll transitions for one person's month queue behind each other. */
const lockKey = (month, userId) => `payroll:${month}:${userId}`;

/**
 * One transition for one person's month.
 *
 * Runs in one transaction, serialised per person-month, and re-reads the live
 * record inside it. The update only applies to the state it was checked
 * against. `expected` ({ status, version }) is what the caller was looking at;
 * if the record has moved on since, the call stops with STALE_STATE rather
 * than acting on something nobody saw. Repeating a call that already took
 * effect (a double click, a retried request) returns the result again instead
 * of failing or acting twice.
 *
 * Approving and locking re-run every readiness check — setup, policy
 * acceptance, blockers — not only the figures: a policy whose acceptance was
 * cleared after submission stops the month even when no amount changed.
 */
export async function transition(actor, month, userId, action, { reason, expected } = {}) {
  if (!ACTIONS.includes(action)) throw badRequest('Unknown payroll action');
  const { first } = monthBounds(month);
  const subject = Number(userId);

  if (['approve', 'lock'].includes(action) && subject === actor.id) {
    throw forbidden('You cannot approve or lock your own pay');
  }

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(first, subject)]);
    const { rows: live } = await client.query(
      `SELECT * FROM payroll_results WHERE month = $1 AND user_id = $2 AND status <> 'SUPERSEDED' FOR UPDATE`,
      [first, subject],
    );
    const row = live[0] || null;
    const status = row?.status || 'DRAFT';
    const version = row?.version ?? null;

    // the same call again, after it already took effect: answer, do not act twice
    const replay = await replayOf(client, { action, row, status, version, expected, actor, first, subject });
    if (replay) return replay;

    if (expected && (expected.status !== status || (expected.version ?? null) !== version)) {
      throw conflict(
        `This month changed since you opened it: it is now ${PAYROLL_STATUS_LABEL[status].toLowerCase()}${version ? ` (version ${version})` : ''}. Reload it and check before acting.`,
        { code: 'STALE_STATE', status, version },
      );
    }

    const log = (act, before, after) => audit(client, {
      entityType: 'PAYROLL', entityId: `${first}:${subject}`, subjectUserId: subject, actorId: actor.id,
      action: act, reason: reason || null, before, after,
    });
    // the row must still be in the state checked above when it is changed
    const guarded = async (sql, params) => {
      const { rowCount } = await client.query(sql, params);
      if (rowCount !== 1) throw conflict('This month changed while the action ran. Reload it and try again.', { code: 'STALE_STATE' });
    };

    if (action === 'submit') {
      if (status !== 'DRAFT') throw conflict(`This month is ${PAYROLL_STATUS_LABEL[status].toLowerCase()}, not a draft`);
      const snap = await snapshotOf(subject, first);
      assertReady(snap);
      if (row) {
        await guarded(
          `UPDATE payroll_results SET status = 'IN_REVIEW', snapshot = $2, policy_id = $3, submitted_by = $4,
                  submitted_at = now(), updated_at = now() WHERE id = $1 AND status = 'DRAFT'`,
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
      return { status: 'IN_REVIEW', version: version ?? 1 };
    }

    if (action === 'approve' || action === 'lock') {
      const from = action === 'approve' ? 'IN_REVIEW' : 'APPROVED';
      const to = ACTION_TARGET[action];
      if (status !== from) throw conflict(`Only a month that is ${PAYROLL_STATUS_LABEL[from].toLowerCase()} can be ${action === 'approve' ? 'approved' : 'locked'}`);
      const fresh = await snapshotOf(subject, first);
      // every prerequisite again, not just the numbers
      assertReady(fresh);
      if (fresh.fingerprint !== row.snapshot?.fingerprint) {
        throw conflict('Attendance, leave or salary for this month changed after it was submitted. Send it back and submit again.', { code: 'CHANGED_SINCE_SUBMIT' });
      }
      const policiesThen = JSON.stringify(row.snapshot?.policy_ids || [row.snapshot?.policy_id]);
      if (JSON.stringify(fresh.policy_ids) !== policiesThen) {
        throw conflict('The attendance policy that applies to this month changed after it was submitted. Send it back and submit again.', { code: 'CHANGED_SINCE_SUBMIT' });
      }
      const column = action === 'approve' ? 'approved' : 'locked';
      await guarded(
        `UPDATE payroll_results SET status = $2, ${column}_by = $3, ${column}_at = now(), updated_at = now()
          WHERE id = $1 AND status = $4 AND version = $5`,
        [row.id, to, actor.id, from, row.version],
      );
      await log(to, { status }, { status: to });
      return { status: to, version: row.version };
    }

    if (action === 'return') {
      if (!['IN_REVIEW', 'APPROVED'].includes(status)) throw conflict('Only a month in review or approved can be sent back');
      if (!String(reason || '').trim()) throw badRequest('Say why it is being sent back');
      await guarded(
        `UPDATE payroll_results SET status = 'DRAFT', approved_by = NULL, approved_at = NULL, updated_at = now()
          WHERE id = $1 AND status = $2 AND version = $3`,
        [row.id, status, row.version],
      );
      await log('RETURNED', { status }, { status: 'DRAFT' });
      return { status: 'DRAFT', version: row.version };
    }

    // reopen
    if (status !== 'LOCKED') throw conflict('Only a locked month can be reopened');
    if (!String(reason || '').trim()) throw badRequest('Reopening a locked month needs a reason on record');
    await guarded(
      `UPDATE payroll_results SET status = 'SUPERSEDED', reopened_by = $2, reopened_at = now(), reopen_reason = $3, updated_at = now()
        WHERE id = $1 AND status = 'LOCKED' AND version = $4`,
      [row.id, actor.id, reason.trim(), row.version],
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

/**
 * Whether this call is a repeat of one that already took effect. Only the
 * person who made a transition gets its result back; anyone else is told the
 * month has moved on.
 */
async function replayOf(client, { action, row, status, version, expected, actor, first, subject }) {
  const target = ACTION_TARGET[action];
  if (ACTION_BY[action]) {
    // submit / approve / lock: the record is already where this call would put it, by this person
    const sameVersion = !expected || expected.version === null || expected.version === undefined || expected.version === version;
    if (row && status === target && row[ACTION_BY[action]] === actor.id && sameVersion
      && (!expected || expected.status !== status)) {
      return { status, version, replayed: true };
    }
    return null;
  }
  if (action === 'reopen' && expected?.status === 'LOCKED' && status === 'DRAFT' && version === (expected.version ?? 0) + 1) {
    const { rows } = await client.query(
      `SELECT reopened_by FROM payroll_results WHERE month = $1 AND user_id = $2 AND version = $3 AND status = 'SUPERSEDED'`,
      [first, subject, expected.version],
    );
    if (rows[0]?.reopened_by === actor.id) return { status, version, replayed: true };
  }
  return null;
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

/**
 * What stands between a month and a payroll anyone can rely on: one list,
 * each item with a count, the people concerned, and where it is fixed. It only
 * reads; nothing here fills a gap. Opening leave balances, advances and other
 * adjustments are not recorded in TaskFlow, and the report says so instead of
 * implying they are settled.
 */
export async function readiness(month, { now = new Date() } = {}) {
  const { first, last } = monthBounds(month);
  const ids = await payrollPeople(first);
  const results = [];
  for (const id of ids) {
    const result = await computePayroll(id, first, { now });
    if (result) results.push(result);
  }
  const person = (r) => ({ id: r.user.id, name: r.user.full_name });
  const withSetup = (code) => results.filter((r) => r.setup.some((s) => s.code === code)).map(person);
  const dayCount = (blocker) => results.reduce((n, r) => n + r.days.filter((d) => d.blockers.includes(blocker)).length, 0);
  const peopleWithDays = (blocker) => results.filter((r) => r.days.some((d) => d.blockers.includes(blocker))).map(person);

  const { config } = await getPolicyFor(first);
  const unknownEligibility = results
    .filter((r) => eligibilityFor(first, config, r.profile) === 'UNKNOWN')
    .map(person);
  const noApprover = [];
  for (const r of results) {
    if (r.user.is_active && !(await leaveReviewers(r.user.id)).length) noApprover.push(person(r));
  }
  const policyItems = new Map();
  for (const r of results) for (const s of r.setup) if (s.code.startsWith('POLICY_')) policyItems.set(`${s.code}:${s.policy_id}`, s);

  const year = first.slice(0, 4);
  const holidays = await holidaysBetween(`${year}-01-01`, `${year}-12-31`);
  const { rows: [pending] } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM leave_requests WHERE status = ANY($3::text[]) AND end_date >= $1 AND start_date <= $2) AS leave,
       (SELECT COUNT(*)::int FROM attendance_corrections WHERE status = 'PENDING' AND work_date BETWEEN $1 AND $2) AS corrections`,
    [first, last, PENDING_LEAVE],
  );
  const excluded = await payrollExclusions(first);

  const item = (key, label, state, extra = {}) => ({ key, label, state, count: extra.people?.length ?? extra.count ?? 0, ...extra });
  const items = [
    item('EMPLOYMENT_DATES', 'Joining dates recorded', withSetup('JOINING_DATE').length ? 'ACTION' : 'OK', {
      people: withSetup('JOINING_DATE'),
      hint: 'Record each joining date on the person\'s work profile. Without it, eligibility and proration are not known — nothing is assumed.',
      link: '/attendance?tab=team',
    }),
    item('EXIT_DATES', 'Exit dates for deactivated accounts', withSetup('EXIT_DATE').length ? 'ACTION' : 'OK', {
      people: withSetup('EXIT_DATE'),
      hint: 'A deactivated account with attendance or leave in the month needs its exit date.',
      link: '/attendance?tab=team',
    }),
    item('SALARY_COVERAGE', 'Attendance-sensitive salary recorded for every employed day', withSetup('SALARY_BASIS').length ? 'ACTION' : 'OK', {
      people: withSetup('SALARY_BASIS'),
      hint: 'Add the amount from its effective date in Payroll → person → Salary basis. Earlier amounts are kept.',
      link: '/payroll',
    }),
    item('POLICY', 'Policy decisions for this month', policyItems.size ? 'ACTION' : 'OK', {
      count: policyItems.size,
      decisions: [...policyItems.values()].map((s) => ({ code: s.code, label: s.label, policy_id: s.policy_id })),
      hint: 'Decided and accepted by an administrator in Settings → Attendance & pay. TaskFlow does not mark a policy accepted on anyone\'s behalf.',
      link: '/settings?tab=attendance',
    }),
    item('HOLIDAYS', `Paid holidays for ${year}`, holidays.length ? 'OK' : 'CONFIRM', {
      count: holidays.length,
      hint: holidays.length ? `${holidays.length} recorded.` : `None recorded for ${year}. Confirm there are none, or add them before the month is finalised.`,
      link: '/settings?tab=attendance',
    }),
    item('APPROVERS', 'Someone can approve each person\'s leave and corrections', noApprover.length ? 'ACTION' : 'OK', {
      people: noApprover,
      hint: 'Set a reporting manager, or give a manager team access, so requests have a reviewer.',
      link: '/attendance?tab=team',
    }),
    item('LEAVE_ELIGIBILITY', 'Paid-leave eligibility known', unknownEligibility.length ? 'ACTION' : 'OK', {
      people: unknownEligibility,
      hint: 'Under the current policy the allowance depends on the joining date. Paid approvals wait until it is recorded.',
      link: '/attendance?tab=team',
    }),
    item('UNRECORDED_DAYS', 'Scheduled days with no attendance and no review', dayCount('UNRECORDED') ? 'ACTION' : 'OK', {
      count: dayCount('UNRECORDED'),
      people: undefined,
      affected: peopleWithDays('UNRECORDED'),
      hint: 'A reviewer looks at each: a correction if the person was there, or a confirmed absence. Never assumed absent.',
      link: '/attendance?tab=review',
    }),
    item('MISSING_CHECKOUTS', 'Days with a missing check-out', dayCount('MISSING_CHECKOUT') ? 'ACTION' : 'OK', {
      count: dayCount('MISSING_CHECKOUT'),
      affected: peopleWithDays('MISSING_CHECKOUT'),
      hint: 'The person asks for a correction with the time they left; a reviewer decides. No check-out is guessed.',
      link: '/attendance?tab=review',
    }),
    item('EXTRA_PENDING', 'Days with extra time waiting for review', dayCount('EXTRA_PENDING') ? 'ACTION' : 'OK', {
      count: dayCount('EXTRA_PENDING'),
      affected: peopleWithDays('EXTRA_PENDING'),
      link: '/attendance?tab=review',
    }),
    item('PENDING_LEAVE', 'Leave requests waiting for a decision', pending.leave ? 'ACTION' : 'OK', {
      count: pending.leave, link: '/attendance?tab=leave',
    }),
    item('PENDING_CORRECTIONS', 'Attendance corrections waiting for a decision', pending.corrections ? 'ACTION' : 'OK', {
      count: pending.corrections, link: '/attendance?tab=review',
    }),
    item('OPENING_BALANCES', 'Opening leave balances, advances and adjustments', 'NOT_TRACKED', {
      hint: 'Not recorded in TaskFlow. Reconcile them with the existing payroll process and keep that record; TaskFlow\'s estimate does not include them.',
    }),
  ];
  if (last >= dateIn(config.timezone, now)) {
    items.unshift(item('MONTH_NOT_OVER', 'The month has ended', 'WAIT', { hint: 'Days still to come are shown as upcoming; nothing for them is final.' }));
  }

  const calculated = results.filter((r) => r.salary?.status === 'CALCULATED').length;
  return {
    month: first,
    generated_at: new Date(now).toISOString(),
    timezone: config.timezone,
    people: results.length,
    coverage: {
      calculated,
      ready: results.filter((r) => r.status === 'READY').length,
      needs_setup: results.filter((r) => r.status === 'NEEDS_SETUP').length,
      provisional: results.filter((r) => r.status === 'PROVISIONAL').length,
    },
    excluded: excluded.map((e) => ({ id: e.id, name: e.full_name, reason: e.reason })),
    items,
    ready: items.every((i) => ['OK', 'NOT_TRACKED'].includes(i.state)),
  };
}
