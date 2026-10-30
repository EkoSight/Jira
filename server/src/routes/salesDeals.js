import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { recordAuditEvent } from '../services/audit.js';
import { getEngagement } from '../services/engagements.js';
import { canWorkOnOpportunity, recordHistory } from '../services/opportunities.js';
import { assertVisible, salesSettings } from '../services/sales/core.js';
import {
  OPPORTUNITY_TYPE_LABELS, PARTY_ROLES, addParty, changePipeline, createRenewal, listParties, removeParty, reviewHandover, startHandover,
} from '../services/sales/deals.js';
import { REQUIRED_FIELD_KEYS, addStage, listPipelines, retireStage, updateStage } from '../services/sales/pipelines.js';
import {
  ACCEPTANCE_METHODS, QUOTE_KINDS, createQuote, decideApproval, getQuote, listQuotes, markSent, pendingApprovalsFor, recordDecision,
  reviseQuote, submitQuote, updateQuote, withdrawQuote,
} from '../services/sales/quotes.js';
import { renderQuotePdf } from '../services/sales/quotePdf.js';
import {
  PAYMENT_MODES, addSchedule, cancelSchedule, fxRate, paymentPosition, recordPayment, setFxRate, updateSchedule, verifyPayment,
  voidSalesPayment,
} from '../services/sales/payments.js';

/**
 * The sales CRM's deal work: pipelines and stages, the organizations on a
 * deal, quotations and proposals with their approvals and PDFs, handover into
 * delivery, renewals, and payment schedules, receipts and refunds.
 *
 * Every route that names a deal checks it is inside the person's book first;
 * changing it also needs the person to be working on it.
 */
const router = Router();

const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const stagesOnly = requirePermission('crm.stages.manage');
const settingsOnly = requirePermission('crm.settings');

async function loadDeal(dealId) {
  const { rows } = await query(
    `SELECT o.*, a.owner_user_id AS relationship_owner_id, a.name AS account_name
       FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE o.id = $1`, [dealId],
  );
  if (!rows[0]) throw notFound('Opportunity not found');
  return rows[0];
}

/**
 * The deal, if the person may see it; with `work`, only if they may change it.
 * With `finance`, the finance permission reaches any deal's payments: finance
 * verifies and corrects money across the book without owning the deals.
 */
async function deal(req, dealId, { work = false, finance = false } = {}) {
  if (finance && hasPermission(req.currentUser, 'crm.finance')) return loadDeal(dealId);
  await assertVisible(req.currentUser, 'opportunity', dealId, 'Opportunity');
  const row = await loadDeal(dealId);
  if (work && !(await canWorkOnOpportunity(req.currentUser, row))) throw forbidden('You cannot change this opportunity');
  return row;
}

async function quoteFor(req, quoteId, { work = false } = {}) {
  const { rows } = await query('SELECT opportunity_id FROM crm_quotes WHERE id = $1', [quoteId]);
  if (!rows[0]) throw notFound('Quotation not found');
  // a named approver reads what they are asked to approve, wherever the deal sits
  if (!work) {
    const { rows: named } = await query(
      `SELECT 1 FROM crm_approvals WHERE quote_id = $1 AND $2 = ANY(approver_ids) LIMIT 1`, [quoteId, req.currentUser.id],
    );
    if (named[0]) return rows[0].opportunity_id;
  }
  await deal(req, rows[0].opportunity_id, { work });
  return rows[0].opportunity_id;
}

// ---------------------------------------------------------------- pipelines

router.get('/pipelines', asyncHandler(async (req, res) => {
  res.json({
    pipelines: await listPipelines({ includeRetired: req.query.retired === '1' }),
    required_fields: REQUIRED_FIELD_KEYS,
    opportunity_types: OPPORTUNITY_TYPE_LABELS,
  });
}));

