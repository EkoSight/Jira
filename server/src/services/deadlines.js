/**
 * Deadline health on the server: the shared definition (shared/deadlineHealth.js)
 * with the organisation's own time zone, working days and "due soon" window,
 * so lists, counts, the dashboard and Google Chat all say the same thing.
 */
import { clock, groupOf, healthLabel } from '../../../shared/deadlineHealth.js';
import { getSettings } from './settings.js';

/** The organisation's calendar, read once per request. */
export async function deadlineClock(now = new Date(), settings = null) {
  const s = settings || await getSettings();
  return clock(now, {
    timezone: s.organisation?.timezone || 'Asia/Kolkata',
    workingDays: s.organisation?.workingDays || [1, 2, 3, 4, 5, 6],
    dueSoonDays: Number(s.workload?.dueSoonDays) || 3,
  });
}

/** Adds `health` (code, words, tone) and the My Tasks group to each task row. */
export function withHealth(rows, c) {
  return rows.map((t) => {
    const h = healthLabel(t, c);
    return { ...t, health: { code: h.code, text: h.text, tone: h.tone, overdue_ms: h.overdueMs, review_due: h.reviewDue, deferred: h.deferred }, group: groupOf(t, c) };
  });
}

/** What the browser needs to compute the same health locally. */
export const clientCalendar = (c) => ({ timezone: c.timezone, workingDays: c.workingDays, dueSoonDays: c.dueSoonDays });
