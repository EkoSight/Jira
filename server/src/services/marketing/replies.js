/**
 * Replies to marketing emails.
 *
 * A reply is matched to the email it answers, most certain first:
 *   1. the code in the Reply-To address (reply+<code>@…), when plus addressing is on;
 *   2. the In-Reply-To / References headers naming the message we sent;
 *   3. the sender's address and a "Re:" of the subject, within 30 days.
 * Automatic replies (out of office, delivery notices) are not counted. A reply
 * that only says "unsubscribe" or "stop" is treated as an unsubscribe.
 *
 * Read from the reply mailbox through Google Workspace (the service account
 * already used for Google Chat, with gmail.readonly granted for that one
 * mailbox), or posted by an inbound mail service.
 */

import { query, withTransaction } from '../../db/pool.js';
import { chatConfig, workspaceApi } from '../../lib/googleChat.js';
import { marketingSettings, normalizeEmail } from './core.js';
import { unsubscribe } from './audiences.js';
import { recordEvent } from './events.js';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const CODE = /\+([0-9a-f]{16})@/i;
const STOP_WORDS = /^\s*(unsubscribe|stop|remove me|please remove|सदस्यता समाप्त|बंद करें)\b/i;

const header = (headers, name) => {
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) return headers.find((h) => String(h.name || h.Name).toLowerCase() === wanted)?.value
    ?? headers.find((h) => String(h.name || h.Name).toLowerCase() === wanted)?.Value ?? null;
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === wanted) return v;
  return null;
};

const addressOf = (value) => {
  const m = String(value || '').match(/<([^>]+)>/);
  return normalizeEmail(m ? m[1] : String(value || '').split(',')[0]);
};

/** Whether a message is an automatic reply rather than a person writing. */
export function isAutomaticReply({ headers = {}, subject = '', from = '' }) {
  const auto = String(header(headers, 'Auto-Submitted') || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (header(headers, 'X-Autoreply') || header(headers, 'X-Autorespond')) return true;
  if (/^(auto_reply|bulk|junk|list)$/i.test(String(header(headers, 'Precedence') || '').trim())) return true;
  if (/^(mailer-daemon|postmaster|no-?reply)@/i.test(addressOf(from))) return true;
  return /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status notification|अनुपस्थित)/i.test(String(subject).trim());
}

/** The message a reply answers, or null. */
export async function matchReply({ to = [], from = '', subject = '', inReplyTo = '', references = '' }) {
  for (const address of [].concat(to).filter(Boolean)) {
    const m = String(address).match(CODE);
    if (m) {
      const { rows } = await query('SELECT * FROM mkt_messages WHERE reply_code = $1', [m[1].toLowerCase()]);
      if (rows[0]) return { message: rows[0], how: 'REPLY_CODE' };
    }
  }
  const ids = `${inReplyTo || ''} ${references || ''}`.match(/<[^>]+>/g) || [];
  for (const raw of ids.reverse()) {
    const id = raw.slice(1, -1);
    const { rows } = await query(
      `SELECT * FROM mkt_messages WHERE provider_message_id = $1 OR provider_message_id = split_part($1, '@', 1) ORDER BY id DESC LIMIT 1`,
      [id],
    );
    if (rows[0]) return { message: rows[0], how: 'THREAD' };
  }
  const sender = addressOf(from);
  const topic = String(subject || '').replace(/^\s*((re|fw|fwd|aw|sv|उत्तर)\s*:\s*)+/i, '').trim();
  if (sender && topic && /^\s*(re|aw|sv)\s*:/i.test(subject)) {
    const { rows } = await query(
      `SELECT * FROM mkt_messages
        WHERE lower(email) = $1 AND sent_at > now() - interval '30 days' AND kind IN ('CAMPAIGN', 'AUTOMATION')
          AND (subject = $2 OR $2 LIKE subject || '%')
        ORDER BY sent_at DESC LIMIT 1`,
      [sender, topic],
    );
    if (rows[0]) return { message: rows[0], how: 'SUBJECT' };
  }
  return null;
}

/**
 * One reply, from wherever it was read. Returns what was done:
 * { matched, recorded, duplicate, unsubscribed, automatic }.
 */
