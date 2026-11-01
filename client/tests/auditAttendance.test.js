/**
 * November 2026 audit: what the screens show. Synthetic data only.
 *
 *   8   blockers from attendance (codes) and payroll ({ code, label }) both
 *       read as words — never "[object Object]"
 *   9   the payroll headline says how much of the team it covers; with
 *       nothing calculated there is no total, never a zero
 *   10  out-of-order October/November answers, empty answers and failures:
 *       the month on screen never shows another month's data, and a failure is
 *       an error with a retry, not an empty or zero result
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKER_LABEL, blockerKey, blockerLabel, dayMeta, payrollCoverage } from '../src/lib/attendance.js';
import { createSequencer, settle } from '../src/lib/useLoad.js';

// ---------------------------------------------------------------- 8: blockers

test('8: a blocker code from the attendance month reads as words', () => {
  assert.equal(blockerLabel('MISSING_CHECKOUT'), BLOCKER_LABEL.MISSING_CHECKOUT);
  assert.equal(blockerLabel('MONTH_NOT_OVER'), 'Month not over');
});

test('8: a { code, label } blocker from payroll reads as words, not [object Object]', () => {
  const fromPayroll = { code: 'UNRECORDED', label: 'scheduled days with no attendance and no review' };
  assert.equal(blockerLabel(fromPayroll), BLOCKER_LABEL.UNRECORDED);
  assert.equal(`Provisional: ${[fromPayroll, 'PENDING_LEAVE'].map(blockerLabel).join(' · ')}.`,
    'Provisional: No attendance and no review · Leave still pending.');
});

test('8: unknown codes, label-only objects and junk still read as text', () => {
  assert.equal(blockerLabel('SOME_NEW_CHECK'), 'Some new check');
  assert.equal(blockerLabel({ code: 'ANOTHER_CHECK' }), 'Another check');
  assert.equal(blockerLabel({ label: 'Waiting on HR' }), 'Waiting on HR');
  assert.equal(blockerLabel({}), 'Unknown item');
  assert.equal(blockerLabel(null), 'Unknown item');
  for (const b of ['X', { code: 'Y' }, { label: 'Z' }, {}, null, undefined, 42]) {
    assert.doesNotMatch(blockerLabel(b), /\[object/);
  }
  assert.equal(blockerKey({ code: 'A', label: 'b' }), 'A');
  assert.equal(blockerKey('A'), 'A');
});

test('8: planned leave on future days has its own words', () => {
  assert.equal(dayMeta('PLANNED_PAID_LEAVE').label, 'Paid leave · planned');
  assert.equal(dayMeta('PLANNED_UNPAID_LEAVE').label, 'Unpaid leave · planned');
});

// ---------------------------------------------------------------- 9: coverage

const row = (status, salary = null) => ({ status, salary });
const calc = (earnings, adjustment = 0) => ({ status: 'CALCULATED', attendance_adjusted_earnings: earnings, attendance_adjustment: adjustment, currency: 'INR' });

test('9: nothing calculated — no total at all, and it says why', () => {
  const c = payrollCoverage(Array.from({ length: 28 }, () => row('NEEDS_SETUP', { status: 'MISSING_BASIS' })));
  assert.equal(c.state, 'NONE');
  assert.equal(c.calculated, 0);
  assert.equal(c.total, 28);
  assert.equal(c.needs_setup, 28);
  assert.equal(c.earnings, null, 'no zero total that reads like a result');
  assert.equal(c.final, false);
});

test('9: partly calculated — the total covers the calculated rows only and says how many are missing', () => {
  const people = [row('PROVISIONAL', calc(10000, 500)), ...Array.from({ length: 27 }, () => row('NEEDS_SETUP'))];
  const c = payrollCoverage(people);
  assert.equal(c.state, 'PARTIAL');
  assert.equal(c.calculated, 1);
  assert.equal(c.missing, 27);
  assert.equal(c.earnings, 10000);
  assert.equal(c.adjustment, 500);
  assert.equal(c.final, false);
});

test('9: everything calculated but not ready is a provisional total; all ready is final', () => {
  const provisional = payrollCoverage([row('READY', calc(100)), row('PROVISIONAL', calc(200))]);
  assert.equal(provisional.state, 'COMPLETE');
  assert.equal(provisional.earnings, 300);
  assert.equal(provisional.final, false);
  const ready = payrollCoverage([row('READY', calc(100)), row('READY', calc(200))]);
  assert.equal(ready.final, true);
});

test('9: different currencies are never added together', () => {
  const c = payrollCoverage([row('READY', calc(100)), row('READY', { ...calc(200), currency: 'USD' })]);
  assert.equal(c.mixed_currency, true);
  assert.equal(c.earnings, null);
});

test('9: an empty month is empty, not zero', () => {
  const c = payrollCoverage([]);
  assert.equal(c.state, 'EMPTY');
  assert.equal(c.earnings, null);
});

// ---------------------------------------------------------------- 10: stale answers

/** Plays requests through the same rules the screens use. */
function screen(accept) {
  const sequencer = createSequencer();
  let shown = { status: 'loading', data: null };
  return {
    ask() {
      const isLatest = sequencer.next();
      shown = { status: 'loading', data: null };
      return (outcome) => {
        const next = settle({ isLatest, accept }, outcome);
        if (next) shown = next;
      };
    },
    get shown() { return shown; },
  };
}

