/**
 * Recurring tasks.
 *
 * A task carries a `recurrence` rule. When an occurrence is completed, the next
 * one is spawned as a fresh card (same owner, department, checklist and tags) with
 * its due date advanced. The completed card stays completed, so each cycle is its
 * own auditable record — yesterday's "close the shop" is a separate, closed card
 * from today's.
 */

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

  const due = task.due_date ? nextDueDate(task.recurrence, task.due_date) : nextDueDate(task.recurrence, new Date());

  // reference stays within the department series (DEPT-N)
  const { rows: deptRows } = await client.query('SELECT key FROM departments WHERE id = $1', [task.department_id]);
  const { rows: seqRows } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(ref, '^.*-', ''), '')::int), 0) + 1 AS next
       FROM tasks WHERE department_id = $1`,
    [task.department_id],
  );
  const ref = `${deptRows[0].key}-${seqRows[0].next}`;

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
