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
      return `${keyResult.unit || '₹'}${number.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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

/** Days left in a period, phrased the way the goal cards read. */
export function daysLeftLabel(endDate) {
  if (!endDate) return '';
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  const days = Math.ceil((end - Date.now()) / 86400000);
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Last day';
  if (days === 1) return '1 day left';
  if (days <= 45) return `${days} days left`;
  return `${Math.round(days / 7)} weeks left`;
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
  switch (item.action) {
    case 'created': return 'created it';
    case 'updated': return `changed ${field}`;
    case 'checked_in': return `checked in — ${item.from_value ?? '—'} → ${item.to_value ?? '—'}`;
    case 'health_overridden': return `set the status to ${health(item.to_value).label} by hand`;
    case 'health_override_cleared': return 'went back to the calculated status';
    case 'archived': return 'archived it';
    case 'task_linked': return 'linked a task';
    case 'task_unlinked': return 'unlinked a task';
    default: return item.action.replace(/_/g, ' ');
  }
};
