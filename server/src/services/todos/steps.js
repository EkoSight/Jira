/**
 * Steps: a task's checklist items, which can now have an owner, a day and a
 * time, and record who ticked them and when (Part B3).
 *
 * A step is one row. Ticking it in Today's plan or on the task changes that
 * same row and writes task_activity. Steps never change a task's status, dates,
 * health, overdue review or black marks. When the last step is done, the
 * assignee is asked "Complete WS-12?"; nothing is completed automatically.
 */
import { query } from '../../db/pool.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logActivity, notify } from '../activity.js';
import { canEditTask, taskVisibilitySql } from '../taskAccess.js';

const CLOSED = ['done', 'cancelled'];

/** The task with its stage, if this person may see it; otherwise 404. */
export async function visibleTask(user, taskId, runner = { query }) {
  const params = [Number(taskId)];
  const visible = taskVisibilitySql(user, params, 't');
  const { rows } = await runner.query(
    `SELECT t.*, ws.stage FROM tasks t LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
      WHERE t.id = $1 AND t.is_archived = FALSE AND ${visible}`, params);
  if (!rows[0]) throw notFound('Task not found');
  return rows[0];
}

/** Who may own a step: the task's assignee or one of its collaborators. */
export async function mayOwnStep(task, userId, runner = { query }) {
  if (!userId) return true;
  if (Number(task.assignee_id) === Number(userId)) return true;
  const { rows } = await runner.query('SELECT 1 FROM task_collaborators WHERE task_id = $1 AND user_id = $2', [task.id, userId]);
  return rows.length > 0;
}

/**
 * Check a change to a step's owner, day or time. Editors of the task may set
 * them; a person may take a step for themselves when they are the assignee or
 * a collaborator; a step's owner may plan their own step.
 */
export async function checkStepChange(user, task, item, change, runner = { query }) {
  const editor = canEditTask(user, task);
  if (change.owner_user_id !== undefined && Number(change.owner_user_id || 0) !== Number(item?.owner_user_id || 0)) {
    const toSelf = Number(change.owner_user_id) === user.id;
    const releasing = change.owner_user_id === null && item && Number(item.owner_user_id) === user.id;
    if (!editor && !toSelf && !releasing) throw forbidden('Only people who can edit this task can give a step to someone else');
    if (change.owner_user_id && !(await mayOwnStep(task, change.owner_user_id, runner))) {
      throw badRequest('A step can be owned by the task\'s assignee or one of its collaborators');
    }
  }
  if ((change.planned_on !== undefined || change.planned_time !== undefined) && item) {
    const mine = Number(item.owner_user_id) === user.id;
    if (!editor && !mine) throw forbidden('Only the step\'s owner or people who can edit this task can plan it');
  }
}

/**
 * Tick or untick one step: the same row everywhere, with who and when, and a
 * line in the task's activity. Returns the row and, when every step is now
 * done, the question for the assignee (asked here if they ticked it, sent to
 * them otherwise).
 */
export async function setStepDone(client, user, task, item, done) {
  if (Boolean(item.is_done) === Boolean(done)) return { item, changed: false, ask_complete: null };
  const { rows } = await client.query(
    `UPDATE task_checklist_items
        SET is_done = $1,
            done_by = CASE WHEN $1 THEN $2::int ELSE NULL END,
            done_at = CASE WHEN $1 THEN now() ELSE NULL END
      WHERE id = $3 RETURNING *`,
    [Boolean(done), user.id, item.id]);
  await logActivity(client, { taskId: task.id, actorId: user.id, action: done ? 'step_done' : 'step_reopened', to: item.title, meta: { step_id: item.id } });
  let ask = null;
  if (done && !CLOSED.includes(task.stage)) {
    const { rows: left } = await client.query('SELECT count(*)::int AS n FROM task_checklist_items WHERE task_id = $1 AND is_done = FALSE', [task.id]);
    if (left[0].n === 0) {
      const words = `All steps on ${task.ref} are done. Complete ${task.ref}?`;
      if (Number(task.assignee_id) === user.id) ask = { task_id: task.id, ref: task.ref, words };
      else if (task.assignee_id) {
        await notify(client, { userId: task.assignee_id, type: 'task', title: `All steps on ${task.ref} are done`, body: `Complete ${task.ref} when you are ready. Nothing was completed automatically.`, taskId: task.id });
      }
    }
  }
  return { item: rows[0], changed: true, ask_complete: ask };
}

/** Add a step to a task, optionally owned and planned. */
export async function addStep(client, user, task, { title, owner_user_id = null, planned_on = null, planned_time = null, is_done = false, done_at = null }) {
  await checkStepChange(user, task, null, { owner_user_id }, client);
  const { rows } = await client.query(
    `INSERT INTO task_checklist_items (task_id, title, position, owner_user_id, created_by, planned_on, planned_time, is_done, done_by, done_at)
     VALUES ($1, $2, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_checklist_items WHERE task_id = $1), $3, $4, $5, $6, $7,
             CASE WHEN $7 THEN $4::int ELSE NULL END, CASE WHEN $7 THEN COALESCE($8::timestamptz, now()) ELSE NULL END)
     RETURNING *`,
    [task.id, title, owner_user_id, user.id, planned_on, planned_time, Boolean(is_done), done_at]);
  await logActivity(client, { taskId: task.id, actorId: user.id, action: 'step_added', to: title, meta: { step_id: rows[0].id } });
  return rows[0];
}

/** Steps with their owner's and ticker's names, as the task page shows them. */
export async function stepsOf(taskId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT ci.*, o.full_name AS owner_name, d.full_name AS done_by_name
       FROM task_checklist_items ci
       LEFT JOIN users o ON o.id = ci.owner_user_id
       LEFT JOIN users d ON d.id = ci.done_by
      WHERE ci.task_id = $1 ORDER BY ci.position, ci.id`, [taskId]);
  return rows;
}
