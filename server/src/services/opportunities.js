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
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { notify } from './activity.js';
import { logActivity } from './crm.js';
import { nextActionGaps, problemWithNextAction } from './dealRules.js';

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

/**
 * Three different "last touched" dates, never folded into one.
 *
 *   last_customer_at — the customer engaged: they wrote or called in, a reply
 *     was received, or a call, meeting, demo or visit actually took place.
 *   last_outbound_at — we reached out: something sent, an attempt, or an
 *     exchange we were part of. Chasing a silent customer moves this, not the
 *     one above, which is exactly how "waiting on them" becomes visible.
 *   last_internal_at — work on our side the customer never saw: notes, stage
 *     changes, edits, finished tasks. Tidying a record moves only this.
 *
 * Read from the deal's own entries and from entries on the organization that
 * name no deal, so an email logged against the organization still counts.
 */
const CUSTOMER_SPOKE = `act.is_external = TRUE
      AND (act.direction = 'INBOUND' OR act.outcome = 'RECEIVED'
           OR (act.outcome = 'COMPLETED' AND act.type IN ('CALL', 'MEETING', 'DEMO', 'IN_PERSON')))`;
const WE_REACHED_OUT = `act.is_external = TRUE
      AND act.direction IS DISTINCT FROM 'INBOUND'
      AND act.outcome IN ('SENT', 'ATTEMPTED', 'COMPLETED')`;
const OUR_SIDE_ONLY = 'act.is_external = FALSE';

/** The latest entry matching `condition`, on the deal or on its organization with no deal named. */
const latest = (condition) => `GREATEST(
    (SELECT MAX(act.occurred_at) FROM account_activities act
      WHERE act.opportunity_id = o.id AND ${condition}),
    (SELECT MAX(act.occurred_at) FROM account_activities act
      WHERE act.account_id = o.account_id AND act.opportunity_id IS NULL AND ${condition}))`;

export const FRESHNESS_COLUMNS = `
  ${latest(CUSTOMER_SPOKE)} AS last_customer_at,
  ${latest(WE_REACHED_OUT)} AS last_outbound_at,
  GREATEST(
    ${latest(OUR_SIDE_ONLY)},
    (SELECT MAX(h.created_at) FROM opportunity_history h WHERE h.opportunity_id = o.id)
  ) AS last_internal_at`;

/**
 * The commercial record, one figure per kind of claim. A SUM over no rows is
 * NULL and stays NULL: "nothing recorded" is not "zero".
 */
export const COMMERCIAL_COLUMNS = `
  (SELECT COUNT(*)::int FROM opportunity_proposals p
    WHERE p.opportunity_id = o.id AND p.status <> 'WITHDRAWN') AS proposal_count,
  (SELECT MAX(p.sent_on) FROM opportunity_proposals p
    WHERE p.opportunity_id = o.id AND p.status <> 'WITHDRAWN') AS last_proposal_on,
  (SELECT COUNT(*)::int FROM opportunity_orders r
    WHERE r.opportunity_id = o.id AND r.status = 'ACCEPTED') AS order_count,
  (SELECT SUM(r.amount) FROM opportunity_orders r
    WHERE r.opportunity_id = o.id AND r.status = 'ACCEPTED') AS booked_value,
  (SELECT SUM(i.amount) FROM opportunity_invoices i
    WHERE i.opportunity_id = o.id AND i.status = 'ISSUED') AS invoiced_value,
  (SELECT SUM(pm.amount) FROM opportunity_payments pm
    WHERE pm.opportunity_id = o.id AND pm.is_void = FALSE) AS cash_received`;

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
           WHERE m.opportunity_id = o.id AND m.status = 'SCHEDULED') AS upcoming_meetings,
         a.type AS account_kind, a.state AS account_state, a.logo_url AS account_logo_url,
         (SELECT i.created_at FROM account_images i
           WHERE i.account_id = a.id AND i.kind = 'LOGO') AS account_logo_uploaded_at,
         na.full_name AS next_step_owner_name, na.avatar_color AS next_step_owner_color,
         eo.full_name AS escalation_owner_name, eo.avatar_color AS escalation_owner_color,
         COALESCE((
           SELECT json_agg(json_build_object(
             'user_id', c.user_id, 'name', cu.full_name, 'color', cu.avatar_color, 'role', c.role)
             ORDER BY cu.full_name)
             FROM opportunity_collaborators c JOIN users cu ON cu.id = c.user_id
            WHERE c.opportunity_id = o.id), '[]'::json) AS collaborators,
         (SELECT COUNT(*)::int FROM opportunity_handovers hv
           WHERE hv.opportunity_id = o.id AND hv.acknowledged_at IS NULL) AS pending_handovers,
         -- raised on this deal, or on its organization without naming a deal
         (SELECT COUNT(*)::int FROM discussion_threads dt
           WHERE dt.kind = 'blocker' AND dt.status = 'open'
             AND ((dt.entity_type = 'OPPORTUNITY' AND dt.entity_id = o.id)
                  OR (dt.entity_type = 'ACCOUNT' AND dt.entity_id = o.account_id))) AS open_blockers,
         ${FRESHNESS_COLUMNS},
         ${COMMERCIAL_COLUMNS}
    FROM opportunities o
    JOIN accounts a ON a.id = o.account_id
    LEFT JOIN crm_segments seg ON seg.id = a.segment_id
    LEFT JOIN users u ON u.id = o.owner_user_id
    LEFT JOIN users ro ON ro.id = a.owner_user_id
    LEFT JOIN users na ON na.id = o.next_step_owner_id
    LEFT JOIN users eo ON eo.id = o.escalation_owner_id
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

