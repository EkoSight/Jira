/**
 * The figures a lead is judged on, worked out once for every screen.
 *
 * The board, the map and the state-wise view all need the same three answers
 * about a lead: what are its open deals worth, is anybody actually talking to
 * them, and is it worth much. Each answer is derived here and never stored, and
 * each carries the rule it was derived by, so "lower potential" or "inactive" is
 * always a stated definition and never a mood.
 *
 * Money follows the opportunity engine's rules exactly: one eligible value per
 * deal, non-commercial work counts for nothing, and a deal with no value is
 * reported as having none — not as ₹0.
 */

import { query } from '../db/pool.js';
import { eligibleValue } from './opportunities.js';
import { getSettings } from './settings.js';

const DAY = 86_400_000;

export const FOLLOW_UP_DEFAULTS = {
  // spoken to inside this many days, with a deal open: active
  activeWithinDays: 30,
  // the tiers of what a lead is worth, in rupees
  lowPotentialBelow: 500000,
  highPotentialFrom: 2500000,
};

export async function followUpRules() {
  const settings = await getSettings();
  return { ...FOLLOW_UP_DEFAULTS, ...(settings.crm?.followUp || {}) };
}

/** The definitions, in words, shipped with every classification. */
export function describeRules(rules) {
  const lakh = (n) => `₹${(n / 100000).toLocaleString('en-IN', { maximumFractionDigits: 1 })} lakh`;
  return {
    activity: {
      active: `Has an open deal and somebody spoke to them in the last ${rules.activeWithinDays} days.`,
      inactive: `Has an open deal, but nobody has spoken to them in ${rules.activeWithinDays} days — or ever.`,
      paused: 'No open deal: everything is on hold or being nurtured.',
      closed: 'Every deal is won or lost.',
    },
    potential: {
      high: `Worth ${lakh(rules.highPotentialFrom)} or more.`,
      medium: `Worth between ${lakh(rules.lowPotentialBelow)} and ${lakh(rules.highPotentialFrom)}.`,
      low: `Worth less than ${lakh(rules.lowPotentialBelow)}.`,
      unknown: 'No value recorded on any open deal, and no relationship estimate. Not the same as low.',
    },
    potential_basis:
      'The larger of the eligible value of its open deals and the relationship-potential estimate on the lead.',
  };
}

export function potentialTier(amount, rules) {
  if (amount === null || amount === undefined) return 'unknown';
  if (amount >= rules.highPotentialFrom) return 'high';
  if (amount < rules.lowPotentialBelow) return 'low';
  return 'medium';
}

/**
 * Deal figures and open blockers for a set of leads, in two queries.
 * Returns a Map keyed by account id.
 */
export async function leadFigures(accountIds, { now = Date.now(), rules } = {}) {
  const figures = new Map();
  if (!accountIds.length) return figures;
  const applied = rules || (await followUpRules());

  const [{ rows: deals }, { rows: accounts }, { rows: blockers }] = await Promise.all([
    query(
      `SELECT o.id, o.account_id, o.status, o.engagement_model, o.value_unknown,
              o.estimated_value, o.proposed_value, o.agreed_value
         FROM opportunities o
        WHERE o.account_id = ANY($1::int[]) AND o.is_archived = FALSE`,
      [accountIds],
    ),
    query(
      `SELECT id, last_external_at, relationship_potential FROM accounts WHERE id = ANY($1::int[])`,
      [accountIds],
    ),
    query(
      `SELECT COALESCE(o.account_id, t.entity_id) AS account_id, COUNT(*)::int AS open_blockers
         FROM discussion_threads t
         LEFT JOIN opportunities o ON t.entity_type = 'OPPORTUNITY' AND o.id = t.entity_id
        WHERE t.kind = 'blocker' AND t.status = 'open'
          AND ((t.entity_type = 'ACCOUNT' AND t.entity_id = ANY($1::int[]))
            OR (t.entity_type = 'OPPORTUNITY' AND o.account_id = ANY($1::int[])))
        GROUP BY 1`,
      [accountIds],
    ),
  ]);

  const blockerCount = new Map(blockers.map((b) => [b.account_id, b.open_blockers]));

  for (const account of accounts) {
    const own = deals.filter((d) => d.account_id === account.id);
    const open = own.filter((d) => d.status === 'ACTIVE');
    const parked = own.filter((d) => d.status === 'ON_HOLD' || d.status === 'NURTURE');

    let eligible = null;
    let withoutValue = 0;
    let nonCommercial = 0;
    for (const deal of open) {
      const value = eligibleValue(deal);
      if (value.amount !== null) eligible = (eligible ?? 0) + value.amount;
      else if (value.basis === 'non_commercial') nonCommercial += 1;
      else if (value.basis === 'none') withoutValue += 1;
    }

    const lastSpoken = account.last_external_at ? new Date(account.last_external_at).getTime() : null;
    const quietDays = lastSpoken === null ? null : Math.floor((now - lastSpoken) / DAY);

    let activity;
    if (open.length) {
      activity = quietDays !== null && quietDays <= applied.activeWithinDays ? 'active' : 'inactive';
    } else if (parked.length) {
      activity = 'paused';
    } else {
      activity = 'closed';
    }

    const estimate = account.relationship_potential === null
      ? null : Number(account.relationship_potential);
    const potentialAmount = eligible === null && estimate === null
      ? null : Math.max(eligible ?? 0, estimate ?? 0);

    figures.set(account.id, {
      open_deals: open.length,
      eligible_value: eligible,
      deals_without_value: withoutValue,
      non_commercial_deals: nonCommercial,
      days_since_spoken: quietDays,
      activity,
      potential: potentialTier(potentialAmount, applied),
      potential_amount: potentialAmount,
      open_blockers: blockerCount.get(account.id) || 0,
    });
  }

  return figures;
}
