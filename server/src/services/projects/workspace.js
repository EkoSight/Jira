/**
 * Projects in My workspace: the "My projects" widget (work grouped by
 * project), the project items in Needs attention, and the three project
 * reminder rules. Imported once by routes/workspace.js so the contributor and
 * the planner register themselves.
 */
import { query } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { getSettings } from '../settings.js';
import { deadlineClock, withHealth } from '../deadlines.js';
import { addDays } from '../../../../shared/deadlineHealth.js';
import { taskVisibilitySql } from '../taskAccess.js';
import { addContributor } from '../workspace/attention.js';
import { registerPlanner } from '../workspace/reminders.js';
import { zonedInstant } from '../sales/core.js';
import { PROJECT_SELECT, listProjects, projectNumbers, projectVisibilitySql } from './index.js';

const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const OPEN_STAGES = ['backlog', 'todo', 'in_progress', 'review', 'blocked'];
const UPDATE_EVERY_DAYS = 14;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- the widget

/** The board link that shows exactly a group's tasks (so the count is the board's). */
const boardLink = (q) => `/board?${new URLSearchParams({ stage: OPEN_STAGES.join(','), ...q }).toString()}`;

/**
 * "My projects": one group per project, each with the person's open tasks in
 * it; "No project" last. Scopes: mine; department (managers: their
 * department's projects); all (people who see every task). Each group's count
 * is the board's count for the same filters.
 */
