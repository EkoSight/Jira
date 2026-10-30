/**
 * Inbound leads: an enquiry before it is an organization, a contact and a deal.
 *
 * A lead is captured (by hand, import, form, API or webhook), classified,
 * routed, assigned, followed up and qualified; qualifying converts it into —
 * or links it to — an organization, a contact and an opportunity, keeping its
 * source, history, follow-ups and calls attached through the links.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { recordAuditEvent } from '../audit.js';
import { ensureFolders } from '../resources.js';
import { syncAccountMirror } from '../opportunities.js';
import { autoAssignLead, reassignLead } from './assignment.js';
import { refreshScore, effectiveScore } from './scoring.js';
import { routeLead, routeFor } from './routing.js';
import {
  CATEGORY_LABEL, OPEN_LEAD_STATUSES, PIPELINE_FOR_CATEGORY, cleanText, companyDomain, domainOf, emitEvent, isEligible,
  nextNumber, normalizeEmail, normalizePhone, salesSettings, scopeCondition,
} from './core.js';

const DAY = 24 * 3600 * 1000;

export const LEAD_SELECT = `
  SELECT l.*, u.full_name AS owner_name, u.avatar_color AS owner_color, d.name AS department_name,
         src.name AS source_name, cam.name AS campaign_name,
         osrc.name AS original_source_name, ocam.name AS original_campaign_name,
         a.name AS account_name, a.owner_user_id AS account_owner_id,
         cb.full_name AS created_by_name,
         (SELECT MIN(t.due_date) FROM tasks t
           WHERE t.crm_lead_id = l.id AND t.followup_kind IS NOT NULL AND t.completed_at IS NULL AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL) AS next_followup_due,
         (SELECT COUNT(*)::int FROM tasks t
           WHERE t.crm_lead_id = l.id AND t.followup_kind IS NOT NULL AND t.completed_at IS NULL AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL
             AND t.due_date < now()) AS overdue_followups
    FROM crm_leads l
    LEFT JOIN users u ON u.id = l.owner_user_id
    LEFT JOIN users cb ON cb.id = l.created_by
    LEFT JOIN departments d ON d.id = l.department_id
    LEFT JOIN crm_sources src ON src.id = l.source_id
    LEFT JOIN crm_campaigns cam ON cam.id = l.campaign_id
    LEFT JOIN crm_sources osrc ON osrc.id = l.original_source_id
    LEFT JOIN crm_campaigns ocam ON ocam.id = l.original_campaign_id
    LEFT JOIN accounts a ON a.id = l.account_id`;

export function decorateLead(row, settings = {}, now = Date.now()) {
  if (!row) return row;
  const staleDays = Number(settings.followUps?.staleLeadDays) || 7;
  const open = OPEN_LEAD_STATUSES.includes(row.status) && !row.is_archived && row.destination === 'TASKFLOW';
  const lastTouch = row.last_contacted_at || row.captured_at;
  const nextDue = row.next_followup_due || row.next_follow_up_at;
  return {
    ...row,
    category_label: CATEGORY_LABEL[row.category],
    effective_score: effectiveScore(row),
    is_open: open,
    is_overdue: open && (row.overdue_followups > 0 || (row.next_follow_up_at && new Date(row.next_follow_up_at).getTime() < now)),
    is_stale: open && lastTouch && now - new Date(lastTouch).getTime() > staleDays * DAY,
    next_due: nextDue,
    never_contacted: open && !row.last_contacted_at,
  };
}

// ---------------------------------------------------------------- attribution

const PAID = /^(cpc|ppc|paid|paid[_-]?social|display|cpm)$/i;

/** The business source and campaign, from what the record says. */
export async function resolveAttribution(runner, { source_id, source, campaign_id, campaign, utm = {} }, channel) {
  let sourceId = source_id ? Number(source_id) : null;
  let campaignId = campaign_id ? Number(campaign_id) : null;
  if (!sourceId && source) {
    const { rows } = await runner.query('SELECT id FROM crm_sources WHERE lower(key) = lower($1) OR lower(name) = lower($1) LIMIT 1', [String(source)]);
    sourceId = rows[0]?.id ?? null;
  }
  if (!campaignId && (campaign || utm.campaign)) {
    const { rows } = await runner.query(
      `SELECT id, source_id FROM crm_campaigns
        WHERE lower(key) = lower($1) OR lower(name) = lower($1) OR lower(utm_campaign) = lower($2) LIMIT 1`,
      [String(campaign || ''), String(utm.campaign || campaign || '')],
    );
    campaignId = rows[0]?.id ?? null;
    if (!sourceId && rows[0]?.source_id) sourceId = rows[0].source_id;
  }
  // documented rule: paid traffic from a known ad network maps to that source;
  // anything else from a form or the website is a website enquiry
  if (!sourceId && utm.source) {
    const s = String(utm.source).toLowerCase();
    const key = PAID.test(String(utm.medium || '')) && /google/.test(s) ? 'google-ads'
      : PAID.test(String(utm.medium || '')) && /(facebook|instagram|fb|ig|meta)/.test(s) ? 'meta-ads'
        : /linkedin/.test(s) ? 'linkedin' : null;
    if (key) sourceId = (await runner.query('SELECT id FROM crm_sources WHERE key = $1', [key])).rows[0]?.id ?? null;
  }
  if (!sourceId && channel === 'FORM') sourceId = (await runner.query(`SELECT id FROM crm_sources WHERE key = 'website'`)).rows[0]?.id ?? null;
  return { sourceId, campaignId };
}

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];
const cleanUtm = (utm = {}) => Object.fromEntries(UTM_KEYS.filter((k) => utm[k]).map((k) => [k, String(utm[k]).slice(0, 200)]));

// ---------------------------------------------------------------- activities

