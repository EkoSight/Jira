/**
 * Campaigns: from draft to sent.
 *
 *   DRAFT → IN_REVIEW → APPROVED → SCHEDULED → SENDING (or TESTING for an A/B
 *   test) → SENT.  Also PAUSED and CANCELLED.
 *
 * Approval is of exactly what the approver saw: any later change to the
 * content, sender or recipients sends it back to draft. Recipients are worked
 * out when sending starts, not when it was scheduled, so anyone who left in
 * between is not mailed — and each person is checked once more as their own
 * email goes.
 */

import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { nextTaskRef } from '../../lib/taskRef.js';
import { checkDesign } from '../../lib/emailRender.js';
import { notify, logActivity as logTaskActivity } from '../activity.js';
import { instantAtLocal, localParts, marketingSettings, newReplyCode, newToken } from './core.js';
import { compileRules } from './segments.js';
import { providerStatus } from './providers.js';
import { senderAllowed, senderFor } from './queue.js';

const CONTENT_FIELDS = ['subject', 'subject_hi', 'preheader', 'preheader_hi', 'from_name', 'from_email', 'reply_to', 'design',
  'audience_id', 'segment_id', 'topic_id', 'ab_test', 'track_opens', 'track_clicks'];
const OTHER_FIELDS = ['name', 'owner_user_id', 'task_id', 'deadline', 'follow_up', 'conversion_window_days', 'send_strategy'];
const VARIANT_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export async function getCampaign(id) {
  const { rows } = await query(
    `SELECT c.*, a.name AS audience_name, s.name AS segment_name, t.name AS topic_name,
            o.full_name AS owner_name, sb.full_name AS submitted_by_name, ap.full_name AS approved_by_name,
            tk.ref AS task_ref, tk.title AS task_title, tk.due_date AS task_due
       FROM mkt_campaigns c
       LEFT JOIN mkt_audiences a ON a.id = c.audience_id
       LEFT JOIN mkt_segments s ON s.id = c.segment_id
       LEFT JOIN mkt_topics t ON t.id = c.topic_id
       LEFT JOIN users o ON o.id = c.owner_user_id
       LEFT JOIN users sb ON sb.id = c.submitted_by
       LEFT JOIN users ap ON ap.id = c.approved_by
       LEFT JOIN tasks tk ON tk.id = c.task_id
      WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Campaign not found');
  const { rows: variants } = await query('SELECT * FROM mkt_campaign_variants WHERE campaign_id = $1 ORDER BY key', [id]);
  return { ...rows[0], variants };
}

/** A hash of everything the approver approves: content, sender and recipients. */
export function fingerprint(campaign, variants = campaign.variants || []) {
  const essence = {
    ...Object.fromEntries(CONTENT_FIELDS.map((f) => [f, campaign[f] ?? null])),
    variants: variants.map((v) => ({ key: v.key, subject: v.subject, subject_hi: v.subject_hi, preheader: v.preheader, from_name: v.from_name, design: v.design })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(essence)).digest('hex');
}

export async function listCampaigns({ status = null, search = '', limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT c.id, c.name, c.status, c.subject, c.audience_id, a.name AS audience_name, c.owner_user_id, o.full_name AS owner_name,
            c.scheduled_at, c.started_at, c.completed_at, c.deadline, c.recipient_count, c.ab_test IS NOT NULL AS is_ab,
            c.send_strategy, c.created_at, c.updated_at, c.task_id, tk.ref AS task_ref,
            (SELECT COUNT(*)::int FROM mkt_messages m WHERE m.campaign_id = c.id AND m.kind = 'CAMPAIGN' AND m.sent_at IS NOT NULL) AS sent,
            (SELECT COUNT(*)::int FROM mkt_messages m WHERE m.campaign_id = c.id AND m.kind = 'CAMPAIGN' AND m.first_opened_at IS NOT NULL) AS opened,
            (SELECT COUNT(*)::int FROM mkt_messages m WHERE m.campaign_id = c.id AND m.kind = 'CAMPAIGN' AND m.first_clicked_at IS NOT NULL) AS clicked,
            (SELECT COUNT(*)::int FROM mkt_messages m WHERE m.campaign_id = c.id AND m.kind = 'CAMPAIGN' AND m.replied_at IS NOT NULL) AS replied
       FROM mkt_campaigns c
       LEFT JOIN mkt_audiences a ON a.id = c.audience_id
       LEFT JOIN users o ON o.id = c.owner_user_id
       LEFT JOIN tasks tk ON tk.id = c.task_id
      WHERE c.is_archived = FALSE AND ($1::text IS NULL OR c.status = $1)
        AND ($2 = '' OR lower(c.name) LIKE '%' || lower($2) || '%' OR lower(COALESCE(c.subject,'')) LIKE '%' || lower($2) || '%')
      ORDER BY COALESCE(c.scheduled_at, c.started_at, c.created_at) DESC
      LIMIT $3`,
    [status, search, limit],
  );
  return rows;
}

