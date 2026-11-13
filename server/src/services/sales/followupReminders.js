/**
 * Reminders before a follow-up, on each person's terms.
 *
 *   - **Choices:** any of 30, 15, 10 and 5 minutes before, in the app and/or
 *     Google Chat. Each person sets defaults; one follow-up can override them.
 *   - **Planned, not guessed:** every reminder is a row planned for one
 *     follow-up time and one person. Moving, handing over, finishing or
 *     cancelling a follow-up cancels what is pending and plans afresh, so a
 *     reminder for an old time or the old owner is never sent.
 *   - **Sent by the server:** the sales worker sends what is due, whether or
 *     not anyone has TaskFlow open. Each row is claimed before it is sent, so
 *     two workers (or a restart mid-run) cannot send it twice; Chat messages
 *     also go through the outbox under a stable key.
 *   - **Honest about delivery:** a reminder that could not be sent says why
 *     (no Chat link, Chat switched off, the time had already passed).
 *   - **Never late:** a reminder whose follow-up time has passed is not sent;
 *     the follow-up shows as due or overdue instead.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { notify } from '../activity.js';
import { config } from '../../config.js';
import { salesSettings } from './core.js';
import { getSettings } from '../settings.js';

export const REMINDER_OFFSETS = [30, 15, 10, 5];
export const REMINDER_CHANNELS = ['APP', 'CHAT'];
const DEFAULT_PREFS = { offsets: [15], channels: ['APP'] };

const cleanOffsets = (list) => [...new Set((list || []).map(Number))].filter((n) => REMINDER_OFFSETS.includes(n)).sort((a, b) => b - a);
const cleanChannels = (list) => [...new Set(list || [])].filter((c) => REMINDER_CHANNELS.includes(c));

export async function reminderPrefs(userId, runner = { query }) {
  const { rows } = await runner.query('SELECT offsets, channels, updated_at FROM crm_reminder_prefs WHERE user_id = $1', [userId]);
  return rows[0] ? { offsets: rows[0].offsets, channels: rows[0].channels, saved: true } : { ...DEFAULT_PREFS, saved: false };
}

/** Saves a person's defaults and re-plans their open follow-ups that use them. */
export async function saveReminderPrefs(userId, { offsets, channels }) {
  const o = cleanOffsets(offsets);
  const c = cleanChannels(channels);
  if (offsets?.length && !o.length) throw badRequest('Choose from 30, 15, 10 or 5 minutes before');
  if (o.length && !c.length) throw badRequest('Choose where reminders arrive: in TaskFlow, in Google Chat, or both');
  await query(
    `INSERT INTO crm_reminder_prefs (user_id, offsets, channels, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET offsets = EXCLUDED.offsets, channels = EXCLUDED.channels, updated_at = now()`,
    [userId, o, c],
  );
  const { rows } = await query(
    `SELECT id FROM tasks WHERE assignee_id = $1 AND followup_kind IS NOT NULL AND completed_at IS NULL AND is_archived = FALSE
        AND crm_cancel_reason IS NULL AND reminder_offsets IS NULL AND due_date > now()`,
    [userId],
  );
  await withTransaction(async (client) => { for (const t of rows) await planReminders(client, t.id); });
  return { ...(await reminderPrefs(userId)), replanned: rows.length };
}

/** Cancels every pending reminder of these follow-ups. */
export async function cancelReminders(client, taskIds, reason) {
  if (!taskIds?.length) return 0;
  const { rowCount } = await client.query(
    `UPDATE crm_followup_reminders SET status = 'CANCELLED', cancel_reason = $2 WHERE task_id = ANY($1::int[]) AND status = 'PENDING'`,
    [taskIds, reason],
  );
  return rowCount;
}

/**
 * Plans the reminders one follow-up should have now: for its current time and
 * person, by its own choice or the person's defaults. Anything pending that no
 * longer fits is cancelled. A reminder whose moment has already gone when it
 * is planned is recorded as skipped (it is never sent late).
 */
