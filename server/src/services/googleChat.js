/**
 * Google Chat delivery.
 *
 * Chat is a second way to receive some TaskFlow notifications, never a
 * replacement: everything still appears in TaskFlow's bell. Three paths:
 *
 *   Instant alerts — new notifications of the chosen types, as direct
 *   messages to people who have added the TaskFlow app.
 *   Morning summary — one direct message per working day: due today, overdue,
 *   waiting for your decision, and a check-in reminder.
 *   Team summary — one message per working day in each Chat space an admin has
 *   pointed at a department: who is away, what is due, what is overdue.
 *
 * Messages go through an outbox: a Google outage delays a message, it does
 * not lose it, and a retry never sends one twice. Leave reasons, coordinates
 * and pay never go to Chat.
 */

import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { effectivePermissions } from '../lib/permissions.js';
import { ChatError, chatConfig, chatLink, chatText, sendChatMessage } from '../lib/googleChat.js';
import { getSettings } from './settings.js';
import { currentPolicy } from './attendancePolicy.js';
import { dateIn, visibleUserIds } from './attendance.js';

const RETRY_MINUTES = [1, 5, 30, 120];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

export const ALERT_TYPE_LABEL = {
  assigned: 'A task is assigned to you',
  due_soon: 'A deadline is coming up',
  deadline_missed: 'A deadline was missed',
  overdue_escalation: 'A task is still overdue',
  task_reopened: 'A task was reopened',
  tagged: 'You are mentioned',
  comment: 'A comment on your task',
  follower: 'You follow a task',
  blackmark: 'A black mark',
  availability: 'Leave that affects your tasks',
  leave_request: 'A leave request needs your decision',
  leave_decision: 'Your leave was decided',
  attendance_correction: 'Attendance corrections',
  attendance_review: 'A day was reviewed',
  attendance_reminder: 'Check-in reminder',
  attendance_checkout_reminder: 'Check-out reminder',
  kudos: 'Kudos',
  recognition: 'Recognition',
  crm_assigned: 'A lead is assigned to you',
  crm_activity: 'Lead activity',
};

const app = (path = '/') => `${config.publicUrl}${path}`;
const taskUrl = (taskId) => app(`/?task=${taskId}`);

// ---------------------------------------------------------------- linking

async function findUserByEmail(email) {
  if (!email) return null;
  const { rows } = await query(
    'SELECT id, full_name, email FROM users WHERE lower(email) = lower($1) AND is_active LIMIT 1',
    [email],
  );
  return rows[0] || null;
}

const isDirect = (space) => space?.type === 'DM' || space?.spaceType === 'DIRECT_MESSAGE' || space?.singleUserBotDm === true;

async function linkDirectMessage(space, googleUser) {
  const user = await findUserByEmail(googleUser?.email);
  await withTransaction(async (client) => {
    if (user) {
      // the newest DM is the one that works; an older one for the same person is retired
      await client.query(
        `UPDATE chat_spaces SET active = FALSE, removed_at = now(), updated_at = now()
          WHERE kind = 'DM' AND user_id = $1 AND active AND space_name <> $2`,
        [user.id, space.name],
      );
    }
    await client.query(
      `INSERT INTO chat_spaces (space_name, kind, display_name, user_id, added_by_email, active)
       VALUES ($1, 'DM', $2, $3, $4, TRUE)
       ON CONFLICT (space_name) DO UPDATE SET user_id = EXCLUDED.user_id, display_name = EXCLUDED.display_name,
         added_by_email = EXCLUDED.added_by_email, active = TRUE, removed_at = NULL, updated_at = now()`,
      [space.name, googleUser?.displayName || null, user?.id || null, googleUser?.email || null],
    );
  });
  return user;
}

// ---------------------------------------------------------------- incoming events

const HELP = [
  '*TaskFlow* sends your task, deadline, leave and attendance alerts here.',
  'Reply with:',
  '• `tasks` — your open tasks due soonest',
  '• `summary` — today’s summary now',
  '• `stop` — pause instant alerts (the morning summary continues)',
  '• `start` — turn instant alerts back on',
  `Change what you receive in TaskFlow → Settings → My account: ${app('/settings?tab=account')}`,
].join('\n');

