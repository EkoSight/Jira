/**
 * The working-time and salary arithmetic, with no database in sight.
 *
 * Every row of the brief's acceptance table (§19) is here, followed by the
 * monthly example and the edge cases the brief lists by name. The examples
 * assume what §19 assumes: a payroll-creditable nine-hour day, no unpaid break,
 * threshold-only grace, and eligible post-18:00 time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clock, computeDay, computeMonth, computeSalary, hhmm, decimalHours,
  intersect, subtract, union, length,
} from '../src/lib/attendanceCalc.js';

const M = 60;
const H = 3600;

const POLICY = {
  graceSeconds: 20 * M,
  graceMode: 'THRESHOLD',
  creditBeforeStart: false,
  extraRequiresReview: false,
  maxSessionSeconds: 14 * H,
};

const WORKDAY = { state: 'WORKDAY', start: clock('09:00'), end: clock('18:00'), breaks: [] };

const day = (checkIn, checkOut, extra = {}, policy = POLICY) => computeDay({
  date: extra.date || '2026-10-05',
  schedule: extra.schedule || WORKDAY,
  session: checkIn === null ? null : {
    checkIn: clock(checkIn),
    checkOut: checkOut === null ? null : clock(checkOut),
    status: checkOut === null ? 'OPEN' : 'COMPLETED',
    regularized: false,
  },
  leave: extra.leave || [],
  absence: extra.absence || null,
  extra: extra.extraReview,
  phase: extra.phase || 'PAST',
}, policy);

// ---------------------------------------------------------------- §19, row by row

test('09:00–18:00 is complete, with no shortage and no surplus', () => {
  const d = day('09:00', '18:00');
  assert.equal(d.duration, 9 * H);
  assert.equal(d.G, 0);
  assert.equal(d.ordinary_short, 0);
  assert.equal(d.remaining_extra, 0);
  assert.equal(d.classification, 'ATTENDED');
});

test('09:15–18:00 earns 15 minutes of grace and is complete', () => {
  const d = day('09:15', '18:00');
  assert.equal(d.duration, 8 * H + 45 * M);
  assert.equal(d.G, 15 * M);
  assert.equal(d.ordinary_short, 0);
  assert.ok(d.flags.includes('WITHIN_GRACE'));
  assert.ok(!d.flags.includes('LATE'));
});

test('09:20–18:00 is still within grace', () => {
  const d = day('09:20', '18:00');
  assert.equal(d.G, 20 * M);
  assert.equal(d.ordinary_short, 0);
  assert.ok(!d.flags.includes('LATE'));
});

test('09:30–18:00 is late, earns no grace, and is 30 minutes short — measured from 09:00', () => {
  const d = day('09:30', '18:00');
  assert.equal(d.duration, 8 * H + 30 * M);
  assert.equal(d.G, 0);
  assert.ok(d.flags.includes('LATE'));
  assert.equal(d.late_seconds, 30 * M, 'late by 30 minutes from 09:00, not 10 from 09:20');
  assert.equal(d.ordinary_short, 30 * M);
  assert.equal(d.remaining_short, 30 * M);
});

test('09:30–18:30 stays flagged late, recovers the shortage, and banks nothing', () => {
  const d = day('09:30', '18:30');
  assert.ok(d.flags.includes('LATE'), 'working later does not erase the fact of arriving late');
  assert.equal(d.ordinary_short, 30 * M);
  assert.equal(d.same_day_offset, 30 * M);
  assert.equal(d.remaining_short, 0);
  assert.equal(d.remaining_extra, 0);
});

test('09:00–19:00 leaves 60 minutes for another day', () => {
  const d = day('09:00', '19:00');
  assert.equal(d.duration, 10 * H);
  assert.equal(d.E_recorded, 60 * M);
  assert.equal(d.remaining_extra, 60 * M);
});

test('09:15–17:30 gets its 15 minutes of grace but is 30 minutes short at the end', () => {
  const d = day('09:15', '17:30');
  assert.equal(d.G, 15 * M);
  assert.equal(d.early_departure, 30 * M);
  assert.equal(d.ordinary_short, 30 * M, 'grace does not excuse leaving early');
  assert.ok(d.flags.includes('EARLY_DEPARTURE'));
});

test('09:15–18:30 is complete with a 30-minute surplus under the paid-grace reading', () => {
  const d = day('09:15', '18:30');
  assert.equal(d.duration, 9 * H + 15 * M);
  assert.equal(d.G, 15 * M);
  assert.equal(d.ordinary_short, 0);
  assert.equal(d.remaining_extra, 30 * M);
});

test('10:00–19:00 is late, recovers its hour the same day, and banks nothing', () => {
  const d = day('10:00', '19:00');
  assert.ok(d.flags.includes('LATE'));
  assert.equal(d.ordinary_short, 60 * M);
  assert.equal(d.same_day_offset, 60 * M);
  assert.equal(d.remaining_extra, 0, 'the normal total is not extra time');
});

test('08:30–17:30 is 30 minutes short: time before 09:00 is recorded, not banked', () => {
  const d = day('08:30', '17:30');
  assert.equal(d.duration, 9 * H);
  assert.equal(d.early_arrival, 30 * M);
  assert.equal(d.E_recorded, 0);
  assert.equal(d.ordinary_short, 30 * M);
});

// ---------------------------------------------------------------- the boundary

test('exactly 09:20:00 is within grace; 09:20:01 is not', () => {
  const onTheSecond = day('09:20:00', '18:00');
  assert.ok(!onTheSecond.flags.includes('LATE'));
  assert.equal(onTheSecond.G, 20 * M);

  const oneSecondLater = day('09:20:01', '18:00');
  assert.ok(oneSecondLater.flags.includes('LATE'));
  assert.equal(oneSecondLater.G, 0);
  assert.equal(oneSecondLater.ordinary_short, 20 * M + 1, 'measured to the second, not rounded');
});

test('the alternative grace mode forgives the first 20 minutes of a late arrival, but only when chosen', () => {
  const forgiving = day('09:30', '18:00', {}, { ...POLICY, graceMode: 'FORGIVE_FIRST' });
  assert.ok(forgiving.flags.includes('LATE'), 'still late');
  assert.equal(forgiving.G, 20 * M);
  assert.equal(forgiving.ordinary_short, 10 * M);

  const none = day('09:10', '18:00', {}, { ...POLICY, graceMode: 'NONE' });
  assert.equal(none.G, 0);
  assert.equal(none.ordinary_short, 10 * M);
});

// ---------------------------------------------------------------- breaks

test('an unpaid lunch hour is deducted by overlap, never twice, and never from a morning that missed it', () => {
  const withLunch = { ...WORKDAY, breaks: [{ start: clock('13:00'), end: clock('14:00'), paid: false }] };

  const full = day('09:00', '18:00', { schedule: withLunch });
  assert.equal(full.R, 8 * H, 'nine-hour span less an unpaid hour');
  assert.equal(full.C, 8 * H);
  assert.equal(full.ordinary_short, 0);
  assert.equal(full.net_estimate, 8 * H);

  // a morning that ended at 12:00 never touched lunch, so lunch is not taken off it
  const morning = day('09:00', '12:00', { schedule: withLunch });
  assert.equal(morning.C, 3 * H);
  assert.equal(morning.net_estimate, 3 * H);
  assert.equal(morning.ordinary_short, 5 * H);

  // a paid break stays creditable
  const paidLunch = { ...WORKDAY, breaks: [{ start: clock('13:00'), end: clock('14:00'), paid: true }] };
  assert.equal(day('09:00', '18:00', { schedule: paidLunch }).R, 9 * H);
});

// ---------------------------------------------------------------- leave

test('approved paid leave is credited once, and working on it is flagged rather than paid twice', () => {
  const leaveDay = day(null, null, { leave: [{ start: clock('09:00'), end: clock('18:00'), paid: true, status: 'APPROVED' }] });
  assert.equal(leaveDay.L, 9 * H);
  assert.equal(leaveDay.ordinary_short, 0);
  assert.equal(leaveDay.classification, 'PAID_LEAVE');

  const workedAnyway = day('09:00', '18:00', { leave: [{ start: clock('09:00'), end: clock('18:00'), paid: true, status: 'APPROVED' }] });
  assert.equal(workedAnyway.C + workedAnyway.L, 9 * H, 'one day, not two');
  assert.ok(workedAnyway.flags.includes('WORKED_DURING_PAID_LEAVE'));
});

test('a half day of leave plus a half day of work is one day', () => {
  const d = day('13:30', '18:00', { leave: [{ start: clock('09:00'), end: clock('13:30'), paid: true, status: 'APPROVED' }] });
  assert.equal(d.L + d.C, 9 * H);
  assert.equal(d.G, 0, 'no second morning grace after morning leave');
  assert.ok(!d.flags.includes('LATE'), 'arriving when the leave ends is not late');
  assert.equal(d.ordinary_short, 0);

  const lateAfterLeave = day('13:45', '18:00', { leave: [{ start: clock('09:00'), end: clock('13:30'), paid: true, status: 'APPROVED' }] });
  assert.ok(lateAfterLeave.flags.includes('LATE'));
  assert.equal(lateAfterLeave.G, 0);
  assert.equal(lateAfterLeave.ordinary_short, 15 * M);
});

test('approved unpaid leave is non-offsettable and is not also counted as a shortage', () => {
  const d = day(null, null, { leave: [{ start: clock('09:00'), end: clock('18:00'), paid: false, status: 'APPROVED' }] });
  assert.equal(d.N, 9 * H);
  assert.equal(d.ordinary_short, 0, 'deducted once, as N');
  assert.equal(d.classification, 'UNPAID_LEAVE');
});

test('pending leave blocks the month rather than being counted as paid or unpaid', () => {
  const d = day(null, null, { leave: [{ start: clock('09:00'), end: clock('18:00'), paid: true, status: 'PENDING' }] });
  assert.equal(d.L, 0);
  assert.equal(d.N, 0);
  assert.equal(d.U, 9 * H);
  assert.ok(d.blockers.includes('PENDING_LEAVE'));
});

// ---------------------------------------------------------------- unrecorded days

test('a past workday with no record needs review, and is not invented as absence', () => {
  const d = day(null, null);
  assert.equal(d.classification, 'UNRECORDED_NEEDS_REVIEW');
  assert.equal(d.N, 0);
  assert.equal(d.U, 9 * H);
  assert.equal(d.ordinary_short, 0);

  const confirmed = day(null, null, { absence: 'UNAPPROVED_ABSENCE' });
  assert.equal(confirmed.classification, 'UNAPPROVED_ABSENCE');
  assert.equal(confirmed.N, 9 * H);
  assert.equal(confirmed.U, 0);
});

test('today without a check-in is "not checked in", and the future is upcoming — neither is absent', () => {
  const today = day(null, null, { phase: 'TODAY' });
  assert.equal(today.classification, 'NOT_CHECKED_IN');
  assert.equal(today.ordinary_short, 0);
  assert.equal(today.U, 0);

  const future = day(null, null, { phase: 'FUTURE' });
  assert.equal(future.classification, 'UPCOMING');
  assert.equal(future.ordinary_short, 0);

  const open = day('09:05', null, { phase: 'TODAY' });
  assert.equal(open.classification, 'IN_PROGRESS');
  assert.equal(open.E_recorded, 0, 'an open session has no extra time yet');
});

test('a missing check-out blocks the day and never becomes a large credit', () => {
  const d = day('09:00', null, { phase: 'PAST' });
  assert.equal(d.classification, 'MISSING_CHECKOUT');
  assert.ok(d.blockers.includes('MISSING_CHECKOUT'));
  assert.equal(d.C, 0);
  assert.equal(d.E_recorded, 0);
  assert.equal(d.U, 9 * H);
});

test('genuine overnight work lands on the day it started, and a very long one needs review before it banks', () => {
  // 09:00 to 02:00 the next morning
  const d = day('09:00', '26:00', {}, { ...POLICY, maxSessionSeconds: 14 * H });
  assert.equal(d.duration, 17 * H);
  assert.equal(d.E_recorded, 8 * H);
  assert.ok(d.flags.includes('LONG_SESSION'));
  assert.equal(d.E_eligible, 0, 'not banked automatically');
  assert.equal(d.E_pending, 8 * H);
  assert.ok(d.blockers.includes('EXTRA_PENDING'));

  const reviewed = day('09:00', '26:00', { extraReview: { status: 'ELIGIBLE', eligibleSeconds: 2 * H, reviewed: true } });
  assert.equal(reviewed.E_eligible, 2 * H, 'a reviewer can accept part of it');
  assert.equal(reviewed.E_rejected, 6 * H);
});

test('extra time awaiting review is held, not used', () => {
  const policy = { ...POLICY, extraRequiresReview: true };
  const d = day('09:00', '19:00', {}, policy);
  assert.equal(d.E_recorded, H);
  assert.equal(d.E_pending, H);
  assert.equal(d.remaining_extra, 0);

  const rejected = day('09:00', '19:00', { extraReview: { status: 'REJECTED' } }, policy);
  assert.equal(rejected.E_rejected, H);
  assert.equal(rejected.E_eligible, 0);
});

test('days off are not absences, and work on them is recorded without automatic credit', () => {
  const off = computeDay({ date: '2026-10-04', schedule: { state: 'WEEKLY_OFF' }, session: null, phase: 'PAST' }, POLICY);
  assert.equal(off.classification, 'WEEKLY_OFF');
  assert.equal(off.R, 0);

  const holidayWork = computeDay({
    date: '2026-10-02', schedule: { state: 'HOLIDAY' },
    session: { checkIn: clock('10:00'), checkOut: clock('14:00'), status: 'COMPLETED' }, phase: 'PAST',
  }, POLICY);
  assert.ok(holidayWork.flags.includes('WORKED_ON_NON_WORKING_DAY'));
  assert.equal(holidayWork.duration, 4 * H);
});

// ---------------------------------------------------------------- the month

test('surplus pools across the month in either direction, each minute once, in a fixed order', () => {
  const days = [
    day('09:00', '18:00', { date: '2026-10-05' }),
    day('09:45', '18:00', { date: '2026-10-06' }), // 45m short
    day('09:00', '19:00', { date: '2026-10-07' }), // 60m surplus
    day('09:30', '18:00', { date: '2026-10-08' }), // 30m short
  ];
  const forwards = computeMonth(days);
  const backwards = computeMonth([...days].reverse());
  assert.deepEqual(forwards, backwards, 'processing order does not change the answer');

  assert.equal(forwards.totals.cross_day_offset, 60 * M);
  assert.equal(forwards.totals.residual_short, 15 * M);
  assert.equal(forwards.totals.unused_extra, 0);
  // the later surplus covers the earlier shortfall first, then the next
  assert.deepEqual(forwards.allocations, [
    { source_date: '2026-10-07', target_date: '2026-10-06', seconds: 45 * M },
    { source_date: '2026-10-07', target_date: '2026-10-08', seconds: 15 * M },
  ]);
});

test('unused surplus is shown, not paid out and not thrown away', () => {
  const month = computeMonth([
    day('09:00', '20:00', { date: '2026-10-05' }),
    day('09:10', '18:00', { date: '2026-10-06' }),
  ]);
  assert.equal(month.totals.unused_extra, 2 * H);
  assert.equal(month.totals.unpaid, 0);
  assert.equal(month.totals.salary_credited, month.totals.required, 'never above the ordinary entitlement');
});

test('the brief\'s monthly example: ₹30,000, 26 days, 13 unpaid hours, ₹1,666.67', () => {
  // build the month the example describes, out of real days
  const days = [];
  let date = 1;
  const next = () => `2026-10-${String(date++).padStart(2, '0')}`;

  // 2 paid-leave days, 1 confirmed unpaid day
  days.push(day(null, null, { date: next(), leave: [{ start: clock('09:00'), end: clock('18:00'), paid: true, status: 'APPROVED' }] }));
  days.push(day(null, null, { date: next(), leave: [{ start: clock('09:00'), end: clock('18:00'), paid: true, status: 'APPROVED' }] }));
  days.push(day(null, null, { date: next(), absence: 'UNAPPROVED_ABSENCE' }));

  // 23 attended days giving 196h30m in-schedule coverage, 3h of grace,
  // 7h30m of ordinary shortage before offsets, and 3h30m of eligible extra
  //   12 days at 09:15–18:00 → 12 × 15m grace = 3h, no shortage
  for (let i = 0; i < 12; i += 1) days.push(day('09:15', '18:00', { date: next() }));
  //   5 days at 09:00–18:00
  for (let i = 0; i < 5; i += 1) days.push(day('09:00', '18:00', { date: next() }));
  //   5 days at 09:00–16:30 → 5 × 1h30m = 7h30m short
  for (let i = 0; i < 5; i += 1) days.push(day('09:00', '16:30', { date: next() }));
  //   1 day at 09:00–21:30 → 3h30m eligible extra
  days.push(day('09:00', '21:30', { date: next() }));

  const month = computeMonth(days);
  const t = month.totals;
  assert.equal(month.days.scheduled, 26);
  assert.equal(t.required, 234 * H);
  assert.equal(t.in_schedule, 196 * H + 30 * M);
  assert.equal(t.grace, 3 * H);
  assert.equal(t.paid_leave, 18 * H);
  assert.equal(t.ordinary_short, 7 * H + 30 * M);
  assert.equal(t.extra_eligible, 3 * H + 30 * M);
  assert.equal(t.same_day_offset + t.cross_day_offset, 3 * H + 30 * M);
  assert.equal(t.residual_short, 4 * H);
  assert.equal(t.non_offsettable_unpaid, 9 * H);
  assert.equal(t.unpaid, 13 * H);
  assert.equal(t.salary_credited, 221 * H);
  assert.equal(month.final, true);

  const salary = computeSalary([{
    monthlyBase: 30000, fullMonthRequired: t.required, segmentRequired: t.required, segmentUnpaid: t.unpaid,
  }]);
  assert.equal(salary.attendance_adjustment, 1666.67);
  assert.equal(salary.attendance_adjusted_earnings, 28333.33);
});

test('a month with anything unresolved is provisional, not final', () => {
  const month = computeMonth([day('09:00', '18:00', { date: '2026-10-05' }), day(null, null, { date: '2026-10-06' })]);
  assert.equal(month.final, false);
  assert.ok(month.blockers.includes('UNRECORDED'));
  assert.equal(month.totals.unresolved, 9 * H);
  assert.equal(month.totals.unpaid, 0, 'unresolved time is not quietly deducted');
});

// ---------------------------------------------------------------- salary

test('joining mid-month is prorated once, then only in-period shortages apply', () => {
  // joined for 13 of 26 scheduled days, attended every one of them
  const s = computeSalary([{ monthlyBase: 30000, fullMonthRequired: 234 * H, segmentRequired: 117 * H, segmentUnpaid: 0 }]);
  assert.equal(s.entitlement, 15000);
  assert.equal(s.attendance_adjusted_earnings, 15000, 'not a full month for half a month');
});

test('a salary change mid-month is split into segments', () => {
  const s = computeSalary([
    { monthlyBase: 30000, fullMonthRequired: 234 * H, segmentRequired: 117 * H, segmentUnpaid: 9 * H },
    { monthlyBase: 36000, fullMonthRequired: 234 * H, segmentRequired: 117 * H, segmentUnpaid: 0 },
  ]);
  assert.equal(s.entitlement, 33000);
  // 15,000 × 9/117 = 1,153.85
  assert.equal(s.attendance_adjustment, 1153.85);
  assert.equal(s.attendance_adjusted_earnings, 31846.15);
});

test('no required time means "needs review", never a division by zero or a zero salary', () => {
  const s = computeSalary([{ monthlyBase: 30000, fullMonthRequired: 0, segmentRequired: 0, segmentUnpaid: 0 }]);
  assert.equal(s.status, 'NOT_APPLICABLE');
  assert.equal(computeSalary([]).status, 'NEEDS_SETUP');
});

test('unpaid time can never exceed required time in the salary', () => {
  const s = computeSalary([{ monthlyBase: 30000, fullMonthRequired: 9 * H, segmentRequired: 9 * H, segmentUnpaid: 20 * H }]);
  assert.equal(s.attendance_adjusted_earnings, 0);
  assert.equal(s.attendance_adjustment, 30000);
});

// ---------------------------------------------------------------- display and intervals

test('durations display as hours and minutes, and convert to true decimals', () => {
  assert.equal(hhmm(8 * H + 30 * M), '8:30');
  assert.equal(decimalHours(8 * H + 30 * M), 8.5, '8h30m is 8.5, not 8.30');
  assert.equal(hhmm(-30 * M), '−0:30');
});

test('interval arithmetic never double-counts', () => {
  assert.equal(length(union([[0, 10]], [[5, 15]])), 15);
  assert.deepEqual(intersect([[0, 10]], [[5, 15]]), [[5, 10]]);
  assert.deepEqual(subtract([[0, 10]], [[2, 4], [6, 8]]), [[0, 2], [4, 6], [8, 10]]);
});

// ---------------------------------------------------------------- before tracking starts

const PRE_START = { ...WORKDAY, beforeStart: true };

test('before tracking starts, a working day someone checked in on is worked out in full — not "a day off"', () => {
  const d = computeDay({
    date: '2026-10-05', schedule: PRE_START, phase: 'PAST', leave: [],
    session: { checkIn: clock('10:00'), checkOut: clock('18:30'), status: 'COMPLETED' },
  }, POLICY);
  assert.equal(d.classification, 'ATTENDED');
  assert.ok(!d.flags.includes('WORKED_ON_NON_WORKING_DAY'));
  assert.ok(d.flags.includes('LATE'));
  assert.equal(d.R, 9 * H);
  assert.equal(d.duration, 8 * H + 30 * M);
  assert.equal(d.late_seconds, 60 * M);
  // the hours are shown, but before tracking starts nothing is owed or queued
  assert.equal(d.E_recorded, 30 * M);
  assert.equal(d.ordinary_short, 0);
  assert.equal(d.remaining_short, 0);
  assert.equal(d.E_pending, 0);
  assert.deepEqual(d.blockers, []);
  const month = computeMonth([d]);
  assert.equal(month.totals.unpaid, 0);

  const today = computeDay({
    date: '2026-10-05', schedule: PRE_START, phase: 'TODAY', leave: [],
    session: { checkIn: clock('10:00'), checkOut: null, status: 'OPEN' },
  }, POLICY);
  assert.equal(today.classification, 'IN_PROGRESS');
  assert.deepEqual(today.flags, ['LATE']);
});

test('before tracking starts, a day with no check-in is not owed, not short and not waiting for review', () => {
  const past = computeDay({ date: '2026-10-02', schedule: PRE_START, phase: 'PAST', leave: [], session: null }, POLICY);
  assert.equal(past.classification, 'BEFORE_START');
  assert.equal(past.R, 0);
  assert.equal(past.ordinary_short, 0);
  assert.deepEqual(past.blockers, []);
  const today = computeDay({ date: '2026-10-05', schedule: PRE_START, phase: 'TODAY', leave: [], session: null }, POLICY);
  assert.equal(today.classification, 'NOT_CHECKED_IN');
  const leave = computeDay({
    date: '2026-10-02', schedule: PRE_START, phase: 'PAST', session: null,
    leave: [{ start: clock('09:00'), end: clock('18:00'), paid: true, status: 'APPROVED' }],
  }, POLICY);
  assert.equal(leave.classification, 'PAID_LEAVE', 'leave still shows as leave');
});

test('a real weekly off is still a day off, before tracking starts or after', () => {
  for (const beforeStart of [true, false]) {
    const d = computeDay({
      date: '2026-10-04', schedule: { ...WORKDAY, state: 'WEEKLY_OFF', beforeStart }, phase: 'PAST', leave: [],
      session: { checkIn: clock('11:00'), checkOut: clock('13:00'), status: 'COMPLETED' },
    }, POLICY);
    assert.deepEqual(d.flags, ['WORKED_ON_NON_WORKING_DAY']);
  }
});
