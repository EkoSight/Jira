/**
 * How the holiday calendar reads on screen.
 *
 * Guarded here: dates are calendar dates (never shifted by the phone's
 * timezone); a range added together shows as one line, but a cancelled date in
 * it does not hide among the dates in force; who it covers is named; and the
 * impact summary says what applies at once and what waits for a person.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByMonth, hoursWords, impactLines, rangeWords, scopeWords, shortDate } from '../src/lib/holidays.js';

const entry = (id, date, extra = {}) => ({ id, holiday_date: date, name: 'Synthetic break', coverage: 'FULL', kind: 'HOLIDAY', status: 'APPROVED', series_id: 's1', ...extra });

test('dates are calendar dates', () => {
  assert.equal(shortDate('2026-10-09'), 'Fri 9 Oct');
  assert.equal(shortDate('2026-11-01'), 'Sun 1 Nov');
  assert.equal(rangeWords('2026-09-30', '2026-10-01'), 'Wed 30 Sep – Thu 1 Oct');
  assert.equal(rangeWords('2026-10-09', '2026-10-09'), 'Fri 9 Oct');
  assert.equal(shortDate(null), '');
});

test('a range shows as one line per month; a cancelled date stands apart', () => {
  const months = groupByMonth([
    entry(3, '2026-10-01'),
    entry(1, '2026-09-29'),
    entry(2, '2026-09-30'),
    entry(4, '2026-10-02', { status: 'CANCELLED' }),
    entry(5, '2026-10-20', { series_id: 's2', name: 'Another' }),
  ]);
  assert.deepEqual(months.map((m) => m.label), ['September 2026', 'October 2026']);
  assert.equal(months[0].rows.length, 1);
  assert.equal(months[0].rows[0].start, '2026-09-29');
  assert.equal(months[0].rows[0].end, '2026-09-30');
  assert.equal(months[1].rows.length, 3, 'in force, cancelled, and a different holiday');
  assert.equal(months[1].rows[1].status, 'CANCELLED');
  assert.equal(months[1].inForce, 2);
});

test('who it covers is named', () => {
  assert.equal(scopeWords({ department_id: null, user_id: null }), 'Everyone');
  assert.equal(scopeWords({ department_id: 3, department_name: 'Sales' }), 'Sales');
  assert.equal(scopeWords({ scope: 'PERSON', user_id: 9 }, { users: [{ id: 9, full_name: 'Ana Sample' }] }), 'Ana Sample');
});

test('the impact says what applies at once and what waits for a person', () => {
  assert.deepEqual(impactLines(null), []);
  const lines = impactLines({
    summary: { attendance_days: 3, marks_to_waive: 2, marks_to_create: 1, standup_to_excuse: 1, leave_days_to_release: 1, payroll_drafts: 0 },
    attendance: { people: 3, required_seconds_change: -27000, unrecorded_cleared: 1, absences_lifted: 1, unrecorded_created: 0, absences_restored: 0 },
  });
  assert.deepEqual(lines.map((l) => l.area), ['Attendance', 'Black marks', 'Standup', 'Leave']);
  assert.match(lines[0].text, /3 attendance days for 3 people \(−7h 30m required\)/);
  assert.match(lines[0].text, /1 confirmed absence no longer count/);
  assert.match(lines[0].applies, /Check-in records are not changed/);
  assert.equal(lines[1].text, '2 to waive, 1 to record');
  assert.match(lines[1].applies, /Only when someone/);
  assert.equal(lines[3].text, '1 leave day to give back');
  assert.equal(hoursWords(16200), '+4h 30m');
  assert.equal(hoursWords(0), '0h');
});
