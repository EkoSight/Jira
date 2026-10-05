/**
 * The working-time ledger: saved records → the pure engine → a day-by-day and
 * monthly account a person can check line by line.
 *
 * Reading only. Nothing here changes a record, so a report can be refreshed as
 * often as anyone likes and always gives the same answer for the same data.
 */

import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { clock, computeDay, computeMonth, computeSalary } from '../lib/attendanceCalc.js';
import { enginePolicy, policyTimeline, policyOn, setupStatus } from './attendancePolicy.js';
import {
  SESSION_COLUMNS, addDays, cutoffFor, dateIn, holidaysBetween, profilesFor, requiredSeconds,
  scheduleOn, secondsInto, settleMissingCheckouts, userBasics,
} from './attendance.js';

export const PENDING_LEAVE = ['SUBMITTED', 'EMERGENCY_REVIEW', 'NOTICE_EXCEPTION'];
export const APPROVED_LEAVE = ['APPROVED_PAID', 'APPROVED_UNPAID'];

export const monthBounds = (month) => {
  const first = `${month.slice(0, 7)}-01`;
  const next = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 1)).toISOString().slice(0, 10);
  return { first, last: addDays(next, -1) };
};

export function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The part of a scheduled day a leave entry covers, in seconds. */
export function leaveSpan(dayPart, schedule, config) {
  const split = clock(config.halfDaySplit || '13:30');
  if (dayPart === 'FIRST_HALF') return [schedule.start, Math.min(split, schedule.end)];
  if (dayPart === 'SECOND_HALF') return [Math.max(split, schedule.start), schedule.end];
  return [schedule.start, schedule.end];
}

/**
 * A leave request's effect on one date. An approved request uses the day
 * allocation fixed when it was approved; a pending one is all pending.
 */
function leaveOnDate(request, date, schedule, config) {
  if (date < request.start_date || date > request.end_date) return [];
  const [start, end] = leaveSpan(request.day_part, schedule, config);
  if (PENDING_LEAVE.includes(request.status)) return [{ start, end, paid: false, status: 'PENDING', request_id: request.id }];
  if (!APPROVED_LEAVE.includes(request.status)) return [];
  const day = (request.day_allocation || []).find((d) => d.date === date);
  if (!day) return [];
  if (day.paid >= day.portion) return [{ start, end, paid: true, status: 'APPROVED', request_id: request.id }];
  if (day.paid <= 0) return [{ start, end, paid: false, status: 'APPROVED', request_id: request.id }];
  // half paid, half unpaid: the paid half is the first half of the span
  const mid = start + Math.floor((end - start) / 2);
  return [
    { start, end: mid, paid: true, status: 'APPROVED', request_id: request.id },
    { start: mid, end, paid: false, status: 'APPROVED', request_id: request.id },
  ];
}

/**
 * Every day for these people between two dates, computed.
 * Returns Map(userId → { user, profile, days: [...] }).
 */
