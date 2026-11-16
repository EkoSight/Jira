/**
 * Routines: repeating to-dos (Part D). Private to their owner, like every
 * to-do.
 *
 *   WORKING_DAYS  every day the person works
 *   WEEKLY        on chosen days of the week (1 Monday … 7 Sunday)
 *   MONTHLY       on a date of the month (the month's last day when it is shorter)
 *
 * "Working day" is this person's own calendar: their weekly off, the holidays
 * that cover them and approved full-day leave (services/dayProtection.js),
 * and a routine makes nothing on a day they do not work, whatever its kind.
 *
 * One item is made on the person's day, once: last_made_on records the day
 * a routine was last considered, and a unique (routine, day) index makes a
 * rerun harmless. Only today is ever considered, so downtime never backfills.
 * Editing a routine changes future items only; stopping it keeps every item
 * it made.
 */
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getSettings } from '../settings.js';
import { localDate } from '../../../../shared/deadlineHealth.js';
import { isWorkingDay } from '../dayProtection.js';
import { createTodo, zoneOf } from './index.js';
import { LINK_TYPES, assertLinkable, describeLinks } from './links.js';

const KINDS = ['WORKING_DAYS', 'WEEKLY', 'MONTHLY'];
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const WEEKDAY_WORDS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday of a date: 1 Monday … 7 Sunday. */
export const isoWeekday = (day) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const lastDayOfMonth = (day) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();

/** Whether a routine's pattern falls on this day (before the working-day check). */
export function patternMatches(routine, day) {
  if (routine.repeat_kind === 'WORKING_DAYS') return true;
  if (routine.repeat_kind === 'WEEKLY') return (routine.weekdays || []).map(Number).includes(isoWeekday(day));
  if (routine.repeat_kind === 'MONTHLY') {
    const date = Number(day.slice(8, 10));
    return date === Math.min(Number(routine.month_day), lastDayOfMonth(day));
  }
  return false;
}

/** "Every working day", "Weekly on Mon, Thu", "Monthly on the 5th". */
export function repeatWords(r) {
  if (r.repeat_kind === 'WORKING_DAYS') return 'Every working day';
  if (r.repeat_kind === 'WEEKLY') return `Weekly on ${(r.weekdays || []).map((d) => WEEKDAY_WORDS[d]).join(', ')}`;
  const n = Number(r.month_day);
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `Monthly on the ${n}${suffix}`;
}

function clean(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.title !== undefined) {
    const title = String(input.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) throw badRequest('Write what repeats');
    if (title.length > 200) throw badRequest('Keep it to 200 characters');
    out.title = title;
  }
  if (!partial || input.repeat_kind !== undefined) {
    if (!KINDS.includes(input.repeat_kind)) throw badRequest('Choose how it repeats');
    out.repeat_kind = input.repeat_kind;
    const days = [...new Set((input.weekdays || []).map(Number))].filter((d) => d >= 1 && d <= 7).sort();
    if (out.repeat_kind === 'WEEKLY' && !days.length) throw badRequest('Choose at least one day of the week');
    out.weekdays = out.repeat_kind === 'WEEKLY' ? days : [];
    const md = Number(input.month_day);
    if (out.repeat_kind === 'MONTHLY' && !(md >= 1 && md <= 31)) throw badRequest('Choose a date of the month, 1 to 31');
    out.month_day = out.repeat_kind === 'MONTHLY' ? md : null;
  }
  if (input.planned_time !== undefined) {
    if (input.planned_time && !TIME.test(input.planned_time)) throw badRequest('Write the time as HH:MM');
    out.planned_time = input.planned_time || null;
  }
  if (input.note !== undefined) out.note = input.note ? String(input.note).slice(0, 2000) : null;
  return out;
}

async function ownRoutine(user, id) {
  const { rows } = await query('SELECT * FROM todo_routines WHERE id = $1 AND owner_user_id = $2', [Number(id), user.id]);
  if (!rows[0]) throw notFound('Routine not found');
  return rows[0];
}

