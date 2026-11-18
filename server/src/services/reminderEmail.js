/**
 * Reminder emails (docs/DEADLINES_REMINDERS.md, "Email"): the sender behind
 * email_outbox, what each email says, what comes back from the email service,
 * and the summaries by email.
 *
 *   - **Rendered when sent.** The outbox keeps what to say (reminder ids, or a
 *     summary's text), not the email. Each task is checked again at the last
 *     moment: one that was finished, handed over, re-dated or deferred in the
 *     meantime is left out (its reminder is cancelled), and an email with
 *     nothing left is not sent.
 *   - **Only a person's own login email.** Never a contact, lead or customer,
 *     and never an address that bounced.
 *   - **System email, not marketing.** The system sender from Settings →
 *     Email, reference `rem-<id>`, no unsubscribe link, no marketing footer,
 *     no marketing contact or figures.
 *   - **Retries** after 1, 5, 30 and 120 minutes, then FAILED. A reminder email
 *     that failed is followed by a notice to the fallback person, once.
 */
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { activeProvider } from './marketing/providers.js';
import { currentBranding } from './branding.js';
import { deadlineClock } from './deadlines.js';
import { weekdayOf } from '../../../shared/deadlineHealth.js';
import {
  TASK_FOR_REMINDERS, hhmm, notRemindable, planFallback, reminderSettings, reminderWords, taskUrl,
} from './taskReminders.js';
import {
  backlogReview, departmentSummary, firstWorkingDayOfWeek, logSummary, personalSummary, reachability,
} from './taskSummaries.js';
import { managedDepartmentIds } from './taskPeople.js';
import { channelPrefs, emailChannel, queueSummaryEmail, summaryChannels, summaryEmailUsable } from './reminderChannels.js';

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const RETRY_MINUTES = [1, 5, 30, 120];
const app = (path = '/') => `${config.publicUrl}${path}`;
// My account → My reminders, where each person changes how they hear
export const MY_REMINDERS_PATH = '/settings?tab=account#how-you-hear';

// ---------------------------------------------------------------- the words

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Chat text is escaped for Chat (&amp; &lt; &gt;); undone before escaping again for HTML
const unchat = (v) => String(v ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const LINK = /<([^|>\s]+)\|([^>]+)>/g;
const GREEN = '#073F2A';

/** One line of Chat markup (*bold*, _italic_, <url|label>) as HTML. */
function chatLineToHtml(line) {
  let out = '';
  let last = 0;
  const inline = (seg) => esc(unchat(seg))
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/g, '$1<em>$2</em>');
  for (const m of line.matchAll(LINK)) {
    out += inline(line.slice(last, m.index));
    out += `<a href="${esc(m[1])}" style="color:${GREEN}">${esc(unchat(m[2]))}</a>`;
    last = m.index + m[0].length;
  }
  return out + inline(line.slice(last));
}

/** Chat markup as plain text: links as "label (url)", no * or _ marks. */
export function chatToText(text) {
  return unchat(String(text || '')
    .replace(LINK, (_, url, label) => `${label} (${url})`)
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/g, '$1$2'));
}

/** Chat markup as HTML paragraphs, one per line; a bold line opens a section. */
export function chatToHtml(text) {
  return String(text || '').split('\n').map((line) => {
    if (!line.trim()) return '';
    const isHeading = /^\s*\*[^*]+\*(\s*\(\d+\))?\s*$/.test(line) || /^\s*\*[^*]+\(\d+\)\*\s*$/.test(line);
    const style = isHeading
      ? 'margin:18px 0 6px;font-size:15px;line-height:1.4;color:#111827'
      : `margin:0 0 6px;font-size:14px;line-height:1.5;color:#1f2933${/^\s+/.test(line) ? ';padding-left:14px;color:#52606d' : ''}`;
    return `<p style="${style}">${chatLineToHtml(line.trim())}</p>`;
  }).filter(Boolean).join('\n');
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const leftWords = (ms) => {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 90) return plural(min, 'minute');
  if (min < 48 * 60) return plural(Math.round(min / 60), 'hour');
  return plural(Math.round(min / 1440), 'day');
};
const overdueWords = (ms) => {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return hours < 48 ? `Overdue by ${plural(hours, 'hour')}` : `Overdue by ${plural(Math.round(hours / 24), 'day')}`;
};

