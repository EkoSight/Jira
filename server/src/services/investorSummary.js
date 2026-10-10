/**
 * The investor summary: what the pipeline can stand behind, as of a date.
 *
 * Only what is on the record counts as verified — accepted orders, issued
 * invoices, payments that arrived, stage moves made with their evidence, and
 * proposals actually sent. Our own estimates are shown apart and labelled as
 * estimates. Anything the record does not support is left out of the figures
 * and counted, so the reader can see what was excluded and why.
 *
 * Never included: anyone's contact details, internal notes, next actions, or the
 * names of the people working the deals. Organization names can be replaced with
 * neutral labels.
 */

import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { dateIn } from './availability.js';
import { evidenceFor, ruleHolds } from './dealRules.js';

const TZ = 'Asia/Kolkata';
const num = (value) => (value === null || value === undefined ? null : Number(value));
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const sum = (rows, key = 'amount') => {
  const known = rows.filter((r) => r[key] !== null && r[key] !== undefined);
  return known.length ? known.reduce((total, r) => total + Number(r[key]), 0) : null;
};

/** India's financial year, April to March, around a date. */
export function financialYear(day) {
  const [y, m] = day.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

export const SUMMARY_DEFINITIONS = {
  bookings: 'Accepted purchase orders, contracts, work orders and MoUs received in the period, each with a reference or a link to the document. Cancelled ones are excluded. A booking is a commitment, not money.',
  invoiced: 'Invoices issued in the period and not cancelled — revenue billed, not cash.',
  collections: 'Payments recorded as received in the period, by the date they arrived. Voided entries are excluded.',
  receivable: 'For every deal with an invoice on record: invoiced to date less collected to date, as of the summary date.',
  wins: 'Deals moved to Won in the period with an accepted order on record.',
  movements: 'Stage moves in the period. Moves made without the evidence their stage asks for are excluded and counted separately.',
  pipeline: 'Live deals as of the summary date, by stage. A deal counts at its stage only when the record supports the stage (a proposal for Proposal, and so on).',
  proposed: 'The latest proposal actually sent on each live deal — an offer, not a commitment.',
  estimated: 'Our own estimate, on live deals with no proposal yet. An estimate: unverified, and not a forecast.',
};

/**
 * The summary for a period. `anonymise` replaces organization names with
 * "Organization A", "Organization B"… in order of bookings.
 */
export async function investorSummary({ from, to, anonymise = false, now = new Date() } = {}) {
  const asOfDay = dateIn(TZ, now);
  const year = financialYear(asOfDay);
  const start = from || year.from;
  const end = to || asOfDay;
  if (!isDay(start) || !isDay(end)) throw badRequest('Use dates like 2026-04-01');
  if (start > end) throw badRequest('The period starts after it ends');
  if (end > asOfDay) throw badRequest('A summary cannot cover days that have not happened yet');
  const endExclusive = new Date(`${end}T00:00:00Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const until = endExclusive.toISOString().slice(0, 10);
  const [fromTs, toTs] = [`${start}T00:00:00+05:30`, `${until}T00:00:00+05:30`];

  const [orders, invoices, payments, receivable, moves, wins, lost, created, live, paused, typed] = await Promise.all([
    query(
      `SELECT r.id, r.kind, r.received_on, r.amount, o.account_id, a.name AS account_name, a.type AS account_type
         FROM opportunity_orders r JOIN opportunities o ON o.id = r.opportunity_id
         JOIN accounts a ON a.id = o.account_id
        WHERE r.status = 'ACCEPTED' AND r.received_on >= $1::date AND r.received_on <= $2::date
          AND o.is_archived = FALSE AND a.is_archived = FALSE`,
      [start, end],
    ),
    query(
      `SELECT i.id, i.issued_on, i.amount, o.account_id
         FROM opportunity_invoices i JOIN opportunities o ON o.id = i.opportunity_id
         JOIN accounts a ON a.id = o.account_id
        WHERE i.status = 'ISSUED' AND i.issued_on >= $1::date AND i.issued_on <= $2::date
          AND o.is_archived = FALSE AND a.is_archived = FALSE`,
      [start, end],
    ),
    query(
      `SELECT pm.id, pm.received_on, pm.amount, o.account_id
         FROM opportunity_payments pm JOIN opportunities o ON o.id = pm.opportunity_id
         JOIN accounts a ON a.id = o.account_id
        WHERE pm.is_void = FALSE AND pm.received_on >= $1::date AND pm.received_on <= $2::date
          AND o.is_archived = FALSE AND a.is_archived = FALSE`,
      [start, end],
    ),
    query(
      `SELECT o.id,
              (SELECT SUM(i.amount) FROM opportunity_invoices i
                WHERE i.opportunity_id = o.id AND i.status = 'ISSUED' AND i.issued_on <= $1::date) AS invoiced,
              (SELECT SUM(pm.amount) FROM opportunity_payments pm
                WHERE pm.opportunity_id = o.id AND pm.is_void = FALSE AND pm.received_on <= $1::date) AS collected
         FROM opportunities o JOIN accounts a ON a.id = o.account_id
        WHERE o.is_archived = FALSE AND a.is_archived = FALSE
          AND EXISTS (SELECT 1 FROM opportunity_invoices i
                       WHERE i.opportunity_id = o.id AND i.status = 'ISSUED' AND i.issued_on <= $1::date)`,
      [end],
    ),
    query(
      `SELECT h.is_reversal, h.to_value, h.evidence_missing
         FROM opportunity_history h JOIN opportunities o ON o.id = h.opportunity_id
         JOIN accounts a ON a.id = o.account_id
        WHERE h.field = 'stage' AND h.created_at >= $1 AND h.created_at < $2
          AND o.is_archived = FALSE AND a.is_archived = FALSE`,
      [fromTs, toTs],
    ),
    // won in the period: when the deal closed, and whether an accepted order backs it
    query(
      `SELECT o.id, o.account_id, a.name AS account_name, o.closed_at,
              (SELECT COUNT(*)::int FROM opportunity_orders r
                WHERE r.opportunity_id = o.id AND r.status = 'ACCEPTED') AS orders,
              (SELECT SUM(r.amount) FROM opportunity_orders r
                WHERE r.opportunity_id = o.id AND r.status = 'ACCEPTED') AS booked
         FROM opportunities o JOIN accounts a ON a.id = o.account_id
        WHERE o.status = 'WON' AND o.closed_at >= $1 AND o.closed_at < $2
          AND o.is_archived = FALSE AND a.is_archived = FALSE`,
      [fromTs, toTs],
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM opportunities o JOIN accounts a ON a.id = o.account_id
        WHERE o.status = 'LOST' AND o.closed_at >= $1 AND o.closed_at < $2
          AND o.is_archived = FALSE AND a.is_archived = FALSE`,
      [fromTs, toTs],
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM opportunities o JOIN accounts a ON a.id = o.account_id
        WHERE o.created_at >= $1 AND o.created_at < $2 AND o.is_archived = FALSE AND a.is_archived = FALSE`,
      [fromTs, toTs],
    ),
    query(
      `SELECT o.id, o.account_id, o.estimated_value, o.value_unknown, o.engagement_model,
              s.id AS stage_id, s.name AS stage_name, s.position AS stage_position, s.kind AS stage_kind,
              s.entry_rules,
              (SELECT p.amount FROM opportunity_proposals p
                WHERE p.opportunity_id = o.id AND p.status <> 'WITHDRAWN'
                ORDER BY p.sent_on DESC, p.id DESC LIMIT 1) AS latest_proposal
         FROM opportunities o JOIN accounts a ON a.id = o.account_id
         LEFT JOIN account_stages s ON s.id = o.stage_id
        WHERE o.status = 'ACTIVE' AND o.is_archived = FALSE AND a.is_archived = FALSE`,
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM opportunities o JOIN accounts a ON a.id = o.account_id
        WHERE o.status IN ('ON_HOLD','NURTURE') AND o.is_archived = FALSE AND a.is_archived = FALSE`,
    ),
    // amounts somebody typed as "collected" with no payment on record behind them
    query(
      `SELECT COUNT(*)::int AS n FROM opportunities o JOIN accounts a ON a.id = o.account_id
        WHERE o.collected_value IS NOT NULL AND o.is_archived = FALSE AND a.is_archived = FALSE
          AND NOT EXISTS (SELECT 1 FROM opportunity_payments pm
                           WHERE pm.opportunity_id = o.id AND pm.is_void = FALSE)`,
    ),
  ]);

  // ---- organization labels: real names, or neutral ones in order of bookings
  const bookedBy = new Map();
  for (const row of orders.rows) {
    bookedBy.set(row.account_id, (bookedBy.get(row.account_id) || 0) + (num(row.amount) || 0));
  }
  for (const row of wins.rows) if (!bookedBy.has(row.account_id)) bookedBy.set(row.account_id, 0);
  const ranked = [...bookedBy.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const nameOf = new Map([...orders.rows, ...wins.rows].map((r) => [r.account_id, r.account_name]));
  const label = (accountId, index) => {
    if (!anonymise) return nameOf.get(accountId) || 'An organization';
    let n = index;
    let text = '';
    do { text = String.fromCharCode(65 + (n % 26)) + text; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return `Organization ${text}`;
  };
  const labels = new Map(ranked.map((id, index) => [id, label(id, index)]));

  // ---- bookings, billing and cash
  const orderRows = orders.rows.map((r) => ({ ...r, amount: num(r.amount) }));
  const noAmount = orderRows.filter((r) => r.amount === null).length;
  const receivables = receivable.rows.map((r) => ({ invoiced: num(r.invoiced) || 0, collected: num(r.collected) || 0 }));
  const outstanding = receivables.reduce((total, r) => total + Math.max(0, r.invoiced - r.collected), 0);

  // ---- movements: only moves made with their evidence
  const moveRows = moves.rows;
  const unsupportedMoves = moveRows.filter((m) => m.evidence_missing?.length);
  const supported = moveRows.filter((m) => !m.evidence_missing?.length);

  // ---- wins: only those an accepted order backs
  const backedWins = wins.rows.filter((w) => w.orders > 0);
  const unbackedWins = wins.rows.length - backedWins.length;

  // ---- the open pipeline, at stages the record supports
  const evidence = await evidenceFor(live.rows.map((d) => d.id));
  const byStage = new Map();
  let unsupportedStage = 0;
  let noStage = 0;
  for (const deal of live.rows) {
    if (!deal.stage_id || deal.stage_kind !== 'open') { noStage += 1; continue; }
    const rules = (deal.entry_rules || []).filter((r) => ['proposal', 'order', 'meeting_completed'].includes(r));
    const ok = rules.every((rule) => ruleHolds(rule, deal, evidence.get(deal.id) || {}));
    if (!ok) { unsupportedStage += 1; continue; }
    const entry = byStage.get(deal.stage_id) || {
      stage: deal.stage_name, position: deal.stage_position, deals: 0,
      proposed: 0, proposed_deals: 0, estimated: 0, estimated_deals: 0, unvalued_deals: 0,
    };
    entry.deals += 1;
    const proposal = num(deal.latest_proposal);
    const estimate = num(deal.estimated_value);
    if (proposal !== null) { entry.proposed += proposal; entry.proposed_deals += 1; }
    else if (estimate !== null && !deal.value_unknown) { entry.estimated += estimate; entry.estimated_deals += 1; }
    else entry.unvalued_deals += 1;
    byStage.set(deal.stage_id, entry);
  }
  const stagesOut = [...byStage.values()].sort((a, b) => a.position - b.position).map(({ position, ...rest }) => rest);
  const pipelineDeals = stagesOut.reduce((t, s) => t + s.deals, 0);

  // customers behind the bookings, by label — never their people
  const customers = ranked.map((accountId) => {
    const own = orderRows.filter((r) => r.account_id === accountId);
    return {
      organization: labels.get(accountId),
      orders: own.length,
      booked: sum(own),
      orders_without_amount: own.filter((r) => r.amount === null).length,
      won_in_period: wins.rows.some((w) => w.account_id === accountId && w.orders > 0),
    };
  });

  return {
    title: 'Pipeline summary',
    as_of: now.toISOString(),
    as_of_date: asOfDay,
    period: { from: start, to: end },
    anonymised: Boolean(anonymise),
    currency: 'INR',
    verified: {
      bookings: { orders: orderRows.length, amount: sum(orderRows), orders_without_amount: noAmount },
      invoiced: { invoices: invoices.rows.length, amount: sum(invoices.rows) },
      collections: { payments: payments.rows.length, amount: sum(payments.rows) },
      receivable: { deals: receivables.length, amount: receivables.length ? outstanding : null },
      wins: { deals: backedWins.length, booked: sum(backedWins.map((w) => ({ amount: num(w.booked) }))) },
      movements: {
        forward: supported.filter((m) => !m.is_reversal && m.to_value !== 'Lost').length,
        back: supported.filter((m) => m.is_reversal).length,
        new_deals: created.rows[0].n,
        lost: lost.rows[0].n,
      },
    },
    pipeline: {
      live_deals: live.rows.length,
      counted_deals: pipelineDeals,
      by_stage: stagesOut,
      proposed_total: stagesOut.reduce((t, s) => t + s.proposed, 0),
      estimated_total: stagesOut.reduce((t, s) => t + s.estimated, 0),
      paused_deals: paused.rows[0].n,
    },
    customers,
    excluded: [
      unsupportedMoves.length && { what: 'Stage moves made without the evidence the stage asks for', count: unsupportedMoves.length },
      unbackedWins && { what: 'Deals marked Won with no accepted order on record', count: unbackedWins },
      unsupportedStage && { what: 'Live deals in a stage the record does not support (left out of the pipeline by stage)', count: unsupportedStage },
      noStage && { what: 'Live deals in a closed stage or none', count: noStage },
      noAmount && { what: 'Orders with no amount recorded (counted, but not in the total)', count: noAmount },
      typed.rows[0].n && { what: 'Hand-typed "collected" figures with no recorded payment behind them', count: typed.rows[0].n },
      { what: 'Contact names, emails and phone numbers; internal notes; next actions; and the names of our staff', count: null },
    ].filter(Boolean),
    definitions: SUMMARY_DEFINITIONS,
  };
}

/** The summary as rows for a spreadsheet: section, measure, value, what it means. */
export function summaryRows(summary) {
  const v = summary.verified;
  const d = summary.definitions;
  const rows = [
    ['As of', 'Date', summary.as_of_date, 'Figures as recorded at this date'],
    ['Period', 'From', summary.period.from, ''],
    ['Period', 'To', summary.period.to, ''],
    ['Verified', 'Bookings — orders', v.bookings.orders, d.bookings],
    ['Verified', 'Bookings — amount (INR)', v.bookings.amount, `${v.bookings.orders_without_amount} order(s) without an amount are not in this total`],
    ['Verified', 'Invoiced — invoices', v.invoiced.invoices, d.invoiced],
    ['Verified', 'Invoiced — amount (INR)', v.invoiced.amount, ''],
    ['Verified', 'Collections — payments', v.collections.payments, d.collections],
    ['Verified', 'Collections — amount (INR)', v.collections.amount, ''],
    ['Verified', 'Receivable — amount (INR)', v.receivable.amount, d.receivable],
    ['Verified', 'Wins backed by an order', v.wins.deals, d.wins],
    ['Verified', 'Stage moves forward', v.movements.forward, d.movements],
    ['Verified', 'Stage moves back', v.movements.back, ''],
    ['Verified', 'New deals', v.movements.new_deals, ''],
    ['Verified', 'Deals lost', v.movements.lost, ''],
    ['Pipeline', 'Live deals', summary.pipeline.live_deals, ''],
    ['Pipeline', 'Counted at a supported stage', summary.pipeline.counted_deals, d.pipeline],
  ];
  for (const stage of summary.pipeline.by_stage) {
    rows.push(['Pipeline by stage', `${stage.stage} — deals`, stage.deals, '']);
    rows.push(['Pipeline by stage', `${stage.stage} — proposed (INR)`, stage.proposed, d.proposed]);
    rows.push(['Pipeline by stage', `${stage.stage} — ESTIMATE (INR)`, stage.estimated, d.estimated]);
  }
  for (const customer of summary.customers) {
    rows.push(['Bookings by organization', customer.organization, customer.booked,
      `${customer.orders} order(s)${customer.orders_without_amount ? `, ${customer.orders_without_amount} without an amount` : ''}`]);
  }
  for (const item of summary.excluded) {
    rows.push(['Excluded', item.what, item.count, '']);
  }
  return rows;
}