export async function planReminders(client, taskId, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT id, assignee_id, due_date, completed_at, crm_cancel_reason, is_archived, followup_kind, reminder_offsets, reminder_channels
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  const t = rows[0];
  const open = t && t.followup_kind && !t.completed_at && !t.crm_cancel_reason && !t.is_archived && t.assignee_id && t.due_date;
  if (!open) {
    await cancelReminders(client, [taskId], 'Follow-up closed');
    return [];
  }
  const prefs = await reminderPrefs(t.assignee_id, client);
  const offsets = t.reminder_offsets ? cleanOffsets(t.reminder_offsets) : cleanOffsets(prefs.offsets);
  const channels = t.reminder_channels ? cleanChannels(t.reminder_channels) : cleanChannels(prefs.channels);
  const due = new Date(t.due_date);
  // whatever is pending for another time, person, offset or channel no longer applies
  await client.query(
    `UPDATE crm_followup_reminders SET status = 'CANCELLED', cancel_reason = 'Follow-up changed'
      WHERE task_id = $1 AND status = 'PENDING'
        AND (due_at <> $2 OR user_id <> $3 OR NOT (offset_minutes = ANY($4::int[])) OR NOT (channel = ANY($5::text[])))`,
    [taskId, due, t.assignee_id, offsets, channels],
  );
  // a follow-up created with an older reminder time keeps no legacy reminder alongside these
  await client.query('UPDATE tasks SET reminder_at = NULL WHERE id = $1 AND reminder_sent_at IS NULL', [taskId]);
  const planned = [];
  for (const offset of offsets) {
    const remindAt = new Date(due.getTime() - offset * 60_000);
    const late = remindAt.getTime() < now.getTime() - 60_000;
    for (const channel of channels) {
      const { rows: r } = await client.query(
        `INSERT INTO crm_followup_reminders (task_id, user_id, due_at, offset_minutes, channel, remind_at, status, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (task_id, user_id, due_at, offset_minutes, channel) DO NOTHING RETURNING *`,
        [taskId, t.assignee_id, due, offset, channel, remindAt, late ? 'SKIPPED' : 'PENDING',
          late ? `The follow-up was set less than ${offset} minutes ahead` : null],
      );
      if (r[0]) planned.push(r[0]);
    }
  }
  return planned;
}

/** The reminders of one follow-up, newest plan first, with Chat delivery where it applies. */
export async function remindersFor(taskId) {
  const { rows } = await query(
    `SELECT r.*, o.status AS chat_status, o.last_error AS chat_error, o.sent_at AS chat_sent_at
       FROM crm_followup_reminders r LEFT JOIN chat_outbox o ON o.dedupe_key = r.outbox_key
      WHERE r.task_id = $1 ORDER BY r.due_at DESC, r.offset_minutes DESC, r.channel`,
    [taskId],
  );
  return rows;
}

const timeWords = (date, tz) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true, day: 'numeric', month: 'short' }).format(date);

/**
 * Sends the reminders that are due. Each is claimed first (SKIP LOCKED), then
 * checked against the follow-up as it stands: anything that changed is
 * cancelled, not sent. Returns what happened, for the worker's log.
 */
