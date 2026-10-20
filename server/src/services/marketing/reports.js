/**
 * Reports, from the messages and events actually recorded.
 *
 * Every figure says what it rests on. Delivery, bounces and complaints come
 * from the provider's own reports — where the provider sends none (SMTP, the
 * outbox), they are shown as "not reported" rather than as zero. Opens come
 * from an image in the email and are a lower bound on people who read it, and
 * an upper bound where mail apps open images themselves (Apple Mail Privacy
 * Protection). Clicks come from the link redirect; clicks by link scanners are
 * counted separately.
 */

import { query } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { providerStatus } from './providers.js';
import { variantResults } from './campaigns.js';

const rate = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : 0);

export const TRACKING_NOTES = [
  'Opens are counted from a small image in the email. People whose mail app blocks images are not counted, so the real number can be higher.',
  'Apple Mail and some other apps load images for everyone automatically (Mail Privacy Protection). Those opens look like people and push the number up.',
  'Clicks go through TaskFlow before reaching the page. Security scanners in some companies open every link the instant an email arrives; such clicks are marked as automatic and are not counted as people, nor do they create follow-up tasks.',
  'A click is also counted as an open, because the person read the email even if the image did not load.',
  'Replies are counted only when the reply mailbox is connected (or an inbound service posts them) and a reply can be matched to the email it answers.',
  'Conversions are counted when the website reports one, when a person records one, or when the pipeline shows a deal won or a lead becoming a customer within the campaign’s attribution window after a click.',
];