/** The subject for one reminder: what, and which task. Never anything secret. */
export function reminderSubject(r, task, now) {
  const name = `${task.ref || `#${task.id}`} ${task.title}`;
  const owner = task.owner_name || 'no owner';
  switch (r.kind) {
    case 'BEFORE_DUE': return `Due in ${leftWords(new Date(task.due_date).getTime() - now.getTime())}: ${name}`;
    case 'AT_DUE': return `Due now: ${name}`;
    case 'AFTER_GRACE': return `Overdue, ${owner}'s task: ${name}`;
    case 'COVER': return `Covering for ${owner}: ${name}`;
    case 'UNREACHED': return `Could not reach ${owner}: ${name}`;
    default: return name;
  }
}

/** Why this person got it, for the footer. */
function footerWhy(items) {
  const own = items.every((i) => i.role === 'OWNER');
  const one = items.length === 1;
  if (own) return one ? 'You get this because you own this task in TaskFlow.' : 'You get this because you own these tasks in TaskFlow.';
  const owners = [...new Set(items.filter((i) => i.role !== 'OWNER').map((i) => i.ownerName || 'its owner'))];
  return `You get this because you are the fallback person for ${owners.join(', ')} in TaskFlow${items.some((i) => i.role === 'OWNER') ? ', or you own the task' : ''}.`;
}

/**
 * The email around the content, readable on a phone: the TaskFlow name from
 * Branding, a heading, the content, a button, and a footer saying why the
 * person gets it and where to change it. No unsubscribe link, no marketing
 * footer: this is a work reminder, changed in My reminders.
 */
