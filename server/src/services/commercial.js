/**
 * The commercial record of a deal: proposals, orders, invoices and payments.
 *
 * Four different claims, kept apart on purpose:
 *
 *   a PROPOSAL is an offer we made          → proposed value
 *   an ORDER is a commitment they made      → bookings
 *   an INVOICE is revenue we have billed    → invoiced
 *   a PAYMENT is cash that actually arrived → cash received
 *
 * Adding any two of these together, or reading a missing one as zero, is how a
 * pipeline report starts claiming money nobody has. A total over no records is
 * null ("nothing recorded"), never 0.
 *
 * Nothing is ever removed. A wrong entry is withdrawn, cancelled or voided with
 * a reason, and the original stays visible with that reason beside it.
 */

import { query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logActivity } from './crm.js';
import { today } from './dealRules.js';
import { cleanLink } from './dealMoves.js';
import { recordHistory } from './opportunities.js';

const num = (value) => (value === null || value === undefined ? null : Number(value));
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10));

export const PROPOSAL_STATUSES = ['SENT', 'ACCEPTED', 'DECLINED', 'SUPERSEDED', 'WITHDRAWN'];

const withNames = (table, alias) => `
  SELECT ${alias}.*, u.full_name AS created_by_name
    FROM ${table} ${alias} LEFT JOIN users u ON u.id = ${alias}.created_by
   WHERE ${alias}.opportunity_id = $1`;

/** Everything on file for one deal, newest first, with the totals that are safe to state. */
export async function commercialRecord(opportunityId) {
  const [proposals, orders, invoices, payments] = await Promise.all([
    query(`${withNames('opportunity_proposals', 'p')} ORDER BY p.sent_on DESC, p.id DESC`, [opportunityId]),
    query(`${withNames('opportunity_orders', 'r')} ORDER BY r.received_on DESC, r.id DESC`, [opportunityId]),
    query(
      `SELECT i.*, u.full_name AS created_by_name, r.reference AS order_reference,
              (SELECT SUM(pm.amount) FROM opportunity_payments pm
                WHERE pm.invoice_id = i.id AND pm.is_void = FALSE) AS paid
         FROM opportunity_invoices i
         LEFT JOIN users u ON u.id = i.created_by
         LEFT JOIN opportunity_orders r ON r.id = i.order_id
        WHERE i.opportunity_id = $1 ORDER BY i.issued_on DESC, i.id DESC`,
      [opportunityId],
    ),
    query(
      `SELECT pm.*, u.full_name AS created_by_name, i.number AS invoice_number
         FROM opportunity_payments pm
         LEFT JOIN users u ON u.id = pm.created_by
         LEFT JOIN opportunity_invoices i ON i.id = pm.invoice_id
        WHERE pm.opportunity_id = $1 ORDER BY pm.received_on DESC, pm.id DESC`,
      [opportunityId],
    ),
  ]);

  const money = (rows) => rows.map((row) => ({
    ...row, amount: num(row.amount), ...(row.paid !== undefined ? { paid: num(row.paid) } : {}),
  }));
  const sum = (rows, keep) => {
    const counted = rows.filter(keep);
    if (!counted.length) return null;
    // an order whose amount nobody knows makes the total incomplete, and says so
    const known = counted.filter((row) => row.amount !== null && row.amount !== undefined);
    return known.length ? known.reduce((total, row) => total + Number(row.amount), 0) : null;
  };

  const liveOrders = orders.rows.filter((r) => r.status === 'ACCEPTED');
  return {
    proposals: money(proposals.rows),
    orders: money(orders.rows),
    invoices: money(invoices.rows),
    payments: money(payments.rows),
    totals: {
      latest_proposal: num(proposals.rows.find((p) => p.status !== 'WITHDRAWN')?.amount ?? null),
      booked: sum(orders.rows, (r) => r.status === 'ACCEPTED'),
      booked_incomplete: liveOrders.some((r) => r.amount === null),
      invoiced: sum(invoices.rows, (i) => i.status === 'ISSUED'),
      cash_received: sum(payments.rows, (p) => !p.is_void),
    },
  };
}

