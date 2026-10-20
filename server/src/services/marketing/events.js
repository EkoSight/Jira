/**
 * What came back from an email, and what follows from it.
 *
 * Sources, kept apart on every event so a report can say what it rests on:
 *   PROVIDER:<name>  the provider's own delivery, bounce and complaint reports
 *   TRACKING         TaskFlow's open pixel and click redirects
 *   MAILBOX          a reply read from the reply mailbox
 *   INBOUND          a reply posted by an inbound mail service
 *   CRM              a conversion seen in the pipeline (a deal won, a lead converted)
 *   API              a conversion reported by the website
 *   MANUAL           a person marked it
 *
 * Opens and clicks that look automatic (link scanners, mail systems fetching
 * images the instant a message arrives) are kept but flagged, and never make
 * follow-up tasks or count as engagement.
 */

import { query, withTransaction } from '../../db/pool.js';
import { recordConsent, localParts, marketingSettings, suppress } from './core.js';
import { unsubscribe } from './audiences.js';
import { createFollowUp, recordCrmHistory } from './followups.js';

export const EVENT_TYPES = ['SENT', 'DELIVERED', 'DEFERRED', 'BOUNCE_HARD', 'BOUNCE_SOFT', 'COMPLAINT', 'REJECTED',
  'FAILED', 'OPEN', 'CLICK', 'UNSUBSCRIBE', 'REPLY', 'CONVERSION'];

const SCANNER = /(bot|crawler|spider|scanner|preview|proofpoint|mimecast|barracuda|safelinks|urldefense|bitdefender|trendmicro|symantec|forcepoint|headless|python-requests|curl\/|go-http-client|wget|java\/|okhttp|libwww)/i;

/** Whether an open or click was probably not a person. */
export function looksAutomatic({ type, userAgent, occurredAt, sentAt }) {
  if (userAgent && SCANNER.test(userAgent)) return true;
  if (!sentAt) return false;
  const seconds = (new Date(occurredAt || Date.now()) - new Date(sentAt)) / 1000;
  // nobody reads an email or follows its link this fast after it was sent
  if (type === 'OPEN' && seconds >= 0 && seconds < 2) return true;
  if (type === 'CLICK' && seconds >= 0 && seconds < 10) return true;
  return false;
}

const WEIGHTS = { OPEN: 1, CLICK: 3, REPLY: 6, CONVERSION: 10, BOUNCE_SOFT: -2 };

/**
 * 0–100 from the last 90 days of human activity, newer counting more
 * (it halves every 30 days). The same activity always gives the same score.
 */
export function engagementScore(events, now = new Date()) {
  let raw = 0;
  for (const e of events) {
    if (e.is_machine) continue;
    const weight = WEIGHTS[e.type];
    if (!weight) continue;
    const ageDays = Math.max(0, (now - new Date(e.occurred_at)) / 86_400_000);
    if (ageDays > 90) continue;
    raw += weight * 0.5 ** (ageDays / 30);
  }
  if (raw <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - Math.exp(-raw / 8)))));
}