export async function renderShell({ subject, heading, intro = null, cards = [], bodyHtml = '', bodyText = '', button = null, why, label = null }) {
  const branding = await currentBranding();
  const appName = branding.appName || 'TaskFlow';
  const whyText = String(why || '').replace(/TaskFlow/g, appName);
  const prefsUrl = app(MY_REMINDERS_PATH);
  const card = (c) => `<tr><td style="padding:14px 16px;border:1px solid #dfe6e2;border-radius:10px;background:#fbfdfc">
<p style="margin:0 0 8px;font-size:15px;line-height:1.35;font-weight:700;color:#111827">${esc(c.title)}</p>
${c.lines.map((l) => `<p style="margin:0 0 4px;font-size:14px;line-height:1.45;color:#1f2933">${esc(l)}</p>`).join('\n')}
${c.url ? `<p style="margin:10px 0 0"><a href="${esc(c.url)}" style="display:inline-block;background:${GREEN};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:9px 16px;border-radius:8px">${esc(c.button || 'Open the task')}</a></p>
<p style="margin:6px 0 0;font-size:12px;color:#52606d;word-break:break-all">${esc(c.url)}</p>` : ''}
</td></tr><tr><td style="height:10px;line-height:10px">&nbsp;</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<tr><td style="background:${GREEN};padding:16px 24px;color:#ffffff;font-size:17px;font-weight:700">${esc(appName)}${label ? ` <span style="font-weight:700;font-size:12px;background:#ffffff;color:${GREEN};border-radius:4px;padding:2px 6px;margin-left:6px">${esc(label)}</span>` : ''}</td></tr>
<tr><td style="padding:22px 24px">
<h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:#111827">${esc(heading)}</h1>
${intro ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#1f2933">${esc(intro)}</p>` : ''}
${cards.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards.map(card).join('\n')}</table>` : ''}
${bodyHtml}
${button ? `<p style="margin:18px 0 0"><a href="${esc(button.url)}" style="display:inline-block;background:${GREEN};color:#ffffff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px">${esc(button.label)}</a></p>` : ''}
<hr style="border:none;border-top:1px solid #e4e9e6;margin:22px 0 14px">
<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#52606d">${esc(whyText)}</p>
<p style="margin:0 0 6px;font-size:12px;line-height:1.5"><a href="${esc(prefsUrl)}" style="color:${GREEN}">Change how you get reminders</a></p>
<p style="margin:0;font-size:12px;color:#7b8794">${esc(appName)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    label ? `[${label}] ${heading}` : heading,
    '',
    ...(intro ? [intro, ''] : []),
    ...cards.flatMap((c) => [c.title, ...c.lines, ...(c.url ? [`${c.button || 'Open the task'}: ${c.url}`] : []), '']),
    ...(bodyText ? [bodyText, ''] : []),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    '--',
    whyText,
    `Change how you get reminders: ${prefsUrl}`,
    appName,
  ].join('\n');
  return { subject, html, text };
}

/** One task reminder as a card: the same facts as the Chat message. */
export function reminderCard(r, task, c, { test = false } = {}) {
  const words = reminderWords({ ...r, reason_note: r.reason }, task, c, { test });
  const lines = words.body.split('\n').filter(Boolean);
  if (r.kind === 'AFTER_GRACE' && task.due_date) {
    lines.splice(1, 0, `${overdueWords(c.now.getTime() - new Date(task.due_date).getTime())}; owned by ${task.owner_name || 'nobody'}.`);
  }
  return {
    subject: `${test ? 'TEST · ' : ''}${reminderSubject(r, task, c.now)}`,
    title: reminderSubject(r, task, c.now),
    lines,
    url: taskUrl(task.id),
    button: 'Open the task',
    role: r.role,
    ownerName: task.owner_name,
  };
}

/** A reminder email for one or more tasks. */
export async function renderReminderEmail(cards, { test = false, label = null } = {}) {
  const one = cards.length === 1;
  const subject = one ? cards[0].subject : `${test ? 'TEST · ' : ''}${cards.length} task reminders: ${cards[0].title}${cards.length > 1 ? ` and ${cards.length - 1} more` : ''}`;
  return renderShell({
    subject,
    heading: one ? cards[0].title : `${cards.length} tasks need you`,
    cards: one ? [{ ...cards[0], title: cards[0].title }] : cards,
    why: footerWhy(cards),
    label: label || (test ? 'TEST' : null),
  });
}

/** A summary (Chat markup) as an email, with an "Open My tasks" button. */
export async function renderSummaryEmail(p) {
  const lines = String(p.text || '').split('\n');
  // the summary's first line is its heading ("Good morning, …")
  const heading = chatToText(lines[0]).trim();
  const rest = lines.slice(1).join('\n');
  return renderShell({
    subject: p.subject,
    heading,
    bodyHtml: chatToHtml(rest),
    bodyText: chatToText(rest).trim(),
    button: p.button || { label: 'Open My tasks', url: app('/my-tasks') },
    why: p.why || 'You get this because you have work in TaskFlow.',
    label: p.test ? 'TEST' : null,
  });
}

/** The subject of a personal summary: "Your TaskFlow day: 3 overdue, 2 due today", or "all clear". */
export function summarySubject(appName, summary) {
  const counts = summary?.counts || {};
  const parts = [counts.overdue && `${counts.overdue} overdue`, counts.today && `${counts.today} due today`].filter(Boolean);
  if (parts.length) return `Your ${appName} day: ${parts.join(', ')}`;
  return summary?.allClear ? `Your ${appName} day: all clear` : `Your ${appName} day: nothing due today`;
}

// ---------------------------------------------------------------- the sender

async function finishRow(id, fields) {
  await query(
    `UPDATE email_outbox SET status = $2, last_error = $3, subject = COALESCE($4, subject),
            provider_message_id = COALESCE($5, provider_message_id), sent_at = CASE WHEN $2 = 'SENT' THEN $6::timestamptz ELSE sent_at END,
            attempts = attempts + $7, next_attempt_at = COALESCE($8, next_attempt_at), to_address = COALESCE($9, to_address), updated_at = now()
      WHERE id = $1`,
    [id, fields.status, fields.error ?? null, fields.subject ?? null, fields.providerMessageId ?? null, fields.now ?? new Date(),
      fields.attempted ? 1 : 0, fields.nextAt ?? null, fields.address ?? null],
  );
}

/**
 * What a reminder email still has to say: each reminder whose task still
 * needs it. The others are cancelled with the reason, so the log never says
 * an email reminded someone about a task it left out.
 */
async function reminderCards(row, c) {
  const items = row.payload?.items || [];
  const test = items.some((i) => i.test);
  const ids = items.map((i) => Number(i.reminderId)).filter(Boolean);
  const { rows: rems } = await query('SELECT * FROM task_reminders WHERE id = ANY($1::bigint[]) ORDER BY remind_at, id', [ids]);
  const cards = [];
  for (const r of rems) {
    if (r.outbox_key !== row.dedupe_key || r.status !== 'SENT') continue;
    const { rows: tr } = await query(`${TASK_FOR_REMINDERS} WHERE t.id = $1`, [r.task_id]);
    const t = tr[0];
    let why = notRemindable(t);
    // a notice about an owner whose account was switched off still goes to their fallback person
    if (why && r.role === 'FALLBACK' && t && !t.owner_active && !t.is_archived && !['done', 'cancelled'].includes(t.stage)) why = null;
    if (!why && r.role === 'OWNER' && t.assignee_id !== r.user_id) why = 'The task was handed to someone else';
    if (!why && new Date(t.due_date).getTime() !== new Date(r.due_at).getTime()) why = 'The deadline changed';
    if (why) {
      await query(`UPDATE task_reminders SET status = 'CANCELLED', reason = $2, updated_at = now() WHERE id = $1`, [r.id, `${why} before the email went`]);
      continue;
    }
    cards.push(reminderCard(r, t, c, { test }));
  }
  return { cards, test };
}

/**
 * Sends what is due in email_outbox: at most `limit` a pass, so a big morning
 * never overruns the email service. Each row is claimed first (its next
 * attempt pushed 10 minutes out), so two servers never send the same email.
 */
export async function sendEmailOutbox(now = new Date(), { limit = 50, onlyIds = null } = {}) {
  const { rows } = await query(
    `UPDATE email_outbox SET next_attempt_at = $1::timestamptz + interval '10 minutes', updated_at = now()
      WHERE id IN (SELECT id FROM email_outbox
                    WHERE status = 'PENDING' AND hold_until <= $1 AND next_attempt_at <= $1
                      AND ($3::bigint[] IS NULL OR id = ANY($3::bigint[]))
                    ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [now, limit, onlyIds],
  );
  const out = { sent: 0, failed: 0, retrying: 0, cancelled: 0 };
  if (!rows.length) return out;
  const settings = await getSettings();
  const s = await reminderSettings(settings);
  const channel = s.email;
  const c = await deadlineClock(now, settings);
  for (const row of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
    const cancel = async (why) => { await finishRow(row.id, { status: 'CANCELLED', error: why, now }); out.cancelled += 1; };
    if (!channel.ready) { await cancel(`Email is not set up (${channel.reason})`); continue; }
    if (['REMINDER', 'SUMMARY'].includes(row.kind) && s.mode === 'OFF') { await cancel('Task reminders are switched off'); continue; }
    const { rows: [user] } = await query(
      'SELECT id, full_name, email, is_active, email_undeliverable_at, email_undeliverable_reason FROM users WHERE id = $1',
      [row.user_id],
    );
    if (!user || !user.is_active) { await cancel('Their account is switched off'); continue; }
    if (user.email_undeliverable_at) { await cancel(`Their email address bounced (${user.email_undeliverable_reason || 'undeliverable'})`); continue; }
    // always their own login email as it is now
    const address = String(user.email || '').trim();
    if (!EMAIL_RE.test(address)) { await cancel('Their account has no valid email address'); continue; }

    let content;
    try {
      if (row.kind === 'REMINDER') {
        const { cards, test } = await reminderCards(row, c);
        if (!cards.length) { await cancel('Every task in it was finished or changed before it went'); continue; }
        content = await renderReminderEmail(cards, { test });
      } else if (row.kind === 'SUMMARY') {
        content = await renderSummaryEmail(row.payload || {});
      } else {
        // sales follow-ups and workspace reminders: words prepared when queued
        const p = row.payload || {};
        const cards = (p.items || []).map((i) => ({ ...i, lines: i.lines || [] }));
        if (!cards.length) { await cancel('Nothing left to remind about'); continue; }
        content = await renderShell({
          subject: cards.length === 1 ? cards[0].subject || cards[0].title : `${cards.length} reminders: ${cards[0].title} and ${cards.length - 1} more`,
          heading: cards.length === 1 ? cards[0].title : `${cards.length} reminders`,
          cards,
          why: p.why || 'You get this because you asked for these reminders by email in TaskFlow.',
          label: p.test || cards.some((i) => i.test) ? 'TEST' : null,
        });
      }
    } catch (err) {
      console.error(`[taskflow] reminder email ${row.id}: could not prepare it:`, err.message);
      await finishRow(row.id, { status: 'FAILED', error: `Could not prepare the email: ${String(err.message).slice(0, 200)}`, now });
      out.failed += 1;
      continue;
    }

    const { settings: sender } = channel.readiness;
    try {
      const { providerMessageId } = await activeProvider().send({
        from: sender.senderEmail,
        fromName: sender.senderName,
        to: address,
        toName: user.full_name || undefined,
        replyTo: sender.replyTo || undefined,
        subject: content.subject,
        html: content.html,
        text: content.text,
        // "rem-" keeps these out of the marketing outbox, events and figures
        reference: `rem-${row.id}`,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-TaskFlow-Kind': `reminder-${row.kind.toLowerCase()}` },
        system: true,
      });
      await finishRow(row.id, { status: 'SENT', subject: content.subject, providerMessageId, now, attempted: true, address });
      out.sent += 1;
    } catch (err) {
      const attempts = Number(row.attempts) + 1;
      const permanent = err?.transient === false;
      const giveUp = permanent || attempts > RETRY_MINUTES.length;
      const error = String(err?.message || err || 'The email service refused it').replace(/\s+/g, ' ').slice(0, 300);
      await finishRow(row.id, {
        status: giveUp ? 'FAILED' : 'PENDING',
        error,
        subject: content.subject,
        now,
        attempted: true,
        nextAt: giveUp ? null : new Date(now.getTime() + RETRY_MINUTES[attempts - 1] * 60_000),
        address,
      });
      out[giveUp ? 'failed' : 'retrying'] += 1;
    }
  }
  return out;
}

