/**
 * The sales CRM's parts of a deal (an "opportunity"): what kind of deal it
 * is, its pipeline, the CSR / NGO detail, the organizations on it and their
 * roles, renewals, and the handover into delivery.
 *
 * Money words are kept apart on purpose. A deal's estimated value is not a
 * forecast, a won deal is a booking (or, for CSR, a funding commitment), and
 * neither is cash: receipts are recorded separately (payments.js).
 */
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nextTaskRef } from '../../lib/taskRef.js';
import { logActivity } from '../crm.js';
import { createKickoffTasks, createOrLinkEngagement } from '../engagements.js';
import { recordHistory } from '../opportunities.js';
import { emitEvent } from './core.js';
import { firstStage } from './pipelines.js';

export const OPPORTUNITY_TYPES = ['NEW_BUSINESS', 'REPEAT', 'RENEWAL', 'UPSELL', 'CSR_FUNDING', 'NGO_PURCHASE', 'PARTNERSHIP'];
/** What the deal is called on screen, by kind: a CSR deal is a funding commitment, not a sale. */
export const OPPORTUNITY_TYPE_LABELS = {
  NEW_BUSINESS: 'New sale',
  REPEAT: 'Repeat sale',
  RENEWAL: 'Renewal / next cycle',
  UPSELL: 'Upsell',
  CSR_FUNDING: 'CSR funding commitment',
  NGO_PURCHASE: 'NGO purchase',
  PARTNERSHIP: 'Partnership',
};
export const FORECAST_CATEGORIES = ['PIPELINE', 'BEST_CASE', 'COMMIT', 'OMITTED'];
export const AGREEMENT_STATUSES = ['NOT_STARTED', 'DRAFTING', 'UNDER_REVIEW', 'SIGNED', 'NOT_REQUIRED'];
export const PARTY_ROLES = ['FUNDER', 'CONTRACTING', 'PAYING', 'IMPLEMENTING_PARTNER', 'BUYER', 'REFERRAL', 'PARTNER', 'OTHER'];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use a date like 2026-04-01');

/** The fields the sales CRM adds to a deal; merged into the deal routes' input. */
export const salesDealShape = {
  pipeline: z.union([z.string().max(40), z.number().int().positive()]).optional(),
  opportunity_type: z.enum(OPPORTUNITY_TYPES).optional(),
  forecast_category: z.enum(FORECAST_CATEGORIES).nullable().optional(),
  is_monetary: z.boolean().optional(),
  renewal_due_on: day.nullable().optional(),
  source_id: z.number().int().positive().nullable().optional(),
  campaign_id: z.number().int().positive().nullable().optional(),
  custom_fields: z.record(z.any()).optional(),
  next_action_absent_reason: z.string().max(500).nullable().optional(),
  lost_reason_code: z.string().max(60).nullable().optional(),
  // CSR / NGO
  thematic_focus: z.array(z.string().max(60)).max(12).optional(),
  proposed_project: z.string().max(5000).nullable().optional(),
  project_geography: z.string().max(500).nullable().optional(),
  beneficiaries: z.string().max(2000).nullable().optional(),
  beneficiary_count: z.number().int().min(0).nullable().optional(),
  requested_amount: z.number().min(0).nullable().optional(),
  committed_amount: z.number().min(0).nullable().optional(),
  funding_cycle: z.string().max(60).nullable().optional(),
  proposal_deadline: day.nullable().optional(),
  agreement_status: z.enum(AGREEMENT_STATUSES).nullable().optional(),
  reporting_commitments: z.string().max(5000).nullable().optional(),
  required_documents: z.array(z.object({
    name: z.string().min(1).max(200),
    received: z.boolean().optional(),
    note: z.string().max(500).optional(),
  })).max(40).optional(),
};

const SALES_COLUMNS = Object.keys(salesDealShape).filter((k) => k !== 'pipeline');
const JSON_COLUMNS = new Set(['custom_fields', 'required_documents']);
// money a person relied on: changing it needs a reason, like the deal's other values
const MONEY_COLUMNS = new Set(['requested_amount', 'committed_amount']);

/** NEW_BUSINESS, REPEAT (the organization has won before) or CSR_FUNDING for the CSR pipeline. */
export async function defaultOpportunityType(client, account, pipelineIdValue) {
  const { rows } = await client.query('SELECT key FROM crm_pipelines WHERE id = $1', [pipelineIdValue]);
  if (rows[0]?.key === 'csr') return account.org_type === 'NGO' ? 'NGO_PURCHASE' : 'CSR_FUNDING';
  const { rows: won } = await client.query(
    `SELECT 1 FROM opportunities WHERE account_id = $1 AND status = 'WON' AND is_archived = FALSE LIMIT 1`, [account.id],
  );
  return won[0] ? 'REPEAT' : 'NEW_BUSINESS';
}

