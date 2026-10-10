import { query } from '../db/pool.js';
import { getSettings } from './settings.js';
import { listAccounts, logosFor } from './crm.js';
import { nextActionGaps, today } from './dealRules.js';
import { FRESHNESS_COLUMNS } from './opportunities.js';

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
  // Number(undefined) is NaN, which `??` does not catch: a stage with no figure
  // of its own (any stage an admin added) used to get NaN, and "quiet for NaN
  // days" is never true — so those deals could never be flagged as gone quiet
  const own = Number(byStage[stageSlug]);
  if (Number.isFinite(own) && own > 0) return own;
  const general = Number(cadence.engagementDays);
  return Number.isFinite(general) && general > 0 ? general : 7;
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
    `SELECT o.id, o.name, o.status, o.next_step, o.next_step_due, o.next_step_owner_id,
            o.expected_close, o.stage_changed_at, o.owner_user_id, o.created_at,
            o.waiting_on, o.waiting_until, o.waiting_reason, o.revisit_on, o.outcome_reason,
            a.id AS account_id, a.name AS account_name, a.department_id,
            s.slug AS stage_slug, s.name AS stage_name, s.position AS stage_position,
            s.kind AS stage_kind, s.quiet_after_days,
            u.full_name AS owner_name, u.avatar_color AS owner_color,
            (SELECT COUNT(*)::int FROM opportunity_requirements r
              WHERE r.opportunity_id = o.id AND r.importance = 'MUST_HAVE'
                AND r.status NOT IN ('MET','WAIVED')) AS unmet_must_haves,
            ${FRESHNESS_COLUMNS}
       FROM opportunities o
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN account_stages s ON s.id = o.stage_id
       LEFT JOIN users u ON u.id = o.owner_user_id
      WHERE o.is_archived = FALSE AND a.is_archived = FALSE
        AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')
        AND ($1::int IS NULL OR a.department_id = $1::int)`,
    [departmentId],
  );

  const todayDate = today();
  const daysAgo = (value) => (value ? Math.floor((now - new Date(value).getTime()) / DAY) : null);
  const dayOf = (value) => (value ? String(value).slice(0, 10) : null);

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

    // Paused on purpose, with a date: silent until the date, then one
    // reminder to look again — never a daily "gone quiet".
    if (deal.status === 'ON_HOLD' || deal.status === 'NURTURE') {
      const revisit = dayOf(deal.revisit_on);
      if (revisit) {
        if (revisit <= todayDate) {
          push({ ...base, kind: 'revisit_due', severity: 'warning',
            detail: `${deal.status === 'NURTURE' ? 'nurtured' : 'on hold'} until ${revisit}${deal.outcome_reason ? ` (${deal.outcome_reason})` : ''} — time to look again` });
        }
        continue;
      }
      // paused before revisit dates were asked for: the old, slower cadence
      const quiet = daysAgo(deal.last_customer_at ?? deal.last_outbound_at);
      const allowed = cadenceFor(deal.stage_slug, cadence, deal.status);
      if (quiet === null || quiet >= allowed) {
        push({ ...base, kind: 'gone_quiet', severity: 'warning',
          detail: `paused with no date to look again, and no contact for ${quiet ?? 'ever'} days` });
      }
      continue;
    }
    if (deal.waiting_on) {
      const until = dayOf(deal.waiting_until);
      if (until && until <= todayDate) {
        push({ ...base, kind: 'revisit_due', severity: 'warning',
          detail: `waiting on ${deal.waiting_on === 'CUSTOMER' ? 'the customer' : deal.waiting_on === 'THIRD_PARTY' ? 'a third party' : 'us'} (${deal.waiting_reason}) — the date to check back was ${until}` });
      }
      continue;
    }

    // live and not paused: every live deal owes a next move, and the customer
    // has to be engaging at the pace its stage expects
    const gaps = nextActionGaps(deal);
    const allowed = deal.quiet_after_days || cadenceFor(deal.stage_slug, cadence, deal.status);
    const customerDays = daysAgo(deal.last_customer_at);
    const outboundDays = daysAgo(deal.last_outbound_at);
    const ageDays = daysAgo(deal.created_at) ?? 0;
    const silent = customerDays === null ? ageDays >= allowed : customerDays >= allowed;

    if (gaps.some((gap) => gap.kind === 'next_action_overdue')) {
      push({ ...base, kind: 'next_action_overdue', severity: 'warning',
        detail: `next action "${deal.next_step}" is past its date` });
    } else if (silent && outboundDays !== null && outboundDays < allowed) {
      // we are chasing; they are not answering — a wait to record, or an escalation
      push({ ...base, kind: 'awaiting_reply', severity: 'warning',
        detail: customerDays === null
          ? `chased ${outboundDays === 0 ? 'today' : `${outboundDays} days ago`}, and they have never responded`
          : `no response for ${customerDays} days though we chased ${outboundDays === 0 ? 'today' : `${outboundDays} days ago`}; ${deal.stage_name || 'this stage'} expects every ${allowed}` });
    } else if (silent) {
      push({ ...base, kind: 'gone_quiet', severity: customerDays === null ? 'critical' : 'warning',
        detail: customerDays === null
          ? 'nobody has heard from them yet'
          : `no contact for ${customerDays} days, and ${deal.stage_name || 'this stage'} expects every ${allowed}` });
    } else if (gaps.some((gap) => gap.kind === 'no_next_action')) {
      push({ ...base, kind: 'no_next_action', severity: 'warning',
        detail: 'nothing agreed as the next step' });
    } else if (gaps.length) {
      push({ ...base, kind: 'next_action_incomplete', severity: 'warning',
        detail: gaps.map((gap) => gap.label.toLowerCase()).join(', ') });
    }

    // a close date coming up with must-haves unresolved is the expensive one
    const closingIn = deal.expected_close
      ? Math.floor((new Date(deal.expected_close).getTime() - now) / DAY)
      : null;
    if (closingIn !== null
        && closingIn <= (Number(cadence.closingSoonDays) || 21)
        && deal.unmet_must_haves > 0) {
      push({ ...base, kind: 'closing_with_blockers', severity: 'critical',
        detail: closingIn < 0
          ? `close date passed with ${deal.unmet_must_haves} must-have${deal.unmet_must_haves === 1 ? '' : 's'} unresolved`
          : `closes in ${closingIn} days with ${deal.unmet_must_haves} must-have${deal.unmet_must_haves === 1 ? '' : 's'} unresolved` });
    }
  }

  // ---- what customers said they would do, and have not
  const { rows: commitments } = await query(
    `SELECT c.id, c.what, c.due_on, c.account_id, c.opportunity_id,
            a.name AS account_name, a.department_id,
            COALESCE(o.owner_user_id, a.owner_user_id) AS owner_user_id,
            u.full_name AS owner_name, u.avatar_color AS owner_color, o.name AS opportunity_name
       FROM customer_commitments c
       JOIN accounts a ON a.id = c.account_id
       LEFT JOIN opportunities o ON o.id = c.opportunity_id
       LEFT JOIN users u ON u.id = COALESCE(o.owner_user_id, a.owner_user_id)
      WHERE c.status = 'OPEN' AND c.due_on < (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND a.is_archived = FALSE
        AND ($1::int IS NULL OR a.department_id = $1::int)`,
    [departmentId],
  );
  for (const commitment of commitments) {
    push({
      entity_type: commitment.opportunity_id ? 'OPPORTUNITY' : 'ACCOUNT',
      entity_id: commitment.opportunity_id ?? commitment.account_id,
      account_id: commitment.account_id,
      title: commitment.opportunity_name || commitment.account_name,
      subtitle: commitment.account_name,
      owner_user_id: commitment.owner_user_id, owner_name: commitment.owner_name,
      owner_color: commitment.owner_color, department_id: commitment.department_id,
      kind: 'commitment_overdue', severity: 'warning',
      detail: `they committed to "${commitment.what}" by ${dayOf(commitment.due_on)}`,
    });
  }

  // ---- handovers nobody has said they have
  const confirmDays = Number(settings.crm?.handoverConfirmDays) || 2;
  const { rows: handovers } = await query(
    `SELECT h.id, h.role, h.to_user_id, h.created_at, o.id AS opportunity_id, o.name, o.account_id,
            a.name AS account_name, a.department_id,
            u.full_name AS to_name, u.avatar_color AS to_color
       FROM opportunity_handovers h
       JOIN opportunities o ON o.id = h.opportunity_id
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN users u ON u.id = h.to_user_id
      WHERE h.acknowledged_at IS NULL AND h.to_user_id IS NOT NULL
        AND h.created_at < now() - ($1 || ' days')::interval
        AND o.is_archived = FALSE AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')
        AND ($2::int IS NULL OR a.department_id = $2::int)`,
    [confirmDays, departmentId],
  );
  for (const handover of handovers) {
    push({
      entity_type: 'OPPORTUNITY', entity_id: handover.opportunity_id, account_id: handover.account_id,
      title: handover.name, subtitle: handover.account_name,
      owner_user_id: handover.to_user_id, owner_name: handover.to_name, owner_color: handover.to_color,
      department_id: handover.department_id,
      kind: 'handover_unconfirmed', severity: 'warning',
      detail: `${handover.role === 'OWNER' ? 'the deal' : handover.role === 'NEXT_ACTION' ? 'the next move' : 'escalations'} handed over ${daysAgo(handover.created_at)} days ago and not yet confirmed`,
    });
  }

  // ---- blockers past the date they were expected to clear
  const { rows: lateBlockers } = await query(
    `SELECT t.id, t.title, t.blocked_item, t.expected_resolution, t.dependency, t.external_party,
            COALESCE(o.account_id, CASE WHEN t.entity_type = 'ACCOUNT' THEN t.entity_id END) AS account_id,
            a.name AS account_name, a.department_id,
            COALESCE(t.responsible_user_id, o.owner_user_id, a.owner_user_id) AS owner_user_id,
            u.full_name AS owner_name, u.avatar_color AS owner_color
       FROM discussion_threads t
       LEFT JOIN opportunities o ON t.entity_type = 'OPPORTUNITY' AND o.id = t.entity_id
       JOIN accounts a ON a.id = COALESCE(o.account_id, CASE WHEN t.entity_type = 'ACCOUNT' THEN t.entity_id END)
       LEFT JOIN users u ON u.id = COALESCE(t.responsible_user_id, o.owner_user_id, a.owner_user_id)
      WHERE t.kind = 'blocker' AND t.status = 'open' AND a.is_archived = FALSE
        AND t.expected_resolution < (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND ($1::int IS NULL OR a.department_id = $1::int)`,
    [departmentId],
  );
  for (const blocker of lateBlockers) {
    push({
      entity_type: 'ACCOUNT', entity_id: blocker.account_id, account_id: blocker.account_id,
      title: blocker.title || 'A blocker', subtitle: blocker.account_name,
      owner_user_id: blocker.owner_user_id, owner_name: blocker.owner_name, owner_color: blocker.owner_color,
      department_id: blocker.department_id,
      kind: 'blocker_overdue', severity: 'critical',
      detail: `${blocker.blocked_item ? `${blocker.blocked_item} is ` : ''}still blocked${blocker.dependency === 'EXTERNAL' && blocker.external_party ? ` on ${blocker.external_party}` : ''}; it was expected to clear by ${dayOf(blocker.expected_resolution)}`,
    });
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

  // ---- blockers raised and then left: the people asked have not answered
  const quietDays = Number(settings.crm?.blockerQuietDays) || 3;
  const { rows: blockers } = await query(
    `SELECT t.id, t.title, t.entity_type, t.entity_id, t.opened_by, t.created_at,
            COALESCE(o.account_id, t.entity_id) AS account_id,
            a.name AS account_name, a.department_id, a.owner_user_id,
            u.full_name AS owner_name, u.avatar_color AS owner_color,
            (SELECT MAX(m.created_at) FROM discussion_messages m WHERE m.thread_id = t.id) AS last_message_at,
            (SELECT COUNT(*)::int FROM discussion_messages m WHERE m.thread_id = t.id) AS messages
       FROM discussion_threads t
       LEFT JOIN opportunities o ON t.entity_type = 'OPPORTUNITY' AND o.id = t.entity_id
       JOIN accounts a ON a.id = COALESCE(o.account_id, CASE WHEN t.entity_type = 'ACCOUNT' THEN t.entity_id END)
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE t.kind = 'blocker' AND t.status = 'open' AND a.is_archived = FALSE
        AND ($1::int IS NULL OR a.department_id = $1::int)`,
    [departmentId],
  );
  for (const blocker of blockers) {
    const last = new Date(blocker.last_message_at || blocker.created_at).getTime();
    const silent = Math.floor((now - last) / DAY);
    if (silent < quietDays) continue;
    push({
      entity_type: 'ACCOUNT', entity_id: blocker.account_id, account_id: blocker.account_id,
      title: blocker.title || 'A blocker', subtitle: blocker.account_name,
      owner_user_id: blocker.owner_user_id, owner_name: blocker.owner_name,
      owner_color: blocker.owner_color, department_id: blocker.department_id,
      kind: 'blocker_waiting', severity: silent >= quietDays * 2 ? 'critical' : 'warning',
      detail: blocker.messages <= 1
        ? `raised ${silent} days ago and nobody has replied`
        : `no reply in ${silent} days`,
    });
  }

  signals.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  // each line carries its organization's logo, so a long list can be scanned by eye
  const logos = await logosFor(signals.map((sig) => sig.account_id));
  for (const signal of signals) signal.account_logo = logos.get(signal.account_id) ?? null;

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
      next_action_incomplete: count('next_action_incomplete'),
      awaiting_reply: count('awaiting_reply'),
      revisit_due: count('revisit_due'),
      commitment_overdue: count('commitment_overdue'),
      handover_unconfirmed: count('handover_unconfirmed'),
      blocker_overdue: count('blocker_overdue'),
      closing_with_blockers: count('closing_with_blockers'),
      meeting_outcome_missing: count('meeting_outcome_missing'),
      milestone_overdue: count('milestone_overdue'),
      blocker_waiting: count('blocker_waiting'),
    },
    attention: signals,
    by_person: [...byOwner.values()].sort((a, b) => b.critical - a.critical || b.total - a.total),
  };
}
