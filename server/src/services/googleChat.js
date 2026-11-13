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
import { ChatError, chatConfig, chatLink, chatText, sendChatMessage } from '../lib/googleChat.js';
import { getSettings } from './settings.js';
import { runStandup, submitFromChat } from './standup.js';
import { departmentSummary, personalSummary, queueSummaries as queueTaskSummaries } from './taskSummaries.js';

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

/**
 * Records a direct message as belonging to a TaskFlow user (or to nobody yet).
 * A person has one working DM; an older one for them is retired.
 */
export async function saveDirectMessage({ spaceName, userId, displayName = null, email = null, googleUserName = null, adminInstalled = false }) {
  await withTransaction(async (client) => {
    if (userId) {
      await client.query(
        `UPDATE chat_spaces SET active = FALSE, removed_at = now(), updated_at = now()
          WHERE kind = 'DM' AND user_id = $1 AND active AND space_name <> $2`,
        [userId, spaceName],
      );
    }
    await client.query(
      `INSERT INTO chat_spaces (space_name, kind, display_name, user_id, added_by_email, google_user_name, admin_installed, active)
       VALUES ($1, 'DM', $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (space_name) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, chat_spaces.user_id),
         display_name = COALESCE(EXCLUDED.display_name, chat_spaces.display_name),
         added_by_email = COALESCE(EXCLUDED.added_by_email, chat_spaces.added_by_email),
         google_user_name = COALESCE(EXCLUDED.google_user_name, chat_spaces.google_user_name),
         admin_installed = chat_spaces.admin_installed OR EXCLUDED.admin_installed,
         active = TRUE, removed_at = NULL, updated_at = now()`,
      [spaceName, displayName, userId || null, email, googleUserName, Boolean(adminInstalled)],
    );
    if (userId && googleUserName) {
      await client.query(
        `INSERT INTO chat_preferences (user_id, google_user_name) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET google_user_name = EXCLUDED.google_user_name`,
        [userId, googleUserName],
      );
    }
  });
}

async function linkDirectMessage(space, googleUser) {
  const user = await findUserByEmail(googleUser?.email);
  await saveDirectMessage({
    spaceName: space.name,
    userId: user?.id || null,
    displayName: googleUser?.displayName || null,
    email: googleUser?.email || null,
    googleUserName: googleUser?.name || null,
    adminInstalled: Boolean(space.adminInstalled),
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
      // added by the person, or their first word in a chat an admin install opened
      if (type === 'ADDED_TO_SPACE' || !known) {
        const { rows: me } = await query('SELECT full_name FROM users WHERE id = $1', [user.id]);
        return { text: `Hi ${chatText(me[0]?.full_name?.split(' ')[0] || 'there')}. You’re connected.\n\n${HELP}` };
      }
      const said = event.message?.argumentText ?? event.message?.text ?? '';
      // a standup sent privately: recorded, then posted in the standup space
      if (/^\s*\/?standup\b/i.test(said)) {
        const result = await submitFromChat({
          source: 'CHAT_DM', text: said,
          sender: { name: event.user?.name || null, email: event.user?.email || null },
          message: { name: event.message?.name || null, thread: event.message?.thread?.name || null },
        });
        return { text: result.text };
      }
      return replyToCommand(user.id, said);
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
    // the standup space: a message that mentions TaskFlow is a standup (or a correction)
    const standup = (await getSettings()).standup || {};
    if (standup.spaceName && space.name === standup.spaceName) {
      const result = await submitFromChat({
        source: 'CHAT_SPACE', text: event.message?.argumentText ?? event.message?.text ?? '',
        sender: { name: event.user?.name || null, email: event.user?.email || null },
        message: { name: event.message?.name || null, thread: event.message?.thread?.name || null },
      });
      return { text: result.text };
    }
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
 * Today for one person, and the department's morning: built in
 * services/taskSummaries.js with the shared deadline definition (sections for
 * overdue, today, upcoming, blocked, review due, needs a date, supporting,
 * covering and decisions). Null when there is nothing to say.
 */
export async function morningSummary(userId, now = new Date(), { force = false } = {}) {
  return personalSummary(userId, { now, force });
}

export async function teamSummary(departmentId, now = new Date()) {
  return departmentSummary(departmentId, { now });
}

// ---------------------------------------------------------------- queueing

export async function enqueue({ dedupeKey, spaceName, userId = null, notificationId = null, kind, payload }) {
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


/**
 * The morning messages, once per person and per space each working day,
 * respecting holidays, leave and days off, with a per-recipient log
 * (services/taskSummaries.js).
 */
export async function queueSummaries(now = new Date()) {
  return queueTaskSummaries(now);
}

// ---------------------------------------------------------------- delivery

/**
 * Why a queued message no longer applies, or null. A reminder or a "due soon"
 * alert about a task that has since been finished, handed to someone else or
 * re-dated would be wrong by the time a retry delivers it.
 */
async function staleReason(row) {
  if (row.kind === 'TASK_REMINDER') {
    const id = Number(String(row.dedupe_key).match(/^task-reminder:(\d+)$/)?.[1]);
    if (!id) return null;
    const { rows } = await query(
      `SELECT r.user_id, r.role, r.due_at, t.assignee_id, t.due_date, t.is_archived, t.deferral_id, s.stage
         FROM task_reminders r JOIN tasks t ON t.id = r.task_id JOIN workflow_statuses s ON s.id = t.status_id WHERE r.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.is_archived || ['done', 'cancelled'].includes(r.stage)) return 'The task was finished before this could be sent';
    if (r.deferral_id) return 'The task was deferred before this could be sent';
    if (r.role === 'OWNER' && r.assignee_id !== r.user_id) return 'The task was handed to someone else before this could be sent';
    if (new Date(r.due_date).getTime() !== new Date(r.due_at).getTime()) return 'The deadline changed before this could be sent';
    return null;
  }
  if (row.kind === 'ALERT' && row.notification_id) {
    const { rows } = await query(
      `SELECT n.type, n.user_id, t.assignee_id, t.follower_id, t.is_archived, s.stage
         FROM notifications n JOIN tasks t ON t.id = n.task_id JOIN workflow_statuses s ON s.id = t.status_id WHERE n.id = $1`,
      [row.notification_id],
    );
    const n = rows[0];
    if (!n) return null;
    const closed = n.is_archived || ['done', 'cancelled'].includes(n.stage);
    if (['due_soon', 'assigned'].includes(n.type) && closed) return 'The task was finished before this could be sent';
    if (['due_soon', 'assigned'].includes(n.type) && n.assignee_id !== n.user_id) return 'The task was handed to someone else before this could be sent';
    if (n.type === 'follower' && n.follower_id !== n.user_id) return 'They no longer follow the task';
  }
  return null;
}

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
    // a message about a task that has moved on since it was queued is not sent
    const stale = await staleReason(row).catch(() => null);
    if (stale) {
      await query(`UPDATE chat_outbox SET status = 'CANCELLED', last_error = $2 WHERE id = $1`, [row.id, stale]);
      continue;
    }
    try {
      const result = await sendChatMessage(row.space_name, row.payload);
      await query(
        `UPDATE chat_outbox SET status = 'SENT', sent_at = now(), attempts = attempts + 1, message_name = $2, thread_name = $3, last_error = NULL WHERE id = $1`,
        [row.id, result?.name || null, result?.thread || null],
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
  // the daily standup has its own space and schedule; a fault there never stops the rest
  let standup = null;
  try { standup = await runStandup(now); } catch (err) { standup = { error: err.message }; }
  const delivered = await deliverOutbox();
  return { dispatched, summaries, standup, delivered };
}