// ---------------------------------------------------------------- proposals

export async function setProposalStatus(client, { opportunity, proposalId, status, notes, actor }) {
  if (!PROPOSAL_STATUSES.includes(status)) throw badRequest('Unknown proposal status');
  const { rows } = await client.query(
    `UPDATE opportunity_proposals
        SET status = $1, notes = COALESCE($2, notes), updated_at = now()
      WHERE id = $3 AND opportunity_id = $4 RETURNING *`,
    [status, notes ?? null, proposalId, opportunity.id],
  );
  if (!rows[0]) throw notFound('Proposal not found');
  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'NOTE',
    actorId: actor.id,
    subject: `Proposal ${rows[0].title ? `"${rows[0].title}" ` : ''}marked ${status.toLowerCase()}`,
    body: notes ?? null,
    meta: { proposal_id: rows[0].id, status },
    source: 'MANUAL',
  });
  return rows[0];
}

// ---------------------------------------------------------------- orders

export async function cancelOrder(client, { opportunity, orderId, reason, actor }) {
  if (!reason?.trim()) throw badRequest('Say why the order is cancelled — the record stays, with your reason');
  const { rows } = await client.query(
    `UPDATE opportunity_orders SET status = 'CANCELLED', cancel_reason = $1, updated_at = now()
      WHERE id = $2 AND opportunity_id = $3 AND status = 'ACCEPTED' RETURNING *`,
    [reason.trim(), orderId, opportunity.id],
  );
  if (!rows[0]) throw notFound('No accepted order with that id on this deal');
  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'ORDER',
    actorId: actor.id,
    subject: `Order ${rows[0].reference || `#${rows[0].id}`} cancelled`,
    body: reason.trim(),
    meta: { order_id: rows[0].id, cancelled: true },
    direction: 'INTERNAL',
    isExternal: false,
    source: 'MANUAL',
  });
  return rows[0];
}

// ---------------------------------------------------------------- invoices

export async function addInvoice(client, { opportunity, invoice, actor }) {
  if (!isDay(invoice.issued_on)) throw badRequest('Give the date the invoice was issued');
  if (invoice.issued_on.slice(0, 10) > today()) throw badRequest('An invoice dated in the future has not been issued yet');
  if (invoice.amount === null || invoice.amount === undefined || Number(invoice.amount) < 0) {
    throw badRequest('An invoice needs its amount');
  }
  if (invoice.order_id) {
    const { rows } = await client.query(
      'SELECT id FROM opportunity_orders WHERE id = $1 AND opportunity_id = $2', [invoice.order_id, opportunity.id],
    );
    if (!rows[0]) throw badRequest('That order is not on this deal');
  }
  const { rows } = await client.query(
    `INSERT INTO opportunity_invoices
       (opportunity_id, order_id, number, issued_on, amount, currency, due_on, link, notes, created_by)
     VALUES ($1,$2,$3,$4::date,$5::numeric,COALESCE($6,'INR'),$7::date,$8,$9,$10)
     RETURNING *`,
    [
      opportunity.id, invoice.order_id ?? null, invoice.number?.trim() || null,
      invoice.issued_on.slice(0, 10), invoice.amount, invoice.currency ?? opportunity.currency ?? null,
      invoice.due_on || null, cleanLink(invoice.link), invoice.notes?.trim() || null, actor.id,
    ],
  );
  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'INVOICE',
    actorId: actor.id,
    subject: `Invoice ${rows[0].number || `#${rows[0].id}`} issued`,
    occurredAt: `${rows[0].issued_on}T12:00:00+05:30`,
    meta: { invoice_id: rows[0].id, amount: num(rows[0].amount) },
    direction: 'OUTBOUND',
    outcome: 'SENT',
    // an invoice going out is not a conversation with anyone
    isExternal: false,
    source: 'MANUAL',
  });
  await refreshFinancialStatus(client, opportunity.id);
  return rows[0];
}