export async function sendDueReminders(now = new Date(), { limit = 200 } = {}) {
  const settings = await salesSettings();
  const tz = settings.calendar?.timezone || 'Asia/Kolkata';
  const chatAllowed = (await getSettings()).crmFollowUps?.chatReminders === true;
  const out = { sent: 0, failed: 0, cancelled: 0, skipped: 0 };
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE crm_followup_reminders r SET status = 'SENDING', attempts = attempts + 1
        WHERE r.id IN (SELECT id FROM crm_followup_reminders WHERE status = 'PENDING' AND remind_at <= $1
                        ORDER BY remind_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING r.*`,
      [now, limit],
    );
    for (const r of rows) {
      const { rows: tr } = await client.query(
        `SELECT t.id, t.title, t.followup_kind, t.assignee_id, t.due_date, t.completed_at, t.crm_cancel_reason, t.is_archived, t.snoozed_until,
                t.description, t.crm_lead_id, t.account_id, l.ref AS lead_ref, COALESCE(l.organization_name, l.contact_name, l.phone) AS lead_name, a.name AS account_name
           FROM tasks t LEFT JOIN crm_leads l ON l.id = t.crm_lead_id LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = $1`,
        [r.task_id],
      );
      const t = tr[0];
      const finish = async (status, error = null, extra = {}) => {
        await client.query(
          `UPDATE crm_followup_reminders SET status = $2, last_error = $3, sent_at = CASE WHEN $2 = 'SENT' THEN $4::timestamptz ELSE sent_at END,
                  outbox_key = COALESCE($5, outbox_key), cancel_reason = CASE WHEN $2 = 'CANCELLED' THEN $3 ELSE cancel_reason END
            WHERE id = $1`,
          [r.id, status, error, now, extra.outboxKey ?? null],
        );
        out[{ SENT: 'sent', FAILED: 'failed', CANCELLED: 'cancelled', SKIPPED: 'skipped' }[status]] += 1;
      };
      if (!t || t.completed_at || t.crm_cancel_reason || t.is_archived) { await finish('CANCELLED', 'Follow-up closed'); continue; }
      if (t.assignee_id !== r.user_id || new Date(t.due_date).getTime() !== new Date(r.due_at).getTime()) { await finish('CANCELLED', 'Follow-up changed'); continue; }
      if (new Date(t.due_date).getTime() <= now.getTime()) { await finish('SKIPPED', 'The follow-up time had passed before it could be sent; it shows as due instead'); continue; }
      if (t.snoozed_until && new Date(t.snoozed_until) > now) { await finish('SKIPPED', 'Snoozed'); continue; }
      const about = t.lead_name || t.account_name || 'a follow-up';
      const link = t.crm_lead_id ? `/sales/leads/${t.crm_lead_id}` : t.account_id ? `/accounts/${t.account_id}` : '/sales?tab=day';
      const title = `In ${r.offset_minutes} min: ${t.title}`;
      const body = `${about}${t.lead_ref ? ` (${t.lead_ref})` : ''} · due ${timeWords(new Date(t.due_date), tz)} ${tz === 'Asia/Kolkata' ? 'IST' : tz}`
        + `${t.description ? ` · ${String(t.description).slice(0, 160)}` : ''}`;
      if (r.channel === 'APP') {
        await notify(client, { userId: r.user_id, type: 'crm_reminder', title, body, taskId: t.id, leadId: t.crm_lead_id, accountId: t.account_id });
        await finish('SENT');
        continue;
      }
      // Google Chat: only when the organization allows it, and only to a linked direct message
      if (!chatAllowed) { await finish('SKIPPED', 'Chat reminders are switched off for the organization (Settings → Sales CRM → Follow-ups)'); continue; }
      const { rows: dm } = await client.query(`SELECT space_name FROM chat_spaces WHERE kind = 'DM' AND user_id = $1 AND active`, [r.user_id]);
      if (!dm[0]) { await finish('FAILED', 'Not linked to Google Chat yet: open TaskFlow in Chat and send it a message'); continue; }
      const key = `crm-reminder:${r.id}`;
      await client.query(
        `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload) VALUES ($1, $2, $3, 'CRM_REMINDER', $4)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [key, dm[0].space_name, r.user_id, JSON.stringify({ text: `⏰ *${title}*\n${body}\nOpen: ${config.publicUrl}${link}` })],
      );
      await finish('SENT', null, { outboxKey: key });
    }
  });
  return out;
}

/** The person saw it: their sent reminders for this follow-up are acknowledged. */
export async function acknowledgeReminders(taskId, userId) {
  const { rowCount } = await query(
    `UPDATE crm_followup_reminders SET acknowledged_at = now() WHERE task_id = $1 AND user_id = $2 AND status = 'SENT' AND acknowledged_at IS NULL`,
    [taskId, userId],
  );
  return rowCount;
}