/** One entry on a lead's timeline; two-way contact moves the contact clocks. */
export async function logLeadActivity(client, leadId, {
  type, direction = 'INTERNAL', outcome = null, subject = null, body = null, actorId = null, taskId = null,
  callId = null, messageId = null, externalRef = null, meta = {}, occurredAt = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO crm_lead_activities (lead_id, type, direction, outcome, subject, body, actor_id, task_id, call_id, message_id, external_ref, meta, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, now()))
     ON CONFLICT (lead_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING *`,
    [leadId, type, direction, outcome, subject, body, actorId, taskId, callId, messageId, externalRef, meta, occurredAt],
  );
  if (!rows[0]) return null;
  const twoWay = (direction === 'INBOUND') || (['CALL', 'MEETING', 'VISIT', 'DEMO'].includes(type) && outcome === 'COMPLETED');
  const attempt = direction === 'OUTBOUND';
  await client.query(
    `UPDATE crm_leads SET last_activity_at = GREATEST(COALESCE(last_activity_at, $2), $2),
            last_contacted_at = CASE WHEN $3 THEN GREATEST(COALESCE(last_contacted_at, $2), $2) ELSE last_contacted_at END,
            first_response_at = CASE WHEN ($3 OR $4) AND first_response_at IS NULL THEN $2 ELSE first_response_at END,
            status = CASE WHEN ($3 OR $4) AND status = 'NEW' THEN 'CONTACTED' ELSE status END
      WHERE id = $1`,
    [leadId, rows[0].occurred_at, twoWay, attempt],
  );
  return rows[0];
}

// ---------------------------------------------------------------- duplicates

/**
 * Possible duplicates with the reason for each. Shared company domains, shared
 * phones and repeat enquiries are shown, never merged automatically.
 */
export async function findDuplicates({ id = null, email = null, phone = null, website = null, organization_name = null, external_id = null, source_system = null }) {
  const emailN = normalizeEmail(email);
  const phoneN = normalizePhone(phone);
  const domain = companyDomain(website) || companyDomain(emailN);
  const name = cleanText(organization_name, 200);
  const out = { leads: [], accounts: [], contacts: [] };
  const { rows: leads } = await query(
    `SELECT l.id, l.ref, l.organization_name, l.contact_name, l.email, l.phone, l.status, l.category, l.captured_at,
            l.email_normalized = $2 AS same_email, l.phone_normalized = $3 AS same_phone, l.domain = $4 AS same_domain,
            (l.external_id IS NOT NULL AND l.external_id = $6 AND l.source_system IS NOT DISTINCT FROM $7) AS same_external,
            (lower(l.organization_name) = lower($5)) AS same_name
       FROM crm_leads l
      WHERE l.id IS DISTINCT FROM $1 AND l.merged_into_id IS NULL
        AND (l.email_normalized = $2 OR l.phone_normalized = $3 OR l.domain = $4 OR lower(l.organization_name) = lower($5)
             OR (l.external_id IS NOT NULL AND l.external_id = $6 AND l.source_system IS NOT DISTINCT FROM $7))
      ORDER BY l.captured_at DESC LIMIT 20`,
    [id, emailN, phoneN, domain, name, external_id, source_system],
  );
  out.leads = leads.map((l) => ({
    ...l,
    reasons: [l.same_external && 'Same external id from the same system', l.same_email && 'Same email', l.same_phone && 'Same phone',
      l.same_domain && 'Same company domain (colleagues share it: may be a different enquiry)', l.same_name && 'Same organization name'].filter(Boolean),
    strength: l.same_external || l.same_email || l.same_phone ? 'strong' : 'possible',
  }));
  const { rows: accounts } = await query(
    `SELECT a.id, a.name, a.type, a.lead_category, a.owner_user_id, u.full_name AS owner_name,
            lower(a.domain) = $1 AS same_domain, lower(a.name) = lower($2) AS same_name
       FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.is_archived = FALSE AND a.merged_into_id IS NULL AND (lower(a.domain) = $1 OR lower(a.name) = lower($2))
      LIMIT 10`,
    [domain, name],
  );
  out.accounts = accounts.map((a) => ({ ...a, reasons: [a.same_domain && 'Same company domain', a.same_name && 'Same name'].filter(Boolean) }));
  const { rows: contacts } = await query(
    `SELECT c.id, c.full_name, c.email, c.phone, c.account_id, a.name AS account_name,
            c.email_normalized = $1 AS same_email, c.phone_normalized = $2 AS same_phone
       FROM account_contacts c JOIN accounts a ON a.id = c.account_id
      WHERE c.is_active = TRUE AND c.merged_into_id IS NULL AND (c.email_normalized = $1 OR c.phone_normalized = $2)
      LIMIT 10`,
    [emailN, phoneN],
  );
  out.contacts = contacts.map((c) => ({ ...c, reasons: [c.same_email && 'Same email', c.same_phone && 'Same phone'].filter(Boolean) }));
  return out;
}

// ---------------------------------------------------------------- create

/** The minimum a lead needs, by category, plus what Settings adds. */
export function validateLead(input, settings = {}) {
  const errors = {};
  const cat = input.category || 'UNCLASSIFIED';
  const hasContact = Boolean(normalizeEmail(input.email) || normalizePhone(input.phone));
  if (cat === 'INDIVIDUAL') {
    if (!cleanText(input.contact_name)) errors.contact_name = 'A name is needed';
  } else if (isEligible(cat) && !cleanText(input.organization_name)) {
    // Taskflow's own leads are organizations; a retailer or FPO bound for
    // TeleCRM is kept with whatever it gave rather than turned away
    errors.organization_name = 'The organization is needed for a business lead';
  }
  if (!cleanText(input.organization_name) && !cleanText(input.contact_name)) errors.organization_name = 'Give an organization or a person';
  if (!hasContact && !cleanText(input.organization_name)) errors.email = 'Give an email or a phone number';
  if (input.email && !normalizeEmail(input.email)) errors.email = 'This is not an email address';
  if (input.phone && !normalizePhone(input.phone)) errors.phone = 'This is not a phone number';
  for (const field of settings.required?.lead?.[cat] || []) {
    if (input[field] === undefined || input[field] === null || String(input[field]).trim() === '') errors[field] = 'Required for this category';
  }
  return errors;
}

/**
 * Captures a lead through any entry path. Returns { lead, created, duplicate }.
 * A retried submission (same idempotency key, or the same external id from the
 * same system) returns the lead it already made, unchanged.
 */
export async function createLead(input, {
  actor = null, channel = 'MANUAL', sourceSystem = null, idempotencyKey = null, client: outer = null, assign = true,
  importJobId = null, origin = 'USER',
} = {}) {
  const settings = await salesSettings();
  const category = input.category || 'UNCLASSIFIED';
  const errors = validateLead({ ...input, category }, settings);
  if (Object.keys(errors).length) throw badRequest(Object.values(errors)[0], { fields: errors });

  const run = async (client) => {
    if (idempotencyKey) {
      const { rows } = await client.query('SELECT id FROM crm_leads WHERE idempotency_key = $1', [idempotencyKey]);
      if (rows[0]) return { id: rows[0].id, created: false, duplicate: 'IDEMPOTENT' };
    }
    const externalId = cleanText(input.external_id, 200);
    const system = cleanText(sourceSystem || input.source_system, 80);
    if (externalId) {
      const { rows } = await client.query('SELECT id FROM crm_leads WHERE external_id = $1 AND source_system IS NOT DISTINCT FROM $2', [externalId, system]);
      if (rows[0]) return { id: rows[0].id, created: false, duplicate: 'EXTERNAL_ID' };
    }
    const emailN = normalizeEmail(input.email);
    const phoneN = normalizePhone(input.phone);
    const domain = companyDomain(input.website) || companyDomain(emailN);
    const utm = cleanUtm(input.utm || {});
    const { sourceId, campaignId } = await resolveAttribution(client, { ...input, utm }, channel);

    // a returning organization: linked when exactly one has this company domain
    let accountId = input.account_id ? Number(input.account_id) : null;
    let accountNote = null;
    let adopted = null;
    if (!accountId && domain) {
      const { rows } = await client.query(
        `SELECT id, name, lead_category FROM accounts WHERE lower(domain) = $1 AND is_archived = FALSE AND merged_into_id IS NULL LIMIT 2`, [domain],
      );
      if (rows.length === 1) { accountId = rows[0].id; accountNote = `Linked to ${rows[0].name} by company domain ${domain}`; adopted = rows[0].lead_category; }
    } else if (accountId) {
      const { rows } = await client.query('SELECT lead_category FROM accounts WHERE id = $1', [accountId]);
      adopted = rows[0]?.lead_category ?? null;
    }
    // an unclassified enquiry from an organization already confirmed as eligible takes its category
    let effectiveCategory = category;
    if (category === 'UNCLASSIFIED' && isEligible(adopted)) effectiveCategory = adopted;
    const route = routeFor(effectiveCategory, settings);

    const seq = await nextNumber(client, 'lead');
    const ref = `L-${String(seq).padStart(5, '0')}`;
    const { rows } = await client.query(
      `INSERT INTO crm_leads
         (ref, category, destination, routing_status, status, priority, organization_name, account_id, contact_name, designation,
          email, phone, email_normalized, phone_normalized, website, domain, city, state, country, enquiry, requirement,
          budget_amount, currency, budget_confirmed, timeline, decision_maker_engaged, need_clarity, fit,
          source_id, campaign_id, original_source_id, original_campaign_id, utm, referral, landing_page, entry_channel,
          source_system, external_id, consent, owner_user_id, department_id, tags, custom_fields, idempotency_key,
          import_job_id, next_follow_up_at, captured_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'NEW'),COALESCE($6,'MEDIUM'),$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,COALESCE($23,'INR'),$24,$25,$26,$27,$28,$29,$30,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
               COALESCE($40::text[], '{}'),COALESCE($41,'{}'::jsonb),$42,$43,$44,COALESCE($45, now()),$46,$46)
       RETURNING *`,
      [ref, effectiveCategory, route.destination, route.routingStatus, input.status ?? null, input.priority ?? null,
        cleanText(input.organization_name, 200), accountId, cleanText(input.contact_name, 160), cleanText(input.designation, 160),
        cleanText(input.email, 200), cleanText(input.phone, 60), emailN, phoneN, cleanText(input.website, 300), domain || domainOf(input.website),
        cleanText(input.city, 120), cleanText(input.state, 80), cleanText(input.country, 80), cleanText(input.enquiry, 20000),
        cleanText(input.requirement, 20000), input.budget_amount ?? null, input.currency ?? null, input.budget_confirmed ?? null,
        input.timeline ?? null, input.decision_maker_engaged ?? null, input.need_clarity ?? null, input.fit ?? null,
        sourceId, campaignId, utm, cleanText(input.referral, 300), cleanText(input.landing_page, 500), channel, system, externalId,
        input.consent || {}, input.owner_user_id ?? null, input.department_id ?? null, input.tags ?? null, input.custom_fields ?? null,
        idempotencyKey, importJobId, input.next_follow_up_at ?? null, input.captured_at ?? null, actor?.id ?? null],
    );
    const lead = rows[0];
    await client.query(
      `INSERT INTO crm_routing_events (lead_id, to_category, to_destination, routing_status, entry_channel, reason, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [lead.id, effectiveCategory, route.destination, route.routingStatus, channel,
        effectiveCategory !== category ? `Took the category of the linked organization (${CATEGORY_LABEL[effectiveCategory]})` : null, actor?.id ?? null],
    );
    if (route.destination === 'TELECRM') {
      await client.query(
        `INSERT INTO crm_handoffs (lead_id, target, method, status, payload) VALUES ($1,'TELECRM','MANUAL_EXPORT','PENDING',$2)
         ON CONFLICT DO NOTHING`,
        [lead.id, { ref, category: effectiveCategory, organization: lead.organization_name, name: lead.contact_name, phone: lead.phone, email: lead.email }],
      );
    }
    await logLeadActivity(client, lead.id, {
      type: 'CAPTURE', subject: `Captured (${channel.toLowerCase().replace('_', ' ')})`,
      body: [accountNote, route.destination === 'TELECRM' ? `${CATEGORY_LABEL[effectiveCategory]}: queued for TeleCRM` : null,
        route.destination === 'TRIAGE' ? 'Waiting for classification' : null].filter(Boolean).join('. ') || null,
      actorId: actor?.id ?? null, meta: { channel, source_system: system },
    });
    if (input.owner_user_id) {
      await client.query(
        `INSERT INTO crm_assignments (entity_type, entity_id, to_user_id, method, reason, actor_id) VALUES ('LEAD',$1,$2,$3,$4,$5)`,
        [lead.id, input.owner_user_id, channel === 'IMPORT' ? 'IMPORT' : 'MANUAL', 'Owner chosen when the lead was added', actor?.id ?? null],
      );
      await client.query('UPDATE crm_leads SET assigned_at = now() WHERE id = $1', [lead.id]);
    }
    await refreshScore(client, lead.id);
    await emitEvent(client, {
      type: 'lead.captured', entityType: 'LEAD', entityId: lead.id, origin, actorId: actor?.id ?? null,
      payload: { category: effectiveCategory, channel, destination: route.destination },
    });
    if (assign && route.destination === 'TASKFLOW' && !input.owner_user_id) await autoAssignLead(client, lead.id, { actor, origin });
    return { id: lead.id, created: true, duplicate: null };
  };

  let result;
  try {
    result = outer ? await run(outer) : await withTransaction(run);
  } catch (err) {
    // two copies of the same submission arriving together: the second loses the
    // race on the unique key and gets the lead the first one made
    if (err.code !== '23505' || outer) throw err;
    const externalId = cleanText(input.external_id, 200);
    const system = cleanText(sourceSystem || input.source_system, 80);
    const { rows } = idempotencyKey
      ? await query('SELECT id FROM crm_leads WHERE idempotency_key = $1', [idempotencyKey])
      : await query('SELECT id FROM crm_leads WHERE external_id = $1 AND source_system IS NOT DISTINCT FROM $2', [externalId, system]);
    if (!rows[0]) throw err;
    result = { id: rows[0].id, created: false, duplicate: idempotencyKey ? 'IDEMPOTENT' : 'EXTERNAL_ID' };
  }
  const lead = await getLead(result.id, { client: outer });
  return { lead, created: result.created, duplicate: result.duplicate };
}