export async function cancelInvoice(client, { opportunity, invoiceId, reason, actor }) {
  if (!reason?.trim()) throw badRequest('Say why the invoice is cancelled — the record stays, with your reason');
  const { rows } = await client.query(
    `UPDATE opportunity_invoices SET status = 'CANCELLED', cancel_reason = $1, updated_at = now()
      WHERE id = $2 AND opportunity_id = $3 AND status = 'ISSUED' RETURNING *`,
    [reason.trim(), invoiceId, opportunity.id],
  );
  if (!rows[0]) throw notFound('No issued invoice with that id on this deal');
  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'INVOICE',
    actorId: actor.id,
    subject: `Invoice ${rows[0].number || `#${rows[0].id}`} cancelled`,
    body: reason.trim(),
    meta: { invoice_id: rows[0].id, cancelled: true },
    direction: 'INTERNAL',
    isExternal: false,
    source: 'MANUAL',
  });
  await refreshFinancialStatus(client, opportunity.id);
  return rows[0];
}

// ---------------------------------------------------------------- payments

export async function addPayment(client, { opportunity, payment, actor }) {
  if (!isDay(payment.received_on)) throw badRequest('Give the date the money arrived');
  if (payment.received_on.slice(0, 10) > today()) {
    throw badRequest('Money expected later has not been received — record it when it arrives');
  }
  if (!(Number(payment.amount) > 0)) throw badRequest('A payment needs the amount that arrived');
  if (payment.invoice_id) {
    const { rows } = await client.query(
      'SELECT id FROM opportunity_invoices WHERE id = $1 AND opportunity_id = $2', [payment.invoice_id, opportunity.id],
    );
    if (!rows[0]) throw badRequest('That invoice is not on this deal');
  }
  const { rows } = await client.query(
    `INSERT INTO opportunity_payments
       (opportunity_id, invoice_id, received_on, amount, currency, reference, link, notes, created_by)
     VALUES ($1,$2,$3::date,$4::numeric,COALESCE($5,'INR'),$6,$7,$8,$9)
     RETURNING *`,
    [
      opportunity.id, payment.invoice_id ?? null, payment.received_on.slice(0, 10), payment.amount,
      payment.currency ?? opportunity.currency ?? null, payment.reference?.trim() || null,
      cleanLink(payment.link), payment.notes?.trim() || null, actor.id,
    ],
  );
  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'PAYMENT',
    actorId: actor.id,
    subject: `Payment received${rows[0].reference ? ` (${rows[0].reference})` : ''}`,
    occurredAt: `${rows[0].received_on}T12:00:00+05:30`,
    meta: { payment_id: rows[0].id, amount: num(rows[0].amount) },
    direction: 'INBOUND',
    outcome: 'RECEIVED',
    isExternal: false,
    source: 'MANUAL',
  });
  await refreshFinancialStatus(client, opportunity.id);
  return rows[0];
}

export async function voidPayment(client, { opportunity, paymentId, reason, actor }) {
  if (!reason?.trim()) throw badRequest('Say why the payment is voided — the record stays, with your reason');
  const { rows } = await client.query(
    `UPDATE opportunity_payments SET is_void = TRUE, void_reason = $1, updated_at = now()
      WHERE id = $2 AND opportunity_id = $3 AND is_void = FALSE RETURNING *`,
    [reason.trim(), paymentId, opportunity.id],
  );
  if (!rows[0]) throw notFound('No payment with that id on this deal');
  await logActivity(client, {
    accountId: opportunity.account_id,
    opportunityId: opportunity.id,
    type: 'PAYMENT',
    actorId: actor.id,
    subject: 'Payment voided',
    body: reason.trim(),
    meta: { payment_id: rows[0].id, voided: true },
    direction: 'INTERNAL',
    isExternal: false,
    source: 'MANUAL',
  });
  await refreshFinancialStatus(client, opportunity.id);
  return rows[0];
}

/**
 * Keeps the deal's money status in step with its invoices and payments, once
 * there are any. A deal with no ledger entries keeps whatever status somebody
 * chose by hand — nothing is overwritten from an absence of records.
 */
