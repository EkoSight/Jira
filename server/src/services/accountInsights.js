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
