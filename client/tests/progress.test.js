/**
 * How the pipeline screens read progress.
 *
 * The same rules the server enforces, worked out on the screen so the person is
 * told before they press anything: what a next action is missing, what
 * evidence a move needs, how old each of the three clocks is, and whether an
 * outcome is a result or a plan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agoWords, clockTone, evidenceNeeds, firstName, nextActionGaps, todayInIndia,
} from '../src/lib/crm.js';
import { outcomeProblem, readsLikeAPlan } from '../src/lib/completion.js';

const live = (patch = {}) => ({
  status: 'ACTIVE', stage_kind: 'open',
  next_step: 'Send pricing', next_step_owner_id: 4, next_step_due: '2026-10-12', ...patch,
});

test('a live deal owes what, who and when; a settled one owes nothing', () => {
  const today = '2026-10-10';
  assert.deepEqual(nextActionGaps(live(), today), []);
  assert.deepEqual(nextActionGaps(live({ next_step: '', next_step_owner_id: null, next_step_due: null }), today),
    ['no_next_action', 'no_next_action_owner', 'no_next_action_due']);
  assert.deepEqual(nextActionGaps(live({ next_step_due: '2026-10-09' }), today), ['next_action_overdue']);
  assert.deepEqual(nextActionGaps(live({ next_step_due: '2026-10-10' }), today), [], 'due today is not late');
  assert.deepEqual(nextActionGaps(live({ status: 'WON', stage_kind: 'won' }), today), []);
  assert.deepEqual(nextActionGaps(live({ status: 'NURTURE' }), today), []);
});

test('the evidence a move needs: forward only, exit rules then entry rules', () => {
  const demo = { id: 5, name: 'Meeting / Demo', kind: 'open', position: 5, entry_rules: [], exit_rules: ['meeting_completed'] };
  const proposal = { id: 7, name: 'Proposal', kind: 'open', position: 7, entry_rules: ['proposal'], exit_rules: [] };
  const won = { id: 9, name: 'Won', kind: 'won', position: 9, entry_rules: ['order'], exit_rules: [] };
  const lost = { id: 10, name: 'Lost', kind: 'lost', position: 10, entry_rules: [], exit_rules: [] };

  const fresh = { proposal_count: 0, order_count: 0, completed_meetings: 0 };
  assert.deepEqual(evidenceNeeds({ opportunity: fresh, from: demo, to: proposal }).map((n) => `${n.phase}:${n.rule}:${n.met}`),
    ['exit:meeting_completed:false', 'entry:proposal:false']);
  assert.deepEqual(evidenceNeeds({ opportunity: { ...fresh, completed_meetings: 1, proposal_count: 1 }, from: demo, to: proposal })
    .map((n) => n.met), [true, true]);
  assert.deepEqual(evidenceNeeds({ opportunity: fresh, from: proposal, to: won }).map((n) => n.rule), ['order']);
  assert.deepEqual(evidenceNeeds({ opportunity: fresh, from: proposal, to: demo }), [], 'going back needs nothing');
  assert.deepEqual(evidenceNeeds({ opportunity: fresh, from: proposal, to: lost }), [], 'nor does losing');
  // every need is said in words, with what to do about it
  for (const need of evidenceNeeds({ opportunity: fresh, from: demo, to: won })) {
    assert.ok(need.label && need.hint);
  }
});

test('the clocks say how long ago, and how worried to be', () => {
  assert.equal(agoWords(null), 'never');
  assert.equal(agoWords(0), 'today');
  assert.equal(agoWords(1), 'yesterday');
  assert.equal(agoWords(9), '9 days ago');
  assert.equal(clockTone(null), 'critical', 'never heard from them is the worst case, not the best');
  assert.equal(clockTone(2, 7), 'good');
  assert.equal(clockTone(6, 7), 'neutral');
  assert.equal(clockTone(10, 7), 'warning');
  assert.equal(clockTone(30, 7), 'critical');
});

test('today is read in India, whatever the device is set to', () => {
  // 20:00 UTC on the 9th is already 01:30 on the 10th in India
  assert.equal(todayInIndia(new Date('2026-10-09T20:00:00Z')), '2026-10-10');
  assert.equal(firstName('Saumya Sharma'), 'Saumya');
});

test('an outcome is a result — "will send samples" is not "tested the samples"', () => {
  assert.ok(readsLikeAPlan('Will send samples'));
  assert.ok(readsLikeAPlan("We'll share the report"));
  assert.ok(readsLikeAPlan('Awaiting confirmation from their lab'));
  assert.ok(!readsLikeAPlan('Tested 40 samples; will share the report Friday'));
  assert.ok(!readsLikeAPlan('Sent the samples to the lab on 3 Oct'));

  assert.match(outcomeProblem('Done'), /status, not an outcome/);
  assert.match(outcomeProblem('ok.'), /status, not an outcome/);
  assert.equal(outcomeProblem('Lab confirmed the correlation on 200 samples'), null);
});
