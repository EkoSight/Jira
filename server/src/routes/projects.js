/**
 * Projects: list, page, create and edit, members, milestones, the lead's
 * updates, tasks in and out, and the tools for starting from what exists.
 * Who may see or change what is decided in services/projects.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { notify } from '../services/activity.js';
import { canEditTask, taskVisibilitySql } from '../services/taskAccess.js';
import { deadlineClock, withHealth } from '../services/deadlines.js';
import { getSettings } from '../services/settings.js';
import { canSee, crmScope } from '../services/sales/core.js';
import { canSeeRecord } from '../services/workspace/access.js';
import { EFFECTIVE_PROGRESS, RESULT_PROGRESS, logOkrActivity } from '../services/okr.js';
import { replanRecord } from '../services/workspace/reminders.js';
import '../services/projects/workspace.js';
import {
  HEALTH_LABEL, OPEN_STATUSES, PROJECT_SELECT, PROJECT_STATUSES, STATUS_LABEL, addMember, canCreateProjectIn,
  canManageProject, linkLatestNotification, listProjects, manageableProject, membershipQuestion, moveTask, moveTasks, projectActivity,
  projectNumbers, projectShape, projectVisibilitySql, visibleProject,
} from '../services/projects/index.js';

const router = Router();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-01-31').nullable().optional();
const id = (v) => Number(v);

const projectInput = z.object({
  name: z.string().trim().min(3, 'Give the project a name of at least 3 characters').max(160),
  done_looks_like: z.string().max(4000).nullable().optional(),
  department_id: z.number().int().positive(),
  lead_user_id: z.number().int().positive(),
  status: z.enum(PROJECT_STATUSES).optional(),
  visibility: z.enum(['DEPARTMENT', 'EVERYONE']).optional(),
  start_date: date,
  target_date: date,
  member_ids: z.array(z.number().int().positive()).max(200).optional(),
  // started from a won deal or a selected application
  opportunity_id: z.number().int().positive().nullable().optional(),
  // the colour of its stamps in the notebook; none means the department's colour
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Choose a colour like #2A78D6').nullable().optional(),
});

/** People named on a project must be active accounts. */
async function activeUser(userId, what) {
  const { rows } = await query('SELECT id, full_name, department_id, is_active FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !rows[0].is_active) throw badRequest(`The ${what} must be an active person`);
  return rows[0];
}

async function activeDepartment(departmentId) {
  const { rows } = await query('SELECT id, is_active FROM departments WHERE id = $1', [departmentId]);
  if (!rows[0]) throw badRequest('That department does not exist');
  if (!rows[0].is_active) throw badRequest('That department is no longer active, so it cannot get new projects');
}

/** Its reminders are planned afresh after a change (an old date or lead is cancelled). */
const replan = (projectId) => replanRecord('PROJECT', projectId).catch((err) => console.error('[taskflow] project replan failed:', err.message));

/** One project, shaped for its page: numbers from what this person can see. */
async function projectPage(user, project) {
  const numbers = (await projectNumbers(user, [project])).get(project.id);
  const [members, contributors, updates] = await Promise.all([
    query(
      `SELECT u.id, u.full_name, u.avatar_color, u.is_active, d.name AS department_name, pm.added_at,
              (u.id = $2) AS is_lead
         FROM project_members pm JOIN users u ON u.id = pm.user_id LEFT JOIN departments d ON d.id = u.department_id
        WHERE pm.project_id = $1 ORDER BY (u.id = $2) DESC, u.full_name`,
      [project.id, project.lead_user_id],
    ),
    // people with work in it, and how much of it is open and overdue (from what this person can see)
    (async () => {
      const params = [project.id];
      const visible = taskVisibilitySql(user, params);
      const { rows } = await query(
        `SELECT t.assignee_id, t.due_date, t.review_date, t.deferral_id, s.stage, u.full_name, u.avatar_color
           FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.project_id = $1 AND t.is_archived = FALSE AND ${visible}`,
        params,
      );
      const c = await deadlineClock();
      const by = new Map();
      for (const t of withHealth(rows, c)) {
        if (!t.assignee_id) continue;
        const p = by.get(t.assignee_id) || { id: t.assignee_id, full_name: t.full_name, avatar_color: t.avatar_color, open: 0, overdue: 0, done: 0 };
        if (t.stage === 'done') p.done += 1;
        else if (t.stage !== 'cancelled') { p.open += 1; if (t.health?.code === 'OVERDUE') p.overdue += 1; }
        by.set(t.assignee_id, p);
      }
      return [...by.values()].sort((a, b) => b.open - a.open || a.full_name.localeCompare(b.full_name));
    })(),
    query(
      `SELECT u.*, a.full_name AS author_name FROM project_updates u LEFT JOIN users a ON a.id = u.author_id
        WHERE u.project_id = $1 ORDER BY u.created_at DESC, u.id DESC LIMIT 50`,
      [project.id],
    ),
  ]);
  const { rows: full } = await query(`${PROJECT_SELECT} WHERE p.id = $1`, [project.id]);
  return {
    project: { ...full[0], ...projectShape(full[0]) },
    links: await projectLinks(user, full[0]),
    numbers,
    members: members.rows,
    contributors,
    updates: updates.rows,
    can_manage: canManageProject(user, full[0]),
    can_add_tasks: OPEN_STATUSES.includes(project.status) && hasPermission(user, 'task.create'),
    labels: { status: STATUS_LABEL, health: HEALTH_LABEL },
  };
}

/**
 * What the project is linked to, each shown only to people who may see it:
 * the key results it supports (Goals), the deal or application it came from
 * and the CRM delivery record (CRM), and its meetings.
 */
async function projectLinks(user, project) {
  const s = await getSettings();
  const okrOn = s.okr?.enabled !== false && hasPermission(user, 'okr.view');
  const crmOn = s.crm?.enabled !== false && hasPermission(user, 'crm.view');
  const out = { okr: okrOn, crm: crmOn, key_results: [], origin: null, engagement: null, meetings: [], engagement_tasks_outside: [] };
  if (okrOn) {
    const { rows } = await query(
      `SELECT kr.id, kr.title, kr.measurement_type, kr.status, kr.unit, o.id AS objective_id, o.title AS objective_title,
              ROUND(${EFFECTIVE_PROGRESS})::int AS progress,
              (SELECT COUNT(*)::int FROM task_key_result_links l JOIN tasks t ON t.id = l.task_id
                WHERE l.key_result_id = kr.id AND t.project_id = $1 AND t.is_archived = FALSE) AS project_tasks_linked
         FROM project_key_result_links pk JOIN key_results kr ON kr.id = pk.key_result_id JOIN objectives o ON o.id = kr.objective_id
        WHERE pk.project_id = $1 AND kr.is_archived = FALSE AND o.is_archived = FALSE ORDER BY o.title, kr.title`,
      [project.id],
    );
    out.key_results = rows;
  }
  if (crmOn && (project.opportunity_id || project.engagement_id)) {
    const scope = await crmScope(user);
    if (project.opportunity_id && await canSee(scope, 'opportunity', project.opportunity_id)) {
      const { rows } = await query(
        `SELECT o.id, o.name, o.status, o.account_id, st.name AS stage_name, a.name AS account_name, pl.category
           FROM opportunities o JOIN accounts a ON a.id = o.account_id LEFT JOIN account_stages st ON st.id = o.stage_id
           LEFT JOIN crm_pipelines pl ON pl.id = o.pipeline_id WHERE o.id = $1`,
        [project.opportunity_id],
      );
      if (rows[0]) out.origin = { ...rows[0], is_application: rows[0].category === 'APPLICATIONS' };
    }
    if (project.engagement_id) {
      const { rows } = await query('SELECT id, name, state, account_id FROM engagements WHERE id = $1', [project.engagement_id]);
      if (rows[0] && await canSee(scope, 'account', rows[0].account_id)) {
        const { rows: ms } = await query(
          `SELECT id, title, due_date, status, accepted_at FROM engagement_milestones WHERE engagement_id = $1 ORDER BY position, due_date NULLS LAST, id`,
          [rows[0].id],
        );
        out.engagement = { ...rows[0], milestones: ms };
        // its tasks that are not in this project: offered, never added by themselves
        const params = [rows[0].id, project.id];
        const visible = taskVisibilitySql(user, params);
        const { rows: outside } = await query(
          `SELECT t.id, t.ref, t.title FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
            WHERE t.engagement_id = $1 AND t.project_id IS DISTINCT FROM $2 AND t.is_archived = FALSE
              AND s.stage NOT IN ('done', 'cancelled') AND t.parent_task_id IS NULL AND ${visible}
            ORDER BY t.id LIMIT 50`,
          params,
        );
        out.engagement_tasks_outside = outside;
      }
    }
  }
  const { rows: meetings } = await query(
    `SELECT id, title, status, scheduled_at, arrange_by FROM crm_meetings WHERE project_id = $1 ORDER BY COALESCE(scheduled_at, arrange_by::timestamptz) DESC NULLS LAST, id DESC LIMIT 100`,
    [project.id],
  );
  for (const m of meetings) if (await canSeeRecord(user, 'MEETING', m.id, s)) out.meetings.push(m);
  return out;
}

// ---------------------------------------------------------------- list and options

router.get('/', asyncHandler(async (req, res) => {
  const projects = await listProjects(req.currentUser, req.query);
  res.json({
    projects,
    can_create: hasPermission(req.currentUser, 'project.create') || hasPermission(req.currentUser, 'project.manage.any'),
    labels: { status: STATUS_LABEL, health: HEALTH_LABEL },
  });
}));

/** For pickers (the task dialog): open projects this person can see, with their milestones. */
router.get('/options', asyncHandler(async (req, res) => {
  const params = [];
  const visible = projectVisibilitySql(req.currentUser, params);
  const { rows } = await query(
    `SELECT p.id, p.name, p.status, p.department_id, d.name AS department_name, d.color AS department_color
       FROM projects p JOIN departments d ON d.id = p.department_id
      WHERE ${visible} AND p.archived_at IS NULL AND p.status IN ('PLANNED', 'ACTIVE', 'ON_HOLD')
      ORDER BY d.position, d.name, p.name`,
    params,
  );
  const ids = rows.map((r) => r.id);
  const { rows: ms } = ids.length
    ? await query(`SELECT id, project_id, name, target_date, reached_at FROM project_milestones WHERE project_id = ANY($1::int[]) ORDER BY position, target_date NULLS LAST, id`, [ids])
    : { rows: [] };
  // the key results each supports, for "Also link this key result?" in the task dialog
  const s = await getSettings();
  const okrOn = s.okr?.enabled !== false && hasPermission(req.currentUser, 'okr.view') && hasPermission(req.currentUser, 'okr.link.task');
  const { rows: krs } = ids.length && okrOn
    ? await query(
      `SELECT pk.project_id, kr.id, kr.title, o.title AS objective_title FROM project_key_result_links pk
         JOIN key_results kr ON kr.id = pk.key_result_id JOIN objectives o ON o.id = kr.objective_id
        WHERE pk.project_id = ANY($1::int[]) AND kr.is_archived = FALSE AND o.is_archived = FALSE`,
      [ids],
    )
    : { rows: [] };
  res.json({
    projects: rows.map((p) => ({
      ...p,
      milestones: ms.filter((m) => m.project_id === p.id),
      key_results: krs.filter((k) => k.project_id === p.id).map(({ project_id, ...k }) => k),
    })),
  });
}));

// ---------------------------------------------------------------- create

router.post('/', asyncHandler(async (req, res) => {
  const data = projectInput.parse(req.body);
  if (!canCreateProjectIn(req.currentUser, data.department_id)) {
    throw forbidden(hasPermission(req.currentUser, 'project.create')
      ? 'You can create projects in your own department only'
      : 'Managers and above create projects');
  }
  await activeDepartment(data.department_id);
  await activeUser(data.lead_user_id, 'lead');
  if (data.start_date && data.target_date && data.target_date < data.start_date) throw badRequest('The target date is before the start date');
  if (data.opportunity_id) await wonDeal(req.currentUser, data.opportunity_id);
  const project = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO projects (name, done_looks_like, department_id, lead_user_id, status, visibility, start_date, target_date, created_by, opportunity_id, color)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'PLANNED'), COALESCE($6, 'DEPARTMENT'), $7, $8, $9, $10, $11) RETURNING *`,
      [data.name, data.done_looks_like || null, data.department_id, data.lead_user_id, data.status || null,
        data.visibility || null, data.start_date || null, data.target_date || null, req.currentUser.id, data.opportunity_id || null, data.color || null],
    );
    const p = rows[0];
    await projectActivity(client, { projectId: p.id, actorId: req.currentUser.id, action: 'created', detail: { name: p.name } });
    // the lead is always a member
    await addMember(client, { project: p, userId: p.lead_user_id, actor: req.currentUser, quiet: true });
    for (const userId of new Set(data.member_ids || [])) {
      await activeUser(userId, 'member');
      await addMember(client, { project: p, userId, actor: req.currentUser });
    }
    if (p.lead_user_id !== req.currentUser.id) {
      await notify(client, { userId: p.lead_user_id, type: 'project', title: `You lead the project ${p.name}`, body: 'You were made its lead.' });
      await linkLatestNotification(client, p.lead_user_id, p.id);
    }
    return p;
  });
  await replan(project.id);
  res.status(201).json(await projectPage(req.currentUser, project));
}));

// ---------------------------------------------------------------- the page

router.get('/:id', asyncHandler(async (req, res) => {
  const project = await visibleProject(req.currentUser, id(req.params.id));
  res.json(await projectPage(req.currentUser, project));
}));

router.get('/:id/activity', asyncHandler(async (req, res) => {
  const project = await visibleProject(req.currentUser, id(req.params.id));
  const params = [project.id];
  const visible = taskVisibilitySql(req.currentUser, params);
  // a task line names the task only when this person can see it
  const { rows } = await query(
    `SELECT a.id, a.action, a.detail, a.created_at, a.actor_id, u.full_name AS actor_name, u.avatar_color,
            CASE WHEN a.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = a.task_id AND ${visible}) THEN a.task_id END AS task_id,
            CASE WHEN a.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = a.task_id AND ${visible})
                 THEN (SELECT ref || ' ' || title FROM tasks WHERE id = a.task_id) END AS task_label
       FROM project_activity a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.project_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    params,
  );
  res.json({ activity: rows });
}));

