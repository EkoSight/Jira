/**
 * Quotations (product and service sales) and CSR proposals / concept notes.
 *
 *   DRAFT ──submit──▶ IN_REVIEW ──approve──▶ APPROVED ──send──▶ SENT ──▶ ACCEPTED | DECLINED
 *     ▲                   │ reject                │ edit                    │ revise
 *     └── CHANGES_REQUESTED ◀┘          back to DRAFT          new version; this one SUPERSEDED
 *
 * An approval is pinned to a hash of what was approved (lines, prices,
 * discounts, taxes, terms, validity, the proposal's scope and budget). Any
 * material change afterwards needs a fresh approval; a quotation that was
 * sent is never edited, it is revised into a new version. Whether a quote
 * needs approval comes from the rules in Settings (discount and value
 * thresholds, named approvers); nobody approves their own exception unless
 * the rule allows it.
 *
 * Acceptance is a record of how the customer said yes (an email reply, a
 * purchase order, a signed copy…), with a date and evidence. It is not a
 * verified electronic signature, and the screens never call it one.
 *
 * Money is exact: amounts are BigInt hundredths, quantities thousandths,
 * rates hundredths of a percent, each line rounded half up.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { notify } from '../activity.js';
import { recordAuditEvent } from '../audit.js';
import { dayStamp, logActivity } from '../crm.js';
import { addProposal } from '../dealMoves.js';
import { recordHistory } from '../opportunities.js';
import { emitEvent, money, nextNumber, salesSettings } from './core.js';

export const QUOTE_KINDS = ['QUOTATION', 'CSR_PROPOSAL'];
export const ACCEPTANCE_METHODS = ['EMAIL_REPLY', 'PURCHASE_ORDER', 'SIGNED_COPY', 'VERBAL', 'MEETING', 'WHATSAPP', 'OTHER'];
const EDITABLE = new Set(['DRAFT', 'CHANGES_REQUESTED', 'APPROVED', 'IN_REVIEW']);
const OPEN = new Set(['DRAFT', 'IN_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'SENT']);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use a date like 2026-04-01');
const amountText = z.union([z.number(), z.string()]).transform((v) => String(v));

export const lineInput = z.object({
  product_id: z.number().int().positive().nullable().optional(),
  description: z.string().min(1).max(2000),
  quantity: amountText.optional(),
  unit: z.string().max(30).nullable().optional(),
  unit_price: amountText.optional(),
  discount_pct: amountText.optional(),
  tax_rate: amountText.nullable().optional(),
  tax_label: z.string().max(40).nullable().optional(),
});

export const quoteInput = z.object({
  kind: z.enum(QUOTE_KINDS).optional(),
  title: z.string().max(200).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code such as INR').optional(),
  valid_until: day.nullable().optional(),
  terms: z.string().max(10000).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  project_scope: z.string().max(20000).nullable().optional(),
  objectives: z.string().max(10000).nullable().optional(),
  outcomes: z.string().max(10000).nullable().optional(),
  deliverables: z.string().max(10000).nullable().optional(),
  timeline: z.string().max(10000).nullable().optional(),
  beneficiaries: z.string().max(5000).nullable().optional(),
  geography: z.string().max(2000).nullable().optional(),
  reporting_plan: z.string().max(10000).nullable().optional(),
  budget_notes: z.string().max(10000).nullable().optional(),
  lines: z.array(lineInput).max(200).optional(),
});

const TEXT_FIELDS = ['title', 'valid_until', 'terms', 'notes', 'project_scope', 'objectives', 'outcomes', 'deliverables',
  'timeline', 'beneficiaries', 'geography', 'reporting_plan', 'budget_notes'];

// ---------------------------------------------------------------- arithmetic

const scaled = (value, scale, label) => {
  try {
    return money.parse(value, scale);
  } catch {
    throw badRequest(`${label} must be a number`);
  }
};

/** Exact line and quote totals. Inputs are strings or numbers; outputs strings. */
export function computeTotals(lines) {
  let subtotal = 0n;
  let discount = 0n;
  let tax = 0n;
  let maxDiscount = 0n;
  const out = lines.map((line, index) => {
    const qty = scaled(line.quantity ?? '1', 3, `Line ${index + 1}: quantity`);
    const price = scaled(line.unit_price ?? '0', 2, `Line ${index + 1}: unit price`);
    const pct = scaled(line.discount_pct ?? '0', 2, `Line ${index + 1}: discount`);
    const rate = line.tax_rate === null || line.tax_rate === undefined || line.tax_rate === '' ? null : scaled(line.tax_rate, 2, `Line ${index + 1}: tax rate`);
    if (qty <= 0n) throw badRequest(`Line ${index + 1}: quantity must be more than zero`);
    if (price < 0n) throw badRequest(`Line ${index + 1}: unit price cannot be negative`);
    if (pct < 0n || pct > 10000n) throw badRequest(`Line ${index + 1}: discount must be between 0 and 100%`);
    if (rate !== null && (rate < 0n || rate > 10000n)) throw badRequest(`Line ${index + 1}: tax rate must be between 0 and 100%`);
    const lineSubtotal = money.mul(price, qty, 3);
    const lineDiscount = money.pct(lineSubtotal, pct);
    const taxable = lineSubtotal - lineDiscount;
    const lineTax = rate === null ? 0n : money.pct(taxable, rate);
    subtotal += lineSubtotal;
    discount += lineDiscount;
    tax += lineTax;
    if (pct > maxDiscount) maxDiscount = pct;
    return {
      position: index,
      product_id: line.product_id ?? null,
      description: String(line.description).trim(),
      quantity: money.format(qty, 3),
      unit: line.unit ?? null,
      unit_price: money.format(price),
      discount_pct: money.format(pct),
      tax_rate: rate === null ? null : money.format(rate),
      tax_label: rate === null ? null : (line.tax_label || 'Tax'),
      line_subtotal: money.format(lineSubtotal),
      line_discount: money.format(lineDiscount),
      line_tax: money.format(lineTax),
      line_total: money.format(taxable + lineTax),
    };
  });
  return {
    lines: out,
    subtotal: money.format(subtotal),
    discount_total: money.format(discount),
    tax_total: money.format(tax),
    total: money.format(subtotal - discount + tax),
    max_discount_pct: money.format(maxDiscount),
  };
}

