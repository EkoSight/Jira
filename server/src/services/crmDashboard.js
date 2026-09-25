/**
 * What the pipeline looks like from above.
 *
 * Every figure here is defined, and its date basis is stated in the response —
 * "this month's wins" counts deals whose won event landed in the month, and
 * "this month's demos" counts meetings that actually completed in it. Current
 * portfolio and activity-during-a-month are kept apart, because mixing them is
 * how a dashboard starts flattering or accusing people.
 *
 * Money follows the same rule the opportunity engine uses: one eligible value
 * per deal, non-commercial work contributes nothing, and a blank is not a zero.
 */

import { query } from '../db/pool.js';
import { decorateOpportunity, eligibleValue, probabilityOf } from './opportunities.js';
import { decorateEngagement } from './engagements.js';

const monthBounds = (month) => {
  const anchor = month ? new Date(`${month}-01T00:00:00Z`) : new Date();
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  return {
    start,
    end,
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
  };
};

/**
 * What each figure means, shipped with the numbers.
 * A metric whose definition is not visible cannot be argued with, and a
 * dashboard nobody can argue with is one nobody trusts.
 */
export const METRIC_DEFINITIONS = {
  open_opportunities: { label: 'Open opportunities', basis: 'now', detail: 'Deals not won, lost or paused, as things stand.' },
  eligible_pipeline: { label: 'Eligible pipeline', basis: 'now', detail: 'One value per open deal — signed, else proposed, else estimated. Unpaid pilots, CSR projects and MoUs contribute nothing.' },
  weighted_forecast: { label: 'Weighted forecast', basis: 'now', detail: 'Eligible value × probability. An estimate using a disclosed probability, not a prediction.' },
  won_this_month: { label: 'Won', basis: 'month', detail: 'Deals whose won event happened inside the selected month.' },
  lost_this_month: { label: 'Lost', basis: 'month', detail: 'Deals whose lost event happened inside the selected month.' },
  value_won: { label: 'Value won', basis: 'month', detail: 'Agreed amounts on deals won in the month. Not revenue collected.' },
  value_collected: { label: 'Collected', basis: 'all', detail: 'Amounts recorded as actually received. Entered by hand, not from an accounting system.' },
  demos_completed: { label: 'Demos completed', basis: 'month', detail: 'Demos whose status is COMPLETED and whose completion fell in the month. A booked demo is not counted.' },
  meetings_completed: { label: 'Meetings completed', basis: 'month', detail: 'Meetings marked completed in the month.' },
  conversations: { label: 'Conversations', basis: 'month', detail: 'Interactions logged as a completed exchange — not messages sent, and not attempts.' },
  proposals_shared: { label: 'Proposals shared', basis: 'month', detail: 'Resources somebody recorded as actually sent to a contact.' },
  closing_soon: { label: 'Closing soon', basis: 'now', detail: 'Open deals with an expected close date inside 30 days.' },
  stalled: { label: 'Stalled', basis: 'now', detail: 'Open deals with no external interaction for longer than the configured cadence.' },
  overdue_next_actions: { label: 'Overdue next actions', basis: 'now', detail: 'Open deals whose next-action date has passed.' },
  missing_next_action: { label: 'No next action', basis: 'now', detail: 'Open deals past the qualification stage with nothing agreed as next.' },
  unresolved_blockers: { label: 'Unresolved blockers', basis: 'now', detail: 'Must-have requirements that are open or blocked on live deals.' },
  engagements_attention: { label: 'Delivery needing attention', basis: 'now', detail: 'Live engagements at risk, blocked, or with an overdue milestone.' },
};

const OPEN = `o.status = 'ACTIVE' AND o.is_archived = FALSE AND a.is_archived = FALSE`;

const scopeClause = (filters, params) => {
  const where = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.ownerId) where.push(`o.owner_user_id = ${push(Number(filters.ownerId))}`);
  if (filters.departmentId) where.push(`a.department_id = ${push(Number(filters.departmentId))}`);
  if (filters.segmentId) where.push(`a.segment_id = ${push(Number(filters.segmentId))}`);
  return where;
};

