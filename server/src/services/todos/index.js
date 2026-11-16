/**
 * Quick to-dos and Today's plan (Parts A and B).
 *
 * One item shape for the three things a plan holds:
 *   TODO  a line written for yourself (todos), private unless shared
 *   STEP  a task checklist item you own (task_checklist_items), the same row as on the task
 *   PIN   a task pinned to a day (todo_pins), showing the task's live status
 *
 *   { source, key, id, title, done, done_at, planned_on, planned_time, position,
 *     link, shared, carried_from, project, ... }
 *
 * Every count comes from the same function as the list it counts: the header's
 * "3 left" is todayPlan().left.
 *
 * Privacy: every query here is scoped to the signed-in person
 * (owner_user_id / user_id = me). Another person's to-do id answers 404, for
 * managers, admins and super admins too. The only exception is recordSteps():
 * to-dos their owner shared onto a record, shown to people who can see it.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { getSettings } from '../settings.js';
import { addDays, localDate } from '../../../../shared/deadlineHealth.js';
import { taskVisibilitySql } from '../taskAccess.js';
import { logActivity } from '../activity.js';
import { planRecord } from '../workspace/reminders.js';
import { projectActivity } from '../projects/index.js';
import {
  LINK_TYPES, LINK_WORD, assertLinkable, chainFor, describeLink, describeLinks, meetingsOn,
  referenceIn, suggestFor, suggestionCandidates,
} from './links.js';
import { addStep, checkStepChange, mayOwnStep, setStepDone, visibleTask } from './steps.js';

export { LINK_TYPES, LINK_WORD };

const CLOSED_STAGES = ['done', 'cancelled'];
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const keyOf = (type, id) => `${type}:${Number(id)}`;

/** Ticking or removing a to-do cancels its own "remind me", and the planned message with it. */
async function cancelReminders(client, todo) {
  const { rowCount } = await client.query(
    `UPDATE personal_reminders SET status = 'CANCELLED', updated_at = now()
      WHERE entity_type = 'TODO' AND entity_id = $1 AND user_id = $2 AND status = 'ACTIVE'`, [todo.id, todo.owner_user_id]);
  if (rowCount) await planRecord(client, 'TODO', todo.id);
}

// ---------------------------------------------------------------- the person's day

/** "Today" is the person's own timezone, else the company's. */
export function zoneOf(user, settings) {
  return user.timezone || settings?.organisation?.timezone || 'Asia/Kolkata';
}

export async function todayFor(user, now = new Date()) {
  const s = await getSettings();
  const tz = zoneOf(user, s);
  return { today: localDate(now, tz), tz, settings: s };
}

/** A day the client sent: a date, or TODAY / TOMORROW in the person's own day. */
function readDay(value, today) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (value === 'TODAY') return today;
  if (value === 'TOMORROW') return addDays(today, 1);
  if (!DATE.test(String(value))) throw badRequest('Pick a day');
  return String(value);
}

function readTime(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!TIME.test(String(value))) throw badRequest('Write the time as HH:MM, for example 15:00');
  return String(value);
}

const cleanTitle = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function checkTitle(title) {
  if (!title) throw badRequest('Write the to-do first');
  if (title.length > 200) throw badRequest('Keep it to 200 characters; put the rest in a note');
  return title;
}

// ---------------------------------------------------------------- item shapes

const publicLink = (l) => (l ? { type: l.type, id: l.id, label: l.label, url: l.url, word: l.word, visible: l.visible, ...(l.ref ? { ref: l.ref } : {}) } : null);

function todoItem(r, { today, links, suggestions }) {
  const own = r.link_type ? links.get(keyOf(r.link_type, r.link_id)) : null;
  const inherited = !own && r.list_link_type ? links.get(keyOf(r.list_link_type, r.list_link_id)) : null;
  const link = own || inherited || null;
  const planned = dayOf(r.planned_on);
  const carried = planned && today && planned < today ? planned : null;
  return {
    source: 'TODO', key: `TODO:${r.id}`, id: r.id, title: r.title, note: r.note,
    done: Boolean(r.done_at), done_at: r.done_at, planned_on: planned, planned_time: r.planned_time,
    position: r.position, link: publicLink(link), link_inherited: Boolean(inherited), shared: r.shared,
    carried_from: carried,
    // asked once, after 7 days of carrying
    ask_still_want: Boolean(carried && !r.done_at && !r.carry_asked_at && daysBetween(carried, today) >= 7),
    list: r.list_id ? { id: r.list_id, name: r.list_name } : null,
    became: r.became_task_id ? { task_id: r.became_task_id, ref: r.became_ref } : null,
    project: link?.project || null, origin: r.source, created_at: r.created_at,
    suggestion: (!link && !r.done_at && suggestions?.get(r.id)) || null,
  };
}

function stepItem(r, { today, links }) {
  const link = links.get(keyOf('TASK', r.task_id));
  const onDay = dayOf(r.on_day);
  return {
    source: 'STEP', key: `STEP:${r.id}`, id: r.id, title: r.title,
    done: Boolean(r.is_done), done_at: r.done_at, done_date_unknown: Boolean(r.is_done && !r.done_at),
    planned_on: onDay, own_day: dayOf(r.planned_on), planned_time: r.planned_time, position: r.owner_position,
    link: publicLink(link), shared: true,
    carried_from: onDay && today && onDay < today ? onDay : null, ask_still_want: false,
    task: { id: r.task_id, ref: r.ref, title: r.task_title, stage: r.stage },
    project: link?.project || null, created_at: r.created_at,
  };
}

function pinItem(r, { links }) {
  const link = links.get(keyOf('TASK', r.task_id));
  return {
    source: 'PIN', key: `PIN:${r.id}`, id: r.id, title: r.title,
    done: CLOSED_STAGES.includes(r.stage), done_at: null, planned_on: dayOf(r.day), planned_time: null,
    position: r.position, link: publicLink(link), shared: false, carried_from: null, ask_still_want: false,
    // live, not a copy
    task: {
      id: r.task_id, ref: r.ref, title: r.title, stage: r.stage, status_name: r.status_name, status_id: r.status_id,
      due_date: r.due_date, task_type: r.task_type, priority: r.priority, recurrence: r.recurrence, assignee_id: r.assignee_id,
    },
    project: link?.project || null, created_at: r.created_at,
  };
}