// ---------------------------------------------------------------- edit

const editInput = projectInput.partial().extend({
  // the CRM's delivery record for a won deal (one each way); null unlinks
  engagement_id: z.number().int().positive().nullable().optional(),
  // completing or cancelling with open tasks: what happens to each, chosen by the person
  open_task_actions: z.array(z.object({
    task_id: z.number().int().positive(),
    action: z.enum(['KEEP', 'MOVE', 'REMOVE']),
    to_project_id: z.number().int().positive().optional(),
  })).optional(),
});

router.patch('/:id', asyncHandler(async (req, res) => {
  const data = editInput.parse(req.body);
  const project = await manageableProject(req.currentUser, id(req.params.id));
  if (data.department_id && data.department_id !== project.department_id) {
    if (!canCreateProjectIn(req.currentUser, data.department_id)) throw forbidden('You cannot move this project to that department');
    await activeDepartment(data.department_id);
  }
  if (data.lead_user_id && data.lead_user_id !== project.lead_user_id) await activeUser(data.lead_user_id, 'lead');
  if (data.engagement_id) {
    const { rows: e } = await query('SELECT id, account_id FROM engagements WHERE id = $1', [data.engagement_id]);
    const s = await getSettings();
    if (!e[0] || s.crm?.enabled === false || !hasPermission(req.currentUser, 'crm.view') || !(await canSee(await crmScope(req.currentUser), 'account', e[0].account_id))) {
      throw notFound('Delivery record not found');
    }
    const { rows: taken } = await query('SELECT id, name FROM projects WHERE engagement_id = $1 AND id <> $2', [data.engagement_id, project.id]);
    if (taken[0]) throw conflict(`That delivery record is already linked to the project ${taken[0].name}`);
  }
  if (data.opportunity_id) await wonDeal(req.currentUser, data.opportunity_id);
  const start = data.start_date !== undefined ? data.start_date : projectShape(project).start_date;
  const target = data.target_date !== undefined ? data.target_date : projectShape(project).target_date;
  if (start && target && target < start) throw badRequest('The target date is before the start date');

  const closing = data.status && ['COMPLETED', 'CANCELLED'].includes(data.status) && !['COMPLETED', 'CANCELLED'].includes(project.status);
  let openTasks = [];
  if (closing) {
    const { rows } = await query(
      `SELECT t.id, t.ref, t.title FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
        WHERE t.project_id = $1 AND t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled') ORDER BY t.id`,
      [project.id],
    );
    openTasks = rows;
    const chosen = new Map((data.open_task_actions || []).map((a) => [a.task_id, a]));
    const missing = openTasks.filter((t) => !chosen.has(t.id));
    if (missing.length) {
      throw conflict(`This project still has ${missing.length} open task${missing.length === 1 ? '' : 's'}. Choose what happens to each one first.`, {
        code: 'OPEN_TASKS', open_tasks: openTasks,
      });
    }
    for (const a of chosen.values()) {
      if (a.action === 'MOVE' && !a.to_project_id) throw badRequest('Choose the project to move the task to');
    }
  }

  const updated = await withTransaction(async (client) => {
    const fields = [];
    const params = [];
    const set = (column, value) => { params.push(value); fields.push(`${column} = $${params.length}`); };
    for (const key of ['name', 'done_looks_like', 'department_id', 'lead_user_id', 'status', 'visibility', 'start_date', 'target_date', 'engagement_id', 'opportunity_id', 'color']) {
      if (data[key] !== undefined) set(key, data[key] === '' ? null : data[key]);
    }
    if (data.status === 'COMPLETED' && project.status !== 'COMPLETED') fields.push('completed_at = now()');
    if (data.status && data.status !== 'COMPLETED' && project.status === 'COMPLETED') fields.push('completed_at = NULL');
    let row = project;
    if (fields.length) {
      params.push(project.id);
      ({ rows: [row] } = await client.query(`UPDATE projects SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params));
    }
    if (closing) {
      for (const a of data.open_task_actions || []) {
        if (!openTasks.some((t) => t.id === a.task_id)) continue;
        if (a.action === 'MOVE') {
          const { rows: target } = await client.query('SELECT * FROM projects WHERE id = $1', [a.to_project_id]);
          if (!target[0] || !(await canSeeProjectTx(client, req.currentUser, a.to_project_id))) throw notFound('Project not found');
          await moveTask(client, { taskId: a.task_id, projectId: a.to_project_id, actor: req.currentUser, allowSubtask: true });
        } else if (a.action === 'REMOVE') {
          await moveTask(client, { taskId: a.task_id, projectId: null, actor: req.currentUser, allowSubtask: true });
        } else {
          await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'task_kept_open', taskId: a.task_id });
        }
      }
    }
    if (data.engagement_id !== undefined && (data.engagement_id || null) !== (project.engagement_id || null)) {
      await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: data.engagement_id ? 'engagement_linked' : 'engagement_unlinked' });
    }
    for (const key of ['name', 'department_id', 'lead_user_id', 'status', 'visibility', 'start_date', 'target_date']) {
      if (data[key] === undefined) continue;
      const before = key.endsWith('_date') ? projectShape(project)[key] : project[key];
      if (String(before ?? '') === String(data[key] ?? '')) continue;
      await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'changed', detail: { field: key, from: before ?? null, to: data[key] ?? null } });
    }
    if (data.lead_user_id && data.lead_user_id !== project.lead_user_id) {
      await addMember(client, { project: row, userId: data.lead_user_id, actor: req.currentUser, quiet: true });
      if (data.lead_user_id !== req.currentUser.id) {
        await notify(client, { userId: data.lead_user_id, type: 'project', title: `You lead the project ${row.name}`, body: 'You were made its lead.' });
        await linkLatestNotification(client, data.lead_user_id, row.id);
      }
    }
    if (data.status && data.status !== project.status) {
      const { rows: members } = await client.query('SELECT user_id FROM project_members WHERE project_id = $1', [project.id]);
      for (const m of members) {
        if (m.user_id === req.currentUser.id) continue;
        await notify(client, { userId: m.user_id, type: 'project', title: `${row.name} is now ${STATUS_LABEL[data.status].toLowerCase()}`, body: `Changed by ${req.currentUser.full_name}` });
        await linkLatestNotification(client, m.user_id, row.id);
      }
    }
    return row;
  });
  await replan(updated.id);
  res.json(await projectPage(req.currentUser, updated));
}));

async function canSeeProjectTx(client, user, projectId) {
  const params = [projectId];
  const visible = projectVisibilitySql(user, params);
  const { rows } = await client.query(`SELECT 1 FROM projects p WHERE p.id = $1 AND ${visible}`, params);
  return rows.length > 0;
}

/** On hold: the open tasks with their deadlines, so the lead can reschedule them through the normal flow. */
router.get('/:id/open-tasks', asyncHandler(async (req, res) => {
  const project = await visibleProject(req.currentUser, id(req.params.id));
  const params = [project.id];
  const visible = taskVisibilitySql(req.currentUser, params);
  const { rows } = await query(
    `SELECT t.id, t.ref, t.title, t.due_date, t.assignee_id, u.full_name AS assignee_name, s.stage, t.review_date, t.deferral_id
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = $1 AND t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled') AND ${visible}
      ORDER BY t.due_date NULLS LAST, t.id`,
    params,
  );
  res.json({ tasks: withHealth(rows, await deadlineClock()) });
}));

// ---------------------------------------------------------------- members

/**
 * Whether giving this project's task to this person should ask "Add them to
 * the project?" (someone from another department who is not a member).
 */
router.get('/:id/member-check', asyncHandler(async (req, res) => {
  const project = await visibleProject(req.currentUser, id(req.params.id));
  const userId = Number(req.query.user_id);
  if (!userId) throw badRequest('Say who');
  res.json(await membershipQuestion(project.id, userId) || { ask: false });
}));

router.post('/:id/members', asyncHandler(async (req, res) => {
  const { user_id: userId } = z.object({ user_id: z.number().int().positive() }).parse(req.body);
  const project = await manageableProject(req.currentUser, id(req.params.id));
  await activeUser(userId, 'member');
  await withTransaction((client) => addMember(client, { project, userId, actor: req.currentUser }));
  res.status(201).json(await projectPage(req.currentUser, project));
}));

router.delete('/:id/members/:userId', asyncHandler(async (req, res) => {
  const project = await manageableProject(req.currentUser, id(req.params.id));
  const userId = id(req.params.userId);
  if (userId === project.lead_user_id) throw badRequest('The lead is always a member. Choose another lead first.');
  await withTransaction(async (client) => {
    const { rowCount } = await client.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [project.id, userId]);
    if (!rowCount) return;
    await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'member_removed', detail: { user_id: userId } });
    if (userId !== req.currentUser.id) {
      await notify(client, { userId, type: 'project', title: `You were removed from the project ${project.name}`, body: 'You keep seeing tasks you are on for other reasons.' });
    }
  });
  res.json(await projectPage(req.currentUser, project));
}));

// ---------------------------------------------------------------- milestones

const milestoneInput = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().max(4000).nullable().optional(),
  target_date: date,
  position: z.number().int().min(0).max(10000).optional(),
});

router.post('/:id/milestones', asyncHandler(async (req, res) => {
  const data = milestoneInput.parse(req.body);
  const project = await manageableProject(req.currentUser, id(req.params.id));
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO project_milestones (project_id, name, description, target_date, position, created_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT COALESCE(MAX(position), 0) + 10 FROM project_milestones WHERE project_id = $1)), $6) RETURNING *`,
      [project.id, data.name, data.description || null, data.target_date || null, data.position ?? null, req.currentUser.id],
    );
    await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'milestone_added', detail: { name: rows[0].name, target_date: data.target_date || null } });
  });
  await replan(project.id);
  res.status(201).json(await projectPage(req.currentUser, project));
}));