/**
 * Writes the sales CRM fields given in `data` (others untouched) and records
 * each change on the deal's history. `pipeline_id` is only set here when the
 * deal has none.
 */
export async function applySalesFields(client, opportunityId, data, { actorId = null, reason = null, existing = null } = {}) {
  const { rows } = existing ? { rows: [existing] } : await client.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
  const before = rows[0];
  if (!before) throw notFound('Opportunity not found');
  const sets = [];
  const params = [];
  const changes = [];
  for (const key of SALES_COLUMNS) {
    if (data[key] === undefined) continue;
    const value = data[key] === '' ? null : data[key];
    if (MONEY_COLUMNS.has(key) && before[key] !== null && before[key] !== undefined
        && value !== null && Number(before[key]) !== Number(value) && !reason && existing) {
      throw badRequest(`Say why the ${key.replace('_', ' ')} changed — the reason stays on the deal's history`, { code: 'REASON_REQUIRED', field: key });
    }
    params.push(JSON_COLUMNS.has(key) ? JSON.stringify(value ?? (key === 'custom_fields' ? {} : [])) : value);
    sets.push(`${key} = $${params.length}${JSON_COLUMNS.has(key) ? '::jsonb' : ''}`);
    const was = JSON_COLUMNS.has(key) || Array.isArray(before[key]) ? JSON.stringify(before[key] ?? null) : before[key];
    const now = JSON_COLUMNS.has(key) || Array.isArray(value) ? JSON.stringify(value ?? null) : value;
    if (String(was ?? '') !== String(now ?? '')) changes.push([key, was, now]);
  }
  if (data.pipeline_id && !before.pipeline_id) {
    params.push(data.pipeline_id);
    sets.push(`pipeline_id = $${params.length}`);
  }
  if (!sets.length) return before;
  params.push(opportunityId);
  const { rows: after } = await client.query(
    `UPDATE opportunities SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
  );
  // creating a deal records "created"; field-by-field lines are for edits
  if (existing && actorId) {
    for (const [field, from, to] of changes) {
      await recordHistory(client, { opportunityId, field, from, to, actorId, reason });
    }
  }
  return after[0];
}

/**
 * Moves a deal to another pipeline, at a stage of that pipeline. Rare (a CSR
 * enquiry that turns out to be a purchase), so it is explicit and recorded.
 */
export async function changePipeline(client, { opportunityId, stageId, actor, reason }) {
  if (!reason?.trim()) throw badRequest('Say why this deal is moving to another pipeline');
  const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1 FOR UPDATE', [opportunityId]);
  const deal = rows[0];
  if (!deal) throw notFound('Opportunity not found');
  if (deal.status !== 'ACTIVE') throw badRequest('Only an open deal can change pipeline; reopen it first');
  const { rows: st } = await client.query(
    `SELECT s.*, p.name AS pipeline_name FROM account_stages s JOIN crm_pipelines p ON p.id = s.pipeline_id WHERE s.id = $1`, [stageId],
  );
  const stage = st[0];
  if (!stage || stage.retired_at) throw badRequest('Choose a live stage of the new pipeline');
  if (stage.kind !== 'open') throw badRequest('Choose an open stage; win or lose the deal after it has moved');
  if (stage.pipeline_id === deal.pipeline_id) throw badRequest('That stage is in the same pipeline; move the deal normally');
  const { rows: from } = await client.query('SELECT p.name AS pipeline_name, s.name AS stage_name FROM opportunities o LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id LEFT JOIN account_stages s ON s.id = o.stage_id WHERE o.id = $1', [opportunityId]);
  await client.query(
    'UPDATE opportunities SET pipeline_id = $2, stage_id = $3, stage_changed_at = now(), updated_at = now() WHERE id = $1',
    [opportunityId, stage.pipeline_id, stage.id],
  );
  await recordHistory(client, {
    opportunityId, field: 'pipeline', from: `${from[0]?.pipeline_name} · ${from[0]?.stage_name}`, to: `${stage.pipeline_name} · ${stage.name}`,
    reason, actorId: actor.id,
  });
  await emitEvent(client, { type: 'opportunity.stage_changed', entityType: 'OPPORTUNITY', entityId: opportunityId, actorId: actor.id, payload: { pipeline_changed: true, stage_id: stage.id } });
}

// ---------------------------------------------------------------- organizations on a deal

export async function listParties(opportunityId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT p.*, a.name AS account_name, a.org_type, a.lead_category
       FROM opportunity_parties p JOIN accounts a ON a.id = p.account_id
      WHERE p.opportunity_id = $1 ORDER BY p.role, a.name`, [opportunityId],
  );
  return rows;
}

