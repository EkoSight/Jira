/**
 * Projects: a department's goal-shaped pieces of work, with a lead, members,
 * milestones and tasks.
 *
 * Each relationship is stored once (tasks.project_id, tasks.milestone_id,
 * project_members, …). A project's numbers — progress, overdue, health, the
 * next milestone — are worked out here when read, from the tasks the viewer
 * can see, so every count equals the list it summarises.
 */
import { query, withTransaction } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { logActivity, notify } from '../activity.js';
import { canEditTask, taskVisibilitySql } from '../taskAccess.js';
import { deadlineClock } from '../deadlines.js';
import { addDays, healthOf } from '../../../../shared/deadlineHealth.js';

export const PROJECT_STATUSES = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
export const OPEN_STATUSES = ['PLANNED', 'ACTIVE', 'ON_HOLD'];
export const STATUS_LABEL = { PLANNED: 'Planned', ACTIVE: 'Active', ON_HOLD: 'On hold', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
export const HEALTH_LABEL = { ON_TRACK: 'On track', AT_RISK: 'At risk', OFF_TRACK: 'Off track' };

const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- who may do what

/**
 * The projects `user` may see: everyone with task.view.all; the owning
 * department; members; anyone with a task in it (assignee, follower or
 * tagged); everyone, for a project marked "Everyone in the company".
 */
export function projectVisibilitySql(user, params, alias = 'p') {
  if (hasPermission(user, 'task.view.all')) return '1=1';
  params.push(user.id, user.department_id);
  const uid = `$${params.length - 1}`;
  const dept = `$${params.length}`;
  return `(
    ${alias}.visibility = 'EVERYONE'
    OR ${alias}.department_id = ${dept}
    OR ${alias}.lead_user_id = ${uid}
    OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${alias}.id AND pm.user_id = ${uid})
    OR EXISTS (SELECT 1 FROM tasks pt WHERE pt.project_id = ${alias}.id AND pt.is_archived = FALSE
                 AND (pt.assignee_id = ${uid} OR pt.follower_id = ${uid}
                      OR EXISTS (SELECT 1 FROM task_collaborators ptc WHERE ptc.task_id = pt.id AND ptc.user_id = ${uid})))
  )`;
}

export async function canSeeProject(user, id) {
  const params = [Number(id)];
  const visible = projectVisibilitySql(user, params);
  const { rows } = await query(`SELECT 1 FROM projects p WHERE p.id = $1 AND ${visible}`, params);
  return rows.length > 0;
}

/** Managers and above create projects in their own department; admins in any. */
export function canCreateProjectIn(user, departmentId) {
  if (hasPermission(user, 'project.manage.any')) return true;
  return hasPermission(user, 'project.create') && Number(departmentId) === Number(user.department_id);
}

/** Edit a project: admins any; managers their department's; the lead their own. */
export function canManageProject(user, project) {
  if (!project) return false;
  if (hasPermission(user, 'project.manage.any')) return true;
  if (project.lead_user_id === user.id) return true;
  return hasPermission(user, 'project.create') && project.department_id === user.department_id;
}

/** The project row if `user` may see it, else 404 (never says it exists). */
export async function visibleProject(user, id) {
  const params = [Number(id)];
  const visible = projectVisibilitySql(user, params);
  const { rows } = await query(`SELECT p.* FROM projects p WHERE p.id = $1 AND ${visible}`, params);
  if (!rows[0]) throw notFound('Project not found');
  return rows[0];
}

export async function manageableProject(user, id) {
  const project = await visibleProject(user, id);
  if (!canManageProject(user, project)) throw forbidden('Only the project\'s lead, its department\'s managers or an admin can change it');
  return project;
}

/** The project's history, in order. */
export async function projectActivity(client, { projectId, actorId, action, taskId = null, detail = {} }) {
  await (client || { query }).query(
    'INSERT INTO project_activity (project_id, actor_id, action, task_id, detail) VALUES ($1, $2, $3, $4, $5)',
    [projectId, actorId || null, action, taskId, JSON.stringify(detail)],
  );
}

// ---------------------------------------------------------------- the numbers

/**
 * A project's health from its tasks (active projects only), with the reason
 * in words. No scores: the first rule that applies, in this order.
 */
export function healthFromTasks(project, stats, milestones, c) {
  if (project.status !== 'ACTIVE') return null;
  const today = c.today;
  const target = dayOf(project.target_date);
  if (target && target < today) return { code: 'OFF_TRACK', why: `Past its target date (${target}) and not complete` };
  const late = milestones.find((m) => !m.reached_at && m.target_date && dayOf(m.target_date) < today && m.open > 0);
  if (late) return { code: 'OFF_TRACK', why: `Milestone "${late.name}" is past its date with ${plural(late.open, 'open task')}` };
  if (stats.overdue > 0) return { code: 'AT_RISK', why: `${plural(stats.overdue, 'overdue task')}` };
  const soon = milestones.find((m) => !m.reached_at && m.target_date && dayOf(m.target_date) >= today
    && dayOf(m.target_date) <= addDays(today, 3) && m.open > 0);
  if (soon) return { code: 'AT_RISK', why: `Milestone "${soon.name}" is due ${dayOf(soon.target_date)} with ${plural(soon.open, 'open task')}` };
  return { code: 'ON_TRACK', why: 'No overdue tasks and no late milestones' };
}

const emptyStats = () => ({ total: 0, done: 0, open: 0, overdue: 0, unassigned: 0, progress: 0 });
function addTask(stats, t, c) {
  if (t.stage === 'cancelled') return;
  stats.total += 1;
  if (t.stage === 'done') { stats.done += 1; return; }
  stats.open += 1;
  if (!t.assignee_id) stats.unassigned += 1;
  if (healthOf(t, c).code === 'OVERDUE') stats.overdue += 1;
}
const finish = (s) => ({ ...s, progress: s.total ? Math.round((s.done / s.total) * 100) : 0 });

/**
 * The numbers of these projects, from the tasks `user` can see. Progress is
 * done ÷ (all − cancelled − archived). Returns a Map of project id → numbers.
 */
export async function projectNumbers(user, projects, { c = null } = {}) {
  const out = new Map();
  if (!projects.length) return out;
  const clock = c || await deadlineClock();
  const ids = projects.map((p) => p.id);
  const params = [ids];
  const visible = taskVisibilitySql(user, params);
  const { rows: tasks } = await query(
    `SELECT t.id, t.project_id, t.milestone_id, t.assignee_id, t.due_date, t.review_date, t.deferral_id, s.stage
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.project_id = ANY($1::int[]) AND t.is_archived = FALSE AND ${visible}`,
    params,
  );
  const { rows: milestones } = await query(
    `SELECT * FROM project_milestones WHERE project_id = ANY($1::int[]) ORDER BY position, target_date NULLS LAST, id`,
    [ids],
  );
  const { rows: updates } = await query(
    `SELECT DISTINCT ON (u.project_id) u.*, a.full_name AS author_name
       FROM project_updates u LEFT JOIN users a ON a.id = u.author_id
      WHERE u.project_id = ANY($1::int[]) ORDER BY u.project_id, u.created_at DESC, u.id DESC`,
    [ids],
  );
  const latest = new Map(updates.map((u) => [u.project_id, u]));
  for (const project of projects) {
    const stats = emptyStats();
    const ms = milestones.filter((m) => m.project_id === project.id).map((m) => ({ ...m, stats: emptyStats() }));
    const byId = new Map(ms.map((m) => [m.id, m]));
    for (const t of tasks.filter((x) => x.project_id === project.id)) {
      addTask(stats, t, clock);
      if (t.milestone_id && byId.has(t.milestone_id)) addTask(byId.get(t.milestone_id).stats, t, clock);
    }
    const milestonesOut = ms.map((m) => ({ ...m, target_date: dayOf(m.target_date), stats: finish(m.stats), open: m.stats.open }));
    const next = milestonesOut.find((m) => !m.reached_at) || null;
    const update = latest.get(project.id) || null;
    out.set(project.id, {
      ...finish(stats),
      milestones: milestonesOut.map(({ open, ...m }) => m),
      next_milestone: next && { id: next.id, name: next.name, target_date: next.target_date, open: next.stats.open },
      health_from_tasks: healthFromTasks(project, stats, milestonesOut, clock),
      lead_update: update && { health: update.health, note: update.note, at: update.created_at, author_name: update.author_name, author_id: update.author_id },
      update_age_days: update ? Math.floor((clock.now.getTime() - new Date(update.created_at).getTime()) / 86_400_000) : null,
    });
  }
  return out;
}

/** The SELECT a project list and page use: names alongside the row. */
export const PROJECT_SELECT = `
  SELECT p.*, d.name AS department_name, d.key AS department_key, d.color AS department_color,
         l.full_name AS lead_name, l.avatar_color AS lead_color, l.is_active AS lead_active,
         (SELECT COUNT(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS member_count
    FROM projects p
    JOIN departments d ON d.id = p.department_id
    JOIN users l ON l.id = p.lead_user_id
`;

/** Projects `user` can see, with their numbers, filtered as asked. */
export async function listProjects(user, q = {}) {
  const params = [];
  const where = [projectVisibilitySql(user, params), 'p.archived_at IS NULL'];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  if (q.department_id) where.push(`p.department_id = ${push(Number(q.department_id))}`);
  if (q.lead_id) where.push(`p.lead_user_id = ${push(Number(q.lead_id))}`);
  if (q.status === 'open') where.push(`p.status IN ('PLANNED', 'ACTIVE', 'ON_HOLD')`);
  else if (q.status && PROJECT_STATUSES.includes(q.status)) where.push(`p.status = ${push(q.status)}`);
  if (q.mine === 'true' || q.mine === '1') {
    const me = push(user.id);
    where.push(`(p.lead_user_id = ${me}
      OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ${me})
      OR EXISTS (SELECT 1 FROM tasks pt WHERE pt.project_id = p.id AND pt.is_archived = FALSE
                   AND (pt.assignee_id = ${me} OR pt.follower_id = ${me}
                        OR EXISTS (SELECT 1 FROM task_collaborators ptc WHERE ptc.task_id = pt.id AND ptc.user_id = ${me}))))`);
  }
  if (q.search) where.push(`p.name ILIKE ${push(`%${q.search}%`)}`);
  const { rows } = await query(
    `${PROJECT_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY d.position, d.name, CASE p.status WHEN 'ACTIVE' THEN 0 WHEN 'PLANNED' THEN 1 WHEN 'ON_HOLD' THEN 2 ELSE 3 END, p.target_date NULLS LAST, p.name`,
    params,
  );
  const numbers = await projectNumbers(user, rows);
  return rows.map((p) => ({ ...p, ...shape(p), numbers: numbers.get(p.id), can_manage: canManageProject(user, p) }));
}

/** Plain dates for the screen. */
const shape = (p) => ({ start_date: dayOf(p.start_date), target_date: dayOf(p.target_date) });
export const projectShape = shape;

/**
 * Task rows carry their project's and milestone's names. Someone can see a
 * task (through its department) without being able to see its project; for
 * them the project is left out, so its name never reaches them.
 */
export async function maskProjects(user, rows) {
  const ids = [...new Set(rows.map((r) => r.project_id).filter(Boolean))];
  if (!ids.length) return rows;
  const params = [ids];
  const visible = projectVisibilitySql(user, params);
  const { rows: seen } = await query(`SELECT p.id FROM projects p WHERE p.id = ANY($1::int[]) AND ${visible}`, params);
  const ok = new Set(seen.map((r) => r.id));
  return rows.map((r) => (r.project_id && !ok.has(r.project_id)
    ? { ...r, project_id: null, project_name: null, project_status: null, milestone_id: null, milestone_name: null, project_hidden: true }
    : r));
}

/**
 * A new task's place in a project: set when it is created (no move to
 * record), with the engagement sync rule and the project's history.
 */
export async function placeNewTask(client, { task, projectId, milestoneId = null, actor }) {
  if (!projectId) return;
  const { rows } = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = rows[0];
  if (!project || project.archived_at) throw notFound('Project not found');
  if (!OPEN_STATUSES.includes(project.status)) {
    throw conflict(`This project is ${STATUS_LABEL[project.status].toLowerCase()}. Reopen it before adding tasks.`, { code: 'PROJECT_CLOSED' });
  }
  if (milestoneId) {
    const { rows: m } = await client.query('SELECT project_id FROM project_milestones WHERE id = $1', [milestoneId]);
    if (m[0]?.project_id !== projectId) throw badRequest('That milestone belongs to another project');
  }
  await client.query(
    'UPDATE tasks SET project_id = $2, milestone_id = $3, engagement_id = COALESCE(engagement_id, $4) WHERE id = $1',
    [task.id, projectId, milestoneId || null, project.engagement_id || null],
  );
  await projectActivity(client, { projectId, actorId: actor?.id, action: 'task_added', taskId: task.id, detail: { ref: task.ref, created: true } });
}

/** Whether a project's tasks may be given to this person without asking to add them (same department, or a member). */
export async function membershipQuestion(projectId, userId) {
  if (!projectId || !userId) return null;
  const { rows } = await query(
    `SELECT p.department_id AS project_department_id, u.department_id AS user_department_id, u.full_name,
            EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = u.id) AS is_member
       FROM projects p, users u WHERE p.id = $1 AND u.id = $2`,
    [projectId, userId],
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, ask: !r.is_member && r.project_department_id !== r.user_department_id };
}

// ---------------------------------------------------------------- members

export async function isMember(projectId, userId) {
  const { rows } = await query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
  return rows.length > 0;
}

export async function addMember(client, { project, userId, actor, quiet = false }) {
  const { rowCount } = await client.query(
    'INSERT INTO project_members (project_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [project.id, userId, actor?.id || null],
  );
  if (!rowCount) return false;
  await projectActivity(client, { projectId: project.id, actorId: actor?.id, action: 'member_added', detail: { user_id: userId } });
  if (!quiet && userId !== actor?.id) {
    await notify(client, { userId, type: 'project', title: `You were added to the project ${project.name}`, body: 'Members see every task in the project.' });
    await linkLatestNotification(client, userId, project.id);
  }
  return true;
}

/** Points the newest project notice for this person at the project (for the bell's link). */
async function linkLatestNotification(client, userId, projectId) {
  await client.query(
    `UPDATE notifications SET entity_type = 'PROJECT', entity_id = $2
      WHERE id = (SELECT id FROM notifications WHERE user_id = $1 AND type = 'project' ORDER BY id DESC LIMIT 1)`,
    [userId, projectId],
  );
}
export { linkLatestNotification };

// ---------------------------------------------------------------- moving tasks

/** The task and every task under it (subtasks of subtasks too). */
async function withDescendants(client, taskId) {
  const { rows } = await client.query(
    `WITH RECURSIVE tree AS (
       SELECT id, parent_task_id, project_id, milestone_id, engagement_id, ref FROM tasks WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_task_id, t.project_id, t.milestone_id, t.engagement_id, t.ref FROM tasks t JOIN tree ON t.parent_task_id = tree.id
     ) SELECT * FROM tree`,
    [taskId],
  );
  return rows;
}

/**
 * Puts a task (and its subtasks) into a project, or takes it out (projectId
 * null). The one place this happens:
 *   - a subtask always follows its parent, so moving one on its own is refused
 *   - a milestone from another project is cleared (and the result says so)
 *   - the engagement sync rule: a task joining a project with a linked
 *     engagement takes its id when it has none
 *   - both projects' activity and the task's own history record the move
 * Returns { moved: [task ids], milestone_cleared, subtasks }.
 */
export async function moveTask(client, { taskId, projectId, milestoneId, actor, allowSubtask = false }) {
  const { rows: trows } = await client.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  const task = trows[0];
  if (!task) throw notFound('Task not found');
  if (task.parent_task_id && !allowSubtask) {
    const { rows: parent } = await client.query('SELECT project_id FROM tasks WHERE id = $1', [task.parent_task_id]);
    if ((parent[0]?.project_id || null) !== (projectId || null)) {
      throw badRequest('A subtask is always in its parent\'s project. Move the parent task instead.');
    }
  }
  let project = null;
  if (projectId) {
    const { rows } = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    project = rows[0];
    if (!project || project.archived_at) throw notFound('Project not found');
    if (!OPEN_STATUSES.includes(project.status)) {
      throw conflict(`This project is ${STATUS_LABEL[project.status].toLowerCase()}. Reopen it before adding tasks.`, { code: 'PROJECT_CLOSED' });
    }
  }
  let milestone = null;
  if (milestoneId) {
    const { rows } = await client.query('SELECT * FROM project_milestones WHERE id = $1', [milestoneId]);
    milestone = rows[0];
    if (!milestone || milestone.project_id !== (projectId || null)) throw badRequest('That milestone belongs to another project');
  }
  const tree = await withDescendants(client, taskId);
  const moved = [];
  let milestoneCleared = false;
  for (const node of tree) {
    const sameProject = (node.project_id || null) === (projectId || null);
    // the task itself takes the milestone asked for; subtasks keep theirs when they stay in the same project
    let nextMilestone = node.milestone_id;
    if (node.id === task.id && milestoneId !== undefined) nextMilestone = milestoneId || null;
    else if (!sameProject) nextMilestone = null;
    if (!sameProject && node.milestone_id && nextMilestone === null) milestoneCleared = true;
    if (nextMilestone) {
      const { rows } = await client.query('SELECT project_id FROM project_milestones WHERE id = $1', [nextMilestone]);
      if (rows[0]?.project_id !== (projectId || null)) { nextMilestone = null; milestoneCleared = true; }
    }
    const engagement = project?.engagement_id && !node.engagement_id ? project.engagement_id : node.engagement_id;
    if (sameProject && (node.milestone_id || null) === (nextMilestone || null) && engagement === node.engagement_id) continue;
    await client.query(
      'UPDATE tasks SET project_id = $2, milestone_id = $3, engagement_id = $4, updated_at = now() WHERE id = $1',
      [node.id, projectId || null, nextMilestone || null, engagement || null],
    );
    if (!sameProject) {
      await logActivity(client, { taskId: node.id, actorId: actor?.id, action: 'updated', field: 'project_id', from: node.project_id, to: projectId || null });
      if (node.project_id) await projectActivity(client, { projectId: node.project_id, actorId: actor?.id, action: 'task_removed', taskId: node.id, detail: { ref: node.ref, to_project_id: projectId || null } });
      if (projectId) await projectActivity(client, { projectId, actorId: actor?.id, action: 'task_added', taskId: node.id, detail: { ref: node.ref, from_project_id: node.project_id || null } });
      moved.push(node.id);
    } else if ((node.milestone_id || null) !== (nextMilestone || null)) {
      await logActivity(client, { taskId: node.id, actorId: actor?.id, action: 'updated', field: 'milestone_id', from: node.milestone_id, to: nextMilestone || null });
    }
  }
  return { moved, milestone_cleared: milestoneCleared, subtasks: tree.length - 1 };
}

/** Moves several tasks the actor may edit; tasks they cannot edit are refused, nothing is half done. */
export async function moveTasks(actor, { taskIds, projectId, milestoneId = null }) {
  return withTransaction(async (client) => {
    const results = [];
    for (const id of taskIds) {
      const { rows } = await client.query('SELECT * FROM tasks WHERE id = $1', [id]);
      if (!rows[0]) throw notFound('Task not found');
      if (!canEditTask(actor, rows[0])) throw forbidden(`You cannot edit ${rows[0].ref}, so it cannot be moved`);
      results.push(await moveTask(client, { taskId: id, projectId, milestoneId: milestoneId ?? undefined, actor }));
    }
    return {
      moved: results.flatMap((r) => r.moved),
      milestone_cleared: results.some((r) => r.milestone_cleared),
      subtasks: results.reduce((n, r) => n + r.subtasks, 0),
    };
  });
}
