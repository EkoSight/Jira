/**
 * Who is away, and when.
 *
 * Everything here works in calendar days in the organisation's timezone. "On
 * leave on the 14th" is a statement about a date, not about an instant, so a
 * deadline at 6pm on the 14th and one at 9am on the 14th are both "on the day
 * she is away" — while one at 00:30 on the 15th in India is not, even though the
 * server running in UTC would call it the 14th.
 *
 * Only exceptions are stored. A person with no entry for a day is available on
 * it, and "available" is never written down.
 */

import { query } from '../db/pool.js';
import { getSettings } from './settings.js';

export const AVAILABILITY_STATUSES = ['ON_LEAVE', 'HALF_DAY', 'UNAVAILABLE'];
export const DAY_PARTS = ['MORNING', 'AFTERNOON'];

const DAY = 86_400_000;

export const STATUS_LABEL = {
  ON_LEAVE: 'on leave',
  HALF_DAY: 'on a half day',
  UNAVAILABLE: 'unavailable',
};

/** The organisation's calendar settings, with safe defaults. */
export async function orgCalendar() {
  const settings = await getSettings();
  return {
    timezone: settings.organisation?.timezone || 'Asia/Kolkata',
    workingDays: settings.organisation?.workingDays || [1, 2, 3, 4, 5, 6],
  };
}

/** The calendar date (YYYY-MM-DD) an instant falls on, in the given timezone. */
export function dateIn(timezone, value = new Date()) {
  const instant = value instanceof Date ? value : new Date(value);
  // en-CA formats as YYYY-MM-DD, which is exactly the shape a DATE column wants
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/** A DATE value from Postgres (a Date at local midnight, or a string) as YYYY-MM-DD. */
export function asDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Day arithmetic on YYYY-MM-DD strings, free of any timezone. */
export function addDays(date, days) {
  const t = Date.parse(`${date}T00:00:00Z`) + days * DAY;
  return new Date(t).toISOString().slice(0, 10);
}

const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Working days in an inclusive range. */
export function workingDaysBetween(start, end, workingDays) {
  let count = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (workingDays.includes(weekday(d))) count += 1;
  }
  return count;
}

/** The first working day after a date. */
export function nextWorkingDay(date, workingDays) {
  let d = addDays(date, 1);
  for (let i = 0; i < 14 && !workingDays.includes(weekday(d)); i += 1) d = addDays(d, 1);
  return d;
}

const SELECT = `
  SELECT a.*, u.full_name, u.avatar_color, u.department_id, d.name AS department_name,
         c.full_name AS created_by_name
    FROM user_availability a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN users c ON c.id = a.created_by
`;

/** Adds what can be worked out and should never be stored. */
export function decorate(row, { today, workingDays, timezone = 'Asia/Kolkata' }) {
  const start = asDate(row.start_date);
  const end = asDate(row.end_date);
  return {
    ...row,
    start_date: start,
    end_date: end,
    days: Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1,
    working_days: row.status === 'HALF_DAY' ? 0.5 : workingDaysBetween(start, end, workingDays),
    // booked before it began: a planned absence rather than a same-day one
    planned: dateIn(timezone, row.created_at) < start,
    is_current: start <= today && end >= today,
    is_upcoming: start > today,
    is_past: end < today,
    back_on: row.status === 'HALF_DAY' ? null : nextWorkingDay(end, workingDays),
  };
}

/** Entries overlapping [from, to], optionally for some people. Cancelled ones excluded. */
export async function listAvailability({ from, to, userIds = null, includeInactive = false } = {}) {
  const { timezone, workingDays } = await orgCalendar();
  const today = dateIn(timezone);
  const params = [from, to];
  const where = ['a.cancelled_at IS NULL', 'a.start_date <= $2::date', 'a.end_date >= $1::date'];
  if (!includeInactive) where.push('u.is_active = TRUE');
  if (userIds?.length) {
    params.push(userIds);
    where.push(`a.user_id = ANY($${params.length}::int[])`);
  }
  const { rows } = await query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_date, u.full_name`,
    params,
  );
  return rows.map((row) => decorate(row, { today, workingDays, timezone }));
}

export async function getEntry(id) {
  const { timezone, workingDays } = await orgCalendar();
  const { rows } = await query(`${SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? decorate(rows[0], { today: dateIn(timezone), workingDays, timezone }) : null;
}

/** Any live entry for this person that shares a day with the range. */
export async function findOverlap(userId, start, end, exceptId = null) {
  const { rows } = await query(
    `SELECT id, status, start_date, end_date FROM user_availability
      WHERE user_id = $1 AND cancelled_at IS NULL
        AND start_date <= $3::date AND end_date >= $2::date
        AND ($4::int IS NULL OR id <> $4::int)
      LIMIT 1`,
    [userId, start, end, exceptId],
  );
  return rows[0] || null;
}

/**
 * Where each person stands on one date: a map of user id to their entry.
 * Anyone missing from the map is available that day.
 */
export async function statusOn(date, userIds = null) {
  const entries = await listAvailability({ from: date, to: date, userIds });
  return new Map(entries.map((e) => [e.user_id, e]));
}

/**
 * Whether a deadline lands while its owner is away, and how much of the run-up
 * they will miss. The warning a manager sees before assigning.
 *
 * `due` is an instant; it is turned into the organisation's calendar date first.
 */
export async function checkAssignment(userId, due, { now = new Date() } = {}) {
  if (!userId || !due) return null;
  const { timezone, workingDays } = await orgCalendar();
  const today = dateIn(timezone, now);
  const dueDate = dateIn(timezone, due);
  if (dueDate < today) return null;

  const entries = await listAvailability({ from: today, to: dueDate, userIds: [userId] });
  if (!entries.length) return null;

  const onDue = entries.find((e) => e.start_date <= dueDate && e.end_date >= dueDate) || null;

  // working days between now and the deadline, and how many of them they are away
  let window = 0;
  let away = 0;
  for (let d = today; d <= dueDate; d = addDays(d, 1)) {
    if (!workingDays.includes(weekday(d))) continue;
    window += 1;
    const hit = entries.find((e) => e.start_date <= d && e.end_date >= d);
    if (hit) away += hit.status === 'HALF_DAY' ? 0.5 : 1;
  }

  return {
    user_id: userId,
    full_name: entries[0].full_name,
    due_date: dueDate,
    on_due_date: onDue,
    working_days_until_due: window,
    working_days_away: away,
    entries,
    // the earliest working day they are back after the absence covering the due date
    suggested_due_date: onDue && onDue.status !== 'HALF_DAY' ? onDue.back_on : null,
  };
}

/**
 * Tasks already assigned to someone that fall due while they will be away.
 * Shown when leave is booked, so work can be handed over before it goes.
 */
export async function tasksDueDuring(userId, start, end) {
  const { timezone } = await orgCalendar();
  const { rows } = await query(
    `SELECT t.id, t.ref, t.title, t.due_date, t.reporter_id, t.created_by,
            (t.due_date AT TIME ZONE $4)::date AS due_day
       FROM tasks t
       JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.assignee_id = $1 AND t.is_archived = FALSE
        AND s.stage NOT IN ('done', 'cancelled')
        AND t.due_date IS NOT NULL
        AND (t.due_date AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY t.due_date`,
    [userId, start, end, timezone],
  );
  return rows.map((row) => ({ ...row, due_day: asDate(row.due_day) }));
}
