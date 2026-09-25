/**
 * Opportunities: the deals inside a relationship.
 *
 * An account is the organization — enduring, with contacts, history and a
 * relationship owner. An opportunity is one specific agreement being pursued
 * with it. Winning one does not close the organization, and a second can run
 * alongside the first.
 *
 * Two rules run through everything here:
 *
 *   MONEY IS NEVER ADDED UP ACROSS KINDS. An estimate, a proposal, a signed
 *   amount and cash collected are four different claims. A blank one means "not
 *   known", never zero, and the forecast uses exactly one of them per deal.
 *
 *   A FORECAST IS A DISCLOSED ESTIMATE. The probability is either the stage's
 *   default or one a person set with a reason, and the API says which.
 */

import { query } from '../db/pool.js';
import { hasPermission } from '../lib/permissions.js';

const DAY = 86_400_000;

export const ENGAGEMENT_MODELS = [
  'PAID_PILOT', 'UNPAID_PILOT', 'DEVICE_PURCHASE', 'TESTING_CONTRACT',
  'CLINIC_PARTNERSHIP', 'INSTITUTIONAL_PROJECT', 'CSR_PROJECT',
  'PARTNERSHIP', 'COMMERCIAL', 'OTHER',
];

export const OPPORTUNITY_STATUSES = ['ACTIVE', 'WON', 'LOST', 'ON_HOLD', 'NURTURE'];
export const REQUIREMENT_CATEGORIES = [
  'COMMERCIAL', 'TECHNICAL', 'VALIDATION', 'LEGAL', 'OPERATIONAL', 'APPROVAL', 'DATA', 'OTHER',
];
export const REQUIREMENT_IMPORTANCE = ['MUST_HAVE', 'SHOULD_HAVE', 'NICE_TO_HAVE'];
export const REQUIREMENT_STATUSES = ['OPEN', 'IN_PROGRESS', 'MET', 'BLOCKED', 'WAIVED'];
export const CONTACT_ROLES = [
  'PRIMARY', 'DECISION_MAKER', 'CHAMPION', 'TECHNICAL_EVALUATOR',
  'PROCUREMENT', 'FINANCE', 'APPROVER', 'STAKEHOLDER', 'BLOCKER',
];
export const FINANCIAL_STATUSES = ['NOT_APPLICABLE', 'UNPAID', 'INVOICED', 'PART_PAID', 'PAID'];

/**
 * The kinds of agreement where money is not the point.
 *
 * An unpaid pilot or an unsigned MoU can be worth pursuing and worth recording,
 * but counting either as pipeline value is how a forecast starts lying.
 */
export const NON_COMMERCIAL_MODELS = new Set(['UNPAID_PILOT', 'CSR_PROJECT', 'PARTNERSHIP']);

export const OPPORTUNITY_SELECT = `
  SELECT o.*,
         a.name AS account_name, a.type AS account_type, a.segment_id,
         a.owner_user_id AS relationship_owner_id,
         a.department_id,
         seg.name AS segment_name, seg.color AS segment_color,
         u.full_name AS owner_name, u.avatar_color AS owner_color,
         ro.full_name AS relationship_owner_name,
         s.name AS stage_name, s.slug AS stage_slug, s.kind AS stage_kind,
         s.color AS stage_color, s.position AS stage_position,
         s.default_probability AS stage_probability,
         s.requires_contact, s.requires_next_action, s.requires_value,
         (SELECT COUNT(*)::int FROM opportunity_contacts oc WHERE oc.opportunity_id = o.id) AS contact_count,
         (SELECT COUNT(*)::int FROM opportunity_requirements r
           WHERE r.opportunity_id = o.id AND r.status NOT IN ('MET', 'WAIVED')) AS open_requirements,
         (SELECT COUNT(*)::int FROM opportunity_requirements r
           WHERE r.opportunity_id = o.id AND r.importance = 'MUST_HAVE'
             AND r.status NOT IN ('MET', 'WAIVED')) AS unmet_must_haves,
         (SELECT COUNT(*)::int FROM tasks t
            JOIN workflow_statuses ws ON ws.id = t.status_id
           WHERE t.opportunity_id = o.id AND t.is_archived = FALSE
             AND ws.stage NOT IN ('done', 'cancelled')) AS open_tasks,
         (SELECT COUNT(*)::int FROM tasks t
            JOIN workflow_statuses ws ON ws.id = t.status_id
           WHERE t.opportunity_id = o.id AND t.is_archived = FALSE
             AND ws.stage NOT IN ('done', 'cancelled')
             AND t.due_date < now()) AS overdue_tasks,
         (SELECT COUNT(*)::int FROM crm_meetings m
           WHERE m.opportunity_id = o.id AND m.status = 'COMPLETED') AS completed_meetings,
         (SELECT COUNT(*)::int FROM crm_meetings m
           WHERE m.opportunity_id = o.id AND m.status = 'SCHEDULED') AS upcoming_meetings
    FROM opportunities o
    JOIN accounts a ON a.id = o.account_id
    LEFT JOIN crm_segments seg ON seg.id = a.segment_id
    LEFT JOIN users u ON u.id = o.owner_user_id
    LEFT JOIN users ro ON ro.id = a.owner_user_id
    LEFT JOIN account_stages s ON s.id = o.stage_id
`;

