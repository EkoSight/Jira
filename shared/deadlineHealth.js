/**
 * Deadline health: one definition of "overdue", "due today" and "due soon",
 * used by the server (lists, counts, the dashboard, Google Chat), the board,
 * the list and My Tasks. Before this, the board said "Due today" for a task
 * due at 10:00 when it was 15:00, while My Tasks and Chat called it overdue,
 * and the browser used the device's time zone while Chat used India time.
 *
 * Rules, in the organisation's time zone:
 *   Overdue      the due time has passed (D4: at the due time, not at the end of the day)
 *   Due today    due later today
 *   Due soon     due after today, by the end of the Nth working day (default 3)
 *   Upcoming     due later than that
 *   No deadline  no deadline and no review date
 *   Review due   deferred (or Backlog work with no deadline) whose review date is today or past
 *   Review later the same, with the review date still ahead
 *
 * A deferred task (an approved deferral) is never overdue: its deadline is
 * paused and its review date is what counts. Exactly one code per task, so
 * groups built from codes never overlap and their counts add up.
 */

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5, 6];
export const DEFAULT_DUE_SOON_DAYS = 3;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- calendar

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(instant, timezone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant instanceof Date ? instant : new Date(instant));
}

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Day of the week of a date: Sunday 0 … Saturday 6. */
export const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

function offsetAt(timezone, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}

/** The instant a calendar date begins in a time zone. */
export function startOfDay(date, timezone = DEFAULT_TIMEZONE) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const first = guess - offsetAt(timezone, guess);
  return new Date(guess - offsetAt(timezone, first));
}

/** The instant a calendar date ends (the next day's start). */
export const endOfDay = (date, timezone = DEFAULT_TIMEZONE) => startOfDay(addDays(date, 1), timezone);

/** The end of the Nth working day after `date` (today does not count). */
export function endOfWorkingDays(date, n, { timezone = DEFAULT_TIMEZONE, workingDays = DEFAULT_WORKING_DAYS } = {}) {
  const days = workingDays?.length ? workingDays : DEFAULT_WORKING_DAYS;
  let d = date;
  let counted = 0;
  for (let i = 0; i < 60 && counted < n; i += 1) {
    d = addDays(d, 1);
    if (days.includes(weekdayOf(d))) counted += 1;
  }
  return endOfDay(d, timezone);
}

// ---------------------------------------------------------------- health

const isOpen = (stage) => stage !== 'done' && stage !== 'cancelled';
const toDate = (v) => (v ? (v instanceof Date ? v : new Date(v)) : null);
const reviewDateOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/** The boundaries for one moment, worked out once and reused for many tasks. */
export function clock(now = new Date(), {
  timezone = DEFAULT_TIMEZONE, workingDays = DEFAULT_WORKING_DAYS, dueSoonDays = DEFAULT_DUE_SOON_DAYS,
} = {}) {
  const at = toDate(now);
  const today = localDate(at, timezone);
  return {
    now: at,
    timezone,
    today,
    tomorrow: addDays(today, 1),
    endToday: endOfDay(today, timezone),
    endTomorrow: endOfDay(addDays(today, 1), timezone),
    endSoon: endOfWorkingDays(today, dueSoonDays, { timezone, workingDays }),
    end7: endOfDay(addDays(today, 7), timezone),
    end30: endOfDay(addDays(today, 30), timezone),
    dueSoonDays,
    workingDays,
  };
}

/**
 * The health of one task. `task` needs stage, due_date and, where they
 * exist, review_date and deferral_id. Returns { code, deferred, overdueMs, reviewDue }.
 */