/** Timed items first, by time; then the person's own order. */
export function planOrder(a, b) {
  if (a.planned_time && b.planned_time && a.planned_time !== b.planned_time) return a.planned_time.localeCompare(b.planned_time);
  if (a.planned_time && !b.planned_time) return -1;
  if (!a.planned_time && b.planned_time) return 1;
  const pa = a.position ?? 1e9;
  const pb = b.position ?? 1e9;
  if (pa !== pb) return pa - pb;
  return String(a.created_at).localeCompare(String(b.created_at)) || a.key.localeCompare(b.key);
}

// ---------------------------------------------------------------- reading rows

const TODO_SELECT = `
  SELECT td.*, l.name AS list_name, l.link_type AS list_link_type, l.link_id AS list_link_id, bt.ref AS became_ref
    FROM todos td
    LEFT JOIN todo_lists l ON l.id = td.list_id
    LEFT JOIN tasks bt ON bt.id = td.became_task_id`;

async function todoRows(user, where, params) {
  const { rows } = await query(
    `${TODO_SELECT}
      WHERE td.owner_user_id = $1 AND td.archived_at IS NULL AND td.moved_to_checklist_item_id IS NULL AND (${where})
      ORDER BY td.position, td.created_at, td.id`, [user.id, ...params]);
  return rows;
}

/** Steps this person owns, on tasks they can still see (losing access removes them from the plan). */
async function stepRows(user, tz, where, extra = []) {
  const params = [user.id, tz, ...extra];
  const visible = taskVisibilitySql(user, params, 't');
  const { rows } = await query(
    `SELECT ci.id, ci.title, ci.is_done, ci.done_at, ci.done_by, ci.planned_on, ci.planned_time, ci.owner_position, ci.created_at,
            t.id AS task_id, t.ref, t.title AS task_title, t.project_id, t.assignee_id, ws.stage,
            COALESCE(ci.planned_on, (t.due_date AT TIME ZONE $2::text)::date) AS on_day
       FROM task_checklist_items ci
       JOIN tasks t ON t.id = ci.task_id
       LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
      WHERE ci.owner_user_id = $1 AND t.is_archived = FALSE AND ${visible} AND (${where})
      ORDER BY ci.owner_position NULLS LAST, ci.created_at, ci.id`, params);
  return rows;
}

const OPEN_STEP = `(ci.is_done = FALSE AND COALESCE(ws.stage, 'todo') NOT IN ('done', 'cancelled'))`;
const STEP_DAY = `COALESCE(ci.planned_on, (t.due_date AT TIME ZONE $2::text)::date)`;

async function pinRows(user, day) {
  const params = [user.id, day];
  const visible = taskVisibilitySql(user, params, 't');
  const { rows } = await query(
    `SELECT p.id, p.day, p.position, p.created_at, p.task_id, t.ref, t.title, t.due_date, t.project_id, t.assignee_id,
            t.task_type, t.priority, t.recurrence, t.status_id, ws.stage, ws.name AS status_name
       FROM todo_pins p
       JOIN tasks t ON t.id = p.task_id
       LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
      WHERE p.user_id = $1 AND p.day = $2::date AND t.is_archived = FALSE AND ${visible}
      ORDER BY p.position, p.id`, params);
  return rows;
}

/** Turn rows into items: links described once, suggestions for unlinked open lines. */
async function itemsFrom(user, { todos = [], steps = [], pins = [] }, { today, tz, settings, suggest = true }) {
  const pairs = [];
  for (const r of todos) {
    if (r.link_type) pairs.push({ type: r.link_type, id: r.link_id });
    else if (r.list_link_type) pairs.push({ type: r.list_link_type, id: r.list_link_id });
  }
  for (const r of steps) pairs.push({ type: 'TASK', id: r.task_id });
  for (const r of pins) pairs.push({ type: 'TASK', id: r.task_id });
  const links = await describeLinks(user, pairs, settings);
  let suggestions = null;
  const unlinked = todos.filter((r) => !r.link_type && !r.list_link_type && !r.done_at);
  if (suggest && unlinked.length) {
    const candidates = await suggestionCandidates(user, { day: today, tz, settings });
    suggestions = new Map();
    for (const r of unlinked) { const s = suggestFor(r.title, candidates); if (s) suggestions.set(r.id, s); }
  }
  const ctx = { today, links, suggestions };
  return {
    todos: todos.map((r) => todoItem(r, ctx)),
    steps: steps.map((r) => stepItem(r, ctx)),
    pins: pins.map((r) => pinItem(r, ctx)),
  };
}

// ---------------------------------------------------------------- Today's plan

/**
 * Today's plan, top to bottom: carried over (unfinished from earlier days,
 * never "overdue"), today (my to-dos, my steps and pins, in my order), fixed
 * times (today's meetings, read-only) and the done count. Ticked items stay
 * where they were. `left` is the header's count.
 */
