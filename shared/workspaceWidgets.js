/**
 * The My workspace widget catalogue: one registry for the server and the
 * browser. The server uses it to decide who may see and add each widget; the
 * browser uses it to draw and configure them.
 *
 * A widget is presentation only. It never grants access: its data comes from
 * an endpoint that checks permissions itself, and its count comes from the
 * same query as the list its drill-down opens.
 *
 * Fields:
 *   version      bumped when a widget's saved config changes shape
 *   title        the default heading (a person may rename their copy)
 *   module       a module switch that must be on (crm, okr), or null
 *   anyOf        the person needs at least one of these permissions (empty: anyone)
 *   needs        a special condition: 'tracksDay' (attendance and standup apply)
 *   widths       allowed widths
 *   settings     the settings a person may change on their copy
 *   scopes       the scopes it offers; 'team' only for people whose permissions show team data
 *   endpoint     where its data comes from (existing endpoints where one exists)
 *   drill        where "Open" goes
 *   since        the release it was added in (newer than a layout's save: shown as "New")
 */

export const WIDGET_TYPES = {
  summary: {
    version: 1, title: 'Summary', module: null, anyOf: [], widths: ['full'],
    settings: ['title'], scopes: ['mine'], endpoint: '/workspace/widgets/summary', drill: '/workspace/attention',
    description: 'Counts of what needs you: needs attention, overdue, due today, waiting on others, decisions',
  },
  attention: {
    version: 1, title: 'Needs attention', module: null, anyOf: [], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows', 'view'], scopes: ['mine'], endpoint: '/workspace/attention', drill: '/workspace/attention',
    description: 'One list of what needs you, from every module, in an order you can follow',
  },
  decisions: {
    version: 1, title: 'Needs my decision', module: null, anyOf: [], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows'], scopes: ['mine'], endpoint: '/workspace/decisions', drill: '/workspace/decisions',
    description: 'Approvals waiting on you: deadline changes, blocks, leave, extra time, holidays, quotations, handovers, appeals, standup reviews',
  },
  today: {
    version: 1, title: 'Today', module: null, anyOf: [], needs: 'tracksDay', widths: ['full', 'half'],
    settings: ['title'], scopes: ['mine'], endpoint: '/attendance/today', drill: '/attendance',
    description: 'Your check-in, today\'s standup, and leave or a holiday today',
  },
  my_tasks: {
    version: 1, title: 'My tasks', module: null, anyOf: [], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows', 'sort', 'scope'], scopes: ['mine', 'supporting', 'assigned_by_me', 'team'],
    endpoint: '/tasks', drill: '/board',
    description: 'Open tasks with their deadline health, from the board',
  },
  deadlines: {
    version: 1, title: 'Deadlines coming up', module: null, anyOf: [], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows', 'range', 'scope'], scopes: ['mine', 'supporting', 'assigned_by_me', 'team'],
    endpoint: '/tasks', drill: '/board',
    description: 'Tasks and applications with a deadline in the next days',
  },
  waiting: {
    version: 1, title: 'Waiting on others', module: null, anyOf: [], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows'], scopes: ['mine'], endpoint: '/workspace/waiting', drill: '/workspace/waiting',
    description: 'What you are waiting for, from whom and since when',
  },
  meetings: {
    version: 1, title: 'Meetings', module: null, anyOf: [], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows'], scopes: ['mine'], endpoint: '/meetings/mine', drill: '/meetings',
    description: 'Confirmed meetings coming up, and meetings still to arrange',
  },
  applications: {
    version: 1, title: 'Applications', module: 'crm', anyOf: ['crm.view'], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows', 'scope'], scopes: ['mine', 'team'], endpoint: '/applications', drill: '/applications',
    description: 'Grants, programmes and other applications: preparing, and submitted and waiting',
  },
  deals: {
    version: 1, title: 'Deals', module: 'crm', anyOf: ['crm.view'], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows', 'scope'], scopes: ['mine', 'team'], endpoint: '/workspace/widgets/deals', drill: '/pipeline',
    description: 'Your open deals with their next action, waiting and last update',
  },
  leads_to_work: {
    version: 1, title: 'Leads to work', module: 'crm', anyOf: ['crm.view'], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows'], scopes: ['mine'], endpoint: '/sales/work-queue', drill: '/sales?tab=day',
    description: 'Your CRM work queue, the same as Sales → My Day',
  },
  calls_to_describe: {
    version: 1, title: 'Calls to describe', module: 'crm', anyOf: ['crm.activity.log'], widths: ['full', 'half'],
    settings: ['title', 'rows'], scopes: ['mine'], endpoint: '/sales/calls/pending', drill: '/sales?tab=day',
    description: 'Calls you made that still need an outcome',
  },
  followups: {
    version: 1, title: 'Follow-ups', module: 'crm', anyOf: ['crm.view'], widths: ['full', 'half'],
    settings: ['title', 'density', 'rows'], scopes: ['mine'], endpoint: '/sales/work-queue', drill: '/sales?tab=day',
    description: 'CRM follow-ups overdue and due today',
  },
  key_results: {
    version: 1, title: 'Key results to check in', module: 'okr', anyOf: ['okr.view'], widths: ['full', 'half'],
    settings: ['title', 'rows'], scopes: ['mine'], endpoint: '/workspace/widgets/key_results', drill: '/goals',
    description: 'Your key results that are due a check-in, with signals about them',
  },
  team_workload: {
    version: 1, title: 'Team workload', module: null, anyOf: [], widths: ['full'],
    settings: ['title'], scopes: ['mine'], endpoint: '/reports/dashboard', drill: '/team',
    description: 'Open work per person, as on today\'s dashboard',
  },
  company_overview: {
    version: 1, title: 'Company overview', module: null, anyOf: [], widths: ['full'],
    settings: ['title'], scopes: ['mine'], endpoint: '/reports/dashboard', drill: '/overview',
    description: 'Today\'s dashboard numbers, with the same scope as the overview page',
  },
  recognition: {
    version: 1, title: 'Recognition', module: null, anyOf: [], widths: ['full', 'half'],
    settings: ['title', 'rows'], scopes: ['mine'], endpoint: '/recognition/kudos', drill: '/recognition',
    description: 'Kudos you received and recent recognition',
  },
  my_black_marks: {
    version: 1, title: 'My black marks', module: null, anyOf: ['blackmark.view'], widths: ['full', 'half'],
    settings: ['title', 'rows'], scopes: ['mine'], endpoint: '/blackmarks', drill: '/black-marks',
    description: 'Your own marks and appeals only',
  },
  pinned_notes: {
    version: 1, title: 'Pinned notes', module: null, anyOf: ['note.use'], widths: ['full', 'half'],
    settings: ['title', 'rows'], scopes: ['mine'], endpoint: '/notes', drill: '/notes',
    description: 'Your pinned notes',
  },
  saved_view: {
    version: 1, title: 'Saved view', module: null, anyOf: [], widths: ['full', 'half'],
    settings: ['title', 'rows', 'view_id'], scopes: ['mine'], endpoint: '/task-views', drill: '/board',
    description: 'One of your saved task views, compact',
  },
};