// ---------------------------------------------------------------- read

export async function getLead(id, { client = null } = {}) {
  const runner = client || { query };
  const { rows } = await runner.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
  if (!rows[0]) return null;
  return decorateLead(rows[0], await salesSettings());
}

export const LEAD_VIEWS = ['open', 'mine', 'team', 'unassigned', 'new', 'overdue', 'stale', 'nurture', 'converted', 'disqualified',
  'needs_classification', 'telecrm', 'archived', 'all'];

/**
 * A page of leads for one view, inside what the person may see. Views of the
 * routing queues are for people with crm.routing; the route checks that.
 */
export async function listLeads(filters = {}, scope = { all: true }) {
  const settings = await salesSettings();
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const where = [scopeCondition(scope, 'lead', 'l', push)];
  const view = LEAD_VIEWS.includes(filters.view) ? filters.view : 'open';
  const staleDays = Number(settings.followUps?.staleLeadDays) || 7;
  // the open statuses written into the query, so no parameter is left unused by views that do not need it
  const openSql = `l.status IN (${OPEN_LEAD_STATUSES.map((st) => `'${st}'`).join(',')})`;
  if (view !== 'archived') where.push('l.is_archived = FALSE');
  // the routing queues are the only lists that show leads bound for TeleCRM or waiting for a category
  if (!['needs_classification', 'telecrm', 'archived'].includes(view)) where.push(`l.destination = 'TASKFLOW'`);
  switch (view) {
    case 'open': where.push(openSql); break;
    case 'mine': where.push(openSql, `l.owner_user_id = ${push(filters.userId)}`); break;
    case 'team': where.push(openSql); break;
    case 'unassigned': where.push(openSql, 'l.owner_user_id IS NULL'); break;
    case 'new': where.push(`l.status = 'NEW'`); break;
    case 'overdue': where.push(openSql, `(l.next_follow_up_at < now() OR EXISTS (SELECT 1 FROM tasks t WHERE t.crm_lead_id = l.id AND t.followup_kind IS NOT NULL
                       AND t.completed_at IS NULL AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL AND t.due_date < now()))`); break;
    case 'stale': where.push(openSql, `COALESCE(l.last_contacted_at, l.captured_at) < now() - (${push(staleDays)} || ' days')::interval`); break;
    case 'nurture': where.push(`l.status = 'NURTURE'`); break;
    case 'converted': where.push(`l.status = 'CONVERTED'`); break;
    case 'disqualified': where.push(`l.status = 'DISQUALIFIED'`); break;
    case 'needs_classification': where.push(`l.routing_status = 'NEEDS_CLASSIFICATION'`); break;
    case 'telecrm': where.push(`l.destination = 'TELECRM'`); break;
    case 'archived': where.push('l.is_archived = TRUE'); break;
    default: break;
  }
  if (filters.q) {
    const t = push(`%${String(filters.q).trim()}%`);
    where.push(`(l.organization_name ILIKE ${t} OR l.contact_name ILIKE ${t} OR l.email ILIKE ${t} OR l.phone ILIKE ${t} OR l.ref ILIKE ${t} OR l.enquiry ILIKE ${t})`);
  }
  if (filters.category) where.push(`l.category = ${push(filters.category)}`);
  if (filters.status) where.push(`l.status = ${push(filters.status)}`);
  if (filters.priority) where.push(`l.priority = ${push(filters.priority)}`);
  if (filters.owner_id === 'none') where.push('l.owner_user_id IS NULL');
  else if (filters.owner_id) where.push(`l.owner_user_id = ${push(Number(filters.owner_id))}`);
  if (filters.department_id) where.push(`l.department_id = ${push(Number(filters.department_id))}`);
  if (filters.source_id) where.push(`(l.source_id = ${push(Number(filters.source_id))} OR l.original_source_id = $${params.length})`);
  if (filters.campaign_id) where.push(`(l.campaign_id = ${push(Number(filters.campaign_id))} OR l.original_campaign_id = $${params.length})`);
  if (filters.state) where.push(`lower(l.state) = lower(${push(filters.state)})`);
  if (filters.tag) where.push(`${push(filters.tag)} = ANY(l.tags)`);
  if (filters.from) where.push(`l.captured_at >= ${push(filters.from)}::date`);
  if (filters.to) where.push(`l.captured_at < (${push(filters.to)}::date + 1)`);
  if (filters.min_score) where.push(`COALESCE(l.score_override, l.score) >= ${push(Number(filters.min_score))}`);
  if (filters.entry_channel) where.push(`l.entry_channel = ${push(filters.entry_channel)}`);

  const SORTS = {
    newest: 'l.captured_at DESC, l.id DESC', oldest: 'l.captured_at ASC, l.id ASC',
    score: 'COALESCE(l.score_override, l.score) DESC NULLS LAST, l.captured_at DESC',
    follow_up: 'next_followup_due ASC NULLS LAST, l.next_follow_up_at ASC NULLS LAST',
    activity: 'l.last_activity_at DESC NULLS LAST', organization: 'lower(l.organization_name) ASC NULLS LAST, l.id',
  };
  const order = SORTS[filters.sort] || SORTS.newest;
  const pageSize = Math.min(Math.max(Number(filters.page_size) || 50, 1), 200);
  const page = Math.max(Number(filters.page) || 1, 1);
  const whereSql = where.join(' AND ');
  const [{ rows }, { rows: count }] = await Promise.all([
    query(`SELECT * FROM (${LEAD_SELECT} WHERE ${whereSql}) x ORDER BY ${order.replace(/l\./g, 'x.')} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
    query(`SELECT COUNT(*)::int AS n FROM crm_leads l WHERE ${whereSql}`, params),
  ]);
  return { leads: rows.map((r) => decorateLead(r, settings)), total: count[0].n, page, page_size: pageSize, view };
}

/** Counts for the view chips, inside the person's scope. */
export async function leadCounts(scope, userId) {
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const settings = await salesSettings();
  const scoped = scopeCondition(scope, 'lead', 'l', push);
  const open = push(OPEN_LEAD_STATUSES);
  const me = push(userId);
  const stale = push(Number(settings.followUps?.staleLeadDays) || 7);
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE l.destination = 'TASKFLOW' AND l.status = ANY(${open}::text[]))::int AS open,
       COUNT(*) FILTER (WHERE l.destination = 'TASKFLOW' AND l.status = ANY(${open}::text[]) AND l.owner_user_id = ${me})::int AS mine,
       COUNT(*) FILTER (WHERE l.destination = 'TASKFLOW' AND l.status = ANY(${open}::text[]) AND l.owner_user_id IS NULL)::int AS unassigned,
       COUNT(*) FILTER (WHERE l.destination = 'TASKFLOW' AND l.status = 'NEW')::int AS new,
       COUNT(*) FILTER (WHERE l.destination = 'TASKFLOW' AND l.status = ANY(${open}::text[]) AND (l.next_follow_up_at < now() OR EXISTS (
          SELECT 1 FROM tasks t WHERE t.crm_lead_id = l.id AND t.followup_kind IS NOT NULL AND t.completed_at IS NULL AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL AND t.due_date < now())))::int AS overdue,
       COUNT(*) FILTER (WHERE l.destination = 'TASKFLOW' AND l.status = ANY(${open}::text[]) AND COALESCE(l.last_contacted_at, l.captured_at) < now() - (${stale} || ' days')::interval)::int AS stale,
       COUNT(*) FILTER (WHERE l.routing_status = 'NEEDS_CLASSIFICATION')::int AS needs_classification,
       COUNT(*) FILTER (WHERE l.destination = 'TELECRM' AND l.routing_status IN ('HANDOFF_PENDING', 'HANDOFF_FAILED'))::int AS telecrm_pending,
       COUNT(*) FILTER (WHERE l.captured_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS today
       FROM crm_leads l WHERE l.is_archived = FALSE AND ${scoped}`,
    params,
  );
  return rows[0];
}

// ---------------------------------------------------------------- update

const EDITABLE = ['organization_name', 'contact_name', 'designation', 'email', 'phone', 'website', 'city', 'state', 'country',
  'enquiry', 'requirement', 'budget_amount', 'currency', 'budget_confirmed', 'timeline', 'decision_maker_engaged', 'need_clarity',
  'fit', 'priority', 'tags', 'referral', 'next_follow_up_at', 'custom_fields', 'department_id', 'source_id', 'campaign_id'];

/**
 * Edits a lead. A category change goes through the boundary; an owner change
 * is a recorded reassignment; status changes keep their rules (disqualifying
 * needs a reason; "converted" only happens through conversion).
 */
export async function updateLead(id, data, { actor, client: outer = null, origin = 'USER', depth = 0 }) {
  const run = async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE', [id]);
    const lead = rows[0];
    if (!lead) throw notFound('Lead not found');
    if (lead.merged_into_id) throw conflict('This lead was merged into another; edit that one');
    const sets = [];
    const params = [id];
    const push = (v) => { params.push(v); return `$${params.length}`; };
    const changed = {};
    for (const key of EDITABLE) {
      if (data[key] === undefined) continue;
      let value = data[key];
      if (typeof value === 'string') value = cleanText(value, key === 'enquiry' || key === 'requirement' ? 20000 : 500);
      if (key === 'email' && value && !normalizeEmail(value)) throw badRequest('This is not an email address');
      if (key === 'phone' && value && !normalizePhone(value)) throw badRequest('This is not a phone number');
      sets.push(`${key} = ${push(key === 'custom_fields' ? { ...(lead.custom_fields || {}), ...(value || {}) } : value)}`);
      changed[key] = value;
    }
    if (changed.email !== undefined) sets.push(`email_normalized = ${push(normalizeEmail(changed.email))}`);
    if (changed.phone !== undefined) sets.push(`phone_normalized = ${push(normalizePhone(changed.phone))}`);
    if (changed.website !== undefined || changed.email !== undefined) {
      sets.push(`domain = ${push(companyDomain(changed.website ?? lead.website) || companyDomain(normalizeEmail(changed.email ?? lead.email)) || null)}`);
    }
    if (data.status !== undefined && data.status !== lead.status) {
      if (data.status === 'CONVERTED') throw badRequest('Convert the lead to make it an opportunity');
      if (lead.status === 'CONVERTED') throw conflict('This lead is already converted; work the opportunity instead');
      if (data.status === 'DISQUALIFIED' && !cleanText(data.disqualify_reason || data.reason)) throw badRequest('Say why the lead is disqualified');
      sets.push(`status = ${push(data.status)}`);
      if (data.status === 'DISQUALIFIED') sets.push(`disqualify_reason = ${push(cleanText(data.disqualify_reason || data.reason))}`);
      changed.status = data.status;
    }
    if (data.score_override !== undefined) {
      if (data.score_override !== null && !cleanText(data.score_override_reason)) throw badRequest('Say why the score is overridden');
      sets.push(`score_override = ${push(data.score_override)}`, `score_override_reason = ${push(data.score_override === null ? null : cleanText(data.score_override_reason))}`,
        `score_override_by = ${push(data.score_override === null ? null : actor.id)}`);
      changed.score_override = data.score_override;
    }
    if (sets.length) {
      sets.push('updated_at = now()', `updated_by = ${push(actor?.id ?? null)}`);
      await client.query(`UPDATE crm_leads SET ${sets.join(', ')} WHERE id = $1`, params);
    }
    if (Object.keys(changed).length) {
      await logLeadActivity(client, id, {
        type: changed.status ? 'STATUS' : 'EDIT', subject: changed.status ? `Status: ${changed.status.toLowerCase()}` : 'Details updated',
        body: changed.status === 'DISQUALIFIED' ? cleanText(data.disqualify_reason || data.reason) : null,
        actorId: actor?.id ?? null, meta: { fields: Object.keys(changed) },
      });
    }
    if (data.category !== undefined && data.category !== lead.category) {
      const fresh = (await client.query('SELECT * FROM crm_leads WHERE id = $1', [id])).rows[0];
      await routeLead(client, fresh, { category: data.category, actor, channel: 'EDIT', reason: cleanText(data.reason) });
      if (isEligible(data.category) && !fresh.owner_user_id) await autoAssignLead(client, id, { actor, origin, depth });
    }
    if (data.owner_user_id !== undefined && data.owner_user_id !== lead.owner_user_id && data.owner_user_id) {
      await reassignLead(client, id, { toUserId: data.owner_user_id, reason: cleanText(data.reason), actor, origin, depth });
    }
    await refreshScore(client, id);
    if (changed.status) {
      await emitEvent(client, { type: 'lead.status_changed', entityType: 'LEAD', entityId: id, origin, depth, actorId: actor?.id ?? null, payload: { from: lead.status, to: changed.status } });
      // a closed lead's pending follow-ups are cancelled, with the reason recorded
      if (['DISQUALIFIED'].includes(changed.status)) await cancelLeadFollowUps(client, id, `Lead disqualified`, actor);
    }
  };
  if (outer) await run(outer); else await withTransaction(run);
  return getLead(id, { client: outer });
}

/** Cancels a lead's open follow-up tasks, keeping them on the record. */
export async function cancelLeadFollowUps(client, leadId, reason, actor) {
  const { rows: status } = await client.query(`SELECT id FROM workflow_statuses WHERE stage = 'cancelled' AND is_active = TRUE ORDER BY position LIMIT 1`);
  const { rows } = await client.query(
    `UPDATE tasks SET crm_cancel_reason = $2, updated_at = now(),
            status_id = COALESCE($3, status_id), is_archived = CASE WHEN $3::int IS NULL THEN TRUE ELSE is_archived END
      WHERE crm_lead_id = $1 AND followup_kind IS NOT NULL AND completed_at IS NULL AND is_archived = FALSE
      RETURNING id`,
    [leadId, reason, status[0]?.id ?? null],
  );
  if (rows.length) await logLeadActivity(client, leadId, { type: 'FOLLOWUP', subject: `${rows.length} follow-up(s) cancelled`, body: reason, actorId: actor?.id ?? null });
  return rows.length;
}

export async function archiveLead(id, { actor, reason = null, restore = false }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      restore
        ? `UPDATE crm_leads SET is_archived = FALSE, archived_at = NULL, archived_by = NULL, archive_reason = NULL, updated_at = now() WHERE id = $1 RETURNING id`
        : `UPDATE crm_leads SET is_archived = TRUE, archived_at = now(), archived_by = $2, archive_reason = $3, updated_at = now() WHERE id = $1 RETURNING id`,
      restore ? [id] : [id, actor.id, reason],
    );
    if (!rows[0]) throw notFound('Lead not found');
    await logLeadActivity(client, id, { type: 'ARCHIVE', subject: restore ? 'Restored' : 'Archived', body: reason, actorId: actor.id });
    await recordAuditEvent(client, { action: restore ? 'LEAD_RESTORED' : 'LEAD_ARCHIVED', entityType: 'LEAD', entityId: id, actorId: actor.id, reason });
    return getLead(id, { client });
  });
}