const checklist = z.array(z.object({ label: z.string().min(1).max(200), required: z.boolean().optional() })).max(20);
const stageInput = z.object({
  name: z.string().min(2).max(60),
  kind: z.enum(['open', 'won', 'lost']).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  position: z.number().int().optional(),
  default_probability: z.number().int().min(0).max(100).nullable().optional(),
  required_fields: z.array(z.string().max(40)).max(20).optional(),
  checklist: checklist.optional(),
  allowed_to: z.array(z.number().int().positive()).max(30).nullable().optional(),
  aging_days: z.number().int().min(1).max(365).nullable().optional(),
  approval_gate: z.boolean().optional(),
  counts_in_forecast: z.boolean().optional(),
  quiet_after_days: z.number().int().min(1).max(365).nullable().optional(),
  entry_expectations: z.string().max(2000).nullable().optional(),
  is_active: z.boolean().optional(),
});

router.post('/pipelines/:pid/stages', stagesOnly, asyncHandler(async (req, res) => {
  const data = stageInput.parse(req.body);
  const stage = await withTransaction(async (client) => {
    const created = await addStage(client, id(req.params.pid), data);
    await recordAuditEvent(client, { action: 'STAGE_CREATED', entityType: 'STAGE', entityId: created.id, actorId: req.currentUser.id, summary: created.name, detail: data });
    return created;
  });
  res.status(201).json({ stage });
}));

router.patch('/stages/:sid', stagesOnly, asyncHandler(async (req, res) => {
  const data = stageInput.partial().parse(req.body);
  const stage = await withTransaction(async (client) => {
    const { before, after } = await updateStage(client, id(req.params.sid), data);
    await recordAuditEvent(client, {
      action: 'STAGE_UPDATED', entityType: 'STAGE', entityId: after.id, actorId: req.currentUser.id, summary: after.name,
      detail: { before: Object.fromEntries(Object.keys(data).map((k) => [k, before[k]])), after: data },
    });
    return after;
  });
  res.json({ stage });
}));

router.post('/stages/:sid/retire', stagesOnly, asyncHandler(async (req, res) => {
  const { into_stage_id: into } = z.object({ into_stage_id: z.number().int().positive().nullable().optional() }).parse(req.body ?? {});
  const result = await withTransaction(async (client) => {
    const r = await retireStage(client, id(req.params.sid), { intoStageId: into ?? null, actor: req.currentUser, recordHistory });
    await recordAuditEvent(client, {
      action: 'STAGE_RETIRED', entityType: 'STAGE', entityId: r.stage.id, actorId: req.currentUser.id, summary: r.stage.name,
      detail: { into: r.into?.id ?? null, moved: r.moved },
    });
    return r;
  });
  res.json({ retired: result.stage.id, into: result.into?.id ?? null, moved: result.moved });
}));

router.put('/pipelines/:pid/order', stagesOnly, asyncHandler(async (req, res) => {
  const { stage_ids: stageIds } = z.object({ stage_ids: z.array(z.number().int().positive()).min(1).max(40) }).parse(req.body);
  const pid = id(req.params.pid);
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, position FROM account_stages WHERE pipeline_id = $1 AND retired_at IS NULL', [pid]);
    const known = new Set(rows.map((r) => r.id));
    if (stageIds.length !== known.size || stageIds.some((s) => !known.has(s))) throw badRequest('List every live stage of this pipeline exactly once');
    const base = Math.min(...rows.map((r) => r.position));
    for (const [i, sid] of stageIds.entries()) await client.query('UPDATE account_stages SET position = $1, updated_at = now() WHERE id = $2', [base + i, sid]);
    await recordAuditEvent(client, { action: 'STAGES_REORDERED', entityType: 'PIPELINE', entityId: pid, actorId: req.currentUser.id, detail: { order: stageIds } });
  });
  res.json({ pipelines: await listPipelines() });
}));