export const WIDGET_KEYS = Object.keys(WIDGET_TYPES);

export const SCOPE_LABEL = {
  mine: 'Mine',
  supporting: 'Supporting',
  assigned_by_me: 'Assigned by me',
  team: 'My team',
};

export const ROW_CHOICES = [5, 10, 20];
export const RANGE_CHOICES = [3, 7, 14, 30];
export const WIDTHS = ['full', 'half'];
export const MAX_WIDGETS = 30;

/**
 * Whether a person may see a widget type, and if not, why in words. `who` is
 * { can(permission), modules: { crm, okr }, tracksDay }.
 */
export function widgetAccess(type, who) {
  const w = WIDGET_TYPES[type];
  if (!w) return { ok: false, why: 'This widget is no longer available', retired: true };
  if (w.module && who.modules?.[w.module] === false) return { ok: false, why: 'This module is switched off' };
  if (w.anyOf.length && !w.anyOf.some((p) => who.can(p))) return { ok: false, why: 'Not available to you' };
  if (w.needs === 'tracksDay' && !who.tracksDay) return { ok: false, why: 'Attendance and the standup do not apply to you' };
  return { ok: true };
}

/** The scopes a person may use on a widget ('team' needs team data access). */
export function scopesFor(type, who) {
  const w = WIDGET_TYPES[type];
  if (!w) return [];
  return w.scopes.filter((s) => s !== 'team' || who.teamScope?.[type === 'deals' || type === 'applications' ? 'crm' : 'tasks']);
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

/**
 * One widget as stored, cleaned: unknown settings dropped, values clamped. An
 * unknown type is kept as it is (it renders as "no longer available" until
 * the person removes it), so a retired widget never breaks a layout.
 */
export function normaliseWidget(raw, index = 0) {
  const id = clean(raw?.id, 40) || `w${index + 1}`;
  const type = clean(raw?.type, 40);
  const w = WIDGET_TYPES[type];
  const width = WIDTHS.includes(raw?.width) ? raw.width : 'full';
  if (!w) return { id, type, typeVersion: Number(raw?.typeVersion) || 1, width, config: {} };
  const c = raw?.config && typeof raw.config === 'object' ? raw.config : {};
  const config = {};
  if (w.settings.includes('title') && clean(c.title, 60)) config.title = clean(c.title, 60);
  if (w.settings.includes('density') && ['compact', 'expanded'].includes(c.density)) config.density = c.density;
  if (w.settings.includes('rows') && ROW_CHOICES.includes(Number(c.rows))) config.rows = Number(c.rows);
  if (w.settings.includes('range') && RANGE_CHOICES.includes(Number(c.range))) config.range = Number(c.range);
  if (w.settings.includes('sort') && ['due_date', 'priority', 'updated'].includes(c.sort)) config.sort = c.sort;
  if (w.settings.includes('scope') && w.scopes.includes(c.scope)) config.scope = c.scope;
  if (w.settings.includes('view') && ['today', 'coming', 'waiting', 'all'].includes(c.view)) config.view = c.view;
  if (w.settings.includes('view_id') && Number.isInteger(Number(c.view_id)) && Number(c.view_id) > 0) config.view_id = Number(c.view_id);
  return { id, type, typeVersion: w.version, width: w.widths.includes(width) ? width : w.widths[0], config };
}

/** A whole layout, cleaned: at most MAX_WIDGETS, unique ids. */
export function normaliseLayout(raw) {
  const list = Array.isArray(raw?.widgets) ? raw.widgets.slice(0, MAX_WIDGETS) : [];
  const seen = new Set();
  const widgets = [];
  list.forEach((w, i) => {
    const n = normaliseWidget(w, i);
    let id = n.id;
    let k = 1;
    while (seen.has(id)) { k += 1; id = `${n.id}-${k}`; }
    seen.add(id);
    widgets.push({ ...n, id });
  });
  return { widgets };
}

const OPEN_STAGES = 'backlog,todo,in_progress,review,blocked';

/**
 * The board filters a task widget means. The widget asks /tasks with exactly
 * these, and its "Open" goes to the board with exactly these, so its count is
 * the number of cards the board shows.
 */
export function taskWidgetFilters(type, config, { userId, departmentId, today, addDays }) {
  const scope = config.scope || 'mine';
  const q = { stage: OPEN_STAGES };
  if (scope === 'mine') q.assignee_id = String(userId);
  else if (scope === 'supporting') q.supporter_id = String(userId);
  else if (scope === 'assigned_by_me') q.assigned_by = String(userId);
  else if (scope === 'team' && departmentId) q.department_id = String(departmentId);
  if (type === 'deadlines') {
    q.due = 'range';
    q.due_from = today;
    q.due_to = addDays(today, (config.range || 7) - 1);
  }
  return q;
}

/** A board link for a set of filters. */
export const boardLink = (filters) => `/board?${new URLSearchParams(filters).toString()}`;

/** The heading a widget shows: the person's title, else the default. */
export const widgetTitle = (w) => w?.config?.title || WIDGET_TYPES[w?.type]?.title || 'Widget';