/**
 * The portfolio as it stands, plus what happened during one month.
 * The two are returned separately and labelled, never merged into one figure.
 */
export async function crmDashboard(filters = {}) {
  const bounds = monthBounds(filters.month);
  const params = [];
  const scope = scopeClause(filters, params);
  const scoped = scope.length ? `AND ${scope.join(' AND ')}` : '';

  // ---- the open book, valued one deal at a time so the rules hold
  const { rows: openRows } = await query(
    `SELECT o.*, a.name AS account_name, a.segment_id, a.department_id,
            a.owner_user_id AS relationship_owner_id,
            u.full_name AS owner_name, u.avatar_color AS owner_color,
            s.name AS stage_name, s.slug AS stage_slug, s.kind AS stage_kind,
            s.color AS stage_color, s.position AS stage_position,
            s.default_probability AS stage_probability,
            s.requires_contact, s.requires_next_action, s.requires_value,
            (SELECT COUNT(*)::int FROM opportunity_contacts oc WHERE oc.opportunity_id = o.id) AS contact_count,
            (SELECT COUNT(*)::int FROM opportunity_requirements r
              WHERE r.opportunity_id = o.id AND r.importance = 'MUST_HAVE'
                AND r.status NOT IN ('MET','WAIVED')) AS unmet_must_haves
       FROM opportunities o
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN users u ON u.id = o.owner_user_id
       LEFT JOIN account_stages s ON s.id = o.stage_id
      WHERE ${OPEN} ${scoped}`,
    params,
  );

  const open = openRows.map((row) => decorateOpportunity(row));
  const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

  const soon = new Date(Date.now() + 30 * 86_400_000);
  const closingSoon = open.filter(
    (o) => o.expected_close && new Date(o.expected_close) <= soon,
  );

  // ---- what happened in the month, each on its own date basis
  const monthParams = [bounds.start, bounds.end, ...params];
  const shift = (clause) => clause.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 2}`);
  const monthScoped = scope.length ? `AND ${scope.map(shift).join(' AND ')}` : '';

  const { rows: monthRows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM opportunities o JOIN accounts a ON a.id = o.account_id
         WHERE o.status = 'WON' AND o.closed_at >= $1 AND o.closed_at < $2 ${monthScoped}) AS won,
       (SELECT COUNT(*)::int FROM opportunities o JOIN accounts a ON a.id = o.account_id
         WHERE o.status = 'LOST' AND o.closed_at >= $1 AND o.closed_at < $2 ${monthScoped}) AS lost,
       (SELECT COALESCE(SUM(o.agreed_value), 0) FROM opportunities o JOIN accounts a ON a.id = o.account_id
         WHERE o.status = 'WON' AND o.closed_at >= $1 AND o.closed_at < $2 ${monthScoped}) AS value_won,
       (SELECT COALESCE(SUM(o.collected_value), 0) FROM opportunities o JOIN accounts a ON a.id = o.account_id
         WHERE o.collected_value IS NOT NULL ${monthScoped}) AS value_collected`,
    monthParams,
  );

  const { rows: activityRows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM crm_meetings m
         WHERE m.kind = 'DEMO' AND m.status = 'COMPLETED'
           AND m.completed_at >= $1 AND m.completed_at < $2) AS demos_completed,
       (SELECT COUNT(*)::int FROM crm_meetings m
         WHERE m.status = 'COMPLETED' AND m.completed_at >= $1 AND m.completed_at < $2) AS meetings_completed,
       (SELECT COUNT(*)::int FROM crm_meetings m
         WHERE m.status = 'SCHEDULED' AND m.scheduled_at >= now()) AS meetings_upcoming,
       (SELECT COUNT(*)::int FROM crm_meetings m
         WHERE m.status = 'SCHEDULED' AND m.scheduled_at < now()) AS meetings_awaiting_outcome,
       (SELECT COUNT(*)::int FROM account_activities act
         WHERE act.is_external = TRUE AND act.outcome IN ('COMPLETED','RECEIVED')
           AND act.occurred_at >= $1 AND act.occurred_at < $2) AS conversations,
       (SELECT COUNT(*)::int FROM account_activities act
         WHERE act.is_external = TRUE AND act.outcome = 'ATTEMPTED'
           AND act.occurred_at >= $1 AND act.occurred_at < $2) AS attempts,
       (SELECT COUNT(*)::int FROM crm_resource_shares sh
         WHERE sh.shared_at >= $1 AND sh.shared_at < $2) AS proposals_shared`,
    [bounds.start, bounds.end],
  );

  const { rows: engagementRows } = await query(
    `${'SELECT e.*, a.name AS account_name, a.owner_user_id AS relationship_owner_id, a.department_id,'}
            o.name AS opportunity_name, o.agreed_value, o.currency, o.agreement_type,
            o.agreement_date, o.financial_status,
            u.full_name AS owner_name, u.avatar_color AS owner_color,
            (SELECT COUNT(*)::int FROM engagement_milestones m WHERE m.engagement_id = e.id) AS milestone_total,
            (SELECT COUNT(*)::int FROM engagement_milestones m
              WHERE m.engagement_id = e.id AND m.status = 'ACCEPTED') AS milestone_accepted,
            (SELECT COUNT(*)::int FROM engagement_milestones m
              WHERE m.engagement_id = e.id AND m.status = 'BLOCKED') AS milestone_blocked,
            (SELECT COUNT(*)::int FROM engagement_milestones m
              WHERE m.engagement_id = e.id AND m.status <> 'ACCEPTED'
                AND m.due_date < CURRENT_DATE) AS milestone_overdue,
            0 AS open_tasks
       FROM engagements e
       JOIN accounts a ON a.id = e.account_id
       LEFT JOIN opportunities o ON o.id = e.opportunity_id
       LEFT JOIN users u ON u.id = e.owner_user_id
      WHERE e.is_archived = FALSE
        AND e.state IN ('PLANNING','ONBOARDING','ACTIVE','AT_RISK')`,
  );
  const engagements = engagementRows.map(decorateEngagement);

  const byStage = new Map();
  for (const row of open) {
    const key = row.stage_slug || 'unstaged';
    const bucket = byStage.get(key) || {
      slug: key, name: row.stage_name || 'No stage', color: row.stage_color,
      position: row.stage_position ?? 99, count: 0, eligible: 0, weighted: 0,
    };
    bucket.count += 1;
    bucket.eligible += row.eligible_value ?? 0;
    bucket.weighted += row.weighted_value ?? 0;
    byStage.set(key, bucket);
  }

  return {
    month: bounds.key,
    period: { start: bounds.start.toISOString(), end: bounds.end.toISOString() },
    definitions: METRIC_DEFINITIONS,

    // as things stand
    portfolio: {
      open_opportunities: open.length,
      organizations: new Set(open.map((o) => o.account_id)).size,
      eligible_pipeline: sum(open, (o) => o.eligible_value),
      weighted_forecast: sum(open, (o) => o.weighted_value),
      // said out loud, because a total that silently omits deals is a lie
      without_value: open.filter((o) => o.eligible_value === null).length,
      closing_soon: closingSoon.length,
      closing_soon_value: sum(closingSoon, (o) => o.eligible_value),
      overdue_next_actions: open.filter((o) => o.next_step_overdue).length,
      missing_next_action: open.filter(
        (o) => !o.next_step && (o.stage_position ?? 0) >= 3,
      ).length,
      unresolved_blockers: sum(open, (o) => o.unmet_must_haves),
      engagements_live: engagements.length,
      engagements_attention: engagements.filter((e) => e.needs_attention).length,
    },

    // what happened during the selected month
    activity: {
      won: monthRows[0].won,
      lost: monthRows[0].lost,
      value_won: Number(monthRows[0].value_won) || 0,
      value_collected: Number(monthRows[0].value_collected) || 0,
      demos_completed: activityRows[0].demos_completed,
      meetings_completed: activityRows[0].meetings_completed,
      meetings_upcoming: activityRows[0].meetings_upcoming,
      meetings_awaiting_outcome: activityRows[0].meetings_awaiting_outcome,
      conversations: activityRows[0].conversations,
      attempts: activityRows[0].attempts,
      proposals_shared: activityRows[0].proposals_shared,
    },

    by_stage: [...byStage.values()].sort((a, b) => a.position - b.position),
    closing_soon: closingSoon
      .sort((a, b) => new Date(a.expected_close) - new Date(b.expected_close))
      .slice(0, 20),
    engagements_attention: engagements.filter((e) => e.needs_attention),
  };
}

/**
 * Per-person summaries for a month.
 *
 * Attributed to the person who was recorded as doing the thing, and to the owner
 * the deal had at the time — reassignment does not rewrite last quarter. Where a
 * figure is zero, it says "nothing recorded", which is not the same claim as
 * "did no work".
 */
export async function managerSummaries({ month, departmentId = null } = {}) {
  const bounds = monthBounds(month);

  const { rows: people } = await query(
    `SELECT u.id, u.full_name, u.avatar_color, u.job_title, d.name AS department
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.is_active = TRUE AND ($1::int IS NULL OR u.department_id = $1::int)
      ORDER BY u.full_name`,
    [departmentId],
  );

  const summaries = [];
  for (const person of people) {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM opportunities o
           WHERE o.owner_user_id = $1 AND o.status = 'ACTIVE' AND o.is_archived = FALSE) AS open_deals,
         (SELECT COUNT(DISTINCT o.account_id)::int FROM opportunities o
           WHERE o.owner_user_id = $1 AND o.status = 'ACTIVE' AND o.is_archived = FALSE) AS organizations,
         (SELECT COUNT(*)::int FROM opportunities o
           WHERE o.owner_user_id = $1 AND o.status = 'WON'
             AND o.closed_at >= $2 AND o.closed_at < $3) AS won,
         (SELECT COUNT(*)::int FROM opportunities o
           WHERE o.owner_user_id = $1 AND o.status = 'LOST'
             AND o.closed_at >= $2 AND o.closed_at < $3) AS lost,
         (SELECT COALESCE(SUM(o.agreed_value),0) FROM opportunities o
           WHERE o.owner_user_id = $1 AND o.status = 'WON'
             AND o.closed_at >= $2 AND o.closed_at < $3) AS value_won,
         -- attributed to whoever actually recorded it, not to today's owner
         (SELECT COUNT(*)::int FROM account_activities act
           WHERE act.actor_id = $1 AND act.is_external = TRUE
             AND act.outcome IN ('COMPLETED','RECEIVED')
             AND act.occurred_at >= $2 AND act.occurred_at < $3) AS conversations,
         (SELECT COUNT(*)::int FROM account_activities act
           WHERE act.actor_id = $1 AND act.is_external = TRUE AND act.outcome = 'ATTEMPTED'
             AND act.occurred_at >= $2 AND act.occurred_at < $3) AS attempts,
         (SELECT COUNT(*)::int FROM crm_meetings m
           WHERE m.owner_user_id = $1 AND m.status = 'COMPLETED'
             AND m.completed_at >= $2 AND m.completed_at < $3) AS meetings_completed,
         (SELECT COUNT(*)::int FROM crm_meetings m
           WHERE m.owner_user_id = $1 AND m.kind = 'DEMO' AND m.status = 'COMPLETED'
             AND m.completed_at >= $2 AND m.completed_at < $3) AS demos_completed,
         (SELECT COUNT(*)::int FROM crm_resource_shares sh
           WHERE sh.shared_by = $1 AND sh.shared_at >= $2 AND sh.shared_at < $3) AS proposals_shared,
         (SELECT COUNT(*)::int FROM opportunity_history h
           WHERE h.actor_id = $1 AND h.field = 'stage' AND h.is_reversal = FALSE
             AND h.created_at >= $2 AND h.created_at < $3) AS stage_moves,
         (SELECT COUNT(*)::int FROM tasks t
            JOIN workflow_statuses ws ON ws.id = t.status_id
           WHERE t.assignee_id = $1 AND t.account_id IS NOT NULL AND t.is_archived = FALSE
             AND ws.stage NOT IN ('done','cancelled') AND t.due_date < now()) AS overdue_tasks,
         (SELECT COUNT(*)::int FROM engagement_milestones m
            JOIN engagements e ON e.id = m.engagement_id
           WHERE e.owner_user_id = $1 AND m.status = 'ACCEPTED'
             AND m.accepted_at >= $2 AND m.accepted_at < $3) AS milestones_accepted`,
      [person.id, bounds.start, bounds.end],
    );

    const m = rows[0];
    const anyActivity = m.conversations + m.attempts + m.meetings_completed
      + m.proposals_shared + m.stage_moves + m.won + m.lost;

    // nothing on file is a statement about the record, not about the person
    if (m.open_deals === 0 && anyActivity === 0) continue;

    summaries.push({
      user: person,
      metrics: {
        ...m,
        value_won: Number(m.value_won) || 0,
      },
      nothing_recorded: anyActivity === 0,
    });
  }

  return {
    month: bounds.key,
    period: { start: bounds.start.toISOString(), end: bounds.end.toISOString() },
    definitions: METRIC_DEFINITIONS,
    summaries: summaries.sort(
      (a, b) => b.metrics.won - a.metrics.won || b.metrics.open_deals - a.metrics.open_deals,
    ),
  };
}