async function milestoneOf(project, milestoneId) {
  const { rows } = await query('SELECT * FROM project_milestones WHERE id = $1 AND project_id = $2', [milestoneId, project.id]);
  if (!rows[0]) throw notFound('Milestone not found');
  return rows[0];
}

router.patch('/:id/milestones/:mid', asyncHandler(async (req, res) => {
  const data = milestoneInput.partial().extend({ reached: z.boolean().optional() }).parse(req.body);
  const project = await manageableProject(req.currentUser, id(req.params.id));
  const m = await milestoneOf(project, id(req.params.mid));
  await withTransaction(async (client) => {
    const fields = [];
    const params = [];
    const set = (column, value) => { params.push(value); fields.push(`${column} = $${params.length}`); };
    for (const key of ['name', 'description', 'target_date', 'position']) if (data[key] !== undefined) set(key, data[key] === '' ? null : data[key]);
    // "Reached" is marked by a person, never worked out
    if (data.reached === true && !m.reached_at) { fields.push('reached_at = now()'); set('reached_by', req.currentUser.id); }
    if (data.reached === false && m.reached_at) fields.push('reached_at = NULL', 'reached_by = NULL');
    if (!fields.length) return;
    params.push(m.id);
    await client.query(`UPDATE project_milestones SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
    const action = data.reached === true ? 'milestone_reached' : data.reached === false ? 'milestone_reopened' : 'milestone_changed';
    await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action, detail: { name: data.name || m.name } });
  });
  await replan(project.id);
  res.json(await projectPage(req.currentUser, project));
}));

router.delete('/:id/milestones/:mid', asyncHandler(async (req, res) => {
  const project = await manageableProject(req.currentUser, id(req.params.id));
  const m = await milestoneOf(project, id(req.params.mid));
  await withTransaction(async (client) => {
    // its tasks stay as they are, only without the milestone
    const { rows } = await client.query('UPDATE tasks SET milestone_id = NULL WHERE milestone_id = $1 RETURNING id', [m.id]);
    await client.query('DELETE FROM project_milestones WHERE id = $1', [m.id]);
    await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'milestone_removed', detail: { name: m.name, tasks_cleared: rows.length } });
  });
  await replan(project.id);
  res.json(await projectPage(req.currentUser, project));
}));

// ---------------------------------------------------------------- the lead's updates

router.post('/:id/updates', asyncHandler(async (req, res) => {
  const data = z.object({
    health: z.enum(['ON_TRACK', 'AT_RISK', 'OFF_TRACK']),
    note: z.string().trim().min(3, 'Say a few words about how it is going').max(4000),
  }).parse(req.body);
  const project = await visibleProject(req.currentUser, id(req.params.id));
  // the lead's own word: the lead posts it (an admin may, to cover)
  if (project.lead_user_id !== req.currentUser.id && !hasPermission(req.currentUser, 'project.manage.any')) {
    throw forbidden('Only the project\'s lead posts its updates');
  }
  await withTransaction(async (client) => {
    await client.query('INSERT INTO project_updates (project_id, author_id, health, note) VALUES ($1, $2, $3, $4)', [project.id, req.currentUser.id, data.health, data.note]);
    await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'update_posted', detail: { health: data.health } });
  });
  await replan(project.id);
  res.status(201).json(await projectPage(req.currentUser, project));
}));

// ---------------------------------------------------------------- tasks in and out

router.post('/:id/tasks', asyncHandler(async (req, res) => {
  const data = z.object({
    task_ids: z.array(z.number().int().positive()).min(1).max(200),
    milestone_id: z.number().int().positive().nullable().optional(),
  }).parse(req.body);
  const project = await visibleProject(req.currentUser, id(req.params.id));
  const result = await moveTasks(req.currentUser, { taskIds: data.task_ids, projectId: project.id, milestoneId: data.milestone_id });
  res.json({ ...result, ...(await projectPage(req.currentUser, project)) });
}));

router.post('/:id/tasks/remove', asyncHandler(async (req, res) => {
  const data = z.object({ task_ids: z.array(z.number().int().positive()).min(1).max(200) }).parse(req.body);
  const project = await visibleProject(req.currentUser, id(req.params.id));
  const { rows } = await query('SELECT id FROM tasks WHERE id = ANY($1::int[]) AND project_id = $2', [data.task_ids, project.id]);
  if (rows.length !== data.task_ids.length) throw badRequest('Some of those tasks are not in this project');
  const result = await moveTasks(req.currentUser, { taskIds: data.task_ids, projectId: null });
  res.json({ ...result, ...(await projectPage(req.currentUser, project)) });
}));

// ---------------------------------------------------------------- starting from what exists

/** A parent task and its subtasks, as a project would be made of them. Writes nothing. */
async function parentPreview(user, taskId) {
  const params = [taskId];
  const visible = taskVisibilitySql(user, params);
  const { rows } = await query(
    `SELECT t.*, d.name AS department_name, u.full_name AS assignee_name, u.is_active AS assignee_active
       FROM tasks t JOIN departments d ON d.id = t.department_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.id = $1 AND t.is_archived = FALSE AND ${visible}`,
    params,
  );
  const parent = rows[0];
  if (!parent) throw notFound('Task not found');
  if (parent.parent_task_id) throw badRequest('This task is itself a subtask. Start from its parent.');
  if (parent.project_id) throw badRequest('This task is already in a project');
  const { rows: subtasks } = await query(
    `WITH RECURSIVE tree AS (
       SELECT id, ref, title, parent_task_id, project_id FROM tasks WHERE parent_task_id = $1 AND is_archived = FALSE
       UNION ALL SELECT t.id, t.ref, t.title, t.parent_task_id, t.project_id FROM tasks t JOIN tree ON t.parent_task_id = tree.id WHERE t.is_archived = FALSE
     ) SELECT * FROM tree ORDER BY id`,
    [parent.id],
  );
  return {
    project: {
      name: parent.title, department_id: parent.department_id, department_name: parent.department_name,
      lead_user_id: parent.assignee_active ? parent.assignee_id : null, lead_name: parent.assignee_active ? parent.assignee_name : null,
    },
    tasks: [{ id: parent.id, ref: parent.ref, title: parent.title }, ...subtasks.map((s) => ({ id: s.id, ref: s.ref, title: s.title }))],
    already_in_projects: subtasks.filter((s) => s.project_id).map((s) => s.ref),
  };
}

router.get('/from-task/:taskId/preview', asyncHandler(async (req, res) => {
  res.json(await parentPreview(req.currentUser, id(req.params.taskId)));
}));

router.post('/from-task/:taskId', asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(3).max(160).optional(), lead_user_id: z.number().int().positive().optional() }).parse(req.body || {});
  const preview = await parentPreview(req.currentUser, id(req.params.taskId));
  const departmentId = preview.project.department_id;
  if (!canCreateProjectIn(req.currentUser, departmentId)) throw forbidden('Managers and above create projects, in their own department');
  const leadId = data.lead_user_id || preview.project.lead_user_id || req.currentUser.id;
  await activeUser(leadId, 'lead');
  await activeDepartment(departmentId);
  const parentId = preview.tasks[0].id;
  const { rows: parentRow } = await query('SELECT * FROM tasks WHERE id = $1', [parentId]);
  if (!canEditTask(req.currentUser, parentRow[0])) throw forbidden('You cannot edit that task, so it cannot become a project');
  const project = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO projects (name, department_id, lead_user_id, status, created_by) VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING *`,
      [data.name || preview.project.name, departmentId, leadId, req.currentUser.id],
    );
    const p = rows[0];
    await projectActivity(client, { projectId: p.id, actorId: req.currentUser.id, action: 'created_from_task', taskId: parentId, detail: { ref: preview.tasks[0].ref } });
    await addMember(client, { project: p, userId: leadId, actor: req.currentUser, quiet: true });
    // the parent and every subtask, references unchanged
    await moveTask(client, { taskId: parentId, projectId: p.id, actor: req.currentUser });
    return p;
  });
  res.status(201).json(await projectPage(req.currentUser, project));
}));