/** Handles one verified event from Google Chat and returns the synchronous reply. */
export async function handleChatEvent(event) {
  const type = event?.type;
  const space = event?.space;
  if (!space?.name || !/^spaces\/[A-Za-z0-9_-]+$/.test(space.name)) return {};

  if (type === 'REMOVED_FROM_SPACE') {
    await query(
      `UPDATE chat_spaces SET active = FALSE, removed_at = now(), updated_at = now() WHERE space_name = $1`,
      [space.name],
    );
    return {};
  }

  if (isDirect(space)) {
    if (type === 'ADDED_TO_SPACE' || type === 'MESSAGE') {
      const { rows } = await query(`SELECT user_id, active FROM chat_spaces WHERE space_name = $1`, [space.name]);
      const known = rows[0]?.active && rows[0]?.user_id;
      const user = known ? { id: rows[0].user_id } : await linkDirectMessage(space, event.user);
      if (!user) {
        return {
          text: `I couldn’t find an active TaskFlow account for ${chatText(event.user?.email || 'this Google account')}. `
            + 'Ask your TaskFlow admin to check the email on your profile matches your Google Workspace email, then remove and add the TaskFlow app again.',
        };
      }
      if (type === 'ADDED_TO_SPACE') {
        const { rows: me } = await query('SELECT full_name FROM users WHERE id = $1', [user.id]);
        return { text: `Hi ${chatText(me[0]?.full_name?.split(' ')[0] || 'there')}. You’re connected.\n\n${HELP}` };
      }
      return replyToCommand(user.id, event.message?.argumentText ?? event.message?.text ?? '');
    }
    return {};
  }

  // a space or group conversation
  if (type === 'ADDED_TO_SPACE') {
    await query(
      `INSERT INTO chat_spaces (space_name, kind, display_name, added_by_email, active)
       VALUES ($1, 'SPACE', $2, $3, TRUE)
       ON CONFLICT (space_name) DO UPDATE SET display_name = EXCLUDED.display_name, active = TRUE, removed_at = NULL, updated_at = now()`,
      [space.name, space.displayName || null, event.user?.email || null],
    );
    return {
      text: 'Thanks for adding TaskFlow. A TaskFlow admin can now choose which department this space follows '
        + `(Settings → Google Chat), and I’ll post a short team summary here each working morning: ${app('/settings?tab=chat')}`,
    };
  }
  if (type === 'MESSAGE') {
    return { text: 'In a space I only post the daily team summary. Message me directly for your own tasks and alerts.' };
  }
  return {};
}

