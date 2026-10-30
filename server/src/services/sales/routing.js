/**
 * The Taskflow / TeleCRM boundary.
 *
 * Taskflow's CRM works B2B corporate and CSR / NGO leads. Retailers, FPOs and
 * individual consumers belong in TeleCRM; a lead whose category is not known
 * waits in a restricted review queue. Every way a lead or organization enters
 * or changes — the form on screen, an edit, a bulk change, an import, the API,
 * a webhook, a public form, a conversion, automation — goes through
 * `routeLead` / `classifyAccount`, so the rule lives in one place.
 *
 * Nothing is discarded and nothing is claimed: an excluded lead is kept, with
 * its history, on a hand-off list until a person confirms TeleCRM has it.
 */
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { recordAuditEvent } from '../audit.js';
import {
  CATEGORY_LABEL, EXCLUDED_CATEGORIES, LEAD_CATEGORIES, emitEvent, isEligible, isExcluded, salesSettings,
} from './core.js';

/** Where a category goes. */
export function routeFor(category, settings = {}) {
  if (isEligible(category)) return { destination: 'TASKFLOW', routingStatus: 'ACTIVE' };
  if (isExcluded(category)) {
    return settings.routing?.excludedDestination === 'TRIAGE'
      ? { destination: 'TRIAGE', routingStatus: 'NEEDS_CLASSIFICATION' }
      : { destination: 'TELECRM', routingStatus: 'HANDOFF_PENDING' };
  }
  return { destination: 'TRIAGE', routingStatus: 'NEEDS_CLASSIFICATION' };
}

const ALIASES = [
  [/^(b2b|b2b[ _-]?corporate|corporate|company|business|enterprise|institution|government|agri[ -]?business|manufacturer|agritech|agri[ -]?tech)$/i, 'B2B_CORPORATE'],
  [/^(csr|csr[ _/-]?ngo|ngo|foundation|trust|csr team|csr foundation|non[ -]?profit|charity|society)$/i, 'CSR_NGO'],
  [/^(retailer|retail|dealer|distributor|shop|agri[ -]?input (dealer|retailer)|krishi kendra)$/i, 'RETAILER'],
  [/^(fpo|fpc|farmer producer (organi[sz]ation|company)|producer company)$/i, 'FPO'],
  [/^(individual|consumer|farmer|person|customer|individual[ /]consumer|farmer[ /]individual)$/i, 'INDIVIDUAL'],
  [/^(unclassified|unknown|not sure|other)$/i, 'UNCLASSIFIED'],
];

/**
 * A category from what a form, file or other system says. Only explicit
 * answers are read; a company name is never used to guess. Unknown → UNCLASSIFIED.
 */
export function categoryFromInput(value) {
  if (value === null || value === undefined || value === '') return 'UNCLASSIFIED';
  const v = String(value).trim();
  if (LEAD_CATEGORIES.includes(v.toUpperCase())) return v.toUpperCase();
  for (const [pattern, category] of ALIASES) if (pattern.test(v)) return category;
  return 'UNCLASSIFIED';
}

