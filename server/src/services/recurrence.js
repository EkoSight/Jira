/**
 * Recurring tasks.
 *
 * A task carries a `recurrence` rule. When an occurrence is completed, the next
 * one is spawned as a fresh card (same owner, department, checklist and tags) with
 * its due date advanced. The completed card stays completed, so each cycle is its
 * own auditable record — yesterday's "close the shop" is a separate, closed card
 * from today's.
 */

import { withTransaction } from '../db/pool.js';
import { notify } from './activity.js';
import { nextTaskRef } from '../lib/taskRef.js';

export const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

const addDays = (date, n) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
};

/** The next due date for a recurrence, based on the occurrence just finished. */
export function nextDueDate(recurrence, fromDate) {
  const base = fromDate ? new Date(fromDate) : new Date();

  switch (recurrence) {
    case 'daily':
      return addDays(base, 1);
    case 'weekly':
      return addDays(base, 7);
    case 'monthly': {
      const next = new Date(base);
      const day = next.getUTCDate();
      next.setUTCMonth(next.getUTCMonth() + 1);
      // guard against month-length overflow (e.g. Jan 31 -> Feb): clamp to month end
      if (next.getUTCDate() < day) next.setUTCDate(0);
      return next;
    }
    case 'weekdays': {
      // EkoSight works a six-day week, so only Sunday (day 0) is skipped
      let next = addDays(base, 1);
      while (next.getUTCDay() === 0) next = addDays(next, 1);
      return next;
    }
    default:
      return null;
  }
}

/**
 * The next due date that is still ahead of us.
 *
 * Rolling forward a single interval from the previous due date is wrong when that
 * occurrence was completed late: "yesterday + 1 day" can already be in the past,
 * so the new task is born overdue and earns a black mark the moment someone
 * finishes the old one. Stepping until the slot is in the future keeps the
 * cadence and the time of day, without penalising a person for catching up.
 */
export function nextDueDateAhead(recurrence, fromDate, now = new Date()) {
  let next = nextDueDate(recurrence, fromDate);
  if (!next) return null;

  // a year of steps is far more than any real catch-up, and stops a runaway loop
  for (let guard = 0; guard < 400 && next.getTime() <= now.getTime(); guard += 1) {
    next = nextDueDate(recurrence, next);
    if (!next) return null;
  }
  return next;
}

export const describeRecurrence = (recurrence) =>
  ({
    daily: 'every day',
    weekdays: 'every working day',
    weekly: 'every week',
    monthly: 'every month',
  })[recurrence] || null;

/**
 * Creates the next occurrence of a just-completed recurring task.
 * Must run inside the same transaction as the completion.
 *
 * @returns the new task row, or null if the task does not recur.
 */
export async function spawnNextOccurrence(client, task) {
  if (!task.recurrence || task.recurrence === 'none') return null;

  // the whole series shares a root id, so all occurrences can be counted together
  const seriesRoot = task.recurrence_parent_id || task.id;

  // land the next card in the default starting column
  const { rows: statusRows } = await client.query(
    `SELECT id FROM workflow_statuses WHERE is_active = TRUE
      ORDER BY is_default DESC, position ASC LIMIT 1`,
  );
  if (!statusRows[0]) return null;
  const statusId = statusRows[0].id;

  // always lands in the future, so catching up on a late occurrence never creates
  // a task that is already overdue
  const due = nextDueDateAhead(task.recurrence, task.due_date || new Date());

  // reference stays within the department series (DEPT-N), allocated under the
  // same lock the normal create path uses so two simultaneous completions in one
  // department cannot mint the same reference
  const ref = await nextTaskRef(client, task.department_id);

  const { rows } = await client.query(
    `INSERT INTO tasks
       (ref, title, description, department_id, status_id, priority, task_type, assignee_id,
        follower_id, reporter_id, created_by, start_date, due_date, original_due_date,
        estimate_hours, progress, tags, recurrence, recurrence_parent_id, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,0,$15::text[],$16,$17,
             (SELECT COALESCE(MAX(position), 0) + 100 FROM tasks WHERE status_id = $5))
     RETURNING *`,
    [
      ref,
      task.title,
      task.description,
      task.department_id,
      statusId,
      task.priority,
      task.task_type,
      task.assignee_id,
      task.follower_id,
      task.reporter_id,
      task.created_by,
      task.start_date,
      due,
      task.estimate_hours,
      task.tags || [],
      task.recurrence,
      seriesRoot,
    ],
  );
  const next = rows[0];

  // carry the checklist forward, unchecked, so a daily routine keeps its steps
  await client.query(
    `INSERT INTO task_checklist_items (task_id, title, position, is_done)
     SELECT $1, title, position, FALSE FROM task_checklist_items WHERE task_id = $2`,
    [next.id, task.id],
  );

  // keep the same people tagged in
  await client.query(
    `INSERT INTO task_collaborators (task_id, user_id, added_by)
     SELECT $1, user_id, added_by FROM task_collaborators WHERE task_id = $2
     ON CONFLICT DO NOTHING`,
    [next.id, task.id],
  );

  // its project comes with it (and its milestone while that is open). Key
  // result and deal links are not carried, as before: carrying a key result
  // would change how TASK_ROLLUP counts (docs/PROJECTS.md, PD7).
  await carryProject(client, task, next, task.project_id);

  await copyRoutineSubtasks(client, task, next, due);

  return next;
}

