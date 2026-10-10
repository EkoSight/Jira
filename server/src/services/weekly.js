/**
 * The week, on the record.
 *
 * What moved since last week, read from what was recorded as it happened:
 * stage changes, what customers committed to (and whether they kept it),
 * proposals, orders, invoices and cash, next actions and deal tasks that
 * slipped, and the things waiting on a decision.
 *
 * A week that has ended is written down once and never rewritten — it is what
 * was known at the time. The week in progress is worked out live and says so.
 * Customer outcomes and activity counts are kept in separate sections: a busy
 * week of emails is not the same thing as a week in which something moved.
 */

import { query } from '../db/pool.js';
import { dateIn } from './availability.js';

const TZ = 'Asia/Kolkata';
const num = (value) => (value === null || value === undefined ? null : Number(value));
const iso = (date) => date.toISOString().slice(0, 10);

/** Monday to Monday (India time) around a date, as YYYY-MM-DD; the end is exclusive. */
export function weekOf(day = dateIn(TZ)) {
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - back);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start: iso(start), end: iso(end) };
}

/** The week before the one containing `day`. */
export function previousWeek(day = dateIn(TZ)) {
  const { start } = weekOf(day);
  const before = new Date(`${start}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  return weekOf(iso(before));
}

/** The kinds of entry that are contact with a customer — effort — as opposed to record-keeping. */
export const TOUCH_TYPES = ['EMAIL', 'CALL', 'MEETING', 'DEMO', 'IN_PERSON', 'PPT', 'PROPOSAL', 'SUMMARY', 'NOTE'];

export const WEEK_DEFINITIONS = {
  stage_changes: 'Every stage move recorded in the week, forwards and back, with who moved it and why.',
  commitments: 'What customers said they would do: recorded this week, kept or missed this week, and still open and due by the end of it.',
  proposals: 'Proposals recorded with a sent date in the week.',
  orders: 'Accepted orders, purchase orders, contracts and MoUs received in the week — bookings, not money.',
  invoices: 'Invoices issued in the week and not cancelled — revenue billed, not cash.',
  payments: 'Money that arrived in the week, by the date it arrived; voided entries excluded.',
  missed_next_actions: 'Live deals whose next action was due before the week ended and has not been done or re-agreed.',
  missed_tasks: 'Deal tasks due in the week that were not finished by their deadline.',
  decisions: 'Open blockers, live deals past their expected close date, handovers nobody has confirmed, deals moved without evidence, and help asked for in weekly reviews.',
  activity_counts: 'How much was logged — effort, not outcomes. Shown apart so a busy week is not read as a productive one.',
};

const bounds = (start, end) => [`${start}T00:00:00+05:30`, `${end}T00:00:00+05:30`];

/**
 * Builds the week's record. `asOf` is when "now" is for things that are
 * judged as of a moment (what is overdue, what is still open).
 */
export async function buildWeek({ start, end, asOf = new Date() }) {
  const [from, to] = bounds(start, end);
  const asOfDay = dateIn(TZ, asOf) < end ? dateIn(TZ, asOf) : end;

  const [
    stageRows, made, resolved, dueOpen, proposals, orders, invoices, payments,
    missedActions, missedTasks, blockers, pastClose, handovers, noEvidence, help, counts,
  ] = await Promise.all([
    query(
      `SELECT h.opportunity_id, h.from_value, h.to_value, h.is_reversal, h.reason, h.evidence_missing,
              h.created_at, o.name, o.account_id, a.name AS account_name, u.full_name AS actor_name,
              ow.full_name AS owner_name
         FROM opportunity_history h
         JOIN opportunities o ON o.id = h.opportunity_id
         JOIN accounts a ON a.id = o.account_id
         LEFT JOIN users u ON u.id = h.actor_id
         LEFT JOIN users ow ON ow.id = o.owner_user_id
        WHERE h.field = 'stage' AND h.created_at >= $1 AND h.created_at < $2
        ORDER BY h.created_at`,
      [from, to],
    ),
    query(
      `SELECT c.*, a.name AS account_name, o.name AS opportunity_name
         FROM customer_commitments c JOIN accounts a ON a.id = c.account_id
         LEFT JOIN opportunities o ON o.id = c.opportunity_id
        WHERE c.created_at >= $1 AND c.created_at < $2 ORDER BY c.created_at`,
      [from, to],
    ),
    query(
      `SELECT c.*, a.name AS account_name, o.name AS opportunity_name
         FROM customer_commitments c JOIN accounts a ON a.id = c.account_id
         LEFT JOIN opportunities o ON o.id = c.opportunity_id
        WHERE c.status IN ('KEPT','MISSED') AND c.resolved_at >= $1 AND c.resolved_at < $2
        ORDER BY c.resolved_at`,
      [from, to],
    ),
    query(
      `SELECT c.*, a.name AS account_name, o.name AS opportunity_name
         FROM customer_commitments c JOIN accounts a ON a.id = c.account_id
         LEFT JOIN opportunities o ON o.id = c.opportunity_id
        WHERE c.status = 'OPEN' AND c.due_on < $1::date ORDER BY c.due_on`,
      [end],
    ),
    query(
      `SELECT p.id, p.title, p.sent_on, p.amount, p.status, p.opportunity_id, o.name, o.account_id,
              a.name AS account_name
         FROM opportunity_proposals p JOIN opportunities o ON o.id = p.opportunity_id
         JOIN accounts a ON a.id = o.account_id
        WHERE p.status <> 'WITHDRAWN' AND p.sent_on >= $1::date AND p.sent_on < $2::date
        ORDER BY p.sent_on`,
      [start, end],
    ),
    query(
      `SELECT r.id, r.kind, r.reference, r.received_on, r.amount, r.opportunity_id, o.name, o.account_id,
              a.name AS account_name
         FROM opportunity_orders r JOIN opportunities o ON o.id = r.opportunity_id
         JOIN accounts a ON a.id = o.account_id
        WHERE r.status = 'ACCEPTED' AND r.received_on >= $1::date AND r.received_on < $2::date
        ORDER BY r.received_on`,
      [start, end],
    ),
    query(
      `SELECT i.id, i.number, i.issued_on, i.amount, i.opportunity_id, o.name, o.account_id,
              a.name AS account_name
         FROM opportunity_invoices i JOIN opportunities o ON o.id = i.opportunity_id
         JOIN accounts a ON a.id = o.account_id
        WHERE i.status = 'ISSUED' AND i.issued_on >= $1::date AND i.issued_on < $2::date
        ORDER BY i.issued_on`,
      [start, end],
    ),
    query(
      `SELECT pm.id, pm.reference, pm.received_on, pm.amount, pm.opportunity_id, o.name, o.account_id,
              a.name AS account_name
         FROM opportunity_payments pm JOIN opportunities o ON o.id = pm.opportunity_id
         JOIN accounts a ON a.id = o.account_id
        WHERE pm.is_void = FALSE AND pm.received_on >= $1::date AND pm.received_on < $2::date
        ORDER BY pm.received_on`,
      [start, end],
    ),
    // a next action due before the week ended that nobody has done or re-agreed
    query(
      `SELECT o.id AS opportunity_id, o.name, o.account_id, a.name AS account_name, o.next_step,
              o.next_step_due, u.full_name AS owner_name
         FROM opportunities o JOIN accounts a ON a.id = o.account_id
         LEFT JOIN users u ON u.id = o.next_step_owner_id
        WHERE o.status = 'ACTIVE' AND o.is_archived = FALSE AND a.is_archived = FALSE
          AND o.waiting_on IS NULL
          AND o.next_step_due < LEAST($1::date, $2::date)
        ORDER BY o.next_step_due`,
      [end, asOfDay],
    ),
    query(
      `SELECT t.id, t.ref, t.title, t.due_date, t.completed_at, a.id AS account_id, a.name AS account_name,
              u.full_name AS assignee_name
         FROM tasks t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.is_archived = FALSE AND t.due_date >= $1 AND t.due_date < $2
          AND (t.completed_at IS NULL OR t.completed_at > t.due_date)
        ORDER BY t.due_date`,
      [from, to],
    ),
    query(
      `SELECT t.id, t.title, t.category, t.blocked_item, t.dependency, t.external_party,
              t.expected_resolution, t.created_at,
              COALESCE(o.account_id, CASE WHEN t.entity_type = 'ACCOUNT' THEN t.entity_id END) AS account_id,
              a.name AS account_name, o.name AS opportunity_name, u.full_name AS responsible_name
         FROM discussion_threads t
         LEFT JOIN opportunities o ON t.entity_type = 'OPPORTUNITY' AND o.id = t.entity_id
         JOIN accounts a ON a.id = COALESCE(o.account_id, CASE WHEN t.entity_type = 'ACCOUNT' THEN t.entity_id END)
         LEFT JOIN users u ON u.id = t.responsible_user_id
        WHERE t.kind = 'blocker' AND t.created_at < $1
          AND (t.status = 'open' OR t.resolved_at >= $1)
        ORDER BY t.expected_resolution NULLS LAST`,
      [to],
    ),
    query(
      `SELECT o.id AS opportunity_id, o.name, o.account_id, a.name AS account_name, o.expected_close,
              u.full_name AS owner_name
         FROM opportunities o JOIN accounts a ON a.id = o.account_id
         LEFT JOIN users u ON u.id = o.owner_user_id
        WHERE o.status = 'ACTIVE' AND o.is_archived = FALSE AND a.is_archived = FALSE
          AND o.expected_close < $1::date
        ORDER BY o.expected_close`,
      [end],
    ),
    query(
      `SELECT h.id, h.role, h.created_at, o.id AS opportunity_id, o.name, o.account_id,
              a.name AS account_name, t.full_name AS to_name
         FROM opportunity_handovers h JOIN opportunities o ON o.id = h.opportunity_id
         JOIN accounts a ON a.id = o.account_id
         LEFT JOIN users t ON t.id = h.to_user_id
        WHERE h.created_at < $1 AND (h.acknowledged_at IS NULL OR h.acknowledged_at >= $1)
          AND h.to_user_id IS NOT NULL AND h.to_user_id <> COALESCE(h.handed_by, 0)
        ORDER BY h.created_at`,
      [to],
    ),
    query(
      `SELECT h.opportunity_id, h.to_value, h.evidence_missing, h.reason, h.created_at, o.name,
              o.account_id, a.name AS account_name, u.full_name AS actor_name
         FROM opportunity_history h JOIN opportunities o ON o.id = h.opportunity_id
         JOIN accounts a ON a.id = o.account_id
         LEFT JOIN users u ON u.id = h.actor_id
        WHERE h.field = 'stage' AND h.evidence_missing IS NOT NULL
          AND h.created_at >= $1 AND h.created_at < $2`,
      [from, to],
    ),
    query(
      `SELECT i.help_needed, i.opportunity_id, o.name, o.account_id, u.full_name AS asked_by,
              hf.full_name AS help_from_name
         FROM weekly_review_items i
         JOIN weekly_reviews r ON r.id = i.review_id
         LEFT JOIN opportunities o ON o.id = i.opportunity_id
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN users hf ON hf.id = i.help_from_user_id
        WHERE r.week_start = $1::date AND r.status = 'SUBMITTED'
          AND NULLIF(TRIM(i.help_needed), '') IS NOT NULL`,
      [start],
    ),
    // touches only: orders, invoices, payments and proposals on the ledger are
    // outcomes, counted above, and never effort
    query(
      `SELECT type, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE direction = 'INBOUND' OR outcome = 'RECEIVED')::int AS inbound
         FROM account_activities
        WHERE occurred_at >= $1 AND occurred_at < $2 AND is_external = TRUE
          AND type = ANY($3::text[])
          AND NOT (type = 'PROPOSAL' AND meta ? 'proposal_id')
        GROUP BY type`,
      [from, to, TOUCH_TYPES],
    ),
  ]);

  const money = (rows) => rows.map((row) => ({ ...row, amount: num(row.amount) }));
  const total = (rows) => {
    const known = rows.filter((row) => row.amount !== null && row.amount !== undefined);
    return known.length ? known.reduce((sum, row) => sum + Number(row.amount), 0) : null;
  };

  const stageChanges = stageRows.rows.map((row) => ({
    ...row,
    direction: row.is_reversal ? 'back' : row.to_value === 'Lost' ? 'lost' : 'forward',
  }));
  const kept = resolved.rows.filter((c) => c.status === 'KEPT');
  const missed = resolved.rows.filter((c) => c.status === 'MISSED');
  const orderRows = money(orders.rows);
  const invoiceRows = money(invoices.rows);
  const paymentRows = money(payments.rows);
  const proposalRows = money(proposals.rows);
  const openBlockers = blockers.rows.map((b) => ({
    ...b,
    overdue: Boolean(b.expected_resolution) && String(b.expected_resolution).slice(0, 10) < asOfDay,
  }));

  return {
    week_start: start,
    week_end: end,
    as_of: asOf.toISOString(),
    definitions: WEEK_DEFINITIONS,
    summary: {
      stage_moves: stageChanges.length,
      moved_forward: stageChanges.filter((c) => c.direction === 'forward').length,
      moved_back: stageChanges.filter((c) => c.direction === 'back').length,
      commitments_made: made.rows.length,
      commitments_kept: kept.length,
      commitments_missed: missed.length,
      commitments_overdue: dueOpen.rows.length,
      proposals: proposalRows.length,
      proposals_value: total(proposalRows),
      orders: orderRows.length,
      booked: total(orderRows),
      invoiced: total(invoiceRows),
      cash_received: total(paymentRows),
      missed_next_actions: missedActions.rows.length,
      missed_tasks: missedTasks.rows.length,
      decisions: openBlockers.length + pastClose.rows.length + handovers.rows.length
        + noEvidence.rows.length + help.rows.length,
    },
    stage_changes: stageChanges,
    commitments: { made: made.rows, kept, missed, overdue: dueOpen.rows },
    proposals: proposalRows,
    orders: orderRows,
    invoices: invoiceRows,
    payments: paymentRows,
    missed: { next_actions: missedActions.rows, tasks: missedTasks.rows },
    decisions: {
      blockers: openBlockers,
      past_close: pastClose.rows,
      unconfirmed_handovers: handovers.rows,
      moved_without_evidence: noEvidence.rows,
      help_requested: help.rows,
    },
    activity_counts: Object.fromEntries(counts.rows.map((row) => [row.type, { logged: row.n, from_them: row.inbound }])),
  };
}

/** A stored week, or the week worked out now. A week still running is never stored. */
export async function getWeek(start) {
  const week = weekOf(start);
  const { rows } = await query('SELECT * FROM pipeline_snapshots WHERE week_start = $1', [week.start]);
  if (rows[0]) {
    return { ...rows[0].data, stored: true, generated_at: rows[0].generated_at, generated_by: rows[0].generated_by };
  }
  const data = await buildWeek(week);
  return { ...data, stored: false, running: week.end > dateIn(TZ) };
}

/**
 * Writes down a week that has ended — once. A second call returns the record
 * already made rather than replacing it.
 */
export async function storeWeek(start, { actorId = null } = {}) {
  const week = weekOf(start);
  if (week.end > dateIn(TZ)) return { stored: false, reason: 'The week has not ended yet' };
  const { rows: existing } = await query('SELECT id FROM pipeline_snapshots WHERE week_start = $1', [week.start]);
  if (existing[0]) return { stored: false, reason: 'already recorded', id: existing[0].id };
  const data = await buildWeek({ ...week, asOf: new Date(`${week.end}T00:00:00+05:30`) });
  const { rows } = await query(
    `INSERT INTO pipeline_snapshots (week_start, week_end, data, generated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (week_start) DO NOTHING
     RETURNING id`,
    [week.start, week.end, JSON.stringify(data), actorId],
  );
  return { stored: Boolean(rows[0]), id: rows[0]?.id ?? null, week };
}

export async function listWeeks() {
  const { rows } = await query(
    `SELECT id, week_start, week_end, generated_at, generated_by,
            data->'summary' AS summary
       FROM pipeline_snapshots ORDER BY week_start DESC LIMIT 104`,
  );
  return rows;
}
