/**
 * The coverage check: "which open tasks will nobody hear about today?"
 *
 * For every open task it looks for a way someone accountable was told today:
 *   - the owner's own summary, delivered in Google Chat;
 *   - a fallback person's summary that covered the owner (away, not
 *     connected, Chat switched off, or their summary failed);
 *   - the department's summary, or a manager's summary, for work that has
 *     nobody (no owner, or an owner whose account is switched off).
 * A summary that only reached the TaskFlow bell does not count on its own (the
 * person has to open TaskFlow to see it): the fallback has to have it too.
 * Work whose owner is away and that is not due before they are back needs
 * nobody today.
 *
 * Every exception is listed with its reason, seen or not: no owner, owner
 * switched off, no date, owner not connected, owner away, delivery failed,
 * no summary today, nobody to fall back on. The answer for "unseen" should be
 * zero; the report says what to fix when it is not.
 */
import { query } from '../db/pool.js';
import { getSettings } from './settings.js';
import { deadlineClock } from './deadlines.js';
import { healthOf, weekdayOf } from '../../../shared/deadlineHealth.js';
import { awayAt, reminderSettings } from './taskReminders.js';

export const REASON_WORDS = {
  NO_OWNER: 'No owner',
  INACTIVE_OWNER: 'The owner\'s account is switched off',
  NEEDS_DATE: 'No deadline and no review date',
  NOT_CONNECTED: 'The owner is not reachable in Google Chat (bell only)',
  OWNER_AWAY: 'The owner is away',
  DELIVERY_FAILED: 'The owner\'s summary could not be delivered',
  NO_SUMMARY: 'No summary was sent to the owner today',
  NO_FALLBACK: 'Nobody to fall back on',
  CHAT_OFF: 'Google Chat is switched off for the organisation',
};

const delivered = (row) => row && row.status === 'QUEUED' && row.chat_status === 'SENT';
const queuedOnly = (row) => row && row.status === 'QUEUED' && (row.chat_status === 'PENDING' || !row.chat_status);

