/**
 * What the customer said they would do.
 *
 * "They will share the soil samples by Friday" is the most common reason a deal
 * waits, and the most commonly forgotten. A commitment is recorded with its
 * date, and closed as kept, missed or withdrawn — so the weekly record can say
 * what customers committed to, and which of those commitments slipped.
 */

import { query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logActivity } from './crm.js';

export const COMMITMENT_OUTCOMES = ['KEPT', 'MISSED', 'WITHDRAWN'];

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);

export async function addCommitment(client, {
  accountId, opportunityId = null, activityId = null, contactId = null, what, dueOn = null, actor,
}) {
  const text = String(what || '').trim();
  if (text.length < 3) throw badRequest('Say what they committed to');
  if (dueOn && !isDay(String(dueOn))) throw badRequest('The date they committed to is not a date');
  const { rows } = await client.query(
    `INSERT INTO customer_commitments
       (account_id, opportunity_id, activity_id, contact_id, what, due_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7) RETURNING *`,
    [accountId, opportunityId, activityId, contactId, text, dueOn ? String(dueOn).slice(0, 10) : null, actor.id],
  );
  return rows[0];
}

/** Closes a commitment as kept, missed or withdrawn — never deletes it. */
export async function resolveCommitment(client, { commitmentId, status, note = null, actor }) {
  if (!COMMITMENT_OUTCOMES.includes(status)) throw badRequest('Say whether it was kept, missed or withdrawn');
  const { rows } = await client.query(
    `UPDATE customer_commitments
        SET status = $1, resolution_note = $2, resolved_at = now(), resolved_by = $3, updated_at = now()
      WHERE id = $4 AND status = 'OPEN' RETURNING *`,
    [status, note, actor.id, commitmentId],
  );
  if (!rows[0]) throw notFound('No open commitment with that id');
  const commitment = rows[0];
  await logActivity(client, {
    accountId: commitment.account_id,
    opportunityId: commitment.opportunity_id,
    type: 'NOTE',
    actorId: actor.id,
    subject: `They ${status === 'KEPT' ? 'kept' : status === 'MISSED' ? 'missed' : 'withdrew'}: ${commitment.what}`,
    body: note,
    meta: { commitment_id: commitment.id, status },
    // recording their commitment as kept is our bookkeeping; whatever they
    // actually sent is logged as its own entry
    direction: 'INTERNAL',
    isExternal: false,
    source: 'MANUAL',
  });
  return commitment;
}

export async function listCommitments({ accountId = null, opportunityId = null } = {}) {
  const { rows } = await query(
    `SELECT c.*, ct.full_name AS contact_name, u.full_name AS created_by_name,
            r.full_name AS resolved_by_name, o.name AS opportunity_name
       FROM customer_commitments c
       LEFT JOIN account_contacts ct ON ct.id = c.contact_id
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN users r ON r.id = c.resolved_by
       LEFT JOIN opportunities o ON o.id = c.opportunity_id
      WHERE ($1::int IS NULL OR c.account_id = $1::int)
        AND ($2::int IS NULL OR c.opportunity_id = $2::int)
      ORDER BY (c.status = 'OPEN') DESC, c.due_on NULLS LAST, c.created_at DESC
      LIMIT 200`,
    [accountId, opportunityId],
  );
  return rows;
}