async function replyToCommand(userId, raw) {
  const command = String(raw).trim().toLowerCase().replace(/^\//, '');
  if (command === 'stop' || command === 'pause') {
    await setPreferences(userId, { instant: false });
    return { text: 'Instant alerts paused. You’ll still get the morning summary. Reply `start` to turn them back on.' };
  }
  if (command === 'start' || command === 'resume') {
    await setPreferences(userId, { instant: true });
    return { text: 'Instant alerts are on.' };
  }
  if (command === 'tasks' || command === 'my tasks') {
    const tasks = await openTasks(userId, 10);
    if (!tasks.length) return { text: 'You have no open tasks. Nice.' };
    return { text: ['*Your open tasks, soonest first*', ...tasks.map(taskLine)].join('\n') };
  }
  if (command === 'summary' || command === 'today') {
    const summary = await morningSummary(userId, new Date(), { force: true });
    return summary || { text: 'Nothing due today, nothing overdue, and nothing waiting for you.' };
  }
  return { text: HELP };
}

// ---------------------------------------------------------------- preferences

export async function getPreferences(userId) {
  const { rows } = await query('SELECT instant, morning_summary FROM chat_preferences WHERE user_id = $1', [userId]);
  return rows[0] || { instant: true, morning_summary: true };
}

export async function setPreferences(userId, changes) {
  const current = await getPreferences(userId);
  const next = { ...current, ...changes };
  await query(
    `INSERT INTO chat_preferences (user_id, instant, morning_summary) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET instant = EXCLUDED.instant, morning_summary = EXCLUDED.morning_summary, updated_at = now()`,
    [userId, Boolean(next.instant), Boolean(next.morning_summary)],
  );
  return next;
}

export async function directSpaceFor(userId) {
  const { rows } = await query(`SELECT * FROM chat_spaces WHERE kind = 'DM' AND user_id = $1 AND active`, [userId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------- content

async function openTasks(userId, limit) {
  const { rows } = await query(
    `SELECT t.id, t.ref, t.title, t.due_date, t.priority, (t.due_date < now()) AS overdue
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.assignee_id = $1 AND NOT t.is_archived AND s.stage NOT IN ('done', 'cancelled')
      ORDER BY t.due_date NULLS LAST LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

const when = (value, tz = 'Asia/Kolkata') => new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(value));

const taskLine = (t) => `• ${chatLink(taskUrl(t.id), `${t.ref ? `${t.ref} ` : ''}${t.title}`)}${t.due_date ? ` — ${t.overdue ? '*overdue*, was due ' : 'due '}${when(t.due_date)}` : ''}`;

/** A notification as a Chat message, with a link back to what it is about. */
export function alertMessage(n) {
  const lines = [`*${chatText(n.title)}*`];
  if (n.body) lines.push(chatText(n.body));
  if (n.task_id) lines.push(chatLink(taskUrl(n.task_id), n.task_ref ? `Open ${n.task_ref} in TaskFlow` : 'Open the task in TaskFlow'));
  else if (n.objective_id) lines.push(chatLink(app(`/goals/${n.objective_id}`), 'Open the goal in TaskFlow'));
  else if (n.account_id) lines.push(chatLink(app(`/accounts/${n.account_id}`), 'Open the lead in TaskFlow'));
  else if (/^(leave_|attendance_)/.test(n.type)) {
    const path = ['leave_request', 'attendance_correction'].includes(n.type) ? '/attendance?tab=approvals' : '/attendance';
    lines.push(chatLink(app(path), 'Open attendance in TaskFlow'));
  }
  return { text: lines.join('\n') };
}

/**
 * Today for one person. Returns null when there is nothing worth saying, so an
 * empty morning does not ping anyone.
 */
export async function morningSummary(userId, now = new Date(), { force = false } = {}) {
  const { rows: users } = await query(
    'SELECT id, full_name, role, extra_permissions, revoked_permissions, department_id FROM users WHERE id = $1 AND is_active',
    [userId],
  );
  const user = users[0];
  if (!user) return null;
  const settings = await getSettings();
  const tz = settings.organisation?.timezone || 'Asia/Kolkata';
  const today = dateIn(tz, now);

  const { rows: tasks } = await query(
    `SELECT t.id, t.ref, t.title, t.due_date, (t.due_date < $2) AS overdue
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.assignee_id = $1 AND NOT t.is_archived AND s.stage NOT IN ('done', 'cancelled')
        AND t.due_date IS NOT NULL
        AND (t.due_date < $2 OR (t.due_date AT TIME ZONE $3)::date = $4::date)
      ORDER BY t.due_date`,
    [userId, now, tz, today],
  );
  const overdue = tasks.filter((t) => t.overdue);
  const dueToday = tasks.filter((t) => !t.overdue);

  // decisions waiting on this person, for the teams they are authorised to review
  const perms = effectivePermissions(user);
  let leaveWaiting = 0;
  let correctionsWaiting = 0;
  if (perms.includes('leave.approve') || perms.includes('attendance.approve')) {
    const ids = await visibleUserIds(user);
    if (perms.includes('leave.approve')) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM leave_requests WHERE status IN ('SUBMITTED', 'EMERGENCY_REVIEW', 'NOTICE_EXCEPTION')
            AND user_id <> $1 AND ($2::int[] IS NULL OR user_id = ANY($2::int[]))`,
        [userId, ids],
      );
      leaveWaiting = rows[0].n;
    }
    if (perms.includes('attendance.approve')) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM attendance_corrections WHERE status = 'PENDING'
            AND user_id <> $1 AND ($2::int[] IS NULL OR user_id = ANY($2::int[]))`,
        [userId, ids],
      );
      correctionsWaiting = rows[0].n;
    }
  }

  // a check-in nudge only once attendance has started, and only if not done
  let checkIn = false;
  const policy = (await currentPolicy()).config;
  if (policy.startDate && today >= policy.startDate && policy.workingDays.includes(new Date(`${today}T00:00:00Z`).getUTCDay())) {
    const { rows } = await query(
      `SELECT
         EXISTS (SELECT 1 FROM attendance_sessions WHERE user_id = $1 AND work_date = $2) AS checked_in,
         COALESCE((SELECT attendance_required FROM employee_work_profiles WHERE user_id = $1), TRUE) AS required,
         EXISTS (SELECT 1 FROM leave_requests WHERE user_id = $1 AND status IN ('APPROVED_PAID', 'APPROVED_UNPAID')
                  AND $2::date BETWEEN start_date AND end_date) AS on_leave`,
      [userId, today],
    );
    checkIn = rows[0].required && !rows[0].checked_in && !rows[0].on_leave;
  }

  if (!force && !tasks.length && !leaveWaiting && !correctionsWaiting && !checkIn) return null;

  const first = user.full_name.split(' ')[0];
  const lines = [`*Good morning, ${chatText(first)}* — ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(now)}`];
  if (checkIn) lines.push(`\n⏱ Remember to *Check In / Start Work*: ${app('/')}`);
  if (overdue.length) {
    lines.push(`\n*Overdue (${overdue.length})*`);
    lines.push(...overdue.slice(0, 6).map(taskLine));
    if (overdue.length > 6) lines.push(`…and ${overdue.length - 6} more: ${app('/my-tasks')}`);
  }
  if (dueToday.length) {
    lines.push(`\n*Due today (${dueToday.length})*`);
    lines.push(...dueToday.slice(0, 6).map(taskLine));
    if (dueToday.length > 6) lines.push(`…and ${dueToday.length - 6} more: ${app('/my-tasks')}`);
  }
  if (leaveWaiting || correctionsWaiting) {
    const parts = [];
    if (leaveWaiting) parts.push(`${leaveWaiting} leave request${leaveWaiting === 1 ? '' : 's'}`);
    if (correctionsWaiting) parts.push(`${correctionsWaiting} attendance correction${correctionsWaiting === 1 ? '' : 's'}`);
    lines.push(`\n*Waiting for your decision:* ${parts.join(' and ')} — ${chatLink(app('/attendance?tab=approvals'), 'review')}`);
  }
  if (lines.length === 1) lines.push('\nNothing due today, nothing overdue, and nothing waiting for you.');
  return { text: lines.join('\n') };
}

/**
 * The department's morning in one message. Who is away is shown by name and
 * dates only — never the reason, which may be medical or personal.
 */
export async function teamSummary(departmentId, now = new Date()) {
  const settings = await getSettings();
  const tz = settings.organisation?.timezone || 'Asia/Kolkata';
  const today = dateIn(tz, now);
  const { rows: dept } = await query('SELECT name FROM departments WHERE id = $1', [departmentId]);
  if (!dept[0]) return null;

  const { rows: away } = await query(
    `SELECT u.full_name, a.status, a.day_part, a.end_date
       FROM user_availability a JOIN users u ON u.id = a.user_id
      WHERE a.cancelled_at IS NULL AND u.is_active AND u.department_id = $1 AND $2::date BETWEEN a.start_date AND a.end_date
      ORDER BY u.full_name`,
    [departmentId, today],
  );
  const { rows: tasks } = await query(
    `SELECT t.id, t.ref, t.title, t.due_date, (t.due_date < $2) AS overdue, u.full_name AS owner
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.department_id = $1 AND NOT t.is_archived AND s.stage NOT IN ('done', 'cancelled')
        AND t.due_date IS NOT NULL AND (t.due_date < $2 OR (t.due_date AT TIME ZONE $3)::date = $4::date)
      ORDER BY t.due_date`,
    [departmentId, now, tz, today],
  );
  const overdue = tasks.filter((t) => t.overdue);
  const dueToday = tasks.filter((t) => !t.overdue);
  const awayText = (a) => (a.status === 'HALF_DAY'
    ? `${chatText(a.full_name)} (half day, ${a.day_part === 'MORNING' ? 'morning' : 'afternoon'})`
    : `${chatText(a.full_name)}${a.end_date > today ? ` (back after ${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${a.end_date}T00:00:00Z`))})` : ''}`);
  const line = (t) => `${taskLine(t)}${t.owner ? ` · ${chatText(t.owner)}` : ' · *unassigned*'}`;

  const lines = [`*${chatText(dept[0].name)} — ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(now)}*`];
  lines.push(away.length ? `\n*Away today:* ${away.map(awayText).join(', ')}` : '\nEveryone is in today.');
  if (dueToday.length) {
    lines.push(`\n*Due today (${dueToday.length})*`, ...dueToday.slice(0, 8).map(line));
    if (dueToday.length > 8) lines.push(`…and ${dueToday.length - 8} more`);
  }
  if (overdue.length) {
    lines.push(`\n*Overdue (${overdue.length})*`, ...overdue.slice(0, 8).map(line));
    if (overdue.length > 8) lines.push(`…and ${overdue.length - 8} more: ${app('/board?overdue=true')}`);
  }
  if (!dueToday.length && !overdue.length) lines.push('Nothing due today and nothing overdue.');
  return { text: lines.join('\n') };
}

