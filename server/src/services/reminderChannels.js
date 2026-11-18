/**
 * How people hear about their tasks (docs/DEADLINES_REMINDERS.md, "Email"):
 * the TaskFlow bell always, Google Chat and email by each person's choice over
 * the organisation's defaults, and the queue that turns reminders into emails.
 *
 * The choices:
 *   BOTH             Chat and email
 *   CHAT_ELSE_EMAIL  Chat, or email when Chat cannot reach them
 *   EMAIL            email only
 *   CHAT             Chat only
 *   BELL             the TaskFlow bell only
 * The bell always carries a task reminder, whatever the choice.
 *
 * Kept apart from the reminder engine and the summaries so both can use it
 * without importing each other.
 */
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { getSettings } from './settings.js';
import { emailReadiness } from './accountEmail.js';
import { localDate } from '../../../shared/deadlineHealth.js';

export const CHANNEL_CHOICES = ['BOTH', 'CHAT_ELSE_EMAIL', 'EMAIL', 'CHAT', 'BELL'];
export const CHOICE_WORDS = {
  BOTH: 'Google Chat and email',
  CHAT_ELSE_EMAIL: 'Google Chat, or email when Chat can\'t reach me',
  EMAIL: 'Email only',
  CHAT: 'Google Chat only',
  BELL: 'The TaskFlow bell only',
};
// reminders that fall due within this of the first one go as one email
export const BATCH_HOLD_MS = 3 * 60_000;
const valid = (v, fallback) => (CHANNEL_CHOICES.includes(v) ? v : fallback);

/** The organisation's defaults for email (Settings → Reminders → Channels). */
export function emailDefaults(settings) {
  const e = settings?.reminders?.email || {};
  const cap = Number(e.dailyCap);
  return {
    enabled: e.enabled !== false,
    taskReminders: valid(e.taskReminders, 'BOTH'),
    summaries: valid(e.summaries, 'CHAT_ELSE_EMAIL'),
    managerNotices: e.managerNotices !== false,
    teamSummary: e.teamSummary === true,
    dailyCap: Number.isFinite(cap) ? Math.min(50, Math.max(1, Math.round(cap))) : 10,
  };
}

/** Whether reminder emails can go now: the switch, and the system sender (Settings → Email). */
export async function emailChannel(settings = null) {
  const all = settings || await getSettings();
  const d = emailDefaults(all);
  const readiness = await emailReadiness();
  const ready = d.enabled && readiness.ready;
  return {
    ...d,
    ready,
    reason: !d.enabled ? 'Email reminders are switched off (Settings → Reminders → Channels)' : readiness.reason,
    readiness,
  };
}

/**
 * Each person's choices over the defaults, with their address and whether it
 * bounced: Map user id → { taskReminders, summaries, summaryAllClear, chosen,
 * email, undeliverable, undeliverableReason }.
 */
export async function channelPrefs(userIds, runner = { query }, settings = null) {
  const ids = [...new Set(userIds)].filter(Boolean).map(Number);
  const out = new Map();
  if (!ids.length) return out;
  const d = emailDefaults(settings || await getSettings());
  const { rows } = await runner.query(
    `SELECT u.id, u.email, u.email_undeliverable_at, u.email_undeliverable_reason,
            p.task_reminders, p.summaries, p.summary_all_clear
       FROM users u LEFT JOIN reminder_channel_prefs p ON p.user_id = u.id WHERE u.id = ANY($1::int[])`,
    [ids],
  );
  for (const r of rows) {
    out.set(r.id, {
      taskReminders: valid(r.task_reminders, d.taskReminders),
      summaries: valid(r.summaries, d.summaries),
      summaryAllClear: Boolean(r.summary_all_clear),
      chosen: Boolean(r.task_reminders || r.summaries),
      email: r.email,
      undeliverable: Boolean(r.email_undeliverable_at),
      undeliverableAt: r.email_undeliverable_at,
      undeliverableReason: r.email_undeliverable_reason,
    });
  }
  return out;
}

export async function channelPref(userId, runner = { query }, settings = null) {
  return (await channelPrefs([userId], runner, settings)).get(Number(userId)) || null;
}

/**
 * Which channels a choice plans, besides the bell. When email cannot be used
 * (not set up, or their address bounced), "email only" falls back to Chat, so
 * nobody loses their reminders by choosing email.
 */
