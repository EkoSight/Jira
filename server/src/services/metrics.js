import { query } from '../db/pool.js';
import { getSettings } from './settings.js';

const scopeClause = (scope, params) => {
  const where = ['t.is_archived = FALSE'];
  if (scope?.departmentId) {
    params.push(scope.departmentId);
    where.push(`t.department_id = $${params.length}`);
  }
  if (scope?.assigneeId) {
    params.push(scope.assigneeId);
    where.push(`t.assignee_id = $${params.length}`);
  }
  return where.join(' AND ');
};

/** Headline counters for the dashboard tiles. */
export async function taskSummary(scope = {}) {
  const settings = await getSettings();
  const params = [settings.workload.dueSoonDays];
  const where = scopeClause(scope, params);

  const { rows } = await query(
    `SELECT
       COUNT(*)::int                                                                  AS total,
       COUNT(*) FILTER (WHERE s.stage IN ('backlog','todo'))::int                     AS open,
       COUNT(*) FILTER (WHERE s.stage = 'in_progress')::int                           AS in_progress,
       COUNT(*) FILTER (WHERE s.stage = 'blocked')::int                               AS blocked,
       COUNT(*) FILTER (WHERE s.stage = 'review')::int                                AS in_review,
       COUNT(*) FILTER (WHERE s.stage = 'done')::int                                  AS done,
       COUNT(*) FILTER (WHERE s.stage NOT IN ('done','cancelled'))::int               AS pending,
       COUNT(*) FILTER (WHERE t.priority = 'critical' AND s.stage NOT IN ('done','cancelled'))::int AS critical,
       COUNT(*) FILTER (WHERE t.due_date < now() AND s.stage NOT IN ('done','cancelled'))::int      AS overdue,
       COUNT(*) FILTER (
         WHERE t.due_date >= now()
           AND t.due_date < now() + ($1 || ' days')::interval
           AND s.stage NOT IN ('done','cancelled')
       )::int                                                                          AS due_soon,
       COUNT(*) FILTER (WHERE t.assignee_id IS NULL AND s.stage NOT IN ('done','cancelled'))::int   AS unassigned,
       COUNT(*) FILTER (WHERE s.stage = 'done' AND t.completed_at >= date_trunc('month', now()))::int AS completed_this_month,
       COUNT(*) FILTER (WHERE s.stage = 'done' AND t.completed_at >= now() - interval '7 days')::int  AS completed_this_week
     FROM tasks t
     JOIN workflow_statuses s ON s.id = t.status_id
     WHERE ${where}`,
    params,
  );

  return rows[0];
}

export async function breakdowns(scope = {}) {
  const params = [];
  const where = scopeClause(scope, params);

  const [byStatus, byDepartment, byPriority, byType] = await Promise.all([
    query(
      `SELECT s.id, s.name, s.slug, s.stage, s.color, s.position, COUNT(t.id)::int AS count
         FROM workflow_statuses s
         LEFT JOIN tasks t ON t.status_id = s.id AND ${where}
        WHERE s.is_active = TRUE
        GROUP BY s.id
        ORDER BY s.position`,
      params,
    ),
    query(
      `SELECT d.id, d.name, d.key, d.color,
              COUNT(t.id)::int                                                      AS total,
              COUNT(t.id) FILTER (WHERE s.stage NOT IN ('done','cancelled'))::int    AS pending,
              COUNT(t.id) FILTER (WHERE t.due_date < now() AND s.stage NOT IN ('done','cancelled'))::int AS overdue,
              COUNT(t.id) FILTER (WHERE s.stage = 'done')::int                       AS done
         FROM departments d
         LEFT JOIN tasks t ON t.department_id = d.id AND ${where}
         LEFT JOIN workflow_statuses s ON s.id = t.status_id
        WHERE d.is_active = TRUE
        GROUP BY d.id
        ORDER BY d.position, d.name`,
      params,
    ),
    query(
      `SELECT t.priority, COUNT(*)::int AS count
         FROM tasks t
         JOIN workflow_statuses s ON s.id = t.status_id
        WHERE ${where} AND s.stage NOT IN ('done','cancelled')
        GROUP BY t.priority`,
      params,
    ),
    query(
      `SELECT t.task_type, COUNT(*)::int AS count
         FROM tasks t
         JOIN workflow_statuses s ON s.id = t.status_id
        WHERE ${where} AND s.stage NOT IN ('done','cancelled')
        GROUP BY t.task_type
        ORDER BY count DESC`,
      params,
    ),
  ]);

  return {
    byStatus: byStatus.rows,
    byDepartment: byDepartment.rows,
    byPriority: byPriority.rows,
    byType: byType.rows,
  };
}

/**
 * Who is working on what, how loaded they are, and who is sitting idle.
 * This is the "system remembers so you do not have to" view.
 */
