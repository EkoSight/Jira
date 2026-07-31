export const PRIORITIES = [
  { value: 'critical', label: 'Critical', tone: 'critical' },
  { value: 'high', label: 'High', tone: 'serious' },
  { value: 'medium', label: 'Medium', tone: 'brand' },
  { value: 'low', label: 'Low', tone: 'neutral' },
];

export const PRIORITY_LABEL = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.label]));
export const PRIORITY_TONE = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.tone]));
export const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export const STAGE_LABEL = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const WORKLOAD_STATUS = {
  idle: { label: 'Idle', tone: 'neutral', note: 'No open work' },
  available: { label: 'Available', tone: 'good', note: 'Has room for more' },
  busy: { label: 'Busy', tone: 'warning', note: 'Near capacity' },
  overloaded: { label: 'Overloaded', tone: 'critical', note: 'Over capacity' },
  stalled: { label: 'Stalled', tone: 'serious', note: 'No recent movement' },
};

const dayMs = 86400000;

export const initials = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase();

export function formatDate(value, { withTime = false } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/** "3 days late", "due today", "in 5 days" — the phrasing the board leans on. */
export function dueLabel(dueDate, { done = false } = {}) {
  if (!dueDate) return { text: 'No deadline', tone: 'neutral' };

  const due = new Date(dueDate);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const days = Math.round((dueDay - startOfToday) / dayMs);

  if (done) return { text: formatDate(dueDate), tone: 'neutral' };
  if (days < 0) {
    const late = Math.abs(days);
    return { text: `${late} day${late === 1 ? '' : 's'} late`, tone: 'critical' };
  }
  if (days === 0) return { text: 'Due today', tone: 'warning' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'warning' };
  if (days <= 3) return { text: `In ${days} days`, tone: 'serious' };
  return { text: formatDate(dueDate), tone: 'neutral' };
}

export function relativeTime(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

/** Turns a stored datetime into the value an <input type="datetime-local"> wants. */
export function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export const fromDateTimeLocal = (value) => (value ? new Date(value).toISOString() : null);

export const monthKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export const monthLabel = (key) => {
  const [year, month] = key.split('-');
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
};

export const describeActivity = (item) => {
  const field = item.field ? item.field.replace(/_/g, ' ').replace(' id', '') : '';
  switch (item.action) {
    case 'created': return 'created this task';
    case 'completed': return 'marked it done';
    case 'reopened': return 'reopened it';
    case 'commented': return 'left a comment';
    case 'archived': return 'archived it';
    case 'moved': return `moved it to ${item.meta?.to_status || 'another column'}`;
    case 'updated': return `changed ${field}`;
    default: return item.action;
  }
};