export async function listRoutines(user) {
  const { rows } = await query(
    `SELECT r.*, (SELECT count(*)::int FROM todos t WHERE t.routine_id = r.id) AS made
       FROM todo_routines r WHERE r.owner_user_id = $1 ORDER BY r.stopped_at IS NOT NULL, r.created_at, r.id`, [user.id]);
  const links = await describeLinks(user, rows.filter((r) => r.link_type).map((r) => ({ type: r.link_type, id: r.link_id })));
  return {
    routines: rows.map((r) => ({
      id: r.id, title: r.title, note: r.note, repeat_kind: r.repeat_kind, weekdays: r.weekdays, month_day: r.month_day,
      planned_time: r.planned_time, words: repeatWords(r), stopped: Boolean(r.stopped_at), stopped_at: r.stopped_at,
      made: r.made, last_made_on: r.last_made_on,
      link: r.link_type ? (({ type, id, label, url, visible }) => ({ type, id, label, url, visible }))(links.get(`${r.link_type}:${r.link_id}`) || {}) : null,
    })),
  };
}

export async function createRoutine(user, input) {
  const r = clean(input);
  let linkType = input.link_type || null;
  const linkId = input.link_id ? Number(input.link_id) : null;
  if (linkType && (!LINK_TYPES.includes(linkType) || !(await assertLinkable(user, linkType, linkId)))) throw notFound('That record is not available');
  if (!linkType) linkType = null;
  const { rows } = await query(
    `INSERT INTO todo_routines (owner_user_id, title, note, repeat_kind, weekdays, month_day, planned_time, link_type, link_id, starts_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [user.id, r.title, r.note ?? null, r.repeat_kind, r.weekdays, r.month_day, r.planned_time ?? null, linkType, linkType ? linkId : null,
      localDate(new Date(), zoneOf(user, await getSettings()))]);
  return { routine: rows[0] };
}

/** Future items only: what was already made stays as it is. */
export async function updateRoutine(user, id, input) {
  const current = await ownRoutine(user, id);
  if (current.stopped_at) throw badRequest('This routine is stopped');
  const r = clean(input, { partial: true });
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(r)) { params.push(v); sets.push(`${k} = $${params.length}`); }
  if (!sets.length) return { routine: current };
  params.push(current.id);
  const { rows } = await query(`UPDATE todo_routines SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
  return { routine: rows[0] };
}

/** Stopping keeps the history: every item it made stays. */
export async function stopRoutine(user, id) {
  const r = await ownRoutine(user, id);
  if (!r.stopped_at) await query('UPDATE todo_routines SET stopped_at = now(), updated_at = now() WHERE id = $1', [r.id]);
  return { ok: true };
}

/**
 * Make today's items, at most one per routine per day. Called every minute by
 * the reminder worker; each routine is considered once a day.
 */
export async function makeRoutineTodos({ now = new Date() } = {}) {
  const settings = await getSettings();
  if (settings.todos?.enabled === false) return { made: 0, skipped: 0 };
  const { rows } = await query(
    `SELECT r.*, u.timezone, u.department_id, u.is_active
       FROM todo_routines r JOIN users u ON u.id = r.owner_user_id
      WHERE r.stopped_at IS NULL AND u.is_active`);
  let made = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      if (await makeOne(r, settings, now)) made += 1; else skipped += 1;
    } catch (err) {
      // one routine failing never stops the others
      console.error(`[taskflow] routine ${r.id} failed:`, err.message);
    }
  }
  return { made, skipped };
}

/** Today's item for one routine; true when one was made now. */
async function makeOne(r, settings, now) {
  {
    const user = { id: r.owner_user_id, timezone: r.timezone };
    const today = localDate(now, zoneOf(user, settings));
    const last = r.last_made_on ? String(r.last_made_on).slice(0, 10) : null;
    if ((last && last >= today) || String(r.starts_on).slice(0, 10) > today) return false;
    const mark = () => query('UPDATE todo_routines SET last_made_on = $2 WHERE id = $1 AND (last_made_on IS NULL OR last_made_on < $2::date)', [r.id, today]);
    if (!patternMatches(r, today) || !(await isWorkingDay(r.owner_user_id, r.department_id, today))) { await mark(); return false; }
    const { rows: owner } = await query('SELECT * FROM users WHERE id = $1', [r.owner_user_id]);
    // the client key and the unique (routine, day) index make a rerun or a second server harmless
    const base = {
      title: r.title, note: r.note, planned_on: today, planned_time: r.planned_time, source: 'ROUTINE', read_ref: false,
      routine_id: r.id, routine_day: today, client_key: `routine:${r.id}:${today}`,
    };
    let result;
    try {
      result = await createTodo(owner[0], { ...base, link_type: r.link_type, link_id: r.link_id });
    } catch (err) {
      // a linked record the owner can no longer see: made without the link
      if (err.status === 404 && r.link_type) result = await createTodo(owner[0], base);
      else throw err;
    }
    await mark();
    return !result.duplicate;
  }
}
