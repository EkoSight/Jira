import { query } from '../db/pool.js';
import { getSettings } from './settings.js';
import { notify } from './activity.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const periodMonth = (date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;

const ruleMatches = (rule, task) => {
  if (rule.priorities?.length && !rule.priorities.includes(task.priority)) return false;
  if (rule.department_ids?.length && !rule.department_ids.includes(task.department_id)) return false;
  return true;
};

/**
 * Inserts a black mark unless one with the same occurrence key already exists.
 * The unique index on occurrence_key makes repeated scans idempotent.
 */
export async function recordBlackMark({
  userId,
  taskId = null,
  ruleId = null,
  points,
  reason,
  source = 'auto',
  occurredAt = new Date(),
  occurrenceKey,
  createdBy = null,
}) {
  const { rows } = await query(
    `INSERT INTO black_marks
       (user_id, task_id, rule_id, points, reason, source, occurred_at, period_month, occurrence_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (occurrence_key) DO NOTHING
     RETURNING *`,
    [
      userId,
      taskId,
      ruleId,
      points,
      reason,
      source,
      occurredAt,
      periodMonth(occurredAt),
      occurrenceKey,
      createdBy,
    ],
  );
  return rows[0] || null;
}

async function pointsAlreadyOnTask(taskId, ruleId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(points), 0) AS total FROM black_marks
     WHERE task_id = $1 AND rule_id = $2 AND status = 'active'`,
    [taskId, ruleId],
  );
  return Number(rows[0].total);
}

/**
 * Evaluates every active rule against the current task set.
 * Safe to call as often as you like — nothing is double counted.
 *
 * @returns {Promise<{scanned:number, created:Array}>}
 */
export async function runBlackMarkScan({ now = new Date(), taskId = null } = {}) {
  const settings = await getSettings();

  const { rows: rules } = await query(
    `SELECT * FROM blackmark_rules WHERE is_active = TRUE AND trigger_type <> 'manual'`,
  );
  if (rules.length === 0) return { scanned: 0, created: [] };

  const { rows: tasks } = await query(
    `SELECT t.*, s.stage, d.name AS department_name, u.full_name AS assignee_name, u.department_id AS assignee_department_id
       FROM tasks t
       JOIN workflow_statuses s ON s.id = t.status_id
       JOIN departments d ON d.id = t.department_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.is_archived = FALSE
        AND t.assignee_id IS NOT NULL
        AND t.due_date IS NOT NULL
        AND ($1::int IS NULL OR t.id = $1::int)`,
    [taskId],
  );

  const created = [];

  for (const task of tasks) {
    const due = new Date(task.due_date);
    const isDone = task.stage === 'done';
    const isCancelled = task.stage === 'cancelled';
    if (isCancelled) continue;

    for (const rule of rules) {
      if (!ruleMatches(rule, task)) continue;

      const graceMs = (rule.grace_hours || 0) * HOUR_MS;
      const deadline = due.getTime() + graceMs;

      if (rule.trigger_type === 'deadline_missed') {
        if (isDone || now.getTime() <= deadline) continue;
        const mark = await recordBlackMark({
          userId: task.assignee_id,
          taskId: task.id,
          ruleId: rule.id,
          points: Number(rule.points),
          reason: `Missed deadline on ${task.ref} — ${task.title}`,
          occurredAt: new Date(deadline),
          occurrenceKey: `rule:${rule.id}:task:${task.id}:missed`,
        });
        if (mark) created.push({ ...mark, rule_name: rule.name, task_ref: task.ref });
      }

      if (rule.trigger_type === 'completed_late') {
        if (!isDone || !task.completed_at) continue;
        const completedAt = new Date(task.completed_at);
        if (completedAt.getTime() <= deadline) continue;
        const mark = await recordBlackMark({
          userId: task.assignee_id,
          taskId: task.id,
          ruleId: rule.id,
          points: Number(rule.points),
          reason: `Completed ${task.ref} after the deadline`,
          occurredAt: completedAt,
          occurrenceKey: `rule:${rule.id}:task:${task.id}:late`,
        });
        if (mark) created.push({ ...mark, rule_name: rule.name, task_ref: task.ref });
      }

      if (rule.trigger_type === 'overdue_escalation') {
        if (isDone || now.getTime() <= deadline) continue;
        const every = Math.max(1, rule.repeat_every_days || 1) * DAY_MS;
        const cycles = Math.floor((now.getTime() - deadline) / every);
        if (cycles < 1) continue;

        for (let cycle = 1; cycle <= cycles; cycle += 1) {
          if (rule.max_points_per_task != null) {
            const existing = await pointsAlreadyOnTask(task.id, rule.id);
            if (existing + Number(rule.points) > Number(rule.max_points_per_task)) break;
          }
          const mark = await recordBlackMark({
            userId: task.assignee_id,
            taskId: task.id,
            ruleId: rule.id,
            points: Number(rule.points),
            reason: `${task.ref} still overdue after ${cycle * (rule.repeat_every_days || 1)} day(s)`,
            occurredAt: new Date(deadline + cycle * every),
            occurrenceKey: `rule:${rule.id}:task:${task.id}:overdue:${cycle}`,
          });
          if (mark) created.push({ ...mark, rule_name: rule.name, task_ref: task.ref });
        }
      }
    }

    if (!isDone && now.getTime() > due.getTime()) {
      await query('UPDATE tasks SET breach_evaluated_at = now() WHERE id = $1', [task.id]);
    }
  }

  if (settings.blackmarks.notifyMember) {
    for (const mark of created) {
      await notify(null, {
        userId: mark.user_id,
        type: 'blackmark',
        title: `Black mark recorded (${Number(mark.points)} pt)`,
        body: mark.reason,
        taskId: mark.task_id,
      });
    }
  }

  return { scanned: tasks.length, created };
}

/** Fired from the task routes when a card is moved out of a done status. */
export async function handleTaskReopened({ task, actorId }) {
  const { rows: rules } = await query(
    `SELECT * FROM blackmark_rules WHERE is_active = TRUE AND trigger_type = 'task_reopened'`,
  );
  const created = [];
  for (const rule of rules) {
    if (!ruleMatches(rule, task)) continue;
    if (!task.assignee_id) continue;
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM task_activity
        WHERE task_id = $1 AND action = 'reopened'`,
      [task.id],
    );
    const mark = await recordBlackMark({
      userId: task.assignee_id,
      taskId: task.id,
      ruleId: rule.id,
      points: Number(rule.points),
      reason: `${task.ref} was reopened after being marked done`,
      occurrenceKey: `rule:${rule.id}:task:${task.id}:reopen:${rows[0].n}`,
      createdBy: actorId,
    });
    if (mark) created.push(mark);
  }
  return created;
}