export async function campaignReport(id) {
  const { rows: campaigns } = await query(
    `SELECT c.*, a.name AS audience_name FROM mkt_campaigns c LEFT JOIN mkt_audiences a ON a.id = c.audience_id WHERE c.id = $1`, [id],
  );
  const campaign = campaigns[0];
  if (!campaign) throw notFound('Campaign not found');

  const [{ rows: totals }, { rows: skips }, { rows: events }, { rows: links }, { rows: timeline }, { rows: providers }, { rows: followups }] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS recipients,
              COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
              COUNT(*) FILTER (WHERE status IN ('QUEUED', 'SENDING', 'HELD'))::int AS waiting,
              COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
              COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
              COUNT(*) FILTER (WHERE first_opened_at IS NOT NULL)::int AS unique_opens,
              COALESCE(SUM(open_count), 0)::int AS total_opens,
              COUNT(*) FILTER (WHERE first_clicked_at IS NOT NULL)::int AS unique_clicks,
              COALESCE(SUM(click_count), 0)::int AS total_clicks,
              COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replies,
              COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int AS conversions,
              COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribes,
              COUNT(*) FILTER (WHERE complained_at IS NOT NULL)::int AS complaints,
              COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounces
         FROM mkt_messages WHERE campaign_id = $1 AND kind = 'CAMPAIGN'`,
      [id],
    ),
    query(`SELECT skip_reason, COUNT(*)::int AS n FROM mkt_messages WHERE campaign_id = $1 AND kind = 'CAMPAIGN' AND status = 'SKIPPED' GROUP BY skip_reason ORDER BY n DESC`, [id]),
    query(
      `SELECT type, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_machine)::int AS machine, COALESCE(SUM(value), 0)::numeric AS value
         FROM mkt_events WHERE campaign_id = $1 GROUP BY type`,
      [id],
    ),
    query(
      `SELECT l.id, l.url, COUNT(e.id) FILTER (WHERE NOT e.is_machine)::int AS clicks,
              COUNT(DISTINCT e.message_id) FILTER (WHERE NOT e.is_machine)::int AS people,
              COUNT(e.id) FILTER (WHERE e.is_machine)::int AS automatic
         FROM mkt_links l LEFT JOIN mkt_events e ON e.link_id = l.id AND e.type = 'CLICK'
        WHERE l.campaign_id = $1 GROUP BY l.id ORDER BY clicks DESC, l.id`,
      [id],
    ),
    query(
      `SELECT date_trunc('hour', occurred_at) AS hour,
              COUNT(*) FILTER (WHERE type = 'OPEN' AND NOT is_machine)::int AS opens,
              COUNT(*) FILTER (WHERE type = 'CLICK' AND NOT is_machine)::int AS clicks
         FROM mkt_events WHERE campaign_id = $1 AND type IN ('OPEN', 'CLICK')
        GROUP BY 1 ORDER BY 1 LIMIT 168`,
      [id],
    ),
    query(`SELECT DISTINCT provider FROM mkt_messages WHERE campaign_id = $1 AND kind = 'CAMPAIGN' AND provider IS NOT NULL`, [id]),
    query(
      `SELECT f.id, f.reason, f.created_at, t.ref AS task_ref, t.title AS task_title, ws.stage AS task_stage, u.full_name AS assignee_name,
              c.id AS contact_id, c.email, c.first_name, c.last_name
         FROM mkt_followups f JOIN mkt_contacts c ON c.id = f.contact_id LEFT JOIN tasks t ON t.id = f.task_id
         LEFT JOIN workflow_statuses ws ON ws.id = t.status_id LEFT JOIN users u ON u.id = t.assignee_id
        WHERE f.campaign_id = $1 ORDER BY f.created_at DESC`,
      [id],
    ),
  ]);
  const t = totals[0];
  const byType = Object.fromEntries(events.map((e) => [e.type, e]));
  const status = providerStatus();
  // delivery is only known where the provider used reports it
  const used = providers.map((p) => p.provider);
  const reportsDelivery = used.length ? used.every((p) => ['ses', 'brevo'].includes(p)) : Boolean(status.events?.delivery);
  const delivered = reportsDelivery ? t.delivered : null;
  const base = reportsDelivery ? t.delivered : t.sent;
  return {
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, subject: campaign.subject, audience_name: campaign.audience_name,
      started_at: campaign.started_at, completed_at: campaign.completed_at, ab_test: campaign.ab_test, send_strategy: campaign.send_strategy },
    totals: {
      ...t,
      delivered,
      hard_bounces: byType.BOUNCE_HARD?.n || 0,
      soft_bounces: byType.BOUNCE_SOFT?.n || 0,
      machine_opens: byType.OPEN?.machine || 0,
      machine_clicks: byType.CLICK?.machine || 0,
      conversion_value: Number(byType.CONVERSION?.value || 0),
    },
    rates: {
      delivery: reportsDelivery ? rate(t.delivered, t.sent) : null,
      open: rate(t.unique_opens, base),
      click: rate(t.unique_clicks, base),
      click_to_open: rate(t.unique_clicks, t.unique_opens),
      reply: rate(t.replies, base),
      conversion: rate(t.conversions, base),
      unsubscribe: rate(t.unsubscribes, base),
      bounce: rate(t.bounces, t.sent),
      complaint: rate(t.complaints, base),
    },
    base_label: reportsDelivery ? 'delivered' : 'sent',
    skipped: skips,
    links,
    timeline,
    variants: campaign.ab_test ? await variantResults(id) : [],
    followups,
    sources: {
      delivery: reportsDelivery ? 'The provider’s delivery reports' : 'Not reported by this provider',
      bounces: reportsDelivery ? 'The provider’s bounce and complaint reports' : 'Not reported by this provider',
      opens: 'TaskFlow’s open image', clicks: 'TaskFlow’s link redirect', replies: 'The reply mailbox or inbound posts',
      conversions: 'The website, the pipeline, or a person',
    },
    notes: TRACKING_NOTES,
  };
}

/** One audience, or all of them: size, growth, where people came from, how engaged they are. */
export async function audienceReport(audienceId = null) {
  const params = audienceId ? [audienceId] : [];
  const where = audienceId ? 'WHERE m.audience_id = $1' : '';
  const [status, growth, sources, engagement, campaigns, places] = await Promise.all([
    query(`SELECT m.status, COUNT(*)::int AS n FROM mkt_memberships m ${where} GROUP BY m.status`, params),
    query(
      `SELECT date_trunc('week', k.created_at)::date AS week,
              COUNT(*) FILTER (WHERE k.action IN ('SUBSCRIBE', 'CONFIRM', 'RESUBSCRIBE'))::int AS joined,
              COUNT(*) FILTER (WHERE k.action IN ('UNSUBSCRIBE', 'UNSUBSCRIBE_ALL'))::int AS left_
         FROM mkt_consents k
        WHERE k.created_at > now() - interval '26 weeks' ${audienceId ? 'AND (k.audience_id = $1 OR (k.audience_id IS NULL AND k.action = \'UNSUBSCRIBE_ALL\' AND EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = k.contact_id AND m.audience_id = $1)))' : ''}
        GROUP BY 1 ORDER BY 1`,
      params,
    ),
    query(`SELECT m.source, COUNT(*)::int AS n FROM mkt_memberships m ${where} ${where ? 'AND' : 'WHERE'} m.status = 'SUBSCRIBED' GROUP BY m.source ORDER BY n DESC`, params),
    query(
      `SELECT CASE WHEN c.engagement_score >= 60 THEN 'High' WHEN c.engagement_score >= 25 THEN 'Medium'
                   WHEN c.engagement_score > 0 THEN 'Low' ELSE 'None yet' END AS band, COUNT(*)::int AS n
         FROM mkt_memberships m JOIN mkt_contacts c ON c.id = m.contact_id ${where} ${where ? 'AND' : 'WHERE'} m.status = 'SUBSCRIBED'
        GROUP BY 1`,
      params,
    ),
    query(
      `SELECT c.id, c.name, c.started_at, c.recipient_count,
              COUNT(m.id) FILTER (WHERE m.sent_at IS NOT NULL)::int AS sent,
              COUNT(m.id) FILTER (WHERE m.first_opened_at IS NOT NULL)::int AS opened,
              COUNT(m.id) FILTER (WHERE m.first_clicked_at IS NOT NULL)::int AS clicked,
              COUNT(m.id) FILTER (WHERE m.unsubscribed_at IS NOT NULL)::int AS unsubscribed
         FROM mkt_campaigns c LEFT JOIN mkt_messages m ON m.campaign_id = c.id AND m.kind = 'CAMPAIGN'
        WHERE c.started_at IS NOT NULL ${audienceId ? 'AND c.audience_id = $1' : ''}
        GROUP BY c.id ORDER BY c.started_at DESC LIMIT 12`,
      params,
    ),
    query(
      `SELECT COALESCE(NULLIF(c.state, ''), 'Not recorded') AS state, COUNT(*)::int AS n
         FROM mkt_memberships m JOIN mkt_contacts c ON c.id = m.contact_id ${where} ${where ? 'AND' : 'WHERE'} m.status = 'SUBSCRIBED'
        GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      params,
    ),
  ]);
  return {
    status: Object.fromEntries(status.rows.map((r) => [r.status, r.n])),
    growth: growth.rows.map((r) => ({ week: r.week, joined: r.joined, left: r.left_ })),
    sources: sources.rows,
    engagement: engagement.rows,
    campaigns: campaigns.rows.map((r) => ({ ...r, open_rate: rate(r.opened, r.sent), click_rate: rate(r.clicked, r.sent) })),
    places: places.rows,
  };
}