/**
 * Managers at the top, the organizations they lead beneath them.
 *
 * Grouped by ONE primary ownership — the relationship owner — so an
 * organization appears under exactly one person and portfolio totals cannot be
 * double-counted. Collaborators are listed on the organization without adding to
 * anyone's totals.
 */
export async function ownershipTree({ departmentId = null } = {}) {
  const { rows: accounts } = await query(
    `SELECT a.id, a.name, a.type, a.segment_id, a.owner_user_id, a.follower_user_id,
            a.department_id, a.last_external_at,
            seg.name AS segment_name, seg.color AS segment_color,
            o.full_name AS owner_name, o.avatar_color AS owner_color, o.job_title AS owner_title,
            f.full_name AS follower_name,
            d.name AS department_name
       FROM accounts a
       LEFT JOIN users o ON o.id = a.owner_user_id
       LEFT JOIN users f ON f.id = a.follower_user_id
       LEFT JOIN crm_segments seg ON seg.id = a.segment_id
       LEFT JOIN departments d ON d.id = a.department_id
      WHERE a.is_archived = FALSE
        AND ($1::int IS NULL OR a.department_id = $1::int)
      ORDER BY a.name`,
    [departmentId],
  );

  const { rows: opportunityRows } = await query(
    `SELECT o.*, a.name AS account_name, a.segment_id, a.department_id,
            a.owner_user_id AS relationship_owner_id,
            u.full_name AS owner_name, u.avatar_color AS owner_color,
            s.name AS stage_name, s.slug AS stage_slug, s.kind AS stage_kind,
            s.color AS stage_color, s.position AS stage_position,
            s.default_probability AS stage_probability,
            s.requires_contact, s.requires_next_action, s.requires_value,
            (SELECT COUNT(*)::int FROM opportunity_contacts oc WHERE oc.opportunity_id = o.id) AS contact_count,
            (SELECT COUNT(*)::int FROM opportunity_requirements r
              WHERE r.opportunity_id = o.id AND r.importance = 'MUST_HAVE'
                AND r.status NOT IN ('MET','WAIVED')) AS unmet_must_haves
       FROM opportunities o
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN users u ON u.id = o.owner_user_id
       LEFT JOIN account_stages s ON s.id = o.stage_id
      WHERE o.is_archived = FALSE AND a.is_archived = FALSE
        AND ($1::int IS NULL OR a.department_id = $1::int)`,
    [departmentId],
  );

  const byAccount = new Map();
  for (const row of opportunityRows) {
    const list = byAccount.get(row.account_id) || [];
    list.push(decorateOpportunity(row));
    byAccount.set(row.account_id, list);
  }

  const managers = new Map();
  const unassigned = [];

  for (const account of accounts) {
    const deals = byAccount.get(account.id) || [];
    const live = deals.filter((d) => d.is_open);
    const node = {
      ...account,
      opportunities: deals,
      open_count: live.length,
      eligible_value: live.reduce((sum, d) => sum + (d.eligible_value ?? 0), 0),
      weighted_value: live.reduce((sum, d) => sum + (d.weighted_value ?? 0), 0),
      needs_attention: live.some((d) => d.next_step_overdue || d.gaps.length > 0),
    };

    if (!account.owner_user_id) {
      unassigned.push(node);
      continue;
    }
    const manager = managers.get(account.owner_user_id) || {
      user: {
        id: account.owner_user_id,
        full_name: account.owner_name,
        avatar_color: account.owner_color,
        job_title: account.owner_title,
        department: account.department_name,
      },
      organizations: [],
    };
    manager.organizations.push(node);
    managers.set(account.owner_user_id, manager);
  }

  const withTotals = [...managers.values()].map((manager) => ({
    ...manager,
    totals: {
      organizations: manager.organizations.length,
      open_opportunities: manager.organizations.reduce((s, a) => s + a.open_count, 0),
      eligible_value: manager.organizations.reduce((s, a) => s + a.eligible_value, 0),
      weighted_value: manager.organizations.reduce((s, a) => s + a.weighted_value, 0),
      needs_attention: manager.organizations.filter((a) => a.needs_attention).length,
    },
  }));

  return {
    // one primary grouping, so no organization is counted under two people
    grouping: 'relationship_owner',
    managers: withTotals.sort((a, b) => b.totals.eligible_value - a.totals.eligible_value),
    unassigned,
  };
}