function cleanAbTest(ab) {
  if (!ab) return null;
  const metric = ['OPENS', 'CLICKS', 'REPLIES', 'MANUAL'].includes(ab.metric) ? ab.metric : 'CLICKS';
  const testPercent = Math.min(Math.max(Math.round(Number(ab.test_percent) || 20), 5), 100);
  const waitHours = Math.min(Math.max(Number(ab.wait_hours) || 4, 1), 168);
  return { metric, test_percent: testPercent, wait_hours: waitHours, winner: ab.winner ?? null, decided_at: ab.decided_at ?? null };
}

async function createPrepTask(client, campaign, actor) {
  const ownerId = campaign.owner_user_id || actor.id;
  const { rows: owners } = await client.query('SELECT id, department_id FROM users WHERE id = $1', [ownerId]);
  const settings = await marketingSettings();
  let departmentId = owners[0]?.department_id || settings.followUps?.departmentId;
  if (!departmentId) departmentId = (await client.query('SELECT id FROM departments ORDER BY position, id LIMIT 1')).rows[0]?.id;
  const { rows: statuses } = await client.query('SELECT id FROM workflow_statuses WHERE is_active = TRUE ORDER BY is_default DESC, position ASC LIMIT 1');
  if (!departmentId || !statuses[0]) return null;
  const due = campaign.deadline ? new Date(campaign.deadline) : new Date(Date.now() + 7 * 86_400_000);
  const ref = await nextTaskRef(client, departmentId);
  const { rows } = await client.query(
    `INSERT INTO tasks (ref, title, description, department_id, status_id, priority, task_type, assignee_id, reporter_id, created_by,
                        due_date, original_due_date, tags, position)
     VALUES ($1,$2,$3,$4,$5,'medium','campaign',$6,$7,$7,$8,$8,ARRAY['email-campaign'],
             (SELECT COALESCE(MAX(position),0)+100 FROM tasks WHERE status_id = $5))
     RETURNING *`,
    [ref, `Prepare and send the email campaign “${campaign.name}”`.slice(0, 240),
      'Write it, test it, get it approved and schedule it, under Email marketing → Campaigns.',
      departmentId, statuses[0].id, ownerId, actor.id, due],
  );
  await logTaskActivity(client, { taskId: rows[0].id, actorId: actor.id, action: 'created', meta: { source: 'email_marketing', campaign_id: campaign.id } });
  if (ownerId !== actor.id) {
    await notify(client, { userId: ownerId, type: 'assigned', title: 'New email campaign to prepare', body: campaign.name, taskId: rows[0].id });
  }
  return rows[0];
}

async function saveVariants(client, campaignId, variants) {
  if (variants === undefined) return;
  const list = (variants || []).slice(0, VARIANT_KEYS.length).map((v, i) => ({ ...v, key: VARIANT_KEYS[i] }));
  await client.query('DELETE FROM mkt_campaign_variants WHERE campaign_id = $1 AND NOT (key = ANY($2::text[]))', [campaignId, list.map((v) => v.key)]);
  for (const v of list) {
    await client.query(
      `INSERT INTO mkt_campaign_variants (campaign_id, key, subject, subject_hi, preheader, from_name, design)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (campaign_id, key) DO UPDATE SET subject = EXCLUDED.subject, subject_hi = EXCLUDED.subject_hi,
         preheader = EXCLUDED.preheader, from_name = EXCLUDED.from_name, design = EXCLUDED.design`,
      [campaignId, v.key, v.subject || null, v.subject_hi || null, v.preheader || null, v.from_name || null, v.design || null],
    );
  }
}

