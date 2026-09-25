/**
 * The CRM screens' derivation helpers.
 *
 * `stageEntryGaps` is the one worth guarding closely. It answers "what does the
 * stage I am about to move this deal into expect?", and it is advisory by design:
 * it must always be able to say "nothing missing", must never treat a blank value
 * as zero, and must never be mistaken for a rule that blocks the move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeForecast, exactMoney, stageEntryGaps, VALUE_BASIS_LABEL } from '../src/lib/crm.js';

const stage = (patch = {}) => ({
  id: 5,
  name: 'Proposal',
  kind: 'open',
  position: 6,
  requires_contact: true,
  requires_next_action: true,
  requires_value: true,
  ...patch,
});

const deal = (patch = {}) => ({
  contact_count: 2,
  next_step: 'Send the pilot proposal',
  next_step_due: '2026-10-01',
  eligible_value: 1250000,
  value_unknown: false,
  expected_close: '2026-12-01',
  unmet_must_haves: 0,
  ...patch,
});

const kinds = (gaps) => gaps.map((g) => g.kind);

test('a deal with everything in place has nothing missing', () => {
  assert.deepEqual(stageEntryGaps(deal(), stage()), []);
});

test('each gate is reported separately, so the message says what to do', () => {
  assert.deepEqual(kinds(stageEntryGaps(deal({ contact_count: 0 }), stage())), ['no_contact']);
  assert.deepEqual(kinds(stageEntryGaps(deal({ next_step: null }), stage())), ['no_next_step']);
  assert.deepEqual(
    kinds(stageEntryGaps(deal({ next_step_due: null }), stage())),
    ['no_next_step_date'],
  );
  assert.deepEqual(kinds(stageEntryGaps(deal({ eligible_value: null }), stage())), ['no_value']);
});

test('a missing next action is reported once, not twice', () => {
  // no next step AND no date on it would otherwise both fire
  const gaps = kinds(stageEntryGaps(deal({ next_step: null, next_step_due: null }), stage()));
  assert.deepEqual(gaps, ['no_next_step']);
});

test('a value genuinely not known is an answer, and is not a gap', () => {
  const gaps = stageEntryGaps(deal({ eligible_value: null, value_unknown: true }), stage());
  assert.deepEqual(kinds(gaps), [], 'saying so is different from failing to say anything');
});

test('a stage that expects nothing asks for nothing', () => {
  const early = stage({
    name: 'New', position: 1, requires_contact: false,
    requires_next_action: false, requires_value: false,
  });
  assert.deepEqual(stageEntryGaps(deal({
    contact_count: 0, next_step: null, next_step_due: null,
    eligible_value: null, expected_close: null,
  }), early), []);
});

test('a close date is only expected once a deal is far enough along', () => {
  const late = stage({ position: 4 });
  const early = stage({ position: 3, requires_contact: false, requires_next_action: false, requires_value: false });
  assert.ok(kinds(stageEntryGaps(deal({ expected_close: null }), late)).includes('no_close_date'));
  assert.ok(!kinds(stageEntryGaps(deal({ expected_close: null }), early)).includes('no_close_date'));
});

test('unresolved must-haves are counted in the words a person reads', () => {
  const one = stageEntryGaps(deal({ unmet_must_haves: 1 }), stage());
  assert.match(one.at(-1).label, /1 must-have requirement unresolved/);
  const many = stageEntryGaps(deal({ unmet_must_haves: 3 }), stage());
  assert.match(many.at(-1).label, /3 must-have requirements unresolved/);
});

test('won and lost stages are settled by a different form, so they gate nothing here', () => {
  const bare = deal({
    contact_count: 0, next_step: null, next_step_due: null,
    eligible_value: null, expected_close: null, unmet_must_haves: 4,
  });
  assert.deepEqual(stageEntryGaps(bare, stage({ kind: 'won' })), []);
  assert.deepEqual(stageEntryGaps(bare, stage({ kind: 'lost' })), []);
  // and with no target stage picked yet there is nothing to say
  assert.deepEqual(stageEntryGaps(bare, null), []);
});

test('a forecast figure is never shown without saying where it came from', () => {
  const described = describeForecast({
    eligible_value: 1000000,
    eligible_basis: 'proposed',
    weighted_value: 400000,
    probability_percent: 40,
    probability_source: 'stage',
  });
  assert.equal(described.amount, 1000000);
  assert.equal(described.weighted, 400000);
  assert.match(described.note, /40%/);
  assert.match(described.note, /stage default/);
});

test('a deal with no usable value reports no amount and says why', () => {
  const described = describeForecast({
    eligible_value: null,
    eligible_basis: 'non_commercial',
  });
  assert.equal(described.amount, null, 'not zero — there is no number');
  assert.equal(described.note, VALUE_BASIS_LABEL.non_commercial);
});

test('an exact amount is spelled out, and a blank one stays blank', () => {
  assert.equal(exactMoney(1250000), '₹12,50,000');
  assert.equal(exactMoney(null), null);
  assert.equal(exactMoney(''), null);
  assert.equal(exactMoney(0), '₹0', 'a recorded zero is a real number and is shown');
});