const daysSince = (value, now = Date.now()) =>
  value ? Math.floor((now - new Date(value).getTime()) / DAY) : null;

const num = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * The one amount a forecast is allowed to use, and where it came from.
 *
 * Signed beats proposed beats estimated — the most committed number anyone has.
 * A deal whose model is not commercial, or whose value is explicitly unknown,
 * contributes nothing rather than a guess.
 */
export function eligibleValue(row) {
  if (row.value_unknown) return { amount: null, basis: 'unknown', reason: 'marked as not yet known' };
  if (NON_COMMERCIAL_MODELS.has(row.engagement_model)) {
    return { amount: null, basis: 'non_commercial', reason: 'not commercial work' };
  }
  const agreed = num(row.agreed_value);
  if (agreed !== null) return { amount: agreed, basis: 'agreed', reason: 'signed amount' };
  const proposed = num(row.proposed_value);
  if (proposed !== null) return { amount: proposed, basis: 'proposed', reason: 'amount we proposed' };
  const estimated = num(row.estimated_value);
  if (estimated !== null) return { amount: estimated, basis: 'estimated', reason: 'our estimate' };
  return { amount: null, basis: 'none', reason: 'no value recorded' };
}

/** The probability being used, and whether a person chose it or the stage did. */
export function probabilityOf(row) {
  if (row.probability !== null && row.probability !== undefined) {
    return { percent: Number(row.probability), source: 'explicit', reason: row.probability_reason || null };
  }
  const stage = row.stage_probability;
  return {
    percent: stage === null || stage === undefined ? null : Number(stage),
    source: 'stage',
    reason: `default for ${row.stage_name || 'this stage'}`,
  };
}

/**
 * What the stage says should be in place before this moves on.
 *
 * Advisory: it is returned so the UI can show it, never used to refuse an edit.
 * Early capture stays light; the gate only has anything to say once a deal has
 * reached a stage that expects more.
 */
export function stageGaps(row) {
  const gaps = [];
  if (row.requires_contact && !row.contact_count) {
    gaps.push({ kind: 'no_contact', label: 'No one named at the organization' });
  }
  if (row.requires_next_action && !row.next_step) {
    gaps.push({ kind: 'no_next_step', label: 'No next action' });
  }
  if (row.requires_next_action && row.next_step && !row.next_step_due) {
    gaps.push({ kind: 'no_next_step_date', label: 'Next action has no date' });
  }
  if (row.requires_value && eligibleValue(row).amount === null && !row.value_unknown) {
    gaps.push({ kind: 'no_value', label: 'No value recorded' });
  }
  if (!row.expected_close && row.stage_kind === 'open' && row.stage_position >= 4) {
    gaps.push({ kind: 'no_close_date', label: 'No expected close date' });
  }
  if (row.unmet_must_haves > 0) {
    gaps.push({
      kind: 'unmet_must_haves',
      label: `${row.unmet_must_haves} must-have requirement${row.unmet_must_haves === 1 ? '' : 's'} unresolved`,
    });
  }
  return gaps;
}

