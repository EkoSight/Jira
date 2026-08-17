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

  return next;
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