/** Links an organization to a deal in a role; the same link twice is one link. */
export async function addParty(client, { opportunityId, accountId, role, notes = null, actor }) {
  if (!PARTY_ROLES.includes(role)) throw badRequest('Unknown role');
  const { rows: acc } = await client.query('SELECT id, name, archived_at, merged_into_id FROM accounts WHERE id = $1', [accountId]);
  if (!acc[0]) throw badRequest('Organization not found');
  if (acc[0].merged_into_id) throw badRequest('That organization was merged; link the one it was merged into');
  const { rows } = await client.query(
    `INSERT INTO opportunity_parties (opportunity_id, account_id, role, notes, created_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (opportunity_id, account_id, role) DO UPDATE SET notes = COALESCE(EXCLUDED.notes, opportunity_parties.notes)
     RETURNING *, (xmax = 0) AS inserted`,
    [opportunityId, accountId, role, notes, actor.id],
  );
  if (rows[0].inserted) {
    // an organization's roles are kept on it too, so a funder is findable as one
    const orgRole = { FUNDER: 'CSR_FUNDER', IMPLEMENTING_PARTNER: 'IMPLEMENTING_PARTNER', REFERRAL: 'REFERRAL_SOURCE', BUYER: 'CUSTOMER', PAYING: 'CUSTOMER' }[role];
    if (orgRole) {
      await client.query(
        `UPDATE accounts SET org_roles = ARRAY(SELECT DISTINCT unnest(org_roles || ARRAY[$2::text])), updated_at = now() WHERE id = $1 AND NOT ($2 = ANY(org_roles))`,
        [accountId, orgRole],
      );
    }
    await recordHistory(client, { opportunityId, field: 'party', from: null, to: `${acc[0].name} as ${role.toLowerCase().replace(/_/g, ' ')}`, actorId: actor.id });
  }
  return rows[0];
}

export async function removeParty(client, { opportunityId, partyId, actor }) {
  const { rows } = await client.query(
    `DELETE FROM opportunity_parties p USING accounts a WHERE p.id = $1 AND p.opportunity_id = $2 AND a.id = p.account_id
     RETURNING p.role, a.name`, [partyId, opportunityId],
  );
  if (!rows[0]) throw notFound('That organization is not on this deal');
  await recordHistory(client, { opportunityId, field: 'party', from: `${rows[0].name} as ${rows[0].role.toLowerCase().replace(/_/g, ' ')}`, to: null, actorId: actor.id });
}

// ---------------------------------------------------------------- renewals and next cycles

/**
 * Opens the next deal for a won one: a renewal, a next funding cycle, or a
 * repeat order. The won deal is never changed to represent the new sale, and
 * asking twice returns the same renewal (one per deal, by a unique index).
 */