/** Attaches everything derived. Nothing here is stored. */
export function decorateOpportunity(row, now = Date.now()) {
  const value = eligibleValue(row);
  const probability = probabilityOf(row);
  const isOpen = row.stage_kind === 'open' && row.status === 'ACTIVE';

  return {
    ...row,
    estimated_value: num(row.estimated_value),
    proposed_value: num(row.proposed_value),
    agreed_value: num(row.agreed_value),
    collected_value: num(row.collected_value),
    // the single number a forecast may use, and the label that says which it is
    eligible_value: value.amount,
    eligible_basis: value.basis,
    eligible_reason: value.reason,
    probability_percent: probability.percent,
    probability_source: probability.source,
    probability_note: probability.reason,
    // an estimate, and the response says so wherever it appears
    weighted_value:
      value.amount === null || probability.percent === null
        ? null
        : Math.round((value.amount * probability.percent) / 100),
    is_open: isOpen,
    days_since_stage_change: daysSince(row.stage_changed_at, now),
    days_since_external: daysSince(row.last_external_at, now),
    next_step_overdue: row.next_step_due
      ? new Date(row.next_step_due).getTime() < now && isOpen
      : false,
    close_overdue: row.expected_close
      ? new Date(row.expected_close).getTime() < now && isOpen
      : false,
    gaps: stageGaps(row),
  };
}

/** Whoever leads the deal, leads the relationship, or manages any of them. */
export const canEditOpportunity = (user, row) =>
  hasPermission(user, 'crm.manage.any')
  || row.owner_user_id === user.id
  || row.relationship_owner_id === user.id
  || row.created_by === user.id;

// ---------------------------------------------------------------- fetching

export async function listOpportunities(filters = {}) {
  const params = [];
  const where = ['o.is_archived = FALSE', 'a.is_archived = FALSE'];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.accountId) where.push(`o.account_id = ${push(Number(filters.accountId))}`);
  if (filters.ownerId) where.push(`o.owner_user_id = ${push(Number(filters.ownerId))}`);
  if (filters.stageId) where.push(`o.stage_id = ${push(Number(filters.stageId))}`);
  if (filters.segmentId) where.push(`a.segment_id = ${push(Number(filters.segmentId))}`);
  if (filters.departmentId) where.push(`a.department_id = ${push(Number(filters.departmentId))}`);
  if (filters.status) where.push(`o.status = ${push(filters.status)}`);
  if (filters.model) where.push(`o.engagement_model = ${push(filters.model)}`);
  if (filters.openOnly) where.push(`o.status = 'ACTIVE'`);
  if (filters.closingBefore) where.push(`o.expected_close <= ${push(filters.closingBefore)}`);
  if (filters.search) {
    const term = push(`%${filters.search}%`);
    where.push(`(o.name ILIKE ${term} OR a.name ILIKE ${term})`);
  }

  const limit = Math.min(Number(filters.limit) || 300, 1000);
  const { rows } = await query(
    `${OPPORTUNITY_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY s.position NULLS LAST, o.expected_close NULLS LAST, o.id DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => decorateOpportunity(row));
}

export async function getOpportunity(id) {
  const { rows } = await query(`${OPPORTUNITY_SELECT} WHERE o.id = $1`, [id]);
  return rows[0] ? decorateOpportunity(rows[0]) : null;
}

/** The deals on one organization, newest first, open ones above settled ones. */
export async function opportunitiesFor(accountId) {
  const { rows } = await query(
    `${OPPORTUNITY_SELECT} WHERE o.account_id = $1 AND o.is_archived = FALSE
      ORDER BY (o.status = 'ACTIVE') DESC, o.expected_close NULLS LAST, o.id DESC`,
    [accountId],
  );
  return rows.map((row) => decorateOpportunity(row));
}

// ---------------------------------------------------------------- contacts

export async function listContacts(accountId, { includeInactive = false } = {}) {
  const { rows } = await query(
    `SELECT c.*,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'opportunity_id', oc.opportunity_id, 'role', oc.role,
                 'involvement', oc.involvement, 'opportunity_name', o.name))
                 FROM opportunity_contacts oc
                 JOIN opportunities o ON o.id = oc.opportunity_id
                WHERE oc.contact_id = c.id), '[]'::json) AS roles
       FROM account_contacts c
      WHERE c.account_id = $1 ${includeInactive ? '' : 'AND c.is_active = TRUE'}
      ORDER BY c.is_primary DESC, c.full_name`,
    [accountId],
  );
  return rows;
}

/**
 * Contacts that look like they might be the same person.
 *
 * Flagged for a human to judge, never merged: two people at one organization can
 * share a name, and a shared email domain proves only that they work together.
 */
export async function possibleDuplicateContacts(accountId, { email, phone, fullName }) {
  const { rows } = await query(
    `SELECT id, full_name, email, phone FROM account_contacts
      WHERE account_id = $1 AND is_active = TRUE
        AND ( (LENGTH(COALESCE($2, '')) > 0 AND LOWER(email) = LOWER($2))
           OR (LENGTH(COALESCE($3, '')) > 0 AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')
                                              = regexp_replace($3, '\\D', '', 'g'))
           OR (LENGTH(COALESCE($4, '')) > 0 AND LOWER(full_name) = LOWER($4)) )`,
    [accountId, email || null, phone || null, fullName || null],
  );
  return rows;
}

// ---------------------------------------------------------------- requirements

export async function listRequirements(opportunityId) {
  const { rows } = await query(
    `SELECT r.*, u.full_name AS owner_name, u.avatar_color AS owner_color,
            t.ref AS task_ref, t.title AS task_title, ws.stage AS task_stage
       FROM opportunity_requirements r
       LEFT JOIN users u ON u.id = r.owner_user_id
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
      WHERE r.opportunity_id = $1
      ORDER BY
        CASE r.importance WHEN 'MUST_HAVE' THEN 0 WHEN 'SHOULD_HAVE' THEN 1 ELSE 2 END,
        CASE r.status WHEN 'BLOCKED' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'IN_PROGRESS' THEN 2 ELSE 3 END,
        r.position, r.id`,
    [opportunityId],
  );
  return rows;
}

/**
 * The single thing most in the way of winning, or nothing.
 * A blocked must-have outranks an open one; nothing met or waived counts.
 */
export function topBlocker(requirements = []) {
  const live = requirements.filter((r) => !['MET', 'WAIVED'].includes(r.status));
  return (
    live.find((r) => r.importance === 'MUST_HAVE' && r.status === 'BLOCKED')
    || live.find((r) => r.status === 'BLOCKED')
    || live.find((r) => r.importance === 'MUST_HAVE')
    || null
  );
}

// ---------------------------------------------------------------- history

export async function recordHistory(client, { opportunityId, field, from, to, actorId, reason, isReversal = false }) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO opportunity_history
       (opportunity_id, field, from_value, to_value, is_reversal, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      opportunityId,
      field,
      from === null || from === undefined ? null : String(from),
      to === null || to === undefined ? null : String(to),
      isReversal,
      reason ?? null,
      actorId ?? null,
    ],
  );
}

export async function recordOwnershipChange(client, { entityType, entityId, from, to, actorId, reason }) {
  if (from === to) return;
  const runner = client || { query };
  await runner.query(
    `INSERT INTO crm_ownership_history (entity_type, entity_id, from_user_id, to_user_id, reason, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [entityType, entityId, from ?? null, to ?? null, reason ?? null, actorId ?? null],
  );
}

