/**
 * The notebook's pages (Part N): any day's page, a week, the month index and
 * the day's notes. The same item shape and the same row functions as Today's
 * plan, so every count still equals its list.
 *
 * A past page shows the day as it was left: what was planned, what was done,
 * and what moved away (with its "-> date", from todo_moves). Looking at a page
 * changes nothing.
 */
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { addDays } from '../../../../shared/deadlineHealth.js';
import { meetingsOn } from './links.js';
import {
  OPEN_STEP, STEP_DAY, createTodo, itemsFrom, pinRows, planOrder, prefsOf, stepRows, todayFor, todayPlan, todoRows,
} from './index.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

function checkDay(day) {
  if (!DATE.test(String(day || '')) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw badRequest('Choose a day');
  return String(day);
}

/** ISO week number of a date. */
export function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/** Monday of the week a day is in. */
export const mondayOf = (day) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

async function noteFor(userId, day) {
  const { rows } = await query('SELECT body, updated_at FROM todo_day_notes WHERE owner_user_id = $1 AND day = $2', [userId, day]);
  return rows[0] ? { body: rows[0].body, updated_at: rows[0].updated_at } : { body: '', updated_at: null };
}

/** Lines that moved away from a day: still shown on it, greyed, with where they went. */
async function movedAway(user, day) {
  const { rows } = await query(
    `SELECT DISTINCT ON (td.id) td.id, td.title, td.done_at, mv.to_day, mv.moved_at
       FROM todo_moves mv JOIN todos td ON td.id = mv.todo_id
      WHERE td.owner_user_id = $1 AND mv.from_day = $2::date AND td.archived_at IS NULL
        AND td.planned_on IS DISTINCT FROM $2::date
      ORDER BY td.id, mv.moved_at DESC`, [user.id, day]);
  return rows.map((r) => ({
    source: 'MOVED', key: `MOVED:${r.id}`, id: r.id, title: r.title, moved_to: dayOf(r.to_day), done: false, moved_at: r.moved_at,
  }));
}

/**
 * One day's page. Today is Today's plan (carried over, today, fixed times,
 * done) plus notes and moved lines; any other day lists what was planned on
 * it, open or done.
 */
export async function dayPage(user, day, { now = new Date() } = {}) {
  const { today, tz, settings } = await todayFor(user, now);
  const d = checkDay(day || today);
  const [note, moved, prefs] = await Promise.all([noteFor(user.id, d), movedAway(user, d), prefsOf(user.id)]);
  const base = { day: d, today, timezone: tz, week: isoWeek(d), is_today: d === today, is_past: d < today, note, moved, prefs };
  if (d === today) {
    const plan = await todayPlan(user, { now });
    return { ...plan, ...base, hide_done: prefs.hide_done };
  }
  const [todos, steps, pins, meetings] = await Promise.all([
    todoRows(user, 'td.planned_on = $2::date', [d]),
    stepRows(user, tz, `${STEP_DAY} = $3::date AND (${OPEN_STEP} OR ci.is_done)`, [d]),
    pinRows(user, d),
    meetingsOn(user, d, tz),
  ]);
  const items = await itemsFrom(user, { todos, steps, pins }, { today, tz, settings, suggest: d >= today });
  // on another day's page nothing is "carried": each line is on the day it was planned for
  const all = [...items.todos, ...items.steps, ...items.pins].map((i) => ({ ...i, carried_from: null, ask_still_want: false })).sort(planOrder);
  return {
    ...base,
    carried: [], items: all, hide_done: prefs.hide_done,
    meetings: meetings.map((m) => ({ id: m.id, title: m.title, time: m.local_time, status: m.status, url: `/meetings?meeting=${m.id}` })),
    left: all.filter((i) => !i.done).length,
    done_count: all.filter((i) => i.done && !i.became).length,
    carried_count: 0,
  };
}

/** A week, Monday to Sunday: each day's lines (open and done) and its note. */
export async function weekPage(user, day, { now = new Date() } = {}) {
  const { today, tz, settings } = await todayFor(user, now);
  const monday = mondayOf(checkDay(day || today));
  const sunday = addDays(monday, 6);
  const [todos, steps, notes] = await Promise.all([
    todoRows(user, 'td.planned_on BETWEEN $2::date AND $3::date', [monday, sunday]),
    stepRows(user, tz, `${STEP_DAY} BETWEEN $3::date AND $4::date AND (${OPEN_STEP} OR ci.is_done)`, [monday, sunday]),
    query('SELECT day, body FROM todo_day_notes WHERE owner_user_id = $1 AND day BETWEEN $2 AND $3 AND body <> \'\' ORDER BY day', [user.id, monday, sunday]),
  ]);
  const items = await itemsFrom(user, { todos, steps }, { today, tz, settings, suggest: false });
  const all = [...items.todos, ...items.steps].map((i) => ({ ...i, carried_from: null }));
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(monday, i);
    days.push({ day: d, is_today: d === today, items: all.filter((x) => x.planned_on === d).sort(planOrder) });
  }
  return {
    today, monday, sunday, week: isoWeek(monday), days,
    notes: notes.rows.map((n) => ({ day: dayOf(n.day), body: n.body })),
  };
}

