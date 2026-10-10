/**
 * The weekly review: each owner says, deal by deal, what changed, the evidence
 * for it, the next milestone, and any help they need.
 *
 * Outcomes and effort are kept apart. Beside each deal the review shows what
 * the record says moved (a stage, a proposal, an order, money, a customer
 * commitment kept) and, separately and smaller, how much was logged. A week of
 * twenty emails with nothing moved should read as exactly that.
 */

import { query, withTransaction } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { assertSafeUrl } from '../lib/uploads.js';
import { notify } from './activity.js';
import { TOUCH_TYPES, weekOf } from './weekly.js';

const bounds = (week) => [`${week.start}T00:00:00+05:30`, `${week.end}T00:00:00+05:30`];

/** The deals a person answers for in a week: those they own or owe the next move on. */
async function dealsFor(userId, week) {
  const { rows } = await query(
    `SELECT o.id, o.name, o.status, o.account_id, a.name AS account_name, o.next_step, o.next_step_due,
            s.name AS stage_name, s.color AS stage_color
       FROM opportunities o
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN account_stages s ON s.id = o.stage_id
      WHERE o.is_archived = FALSE AND a.is_archived = FALSE
        AND (o.owner_user_id = $1 OR o.next_step_owner_id = $1)
        AND (o.status IN ('ACTIVE','ON_HOLD','NURTURE') OR o.closed_at >= $2)
      ORDER BY a.name, o.name`,
    [userId, `${week.start}T00:00:00+05:30`],
  );
  return rows;
}

/** What the record shows moved on these deals in the week — the outcomes. */
async function outcomesFor(dealIds, week) {
  const byDeal = new Map(dealIds.map((id) => [id, []]));
  if (!dealIds.length) return byDeal;
  const [from, to] = bounds(week);
  const add = (id, entry) => byDeal.get(id)?.push(entry);

  const [stages, proposals, orders, payments, commitments, responses] = await Promise.all([
    query(`SELECT opportunity_id, from_value, to_value, is_reversal, created_at FROM opportunity_history
            WHERE field = 'stage' AND opportunity_id = ANY($1::int[]) AND created_at >= $2 AND created_at < $3`,
    [dealIds, from, to]),
    query(`SELECT opportunity_id, title, amount, sent_on FROM opportunity_proposals
            WHERE status <> 'WITHDRAWN' AND opportunity_id = ANY($1::int[])
              AND sent_on >= $2::date AND sent_on < $3::date`, [dealIds, week.start, week.end]),
    query(`SELECT opportunity_id, reference, amount, received_on FROM opportunity_orders
            WHERE status = 'ACCEPTED' AND opportunity_id = ANY($1::int[])
              AND received_on >= $2::date AND received_on < $3::date`, [dealIds, week.start, week.end]),
    query(`SELECT opportunity_id, amount, received_on FROM opportunity_payments
            WHERE is_void = FALSE AND opportunity_id = ANY($1::int[])
              AND received_on >= $2::date AND received_on < $3::date`, [dealIds, week.start, week.end]),
    query(`SELECT opportunity_id, what, status, resolved_at, created_at FROM customer_commitments
            WHERE opportunity_id = ANY($1::int[])
              AND ((created_at >= $2 AND created_at < $3) OR (resolved_at >= $2 AND resolved_at < $3))`,
    [dealIds, from, to]),
    // hearing from them by email, call or meeting; an order or payment is its own outcome above
    query(`SELECT opportunity_id, COUNT(*)::int AS n, MAX(occurred_at) AS last_at FROM account_activities
            WHERE opportunity_id = ANY($1::int[]) AND occurred_at >= $2 AND occurred_at < $3
              AND is_external = TRUE AND type = ANY($4::text[])
              AND (direction = 'INBOUND' OR outcome = 'RECEIVED'
                   OR (outcome = 'COMPLETED' AND type IN ('CALL','MEETING','DEMO','IN_PERSON')))
            GROUP BY opportunity_id`, [dealIds, from, to, TOUCH_TYPES]),
  ]);

  for (const row of stages.rows) {
    add(row.opportunity_id, { kind: 'stage', text: `${row.is_reversal ? 'Moved back' : 'Moved'} ${row.from_value ?? ''} → ${row.to_value}`, at: row.created_at });
  }
  for (const row of proposals.rows) add(row.opportunity_id, { kind: 'proposal', text: `Proposal sent${row.title ? `: ${row.title}` : ''}`, amount: row.amount === null ? null : Number(row.amount), at: row.sent_on });
  for (const row of orders.rows) add(row.opportunity_id, { kind: 'order', text: `Order received${row.reference ? ` (${row.reference})` : ''}`, amount: row.amount === null ? null : Number(row.amount), at: row.received_on });
  for (const row of payments.rows) add(row.opportunity_id, { kind: 'payment', text: 'Payment received', amount: Number(row.amount), at: row.received_on });
  for (const row of commitments.rows) {
    const resolvedInWeek = row.resolved_at && new Date(row.resolved_at) >= new Date(from);
    add(row.opportunity_id, {
      kind: 'commitment',
      text: resolvedInWeek ? `They ${row.status === 'KEPT' ? 'kept' : row.status === 'MISSED' ? 'missed' : 'withdrew'}: ${row.what}` : `They committed to: ${row.what}`,
      at: resolvedInWeek ? row.resolved_at : row.created_at,
    });
  }
  for (const row of responses.rows) {
    add(row.opportunity_id, { kind: 'response', text: `Heard from them ${row.n === 1 ? 'once' : `${row.n} times`}`, at: row.last_at });
  }
  return byDeal;
}