/**
 * Everything worth flagging on a live deal, most fixable first: the next
 * action's what / who / when, a deal nobody owns, then what its stage expects.
 */
export function dealFlags(row, gaps = stageGaps(row)) {
  const flags = [...nextActionGaps(row)];
  if (row.status === 'ACTIVE' && row.stage_kind === 'open' && !row.owner_user_id) {
    flags.push({ kind: 'no_owner', label: 'Nobody owns this deal' });
  }
  // the next-action gaps above already say these two, in more detail
  for (const gap of gaps) {
    if (gap.kind === 'no_next_step' || gap.kind === 'no_next_step_date') continue;
    flags.push(gap);
  }
  return flags;
}

/** Attaches everything derived. Nothing here is stored. */
export function decorateOpportunity(row, now = Date.now()) {
  const value = eligibleValue(row);
  const probability = probabilityOf(row);
  const isOpen = row.stage_kind === 'open' && row.status === 'ACTIVE';
  const gaps = stageGaps(row);
  const customerAt = row.last_customer_at ? new Date(row.last_customer_at).getTime() : null;
  const outboundAt = row.last_outbound_at ? new Date(row.last_outbound_at).getTime() : null;

  return {
    ...row,
    estimated_value: num(row.estimated_value),
    proposed_value: num(row.proposed_value),
    agreed_value: num(row.agreed_value),
    collected_value: num(row.collected_value),
    // the commercial record: bookings, revenue billed and cash, never summed
    booked_value: num(row.booked_value),
    invoiced_value: num(row.invoiced_value),
    cash_received: num(row.cash_received),
    days_since_customer: daysSince(row.last_customer_at, now),
    days_since_outbound: daysSince(row.last_outbound_at, now),
    days_since_internal: daysSince(row.last_internal_at, now),
    // we have chased since they last engaged — the ball is in their court
    awaiting_customer: outboundAt !== null && (customerAt === null || outboundAt > customerAt),
    next_step_age_days: daysSince(row.next_step_set_at, now),
    next_action_gaps: nextActionGaps(row),
    flags: dealFlags(row, gaps),
    account_logo_src: row.account_logo_uploaded_at
      ? `/accounts/${row.account_id}/image/logo?v=${new Date(row.account_logo_uploaded_at).getTime()}`
      : row.account_logo_url || null,
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
    gaps,
  };
}

/**
 * Whoever leads the deal, leads the relationship, owes its next move, is its
 * escalation point, or manages any of them. Collaborators are checked
 * separately (see canWorkOnOpportunity), because that needs a lookup.
 */
export const canEditOpportunity = (user, row) =>
  hasPermission(user, 'crm.manage.any')
  || row.owner_user_id === user.id
  || row.relationship_owner_id === user.id
  || row.created_by === user.id
  || row.next_step_owner_id === user.id
  || row.escalation_owner_id === user.id;