export async function handleReply({ id, to, from, subject, inReplyTo, references, text = '', headers = {}, receivedAt = null, source = 'MAILBOX' }) {
  if (isAutomaticReply({ headers, subject, from })) return { matched: false, automatic: true };
  const match = await matchReply({ to, from, subject, inReplyTo, references });
  if (!match) return { matched: false };
  const { message } = match;
  // only the person it was sent to counts; a forward from someone else does not
  if (addressOf(from) && normalizeEmail(message.email) !== addressOf(from) && match.how !== 'REPLY_CODE') return { matched: false };
  const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const outcome = await recordEvent({
    type: 'REPLY', messageId: message.id, source, occurredAt: receivedAt,
    providerEventId: id ? `reply:${source}:${id}` : null,
    meta: { snippet, matched_by: match.how, from: addressOf(from), subject: String(subject || '').slice(0, 200) },
  });
  let unsubscribed = false;
  if (outcome.recorded && message.contact_id && STOP_WORDS.test(snippet)) {
    await withTransaction(async (client) => {
      await unsubscribe(client, message.contact_id, { all: true, source: 'REPLY', reason: `Replied “${snippet.slice(0, 60)}”`, messageId: message.id });
    });
    await recordEvent({ type: 'UNSUBSCRIBE', messageId: message.id, source, providerEventId: id ? `reply-unsub:${source}:${id}` : null, meta: { via: 'reply' } });
    unsubscribed = true;
  }
  return { matched: true, recorded: outcome.recorded, duplicate: outcome.duplicate, unsubscribed, how: match.how };
}

// ---------------------------------------------------------------- the Gmail mailbox

export function repliesStatus(settings) {
  const cfg = chatConfig();
  const r = settings.replies || {};
  return {
    enabled: Boolean(r.enabled),
    mailbox: r.mailbox || '',
    usable: Boolean(r.enabled && r.mailbox && cfg.usable),
    missing: [
      !cfg.usable && 'Google service account (GOOGLE_CHAT_CLIENT_EMAIL / GOOGLE_CHAT_PRIVATE_KEY)',
      !r.mailbox && 'the reply mailbox address (Settings)',
    ].filter(Boolean),
  };
}

/** Reads recent mail in the reply mailbox and records the replies it finds. */
export async function syncReplies({ max = 100 } = {}) {
  const settings = await marketingSettings();
  const status = repliesStatus(settings);
  if (!status.usable) return { skipped: true, missing: status.missing };
  const days = Math.min(Math.max(Number(settings.replies.lookbackDays) || 3, 1), 30);
  const base = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(status.mailbox)}`;
  const options = { scope: GMAIL_SCOPE, subject: status.mailbox };
  const list = await workspaceApi(`${base}/messages?maxResults=${max}&q=${encodeURIComponent(`in:inbox newer_than:${days}d -from:me`)}`, options);
  const totals = { read: 0, matched: 0, recorded: 0, automatic: 0, unsubscribed: 0 };
  for (const item of list.messages || []) {
    const seen = await query('SELECT 1 FROM mkt_events WHERE provider_event_id = $1', [`reply:MAILBOX:${item.id}`]);
    if (seen.rows[0]) continue;
    const msg = await workspaceApi(
      `${base}/messages/${item.id}?format=metadata${['From', 'To', 'Cc', 'Delivered-To', 'X-Original-To', 'Subject', 'In-Reply-To', 'References', 'Auto-Submitted', 'Precedence', 'X-Autoreply']
        .map((h) => `&metadataHeaders=${h}`).join('')}`,
      options,
    );
    totals.read += 1;
    const headers = msg.payload?.headers || [];
    const result = await handleReply({
      id: item.id,
      to: ['To', 'Cc', 'Delivered-To', 'X-Original-To'].map((h) => header(headers, h)).filter(Boolean),
      from: header(headers, 'From'),
      subject: header(headers, 'Subject') || '',
      inReplyTo: header(headers, 'In-Reply-To') || '',
      references: header(headers, 'References') || '',
      text: msg.snippet || '',
      headers,
      receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)) : null,
      source: 'MAILBOX',
    });
    if (result.automatic) totals.automatic += 1;
    if (result.matched) totals.matched += 1;
    if (result.recorded) totals.recorded += 1;
    if (result.unsubscribed) totals.unsubscribed += 1;
  }
  return totals;
}

// ---------------------------------------------------------------- inbound mail services

/**
 * A reply posted by an inbound mail service. Understands the common shapes
 * (Postmark, Mailgun, SendGrid Inbound Parse, and a plain
 * { to, from, subject, text, in_reply_to, references, message_id }).
 */
export function normalizeInbound(body = {}) {
  const headers = body.Headers || body.headers || {};
  const pickHeader = (name) => header(headers, name) || body[name] || body[name.toLowerCase()] || null;
  return {
    id: body.MessageID || body.message_id || body['Message-Id'] || pickHeader('Message-ID') || null,
    to: [body.OriginalRecipient, body.To, body.recipient, body.to, body.envelope?.to].flat().filter(Boolean).map(String),
    from: body.From || body.sender || body.from || '',
    subject: body.Subject || body.subject || '',
    inReplyTo: pickHeader('In-Reply-To') || body.in_reply_to || '',
    references: pickHeader('References') || body.references || '',
    text: body.StrippedTextReply || body['stripped-text'] || body.TextBody || body.text || body['body-plain'] || '',
    headers,
  };
}
