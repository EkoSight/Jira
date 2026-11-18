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
 * A summary the email service accepted counts like one Chat delivered.
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
import { channelPrefs } from './reminderChannels.js';

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
  EMAIL_BOUNCED: 'The owner\'s email address bounced',
  EMAIL_NOT_SET_UP: 'Email is not set up',
  REACHES_NOBODY: 'Reaches nobody: no Chat, no email',
};

// a Chat summary counts once Chat delivered it; an email once the email service took it
const delivered = (row) => Boolean(row && ((row.status === 'QUEUED' && row.chat_status === 'SENT') || (row.status === 'EMAILED' && row.email_status === 'SENT')));
const queuedOnly = (row) => Boolean(row && ((row.status === 'QUEUED' && (row.chat_status === 'PENDING' || !row.chat_status))
  || (row.status === 'EMAILED' && (row.email_status === 'PENDING' || !row.email_status))));
const by = (l) => (l.channel === 'EMAIL' ? ' (email)' : '');

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
    `SELECT g.*, o.status AS chat_status, o.last_error AS chat_error, e.status AS email_status, e.last_error AS email_error, u.full_name
       FROM reminder_summary_log g LEFT JOIN chat_outbox o ON o.dedupe_key = g.outbox_key
       LEFT JOIN email_outbox e ON e.dedupe_key = g.outbox_key LEFT JOIN users u ON u.id = g.user_id
      WHERE g.summary_date = $1 AND g.kind IN ('PERSONAL', 'DEPARTMENT')`,
    [date],
  );
  // one row per person and channel: the Chat (or bell) row, and the email row
  const chatLogs = logs.filter((l) => l.channel !== 'EMAIL');
  const personal = new Map(chatLogs.filter((l) => l.kind === 'PERSONAL').map((l) => [l.user_id, l]));
  const personalEmail = new Map(logs.filter((l) => l.kind === 'PERSONAL' && l.channel === 'EMAIL').map((l) => [l.user_id, l]));
  const departmentLogs = logs.filter((l) => l.kind === 'DEPARTMENT');
  const coverers = logs.filter((l) => l.kind === 'PERSONAL' && l.covering_user_ids?.length);
  const ownerIds = [...new Set(tasks.map((t) => t.assignee_id).filter(Boolean))];
  const prefs = await channelPrefs(ownerIds, { query }, settings);

  // when the owners who are away are back, for "nothing due before they return"
  const awayOwners = [...new Set([...personal.values(), ...personalEmail.values()].filter((l) => l.status === 'SKIPPED' && /^Away/.test(l.reason || '')).map((l) => l.user_id))];
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
        if (d.task_ids?.includes(t.id)) {
          if (delivered(d)) paths.push(d.channel === 'EMAIL' ? `${d.full_name}'s team summary (email)` : `department summary (${d.space_name})`);
          else if (queuedOnly(d)) pendingPath = true;
        }
      }
      for (const l of [...personal.values(), ...personalEmail.values()]) {
        if (l.user_id && l.task_ids?.includes(t.id)) { if (delivered(l)) paths.push(`${l.full_name}'s summary${by(l)}`); else if (queuedOnly(l)) pendingPath = true; }
      }
    } else {
      const ownEmail = personalEmail.get(t.assignee_id);
      // with Chat switched off, the email row says whether the owner is away
      const own = personal.get(t.assignee_id) || (ownEmail?.status === 'SKIPPED' && /^Away/.test(ownEmail.reason || '') ? ownEmail : undefined);
      const emailSeen = delivered(ownEmail) && ownEmail.task_ids?.includes(t.id);
      const emailPending = !emailSeen && queuedOnly(ownEmail) && ownEmail.task_ids?.includes(t.id);
      const covered = coverers.filter((l) => l.covering_user_ids.includes(t.assignee_id));
      for (const l of covered) { if (delivered(l)) paths.push(`covered in ${l.full_name}'s summary${by(l)}`); else if (queuedOnly(l)) pendingPath = true; }
      if (emailSeen) paths.push('owner\'s summary by email');
      else if (emailPending) pendingPath = true;
      const byEmail = emailSeen || emailPending;
      if (!own) { if (!byEmail) reasons.push(s.chatEnabled ? 'NO_SUMMARY' : 'CHAT_OFF'); }
      else if (own.status === 'SKIPPED' && /^Away/.test(own.reason || '')) {
        reasons.push('OWNER_AWAY');
        const back = backOn(t.assignee_id);
        const urgent = ['OVERDUE', 'DUE_TODAY'].includes(h.code) || (t.due_date && back && new Date(t.due_date) < new Date(`${back}T00:00:00Z`) && !t.deferral_id);
        if (!urgent && !paths.length) status = 'NOT_NEEDED';
      } else if (own.status === 'APP_ONLY') {
        if (!byEmail) {
          reasons.push('NOT_CONNECTED');
          // once email is set up, say why email did not reach them either
          if (s.email.ready) reasons.push(prefs.get(t.assignee_id)?.undeliverable ? 'EMAIL_BOUNCED' : ownEmail?.email_status === 'FAILED' ? 'DELIVERY_FAILED' : 'REACHES_NOBODY');
        }
      } else if (own.status === 'SKIPPED' && /email only/.test(own.reason || '')) {
        if (!byEmail) reasons.push(ownEmail?.email_status === 'FAILED' ? 'DELIVERY_FAILED' : prefs.get(t.assignee_id)?.undeliverable ? 'EMAIL_BOUNCED' : 'NO_SUMMARY');
      }
      else if (own.status === 'QUEUED' && own.chat_status === 'FAILED') reasons.push('DELIVERY_FAILED');
      else if (own.status === 'SKIPPED') reasons.push('NO_SUMMARY');
      if (delivered(own) && own.task_ids?.includes(t.id)) paths.unshift('owner\'s summary in Chat');
      else if (queuedOnly(own) && own.task_ids?.includes(t.id)) pendingPath = true;
      const needsFallback = reasons.some((r) => ['OWNER_AWAY', 'NOT_CONNECTED', 'DELIVERY_FAILED', 'EMAIL_BOUNCED', 'REACHES_NOBODY'].includes(r));
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
    // email as a way to reach people: whether it is set up, and if not why
    email_ready: s.email.ready,
    email_reason: s.email.ready ? null : s.email.reason,
  };
  if (store) {
    await query(
      `INSERT INTO coverage_reports (report_date, generated_at, open_tasks, unseen, exceptions, summary)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (report_date) DO UPDATE SET generated_at = EXCLUDED.generated_at, open_tasks = EXCLUDED.open_tasks,
         unseen = EXCLUDED.unseen, exceptions = EXCLUDED.exceptions, summary = EXCLUDED.summary`,
      [date, now, tasks.length, result.unseen, JSON.stringify(report.exceptions), JSON.stringify({ ...result, by_reason: byReason, departments_without_summary: noSpace, chat_enabled: s.chatEnabled, email_ready: s.email.ready, email_reason: report.email_reason })],
    );
  }
  return report;
}