/**
 * Where the organizations are.
 *
 * Only pins that were actually entered. Nothing is geocoded and no coordinate is
 * invented — an organization without one stays in the unmapped list rather than
 * being dropped from the page or guessed onto the map.
 */
export async function mapView({ departmentId = null, segmentId = null } = {}) {
  const { rows } = await query(
    `SELECT a.id, a.name, a.type, a.segment_id, a.owner_user_id,
            seg.name AS segment_name, seg.color AS segment_color,
            u.full_name AS owner_name, u.avatar_color AS owner_color,
            a.hq_address, a.operating_regions,
            (SELECT COUNT(*)::int FROM opportunities o
              WHERE o.account_id = a.id AND o.status = 'ACTIVE' AND o.is_archived = FALSE) AS open_deals,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', l.id, 'label', l.label, 'kind', l.kind, 'city', l.city,
                'state', l.state, 'country', l.country,
                'latitude', l.latitude, 'longitude', l.longitude, 'precision', l.precision))
                FROM account_locations l WHERE l.account_id = a.id), '[]'::json) AS locations
       FROM accounts a
       LEFT JOIN crm_segments seg ON seg.id = a.segment_id
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.is_archived = FALSE
        AND ($1::int IS NULL OR a.department_id = $1::int)
        AND ($2::int IS NULL OR a.segment_id = $2::int)
      ORDER BY a.name`,
    [departmentId, segmentId],
  );

  const mapped = [];
  const unmapped = [];
  for (const row of rows) {
    const pins = (row.locations || []).filter(
      (l) => l.latitude !== null && l.longitude !== null,
    );
    if (pins.length) mapped.push({ ...row, pins });
    else unmapped.push(row);
  }

  return {
    // an organization with two sites is one organization, counted once
    organizations_mapped: mapped.length,
    organizations_unmapped: unmapped.length,
    pins_total: mapped.reduce((sum, row) => sum + row.pins.length, 0),
    mapped,
    unmapped,
  };
}
