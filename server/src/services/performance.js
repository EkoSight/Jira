import { query } from '../db/pool.js';
import { getSettings } from './settings.js';

/**
 * Per-person performance review.
 *
 * Reads what actually happened in a period and turns it into findings a manager
 * can act on and a person can act on: what went well, what is going wrong, and a
 * concrete suggestion for each concern. Every statement carries the evidence it
 * came from, so nothing is an unexplained judgement.
 *
 * The analysis is deterministic — no external service, nothing leaves the server —
 * and each rule states the threshold it fired on.
 */

const monthBounds = (month) => {
  const anchor = month ? new Date(`${month}-01T00:00:00Z`) : new Date();
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  const previousStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1));
  return {
    start,
    end,
    previousStart,
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
  };
};

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

/** Everything measured about one person in one period. */
async function gather(userId, { start, end, previousStart }) {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'done'
           AND t.completed_at >= $2 AND t.completed_at < $3)                       AS completed,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'done' AND t.due_date IS NOT NULL
           AND t.completed_at <= t.due_date
           AND t.completed_at >= $2 AND t.completed_at < $3)                       AS on_time,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'done' AND t.due_date IS NOT NULL
           AND t.completed_at > t.due_date
           AND t.completed_at >= $2 AND t.completed_at < $3)                       AS late,
       (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (t.completed_at - t.due_date)) / 86400), 0)
          FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'done' AND t.due_date IS NOT NULL
           AND t.completed_at > t.due_date
           AND t.completed_at >= $2 AND t.completed_at < $3)                       AS avg_days_late,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage NOT IN ('done','cancelled')
           AND t.is_archived = FALSE AND t.due_date < now())                       AS overdue_now,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage NOT IN ('done','cancelled')
           AND t.is_archived = FALSE)                                              AS open_now,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'blocked' AND t.is_archived = FALSE) AS blocked_now,
       (SELECT COUNT(*)::int FROM tasks t
         WHERE t.assignee_id = $1 AND t.is_archived = FALSE
           AND t.updated_at < now() - interval '4 days'
           AND t.status_id IN (SELECT id FROM workflow_statuses WHERE stage NOT IN ('done','cancelled'))) AS stale_now,
       (SELECT COALESCE(SUM(t.due_date_changes), 0)::int FROM tasks t
         WHERE t.assignee_id = $1 AND t.updated_at >= $2 AND t.updated_at < $3)     AS deadline_changes,
       (SELECT COUNT(*)::int FROM black_marks bm
         WHERE bm.user_id = $1 AND bm.status = 'active'
           AND bm.occurred_at >= $2 AND bm.occurred_at < $3)                        AS mark_count,
       (SELECT COALESCE(SUM(bm.points), 0) FROM black_marks bm
         WHERE bm.user_id = $1 AND bm.status = 'active'
           AND bm.occurred_at >= $2 AND bm.occurred_at < $3)                        AS mark_points,
       (SELECT COUNT(*)::int FROM kudos k
         WHERE k.to_user = $1 AND k.created_at >= $2 AND k.created_at < $3)         AS kudos,
       (SELECT COUNT(*)::int FROM task_activity a
         WHERE a.actor_id = $1 AND a.action = 'reopened'
           AND a.created_at >= $2 AND a.created_at < $3)                            AS reopened,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'done'
           AND t.completed_at >= $4 AND t.completed_at < $2)                        AS prev_completed,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'done' AND t.due_date IS NOT NULL
           AND t.completed_at <= t.due_date
           AND t.completed_at >= $4 AND t.completed_at < $2)                        AS prev_on_time,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'done' AND t.due_date IS NOT NULL
           AND t.completed_at > t.due_date
           AND t.completed_at >= $4 AND t.completed_at < $2)                        AS prev_late,
       (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
         WHERE t.assignee_id = $1 AND s.stage = 'done' AND t.completion_note IS NOT NULL
           AND t.completed_at >= $2 AND t.completed_at < $3)                        AS with_notes`,
    [userId, start, end, previousStart],
  );

  // where the lateness concentrates — the most useful single diagnostic
  const { rows: byType } = await query(
    `SELECT t.task_type,
            COUNT(*)::int AS done,
            COUNT(*) FILTER (WHERE t.due_date IS NOT NULL AND t.completed_at > t.due_date)::int AS late
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.assignee_id = $1 AND s.stage = 'done'
        AND t.completed_at >= $2 AND t.completed_at < $3
      GROUP BY t.task_type
      ORDER BY late DESC, done DESC`,
    [userId, start, end],
  );

  const { rows: byPriority } = await query(
    `SELECT t.priority,
            COUNT(*)::int AS done,
            COUNT(*) FILTER (WHERE t.due_date IS NOT NULL AND t.completed_at > t.due_date)::int AS late
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.assignee_id = $1 AND s.stage = 'done'
        AND t.completed_at >= $2 AND t.completed_at < $3
      GROUP BY t.priority`,
    [userId, start, end],
  );

  return { ...rows[0], byType, byPriority };
}

/**
 * Turns the numbers into findings. Each concern names the evidence and pairs with
 * a suggestion, so a review is never just a score.
 */
function analyse(raw, user, settings) {
  const metrics = {
    completed: raw.completed,
    onTime: raw.on_time,
    late: raw.late,
    onTimeRate: pct(raw.on_time, raw.on_time + raw.late),
    avgDaysLate: Number(raw.avg_days_late) || 0,
    overdueNow: raw.overdue_now,
    openNow: raw.open_now,
    blockedNow: raw.blocked_now,
    staleNow: raw.stale_now,
    deadlineChanges: raw.deadline_changes,
    markCount: raw.mark_count,
    markPoints: Number(raw.mark_points) || 0,
    kudos: raw.kudos,
    reopened: raw.reopened,
    withNotes: raw.with_notes,
    previous: {
      completed: raw.prev_completed,
      onTimeRate: pct(raw.prev_on_time, raw.prev_on_time + raw.prev_late),
    },
  };

  const strengths = [];
  const concerns = [];
  const suggestions = [];

  const add = (list, title, detail, extra = {}) => list.push({ title, detail, ...extra });

  // ---- delivery ----------------------------------------------------------
  if (metrics.onTimeRate !== null && metrics.onTimeRate >= 90 && metrics.completed >= 3) {
    add(strengths, 'Delivers on time', `${metrics.onTimeRate}% of the ${metrics.onTime + metrics.late} tasks with a deadline were finished on or before it.`);
  }
  if (metrics.onTimeRate !== null && metrics.onTimeRate < 60 && metrics.late >= 2) {
    add(
      concerns,
      'Deadlines are slipping',
      `${metrics.late} of ${metrics.onTime + metrics.late} tasks with a deadline were finished late (${metrics.onTimeRate}% on time), on average ${metrics.avgDaysLate.toFixed(1)} days over.`,
      { severity: metrics.onTimeRate < 40 ? 'high' : 'medium', metric: 'onTimeRate' },
    );
    add(
      suggestions,
      'Set your own deadline a day earlier',
      'Aim to finish a day before the real date. It absorbs the small surprises that are currently pushing work past the deadline.',
    );
  }

  // ---- current backlog ---------------------------------------------------
  if (metrics.overdueNow >= 3) {
    add(
      concerns,
      `${metrics.overdueNow} tasks are overdue right now`,
      'These are already past their deadline and still open, so they are accruing black marks while they sit there.',
      { severity: 'high', metric: 'overdueNow' },
    );
    add(
      suggestions,
      'Clear the overdue list first',
      'Work the oldest overdue task to done before starting anything new. If one genuinely cannot be finished, move its deadline and say why, rather than leaving it silently late.',
    );
  }

  if (metrics.staleNow >= 3) {
    add(
      concerns,
      `${metrics.staleNow} open tasks have not moved in over 4 days`,
      'Nobody can tell whether these are in progress, blocked or forgotten.',
      { severity: 'medium', metric: 'staleNow' },
    );
    add(
      suggestions,
      'Touch each open task once a week',
      'A status move or a one-line comment is enough. It keeps the board honest and stops someone chasing you for an update.',
    );
  }

  if (metrics.blockedNow >= 2) {
    add(
      concerns,
      `${metrics.blockedNow} tasks are sitting blocked`,
      'Blocked work still counts against the deadline unless someone unblocks it.',
      { severity: 'medium', metric: 'blockedNow' },
    );
    add(
      suggestions,
      'Escalate a block within a day',
      'Tag the person who can unblock you on the card. A block that nobody knows about looks the same as work that is not being done.',
    );
  }

  // ---- deadline hygiene --------------------------------------------------
  if (metrics.deadlineChanges >= 5) {
    add(
      concerns,
      `Deadlines were moved ${metrics.deadlineChanges} times`,
      'Frequently pushing the date makes planning around your work unreliable, even when everything eventually gets done.',
      { severity: 'medium', metric: 'deadlineChanges' },
    );
    add(
      suggestions,
      'Estimate against your real week',
      'Before accepting a date, check what you already owe that week on the Team page. It is better to agree a later date once than to move it three times.',
    );
  }

  // ---- where it goes wrong ----------------------------------------------
  const worstType = (raw.byType || []).find((row) => row.late >= 2 && row.late >= row.done / 2);
  if (worstType) {
    add(
      concerns,
      `${String(worstType.task_type).replace(/-/g, ' ')} work is where you slip`,
      `${worstType.late} of ${worstType.done} ${String(worstType.task_type).replace(/-/g, ' ')} tasks finished late — more than any other type.`,
      { severity: 'medium', metric: 'byType' },
    );
    add(
      suggestions,
      `Break ${String(worstType.task_type).replace(/-/g, ' ')} tasks into sub tasks`,
      'Splitting them into steps shows progress earlier and surfaces the hard part while there is still time to ask for help.',
    );
  }

  const criticalRow = (raw.byPriority || []).find((row) => row.priority === 'critical');
  if (criticalRow && criticalRow.late > 0) {
    add(
      concerns,
      'Critical work is finishing late',
      `${criticalRow.late} of ${criticalRow.done} critical tasks missed their deadline. These carry the heaviest black marks and usually block someone else.`,
      { severity: 'high', metric: 'critical' },
    );
    add(
      suggestions,
      'Start the critical task first each day',
      'Do the highest priority item before anything else, while you still have the day to recover if it goes wrong.',
    );
  }

  // ---- record keeping ----------------------------------------------------
  if (metrics.completed >= 4 && metrics.withNotes < metrics.completed / 2) {
    add(
      concerns,
      'Completions often have no outcome recorded',
      `Only ${metrics.withNotes} of ${metrics.completed} finished tasks say what was actually done.`,
      { severity: 'low', metric: 'withNotes' },
    );
    add(
      suggestions,
      'Write one line and attach the proof',
      'A sentence and a link takes ten seconds and means nobody has to ask you later what happened.',
    );
  }

  if (metrics.reopened >= 2) {
    add(
      concerns,
      `${metrics.reopened} tasks had to be reopened`,
      'Work marked done that came back suggests it was closed before it was truly finished.',
      { severity: 'medium', metric: 'reopened' },
    );
    add(
      suggestions,
      'Check the task against its description before closing',
      'Re-read what was asked for. Closing early costs more time than it saves.',
    );
  }

  // ---- load --------------------------------------------------------------
  if (metrics.openNow > (user.max_concurrent_tasks || 8)) {
    add(
      concerns,
      'Carrying more work than is realistic',
      `${metrics.openNow} tasks are open against a comfortable load of ${user.max_concurrent_tasks || 8}.`,
      { severity: 'medium', metric: 'openNow' },
    );
    add(
      suggestions,
      'Hand something over',
      'Anyone can reassign a task now. Pick the one least dependent on you and give it to someone with room on the Team page.',
    );
  }

  // ---- positives ---------------------------------------------------------
  if (metrics.completed >= 5) {
    add(strengths, 'Steady throughput', `${metrics.completed} tasks completed this period.`);
  }
  if (metrics.kudos > 0) {
    add(strengths, `Recognised by colleagues`, `${metrics.kudos} kudos received this period.`);
  }
  if (metrics.markCount === 0 && metrics.completed > 0) {
    add(strengths, 'A clean month', 'No black marks recorded in this period.');
  }
  if (
    metrics.previous.onTimeRate !== null &&
    metrics.onTimeRate !== null &&
    metrics.onTimeRate - metrics.previous.onTimeRate >= 15
  ) {
    add(
      strengths,
      'Improving',
      `On-time delivery is up from ${metrics.previous.onTimeRate}% last month to ${metrics.onTimeRate}%.`,
    );
  }

  const declining =
    metrics.previous.onTimeRate !== null &&
    metrics.onTimeRate !== null &&
    metrics.previous.onTimeRate - metrics.onTimeRate >= 15;
  if (declining) {
    add(
      concerns,
      'Slipping compared with last month',
      `On-time delivery fell from ${metrics.previous.onTimeRate}% to ${metrics.onTimeRate}%.`,
      { severity: 'medium', metric: 'trend' },
    );
  }

  // ---- overall standing --------------------------------------------------
  const limit = settings.blackmarks.missedDeadlineLimit;
  let standing = 'good';
  if (metrics.markPoints >= settings.blackmarks.criticalPoints || metrics.overdueNow >= 5) standing = 'needs_action';
  else if (metrics.markCount > limit || metrics.markPoints >= settings.blackmarks.warningPoints) standing = 'watch';
  else if (concerns.length === 0 && metrics.completed > 0) standing = 'strong';

  const headline = {
    strong: 'Doing well across the board.',
    good: 'Broadly on track, with a couple of things to tighten up.',
    watch: 'Some real slippage worth talking through.',
    needs_action: 'Needs attention — this is not recoverable without a change.',
  }[standing];

  const summary =
    metrics.completed === 0 && metrics.openNow === 0
      ? 'No completed or open work in this period, so there is nothing to review yet.'
      : `${headline} ${metrics.completed} task${metrics.completed === 1 ? '' : 's'} completed` +
        (metrics.onTimeRate !== null ? `, ${metrics.onTimeRate}% on time` : '') +
        (metrics.markCount > 0 ? `, ${metrics.markCount} black mark${metrics.markCount === 1 ? '' : 's'} (${metrics.markPoints} pts)` : ', no black marks') +
        `. ${metrics.overdueNow} task${metrics.overdueNow === 1 ? '' : 's'} overdue right now.`;

  return { metrics, strengths, concerns, suggestions, standing, summary };
}

export async function performanceReview({ userId, month }) {
  const bounds = monthBounds(month);
  const settings = await getSettings();

  const { rows: userRows } = await query(
    `SELECT u.id, u.full_name, u.email, u.job_title, u.avatar_color, u.max_concurrent_tasks,
            u.weekly_capacity_hours, d.name AS department
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = $1`,
    [userId],
  );
  const user = userRows[0];
  if (!user) return null;

  const raw = await gather(userId, bounds);
  const analysis = analyse(raw, user, settings);

  return {
    user,
    month: bounds.key,
    period: { start: bounds.start.toISOString(), end: bounds.end.toISOString() },
    ...analysis,
  };
}

/** Every active person's review, ordered worst standing first. */
export async function teamReview({ month, departmentId = null }) {
  const { rows } = await query(
    `SELECT id FROM users
      WHERE is_active = TRUE AND ($1::int IS NULL OR department_id = $1::int)
      ORDER BY full_name`,
    [departmentId],
  );

  const reviews = [];
  for (const row of rows) {
    const review = await performanceReview({ userId: row.id, month });
    if (review) reviews.push(review);
  }

  const rank = { needs_action: 0, watch: 1, good: 2, strong: 3 };
  reviews.sort((a, b) => rank[a.standing] - rank[b.standing] || b.concerns.length - a.concerns.length);
  return reviews;
}