router.post('/opportunities/:id/pipeline', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const { stage_id: stageId, reason } = z.object({ stage_id: z.number().int().positive(), reason: z.string().min(3).max(2000) }).parse(req.body);
  const dealId = id(req.params.id);
  await deal(req, dealId, { work: true });
  await withTransaction((client) => changePipeline(client, { opportunityId: dealId, stageId, actor: req.currentUser, reason }));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- the deal's sales summary

router.get('/opportunities/:id/sales', asyncHandler(async (req, res) => {
  const dealId = id(req.params.id);
  const row = await deal(req, dealId);
  const [parties, quotes, position, engagement, renewals, pipeline] = await Promise.all([
    listParties(dealId),
    listQuotes(dealId),
    paymentPosition(dealId),
    query('SELECT id FROM engagements WHERE opportunity_id = $1', [dealId]),
    query(`SELECT id, name, status, expected_close, renewal_of_id FROM opportunities
            WHERE (renewal_of_id = $1 OR id = $2) AND is_archived = FALSE`, [dealId, row.renewal_of_id ?? 0]),
    query('SELECT id, key, name FROM crm_pipelines WHERE id = $1', [row.pipeline_id]),
  ]);
  // who to call or message about this deal: its primary contact, else the organization's
  const { rows: contact } = await query(
    `SELECT c.id, c.full_name, c.phone, c.email FROM account_contacts c
      LEFT JOIN opportunity_contacts oc ON oc.contact_id = c.id AND oc.opportunity_id = $1
      WHERE c.account_id = $2 AND c.is_active = TRUE
      ORDER BY (oc.role = 'PRIMARY') DESC NULLS LAST, (oc.contact_id IS NOT NULL) DESC, c.is_primary DESC, c.id LIMIT 1`,
    [dealId, row.account_id],
  );
  res.json({
    pipeline: pipeline.rows[0] || null,
    opportunity_type: row.opportunity_type,
    opportunity_type_label: OPPORTUNITY_TYPE_LABELS[row.opportunity_type] || null,
    is_monetary: row.is_monetary,
    csr: {
      thematic_focus: row.thematic_focus, proposed_project: row.proposed_project, project_geography: row.project_geography,
      beneficiaries: row.beneficiaries, beneficiary_count: row.beneficiary_count, requested_amount: row.requested_amount,
      committed_amount: row.committed_amount, funding_cycle: row.funding_cycle, proposal_deadline: row.proposal_deadline,
      agreement_status: row.agreement_status, reporting_commitments: row.reporting_commitments, required_documents: row.required_documents,
    },
    parties,
    quotes,
    payments: position,
    engagement: engagement.rows[0] ? await getEngagement(engagement.rows[0].id) : null,
    renewal_of: renewals.rows.find((r) => r.id === row.renewal_of_id) || null,
    renewal: renewals.rows.find((r) => r.renewal_of_id === dealId) || null,
    contact: contact[0] || null,
    can_work: await canWorkOnOpportunity(req.currentUser, row),
  });
}));

// ---------------------------------------------------------------- organizations on a deal

router.post('/opportunities/:id/parties', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const data = z.object({ account_id: z.number().int().positive(), role: z.enum(PARTY_ROLES), notes: z.string().max(1000).nullable().optional() }).parse(req.body);
  const dealId = id(req.params.id);
  await deal(req, dealId, { work: true });
  await withTransaction((client) => addParty(client, { opportunityId: dealId, accountId: data.account_id, role: data.role, notes: data.notes ?? null, actor: req.currentUser }));
  res.status(201).json({ parties: await listParties(dealId) });
}));

router.delete('/opportunities/:id/parties/:partyId', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const dealId = id(req.params.id);
  await deal(req, dealId, { work: true });
  await withTransaction((client) => removeParty(client, { opportunityId: dealId, partyId: id(req.params.partyId), actor: req.currentUser }));
  res.json({ parties: await listParties(dealId) });
}));

// ---------------------------------------------------------------- renewals

