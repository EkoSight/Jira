/**
 * Moving a deal from one stage to another — in one place.
 *
 * A deal can be moved from four screens: the deal itself, its card on the
 * board, the organization's header, and the "mark as customer" button. They
 * used to take different paths, and only the first one moved the opportunity:
 * the others changed the lead's mirror columns and left the deal where it was,
 * so a lead dragged to Won never counted as won anywhere that reads deals — the
 * dashboard included. Every path now comes through applyStageMove.
 *
 * And every path now checks the same two things before anything moves:
 *
 *   EVIDENCE. The stage being entered (and the one being left) can require a
 *   record — a dated proposal, an accepted order or contract, a meeting that
 *   actually happened. The record can be captured in the same request. A
 *   finished task is never evidence. A manager can move a deal without it, but
 *   only by writing down why, and the exception stays on the deal's history.
 *
 *   THE NEXT ACTION. A deal moving into a live stage must leave with a
 *   specific next action, a person who owes it, and a date that has not
 *   already passed. A stage change is exactly when the old next step stops
 *   being true, which is how a pipeline ends up showing yesterday's plan.
 */

import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { assertSafeUrl } from '../lib/uploads.js';
import { logActivity } from './crm.js';
import { dealEvidence, missingForMove, nextActionGaps, today } from './dealRules.js';
import { recordHistory, setNextAction, syncAccountMirror } from './opportunities.js';

/** A stage with where the deal is coming from, for the history line. */
export async function loadStageMove(stageId, fromStageId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT s.*, (SELECT name FROM account_stages WHERE id = $2) AS from_name,
            (SELECT position FROM account_stages WHERE id = $2) AS from_position
       FROM account_stages s WHERE s.id = $1`,
    [stageId, fromStageId ?? null],
  );
  if (!rows[0]) throw badRequest('Stage not found');
  return rows[0];
}

/** The stage a won deal goes to. */
export async function wonStage() {
  const { rows } = await query(
    `SELECT id FROM account_stages WHERE kind = 'won' AND is_active = TRUE
      ORDER BY position LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

/**
 * Moves one opportunity, records why, and keeps the lead's headline in step.
 *
 * `opportunity` is the raw row; `stage` comes from loadStageMove. The rules are
 * the ones the deal screen always applied: a loss needs a reason, a terminal
 * stage stamps closed_at (which is what "won this month" counts), and moving
 * backwards is recorded as a reversal rather than hidden. The evidence and
 * next-action checks happen before this, in applyStageMove.
 */
export async function moveOpportunityStage(client, {
  opportunity, stage, data = {}, actor, evidenceMissing = null,
}) {
  if (stage.kind === 'lost' && !data.outcome_reason?.trim()) {
    throw badRequest('Say why this was lost — a closed deal with no reason teaches nobody anything');
  }

  const status = stage.kind === 'won' ? 'WON' : stage.kind === 'lost' ? 'LOST' : 'ACTIVE';
  const isReversal = stage.position < (stage.from_position ?? 0);

  await client.query(
    `UPDATE opportunities
        SET stage_id = $1, status = $2, stage_changed_at = now(),
            outcome_reason = COALESCE($3, outcome_reason),
            revisit_on = COALESCE($4::date, revisit_on),
            agreement_type = COALESCE($5, agreement_type),
            agreement_date = COALESCE($6::date, agreement_date),
            agreement_link = COALESCE($7, agreement_link),
            agreed_value = COALESCE($8::numeric, agreed_value),
            financial_status = COALESCE($9, financial_status),
            closed_at = CASE WHEN $10 IN ('won','lost') THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $11`,
    [
      stage.id, status,
      data.outcome_reason ?? null, data.revisit_on ?? null,
      data.agreement_type ?? null, data.agreement_date ?? null, data.agreement_link ?? null,
      data.agreed_value ?? null, data.financial_status ?? null,
      stage.kind, opportunity.id,
    ],
  );

  const overrideNote = evidenceMissing?.length
    ? `Moved without: ${evidenceMissing.join(', ')}. ${data.override_reason ?? ''}`.trim()
    : null;

  await recordHistory(client, {
    opportunityId: opportunity.id,
    field: 'stage',
    from: stage.from_name,
    to: stage.name,
    isReversal,
    reason: overrideNote ?? data.reason ?? data.outcome_reason ?? null,
    actorId: actor.id,
    evidenceMissing,
  });

  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'STAGE_CHANGE',
    actorId: actor.id,
    subject: `${opportunity.name}: moved to ${stage.name}`,
    body: overrideNote,
    meta: {
      from: stage.from_name, to: stage.name, reversal: isReversal,
      ...(evidenceMissing?.length ? { evidence_missing: evidenceMissing } : {}),
    },
  });

  await syncAccountMirror(client, opportunity.account_id);
  return { status, isReversal };
}