/** What was logged on these deals in the week by this person — effort, shown apart. */
async function activityFor(userId, dealIds, week) {
  const byDeal = new Map(dealIds.map((id) => [id, {}]));
  if (!dealIds.length) return byDeal;
  const [from, to] = bounds(week);
  const { rows } = await query(
    `SELECT opportunity_id, type, COUNT(*)::int AS n FROM account_activities
      WHERE actor_id = $1 AND opportunity_id = ANY($2::int[]) AND occurred_at >= $3 AND occurred_at < $4
        AND type IN ('EMAIL','CALL','MEETING','DEMO','IN_PERSON','PPT','PROPOSAL','NOTE','SUMMARY')
      GROUP BY opportunity_id, type`,
    [userId, dealIds, from, to],
  );
  for (const row of rows) byDeal.get(row.opportunity_id)[row.type] = row.n;
  return byDeal;
}

/** One person's review for a week: their deals, what the record shows, what they wrote. */
export async function reviewFor(userId, day) {
  const week = weekOf(day);
  const deals = await dealsFor(userId, week);
  const ids = deals.map((d) => d.id);
  const [outcomes, activity, reviewRows] = await Promise.all([
    outcomesFor(ids, week),
    activityFor(userId, ids, week),
    query('SELECT * FROM weekly_reviews WHERE user_id = $1 AND week_start = $2', [userId, week.start]),
  ]);
  const review = reviewRows.rows[0] || null;
  const { rows: items } = review
    ? await query(
      `SELECT i.*, u.full_name AS help_from_name FROM weekly_review_items i
         LEFT JOIN users u ON u.id = i.help_from_user_id WHERE i.review_id = $1`,
      [review.id],
    )
    : { rows: [] };
  const itemFor = new Map(items.map((i) => [i.opportunity_id, i]));

  return {
    week,
    review: review
      ? { id: review.id, status: review.status, summary: review.summary, submitted_at: review.submitted_at }
      : { id: null, status: 'NOT_STARTED', summary: null, submitted_at: null },
    deals: deals.map((deal) => ({
      ...deal,
      outcomes: outcomes.get(deal.id) || [],
      activity: activity.get(deal.id) || {},
      item: itemFor.get(deal.id) || null,
    })),
  };
}

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10));

/** Saves one deal's part of the review, starting the review if needed. */
export async function saveReviewItem(userId, day, opportunityId, fields) {
  const week = weekOf(day);
  const deals = await dealsFor(userId, week);
  if (!deals.some((d) => d.id === opportunityId)) throw badRequest('That deal is not one of yours this week');
  if (fields.evidence_url) assertSafeUrl(String(fields.evidence_url).trim());
  if (fields.next_milestone_due && !isDay(String(fields.next_milestone_due))) throw badRequest('The milestone date is not a date');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO weekly_reviews (user_id, week_start) VALUES ($1, $2)
       ON CONFLICT (user_id, week_start) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [userId, week.start],
    );
    const review = rows[0];
    if (review.status === 'SUBMITTED') throw badRequest('This week\'s review was already sent');
    const { rows: item } = await client.query(
      `INSERT INTO weekly_review_items
         (review_id, opportunity_id, what_changed, no_change, evidence_url, next_milestone,
          next_milestone_due, help_needed, help_from_user_id)
       VALUES ($1,$2,$3,COALESCE($4,FALSE),$5,$6,$7::date,$8,$9)
       ON CONFLICT (review_id, opportunity_id) DO UPDATE SET
         what_changed = EXCLUDED.what_changed, no_change = EXCLUDED.no_change,
         evidence_url = EXCLUDED.evidence_url, next_milestone = EXCLUDED.next_milestone,
         next_milestone_due = EXCLUDED.next_milestone_due, help_needed = EXCLUDED.help_needed,
         help_from_user_id = EXCLUDED.help_from_user_id, updated_at = now()
       RETURNING *`,
      [
        review.id, opportunityId, fields.what_changed?.trim() || null, fields.no_change ?? false,
        fields.evidence_url?.trim() || null, fields.next_milestone?.trim() || null,
        fields.next_milestone_due || null, fields.help_needed?.trim() || null, fields.help_from_user_id ?? null,
      ],
    );
    return item[0];
  });
}

