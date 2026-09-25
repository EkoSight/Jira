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

  // the pipeline nudges: each says what to do, not just that something is wrong
  gone_quiet: {
    label: 'Gone quiet', severity: 'warning',
    action: 'Speak to them, then log it',
  },
  next_action_overdue: {
    label: 'Next action overdue', severity: 'warning',
    action: 'Do it, or agree a new one with a date',
  },
  no_next_action: {
    label: 'No next action', severity: 'warning',
    action: 'Agree what happens next, and by when',
  },
  closing_with_blockers: {
    label: 'Closing with blockers', severity: 'critical',
    action: 'Resolve the must-haves, or move the close date honestly',
  },
  meeting_outcome_missing: {
    label: 'Outcome not recorded', severity: 'warning',
    action: 'Say what came of it',
  },
  milestone_overdue: {
    label: 'Milestone overdue', severity: 'warning',
    action: 'Deliver it, or say what is holding it up',
  },
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

// ------------------------------------------------------------ B2B vocabulary

/**
 * The kinds of agreement, and whether money is the point of them.
 *
 * An unpaid pilot can matter enormously and still not belong in a revenue
 * forecast. Keeping that distinction in the label stops it being lost.
 */
export const ENGAGEMENT_MODELS = [
  { value: 'PAID_PILOT', label: 'Paid pilot', commercial: true },
  { value: 'UNPAID_PILOT', label: 'Unpaid pilot', commercial: false },
  { value: 'DEVICE_PURCHASE', label: 'Device purchase', commercial: true },
  { value: 'TESTING_CONTRACT', label: 'Testing contract', commercial: true },
  { value: 'CLINIC_PARTNERSHIP', label: 'Clinic partnership', commercial: true },
  { value: 'INSTITUTIONAL_PROJECT', label: 'Institutional project', commercial: true },
  { value: 'CSR_PROJECT', label: 'CSR project', commercial: false },
  { value: 'PARTNERSHIP', label: 'Partnership / MoU', commercial: false },
  { value: 'COMMERCIAL', label: 'Commercial work', commercial: true },
  { value: 'OTHER', label: 'Other', commercial: true },
];

export const MODEL_META = Object.fromEntries(ENGAGEMENT_MODELS.map((m) => [m.value, m]));
export const modelLabel = (value) => MODEL_META[value]?.label || 'Opportunity';

export const OPPORTUNITY_STATUS_META = {
  ACTIVE: { label: 'Live', tone: 'brand' },
  WON: { label: 'Won', tone: 'good' },
  LOST: { label: 'Lost', tone: 'critical' },
  ON_HOLD: { label: 'On hold', tone: 'warning' },
  NURTURE: { label: 'Nurture', tone: 'neutral' },
};

/** What each of the five amounts actually claims. Never added together. */
export const VALUE_FIELDS = [
  { key: 'estimated_value', label: 'Estimated', hint: 'Our guess, before anything was put to them' },
  { key: 'proposed_value', label: 'Proposed', hint: 'The amount we put in front of them' },
  { key: 'agreed_value', label: 'Agreed', hint: 'What they actually signed' },
  { key: 'collected_value', label: 'Collected', hint: 'What has actually arrived' },
];

export const VALUE_BASIS_LABEL = {
  agreed: 'signed amount',
  proposed: 'amount proposed',
  estimated: 'our estimate',
  unknown: 'not yet known',
  non_commercial: 'not commercial work',
  none: 'no value recorded',
};

export const CONTACT_ROLES = [
  { value: 'PRIMARY', label: 'Primary contact' },
  { value: 'DECISION_MAKER', label: 'Decision maker' },
  { value: 'CHAMPION', label: 'Champion' },
  { value: 'TECHNICAL_EVALUATOR', label: 'Technical evaluator' },
  { value: 'PROCUREMENT', label: 'Procurement' },
  { value: 'FINANCE', label: 'Finance' },
  { value: 'APPROVER', label: 'Approver' },
  { value: 'STAKEHOLDER', label: 'Stakeholder' },
  { value: 'BLOCKER', label: 'Blocker' },
];

export const ROLE_LABEL = Object.fromEntries(CONTACT_ROLES.map((r) => [r.value, r.label]));

export const PREFERRED_CHANNELS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'PHONE', label: 'Phone' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'LINKEDIN', label: 'LinkedIn' },
  { value: 'IN_PERSON', label: 'In person' },
];