export async function todayPlan(user, { now = new Date() } = {}) {
  const { today, tz, settings } = await todayFor(user, now);
  const [todos, steps, pins, meetings, prefs] = await Promise.all([
    todoRows(user, `td.planned_on = $2::date OR (td.planned_on < $2::date AND (td.done_at IS NULL OR (td.done_at AT TIME ZONE $3::text)::date = $2::date))`, [today, tz]),
    stepRows(user, tz, `${STEP_DAY} <= $3::date AND (${OPEN_STEP} OR (ci.is_done AND (ci.done_at AT TIME ZONE $2::text)::date = $3::date))`, [today]),
    pinRows(user, today),
    meetingsOn(user, today, tz),
    query('SELECT notebook_hide_done FROM users WHERE id = $1', [user.id]),
  ]);
  const items = await itemsFrom(user, { todos, steps, pins }, { today, tz, settings });
  const all = [...items.todos, ...items.steps, ...items.pins];
  const carried = all.filter((i) => i.carried_from)
    .sort((a, b) => a.carried_from.localeCompare(b.carried_from) || planOrder(a, b));
  const todayItems = all.filter((i) => !i.carried_from).sort(planOrder);
  const counted = [...carried, ...todayItems];
  return {
    day: today, today, timezone: tz,
    carried, items: todayItems,
    meetings: meetings.map((m) => ({ id: m.id, title: m.title, time: m.local_time, status: m.status, url: `/meetings?meeting=${m.id}` })),
    left: counted.filter((i) => !i.done).length,
    done_count: counted.filter((i) => i.done && !i.became).length,
    carried_count: carried.filter((i) => !i.done).length,
    hide_done: Boolean(prefs.rows[0]?.notebook_hide_done),
  };
}

/** Next 14 days, open items only, grouped by day. */
export async function upcoming(user, { days = 14, now = new Date() } = {}) {
  const { today, tz, settings } = await todayFor(user, now);
  const last = addDays(today, days);
  const [todos, steps] = await Promise.all([
    todoRows(user, `td.done_at IS NULL AND td.planned_on > $2::date AND td.planned_on <= $3::date`, [today, last]),
    stepRows(user, tz, `${OPEN_STEP} AND ${STEP_DAY} > $3::date AND ${STEP_DAY} <= $4::date`, [today, last]),
  ]);
  const items = await itemsFrom(user, { todos, steps }, { today, tz, settings });
  const byDay = new Map();
  for (const i of [...items.todos, ...items.steps]) {
    if (!byDay.has(i.planned_on)) byDay.set(i.planned_on, []);
    byDay.get(i.planned_on).push(i);
  }
  return {
    today, from: addDays(today, 1), to: last,
    days: [...byDay.keys()].sort().map((d) => ({ day: d, items: byDay.get(d).sort(planOrder) })),
    count: items.todos.length + items.steps.length,
  };
}

/** No day: open to-dos outside lists, and owned steps with no day and no due date. */
export async function anytime(user, { now = new Date() } = {}) {
  const { today, tz, settings } = await todayFor(user, now);
  const [todos, steps] = await Promise.all([
    todoRows(user, 'td.done_at IS NULL AND td.planned_on IS NULL AND td.list_id IS NULL', []),
    stepRows(user, tz, `${OPEN_STEP} AND ${STEP_DAY} IS NULL`),
  ]);
  const items = await itemsFrom(user, { todos, steps }, { today, tz, settings });
  return { today, items: [...items.todos, ...items.steps].sort(planOrder) };
}

/**
 * Done, newest first, searchable. With whatIDid, each item carries its chain
 * and the items are grouped by project, task, goal, department and record —
 * for the person's own updates; nobody else sees it.
 */
export async function doneItems(user, { q = '', limit = 100, whatIDid = false, now = new Date() } = {}) {
  const { today, tz, settings } = await todayFor(user, now);
  const text = String(q || '').trim();
  const like = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const n = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const [todos, steps] = await Promise.all([
    todoRows(user, `td.done_at IS NOT NULL AND td.became_task_id IS NULL AND ($2::text IS NULL OR td.title ILIKE $2 OR td.note ILIKE $2)`, [like]),
    stepRows(user, tz, `ci.is_done AND ($3::text IS NULL OR ci.title ILIKE $3)`, [like]),
  ]);
  // steps I ticked on others' behalf are mine to report too, when I can see the task
  const params = [user.id, like];
  const visible = taskVisibilitySql(user, params, 't');
  const { rows: tickedByMe } = await query(
    `SELECT ci.id, ci.title, ci.is_done, ci.done_at, ci.done_by, ci.planned_on, ci.planned_time, ci.owner_position, ci.created_at,
            t.id AS task_id, t.ref, t.title AS task_title, t.project_id, t.assignee_id, ws.stage, ci.planned_on AS on_day
       FROM task_checklist_items ci JOIN tasks t ON t.id = ci.task_id LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
      WHERE ci.done_by = $1 AND ci.is_done AND (ci.owner_user_id IS DISTINCT FROM $1) AND t.is_archived = FALSE
        AND ($2::text IS NULL OR ci.title ILIKE $2) AND ${visible}`, params);
  const items = await itemsFrom(user, { todos, steps: [...steps, ...tickedByMe] }, { today, tz, settings, suggest: false });
  const all = [...items.todos, ...items.steps]
    .sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')))
    .slice(0, n);
  if (!whatIDid) return { items: all };
  const cache = new Map();
  for (const i of all) i.chain = i.link?.visible ? await chainFor(user, { ...i.link, project: i.project }, settings, cache) : null;
  return { items: all, groups: groupWhatIDid(all) };
}

/** Group done items under every heading of their chain. */
export function groupWhatIDid(items) {
  const dims = { project: new Map(), task: new Map(), goal: new Map(), department: new Map(), record: new Map() };
  const add = (dim, key, label, url, item) => {
    if (!dims[dim].has(key)) dims[dim].set(key, { key, label, url, items: [] });
    dims[dim].get(key).items.push(item.key);
  };
  const unlinked = [];
  for (const i of items) {
    const c = i.chain;
    if (!c) { unlinked.push(i.key); continue; }
    if (c.project) add('project', `PROJECT:${c.project.id}`, c.project.name, `/projects/${c.project.id}`, i);
    for (const t of c.tasks) add('task', `TASK:${t.id}`, `${t.ref} ${t.title}`, t.url, i);
    for (const k of c.key_results) add('goal', `KEY_RESULT:${k.id}`, k.title, k.url, i);
    for (const o of c.objectives) add('goal', `OBJECTIVE:${o.id}`, o.title, o.url, i);
    for (const d of c.departments) add('department', `DEPARTMENT:${d.id}`, d.name, null, i);
    if (!['TASK', 'PROJECT', 'KEY_RESULT', 'OBJECTIVE'].includes(c.record.type)) add('record', `${c.record.type}:${c.record.id}`, c.record.label, c.record.url, i);
  }
  const out = {};
  for (const [dim, map] of Object.entries(dims)) out[dim] = [...map.values()];
  out.unlinked = unlinked;
  return out;
}