/** The same, plus the people named as helping on the deal. */
export async function canWorkOnOpportunity(user, row) {
  if (canEditOpportunity(user, row)) return true;
  const { rows } = await query(
    'SELECT 1 FROM opportunity_collaborators WHERE opportunity_id = $1 AND user_id = $2',
    [row.id, user.id],
  );
  return rows.length > 0;
}

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
  if (filters.statuses) where.push(`o.status = ANY(${push(filters.statuses)}::text[])`);
  if (filters.model) where.push(`o.engagement_model = ${push(filters.model)}`);
  if (filters.openOnly) where.push(`o.status = 'ACTIVE'`);
  if (filters.nextOwnerId) where.push(`o.next_step_owner_id = ${push(Number(filters.nextOwnerId))}`);
  if (filters.accountType) where.push(`a.type = ${push(filters.accountType)}`);
  if (filters.state === 'none') where.push(`NULLIF(TRIM(a.state), '') IS NULL`);
  else if (filters.state) where.push(`LOWER(TRIM(a.state)) = LOWER(TRIM(${push(filters.state)}))`);
  // everything one person is part of: leading it, owing its next move, being
  // its escalation point, helping on it, or leading the relationship
  if (filters.involving) {
    const uid = push(Number(filters.involving));
    where.push(`(o.owner_user_id = ${uid} OR o.next_step_owner_id = ${uid}
                 OR o.escalation_owner_id = ${uid} OR a.owner_user_id = ${uid}
                 OR EXISTS (SELECT 1 FROM opportunity_collaborators oc2
                             WHERE oc2.opportunity_id = o.id AND oc2.user_id = ${uid}))`);
  }
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

export async function recordHistory(client, {
  opportunityId, field, from, to, actorId, reason, isReversal = false, evidenceMissing = null,
}) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO opportunity_history
       (opportunity_id, field, from_value, to_value, is_reversal, reason, actor_id, evidence_missing)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      opportunityId,
      field,
      from === null || from === undefined ? null : String(from),
      to === null || to === undefined ? null : String(to),
      isReversal,
      reason ?? null,
      actorId ?? null,
      evidenceMissing?.length ? evidenceMissing : null,
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

// ---------------------------------------------------------------- people on a deal

const ROLE_WORDS = {
  OWNER: 'deal owner',
  NEXT_ACTION: 'next action',
  ESCALATION: 'escalation point',
};

/** An active user, or a clear refusal — a deal is never handed to nobody. */
export async function mustBeActiveUser(userId, runner = { query }) {
  const { rows } = await runner.query(
    'SELECT id, full_name, is_active FROM users WHERE id = $1', [userId],
  );
  if (!rows[0]) throw badRequest('That person does not exist');
  if (!rows[0].is_active) throw badRequest(`${rows[0].full_name} is no longer active — pick someone who is`);
  return rows[0];
}

/**
 * Records that something on a deal changed hands, and tells both people.
 *
 * The new person is asked to acknowledge it; until they do, the deal shows the
 * handover as unconfirmed, so "I thought you had it" is visible before it costs
 * a week.
 */
export async function recordHandover(client, {
  opportunity, role, fromUserId, toUserId, reason = null, owed = null, actor,
}) {
  const { rows } = await client.query(
    `INSERT INTO opportunity_handovers
       (opportunity_id, role, from_user_id, to_user_id, reason, owed, handed_by, acknowledged_at, acknowledged_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,
             CASE WHEN $4::int = $7::int THEN now() END,
             CASE WHEN $4::int = $7::int THEN $7::int END)
     RETURNING *`,
    // taking something on yourself needs no confirmation from yourself
    [opportunity.id, role, fromUserId ?? null, toUserId ?? null, reason, owed, actor.id],
  );

  const what = ROLE_WORDS[role] || 'deal';
  if (toUserId && toUserId !== actor.id) {
    await notify(client, {
      userId: toUserId,
      type: 'crm_handover',
      title: `${opportunity.name}: you are now the ${what}`,
      body: [owed && `Owed next: ${owed}`, reason && `Why: ${reason}`, 'Open the deal to confirm you have it.']
        .filter(Boolean).join(' · '),
      accountId: opportunity.account_id,
    });
  }
  if (fromUserId && fromUserId !== actor.id && fromUserId !== toUserId) {
    await notify(client, {
      userId: fromUserId,
      type: 'crm_handover',
      title: `${opportunity.name}: the ${what} has moved to someone else`,
      body: reason ? `Why: ${reason}` : null,
      accountId: opportunity.account_id,
    });
  }

  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'HANDOVER',
    actorId: actor.id,
    subject: `${opportunity.name}: ${what} handed over`,
    body: [owed && `Owed next: ${owed}`, reason && `Why: ${reason}`].filter(Boolean).join('\n') || null,
    meta: { role, from: fromUserId ?? null, to: toUserId ?? null, handover_id: rows[0].id },
    direction: 'INTERNAL',
    isExternal: false,
    source: 'MANUAL',
  });
  return rows[0];
}

