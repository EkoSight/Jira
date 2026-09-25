/**
 * Delivery, after the deal is won.
 *
 * A win is not the end of the relationship — it is the point at which the
 * promise has to be kept. An engagement carries the agreed scope, the
 * milestones, who is delivering and when it is reviewed, and it runs on its own
 * states: work can be AT_RISK while the opportunity stays WON, because a signed
 * agreement says nothing about whether implementation is going well.
 *
 * The commercial value is NOT copied here. One agreed amount, recorded once, on
 * the opportunity — otherwise a won deal and its delivery both report the same
 * money and the total is wrong.
 */

import { query } from '../db/pool.js';
import { hasPermission } from '../lib/permissions.js';
import { nextTaskRef } from '../lib/taskRef.js';
import { logActivity } from './crm.js';

export const ENGAGEMENT_STATES = ['PLANNING', 'ONBOARDING', 'ACTIVE', 'AT_RISK', 'COMPLETED', 'ON_HOLD'];
export const MILESTONE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'DELIVERED', 'ACCEPTED', 'BLOCKED'];

/** The states that mean delivery is still somebody's problem today. */
const LIVE_STATES = new Set(['PLANNING', 'ONBOARDING', 'ACTIVE', 'AT_RISK']);

export const ENGAGEMENT_SELECT = `
  SELECT e.*,
         a.name AS account_name, a.owner_user_id AS relationship_owner_id,
         a.department_id,
         o.name AS opportunity_name, o.agreed_value, o.currency, o.agreement_type,
         o.agreement_date, o.financial_status,
         u.full_name AS owner_name, u.avatar_color AS owner_color,
         (SELECT COUNT(*)::int FROM engagement_milestones m WHERE m.engagement_id = e.id) AS milestone_total,
         (SELECT COUNT(*)::int FROM engagement_milestones m
           WHERE m.engagement_id = e.id AND m.status = 'ACCEPTED') AS milestone_accepted,
         (SELECT COUNT(*)::int FROM engagement_milestones m
           WHERE m.engagement_id = e.id AND m.status = 'BLOCKED') AS milestone_blocked,
         (SELECT COUNT(*)::int FROM engagement_milestones m
           WHERE m.engagement_id = e.id AND m.status NOT IN ('ACCEPTED')
             AND m.due_date < CURRENT_DATE) AS milestone_overdue,
         (SELECT COUNT(*)::int FROM tasks t
            JOIN workflow_statuses ws ON ws.id = t.status_id
           WHERE t.engagement_id = e.id AND t.is_archived = FALSE
             AND ws.stage NOT IN ('done','cancelled')) AS open_tasks
    FROM engagements e
    JOIN accounts a ON a.id = e.account_id
    LEFT JOIN opportunities o ON o.id = e.opportunity_id
    LEFT JOIN users u ON u.id = e.owner_user_id
`;

export function decorateEngagement(row) {
  const today = Date.now();
  return {
    ...row,
    // the deal's money is shown here, never re-recorded: this is a reference to
    // the one agreed amount, not a second copy of it
    agreed_value: row.agreed_value === null || row.agreed_value === undefined
      ? null : Number(row.agreed_value),
    is_live: LIVE_STATES.has(row.state),
    review_overdue: row.next_review_on
      ? new Date(row.next_review_on).getTime() < today && LIVE_STATES.has(row.state)
      : false,
    needs_attention: row.state === 'AT_RISK'
      || row.milestone_blocked > 0
      || row.milestone_overdue > 0,
  };
}

export const canEditEngagement = (user, row) =>
  hasPermission(user, 'crm.manage.any')
  || row.owner_user_id === user.id
  || row.relationship_owner_id === user.id
  || row.created_by === user.id;

export async function listEngagements(filters = {}) {
  const params = [];
  const where = ['e.is_archived = FALSE'];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.accountId) where.push(`e.account_id = ${push(Number(filters.accountId))}`);
  if (filters.ownerId) where.push(`e.owner_user_id = ${push(Number(filters.ownerId))}`);
  if (filters.state) where.push(`e.state = ${push(filters.state)}`);
  if (filters.liveOnly) where.push(`e.state IN ('PLANNING','ONBOARDING','ACTIVE','AT_RISK')`);

  const { rows } = await query(
    `${ENGAGEMENT_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY e.next_review_on NULLS LAST, e.id DESC LIMIT 300`,
    params,
  );
  return rows.map(decorateEngagement);
}

export async function getEngagement(id) {
  const { rows } = await query(`${ENGAGEMENT_SELECT} WHERE e.id = $1`, [id]);
  return rows[0] ? decorateEngagement(rows[0]) : null;
}