router.post('/opportunities/:id/renewal', requirePermission('crm.create'), asyncHandler(async (req, res) => {
  const data = z.object({
    name: z.string().min(2).max(200).optional(),
    expected_close: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    owner_user_id: z.number().int().positive().nullable().optional(),
  }).parse(req.body ?? {});
  const dealId = id(req.params.id);
  await deal(req, dealId, { work: true });
  const result = await withTransaction((client) => createRenewal(client, {
    opportunityId: dealId, actor: req.currentUser, name: data.name, expectedClose: data.expected_close ?? null, ownerUserId: data.owner_user_id ?? null,
  }));
  res.status(result.created ? 201 : 200).json(result);
}));

// ---------------------------------------------------------------- handover into delivery

router.post('/opportunities/:id/handover', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const dealId = id(req.params.id);
  await deal(req, dealId, { work: true });
  const result = await withTransaction((client) => startHandover(client, { opportunityId: dealId, actor: req.currentUser, input: req.body ?? {} }));
  res.status(result.created ? 201 : 200).json({ ...result, engagement: await getEngagement(result.engagement_id) });
}));

router.post('/handovers/:engagementId/review', asyncHandler(async (req, res) => {
  if (!hasPermission(req.currentUser, 'crm.manage.any') && !hasPermission(req.currentUser, 'crm.approve')) {
    throw forbidden('A manager reviews handovers');
  }
  const data = z.object({ decision: z.enum(['ACCEPTED', 'RETURNED']), note: z.string().max(2000).nullable().optional() }).parse(req.body);
  const engagementId = id(req.params.engagementId);
  const { rows } = await query('SELECT opportunity_id FROM engagements WHERE id = $1', [engagementId]);
  if (!rows[0]) throw notFound('Delivery record not found');
  if (rows[0].opportunity_id) await deal(req, rows[0].opportunity_id);
  await withTransaction((client) => reviewHandover(client, { engagementId, actor: req.currentUser, decision: data.decision, note: data.note ?? null }));
  res.json({ engagement: await getEngagement(engagementId) });
}));

// ---------------------------------------------------------------- catalogue

const productInput = z.object({
  sku: z.string().max(60).nullable().optional(),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  kind: z.enum(['PRODUCT', 'SERVICE', 'SUBSCRIPTION', 'PROGRAMME']).optional(),
  unit: z.string().max(30).nullable().optional(),
  unit_price: z.union([z.number().min(0), z.string().regex(/^\d+(\.\d{1,2})?$/)]).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  tax_rate: z.number().min(0).max(100).nullable().optional(),
  tax_label: z.string().max(40).nullable().optional(),
  hsn_sac: z.string().max(20).nullable().optional(),
  is_active: z.boolean().optional(),
});

router.get('/products', asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM crm_products ${req.query.all === '1' ? '' : 'WHERE is_active = TRUE'} ORDER BY name`);
  res.json({ products: rows });
}));

router.post('/products', settingsOnly, asyncHandler(async (req, res) => {
  const d = productInput.parse(req.body);
  const { rows } = await query(
    `INSERT INTO crm_products (sku, name, description, kind, unit, unit_price, currency, tax_rate, tax_label, hsn_sac, created_by)
     VALUES ($1,$2,$3,COALESCE($4,'PRODUCT'),$5,$6::numeric,COALESCE($7,'INR'),$8,$9,$10,$11) RETURNING *`,
    [d.sku || null, d.name, d.description ?? null, d.kind ?? null, d.unit ?? null, d.unit_price === undefined || d.unit_price === null ? null : String(d.unit_price),
      d.currency ?? null, d.tax_rate ?? null, d.tax_label ?? null, d.hsn_sac ?? null, req.currentUser.id],
  );
  await recordAuditEvent(null, { action: 'PRODUCT_CREATED', entityType: 'PRODUCT', entityId: rows[0].id, actorId: req.currentUser.id, summary: rows[0].name });
  res.status(201).json({ product: rows[0] });
}));

router.patch('/products/:pid', settingsOnly, asyncHandler(async (req, res) => {
  const d = productInput.partial().parse(req.body);
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(d)) {
    params.push(k === 'unit_price' && v !== null ? String(v) : v);
    sets.push(`${k} = $${params.length}${k === 'unit_price' ? '::numeric' : ''}`);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  params.push(id(req.params.pid));
  const { rows } = await query(`UPDATE crm_products SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) throw notFound('Product not found');
  await recordAuditEvent(null, { action: 'PRODUCT_UPDATED', entityType: 'PRODUCT', entityId: rows[0].id, actorId: req.currentUser.id, summary: rows[0].name, detail: d });
  res.json({ product: rows[0] });
}));