export async function buildLedgers(userIds, from, to, { now = new Date() } = {}) {
  await settleMissingCheckouts(null, now);
  const timeline = await policyTimeline();
  const current = timeline[timeline.length - 1].config;
  const today = dateIn(current.timezone, now);

  const [users, profiles, holidays, sessions, leaves, reviews, extras] = await Promise.all([
    userBasics(userIds),
    profilesFor(userIds),
    holidaysBetween(from, to),
    query(`SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3`, [userIds, from, to]),
    query(`SELECT * FROM leave_requests WHERE user_id = ANY($1::int[]) AND end_date >= $2 AND start_date <= $3
            AND status = ANY($4::text[])`, [userIds, from, to, [...PENDING_LEAVE, ...APPROVED_LEAVE]]),
    query('SELECT * FROM attendance_day_reviews WHERE user_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3', [userIds, from, to]),
    query('SELECT * FROM extra_time_reviews WHERE user_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3', [userIds, from, to]),
  ]);

  const key = (u, d) => `${u}|${d}`;
  const sessionBy = new Map(sessions.rows.map((s) => [key(s.user_id, s.work_date), s]));
  const reviewBy = new Map(reviews.rows.map((r) => [key(r.user_id, r.work_date), r]));
  const extraBy = new Map(extras.rows.map((r) => [key(r.user_id, r.work_date), r]));

  const result = new Map();
  for (const user of users) {
    const profile = profiles.get(user.id) || null;
    const mine = leaves.rows.filter((l) => l.user_id === user.id);
    const days = datesBetween(from, to).map((date) => {
      const version = policyOn(timeline, date);
      const { config } = version;
      const schedule = scheduleOn(date, { config, profile, holidays, departmentId: user.department_id });
      const row = sessionBy.get(key(user.id, date)) || null;
      const tz = config.timezone;

      let phase = date > today ? 'FUTURE' : date === today ? 'TODAY' : 'PAST';
      if (row?.status === 'OPEN' && cutoffFor(date, config) > now) phase = 'TODAY';

      const session = row && row.check_in_at ? {
        checkIn: secondsInto(date, row.check_in_at, tz),
        checkOut: row.check_out_at ? secondsInto(date, row.check_out_at, tz) : null,
        status: row.status,
        regularized: row.regularized,
      } : null;

      const leave = schedule.state === 'WORKDAY'
        ? mine.flatMap((l) => leaveOnDate(l, date, schedule, config))
        : [];
      const extraRow = extraBy.get(key(user.id, date));
      const extra = extraRow ? { status: extraRow.status, eligibleSeconds: extraRow.eligible_seconds ?? undefined, reviewed: true } : undefined;
      const review = reviewBy.get(key(user.id, date));

      const computed = computeDay({
        date, schedule, session, leave, phase, extra,
        absence: review?.decision || null,
      }, enginePolicy(config));

      return {
        ...computed,
        policy_id: version.id,
        schedule_state: schedule.state,
        // before the attendance start date: shown, never owed
        before_start: Boolean(schedule.beforeStart),
        holiday: schedule.holiday || null,
        session: row ? {
          id: row.id, status: row.status, check_in_at: row.check_in_at, check_out_at: row.check_out_at,
          check_in_source: row.check_in_source, check_out_source: row.check_out_source,
          review_flags: row.review_flags, regularized: row.regularized,
          has_location: row.check_in_lat !== null || row.check_out_lat !== null,
        } : null,
        leave_request_ids: [...new Set(leave.map((l) => l.request_id))],
        day_review: review ? { decision: review.decision, note: review.note } : null,
        extra_review: extraRow ? { status: extraRow.status, eligible_seconds: extraRow.eligible_seconds, reason: extraRow.reason } : null,
      };
    });
    result.set(user.id, { user, profile, days });
  }
  return result;
}

/** One person's month, with the monthly pooling applied. */
export async function monthLedger(userId, month, options = {}) {
  const { first, last } = monthBounds(month);
  const ledgers = await buildLedgers([userId], first, last, options);
  const entry = ledgers.get(Number(userId));
  if (!entry) return null;
  const month_ = computeMonth(entry.days);
  return {
    ...entry,
    month: first,
    totals: month_.totals,
    day_counts: month_.days,
    allocations: month_.allocations,
    blockers: month_.blockers,
    final: month_.final,
  };
}

// ---------------------------------------------------------------- payroll

const LIVE_PAYROLL = `SELECT * FROM payroll_results WHERE month = $1 AND user_id = $2 AND status <> 'SUPERSEDED'`;

export async function livePayroll(month, userId) {
  const { rows } = await query(LIVE_PAYROLL, [month, userId]);
  return rows[0] || null;
}

/** Whether a person's month is locked; locked months only change by reopening. */
export async function isLocked(userId, date) {
  const { first } = monthBounds(date);
  const { rows } = await query(
    `SELECT 1 FROM payroll_results WHERE user_id = $1 AND month = $2 AND status IN ('APPROVED', 'LOCKED')`,
    [userId, first],
  );
  return rows.length > 0;
}

/**
 * The salary estimate for one person's month: the day ledger, the setup
 * checks, the segments by salary change, and the money. Draft whenever
 * anything is unresolved or not yet configured; it says exactly what.
 */