// ---------------------------------------------------------------- evidence captured on the move

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);

/** A link anyone can open, or nothing. Only http and https. */
export const cleanLink = (value) => (value && String(value).trim() ? assertSafeUrl(String(value).trim()) : null);

/** Records a proposal, and makes it the deal's proposed amount when it had one. */
export async function addProposal(client, { opportunity, proposal, actor }) {
  if (!isDay(proposal.sent_on)) throw badRequest('Give the date the proposal was sent');
  if (proposal.sent_on.slice(0, 10) > today()) {
    throw badRequest('A proposal dated in the future has not been sent yet — record it once it goes out');
  }
  const { rows } = await client.query(
    `INSERT INTO opportunity_proposals
       (opportunity_id, title, sent_on, amount, currency, valid_until, link, notes, created_by)
     VALUES ($1,$2,$3::date,$4::numeric,COALESCE($5,'INR'),$6::date,$7,$8,$9)
     RETURNING *`,
    [
      opportunity.id, proposal.title?.trim() || null, proposal.sent_on.slice(0, 10),
      proposal.amount ?? null, proposal.currency ?? opportunity.currency ?? null,
      proposal.valid_until || null, cleanLink(proposal.link), proposal.notes?.trim() || null,
      actor.id,
    ],
  );
  const created = rows[0];

  // the amount actually put in front of them is, by definition, the proposed value
  if (created.amount !== null && String(created.amount) !== String(opportunity.proposed_value ?? '')) {
    await client.query(
      'UPDATE opportunities SET proposed_value = $1::numeric, updated_at = now() WHERE id = $2',
      [created.amount, opportunity.id],
    );
    await recordHistory(client, {
      opportunityId: opportunity.id, field: 'proposed_value',
      from: opportunity.proposed_value, to: created.amount,
      reason: `Proposal sent on ${created.sent_on}`, actorId: actor.id,
    });
  }

  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'PROPOSAL',
    actorId: actor.id,
    subject: `Proposal sent${created.title ? `: ${created.title}` : ''}`,
    body: created.link ? `Link: ${created.link}` : null,
    occurredAt: `${created.sent_on}T12:00:00+05:30`,
    meta: { proposal_id: created.id, amount: created.amount },
    direction: 'OUTBOUND',
    outcome: 'SENT',
    source: 'MANUAL',
  });
  return created;
}

export const ORDER_KINDS = ['PURCHASE_ORDER', 'CONTRACT', 'WORK_ORDER', 'MOU', 'OTHER'];

/**
 * Records an accepted order or contract — the booking. It needs a date and
 * something that points at the document (its number or a link), because "they
 * said yes on the phone" is a reason to chase the paperwork, not a booking.
 */
export async function addOrder(client, { opportunity, order, actor }) {
  if (!isDay(order.received_on)) throw badRequest('Give the date the order or contract was received');
  if (order.received_on.slice(0, 10) > today()) {
    throw badRequest('An order dated in the future has not been received yet');
  }
  if (!order.reference?.trim() && !order.link?.trim()) {
    throw badRequest('Give the order or contract number, or a link to it — something anyone can check');
  }
  const kind = ORDER_KINDS.includes(order.kind) ? order.kind : 'PURCHASE_ORDER';
  const { rows } = await client.query(
    `INSERT INTO opportunity_orders
       (opportunity_id, kind, reference, received_on, amount, currency, link, notes, created_by)
     VALUES ($1,$2,$3,$4::date,$5::numeric,COALESCE($6,'INR'),$7,$8,$9)
     RETURNING *`,
    [
      opportunity.id, kind, order.reference?.trim() || null, order.received_on.slice(0, 10),
      order.amount ?? null, order.currency ?? opportunity.currency ?? null,
      cleanLink(order.link), order.notes?.trim() || null, actor.id,
    ],
  );
  const created = rows[0];

  // the first order fills a blank agreed value; it never overwrites one somebody set
  if (created.amount !== null && (opportunity.agreed_value === null || opportunity.agreed_value === undefined)) {
    await client.query(
      'UPDATE opportunities SET agreed_value = $1::numeric, updated_at = now() WHERE id = $2',
      [created.amount, opportunity.id],
    );
    await recordHistory(client, {
      opportunityId: opportunity.id, field: 'agreed_value', from: null, to: created.amount,
      reason: `Order ${created.reference || created.link} received on ${created.received_on}`,
      actorId: actor.id,
    });
  }

  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'ORDER',
    actorId: actor.id,
    subject: `${kind === 'CONTRACT' ? 'Contract' : kind === 'MOU' ? 'MoU' : 'Order'} received${created.reference ? `: ${created.reference}` : ''}`,
    body: created.link ? `Link: ${created.link}` : null,
    occurredAt: `${created.received_on}T12:00:00+05:30`,
    meta: { order_id: created.id, amount: created.amount },
    // a purchase order arriving is the customer acting, and counts as hearing from them
    direction: 'INBOUND',
    outcome: 'RECEIVED',
    isExternal: true,
    source: 'MANUAL',
  });
  return created;
}