export async function createRenewal(client, { opportunityId, actor, name = null, expectedClose = null, ownerUserId = null }) {
  const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1 FOR UPDATE', [opportunityId]);
  const deal = rows[0];
  if (!deal) throw notFound('Opportunity not found');
  if (deal.status !== 'WON') throw badRequest('Only a won deal has a renewal or next cycle');
  const { rows: existing } = await client.query('SELECT id FROM opportunities WHERE renewal_of_id = $1', [opportunityId]);
  if (existing[0]) return { id: existing[0].id, created: false };
  const stageId = await firstStage(deal.pipeline_id, client);
  const { rows: pipe } = await client.query('SELECT key FROM crm_pipelines WHERE id = $1', [deal.pipeline_id]);
  const isCsr = pipe[0]?.key === 'csr';
  const owner = ownerUserId ?? deal.owner_user_id ?? actor.id;
  const due = expectedClose || deal.renewal_due_on || null;
  const { rows: created } = await client.query(
    `INSERT INTO opportunities
       (account_id, name, engagement_model, stage_id, status, owner_user_id, currency, expected_close, original_close,
        pipeline_id, opportunity_type, renewal_of_id, source_id, campaign_id, is_monetary, thematic_focus,
        proposed_project, project_geography, beneficiaries, funding_cycle, created_by,
        next_step, next_step_due, next_step_owner_id, next_step_set_at, next_step_set_by)
     VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7::date,$7::date,$8,'RENEWAL',$9,$10,$11,$12,$13,$14,$15,$16,NULL,$17,
             $18, GREATEST(CURRENT_DATE + 1, COALESCE($7::date - 30, CURRENT_DATE + 7)), $5, now(), $17)
     RETURNING *`,
    [
      deal.account_id, name || `${deal.name} — ${isCsr ? 'next cycle' : 'renewal'}`, deal.engagement_model, stageId, owner,
      deal.currency, due, deal.pipeline_id, deal.id, deal.source_id, deal.campaign_id, deal.is_monetary,
      deal.thematic_focus || [], deal.proposed_project, deal.project_geography, deal.beneficiaries, actor.id,
      isCsr ? 'Start the next funding cycle conversation' : 'Confirm renewal scope and timing',
    ],
  );
  const renewal = created[0];
  // stakeholders and organizations carry over; the new deal records its own outcome
  await client.query(
    `INSERT INTO opportunity_contacts (opportunity_id, contact_id, role)
     SELECT $1, contact_id, role FROM opportunity_contacts WHERE opportunity_id = $2 ON CONFLICT DO NOTHING`, [renewal.id, deal.id],
  );
  await client.query(
    `INSERT INTO opportunity_parties (opportunity_id, account_id, role, notes, created_by)
     SELECT $1, account_id, role, notes, $3 FROM opportunity_parties WHERE opportunity_id = $2 ON CONFLICT DO NOTHING`, [renewal.id, deal.id, actor.id],
  );
  await recordHistory(client, { opportunityId: renewal.id, field: 'created', to: renewal.name, reason: `Renewal of #${deal.id}`, actorId: actor.id });
  await recordHistory(client, { opportunityId: deal.id, field: 'renewal', to: `#${renewal.id} ${renewal.name}`, actorId: actor.id });
  await logActivity(client, {
    accountId: deal.account_id, opportunityId: renewal.id, type: 'RENEWAL', actorId: actor.id,
    subject: `${isCsr ? 'Next cycle' : 'Renewal'} opened: ${renewal.name}`, source: 'MANUAL',
  });
  await emitEvent(client, { type: 'opportunity.renewal_created', entityType: 'OPPORTUNITY', entityId: renewal.id, actorId: actor.id, payload: { renewal_of: deal.id } });
  return { id: renewal.id, created: true };
}

// ---------------------------------------------------------------- handover into delivery

const reportingInput = z.array(z.object({
  title: z.string().min(2).max(200),
  due_on: day,
  notes: z.string().max(1000).optional(),
})).max(24);

export const handoverInput = z.object({
  name: z.string().max(200).optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  kickoff_on: day.nullable().optional(),
  ends_on: day.nullable().optional(),
  deliverables: z.string().max(20000).nullable().optional(),
  agreed_scope: z.string().max(20000).nullable().optional(),
  milestones: z.array(z.object({ title: z.string().min(2).max(200), due_date: day.nullable().optional(), description: z.string().max(2000).optional() })).max(40).optional(),
  reporting: reportingInput.optional(),
  create_kickoff_tasks: z.boolean().optional(),
});

/**
 * Hands a won deal to delivery: the existing TaskFlow engagement, its
 * milestones, kickoff tasks and (for CSR) reporting tasks. One engagement per
 * deal; asking again (a retry, a double click, a second person) returns it and
 * creates nothing more. A manager then accepts the handover or returns it.
 */