// ---------------------------------------------------------------- one to-do

async function ownTodo(user, id, runner = { query }) {
  const { rows } = await runner.query(
    'SELECT * FROM todos WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL', [Number(id), user.id]);
  if (!rows[0]) throw notFound('To-do not found');
  return rows[0];
}

/** One to-do as an item (after a change). */
export async function todoById(user, id) {
  const { today, tz, settings } = await todayFor(user);
  const rows = await todoRows(user, 'td.id = $2', [Number(id)]);
  if (!rows[0]) throw notFound('To-do not found');
  return (await itemsFrom(user, { todos: rows }, { today, tz, settings })).todos[0];
}

async function ownList(user, id, runner = { query }) {
  const { rows } = await runner.query('SELECT * FROM todo_lists WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL', [Number(id), user.id]);
  if (!rows[0]) throw notFound('List not found');
  return rows[0];
}

/** A line on a record's activity: task, project, goal, or the step log for deals, applications and meetings. */
async function recordActivity(client, user, type, id, action, todo) {
  const title = todo.title;
  switch (type) {
    case 'TASK': return logActivity(client, { taskId: id, actorId: user.id, action, to: title, meta: { todo_id: todo.id } });
    case 'PROJECT': return projectActivity(client, { projectId: id, actorId: user.id, action, detail: { title, todo_id: todo.id } });
    case 'KEY_RESULT':
    case 'OBJECTIVE':
      return client.query(
        'INSERT INTO okr_activity (entity_type, entity_id, actor_id, action, to_value, meta) VALUES ($1, $2, $3, $4, $5, $6)',
        [type, id, user.id, action, title, { todo_id: todo.id }]);
    default:
      return client.query(
        'INSERT INTO record_step_activity (record_type, record_id, actor_id, action, title, todo_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [type, id, user.id, action, title, todo.id]);
  }
}

/**
 * Add one to-do. Minimum input: a title. The day is what the caller says
 * (Today's plan sends today; elsewhere none, "Anytime"). A typed task
 * reference links privately when the person can see that task. The same
 * client key twice gives the same one to-do.
 */
export async function createTodo(user, input) {
  const result = await withTransaction((client) => insertTodo(client, user, input));
  return createdItem(user, result);
}

async function createdItem(user, result) {
  return {
    todo: result.row.moved_to_checklist_item_id ? null : await todoById(user, result.row.id),
    step: result.shared?.step || null,
    in_plan: result.shared?.in_plan ?? true,
    duplicate: result.duplicate,
    ref_note: result.ref_note,
  };
}

async function insertTodo(c, user, input) {
  const { today, settings } = await todayFor(user);
  const title = checkTitle(cleanTitle(input.title));
  const planned_on = readDay(input.planned_on, today) ?? null;
  const planned_time = readTime(input.planned_time) ?? null;
  const note = input.note ? String(input.note).slice(0, 2000) : null;
  if (input.list_id) await ownList(user, input.list_id, c);

  let linkType = input.link_type || null;
  let linkId = input.link_id ? Number(input.link_id) : null;
  let refNote = null;
  if (linkType) {
    if (!LINK_TYPES.includes(linkType) || !(await assertLinkable(user, linkType, linkId, settings))) throw notFound('That record is not available');
  } else if (input.read_ref !== false) {
    const ref = await referenceIn(user, title);
    if (ref?.task) { linkType = 'TASK'; linkId = ref.task.id; } else if (ref) refNote = ref.note;
  }

  const key = input.client_key ? String(input.client_key).slice(0, 200) : null;
  if (key) {
    const { rows } = await c.query('SELECT * FROM todos WHERE owner_user_id = $1 AND client_key = $2', [user.id, key]);
    if (rows[0]) return { row: rows[0], duplicate: true, ref_note: null };
  }
  const { rows } = await c.query(
    `INSERT INTO todos (owner_user_id, title, note, planned_on, planned_time, position, list_id, link_type, link_id, client_key, source, routine_id, routine_day)
     VALUES ($1, $2, $3, $4, $5,
             (SELECT COALESCE(MAX(position), 0) + 1 FROM todos WHERE owner_user_id = $1 AND planned_on IS NOT DISTINCT FROM $4::date AND list_id IS NOT DISTINCT FROM $6::int),
             $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (owner_user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [user.id, title, note, planned_on, planned_time, input.list_id || null, linkType, linkId,
      key, input.source || 'APP', input.routine_id || null, input.routine_day || null]);
  if (!rows[0]) {
    // a twin request got there first
    const again = await c.query('SELECT * FROM todos WHERE owner_user_id = $1 AND client_key = $2', [user.id, key]);
    return { row: again.rows[0], duplicate: true, ref_note: null };
  }
  let row = rows[0];
  let shared = null;
  // added on a record's own page: shared there (on a task, it becomes a step)
  if (input.shared && linkType) shared = await shareRow(c, user, row, settings);
  if (shared?.row) row = shared.row;
  return { row, duplicate: false, ref_note: refNote, shared };
}

/** Several lines pasted at once: one to-do each, in order, after one confirm. */
export async function createMany(user, input) {
  const lines = (input.lines || []).map(cleanTitle).filter(Boolean);
  if (!lines.length) throw badRequest('Nothing to add');
  if (lines.length > 50) throw badRequest('Add up to 50 at a time');
  const results = await withTransaction(async (client) => {
    const out = [];
    for (const [i, line] of lines.entries()) {
      out.push(await insertTodo(client, user, {
        ...input, title: line, source: 'PASTE',
        client_key: input.client_key ? `${input.client_key}#${i}` : null,
      }));
    }
    return out;
  });
  const items = [];
  for (const r of results) items.push(await createdItem(user, r));
  return { created: items.filter((r) => !r.duplicate).length, items };
}