/**
 * Puts a new occurrence in the project the finished one was in, while that
 * project is open (a completed or cancelled project takes no new tasks), with
 * the milestone if it is still open, and the engagement sync rule.
 */
async function carryProject(client, from, to, projectId) {
  if (!projectId) return;
  const { rows } = await client.query(
    `SELECT p.status, p.engagement_id, m.id AS milestone_id, m.reached_at
       FROM projects p LEFT JOIN project_milestones m ON m.id = $2 AND m.project_id = p.id
      WHERE p.id = $1 AND p.archived_at IS NULL`,
    [projectId, from.milestone_id || null],
  );
  const p = rows[0];
  if (!p || !['PLANNED', 'ACTIVE', 'ON_HOLD'].includes(p.status)) return;
  const milestoneId = p.milestone_id && !p.reached_at ? p.milestone_id : null;
  await client.query(
    'UPDATE tasks SET project_id = $2, milestone_id = $3, engagement_id = COALESCE(engagement_id, $4) WHERE id = $1',
    [to.id, projectId, milestoneId, p.engagement_id || null],
  );
  await client.query(
    `INSERT INTO project_activity (project_id, actor_id, action, task_id, detail) VALUES ($1, NULL, 'task_added', $2, $3)`,
    [projectId, to.id, JSON.stringify({ ref: to.ref, recurring: true })],
  );
  Object.assign(to, { project_id: projectId, milestone_id: milestoneId });
}

/**
 * Recreates the subtasks that are part of the routine.
 *
 * Only the ones marked `repeats_with_parent`. A subtask added mid-cycle to deal
 * with something that came up once should not come back every day forever — so
 * carrying everything forward, the way the checklist does, would be wrong here:
 * a subtask is a real card with its own reference, deadline and black mark
 * exposure, not a tick box.
 *
 * Each copy is fresh: no progress, back in the starting column, due with its
 * parent. The finished ones stay attached to the occurrence that finished them.
 */
export async function copyRoutineSubtasks(client, task, next, due) {
  const { rows: subtasks } = await client.query(
    `SELECT * FROM tasks
      WHERE parent_task_id = $1 AND repeats_with_parent = TRUE AND is_archived = FALSE
      ORDER BY position, id`,
    [task.id],
  );
  if (!subtasks.length) return [];

  const { rows: statusRows } = await client.query(
    `SELECT id FROM workflow_statuses WHERE is_active = TRUE
      ORDER BY is_default DESC, position ASC LIMIT 1`,
  );
  if (!statusRows[0]) return [];
  const statusId = statusRows[0].id;

  const created = [];
  for (const subtask of subtasks) {
    // its own reference in its own department series, under the same lock the
    // normal create path uses
    const ref = await nextTaskRef(client, subtask.department_id);

    const { rows } = await client.query(
      `INSERT INTO tasks
         (ref, title, description, department_id, status_id, priority, task_type, assignee_id,
          follower_id, reporter_id, created_by, parent_task_id, start_date, due_date,
          original_due_date, estimate_hours, progress, tags, recurrence, repeats_with_parent,
          position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,0,$16::text[],'none',TRUE,$17)
       RETURNING *`,
      [
        ref,
        subtask.title,
        subtask.description,
        subtask.department_id,
        statusId,
        subtask.priority,
        subtask.task_type,
        subtask.assignee_id,
        subtask.follower_id,
        subtask.reporter_id,
        subtask.created_by,
        next.id,
        subtask.start_date,
        // a step of the routine is due when the routine is
        due,
        subtask.estimate_hours,
        subtask.tags || [],
        subtask.position,
      ],
    );
    created.push(rows[0]);

    // a subtask's own checklist is part of the step, so it comes too
    await client.query(
      `INSERT INTO task_checklist_items (task_id, title, position, is_done)
       SELECT $1, title, position, FALSE FROM task_checklist_items WHERE task_id = $2`,
      [rows[0].id, subtask.id],
    );

    // a subtask is always in its parent's project
    await carryProject(client, subtask, rows[0], next.project_id || null);
  }

  return created;
}

/**
 * Spawns the next occurrence in its own transaction, after the completion has
 * already been committed.
 *
 * Completing a task is what the person actually did; creating tomorrow's card is a
 * convenience on top. Running it separately means a failure here can never roll
 * back — or silently discard — someone's completion. Failures are logged and
 * reported rather than swallowed.
 *
 * @returns the new task row, or null if the task does not recur or the spawn failed.
 */
export async function spawnNextOccurrenceAfterCompletion(task) {
  if (!task?.recurrence || task.recurrence === 'none') return null;

  try {
    return await withTransaction(async (client) => {
      const next = await spawnNextOccurrence(client, task);
      if (next && task.assignee_id) {
        await notify(client, {
          userId: task.assignee_id,
          type: 'assigned',
          title: `Next up: ${next.ref}`,
          body: `${task.title} — repeats ${describeRecurrence(task.recurrence)}`,
          taskId: next.id,
        });
      }
      return next;
    });
  } catch (err) {
    console.error(
      `[taskflow] could not create the next occurrence of ${task.ref} (${task.recurrence}):`,
      err.message,
    );
    return null;
  }
}
