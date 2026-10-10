/**
 * Deals paused on purpose.
 *
 * A deal that is quiet because nobody is working it should be chased. A deal
 * that is quiet because we are waiting — for the customer's board meeting, a
 * lab result, our own pricing approval — should not be flagged every day; it
 * should come back on the date somebody said to look again.
 *
 * Two shapes, both dated and both with a reason:
 *
 *   WAITING — a live deal paused for a while (on the customer, a third party or
 *   us). It stays in the pipeline and its next action becomes "check back" on
 *   the revisit date. When the customer responds, waiting on them is over.
 *
 *   ON HOLD / NURTURE — the existing statuses for a deal taken out of the live
 *   pipeline. Going forward they need a revisit date too.
 */

import { badRequest } from '../lib/errors.js';
import { logActivity } from './crm.js';
import { today } from './dealRules.js';
import { recordHistory, setNextAction, syncAccountMirror } from './opportunities.js';

export const WAITING_ON = ['CUSTOMER', 'THIRD_PARTY', 'INTERNAL'];

const WAITING_WORDS = {
  CUSTOMER: 'the customer',
  THIRD_PARTY: 'a third party',
  INTERNAL: 'us',
};

/** The longest a deal may be parked without anyone looking at it again. */
export const MAX_PAUSE_DAYS = 180;

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10));

/** A revisit date that is real, not past, and not so far off the deal is forgotten. */
export function problemWithRevisit(until, { todayDate = today() } = {}) {
  if (!until || !isDay(String(until))) return 'Give the date to look at it again';
  const day = String(until).slice(0, 10);
  if (day < todayDate) return 'The date to look at it again has already passed';
  const limit = new Date(`${todayDate}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + MAX_PAUSE_DAYS);
  if (day > limit.toISOString().slice(0, 10)) {
    return `Pick a date within ${MAX_PAUSE_DAYS} days — a deal parked longer than that is forgotten, not waiting`;
  }
  return null;
}

/**
 * Marks a live deal as waiting. Its next action becomes checking back on the
 * revisit date, owed by whoever owes the next move now (or the deal owner).
 */
export async function setWaiting(client, { opportunity, waitingOn, reason, until, ownerId = null, actor }) {
  if (opportunity.status !== 'ACTIVE') throw badRequest('Only a live deal can be waiting — this one is not live');
  if (!WAITING_ON.includes(waitingOn)) throw badRequest('Say who it is waiting on');
  const why = String(reason || '').trim();
  if (why.length < 3) throw badRequest('Say what it is waiting for');
  const problem = problemWithRevisit(until);
  if (problem) throw badRequest(problem);
  const day = String(until).slice(0, 10);

  await client.query(
    `UPDATE opportunities
        SET waiting_on = $1, waiting_reason = $2, waiting_until = $3::date,
            waiting_since = now(), waiting_set_by = $4, updated_at = now()
      WHERE id = $5`,
    [waitingOn, why, day, actor.id, opportunity.id],
  );
  await recordHistory(client, {
    opportunityId: opportunity.id,
    field: 'waiting',
    from: opportunity.waiting_on ? `${opportunity.waiting_on} until ${String(opportunity.waiting_until).slice(0, 10)}` : null,
    to: `${waitingOn} until ${day}`,
    reason: why,
    actorId: actor.id,
  });

  // the next move is to look again on the date — which keeps "every live deal
  // owes a next action" true while it waits
  const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1', [opportunity.id]);
  await setNextAction(client, {
    opportunity: rows[0],
    step: `Check back: ${why}`.slice(0, 2000),
    ownerId: ownerId ?? rows[0].next_step_owner_id ?? rows[0].owner_user_id,
    due: day,
    actor,
    reason: `Waiting on ${WAITING_WORDS[waitingOn]}`,
  });

  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'NOTE',
    actorId: actor.id,
    subject: `${opportunity.name}: waiting on ${WAITING_WORDS[waitingOn]} until ${day}`,
    body: why,
    meta: { waiting_on: waitingOn, until: day },
    direction: 'INTERNAL',
    isExternal: false,
    source: 'MANUAL',
  });
  await syncAccountMirror(client, opportunity.account_id);
}

/** Ends a wait by hand. */
export async function clearWaiting(client, { opportunity, actor, reason = null }) {
  if (!opportunity.waiting_on) return { cleared: false };
  await client.query(
    `UPDATE opportunities
        SET waiting_on = NULL, waiting_reason = NULL, waiting_until = NULL, waiting_since = NULL,
            waiting_set_by = NULL, updated_at = now()
      WHERE id = $1`,
    [opportunity.id],
  );
  await recordHistory(client, {
    opportunityId: opportunity.id,
    field: 'waiting',
    from: `${opportunity.waiting_on} until ${String(opportunity.waiting_until).slice(0, 10)}`,
    to: null,
    reason: reason || 'No longer waiting',
    actorId: actor.id,
  });
  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'NOTE',
    actorId: actor.id,
    subject: `${opportunity.name}: no longer waiting`,
    body: reason || null,
    direction: 'INTERNAL',
    isExternal: false,
    source: 'MANUAL',
  });
  return { cleared: true };
}
