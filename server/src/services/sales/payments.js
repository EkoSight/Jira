/**
 * What a won deal is owed and what actually arrived.
 *
 *   schedule   what is due and when: commercial instalments, or CSR tranches
 *   receipt    money that arrived, on the day it arrived
 *   refund     money that went back; its own record, never a negative receipt
 *
 * Definitions (also in docs/CRM_METRICS.md):
 *   received   = receipts − refunds, not voided, per currency
 *   balance    = scheduled (not cancelled) − received, per currency
 *   overdue    = for each schedule line due before today, what is still
 *                outstanding on it. Receipts tied to a line pay that line
 *                (and a refund of such a receipt comes off it); untied
 *                receipts pay the oldest lines first, untied refunds come
 *                off the latest.
 *
 * Amounts in different currencies are never added together. A payment event
 * (a bank reference, a provider id) is applied once: the same event key twice
 * returns the first record. Verified payments are changed only by people with
 * the finance permission, and only by voiding with a reason and recording a
 * correction that points at the original.
 */
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { recordAuditEvent } from '../audit.js';
import { refreshFinancialStatus } from '../commercial.js';
import { dayStamp, logActivity } from '../crm.js';
import { cleanLink } from '../dealMoves.js';
import { recordHistory } from '../opportunities.js';
import { emitEvent, money } from './core.js';