export async function refreshFinancialStatus(client, opportunityId) {
  const { rows } = await client.query(
    `SELECT o.financial_status,
            (SELECT SUM(i.amount) FROM opportunity_invoices i
              WHERE i.opportunity_id = o.id AND i.status = 'ISSUED') AS invoiced,
            (SELECT SUM(p.amount) FROM opportunity_payments p
              WHERE p.opportunity_id = o.id AND p.is_void = FALSE) AS paid
       FROM opportunities o WHERE o.id = $1`,
    [opportunityId],
  );
  const row = rows[0];
  if (!row) return;
  const invoiced = num(row.invoiced);
  const paid = num(row.paid);
  if (invoiced === null && paid === null) return;

  let status = 'INVOICED';
  if (paid !== null && invoiced !== null && paid >= invoiced) status = 'PAID';
  else if (paid !== null && paid > 0) status = 'PART_PAID';
  if (status !== row.financial_status) {
    await client.query('UPDATE opportunities SET financial_status = $1, updated_at = now() WHERE id = $2',
      [status, opportunityId]);
    await recordHistory(client, {
      opportunityId, field: 'financial_status', from: row.financial_status, to: status,
      reason: 'From the invoices and payments recorded',
    });
  }
}

// ---------------------------------------------------------------- reporting

/**
 * Bookings, revenue billed and cash received inside a period, each on its own
 * date: an order counts on the day it was received, an invoice on the day it
 * was issued, a payment on the day the money arrived.
 */
export async function commercialTotals({ start, end, departmentId = null, ownerId = null } = {}) {
  const scope = `JOIN opportunities o ON o.id = x.opportunity_id
                 JOIN accounts a ON a.id = o.account_id
                WHERE o.is_archived = FALSE AND a.is_archived = FALSE
                  AND ($3::int IS NULL OR a.department_id = $3::int)
                  AND ($4::int IS NULL OR o.owner_user_id = $4::int)`;
  const params = [start, end, departmentId, ownerId];
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM opportunity_orders x ${scope}
         AND x.status = 'ACCEPTED' AND x.received_on >= $1::date AND x.received_on < $2::date) AS orders,
       (SELECT SUM(x.amount) FROM opportunity_orders x ${scope}
         AND x.status = 'ACCEPTED' AND x.received_on >= $1::date AND x.received_on < $2::date) AS booked,
       (SELECT COUNT(*)::int FROM opportunity_orders x ${scope}
         AND x.status = 'ACCEPTED' AND x.amount IS NULL
         AND x.received_on >= $1::date AND x.received_on < $2::date) AS orders_without_amount,
       (SELECT COUNT(*)::int FROM opportunity_invoices x ${scope}
         AND x.status = 'ISSUED' AND x.issued_on >= $1::date AND x.issued_on < $2::date) AS invoices,
       (SELECT SUM(x.amount) FROM opportunity_invoices x ${scope}
         AND x.status = 'ISSUED' AND x.issued_on >= $1::date AND x.issued_on < $2::date) AS invoiced,
       (SELECT COUNT(*)::int FROM opportunity_payments x ${scope}
         AND x.is_void = FALSE AND x.received_on >= $1::date AND x.received_on < $2::date) AS payments,
       (SELECT SUM(x.amount) FROM opportunity_payments x ${scope}
         AND x.is_void = FALSE AND x.received_on >= $1::date AND x.received_on < $2::date) AS cash_received,
       (SELECT COUNT(*)::int FROM opportunity_proposals x ${scope}
         AND x.status <> 'WITHDRAWN' AND x.sent_on >= $1::date AND x.sent_on < $2::date) AS proposals`,
    params,
  );
  const row = rows[0];
  return {
    orders: row.orders,
    booked: num(row.booked),
    orders_without_amount: row.orders_without_amount,
    invoices: row.invoices,
    invoiced: num(row.invoiced),
    payments: row.payments,
    cash_received: num(row.cash_received),
    proposals: row.proposals,
  };
}
