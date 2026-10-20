/**
 * The sending queue.
 *
 * Every email — campaign, automation step, test, confirmation — is a row in
 * mkt_messages first, and is handed to the provider by the worker. Before each
 * one goes, the person is checked again: an unsubscribe, bounce or complaint
 * that arrived after the campaign was started still stops it.
 *
 * Messages are claimed with FOR UPDATE SKIP LOCKED, so two workers never send
 * the same one. A provider failure that might pass (rate limit, outage) is
 * retried with growing gaps; a refusal is not. A message the sender stopped
 * part-way through handing over is marked failed and not resent automatically,
 * because it may already have arrived — a duplicate is worse than a gap.
 */

import { query, withTransaction } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { applyMerge, designLinks, renderEmail } from '../../lib/emailRender.js';
import { domainOf, isSuppressed, localParts, marketingSettings, newReplyCode, newToken, normalizeEmail, publicBase } from './core.js';
import { SendError, activeProvider, providerName, providerStatus } from './providers.js';

const RETRY_MINUTES = [1, 5, 30, 120];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

// ---------------------------------------------------------------- links

/** Makes sure every link in a design has a tracking id. Returns Map(url → id). */
export async function linkIds(client, { campaignId = null, workflowId = null }, design) {
  const runner = client || { query };
  const urls = designLinks(design);
  const map = new Map();
  for (const url of urls) {
    const { rows } = await runner.query(
      `INSERT INTO mkt_links (campaign_id, workflow_id, url) VALUES ($1,$2,$3)
       ON CONFLICT (COALESCE(campaign_id, 0), COALESCE(workflow_id, 0), md5(url)) DO UPDATE SET url = EXCLUDED.url
       RETURNING id`,
      [campaignId, workflowId, url],
    );
    map.set(url, rows[0].id);
  }
  return map;
}

// ---------------------------------------------------------------- who and what

/** The from, reply-to and footer for a message, from campaign → audience → settings. */
export function senderFor({ campaign = null, workflow = null, audience = null, settings, replyCode = null }) {
  const from = (campaign?.from_email || workflow?.from_email || audience?.from_email || settings.defaultFromEmail || '').trim();
  const fromName = campaign?.from_name || workflow?.from_name || audience?.from_name || settings.defaultFromName || settings.company || '';
  let replyTo = (campaign?.reply_to || workflow?.reply_to || audience?.reply_to || settings.defaultReplyTo || '').trim();
  if (replyTo && settings.replyPlusAddressing && replyCode) {
    const [local, domain] = replyTo.split('@');
    replyTo = `${local.split('+')[0]}+${replyCode}@${domain}`;
  }
  return { from, fromName, replyTo: replyTo || null };
}

/** Whether a From address may be used: on the senders list (when there is one) and well formed. */
export function senderAllowed(from, settings) {
  if (!from || !from.includes('@')) return false;
  const list = (settings.senders || []).map((s) => normalizeEmail(s.email || s));
  return !list.length || list.includes(normalizeEmail(from));
}

/** Why this person must not get this message now, or null. */
export async function skipReason(client, message, contact, { settings, campaign, workflow }) {
  if (!contact) return 'CONTACT_REMOVED';
  if (contact.is_archived) return 'CONTACT_ARCHIVED';
  const suppressed = await isSuppressed(client, contact.email_normalized);
  if (suppressed) return `SUPPRESSED_${suppressed}`;
  if (message.kind === 'TEST' || message.kind === 'CONFIRMATION') return null;
  if (contact.email_status !== 'ACTIVE') return `ADDRESS_${contact.email_status}`;
  if (contact.unsubscribed_all_at) return 'UNSUBSCRIBED_ALL';
  if (message.audience_id) {
    const { rows } = await client.query('SELECT status FROM mkt_memberships WHERE audience_id = $1 AND contact_id = $2', [message.audience_id, contact.id]);
    if (rows[0]?.status !== 'SUBSCRIBED') return 'NOT_SUBSCRIBED';
  } else {
    const { rows } = await client.query(`SELECT 1 FROM mkt_memberships WHERE contact_id = $1 AND status = 'SUBSCRIBED' LIMIT 1`, [contact.id]);
    if (!rows[0]) return 'NOT_SUBSCRIBED';
  }
  const topicId = campaign?.topic_id ?? workflow?.topic_id ?? null;
  if (topicId) {
    const { rows } = await client.query('SELECT opted_in FROM mkt_contact_topics WHERE contact_id = $1 AND topic_id = $2', [contact.id, topicId]);
    if (rows[0] && rows[0].opted_in === false) return 'TOPIC_OPTED_OUT';
  }
  void settings;
  return null;
}