// ---------------------------------------------------------------- quotations and proposals

router.get('/opportunities/:id/quotes', asyncHandler(async (req, res) => {
  const dealId = id(req.params.id);
  await deal(req, dealId);
  res.json({ quotes: await listQuotes(dealId), kinds: QUOTE_KINDS });
}));

router.post('/opportunities/:id/quotes', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const dealId = id(req.params.id);
  const row = await deal(req, dealId, { work: true });
  if (row.status !== 'ACTIVE') throw badRequest('Quotations are made on open deals');
  const quoteId = await withTransaction((client) => createQuote(client, { opportunity: row, input: req.body, actor: req.currentUser }));
  res.status(201).json({ quote: await getQuote(quoteId) });
}));

router.get('/quotes/:qid', asyncHandler(async (req, res) => {
  const qid = id(req.params.qid);
  await quoteFor(req, qid);
  res.json({ quote: await getQuote(qid), acceptance_methods: ACCEPTANCE_METHODS });
}));

router.patch('/quotes/:qid', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const qid = id(req.params.qid);
  await quoteFor(req, qid, { work: true });
  await withTransaction((client) => updateQuote(client, { quoteId: qid, input: req.body, actor: req.currentUser }));
  res.json({ quote: await getQuote(qid) });
}));

const quoteStep = (fn) => [requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const qid = id(req.params.qid);
  await quoteFor(req, qid, { work: true });
  const result = await withTransaction((client) => fn(client, qid, req));
  const quote = await getQuote(result?.quoteId ?? qid);
  res.json({ quote, result: result?.quoteId ? undefined : result });
})];

