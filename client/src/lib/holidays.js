/**
 * Words and grouping for the holiday calendar. Pure, so it is tested without
 * a browser.
 */

export const COVERAGE_LABEL = { FULL: 'Full day', FIRST_HALF: 'Morning off', SECOND_HALF: 'Afternoon off' };
export const KIND_LABEL = { HOLIDAY: 'Holiday', CLOSURE: 'Closure' };
export const ACTION_LABEL = { ADD: 'Add', AMEND: 'Change', CANCEL: 'Cancel' };
export const REQUEST_STATUS = {
  PROPOSED: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'good' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};
export const CORRECTION_LABEL = {
  MARK_WAIVE: 'Waive black mark',
  MARK_RESTORE: 'Restore black mark',
  MARK_CREATE: 'Record black mark',
  STANDUP_EXCUSE: 'Excuse standup',
  STANDUP_UNEXCUSE: 'Undo standup excuse',
  LEAVE_DAY_RELEASE: 'Give back leave day',
  LEAVE_DAY_RESTORE: 'Count leave day again',
};
export const CORRECTION_PERMISSION = {
  MARK_WAIVE: 'blackmark.waive',
  MARK_RESTORE: 'blackmark.waive',
  MARK_CREATE: 'blackmark.create',
  STANDUP_EXCUSE: 'standup.review',
  STANDUP_UNEXCUSE: 'standup.review',
  LEAVE_DAY_RELEASE: 'leave.approve',
  LEAVE_DAY_RESTORE: 'leave.approve',
};
export const CORRECTION_STATUS = {
  PROPOSED: { label: 'Waiting for review', tone: 'warning' },
  APPLIED: { label: 'Applied', tone: 'good' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  REVERSED: { label: 'Reversed', tone: 'neutral' },
  STALE: { label: 'No longer applies', tone: 'neutral' },
};
// why a deadline moved, in words
export const SHIFT_LABEL = {
  WEEKLY_OFF: 'weekly day off',
  HOLIDAY: 'holiday',
  HOLIDAY_HALF: 'half-day holiday',
  LEAVE: 'approved leave',
  LEAVE_HALF: 'approved half-day leave',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Fri 9 Oct" for a YYYY-MM-DD date, read as a calendar date (no timezone shift). */
export function shortDate(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(String(date))) return '';
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

/** A date range in words: one day, or first to last. */
export function rangeWords(start, end) {
  if (!start) return '';
  if (!end || end === start) return shortDate(start);
  return `${shortDate(start)} – ${shortDate(end)}`;
}

/** Who an entry or request covers. */
export function scopeWords(row, { departments = [], users = [] } = {}) {
  const scope = row.scope || (row.user_id ? 'PERSON' : row.department_id ? 'DEPARTMENT' : 'COMPANY');
  if (scope === 'PERSON') return row.user_name || users.find((u) => u.id === row.user_id)?.full_name || 'One person';
  if (scope === 'DEPARTMENT') return row.department_name || departments.find((d) => d.id === row.department_id)?.name || 'One department';
  return 'Everyone';
}

/**
 * Calendar entries grouped by month, in date order, with a range kept
 * together: consecutive dates of one series show as one line.
 */
export function groupByMonth(entries) {
  const sorted = [...entries].sort((a, b) => (a.holiday_date === b.holiday_date ? a.id - b.id : a.holiday_date < b.holiday_date ? -1 : 1));
  const months = new Map();
  for (const e of sorted) {
    const key = e.holiday_date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    const list = months.get(key);
    const last = list[list.length - 1];
    const sameSeries = last && e.series_id && last.series_id === e.series_id && last.status === e.status
      && last.coverage === e.coverage && last.name === e.name;
    if (sameSeries) {
      last.entries.push(e);
      last.end = e.holiday_date;
    } else {
      list.push({ key: `${e.id}`, start: e.holiday_date, end: e.holiday_date, entries: [e], ...pick(e) });
    }
  }
  return [...months.entries()].map(([month, rows]) => ({
    month,
    label: `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`,
    rows,
    inForce: rows.filter((r) => r.status === 'APPROVED').reduce((n, r) => n + r.entries.length, 0),
  }));
}

const pick = (e) => ({
  name: e.name, kind: e.kind || 'HOLIDAY', coverage: e.coverage || 'FULL', status: e.status || 'APPROVED',
  department_id: e.department_id, department_name: e.department_name, user_id: e.user_id, user_name: e.user_name,
  approved_by_name: e.approved_by_name, approved_at: e.approved_at, published_at: e.published_at,
  created_by_name: e.created_by_name, created_at: e.created_at, cancelled_by_name: e.cancelled_by_name,
  cancelled_at: e.cancelled_at, cancel_reason: e.cancel_reason, reason: e.reason, series_id: e.series_id,
});

/** Hours and minutes from seconds, signed: "−4h 30m". */
export function hoursWords(seconds) {
  const s = Math.abs(Math.round(Number(seconds) || 0));
  if (!s) return '0h';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  const text = `${h}h${m ? ` ${m}m` : ''}`;
  return Number(seconds) < 0 ? `−${text}` : `+${text}`;
}

/** One line per area of what approving would change, for the review dialog. */
export function impactLines(impact) {
  if (!impact) return [];
  const s = impact.summary || {};
  const a = impact.attendance || {};
  const lines = [];
  if (s.attendance_days) {
    let text = `${s.attendance_days} attendance day${s.attendance_days === 1 ? '' : 's'} for ${a.people} ${a.people === 1 ? 'person' : 'people'} (${hoursWords(a.required_seconds_change)} required)`;
    const extra = [];
    if (a.unrecorded_cleared) extra.push(`${a.unrecorded_cleared} unrecorded day${a.unrecorded_cleared === 1 ? '' : 's'} no longer owed`);
    if (a.absences_lifted) extra.push(`${a.absences_lifted} confirmed absence${a.absences_lifted === 1 ? '' : 's'} no longer count`);
    if (a.unrecorded_created) extra.push(`${a.unrecorded_created} day${a.unrecorded_created === 1 ? '' : 's'} become unrecorded, for a reviewer — not absences`);
    if (a.absences_restored) extra.push(`${a.absences_restored} confirmed absence${a.absences_restored === 1 ? '' : 's'} count again`);
    if (extra.length) text += `: ${extra.join('; ')}`;
    lines.push({ area: 'Attendance', text, applies: 'At once, worked out from the calendar. Check-in records are not changed.' });
  }
  const marks = [['marks_to_waive', 'to waive'], ['marks_to_restore', 'to restore'], ['marks_to_create', 'to record']]
    .filter(([k]) => s[k]).map(([k, w]) => `${s[k]} ${w}`);
  if (marks.length) lines.push({ area: 'Black marks', text: marks.join(', '), applies: 'Only when someone who may waive marks reviews each one.' });
  const standup = [['standup_to_excuse', 'to excuse'], ['standup_to_unexcuse', 'to un-excuse']].filter(([k]) => s[k]).map(([k, w]) => `${s[k]} ${w}`);
  if (standup.length) lines.push({ area: 'Standup', text: standup.join(', '), applies: 'Only when a standup reviewer applies each one.' });
  const leave = [['leave_days_to_release', 'to give back'], ['leave_days_to_restore', 'to count again']].filter(([k]) => s[k]).map(([k, w]) => `${s[k]} leave day${s[k] === 1 ? '' : 's'} ${w}`);
  if (leave.length) lines.push({ area: 'Leave', text: leave.join(', '), applies: 'Only when a leave approver applies each one.' });
  if (s.payroll_drafts) lines.push({ area: 'Payroll', text: `${s.payroll_drafts} draft month${s.payroll_drafts === 1 ? '' : 's'} will recalculate`, applies: 'Drafts only; approved or locked months cannot change.' });
  return lines;
}