export async function workload(scope = {}) {
  const settings = await getSettings();
  const params = [];
  const filters = ['u.is_active = TRUE'];
  if (scope.departmentId) {
    params.push(scope.departmentId);
    filters.push(`u.department_id = $${params.length}`);
  }

  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.role, u.avatar_color, u.job_title,
            u.weekly_capacity_hours, u.max_concurrent_tasks,
            d.name AS department, d.color AS department_color,
            u.last_activity_at,
            COUNT(t.id) FILTER (WHERE s.stage NOT IN ('done','cancelled'))::int             AS open_tasks,
            COUNT(t.id) FILTER (WHERE s.stage = 'in_progress')::int                          AS active_tasks,
            COUNT(t.id) FILTER (WHERE s.stage = 'blocked')::int                              AS blocked_tasks,
            COUNT(t.id) FILTER (
              WHERE t.due_date < now() AND s.stage NOT IN ('done','cancelled')
            )::int                                                                           AS overdue_tasks,
            COUNT(t.id) FILTER (
              WHERE t.priority = 'critical' AND s.stage NOT IN ('done','cancelled')
            )::int                                                                           AS critical_tasks,
            COUNT(t.id) FILTER (
              WHERE s.stage = 'done' AND t.completed_at >= now() - interval '30 days'
            )::int                                                                           AS completed_30d,
            COALESCE(SUM(t.estimate_hours) FILTER (WHERE s.stage NOT IN ('done','cancelled')), 0) AS committed_hours,
            MAX(t.updated_at)                                                                AS last_task_update,
            -- NULL (rather than a huge number) when the member has never done anything yet
            CASE
              WHEN u.last_activity_at IS NULL AND MAX(t.updated_at) IS NULL THEN NULL
              ELSE EXTRACT(DAY FROM now() - GREATEST(
                COALESCE(u.last_activity_at, MAX(t.updated_at)),
                COALESCE(MAX(t.updated_at), u.last_activity_at)
              ))::int
            END                                                                              AS days_since_activity
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN tasks t ON t.assignee_id = u.id AND t.is_archived = FALSE
       LEFT JOIN workflow_statuses s ON s.id = t.status_id
      WHERE ${filters.join(' AND ')}
      GROUP BY u.id, d.name, d.color
      ORDER BY open_tasks DESC, u.full_name`,
    params,
  );

  const idleDays = settings.workload.idleDays;
  const overloadedPct = settings.workload.overloadedPercent;

  return rows.map((r) => {
    const capacityHours = Number(r.weekly_capacity_hours) || 0;
    const committed = Number(r.committed_hours) || 0;
    const hoursLoad = capacityHours > 0 ? Math.round((committed / capacityHours) * 100) : null;
    const countLoad = r.max_concurrent_tasks > 0
      ? Math.round((r.open_tasks / r.max_concurrent_tasks) * 100)
      : null;

    // Load is measured in hours only when the open work actually has estimates;
    // otherwise it is measured in task count. Whichever drives the status is also
    // what the client shows, so the meter and its caption never disagree (no more
    // "0h of 40h" sitting next to "Busy").
    const useHours = committed > 0 && hoursLoad !== null;
    const loadPercent = useHours ? hoursLoad : countLoad;
    const loadBasis = useHours ? 'hours' : 'tasks';

    let status = 'available';
    if (r.open_tasks === 0) status = 'idle';
    else if (loadPercent !== null && loadPercent >= overloadedPct) status = 'overloaded';
    else if (loadPercent !== null && loadPercent >= 70) status = 'busy';
    if (r.open_tasks > 0 && r.days_since_activity !== null && r.days_since_activity >= idleDays) {
      status = 'stalled';
    }

    return {
      ...r,
      committed_hours: committed,
      load_percent: loadPercent,
      load_basis: loadBasis,
      capacity_hours: capacityHours,
      status,
    };
  });
}

/** Created vs completed for the last N days — feeds the trend chart. */
export async function throughput({ days = 14, ...scope } = {}) {
  const params = [days];
  const where = scopeClause(scope, params);

  const { rows } = await query(
    `WITH span AS (
       SELECT generate_series(
         date_trunc('day', now()) - (($1::int - 1) || ' days')::interval,
         date_trunc('day', now()),
         interval '1 day'
       ) AS day
     )
     SELECT to_char(span.day, 'YYYY-MM-DD') AS day,
            (SELECT COUNT(*)::int FROM tasks t
              WHERE date_trunc('day', t.created_at) = span.day AND ${where})   AS created,
            (SELECT COUNT(*)::int FROM tasks t
              WHERE date_trunc('day', t.completed_at) = span.day AND ${where}) AS completed
       FROM span
      ORDER BY span.day`,
    params,
  );
  return rows;
}

export async function upcomingDeadlines({ days = 7, limit = 25, ...scope } = {}) {
  const params = [days, limit];
  const where = scopeClause(scope, params);

  const { rows } = await query(
    `SELECT t.id, t.ref, t.title, t.priority, t.due_date, t.progress,
            s.name AS status, s.stage, s.color AS status_color,
            d.name AS department, d.color AS department_color,
            u.full_name AS assignee, u.avatar_color,
            (t.due_date < now()) AS is_overdue
       FROM tasks t
       JOIN workflow_statuses s ON s.id = t.status_id
       JOIN departments d ON d.id = t.department_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${where}
        AND s.stage NOT IN ('done','cancelled')
        AND t.due_date IS NOT NULL
        AND t.due_date < now() + ($1 || ' days')::interval
      ORDER BY t.due_date ASC
      LIMIT $2`,
    params,
  );
  return rows;
}

export async function recentActivity({ limit = 20, ...scope } = {}) {
  const params = [limit];
  const filters = [];
  if (scope.departmentId) {
    params.push(scope.departmentId);
    filters.push(`t.department_id = $${params.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT a.id, a.action, a.field, a.from_value, a.to_value, a.created_at,
            t.id AS task_id, t.ref, t.title,
            u.full_name AS actor, u.avatar_color
       FROM task_activity a
       JOIN tasks t ON t.id = a.task_id
       LEFT JOIN users u ON u.id = a.actor_id
       ${where}
      ORDER BY a.created_at DESC
      LIMIT $1`,
    params,
  );
  return rows;
}