export function healthOf(task, c) {
  if (!isOpen(task.stage)) return { code: 'DONE', deferred: false, overdueMs: 0, reviewDue: false };
  const deferred = Boolean(task.deferral_id);
  const review = reviewDateOf(task.review_date);
  const reviewDue = Boolean(review && review <= c.today);
  const due = toDate(task.due_date);
  if (deferred || (!due && review)) {
    return { code: reviewDue || !review ? 'REVIEW_DUE' : 'REVIEW_LATER', deferred, overdueMs: 0, reviewDue: reviewDue || !review };
  }
  if (!due) return { code: 'NO_DEADLINE', deferred: false, overdueMs: 0, reviewDue: false };
  const t = due.getTime();
  if (t < c.now.getTime()) return { code: 'OVERDUE', deferred: false, overdueMs: c.now.getTime() - t, reviewDue };
  if (t < c.endToday.getTime()) return { code: 'DUE_TODAY', deferred: false, overdueMs: 0, reviewDue };
  if (t < c.endSoon.getTime()) return { code: 'DUE_SOON', deferred: false, overdueMs: 0, reviewDue };
  return { code: 'UPCOMING', deferred: false, overdueMs: 0, reviewDue };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How long overdue, in words: "3 h", "2 days". */
export function overdueWords(ms) {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (hours < 24) return `${hours} h`;
  return plural(Math.floor(hours / 24), 'day');
}

const timeFmt = (timezone) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = (timezone) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' });
const reviewFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

export const HEALTH_TONE = {
  OVERDUE: 'critical', DUE_TODAY: 'warning', DUE_SOON: 'serious', UPCOMING: 'neutral',
  NO_DEADLINE: 'warning', REVIEW_DUE: 'warning', REVIEW_LATER: 'neutral', DONE: 'neutral',
};

/** The words and tone for a task's deadline: what every card, row and message shows. */
export function healthLabel(task, c) {
  const h = healthOf(task, c);
  const due = toDate(task.due_date);
  const review = reviewDateOf(task.review_date);
  let text;
  switch (h.code) {
    case 'OVERDUE': text = `Overdue · ${overdueWords(h.overdueMs)}`; break;
    case 'DUE_TODAY': text = `Due today ${timeFmt(c.timezone).format(due)}`; break;
    case 'DUE_SOON':
      text = localDate(due, c.timezone) === c.tomorrow
        ? `Due tomorrow ${timeFmt(c.timezone).format(due)}`
        : `Due ${dayFmt(c.timezone).format(due)}`;
      break;
    case 'UPCOMING': text = `Due ${dayFmt(c.timezone).format(due)}`; break;
    case 'NO_DEADLINE': text = 'No deadline'; break;
    case 'REVIEW_DUE': text = h.deferred ? 'Deferred · review due' : 'Review due'; break;
    case 'REVIEW_LATER': text = `${h.deferred ? 'Deferred · review' : 'Review'} ${reviewFmt.format(new Date(`${review}T00:00:00Z`))}`; break;
    default: text = due ? `Was due ${dayFmt(c.timezone).format(due)}` : 'Done';
  }
  return { ...h, text, tone: HEALTH_TONE[h.code] };
}

// ---------------------------------------------------------------- filters and groups

/** The board's date filters. Each is a test on one task; "next 7 days" never includes overdue work. */
export const DUE_FILTERS = {
  overdue: (t, h) => h.code === 'OVERDUE',
  today: (t, h) => h.code === 'DUE_TODAY',
  tomorrow: (t, h, c) => (h.code === 'DUE_SOON' || h.code === 'UPCOMING') && localDate(toDate(t.due_date), c.timezone) === c.tomorrow,
  soon: (t, h) => h.code === 'DUE_TODAY' || h.code === 'DUE_SOON',
  next7: (t, h, c) => ['DUE_TODAY', 'DUE_SOON', 'UPCOMING'].includes(h.code) && toDate(t.due_date) < c.end7,
  next30: (t, h, c) => ['DUE_TODAY', 'DUE_SOON', 'UPCOMING'].includes(h.code) && toDate(t.due_date) < c.end30,
  upcoming: (t, h, c) => ['DUE_SOON', 'UPCOMING'].includes(h.code) && toDate(t.due_date) < c.end7,
  later: (t, h, c) => ['DUE_SOON', 'UPCOMING'].includes(h.code) && toDate(t.due_date) >= c.end7,
  none: (t, h) => h.code === 'NO_DEADLINE',
  review: (t, h) => h.code === 'REVIEW_DUE',
  review_later: (t, h) => h.code === 'REVIEW_LATER',
};

export const DUE_FILTER_LABEL = {
  overdue: 'Overdue', today: 'Due today', tomorrow: 'Due tomorrow', next7: 'Next 7 days', next30: 'Next 30 days',
  none: 'No deadline', review: 'Review due', range: 'Date range',
};

/** Whether a task's deadline falls in a custom range of calendar days (inclusive), any status. */
export function inRange(task, from, to, timezone = DEFAULT_TIMEZONE) {
  const due = toDate(task.due_date);
  if (!due) return false;
  if (from && due < startOfDay(from, timezone)) return false;
  if (to && due >= endOfDay(to, timezone)) return false;
  return true;
}

/**
 * My Tasks groups: one per open task, never two. Blocked work is its own group
 * whatever its deadline; the rest follow the health code.
 */
export const MY_GROUPS = [
  { key: 'overdue', title: 'Overdue', filter: { due: 'overdue', exclude_stage: 'blocked' } },
  { key: 'today', title: 'Today', filter: { due: 'today', exclude_stage: 'blocked' } },
  { key: 'upcoming', title: 'Upcoming · next 7 days', filter: { due: 'upcoming', exclude_stage: 'blocked' } },
  { key: 'blocked', title: 'Blocked', filter: { stage: 'blocked' } },
  { key: 'review', title: 'Backlog review due', filter: { due: 'review', exclude_stage: 'blocked' } },
  { key: 'undated', title: 'Needs a date', filter: { due: 'none', exclude_stage: 'blocked' } },
  { key: 'later', title: 'Later', filter: { due: 'later', exclude_stage: 'blocked' }, collapsed: true },
  { key: 'deferred', title: 'Deferred and scheduled reviews', filter: { due: 'review_later', exclude_stage: 'blocked' }, collapsed: true },
];

export function groupOf(task, c) {
  const h = healthOf(task, c);
  if (h.code === 'DONE') return null;
  if (task.stage === 'blocked') return 'blocked';
  switch (h.code) {
    case 'OVERDUE': return 'overdue';
    case 'DUE_TODAY': return 'today';
    case 'REVIEW_DUE': return 'review';
    case 'REVIEW_LATER': return 'deferred';
    case 'NO_DEADLINE': return 'undated';
    default: return toDate(task.due_date) < c.end7 ? 'upcoming' : 'later';
  }
}

/** Applies the board's deadline filters to rows already narrowed by everything else. */
export function applyDueFilter(rows, { due, due_from: from, due_to: to, exclude_stage: exclude }, c) {
  const excluded = exclude ? String(exclude).split(',') : [];
  return rows.filter((t) => {
    if (excluded.includes(t.stage)) return false;
    if (!due) return true;
    if (due === 'range') return inRange(t, from, to, c.timezone);
    const test = DUE_FILTERS[due];
    if (!test) return true;
    return test(t, healthOf(t, c), c);
  });
}
