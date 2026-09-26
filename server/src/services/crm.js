import { query } from '../db/pool.js';
import { hasPermission } from '../lib/permissions.js';

/**
 * The CRM engine: leads, the pipeline they move through, and the activities that
 * move them. Progress is not stored — "how long since this moved" and "how long
 * since anyone touched it" are derived from stage_changed_at and last_activity_at,
 * so they can never be stale.
 */

const DAY = 86_400_000;

export const ACCOUNT_SELECT = `
  SELECT a.*,
         o.full_name AS owner_name, o.avatar_color AS owner_color,
         f.full_name AS follower_name, f.avatar_color AS follower_color,
         st.name AS stage_name, st.slug AS stage_slug, st.kind AS stage_kind,
         st.color AS stage_color, st.position AS stage_position,
         d.name AS department_name, d.color AS department_color,
         seg.name AS segment_name, seg.slug AS segment_slug, seg.color AS segment_color,
         seg.scope_template AS segment_scope_template,
         -- when an image was uploaded rather than linked; the URL columns stay
         -- exactly as they were, so a lead can have either
         (SELECT i.created_at FROM account_images i
           WHERE i.account_id = a.id AND i.kind = 'LOGO') AS logo_uploaded_at,
         (SELECT i.created_at FROM account_images i
           WHERE i.account_id = a.id AND i.kind = 'BANNER') AS banner_uploaded_at,
         (SELECT COUNT(*)::int FROM account_activities x WHERE x.account_id = a.id) AS activity_count,
         (SELECT COUNT(*)::int FROM tasks t
            WHERE t.account_id = a.id AND t.is_archived = FALSE) AS task_count,
         (SELECT COUNT(*)::int FROM tasks t
            JOIN workflow_statuses ws ON ws.id = t.status_id
           WHERE t.account_id = a.id AND t.is_archived = FALSE
             AND ws.stage NOT IN ('done', 'cancelled')) AS open_task_count,
         (SELECT COUNT(*)::int FROM objectives ob
           WHERE ob.account_id = a.id AND ob.is_archived = FALSE) AS goal_count
    FROM accounts a
    LEFT JOIN users o ON o.id = a.owner_user_id
    LEFT JOIN users f ON f.id = a.follower_user_id
    LEFT JOIN account_stages st ON st.id = a.stage_id
    LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN crm_segments seg ON seg.id = a.segment_id
`;

const daysSince = (value, now = Date.now()) =>
  value ? Math.floor((now - new Date(value).getTime()) / DAY) : null;

/** Adds the derived momentum facts a raw account row needs. */
export function decorateAccount(row, now = Date.now()) {
  return {
    ...row,
    is_open: row.stage_kind === 'open' && row.status === 'ACTIVE',
    days_since_activity: daysSince(row.last_activity_at, now),
    days_since_stage_change: daysSince(row.stage_changed_at, now),
    next_step_overdue: row.next_step_due ? new Date(row.next_step_due).getTime() < now : false,
    // where the UI should actually fetch the image from: an upload wins over a
    // pasted link, and the timestamp busts the cache when it is replaced
    logo_src: row.logo_uploaded_at
      ? `/accounts/${row.id}/image/logo?v=${new Date(row.logo_uploaded_at).getTime()}`
      : row.logo_url || null,
    banner_src: row.banner_uploaded_at
      ? `/accounts/${row.id}/image/banner?v=${new Date(row.banner_uploaded_at).getTime()}`
      : row.banner_url || null,
  };
}

/** Whoever leads or follows an account can work it; crm.manage.any covers all. */
export const canEditAccount = (user, account) =>
  hasPermission(user, 'crm.manage.any')
  || account.owner_user_id === user.id
  || account.follower_user_id === user.id
  || account.created_by === user.id;

// ---------------------------------------------------------------- stages

export async function listStages({ activeOnly = true } = {}) {
  const { rows } = await query(
    `SELECT s.*, (SELECT COUNT(*)::int FROM accounts a
                   WHERE a.stage_id = s.id AND a.is_archived = FALSE) AS account_count
       FROM account_stages s
      ${activeOnly ? 'WHERE s.is_active = TRUE' : ''}
      ORDER BY s.position, s.id`,
  );
  return rows;
}

// ---------------------------------------------------------------- accounts

