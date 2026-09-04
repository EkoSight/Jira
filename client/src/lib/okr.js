/** Shared vocabulary for the Goals screens. */

export const HEALTH_META = {
  ON_TRACK: { label: 'On track', tone: 'good', color: 'var(--good)' },
  AT_RISK: { label: 'At risk', tone: 'warning', color: 'var(--warning)' },
  OFF_TRACK: { label: 'Off track', tone: 'critical', color: 'var(--critical)' },
  COMPLETED: { label: 'Achieved', tone: 'brand', color: 'var(--brand)' },
  NOT_STARTED: { label: 'Not started', tone: 'neutral', color: 'var(--axis)' },
};

export const health = (key) => HEALTH_META[key] || HEALTH_META.NOT_STARTED;

export const OBJECTIVE_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export const STATUS_LABEL = Object.fromEntries(OBJECTIVE_STATUSES.map((s) => [s.value, s.label]));

export const MEASUREMENT_TYPES = [
  { value: 'NUMBER', label: 'A number', hint: 'Farmers onboarded, dealers signed, demos run' },
  { value: 'PERCENTAGE', label: 'A percentage', hint: 'Share of queries answered inside a day' },
  { value: 'CURRENCY', label: 'An amount of money', hint: 'Revenue, cost saved, funding raised' },
  { value: 'BINARY', label: 'Done or not done', hint: 'Something that either happens or does not' },
  { value: 'MILESTONE', label: 'Milestones reached', hint: 'Count of stages cleared out of a total' },
  { value: 'TASK_ROLLUP', label: 'The linked tasks', hint: 'Progress is however much of the work is finished' },
];

export const MEASUREMENT_LABEL = Object.fromEntries(MEASUREMENT_TYPES.map((m) => [m.value, m.label]));

export const CONFIDENCE = [
  { value: 'HIGH', label: 'Confident', tone: 'good' },
  { value: 'MEDIUM', label: 'Some doubt', tone: 'warning' },
  { value: 'LOW', label: 'Worried', tone: 'critical' },
];