/** The month index: which days have lines, and how many are still open. */
export async function monthIndex(user, month, { now = new Date() } = {}) {
  const { today, tz } = await todayFor(user, now);
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : today.slice(0, 7);
  const first = `${m}-01`;
  const last = addDays(`${addDays(first, 32).slice(0, 7)}-01`, -1);
  const { rows } = await query(
    `SELECT planned_on AS day, count(*)::int AS total, count(*) FILTER (WHERE done_at IS NULL)::int AS open
       FROM todos WHERE owner_user_id = $1 AND archived_at IS NULL AND moved_to_checklist_item_id IS NULL
        AND planned_on BETWEEN $2::date AND $3::date GROUP BY planned_on`, [user.id, first, last]);
  const steps = await stepRows(user, tz, `${STEP_DAY} BETWEEN $3::date AND $4::date`, [first, last]);
  const { rows: notes } = await query(`SELECT day FROM todo_day_notes WHERE owner_user_id = $1 AND day BETWEEN $2 AND $3 AND body <> ''`, [user.id, first, last]);
  const days = new Map();
  const at = (d) => { if (!days.has(d)) days.set(d, { day: d, total: 0, open: 0, note: false }); return days.get(d); };
  for (const r of rows) { const x = at(dayOf(r.day)); x.total += r.total; x.open += r.open; }
  for (const s of steps) { const x = at(dayOf(s.on_day)); x.total += 1; if (!s.is_done) x.open += 1; }
  for (const n of notes) at(dayOf(n.day)).note = true;
  return { month: m, first, last, today, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

/** The day's notes: plain text, private, saved as typed. The later save wins. */
export async function saveNote(user, day, body) {
  const d = checkDay(day);
  const text = String(body ?? '');
  if (text.length > 10000) throw badRequest('Notes for one day can be up to 10,000 characters');
  const { rows } = await query(
    `INSERT INTO todo_day_notes (owner_user_id, day, body) VALUES ($1, $2, $3)
     ON CONFLICT (owner_user_id, day) DO UPDATE SET body = EXCLUDED.body, updated_at = now()
     RETURNING body, updated_at`, [user.id, d, text]);
  return { note: rows[0] };
}

export async function getNote(user, day) {
  return { note: await noteFor(user.id, checkDay(day)) };
}

/** "Make this a to-do": one line of the notes becomes a to-do on that day; the note keeps the line. */
export async function noteLineToTodo(user, day, line, clientKey = null) {
  const d = checkDay(day);
  const title = String(line || '').replace(/\s+/g, ' ').trim();
  if (!title) throw badRequest('Choose a line with words on it');
  const note = await noteFor(user.id, d);
  if (!note.body.split(/\r?\n/).some((l) => l.replace(/\s+/g, ' ').trim() === title)) throw notFound('That line is not in the notes');
  return createTodo(user, { title, planned_on: d, source: 'NOTE', client_key: clientKey, read_ref: true });
}