export async function computePayroll(userId, month, { now = new Date() } = {}) {
  const ledger = await monthLedger(userId, month, { now });
  if (!ledger) return null;
  const { first, last } = monthBounds(month);
  const timeline = await policyTimeline();
  const versions = [...new Map(ledger.days.map((d) => [d.policy_id, timeline.find((v) => v.id === d.policy_id)])).values()];
  const latest = versions[versions.length - 1];

  const setup = [];
  for (const version of versions) {
    for (const item of setupStatus(version).items) {
      if (!item.done) setup.push({ code: `POLICY_${item.key.toUpperCase()}`, label: item.label, policy_id: version.id });
    }
  }
  const startDate = latest.config.startDate;
  if (startDate && first < startDate) {
    setup.push({ code: 'MONTH_BEFORE_START', label: `Attendance tracking starts on ${startDate}; this month began before it and is handled outside TaskFlow` });
  }
  if (!ledger.profile?.joining_date) setup.push({ code: 'JOINING_DATE', label: 'Joining date not recorded' });

  // per day: what stayed unpaid after offsets
  const allocatedTo = new Map();
  for (const a of ledger.allocations) allocatedTo.set(a.target_date, (allocatedTo.get(a.target_date) || 0) + a.seconds);
  const unpaidOn = (d) => d.N + d.remaining_short - (allocatedTo.get(d.date) || 0);

  // the month as if employed throughout — the base a mid-month joiner is prorated against
  const holidays = await holidaysBetween(first, last);
  const fullMonthRequired = ledger.days.reduce((sum, d) => {
    const { config } = policyOn(timeline, d.date);
    return sum + requiredSeconds(scheduleOn(d.date, { config, profile: ledger.profile, holidays, departmentId: ledger.user.department_id, ignoreEmployment: true }));
  }, 0);

  const { rows: bases } = await query(
    'SELECT * FROM salary_basis WHERE user_id = $1 AND effective_from <= $2 ORDER BY effective_from',
    [userId, last],
  );
  const employed = ledger.days.filter((d) => d.schedule_state !== 'NOT_EMPLOYED' && !d.before_start);
  const segments = [];
  let missingBasis = false;
  for (const day of employed) {
    const basis = [...bases].reverse().find((b) => b.effective_from <= day.date);
    if (!basis) { missingBasis = true; continue; }
    let seg = segments[segments.length - 1];
    if (!seg || seg.basis.id !== basis.id) {
      seg = { basis, from: day.date, to: day.date, required: 0, unpaid: 0 };
      segments.push(seg);
    }
    seg.to = day.date;
    seg.required += day.R;
    seg.unpaid += unpaidOn(day);
  }
  if (missingBasis || !segments.length) setup.push({ code: 'SALARY_BASIS', label: 'Attendance-sensitive salary not recorded for every employed day' });

  let salary = null;
  if (segments.length && !missingBasis) {
    salary = computeSalary(segments.map((s) => ({
      monthlyBase: s.basis.attendance_sensitive,
      fullMonthRequired,
      segmentRequired: s.required,
      segmentUnpaid: s.unpaid,
    })));
    salary.segments = segments.map((s, i) => ({
      from: s.from, to: s.to, basis_id: s.basis.id, effective_from: s.basis.effective_from,
      fixed_components: s.basis.fixed_components, currency: s.basis.currency, ...salary.lines?.[i],
    }));
    salary.fixed_components = segments.reduce((max, s) => Math.max(max, Number(s.basis.fixed_components) || 0), 0);
    salary.currency = segments[0].basis.currency;
  }

  const blockers = [...ledger.blockers];
  // a month still running has days nobody can judge yet
  if (last >= dateIn(latest.config.timezone, now)) blockers.unshift('MONTH_NOT_OVER');
  const status = setup.length ? 'NEEDS_SETUP' : (blockers.length || !ledger.final ? 'PROVISIONAL' : 'READY');

  return {
    month: first,
    user: ledger.user,
    profile: ledger.profile ? { joining_date: ledger.profile.joining_date, exit_date: ledger.profile.exit_date, work_mode: ledger.profile.work_mode } : null,
    status,
    setup,
    blockers,
    policy_ids: versions.map((v) => v.id),
    policy_id: latest.id,
    assumptions: latest.config.breaksConfirmed ? [] : ['No lunch or rest break is configured yet; breaks are not deducted.'],
    full_month_required: fullMonthRequired,
    totals: ledger.totals,
    day_counts: ledger.day_counts,
    days: ledger.days.map((d) => ({ ...d, unpaid: d.R ? unpaidOn(d) : 0, allocated_in: allocatedTo.get(d.date) || 0 })),
    allocations: ledger.allocations,
    salary,
  };
}

/** A stable fingerprint of what a result says, to notice data changing under an approval. */
export function fingerprint(result) {
  const essence = {
    totals: result.totals,
    allocations: result.allocations,
    salary: result.salary && { ...result.salary },
    days: result.days.map((d) => [d.date, d.classification, d.R, d.C, d.L, d.G, d.N, d.U, d.E_eligible, d.unpaid]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(essence)).digest('hex');
}