/** Change one to-do: words, day, time, done, list, link, "still want this". */
export async function updateTodo(user, id, input) {
  let ask = null;
  const result = await withTransaction(async (client) => {
    const { today, settings } = await todayFor(user);
    const row = await ownTodo(user, id, client);
    if (row.moved_to_checklist_item_id) throw conflict('This to-do is a step on a task now; change it there');
    const sets = [];
    const params = [];
    const set = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };

    if (input.title !== undefined) set('title', checkTitle(cleanTitle(input.title)));
    if (input.note !== undefined) set('note', input.note ? String(input.note).slice(0, 2000) : null);
    const day = readDay(input.planned_on, today);
    if (day !== undefined && day !== dayOf(row.planned_on)) {
      set('planned_on', day);
      await client.query('INSERT INTO todo_moves (todo_id, from_day, to_day) VALUES ($1, $2, $3)', [row.id, dayOf(row.planned_on), day]);
      if (input.position === undefined) {
        // to the bottom of the day it moves to
        params.push(user.id, day);
        sets.push(`position = (SELECT COALESCE(MAX(position), 0) + 1 FROM todos WHERE owner_user_id = $${params.length - 1} AND planned_on IS NOT DISTINCT FROM $${params.length}::date)`);
      }
    }
    const time = readTime(input.planned_time);
    if (time !== undefined) set('planned_time', time);
    if (input.position !== undefined) set('position', Number(input.position) || 0);
    if (input.list_id !== undefined) {
      if (input.list_id) await ownList(user, input.list_id, client);
      set('list_id', input.list_id || null);
    }
    if (input.still_want === true) set('carry_asked_at', new Date());
    if (input.link !== undefined) {
      if (row.shared) throw conflict('Take it off the record first, then change its link');
      if (input.link) {
        if (!(await assertLinkable(user, input.link.type, input.link.id, settings))) throw notFound('That record is not available');
        set('link_type', input.link.type);
        set('link_id', Number(input.link.id));
      } else { set('link_type', null); set('link_id', null); }
    }
    if (input.done !== undefined && Boolean(input.done) !== Boolean(row.done_at)) {
      set('done_at', input.done ? new Date() : null);
      if (input.done) await cancelReminders(client, row);
      if (row.shared && row.link_type) await recordActivity(client, user, row.link_type, row.link_id, input.done ? 'step_done' : 'step_reopened', row);
    }
    if (!sets.length) return row;
    params.push(row.id);
    const { rows } = await client.query(`UPDATE todos SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
    return rows[0];
  });
  const item = await todoById(user, result.id);
  if (input.done === true) {
    // the "done" message: a private linked line may be added to its record's progress
    if (item.link?.visible && !item.shared) ask = { offer_share: `Add to its progress? It goes on ${item.link.word} ${item.link.label}.` };
  }
  return { todo: item, ...(ask || {}) };
}

/** Remove (from carried over, or anywhere): kept as archived, never deleted. */
export async function removeTodo(user, id) {
  return withTransaction(async (client) => {
    const row = await ownTodo(user, id, client);
    if (row.shared && row.link_type && !row.moved_to_checklist_item_id) await recordActivity(client, user, row.link_type, row.link_id, 'step_removed', row);
    await client.query('UPDATE todos SET archived_at = now(), updated_at = now() WHERE id = $1', [row.id]);
    await cancelReminders(client, row);
    return { ok: true };
  });
}

/** "Make it a task": the to-do closes as "Became WS-40". */
export async function becameTask(user, id, taskId) {
  await withTransaction(async (client) => {
    const row = await ownTodo(user, id, client);
    const task = await visibleTask(user, taskId, client);
    if (Number(task.created_by) !== user.id) throw forbidden('That task was not made from this to-do');
    await client.query('UPDATE todos SET became_task_id = $1, done_at = COALESCE(done_at, now()), updated_at = now() WHERE id = $2', [task.id, row.id]);
  });
  return { todo: await todoById(user, id) };
}

// ---------------------------------------------------------------- private and shared

/** Who will see a to-do once shared, said before anything is shared. */
export async function sharePreview(user, id) {
  const row = await ownTodo(user, id);
  const { rows: list } = row.list_id ? await query('SELECT link_type, link_id FROM todo_lists WHERE id = $1', [row.list_id]) : { rows: [] };
  const type = row.link_type || list[0]?.link_type;
  const linkId = row.link_type ? row.link_id : list[0]?.link_id;
  if (!type) throw badRequest('Link it to a record first');
  const link = await describeLink(user, type, linkId);
  if (!link?.visible) throw notFound('That record is not available');
  const words = `People who can see ${link.word === 'task' ? '' : `${link.word[0].toUpperCase()}${link.word.slice(1)} `}${link.label} will see this.`;
  if (type !== 'TASK') return { link: publicLink(link), becomes: 'RECORD_STEP', words, stays_in_plan: true };
  const task = await visibleTask(user, linkId);
  const owns = await mayOwnStep(task, user.id);
  return {
    link: publicLink(link), becomes: 'STEP', stays_in_plan: owns,
    words: `${words} It becomes a step on ${task.ref}${owns ? ', and stays in your plan.' : '.'}`,
    note: owns ? null : 'It leaves your plan: only the assignee or a collaborator can own a step.',
  };
}

async function shareRow(client, user, row, settings) {
  let type = row.link_type;
  let linkId = row.link_id;
  if (!type && row.list_id) {
    const { rows } = await client.query('SELECT link_type, link_id FROM todo_lists WHERE id = $1', [row.list_id]);
    type = rows[0]?.link_type; linkId = rows[0]?.link_id;
  }
  if (!type) throw badRequest('Link it to a record first');
  if (!(await assertLinkable(user, type, linkId, settings))) throw notFound('That record is not available');
  if (type === 'TASK') {
    const task = await visibleTask(user, linkId, client);
    const owns = await mayOwnStep(task, user.id, client);
    const step = await addStep(client, user, task, {
      title: row.title, owner_user_id: owns ? user.id : null, planned_on: dayOf(row.planned_on), planned_time: row.planned_time,
      is_done: Boolean(row.done_at), done_at: row.done_at,
    });
    const { rows } = await client.query(
      `UPDATE todos SET moved_to_checklist_item_id = $1, shared = TRUE, shared_at = now(), link_type = 'TASK', link_id = $2, updated_at = now()
        WHERE id = $3 RETURNING *`, [step.id, task.id, row.id]);
    return { row: rows[0], step, in_plan: owns };
  }
  const { rows } = await client.query(
    'UPDATE todos SET shared = TRUE, shared_at = now(), link_type = $1, link_id = $2, updated_at = now() WHERE id = $3 RETURNING *',
    [type, linkId, row.id]);
  await recordActivity(client, user, type, linkId, 'step_added', row);
  return { row: rows[0], step: null, in_plan: true };
}

/** Share onto its record: an explicit tap, after sharePreview. */
export async function shareTodo(user, id) {
  const { settings } = await todayFor(user);
  const result = await withTransaction(async (client) => {
    const row = await ownTodo(user, id, client);
    if (row.shared) return { row, step: null, in_plan: true };
    return shareRow(client, user, row, settings);
  });
  return {
    todo: result.step ? null : await todoById(user, id),
    step: result.step, in_plan: result.in_plan,
  };
}

/** Back to private (creator or owner). The record's activity keeps "removed a step". */
export async function unshareTodo(user, id) {
  await withTransaction(async (client) => {
    const row = await ownTodo(user, id, client);
    if (!row.shared || row.moved_to_checklist_item_id) throw badRequest('This to-do is not shared on a record');
    await client.query('UPDATE todos SET shared = FALSE, shared_at = NULL, updated_at = now() WHERE id = $1', [row.id]);
    await recordActivity(client, user, row.link_type, row.link_id, 'step_removed', row);
  });
  return { todo: await todoById(user, id) };
}

/** A step taken back into a private to-do by the person who added it or its owner. */
export async function unshareStep(user, stepId) {
  const todoId = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM task_checklist_items WHERE id = $1', [Number(stepId)]);
    const step = rows[0];
    if (!step) throw notFound('Step not found');
    const task = await visibleTask(user, step.task_id, client);
    if (Number(step.created_by) !== user.id && Number(step.owner_user_id) !== user.id) {
      throw forbidden('Only the person who added the step or its owner can take it back');
    }
    const { rows: origin } = await client.query(
      'SELECT * FROM todos WHERE moved_to_checklist_item_id = $1 AND owner_user_id = $2', [step.id, user.id]);
    let id;
    if (origin[0]) {
      id = origin[0].id;
      await client.query(
        `UPDATE todos SET moved_to_checklist_item_id = NULL, shared = FALSE, shared_at = NULL, archived_at = NULL,
                done_at = $1, title = $2, planned_on = $3, planned_time = $4, updated_at = now() WHERE id = $5`,
        [step.is_done ? (step.done_at || origin[0].done_at || null) : null, step.title, step.planned_on, step.planned_time, id]);
    } else {
      const { rows: made } = await client.query(
        `INSERT INTO todos (owner_user_id, title, planned_on, planned_time, done_at, link_type, link_id, source)
         VALUES ($1, $2, $3, $4, $5, 'TASK', $6, 'APP') RETURNING id`,
        [user.id, step.title, step.planned_on, step.planned_time, step.is_done ? step.done_at : null, task.id]);
      id = made[0].id;
    }
    await client.query('DELETE FROM task_checklist_items WHERE id = $1', [step.id]);
    await logActivity(client, { taskId: task.id, actorId: user.id, action: 'step_removed', to: step.title, meta: { step_id: step.id, todo_id: id } });
    return id;
  });
  return { todo: await todoById(user, todoId) };
}

/** Tick, plan or time one of my steps from Today's plan (the same row as on the task). */
export async function updateMyStep(user, stepId, input) {
  const { today } = await todayFor(user);
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM task_checklist_items WHERE id = $1 AND owner_user_id = $2', [Number(stepId), user.id]);
    if (!rows[0]) throw notFound('Step not found');
    let item = rows[0];
    const task = await visibleTask(user, item.task_id, client);
    const change = { planned_on: readDay(input.planned_on, today), planned_time: readTime(input.planned_time) };
    await checkStepChange(user, task, item, change, client);
    const sets = [];
    const params = [];
    for (const key of ['planned_on', 'planned_time']) {
      if (change[key] !== undefined) { params.push(change[key]); sets.push(`${key} = $${params.length}`); }
    }
    if (sets.length) {
      params.push(item.id);
      item = (await client.query(`UPDATE task_checklist_items SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params)).rows[0];
    }
    let ask = null;
    if (input.done !== undefined) {
      const r = await setStepDone(client, user, task, item, Boolean(input.done));
      item = r.item;
      ask = r.ask_complete;
    }
    return { step: item, ask_complete: ask };
  });
}