/** The front page: last 30 days, what is coming, and anything needing attention. */
export async function overview() {
  const [totals, upcoming, review, health, contacts, followups, deadlines] = await Promise.all([
    query(
      `SELECT COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
              COUNT(*) FILTER (WHERE first_opened_at IS NOT NULL)::int AS opened,
              COUNT(*) FILTER (WHERE first_clicked_at IS NOT NULL)::int AS clicked,
              COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
              COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted,
              COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced,
              COUNT(*) FILTER (WHERE complained_at IS NOT NULL)::int AS complained,
              COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed
         FROM mkt_messages WHERE kind IN ('CAMPAIGN', 'AUTOMATION') AND queued_at > now() - interval '30 days'`,
    ),
    query(`SELECT id, name, status, scheduled_at, audience_id FROM mkt_campaigns WHERE status IN ('SCHEDULED', 'SENDING', 'TESTING', 'PAUSED') ORDER BY scheduled_at NULLS LAST LIMIT 10`),
    query(`SELECT id, name, submitted_at FROM mkt_campaigns WHERE status = 'IN_REVIEW' ORDER BY submitted_at`),
    query(
      `SELECT (SELECT COUNT(*)::int FROM mkt_suppressions) AS suppressed,
              (SELECT COUNT(*)::int FROM mkt_messages WHERE status = 'FAILED' AND queued_at > now() - interval '7 days') AS failed_7d,
              (SELECT COUNT(*)::int FROM mkt_messages WHERE status = 'QUEUED') AS queued`,
    ),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = mkt_contacts.id AND m.status = 'SUBSCRIBED'))::int AS subscribed
         FROM mkt_contacts WHERE is_archived = FALSE`,
    ),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ws.stage NOT IN ('done', 'cancelled'))::int AS open
         FROM mkt_followups f LEFT JOIN tasks t ON t.id = f.task_id LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
        WHERE f.created_at > now() - interval '30 days'`,
    ),
    query(
      `SELECT id, name, status, deadline FROM mkt_campaigns
        WHERE deadline IS NOT NULL AND status IN ('DRAFT', 'IN_REVIEW', 'APPROVED') AND deadline < now() + interval '7 days'
        ORDER BY deadline LIMIT 10`,
    ),
  ]);
  const t = totals.rows[0];
  return {
    last30: { ...t, open_rate: rate(t.opened, t.sent), click_rate: rate(t.clicked, t.sent), bounce_rate: rate(t.bounced, t.sent), complaint_rate: rate(t.complained, t.sent) },
    upcoming: upcoming.rows,
    waiting_for_review: review.rows,
    health: health.rows[0],
    contacts: contacts.rows[0],
    followups: followups.rows[0],
    deadlines: deadlines.rows,
    provider: providerStatus(),
  };
}

// ---------------------------------------------------------------- exports

