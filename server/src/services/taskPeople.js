/**
 * Who stands behind a task besides its owner: the fallback person who is told
 * when the owner cannot be reached, and the people who may approve a deadline
 * change, a deferral or a block.
 *
 *   department managers  people an administrator has given the department to
 *                        (attendance_team_access), and active managers whose
 *                        own department it is
 *   fallback             the owner's reporting manager, then the managers of the
 *                        task's department; never the owner themselves
 *   approvers (D1, D3)   the reporter (when they are not the owner), the
 *                        owner's reporting manager, the department's managers,
 *                        and anyone who may edit every task. Never the owner.
 */
import { query } from '../db/pool.js';
import { hasPermission } from '../lib/permissions.js';

/** Active managers of a department, by name. */
export async function departmentManagers(departmentId, runner = { query }) {
  if (!departmentId) return [];
  const { rows } = await runner.query(
    `SELECT DISTINCT u.id, u.full_name FROM users u
      WHERE u.is_active
        AND (u.id IN (SELECT manager_id FROM attendance_team_access WHERE department_id = $1)
             OR (u.role = 'manager' AND u.department_id = $1))
      ORDER BY u.full_name`,
    [departmentId],
  );
  return rows;
}

/** The owner's reporting manager, if active. */
export async function reportingManager(userId, runner = { query }) {
  if (!userId) return null;
  const { rows } = await runner.query(
    `SELECT m.id, m.full_name FROM employee_work_profiles p JOIN users m ON m.id = p.reporting_manager_id
      WHERE p.user_id = $1 AND m.is_active`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * The people told when the owner cannot be: the reporting manager first, then
 * the department's managers. Empty when there is nobody (the coverage check
 * lists that).
 */
export async function fallbackPeople(ownerId, departmentId, runner = { query }) {
  const out = [];
  const manager = await reportingManager(ownerId, runner);
  if (manager && manager.id !== ownerId) out.push({ ...manager, why: 'reporting manager' });
  for (const m of await departmentManagers(departmentId, runner)) {
    if (m.id !== ownerId && !out.some((x) => x.id === m.id)) out.push({ ...m, why: 'department manager' });
  }
  return out;
}

/** Whether this person may approve a deadline change, deferral or block on this task. */
export async function canApprove(user, task, runner = { query }) {
  if (!user || !task) return false;
  if (task.assignee_id && user.id === task.assignee_id) return false;
  if (hasPermission(user, 'task.edit.any')) return true;
  if (task.reporter_id && task.reporter_id === user.id) return true;
  const manager = await reportingManager(task.assignee_id, runner);
  if (manager?.id === user.id) return true;
  return (await departmentManagers(task.department_id, runner)).some((m) => m.id === user.id);
}

/**
 * SQL: "user $1 may approve for task t" (the same people as canApprove), with
 * $2 true when they may edit every task. For lists and counts.
 */
export const APPROVER_SQL = `(t.assignee_id IS DISTINCT FROM $1 AND (
    $2::boolean
    OR t.reporter_id = $1
    OR EXISTS (SELECT 1 FROM employee_work_profiles wp WHERE wp.user_id = t.assignee_id AND wp.reporting_manager_id = $1)
    OR t.department_id IN (SELECT department_id FROM attendance_team_access WHERE manager_id = $1)
    OR t.department_id = (SELECT department_id FROM users WHERE id = $1 AND role = 'manager' AND is_active)))`;

/** How many deadline changes, deferrals and blocks are waiting for this person's decision. */
export async function waitingForDecision(user, runner = { query }) {
  const all = hasPermission(user, 'task.edit.any');
  const { rows } = await runner.query(
    `SELECT
       (SELECT COUNT(*)::int FROM task_deadline_changes c JOIN tasks t ON t.id = c.task_id
         WHERE c.status = 'PENDING' AND ${APPROVER_SQL}) AS changes,
       (SELECT COUNT(*)::int FROM task_blocks b JOIN tasks t ON t.id = b.task_id
         WHERE b.status = 'PENDING' AND ${APPROVER_SQL}) AS blocks`,
    [user.id, all],
  );
  let appeals = 0;
  if (hasPermission(user, 'blackmark.waive')) {
    const { rows: a } = await runner.query(`SELECT COUNT(*)::int AS n FROM black_mark_appeals WHERE status = 'OPEN' AND user_id <> $1`, [user.id]);
    appeals = a[0].n;
  }
  return { changes: rows[0].changes, blocks: rows[0].blocks, appeals };
}

/** The departments a person manages (for scoping review screens and shared views). */
export async function managedDepartmentIds(user, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT department_id AS id FROM attendance_team_access WHERE manager_id = $1
     UNION SELECT department_id FROM users WHERE id = $1 AND role = 'manager' AND department_id IS NOT NULL`,
    [user.id],
  );
  return rows.map((r) => r.id);
}

/** People whose reporting manager this person is. */
export async function directReports(userId, runner = { query }) {
  const { rows } = await runner.query('SELECT user_id AS id FROM employee_work_profiles WHERE reporting_manager_id = $1', [userId]);
  return rows.map((r) => r.id);
}
