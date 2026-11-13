/**
 * Task reminders: one planned engine for every task, on the pattern of the
 * sales follow-up reminders (services/sales/followupReminders.js), which keep
 * their own reminders for CRM follow-ups.
 *
 *   - **Planned, not guessed.** One row per task, person, moment and channel
 *     (task_reminders): before the deadline (D5: 2 hours), at the deadline to
 *     the owner, and after the grace period to the fallback person. The plan
 *     is redone whenever the task changes; whatever no longer fits is
 *     cancelled, so a reminder for an old time or an old owner is never sent.
 *   - **Checked when sent.** Each row is claimed (SKIP LOCKED), then checked
 *     against the task as it stands: finished, handed over, re-dated or
 *     deferred means cancelled, not sent.
 *   - **People's time.** Nothing on a day off, a holiday, leave or the half of
 *     a day that is off, and nothing in quiet hours (D6): each is skipped with
 *     the reason, and the next morning summary carries the task. Anything due
 *     while the owner is away goes to their fallback person instead.
 *   - **Honest about delivery.** Every row ends as sent, failed, skipped,
 *     cancelled or "would send" (test mode), with the reason. A Chat message
 *     the outbox could not deliver is followed by a notice to the fallback
 *     person. A sent message is not a read one: acknowledgement is recorded
 *     separately, when the person opens the task.
 *   - **Safe start.** TEST until an administrator switches it to LIVE: in
 *     TEST only the administrator who switched it on receives anything, and
 *     everyone else's reminders are recorded as "would send".
 */
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { chatLink as chatAnchor, chatText } from '../lib/googleChat.js';
import { getSettings } from './settings.js';
import { deadlineClock } from './deadlines.js';
import { addDays, healthLabel, localDate } from '../../../shared/deadlineHealth.js';
import { markCalendar, pickRule } from './blackmarks.js';
import { fallbackPeople } from './taskPeople.js';

const HOUR = 3_600_000;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MODES = ['OFF', 'TEST', 'LIVE'];

export async function reminderSettings(settings = null) {
  const s = settings || await getSettings();
  const r = s.reminders || {};
  return {
    mode: MODES.includes(r.mode) ? r.mode : 'TEST',
    testRecipientId: r.testRecipientId ?? null,
    beforeDueHours: Math.min(48, Math.max(0, Number(r.beforeDueHours ?? 2))),
    atDue: r.atDue !== false,
    managerNotice: r.managerNotice !== false,
    quietStart: TIME.test(String(r.quietStart)) ? r.quietStart : '20:00',
    quietEnd: TIME.test(String(r.quietEnd)) ? r.quietEnd : '08:30',
    catchUpUntil: TIME.test(String(r.catchUpUntil)) ? r.catchUpUntil : '18:00',
    weeklyBacklog: r.weeklyBacklog !== false,
    coverageTime: TIME.test(String(r.coverageTime)) ? r.coverageTime : '11:00',
    timezone: s.organisation?.timezone || 'Asia/Kolkata',
    chatEnabled: s.googleChat?.enabled === true,
  };
}

export const hhmm = (instant, timezone) => new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(instant);

/** Whether an instant falls in quiet hours (which usually run past midnight). */
export function inQuietHours(instant, { quietStart, quietEnd, timezone }) {
  const t = hhmm(instant, timezone);
  if (quietStart === quietEnd) return false;
  return quietStart < quietEnd ? t >= quietStart && t < quietEnd : t >= quietStart || t < quietEnd;
}

const OFF_WORDS = {
  WEEKLY_OFF: 'their day off',
  HOLIDAY: 'a holiday',
  HOLIDAY_HALF: 'the half of the day that is a holiday',
  LEAVE: 'on approved leave',
  LEAVE_HALF: 'on approved half-day leave',
};
export const offWords = (off) => (off ? `${OFF_WORDS[off.code] || 'away'}${off.name ? ` (${off.name})` : ''}` : null);