// ---------------------------------------------------------------- conversion

async function firstStage(client, pipelineKey) {
  const { rows } = await client.query(
    `SELECT s.id, s.pipeline_id FROM account_stages s JOIN crm_pipelines p ON p.id = s.pipeline_id
      WHERE p.key = $1 AND s.is_active = TRUE AND s.kind = 'open' AND s.retired_at IS NULL
      ORDER BY s.position, s.id LIMIT 1`,
    [pipelineKey],
  );
  return rows[0] || null;
}

/**
 * Qualifies a lead into an opportunity: links or creates the organization and
 * contact, creates (or links) the deal in the category's pipeline, and points
 * everything the lead collected — follow-ups, calls, messages — at them. Running
 * it again returns what the first run made.
 */
export async function convertLead(id, body, { actor }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE', [id]);
    const lead = rows[0];
    if (!lead) throw notFound('Lead not found');
    if (lead.status === 'CONVERTED') {
      return { lead: await getLead(id, { client }), accountId: lead.converted_account_id, opportunityId: lead.converted_opportunity_id, contactId: lead.converted_contact_id, already: true };
    }
    if (lead.destination !== 'TASKFLOW') {
      throw conflict(lead.destination === 'TELECRM'
        ? `${CATEGORY_LABEL[lead.category]} leads belong in TeleCRM and cannot become Taskflow opportunities`
        : 'Classify this lead before converting it');
    }
    const settings = await salesSettings();
    const ownerId = lead.owner_user_id || actor.id;
    const { rows: ownerRows } = await client.query('SELECT department_id FROM users WHERE id = $1', [ownerId]);
    const departmentId = lead.department_id || ownerRows[0]?.department_id || actor.department_id || null;

    // the organization
    let accountId = body.account?.id ? Number(body.account.id) : (body.account?.mode === 'new' ? null : lead.account_id);
    let createdAccount = false;
    if (accountId) {
      const { rows: acc } = await client.query('SELECT id, lead_category, routing_status, is_archived FROM accounts WHERE id = $1', [accountId]);
      if (!acc[0] || acc[0].is_archived) throw badRequest('That organization is not available');
      if (acc[0].routing_status === 'EXCLUDED') throw conflict('That organization is classified for TeleCRM');
      if (!acc[0].lead_category) {
        await client.query(`UPDATE accounts SET lead_category = $2, routing_status = 'ACTIVE', category_source = 'CONVERSION', category_set_at = now(), category_set_by = $3 WHERE id = $1`,
          [accountId, lead.category, actor.id]);
      }
    } else {
      const name = cleanText(body.account?.name, 200) || lead.organization_name || lead.contact_name;
      if (!name) throw badRequest('Name the organization');
      const stage = await firstStage(client, PIPELINE_FOR_CATEGORY[lead.category]);
      const { rows: acc } = await client.query(
        `INSERT INTO accounts (name, type, stage_id, owner_user_id, department_id, website, domain, contact_name, contact_email, contact_phone,
                               state, city, country, source, lead_category, routing_status, category_source, category_set_at, category_set_by,
                               org_type, segment_id, original_source_id, original_campaign_id, created_by, last_activity_at)
         VALUES ($1,'LEAD',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ACTIVE','CONVERSION',now(),$15,$16,$17,$18,$19,$15,now())
         RETURNING id`,
        [name, stage?.id ?? null, ownerId, departmentId, lead.website, lead.domain, lead.contact_name, lead.email, lead.phone,
          lead.state, lead.city, lead.country, null, lead.category, actor.id,
          body.account?.org_type ?? (lead.category === 'CSR_NGO' ? null : 'COMPANY'), body.account?.segment_id ?? null,
          lead.original_source_id, lead.original_campaign_id],
      );
      accountId = acc[0].id;
      createdAccount = true;
      await ensureFolders(client, accountId);
    }

    // the person
    let contactId = body.contact?.id ? Number(body.contact.id) : null;
    if (!contactId && body.contact?.mode !== 'none' && (lead.contact_name || lead.email || lead.phone)) {
      const { rows: existing } = await client.query(
        `SELECT id FROM account_contacts WHERE account_id = $1 AND is_active = TRUE
            AND ((email_normalized IS NOT NULL AND email_normalized = $2) OR (phone_normalized IS NOT NULL AND phone_normalized = $3)) LIMIT 1`,
        [accountId, lead.email_normalized, lead.phone_normalized],
      );
      if (existing[0]) contactId = existing[0].id;
      else {
        const { rows: hasPrimary } = await client.query('SELECT 1 FROM account_contacts WHERE account_id = $1 AND is_primary = TRUE AND is_active = TRUE', [accountId]);
        const { rows: c } = await client.query(
          `INSERT INTO account_contacts (account_id, full_name, designation, email, phone, email_normalized, phone_normalized, is_primary,
                                         consent, decision_roles, created_by)
           VALUES ($1, COALESCE($2,'Primary contact'), $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [accountId, lead.contact_name, lead.designation, lead.email, lead.phone, lead.email_normalized, lead.phone_normalized,
            !hasPrimary.length, lead.consent || {}, body.contact?.decision_roles || [], actor.id],
        );
        contactId = c[0].id;
      }
    }

    // the deal
    let opportunityId = body.opportunity?.id ? Number(body.opportunity.id) : null;
    if (opportunityId) {
      const { rows: o } = await client.query('SELECT id, account_id FROM opportunities WHERE id = $1', [opportunityId]);
      if (!o[0] || o[0].account_id !== accountId) throw badRequest('That opportunity is not on this organization');
    } else {
      const pipelineKey = PIPELINE_FOR_CATEGORY[lead.category];
      const { rows: pipe } = await client.query('SELECT id FROM crm_pipelines WHERE key = $1', [pipelineKey]);
      let stageId = body.opportunity?.stage_id ? Number(body.opportunity.stage_id) : null;
      if (stageId) {
        const { rows: st } = await client.query('SELECT pipeline_id FROM account_stages WHERE id = $1', [stageId]);
        if (st[0]?.pipeline_id !== pipe[0].id) throw badRequest('That stage is not in this pipeline');
      } else stageId = (await firstStage(client, pipelineKey))?.id ?? null;
      const { rows: won } = await client.query(`SELECT 1 FROM opportunities WHERE account_id = $1 AND status = 'WON' LIMIT 1`, [accountId]);
      const type = body.opportunity?.opportunity_type
        || (lead.category === 'CSR_NGO' ? 'CSR_FUNDING' : won.length ? 'REPEAT' : 'NEW_BUSINESS');
      const o = body.opportunity || {};
      const nextStep = cleanText(o.next_step, 2000);
      const { rows: opp } = await client.query(
        `INSERT INTO opportunities
           (account_id, name, stage_id, owner_user_id, estimated_value, currency, expected_close, original_close, next_step, next_step_due,
            next_step_owner_id, next_step_set_at, next_step_set_by, pipeline_id, opportunity_type, source_lead_id, source_id, campaign_id,
            engagement_model, requested_amount, proposed_project, problem, created_by)
         VALUES ($1,$2,$3,$4,$5::numeric,COALESCE($6,$7),$8::date,$8::date,$9::text,$10::date,$11,CASE WHEN $9::text IS NULL THEN NULL ELSE now() END,
                 CASE WHEN $9::text IS NULL THEN NULL ELSE $12::int END,$13,$14,$15,$16,$17,$18,$19::numeric,$20,$21,$12)
         RETURNING id`,
        [accountId, cleanText(o.name, 200) || `${lead.organization_name || lead.contact_name} — ${lead.category === 'CSR_NGO' ? 'CSR' : 'enquiry'}`,
          stageId, ownerId, o.estimated_value ?? lead.budget_amount ?? null, o.currency ?? null, lead.currency || settings.calendar?.currency || 'INR',
          o.expected_close ?? null, nextStep, nextStep ? (o.next_step_due ?? null) : null, nextStep ? (o.next_step_owner_id ?? ownerId) : null, actor.id,
          pipe[0].id, type, lead.id, lead.original_source_id || lead.source_id, lead.original_campaign_id || lead.campaign_id,
          lead.category === 'CSR_NGO' ? 'CSR_PROJECT' : (o.engagement_model || 'COMMERCIAL'),
          lead.category === 'CSR_NGO' ? (o.requested_amount ?? lead.budget_amount ?? null) : null,
          lead.category === 'CSR_NGO' ? (o.proposed_project ?? lead.requirement ?? null) : null,
          lead.requirement || lead.enquiry],
      );
      opportunityId = opp[0].id;
      if (contactId) {
        await client.query(
          `INSERT INTO opportunity_contacts (opportunity_id, contact_id, role) VALUES ($1,$2,'PRIMARY') ON CONFLICT DO NOTHING`,
          [opportunityId, contactId],
        );
      }
      await client.query(
        `INSERT INTO opportunity_history (opportunity_id, field, from_value, to_value, actor_id, reason)
         VALUES ($1, 'created', NULL, $2, $3, $4)`,
        [opportunityId, 'Converted from a lead', actor.id, `Lead ${lead.ref}`],
      );
    }
    if (createdAccount) {
      await client.query('UPDATE accounts SET primary_opportunity_id = $2 WHERE id = $1 AND primary_opportunity_id IS NULL', [accountId, opportunityId]);
      await syncAccountMirror(client, accountId);
    }

    // the lead keeps its record and points at what it became
    await client.query(
      `UPDATE crm_leads SET status = 'CONVERTED', converted_at = now(), converted_by = $2, converted_account_id = $3,
              converted_opportunity_id = $4, converted_contact_id = $5, account_id = COALESCE(account_id, $3),
              contact_id = COALESCE(contact_id, $5), updated_at = now(), updated_by = $2
        WHERE id = $1`,
      [id, actor.id, accountId, opportunityId, contactId],
    );
    // what it collected follows it
    await client.query(
      `UPDATE tasks SET account_id = COALESCE(account_id, $2), opportunity_id = COALESCE(opportunity_id, $3)
        WHERE crm_lead_id = $1`,
      [id, accountId, opportunityId],
    );
    await client.query(
      `UPDATE crm_calls SET account_id = COALESCE(account_id, $2), opportunity_id = COALESCE(opportunity_id, $3), contact_id = COALESCE(contact_id, $4)
        WHERE lead_id = $1`,
      [id, accountId, opportunityId, contactId],
    );
    await client.query(
      `UPDATE crm_wa_messages SET account_id = COALESCE(account_id, $2), opportunity_id = COALESCE(opportunity_id, $3), contact_id = COALESCE(contact_id, $4)
        WHERE lead_id = $1`,
      [id, accountId, opportunityId, contactId],
    );
    await client.query(
      `INSERT INTO account_activities (account_id, opportunity_id, contact_id, lead_id, type, actor_id, subject, body, direction, outcome, is_external, source)
       VALUES ($1,$2,$3,$4,'LEAD',$5,$6,$7,'INTERNAL','NOTED',FALSE,'LEAD')`,
      [accountId, opportunityId, contactId, id, actor.id, `Converted from lead ${lead.ref}`,
        [lead.enquiry, lead.requirement].filter(Boolean).join('\n\n') || null],
    );
    await logLeadActivity(client, id, { type: 'CONVERSION', subject: 'Converted to an opportunity', actorId: actor.id, meta: { accountId, opportunityId, contactId } });
    await recordAuditEvent(client, {
      action: 'LEAD_CONVERTED', entityType: 'LEAD', entityId: id, actorId: actor.id,
      summary: `${lead.ref} → organization ${accountId}, opportunity ${opportunityId}`, detail: { accountId, opportunityId, contactId, createdAccount },
    });
    await emitEvent(client, { type: 'lead.converted', entityType: 'LEAD', entityId: id, actorId: actor.id, payload: { account_id: accountId, opportunity_id: opportunityId } });
    await emitEvent(client, { type: 'opportunity.created', entityType: 'OPPORTUNITY', entityId: opportunityId, actorId: actor.id, payload: { from_lead: id } });
    return { lead: await getLead(id, { client }), accountId, opportunityId, contactId, createdAccount, already: false };
  });
}

/** The lead's own timeline with what was routed and assigned. */
export async function leadTimeline(id) {
  const { rows } = await query(
    `SELECT a.*, u.full_name AS actor_name FROM crm_lead_activities a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.lead_id = $1 ORDER BY a.occurred_at DESC, a.id DESC LIMIT 500`,
    [id],
  );
  return rows;
}

export async function leadRouting(id) {
  const [{ rows: events }, { rows: assignments }, { rows: handoff }] = await Promise.all([
    query(`SELECT r.*, u.full_name AS actor_name FROM crm_routing_events r LEFT JOIN users u ON u.id = r.actor_id WHERE r.lead_id = $1 ORDER BY r.created_at DESC`, [id]),
    query(`SELECT s.*, f.full_name AS from_name, t.full_name AS to_name, u.full_name AS actor_name, r.name AS rule_name
             FROM crm_assignments s LEFT JOIN users f ON f.id = s.from_user_id LEFT JOIN users t ON t.id = s.to_user_id
             LEFT JOIN users u ON u.id = s.actor_id LEFT JOIN crm_assignment_rules r ON r.id = s.rule_id
            WHERE s.entity_type = 'LEAD' AND s.entity_id = $1 ORDER BY s.created_at DESC`, [id]),
    query(`SELECT * FROM crm_handoffs WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
  ]);
  return { events, assignments, handoff: handoff[0] || null };
}