// ---------------------------------------------------------------- queueing

async function enqueue({ dedupeKey, spaceName, userId = null, notificationId = null, kind, payload }) {
  const { rowCount } = await query(
    `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, notification_id, kind, payload)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [dedupeKey, spaceName, userId, notificationId, kind, JSON.stringify(payload)],
  );
  return rowCount > 0;
}

/**
 * New notifications → instant alerts. The first run only records where to
 * start, so switching Chat on never replays history.
 */
export async function dispatchNotifications() {
  const settings = await getSettings();
  if (!settings.googleChat?.enabled) return { queued: 0 };
  const types = settings.googleChat.alertTypes || [];

  const { rows: cursor } = await query('SELECT last_notification_id FROM chat_cursor WHERE id = 1');
  if (!cursor[0]) {
    await query(
      `INSERT INTO chat_cursor (id, last_notification_id) SELECT 1, COALESCE(MAX(id), 0) FROM notifications ON CONFLICT (id) DO NOTHING`,
    );
    return { queued: 0, started: true };
  }
  const { rows } = await query(
    `SELECT n.*, t.ref AS task_ref, sp.space_name, COALESCE(p.instant, TRUE) AS instant
       FROM notifications n
       LEFT JOIN tasks t ON t.id = n.task_id
       LEFT JOIN chat_spaces sp ON sp.kind = 'DM' AND sp.user_id = n.user_id AND sp.active
       LEFT JOIN chat_preferences p ON p.user_id = n.user_id
      WHERE n.id > $1 ORDER BY n.id LIMIT 500`,
    [cursor[0].last_notification_id],
  );
  let queued = 0;
  for (const n of rows) {
    if (n.space_name && n.instant && types.includes(n.type)) {
      if (await enqueue({
        dedupeKey: `n:${n.id}:${n.space_name}`, spaceName: n.space_name, userId: n.user_id,
        notificationId: n.id, kind: 'ALERT', payload: alertMessage(n),
      })) queued += 1;
    }
  }
  if (rows.length) {
    await query('UPDATE chat_cursor SET last_notification_id = $1, updated_at = now() WHERE id = 1', [rows[rows.length - 1].id]);
  }
  return { queued };
}

const pastTime = (now, hhmm, tz) => {
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return local >= hhmm;
};

/** The morning messages, once per person and per space each working day. */
export async function queueSummaries(now = new Date()) {
  const settings = await getSettings();
  const chat = settings.googleChat || {};
  if (!chat.enabled) return { queued: 0 };
  const tz = settings.organisation?.timezone || 'Asia/Kolkata';
  const today = dateIn(tz, now);
  const workingDays = settings.organisation?.workingDays || [1, 2, 3, 4, 5, 6];
  if (!workingDays.includes(new Date(`${today}T00:00:00Z`).getUTCDay())) return { queued: 0 };
  // a summary queued late in the day would be noise; only the morning counts
  const tooLate = pastTime(now, '13:00', tz);
  let queued = 0;

  if (pastTime(now, chat.morningSummaryTime || '08:45', tz) && !tooLate) {
    const { rows } = await query(
      `SELECT sp.space_name, sp.user_id FROM chat_spaces sp JOIN users u ON u.id = sp.user_id AND u.is_active
         LEFT JOIN chat_preferences p ON p.user_id = sp.user_id
        WHERE sp.kind = 'DM' AND sp.active AND COALESCE(p.morning_summary, TRUE)
          AND NOT EXISTS (SELECT 1 FROM chat_outbox o WHERE o.dedupe_key = 'digest:' || sp.user_id || ':' || $1)`,
      [today],
    );
    for (const row of rows) {
      const payload = await morningSummary(row.user_id, now);
      // record that today was considered, even when there was nothing to say
      if (!payload) {
        await query(
          `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload, status, sent_at)
           VALUES ($1, $2, $3, 'DIGEST', '{"skipped":true}', 'SENT', now()) ON CONFLICT (dedupe_key) DO NOTHING`,
          [`digest:${row.user_id}:${today}`, row.space_name, row.user_id],
        );
        continue;
      }
      if (await enqueue({ dedupeKey: `digest:${row.user_id}:${today}`, spaceName: row.space_name, userId: row.user_id, kind: 'DIGEST', payload })) queued += 1;
    }
  }

  if (pastTime(now, chat.teamSummaryTime || '09:15', tz) && !tooLate) {
    const { rows } = await query(
      `SELECT space_name, department_id FROM chat_spaces
        WHERE kind = 'SPACE' AND active AND team_summary AND department_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM chat_outbox o WHERE o.dedupe_key = 'team:' || space_name || ':' || $1)`,
      [today],
    );
    for (const row of rows) {
      const payload = await teamSummary(row.department_id, now);
      if (payload && await enqueue({ dedupeKey: `team:${row.space_name}:${today}`, spaceName: row.space_name, kind: 'TEAM_SUMMARY', payload })) queued += 1;
    }
  }
  return { queued };
}

// ---------------------------------------------------------------- delivery

/** Sends what is due. Failures wait and retry; a removed app stops trying. */
export async function deliverOutbox({ limit = 50 } = {}) {
  if (!chatConfig().configured) return { sent: 0, failed: 0, skipped: 'not configured' };
  const { rows } = await query(
    `UPDATE chat_outbox SET next_attempt_at = now() + interval '2 minutes'
      WHERE id IN (SELECT id FROM chat_outbox WHERE status = 'PENDING' AND next_attempt_at <= now()
                    ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [limit],
  );
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await sendChatMessage(row.space_name, row.payload);
      await query(
        `UPDATE chat_outbox SET status = 'SENT', sent_at = now(), attempts = attempts + 1, message_name = $2, last_error = NULL WHERE id = $1`,
        [row.id, result?.name || null],
      );
      sent += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const permanent = err instanceof ChatError && err.permanent;
      const giveUp = permanent || attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE chat_outbox SET attempts = $2, last_error = $3, status = $4,
                next_attempt_at = now() + ($5 || ' minutes')::interval WHERE id = $1`,
        [row.id, attempts, String(err.message).slice(0, 500), giveUp ? 'FAILED' : 'PENDING', String(RETRY_MINUTES[attempts - 1] || 120)],
      );
      if (err instanceof ChatError && err.spaceGone) {
        await query(`UPDATE chat_spaces SET active = FALSE, removed_at = now(), updated_at = now() WHERE space_name = $1`, [row.space_name]);
      }
      if (giveUp) failed += 1;
    }
  }
  return { sent, failed };
}

/** A message straight to one person's Chat, to prove the set-up works. */
export async function sendTest(userId) {
  const space = await directSpaceFor(userId);
  if (!space) return { ok: false, reason: 'NOT_LINKED' };
  const key = `test:${userId}:${Date.now()}`;
  await enqueue({
    dedupeKey: key, spaceName: space.space_name, userId, kind: 'TEST',
    payload: { text: `*Test message from TaskFlow* — Google Chat is working. ${chatLink(app('/'), 'Open TaskFlow')}` },
  });
  await deliverOutbox({ limit: 10 });
  const { rows } = await query('SELECT status, last_error FROM chat_outbox WHERE dedupe_key = $1', [key]);
  return { ok: rows[0]?.status === 'SENT', status: rows[0]?.status, error: rows[0]?.last_error || null };
}

/** One pass of everything; the worker calls this every minute. */
export async function runChatWork(now = new Date()) {
  const dispatched = await dispatchNotifications();
  const summaries = await queueSummaries(now);
  const delivered = await deliverOutbox();
  return { dispatched, summaries, delivered };
}