// ---------------------------------------------------------------- the one way to move a deal

const hasNextActionInput = (data) =>
  data.next_step !== undefined || data.next_step_owner_id !== undefined || data.next_step_due !== undefined;

/**
 * Checks, then moves. Throws a 400 with a `code` the screens understand:
 *
 *   STAGE_EVIDENCE_REQUIRED — with `missing` (rule, label, hint, phase, stage)
 *   NEXT_ACTION_REQUIRED    — with `gaps`
 *
 * Runs inside the caller's transaction, so a proposal or order captured on the
 * move is rolled back with it if the move is refused.
 */
export async function applyStageMove(client, { opportunityId, stageId, data = {}, actor }) {
  // locked, so two people moving the same deal cannot both pass the checks
  const { rows: locked } = await client.query(
    'SELECT * FROM opportunities WHERE id = $1 FOR UPDATE', [opportunityId],
  );
  let current = locked[0];
  if (!current) throw badRequest('Opportunity not found');

  const stage = await loadStageMove(stageId, current.stage_id, client);
  const { rows: fromRows } = current.stage_id
    ? await client.query('SELECT * FROM account_stages WHERE id = $1', [current.stage_id])
    : { rows: [] };
  const from = fromRows[0] || null;

  // evidence captured on the move itself
  if (data.proposal) await addProposal(client, { opportunity: current, proposal: data.proposal, actor });
  if (data.order) {
    const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
    await addOrder(client, { opportunity: rows[0], order: data.order, actor });
  }
  if (data.proposal || data.order) {
    const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
    current = rows[0];
  }

  const evidence = await dealEvidence(opportunityId, client);
  const missing = missingForMove({ opportunity: current, from, to: stage, evidence });
  let evidenceMissing = null;
  if (missing.length) {
    const mayOverride = hasPermission(actor, 'crm.manage.any');
    const reason = data.override_reason?.trim() || '';
    if (!mayOverride || reason.length < 10) {
      throw badRequest(
        `${stage.name} needs evidence first: ${missing.map((m) => m.label.toLowerCase()).join('; ')}`,
        {
          code: 'STAGE_EVIDENCE_REQUIRED',
          missing,
          can_override: mayOverride,
          // a manager trying to override with too little said is told why
          ...(mayOverride && data.override_reason !== undefined
            ? { override_problem: 'Write at least a sentence on why it is moving without the evidence' }
            : {}),
        },
      );
    }
    evidenceMissing = missing.map((m) => m.rule);
  }

  if (stage.kind === 'open') {
    if (hasNextActionInput(data)) {
      await setNextAction(client, {
        opportunity: current,
        step: data.next_step !== undefined ? data.next_step : current.next_step,
        ownerId: data.next_step_owner_id !== undefined ? data.next_step_owner_id : current.next_step_owner_id,
        due: data.next_step_due !== undefined ? data.next_step_due : current.next_step_due,
        actor,
        reason: `Moving to ${stage.name}`,
      });
      const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
      current = rows[0];
    }
    const gaps = nextActionGaps({ ...current, status: 'ACTIVE', stage_kind: 'open' });
    if (gaps.length) {
      throw badRequest(
        `Say what happens next before moving to ${stage.name}: ${gaps.map((g) => g.label.toLowerCase()).join('; ')}`,
        { code: 'NEXT_ACTION_REQUIRED', gaps },
      );
    }
  }

  return moveOpportunityStage(client, {
    opportunity: current, stage, data, actor, evidenceMissing,
  });
}
