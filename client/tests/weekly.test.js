/**
 * How the weekly screens read.
 *
 * The week runs Monday to Monday in India exactly as the server counts it, a
 * pause needs a real date not too far off, a blocker is not raised without
 * saying what is blocked, on whom, who clears it and by when, and effort reads
 * as effort.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRM_SIGNAL_META, MAX_PAUSE_DAYS, effortWords, revisitProblem, shiftWeek, waitingWords, weekLabel, weekOf,
} from '../src/lib/crm.js';
import { BLOCKER_CATEGORIES, blockerProblem } from '../src/lib/threads.js';

test('a week runs Monday to Monday, the same way the server counts it', () => {
  assert.deepEqual(weekOf('2026-10-10'), { start: '2026-10-05', end: '2026-10-12' }, 'a Saturday');
  assert.deepEqual(weekOf('2026-10-12'), { start: '2026-10-12', end: '2026-10-19' }, 'a Monday starts its own week');
  assert.deepEqual(weekOf('2026-10-18'), { start: '2026-10-12', end: '2026-10-19' }, 'a Sunday ends it');
  assert.deepEqual(weekOf('2026-01-01'), { start: '2025-12-29', end: '2026-01-05' }, 'across a year end');
  assert.equal(shiftWeek('2026-10-05', -1), '2026-09-28');
  assert.equal(shiftWeek('2026-12-28', 1), '2027-01-04');
});

test('a week is labelled Monday to Sunday', () => {
  assert.equal(weekLabel('2026-10-05'), '5 – 11 Oct 2026');
  // ICU spells September "Sep" or "Sept" depending on its version
  const september = new Date(Date.UTC(2026, 8, 28)).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'short' });
  assert.equal(weekLabel('2026-09-28'), `28 ${september} – 4 Oct 2026`, 'across a month end, both months are named');
});

test('a pause needs a date that has not passed and is not so far off the deal is forgotten', () => {
  const today = '2026-10-10';
  assert.equal(revisitProblem('', today), 'Give the date to look at it again');
  assert.equal(revisitProblem('2026-10-09', today), 'That date has already passed');
  assert.equal(revisitProblem('2026-10-10', today), null, 'today is allowed');
  assert.equal(revisitProblem('2027-04-08', today), null, `${MAX_PAUSE_DAYS} days out is allowed`);
  assert.match(revisitProblem('2027-04-09', today), /within 180 days/);
  assert.equal(waitingWords('CUSTOMER'), 'the customer');
  assert.equal(waitingWords('THIRD_PARTY'), 'a third party');
  assert.equal(waitingWords('INTERNAL'), 'us');
});

test('a blocker says what is blocked, on whom, who clears it and by when', () => {
  const today = '2026-10-10';
  const facts = {
    blocked_item: 'Sample validation', dependency: 'EXTERNAL', external_party: 'FarMart quality lab',
    responsible_user_id: '4', expected_resolution: '2026-10-15',
  };
  assert.equal(blockerProblem(facts, today), null);
  assert.equal(blockerProblem({ ...facts, blocked_item: 'x' }, today), 'Say what exactly is blocked');
  assert.equal(blockerProblem({ ...facts, dependency: '' }, today), 'Say whether it depends on us or on someone outside');
  assert.equal(blockerProblem({ ...facts, external_party: '' }, today), 'Say who outside holds it up');
  assert.equal(blockerProblem({ ...facts, dependency: 'INTERNAL', external_party: '' }, today), null, 'ours needs no outside party');
  assert.equal(blockerProblem({ ...facts, responsible_user_id: '' }, today), 'Name who on our side clears it');
  assert.equal(blockerProblem({ ...facts, expected_resolution: '' }, today), 'Give the date it is expected to clear');
  assert.equal(blockerProblem({ ...facts, expected_resolution: '2026-10-09' }, today), 'That date has already passed');
  for (const named of ['SAMPLE_VALIDATION', 'PRICING_APPROVAL', 'FUNDING', 'PROCUREMENT']) {
    assert.ok(BLOCKER_CATEGORIES.some((c) => c.value === named), `${named} is its own kind, so it can be counted`);
  }
});

test('effort reads as counts of what was logged, and nothing as nothing', () => {
  assert.equal(effortWords({ EMAIL: 3, CALL: 1 }), '3 emails, 1 call');
  assert.equal(effortWords({ MEETING: 2, NOTE: 0 }), '2 meetings');
  assert.equal(effortWords({}), '');
});

test('every nudge the server raises has words on the screen', () => {
  for (const kind of [
    'gone_quiet', 'awaiting_reply', 'revisit_due', 'next_action_overdue', 'no_next_action',
    'next_action_incomplete', 'closing_with_blockers', 'commitment_overdue', 'handover_unconfirmed',
    'blocker_overdue', 'blocker_waiting', 'meeting_outcome_missing', 'milestone_overdue',
  ]) {
    assert.ok(CRM_SIGNAL_META[kind]?.label, `${kind} has a label`);
    assert.ok(CRM_SIGNAL_META[kind]?.action, `${kind} says what to do`);
  }
});