export async function listMilestones(engagementId) {
  const { rows } = await query(
    `SELECT m.*, t.ref AS task_ref, t.title AS task_title, ws.stage AS task_stage,
            u.full_name AS accepted_by_name
       FROM engagement_milestones m
       LEFT JOIN tasks t ON t.id = m.task_id
       LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
       LEFT JOIN users u ON u.id = m.accepted_by
      WHERE m.engagement_id = $1
      ORDER BY m.position, m.due_date NULLS LAST, m.id`,
    [engagementId],
  );
  return rows;
}

/**
 * Creates the engagement for a won deal, or hands back the one already there.
 *
 * Idempotent by a unique index on opportunity_id, so pressing the button twice,
 * a retry, or winning the same deal again all land on the same engagement rather
 * than splitting delivery in two.
 */
export async function createOrLinkEngagement(client, { opportunity, actor, name, ownerUserId, kickoffOn }) {
  const { rows: existing } = await client.query(
    'SELECT id FROM engagements WHERE opportunity_id = $1', [opportunity.id],
  );
  if (existing[0]) return { engagement_id: existing[0].id, created: false };

  // what the deal already established, carried over rather than retyped. The
  // value is deliberately not among these.
  const carried = {
    accepted_scope: opportunity.scope_summary || null,
    win_criteria: opportunity.win_criteria || null,
    agreement_type: opportunity.agreement_type || null,
    agreement_date: opportunity.agreement_date || null,
    agreement_link: opportunity.agreement_link || null,
  };

  const { rows } = await client.query(
    `INSERT INTO engagements
       (account_id, opportunity_id, name, state, agreed_scope, owner_user_id,
        kickoff_on, carried_from_opportunity, created_by)
     VALUES ($1,$2,$3,'PLANNING',$4,$5,$6::date,$7::jsonb,$8)
     RETURNING id`,
    [
      opportunity.account_id,
      opportunity.id,
      name || `${opportunity.name} — delivery`,
      opportunity.scope_summary || null,
      ownerUserId ?? opportunity.owner_user_id ?? actor.id,
      kickoffOn ?? null,
      JSON.stringify(carried),
      actor.id,
    ],
  );

  // the contacts who got the deal signed are the ones delivery has to work with
  await client.query(
    `INSERT INTO opportunity_contacts (opportunity_id, contact_id, role)
     SELECT $1, contact_id, role FROM opportunity_contacts WHERE opportunity_id = $1
     ON CONFLICT DO NOTHING`,
    [opportunity.id],
  );

  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    engagementId: rows[0].id,
    type: 'NOTE',
    actorId: actor.id,
    subject: `Delivery started: ${name || opportunity.name}`,
  });

  return { engagement_id: rows[0].id, created: true };
}

const KICKOFF_TEMPLATE = [
  'Hold the kickoff call and agree the plan',
  'Confirm the delivery contacts on both sides',
  'Agree the reporting cadence and first review date',
];

/** The work delivery starts with, created once through the ordinary task engine. */
export async function createKickoffTasks(client, engagement, actor) {
  if (engagement.kickoff_tasks_created) return [];

  const { rows: statusRows } = await client.query(
    `SELECT id FROM workflow_statuses WHERE is_active = TRUE
      ORDER BY is_default DESC, position ASC LIMIT 1`,
  );
  const { rows: accountRows } = await client.query(
    'SELECT department_id FROM accounts WHERE id = $1', [engagement.account_id],
  );
  const departmentId = accountRows[0]?.department_id ?? actor.department_id;
  if (!statusRows[0] || !departmentId) return [];

  const base = engagement.kickoff_on
    ? new Date(engagement.kickoff_on).getTime()
    : Date.now() + 7 * 86_400_000;

  const created = [];
  for (const [index, title] of KICKOFF_TEMPLATE.entries()) {
    const due = new Date(Math.max(base + index * 86_400_000, Date.now() + 3_600_000));
    const ref = await nextTaskRef(client, departmentId);
    const { rows } = await client.query(
      `INSERT INTO tasks
         (ref, title, department_id, status_id, priority, assignee_id, reporter_id, created_by,
          due_date, original_due_date, account_id, opportunity_id, engagement_id, position)
       VALUES ($1,$2,$3,$4,'medium',$5,$6,$6,$7,$7,$8,$9,$10,
               (SELECT COALESCE(MAX(position),0)+100 FROM tasks WHERE status_id = $4))
       RETURNING *`,
      [
        ref, `${title} — ${engagement.name}`, departmentId, statusRows[0].id,
        engagement.owner_user_id ?? actor.id, actor.id, due,
        engagement.account_id, engagement.opportunity_id ?? null, engagement.id,
      ],
    );
    created.push(rows[0]);
  }

  await client.query(
    'UPDATE engagements SET kickoff_tasks_created = TRUE WHERE id = $1', [engagement.id],
  );
  return created;
}