const FPO_NAME = /(\bfpo\b|\bfpc\b|farmers?'? producer|producer company|producer organi[sz]ation)/i;
const RETAIL_NAME = /(\bretail|\btraders?\b|agro (centre|center|agency|agencies|kendra|store|services)|krishi kendra|seeds? (and|&) fertili[sz]ers?|fertili[sz]er (shop|store|depot)|\bdealers?\b)/i;

/** A suggestion for a person to confirm, with the reason; never applied by itself. */
export function suggestCategory({ name = '', segmentSlug = null, segmentName = null, contactOnly = false } = {}) {
  if (FPO_NAME.test(name)) return { category: 'FPO', reason: 'The name reads like a farmer producer organization' };
  if (RETAIL_NAME.test(name)) return { category: 'RETAILER', reason: 'The name reads like a retailer or dealer' };
  if (['csr', 'foundation', 'ngo'].includes(segmentSlug)) return { category: 'CSR_NGO', reason: `Its segment is ${segmentName || segmentSlug}` };
  if (contactOnly) return { category: 'INDIVIDUAL', reason: 'No organization was given' };
  return { category: 'B2B_CORPORATE', reason: segmentName ? `Its segment is ${segmentName}` : 'An organization with no other signal' };
}

/** Writes one routing decision on the record of decisions (append-only). */
async function recordRouting(client, { leadId = null, accountId = null, from = {}, to = {}, channel = null, reason = null, actorId = null }) {
  await client.query(
    `INSERT INTO crm_routing_events
       (lead_id, account_id, from_category, to_category, from_destination, to_destination, routing_status, entry_channel, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [leadId, accountId, from.category ?? null, to.category ?? null, from.destination ?? null, to.destination ?? null,
      to.routingStatus ?? null, channel, reason, actorId],
  );
}

/** Opens a hand-off for an excluded record, or returns the live one. */
async function openHandoff(client, { leadId = null, accountId = null, payload = {} }) {
  const col = leadId ? 'lead_id' : 'account_id';
  const id = leadId || accountId;
  const { rows: existing } = await client.query(
    `SELECT * FROM crm_handoffs WHERE ${col} = $1 AND target = 'TELECRM' AND status <> 'CANCELLED'`, [id],
  );
  if (existing[0]) return existing[0];
  const { rows } = await client.query(
    `INSERT INTO crm_handoffs (lead_id, account_id, target, method, status, payload)
     VALUES ($1,$2,'TELECRM','MANUAL_EXPORT','PENDING',$3) RETURNING *`,
    [leadId, accountId, payload],
  );
  return rows[0];
}

async function cancelHandoff(client, { leadId = null, accountId = null, reason }) {
  const col = leadId ? 'lead_id' : 'account_id';
  await client.query(
    `UPDATE crm_handoffs SET status = 'CANCELLED', cancelled_reason = $2, updated_at = now()
      WHERE ${col} = $1 AND target = 'TELECRM' AND status IN ('PENDING', 'FAILED')`,
    [leadId || accountId, reason],
  );
}

export const handoffPayload = (lead) => ({
  ref: lead.ref, category: lead.category, organization: lead.organization_name, name: lead.contact_name,
  phone: lead.phone, email: lead.email, city: lead.city, state: lead.state, enquiry: lead.enquiry,
  captured_at: lead.captured_at,
});

/**
 * Sets a lead's category and everything that follows from it: destination,
 * routing status, the hand-off, and the routing record. Returns the routing.
 * The caller holds the transaction and has the lead row.
 */
export async function routeLead(client, lead, { category, actor = null, channel = null, reason = null, settings = null }) {
  if (!LEAD_CATEGORIES.includes(category)) throw badRequest(`Unknown lead category: ${category}`);
  const s = settings || await salesSettings();
  const to = { category, ...routeFor(category, s) };
  const from = { category: lead.category, destination: lead.destination };
  const changed = lead.category !== category || lead.destination !== to.destination || lead.routing_status !== to.routingStatus;
  // a hand-off already exported or confirmed keeps its state
  if (to.routingStatus === 'HANDOFF_PENDING' && ['HANDOFF_EXPORTED', 'HANDED_OFF'].includes(lead.routing_status) && lead.category === category) {
    return { ...to, routingStatus: lead.routing_status, changed: false };
  }
  if (!changed && lead.id) return { ...to, changed: false };

  if (lead.id) {
    await client.query(
      `UPDATE crm_leads SET category = $2, destination = $3, routing_status = $4, updated_at = now(), updated_by = $5
        WHERE id = $1`,
      [lead.id, category, to.destination, to.routingStatus, actor?.id ?? null],
    );
    if (to.destination === 'TELECRM') {
      await openHandoff(client, { leadId: lead.id, payload: handoffPayload({ ...lead, category }) });
    } else {
      await cancelHandoff(client, { leadId: lead.id, reason: `Reclassified as ${CATEGORY_LABEL[category]}` });
    }
    // an excluded or unclassified lead leaves active work: its owner keeps
    // the record, but it is not in assignment pools, forecasts or totals
    await recordRouting(client, { leadId: lead.id, from, to, channel, reason, actorId: actor?.id ?? null });
    await client.query(
      `INSERT INTO crm_lead_activities (lead_id, type, direction, subject, body, actor_id, meta)
       VALUES ($1, 'ROUTING', 'INTERNAL', $2, $3, $4, $5)`,
      [lead.id,
        to.destination === 'TASKFLOW' ? `Classified as ${CATEGORY_LABEL[category]}`
          : to.destination === 'TELECRM' ? `${CATEGORY_LABEL[category]}: queued for TeleCRM`
            : 'Waiting for classification',
        reason, actor?.id ?? null, { from, to }],
    );
    await emitEvent(client, {
      type: 'lead.routed', entityType: 'LEAD', entityId: lead.id, actorId: actor?.id ?? null,
      payload: { category, destination: to.destination, from_category: from.category },
    });
  }
  return { ...to, changed: true };
}

/**
 * The same boundary for an organization: confirming or changing its category.
 * An excluded organization leaves the active pipeline (its deals are kept but
 * no longer counted) and is queued for TeleCRM.
 */
export async function classifyAccount(client, accountId, { category, actor, reason = null, source = 'MANUAL' }) {
  if (!LEAD_CATEGORIES.includes(category)) throw badRequest(`Unknown lead category: ${category}`);
  const { rows } = await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  const account = rows[0];
  if (!account) throw notFound('Organization not found');
  const status = isEligible(category) ? 'ACTIVE' : isExcluded(category) ? 'EXCLUDED' : 'NEEDS_CLASSIFICATION';
  if (account.lead_category === category && account.routing_status === status) return { category, routingStatus: status, changed: false };
  await client.query(
    `UPDATE accounts SET lead_category = $2, routing_status = $3, category_source = $4, category_set_at = now(),
            category_set_by = $5, updated_at = now()
      WHERE id = $1`,
    [accountId, category, status, source, actor?.id ?? null],
  );
  if (isExcluded(category)) {
    await openHandoff(client, {
      accountId,
      payload: { ref: `ORG-${accountId}`, category, organization: account.name, phone: account.contact_phone, email: account.contact_email, state: account.state },
    });
  } else {
    await cancelHandoff(client, { accountId, reason: `Confirmed as ${CATEGORY_LABEL[category]}` });
  }
  await recordRouting(client, {
    accountId,
    from: { category: account.lead_category, destination: account.routing_status },
    to: { category, destination: isEligible(category) ? 'TASKFLOW' : isExcluded(category) ? 'TELECRM' : 'TRIAGE', routingStatus: status },
    channel: source, reason, actorId: actor?.id ?? null,
  });
  await recordAuditEvent(client, {
    action: 'ACCOUNT_CLASSIFIED', entityType: 'ACCOUNT', entityId: accountId, actorId: actor?.id ?? null, reason,
    summary: `${account.name}: ${account.lead_category ? CATEGORY_LABEL[account.lead_category] : 'legacy, unconfirmed'} → ${CATEGORY_LABEL[category]}`,
    detail: { from: account.lead_category, to: category, routing_status: status },
  });
  await client.query(
    `INSERT INTO account_activities (account_id, type, actor_id, subject, body, direction, outcome, is_external, source)
     VALUES ($1, 'NOTE', $2, $3, $4, 'INTERNAL', 'NOTED', FALSE, 'SYSTEM')`,
    [accountId, actor?.id ?? null, `Category: ${CATEGORY_LABEL[category]}`, reason],
  );
  return { category, routingStatus: status, changed: true };
}

// ---------------------------------------------------------------- hand-off list

export async function listHandoffs({ status = null, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT h.*, l.ref AS lead_ref, l.category AS lead_category, l.organization_name, l.contact_name, l.phone, l.email,
            l.city, l.state, l.enquiry, l.captured_at, a.name AS account_name, a.lead_category AS account_category,
            eu.full_name AS exported_by_name, cu.full_name AS confirmed_by_name
       FROM crm_handoffs h
       LEFT JOIN crm_leads l ON l.id = h.lead_id
       LEFT JOIN accounts a ON a.id = h.account_id
       LEFT JOIN users eu ON eu.id = h.exported_by
       LEFT JOIN users cu ON cu.id = h.confirmed_by
      WHERE ($1::text IS NULL AND h.status <> 'CANCELLED') OR h.status = $1
      ORDER BY h.created_at DESC LIMIT $2`,
    [status, Math.min(Number(limit) || 200, 2000)],
  );
  return rows;
}

export const HANDOFF_HEADER = ['TaskFlow ref', 'Category', 'Organization', 'Name', 'Phone', 'Email', 'City', 'State', 'Enquiry', 'Captured on'];

export const handoffRow = (h) => [
  h.lead_ref || `ORG-${h.account_id}`, CATEGORY_LABEL[h.lead_category || h.account_category] || '',
  h.organization_name || h.account_name || '', h.contact_name || '', h.payload?.phone || h.phone || '',
  h.payload?.email || h.email || '', h.city || '', h.state || h.payload?.state || '', h.enquiry || '',
  h.captured_at ? new Date(h.captured_at).toISOString().slice(0, 10) : '',
];

/** Marks hand-offs exported in one batch. Exporting is not handing off: nothing is confirmed. */
export async function markExported(client, ids, { actor, format }) {
  if (!ids.length) throw badRequest('Choose the leads to export');
  const { rows: batch } = await client.query(
    `INSERT INTO crm_handoff_batches (target, format, row_count, created_by) VALUES ('TELECRM', $1, $2, $3) RETURNING id`,
    [format, ids.length, actor.id],
  );
  const { rows } = await client.query(
    `UPDATE crm_handoffs SET status = 'EXPORTED', batch_id = $2, exported_at = now(), exported_by = $3, attempts = attempts + 1,
            updated_at = now()
      WHERE id = ANY($1::int[]) AND status IN ('PENDING', 'EXPORTED', 'FAILED') RETURNING *`,
    [ids, batch[0].id, actor.id],
  );
  for (const h of rows) {
    if (h.lead_id) await client.query(`UPDATE crm_leads SET routing_status = 'HANDOFF_EXPORTED', updated_at = now() WHERE id = $1 AND destination = 'TELECRM'`, [h.lead_id]);
  }
  await recordAuditEvent(client, {
    action: 'TELECRM_EXPORT', entityType: 'HANDOFF_BATCH', entityId: batch[0].id, actorId: actor.id,
    summary: `${rows.length} lead(s) exported for TeleCRM (${format})`, detail: { ids: rows.map((r) => r.id) },
  });
  return { batchId: batch[0].id, handoffs: rows };
}

/** A person confirms TeleCRM has the lead — the only way a hand-off is marked done. */
export async function confirmHandoff(client, id, { actor, externalId = null, note = null, failed = false, error = null }) {
  const { rows } = await client.query('SELECT * FROM crm_handoffs WHERE id = $1 FOR UPDATE', [id]);
  const h = rows[0];
  if (!h) throw notFound('Hand-off not found');
  if (h.status === 'CANCELLED') throw badRequest('This hand-off was cancelled: the record was reclassified');
  if (failed) {
    await client.query(
      `UPDATE crm_handoffs SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1`, [id, error || note || 'Marked as not received'],
    );
    if (h.lead_id) await client.query(`UPDATE crm_leads SET routing_status = 'HANDOFF_FAILED', updated_at = now() WHERE id = $1`, [h.lead_id]);
  } else {
    await client.query(
      `UPDATE crm_handoffs SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = $2, external_id = COALESCE($3, external_id),
              confirmation_note = $4, last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [id, actor.id, externalId, note],
    );
    if (h.lead_id) await client.query(`UPDATE crm_leads SET routing_status = 'HANDED_OFF', updated_at = now() WHERE id = $1`, [h.lead_id]);
  }
  if (h.lead_id) {
    await client.query(
      `INSERT INTO crm_lead_activities (lead_id, type, direction, subject, body, actor_id, meta)
       VALUES ($1, 'ROUTING', 'INTERNAL', $2, $3, $4, $5)`,
      [h.lead_id, failed ? 'TeleCRM hand-off failed' : 'Confirmed in TeleCRM', note || error, actor.id, { external_id: externalId }],
    );
  }
  await recordAuditEvent(client, {
    action: failed ? 'TELECRM_HANDOFF_FAILED' : 'TELECRM_HANDOFF_CONFIRMED', entityType: 'HANDOFF', entityId: id, actorId: actor.id,
    summary: failed ? 'Hand-off marked as failed' : `Confirmed in TeleCRM${externalId ? ` as ${externalId}` : ''}`, reason: note,
  });
}

/** Organizations awaiting an administrator's confirmation of their category. */
export async function remediationQueue() {
  const { rows } = await query(
    `SELECT a.id, a.name, a.type, a.lead_category, a.routing_status, a.suggested_category, a.suggestion_reason,
            s.name AS segment_name, u.full_name AS owner_name, a.state,
            (SELECT COUNT(*)::int FROM opportunities o WHERE o.account_id = a.id AND o.is_archived = FALSE AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')) AS open_deals
       FROM accounts a
       LEFT JOIN crm_segments s ON s.id = a.segment_id
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.is_archived = FALSE AND (a.routing_status IN ('LEGACY_UNCONFIRMED', 'NEEDS_CLASSIFICATION') OR a.lead_category = 'UNCLASSIFIED')
      ORDER BY (a.suggested_category IN ('FPO', 'RETAILER')) DESC, a.name`,
  );
  return rows.map((r) => ({ ...r, flagged: EXCLUDED_CATEGORIES.includes(r.suggested_category) }));
}
