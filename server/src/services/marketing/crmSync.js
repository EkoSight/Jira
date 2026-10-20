/**
 * The CRM and email marketing, kept in step.
 *
 * People at organizations in the pipeline are added to the audiences whose
 * rules they match (by pipeline type, organization tag or segment), and taken
 * off — archived, not unsubscribed — when they stop matching, so a lead that
 * becomes a customer moves from Leads to Customers. Nobody who unsubscribed is
 * ever put back. This runs only once an admin has switched it on, after
 * checking the consent basis.
 *
 * TaskFlow's own changes — a new lead, a lead becoming a customer, a deal
 * moving, won or lost, a task finished — are read from the tables that already
 * record them (nothing in the pipeline code changes) and become contact
 * activity that automations start from. A deal won or a customer converted
 * after someone clicked a campaign is recorded as that campaign's conversion.
 */

import { query } from '../../db/pool.js';
import { isValidEmail, logContactActivity, marketingSettings } from './core.js';
import { splitName, upsertContact } from './contacts.js';
import { addToAudience } from './audiences.js';
import { recordEvent } from './events.js';

export const CRM_BASIS = 'Existing business relationship: a contact at an organization in the TaskFlow pipeline';

function matches(rule, person) {
  if (!rule) return false;
  if (rule.account_types?.includes(person.type)) return true;
  const tags = (person.tags || []).map((t) => String(t).toLowerCase());
  if (rule.account_tags?.some((t) => tags.includes(t))) return true;
  if (person.segment_id && rule.segment_ids?.includes(person.segment_id)) return true;
  return false;
}

/** One pass: every CRM person with an address, into the audiences they match. */
export async function syncFromCrm({ force = false } = {}) {
  const settings = await marketingSettings();
  if (!settings.crmSync?.enabled && !force) return { skipped: 'CRM sync is switched off' };
  const { rows: audiences } = await query(`SELECT * FROM mkt_audiences WHERE crm_sync IS NOT NULL AND is_archived = FALSE`);
  if (!audiences.length) return { people: 0 };

  const { rows: people } = await query(
    `SELECT ac.id AS crm_contact_id, ac.full_name, ac.email, ac.phone, ac.designation, ac.location, ac.is_active,
            a.id AS account_id, a.name AS account_name, a.type, a.tags, a.segment_id, a.owner_user_id, a.is_archived
       FROM account_contacts ac JOIN accounts a ON a.id = ac.account_id
      WHERE ac.email LIKE '%@%'
     UNION ALL
     -- the single contact recorded on older organizations
     SELECT NULL, a.contact_name, a.contact_email, a.contact_phone, NULL, NULL, TRUE,
            a.id, a.name, a.type, a.tags, a.segment_id, a.owner_user_id, a.is_archived
       FROM accounts a
      WHERE a.contact_email LIKE '%@%'
        AND NOT EXISTS (SELECT 1 FROM account_contacts ac WHERE ac.account_id = a.id AND lower(trim(ac.email)) = lower(trim(a.contact_email)))`,
  );

  const totals = { people: people.length, created: 0, joined: 0, kept_unsubscribed: 0, archived: 0, invalid: 0 };
  for (const p of people) {
    if (!isValidEmail(p.email)) { totals.invalid += 1; continue; }
    const live = p.is_active && !p.is_archived;
    const { first_name: first, last_name: last } = splitName(p.full_name);
    const { contact, created } = await upsertContact(null, {
      email: p.email, first_name: first, last_name: last, phone: p.phone, designation: p.designation,
      organization: p.account_name, city: p.location, account_id: p.account_id, crm_contact_id: p.crm_contact_id,
      owner_user_id: p.owner_user_id,
    }, { source: 'CRM_SYNC' });
    if (created) totals.created += 1;
    for (const audience of audiences) {
      if (live && matches(audience.crm_sync, p)) {
        const r = await addToAudience(null, contact.id, audience.id, {
          status: audience.crm_sync_status, source: 'CRM_SYNC', basis: CRM_BASIS, synced: true,
          meta: { account_id: p.account_id, crm_contact_id: p.crm_contact_id },
        });
        if (r.result === 'SUBSCRIBED' || r.result === 'PENDING') totals.joined += 1;
        if (r.result === 'KEPT_UNSUBSCRIBED' || r.result === 'SUPPRESSED') totals.kept_unsubscribed += 1;
      } else {
        // put there by the CRM, and the CRM no longer puts them there
        const { rowCount } = await query(
          `UPDATE mkt_memberships SET status = 'ARCHIVED', updated_at = now()
            WHERE audience_id = $1 AND contact_id = $2 AND synced = TRUE AND status IN ('SUBSCRIBED', 'PENDING')`,
          [audience.id, contact.id],
        );
        if (rowCount) {
          totals.archived += 1;
          await logContactActivity(null, contact.id, 'LEFT', { audienceId: audience.id, data: { source: 'CRM_SYNC', reason: 'No longer matches the audience rule' } });
        }
      }
    }
  }
  return totals;
}

