/**
 * How availability reads.
 *
 * The thing worth guarding is dates. Leave is a calendar date, and the easy bug
 * is to push "2026-10-14" through a Date and get the 13th back in a browser west
 * of UTC. These helpers keep dates as strings end to end, and the wording must
 * never claim more than the entry says.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dayLabel, describeConflict, describeEntry, formatDays, moveDeadlineTo, rangeLabel,
  todayIn, weekdayOf,
} from '../src/lib/availability.js';

const entry = (patch = {}) => ({
  id: 1, user_id: 2, status: 'ON_LEAVE', start_date: '2026-10-12', end_date: '2026-10-16',
  day_part: null, note: null, planned: true, back_on: '2026-10-17', ...patch,
});

test('dates stay dates, whatever the machine timezone', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOf('2026-10-12'), 1, 'a Monday');
  assert.equal(dayLabel('2026-10-12'), 'Mon 12 Oct');
  assert.equal(todayIn('Asia/Kolkata', new Date('2026-10-14T19:00:00Z')), '2026-10-15');
});

test('ranges read the way people say them', () => {
  assert.equal(rangeLabel('2026-10-12', '2026-10-16'), '12–16 Oct');
  assert.equal(rangeLabel('2026-10-30', '2026-11-02'), '30 Oct – 2 Nov');
  assert.equal(rangeLabel('2026-10-12', '2026-10-12'), 'Mon 12 Oct');
});

test('an entry is described relative to today', () => {
  assert.equal(describeEntry(null, '2026-10-01'), 'Available');
  assert.equal(describeEntry(entry(), '2026-10-01'), 'Planned leave, 12–16 Oct');
  assert.equal(describeEntry(entry(), '2026-10-14'), 'On leave until Fri 16 Oct, back Sat 17 Oct');
  assert.equal(describeEntry(entry(), '2026-10-16'), 'On leave today');
  assert.equal(
    describeEntry(entry({ status: 'HALF_DAY', start_date: '2026-10-14', end_date: '2026-10-14', day_part: 'AFTERNOON' }), '2026-10-14'),
    'Half day (afternoon) today',
  );
  assert.equal(
    describeEntry(entry({ status: 'UNAVAILABLE', planned: true }), '2026-10-01'),
    'Unavailable, 12–16 Oct',
    'only leave is called planned leave',
  );
});

test('the warning names the day and offers what the entry supports', () => {
  const onDue = describeConflict({
    full_name: 'Vartika Gupta', due_date: '2026-10-14', on_due_date: entry({ note: 'Family wedding' }),
    working_days_away: 3, working_days_until_due: 5, entries: [entry()],
  });
  assert.equal(onDue.severity, 'warning');
  assert.equal(onDue.headline, 'Vartika is on leave on Wed 14 Oct, the day this is due.');
  assert.match(onDue.detail, /Family wedding/);

  const half = describeConflict({
    full_name: 'Rahul Mehta', due_date: '2026-10-14',
    on_due_date: entry({ status: 'HALF_DAY', start_date: '2026-10-14', end_date: '2026-10-14', day_part: 'MORNING' }),
    working_days_away: 0.5, working_days_until_due: 3, entries: [],
  });
  assert.equal(half.severity, 'info', 'a half day is worth knowing, not a red flag');
  assert.match(half.headline, /half day \(morning\)/);

  const before = describeConflict({
    full_name: 'Rahul Mehta', due_date: '2026-10-20', on_due_date: null,
    working_days_away: 2, working_days_until_due: 6, entries: [entry({ start_date: '2026-10-14', end_date: '2026-10-15' })],
  });
  assert.equal(before.headline, 'Rahul is away 2 days of the 6 working days before this is due.');

  assert.equal(describeConflict(null), null);
  assert.equal(formatDays(0.5), 'half a day');
  assert.equal(formatDays(1), '1 day');
});

test('moving the deadline keeps the time of day', () => {
  assert.equal(moveDeadlineTo('2026-10-14T18:00', '2026-10-17'), '2026-10-17T18:00');
  assert.equal(moveDeadlineTo('', '2026-10-17'), '2026-10-17T18:00');
});