export const REQUIREMENT_CATEGORIES = [
  { value: 'COMMERCIAL', label: 'Commercial' },
  { value: 'TECHNICAL', label: 'Technical' },
  { value: 'VALIDATION', label: 'Validation' },
  { value: 'LEGAL', label: 'Legal' },
  { value: 'OPERATIONAL', label: 'Operational' },
  { value: 'APPROVAL', label: 'Approval' },
  { value: 'DATA', label: 'Data' },
  { value: 'OTHER', label: 'Other' },
];

export const IMPORTANCE_META = {
  MUST_HAVE: { label: 'Must have', tone: 'critical' },
  SHOULD_HAVE: { label: 'Should have', tone: 'warning' },
  NICE_TO_HAVE: { label: 'Nice to have', tone: 'neutral' },
};

export const REQUIREMENT_STATUS_META = {
  OPEN: { label: 'Open', tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', tone: 'brand' },
  MET: { label: 'Met', tone: 'good' },
  BLOCKED: { label: 'Blocked', tone: 'critical' },
  WAIVED: { label: 'Waived', tone: 'neutral' },
};

/** What each outcome means, so a sent deck never reads as a conversation. */
export const OUTCOME_META = {
  ATTEMPTED: { label: 'Attempted', engaged: false },
  COMPLETED: { label: 'Completed', engaged: true },
  SENT: { label: 'Sent', engaged: true },
  RECEIVED: { label: 'Reply received', engaged: true },
  SCHEDULED: { label: 'Scheduled', engaged: false },
  CANCELLED: { label: 'Cancelled', engaged: false },
  NO_SHOW: { label: 'No show', engaged: false },
  NOTED: { label: 'Noted', engaged: false },
};

export const outcomeMeta = (value) => OUTCOME_META[value] || OUTCOME_META.NOTED;

/**
 * The exact amount, spelled out, for the places a rounded "₹12.5 L" is not
 * enough. Indian grouping, because that is how these numbers get read aloud.
 */
export function exactMoney(value, currency = 'INR') {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isNaN(number)) return null;
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${number.toLocaleString(currency === 'INR' ? 'en-IN' : undefined,
    { maximumFractionDigits: 0 })}`;
}

/**
 * How a forecast figure should be spoken about: the number, where it came from,
 * and the probability being applied. Never just a number on its own.
 */
export function describeForecast(opportunity) {
  if (opportunity.eligible_value === null) {
    return { amount: null, note: VALUE_BASIS_LABEL[opportunity.eligible_basis] || 'no value recorded' };
  }
  const basis = VALUE_BASIS_LABEL[opportunity.eligible_basis] || 'recorded value';
  const probability = opportunity.probability_percent;
  return {
    amount: opportunity.eligible_value,
    weighted: opportunity.weighted_value,
    note: probability === null
      ? basis
      : `${basis} × ${probability}% (${opportunity.probability_source === 'explicit' ? 'set by hand' : 'stage default'})`,
  };
}

/**
 * What a stage expects to be true before a deal enters it.
 *
 * The server returns the gaps for the stage a deal is IN. This works out the gaps
 * for the stage it is about to move TO, which is the only moment the question is
 * actually useful — so the same rules are applied here, against the target
 * stage's own gate columns.
 *
 * Advisory, always. It tells somebody what is missing and lets them move the deal
 * anyway: a real deal sometimes jumps a stage, and a tool that refuses is a tool
 * people route around by lying to it.
 */
export function stageEntryGaps(opportunity, stage) {
  if (!stage || stage.kind !== 'open') return [];
  const gaps = [];
  if (stage.requires_contact && !opportunity.contact_count) {
    gaps.push({ kind: 'no_contact', label: 'No one named at the organization' });
  }
  if (stage.requires_next_action && !opportunity.next_step) {
    gaps.push({ kind: 'no_next_step', label: 'No next action' });
  }
  if (stage.requires_next_action && opportunity.next_step && !opportunity.next_step_due) {
    gaps.push({ kind: 'no_next_step_date', label: 'Next action has no date' });
  }
  if (stage.requires_value
      && opportunity.eligible_value === null
      && !opportunity.value_unknown) {
    gaps.push({ kind: 'no_value', label: 'No value recorded, and not marked unknown' });
  }
  if (!opportunity.expected_close && stage.position >= 4) {
    gaps.push({ kind: 'no_close_date', label: 'No expected close date' });
  }
  if (opportunity.unmet_must_haves > 0) {
    gaps.push({
      kind: 'unmet_must_haves',
      label: `${opportunity.unmet_must_haves} must-have requirement${opportunity.unmet_must_haves === 1 ? '' : 's'} unresolved`,
    });
  }
  return gaps;
}