export const PAYMENT_MODES = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'ONLINE', 'GRANT_DISBURSEMENT', 'OTHER'];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-01');
const amountText = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d{1,2})?$/, 'Use an amount like 1250.50')]).transform(String);
const currency = z.string().regex(/^[A-Z]{3}$/);
const today = () => new Date().toISOString().slice(0, 10);
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export const scheduleInput = z.object({
  label: z.string().min(2).max(200),
  due_on: day,
  amount: amountText,
  currency: currency.optional(),
  kind: z.enum(['COMMERCIAL', 'CSR_TRANCHE']).optional(),
  milestone_id: z.number().int().positive().nullable().optional(),
  invoice_id: z.number().int().positive().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const receiptInput = z.object({
  received_on: day,
  amount: amountText,
  currency: currency.optional(),
  mode: z.enum(PAYMENT_MODES).optional(),
  reference: z.string().max(120).nullable().optional(),
  schedule_id: z.number().int().positive().nullable().optional(),
  invoice_id: z.number().int().positive().nullable().optional(),
  event_key: z.string().max(200).nullable().optional(),
  link: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  corrects_id: z.number().int().positive().nullable().optional(),
});

async function lockDeal(client, opportunityId) {
  const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1 FOR UPDATE', [opportunityId]);
  if (!rows[0]) throw notFound('Opportunity not found');
  return rows[0];
}

// ---------------------------------------------------------------- schedule

export async function addSchedule(client, { opportunityId, input, actor }) {
  const data = scheduleInput.parse(input);
  const deal = await lockDeal(client, opportunityId);
  if (!deal.is_monetary) throw badRequest('This deal has no money in it (a non-monetary partnership); it has no payment schedule');
  const { rows: pipe } = await client.query('SELECT key FROM crm_pipelines WHERE id = $1', [deal.pipeline_id]);
  const kind = data.kind ?? (pipe[0]?.key === 'csr' ? 'CSR_TRANCHE' : 'COMMERCIAL');
  if (data.milestone_id) {
    const { rows } = await client.query(
      'SELECT 1 FROM engagement_milestones m JOIN engagements e ON e.id = m.engagement_id WHERE m.id = $1 AND e.opportunity_id = $2',
      [data.milestone_id, opportunityId],
    );
    if (!rows[0]) throw badRequest('That milestone is not on this deal’s delivery');
  }
  if (data.invoice_id) {
    const { rows } = await client.query('SELECT 1 FROM opportunity_invoices WHERE id = $1 AND opportunity_id = $2', [data.invoice_id, opportunityId]);
    if (!rows[0]) throw badRequest('That invoice is not on this deal');
  }
  const { rows } = await client.query(
    `INSERT INTO crm_payment_schedules (opportunity_id, kind, label, due_on, amount, currency, milestone_id, invoice_id, notes, created_by)
     VALUES ($1,$2,$3,$4::date,$5::numeric,$6,$7,$8,$9,$10) RETURNING *`,
    [opportunityId, kind, data.label.trim(), data.due_on, data.amount, data.currency ?? deal.currency ?? 'INR',
      data.milestone_id ?? null, data.invoice_id ?? null, data.notes ?? null, actor.id],
  );
  await recordHistory(client, { opportunityId, field: 'payment_schedule', to: `${rows[0].label}: ${rows[0].currency} ${rows[0].amount} due ${data.due_on}`, actorId: actor.id });
  return rows[0];
}

export async function updateSchedule(client, { opportunityId, scheduleId, input, actor, reason }) {
  const data = scheduleInput.partial().parse(input);
  const { rows } = await client.query('SELECT * FROM crm_payment_schedules WHERE id = $1 AND opportunity_id = $2 FOR UPDATE', [scheduleId, opportunityId]);
  const before = rows[0];
  if (!before) throw notFound('Schedule line not found');
  if (before.is_cancelled) throw badRequest('This line was cancelled');
  if ((data.amount !== undefined && money.parse(data.amount) !== money.parse(before.amount)) || (data.due_on && data.due_on !== dateOnly(before.due_on))) {
    if (!reason?.trim()) throw badRequest('Say why the amount or date changed', { code: 'REASON_REQUIRED' });
  }
  if (data.currency && data.currency !== before.currency) {
    const { rows: paid } = await client.query('SELECT 1 FROM opportunity_payments WHERE schedule_id = $1 AND is_void = FALSE LIMIT 1', [scheduleId]);
    if (paid[0]) throw badRequest('Payments are recorded against this line; its currency cannot change');
  }
  const sets = [];
  const params = [];
  for (const key of ['label', 'due_on', 'amount', 'currency', 'milestone_id', 'invoice_id', 'notes']) {
    if (data[key] === undefined) continue;
    params.push(data[key]);
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) return before;
  params.push(scheduleId);
  const { rows: after } = await client.query(`UPDATE crm_payment_schedules SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
  await recordHistory(client, {
    opportunityId, field: 'payment_schedule', from: `${before.label}: ${before.currency} ${before.amount} due ${dateOnly(before.due_on)}`,
    to: `${after[0].label}: ${after[0].currency} ${after[0].amount} due ${dateOnly(after[0].due_on)}`, reason, actorId: actor.id,
  });
  return after[0];
}

export async function cancelSchedule(client, { opportunityId, scheduleId, actor, reason }) {
  if (!reason?.trim()) throw badRequest('Say why this line is cancelled');
  const { rows } = await client.query(
    `UPDATE crm_payment_schedules SET is_cancelled = TRUE, cancel_reason = $3, updated_at = now()
      WHERE id = $1 AND opportunity_id = $2 AND is_cancelled = FALSE RETURNING *`, [scheduleId, opportunityId, reason],
  );
  if (!rows[0]) throw notFound('Schedule line not found');
  await recordHistory(client, { opportunityId, field: 'payment_schedule', from: `${rows[0].label}: ${rows[0].currency} ${rows[0].amount}`, to: 'cancelled', reason, actorId: actor.id });
  return rows[0];
}

// ---------------------------------------------------------------- receipts and refunds

/**
 * Records a receipt or a refund. The same event key (given, or the bank
 * reference) is applied once; a second attempt returns the first record with
 * `duplicate: true` and changes nothing.
 */
export async function recordPayment(client, { opportunityId, input, actor, kind = 'RECEIPT' }) {
  const data = receiptInput.parse(input);
  if (kind === 'REFUND' && !hasPermission(actor, 'crm.finance')) throw forbidden('Refunds are recorded by finance');
  if (data.received_on > today()) throw badRequest(kind === 'REFUND' ? 'A refund dated in the future has not happened yet' : 'Money expected later has not been received — record it when it arrives');
  const deal = await lockDeal(client, opportunityId);
  if (!deal.is_monetary) throw badRequest('This deal has no money in it (a non-monetary partnership)');
  const cur = data.currency ?? deal.currency ?? 'INR';
  const reference = data.reference?.trim() || null;
  const eventKey = data.event_key?.trim() || (reference ? `${kind}:${(data.mode || 'ANY')}:${reference.toUpperCase().replace(/\s+/g, '')}` : null);
  if (eventKey) {
    const { rows } = await client.query('SELECT * FROM opportunity_payments WHERE event_key = $1', [eventKey]);
    if (rows[0]) {
      if (rows[0].opportunity_id !== opportunityId) throw badRequest(`That payment reference is already recorded on another deal (#${rows[0].opportunity_id})`, { code: 'PAYMENT_DUPLICATE' });
      return { payment: rows[0], duplicate: true };
    }
  }
  if (data.schedule_id) {
    const { rows } = await client.query('SELECT * FROM crm_payment_schedules WHERE id = $1 AND opportunity_id = $2', [data.schedule_id, opportunityId]);
    if (!rows[0]) throw badRequest('That schedule line is not on this deal');
    if (rows[0].is_cancelled) throw badRequest('That schedule line was cancelled');
    if (rows[0].currency !== cur) throw badRequest(`That line is in ${rows[0].currency}; record the payment in ${rows[0].currency}, or on another line`);
  }
  if (data.invoice_id) {
    const { rows } = await client.query('SELECT currency FROM opportunity_invoices WHERE id = $1 AND opportunity_id = $2', [data.invoice_id, opportunityId]);
    if (!rows[0]) throw badRequest('That invoice is not on this deal');
  }
  if (data.corrects_id) {
    const { rows } = await client.query('SELECT 1 FROM opportunity_payments WHERE id = $1 AND opportunity_id = $2', [data.corrects_id, opportunityId]);
    if (!rows[0]) throw badRequest('The payment being corrected is not on this deal');
  }
  if (kind === 'REFUND') {
    // a refund cannot exceed what was received in that currency
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'REFUND' THEN -amount ELSE amount END), 0) AS net
         FROM opportunity_payments WHERE opportunity_id = $1 AND is_void = FALSE AND currency = $2`, [opportunityId, cur],
    );
    if (money.parse(data.amount) > money.parse(rows[0].net)) throw badRequest(`Only ${cur} ${rows[0].net} has been received on this deal; a refund cannot be more`);
  }
  const inserted = await client.query(
    `INSERT INTO opportunity_payments (opportunity_id, invoice_id, received_on, amount, currency, reference, link, notes, created_by,
                                       kind, schedule_id, mode, event_key, corrects_id)
     VALUES ($1,$2,$3::date,$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [opportunityId, data.invoice_id ?? null, data.received_on, data.amount, cur, reference, cleanLink(data.link), data.notes?.trim() || null,
      actor.id, kind, data.schedule_id ?? null, data.mode ?? null, eventKey, data.corrects_id ?? null],
  );
  if (!inserted.rows[0]) {
    // another request recorded the same event a moment ago
    const { rows } = await client.query('SELECT * FROM opportunity_payments WHERE event_key = $1', [eventKey]);
    return { payment: rows[0], duplicate: true };
  }
  const payment = inserted.rows[0];
  await logActivity(client, {
    accountId: deal.account_id, opportunityId, type: kind === 'REFUND' ? 'REFUND' : 'PAYMENT', actorId: actor.id,
    subject: `${kind === 'REFUND' ? 'Refund paid' : 'Payment received'}: ${cur} ${payment.amount}${reference ? ` (${reference})` : ''}`,
    occurredAt: dayStamp(data.received_on),
    meta: { payment_id: payment.id, amount: payment.amount, currency: cur, kind },
    direction: kind === 'REFUND' ? 'OUTBOUND' : 'INBOUND', outcome: kind === 'REFUND' ? 'SENT' : 'RECEIVED', isExternal: false, source: 'MANUAL',
  });
  await recordAuditEvent(client, {
    action: kind === 'REFUND' ? 'PAYMENT_REFUND' : 'PAYMENT_RECEIPT', entityType: 'OPPORTUNITY', entityId: opportunityId, actorId: actor.id,
    summary: `${cur} ${payment.amount}`, detail: { payment_id: payment.id, reference, corrects: data.corrects_id ?? null },
  });
  await refreshFinancialStatus(client, opportunityId);
  await emitEvent(client, { type: kind === 'REFUND' ? 'payment.refunded' : 'payment.received', entityType: 'OPPORTUNITY', entityId: opportunityId, actorId: actor.id, payload: { payment_id: payment.id } });
  return { payment, duplicate: false };
}

/** Finance confirms a payment against the bank. */
export async function verifyPayment(client, { opportunityId, paymentId, actor }) {
  if (!hasPermission(actor, 'crm.finance')) throw forbidden('Payments are verified by finance');
  const { rows } = await client.query(
    `UPDATE opportunity_payments SET verified_at = now(), verified_by = $3, updated_at = now()
      WHERE id = $1 AND opportunity_id = $2 AND is_void = FALSE AND verified_at IS NULL RETURNING *`, [paymentId, opportunityId, actor.id],
  );
  if (!rows[0]) throw badRequest('Only an unverified, live payment can be verified');
  await recordAuditEvent(client, { action: 'PAYMENT_VERIFIED', entityType: 'OPPORTUNITY', entityId: opportunityId, actorId: actor.id, detail: { payment_id: paymentId } });
  return rows[0];
}

/** Voids a payment with a reason. A verified one needs the finance permission. */
export async function voidSalesPayment(client, { opportunityId, paymentId, actor, reason }) {
  if (!reason?.trim()) throw badRequest('Say why the payment is voided — the record stays, with your reason');
  const { rows } = await client.query('SELECT * FROM opportunity_payments WHERE id = $1 AND opportunity_id = $2 FOR UPDATE', [paymentId, opportunityId]);
  const p = rows[0];
  if (!p) throw notFound('No payment with that id on this deal');
  if (p.is_void) throw badRequest('Already voided');
  if ((p.verified_at || p.kind === 'REFUND') && !hasPermission(actor, 'crm.finance')) throw forbidden('A verified payment or a refund is changed only by finance');
  await client.query('UPDATE opportunity_payments SET is_void = TRUE, void_reason = $2, updated_at = now() WHERE id = $1', [paymentId, reason.trim()]);
  const { rows: deal } = await client.query('SELECT account_id FROM opportunities WHERE id = $1', [opportunityId]);
  await logActivity(client, {
    accountId: deal[0].account_id, opportunityId, type: 'PAYMENT', actorId: actor.id, subject: `${p.kind === 'REFUND' ? 'Refund' : 'Payment'} voided: ${p.currency} ${p.amount}`,
    body: reason.trim(), meta: { payment_id: paymentId, voided: true }, direction: 'INTERNAL', isExternal: false, source: 'MANUAL',
  });
  await recordAuditEvent(client, { action: 'PAYMENT_VOIDED', entityType: 'OPPORTUNITY', entityId: opportunityId, actorId: actor.id, reason, detail: { payment_id: paymentId, amount: p.amount, currency: p.currency, verified: Boolean(p.verified_at) } });
  await refreshFinancialStatus(client, opportunityId);
}

// ---------------------------------------------------------------- the position

/**
 * Per currency: scheduled, received (receipts − refunds), balance and
 * overdue, with each schedule line's outstanding amount. Plain strings, exact.
 */
export async function paymentPosition(opportunityId, { asOf = today(), runner = { query } } = {}) {
  const [{ rows: schedule }, { rows: payments }] = await Promise.all([
    runner.query('SELECT * FROM crm_payment_schedules WHERE opportunity_id = $1 ORDER BY due_on, id', [opportunityId]),
    runner.query(
      `SELECT p.*, u.full_name AS created_by_name, vu.full_name AS verified_by_name
         FROM opportunity_payments p LEFT JOIN users u ON u.id = p.created_by LEFT JOIN users vu ON vu.id = p.verified_by
        WHERE p.opportunity_id = $1 ORDER BY p.received_on, p.id`, [opportunityId],
    ),
  ]);
  const currencies = new Set([...schedule.filter((s) => !s.is_cancelled).map((s) => s.currency), ...payments.filter((p) => !p.is_void).map((p) => p.currency)]);
  const byCurrency = {};
  const lines = schedule.map((s) => ({ ...s, due_on: dateOnly(s.due_on), received: '0.00', outstanding: s.is_cancelled ? '0.00' : String(s.amount), overdue: false }));
  for (const cur of currencies) {
    const live = payments.filter((p) => !p.is_void && p.currency === cur);
    const receipts = live.filter((p) => p.kind !== 'REFUND').reduce((t, p) => t + money.parse(p.amount), 0n);
    const refunds = live.filter((p) => p.kind === 'REFUND').reduce((t, p) => t + money.parse(p.amount), 0n);
    const received = receipts - refunds;
    const curLines = lines.filter((l) => !l.is_cancelled && l.currency === cur);
    const scheduled = curLines.reduce((t, l) => t + money.parse(l.amount), 0n);

    // receipts tied to a line pay that line, and a refund of one of them comes
    // off the same line; the rest (net of refunds) pay the oldest lines first,
    // and an untied refund comes off the latest
    const lineOf = (p) => p.schedule_id ?? (p.corrects_id ? live.find((r) => r.id === p.corrects_id)?.schedule_id ?? null : null);
    let untied = received;
    for (const l of curLines) {
      const tied = live.filter((p) => lineOf(p) === l.id).reduce((t, p) => t + (p.kind === 'REFUND' ? -money.parse(p.amount) : money.parse(p.amount)), 0n);
      untied -= tied;
      l._paid = tied > 0n ? tied : 0n;
    }
    for (const l of curLines) {
      const room = money.parse(l.amount) - l._paid;
      if (room > 0n && untied > 0n) {
        const use = untied < room ? untied : room;
        l._paid += use;
        untied -= use;
      }
    }
    for (const l of [...curLines].reverse()) {
      if (untied >= 0n) break;
      const back = l._paid < -untied ? l._paid : -untied;
      l._paid -= back;
      untied += back;
    }
    let overdue = 0n;
    for (const l of curLines) {
      const outstanding = money.parse(l.amount) - l._paid;
      l.received = money.format(l._paid);
      l.outstanding = money.format(outstanding > 0n ? outstanding : 0n);
      l.overdue = outstanding > 0n && l.due_on < asOf;
      if (l.overdue) overdue += outstanding;
      delete l._paid;
    }
    const balance = scheduled - received;
    byCurrency[cur] = {
      currency: cur,
      scheduled: curLines.length ? money.format(scheduled) : null,
      receipts: money.format(receipts),
      refunds: money.format(refunds),
      received: money.format(received),
      // a schedule says what is owed; without one there is no balance to state
      balance: curLines.length ? money.format(balance > 0n ? balance : 0n) : null,
      overpaid: curLines.length && balance < 0n ? money.format(-balance) : null,
      overdue: money.format(overdue),
    };
  }
  return { as_of: asOf, currencies: Object.values(byCurrency), schedule: lines, payments };
}

// ---------------------------------------------------------------- conversion rates

/** The rate to turn `currency` into `base` on or before `asOf`; null when none is recorded. */
export async function fxRate(currencyCode, base, asOf, runner = { query }) {
  if (currencyCode === base) return { rate: '1', as_of: asOf, source: 'same currency' };
  const { rows } = await runner.query(
    'SELECT rate, as_of, source FROM crm_fx_rates WHERE currency = $1 AND base = $2 AND as_of <= $3::date ORDER BY as_of DESC LIMIT 1',
    [currencyCode, base, asOf],
  );
  return rows[0] ? { rate: String(rows[0].rate), as_of: dateOnly(rows[0].as_of), source: rows[0].source } : null;
}

export async function setFxRate({ currency: cur, base, rate, asOf, source }, actor) {
  if (!/^[A-Z]{3}$/.test(cur) || !/^[A-Z]{3}$/.test(base) || cur === base) throw badRequest('Give two different three-letter currency codes');
  if (!(Number(rate) > 0)) throw badRequest('The rate must be more than zero');
  const { rows } = await query(
    `INSERT INTO crm_fx_rates (currency, base, rate, as_of, source, created_by) VALUES ($1,$2,$3::numeric,$4::date,$5,$6)
     ON CONFLICT (currency, base, as_of) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, created_by = EXCLUDED.created_by
     RETURNING *`,
    [cur, base, String(rate), asOf, source ?? null, actor.id],
  );
  await recordAuditEvent(null, { action: 'FX_RATE_SET', entityType: 'SETTINGS', actorId: actor.id, summary: `${cur}→${base} ${rate} on ${asOf}`, detail: { source } });
  return rows[0];
}