/** My order for Today's plan: keys like TODO:1, STEP:4, PIN:2. */
export async function reorder(user, keys) {
  if (!Array.isArray(keys) || keys.length > 300) throw badRequest('Send the items in their new order');
  await withTransaction(async (client) => {
    for (const [i, key] of keys.entries()) {
      const [source, raw] = String(key).split(':');
      const id = Number(raw);
      if (source === 'TODO') await client.query('UPDATE todos SET position = $1 WHERE id = $2 AND owner_user_id = $3', [i + 1, id, user.id]);
      else if (source === 'STEP') await client.query('UPDATE task_checklist_items SET owner_position = $1 WHERE id = $2 AND owner_user_id = $3', [i + 1, id, user.id]);
      else if (source === 'PIN') await client.query('UPDATE todo_pins SET position = $1 WHERE id = $2 AND user_id = $3', [i + 1, id, user.id]);
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------- pins and "Plan my day"

export async function addPin(user, { task_id, day }) {
  const { today } = await todayFor(user);
  const on = readDay(day ?? 'TODAY', today);
  const task = await visibleTask(user, task_id);
  const { rows } = await query(
    `INSERT INTO todo_pins (user_id, day, task_id, position)
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), 0) + 1 FROM todo_pins WHERE user_id = $1 AND day = $2::date))
     ON CONFLICT (user_id, day, task_id) DO UPDATE SET day = EXCLUDED.day RETURNING *`, [user.id, on, task.id]);
  return { pin: rows[0] };
}

/** Unpinning changes nothing on the task. */
export async function removePin(user, id) {
  const { rowCount } = await query('DELETE FROM todo_pins WHERE id = $1 AND user_id = $2', [Number(id), user.id]);
  if (!rowCount) throw notFound('Pin not found');
  return { ok: true };
}

/**
 * Suggestions for the day; nothing is added unless chosen. My tasks due today,
 * overdue or due within 2 days; my steps planned for other days; milestones of
 * my projects due this week with my open tasks in them; today's meetings.
 */
export async function planSuggestions(user, { now = new Date() } = {}) {
  const { today, tz, settings } = await todayFor(user, now);
  const soon = addDays(today, 2);
  const params = [user.id, today, soon, tz];
  const visible = taskVisibilitySql(user, params, 't');
  const { rows: tasks } = await query(
    `SELECT t.id, t.ref, t.title, t.due_date, ws.stage, (t.due_date AT TIME ZONE $4::text)::date AS due_day
       FROM tasks t JOIN workflow_statuses ws ON ws.id = t.status_id
      WHERE t.assignee_id = $1 AND t.is_archived = FALSE AND ws.stage NOT IN ('done', 'cancelled')
        AND t.due_date IS NOT NULL AND (t.due_date AT TIME ZONE $4::text)::date <= $3::date
        AND NOT EXISTS (SELECT 1 FROM todo_pins p WHERE p.user_id = $1 AND p.day = $2::date AND p.task_id = t.id)
        AND ${visible}
      ORDER BY t.due_date, t.id LIMIT 30`, params);
  const steps = await stepRows(user, tz, `${OPEN_STEP} AND ${STEP_DAY} IS DISTINCT FROM $3::date`, [today]);
  let milestones = [];
  if (settings.projects?.enabled !== false) {
    const { rows } = await query(
      `SELECT m.id, m.name, m.target_date, p.id AS project_id, p.name AS project_name
         FROM project_milestones m JOIN projects p ON p.id = m.project_id
        WHERE m.reached_at IS NULL AND m.target_date BETWEEN $2::date AND $3::date
          AND p.status IN ('PLANNED', 'ACTIVE', 'ON_HOLD') AND p.archived_at IS NULL
          AND (p.lead_user_id = $1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1))
        ORDER BY m.target_date, m.id`, [user.id, today, addDays(today, 6)]);
    for (const m of rows) {
      const tp = [user.id, m.id];
      const vis = taskVisibilitySql(user, tp, 't');
      const { rows: mine } = await query(
        `SELECT t.id, t.ref, t.title FROM tasks t JOIN workflow_statuses ws ON ws.id = t.status_id
          WHERE t.milestone_id = $2 AND t.assignee_id = $1 AND t.is_archived = FALSE AND ws.stage NOT IN ('done', 'cancelled') AND ${vis}
          ORDER BY t.due_date NULLS LAST, t.id`, tp);
      milestones.push({ id: m.id, name: m.name, target_date: dayOf(m.target_date), project: { id: m.project_id, name: m.project_name }, tasks: mine });
    }
    milestones = milestones.filter((m) => m.tasks.length);
  }
  const meetings = await meetingsOn(user, today, tz);
  const items = await itemsFrom(user, { steps }, { today, tz, settings, suggest: false });
  return {
    today,
    tasks: tasks.map((t) => ({ id: t.id, ref: t.ref, title: t.title, due_day: dayOf(t.due_day), overdue: dayOf(t.due_day) < today, due_today: dayOf(t.due_day) === today })),
    steps: items.steps,
    milestones,
    meetings: meetings.map((m) => ({ id: m.id, title: m.title, time: m.local_time })),
  };
}

// ---------------------------------------------------------------- lists

export async function lists(user) {
  const { rows } = await query(
    `SELECT l.*, count(td.id) FILTER (WHERE td.archived_at IS NULL)::int AS total,
            count(td.id) FILTER (WHERE td.archived_at IS NULL AND td.done_at IS NOT NULL)::int AS done
       FROM todo_lists l LEFT JOIN todos td ON td.list_id = l.id AND td.moved_to_checklist_item_id IS NULL
      WHERE l.owner_user_id = $1 AND l.archived_at IS NULL
      GROUP BY l.id ORDER BY l.position, l.created_at, l.id`, [user.id]);
  const links = await describeLinks(user, rows.filter((r) => r.link_type).map((r) => ({ type: r.link_type, id: r.link_id })));
  return {
    lists: rows.map((r) => ({
      id: r.id, name: r.name, total: r.total, done: r.done, left: r.total - r.done, created_at: r.created_at,
      link: r.link_type ? publicLink(links.get(keyOf(r.link_type, r.link_id))) : null, copied_from_id: r.copied_from_id,
    })),
  };
}

export async function createList(user, { name, link_type = null, link_id = null }) {
  const clean = cleanTitle(name);
  if (!clean) throw badRequest('Name the list');
  if (clean.length > 120) throw badRequest('Keep the name to 120 characters');
  if (link_type && !(await assertLinkable(user, link_type, link_id))) throw notFound('That record is not available');
  const { rows } = await query(
    `INSERT INTO todo_lists (owner_user_id, name, link_type, link_id, position)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position), 0) + 1 FROM todo_lists WHERE owner_user_id = $1)) RETURNING *`,
    [user.id, clean, link_type || null, link_type ? Number(link_id) : null]);
  return { list: rows[0] };
}

export async function updateList(user, id, input) {
  const list = await ownList(user, id);
  const sets = [];
  const params = [];
  if (input.name !== undefined) {
    const clean = cleanTitle(input.name);
    if (!clean || clean.length > 120) throw badRequest('Name the list (up to 120 characters)');
    params.push(clean); sets.push(`name = $${params.length}`);
  }
  if (input.link !== undefined) {
    if (input.link && !(await assertLinkable(user, input.link.type, input.link.id))) throw notFound('That record is not available');
    params.push(input.link?.type || null, input.link ? Number(input.link.id) : null);
    sets.push(`link_type = $${params.length - 1}`, `link_id = $${params.length}`);
  }
  if (!sets.length) return { list };
  params.push(list.id);
  const { rows } = await query(`UPDATE todo_lists SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
  return { list: rows[0] };
}

export async function listDetail(user, id) {
  const list = await ownList(user, id);
  const { today, tz, settings } = await todayFor(user);
  const rows = await todoRows(user, 'td.list_id = $2', [list.id]);
  const items = (await itemsFrom(user, { todos: rows }, { today, tz, settings })).todos;
  const link = list.link_type ? await describeLink(user, list.link_type, list.link_id, settings) : null;
  return { list: { id: list.id, name: list.name, link: publicLink(link), copied_from_id: list.copied_from_id }, items };
}

/** "Use again": a copy with every item unticked. */
export async function useListAgain(user, id) {
  const list = await ownList(user, id);
  const created = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO todo_lists (owner_user_id, name, link_type, link_id, copied_from_id, position)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(position), 0) + 1 FROM todo_lists WHERE owner_user_id = $1)) RETURNING *`,
      [user.id, list.name, list.link_type, list.link_id, list.id]);
    await client.query(
      `INSERT INTO todos (owner_user_id, title, note, position, list_id, link_type, link_id, source)
       SELECT owner_user_id, title, note, position, $1, link_type, link_id, 'LIST'
         FROM todos WHERE list_id = $2 AND owner_user_id = $3 AND archived_at IS NULL AND moved_to_checklist_item_id IS NULL
        ORDER BY position, id`, [rows[0].id, list.id, user.id]);
    return rows[0];
  });
  return listDetail(user, created.id);
}

export async function archiveList(user, id) {
  const list = await ownList(user, id);
  await query('UPDATE todo_lists SET archived_at = now(), updated_at = now() WHERE id = $1', [list.id]);
  return { ok: true };
}

// ---------------------------------------------------------------- on a record's page

/**
 * A record's to-dos for the person looking: their own private ones
 * ("My private to-dos (2)", nobody else sees these) and the steps shared onto
 * it, which everyone who can see the record sees (title, who, when; never the
 * note). For a key result, the steps done since its last check-in.
 */
export async function recordSteps(user, type, id) {
  if (!LINK_TYPES.includes(type)) throw notFound('Not found');
  const recordId = Number(id);
  const { today, tz, settings } = await todayFor(user);
  if (!(await assertLinkable(user, type, recordId, settings))) throw notFound('Not found');
  const mineRows = await todoRows(user,
    `NOT td.shared AND ((td.link_type = $2 AND td.link_id = $3) OR (td.link_type IS NULL AND td.list_id IN (SELECT id FROM todo_lists WHERE link_type = $2 AND link_id = $3)))`,
    [type, recordId]);
  const mine = (await itemsFrom(user, { todos: mineRows }, { today, tz, settings, suggest: false })).todos;
  let shared = [];
  let activity = [];
  if (type !== 'TASK') {
    const { rows } = await query(
      `SELECT td.id, td.title, td.done_at, td.planned_on, td.shared_at, td.created_at, td.owner_user_id, u.full_name AS owner_name
         FROM todos td JOIN users u ON u.id = td.owner_user_id
        WHERE td.shared AND td.link_type = $1 AND td.link_id = $2 AND td.archived_at IS NULL AND td.moved_to_checklist_item_id IS NULL
        ORDER BY td.done_at IS NOT NULL, td.shared_at, td.id`, [type, recordId]);
    shared = rows.map((r) => ({
      id: r.id, title: r.title, done: Boolean(r.done_at), done_at: r.done_at, planned_on: dayOf(r.planned_on),
      shared_at: r.shared_at, owner: { id: r.owner_user_id, name: r.owner_name }, mine: r.owner_user_id === user.id,
    }));
    if (['DEAL', 'APPLICATION', 'MEETING'].includes(type)) {
      const { rows: a } = await query(
        `SELECT a.action, a.title, a.created_at, u.full_name AS actor_name FROM record_step_activity a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.record_type = $1 AND a.record_id = $2 ORDER BY a.created_at DESC, a.id DESC LIMIT 50`, [type, recordId]);
      activity = a;
    }
  }
  const out = {
    record: { type, id: recordId },
    mine, mine_count: mine.length,
    shared, steps_done: shared.filter((s) => s.done).length, steps_total: shared.length,
    activity,
  };
  if (type === 'KEY_RESULT') {
    const { rows } = await query('SELECT max(created_at) AS last FROM key_result_check_ins WHERE key_result_id = $1', [recordId]);
    const last = rows[0]?.last || null;
    out.last_check_in = last;
    out.done_since_check_in = shared.filter((s) => s.done && (!last || new Date(s.done_at) > new Date(last)));
  }
  return out;
}

// ---------------------------------------------------------------- personal switches

export async function setPrefs(user, { hide_done }) {
  if (hide_done !== undefined) await query('UPDATE users SET notebook_hide_done = $1 WHERE id = $2', [Boolean(hide_done), user.id]);
  const { rows } = await query('SELECT notebook_hide_done FROM users WHERE id = $1', [user.id]);
  return { hide_done: rows[0].notebook_hide_done };
}