/**
 * A reminder email the outbox gave up on: the fallback person is told, once
 * (as for a Chat message that could not be delivered). The bell copy did
 * arrive.
 */
export async function followUpFailedEmails(now = new Date()) {
  const { rows } = await query(
    `SELECT r.*, e.last_error FROM task_reminders r JOIN email_outbox e ON e.dedupe_key = r.outbox_key
      WHERE r.channel = 'EMAIL' AND r.role = 'OWNER' AND r.status = 'SENT' AND e.status = 'FAILED'
        AND r.remind_at > $1::timestamptz - interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM task_reminders u WHERE u.task_id = r.task_id AND u.kind = 'UNREACHED' AND u.due_at = r.due_at)`,
    [now],
  );
  let told = 0;
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(`${r.task_id}:${r.due_at}`)) continue;
    seen.add(`${r.task_id}:${r.due_at}`);
    await withTransaction(async (client) => {
      const { rows: tr } = await client.query(`${TASK_FOR_REMINDERS} WHERE t.id = $1`, [r.task_id]);
      if (!tr[0] || notRemindable(tr[0])) return;
      told += await planFallback(client, tr[0], 'UNREACHED', `Email: ${String(r.last_error || 'delivery failed').slice(0, 150)}`, now);
    });
  }
  return { told };
}