/** Creates or edits a campaign. A change to what was approved sends it back to draft. */
export async function saveCampaign(id, input, actor) {
  return withTransaction(async (client) => {
    const values = {};
    for (const f of [...CONTENT_FIELDS, ...OTHER_FIELDS]) if (input[f] !== undefined) values[f] = input[f];
    if (values.ab_test !== undefined) values.ab_test = cleanAbTest(values.ab_test);
    if (values.send_strategy && !['NOW', 'SCHEDULED', 'OPTIMIZED'].includes(values.send_strategy)) throw badRequest('Unknown way of sending');
    if (values.design !== undefined && (!values.design || !Array.isArray(values.design.blocks))) throw badRequest('The email content is not a design');
    if (values.task_id) {
      const { rows } = await client.query('SELECT id FROM tasks WHERE id = $1', [values.task_id]);
      if (!rows[0]) throw badRequest('That task does not exist');
    }

    if (!id) {
      if (!String(values.name || '').trim()) throw badRequest('Give the campaign a name');
      const insert = { ...values, created_by: actor.id };
      if (!insert.owner_user_id) insert.owner_user_id = actor.id;
      const cols = Object.keys(insert);
      const { rows } = await client.query(
        `INSERT INTO mkt_campaigns (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((c) => insert[c]),
      );
      const campaign = rows[0];
      await saveVariants(client, campaign.id, input.variants);
      if (input.create_task && !campaign.task_id) {
        const task = await createPrepTask(client, campaign, actor);
        if (task) await client.query('UPDATE mkt_campaigns SET task_id = $2 WHERE id = $1', [campaign.id, task.id]);
      }
      return campaign.id;
    }

    const { rows: currentRows } = await client.query('SELECT * FROM mkt_campaigns WHERE id = $1 FOR UPDATE', [id]);
    const current = currentRows[0];
    if (!current) throw notFound('Campaign not found');
    const { rows: oldVariants } = await client.query('SELECT * FROM mkt_campaign_variants WHERE campaign_id = $1 ORDER BY key', [id]);
    const touchesContent = CONTENT_FIELDS.some((f) => values[f] !== undefined) || input.variants !== undefined;
    if (touchesContent && ['SENDING', 'TESTING', 'SENT', 'CANCELLED', 'PAUSED'].includes(current.status)) {
      throw conflict('This campaign has started sending; its content and recipients can no longer change. Duplicate it to send a new version.');
    }
    const sets = [];
    const params = [id];
    for (const [k, v] of Object.entries(values)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    if (sets.length) await client.query(`UPDATE mkt_campaigns SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    await saveVariants(client, id, input.variants);
    if (input.create_task && !current.task_id) {
      const task = await createPrepTask(client, { ...current, ...values }, actor);
      if (task) await client.query('UPDATE mkt_campaigns SET task_id = $2 WHERE id = $1', [id, task.id]);
    }

    if (touchesContent && ['IN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(current.status)) {
      const { rows: after } = await client.query('SELECT * FROM mkt_campaigns WHERE id = $1', [id]);
      const { rows: newVariants } = await client.query('SELECT * FROM mkt_campaign_variants WHERE campaign_id = $1 ORDER BY key', [id]);
      if (fingerprint(after[0], newVariants) !== fingerprint(current, oldVariants)) {
        await client.query(
          `UPDATE mkt_campaigns SET status = 'DRAFT', approved_by = NULL, approved_at = NULL, approved_fingerprint = NULL,
                  scheduled_at = CASE WHEN status = 'SCHEDULED' THEN NULL ELSE scheduled_at END,
                  review_note = 'Changed after it was sent for review, so it needs approving again'
            WHERE id = $1`,
          [id],
        );
      }
    }
    return id;
  }).then((campaignId) => getCampaign(campaignId));
}

// ---------------------------------------------------------------- recipients

/** The WHERE clause for who a campaign goes to, as it stands now. */
export function recipientWhere(campaign, segmentRules, params) {
  const conds = [
    'c.is_archived = FALSE', "c.email_status = 'ACTIVE'", 'c.unsubscribed_all_at IS NULL',
    'NOT EXISTS (SELECT 1 FROM mkt_suppressions s WHERE s.email_normalized = c.email_normalized)',
  ];
  if (campaign.audience_id) {
    params.push(campaign.audience_id);
    conds.push(`EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.audience_id = $${params.length} AND m.status = 'SUBSCRIBED')`);
  } else {
    conds.push(`EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.status = 'SUBSCRIBED')`);
  }
  if (campaign.topic_id) {
    params.push(campaign.topic_id);
    conds.push(`NOT EXISTS (SELECT 1 FROM mkt_contact_topics t WHERE t.contact_id = c.id AND t.topic_id = $${params.length} AND t.opted_in = FALSE)`);
  }
  if (segmentRules) conds.push(`(${compileRules(segmentRules, params)})`);
  return conds.join(' AND ');
}

async function segmentRulesFor(campaign) {
  if (!campaign.segment_id) return null;
  const { rows } = await query('SELECT rules FROM mkt_segments WHERE id = $1', [campaign.segment_id]);
  return rows[0]?.rules || null;
}

export async function countRecipients(campaign) {
  const params = [];
  const where = recipientWhere(campaign, await segmentRulesFor(campaign), params);
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM mkt_contacts c WHERE ${where}`, params);
  return rows[0].n;
}

/** Everything to fix, and to think about, before this campaign can go. */
export async function reviewChecks(campaign) {
  const settings = await marketingSettings();
  const problems = [];
  const warnings = [];
  const { rows: fields } = await query('SELECT key FROM mkt_fields');
  const languages = campaign.subject_hi || JSON.stringify(campaign.design).includes('"hi":"') ? ['en', 'hi'] : ['en'];
  const design = checkDesign(campaign.design, { subject: campaign.subject, subjectHi: campaign.subject_hi, languages, customKeys: fields.map((f) => f.key) });
  problems.push(...design.problems);
  warnings.push(...design.warnings);
  for (const v of campaign.variants || []) {
    if (v.design) {
      const c = checkDesign(v.design, { subject: v.subject || campaign.subject, languages, customKeys: fields.map((f) => f.key) });
      problems.push(...c.problems.map((p) => `Version ${v.key}: ${p}`));
    }
  }
  if (!campaign.audience_id && !campaign.segment_id) problems.push('Choose an audience or a segment to send to');
  const audience = campaign.audience_id ? (await query('SELECT * FROM mkt_audiences WHERE id = $1', [campaign.audience_id])).rows[0] : null;
  const sender = senderFor({ campaign, audience, settings });
  if (!sender.from) problems.push('No sender address: set one on the campaign, its audience or in Settings');
  else if (!senderAllowed(sender.from, settings)) problems.push(`${sender.from} is not on the list of approved senders (Settings)`);
  if (!settings.postalAddress) problems.push('The postal address for the email footer is not set (Settings). The law and the big mailbox providers expect it.');
  if (!sender.replyTo) warnings.push('No reply-to address: replies go to the sender address, and may not be read');
  if (campaign.ab_test) {
    if ((campaign.variants || []).length < 2) problems.push('An A/B test needs at least two versions');
  }
  const recipients = await countRecipients(campaign);
  if (!recipients) problems.push('Nobody would receive it: the audience or segment has no subscribed contacts');
  const status = providerStatus();
  if (!status.configured) warnings.push(`Sending is not set up on the server yet (${status.missing.join(', ')})`);
  else if (!status.delivers) warnings.push('The server is set to the outbox only: emails are recorded, not delivered');
  if (!status.events?.bounce && status.delivers) warnings.push('This provider does not report bounces or complaints to TaskFlow; they will not be suppressed automatically');
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)], recipients, sender };
}

// ---------------------------------------------------------------- approval

async function approversExcept(userId) {
  const { rows } = await query('SELECT id, role, extra_permissions, revoked_permissions FROM users WHERE is_active AND id <> $1', [userId]);
  return rows.filter((u) => hasPermission(u, 'marketing.approve'));
}

export async function submitForReview(id, actor) {
  const campaign = await getCampaign(id);
  if (campaign.status !== 'DRAFT') throw conflict('Only a draft can be sent for review');
  const checks = await reviewChecks(campaign);
  if (checks.problems.length) throw badRequest(`Fix these first: ${checks.problems.join('; ')}`, { problems: checks.problems });
  const settings = await marketingSettings();
  const print = fingerprint(campaign);
  if (!settings.approvals?.required) {
    await query(
      `UPDATE mkt_campaigns SET status = 'APPROVED', submitted_by = $2, submitted_at = now(), approved_by = $2, approved_at = now(),
              approved_fingerprint = $3, review_note = 'Approval is switched off in Settings', updated_at = now() WHERE id = $1`,
      [id, actor.id, print],
    );
    return getCampaign(id);
  }
  await query(
    `UPDATE mkt_campaigns SET status = 'IN_REVIEW', submitted_by = $2, submitted_at = now(), review_note = NULL, updated_at = now() WHERE id = $1`,
    [id, actor.id],
  );
  for (const approver of await approversExcept(actor.id)) {
    await notify(null, { userId: approver.id, type: 'marketing_review', title: 'An email campaign is waiting for your approval', body: `${campaign.name} — sent by ${actor.full_name}` });
  }
  return getCampaign(id);
}

export async function approveCampaign(id, actor, note = null) {
  if (!hasPermission(actor, 'marketing.approve')) throw forbidden('Requires permission: marketing.approve');
  const settings = await marketingSettings();
  const campaign = await getCampaign(id);
  if (campaign.status !== 'IN_REVIEW') throw conflict('This campaign is not waiting for approval');
  if (campaign.submitted_by === actor.id && !settings.approvals?.allowSelfApproval) {
    throw forbidden('Someone other than the person who sent it for review approves it');
  }
  const checks = await reviewChecks(campaign);
  if (checks.problems.length) throw badRequest(`It cannot be approved yet: ${checks.problems.join('; ')}`);
  await query(
    `UPDATE mkt_campaigns SET status = 'APPROVED', approved_by = $2, approved_at = now(), approved_fingerprint = $3, review_note = $4, updated_at = now()
      WHERE id = $1`,
    [id, actor.id, fingerprint(campaign), note],
  );
  if (campaign.submitted_by) await notify(null, { userId: campaign.submitted_by, type: 'marketing_review', title: 'Your email campaign was approved', body: campaign.name });
  return getCampaign(id);
}

export async function requestChanges(id, actor, note) {
  if (!hasPermission(actor, 'marketing.approve')) throw forbidden('Requires permission: marketing.approve');
  if (!String(note || '').trim()) throw badRequest('Say what needs to change');
  const campaign = await getCampaign(id);
  if (!['IN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(campaign.status)) throw conflict('This campaign is not waiting for approval');
  await query(
    `UPDATE mkt_campaigns SET status = 'DRAFT', approved_by = NULL, approved_at = NULL, approved_fingerprint = NULL, scheduled_at = NULL,
            review_note = $2, updated_at = now() WHERE id = $1`,
    [id, note.trim()],
  );
  if (campaign.submitted_by) await notify(null, { userId: campaign.submitted_by, type: 'marketing_review', title: 'Changes asked for on your email campaign', body: `${campaign.name}: ${note.trim()}` });
  return getCampaign(id);
}

// ---------------------------------------------------------------- scheduling and sending

export async function scheduleCampaign(id, { at = null, strategy = null }, actor) {
  const campaign = await getCampaign(id);
  if (!['APPROVED', 'SCHEDULED'].includes(campaign.status)) throw conflict('Only an approved campaign can be scheduled');
  if (fingerprint(campaign) !== campaign.approved_fingerprint) throw conflict('It changed after approval; send it for review again');
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) throw badRequest('That is not a date and time');
  if (when.getTime() < Date.now() - 60_000) throw badRequest('Choose a time in the future');
  const status = providerStatus();
  if (!status.configured) throw badRequest(`Sending is not set up on the server: ${status.missing.join(', ')}`);
  await query(
    `UPDATE mkt_campaigns SET status = 'SCHEDULED', scheduled_at = $2, send_strategy = COALESCE($3, send_strategy), updated_at = now() WHERE id = $1`,
    [id, when, strategy],
  );
  void actor;
  // "send now" starts at once rather than waiting for the next pass of the worker
  if (when.getTime() <= Date.now() + 5_000) await startCampaign(id);
  return getCampaign(id);
}

export async function unscheduleCampaign(id) {
  const { rowCount } = await query(`UPDATE mkt_campaigns SET status = 'APPROVED', scheduled_at = NULL, updated_at = now() WHERE id = $1 AND status = 'SCHEDULED'`, [id]);
  if (!rowCount) throw conflict('This campaign is not scheduled');
  return getCampaign(id);
}

/** Splits recipients across versions: the first `testPercent` share is tested, the rest waits for the winner. */
export function splitForTest(count, variantKeys, testPercent) {
  if (!variantKeys.length) return { assignments: Array(count).fill(null), held: 0 };
  const testCount = testPercent >= 100 ? count : Math.max(variantKeys.length, Math.round((count * testPercent) / 100));
  const assignments = [];
  for (let i = 0; i < count; i += 1) assignments.push(i < Math.min(testCount, count) ? variantKeys[i % variantKeys.length] : null);
  return { assignments, held: Math.max(0, count - testCount) };
}

/** The send time for a person under send-time optimization: their hour, within a day of the start. */
export function optimizedTime(start, hour, timeZone = 'Asia/Kolkata') {
  const { date, hour: startHour } = localParts(start, timeZone);
  let at = instantAtLocal(date, hour, timeZone);
  if (hour < startHour || at < start) at = new Date(at.getTime() + 86_400_000);
  if (at < start) at = start;
  return at;
}

/** Works out who it goes to, now, and queues one message each. */
export async function startCampaign(id) {
  const settings = await marketingSettings();
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM mkt_campaigns WHERE id = $1 FOR UPDATE', [id]);
    const campaign = rows[0];
    if (!campaign || campaign.status !== 'SCHEDULED') return { started: false };
    const { rows: variants } = await client.query('SELECT * FROM mkt_campaign_variants WHERE campaign_id = $1 ORDER BY key', [id]);
    if (fingerprint(campaign, variants) !== campaign.approved_fingerprint) {
      await client.query(`UPDATE mkt_campaigns SET status = 'DRAFT', review_note = 'Changed after approval, so it was not sent' WHERE id = $1`, [id]);
      return { started: false, reason: 'changed' };
    }
    const segment = campaign.segment_id ? (await client.query('SELECT rules FROM mkt_segments WHERE id = $1', [campaign.segment_id])).rows[0]?.rules : null;
    const params = [];
    const where = recipientWhere(campaign, segment, params);
    params.push(String(id));
    // a fixed shuffle, so the A/B split is random but the same if it is ever recomputed
    const { rows: people } = await client.query(
      `SELECT c.id, c.email, c.best_send_hour FROM mkt_contacts c WHERE ${where} ORDER BY md5(c.id::text || $${params.length})`,
      params,
    );
    const start = new Date(Math.max(Date.now(), new Date(campaign.scheduled_at || Date.now()).getTime()));
    const ab = campaign.ab_test && variants.length >= 2 ? campaign.ab_test : null;
    const keys = ab ? variants.map((v) => v.key) : [];
    const { assignments, held } = splitForTest(people.length, keys, ab ? ab.test_percent : 100);

    let defaultHour = Number(settings.sto?.defaultHour ?? 10);
    if (campaign.send_strategy === 'OPTIMIZED') {
      const hours = people.map((p) => p.best_send_hour).filter((h) => h !== null);
      if (hours.length >= 5) {
        const counts = new Map();
        hours.forEach((h) => counts.set(h, (counts.get(h) || 0) + 1));
        defaultHour = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      }
    }

    const ids = []; const emails = []; const tokens = []; const codes = []; const variantCol = []; const statuses = []; const times = [];
    people.forEach((p, i) => {
      ids.push(p.id); emails.push(p.email); tokens.push(newToken()); codes.push(newReplyCode());
      variantCol.push(assignments[i]);
      statuses.push(ab && assignments[i] === null ? 'HELD' : 'QUEUED');
      times.push(campaign.send_strategy === 'OPTIMIZED' && !(ab && assignments[i] === null)
        ? optimizedTime(start, p.best_send_hour ?? defaultHour, settings.timezone).toISOString()
        : start.toISOString());
    });
    if (ids.length) {
      await client.query(
        `INSERT INTO mkt_messages (kind, campaign_id, audience_id, contact_id, email, token, reply_code, variant, status, scheduled_for)
         SELECT 'CAMPAIGN', $1, $2, x.contact_id, x.email, x.token, x.code, x.variant, x.status, x.at::timestamptz
           FROM unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
                AS x(contact_id, email, token, code, variant, status, at)
         ON CONFLICT (campaign_id, contact_id) WHERE kind = 'CAMPAIGN' DO NOTHING`,
        [id, campaign.audience_id, ids, emails, tokens, codes, variantCol, statuses, times],
      );
    }
    const testing = ab && held > 0;
    await client.query(
      `UPDATE mkt_campaigns SET status = $2, started_at = now(), recipient_count = $3,
              ab_test = CASE WHEN ab_test IS NULL THEN NULL ELSE ab_test || jsonb_build_object('test_started_at', now()) END,
              updated_at = now()
        WHERE id = $1`,
      [id, testing ? 'TESTING' : 'SENDING', people.length],
    );
    if (campaign.task_id) {
      await client.query('INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, NULL, $2)',
        [campaign.task_id, `Email campaign started: ${people.length} recipient(s)${testing ? `, testing ${variants.length} versions first` : ''}.`]);
    }
    return { started: true, recipients: people.length, held };
  });
}

/** For each version of an A/B test: sent, and unique human opens, clicks and replies. */
export async function variantResults(campaignId) {
  const { rows } = await query(
    `SELECT m.variant,
            COUNT(*) FILTER (WHERE m.sent_at IS NOT NULL)::int AS sent,
            COUNT(*) FILTER (WHERE m.first_opened_at IS NOT NULL)::int AS opened,
            COUNT(*) FILTER (WHERE m.first_clicked_at IS NOT NULL)::int AS clicked,
            COUNT(*) FILTER (WHERE m.replied_at IS NOT NULL)::int AS replied,
            COUNT(*) FILTER (WHERE m.converted_at IS NOT NULL)::int AS converted
       FROM mkt_messages m WHERE m.campaign_id = $1 AND m.kind = 'CAMPAIGN' AND m.variant IS NOT NULL
      GROUP BY m.variant ORDER BY m.variant`,
    [campaignId],
  );
  return rows;
}

/** The winning version by the test's measure; ties go to the earlier version. */
export function pickWinner(results, metric) {
  const field = { OPENS: 'opened', CLICKS: 'clicked', REPLIES: 'replied' }[metric] || 'clicked';
  let best = null;
  for (const r of results) {
    const rate = r.sent ? r[field] / r.sent : 0;
    if (!best || rate > best.rate) best = { key: r.variant, rate };
  }
  return best?.key || null;
}

/** Sends the rest of an A/B test to the winning version. */
export async function finishTest(id, { winner = null, actor = null } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM mkt_campaigns WHERE id = $1 FOR UPDATE', [id]);
    const campaign = rows[0];
    if (!campaign || !['TESTING', 'PAUSED'].includes(campaign.status) || !campaign.ab_test) throw conflict('This campaign is not running an A/B test');
    const chosen = winner || pickWinner(await variantResults(id), campaign.ab_test.metric);
    if (!chosen) throw badRequest('No version has results yet');
    await client.query(
      `UPDATE mkt_messages SET variant = $2, status = 'QUEUED', scheduled_for = now() WHERE campaign_id = $1 AND kind = 'CAMPAIGN' AND status = 'HELD'`,
      [id, chosen],
    );
    await client.query(
      `UPDATE mkt_campaigns SET status = 'SENDING',
              ab_test = ab_test || jsonb_build_object('winner', $2::text, 'decided_at', now(), 'decided_by', $3::int),
              updated_at = now() WHERE id = $1`,
      [id, chosen, actor?.id ?? null],
    );
    return { winner: chosen };
  });
}

/** Called by the worker: start what is due, and decide tests whose waiting time is over. */
export async function runCampaignSchedule() {
  const started = [];
  const { rows: due } = await query(`SELECT id FROM mkt_campaigns WHERE status = 'SCHEDULED' AND scheduled_at <= now() ORDER BY scheduled_at LIMIT 10`);
  for (const { id } of due) started.push({ id, ...(await startCampaign(id)) });
  const decided = [];
  const { rows: tests } = await query(
    `SELECT id FROM mkt_campaigns WHERE status = 'TESTING' AND ab_test->>'metric' <> 'MANUAL'
        AND (ab_test->>'test_started_at')::timestamptz + make_interval(hours => (ab_test->>'wait_hours')::int) <= now()`,
  );
  for (const { id } of tests) {
    try {
      decided.push({ id, ...(await finishTest(id)) });
    } catch (err) {
      decided.push({ id, error: err.message });
    }
  }
  return { started, decided };
}

export async function pauseCampaign(id) {
  const { rowCount } = await query(`UPDATE mkt_campaigns SET status = 'PAUSED', updated_at = now() WHERE id = $1 AND status IN ('SENDING', 'TESTING')`, [id]);
  if (!rowCount) throw conflict('Only a campaign that is sending can be paused');
  return getCampaign(id);
}

export async function resumeCampaign(id) {
  const campaign = await getCampaign(id);
  if (campaign.status !== 'PAUSED') throw conflict('This campaign is not paused');
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM mkt_messages WHERE campaign_id = $1 AND status = 'HELD'`, [id]);
  await query(`UPDATE mkt_campaigns SET status = $2, updated_at = now() WHERE id = $1`, [id, rows[0].n && !campaign.ab_test?.winner ? 'TESTING' : 'SENDING']);
  return getCampaign(id);
}

export async function cancelCampaign(id) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT status FROM mkt_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw notFound('Campaign not found');
    if (['SENT', 'CANCELLED'].includes(rows[0].status)) throw conflict('This campaign has finished');
    const { rowCount } = await client.query(`UPDATE mkt_messages SET status = 'CANCELLED' WHERE campaign_id = $1 AND kind = 'CAMPAIGN' AND status IN ('QUEUED', 'HELD')`, [id]);
    await client.query(`UPDATE mkt_campaigns SET status = 'CANCELLED', completed_at = now(), updated_at = now() WHERE id = $1`, [id]);
    return { cancelled: rowCount };
  });
}