async function cursor(key) {
  const { rows } = await query('SELECT value FROM mkt_cursors WHERE key = $1', [key]);
  return rows[0]?.value || new Date();
}
const setCursor = (key, value) => query('UPDATE mkt_cursors SET value = $2, updated_at = now() WHERE key = $1 AND (value IS NULL OR value < $2)', [key, value]);

async function contactsOf(accountId) {
  const { rows } = await query('SELECT * FROM mkt_contacts WHERE account_id = $1 AND is_archived = FALSE', [accountId]);
  return rows;
}

/** A pipeline success after someone clicked a campaign is that campaign's conversion. */
async function attributeConversion(contact, { event, entityId, at, value = null }) {
  const { rows } = await query(
    `SELECT m.id FROM mkt_messages m LEFT JOIN mkt_campaigns c ON c.id = m.campaign_id
      WHERE m.contact_id = $1 AND m.first_clicked_at IS NOT NULL AND m.first_clicked_at <= $2
        AND m.first_clicked_at > $2::timestamptz - make_interval(days => COALESCE(c.conversion_window_days, 30))
      ORDER BY m.first_clicked_at DESC LIMIT 1`,
    [contact.id, at],
  );
  if (!rows[0]) return null;
  return recordEvent({
    type: 'CONVERSION', messageId: rows[0].id, source: 'CRM', occurredAt: at, value,
    providerEventId: `crm:${event}:${entityId}:${contact.id}`, meta: { label: event === 'DEAL_WON' ? 'Deal won' : 'Became a customer' },
  });
}

async function emit(accountId, data, at) {
  let n = 0;
  for (const contact of await contactsOf(accountId)) {
    await logContactActivity(null, contact.id, 'TASKFLOW_EVENT', { data });
    if (data.event === 'DEAL_WON' || data.event === 'BECAME_CUSTOMER') await attributeConversion(contact, { event: data.event, entityId: data.entity_id, at, value: data.value ?? null });
    n += 1;
  }
  return n;
}

/** TaskFlow's changes since the last pass, as contact activity. */
export async function pollTaskflowEvents() {
  const out = { leads: 0, customers: 0, deals: 0, tasks: 0 };

  const leadsFrom = await cursor('lead_created');
  const { rows: leads } = await query(
    `SELECT id, name, created_at FROM accounts WHERE type = 'LEAD' AND created_at > $1 ORDER BY created_at LIMIT 500`, [leadsFrom],
  );
  for (const a of leads) {
    out.leads += await emit(a.id, { event: 'LEAD_CREATED', entity_id: a.id, account_id: a.id, name: a.name }, a.created_at);
    await setCursor('lead_created', a.created_at);
  }

  const customersFrom = await cursor('became_customer');
  const { rows: customers } = await query(
    `SELECT id, name, converted_at FROM accounts WHERE type = 'CUSTOMER' AND converted_at > $1 ORDER BY converted_at LIMIT 500`, [customersFrom],
  );
  for (const a of customers) {
    out.customers += await emit(a.id, { event: 'BECAME_CUSTOMER', entity_id: a.id, account_id: a.id, name: a.name }, a.converted_at);
    await setCursor('became_customer', a.converted_at);
  }

  const dealsFrom = await cursor('deal_stage');
  const { rows: moves } = await query(
    `SELECT h.id, h.opportunity_id, h.to_value, h.created_at, o.account_id, o.name, o.agreed_value,
            (SELECT st.kind FROM account_stages st WHERE st.name = h.to_value ORDER BY st.id LIMIT 1) AS kind
       FROM opportunity_history h JOIN opportunities o ON o.id = h.opportunity_id
      WHERE h.field = 'stage' AND h.created_at > $1 ORDER BY h.created_at LIMIT 500`,
    [dealsFrom],
  );
  for (const m of moves) {
    out.deals += await emit(m.account_id, { event: 'DEAL_STAGE', entity_id: m.id, opportunity_id: m.opportunity_id, stage: m.to_value, name: m.name }, m.created_at);
    if (m.kind === 'won') await emit(m.account_id, { event: 'DEAL_WON', entity_id: m.opportunity_id, opportunity_id: m.opportunity_id, name: m.name, value: m.agreed_value }, m.created_at);
    if (m.kind === 'lost') await emit(m.account_id, { event: 'DEAL_LOST', entity_id: m.opportunity_id, opportunity_id: m.opportunity_id, name: m.name }, m.created_at);
    await setCursor('deal_stage', m.created_at);
  }

  const tasksFrom = await cursor('task_completed');
  const { rows: tasks } = await query(
    `SELECT id, ref, title, account_id, completed_at FROM tasks WHERE account_id IS NOT NULL AND completed_at > $1 ORDER BY completed_at LIMIT 500`,
    [tasksFrom],
  );
  for (const t of tasks) {
    out.tasks += await emit(t.account_id, { event: 'TASK_COMPLETED', entity_id: t.id, task_ref: t.ref, title: t.title }, t.completed_at);
    await setCursor('task_completed', t.completed_at);
  }
  return out;
}