export async function listHandovers(opportunityId) {
  const { rows } = await query(
    `SELECT h.*, f.full_name AS from_name, t.full_name AS to_name, t.avatar_color AS to_color,
            b.full_name AS handed_by_name, k.full_name AS acknowledged_by_name
       FROM opportunity_handovers h
       LEFT JOIN users f ON f.id = h.from_user_id
       LEFT JOIN users t ON t.id = h.to_user_id
       LEFT JOIN users b ON b.id = h.handed_by
       LEFT JOIN users k ON k.id = h.acknowledged_by
      WHERE h.opportunity_id = $1
      ORDER BY h.created_at DESC LIMIT 50`,
    [opportunityId],
  );
  return rows;
}

/** Handovers waiting for this person to say they have it. */
export async function pendingHandoversFor(userId) {
  const { rows } = await query(
    `SELECT h.*, o.name AS opportunity_name, o.account_id, a.name AS account_name,
            f.full_name AS from_name, b.full_name AS handed_by_name
       FROM opportunity_handovers h
       JOIN opportunities o ON o.id = h.opportunity_id
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN users f ON f.id = h.from_user_id
       LEFT JOIN users b ON b.id = h.handed_by
      WHERE h.to_user_id = $1 AND h.acknowledged_at IS NULL
        AND o.is_archived = FALSE
      ORDER BY h.created_at`,
    [userId],
  );
  return rows;
}

export async function acknowledgeHandover(handoverId, user) {
  const { rows } = await query('SELECT * FROM opportunity_handovers WHERE id = $1', [handoverId]);
  const handover = rows[0];
  if (!handover) throw notFound('Handover not found');
  if (handover.to_user_id !== user.id && !hasPermission(user, 'crm.manage.any')) {
    throw forbidden('Only the person it was handed to can confirm it');
  }
  if (handover.acknowledged_at) return handover;
  const { rows: updated } = await query(
    `UPDATE opportunity_handovers SET acknowledged_at = now(), acknowledged_by = $2
      WHERE id = $1 RETURNING *`,
    [handoverId, user.id],
  );
  return updated[0];
}

// ---------------------------------------------------------------- the next action

const dayOf = (value) => (value ? String(value).slice(0, 10) : '');

/**
 * Sets what happens next on a deal: the action, who owes it, and by when.
 *
 * All three, always — that is the rule. The change is recorded field by field
 * in the deal's history, appears on the timeline as internal work (it is not
 * contact with the customer), and a change of person is a handover the new
 * person is told about.
 */
export async function setNextAction(client, {
  opportunity, step, ownerId, due, actor, reason = null, taskId = null,
}) {
  const text = String(step ?? '').trim();
  const day = dayOf(due);
  const owner = ownerId === null || ownerId === undefined || ownerId === '' ? null : Number(ownerId);
  const changed = {
    next_step: text !== String(opportunity.next_step ?? '').trim(),
    next_step_due: day !== dayOf(opportunity.next_step_due),
    next_step_owner_id: owner !== (opportunity.next_step_owner_id ?? null),
  };
  // saving a form that repeats the current next action changes nothing, and is
  // not the moment to refuse an older deal for what it was already missing
  if (!changed.next_step && !changed.next_step_due && !changed.next_step_owner_id) {
    return { changed: false };
  }

  const problem = problemWithNextAction({ step: text, ownerId: owner, due: day });
  if (problem) throw badRequest(problem, { code: 'NEXT_ACTION_INVALID' });

  const person = await mustBeActiveUser(owner, client);

  await client.query(
    `UPDATE opportunities
        SET next_step = $1, next_step_due = $2::date, next_step_owner_id = $3,
            next_step_set_at = now(), next_step_set_by = $4, next_step_task_id = $5,
            updated_at = now()
      WHERE id = $6`,
    [text, day, owner, actor.id, taskId, opportunity.id],
  );

  for (const [field, after] of [['next_step', text], ['next_step_due', day], ['next_step_owner_id', owner]]) {
    if (!changed[field]) continue;
    await recordHistory(client, {
      opportunityId: opportunity.id,
      field,
      from: field === 'next_step_due' ? dayOf(opportunity[field]) || null : opportunity[field],
      to: after,
      actorId: actor.id,
      reason,
    });
  }

  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'NEXT_ACTION',
    actorId: actor.id,
    subject: `Next action: ${text}`,
    body: `${person.full_name} · by ${day}${reason ? `\nWhy: ${reason}` : ''}`,
    meta: {
      owner_id: owner, due: day,
      previous: { step: opportunity.next_step ?? null, owner_id: opportunity.next_step_owner_id ?? null,
        due: dayOf(opportunity.next_step_due) || null },
    },
    direction: 'INTERNAL',
    isExternal: false,
    source: taskId ? 'TASK' : 'MANUAL',
  });

  if (changed.next_step_owner_id) {
    if (opportunity.next_step_owner_id) {
      // a move from one person to another is a handover, and both are told
      await recordHandover(client, {
        opportunity, role: 'NEXT_ACTION', fromUserId: opportunity.next_step_owner_id,
        toUserId: owner, reason, owed: text, actor,
      });
    } else if (owner !== actor.id) {
      await notify(client, {
        userId: owner,
        type: 'crm_next_action',
        title: `${opportunity.name}: the next move is yours`,
        body: `${text} — by ${day}`,
        accountId: opportunity.account_id,
      });
    }
  } else if (owner !== actor.id && (changed.next_step || changed.next_step_due)) {
    // the same person, a different ask: they hear about it
    await notify(client, {
      userId: owner,
      type: 'crm_next_action',
      title: `${opportunity.name}: next action updated`,
      body: `${text} — by ${day}`,
      accountId: opportunity.account_id,
    });
  }

  await syncAccountMirror(client, opportunity.account_id);
  return { changed: true };
}