export async function campaignRecipientsCsv(id) {
  const { rows } = await query(
    `SELECT m.email, c.first_name, c.last_name, c.organization, m.variant, m.status, m.skip_reason, m.sent_at, m.delivered_at,
            m.first_opened_at, m.open_count, m.first_clicked_at, m.click_count, m.replied_at, m.converted_at, m.unsubscribed_at,
            m.bounced_at, m.complained_at, m.last_error
       FROM mkt_messages m LEFT JOIN mkt_contacts c ON c.id = m.contact_id
      WHERE m.campaign_id = $1 AND m.kind = 'CAMPAIGN' ORDER BY m.id`,
    [id],
  );
  const header = ['Email', 'First name', 'Last name', 'Organization', 'Version', 'Status', 'Skipped because', 'Sent', 'Delivered',
    'First opened', 'Opens', 'First clicked', 'Clicks', 'Replied', 'Converted', 'Unsubscribed', 'Bounced', 'Marked as spam', 'Error'];
  return { header, rows: rows.map((r) => [r.email, r.first_name, r.last_name, r.organization, r.variant, r.status, r.skip_reason, r.sent_at,
    r.delivered_at, r.first_opened_at, r.open_count, r.first_clicked_at, r.click_count, r.replied_at, r.converted_at, r.unsubscribed_at,
    r.bounced_at, r.complained_at, r.last_error]) };
}

export async function campaignEventsCsv(id) {
  const { rows } = await query(
    `SELECT e.occurred_at, e.type, m.email, e.url, e.source, e.is_machine, e.value
       FROM mkt_events e LEFT JOIN mkt_messages m ON m.id = e.message_id WHERE e.campaign_id = $1 ORDER BY e.occurred_at`,
    [id],
  );
  return {
    header: ['When', 'What', 'Email', 'Link', 'Reported by', 'Automatic (not a person)', 'Value'],
    rows: rows.map((r) => [r.occurred_at, r.type, r.email, r.url, r.source, r.is_machine, r.value === null ? null : Number(r.value)]),
  };
}

export async function contactsCsv({ audienceId = null, ids = null } = {}) {
  const { rows: fields } = await query('SELECT key, label FROM mkt_fields ORDER BY position, id');
  const { rows } = await query(
    `SELECT c.*, a.name AS account_name,
            (SELECT string_agg(au.name || ': ' || m.status, '; ' ORDER BY au.name) FROM mkt_memberships m JOIN mkt_audiences au ON au.id = m.audience_id WHERE m.contact_id = c.id) AS audiences
       FROM mkt_contacts c LEFT JOIN accounts a ON a.id = c.account_id
      WHERE c.is_archived = FALSE
        AND ($1::int IS NULL OR EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.audience_id = $1))
        AND ($2::int[] IS NULL OR c.id = ANY($2::int[]))
      ORDER BY c.id`,
    [audienceId, ids],
  );
  const header = ['Email', 'First name', 'Last name', 'Phone', 'Organization', 'Designation', 'City', 'State', 'Country', 'Language',
    'Tags', 'Audiences', 'Email status', 'Engagement score', 'Last opened', 'Last clicked', 'Pipeline organization', 'Added', 'How added',
    ...fields.map((f) => f.label)];
  return { header, rows: rows.map((r) => [r.email, r.first_name, r.last_name, r.phone, r.organization, r.designation, r.city, r.state, r.country,
    r.language, (r.tags || []).join(', '), r.audiences, r.email_status, r.engagement_score, r.last_opened_at, r.last_clicked_at,
    r.account_name, r.created_at, r.source, ...fields.map((f) => r.custom?.[f.key] ?? '')]) };
}

export async function consentsCsv() {
  const { rows } = await query(
    `SELECT k.created_at, c.email, k.action, a.name AS audience, t.name AS topic, k.source, k.basis, k.consent_text, k.ip, u.full_name AS actor
       FROM mkt_consents k JOIN mkt_contacts c ON c.id = k.contact_id LEFT JOIN mkt_audiences a ON a.id = k.audience_id
       LEFT JOIN mkt_topics t ON t.id = k.topic_id LEFT JOIN users u ON u.id = k.actor_id
      ORDER BY k.created_at DESC LIMIT 100000`,
  );
  return {
    header: ['When', 'Email', 'What', 'Audience', 'Topic', 'How', 'Basis', 'Words agreed to', 'IP address', 'By'],
    rows: rows.map((r) => [r.created_at, r.email, r.action, r.audience, r.topic, r.source, r.basis, r.consent_text, r.ip, r.actor]),
  };
}

export async function suppressionsCsv() {
  const { rows } = await query('SELECT email_normalized, reason, source, note, created_at FROM mkt_suppressions ORDER BY created_at DESC');
  return { header: ['Email', 'Reason', 'Source', 'Note', 'Since'], rows: rows.map((r) => [r.email_normalized, r.reason, r.source, r.note, r.created_at]) };
}