export async function projectsWidget(user, { scope = 'mine', rows = 5 } = {}) {
  const c = await deadlineClock();
  const q = { status: 'open' };
  if (scope === 'department') q.department_id = user.department_id;
  else if (scope !== 'all') q.mine = 'true';
  const projects = await listProjects(user, q);
  const params = [];
  const visible = taskVisibilitySql(user, params);
  const mineOnly = scope === 'mine';
  params.push(OPEN_STAGES);
  const stages = `$${params.length}`;
  params.push(mineOnly ? user.id : projects.map((p) => p.id));
  const which = mineOnly ? `t.assignee_id = $${params.length}` : `t.project_id = ANY($${params.length}::int[])`;
  const { rows: tasks } = await query(
    `SELECT t.id, t.ref, t.title, t.project_id, t.assignee_id, t.due_date, t.review_date, t.deferral_id, s.stage,
            u.full_name AS assignee_name
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.is_archived = FALSE AND s.stage = ANY(${stages}::text[]) AND ${visible} AND ${which}`,
    params,
  );
  const healthy = withHealth(tasks, c);
  const order = (a, b) => (a.health?.code === 'OVERDUE') - (b.health?.code === 'OVERDUE') || 0;
  const sortTasks = (list) => [...list].sort((a, b) => -order(a, b) || String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
  const groups = projects.map((p) => {
    const mine = sortTasks(healthy.filter((t) => t.project_id === p.id));
    const isLead = p.lead_user_id === user.id;
    return {
      project: {
        id: p.id, name: p.name, status: p.status, department_name: p.department_name, lead_name: p.lead_name, target_date: p.target_date,
      },
      numbers: {
        progress: p.numbers.progress, total: p.numbers.total, done: p.numbers.done,
        next_milestone: p.numbers.next_milestone, health_from_tasks: p.numbers.health_from_tasks, lead_update: p.numbers.lead_update,
      },
      is_lead: isLead,
      // the lead also sees what is unowned and what is late across the project
      lead_extras: isLead ? { unassigned: p.numbers.unassigned, overdue: p.numbers.overdue } : null,
      count: mine.length,
      tasks: mine.slice(0, rows),
      link: mineOnly ? boardLink({ project_id: String(p.id), assignee_id: String(user.id) }) : boardLink({ project_id: String(p.id) }),
      project_link: `/projects/${p.id}`,
    };
  });
  let noProject = null;
  if (mineOnly) {
    const loose = sortTasks(healthy.filter((t) => !t.project_id));
    noProject = { count: loose.length, tasks: loose.slice(0, rows), link: boardLink({ project_id: 'none', assignee_id: String(user.id) }) };
  }
  return { scope, groups, no_project: noProject, calendar: { timezone: c.timezone } };
}

// ---------------------------------------------------------------- Needs attention

addContributor(async function projectItems(user) {
  const settings = await getSettings();
  if (settings.projects?.enabled === false) return [];
  const c = await deadlineClock();
  const today = c.today;
  const out = [];
  // as the lead: milestones coming up with open work, a target date passed, no update lately, unowned work
  const { rows: led } = await query(`${PROJECT_SELECT} WHERE p.lead_user_id = $1 AND p.archived_at IS NULL AND p.status IN ('PLANNED', 'ACTIVE', 'ON_HOLD')`, [user.id]);
  const numbers = await projectNumbers(user, led, { c });
  for (const p of led) {
    const n = numbers.get(p.id);
    const record = { type: 'PROJECT', id: p.id, label: p.name, url: `/projects/${p.id}` };
    for (const m of n.milestones) {
      if (m.reached_at || !m.target_date || !m.stats.open) continue;
      if (m.target_date > addDays(today, 3)) continue;
      const late = m.target_date < today;
      out.push({
        key: `PROJECT_MILESTONE:PROJECT:${p.id}:${m.id}:${m.target_date}`, kind: 'PROJECT_MILESTONE',
        title: late ? `Milestone "${m.name}" is past its date` : `Milestone "${m.name}" is coming up`,
        reason: `${plural(m.stats.open, 'open task')} · ${late ? 'was due' : 'due'} ${m.target_date}`,
        record, related: [], when: { date: m.target_date, dateOnly: true },
        tier: late ? 2 : m.target_date === today ? 1 : 4, overdue: late, dueToday: m.target_date === today,
        action: { label: 'Open the project', kind: 'OPEN' },
      });
    }
    const target = p.target_date ? dayOf(p.target_date) : null;
    if (p.status === 'ACTIVE' && target && target < today) {
      out.push({
        key: `PROJECT_PAST_TARGET:PROJECT:${p.id}:${target}`, kind: 'PROJECT_PAST_TARGET', title: 'Past its target date',
        reason: `Target ${target}; ${plural(n.total - n.done, 'task')} still open. Finish it, move the date, or close it`,
        record, related: [], when: { date: target, dateOnly: true }, tier: 2, overdue: true, action: { label: 'Open the project', kind: 'OPEN' },
      });
    }
    if (p.status === 'ACTIVE' && (n.update_age_days === null ? daysSince(p.created_at, c) >= UPDATE_EVERY_DAYS : n.update_age_days >= UPDATE_EVERY_DAYS)) {
      out.push({
        key: `PROJECT_UPDATE_DUE:PROJECT:${p.id}:${n.lead_update ? dayOf(n.lead_update.at) : 'none'}`, kind: 'PROJECT_UPDATE_DUE', title: 'Post a project update',
        reason: n.lead_update ? `The last one was ${n.update_age_days} days ago` : 'No update has been posted yet',
        record, related: [], when: {}, tier: 5, action: { label: 'Open the project', kind: 'OPEN' },
      });
    }
    if (n.unassigned > 0) {
      out.push({
        key: `PROJECT_UNASSIGNED:PROJECT:${p.id}:${n.unassigned}`, kind: 'PROJECT_UNASSIGNED', title: `${plural(n.unassigned, 'task')} with no owner`,
        reason: 'In your project', record, related: [], when: {}, tier: 5, action: { label: 'Open the project', kind: 'OPEN' },
      });
    }
  }
  // to the department's managers and admins: a project whose lead is no longer active
  const anyDept = hasPermission(user, 'project.manage.any');
  if (anyDept || hasPermission(user, 'project.create')) {
    const params = [];
    const visible = projectVisibilitySql(user, params);
    if (!anyDept) params.push(user.department_id || 0);
    const { rows: orphans } = await query(
      `SELECT p.id, p.name FROM projects p JOIN users l ON l.id = p.lead_user_id
        WHERE l.is_active = FALSE AND p.archived_at IS NULL AND p.status IN ('PLANNED', 'ACTIVE', 'ON_HOLD') AND ${visible}
          ${anyDept ? '' : `AND p.department_id = $${params.length}`}`,
      params,
    );
    for (const p of orphans) {
      out.push({
        key: `PROJECT_NO_LEAD:PROJECT:${p.id}:0`, kind: 'PROJECT_NO_LEAD', title: 'Project has no active lead', reason: 'Choose a new lead',
        record: { type: 'PROJECT', id: p.id, label: p.name, url: `/projects/${p.id}` }, related: [], when: {}, tier: 3,
        action: { label: 'Open the project', kind: 'OPEN' },
      });
    }
  }
  return out;
});

function daysSince(at, c) {
  return Math.floor((c.now.getTime() - new Date(at).getTime()) / 86_400_000);
}

// ---------------------------------------------------------------- reminder rules

const PLAN_SELECT = `
  SELECT p.*, l.is_active AS lead_active,
         (SELECT MAX(created_at) FROM project_updates u WHERE u.project_id = p.id) AS last_update_at
    FROM projects p JOIN users l ON l.id = p.lead_user_id`;

async function companyTz(runner) {
  const { rows } = await runner.query(`SELECT value->>'timezone' AS tz FROM settings WHERE key = 'organisation'`);
  return rows[0]?.tz || 'Asia/Kolkata';
}

registerPlanner({
  name: 'projects',
  entityType: 'PROJECT',
  rules: ['PROJECT_MILESTONE_DUE', 'PROJECT_TARGET_DATE', 'PROJECT_UPDATE_DUE'],
  async plan(runner, id) {
    const { rows } = await runner.query(`${PLAN_SELECT} WHERE p.id = $1`, [id]);
    const p = rows[0];
    if (!p || p.archived_at) return { desired: [], why: 'The project was removed' };
    if (['COMPLETED', 'CANCELLED'].includes(p.status)) return { desired: [], why: `The project is ${p.status.toLowerCase()}` };
    if (!p.lead_active) return { desired: [], why: 'The project has no active lead' };
    const settings = await runner.query(`SELECT value FROM settings WHERE key = 'projects'`);
    if (settings.rows[0]?.value?.enabled === false) return { desired: [], why: 'Projects are switched off' };
    const tz = await companyTz(runner);
    const end = (date) => zonedInstant(addDays(date, 1), '00:00', tz);
    const who = p.lead_user_id;
    const desired = [];
    const { rows: ms } = await runner.query(
      `SELECT m.id, m.name, m.target_date,
              (SELECT COUNT(*)::int FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
                WHERE t.milestone_id = m.id AND t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled')) AS open
         FROM project_milestones m WHERE m.project_id = $1 AND m.reached_at IS NULL AND m.target_date IS NOT NULL`,
      [id],
    );
    for (const m of ms) {
      if (!m.open) continue;
      const date = dayOf(m.target_date);
      desired.push({ recipientId: who, ruleKey: 'PROJECT_MILESTONE_DUE', occurrenceKey: `ms:${m.id}:${date}`, date: addDays(date, -3), until: end(date), facts: { milestone: m.name, date, open: m.open } });
    }
    if (p.status === 'ACTIVE' && p.target_date) {
      const date = dayOf(p.target_date);
      desired.push({ recipientId: who, ruleKey: 'PROJECT_TARGET_DATE', occurrenceKey: `target:${date}`, date: addDays(date, -7), until: end(date), facts: { date } });
    }
    if (p.status === 'ACTIVE') {
      const base = dayOf(p.last_update_at || p.created_at);
      desired.push({ recipientId: who, ruleKey: 'PROJECT_UPDATE_DUE', occurrenceKey: `update:${base}`, date: addDays(base, UPDATE_EVERY_DAYS), facts: { since: base, had_update: Boolean(p.last_update_at) } });
    }
    return { desired, why: 'The project changed' };
  },
  async sweep(runner, { forUser = null } = {}) {
    const { rows } = await runner.query(
      `SELECT id FROM projects WHERE archived_at IS NULL AND status IN ('PLANNED', 'ACTIVE', 'ON_HOLD') AND ($1::int IS NULL OR lead_user_id = $1)`,
      [forUser],
    );
    return rows.map((r) => r.id);
  },
  async words(runner, o, { label }) {
    const { rows } = await runner.query('SELECT name FROM projects WHERE id = $1', [o.entity_id]);
    const name = label?.label || rows[0]?.name || 'Your project';
    const why = 'You lead this project';
    const f = o.facts || {};
    if (o.rule_key === 'PROJECT_MILESTONE_DUE') {
      return { title: `Milestone "${f.milestone}" is due ${f.date}: ${name}`, body: `${plural(f.open || 0, 'open task')} in it. Mark it reached when it is done, or move its date.`, why };
    }
    if (o.rule_key === 'PROJECT_TARGET_DATE') {
      return { title: `Target date ${f.date} is a week away: ${name}`, body: 'Check what is left, and finish, move the date or close the project.', why };
    }
    return { title: `Time for a project update: ${name}`, body: f.had_update ? `The last update was on ${f.since}. Say how it is going, in your words.` : 'No update has been posted yet. Say how it is going, in your words.', why };
  },
});