export async function listHistory(opportunityId) {
  const { rows } = await query(
    `SELECT h.*, u.full_name AS actor_name, u.avatar_color AS actor_color
       FROM opportunity_history h LEFT JOIN users u ON u.id = h.actor_id
      WHERE h.opportunity_id = $1 ORDER BY h.created_at DESC LIMIT 100`,
    [opportunityId],
  );
  return rows;
}

/**
 * Keeps the account's mirror columns in step with its primary opportunity.
 *
 * `accounts.stage_id`, `value` and `status` were the truth before deals were
 * separated out, and the board, the nudges and the insights all read them. They
 * are kept correct so none of that had to be rewritten in the same change.
 */
export async function syncAccountMirror(client, accountId) {
  const runner = client || { query };
  await runner.query(
    `UPDATE accounts a
        SET stage_id = o.stage_id,
            value = COALESCE(o.agreed_value, o.proposed_value, o.estimated_value),
            status = CASE o.status WHEN 'NURTURE' THEN 'ON_HOLD' ELSE o.status END,
            stage_changed_at = o.stage_changed_at,
            next_step = o.next_step,
            next_step_due = o.next_step_due,
            updated_at = now()
       FROM opportunities o
      WHERE o.id = a.primary_opportunity_id AND a.id = $1`,
    [accountId],
  );
}

/**
 * Chooses which deal the organization's headline figures follow.
 * The open one closing soonest; failing that, the most recently touched.
 */
export async function refreshPrimaryOpportunity(client, accountId) {
  const runner = client || { query };
  await runner.query(
    `UPDATE accounts SET primary_opportunity_id = (
        SELECT o.id FROM opportunities o
         WHERE o.account_id = $1 AND o.is_archived = FALSE
         ORDER BY (o.status = 'ACTIVE') DESC, o.expected_close NULLS LAST, o.updated_at DESC
         LIMIT 1)
      WHERE id = $1`,
    [accountId],
  );
  await syncAccountMirror(client, accountId);
}
