/**
 * Who may see a task, and who may edit one: the only place this is decided.
 *
 * Every list, count, widget, reminder, deep link and Chat reply that shows a
 * task asks here, so a task can never be visible on one screen and hidden on
 * another. Being tagged on a card grants access to it regardless of
 * department — that is the whole point of tagging someone from another team.
 * The members of a task's project see it too, whichever department it is in:
 * that is what lets a project run across departments (approved by the owner).
 */
import { query } from '../db/pool.js';
import { hasPermission } from '../lib/permissions.js';

/**
 * The WHERE fragment for the tasks `user` may see, with `alias` as the tasks
 * table's alias. Pushes its values onto `params`.
 */
export function taskVisibilitySql(user, params, alias = 't') {
  if (hasPermission(user, 'task.view.all')) return '1=1';
  params.push(user.id, user.department_id);
  const uid = `$${params.length - 1}`;
  const dept = `$${params.length}`;
  return `(
    ${alias}.assignee_id = ${uid}
    OR ${alias}.follower_id = ${uid}
    OR ${alias}.reporter_id = ${uid}
    OR ${alias}.created_by = ${uid}
    OR ${alias}.department_id = ${dept}
    OR EXISTS (SELECT 1 FROM task_collaborators tc WHERE tc.task_id = ${alias}.id AND tc.user_id = ${uid})
    OR (${alias}.project_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM project_members tpm WHERE tpm.project_id = ${alias}.project_id AND tpm.user_id = ${uid}))
  )`;
}

/** Whether `user` may see the task with this id (false for a task that does not exist). */
export async function canSeeTask(user, taskId) {
  const params = [Number(taskId)];
  const visible = taskVisibilitySql(user, params);
  const { rows } = await query(`SELECT 1 FROM tasks t WHERE t.id = $1 AND ${visible}`, params);
  return rows.length > 0;
}

/** Whether `user` may edit this task row (it needs assignee, follower, reporter and creator). */
export function canEditTask(user, task) {
  if (hasPermission(user, 'task.edit.any')) return true;
  if (!hasPermission(user, 'task.edit.own')) return false;
  // the follower is a second owner, so they can move and update the card too
  return [task.assignee_id, task.follower_id, task.reporter_id, task.created_by].includes(user.id);
}
