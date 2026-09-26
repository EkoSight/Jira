/**
 * How availability reads.
 *
 * "Available" is the absence of an entry, never a stored value, so everything
 * here takes an entry that may be null and says what it means in words a person
 * would use: "On leave until Friday", "Half day (afternoon) today".
 *
 * Dates are YYYY-MM-DD calendar days, the same shape the server uses. They are
 * handled as plain strings on purpose — turning "2026-10-14" into a Date and
 * back is how a leave day quietly becomes the day before in a browser west of UTC.
 */

export const AVAILABILITY_STATUSES = [
  { value: 'ON_LEAVE', label: 'On leave', short: 'Leave', tone: 'warning', hint: 'Away for the whole day' },
  { value: 'HALF_DAY', label: 'Half day', short: 'Half day', tone: 'brand', hint: 'Away for the morning or the afternoon' },
  { value: 'UNAVAILABLE', label: 'Unavailable', short: 'Unavailable', tone: 'critical', hint: 'Working, but not reachable for new work — travel, training, field visits' },
];

export const STATUS_META = {
  AVAILABLE: { value: 'AVAILABLE', label: 'Available', short: 'Available', tone: 'good' },
  ...Object.fromEntries(AVAILABILITY_STATUSES.map((s) => [s.value, s])),
};

export const DAY_PART_LABEL = { MORNING: 'morning', AFTERNOON: 'afternoon' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** "Mon 14 Oct" — a leave date as people say it. */
export function dayLabel(date, { weekday = true } = {}) {
  if (!date) return '';
  const [, m, d] = date.split('-').map(Number);
  const base = `${d} ${MONTHS[m - 1]}`;
  return weekday ? `${WEEKDAYS[weekdayOf(date)]} ${base}` : base;
}

/** Today as a calendar date in the given timezone (the organisation's). */
export function todayIn(timezone = 'Asia/Kolkata', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** "14–18 Oct", "14 Oct", "30 Oct – 2 Nov". */
export function rangeLabel(start, end) {
  if (!start) return '';
  if (!end || start === end) return dayLabel(start);
  const [, sm, sd] = start.split('-').map(Number);
  const [, em, ed] = end.split('-').map(Number);
  if (sm === em) return `${sd}–${ed} ${MONTHS[em - 1]}`;
  return `${sd} ${MONTHS[sm - 1]} – ${ed} ${MONTHS[em - 1]}`;
}

/**
 * One line about an entry relative to today.
 *   On leave today, back Mon 20 Oct
 *   Half day (afternoon) today
 *   Planned leave, 14–18 Oct
 */
export function describeEntry(entry, today) {
  if (!entry) return 'Available';
  const meta = STATUS_META[entry.status] || STATUS_META.ON_LEAVE;
  if (entry.status === 'HALF_DAY') {
    const part = DAY_PART_LABEL[entry.day_part] || '';
    const when = entry.start_date === today ? 'today' : dayLabel(entry.start_date);
    return `Half day${part ? ` (${part})` : ''} ${when}`;
  }
  const current = entry.start_date <= today && entry.end_date >= today;
  if (current) {
    if (entry.end_date === today) return `${meta.label} today`;
    return `${meta.label} until ${dayLabel(entry.end_date)}${entry.back_on ? `, back ${dayLabel(entry.back_on)}` : ''}`;
  }
  const planned = entry.planned && entry.status === 'ON_LEAVE' ? 'Planned leave' : meta.label;
  return `${planned}, ${rangeLabel(entry.start_date, entry.end_date)}`;
}

/**
 * The warning a manager reads before assigning. Returns null when there is
 * nothing to say.
 */
export function describeConflict(conflict) {
  if (!conflict) return null;
  const who = conflict.full_name?.split(' ')[0] || 'This person';
  const onDue = conflict.on_due_date;
  if (onDue) {
    const meta = STATUS_META[onDue.status] || STATUS_META.ON_LEAVE;
    const what = onDue.status === 'HALF_DAY'
      ? `on a half day (${DAY_PART_LABEL[onDue.day_part] || 'part of the day'})`
      : meta.label.toLowerCase();
    return {
      severity: onDue.status === 'HALF_DAY' ? 'info' : 'warning',
      headline: `${who} is ${what} on ${dayLabel(conflict.due_date)}, the day this is due.`,
      detail: onDue.status === 'HALF_DAY'
        ? 'They are in for half the day — it may still be fine.'
        : `${rangeLabel(onDue.start_date, onDue.end_date)}${onDue.note ? ` — “${onDue.note}”` : ''}.`,
    };
  }
  if (conflict.working_days_away > 0) {
    return {
      severity: 'info',
      headline: `${who} is away ${formatDays(conflict.working_days_away)} of the ${conflict.working_days_until_due} working days before this is due.`,
      detail: conflict.entries.map((e) => rangeLabel(e.start_date, e.end_date)).join(', '),
    };
  }
  return null;
}

export function formatDays(n) {
  if (n === 0.5) return 'half a day';
  const whole = Number.isInteger(n) ? n : n.toFixed(1);
  return `${whole} day${n === 1 ? '' : 's'}`;
}

/** Keep the time of day, move the date: 18:00 on the old day becomes 18:00 on the new one. */
export function moveDeadlineTo(dateTimeLocal, newDate) {
  const time = dateTimeLocal && dateTimeLocal.includes('T') ? dateTimeLocal.split('T')[1] : '18:00';
  return `${newDate}T${time}`;
}
