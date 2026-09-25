import { query } from '../db/pool.js';
import { getSettings } from './settings.js';
import { listAccounts } from './crm.js';

/**
 * The CRM attention engine — the same idea as the Goals one, pointed at deals.
 *
 * It answers, from data that already exists, the two questions that decide
 * whether a pipeline is alive: is every lead moving a step, and is every lead
 * still being engaged. Everything is derived from stage_changed_at and
 * last_activity_at, so it is always current.
 */

export const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

/** The single most important thing wrong with one open account, or nothing. */
function accountSignal(account, cadence, now) {
  // only live leads are chased; a won, lost or paused deal is not "stuck"
  if (!account.is_open || account.type !== 'LEAD') return null;

  const base = {
    account_id: account.id,
    title: account.name,
    owner_user_id: account.owner_user_id,
    owner_name: account.owner_name,
    owner_color: account.owner_color,
    follower_user_id: account.follower_user_id,
    department_id: account.department_id,
    department_name: account.department_name,
    stage_name: account.stage_name,
    days_since_activity: account.days_since_activity,
    days_since_stage_change: account.days_since_stage_change,
  };

  if (account.next_step_overdue) {
    return { ...base, kind: 'account_next_step_overdue', severity: 'warning', detail: `next step "${account.next_step}" is overdue` };
  }

  const cold = account.days_since_activity === null || account.days_since_activity >= cadence.engagementDays;
  const stuck = account.days_since_stage_change !== null && account.days_since_stage_change >= cadence.stageStaleDays;

  // hasn't moved a stage AND has gone quiet — the deal is drifting
  if (stuck && cold) {
    const days = account.days_since_stage_change;
    return {
      ...base,
      kind: 'account_stalled',
      severity: 'critical',
      detail:
        account.days_since_activity === null
          ? `hasn't moved in ${days} days and has never been worked`
          : `hasn't moved in ${days} days and no contact for ${account.days_since_activity}`,
    };
  }
  // still in the same stage but recently touched — just needs a push
  if (cold) {
    return {
      ...base,
      kind: 'account_cold',
      severity: 'warning',
      detail:
        account.days_since_activity === null
          ? 'has never been contacted'
          : `no contact in ${account.days_since_activity} days`,
    };
  }
  // being worked, but with no agreed next step nobody knows what happens next
  if (!account.next_step) {
    return { ...base, kind: 'account_no_next_step', severity: 'warning', detail: 'has no agreed next step' };
  }
  return null;
}

export async function analyseAccounts(filters = {}) {
  const settings = await getSettings();
  const cadence = settings.crm?.cadence || {};
  const now = Date.now();

  const accounts = await listAccounts({ ...filters, status: 'ACTIVE' });
  const open = accounts.filter((a) => a.is_open && a.type === 'LEAD');

  const signals = [];
  for (const account of open) {
    const signal = accountSignal(account, cadence, now);
    if (signal) signals.push(signal);
  }

  signals.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
      || (b.days_since_stage_change ?? 0) - (a.days_since_stage_change ?? 0),
  );

  // who is leading deals that are drifting
  const people = new Map();
  for (const signal of signals) {
    if (!signal.owner_user_id) continue;
    const entry = people.get(signal.owner_user_id) || {
      user_id: signal.owner_user_id, name: signal.owner_name, color: signal.owner_color,
      stalled: 0, cold: 0, total: 0,
    };
    entry.total += 1;
    if (signal.kind === 'account_stalled') entry.stalled += 1;
    if (signal.kind === 'account_cold' || signal.kind === 'account_next_step_overdue') entry.cold += 1;
    people.set(signal.owner_user_id, entry);
  }

  const count = (predicate) => signals.filter(predicate).length;

  return {
    summary: {
      open_leads: open.length,
      total_signals: signals.length,
      stalled: count((s) => s.kind === 'account_stalled'),
      cold: count((s) => s.kind === 'account_cold'),
      no_next_step: count((s) => s.kind === 'account_no_next_step'),
      overdue_next_step: count((s) => s.kind === 'account_next_step_overdue'),
      pipeline_value: open.reduce((sum, a) => sum + (Number(a.value) || 0), 0),
    },
    attention: signals,
    by_person: [...people.values()].sort((a, b) => b.stalled - a.stalled || b.total - a.total),
  };
}

// ------------------------------------------------- the wider set of signals
//
// The same engine, extended to everything else that goes quiet: meetings that
// happened with nothing recorded, deals approaching a close date with must-haves
// still open, and delivery milestones past their date. Every one is derived from
// stored data, so a signal cannot be stale.

