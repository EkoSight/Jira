/**
 * Dry-run reconciliation: legacy calendar leave against canonical leave
 * requests, unknown leave eligibility, and opening balances.
 *
 * Before leave requests existed, "Mark leave" wrote straight onto the team
 * calendar (user_availability). Those rows never reached attendance or pay —
 * the ledger reads only leave requests — but they look like leave on the
 * calendar. This report lists each one with what it overlaps, so HR can decide
 * row by row. It changes nothing, and it never proposes approving a row or
 * turning one into unpaid absence: the only proposals are "review with the
 * person", "already covered by a request" and "waiting on a pending request".
 *
 * Output carries record ids, dates and states only — no names, reasons,
 * salaries, contact or location data — so it can be shared for review.
 */

const LEAVE_STATUSES = ['ON_LEAVE', 'HALF_DAY'];

/**
 * Runs every query on the given client; the caller decides the transaction
 * (the command-line tool uses a READ ONLY one, so a write would fail).
 */
export async function legacyLeaveReport(client, { asOf }) {
  const { rows: legacy } = await client.query(
    `SELECT a.id, a.user_id, a.status, a.start_date::text AS start_date, a.end_date::text AS end_date, a.day_part,
            a.created_by, a.created_at
       FROM user_availability a
      WHERE a.cancelled_at IS NULL AND a.status = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.availability_id = a.id)
      ORDER BY a.start_date, a.id`,
    [LEAVE_STATUSES],
  );

  const rows = [];
  for (const row of legacy) {
    const { rows: requests } = await client.query(
      `SELECT id, status, start_date::text AS start_date, end_date::text AS end_date, day_part
         FROM leave_requests
        WHERE user_id = $1 AND status NOT IN ('DRAFT', 'REJECTED', 'CANCELLED')
          AND end_date >= $2 AND start_date <= $3
        ORDER BY id`,
      [row.user_id, row.start_date, row.end_date],
    );
    const { rows: [attendance] } = await client.query(
      `SELECT COUNT(*)::int AS days FROM attendance_sessions
        WHERE user_id = $1 AND work_date BETWEEN $2 AND $3 AND check_in_at IS NOT NULL`,
      [row.user_id, row.start_date, row.end_date],
    );
    const { rows: closed } = await client.query(
      `SELECT DISTINCT month::text AS month, status FROM payroll_results
        WHERE user_id = $1 AND status IN ('APPROVED', 'LOCKED')
          AND month BETWEEN date_trunc('month', $2::date) AND $3::date
        ORDER BY 1`,
      [row.user_id, row.start_date, row.end_date],
    );
    const approved = requests.filter((r) => r.status.startsWith('APPROVED'));
    const coversAll = approved.some((r) => r.start_date <= row.start_date && r.end_date >= row.end_date);
    let proposal;
    if (coversAll) proposal = 'COVERED_BY_APPROVED_REQUEST';
    else if (requests.some((r) => !r.status.startsWith('APPROVED'))) proposal = 'WAIT_FOR_PENDING_REQUEST';
    else proposal = 'REVIEW_WITH_PERSON';
    rows.push({
      availability_id: row.id,
      user_id: row.user_id,
      status: row.status,
      start_date: row.start_date,
      end_date: row.end_date,
      day_part: row.day_part,
      recorded_by: row.created_by === row.user_id ? 'SELF' : 'SOMEONE_ELSE',
      recorded_at: row.created_at,
      overlapping_requests: requests.map((r) => ({ id: r.id, status: r.status, start_date: r.start_date, end_date: r.end_date })),
      days_with_attendance: attendance.days,
      closed_payroll_months: closed.map((c) => `${c.month.slice(0, 7)} (${c.status.toLowerCase()})`),
      proposal,
    });
  }

  const { rows: unknown } = await client.query(
    `SELECT u.id AS user_id FROM users u LEFT JOIN employee_work_profiles p ON p.user_id = u.id
      WHERE u.is_active AND p.joining_date IS NULL ORDER BY u.id`,
  );
  const { rows: noExit } = await client.query(
    `SELECT u.id AS user_id FROM users u LEFT JOIN employee_work_profiles p ON p.user_id = u.id
      WHERE NOT u.is_active AND p.exit_date IS NULL ORDER BY u.id`,
  );

  const count = (proposal) => rows.filter((r) => r.proposal === proposal).length;
  return {
    dry_run: true,
    as_of: asOf,
    writes: 0,
    legacy_calendar_leave: {
      total: rows.length,
      covered_by_approved_request: count('COVERED_BY_APPROVED_REQUEST'),
      wait_for_pending_request: count('WAIT_FOR_PENDING_REQUEST'),
      review_with_person: count('REVIEW_WITH_PERSON'),
      in_closed_payroll_months: rows.filter((r) => r.closed_payroll_months.length).length,
      rows,
    },
    unknown_leave_eligibility: { total: unknown.length, user_ids: unknown.map((r) => r.user_id) },
    deactivated_without_exit_date: { total: noExit.length, user_ids: noExit.map((r) => r.user_id) },
    opening_balances: {
      tracked_in_taskflow: false,
      note: 'Opening leave balances, advances and adjustments are not recorded in TaskFlow. Reconcile them with the existing payroll process.',
    },
    how_to_resolve: [
      'COVERED_BY_APPROVED_REQUEST: the calendar already shows the approved request; the old row can be cancelled from the calendar after review (audited as LEGACY_LEAVE_CANCELLED).',
      'WAIT_FOR_PENDING_REQUEST: decide the pending request in Attendance → Leave; then review the old row again.',
      'REVIEW_WITH_PERSON: if it was real leave, the person (or their approver on their behalf) requests it in Attendance → Leave and it is decided normally; if not, cancel the old row. Nothing is approved or made unpaid by this report.',
      'Rows in closed payroll months cannot be changed from the calendar; reopen the month through payroll if a change is genuinely needed.',
    ],
  };
}