/** What an approval is pinned to. */
export function contentHash(quote, lines) {
  const material = {
    kind: quote.kind, currency: quote.currency, valid_until: quote.valid_until ? String(quote.valid_until).slice(0, 10) : null,
    terms: quote.terms ?? null, total: String(quote.total),
    lines: lines.map((l) => [l.description, String(l.quantity), String(l.unit_price), String(l.discount_pct), l.tax_rate === null ? null : String(l.tax_rate), l.product_id ?? null]),
    csr: [quote.project_scope, quote.objectives, quote.outcomes, quote.deliverables, quote.timeline, quote.beneficiaries, quote.geography, quote.reporting_plan, quote.budget_notes].map((v) => v ?? null),
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

const dateOnly = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

// ---------------------------------------------------------------- reading

export async function getQuote(id, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT q.*, o.name AS opportunity_name, o.account_id, o.pipeline_id, o.owner_user_id AS opportunity_owner_id,
            a.name AS account_name, cu.full_name AS created_by_name, au.full_name AS approved_by_name, su.full_name AS sent_by_name
       FROM crm_quotes q
       JOIN opportunities o ON o.id = q.opportunity_id
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN users cu ON cu.id = q.created_by
       LEFT JOIN users au ON au.id = q.approved_by
       LEFT JOIN users su ON su.id = q.sent_by
      WHERE q.id = $1`, [id],
  );
  if (!rows[0]) return null;
  const { rows: lines } = await runner.query('SELECT * FROM crm_quote_lines WHERE quote_id = $1 ORDER BY position, id', [id]);
  const { rows: approvals } = await runner.query(
    `SELECT ap.*, ru.full_name AS requested_by_name, du.full_name AS decided_by_name,
            (SELECT array_agg(full_name ORDER BY full_name) FROM users WHERE id = ANY(ap.approver_ids)) AS approver_names
       FROM crm_approvals ap LEFT JOIN users ru ON ru.id = ap.requested_by LEFT JOIN users du ON du.id = ap.decided_by
      WHERE ap.quote_id = $1 ORDER BY ap.id DESC`, [id],
  );
  const quote = rows[0];
  const hash = contentHash(quote, lines);
  return {
    ...quote,
    lines,
    approvals,
    // an approval given to different content does not count
    approval_current: Boolean(quote.approved_hash && quote.approved_hash === hash),
    content_hash: hash,
  };
}

export async function listQuotes(opportunityId) {
  const { rows } = await query(
    `SELECT q.id, q.kind, q.number, q.version, q.family_id, q.title, q.status, q.currency, q.total, q.valid_until,
            q.approval_required, q.approved_at, q.sent_at, q.decided_on, q.created_at, u.full_name AS created_by_name
       FROM crm_quotes q LEFT JOIN users u ON u.id = q.created_by
      WHERE q.opportunity_id = $1 ORDER BY q.number, q.version DESC`, [opportunityId],
  );
  return rows;
}

// ---------------------------------------------------------------- writing

async function writeLines(client, quoteId, lines) {
  await client.query('DELETE FROM crm_quote_lines WHERE quote_id = $1', [quoteId]);
  for (const l of lines) {
    await client.query(
      `INSERT INTO crm_quote_lines (quote_id, position, product_id, description, quantity, unit, unit_price, discount_pct,
                                    tax_rate, tax_label, line_subtotal, line_discount, line_tax, line_total)
       VALUES ($1,$2,$3,$4,$5::numeric,$6,$7::numeric,$8::numeric,$9::numeric,$10,$11::numeric,$12::numeric,$13::numeric,$14::numeric)`,
      [quoteId, l.position, l.product_id, l.description, l.quantity, l.unit, l.unit_price, l.discount_pct, l.tax_rate,
        l.tax_label, l.line_subtotal, l.line_discount, l.line_tax, l.line_total],
    );
  }
}

/** Fills a line from the catalogue where the person did not type a value. */
async function withCatalogue(client, lines) {
  const ids = [...new Set(lines.map((l) => l.product_id).filter(Boolean))];
  if (!ids.length) return lines;
  const { rows } = await client.query('SELECT * FROM crm_products WHERE id = ANY($1::int[])', [ids]);
  const byId = new Map(rows.map((p) => [p.id, p]));
  return lines.map((l) => {
    const p = l.product_id ? byId.get(l.product_id) : null;
    if (l.product_id && !p) throw badRequest('A line points at a product that does not exist');
    if (!p) return l;
    return {
      ...l,
      unit: l.unit ?? p.unit,
      unit_price: l.unit_price ?? (p.unit_price === null ? undefined : String(p.unit_price)),
      tax_rate: l.tax_rate === undefined ? (p.tax_rate === null ? null : String(p.tax_rate)) : l.tax_rate,
      tax_label: l.tax_label ?? p.tax_label,
    };
  });
}

export async function createQuote(client, { opportunity, input, actor }) {
  const data = quoteInput.parse(input);
  if (!opportunity.is_monetary && (data.lines?.length ?? 0) > 0 && (data.kind ?? 'QUOTATION') === 'QUOTATION') {
    throw badRequest('This deal is a non-monetary partnership; record a proposal without prices, or mark the deal as monetary first');
  }
  const { rows: pipe } = await client.query('SELECT key FROM crm_pipelines WHERE id = $1', [opportunity.pipeline_id]);
  const kind = data.kind ?? (pipe[0]?.key === 'csr' ? 'CSR_PROPOSAL' : 'QUOTATION');
  const settings = await salesSettings();
  const currency = data.currency ?? opportunity.currency ?? settings.calendar?.currency ?? 'INR';
  const year = new Date().getFullYear();
  const prefix = kind === 'CSR_PROPOSAL' ? 'PR' : 'QT';
  const number = `${prefix}-${year}-${String(await nextNumber(client, `quote:${prefix}:${year}`)).padStart(4, '0')}`;
  const lines = await withCatalogue(client, data.lines ?? []);
  const totals = computeTotals(lines);
  const validUntil = data.valid_until ?? new Date(Date.now() + (settings.quotes?.validityDays ?? 30) * 86_400_000).toISOString().slice(0, 10);
  const { rows } = await client.query(
    `INSERT INTO crm_quotes (opportunity_id, kind, number, version, title, currency, subtotal, discount_total, tax_total, total,
                             max_discount_pct, valid_until, terms, notes, project_scope, objectives, outcomes, deliverables,
                             timeline, beneficiaries, geography, reporting_plan, budget_notes, created_by, updated_by)
     VALUES ($1,$2,$3,1,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10::numeric,$11::date,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)
     RETURNING *`,
    [opportunity.id, kind, number, data.title ?? null, currency, totals.subtotal, totals.discount_total, totals.tax_total, totals.total,
      totals.max_discount_pct, validUntil, data.terms ?? settings.quotes?.terms ?? null, data.notes ?? null,
      data.project_scope ?? null, data.objectives ?? null, data.outcomes ?? null, data.deliverables ?? null, data.timeline ?? null,
      data.beneficiaries ?? opportunity.beneficiaries ?? null, data.geography ?? opportunity.project_geography ?? null,
      data.reporting_plan ?? null, data.budget_notes ?? null, actor.id],
  );
  const quote = rows[0];
  await client.query('UPDATE crm_quotes SET family_id = id WHERE id = $1', [quote.id]);
  await writeLines(client, quote.id, totals.lines);
  await logActivity(client, {
    accountId: opportunity.account_id, opportunityId: opportunity.id, quoteId: quote.id, type: 'QUOTE', actorId: actor.id,
    subject: `${kind === 'CSR_PROPOSAL' ? 'Proposal' : 'Quotation'} ${number} drafted`, source: 'MANUAL',
  });
  return quote.id;
}

/**
 * Edits a draft. Editing an approved quotation sends it back to draft: what
 * was approved is no longer what would be sent. A sent one is revised instead.
 */
export async function updateQuote(client, { quoteId, input, actor }) {
  const data = quoteInput.partial().parse(input);
  const { rows } = await client.query('SELECT * FROM crm_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
  const quote = rows[0];
  if (!quote) throw notFound('Quotation not found');
  if (!EDITABLE.has(quote.status)) {
    throw badRequest(quote.status === 'SENT' ? 'This was sent; revise it to make a new version' : `A ${quote.status.toLowerCase()} quotation cannot be edited`);
  }
  const sets = [];
  const params = [];
  for (const key of TEXT_FIELDS) {
    if (data[key] === undefined) continue;
    params.push(data[key]);
    sets.push(`${key} = $${params.length}`);
  }
  if (data.currency && data.currency !== quote.currency) {
    params.push(data.currency);
    sets.push(`currency = $${params.length}`);
  }
  if (data.lines) {
    const totals = computeTotals(await withCatalogue(client, data.lines));
    await writeLines(client, quoteId, totals.lines);
    for (const key of ['subtotal', 'discount_total', 'tax_total', 'total', 'max_discount_pct']) {
      params.push(totals[key]);
      sets.push(`${key} = $${params.length}::numeric`);
    }
  }
  if (!sets.length) return quoteId;
  params.push(actor.id);
  sets.push(`updated_by = $${params.length}`);
  params.push(quoteId);
  await client.query(`UPDATE crm_quotes SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);

  // did the material content change? then an approval or a pending review lapses
  const fresh = await getQuote(quoteId, client);
  if (['APPROVED', 'IN_REVIEW'].includes(quote.status) && quote.approved_hash !== fresh.content_hash) {
    await client.query(`UPDATE crm_approvals SET status = 'CANCELLED', comment = COALESCE(comment, 'Content changed after the request') WHERE quote_id = $1 AND status = 'PENDING'`, [quoteId]);
    await client.query(`UPDATE crm_quotes SET status = 'DRAFT', approved_hash = NULL, approved_at = NULL, approved_by = NULL WHERE id = $1`, [quoteId]);
    await recordHistory(client, { opportunityId: quote.opportunity_id, field: 'quote', from: `${quote.number} v${quote.version} ${quote.status.toLowerCase()}`, to: 'draft (edited)', reason: 'Content changed; approval needed again', actorId: actor.id });
  }
  return quoteId;
}

// ---------------------------------------------------------------- approval

/** Which approval rules a quotation triggers, and who may approve it. */
export async function approvalNeeded(client, quote) {
  const { rows: rules } = await client.query(
    `SELECT * FROM crm_approval_rules WHERE is_enabled = TRUE AND (kind = 'ANY' OR kind = $1)
        AND (pipeline_id IS NULL OR pipeline_id = $2) ORDER BY position, id`,
    [quote.kind, quote.pipeline_id ?? null],
  );
  const reasons = [];
  const approvers = new Set();
  let allowSelf = true;
  let matched = 0;
  for (const rule of rules) {
    const hits = [];
    if (rule.min_discount_pct !== null && Number(quote.max_discount_pct) >= Number(rule.min_discount_pct)) {
      hits.push(`a discount of ${Number(quote.max_discount_pct)}% (rule: ${Number(rule.min_discount_pct)}% or more)`);
    }
    if (rule.min_total !== null) {
      if (rule.currency !== quote.currency) {
        // amounts in different currencies are never compared without a rate; ask a person
        hits.push(`a total in ${quote.currency}, where the rule's threshold is in ${rule.currency}`);
      } else if (money.parse(quote.total) >= money.parse(rule.min_total)) {
        hits.push(`a total of ${quote.currency} ${quote.total} (rule: ${rule.currency} ${rule.min_total} or more)`);
      }
    }
    if (!hits.length) continue;
    matched += 1;
    reasons.push(`${rule.name}: ${hits.join(' and ')}`);
    for (const id of rule.approver_user_ids || []) approvers.add(id);
    if (!rule.allow_self_approval) allowSelf = false;
  }
  return { required: matched > 0, reasons, approverIds: [...approvers], allowSelf: matched ? allowSelf : true };
}

/**
 * Sends a draft for review. If no rule asks for approval it is approved on
 * the spot ("no approval needed under the current rules"), and that is what
 * its history says.
 */
export async function submitQuote(client, { quoteId, actor }) {
  const { rows } = await client.query('SELECT * FROM crm_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
  if (!rows[0]) throw notFound('Quotation not found');
  if (!['DRAFT', 'CHANGES_REQUESTED'].includes(rows[0].status)) throw badRequest(`A ${rows[0].status.toLowerCase().replace('_', ' ')} quotation cannot be submitted`);
  const quote = await getQuote(quoteId, client);
  if (quote.kind === 'QUOTATION' && !quote.lines.length) throw badRequest('Add at least one line before submitting');
  if (quote.valid_until && dateOnly(quote.valid_until) < new Date().toISOString().slice(0, 10)) throw badRequest('The validity date has passed; change it first');
  const need = await approvalNeeded(client, quote);
  if (!need.required) {
    await client.query(
      `UPDATE crm_quotes SET status = 'APPROVED', approval_required = FALSE, approval_reasons = '{}', approved_hash = $2, approved_at = now(), approved_by = NULL, updated_at = now() WHERE id = $1`,
      [quoteId, quote.content_hash],
    );
    await recordHistory(client, { opportunityId: quote.opportunity_id, field: 'quote', from: quote.number, to: 'ready to send', reason: 'No approval needed under the current rules', actorId: actor.id });
    return { status: 'APPROVED', approval: null };
  }
  let approvers = need.approverIds;
  if (!approvers.length) {
    // nobody named: anyone holding the approval permission, other than the requester unless allowed
    const { rows: holders } = await client.query(`SELECT id, role, extra_permissions, revoked_permissions FROM users WHERE is_active = TRUE`);
    approvers = holders.filter((u) => hasPermission(u, 'crm.approve')).map((u) => u.id);
  }
  if (!need.allowSelf) approvers = approvers.filter((id) => id !== actor.id);
  if (!approvers.length) throw badRequest('Nobody else can approve this; ask an administrator to name an approver in Settings → Approvals');
  const { rows: ap } = await client.query(
    `INSERT INTO crm_approvals (quote_id, content_hash, reasons, approver_ids, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [quoteId, quote.content_hash, need.reasons, approvers, actor.id],
  );
  await client.query(`UPDATE crm_quotes SET status = 'IN_REVIEW', approval_required = TRUE, approval_reasons = $2, updated_at = now() WHERE id = $1`, [quoteId, need.reasons]);
  for (const userId of approvers) {
    await notify(client, {
      userId, type: 'crm_approval', title: `Approval needed: ${quote.number} for ${quote.account_name}`,
      body: need.reasons.join('; '), accountId: quote.account_id,
    });
  }
  await logActivity(client, {
    accountId: quote.account_id, opportunityId: quote.opportunity_id, quoteId, type: 'APPROVAL', actorId: actor.id,
    subject: `${quote.number} sent for approval`, body: need.reasons.join('\n'), source: 'MANUAL',
  });
  await emitEvent(client, { type: 'approval.requested', entityType: 'QUOTE', entityId: quoteId, actorId: actor.id, payload: { approval_id: ap[0].id } });
  return { status: 'IN_REVIEW', approval: ap[0] };
}

export async function decideApproval(client, { approvalId, actor, decision, comment = null }) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw badRequest('Approve or reject');
  if (decision === 'REJECTED' && !comment?.trim()) throw badRequest('Say what needs to change');
  const { rows } = await client.query('SELECT * FROM crm_approvals WHERE id = $1 FOR UPDATE', [approvalId]);
  const approval = rows[0];
  if (!approval) throw notFound('Approval not found');
  if (approval.status !== 'PENDING') throw badRequest(`This approval was already ${approval.status.toLowerCase()}`);
  const named = (approval.approver_ids || []).includes(actor.id);
  if (!named && !(actor.role === 'admin')) throw forbidden('You are not an approver for this quotation');
  const quote = await getQuote(approval.quote_id, client);
  if (approval.requested_by === actor.id && actor.role !== 'admin') {
    const need = await approvalNeeded(client, quote);
    if (!need.allowSelf) throw forbidden('You cannot approve an exception you asked for');
  }
  if (quote.content_hash !== approval.content_hash) {
    await client.query(`UPDATE crm_approvals SET status = 'CANCELLED', decided_at = now(), comment = 'The quotation changed after approval was asked' WHERE id = $1`, [approvalId]);
    throw badRequest('The quotation changed after approval was asked; it needs to be submitted again');
  }
  await client.query(
    'UPDATE crm_approvals SET status = $2, decided_by = $3, decided_at = now(), comment = $4 WHERE id = $1',
    [approvalId, decision, actor.id, comment],
  );
  if (decision === 'APPROVED') {
    await client.query(
      `UPDATE crm_quotes SET status = 'APPROVED', approved_hash = $2, approved_at = now(), approved_by = $3, updated_at = now() WHERE id = $1`,
      [quote.id, approval.content_hash, actor.id],
    );
  } else {
    await client.query(`UPDATE crm_quotes SET status = 'CHANGES_REQUESTED', updated_at = now() WHERE id = $1`, [quote.id]);
  }
  await logActivity(client, {
    accountId: quote.account_id, opportunityId: quote.opportunity_id, quoteId: quote.id, type: 'APPROVAL', actorId: actor.id,
    subject: `${quote.number} ${decision === 'APPROVED' ? 'approved' : 'returned for changes'}`, body: comment, source: 'MANUAL',
  });
  await recordAuditEvent(client, { action: `QUOTE_${decision}`, entityType: 'QUOTE', entityId: quote.id, actorId: actor.id, reason: comment, summary: `${quote.number} v${quote.version}`, detail: { approval_id: approvalId, hash: approval.content_hash } });
  if (approval.requested_by && approval.requested_by !== actor.id) {
    await notify(client, {
      userId: approval.requested_by, type: 'crm_approval', title: `${quote.number} ${decision === 'APPROVED' ? 'approved' : 'needs changes'}`,
      body: comment, accountId: quote.account_id,
    });
  }
  return decision;
}

// ---------------------------------------------------------------- sending and the answer

/**
 * Records that the quotation went out (downloaded and emailed, handed over,
 * shared on WhatsApp…). Only an approved quotation whose content is still the
 * approved content can be sent. Sending also files it as the deal's
 * proposal, which is the evidence the pipeline's proposal stages ask for.
 */
export async function markSent(client, { quoteId, actor, via = 'EMAIL', to = null, sentOn = null }) {
  const { rows } = await client.query('SELECT * FROM crm_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
  if (!rows[0]) throw notFound('Quotation not found');
  const quote = await getQuote(quoteId, client);
  if (quote.status !== 'APPROVED') throw badRequest(quote.status === 'SENT' ? 'This was already sent' : 'Only an approved quotation can be sent');
  if (!quote.approval_current) throw badRequest('The quotation changed after it was approved; submit it again');
  const { rows: opp } = await client.query('SELECT * FROM opportunities WHERE id = $1', [quote.opportunity_id]);
  const on = sentOn || new Date().toISOString().slice(0, 10);
  const proposal = await addProposal(client, {
    opportunity: opp[0], actor,
    proposal: { title: `${quote.number} v${quote.version}${quote.title ? ` — ${quote.title}` : ''}`, sent_on: on, amount: Number(quote.total) || null, currency: quote.currency, valid_until: dateOnly(quote.valid_until) },
  });
  await client.query(
    `UPDATE crm_quotes SET status = 'SENT', sent_at = now(), sent_via = $2, sent_to = $3, sent_by = $4, proposal_record_id = $5, updated_at = now() WHERE id = $1`,
    [quoteId, String(via).slice(0, 30), to ? String(to).slice(0, 300) : null, actor.id, proposal.id],
  );
  // an earlier version still marked as sent is replaced by this one
  await client.query(
    `UPDATE crm_quotes SET status = 'SUPERSEDED', updated_at = now() WHERE family_id = $1 AND id <> $2 AND status IN ('SENT','APPROVED','DRAFT','CHANGES_REQUESTED','IN_REVIEW')`,
    [quote.family_id, quoteId],
  );
  return proposal;
}

export async function recordDecision(client, { quoteId, actor, input }) {
  const data = z.object({
    decision: z.enum(['ACCEPTED', 'DECLINED']),
    decided_on: day,
    acceptance_method: z.enum(ACCEPTANCE_METHODS).optional(),
    note: z.string().max(5000).nullable().optional(),
    evidence_url: z.string().url().max(1000).nullable().optional(),
    decline_reason: z.string().max(2000).nullable().optional(),
  }).parse(input);
  const { rows } = await client.query('SELECT * FROM crm_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
  const quote = rows[0];
  if (!quote) throw notFound('Quotation not found');
  if (quote.status !== 'SENT') throw badRequest('Record the customer’s answer once the quotation has been sent');
  if (data.decided_on > new Date().toISOString().slice(0, 10)) throw badRequest('The answer cannot be dated in the future');
  if (data.decision === 'ACCEPTED' && !data.acceptance_method) throw badRequest('Say how they accepted (an email reply, a purchase order, a signed copy…)');
  if (data.decision === 'DECLINED' && !data.decline_reason?.trim()) throw badRequest('Say why it was declined');
  await client.query(
    `UPDATE crm_quotes SET status = $2, decided_on = $3::date, acceptance_method = $4, acceptance_note = $5, acceptance_evidence_url = $6,
            decline_reason = $7, decision_recorded_by = $8, updated_at = now() WHERE id = $1`,
    [quoteId, data.decision, data.decided_on, data.acceptance_method ?? null, data.note ?? null, data.evidence_url ?? null,
      data.decline_reason ?? null, actor.id],
  );
  if (quote.proposal_record_id) {
    await client.query('UPDATE opportunity_proposals SET status = $2, updated_at = now() WHERE id = $1', [quote.proposal_record_id, data.decision]);
  }
  const full = await getQuote(quoteId, client);
  await logActivity(client, {
    accountId: full.account_id, opportunityId: full.opportunity_id, quoteId, type: 'QUOTE', actorId: actor.id,
    subject: `${full.number} ${data.decision === 'ACCEPTED' ? 'accepted' : 'declined'}${data.acceptance_method ? ` (${data.acceptance_method.toLowerCase().replace('_', ' ')})` : ''}`,
    body: data.note || data.decline_reason || null, direction: 'INBOUND', isExternal: true, outcome: 'RECEIVED',
    occurredAt: dayStamp(data.decided_on), source: 'MANUAL',
  });
  await emitEvent(client, { type: data.decision === 'ACCEPTED' ? 'proposal.accepted' : 'proposal.declined', entityType: 'QUOTE', entityId: quoteId, actorId: actor.id, payload: { opportunity_id: full.opportunity_id } });
  return data.decision;
}

/** A new version from any quotation; the old one is superseded unless it was accepted. */
export async function reviseQuote(client, { quoteId, actor }) {
  const { rows } = await client.query('SELECT * FROM crm_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
  const quote = rows[0];
  if (!quote) throw notFound('Quotation not found');
  if (quote.status === 'ACCEPTED') throw badRequest('An accepted quotation is not revised; open a new quotation or a renewal');
  const { rows: latest } = await client.query('SELECT MAX(version) AS v FROM crm_quotes WHERE family_id = $1', [quote.family_id]);
  const version = Number(latest[0].v) + 1;
  const copy = { ...quote };
  const { rows: created } = await client.query(
    `INSERT INTO crm_quotes (opportunity_id, kind, number, version, family_id, title, status, currency, subtotal, discount_total, tax_total, total,
                             max_discount_pct, valid_until, terms, notes, project_scope, objectives, outcomes, deliverables, timeline,
                             beneficiaries, geography, reporting_plan, budget_notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8,$9,$10,$11,$12,GREATEST($13::date, CURRENT_DATE + 7),$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25)
     RETURNING id`,
    [copy.opportunity_id, copy.kind, copy.number, version, copy.family_id, copy.title, copy.currency, copy.subtotal, copy.discount_total,
      copy.tax_total, copy.total, copy.max_discount_pct, copy.valid_until, copy.terms, copy.notes, copy.project_scope, copy.objectives,
      copy.outcomes, copy.deliverables, copy.timeline, copy.beneficiaries, copy.geography, copy.reporting_plan, copy.budget_notes, actor.id],
  );
  await client.query(
    `INSERT INTO crm_quote_lines (quote_id, position, product_id, description, quantity, unit, unit_price, discount_pct, tax_rate, tax_label,
                                  line_subtotal, line_discount, line_tax, line_total)
     SELECT $2, position, product_id, description, quantity, unit, unit_price, discount_pct, tax_rate, tax_label,
            line_subtotal, line_discount, line_tax, line_total FROM crm_quote_lines WHERE quote_id = $1`,
    [quoteId, created[0].id],
  );
  if (OPEN.has(quote.status)) {
    await client.query(`UPDATE crm_approvals SET status = 'CANCELLED' WHERE quote_id = $1 AND status = 'PENDING'`, [quoteId]);
    await client.query(`UPDATE crm_quotes SET status = 'SUPERSEDED', updated_at = now() WHERE id = $1`, [quoteId]);
  }
  await recordHistory(client, { opportunityId: quote.opportunity_id, field: 'quote', from: `${quote.number} v${quote.version}`, to: `${quote.number} v${version} (draft)`, actorId: actor.id });
  return created[0].id;
}

export async function withdrawQuote(client, { quoteId, actor, reason }) {
  if (!reason?.trim()) throw badRequest('Say why it is withdrawn');
  const { rows } = await client.query(
    `UPDATE crm_quotes SET status = 'WITHDRAWN', decline_reason = $2, updated_at = now(), updated_by = $3
      WHERE id = $1 AND status IN ('DRAFT','IN_REVIEW','APPROVED','CHANGES_REQUESTED','SENT') RETURNING opportunity_id, number, version, proposal_record_id`,
    [quoteId, reason, actor.id],
  );
  if (!rows[0]) throw badRequest('Only an open quotation can be withdrawn');
  await client.query(`UPDATE crm_approvals SET status = 'CANCELLED' WHERE quote_id = $1 AND status = 'PENDING'`, [quoteId]);
  if (rows[0].proposal_record_id) await client.query(`UPDATE opportunity_proposals SET status = 'WITHDRAWN', updated_at = now() WHERE id = $1`, [rows[0].proposal_record_id]);
  await recordHistory(client, { opportunityId: rows[0].opportunity_id, field: 'quote', from: `${rows[0].number} v${rows[0].version}`, to: 'withdrawn', reason, actorId: actor.id });
}

/** Quotations whose validity has passed while waiting for an answer. Run by the worker. */
export async function expireQuotes() {
  const { rows } = await query(
    `UPDATE crm_quotes SET status = 'EXPIRED', updated_at = now()
      WHERE status IN ('SENT', 'APPROVED') AND valid_until < CURRENT_DATE RETURNING id, opportunity_id, number, version`,
  );
  return rows.length;
}

/** The approvals waiting on a person. */
export async function pendingApprovalsFor(user) {
  const { rows } = await query(
    `SELECT ap.id, ap.quote_id, ap.reasons, ap.requested_at, q.number, q.version, q.kind, q.total, q.currency, q.max_discount_pct,
            o.id AS opportunity_id, o.account_id, o.name AS opportunity_name, a.name AS account_name, ru.full_name AS requested_by_name
       FROM crm_approvals ap JOIN crm_quotes q ON q.id = ap.quote_id JOIN opportunities o ON o.id = q.opportunity_id
       JOIN accounts a ON a.id = o.account_id LEFT JOIN users ru ON ru.id = ap.requested_by
      WHERE ap.status = 'PENDING' AND ($1 = ANY(ap.approver_ids) OR $2)
      ORDER BY ap.requested_at`, [user.id, user.role === 'admin'],
  );
  return rows;
}