/** The hour (India time) someone most often opens or clicks, from at least three readings. */
export function bestHour(events, timeZone = 'Asia/Kolkata') {
  const counts = new Map();
  for (const e of events) {
    if (e.is_machine || !['OPEN', 'CLICK'].includes(e.type)) continue;
    const hour = localParts(new Date(e.occurred_at), timeZone).hour;
    counts.set(hour, (counts.get(hour) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total < 3) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

async function findMessage(client, { messageId, token, reference, providerMessageId, email }) {
  const by = async (sql, value) => (value ? (await client.query(sql, [value])).rows[0] : null);
  return (await by('SELECT * FROM mkt_messages WHERE id = $1', messageId))
    || (await by('SELECT * FROM mkt_messages WHERE token = $1', token))
    || (await by('SELECT * FROM mkt_messages WHERE token = $1', reference))
    || (providerMessageId
      ? (await client.query(
        'SELECT * FROM mkt_messages WHERE provider_message_id = $1 AND ($2::text IS NULL OR lower(email) = lower($2)) ORDER BY id DESC LIMIT 1',
        [providerMessageId, email || null],
      )).rows[0]
      : null)
    || null;
}

/**
 * Records one event and applies what follows from it. Safe to call twice with
 * the same providerEventId: the second call changes nothing.
 * Returns { recorded, duplicate, event, message }.
 */
export async function recordEvent(input) {
  const settings = await marketingSettings();
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const outcome = await withTransaction(async (client) => {
    const message = await findMessage(client, input);
    const contactId = message?.contact_id ?? input.contactId ?? null;
    let machine = Boolean(input.isMachine);
    if (['OPEN', 'CLICK'].includes(input.type) && !machine) {
      machine = looksAutomatic({ type: input.type, userAgent: input.userAgent, occurredAt, sentAt: message?.sent_at });
    }
    const { rows } = await client.query(
      `INSERT INTO mkt_events (type, message_id, contact_id, campaign_id, workflow_id, link_id, url, source, provider_event_id,
                               is_machine, ip, user_agent, value, meta, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
       RETURNING *`,
      // a test or confirmation email is never part of a campaign's figures
      [input.type, message?.id ?? null, contactId,
        message ? (message.kind === 'CAMPAIGN' ? message.campaign_id : null) : input.campaignId ?? null,
        message?.kind === 'AUTOMATION' ? message.workflow_id : null,
        input.linkId ?? null, input.url ?? null, input.source, input.providerEventId ?? null, machine,
        input.ip ? String(input.ip).slice(0, 64) : null, input.userAgent ? String(input.userAgent).slice(0, 300) : null,
        input.value ?? null, input.meta || {}, occurredAt],
    );
    if (!rows[0]) return { recorded: false, duplicate: true, message };
    const event = rows[0];

    const { rows: contacts } = contactId ? await client.query('SELECT * FROM mkt_contacts WHERE id = $1 FOR UPDATE', [contactId]) : { rows: [] };
    const contact = contacts[0] || null;
    const email = contact?.email_normalized || input.email || message?.email;
    const human = !machine;

    switch (input.type) {
      case 'DELIVERED':
        if (message) await client.query(`UPDATE mkt_messages SET status = CASE WHEN status = 'SENT' THEN 'DELIVERED' ELSE status END, delivered_at = COALESCE(delivered_at, $2) WHERE id = $1`, [message.id, occurredAt]);
        if (contact) await client.query('UPDATE mkt_contacts SET soft_bounces = 0 WHERE id = $1', [contact.id]);
        break;
      case 'BOUNCE_HARD':
      case 'COMPLAINT': {
        const status = input.type === 'COMPLAINT' ? 'COMPLAINED' : 'BOUNCED';
        if (message) await client.query(`UPDATE mkt_messages SET status = $2, ${input.type === 'COMPLAINT' ? 'complained_at' : 'bounced_at'} = COALESCE(${input.type === 'COMPLAINT' ? 'complained_at' : 'bounced_at'}, $3) WHERE id = $1`, [message.id, status, occurredAt]);
        if (email) await suppress(client, email, { reason: input.type === 'COMPLAINT' ? 'COMPLAINT' : 'HARD_BOUNCE', source: input.source, note: input.meta?.diagnostic || null });
        if (contact) {
          await client.query(`UPDATE mkt_contacts SET email_status = $2, updated_at = now() WHERE id = $1`, [contact.id, status]);
          if (input.type === 'COMPLAINT') {
            // marking it as spam is the clearest "stop" there is
            await unsubscribe(client, contact.id, { all: true, source: 'PROVIDER_COMPLAINT', reason: 'Marked as spam', messageId: message?.id });
          } else {
            await client.query(`UPDATE mkt_memberships SET status = 'CLEANED', updated_at = now() WHERE contact_id = $1 AND status IN ('SUBSCRIBED', 'PENDING')`, [contact.id]);
            await recordConsent(client, { contactId: contact.id, action: 'SUPPRESS', source: input.source, meta: { reason: 'Hard bounce', diagnostic: input.meta?.diagnostic || null } });
          }
        }
        break;
      }
      case 'BOUNCE_SOFT':
        if (message) await client.query(`UPDATE mkt_messages SET status = CASE WHEN status IN ('SENT', 'DELIVERED') THEN 'BOUNCED' ELSE status END, bounced_at = COALESCE(bounced_at, $2) WHERE id = $1`, [message.id, occurredAt]);
        if (contact) {
          const { rows: after } = await client.query('UPDATE mkt_contacts SET soft_bounces = soft_bounces + 1 WHERE id = $1 RETURNING soft_bounces', [contact.id]);
          if (after[0].soft_bounces >= (Number(settings.softBounceLimit) || 3)) {
            await suppress(client, email, { reason: 'SOFT_BOUNCES', source: input.source, note: `${after[0].soft_bounces} soft bounces in a row` });
            await client.query(`UPDATE mkt_contacts SET email_status = 'BOUNCED', updated_at = now() WHERE id = $1`, [contact.id]);
            await client.query(`UPDATE mkt_memberships SET status = 'CLEANED', updated_at = now() WHERE contact_id = $1 AND status IN ('SUBSCRIBED', 'PENDING')`, [contact.id]);
            await recordConsent(client, { contactId: contact.id, action: 'SUPPRESS', source: input.source, meta: { reason: 'Repeated soft bounces' } });
          }
        }
        break;
      case 'REJECTED':
      case 'FAILED':
        if (message) await client.query(`UPDATE mkt_messages SET status = 'FAILED', last_error = COALESCE($2, last_error) WHERE id = $1 AND status IN ('SENT', 'SENDING', 'QUEUED')`, [message.id, input.meta?.diagnostic || null]);
        break;
      case 'OPEN':
        if (message) await client.query(`UPDATE mkt_messages SET open_count = open_count + 1, first_opened_at = CASE WHEN $2 THEN COALESCE(first_opened_at, $3) ELSE first_opened_at END WHERE id = $1`, [message.id, human, occurredAt]);
        if (contact && human) await client.query('UPDATE mkt_contacts SET last_opened_at = GREATEST(COALESCE(last_opened_at, to_timestamp(0)), $2) WHERE id = $1', [contact.id, occurredAt]);
        break;
      case 'CLICK':
        // a click is also an open: images may have been blocked
        if (message) await client.query(`UPDATE mkt_messages SET click_count = click_count + 1, first_clicked_at = CASE WHEN $2 THEN COALESCE(first_clicked_at, $3) ELSE first_clicked_at END, first_opened_at = CASE WHEN $2 THEN COALESCE(first_opened_at, $3) ELSE first_opened_at END WHERE id = $1`, [message.id, human, occurredAt]);
        if (contact && human) await client.query('UPDATE mkt_contacts SET last_clicked_at = GREATEST(COALESCE(last_clicked_at, to_timestamp(0)), $2), last_opened_at = GREATEST(COALESCE(last_opened_at, to_timestamp(0)), $2) WHERE id = $1', [contact.id, occurredAt]);
        break;
      case 'UNSUBSCRIBE':
        if (message) await client.query('UPDATE mkt_messages SET unsubscribed_at = COALESCE(unsubscribed_at, $2) WHERE id = $1', [message.id, occurredAt]);
        break;
      case 'REPLY':
        if (message) await client.query('UPDATE mkt_messages SET replied_at = COALESCE(replied_at, $2) WHERE id = $1', [message.id, occurredAt]);
        if (contact) await client.query('UPDATE mkt_contacts SET last_replied_at = GREATEST(COALESCE(last_replied_at, to_timestamp(0)), $2) WHERE id = $1', [contact.id, occurredAt]);
        break;
      case 'CONVERSION':
        if (message) await client.query('UPDATE mkt_messages SET converted_at = COALESCE(converted_at, $2) WHERE id = $1', [message.id, occurredAt]);
        if (contact) await client.query('UPDATE mkt_contacts SET last_converted_at = GREATEST(COALESCE(last_converted_at, to_timestamp(0)), $2) WHERE id = $1', [contact.id, occurredAt]);
        break;
      default:
    }

    if (contact && ['OPEN', 'CLICK', 'REPLY', 'CONVERSION', 'BOUNCE_SOFT'].includes(input.type)) {
      const { rows: history } = await client.query(
        `SELECT type, occurred_at, is_machine FROM mkt_events WHERE contact_id = $1 AND occurred_at > now() - interval '90 days'`,
        [contact.id],
      );
      await client.query(
        'UPDATE mkt_contacts SET engagement_score = $2, best_send_hour = COALESCE($3, best_send_hour) WHERE id = $1',
        [contact.id, engagementScore(history), bestHour(history, settings.timezone)],
      );
    }
    return { recorded: true, duplicate: false, event, message, contact, human };
  });

  if (outcome.recorded) {
    // what follows in TaskFlow: never allowed to lose the event itself
    try {
      await afterEvent({ ...outcome, input });
    } catch (err) {
      console.error('[taskflow] email marketing: follow-up after an event failed:', err.message);
    }
  }
  return outcome;
}

const HISTORY_WORDS = {
  CLICK: 'Clicked a link in',
  REPLY: 'Replied to',
  CONVERSION: 'Converted after',
  UNSUBSCRIBE: 'Unsubscribed from',
  COMPLAINT: 'Marked as spam:',
  BOUNCE_HARD: 'Email bounced:',
};

async function afterEvent({ event, message, contact, human, input }) {
  if (!contact || (message && !['CAMPAIGN', 'AUTOMATION'].includes(message.kind))) return;
  const { rows: campaigns } = message?.campaign_id ? await query('SELECT * FROM mkt_campaigns WHERE id = $1', [message.campaign_id]) : { rows: [] };
  const { rows: workflows } = message?.workflow_id ? await query('SELECT * FROM mkt_workflows WHERE id = $1', [message.workflow_id]) : { rows: [] };
  const campaign = campaigns[0] || null;
  const workflow = workflows[0] || null;
  const name = campaign?.name || workflow?.name || message?.subject || 'an email';

  // ---- a follow-up task where the campaign asks for one
  let task = null;
  const rules = campaign?.follow_up || (workflow ? { on_reply: true, on_conversion: true, assign: 'CONTACT_OWNER' } : null);
  if (rules && (campaign || workflow)) {
    const linkWanted = !rules.link_urls?.length || rules.link_urls.includes(event.url);
    const wanted = (event.type === 'CLICK' && human && rules.on_click && linkWanted)
      || (event.type === 'REPLY' && rules.on_reply)
      || (event.type === 'CONVERSION' && rules.on_conversion);
    if (wanted) {
      const detail = event.type === 'CLICK' ? `They followed ${event.url}.`
        : event.type === 'REPLY' ? (input.meta?.snippet ? `They wrote: “${String(input.meta.snippet).slice(0, 300)}”` : 'Read their reply in the reply mailbox.')
          : input.value ? `Value: ₹${input.value}.` : '';
      const made = await createFollowUp({
        contact, campaign, workflow, nodeKey: 'reply', message, reason: event.type, detail,
        assign: rules.assign || 'CONTACT_OWNER', dueDays: rules.due_days,
      });
      task = made.task;
    }
  }

  // ---- the organization's history: the things a salesperson would want to know
  const firstClick = event.type === 'CLICK' && human;
  if (HISTORY_WORDS[event.type] && (event.type !== 'CLICK' || firstClick)) {
    await recordCrmHistory(null, contact, {
      key: event.type === 'CLICK' ? `click:${message?.id}` : `${event.type}:${message?.id || event.id}`,
      subject: `${HISTORY_WORDS[event.type]} “${name}”`,
      body: event.type === 'CLICK' ? event.url : event.type === 'REPLY' ? (input.meta?.snippet || null) : (input.meta?.diagnostic || null),
      occurredAt: event.occurred_at,
      taskId: task?.id ?? null,
      meta: { campaign_id: campaign?.id ?? null, workflow_id: workflow?.id ?? null, event: event.type, mkt_contact_id: contact.id },
    });
  }

  // ---- automations waiting on activity
  const { onEmailEvent } = await import('./automations.js');
  await onEmailEvent({ event, message, contact, human });
}

/** A conversion the website reports: by the click reference in the link, or by email address. */
export async function recordConversion({ ref, email, value = null, label = null, source = 'API', occurredAt = null, externalId = null }) {
  let messageId = null;
  if (ref) {
    const { rows } = await query('SELECT id FROM mkt_messages WHERE reply_code = $1', [String(ref).slice(0, 40)]);
    messageId = rows[0]?.id ?? null;
  }
  if (!messageId && email) {
    // the latest email they clicked, inside its campaign's attribution window
    const { rows } = await query(
      `SELECT m.id FROM mkt_messages m LEFT JOIN mkt_campaigns c ON c.id = m.campaign_id
        WHERE lower(m.email) = lower($1) AND m.first_clicked_at IS NOT NULL
          AND m.first_clicked_at > now() - make_interval(days => COALESCE(c.conversion_window_days, 30))
        ORDER BY m.first_clicked_at DESC LIMIT 1`,
      [email],
    );
    messageId = rows[0]?.id ?? null;
  }
  if (!messageId) return { recorded: false, reason: 'No clicked email matches this conversion' };
  return recordEvent({
    type: 'CONVERSION', messageId, source, value, occurredAt,
    providerEventId: externalId ? `conversion:${source}:${externalId}` : null,
    meta: { label },
  });
}