/** Whether a person is away at an instant, and if so why, from their own calendar. */
export async function awayAt(userIds, instant, timezone) {
  const date = localDate(instant, timezone);
  const cal = await markCalendar(userIds, { from: addDays(date, -1), to: addDays(date, 60), now: instant });
  // seconds into the local day, which decides which half of a half day applies
  const [h, m] = hhmm(instant, timezone).split(':').map(Number);
  const local = h * 3600 + m * 60;
  const out = new Map();
  for (const id of userIds) out.set(id, cal.offAt(id, date, local));
  /** The first date the person is working again (for "nothing due before they return"). */
  const backOn = (id) => {
    let d = date;
    for (let i = 0; i < 60; i += 1) {
      d = addDays(d, 1);
      if (!cal.offAt(id, d, 9 * 3600)) return d;
    }
    return null;
  };
  return { away: out, backOn, date };
}

// ---------------------------------------------------------------- reaching people

/** Whether a person's Google Chat can be used, and if not, why in words. */
export async function chatRoute(userId, runner = { query }, settings = null) {
  const s = settings || await reminderSettings();
  if (!s.chatEnabled) return { ok: false, why: 'Google Chat is switched off for the organisation' };
  const { rows } = await runner.query(
    `SELECT s.space_name, s.added_by_email, u.email, COALESCE(p.instant, TRUE) AS instant, COALESCE(p.morning_summary, TRUE) AS morning_summary
       FROM users u
       LEFT JOIN chat_spaces s ON s.kind = 'DM' AND s.user_id = u.id AND s.active
       LEFT JOIN chat_preferences p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r?.space_name) return { ok: false, why: 'Not connected to Google Chat', notConnected: true, prefs: r };
  if (r.added_by_email && r.added_by_email.toLowerCase() !== String(r.email).toLowerCase()) {
    return { ok: false, why: 'The Chat account linked to this person is not their login email; an administrator should check it', notConnected: true, prefs: r };
  }
  return { ok: true, space: r.space_name, instant: r.instant, morningSummary: r.morning_summary };
}

// ---------------------------------------------------------------- the words

const app = (path = '/') => `${config.publicUrl}${path}`;
export const taskUrl = (taskId) => app(`/?task=${taskId}`);
const dueWords = (due, timezone) => `${new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(due)} ${timezone === 'Asia/Kolkata' ? 'IST' : timezone}`;

/**
 * What every task message carries: the task ID and title, the owner, the due
 * date and time with the time zone, the status and deadline health, the next
 * action, and a direct link.
 */
export function taskFacts(task, c) {
  const h = healthLabel(task, c);
  return {
    health: h,
    lines: [
      `Owner: ${task.owner_name || 'nobody yet'}`,
      `Due: ${task.due_date ? dueWords(new Date(task.due_date), c.timezone) : 'no deadline'}`,
      `Status: ${task.status_name || task.stage} · ${h.text}`,
      `Next action: ${task.next_action || 'none recorded'}`,
    ],
  };
}

const KIND_TYPE = { BEFORE_DUE: 'task_due_soon', AT_DUE: 'task_due_now', AFTER_GRACE: 'task_overdue_notice', COVER: 'task_cover', UNREACHED: 'task_unreached' };

export function reminderWords(r, task, c, { test = false } = {}) {
  const ref = task.ref || `#${task.id}`;
  const left = task.due_date ? Math.max(1, Math.round((new Date(task.due_date).getTime() - c.now.getTime()) / 60_000)) : 0;
  const leftWords = left >= 90 ? `${Math.round(left / 60)} h` : `${left} min`;
  const title = {
    BEFORE_DUE: `Due in ${leftWords}: ${ref} ${task.title}`,
    AT_DUE: `Deadline now: ${ref} ${task.title}`,
    AFTER_GRACE: `Still open after its deadline: ${ref} ${task.title} (${task.owner_name || 'no owner'})`,
    COVER: `Covering for ${task.owner_name || 'a colleague'}: ${ref} ${task.title}`,
    UNREACHED: `Could not reach ${task.owner_name || 'the owner'} about ${ref} ${task.title}`,
  }[r.kind];
  const why = {
    COVER: `${task.owner_name || 'The owner'} is ${r.reason_note || 'away'}, and this is due before they are back.`,
    UNREACHED: `A reminder to ${task.owner_name || 'the owner'} could not be delivered in Google Chat${r.reason_note ? ` (${r.reason_note})` : ''}.`,
    AFTER_GRACE: 'The grace period has passed and it is still open. A conversation may help: it may be blocked, need a new date, or be done but not marked.',
  }[r.kind];
  const facts = taskFacts(task, c);
  const body = [why, ...facts.lines].filter(Boolean).join('\n');
  const prefix = test ? 'TEST · ' : '';
  return {
    type: KIND_TYPE[r.kind],
    title: `${prefix}${title}`,
    body,
    chat: { text: [`${test ? '*TEST* · ' : ''}⏰ *${chatText(title)}*`, ...body.split('\n').map(chatText), chatAnchor(taskUrl(task.id), `Open ${ref} in TaskFlow`)].join('\n') },
  };
}

// ---------------------------------------------------------------- planning

/** The grace period the black-mark rule for this task would use (D2), else 24 hours. */
async function graceHours(task, runner) {
  const { rows } = await runner.query(`SELECT * FROM blackmark_rules WHERE is_active = TRUE AND trigger_type = 'deadline_missed'`);
  const rule = pickRule(rows, task);
  return rule ? Number(rule.grace_hours || 0) : 24;
}

const TASK_FOR_REMINDERS = `
  SELECT t.id, t.ref, t.title, t.assignee_id, t.due_date, t.department_id, t.priority, t.is_archived, t.followup_kind,
         t.deferral_id, t.review_date, t.next_action, t.status_id, s.stage, s.name AS status_name,
         u.full_name AS owner_name, u.is_active AS owner_active
    FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id LEFT JOIN users u ON u.id = t.assignee_id`;

/** Why a task has no reminders now, or null when it should have them. */
function notRemindable(t) {
  if (!t) return 'The task no longer exists';
  if (t.is_archived) return 'The task was archived';
  if (t.stage === 'done') return 'The task is done';
  if (t.stage === 'cancelled') return 'The task was cancelled';
  if (t.followup_kind) return 'A CRM follow-up: it has its own reminders';
  if (!t.assignee_id) return 'The task has no owner';
  if (!t.owner_active) return 'The owner\'s account is switched off';
  if (!t.due_date) return 'The task has no deadline';
  if (t.deferral_id) return 'The task is deferred';
  return null;
}

/** Cancels every pending reminder of these tasks, with the reason. */
export async function cancelTaskReminders(runner, taskIds, reason) {
  if (!taskIds?.length) return 0;
  const { rowCount } = await runner.query(
    `UPDATE task_reminders SET status = 'CANCELLED', reason = $2, updated_at = now() WHERE task_id = ANY($1::int[]) AND status = 'PENDING'`,
    [taskIds, reason],
  );
  return rowCount;
}

/**
 * Plans the reminders one task should have now, for its current deadline and
 * owner. Anything pending that no longer fits is cancelled. A moment that has
 * already gone is not planned (it shows in the summaries instead).
 */
export async function planTaskReminders(runner, taskId, { now = new Date(), settings = null } = {}) {
  const s = settings || await reminderSettings();
  const { rows } = await runner.query(`${TASK_FOR_REMINDERS} WHERE t.id = $1`, [taskId]);
  const t = rows[0];
  const why = notRemindable(t);
  if (why || s.mode === 'OFF') {
    await cancelTaskReminders(runner, [taskId], why || 'Task reminders are switched off');
    return [];
  }
  const due = new Date(t.due_date);
  const wanted = [];
  const add = (kind, at, userId, role, aboutUserId = null) => {
    for (const channel of ['APP', 'CHAT']) wanted.push({ kind, at, userId, role, aboutUserId, channel });
  };
  if (s.beforeDueHours > 0) add('BEFORE_DUE', new Date(due.getTime() - s.beforeDueHours * HOUR), t.assignee_id, 'OWNER');
  if (s.atDue) add('AT_DUE', due, t.assignee_id, 'OWNER');
  if (s.managerNotice) {
    const grace = await graceHours(t, runner);
    const fallback = await fallbackPeople(t.assignee_id, t.department_id, runner);
    // the reporting manager if there is one, otherwise the department's managers
    const told = fallback[0]?.why === 'reporting manager' ? [fallback[0]] : fallback;
    for (const p of told) add('AFTER_GRACE', new Date(due.getTime() + grace * HOUR), p.id, 'FALLBACK', t.assignee_id);
  }
  const keep = wanted.filter((w) => w.at.getTime() >= now.getTime() - 60_000);

  // whatever is pending for another moment, person or kind no longer applies
  const { rows: pending } = await runner.query(
    `SELECT id, kind, user_id, due_at, channel, remind_at FROM task_reminders WHERE task_id = $1 AND status = 'PENDING' AND kind IN ('BEFORE_DUE', 'AT_DUE', 'AFTER_GRACE')`,
    [taskId],
  );
  for (const p of pending) {
    const still = keep.some((w) => w.kind === p.kind && w.userId === p.user_id && w.channel === p.channel
      && new Date(p.due_at).getTime() === due.getTime() && new Date(p.remind_at).getTime() === w.at.getTime());
    if (!still) {
      const reason = new Date(p.due_at).getTime() !== due.getTime() ? 'The deadline changed'
        : p.user_id !== t.assignee_id && p.kind !== 'AFTER_GRACE' ? 'The task was handed to someone else' : 'The plan changed';
      await runner.query(`UPDATE task_reminders SET status = 'CANCELLED', reason = $2, updated_at = now() WHERE id = $1`, [p.id, reason]);
    }
  }
  const planned = [];
  for (const w of keep) {
    const { rows: r } = await runner.query(
      `INSERT INTO task_reminders (task_id, user_id, kind, role, about_user_id, due_at, remind_at, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (task_id, user_id, kind, due_at, channel) DO NOTHING RETURNING *`,
      [taskId, w.userId, w.kind, w.role, w.aboutUserId, due, w.at, w.channel],
    );
    if (r[0]) planned.push(r[0]);
  }
  return planned;
}

/** Plans one task in its own transaction; never fails the caller. */
export async function replanTask(taskId) {
  try {
    await withTransaction((client) => planTaskReminders(client, taskId));
  } catch (err) {
    console.error(`[taskflow] reminders: planning task ${taskId} failed:`, err.message);
  }
}

/**
 * Re-plans every open task with a deadline near enough to matter: a safety
 * net under the per-change planning, so leave approved elsewhere, an owner
 * switched off or a rule's grace changed are picked up within minutes.
 */
export async function replanSweep({ now = new Date() } = {}) {
  const settings = await reminderSettings();
  const { rows } = await query(
    `SELECT t.id FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled') AND t.followup_kind IS NULL
        AND t.due_date BETWEEN $1::timestamptz - interval '3 days' AND $1::timestamptz + interval '30 days'`,
    [now],
  );
  for (const r of rows) {
    await withTransaction((client) => planTaskReminders(client, r.id, { now, settings }));
  }
  // pending reminders of tasks that have since closed are cancelled when their moment comes
  return { planned: rows.length };
}

// ---------------------------------------------------------------- sending

async function insertNotification(runner, { userId, type, title, body, taskId }) {
  const { rows } = await runner.query(
    `INSERT INTO notifications (user_id, type, title, body, task_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, type, title, body, taskId],
  );
  return rows[0].id;
}

/** Plans a fallback reminder (cover or could-not-reach) to be sent now, once. */
async function planFallback(runner, task, kind, note, now) {
  const people = await fallbackPeople(task.assignee_id, task.department_id, runner);
  const told = people[0]?.why === 'reporting manager' ? [people[0]] : people;
  for (const p of told) {
    for (const channel of ['APP', 'CHAT']) {
      await runner.query(
        `INSERT INTO task_reminders (task_id, user_id, kind, role, about_user_id, due_at, remind_at, channel, reason)
         VALUES ($1, $2, $3, 'FALLBACK', $4, $5, $6, $7, $8)
         ON CONFLICT (task_id, user_id, kind, due_at, channel) DO NOTHING`,
        [task.id, p.id, kind, task.assignee_id, task.due_date, now, channel, note],
      );
    }
  }
  return told.length;
}

/**
 * Sends the reminders that are due. Each is claimed first, then checked
 * against the task and the person as they are now.
 */
export async function sendDueTaskReminders(now = new Date(), { limit = 300 } = {}) {
  const s = await reminderSettings();
  const c = await deadlineClock(now);
  const out = { sent: 0, failed: 0, cancelled: 0, skipped: 0, would_send: 0, covered: 0 };
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE task_reminders r SET status = 'SENDING', attempts = attempts + 1, updated_at = now()
        WHERE r.id IN (SELECT id FROM task_reminders WHERE status = 'PENDING' AND remind_at <= $1
                        ORDER BY remind_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING r.*`,
      [now, limit],
    );
    if (!rows.length) return;
    rows.sort((a, b) => new Date(a.remind_at) - new Date(b.remind_at) || a.id - b.id);
    // when the worker was behind, only the latest reminder per task, person and channel goes
    const latest = new Map();
    for (const r of rows) latest.set(`${r.task_id}:${r.user_id}:${r.channel}`, r.id);
    const people = [...new Set(rows.map((r) => r.user_id))];
    const { away, backOn } = await awayAt(people, now, s.timezone);
    const { rows: active } = await client.query('SELECT id, is_active FROM users WHERE id = ANY($1::int[])', [people]);
    const isActive = new Map(active.map((u) => [u.id, u.is_active]));
    const quiet = inQuietHours(now, s);

    for (const r of rows) {
      const finish = async (status, reason = null, extra = {}) => {
        await client.query(
          `UPDATE task_reminders SET status = $2, reason = $3, sent_at = CASE WHEN $2 = 'SENT' THEN $4::timestamptz ELSE sent_at END,
                  notification_id = COALESCE($5, notification_id), outbox_key = COALESCE($6, outbox_key), updated_at = now()
            WHERE id = $1`,
          [r.id, status, reason, now, extra.notificationId ?? null, extra.outboxKey ?? null],
        );
        out[{ SENT: 'sent', FAILED: 'failed', CANCELLED: 'cancelled', SKIPPED: 'skipped', WOULD_SEND: 'would_send' }[status]] += 1;
      };
      const { rows: tr } = await client.query(`${TASK_FOR_REMINDERS} WHERE t.id = $1`, [r.task_id]);
      const t = tr[0];
      const closed = notRemindable(t);
      if (closed && !(r.role === 'FALLBACK' && t && !t.owner_active && !t.is_archived && !['done', 'cancelled'].includes(t.stage))) {
        await finish('CANCELLED', closed); continue;
      }
      if (r.role === 'OWNER' && t.assignee_id !== r.user_id) { await finish('CANCELLED', 'The task was handed to someone else'); continue; }
      if (new Date(t.due_date).getTime() !== new Date(r.due_at).getTime()) { await finish('CANCELLED', 'The deadline changed'); continue; }
      if (s.mode === 'OFF') { await finish('SKIPPED', 'Task reminders are switched off'); continue; }
      if (!isActive.get(r.user_id)) { await finish('CANCELLED', 'Their account is switched off'); continue; }
      if (latest.get(`${r.task_id}:${r.user_id}:${r.channel}`) !== r.id) {
        await finish('SKIPPED', 'A later reminder for the same task was due at the same time; only that one was sent'); continue;
      }
      const lateBy = now.getTime() - new Date(r.remind_at).getTime();
      if (r.kind === 'BEFORE_DUE' && now.getTime() >= new Date(t.due_date).getTime()) {
        await finish('SKIPPED', 'The deadline passed before it could be sent; the task shows as overdue instead'); continue;
      }
      if (lateBy > 12 * HOUR) { await finish('SKIPPED', 'More than 12 hours late; the morning summary carries the task instead'); continue; }

      const off = away.get(r.user_id);
      if (off) {
        // the owner is away: anything due before they are back goes to the fallback person
        if (r.role === 'OWNER' && r.channel === 'APP' && (r.kind === 'BEFORE_DUE' || r.kind === 'AT_DUE')) {
          const back = backOn(r.user_id);
          const n = await planFallback(client, t, 'COVER', `${offWords(off)}${back ? `, back on ${back}` : ''}`, now);
          out.covered += n;
          await finish('SKIPPED', `Away: ${offWords(off)}.${n ? ' Their fallback person was told instead.' : ' Nobody to cover: listed in the coverage check.'}`);
        } else {
          await finish('SKIPPED', `Away: ${offWords(off)}`);
        }
        continue;
      }
      if (quiet) { await finish('SKIPPED', `Quiet hours (${s.quietStart}–${s.quietEnd}): the next morning summary carries it`); continue; }

      const test = s.mode === 'TEST';
      if (test && Number(s.testRecipientId) !== r.user_id) { await finish('WOULD_SEND', 'Test mode: would have been sent'); continue; }
      const words = reminderWords({ ...r, reason_note: r.reason }, t, c, { test });
      if (r.channel === 'APP') {
        const notificationId = await insertNotification(client, { userId: r.user_id, type: words.type, title: words.title, body: words.body, taskId: t.id });
        await finish('SENT', null, { notificationId });
        continue;
      }
      const route = await chatRoute(r.user_id, client, s);
      if (!route.ok) { await finish('SKIPPED', `${route.why}; the TaskFlow bell carried it`); continue; }
      if (!route.instant) { await finish('SKIPPED', 'They switched Chat alerts off; the TaskFlow bell carried it'); continue; }
      const key = `task-reminder:${r.id}`;
      await client.query(
        `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload) VALUES ($1, $2, $3, 'TASK_REMINDER', $4)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [key, route.space, r.user_id, JSON.stringify(words.chat)],
      );
      await finish('SENT', null, { outboxKey: key });
    }
  });
  return out;
}

/**
 * A Chat reminder the outbox gave up on: the fallback person is told, once.
 * (The bell copy did arrive; the person may simply not have opened TaskFlow.)
 */
export async function followUpFailedChats(now = new Date()) {
  const { rows } = await query(
    `SELECT r.*, o.last_error FROM task_reminders r JOIN chat_outbox o ON o.dedupe_key = r.outbox_key
      WHERE r.channel = 'CHAT' AND r.role = 'OWNER' AND r.status = 'SENT' AND o.status = 'FAILED'
        AND r.remind_at > $1::timestamptz - interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM task_reminders u WHERE u.task_id = r.task_id AND u.kind = 'UNREACHED' AND u.due_at = r.due_at)`,
    [now],
  );
  let told = 0;
  for (const r of rows) {
    await withTransaction(async (client) => {
      const { rows: tr } = await client.query(`${TASK_FOR_REMINDERS} WHERE t.id = $1`, [r.task_id]);
      if (!tr[0] || notRemindable(tr[0])) return;
      told += await planFallback(client, tr[0], 'UNREACHED', String(r.last_error || 'delivery failed').slice(0, 160), now);
    });
  }
  return { told };
}

/** The person opened the task: their sent reminders for it are acknowledged. */
export async function acknowledgeTaskReminders(taskId, userId) {
  const { rowCount } = await query(
    `UPDATE task_reminders SET acknowledged_at = now(), updated_at = now()
      WHERE task_id = $1 AND user_id = $2 AND status = 'SENT' AND acknowledged_at IS NULL`,
    [taskId, userId],
  );
  return rowCount;
}

/** One task's reminders, newest plan first, with Chat delivery where it applies. */
export async function remindersForTask(taskId) {
  const { rows } = await query(
    `SELECT r.*, u.full_name AS user_name, o.status AS chat_status, o.last_error AS chat_error, o.sent_at AS chat_sent_at
       FROM task_reminders r JOIN users u ON u.id = r.user_id LEFT JOIN chat_outbox o ON o.dedupe_key = r.outbox_key
      WHERE r.task_id = $1 ORDER BY r.remind_at DESC, r.id DESC`,
    [taskId],
  );
  return rows.map(deliveryStatus);
}

/**
 * One state for the delivery log: QUEUED, SENT, FAILED, SKIPPED,
 * ACKNOWLEDGED, CANCELLED, WOULD_SEND or PLANNED. A Chat reminder is SENT only
 * once the outbox delivered it.
 */
export function deliveryStatus(r) {
  let state = r.status;
  if (r.status === 'PENDING' || r.status === 'SENDING') state = 'PLANNED';
  if (r.status === 'SENT' && r.channel === 'CHAT') state = r.chat_status === 'SENT' ? 'SENT' : r.chat_status === 'FAILED' ? 'FAILED' : 'QUEUED';
  if (state === 'SENT' && r.acknowledged_at) state = 'ACKNOWLEDGED';
  return { ...r, state, reason: r.status === 'SENT' && r.chat_status === 'FAILED' ? r.chat_error : r.reason };
}