router.post('/quotes/:qid/submit', ...quoteStep((client, qid, req) => submitQuote(client, { quoteId: qid, actor: req.currentUser })));
router.post('/quotes/:qid/send', ...quoteStep((client, qid, req) => {
  const d = z.object({ via: z.enum(['EMAIL', 'WHATSAPP', 'IN_PERSON', 'PORTAL', 'OTHER']).optional(), to: z.string().max(300).nullable().optional(), sent_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
  return markSent(client, { quoteId: qid, actor: req.currentUser, via: d.via ?? 'EMAIL', to: d.to ?? null, sentOn: d.sent_on ?? null });
}));
router.post('/quotes/:qid/decision', ...quoteStep((client, qid, req) => recordDecision(client, { quoteId: qid, actor: req.currentUser, input: req.body })));
router.post('/quotes/:qid/revise', ...quoteStep(async (client, qid, req) => ({ quoteId: await reviseQuote(client, { quoteId: qid, actor: req.currentUser }) })));
router.post('/quotes/:qid/withdraw', ...quoteStep((client, qid, req) => withdrawQuote(client, { quoteId: qid, actor: req.currentUser, reason: String(req.body?.reason || '') })));

router.get('/quotes/:qid/pdf', asyncHandler(async (req, res) => {
  const qid = id(req.params.qid);
  await quoteFor(req, qid);
  const quote = await getQuote(qid);
  const { rows: acct } = await query(
    `SELECT a.name AS account_name, a.hq_address AS address, a.city, a.state, a.pincode, a.country,
            c.full_name AS contact_name, c.designation AS contact_designation, c.email, c.phone
       FROM opportunities o JOIN accounts a ON a.id = o.account_id
       LEFT JOIN opportunity_contacts oc ON oc.opportunity_id = o.id AND oc.role = 'PRIMARY'
       LEFT JOIN account_contacts c ON c.id = oc.contact_id
      WHERE o.id = $1 LIMIT 1`, [quote.opportunity_id],
  );
  const a = acct[0] || {};
  const settings = await salesSettings();
  const pdf = await renderQuotePdf({
    quote,
    party: { ...a, address: [a.address, a.city, a.state, a.pincode, a.country].filter(Boolean).join(', ') || null },
    letterhead: settings.quotes || {},
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${quote.number}-v${quote.version}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(pdf);
}));

// ---------------------------------------------------------------- approvals

router.get('/approvals', asyncHandler(async (req, res) => {
  res.json({ approvals: await pendingApprovalsFor(req.currentUser) });
}));

router.post('/approvals/:aid/decide', requirePermission('crm.approve'), asyncHandler(async (req, res) => {
  const d = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().max(2000).nullable().optional() }).parse(req.body);
  const aid = id(req.params.aid);
  const { rows } = await query('SELECT quote_id FROM crm_approvals WHERE id = $1', [aid]);
  if (!rows[0]) throw notFound('Approval not found');
  await quoteFor(req, rows[0].quote_id);
  await withTransaction((client) => decideApproval(client, { approvalId: aid, actor: req.currentUser, decision: d.decision, comment: d.comment ?? null }));
  res.json({ quote: await getQuote(rows[0].quote_id) });
}));

const ruleInput = z.object({
  name: z.string().min(2).max(120),
  kind: z.enum(['ANY', 'QUOTATION', 'CSR_PROPOSAL']).optional(),
  pipeline_id: z.number().int().positive().nullable().optional(),
  min_discount_pct: z.number().min(0).max(100).nullable().optional(),
  min_total: z.union([z.number().min(0), z.string().regex(/^\d+(\.\d{1,2})?$/)]).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  approver_user_ids: z.array(z.number().int().positive()).max(20).optional(),
  allow_self_approval: z.boolean().optional(),
  is_enabled: z.boolean().optional(),
  position: z.number().int().optional(),
});

router.get('/approval-rules', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, (SELECT array_agg(full_name ORDER BY full_name) FROM users WHERE id = ANY(r.approver_user_ids)) AS approver_names
       FROM crm_approval_rules r ORDER BY position, id`,
  );
  res.json({ rules: rows });
}));

router.post('/approval-rules', settingsOnly, asyncHandler(async (req, res) => {
  const d = ruleInput.parse(req.body);
  if ((d.min_discount_pct ?? null) === null && (d.min_total ?? null) === null) throw badRequest('Set a discount or a value threshold');
  const { rows } = await query(
    `INSERT INTO crm_approval_rules (name, kind, pipeline_id, min_discount_pct, min_total, currency, approver_user_ids, allow_self_approval, is_enabled, position, created_by)
     VALUES ($1,COALESCE($2,'ANY'),$3,$4,$5::numeric,COALESCE($6,'INR'),COALESCE($7::int[],'{}'),COALESCE($8,FALSE),COALESCE($9,TRUE),COALESCE($10,0),$11) RETURNING *`,
    [d.name, d.kind ?? null, d.pipeline_id ?? null, d.min_discount_pct ?? null, d.min_total === undefined || d.min_total === null ? null : String(d.min_total),
      d.currency ?? null, d.approver_user_ids ?? null, d.allow_self_approval ?? null, d.is_enabled ?? null, d.position ?? null, req.currentUser.id],
  );
  await recordAuditEvent(null, { action: 'APPROVAL_RULE_CREATED', entityType: 'SETTINGS', entityId: rows[0].id, actorId: req.currentUser.id, summary: rows[0].name, detail: d });
  res.status(201).json({ rule: rows[0] });
}));

router.patch('/approval-rules/:rid', settingsOnly, asyncHandler(async (req, res) => {
  const d = ruleInput.partial().parse(req.body);
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(d)) {
    params.push(k === 'min_total' && v !== null ? String(v) : v);
    sets.push(`${k} = $${params.length}${k === 'min_total' ? '::numeric' : k === 'approver_user_ids' ? '::int[]' : ''}`);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  params.push(id(req.params.rid));
  const { rows } = await query(`UPDATE crm_approval_rules SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) throw notFound('Rule not found');
  await recordAuditEvent(null, { action: 'APPROVAL_RULE_UPDATED', entityType: 'SETTINGS', entityId: rows[0].id, actorId: req.currentUser.id, summary: rows[0].name, detail: d });
  res.json({ rule: rows[0] });
}));