export function plannedChannels(choice, emailUsable) {
  const c = valid(choice, 'BOTH');
  if (!emailUsable) return { chat: c !== 'BELL', email: false };
  return {
    chat: c === 'BOTH' || c === 'CHAT_ELSE_EMAIL' || c === 'CHAT',
    email: c === 'BOTH' || c === 'CHAT_ELSE_EMAIL' || c === 'EMAIL',
  };
}

/**
 * Which channels carry a person's summary (the morning summary, the weekly
 * backlog review). `chatOk`: Chat reaches them and they have not switched the
 * Chat summary off. `emailUsable`: email could reach them. "Email only" falls
 * back to Chat when email cannot be used; "the bell only" uses neither.
 */
export function summaryChannels(choice, { chatOk, emailUsable }) {
  const c = valid(choice, 'CHAT_ELSE_EMAIL');
  if (c === 'BELL') return { chat: false, email: false };
  if (c === 'EMAIL') return emailUsable ? { chat: false, email: true } : { chat: chatOk, email: false };
  if (c === 'CHAT') return { chat: chatOk, email: false };
  if (c === 'BOTH') return { chat: chatOk, email: emailUsable };
  return { chat: chatOk, email: !chatOk && emailUsable };
}

/**
 * Whether a summary could go to this person by email at all: email set up,
 * their address not bounced, and, for someone who switched the Chat summary
 * off and has not chosen anything here, not (switching it off meant "no
 * summary", and is not read now as "by email instead"). `live` also applies
 * the reminders' mode: in TEST only the test administrator's emails go.
 */
export function summaryEmailUsable(pref, { channel, chatSummaryOff = false, mode = 'LIVE', testRecipientId = null, userId = null, live = false }) {
  if (!channel?.ready || !pref || pref.undeliverable) return false;
  if (chatSummaryOff && !pref.chosen) return false;
  if (!live) return true;
  if (mode === 'OFF') return false;
  return mode === 'LIVE' || Number(testRecipientId) === Number(userId);
}

// ---------------------------------------------------------------- the email queue

/**
 * One reminder into an email. It joins an email of the same kind still being
 * held for this person (so several reminders falling due together go as one),
 * or starts a new one, unless the person has had today's allowance. Returns
 * { key } or { capped: true }.
 */
export async function queueReminderEmail(runner, { userId, address, kind, item, holdMs = BATCH_HOLD_MS, now = new Date(), timezone = 'Asia/Kolkata', cap = 10 }) {
  const day = localDate(now, timezone);
  if (holdMs > 0) {
    const { rows: open } = await runner.query(
      `SELECT id, dedupe_key FROM email_outbox
        WHERE user_id = $1 AND kind = $2 AND status = 'PENDING' AND attempts = 0 AND hold_until > $3 AND items < 20
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [userId, kind, now],
    );
    if (open[0]) {
      await runner.query(
        `UPDATE email_outbox SET payload = jsonb_set(payload, '{items}', COALESCE(payload->'items', '[]'::jsonb) || $2::jsonb),
                items = items + 1, updated_at = now() WHERE id = $1`,
        [open[0].id, JSON.stringify([item])],
      );
      return { key: open[0].dedupe_key, joined: true };
    }
  }
  const { rows: [{ n }] } = await runner.query(
    `SELECT COUNT(*)::int AS n FROM email_outbox
      WHERE user_id = $1 AND kind IN ('REMINDER', 'FOLLOW_UP', 'WORKSPACE') AND local_date = $2 AND status <> 'CANCELLED'`,
    [userId, day],
  );
  if (n >= cap) return { capped: true };
  const key = `email:${kind.toLowerCase()}:${userId}:${crypto.randomUUID()}`;
  const hold = new Date(now.getTime() + holdMs);
  await runner.query(
    `INSERT INTO email_outbox (dedupe_key, user_id, to_address, kind, payload, items, hold_until, next_attempt_at, local_date)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6, $7)`,
    [key, userId, address, kind, JSON.stringify({ items: [item] }), hold, day],
  );
  return { key };
}

/** A summary into an email of its own (summaries never count towards the daily allowance). */
export async function queueSummaryEmail(runner, { key, userId, address, payload, now = new Date() }) {
  await (runner || { query }).query(
    `INSERT INTO email_outbox (dedupe_key, user_id, to_address, kind, payload, hold_until, next_attempt_at)
     VALUES ($1, $2, $3, 'SUMMARY', $4, $5, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [key, userId, address, JSON.stringify(payload), now],
  );
  return { key };
}
