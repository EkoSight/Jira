import { query } from '../db/pool.js';

/**
 * Monthly performance scoring.
 *
 * The score rewards finishing real work on time and is reduced by black marks,
 * so it cannot be gamed by closing a pile of trivial cards late. Weights are
 * deliberately simple enough to explain to the person being measured:
 *
 *   each completed task      1 point
 *     high priority         +0.5
 *     critical priority     +1
 *     finished on time      +0.5
 *     finished late         -0.5
 *   each active black mark  -1 per point
 *   each kudos received     +0.25 (capped at 2)
 */
export const WEIGHTS = {
  base: 1,
  high: 0.5,
  critical: 1,
  onTime: 0.5,
  late: -0.5,
  blackMark: -1,
  kudos: 0.25,
  kudosCap: 2,
};

const monthBounds = (month) => {
  const anchor = month ? new Date(`${month}-01T00:00:00Z`) : new Date();
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  return { start, end, key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}` };
};

export async function leaderboard({ month, departmentId = null } = {}) {
  const { start, end, key } = monthBounds(month);

  const { rows } = await query(
    `WITH completed AS (
       SELECT t.assignee_id AS user_id,
              COUNT(*)::int AS done_count,
              COUNT(*) FILTER (WHERE t.due_date IS NOT NULL AND t.completed_at <= t.due_date)::int AS on_time,
              COUNT(*) FILTER (WHERE t.due_date IS NOT NULL AND t.completed_at > t.due_date)::int  AS late,
              COUNT(*) FILTER (WHERE t.priority = 'critical')::int AS critical_done,
              COUNT(*) FILTER (WHERE t.priority = 'high')::int     AS high_done
         FROM tasks t
         JOIN workflow_statuses s ON s.id = t.status_id
        WHERE s.stage = 'done'
          AND t.assignee_id IS NOT NULL
          AND t.completed_at >= $1 AND t.completed_at < $2
        GROUP BY t.assignee_id
     ),
     marks AS (
       SELECT user_id, COALESCE(SUM(points), 0) AS mark_points, COUNT(*)::int AS mark_count
         FROM black_marks
        WHERE status = 'active' AND occurred_at >= $1 AND occurred_at < $2
        GROUP BY user_id
     ),
     praise AS (
       SELECT to_user AS user_id, COUNT(*)::int AS kudos_count
         FROM kudos
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY to_user
     )
     SELECT u.id AS user_id, u.full_name, u.avatar_color, u.job_title,
            d.name AS department, d.color AS department_color,
            COALESCE(c.done_count, 0)     AS done_count,
            COALESCE(c.on_time, 0)        AS on_time,
            COALESCE(c.late, 0)           AS late,
            COALESCE(c.critical_done, 0)  AS critical_done,
            COALESCE(c.high_done, 0)      AS high_done,
            COALESCE(m.mark_points, 0)    AS mark_points,
            COALESCE(m.mark_count, 0)     AS mark_count,
            COALESCE(p.kudos_count, 0)    AS kudos_count
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN completed c ON c.user_id = u.id
       LEFT JOIN marks m ON m.user_id = u.id
       LEFT JOIN praise p ON p.user_id = u.id
      WHERE u.is_active = TRUE
        AND ($3::int IS NULL OR u.department_id = $3::int)`,
    [start, end, departmentId],
  );

  const scored = rows
    .map((row) => {
      const kudosBonus = Math.min(WEIGHTS.kudosCap, row.kudos_count * WEIGHTS.kudos);
      const score =
        row.done_count * WEIGHTS.base +
        row.high_done * WEIGHTS.high +
        row.critical_done * WEIGHTS.critical +
        row.on_time * WEIGHTS.onTime +
        row.late * WEIGHTS.late +
        Number(row.mark_points) * WEIGHTS.blackMark +
        kudosBonus;

      const withDeadline = row.on_time + row.late;
      return {
        ...row,
        mark_points: Number(row.mark_points),
        kudos_bonus: Number(kudosBonus.toFixed(2)),
        on_time_rate: withDeadline > 0 ? Math.round((row.on_time / withDeadline) * 100) : null,
        score: Number(score.toFixed(2)),
      };
    })
    // somebody with no completed work and no black marks is not "in the running"
    .filter((row) => row.done_count > 0 || row.mark_count > 0 || row.kudos_count > 0)
    .sort((a, b) => b.score - a.score || b.on_time - a.on_time || a.mark_points - b.mark_points);

  return { month: key, period: { start: start.toISOString(), end: end.toISOString() }, weights: WEIGHTS, members: scored };
}

/** The standing winner for a month, if one has been awarded. */
export async function awardsFor(month) {
  const { start } = monthBounds(month);
  const periodMonth = start.toISOString().slice(0, 10);

  const { rows } = await query(
    `SELECT r.*, u.full_name, u.avatar_color, u.job_title, d.name AS department,
            a.full_name AS awarded_by_name
       FROM recognitions r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN users a ON a.id = r.awarded_by
      WHERE r.period_month = $1
      ORDER BY r.created_at`,
    [periodMonth],
  );
  return rows;
}

export async function award({ userId, month, title, citation, awardedBy }) {
  const { start } = monthBounds(month);
  const periodMonth = start.toISOString().slice(0, 10);

  const board = await leaderboard({ month });
  const entry = board.members.find((m) => m.user_id === userId);

  const { rows } = await query(
    `INSERT INTO recognitions (user_id, period_month, title, citation, score, stats, awarded_by)
     VALUES ($1, $2, COALESCE($3, 'Performer of the Month'), $4, $5, $6, $7)
     ON CONFLICT (user_id, period_month, title)
       DO UPDATE SET citation = EXCLUDED.citation, score = EXCLUDED.score,
                     stats = EXCLUDED.stats, awarded_by = EXCLUDED.awarded_by
     RETURNING *`,
    [
      userId,
      periodMonth,
      title || null,
      citation || null,
      entry?.score ?? null,
      JSON.stringify(
        entry
          ? {
              done_count: entry.done_count,
              on_time: entry.on_time,
              on_time_rate: entry.on_time_rate,
              critical_done: entry.critical_done,
              mark_count: entry.mark_count,
              kudos_count: entry.kudos_count,
            }
          : {},
      ),
      awardedBy,
    ],
  );
  return rows[0];
}