export async function listAccounts(filters = {}) {
  const params = [];
  const where = ['a.is_archived = FALSE'];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.type) where.push(`a.type = ${push(filters.type)}`);
  if (filters.stageId) where.push(`a.stage_id = ${push(Number(filters.stageId))}`);
  if (filters.ownerId) where.push(`a.owner_user_id = ${push(Number(filters.ownerId))}`);
  if (filters.departmentId) where.push(`a.department_id = ${push(Number(filters.departmentId))}`);
  if (filters.status) where.push(`a.status = ${push(filters.status)}`);
  if (filters.involving) {
    const uid = push(Number(filters.involving));
    where.push(`(a.owner_user_id = ${uid} OR a.follower_user_id = ${uid})`);
  }
  if (filters.search) {
    const term = push(`%${filters.search}%`);
    where.push(`(a.name ILIKE ${term} OR a.contact_name ILIKE ${term})`);
  }
  // "none" asks for the leads nobody has placed yet, which is its own answer
  if (filters.state === 'none') where.push(`NULLIF(TRIM(a.state), '') IS NULL`);
  else if (filters.state) where.push(`LOWER(TRIM(a.state)) = LOWER(TRIM(${push(filters.state)}))`);

  const limit = Math.min(Number(filters.limit) || 500, 1000);
  const { rows } = await query(
    `${ACCOUNT_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY a.stage_changed_at DESC, a.id DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => decorateAccount(row));
}

export async function getAccount(id) {
  const { rows } = await query(`${ACCOUNT_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? decorateAccount(rows[0]) : null;
}

/** The board: open accounts grouped by the stage they sit in. */
export async function pipeline(filters = {}) {
  const [stages, accounts] = await Promise.all([
    listStages(),
    listAccounts({ ...filters }),
  ]);

  const byStage = new Map(stages.map((s) => [s.id, []]));
  for (const account of accounts) {
    if (byStage.has(account.stage_id)) byStage.get(account.stage_id).push(account);
  }

  return {
    stages: stages.map((stage) => ({
      ...stage,
      accounts: byStage.get(stage.id) || [],
      value: (byStage.get(stage.id) || []).reduce((sum, a) => sum + (Number(a.value) || 0), 0),
    })),
    total: accounts.length,
  };
}

// ---------------------------------------------------------------- activities

/**
 * Records one touch on a deal and keeps the account's "last worked" clock fresh.
 * System events (stage changes, conversions) come through here too, so the
 * timeline is the single record of everything that happened.
 */
/**
 * Which kinds of touch actually count as having engaged the partner.
 *
 * A stage change, an internal note or a new opportunity is bookkeeping. Only a
 * real exchange with a real person resets the follow-up clock — otherwise
 * tidying up a record looks like working the relationship.
 */
const EXTERNAL_TYPES = new Set(['EMAIL', 'CALL', 'PPT', 'PROPOSAL', 'MEETING', 'DEMO', 'IN_PERSON']);

/**
 * What a touch of each kind means by default, when the caller does not say.
 * Sending is not the same as being answered, and neither is the same as a
 * conversation that actually happened.
 */
const DEFAULT_OUTCOME = {
  EMAIL: 'SENT', PPT: 'SENT', PROPOSAL: 'SENT',
  CALL: 'COMPLETED', MEETING: 'COMPLETED', DEMO: 'COMPLETED', IN_PERSON: 'COMPLETED',
};

export async function logActivity(client, {
  accountId, type, actorId, subject = null, body = null, nextStep = null,
  taskId = null, occurredAt = null, meta = {},
  opportunityId = null, engagementId = null, meetingId = null, contactId = null,
  channel = null, direction = null, outcome = null, externalParticipants = null,
  isExternal = null,
}) {
  const runner = client || { query };

  // "did we actually engage them" is decided by what happened, not by who typed it
  const external = isExternal === null ? EXTERNAL_TYPES.has(type) : isExternal;
  const resolvedOutcome = outcome ?? DEFAULT_OUTCOME[type] ?? 'NOTED';
  // an attempt that did not connect is not engagement, whatever its type
  const countsAsEngagement = external && !['ATTEMPTED', 'CANCELLED', 'NO_SHOW', 'SCHEDULED'].includes(resolvedOutcome);

  const { rows } = await runner.query(
    `INSERT INTO account_activities
       (account_id, type, actor_id, subject, body, next_step, task_id, occurred_at, meta,
        opportunity_id, engagement_id, meeting_id, contact_id, channel, direction,
        outcome, external_participants, is_external)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, now()),$9,
             $10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      accountId, type, actorId, subject, body, nextStep, taskId, occurredAt, meta,
      opportunityId, engagementId, meetingId, contactId, channel, direction,
      resolvedOutcome, externalParticipants, external,
    ],
  );

  // the account is only as "worked" as its most recent real touch
  await runner.query(
    `UPDATE accounts
        SET last_activity_at = GREATEST(COALESCE(last_activity_at, to_timestamp(0)), $2),
            last_external_at = CASE WHEN $4 THEN
              GREATEST(COALESCE(last_external_at, to_timestamp(0)), $2) ELSE last_external_at END,
            next_step = COALESCE($3, next_step),
            updated_at = now()
      WHERE id = $1`,
    [accountId, rows[0].occurred_at, nextStep, countsAsEngagement],
  );

  // and so is the deal it was about
  if (opportunityId && countsAsEngagement) {
    await runner.query(
      `UPDATE opportunities
          SET last_external_at = GREATEST(COALESCE(last_external_at, to_timestamp(0)), $2),
              updated_at = now()
        WHERE id = $1`,
      [opportunityId, rows[0].occurred_at],
    );
  }

  return rows[0];
}

export async function listActivities(accountId) {
  const { rows } = await query(
    `SELECT act.*, u.full_name AS actor_name, u.avatar_color AS actor_color,
            t.ref AS task_ref, t.title AS task_title,
            ts.stage AS task_stage
       FROM account_activities act
       LEFT JOIN users u ON u.id = act.actor_id
       LEFT JOIN tasks t ON t.id = act.task_id
       LEFT JOIN workflow_statuses ts ON ts.id = t.status_id
      WHERE act.account_id = $1
      ORDER BY act.occurred_at DESC, act.id DESC
      LIMIT 200`,
    [accountId],
  );
  return rows;
}