/**
 * Sends the review. Every deal still live needs what changed (or a plain "no
 * change"), and the next milestone with a date. Anyone asked for help is told.
 */
export async function submitReview(user, day, summary = null) {
  const current = await reviewFor(user.id, day);
  const missing = [];
  for (const deal of current.deals) {
    if (!['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(deal.status)) continue;
    const item = deal.item;
    if (!item || (!item.no_change && !(item.what_changed && item.what_changed.length >= 3))) {
      missing.push({ opportunity_id: deal.id, name: deal.name, missing: 'what changed' });
    } else if (!item.next_milestone || !item.next_milestone_due) {
      missing.push({ opportunity_id: deal.id, name: deal.name, missing: 'the next milestone and its date' });
    }
  }
  if (missing.length) {
    throw badRequest(
      `Say what changed and the next milestone for every live deal first — ${missing.map((m) => m.name).join(', ')}`,
      { code: 'REVIEW_INCOMPLETE', missing },
    );
  }

  const week = current.week;
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO weekly_reviews (user_id, week_start, status, summary, submitted_at)
       VALUES ($1, $2, 'SUBMITTED', $3, now())
       ON CONFLICT (user_id, week_start) DO UPDATE
         SET status = 'SUBMITTED', summary = EXCLUDED.summary, submitted_at = now(), updated_at = now()
       WHERE weekly_reviews.status <> 'SUBMITTED'
       RETURNING id`,
      [user.id, week.start, summary?.trim() || null],
    );
    if (!rows[0]) throw badRequest('This week\'s review was already sent');
    for (const deal of current.deals) {
      const item = deal.item;
      if (!item?.help_needed || !item.help_from_user_id || item.help_from_user_id === user.id) continue;
      await notify(client, {
        userId: item.help_from_user_id,
        type: 'crm_help',
        title: `${user.full_name} asked for your help on ${deal.name}`,
        body: item.help_needed,
        accountId: deal.account_id,
      });
    }
  });
  return reviewFor(user.id, day);
}

/** Everyone's reviews for a week: who has sent one, what they said, and help asked for. */
export async function teamReviews(day, { departmentId = null } = {}) {
  const week = weekOf(day);
  const { rows: people } = await query(
    `SELECT DISTINCT u.id, u.full_name, u.avatar_color, u.department_id
       FROM users u
       JOIN opportunities o ON (o.owner_user_id = u.id OR o.next_step_owner_id = u.id)
       JOIN accounts a ON a.id = o.account_id
      WHERE u.is_active = TRUE AND o.is_archived = FALSE AND a.is_archived = FALSE
        AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')
        AND ($1::int IS NULL OR u.department_id = $1::int)
      ORDER BY u.full_name`,
    [departmentId],
  );
  const reviews = [];
  for (const person of people) {
    const review = await reviewFor(person.id, week.start);
    // a review is theirs until they send it: the record is shown, their words are not
    const sent = review.review.status === 'SUBMITTED';
    reviews.push({
      user: person,
      ...review,
      deals: review.deals.map((deal) => ({ ...deal, item: sent ? deal.item : null })),
    });
  }
  return {
    week,
    sent: reviews.filter((r) => r.review.status === 'SUBMITTED').length,
    waiting: reviews.filter((r) => r.review.status !== 'SUBMITTED').map((r) => r.user),
    reviews,
    help_requested: reviews.flatMap((r) => r.deals
      .filter((d) => d.item?.help_needed && r.review.status === 'SUBMITTED')
      .map((d) => ({ from: r.user.full_name, deal: d.name, account_name: d.account_name,
        help: d.item.help_needed, help_from_name: d.item.help_from_name }))),
  };
}