// ---------------------------------------------------------------- what comes back

async function notifyUndeliverable(user, reason) {
  const branding = await currentBranding();
  const appName = branding.appName || 'TaskFlow';
  await query(
    `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'email_undeliverable', $2, $3)`,
    [user.id, 'Reminder emails to you have stopped',
      `Emails to ${user.email} could not be delivered (${reason}). Your reminders still come to the ${appName} bell, and to Google Chat if it is connected. Once your address is fixed, an administrator can clear this on the Team page.`],
  );
  const { rows: admins } = await query(
    `SELECT id FROM users WHERE is_active AND role IN ('admin', 'super_admin') AND id <> $1`,
    [user.id],
  );
  for (const a of admins) {
    await query(
      `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'email_undeliverable', $2, $3)`,
      [a.id, `Emails to ${user.full_name} bounce`,
        `Reminder emails to ${user.email} stopped: ${reason}. Check the address, then clear the mark on the Team page (Edit → Sign-in and email).`],
    );
  }
}

/** Marks a person's address undeliverable (once) and tells them and the administrators. */
export async function markUndeliverable(userId, reason, at = new Date()) {
  const { rows } = await query(
    `UPDATE users SET email_undeliverable_at = $2, email_undeliverable_reason = $3
      WHERE id = $1 AND email_undeliverable_at IS NULL RETURNING id, full_name, email`,
    [userId, at, String(reason).slice(0, 200)],
  );
  if (rows[0]) await notifyUndeliverable(rows[0], reason);
  return Boolean(rows[0]);
}

/**
 * A delivery report for a system email (an account email `acct-…` or a
 * reminder email `rem-…`). Never a marketing event. A hard bounce or a
 * complaint marks the address undeliverable; soft bounces (and rejections)
 * count, and three in a row count as hard; a delivery resets the count.
 * Only the person's current address is affected.
 */