export async function coverageReport({ now = new Date(), store = false } = {}) {
  const settings = await getSettings();
  const s = await reminderSettings(settings);
  const c = await deadlineClock(now, settings);
  const date = c.today;
  const workingDays = settings.organisation?.workingDays || [1, 2, 3, 4, 5, 6];
  if (!workingDays.includes(weekdayOf(date))) return { date, skipped: 'Not a working day for the organisation' };

  const { rows: tasks } = await query(
    `SELECT t.id, t.ref, t.title, t.assignee_id, t.department_id, t.due_date, t.review_date, t.deferral_id, s.stage,
            u.full_name AS owner_name, u.is_active AS owner_active, d.name AS department_name
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id JOIN departments d ON d.id = t.department_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled')
      ORDER BY t.id`,
  );
  const { rows: logs } = await query(
    `SELECT g.*, o.status AS chat_status, o.last_error AS chat_error, u.full_name
       FROM reminder_summary_log g LEFT JOIN chat_outbox o ON o.dedupe_key = g.outbox_key LEFT JOIN users u ON u.id = g.user_id
      WHERE g.summary_date = $1 AND g.kind IN ('PERSONAL', 'DEPARTMENT')`,
    [date],
  );
  const personal = new Map(logs.filter((l) => l.kind === 'PERSONAL').map((l) => [l.user_id, l]));
  const departmentLogs = logs.filter((l) => l.kind === 'DEPARTMENT');
  const coverers = logs.filter((l) => l.kind === 'PERSONAL' && l.covering_user_ids?.length);

  // when the owners who are away are back, for "nothing due before they return"
  const awayOwners = [...personal.values()].filter((l) => l.status === 'SKIPPED' && /^Away/.test(l.reason || '')).map((l) => l.user_id);
  const { backOn } = awayOwners.length ? await awayAt(awayOwners, now, c.timezone) : { backOn: () => null };

  const result = { seen: 0, pending: 0, unseen: 0, not_needed: 0 };
  const byReason = {};
  const exceptions = [];
  const unseenTasks = [];
  for (const t of tasks) {
    const reasons = [];
    const paths = [];
    const h = healthOf(t, c);
    if (h.code === 'NO_DEADLINE') reasons.push('NEEDS_DATE');
    const nobody = !t.assignee_id || t.owner_active === false;
    if (!t.assignee_id) reasons.push('NO_OWNER');
    else if (t.owner_active === false) reasons.push('INACTIVE_OWNER');

    let status = 'UNSEEN';
    let pendingPath = false;
    if (nobody) {
      for (const d of departmentLogs) {
        if (d.task_ids?.includes(t.id)) { if (delivered(d)) paths.push(`department summary (${d.space_name})`); else if (queuedOnly(d)) pendingPath = true; }
      }
      for (const l of personal.values()) {
        if (l.user_id && l.task_ids?.includes(t.id)) { if (delivered(l)) paths.push(`${l.full_name}'s summary`); else if (queuedOnly(l)) pendingPath = true; }
      }
    } else {
      const own = personal.get(t.assignee_id);
      const covered = coverers.filter((l) => l.covering_user_ids.includes(t.assignee_id));
      for (const l of covered) { if (delivered(l)) paths.push(`covered in ${l.full_name}'s summary`); else if (queuedOnly(l)) pendingPath = true; }
      if (!own) reasons.push(s.chatEnabled ? 'NO_SUMMARY' : 'CHAT_OFF');
      else if (own.status === 'SKIPPED' && /^Away/.test(own.reason || '')) {
        reasons.push('OWNER_AWAY');
        const back = backOn(t.assignee_id);
        const urgent = ['OVERDUE', 'DUE_TODAY'].includes(h.code) || (t.due_date && back && new Date(t.due_date) < new Date(`${back}T00:00:00Z`) && !t.deferral_id);
        if (!urgent && !paths.length) status = 'NOT_NEEDED';
      } else if (own.status === 'APP_ONLY') reasons.push('NOT_CONNECTED');
      else if (own.status === 'QUEUED' && own.chat_status === 'FAILED') reasons.push('DELIVERY_FAILED');
      else if (own.status === 'SKIPPED') reasons.push('NO_SUMMARY');
      if (delivered(own) && own.task_ids?.includes(t.id)) paths.unshift('owner\'s summary in Chat');
      else if (queuedOnly(own) && own.task_ids?.includes(t.id)) pendingPath = true;
      const needsFallback = reasons.some((r) => ['OWNER_AWAY', 'NOT_CONNECTED', 'DELIVERY_FAILED'].includes(r));
      if (needsFallback && !covered.length && status !== 'NOT_NEEDED') reasons.push('NO_FALLBACK');
    }
    if (status !== 'NOT_NEEDED') status = paths.length ? 'SEEN' : pendingPath ? 'PENDING' : 'UNSEEN';
    result[{ SEEN: 'seen', PENDING: 'pending', UNSEEN: 'unseen', NOT_NEEDED: 'not_needed' }[status]] += 1;
    for (const r of reasons) byReason[r] = (byReason[r] || 0) + 1;
    const entry = {
      task_id: t.id, ref: t.ref, title: t.title, owner: t.owner_name || null, owner_id: t.assignee_id,
      department: t.department_name, health: h.code, status, reasons, reached_by: paths,
    };
    if (reasons.length) exceptions.push(entry);
    if (status === 'UNSEEN') unseenTasks.push(entry);
  }

  const { rows: noSpace } = await query(
    `SELECT d.id, d.name FROM departments d
      WHERE d.is_active AND EXISTS (SELECT 1 FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id WHERE t.department_id = d.id AND NOT t.is_archived AND s.stage NOT IN ('done', 'cancelled'))
        AND NOT EXISTS (SELECT 1 FROM chat_spaces sp WHERE sp.kind = 'SPACE' AND sp.active AND sp.team_summary AND sp.department_id = d.id)
      ORDER BY d.name`,
  );
  const report = {
    date,
    generated_at: now.toISOString(),
    open_tasks: tasks.length,
    ...result,
    by_reason: byReason,
    reason_words: REASON_WORDS,
    unseen_tasks: unseenTasks.slice(0, 500),
    exceptions: exceptions.slice(0, 1000),
    departments_without_summary: noSpace,
    chat_enabled: s.chatEnabled,
  };
  if (store) {
    await query(
      `INSERT INTO coverage_reports (report_date, generated_at, open_tasks, unseen, exceptions, summary)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (report_date) DO UPDATE SET generated_at = EXCLUDED.generated_at, open_tasks = EXCLUDED.open_tasks,
         unseen = EXCLUDED.unseen, exceptions = EXCLUDED.exceptions, summary = EXCLUDED.summary`,
      [date, now, tasks.length, result.unseen, JSON.stringify(report.exceptions), JSON.stringify({ ...result, by_reason: byReason, departments_without_summary: noSpace, chat_enabled: s.chatEnabled })],
    );
  }
  return report;
}