// ---------------------------------------------------------------- payments

router.get('/opportunities/:id/payments', asyncHandler(async (req, res) => {
  const dealId = id(req.params.id);
  await deal(req, dealId, { finance: true });
  res.json({ ...(await paymentPosition(dealId)), modes: PAYMENT_MODES, can_finance: hasPermission(req.currentUser, 'crm.finance') });
}));

const paymentStep = (fn, status = 200) => [requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const dealId = id(req.params.id);
  await deal(req, dealId, { work: true, finance: true });
  const result = await withTransaction((client) => fn(client, dealId, req));
  res.status(typeof status === 'function' ? status(result) : status).json({ result, ...(await paymentPosition(dealId)) });
})];

router.post('/opportunities/:id/schedule', ...paymentStep((client, dealId, req) => addSchedule(client, { opportunityId: dealId, input: req.body, actor: req.currentUser }), 201));
router.patch('/opportunities/:id/schedule/:sid', ...paymentStep((client, dealId, req) => updateSchedule(client, {
  opportunityId: dealId, scheduleId: id(req.params.sid), input: req.body, actor: req.currentUser, reason: req.body?.reason ?? null,
})));
router.post('/opportunities/:id/schedule/:sid/cancel', ...paymentStep((client, dealId, req) => cancelSchedule(client, {
  opportunityId: dealId, scheduleId: id(req.params.sid), actor: req.currentUser, reason: String(req.body?.reason || ''),
})));
router.post('/opportunities/:id/receipts', ...paymentStep(
  (client, dealId, req) => recordPayment(client, { opportunityId: dealId, input: req.body, actor: req.currentUser, kind: 'RECEIPT' }),
  (r) => (r.duplicate ? 200 : 201),
));
router.post('/opportunities/:id/refunds', ...paymentStep(
  (client, dealId, req) => recordPayment(client, { opportunityId: dealId, input: req.body, actor: req.currentUser, kind: 'REFUND' }),
  (r) => (r.duplicate ? 200 : 201),
));
router.post('/opportunities/:id/payments/:pid/verify', ...paymentStep((client, dealId, req) => verifyPayment(client, { opportunityId: dealId, paymentId: id(req.params.pid), actor: req.currentUser })));
router.post('/opportunities/:id/payments/:pid/void', ...paymentStep((client, dealId, req) => voidSalesPayment(client, {
  opportunityId: dealId, paymentId: id(req.params.pid), actor: req.currentUser, reason: String(req.body?.reason || ''),
})));

// ---------------------------------------------------------------- currency rates

router.get('/fx-rates', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT r.*, u.full_name AS created_by_name FROM crm_fx_rates r LEFT JOIN users u ON u.id = r.created_by ORDER BY as_of DESC, currency LIMIT 200');
  res.json({ rates: rows });
}));

router.post('/fx-rates', requirePermission('crm.finance'), asyncHandler(async (req, res) => {
  const d = z.object({
    currency: z.string().regex(/^[A-Z]{3}$/), base: z.string().regex(/^[A-Z]{3}$/).optional(),
    rate: z.union([z.number().positive(), z.string().regex(/^\d+(\.\d{1,8})?$/)]), as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source: z.string().max(200).optional(),
  }).parse(req.body);
  const base = d.base ?? (await salesSettings()).calendar?.currency ?? 'INR';
  const rate = await setFxRate({ currency: d.currency, base, rate: String(d.rate), asOf: d.as_of, source: d.source }, req.currentUser);
  res.status(201).json({ rate, check: await fxRate(d.currency, base, d.as_of) });
}));

export default router;
