/**
 * November 2026 audit: the calculation engine.
 *
 * Synthetic fixtures only. The schedule here (Monday–Saturday, 09:00–18:00, no
 * break, 20-minute threshold grace) is a test fixture, not a company policy.
 *
 *   C  approved leave today and in the future is shown as leave, and future
 *      leave is never accrued as paid leave or unpaid time
 *   D  a missing check-out never makes grace and unresolved time overlap
 *   6  half days, overlapping leave and absence, and days off are never
 *      counted twice
 *   the partition rule C + L + G + N + U ≤ R, over many random days
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clock, computeDay, computeMonth, conservationExcess,
} from '../src/lib/attendanceCalc.js';

const M = 60;
const H = 3600;
const POLICY = { graceSeconds: 20 * M, graceMode: 'THRESHOLD', creditBeforeStart: true, extraRequiresReview: false, maxSessionSeconds: 14 * H };
const WORKDAY = { state: 'WORKDAY', start: clock('09:00'), end: clock('18:00'), breaks: [] };
const FIRST_HALF = [clock('09:00'), clock('13:30')];
const SECOND_HALF = [clock('13:30'), clock('18:00')];
const WHOLE = [clock('09:00'), clock('18:00')];

const leave = ([start, end], status, paid) => ({ start, end, status, paid });

function run({ checkIn = null, checkOut = null, status, phase = 'PAST', leaves = [], absence = null, schedule = WORKDAY } = {}) {
  return computeDay({
    date: '2026-11-04',
    schedule,
    session: checkIn === null ? null : {
      checkIn: clock(checkIn),
      checkOut: checkOut === null ? null : clock(checkOut),
      status: status || (checkOut === null ? 'OPEN' : 'COMPLETED'),
      regularized: false,
    },
    leave: leaves,
    absence,
    phase,
  }, POLICY);
}

// ---------------------------------------------------------------- C: today and future

test('C: approved paid full-day leave today shows as paid leave, not "not checked in"', () => {
  const d = run({ phase: 'TODAY', leaves: [leave(WHOLE, 'APPROVED', true)] });
  assert.equal(d.classification, 'PAID_LEAVE');
  assert.equal(d.L, 9 * H);
  assert.equal(d.U, 0);
  assert.deepEqual(d.blockers, []);
});

test('C: approved unpaid full-day leave today shows as unpaid leave', () => {
  const d = run({ phase: 'TODAY', leaves: [leave(WHOLE, 'APPROVED', false)] });
  assert.equal(d.classification, 'UNPAID_LEAVE');
  assert.equal(d.N, 9 * H);
  assert.equal(d.L, 0);
});

test('C: pending full-day leave today is pending, never approved', () => {
  const d = run({ phase: 'TODAY', leaves: [leave(WHOLE, 'PENDING', false)] });
  assert.equal(d.classification, 'PENDING_LEAVE');
  assert.equal(d.L, 0);
  assert.equal(d.N, 0);
  assert.ok(d.blockers.includes('PENDING_LEAVE'));
});

test('C: a half day of approved leave today keeps the day open and says so', () => {
  const d = run({ phase: 'TODAY', leaves: [leave(FIRST_HALF, 'APPROVED', true)] });
  assert.equal(d.classification, 'NOT_CHECKED_IN');
  assert.ok(d.flags.includes('ON_LEAVE_PART_OF_DAY'));
  assert.equal(d.L, 0, 'nothing accrues until the day is over');
});

test('C: future approved paid leave is planned — visible, but never accrued', () => {
  const d = run({ phase: 'FUTURE', leaves: [leave(WHOLE, 'APPROVED', true)] });
  assert.equal(d.classification, 'PLANNED_PAID_LEAVE');
  assert.equal(d.future, true);
  assert.equal(d.planned_paid_leave, 9 * H);
  assert.equal(d.L, 0);
  assert.equal(d.N, 0);
  assert.equal(d.U, 0);
  assert.equal(d.remaining_short, 0);
});

test('C: future approved unpaid leave is planned and deducts nothing yet', () => {
  const d = run({ phase: 'FUTURE', leaves: [leave(WHOLE, 'APPROVED', false)] });
  assert.equal(d.classification, 'PLANNED_UNPAID_LEAVE');
  assert.equal(d.planned_unpaid_leave, 9 * H);
  assert.equal(d.N, 0);
});

test('C: future pending leave stays upcoming, flagged pending — never planned as approved', () => {
  const d = run({ phase: 'FUTURE', leaves: [leave(WHOLE, 'PENDING', false)] });
  assert.equal(d.classification, 'UPCOMING');
  assert.ok(d.flags.includes('LEAVE_PENDING'));
  assert.equal(d.planned_paid_leave, 0);
});

test('C: a month with planned leave keeps it out of required-so-far, paid leave and unpaid', () => {
  const past = run({ checkIn: '09:00', checkOut: '18:00' });
  const today = run({ phase: 'TODAY', leaves: [leave(WHOLE, 'APPROVED', true)] });
  const planned = { ...run({ phase: 'FUTURE', leaves: [leave(WHOLE, 'APPROVED', true)] }), date: '2026-11-06' };
  const upcoming = { ...run({ phase: 'FUTURE' }), date: '2026-11-07' };
  const month = computeMonth([{ ...past, date: '2026-11-03' }, { ...today, date: '2026-11-04' }, planned, upcoming]);
  assert.equal(month.totals.required, 36 * H);
  assert.equal(month.totals.required_to_date, 18 * H, 'only the two days that have started');
  assert.equal(month.totals.paid_leave, 9 * H, 'today only — the planned day is not accrued');
  assert.equal(month.totals.planned_leave, 9 * H);
  assert.equal(month.totals.unpaid, 0);
  assert.equal(month.days.upcoming, 2);
  assert.equal(month.days.planned_leave, 1);
});

// ---------------------------------------------------------------- D: missing check-out

test('D: a 09:10 check-in with no check-out: grace and unresolved never overlap', () => {
  const d = run({ checkIn: '09:10', checkOut: null, status: 'MISSING_CHECKOUT' });
  assert.equal(d.R, 9 * H);
  assert.equal(d.G, 10 * M);
  assert.equal(d.U, 8 * H + 50 * M, 'the rest of the day, not all of it');
  assert.ok(d.C + d.L + d.G + d.N + d.U <= d.R);
  assert.equal(conservationExcess(d), 0);
  assert.equal(d.classification, 'MISSING_CHECKOUT');
  assert.ok(d.blockers.includes('MISSING_CHECKOUT'), 'finalisation stays blocked');
  assert.equal(d.duration, 0, 'no check-out is invented');
  assert.ok(!d.flags.includes('ACCOUNTING_CHECK_FAILED'));
});

test('D: a missing check-out with a half day of approved leave splits the day exactly', () => {
  const d = run({ checkIn: '13:35', checkOut: null, status: 'MISSING_CHECKOUT', leaves: [leave(FIRST_HALF, 'APPROVED', true)] });
  assert.equal(d.L, 4 * H + 30 * M);
  assert.equal(d.L + d.G + d.U, d.R);
  assert.equal(conservationExcess(d), 0);
});

// ---------------------------------------------------------------- 6: no double counting

test('6: half-day presence plus half-day paid leave is a full day, counted once', () => {
  const d = run({ checkIn: '13:30', checkOut: '18:00', leaves: [leave(FIRST_HALF, 'APPROVED', true)] });
  assert.equal(d.C, 4 * H + 30 * M);
  assert.equal(d.L, 4 * H + 30 * M);
  assert.equal(d.C + d.L, d.R);
  assert.equal(d.remaining_short, 0);
  assert.equal(d.classification, 'ATTENDED_WITH_PARTIAL_LEAVE');
});

test('6: half-day presence plus half-day unpaid leave: the unpaid half is deducted once', () => {
  const d = run({ checkIn: '09:00', checkOut: '13:30', leaves: [leave(SECOND_HALF, 'APPROVED', false)] });
  assert.equal(d.N, 4 * H + 30 * M);
  assert.equal(d.remaining_short, 0, 'the unpaid half is N, not also a shortfall');
  assert.equal(d.C + d.N, d.R);
});

test('6: overlapping approved paid and unpaid leave on the same hours never counts twice', () => {
  const d = run({ leaves: [leave(WHOLE, 'APPROVED', true), leave(FIRST_HALF, 'APPROVED', false)] });
  assert.equal(d.L, 9 * H, 'paid leave wins where both cover the same time');
  assert.equal(d.N, 0);
  assert.equal(conservationExcess(d), 0);
});

test('6: approved leave plus a confirmed absence on the same day: one deduction, not two', () => {
  const d = run({ leaves: [leave(FIRST_HALF, 'APPROVED', false)], absence: 'UNAPPROVED_ABSENCE' });
  assert.equal(d.N, 9 * H, 'the unpaid half and the absent half, each once');
  assert.equal(d.remaining_short, 0);
  assert.equal(conservationExcess(d), 0);
});

test('6: leave on a weekly off or holiday is not counted at all', () => {
  for (const state of ['WEEKLY_OFF', 'HOLIDAY']) {
    const d = run({ schedule: { ...WORKDAY, state }, leaves: [leave(WHOLE, 'APPROVED', true)] });
    assert.equal(d.R, 0);
    assert.equal(d.L, 0);
    assert.equal(d.N, 0);
    assert.equal(d.classification, state);
  }
});

// ---------------------------------------------------------------- the partition rule

test('partition rule: C + L + G + N + U never exceeds R over 3,000 random days', () => {
  // a small deterministic generator, so a failure can be reproduced
  let seed = 20261101;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const minute = (from, to) => clock(from) + Math.floor(rand() * ((clock(to) - clock(from)) / 60)) * 60;
  const asClock = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;

  for (let i = 0; i < 3000; i += 1) {
    const inAt = rand() < 0.2 ? null : minute('07:00', '17:00');
    const outAt = inAt === null || rand() < 0.25 ? null : Math.min(inAt + Math.floor(rand() * 12 * 60) * 60 + 60, clock('23:59'));
    const leaves = [];
    for (let k = 0; k < Math.floor(rand() * 3); k += 1) {
      leaves.push(leave(pick([WHOLE, FIRST_HALF, SECOND_HALF]), pick(['APPROVED', 'APPROVED', 'PENDING']), rand() < 0.5));
    }
    const d = run({
      checkIn: inAt === null ? null : asClock(inAt),
      checkOut: outAt === null ? null : asClock(outAt),
      status: inAt !== null && outAt === null ? pick(['OPEN', 'MISSING_CHECKOUT']) : undefined,
      phase: pick(['PAST', 'PAST', 'PAST', 'TODAY', 'FUTURE']),
      leaves,
      absence: rand() < 0.2 ? 'UNAPPROVED_ABSENCE' : null,
    });
    assert.equal(conservationExcess(d), 0, `day ${i}: ${JSON.stringify({ inAt, outAt, leaves, d: [d.R, d.C, d.L, d.G, d.N, d.U] })}`);
    assert.ok(!d.flags.includes('ACCOUNTING_CHECK_FAILED'));
    for (const key of ['C', 'L', 'G', 'N', 'U', 'remaining_short']) assert.ok(d[key] >= 0, `${key} is never negative`);
  }
});