/** How long a deal at this stage may sit before it counts as gone quiet. */
export function cadenceFor(stageSlug, cadence, status) {
  if (status === 'ON_HOLD' || status === 'NURTURE') return Number(cadence.nurtureDays) || 45;
  const byStage = cadence.byStage || {};
  return Number(byStage[stageSlug]) ?? Number(cadence.engagementDays) ?? 7;
}

/** Signals a person has put down, with a reason and an expiry. */
async function activeSnoozes() {
  const { rows } = await query(
    `SELECT entity_type, entity_id, kind FROM crm_nudge_snoozes WHERE until > now()`,
  );
  const set = new Set();
  for (const row of rows) {
    set.add(`${row.entity_type}:${row.entity_id}:${row.kind ?? '*'}`);
  }
  return set;
}

const isSnoozed = (snoozes, entityType, entityId, kind) =>
  snoozes.has(`${entityType}:${entityId}:*`) || snoozes.has(`${entityType}:${entityId}:${kind}`);

/**
 * Everything currently worth somebody's attention across the B2B module.
 *
 * Opportunity-level rather than account-level: a relationship with one healthy
 * deal and one drifting deal should show the drifting one, not an average.
 */
export async function analysePipeline({ departmentId = null } = {}) {
  const settings = await getSettings();
  const cadence = settings.crm?.cadence || {};
  const snoozes = await activeSnoozes();
  const now = Date.now();
  const DAY = 86_400_000;

  const signals = [];
  const push = (signal) => {
    if (isSnoozed(snoozes, signal.entity_type, signal.entity_id, signal.kind)) return;
    signals.push(signal);
  };

  // ---- deals
  const { rows: deals } = await query(
    `SELECT o.id, o.name, o.status, o.next_step, o.next_step_due, o.expected_close,
            o.last_external_at, o.stage_changed_at, o.owner_user_id,
            a.id AS account_id, a.name AS account_name, a.department_id,
            s.slug AS stage_slug, s.name AS stage_name, s.position AS stage_position,
            u.full_name AS owner_name, u.avatar_color AS owner_color,
            (SELECT COUNT(*)::int FROM opportunity_requirements r
              WHERE r.opportunity_id = o.id AND r.importance = 'MUST_HAVE'
                AND r.status NOT IN ('MET','WAIVED')) AS unmet_must_haves
       FROM opportunities o
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN account_stages s ON s.id = o.stage_id
       LEFT JOIN users u ON u.id = o.owner_user_id
      WHERE o.is_archived = FALSE AND a.is_archived = FALSE
        AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')
        AND ($1::int IS NULL OR a.department_id = $1::int)`,
    [departmentId],
  );

  for (const deal of deals) {
    const base = {
      entity_type: 'OPPORTUNITY',
      entity_id: deal.id,
      account_id: deal.account_id,
      title: deal.name,
      subtitle: deal.account_name,
      owner_user_id: deal.owner_user_id,
      owner_name: deal.owner_name,
      owner_color: deal.owner_color,
      department_id: deal.department_id,
      stage_name: deal.stage_name,
    };

    const quietDays = deal.last_external_at
      ? Math.floor((now - new Date(deal.last_external_at).getTime()) / DAY)
      : null;
    const allowed = cadenceFor(deal.stage_slug, cadence, deal.status);

    if (deal.next_step_due && new Date(deal.next_step_due).getTime() < now && deal.status === 'ACTIVE') {
      push({ ...base, kind: 'next_action_overdue', severity: 'warning',
        detail: `next action "${deal.next_step}" is past its date` });
    } else if (quietDays === null || quietDays >= allowed) {
      push({ ...base, kind: 'gone_quiet', severity: quietDays === null ? 'critical' : 'warning',
        detail: quietDays === null
          ? 'nobody has spoken to them yet'
          : `no contact for ${quietDays} days, and ${deal.stage_name || 'this stage'} expects every ${allowed}` });
    } else if (!deal.next_step && (deal.stage_position ?? 0) >= 3 && deal.status === 'ACTIVE') {
      push({ ...base, kind: 'no_next_action', severity: 'warning',
        detail: 'qualified, but nothing agreed as the next step' });
    }

    // a close date coming up with must-haves unresolved is the expensive one
    const closingIn = deal.expected_close
      ? Math.floor((new Date(deal.expected_close).getTime() - now) / DAY)
      : null;
    if (deal.status === 'ACTIVE' && closingIn !== null
        && closingIn <= (Number(cadence.closingSoonDays) || 21)
        && deal.unmet_must_haves > 0) {
      push({ ...base, kind: 'closing_with_blockers', severity: 'critical',
        detail: closingIn < 0
          ? `close date passed with ${deal.unmet_must_haves} must-have${deal.unmet_must_haves === 1 ? '' : 's'} unresolved`
          : `closes in ${closingIn} days with ${deal.unmet_must_haves} must-have${deal.unmet_must_haves === 1 ? '' : 's'} unresolved` });
    }
  }

  // ---- meetings that have been and gone with nothing recorded
  const graceHours = Number(cadence.meetingOutcomeHours) || 24;
  const { rows: meetings } = await query(
    `SELECT m.id, m.title, m.kind, m.scheduled_at, m.owner_user_id, m.account_id,
            a.name AS account_name, a.department_id,
            u.full_name AS owner_name, u.avatar_color AS owner_color
       FROM crm_meetings m
       JOIN accounts a ON a.id = m.account_id
       LEFT JOIN users u ON u.id = m.owner_user_id
      WHERE m.status = 'SCHEDULED'
        AND m.scheduled_at < now() - ($1 || ' hours')::interval
        AND ($2::int IS NULL OR a.department_id = $2::int)`,
    [graceHours, departmentId],
  );
  for (const meeting of meetings) {
    push({
      entity_type: 'MEETING', entity_id: meeting.id, account_id: meeting.account_id,
      title: meeting.title, subtitle: meeting.account_name,
      owner_user_id: meeting.owner_user_id, owner_name: meeting.owner_name,
      owner_color: meeting.owner_color, department_id: meeting.department_id,
      kind: 'meeting_outcome_missing', severity: 'warning',
      detail: `this ${meeting.kind.toLowerCase()} has been and gone with no outcome recorded`,
    });
  }

  // ---- delivery milestones past their date
  const grace = Number(cadence.milestoneGraceDays) || 2;
  const { rows: milestones } = await query(
    `SELECT m.id, m.title, m.due_date, e.id AS engagement_id, e.name AS engagement_name,
            e.owner_user_id, e.account_id, a.name AS account_name, a.department_id,
            u.full_name AS owner_name, u.avatar_color AS owner_color
       FROM engagement_milestones m
       JOIN engagements e ON e.id = m.engagement_id
       JOIN accounts a ON a.id = e.account_id
       LEFT JOIN users u ON u.id = e.owner_user_id
      WHERE e.is_archived = FALSE AND m.status NOT IN ('ACCEPTED')
        AND m.due_date < CURRENT_DATE - ($1 || ' days')::interval
        AND ($2::int IS NULL OR a.department_id = $2::int)`,
    [grace, departmentId],
  );
  for (const milestone of milestones) {
    push({
      entity_type: 'ENGAGEMENT', entity_id: milestone.engagement_id,
      account_id: milestone.account_id,
      title: milestone.title, subtitle: `${milestone.account_name} · ${milestone.engagement_name}`,
      owner_user_id: milestone.owner_user_id, owner_name: milestone.owner_name,
      owner_color: milestone.owner_color, department_id: milestone.department_id,
      kind: 'milestone_overdue', severity: 'warning',
      detail: 'a delivery milestone is past its date and not accepted',
    });
  }

  signals.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const byOwner = new Map();
  for (const signal of signals) {
    if (!signal.owner_user_id) continue;
    const entry = byOwner.get(signal.owner_user_id) || {
      user_id: signal.owner_user_id, name: signal.owner_name,
      color: signal.owner_color, total: 0, critical: 0,
    };
    entry.total += 1;
    if (signal.severity === 'critical') entry.critical += 1;
    byOwner.set(signal.owner_user_id, entry);
  }

  const count = (kind) => signals.filter((s) => s.kind === kind).length;

  return {
    summary: {
      total: signals.length,
      gone_quiet: count('gone_quiet'),
      next_action_overdue: count('next_action_overdue'),
      no_next_action: count('no_next_action'),
      closing_with_blockers: count('closing_with_blockers'),
      meeting_outcome_missing: count('meeting_outcome_missing'),
      milestone_overdue: count('milestone_overdue'),
    },
    attention: signals,
    by_person: [...byOwner.values()].sort((a, b) => b.critical - a.critical || b.total - a.total),
  };
}
