/**
 * What has to be true about a deal, checked in one place.
 *
 * Two kinds of rule live here.
 *
 *   THE NEXT ACTION. Every live deal owes somebody a specific move: what it is,
 *   who owes it, and by when. A deal missing any of the three is flagged, and a
 *   deal cannot be moved to another live stage without all three — a stage
 *   change is exactly when the old next step stops being true.
 *
 *   STAGE EVIDENCE. A stage can say what it needs to see before a deal comes in
 *   (a dated proposal before Proposal, an accepted order or contract before Won)
 *   and before it goes on (a demo that actually happened before leaving Meeting
 *   / Demo). The evidence is a record, never a finished task: "follow up on the
 *   proposal" being Done is not a proposal.
 *
 * Nothing here writes. The routes ask, then decide.
 */

import { query } from '../db/pool.js';
import { dateIn } from './availability.js';
import { eligibleValue } from './opportunities.js';

/** The rules a stage can carry, with the words a person sees when one is missing. */
export const STAGE_RULES = {
  proposal: {
    label: 'A dated proposal on record',
    hint: 'Record the proposal: the date it was sent, and its amount if it had one.',
  },
  order: {
    label: 'An accepted order or contract on record',
    hint: 'Record the purchase order, contract, work order or MoU: its date and its number or link.',
  },
  meeting_completed: {
    label: 'A meeting or demo that actually happened, with its outcome recorded',
    hint: 'Record the outcome on the meeting. A booked meeting is not one that took place.',
  },
  contact: {
    label: 'Someone named at the organization for this deal',
    hint: 'Add the person you are dealing with on the deal.',
  },
  value: {
    label: 'A value, or the value marked as not yet known',
    hint: 'Enter the estimate, or tick "not yet known" so a blank is a decision and not an oversight.',
  },
  close_date: {
    label: 'An expected close date',
    hint: 'Set when you expect this to be decided.',
  },
  must_haves_met: {
    label: 'Every must-have requirement met or waived',
    hint: 'Resolve the open must-haves, or waive them with a note.',
  },
};

export const RULE_KEYS = Object.keys(STAGE_RULES);

const ruleWords = (rule) => STAGE_RULES[rule] || { label: rule, hint: null };

/** The evidence one deal has, counted from the records themselves. */
export async function dealEvidence(opportunityId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT
       (SELECT COUNT(*)::int FROM opportunity_proposals p
         WHERE p.opportunity_id = o.id AND p.status <> 'WITHDRAWN') AS proposals,
       (SELECT COUNT(*)::int FROM opportunity_orders r
         WHERE r.opportunity_id = o.id AND r.status = 'ACCEPTED') AS accepted_orders,
       -- a meeting about this deal, or about the organization without naming a
       -- deal, that was recorded as having taken place
       (SELECT COUNT(*)::int FROM crm_meetings m
         WHERE m.status = 'COMPLETED'
           AND (m.opportunity_id = o.id
                OR (m.opportunity_id IS NULL AND m.account_id = o.account_id))) AS completed_meetings,
       (SELECT COUNT(*)::int FROM opportunity_contacts oc WHERE oc.opportunity_id = o.id) AS contacts,
       (SELECT COUNT(*)::int FROM opportunity_requirements q
         WHERE q.opportunity_id = o.id AND q.importance = 'MUST_HAVE'
           AND q.status NOT IN ('MET', 'WAIVED')) AS unmet_must_haves
       FROM opportunities o WHERE o.id = $1`,
    [opportunityId],
  );
  return rows[0] || {
    proposals: 0, accepted_orders: 0, completed_meetings: 0, contacts: 0, unmet_must_haves: 0,
  };
}

/** Whether one rule holds for a deal, given its evidence. */
export function ruleHolds(rule, opportunity, evidence) {
  switch (rule) {
    case 'proposal': return evidence.proposals > 0;
    case 'order': return evidence.accepted_orders > 0;
    case 'meeting_completed': return evidence.completed_meetings > 0;
    case 'contact': return evidence.contacts > 0;
    case 'value':
      return Boolean(opportunity.value_unknown) || eligibleValue(opportunity).amount !== null
        // non-commercial work has no value to record, and that is not a gap
        || eligibleValue(opportunity).basis === 'non_commercial';
    case 'close_date': return Boolean(opportunity.expected_close);
    case 'must_haves_met': return evidence.unmet_must_haves === 0;
    // a rule this version does not know is not silently passed or failed —
    // it is reported, so a typo in a stage's settings is seen
    default: return false;
  }
}

/**
 * What a move is missing.
 *
 * Entry rules apply when a deal moves forward into a stage, and always when it
 * is won. Exit rules apply when it moves forward out of the stage it is in.
 * Moving backwards, or to Lost, needs no evidence: correcting a stage that was
 * too optimistic must never be harder than leaving it wrong.
 */
export function missingForMove({ opportunity, from, to, evidence }) {
  if (!to || to.kind === 'lost') return [];
  const forward = !from || (to.position ?? 0) > (from.position ?? 0) || to.kind === 'won';
  if (!forward) return [];

  const missing = [];
  if (from && from.id !== to.id && from.kind === 'open') {
    for (const rule of from.exit_rules || []) {
      if (!ruleHolds(rule, opportunity, evidence)) {
        missing.push({ rule, phase: 'exit', stage: from.name, ...ruleWords(rule) });
      }
    }
  }
  for (const rule of to.entry_rules || []) {
    if (missing.some((m) => m.rule === rule)) continue;
    if (!ruleHolds(rule, opportunity, evidence)) {
      missing.push({ rule, phase: 'entry', stage: to.name, ...ruleWords(rule) });
    }
  }
  return missing;
}

/** Today's date where the business is, as YYYY-MM-DD. */
export const today = (timezone = 'Asia/Kolkata', now = new Date()) => dateIn(timezone, now);

const asDay = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return dateIn('Asia/Kolkata', value);
};

/**
 * What is missing from a live deal's next action, in the order a person would
 * fix it. Empty when the deal is not live, or when the action is complete and
 * not yet due.
 */
export function nextActionGaps(opportunity, { todayDate = today() } = {}) {
  const live = opportunity.status === 'ACTIVE'
    && (opportunity.stage_kind === undefined || opportunity.stage_kind === null
      || opportunity.stage_kind === 'open');
  if (!live) return [];

  const gaps = [];
  if (!opportunity.next_step || !String(opportunity.next_step).trim()) {
    gaps.push({ kind: 'no_next_action', label: 'No next action' });
  }
  if (!opportunity.next_step_owner_id) {
    gaps.push({ kind: 'no_next_action_owner', label: 'Nobody named for the next action' });
  }
  const due = asDay(opportunity.next_step_due);
  if (!due) {
    gaps.push({ kind: 'no_next_action_due', label: 'Next action has no date' });
  } else if (due < todayDate) {
    gaps.push({ kind: 'next_action_overdue', label: `Next action was due ${due}` });
  }
  return gaps;
}

/**
 * Checks a next action somebody is about to set. Returns the problem in words,
 * or null. A next action set today must be for today or later — a step already
 * overdue the moment it is agreed is not a plan.
 */
export function problemWithNextAction({ step, ownerId, due }, { todayDate = today() } = {}) {
  if (!step || !String(step).trim()) return 'Say what the next action is';
  if (String(step).trim().length < 3) return 'Describe the next action in a few words';
  if (!ownerId) return 'Name who owes the next action';
  const day = asDay(due);
  if (!day) return 'Give the next action a date';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'The next action date is not a date';
  if (day < todayDate) return 'The next action date has already passed — pick today or later';
  return null;
}