export async function startHandover(client, { opportunityId, actor, input = {} }) {
  const data = handoverInput.parse(input);
  // serialises concurrent handovers of the same deal
  const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1 FOR UPDATE', [opportunityId]);
  const deal = rows[0];
  if (!deal) throw notFound('Opportunity not found');
  if (deal.status !== 'WON') throw badRequest('Delivery starts once the deal is won — this one is not');
  if (data.owner_user_id) {
    const { rows: u } = await client.query('SELECT is_active FROM users WHERE id = $1', [data.owner_user_id]);
    if (!u[0]?.is_active) throw badRequest('Choose an active person to own delivery');
  }
  const linked = await createOrLinkEngagement(client, {
    opportunity: deal, actor, name: data.name, ownerUserId: data.owner_user_id ?? undefined, kickoffOn: data.kickoff_on ?? undefined,
  });
  if (!linked.created) return { engagement_id: linked.engagement_id, created: false, tasks: 0, milestones: 0 };

  const engagementId = linked.engagement_id;
  await client.query(
    `UPDATE engagements SET handover_status = 'IN_REVIEW', deliverables = $2, ends_on = $3::date,
            agreed_scope = COALESCE($4, agreed_scope), reporting_schedule = $5::jsonb, updated_at = now()
      WHERE id = $1`,
    [engagementId, data.deliverables ?? deal.scope_summary ?? null, data.ends_on ?? null, data.agreed_scope ?? null,
      JSON.stringify(data.reporting ?? [])],
  );
  let milestones = 0;
  for (const [index, m] of (data.milestones ?? []).entries()) {
    await client.query(
      'INSERT INTO engagement_milestones (engagement_id, title, description, due_date, position) VALUES ($1,$2,$3,$4::date,$5)',
      [engagementId, m.title, m.description ?? null, m.due_date ?? null, index],
    );
    milestones += 1;
  }
  const { rows: fresh } = await client.query('SELECT * FROM engagements WHERE id = $1', [engagementId]);
  let tasks = 0;
  if (data.create_kickoff_tasks !== false) tasks += (await createKickoffTasks(client, fresh[0], actor)).length;
  tasks += await createReportingTasks(client, fresh[0], data.reporting ?? [], actor);
  // the payment schedule, when there is one, is linked to the engagement's milestones by the payments screen
  await recordHistory(client, { opportunityId, field: 'handover', to: 'Sent for review', actorId: actor.id });
  await emitEvent(client, { type: 'handover.created', entityType: 'ENGAGEMENT', entityId: engagementId, actorId: actor.id, payload: { opportunity_id: opportunityId } });
  return { engagement_id: engagementId, created: true, tasks, milestones };
}

/** One task per reporting commitment, through the ordinary task engine. */
async function createReportingTasks(client, engagement, reporting, actor) {
  if (!reporting.length) return 0;
  const { rows: statusRows } = await client.query('SELECT id FROM workflow_statuses WHERE is_active = TRUE ORDER BY is_default DESC, position ASC LIMIT 1');
  const { rows: acc } = await client.query('SELECT department_id FROM accounts WHERE id = $1', [engagement.account_id]);
  const departmentId = acc[0]?.department_id ?? actor.department_id;
  if (!statusRows[0] || !departmentId) return 0;
  let n = 0;
  for (const r of reporting) {
    const ref = await nextTaskRef(client, departmentId);
    await client.query(
      `INSERT INTO tasks (ref, title, description, department_id, status_id, priority, assignee_id, reporter_id, created_by,
                          due_date, original_due_date, account_id, opportunity_id, engagement_id, position)
       VALUES ($1,$2,$3,$4,$5,'medium',$6,$7,$7,$8::date,$8::date,$9,$10,$11,(SELECT COALESCE(MAX(position),0)+100 FROM tasks WHERE status_id = $5))`,
      [ref, `Report due: ${r.title} — ${engagement.name}`, r.notes ?? null, departmentId, statusRows[0].id,
        engagement.owner_user_id ?? actor.id, actor.id, r.due_on, engagement.account_id, engagement.opportunity_id, engagement.id],
    );
    n += 1;
  }
  return n;
}

/** A manager accepts the handover, or returns it with what is missing. */
export async function reviewHandover(client, { engagementId, actor, decision, note = null }) {
  if (!['ACCEPTED', 'RETURNED'].includes(decision)) throw badRequest('Accept or return the handover');
  if (decision === 'RETURNED' && !note?.trim()) throw badRequest('Say what is missing so it can be fixed');
  const { rows } = await client.query('SELECT * FROM engagements WHERE id = $1 FOR UPDATE', [engagementId]);
  const e = rows[0];
  if (!e) throw notFound('Delivery record not found');
  if (e.created_by === actor.id && decision === 'ACCEPTED') {
    // the person who wrote the handover does not sign it off
    const { rows: others } = await client.query(
      `SELECT 1 FROM users WHERE is_active = TRUE AND id <> $1 AND role IN ('admin','manager') LIMIT 1`, [actor.id],
    );
    if (others[0]) throw badRequest('Someone other than the person who wrote the handover reviews it');
  }
  await client.query(
    `UPDATE engagements SET handover_status = $2, handover_reviewed_by = $3, handover_reviewed_at = now(), handover_note = $4, updated_at = now()
      WHERE id = $1`, [engagementId, decision, actor.id, note],
  );
  if (e.opportunity_id) {
    await recordHistory(client, { opportunityId: e.opportunity_id, field: 'handover', from: e.handover_status, to: decision === 'ACCEPTED' ? 'Accepted' : 'Returned', reason: note, actorId: actor.id });
  }
  return decision;
}
