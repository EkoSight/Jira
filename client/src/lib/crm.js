/** Shared vocabulary for the pipeline screens. */

export const ACCOUNT_TYPE_META = {
  LEAD: { label: 'Lead', tone: 'brand' },
  CUSTOMER: { label: 'Customer', tone: 'good' },
  PARTNER: { label: 'Partner', tone: 'good' },
};

/** Each kind of touch, with the icon and label the timeline shows. */
export const ACTIVITY_META = {
  NOTE: { label: 'Note', icon: 'note', quick: false },
  EMAIL: { label: 'Email', icon: 'link', quick: true },
  CALL: { label: 'Call', icon: 'bell', quick: true },
  PPT: { label: 'Sent deck', icon: 'image', quick: true },
  PROPOSAL: { label: 'Proposal', icon: 'paperclip', quick: true },
  MEETING: { label: 'Meeting', icon: 'team', quick: true },
  DEMO: { label: 'Demo', icon: 'board', quick: true },
  IN_PERSON: { label: 'In person', icon: 'user', quick: true },
  SUMMARY: { label: 'Summary', icon: 'list', quick: true },
  STAGE_CHANGE: { label: 'Stage change', icon: 'chevron', quick: false },
  CONVERTED: { label: 'Converted', icon: 'trophy', quick: false },
};

/** The buttons offered on an account for logging a touch, in order. */
export const QUICK_ACTIVITIES = ['EMAIL', 'CALL', 'MEETING', 'DEMO', 'PPT', 'PROPOSAL', 'IN_PERSON', 'SUMMARY', 'NOTE'];

export const activityMeta = (type) => ACTIVITY_META[type] || ACTIVITY_META.NOTE;

export const CRM_SIGNAL_META = {
  account_stalled: { label: 'Stalled', severity: 'critical' },
  account_cold: { label: 'Going cold', severity: 'warning' },
  account_next_step_overdue: { label: 'Next step overdue', severity: 'warning' },
  account_no_next_step: { label: 'No next step', severity: 'warning' },
};

export const crmSignalMeta = (kind) => CRM_SIGNAL_META[kind] || { label: 'Needs a nudge', severity: 'warning' };

/** Money the way a deal value reads, compact. */
export function formatMoney(value, currency = 'INR') {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isNaN(number)) return null;
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  if (number >= 10000000) return `${symbol}${(number / 10000000).toFixed(2)} Cr`;
  if (number >= 100000) return `${symbol}${(number / 100000).toFixed(1)} L`;
  if (number >= 1000) return `${symbol}${(number / 1000).toFixed(0)}k`;
  return `${symbol}${number.toLocaleString()}`;
}

/** "3 days since contact", the phrasing the cards lean on. */
export function freshnessLabel(days) {
  if (days === null || days === undefined) return { text: 'never worked', tone: 'critical' };
  if (days <= 0) return { text: 'today', tone: 'good' };
  if (days === 1) return { text: '1 day ago', tone: 'good' };
  if (days <= 6) return { text: `${days} days ago`, tone: 'neutral' };
  if (days <= 13) return { text: `${days} days ago`, tone: 'warning' };
  return { text: `${days} days ago`, tone: 'critical' };
}
