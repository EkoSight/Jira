/**
 * Problem 1 on the browser side: the board's label and My Tasks agree, in the
 * organisation's time zone. Before, the board said "Due today" for a task due
 * at 10:00 when it was 15:00, while My Tasks and Chat said overdue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dueLabel, setDeadlineCalendar, taskHealth } from '../src/lib/format.js';
import { MY_GROUPS, clock, groupOf } from '../../shared/deadlineHealth.js';

test('a deadline earlier today is overdue on the card, not "due today"', () => {
  setDeadlineCalendar({ timezone: 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5, 6], dueSoonDays: 3 });
  const earlier = new Date(Date.now() - 5 * 3_600_000).toISOString();
  assert.match(dueLabel(earlier).text, /^Overdue · 5 h$/);
  assert.equal(dueLabel(earlier).tone, 'critical');
  assert.equal(taskHealth({ stage: 'todo', due_date: earlier }).code, 'OVERDUE');
  assert.equal(dueLabel(earlier, { done: true }).tone, 'neutral', 'finished work is not flagged');
});

test('the server\'s health wins when it sent one; the groups cover every case once', () => {
  assert.equal(taskHealth({ health: { code: 'REVIEW_DUE', text: 'Review due', tone: 'warning' } }).text, 'Review due');
  const c = clock(new Date());
  const keys = new Set(MY_GROUPS.map((g) => g.key));
  for (const t of [
    { stage: 'todo', due_date: new Date(Date.now() - 3_600_000).toISOString() },
    { stage: 'blocked', due_date: null },
    { stage: 'backlog', due_date: null, review_date: null },
  ]) assert.ok(keys.has(groupOf(t, c)));
});
