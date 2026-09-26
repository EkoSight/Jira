/**
 * Moving a deal from one stage to another — in one place.
 *
 * A deal can be moved from three screens: the deal itself, the lead's header
 * (or its card on the board), and the "mark as customer" button. They used to
 * take different paths, and only the first one moved the opportunity: the other
 * two changed the lead's mirror columns and left the deal where it was, so a lead
 * dragged to Won never counted as won anywhere that reads deals — the dashboard
 * included. Every path now comes through here.
 */

import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { logActivity } from './crm.js';
import { recordHistory, syncAccountMirror } from './opportunities.js';

/** A stage with where the deal is coming from, for the history line. */
export async function loadStageMove(stageId, fromStageId) {
  const { rows } = await query(
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
 * backwards is recorded as a reversal rather than hidden.
 */
export async function moveOpportunityStage(client, { opportunity, stage, data = {}, actor }) {
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

  await recordHistory(client, {
    opportunityId: opportunity.id,
    field: 'stage',
    from: stage.from_name,
    to: stage.name,
    isReversal,
    reason: data.reason ?? data.outcome_reason ?? null,
    actorId: actor.id,
  });

  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'STAGE_CHANGE',
    actorId: actor.id,
    subject: `${opportunity.name}: moved to ${stage.name}`,
    meta: { from: stage.from_name, to: stage.name, reversal: isReversal },
  });

  await syncAccountMirror(client, opportunity.account_id);
  return { status, isReversal };
}