/** Whether sending now would go over the per-person limits. */
export async function overFrequencyLimit(client, contactId, settings, now = new Date()) {
  const perDay = Number(settings.limits?.perContactPerDay) || 0;
  const perWeek = Number(settings.limits?.perContactPerWeek) || 0;
  if (!perDay && !perWeek) return false;
  const { rows } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE sent_at > $2::timestamptz - interval '1 day')::int AS day,
            COUNT(*) FILTER (WHERE sent_at > $2::timestamptz - interval '7 days')::int AS week
       FROM mkt_messages WHERE contact_id = $1 AND kind IN ('CAMPAIGN', 'AUTOMATION') AND sent_at IS NOT NULL`,
    [contactId, now],
  );
  return (perDay && rows[0].day >= perDay) || (perWeek && rows[0].week >= perWeek);
}

const CONFIRM_WORDS = {
  en: {
    subject: (a) => `Please confirm: ${a}`,
    eyebrow: 'Confirm your email',
    heading: 'One more step',
    body: (a) => `You asked to join **${a}**. Please confirm it was you, and we will start sending.`,
    after: 'If you did not ask, ignore this email and nothing will happen.',
    button: 'Yes, subscribe me →',
  },
  hi: {
    subject: (a) => `कृपया पुष्टि करें: ${a}`,
    eyebrow: 'अपना ईमेल पक्का करें',
    heading: 'बस एक कदम और',
    body: (a) => `आपने **${a}** से जुड़ने का अनुरोध किया है। कृपया पुष्टि करें कि यह आप ही थे।`,
    after: 'यदि आपने अनुरोध नहीं किया, तो इस ईमेल को अनदेखा करें।',
    button: 'हाँ, मुझे जोड़ें →',
  },
};

/** The content of one message, ready to render: subject, preheader and design. */
export async function contentFor(message, { campaign, workflow }) {
  if (message.kind === 'TEST' || message.kind === 'CONFIRMATION') {
    const payload = message.test_payload || {};
    if (message.kind === 'CONFIRMATION') {
      const w = CONFIRM_WORDS[payload.language] || CONFIRM_WORDS.en;
      return {
        subject: w.subject(payload.audience), subject_hi: null, preheader: '',
        design: { settings: { header: 'light', ground: 'sand' }, blocks: [
          { type: 'hero', tone: 'sand', eyebrow: w.eyebrow, title: w.heading, text: w.body(payload.audience), button: { text: w.button, href: payload.confirm_url, style: 'primary' } },
          { type: 'text', text: w.after },
        ] },
        tracking: false,
      };
    }
    return { ...payload, tracking: true };
  }
  if (message.kind === 'AUTOMATION') {
    const node = workflow?.graph?.nodes?.[message.workflow_node];
    if (!node || node.type !== 'email') return null;
    return { subject: node.config?.subject, subject_hi: node.config?.subject_hi, preheader: node.config?.preheader, design: node.config?.design || { blocks: [] }, tracking: true };
  }
  if (!campaign) return null;
  let content = {
    subject: campaign.subject, subject_hi: campaign.subject_hi, preheader: campaign.preheader, preheader_hi: campaign.preheader_hi,
    design: campaign.design, from_name: null, tracking: true,
  };
  if (message.variant) {
    const { rows } = await query('SELECT * FROM mkt_campaign_variants WHERE campaign_id = $1 AND key = $2', [campaign.id, message.variant]);
    const v = rows[0];
    if (v) {
      content = {
        ...content,
        subject: v.subject || content.subject,
        subject_hi: v.subject_hi || content.subject_hi,
        preheader: v.preheader || content.preheader,
        design: v.design || content.design,
        from_name: v.from_name || null,
      };
    }
  }
  return content;
}

/** Where the brand images are served, and the website the logo links to. */
export const brandFor = (settings) => ({ base: `${publicBase()}/brand`, website: settings.website || 'https://soildoctor.in', tagline: settings.tagline ?? undefined });

const hasHindi = (design) => JSON.stringify(design?.blocks || []).includes('"hi":"');

/** What a person sees: merge values, audiences, their organization's pipeline type. */
export async function personFor(client, contact) {
  const runner = client || { query };
  const [{ rows: memberships }, { rows: accounts }] = await Promise.all([
    runner.query(`SELECT audience_id FROM mkt_memberships WHERE contact_id = $1 AND status = 'SUBSCRIBED'`, [contact.id]),
    contact.account_id ? runner.query('SELECT type FROM accounts WHERE id = $1', [contact.account_id]) : Promise.resolve({ rows: [] }),
  ]);
  return {
    ...contact,
    email: contact.email,
    audience_ids: memberships.map((m) => m.audience_id),
    account_type: accounts[0]?.type || 'NONE',
  };
}

/** Renders one queued message for its person. */
export async function renderMessage(client, message, { campaign = null, workflow = null, audience = null, contact = null, settings, enrollment = null }) {
  const content = await contentFor(message, { campaign, workflow });
  if (!content) throw new SendError('The content of this email no longer exists', { transient: false });
  const person = contact ? await personFor(client, contact) : { email: message.email, first_name: content.sample_first_name || null, tags: [], custom: {} };
  const wantsHindi = (person.language || 'en') === 'hi';
  const lang = message.kind === 'CONFIRMATION'
    ? (message.test_payload?.language || 'en')
    : wantsHindi && (content.subject_hi || hasHindi(content.design)) ? 'hi' : 'en';
  const base = publicBase();
  const owner = campaign ? { campaignId: campaign.id } : workflow ? { workflowId: workflow.id } : null;
  const links = owner && content.tracking !== false ? await linkIds(client, owner, content.design) : new Map();
  const trackOpens = content.tracking !== false && (campaign ? campaign.track_opens : true) && message.kind !== 'CONFIRMATION';
  const trackClicks = content.tracking !== false && (campaign ? campaign.track_clicks : true) && message.kind !== 'CONFIRMATION';
  const today = localParts(new Date(), settings.timezone).date;
  const unsubscribeUrl = `${base}/u/${message.token}`;
  const data = {
    campaign: campaign?.name || workflow?.name || '',
    festival: enrollment?.context?.festival || '',
    today: new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${today}T00:00:00Z`)),
    year: today.slice(0, 4),
    unsubscribe_url: unsubscribeUrl,
    preferences_url: unsubscribeUrl,
  };
  const subjectTemplate = (lang === 'hi' && content.subject_hi) ? content.subject_hi : content.subject;
  const preheader = (lang === 'hi' && content.preheader_hi) ? content.preheader_hi : content.preheader;
  const reason = message.kind === 'CONFIRMATION'
    ? { en: 'someone asked to subscribe this address', hi: 'इस पते से सदस्यता का अनुरोध किया गया' }
    : audience
      ? { en: `you are on our ${audience.name} list${audience.purpose ? ` (${audience.purpose.toLowerCase()})` : ''}.`, hi: `आप हमारी ${audience.name} सूची में हैं।` }
      : { en: 'you subscribed to emails from us.', hi: 'आपने हमारे ईमेल की सदस्यता ली है।' };

  const rendered = renderEmail(content.design, {
    person, lang, data, preheader: preheader || '', subject: subjectTemplate || '',
    footer: { company: settings.company, address: settings.postalAddress, reason },
    brand: brandFor(settings),
    track: {
      openPixel: trackOpens ? `${base}/o/${message.token}.gif` : null,
      href: (url) => (trackClicks && links.has(url) ? `${base}/c/${message.token}/${links.get(url)}` : url),
    },
  });
  const subject = applyMerge(subjectTemplate || '', { ...person, ...data }, { mode: 'text' })
    .replace(/[\r\n]+/g, ' ').trim() || '(no subject)';
  return { ...rendered, subject: message.kind === 'TEST' ? `[Test] ${subject}` : subject, lang, fromName: content.from_name || null, unsubscribeUrl };
}