export async function recordSystemEmailEvent(input) {
  const ref = String(input.reference || '');
  let userId = null;
  const rem = /^rem-(\d+)$/.exec(ref);
  if (rem) userId = (await query('SELECT user_id FROM email_outbox WHERE id = $1', [Number(rem[1])])).rows[0]?.user_id ?? null;
  if (!userId && input.providerMessageId) {
    userId = (await query('SELECT user_id FROM email_outbox WHERE provider_message_id = $1 ORDER BY id DESC LIMIT 1', [input.providerMessageId])).rows[0]?.user_id
      ?? (await query('SELECT user_id FROM account_emails WHERE provider_message_id = $1 ORDER BY id DESC LIMIT 1', [input.providerMessageId])).rows[0]?.user_id
      ?? null;
  }
  if (!userId && input.email) {
    userId = (await query('SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1', [String(input.email).trim()])).rows[0]?.id ?? null;
  }
  const { rows: inserted } = await query(
    `INSERT INTO system_email_events (provider_event_id, reference, user_id, type, email, diagnostic, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
    [input.providerEventId || null, ref || null, userId, input.type, input.email || null,
      input.diagnostic ? String(input.diagnostic).slice(0, 300) : null, input.occurredAt ? new Date(input.occurredAt) : new Date()],
  );
  if (!inserted[0]) return { recorded: false, duplicate: true, system: true };
  if (!userId) return { recorded: true, system: true, effect: null };
  const { rows: [user] } = await query('SELECT id, email FROM users WHERE id = $1', [userId]);
  // a report about an address the person no longer uses changes nothing
  if (!user || (input.email && String(input.email).trim().toLowerCase() !== String(user.email).trim().toLowerCase())) {
    return { recorded: true, system: true, effect: 'old_address' };
  }
  const detail = input.diagnostic ? `: ${String(input.diagnostic).slice(0, 120)}` : '';
  switch (input.type) {
    case 'BOUNCE_HARD':
      return { recorded: true, system: true, effect: (await markUndeliverable(user.id, `the address bounced${detail}`)) ? 'undeliverable' : 'already' };
    case 'COMPLAINT':
      return { recorded: true, system: true, effect: (await markUndeliverable(user.id, 'it was reported as spam')) ? 'undeliverable' : 'already' };
    case 'BOUNCE_SOFT':
    case 'REJECTED': {
      const { rows: [u] } = await query('UPDATE users SET email_soft_bounces = email_soft_bounces + 1 WHERE id = $1 RETURNING email_soft_bounces', [user.id]);
      if (u.email_soft_bounces >= 3) {
        await markUndeliverable(user.id, `three deliveries in a row failed${detail}`);
        return { recorded: true, system: true, effect: 'undeliverable' };
      }
      return { recorded: true, system: true, effect: 'counted' };
    }
    case 'DELIVERED':
      await query('UPDATE users SET email_soft_bounces = 0 WHERE id = $1 AND email_soft_bounces <> 0', [user.id]);
      return { recorded: true, system: true, effect: 'delivered' };
    default:
      return { recorded: true, system: true, effect: null };
  }
}

/** An administrator cleared the mark after the address was fixed: reminder emails resume. */
export async function clearUndeliverable(userId) {
  const { rows } = await query(
    `UPDATE users SET email_undeliverable_at = NULL, email_undeliverable_reason = NULL, email_soft_bounces = 0
      WHERE id = $1 RETURNING id, email_undeliverable_at`,
    [userId],
  );
  return Boolean(rows[0]);
}

// ---------------------------------------------------------------- summaries by email

const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
// people Chat reaches never get an email row, so the full look at everyone is
// made at most every 10 minutes a day, not every minute of the worker
const EVERY_MS = 10 * 60_000;
let lastLook = { date: null, at: 0 };
export const resetSummaryLook = () => { lastLook = { date: null, at: 0 }; };

/** Who switched the Chat morning summary off (before choosing anything here). */
async function chatSummaryOff(ids) {
  if (!ids.length) return new Set();
  const { rows } = await query('SELECT user_id FROM chat_preferences WHERE morning_summary = FALSE AND user_id = ANY($1::int[])', [ids]);
  return new Set(rows.map((r) => r.user_id));
}

/**
 * The morning summary, the weekly backlog review and (when the organisation
 * turns it on) the team summary to managers, by email: once a person a day,
 * logged in reminder_summary_log with channel EMAIL. By default only to people
 * Chat cannot reach. They follow the reminders' mode: nothing when OFF, only
 * the test administrator's in TEST (everyone else's "would send"). Nothing is
 * queued, or logged, while email is not set up.
 */
export async function queueEmailSummaries(now = new Date()) {
  const settings = await getSettings();
  const s = await reminderSettings(settings);
  if (s.mode === 'OFF') return { queued: 0, why: 'Task reminders are switched off' };
  if (!s.email.ready) return { queued: 0, why: s.email.reason };
  const c = await deadlineClock(now, settings);
  const today = c.today;
  const workingDays = settings.organisation?.workingDays || [1, 2, 3, 4, 5, 6];
  if (!workingDays.includes(weekdayOf(today))) return { queued: 0 };
  const local = hhmm(now, c.timezone);
  const personalAt = settings.googleChat?.morningSummaryTime || '09:00';
  const teamAt = settings.googleChat?.teamSummaryTime || '09:15';
  if (local < personalAt) return { queued: 0 };
  if (lastLook.date === today && now.getTime() - lastLook.at >= 0 && now.getTime() - lastLook.at < EVERY_MS) return { queued: 0, waited: true };
  lastLook = { date: today, at: now.getTime() };
  const branding = await currentBranding();
  const appName = branding.appName || 'TaskFlow';
  const late = minutes(local) - minutes(personalAt) > 60;
  const lateLine = (text) => (late ? `${text}\n\n_Sent late: ${appName} could not send it at ${personalAt}._` : text);
  const tooLate = local >= s.catchUpUntil;
  let queued = 0;
  const backlogDay = s.weeklyBacklog && firstWorkingDayOfWeek(today, workingDays);

  const { rows: due } = await query(
    `SELECT u.id FROM users u WHERE u.is_active
        AND (NOT EXISTS (SELECT 1 FROM reminder_summary_log g WHERE g.log_key = 'personal-email:' || u.id || ':' || $1)
             OR ($2 AND NOT EXISTS (SELECT 1 FROM reminder_summary_log g WHERE g.log_key = 'backlog-email:' || u.id || ':' || $1)))`,
    [today, backlogDay],
  );
  if (due.length) {
    const ids = due.map((u) => u.id);
    const prefs = await channelPrefs(ids, { query }, settings);
    const off = await chatSummaryOff(ids);
    const { people, covers } = await reachability(now, { s });
    const { rows: logged } = await query(
      `SELECT log_key FROM reminder_summary_log WHERE summary_date = $1 AND channel = 'EMAIL' AND user_id = ANY($2::int[])`,
      [today, ids],
    );
    const has = new Set(logged.map((r) => r.log_key));
    for (const u of due) {
      const p = people.get(u.id);
      const pref = prefs.get(u.id);
      if (!p || !pref) continue;
      const chatOk = Boolean(p.route?.ok && p.route.morningSummary);
      const usable = summaryEmailUsable(pref, { channel: s.email, chatSummaryOff: off.has(u.id) });
      if (!summaryChannels(pref.summaries, { chatOk, emailUsable: usable }).email) continue;
      const test = s.mode === 'TEST';
      const forTest = test && Number(s.testRecipientId) !== u.id;
      const jobs = [
        { kind: 'PERSONAL', key: `personal-email:${u.id}:${today}` },
        ...(backlogDay ? [{ kind: 'BACKLOG_WEEKLY', key: `backlog-email:${u.id}:${today}` }] : []),
      ].filter((j) => !has.has(j.key));
      for (const job of jobs) {
        const base = { key: job.key, kind: job.kind, userId: u.id, date: today, channel: 'EMAIL', late };
        if (tooLate) {
          await logSummary({ ...base, status: 'SKIPPED', reason: `Missed: ${appName} could not send it between ${personalAt} and ${s.catchUpUntil}` });
          continue;
        }
        if (p.unreachable?.away) { await logSummary({ ...base, status: 'SKIPPED', reason: `Away: ${p.unreachable.why}` }); continue; }
        let content = null;
        if (job.kind === 'PERSONAL') {
          let summary = await personalSummary(u.id, { now, c, covering: covers.get(u.id) || [] });
          if (!summary && pref.summaryAllClear) summary = { ...(await personalSummary(u.id, { now, c, force: true })), allClear: true };
          if (!summary) { await logSummary({ ...base, status: 'SKIPPED', reason: 'Nothing to say: no open work and nothing waiting (an all-clear email only when asked for)' }); continue; }
          content = {
            summary,
            payload: {
              subject: `${test ? 'TEST · ' : ''}${summarySubject(appName, summary)}`,
              text: lateLine(summary.text),
              why: 'You get this because you have work in TaskFlow, and Google Chat does not carry your morning summary.',
              test,
            },
          };
          if (chatOk) content.payload.why = 'You get this because you asked for your morning summary by email as well as in Google Chat.';
        } else {
          const review = await backlogReview(u.id, { now, c });
          if (!review) { await logSummary({ ...base, status: 'SKIPPED', reason: 'Nothing in Backlog' }); continue; }
          content = {
            summary: review,
            payload: {
              subject: `${test ? 'TEST · ' : ''}Your ${appName} backlog review for the week`,
              text: review.text,
              button: { label: 'Open the Backlog', url: app(`/board?stage=backlog&assignee_id=${u.id}`) },
              why: 'You get this because you have Backlog or deferred work in TaskFlow.',
              test,
            },
          };
        }
        const extra = { items: content.summary.items, taskIds: content.summary.task_ids, covering: content.summary.covering_user_ids || [] };
        if (forTest) { await logSummary({ ...base, ...extra, status: 'WOULD_SEND', reason: 'Test mode: would have been emailed' }); continue; }
        const outboxKey = `email:summary:${job.key}`;
        await queueSummaryEmail({ query }, { key: outboxKey, userId: u.id, address: pref.email, payload: content.payload, now });
        if (await logSummary({ ...base, ...extra, status: 'EMAILED', outboxKey })) queued += 1;
      }
    }
  }

  // the team summary to each department's managers, only when the organisation turns it on
  if (s.email.teamSummary && local >= teamAt && local < s.catchUpUntil) {
    const { rows: managers } = await query(`SELECT id, full_name, role, extra_permissions, revoked_permissions, department_id, email FROM users WHERE is_active AND role IN ('admin', 'manager')`);
    const prefs = await channelPrefs(managers.map((m) => m.id), { query }, settings);
    const { people } = managers.length ? await reachability(now, { s }) : { people: new Map() };
    for (const m of managers) {
      const pref = prefs.get(m.id);
      if (!pref || pref.undeliverable || pref.summaries === 'BELL') continue;
      if (people.get(m.id)?.unreachable?.away) continue;
      for (const deptId of await managedDepartmentIds(m)) {
        const key = `department-email:${m.id}:${deptId}:${today}`;
        const base = { key, kind: 'DEPARTMENT', userId: m.id, departmentId: deptId, date: today, channel: 'EMAIL', late: minutes(local) - minutes(teamAt) > 60 };
        const { rows: done } = await query('SELECT 1 FROM reminder_summary_log WHERE log_key = $1', [key]);
        if (done.length) continue;
        const summary = await departmentSummary(deptId, { now, c });
        if (!summary) continue;
        const test = s.mode === 'TEST';
        if (test && Number(s.testRecipientId) !== m.id) { await logSummary({ ...base, status: 'WOULD_SEND', reason: 'Test mode: would have been emailed', items: summary.items, taskIds: summary.task_ids }); continue; }
        const outboxKey = `email:summary:${key}`;
        const head = chatToText(summary.text.split('\n')[0]).trim();
        await queueSummaryEmail({ query }, {
          key: outboxKey, userId: m.id, address: pref.email, now,
          payload: {
            subject: `${test ? 'TEST · ' : ''}${head}`,
            text: summary.text,
            button: { label: 'Open the board', url: app(`/board?department_id=${deptId}`) },
            why: 'You get this because you manage this department in TaskFlow, and the team summary by email is switched on.',
            test,
          },
        });
        if (await logSummary({ ...base, status: 'EMAILED', outboxKey, items: summary.items, taskIds: summary.task_ids })) queued += 1;
      }
    }
  }
  return { queued };
}

// ---------------------------------------------------------------- a sample

/**
 * "Send me a sample reminder email": to the person's own address only,
 * marked SAMPLE, for one of their open tasks (or a made-up one). Not a
 * reminder: nothing is logged against a task and it does not count towards
 * the daily limit.
 */
export async function sendSampleEmail(user) {
  const s = await reminderSettings();
  if (!s.email.ready) return { sent: false, reason: s.email.reason };
  if (user.email_undeliverable_at) return { sent: false, reason: 'Your email address bounced; an administrator can clear the mark once it is fixed' };
  const c = await deadlineClock(new Date());
  const { rows } = await query(
    `${TASK_FOR_REMINDERS} WHERE t.assignee_id = $1 AND t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled') AND t.due_date IS NOT NULL
      ORDER BY t.due_date LIMIT 1`,
    [user.id],
  );
  const task = rows[0] || {
    id: 0, ref: 'TF-0', title: 'Sample task', due_date: new Date(c.now.getTime() + 2 * 3_600_000).toISOString(),
    owner_name: user.full_name, stage: 'in_progress', status_name: 'In progress', next_action: 'Finish the first draft',
  };
  const card = reminderCard({ kind: 'BEFORE_DUE', role: 'OWNER' }, task, c);
  const content = await renderReminderEmail([{ ...card, subject: `SAMPLE · ${card.subject}` }], { label: 'SAMPLE' });
  const { settings: sender } = s.email.readiness;
  try {
    const { providerMessageId } = await activeProvider().send({
      from: sender.senderEmail,
      fromName: sender.senderName,
      to: user.email,
      toName: user.full_name || undefined,
      replyTo: sender.replyTo || undefined,
      subject: content.subject,
      html: content.html,
      text: content.text,
      reference: `rem-sample-${user.id}-${Date.now()}`,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-TaskFlow-Kind': 'reminder-sample' },
      system: true,
    });
    return { sent: true, to: user.email, subject: content.subject, providerMessageId };
  } catch (err) {
    return { sent: false, reason: String(err?.message || err).slice(0, 300) };
  }
}