/** Open tasks with a tag, for "Make a project from a tag". Writes nothing. */
router.get('/from-tag/preview', asyncHandler(async (req, res) => {
  const tag = String(req.query.tag || '').trim();
  if (!tag) throw badRequest('Choose a tag');
  const params = [tag];
  const visible = taskVisibilitySql(req.currentUser, params);
  const { rows } = await query(
    `SELECT t.id, t.ref, t.title, t.project_id, t.parent_task_id, t.department_id, d.name AS department_name, u.full_name AS assignee_name
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id JOIN departments d ON d.id = t.department_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE $1 = ANY(t.tags) AND t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled') AND ${visible}
      ORDER BY t.id`,
    params,
  );
  res.json({
    tag,
    tasks: rows.map((r) => ({ ...r, can_move: !r.parent_task_id && !r.project_id, why_not: r.project_id ? 'Already in a project' : r.parent_task_id ? 'A subtask moves with its parent' : null })),
  });
}));

router.post('/from-tag', asyncHandler(async (req, res) => {
  const data = z.object({
    tag: z.string().trim().min(1).max(40),
    task_ids: z.array(z.number().int().positive()).min(1).max(200),
    project_id: z.number().int().positive().optional(),
    project: projectInput.partial({ lead_user_id: true, department_id: true }).optional(),
  }).parse(req.body);
  let project;
  if (data.project_id) {
    project = await visibleProject(req.currentUser, data.project_id);
  } else {
    const p = data.project || {};
    const departmentId = p.department_id || req.currentUser.department_id;
    if (!canCreateProjectIn(req.currentUser, departmentId)) throw forbidden('Managers and above create projects, in their own department');
    await activeDepartment(departmentId);
    const leadId = p.lead_user_id || req.currentUser.id;
    await activeUser(leadId, 'lead');
    project = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO projects (name, department_id, lead_user_id, status, created_by) VALUES ($1, $2, $3, COALESCE($4, 'ACTIVE'), $5) RETURNING *`,
        [p.name || data.tag, departmentId, leadId, p.status || null, req.currentUser.id],
      );
      await projectActivity(client, { projectId: rows[0].id, actorId: req.currentUser.id, action: 'created_from_tag', detail: { tag: data.tag } });
      await addMember(client, { project: rows[0], userId: leadId, actor: req.currentUser, quiet: true });
      return rows[0];
    });
  }
  // only tasks that carry the tag, can be seen, and are not subtasks
  const params = [data.task_ids, data.tag];
  const visible = taskVisibilitySql(req.currentUser, params);
  const { rows } = await query(`SELECT t.id FROM tasks t WHERE t.id = ANY($1::int[]) AND $2 = ANY(t.tags) AND ${visible}`, params);
  if (rows.length !== data.task_ids.length) throw badRequest('Some of those tasks do not carry that tag, or cannot be seen');
  const result = await moveTasks(req.currentUser, { taskIds: data.task_ids, projectId: project.id });
  res.status(201).json({ ...result, ...(await projectPage(req.currentUser, project)) });
}));

// ---------------------------------------------------------------- deals and applications (P2)

/** A won deal or a selected application this person can see, or an error. */
async function wonDeal(user, opportunityId) {
  const s = await getSettings();
  if (s.crm?.enabled === false || !hasPermission(user, 'crm.view')) throw notFound('Deal not found');
  if (!(await canSee(await crmScope(user), 'opportunity', opportunityId))) throw notFound('Deal not found');
  const { rows } = await query(
    `SELECT o.*, u.department_id AS owner_department_id, u.is_active AS owner_active, pl.category
       FROM opportunities o LEFT JOIN users u ON u.id = o.owner_user_id LEFT JOIN crm_pipelines pl ON pl.id = o.pipeline_id
      WHERE o.id = $1`,
    [opportunityId],
  );
  const deal = rows[0];
  if (!deal) throw notFound('Deal not found');
  if (deal.status !== 'WON') throw badRequest('Only a won deal, or a selected application, starts a project');
  return deal;
}

/** "Start a project" on a won deal or selected application: the form filled in. Writes nothing. */
router.get('/from-deal/:oppId/preview', asyncHandler(async (req, res) => {
  const deal = await wonDeal(req.currentUser, id(req.params.oppId));
  const departmentId = deal.owner_department_id || req.currentUser.department_id;
  res.json({
    project: {
      name: deal.name,
      department_id: departmentId,
      lead_user_id: deal.owner_active ? deal.owner_user_id : req.currentUser.id,
      opportunity_id: deal.id,
      visibility: 'DEPARTMENT',
      status: 'ACTIVE',
    },
    is_application: deal.category === 'APPLICATIONS',
    can_create: canCreateProjectIn(req.currentUser, departmentId),
  });
}));

/** The projects a deal or application started (those this person can see). */
router.get('/for-deal/:oppId', asyncHandler(async (req, res) => {
  const s = await getSettings();
  if (s.crm?.enabled === false || !hasPermission(req.currentUser, 'crm.view')) throw notFound('Deal not found');
  if (!(await canSee(await crmScope(req.currentUser), 'opportunity', id(req.params.oppId)))) throw notFound('Deal not found');
  const params = [id(req.params.oppId)];
  const visible = projectVisibilitySql(req.currentUser, params);
  const { rows } = await query(`${PROJECT_SELECT} WHERE p.opportunity_id = $1 AND p.archived_at IS NULL AND ${visible} ORDER BY p.created_at`, params);
  const numbers = await projectNumbers(req.currentUser, rows);
  res.json({ projects: rows.map((p) => ({ ...p, ...projectShape(p), numbers: numbers.get(p.id) })) });
}));

/** The project linked to a CRM delivery record, if this person can see it. */
router.get('/for-engagement/:engId', asyncHandler(async (req, res) => {
  const params = [id(req.params.engId)];
  const visible = projectVisibilitySql(req.currentUser, params);
  const { rows } = await query(`${PROJECT_SELECT} WHERE p.engagement_id = $1 AND p.archived_at IS NULL AND ${visible}`, params);
  const numbers = await projectNumbers(req.currentUser, rows);
  res.json({ project: rows[0] ? { ...rows[0], ...projectShape(rows[0]), numbers: numbers.get(rows[0].id) } : null });
}));

// ---------------------------------------------------------------- goals (P2)

async function okrAllowed(user) {
  const s = await getSettings();
  if (s.okr?.enabled === false || !hasPermission(user, 'okr.view')) throw notFound('Goals are not available to you');
}

async function liveKeyResult(krId) {
  const { rows } = await query(
    `SELECT kr.*, o.is_archived AS objective_archived, o.title AS objective_title, ${RESULT_PROGRESS} AS result_progress
       FROM key_results kr JOIN objectives o ON o.id = kr.objective_id WHERE kr.id = $1`,
    [krId],
  );
  const kr = rows[0];
  if (!kr) throw notFound('Key result not found');
  if (kr.is_archived || kr.objective_archived) throw badRequest('That goal is archived');
  return kr;
}

/** "This project supports this key result": context only, it changes no number on the key result. */
router.post('/:id/key-results', asyncHandler(async (req, res) => {
  const { key_result_id: krId } = z.object({ key_result_id: z.number().int().positive() }).parse(req.body);
  await okrAllowed(req.currentUser);
  const project = await manageableProject(req.currentUser, id(req.params.id));
  await liveKeyResult(krId);
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'INSERT INTO project_key_result_links (project_id, key_result_id, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [project.id, krId, req.currentUser.id],
    );
    if (rowCount) await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'kr_linked', detail: { key_result_id: krId } });
  });
  res.status(201).json(await projectPage(req.currentUser, project));
}));

router.delete('/:id/key-results/:krId', asyncHandler(async (req, res) => {
  await okrAllowed(req.currentUser);
  const project = await manageableProject(req.currentUser, id(req.params.id));
  await withTransaction(async (client) => {
    const { rowCount } = await client.query('DELETE FROM project_key_result_links WHERE project_id = $1 AND key_result_id = $2', [project.id, id(req.params.krId)]);
    if (rowCount) await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'kr_unlinked', detail: { key_result_id: id(req.params.krId) } });
  });
  res.json(await projectPage(req.currentUser, project));
}));

/**
 * "Link this project's tasks to this key result": which tasks, and the key
 * result's progress before and after. Writes nothing.
 */
async function linkPreview(user, project, kr) {
  const params = [project.id, kr.id];
  const visible = taskVisibilitySql(user, params);
  const { rows: candidates } = await query(
    `SELECT t.id, t.ref, t.title, s.stage FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.project_id = $1 AND t.is_archived = FALSE AND s.stage <> 'cancelled' AND ${visible}
        AND NOT EXISTS (SELECT 1 FROM task_key_result_links l WHERE l.task_id = t.id AND l.key_result_id = $2)
      ORDER BY t.id`,
    params,
  );
  const { rows: linked } = await query(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE s.stage = 'done')::int AS done
       FROM task_key_result_links l JOIN tasks t ON t.id = l.task_id AND t.is_archived = FALSE
       JOIN workflow_statuses s ON s.id = t.status_id WHERE l.key_result_id = $1`,
    [kr.id],
  );
  const { n, done } = linked[0];
  const addDone = candidates.filter((t) => t.stage === 'done').length;
  const exec = (d, total) => (total ? Math.round((d / total) * 100) : null);
  const result = kr.result_progress === null || kr.result_progress === undefined ? null : Math.round(Number(kr.result_progress));
  const effective = (e) => (kr.measurement_type === 'TASK_ROLLUP' ? e : result ?? e);
  return {
    key_result: { id: kr.id, title: kr.title, objective_title: kr.objective_title, measurement_type: kr.measurement_type },
    tasks: candidates,
    before: { linked_tasks: n, done_tasks: done, progress: effective(exec(done, n)) },
    after: { linked_tasks: n + candidates.length, done_tasks: done + addDone, progress: effective(exec(done + addDone, n + candidates.length)) },
    // when the key result is measured on its own terms, linking work changes only the work shown beside it
    measured_on_its_own: kr.measurement_type !== 'TASK_ROLLUP' && result !== null,
  };
}

router.get('/:id/key-results/:krId/link-tasks', asyncHandler(async (req, res) => {
  await okrAllowed(req.currentUser);
  const project = await visibleProject(req.currentUser, id(req.params.id));
  const kr = await liveKeyResult(id(req.params.krId));
  res.json(await linkPreview(req.currentUser, project, kr));
}));

router.post('/:id/key-results/:krId/link-tasks', asyncHandler(async (req, res) => {
  const { task_ids: taskIds } = z.object({ task_ids: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body);
  await okrAllowed(req.currentUser);
  if (!hasPermission(req.currentUser, 'okr.link.task')) throw forbidden('Linking tasks to key results needs the goal-linking permission');
  const project = await visibleProject(req.currentUser, id(req.params.id));
  const kr = await liveKeyResult(id(req.params.krId));
  const preview = await linkPreview(req.currentUser, project, kr);
  const allowed = new Set(preview.tasks.map((t) => t.id));
  const refused = taskIds.filter((t) => !allowed.has(t));
  if (refused.length) throw badRequest('Some of those tasks are not in this project, are already linked, or cannot be seen');
  await withTransaction(async (client) => {
    for (const taskId of taskIds) {
      await client.query(
        `INSERT INTO task_key_result_links (task_id, key_result_id, is_primary, created_by) VALUES ($1, $2, FALSE, $3) ON CONFLICT DO NOTHING`,
        [taskId, kr.id, req.currentUser.id],
      );
      await logOkrActivity(client, { entityType: 'LINK', entityId: kr.id, actorId: req.currentUser.id, action: 'task_linked', meta: { task_id: taskId, key_result_id: kr.id, via_project: project.id } });
    }
    await projectActivity(client, { projectId: project.id, actorId: req.currentUser.id, action: 'kr_tasks_linked', detail: { key_result_id: kr.id, count: taskIds.length } });
  });
  res.json({ linked: taskIds.length, ...(await linkPreview(req.currentUser, project, kr)) });
}));

export default router;
