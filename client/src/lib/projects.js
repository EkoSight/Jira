/**
 * Projects in the browser: words, tones and groupings, kept pure so they are
 * tested without a browser.
 */

export const STATUS_LABEL = { PLANNED: 'Planned', ACTIVE: 'Active', ON_HOLD: 'On hold', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
export const STATUS_TONE = { PLANNED: 'neutral', ACTIVE: 'brand', ON_HOLD: 'warning', COMPLETED: 'good', CANCELLED: 'neutral' };
export const HEALTH_LABEL = { ON_TRACK: 'On track', AT_RISK: 'At risk', OFF_TRACK: 'Off track' };
export const HEALTH_TONE = { ON_TRACK: 'good', AT_RISK: 'warning', OFF_TRACK: 'critical' };
export const OPEN_STATUSES = ['PLANNED', 'ACTIVE', 'ON_HOLD'];

/** "2 of 5 tasks done (40%)", or a plain word when there are none. */
export function progressWords(n) {
  if (!n || !n.total) return 'No tasks yet';
  return `${n.done} of ${n.total} task${n.total === 1 ? '' : 's'} done (${n.progress}%)`;
}

/** "12 Mar 2027" for a YYYY-MM-DD date (never shifted by a timezone). */
export function dateWords(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(Date.UTC(y, m - 1, day));
}

/** Projects grouped by department, in the order the server sent them. */
export function byDepartment(projects) {
  const groups = [];
  const index = new Map();
  for (const p of projects) {
    if (!index.has(p.department_id)) {
      index.set(p.department_id, groups.length);
      groups.push({ id: p.department_id, name: p.department_name, color: p.department_color, projects: [] });
    }
    groups[index.get(p.department_id)].projects.push(p);
  }
  return groups;
}

/**
 * A project's tasks grouped by milestone, in the milestones' order, with
 * "No milestone" last. Every task appears exactly once.
 */
export function byMilestone(tasks, milestones = []) {
  const groups = milestones.map((m) => ({ id: m.id, name: m.name, target_date: m.target_date, reached_at: m.reached_at, tasks: [] }));
  const index = new Map(groups.map((g, i) => [g.id, i]));
  const none = { id: null, name: 'No milestone', tasks: [] };
  for (const t of tasks) {
    if (t.milestone_id && index.has(t.milestone_id)) groups[index.get(t.milestone_id)].tasks.push(t);
    else none.tasks.push(t);
  }
  return none.tasks.length ? [...groups, none] : groups;
}

/**
 * Tasks grouped by project for "Group by project": one group per project in
 * order of first appearance, "No project" last. Every task appears once.
 */
export function groupByProject(tasks) {
  const groups = [];
  const index = new Map();
  const none = { id: null, name: 'No project', tasks: [] };
  for (const t of tasks) {
    if (!t.project_id) { none.tasks.push(t); continue; }
    if (!index.has(t.project_id)) {
      index.set(t.project_id, groups.length);
      groups.push({ id: t.project_id, name: t.project_name || 'Project', tasks: [] });
    }
    groups[index.get(t.project_id)].tasks.push(t);
  }
  return none.tasks.length ? [...groups, none] : groups;
}

/** What a project activity line says, in plain words. */
export function activityWords(a, people = {}) {
  const d = a.detail || {};
  const who = (id) => people[id] || 'someone';
  switch (a.action) {
    case 'created': return 'created the project';
    case 'created_from_task': return `made the project from ${d.ref || 'a task'} and its subtasks`;
    case 'created_from_tag': return `made the project from the tag "${d.tag}"`;
    case 'task_added': return d.recurring ? 'the next occurrence of a repeating task joined' : d.created ? 'added a new task' : 'moved a task in';
    case 'task_removed': return 'took a task out';
    case 'task_kept_open': return 'kept a task open when closing the project';
    case 'member_added': return `added ${who(d.user_id)} as a member`;
    case 'member_removed': return `removed ${who(d.user_id)} from the members`;
    case 'milestone_added': return `added the milestone "${d.name}"`;
    case 'milestone_changed': return `changed the milestone "${d.name}"`;
    case 'milestone_reached': return `marked "${d.name}" reached`;
    case 'milestone_reopened': return `reopened the milestone "${d.name}"`;
    case 'milestone_removed': return `removed the milestone "${d.name}"${d.tasks_cleared ? ` (${d.tasks_cleared} task${d.tasks_cleared === 1 ? '' : 's'} kept, without it)` : ''}`;
    case 'update_posted': return `posted an update: ${HEALTH_LABEL[d.health] || ''}`;
    case 'changed': return d.field === 'status' ? `changed the status to ${STATUS_LABEL[d.to] || d.to}` : `changed the ${String(d.field || '').replace(/_/g, ' ').replace(' user id', '')}`;
    case 'step_added': return `added a step: "${d.title}"`;
    case 'step_done': return `ticked a step: "${d.title}"`;
    case 'step_reopened': return `unticked a step: "${d.title}"`;
    case 'step_removed': return `removed a step: "${d.title}"`;
    case 'kr_linked': return 'linked a key result it supports';
    case 'kr_unlinked': return 'unlinked a key result';
    case 'engagement_linked': return 'linked the CRM delivery record';
    default: return a.action.replace(/_/g, ' ');
  }
}