/** Formats a key result's value the way its measurement type reads best. */
export function formatValue(value, keyResult) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return String(value);

  switch (keyResult?.measurement_type) {
    case 'BINARY':
      return number >= 1 ? 'Done' : 'Not yet';
    case 'PERCENTAGE':
      return `${trim(number)}%`;
    case 'CURRENCY':
      // lakh/crore grouping, so ₹25,00,000 in a title and the same amount in a
      // value are recognisably the same number
      return `${keyResult.unit || '₹'}${number.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    default: {
      const formatted = trim(number).toLocaleString();
      return keyResult?.unit ? `${formatted} ${keyResult.unit}` : formatted;
    }
  }
}

const trim = (value) => (Number.isInteger(value) ? value : Math.round(value * 100) / 100);

/** "40 → 100 farmers", the one-line summary of where a key result stands. */
export function measurementSummary(keyResult) {
  if (keyResult.measurement_type === 'BINARY') {
    return Number(keyResult.current_value) >= 1 ? 'Done' : 'Not done yet';
  }
  if (keyResult.measurement_type === 'TASK_ROLLUP') {
    const count = keyResult.linked_task_count || 0;
    return count === 0 ? 'No tasks linked yet' : `${count} linked task${count === 1 ? '' : 's'}`;
  }
  if (keyResult.target_value === null || keyResult.target_value === undefined) {
    return `${formatValue(keyResult.current_value, keyResult)} · no target set`;
  }
  const now = formatValue(keyResult.current_value, keyResult);
  const target = formatValue(keyResult.target_value, keyResult);
  // "of" implies a fraction, which is wrong when the number is meant to come down
  return keyResult.direction === 'DECREASE' ? `${now}, heading for ${target}` : `${now} of ${target}`;
}

/**
 * A calendar date, taken from the local parts.
 *
 * NOT toISOString().slice(0,10) — that converts to UTC first, so local midnight
 * anywhere east of Greenwich lands on the previous day. In IST it turned
 * "1 Jul – 30 Sep" into "30 Jun – 29 Sep" on every preset.
 */
const iso = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * The periods people actually plan in. Offered as presets so a quarter never
 * gets typed in slightly differently by two people.
 */
export function periodPresets(now = new Date()) {
  const year = now.getFullYear();
  const quarter = Math.floor(now.getMonth() / 3);
  const quarterRange = (index, baseYear) => {
    const start = new Date(baseYear, index * 3, 1);
    const end = new Date(baseYear, index * 3 + 3, 0);
    return { start_date: iso(start), end_date: iso(end), label: `Q${index + 1} ${baseYear}` };
  };

  const next = quarter === 3 ? quarterRange(0, year + 1) : quarterRange(quarter + 1, year);

  return [
    { key: 'this-quarter', ...quarterRange(quarter, year), label: `This quarter (${quarterRange(quarter, year).label})` },
    { key: 'next-quarter', ...next, label: `Next quarter (${next.label})` },
    {
      key: 'this-half',
      start_date: iso(new Date(year, quarter < 2 ? 0 : 6, 1)),
      end_date: iso(new Date(year, quarter < 2 ? 6 : 12, 0)),
      label: quarter < 2 ? `First half of ${year}` : `Second half of ${year}`,
    },
    { key: 'this-year', start_date: iso(new Date(year, 0, 1)), end_date: iso(new Date(year, 12, 0)), label: `${year}` },
    // the escape hatch: without it a goal planned outside every preset is
    // invisible with no way to reach it from the page it should be on
    { key: 'all', start_date: null, end_date: null, label: 'All periods' },
  ];
}

/**
 * Days left in a period, phrased the way the goal cards read.
 *
 * Counted in whole calendar days from midnight to midnight, not from the
 * current clock to the end of the last day — measuring from "now" made the
 * answer depend on the time of day, and left "Last day" unreachable: on the
 * final day there was always a fraction of a day left, which rounded up to 1.
 */
export function daysLeftLabel(endDate, now = new Date()) {
  if (!endDate) return '';
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // rounded rather than floored so an hour of clock shift cannot drop a day
  const days = Math.round((end - today) / 86400000);
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Last day';
  if (days === 1) return '1 day left';
  if (days <= 45) return `${days} days left`;
  return `${Math.round(days / 7)} weeks left`;
}

// ------------------------------------------------------------------ pace
//
// Everything below is DERIVED IN THE BROWSER for display only. None of it is
// written back: the stored status of a goal or key result is only ever changed
// by someone deciding to change it. These are readings, not verdicts.

const DAY = 86400000;

/** Whole days between a timestamp and now. Negative means in the future. */
export function daysSince(value, now = Date.now()) {
  if (!value) return null;
  return Math.floor((now - new Date(value).getTime()) / DAY);
}

/**
 * Progress against the pace the calendar expects.
 *
 * `delta` is percentage POINTS ahead (positive) or behind (negative) — not a
 * ratio. Ten points behind at the halfway mark is the same ten points at the
 * end, which is how the health thresholds already read it on the server.
 */
export function pace(progress, elapsed) {
  if (progress === null || progress === undefined || elapsed === null || elapsed === undefined) {
    return { delta: null, verdict: 'unknown', label: 'No pace yet', tone: 'neutral' };
  }
  const delta = Math.round(progress - elapsed);
  if (delta >= 5) return { delta, verdict: 'ahead', label: `${delta} points ahead of schedule`, tone: 'good' };
  if (delta > -10) return { delta, verdict: 'on', label: 'Roughly where it should be', tone: 'good' };
  if (delta > -25) return { delta, verdict: 'behind', label: `${Math.abs(delta)} points behind schedule`, tone: 'warning' };
  return { delta, verdict: 'far-behind', label: `${Math.abs(delta)} points behind schedule`, tone: 'critical' };
}

/**
 * The one sentence a person should be able to read and stop reading.
 * Deliberately plain: no percentages doing work that words do better.
 */
export function paceSentence(objective) {
  const progress = objective.progress_percent;
  const elapsed = objective.time_elapsed_percent;

  if (objective.status === 'COMPLETED') return 'This goal is finished.';
  if (objective.status === 'CANCELLED') return 'This goal was cancelled.';
  if (objective.status === 'ON_HOLD') return 'This goal is on hold — nothing is expected to move.';
  if (objective.status === 'DRAFT') return 'Still a draft. It is not being tracked yet.';
  if (!objective.key_result_count) return 'Nothing is being measured yet, so there is no progress to report.';
  if (progress === null) return 'None of the key results can be scored yet.';

  const left = daysLeftLabel(objective.end_date);
  const reading = pace(progress, elapsed);

  if (elapsed !== null && elapsed >= 100) {
    return progress >= 100
      ? 'The period is over and the goal was met.'
      : `The period is over and the goal reached ${progress}%.`;
  }

  switch (reading.verdict) {
    case 'ahead':
      return `${progress}% done with ${left.toLowerCase()} — comfortably ahead of the calendar.`;
    case 'on':
      return `${progress}% done with ${left.toLowerCase()} — about where it should be.`;
    case 'behind':
      return `${progress}% done with ${left.toLowerCase()} — slipping behind the calendar.`;
    case 'far-behind':
      return `${progress}% done with ${left.toLowerCase()} — well behind, and the gap is not closing on its own.`;
    default:
      return `${progress}% done with ${left.toLowerCase()}.`;
  }
}

/** Where the calendar says progress should be by now, as a percentage. */
export const expectedProgress = (objective) =>
  objective.time_elapsed_percent === null ? null : objective.time_elapsed_percent;

// ------------------------------------------------------------- KR attention

/** How stale a check-in is allowed to get before it is worth mentioning. */
const STALE_DAYS = 14;

/**
 * Reasons a key result might want a human's attention.
 *
 * These are RECOMMENDATIONS the UI works out from data it already has. They
 * never change the key result's stored status, and a key result with no reasons
 * is not asserted to be fine — only that nothing stood out.
 */
export function krAttention(keyResult, now = Date.now()) {
  const reasons = [];
  if (keyResult.status === 'CANCELLED' || keyResult.health === 'COMPLETED') return reasons;

  if (keyResult.health === 'OFF_TRACK') {
    reasons.push({
      kind: 'off_track',
      label: 'Off track',
      detail: 'Progress is far enough behind the calendar that the target is at risk.',
      severity: 'critical',
    });
  } else if (keyResult.health === 'AT_RISK') {
    reasons.push({
      kind: 'at_risk',
      label: 'Slipping',
      detail: 'Behind where the calendar expects it to be.',
      severity: 'warning',
    });
  }

  if (keyResult.needs_target) {
    reasons.push({
      kind: 'no_target',
      label: 'No target',
      detail: 'Without a target the outcome cannot be scored — only the linked work can.',
      severity: 'warning',
    });
  }

  const stale = daysSince(keyResult.last_check_in_at, now);
  if (stale === null) {
    // a key result added this week has not "gone quiet" — it has not had the
    // chance yet, and nagging about it on day one teaches people to ignore the
    // flags that matter
    const age = daysSince(keyResult.created_at, now);
    if (age === null || age >= STALE_DAYS) {
      reasons.push({
        kind: 'never_checked',
        label: 'Never updated',
        detail: 'Nobody has recorded where this stands.',
        severity: 'warning',
      });
    }
  } else if (stale >= STALE_DAYS) {
    reasons.push({
      kind: 'stale',
      label: 'Not updated recently',
      detail: `Last update was ${stale} days ago.`,
      severity: 'warning',
    });
  }

  if (!keyResult.owner_user_id) {
    reasons.push({
      kind: 'unowned',
      label: 'No owner',
      detail: 'Nobody is accountable for moving this one.',
      severity: 'warning',
    });
  }

  if (!keyResult.linked_task_count && keyResult.measurement_type === 'TASK_ROLLUP') {
    reasons.push({
      kind: 'no_work',
      label: 'No work linked',
      detail: 'This one is measured by its tasks, and none are linked.',
      severity: 'warning',
    });
  }

  return reasons;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/** Worst severity among a key result's reasons, for sorting and colouring. */
export function worstSeverity(reasons) {
  return reasons.reduce(
    (worst, r) => (SEVERITY_ORDER[r.severity] < SEVERITY_ORDER[worst] ? r.severity : worst),
    'info',
  );
}

/** Sorts the key results that need attention most urgently to the top. */
export function byUrgency(a, b) {
  const rank = (kr) => {
    const reasons = krAttention(kr);
    if (!reasons.length) return 3;
    return SEVERITY_ORDER[worstSeverity(reasons)];
  };
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  return (a.progress_percent ?? 0) - (b.progress_percent ?? 0);
}

// ------------------------------------------------------------- KR filtering

/**
 * The buckets people actually ask for when scanning a goal. Each is a plain
 * predicate so the counts and the filtered list can never disagree.
 */
export const KR_FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'attention', label: 'Needs attention', match: (kr) => krAttention(kr).length > 0 },
  { key: 'on_track', label: 'On track', match: (kr) => kr.health === 'ON_TRACK' },
  { key: 'done', label: 'Achieved', match: (kr) => kr.health === 'COMPLETED' },
  { key: 'mine', label: 'Mine', match: (kr, userId) => kr.owner_user_id === userId },
];

/** { all: 6, attention: 2, ... } — the number beside each filter chip. */
export function filterCounts(keyResults, userId) {
  return Object.fromEntries(
    KR_FILTERS.map((f) => [f.key, keyResults.filter((kr) => f.match(kr, userId)).length]),
  );
}

// ---------------------------------------------------------------- people

/**
 * Everyone visibly carrying part of this goal: the key result owners and the
 * people assigned the linked work, counted by how much they hold.
 */
export function contributors(keyResults, tasks, excludeUserId = null) {
  const people = new Map();
  const add = (id, name, color, patch) => {
    if (!id) return;
    const entry = people.get(id) || { id, name, color, key_results: 0, tasks: 0, open_tasks: 0 };
    people.set(id, { ...entry, ...patch(entry) });
  };

  for (const kr of keyResults) {
    add(kr.owner_user_id, kr.owner_name, kr.owner_color, (e) => ({ key_results: e.key_results + 1 }));
  }
  for (const task of tasks) {
    add(task.assignee_id, task.assignee_name, task.assignee_color, (e) => ({
      tasks: e.tasks + 1,
      open_tasks: e.open_tasks + (task.stage === 'done' || task.stage === 'cancelled' ? 0 : 1),
    }));
  }

  // the goal's owner is named above as accountable; listing them again under
  // "also carrying this" reads as though there are two of them
  people.delete(excludeUserId);

  return [...people.values()].sort(
    (a, b) => b.key_results - a.key_results || b.tasks - a.tasks || a.name.localeCompare(b.name),
  );
}

/** What one person is carrying on this goal, for the "your part" panel. */
export function myContribution(keyResults, tasks, userId) {
  const owned = keyResults.filter((kr) => kr.owner_user_id === userId);
  const mine = tasks.filter((t) => t.assignee_id === userId);
  const open = mine.filter((t) => t.stage !== 'done' && t.stage !== 'cancelled');
  return {
    key_results: owned,
    tasks: mine,
    open_tasks: open,
    overdue_tasks: open.filter((t) => t.is_overdue),
    needs_update: owned.filter((kr) => krAttention(kr).some((r) => r.kind === 'stale' || r.kind === 'never_checked')),
  };
}

/**
 * How each attention signal reads. The label is the headline; the detail comes
 * from the server so the wording stays in one place.
 */
export const SIGNAL_META = {
  objective_overdue: { label: 'Past deadline', severity: 'critical' },
  objective_off_track: { label: 'Off track', severity: 'critical' },
  objective_stalled: { label: 'Not moving', severity: 'warning' },
  objective_at_risk: { label: 'Slipping', severity: 'warning' },
  objective_no_key_results: { label: 'Nothing measured', severity: 'warning' },
  key_result_off_track: { label: 'Off track', severity: 'critical' },
  key_result_stale: { label: 'Not checked in', severity: 'warning' },
  key_result_flat: { label: 'Stuck', severity: 'warning' },
  department_inactive: { label: 'Gone quiet', severity: 'warning' },
};

export const signalMeta = (kind) => SIGNAL_META[kind] || { label: 'Attention', severity: 'warning' };

export const SEVERITY_TONE = { critical: 'critical', warning: 'warning', info: 'neutral' };

export const describeOkrActivity = (item) => {
  const field = item.field ? item.field.replace(/_/g, ' ').replace(' id', '') : '';
  // a check-in stores the raw numbers; the feed reads them back in the key
  // result's own terms when it knows what they were measuring
  const asValue = (raw) => {
    if (raw === null || raw === undefined) return '—';
    if (!item.key_result_measurement_type) return String(raw);
    return formatValue(raw, {
      measurement_type: item.key_result_measurement_type,
      unit: item.key_result_unit,
    });
  };

  switch (item.action) {
    case 'created': return 'created it';
    case 'updated': return `changed ${field}`;
    case 'checked_in': return `updated it — ${asValue(item.from_value)} → ${asValue(item.to_value)}`;
    case 'health_overridden': return `set the status to ${health(item.to_value).label} by hand`;
    case 'health_override_cleared': return 'went back to the calculated status';
    case 'archived': return 'archived it';
    case 'task_linked': return 'linked a task';
    case 'task_unlinked': return 'unlinked a task';
    case 'period_corrected':
      return `corrected the period from ${item.from_value} to ${item.to_value} — the presets were a day early outside UTC`;
    default: return item.action.replace(/_/g, ' ');
  }
};