test('10: a slow October answer arriving after November was chosen is dropped', () => {
  let selected = '2026-10';
  const s = screen((d) => d?.month?.slice(0, 7) === selected);
  const october = s.ask();
  selected = '2026-11';
  const november = s.ask();
  november({ data: { month: '2026-11-01', people: ['N'] } });
  october({ data: { month: '2026-10-01', people: ['O'] } });
  assert.equal(s.shown.status, 'ready');
  assert.equal(s.shown.data.month, '2026-11-01');
  assert.deepEqual(s.shown.data.people, ['N']);
});

test('10: an answer for a different period than asked is an error, not shown', () => {
  const s = screen((d) => d?.month?.slice(0, 7) === '2026-11');
  s.ask()({ data: { month: '2026-10-01', people: ['O'] } });
  assert.equal(s.shown.status, 'error');
  assert.equal(s.shown.data, null);
});

test('10: a failure is an error with nothing from before — not an empty month or a zero', () => {
  const s = screen((d) => Boolean(d));
  s.ask()({ data: { month: '2026-11-01', people: ['N'] } });
  assert.equal(s.shown.status, 'ready');
  s.ask()({ error: new Error('Cannot reach the server') });
  assert.equal(s.shown.status, 'error');
  assert.equal(s.shown.data, null, 'the earlier success is not passed off as current');
  assert.match(s.shown.error.message, /Cannot reach/);
});

test('10: a late failure for an old request does not wipe the current month', () => {
  const s = screen(() => true);
  const old = s.ask();
  const current = s.ask();
  current({ data: { month: '2026-11-01' } });
  old({ error: new Error('timeout') });
  assert.equal(s.shown.status, 'ready');
});

test('10: an empty answer is a real, empty result — and a retry after failure recovers', () => {
  const s = screen(() => true);
  s.ask()({ error: new Error('offline') });
  assert.equal(s.shown.status, 'error');
  s.ask()({ data: { month: '2026-11-01', people: [] } });
  assert.equal(s.shown.status, 'ready');
  assert.deepEqual(s.shown.data.people, []);
});

test('10: a copy served from the device while offline is marked as such', () => {
  const s = screen(() => true);
  s.ask()({ data: { month: '2026-11-01', __offline: true } });
  assert.equal(s.shown.offline, true);
});

test('9: calculated rows that can still change are counted, so the total is never read as final', () => {
  const c = payrollCoverage([
    { status: 'NEEDS_SETUP', salary: calc(30000), totals: { unresolved: 243 * 3600 } },
    { status: 'NEEDS_SETUP', salary: null, totals: { unresolved: 0 } },
  ]);
  assert.equal(c.with_unresolved, 1);
  assert.equal(c.not_ready_calculated, 1);
  assert.equal(c.final, false);
});