// ---------------------------------------------------------------- handing over to the provider

async function sendOne(message, cache, settings, provider) {
  const load = async (table, id) => {
    if (!id) return null;
    const key = `${table}:${id}`;
    if (!cache.has(key)) cache.set(key, (await query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0] || null);
    return cache.get(key);
  };
  const campaign = await load('mkt_campaigns', message.campaign_id);
  const workflow = await load('mkt_workflows', message.workflow_id);
  const audience = await load('mkt_audiences', message.audience_id);
  const enrollment = message.enrollment_id ? (await query('SELECT * FROM mkt_enrollments WHERE id = $1', [message.enrollment_id])).rows[0] : null;
  const contact = message.contact_id ? (await query('SELECT * FROM mkt_contacts WHERE id = $1', [message.contact_id])).rows[0] : null;

  // checked again now, not when the campaign started. A test or confirmation
  // is checked against the address it actually goes to.
  let skip;
  if (message.kind === 'TEST' || message.kind === 'CONFIRMATION') {
    const suppressed = await isSuppressed(null, message.email);
    // someone who once unsubscribed from everything and signs up again gets
    // the confirmation: confirming it is how they come back
    skip = suppressed && !(message.kind === 'CONFIRMATION' && suppressed === 'UNSUBSCRIBED_ALL') ? `SUPPRESSED_${suppressed}` : null;
  } else {
    skip = await skipReason({ query }, message, contact, { settings, campaign, workflow });
  }
  if (skip) {
    await query(`UPDATE mkt_messages SET status = 'SKIPPED', skip_reason = $2, locked_until = NULL WHERE id = $1`, [message.id, skip]);
    return 'skipped';
  }
  if (contact && ['CAMPAIGN', 'AUTOMATION'].includes(message.kind) && await overFrequencyLimit({ query }, contact.id, settings)) {
    if (message.kind === 'AUTOMATION' && message.attempts <= 3) {
      // an automation step waits a day rather than being lost
      await query(`UPDATE mkt_messages SET status = 'QUEUED', scheduled_for = now() + interval '1 day', locked_until = NULL WHERE id = $1`, [message.id]);
      return 'deferred';
    }
    await query(`UPDATE mkt_messages SET status = 'SKIPPED', skip_reason = 'FREQUENCY_LIMIT', locked_until = NULL WHERE id = $1`, [message.id]);
    return 'skipped';
  }

  const sender = senderFor({ campaign, workflow, audience, settings, replyCode: message.reply_code });
  if (!senderAllowed(sender.from, settings)) {
    await query(`UPDATE mkt_messages SET status = 'FAILED', last_error = $2, locked_until = NULL WHERE id = $1`,
      [message.id, sender.from ? `${sender.from} is not on the list of approved senders` : 'No sender address is set (Email marketing → Settings)']);
    return 'failed';
  }
  if (!settings.postalAddress && message.kind !== 'TEST') {
    await query(`UPDATE mkt_messages SET status = 'FAILED', last_error = 'The postal address for the footer is not set (Email marketing → Settings)', locked_until = NULL WHERE id = $1`, [message.id]);
    return 'failed';
  }

  try {
    const rendered = await renderMessage({ query }, message, { campaign, workflow, audience, contact, settings, enrollment });
    const domain = domainOf(sender.from);
    const result = await provider.send({
      from: sender.from,
      fromName: rendered.fromName || sender.fromName,
      to: message.email,
      toName: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : null,
      replyTo: sender.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      reference: message.token,
      domain,
      headers: message.kind === 'CONFIRMATION' || message.kind === 'TEST' ? {} : {
        'List-Unsubscribe': `<${rendered.unsubscribeUrl}/one-click>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        ...(audience ? { 'List-Id': `${audience.name.replace(/[^\w\s-]/g, '')} <${audience.slug}.${domain}>` } : {}),
        'Feedback-ID': `${campaign ? `c${campaign.id}` : workflow ? `w${workflow.id}` : 'x'}:${message.kind.toLowerCase()}:taskflow`,
      },
    });
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE mkt_messages SET status = 'SENT', sent_at = now(), provider = $2, provider_message_id = $3, subject = $4, language = $5,
                last_error = NULL, locked_until = NULL WHERE id = $1`,
        [message.id, providerName(), result.providerMessageId, rendered.subject, rendered.lang],
      );
      if (contact && ['CAMPAIGN', 'AUTOMATION'].includes(message.kind)) {
        await client.query('UPDATE mkt_contacts SET last_sent_at = now() WHERE id = $1', [contact.id]);
      }
      await client.query(
        `INSERT INTO mkt_events (type, message_id, contact_id, campaign_id, workflow_id, source, provider_event_id)
         VALUES ('SENT', $1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [message.id, message.contact_id, message.kind === 'CAMPAIGN' ? message.campaign_id : null,
          message.kind === 'AUTOMATION' ? message.workflow_id : null, `PROVIDER:${providerName()}`, `sent:${message.id}`],
      );
    });
    return 'sent';
  } catch (err) {
    const transient = err instanceof SendError ? err.transient : true;
    if (transient && message.attempts < MAX_ATTEMPTS) {
      const wait = RETRY_MINUTES[Math.min(message.attempts - 1, RETRY_MINUTES.length - 1)];
      await query(
        `UPDATE mkt_messages SET status = 'QUEUED', next_attempt_at = now() + make_interval(mins => $2), last_error = $3, locked_until = NULL WHERE id = $1`,
        [message.id, wait, String(err.message).slice(0, 500)],
      );
      return 'retry';
    }
    await query(`UPDATE mkt_messages SET status = 'FAILED', last_error = $2, locked_until = NULL WHERE id = $1`, [message.id, String(err.message).slice(0, 500)]);
    await query(
      `INSERT INTO mkt_events (type, message_id, contact_id, campaign_id, workflow_id, source, meta) VALUES ('FAILED', $1, $2, $3, $4, $5, $6)`,
      [message.id, message.contact_id, message.kind === 'CAMPAIGN' ? message.campaign_id : null,
        message.kind === 'AUTOMATION' ? message.workflow_id : null, `PROVIDER:${providerName()}`, { error: String(err.message).slice(0, 300), attempts: message.attempts }],
    );
    return 'failed';
  }
}

/**
 * One pass of the queue: hands over up to `limit` messages that are due.
 * Returns counts by outcome.
 */
export async function processQueue({ limit = 50, onlyIds = null } = {}) {
  const settings = await marketingSettings();
  const provider = activeProvider();
  const status = providerStatus();
  const counts = { sent: 0, skipped: 0, retry: 0, failed: 0, deferred: 0, recovered: 0 };

  // a send interrupted part-way is not repeated: it may have arrived
  const { rowCount: recovered } = await query(
    `UPDATE mkt_messages SET status = 'FAILED', locked_until = NULL,
            last_error = 'Interrupted while handing over to the provider; not resent automatically in case it arrived'
      WHERE status = 'SENDING' AND locked_until < now()`,
  );
  counts.recovered = recovered;
  if (!provider || !status.configured) return { ...counts, notConfigured: true };

  const { rows: claimed } = await query(
    `UPDATE mkt_messages SET status = 'SENDING', attempts = attempts + 1, locked_until = now() + interval '5 minutes'
      WHERE id IN (
        SELECT m.id FROM mkt_messages m
         WHERE m.status = 'QUEUED' AND m.scheduled_for <= now()
           AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= now())
           AND ($2::bigint[] IS NULL OR m.id = ANY($2::bigint[]))
           AND (m.kind <> 'CAMPAIGN' OR EXISTS (SELECT 1 FROM mkt_campaigns c WHERE c.id = m.campaign_id AND c.status IN ('SENDING', 'TESTING')))
           AND (m.kind <> 'AUTOMATION' OR EXISTS (SELECT 1 FROM mkt_workflows w WHERE w.id = m.workflow_id AND w.status = 'ACTIVE'))
         ORDER BY CASE m.kind WHEN 'CONFIRMATION' THEN 0 WHEN 'TEST' THEN 0 ELSE 1 END, m.scheduled_for, m.id
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [limit, onlyIds],
  );
  const cache = new Map();
  for (const message of claimed) {
    const outcome = await sendOne(message, cache, settings, provider);
    counts[outcome] = (counts[outcome] || 0) + 1;
  }

  // a campaign is sent when nothing of it is waiting any more
  await query(
    `UPDATE mkt_campaigns c SET status = 'SENT', completed_at = now(), updated_at = now()
      WHERE c.status = 'SENDING'
        AND NOT EXISTS (SELECT 1 FROM mkt_messages m WHERE m.campaign_id = c.id AND m.kind = 'CAMPAIGN'
                         AND m.status IN ('HELD', 'QUEUED', 'SENDING'))`,
  );
  return counts;
}

/** Queues and immediately sends a test of a campaign or automation email to staff addresses. */
export async function sendTest({ content, emails, campaignId = null, sampleContactId = null, actor }) {
  const status = providerStatus();
  if (!status.configured) throw badRequest(`Sending is not set up: ${status.missing.join(', ')}`);
  const list = [...new Set((emails || []).map(normalizeEmail))].filter((e) => e.includes('@')).slice(0, 10);
  if (!list.length) throw badRequest('Give at least one address to send the test to');
  const ids = [];
  for (const email of list) {
    const { rows } = await query(
      `INSERT INTO mkt_messages (kind, campaign_id, contact_id, email, token, reply_code, test_payload)
       VALUES ('TEST', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [campaignId, sampleContactId, email, newToken(), newReplyCode(), { ...content, requested_by: actor.id }],
    );
    ids.push(rows[0].id);
  }
  // a test's person is the sample contact; the address it goes to is the tester's
  await query('UPDATE mkt_messages SET contact_id = NULL WHERE id = ANY($1::bigint[]) AND $2::int IS NULL', [ids, sampleContactId]);
  const result = await processQueue({ limit: ids.length, onlyIds: ids });
  const { rows } = await query('SELECT id, email, status, last_error, skip_reason FROM mkt_messages WHERE id = ANY($1::bigint[])', [ids]);
  return { result, messages: rows };
}

/** Queues the confirmation email for a double opt-in signup. */
export async function queueConfirmation(client, { contact, audience, confirmToken, language = 'en' }) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO mkt_messages (kind, audience_id, contact_id, email, token, reply_code, test_payload)
     VALUES ('CONFIRMATION', $1, $2, $3, $4, $5, $6)`,
    [audience.id, contact.id, contact.email, newToken(), newReplyCode(),
      { audience: audience.name, confirm_url: `${publicBase()}/confirm/${confirmToken}`, language }],
  );
}

/** Puts a campaign's failed messages back in the queue, when a person decides to. */
export async function retryFailed(campaignId) {
  const { rowCount } = await query(
    `UPDATE mkt_messages SET status = 'QUEUED', attempts = 0, next_attempt_at = NULL, last_error = NULL, scheduled_for = now()
      WHERE campaign_id = $1 AND kind = 'CAMPAIGN' AND status = 'FAILED'`,
    [campaignId],
  );
  if (rowCount) await query(`UPDATE mkt_campaigns SET status = 'SENDING', completed_at = NULL WHERE id = $1 AND status = 'SENT'`, [campaignId]);
  return rowCount;
}