/**
 * Monthly review data: per-member totals with the flag that drives the
 * "more than N missed deadlines" action list.
 */
export async function monthlyReview({ month, departmentId = null } = {}) {
  const settings = await getSettings();
  const windowMonths = Math.max(1, settings.blackmarks.rollingWindowMonths || 1);
  const anchor = month ? new Date(`${month}-01T00:00:00Z`) : new Date();
  const periodEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  const periodStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - (windowMonths - 1), 1));

  const { rows } = await query(
    `SELECT u.id                                                AS user_id,
            u.full_name,
            u.email,
            u.role,
            d.name                                              AS department,
            COUNT(bm.id) FILTER (WHERE bm.status = 'active')     AS mark_count,
            COALESCE(SUM(bm.points) FILTER (WHERE bm.status = 'active'), 0) AS total_points,
            COUNT(bm.id) FILTER (WHERE bm.status = 'waived')     AS waived_count,
            COUNT(DISTINCT bm.task_id) FILTER (
              WHERE bm.status = 'active' AND r.trigger_type IN ('deadline_missed', 'completed_late')
            )                                                    AS missed_deadlines
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN black_marks bm
              ON bm.user_id = u.id
             AND bm.occurred_at >= $1 AND bm.occurred_at < $2
       LEFT JOIN blackmark_rules r ON r.id = bm.rule_id
      WHERE u.is_active = TRUE
        AND ($3::int IS NULL OR u.department_id = $3::int)
      GROUP BY u.id, d.name
      ORDER BY total_points DESC, mark_count DESC, u.full_name ASC`,
    [periodStart, periodEnd, departmentId],
  );

  const limit = settings.blackmarks.missedDeadlineLimit;
  const members = rows.map((r) => ({
    ...r,
    mark_count: Number(r.mark_count),
    waived_count: Number(r.waived_count),
    missed_deadlines: Number(r.missed_deadlines),
    total_points: Number(r.total_points),
    over_limit: Number(r.missed_deadlines) > limit,
    severity:
      Number(r.total_points) >= settings.blackmarks.criticalPoints
        ? 'critical'
        : Number(r.total_points) >= settings.blackmarks.warningPoints
          ? 'warning'
          : 'ok',
  }));

  return {
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString(), months: windowMonths },
    thresholds: settings.blackmarks,
    members,
    flagged: members.filter((m) => m.over_limit || m.severity === 'critical'),
  };
}