export async function duplicateCampaign(id, actor) {
  const campaign = await getCampaign(id);
  const copy = {
    name: `Copy of ${campaign.name}`.slice(0, 200),
    ...Object.fromEntries(CONTENT_FIELDS.map((f) => [f, campaign[f]])),
    ab_test: campaign.ab_test ? { ...cleanAbTest(campaign.ab_test), winner: null, decided_at: null } : null,
    follow_up: campaign.follow_up,
    conversion_window_days: campaign.conversion_window_days,
    send_strategy: campaign.send_strategy,
    owner_user_id: actor.id,
    variants: campaign.variants.map((v) => ({ subject: v.subject, subject_hi: v.subject_hi, preheader: v.preheader, from_name: v.from_name, design: v.design })),
  };
  return saveCampaign(null, copy, actor);
}

/** Campaigns, festivals and seasonal automations for a stretch of days. */
export async function calendar(from, to) {
  const [campaigns, festivals, workflows] = await Promise.all([
    query(
      `SELECT id, name, status, scheduled_at, started_at, completed_at, deadline, owner_user_id
         FROM mkt_campaigns
        WHERE is_archived = FALSE AND status <> 'CANCELLED'
          AND (COALESCE(scheduled_at, started_at, deadline) BETWEEN $1::date AND $2::date + 1)`,
      [from, to],
    ),
    query('SELECT * FROM mkt_festivals WHERE date BETWEEN $1 AND $2 ORDER BY date', [from, to]),
    query(`SELECT id, name, status, trigger FROM mkt_workflows WHERE status = 'ACTIVE' AND trigger->>'type' = 'FESTIVAL'`),
  ]);
  const seasonal = [];
  for (const w of workflows.rows) {
    for (const f of festivals.rows) {
      if (!f.is_confirmed) continue;
      const ids = w.trigger.festival_ids || [];
      if (ids.length && !ids.includes(f.id)) continue;
      const before = Number(w.trigger.days_before) || 0;
      const date = new Date(`${String(f.date).slice(0, 10)}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - before);
      seasonal.push({ workflow_id: w.id, workflow_name: w.name, festival_id: f.id, festival: f.name, date: date.toISOString().slice(0, 10) });
    }
  }
  return { campaigns: campaigns.rows, festivals: festivals.rows, automations: seasonal };
}
