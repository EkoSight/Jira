/**
 * The Goal screens' derivation helpers.
 *
 * Everything under test here is read-only: it turns rows the server already
 * sent into the words and buckets a person reads. None of it writes anything,
 * so the thing worth guarding is that it never overstates what the data says —
 * "not measurable" must not come out as "no progress", and an attention flag
 * must not appear on something nobody needs to look at.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KR_FILTERS, byUrgency, contributors, daysLeftLabel, filterCounts,
  formatValue, krAttention, measurementSummary, myContribution, pace, paceSentence,
} from '../src/lib/okr.js';

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

const keyResult = (patch = {}) => ({
  id: 1,
  title: 'Onboard farmers',
  measurement_type: 'NUMBER',
  direction: 'INCREASE',
  baseline_value: 0,
  target_value: 100,
  current_value: 40,
  unit: 'farmers',
  status: 'ACTIVE',
  health: 'ON_TRACK',
  progress_percent: 40,
  time_elapsed_percent: 40,
  linked_task_count: 2,
  needs_target: false,
  owner_user_id: 7,
  owner_name: 'Asha',
  owner_color: '#2a78d6',
  last_check_in_at: daysAgo(2),
  ...patch,
});

const objective = (patch = {}) => ({
  id: 10,
  title: 'Reach 10,000 farmers',
  status: 'ACTIVE',
  progress_percent: 40,
  time_elapsed_percent: 40,
  key_result_count: 3,
  end_date: daysAhead(30),
  ...patch,
});

// ---------------------------------------------------------------- pace

test('pace measures the gap in points, not as a ratio', () => {
  assert.equal(pace(60, 40).delta, 20);
  assert.equal(pace(60, 40).verdict, 'ahead');
  assert.equal(pace(38, 40).verdict, 'on', 'a couple of points behind is not a problem');
  assert.equal(pace(25, 40).verdict, 'behind');
  assert.equal(pace(5, 40).verdict, 'far-behind');
});

test('pace says nothing at all when there is nothing to compare', () => {
  assert.equal(pace(null, 40).verdict, 'unknown');
  assert.equal(pace(40, null).verdict, 'unknown');
  assert.equal(pace(null, null).delta, null);
});

test('the pace tone matches the verdict, so colour and words cannot disagree', () => {
  assert.equal(pace(60, 40).tone, 'good');
  assert.equal(pace(38, 40).tone, 'good');
  assert.equal(pace(25, 40).tone, 'warning');
  assert.equal(pace(5, 40).tone, 'critical');
});

// ------------------------------------------------------------ the sentence

test('the headline sentence reports the status before it reports a number', () => {
  assert.match(paceSentence(objective({ status: 'COMPLETED' })), /finished/);
  assert.match(paceSentence(objective({ status: 'ON_HOLD' })), /on hold/);
  assert.match(paceSentence(objective({ status: 'DRAFT' })), /draft/);
  assert.match(paceSentence(objective({ status: 'CANCELLED' })), /cancelled/);
});

test('a goal with nothing measured says so rather than reporting zero', () => {
  assert.match(paceSentence(objective({ key_result_count: 0 })), /Nothing is being measured/);
  assert.match(
    paceSentence(objective({ progress_percent: null })),
    /can be scored yet/,
    'unmeasurable is not the same as none',
  );
});

test('the sentence names the gap when a goal is slipping', () => {
  assert.match(paceSentence(objective({ progress_percent: 10, time_elapsed_percent: 70 })), /well behind/);
  assert.match(paceSentence(objective({ progress_percent: 55, time_elapsed_percent: 70 })), /slipping behind/);
  assert.match(paceSentence(objective({ progress_percent: 80, time_elapsed_percent: 40 })), /ahead of the calendar/);
});

test('once the period is over the sentence stops talking about pace', () => {
  const over = objective({ progress_percent: 70, time_elapsed_percent: 100 });
  assert.match(paceSentence(over), /period is over and the goal reached 70%/);
  assert.match(paceSentence({ ...over, progress_percent: 100 }), /the goal was met/);
});

// ------------------------------------------------------------- attention

test('a healthy, recently updated key result raises nothing', () => {
  assert.deepEqual(krAttention(keyResult()), []);
});

test('being behind the calendar is flagged at the severity it deserves', () => {
  assert.equal(krAttention(keyResult({ health: 'OFF_TRACK' }))[0].severity, 'critical');
  assert.equal(krAttention(keyResult({ health: 'AT_RISK' }))[0].severity, 'warning');
});

test('a key result nobody has updated in a fortnight is flagged as stale', () => {
  const stale = krAttention(keyResult({ last_check_in_at: daysAgo(20) }));
  assert.ok(stale.some((r) => r.kind === 'stale'));
  assert.match(stale.find((r) => r.kind === 'stale').detail, /20 days ago/);

  assert.deepEqual(
    krAttention(keyResult({ last_check_in_at: daysAgo(13) })),
    [],
    'a fortnight is the line, and thirteen days is inside it',
  );
});

test('a key result that has never been updated is called out separately', () => {
  const reasons = krAttention(keyResult({ last_check_in_at: null, created_at: daysAgo(30) }));
  assert.ok(reasons.some((r) => r.kind === 'never_checked'));
  assert.ok(!reasons.some((r) => r.kind === 'stale'), 'never updated is not the same as gone stale');
});

test('a key result added this week is not yet nagged for never being updated', () => {
  assert.deepEqual(
    krAttention(keyResult({ last_check_in_at: null, created_at: daysAgo(2) })),
    [],
    'it has not gone quiet, it has not had the chance',
  );
  assert.ok(
    krAttention(keyResult({ last_check_in_at: null, created_at: daysAgo(14) }))
      .some((r) => r.kind === 'never_checked'),
    'once the window has passed it counts',
  );
  assert.ok(
    krAttention(keyResult({ last_check_in_at: null })).some((r) => r.kind === 'never_checked'),
    'with no age to go on it is still flagged rather than silently excused',
  );
});

test('a missing target and a missing owner are both worth mentioning', () => {
  assert.ok(krAttention(keyResult({ needs_target: true })).some((r) => r.kind === 'no_target'));
  assert.ok(
    krAttention(keyResult({ owner_user_id: null, owner_name: null })).some((r) => r.kind === 'unowned'),
  );
});

test('a task roll-up with no tasks is flagged; other types are not', () => {
  assert.ok(
    krAttention(keyResult({ measurement_type: 'TASK_ROLLUP', linked_task_count: 0 }))
      .some((r) => r.kind === 'no_work'),
  );
  assert.ok(
    !krAttention(keyResult({ linked_task_count: 0 })).some((r) => r.kind === 'no_work'),
    'a number with a target does not need linked tasks to be measurable',
  );
});

test('finished and cancelled key results are left alone', () => {
  assert.deepEqual(krAttention(keyResult({ health: 'COMPLETED', last_check_in_at: daysAgo(200) })), []);
  assert.deepEqual(krAttention(keyResult({ status: 'CANCELLED', health: 'OFF_TRACK' })), []);
});

test('the most urgent key results sort to the top', () => {
  const fine = keyResult({ id: 1 });
  const slipping = keyResult({ id: 2, health: 'AT_RISK' });
  const broken = keyResult({ id: 3, health: 'OFF_TRACK' });

  assert.deepEqual(
    [fine, slipping, broken].sort(byUrgency).map((k) => k.id),
    [3, 2, 1],
  );
});

// --------------------------------------------------------------- filters

test('every filter counts exactly the key results it would show', () => {
  const list = [
    keyResult({ id: 1 }),
    keyResult({ id: 2, health: 'OFF_TRACK' }),
    keyResult({ id: 3, health: 'COMPLETED' }),
    keyResult({ id: 4, owner_user_id: 99 }),
  ];
  const counts = filterCounts(list, 7);

  for (const filter of KR_FILTERS) {
    assert.equal(
      counts[filter.key],
      list.filter((kr) => filter.match(kr, 7)).length,
      `the count beside "${filter.label}" matches the list behind it`,
    );
  }

  assert.equal(counts.all, 4);
  assert.equal(counts.attention, 1);
  assert.equal(counts.mine, 3);
  assert.equal(counts.done, 1);
});

// ---------------------------------------------------------------- people

test('contributors counts key results and tasks separately', () => {
  const people = contributors(
    [keyResult({ id: 1, owner_user_id: 7, owner_name: 'Asha' }),
      keyResult({ id: 2, owner_user_id: 8, owner_name: 'Ravi' })],
    [
      { id: 1, assignee_id: 7, assignee_name: 'Asha', stage: 'todo' },
      { id: 2, assignee_id: 7, assignee_name: 'Asha', stage: 'done' },
      { id: 3, assignee_id: null, assignee_name: null, stage: 'todo' },
    ],
  );

  const asha = people.find((p) => p.id === 7);
  assert.equal(asha.key_results, 1);
  assert.equal(asha.tasks, 2);
  assert.equal(asha.open_tasks, 1, 'a finished task is not still being carried');
  assert.ok(!people.some((p) => p.id === null), 'an unassigned task invents nobody');
});

test('the goal owner is not listed again as someone also carrying it', () => {
  const args = [
    [keyResult({ id: 1, owner_user_id: 7, owner_name: 'Asha' }),
      keyResult({ id: 2, owner_user_id: 8, owner_name: 'Ravi' })],
    [{ id: 1, assignee_id: 7, assignee_name: 'Asha', stage: 'todo' }],
  ];

  assert.equal(contributors(...args).length, 2, 'both appear when nobody is excluded');

  const withoutOwner = contributors(...args, 7);
  assert.deepEqual(withoutOwner.map((p) => p.id), [8]);
});

test('your part separates what is open from what is late', () => {
  const mine = myContribution(
    [keyResult({ id: 1, owner_user_id: 7 }),
      keyResult({ id: 2, owner_user_id: 7, last_check_in_at: daysAgo(40) }),
      keyResult({ id: 3, owner_user_id: 8 })],
    [
      { id: 1, assignee_id: 7, stage: 'todo', is_overdue: true },
      { id: 2, assignee_id: 7, stage: 'done', is_overdue: false },
      { id: 3, assignee_id: 8, stage: 'todo', is_overdue: true },
    ],
    7,
  );

  assert.equal(mine.key_results.length, 2);
  assert.equal(mine.tasks.length, 2);
  assert.equal(mine.open_tasks.length, 1);
  assert.equal(mine.overdue_tasks.length, 1);
  assert.equal(mine.needs_update.length, 1, 'only the one that has gone quiet');
});

// ------------------------------------------------------------ measurement

test('each measurement type reads the way that kind of number reads', () => {
  assert.equal(formatValue(1, { measurement_type: 'BINARY' }), 'Done');
  assert.equal(formatValue(0, { measurement_type: 'BINARY' }), 'Not yet');
  assert.equal(formatValue(42.5, { measurement_type: 'PERCENTAGE' }), '42.5%');
  // lakh grouping, not thousands: ₹25,00,000 is how the amount is written here
  assert.equal(formatValue(50000, { measurement_type: 'CURRENCY' }), '₹50,000');
  assert.equal(formatValue(2500000, { measurement_type: 'CURRENCY' }), '₹25,00,000');
  assert.equal(formatValue(40, { measurement_type: 'NUMBER', unit: 'farmers' }), '40 farmers');
  assert.equal(formatValue(null, { measurement_type: 'NUMBER' }), '—');
});

test('a target that is meant to come down does not read as a fraction', () => {
  assert.equal(measurementSummary(keyResult()), '40 farmers of 100 farmers');
  assert.match(
    measurementSummary(keyResult({ direction: 'DECREASE', current_value: 8, target_value: 2 })),
    /heading for/,
  );
});

test('a key result with no target says so instead of showing a share of nothing', () => {
  assert.match(measurementSummary(keyResult({ target_value: null })), /no target set/);
});

// ------------------------------------------------------------------ dates

test('days left is phrased the way a person would say it', () => {
  assert.equal(daysLeftLabel(daysAhead(0)), 'Last day');
  assert.equal(daysLeftLabel(daysAhead(1)), '1 day left');
  assert.equal(daysLeftLabel(daysAhead(12)), '12 days left');
  assert.match(daysLeftLabel(daysAhead(90)), /weeks left/);
  assert.match(daysLeftLabel(daysAhead(-3)), /3 days overdue/);
  assert.equal(daysLeftLabel(null), '');
});