// ---------------------------------------------------------------- the board

/**
 * The board, one card per deal.
 *
 * It used to be one card per lead, and only leads: the moment an organization
 * became a customer, every deal it still had open vanished from the board. A
 * deal is now on the board because it is live, whatever the organization is.
 */
export async function dealBoard(filters = {}) {
  const [{ rows: stages }, deals] = await Promise.all([
    query(
      `SELECT id, name, slug, kind, color, position, default_probability,
              requires_contact, requires_next_action, requires_value,
              entry_rules, exit_rules, entry_expectations
         FROM account_stages WHERE is_active = TRUE ORDER BY position, id`,
    ),
    listOpportunities({ ...filters, statuses: ['ACTIVE', 'ON_HOLD', 'NURTURE'], limit: 1000 }),
  ]);

  const params = [];
  const where = ['o.is_archived = FALSE', 'a.is_archived = FALSE', `o.status IN ('WON', 'LOST')`];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.ownerId) where.push(`o.owner_user_id = ${push(Number(filters.ownerId))}`);
  if (filters.departmentId) where.push(`a.department_id = ${push(Number(filters.departmentId))}`);
  const { rows: settled } = await query(
    `SELECT o.stage_id, o.status, COUNT(*)::int AS n
       FROM opportunities o JOIN accounts a ON a.id = o.account_id
      WHERE ${where.join(' AND ')}
      GROUP BY o.stage_id, o.status`,
    params,
  );

  const live = deals.filter((d) => d.status === 'ACTIVE');
  const paused = deals.filter((d) => d.status !== 'ACTIVE');
  const openStages = stages.filter((s) => s.kind === 'open');
  const byStage = new Map(openStages.map((s) => [s.id, []]));
  // a live deal sitting in a closed stage, or in none, is a contradiction worth
  // showing rather than a card worth hiding
  const misplaced = [];
  for (const deal of live) {
    if (byStage.has(deal.stage_id)) byStage.get(deal.stage_id).push(deal);
    else misplaced.push(deal);
  }

  const columns = openStages.map((stage) => {
    const list = byStage.get(stage.id);
    return {
      ...stage,
      deals: list,
      count: list.length,
      eligible_value: list.reduce((sum, d) => sum + (d.eligible_value ?? 0), 0),
      without_value: list.filter((d) => d.eligible_basis === 'none').length,
    };
  });

  return {
    stages: columns,
    closed: stages.filter((s) => s.kind !== 'open').map((stage) => ({
      ...stage,
      count: settled.filter((r) => r.stage_id === stage.id).reduce((sum, r) => sum + r.n, 0),
    })),
    all_stages: stages,
    paused,
    misplaced,
    total: live.length,
    organizations: new Set(live.map((d) => d.account_id)).size,
    eligible_value: columns.reduce((sum, c) => sum + c.eligible_value, 0),
    deals_without_value: columns.reduce((sum, c) => sum + c.without_value, 0),
    needs_attention: live.filter((d) => d.flags.length > 0).length,
  };
}
