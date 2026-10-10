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
  TASK_DONE: { label: 'Task finished', icon: 'check', quick: false },
  ORDER: { label: 'Order', icon: 'wallet', quick: false },
  INVOICE: { label: 'Invoice', icon: 'wallet', quick: false },
  PAYMENT: { label: 'Payment', icon: 'wallet', quick: false },
  HANDOVER: { label: 'Handover', icon: 'user', quick: false },
  NEXT_ACTION: { label: 'Next action', icon: 'flag', quick: false },
};

/** Which way an entry went — the difference between hearing from them and chasing them. */
export const DIRECTION_META = {
  INBOUND: { label: 'From them', tone: 'good', title: 'The customer reached us or replied' },
  OUTBOUND: { label: 'To them', tone: 'brand', title: 'We reached out' },
  INTERNAL: { label: 'Internal', tone: 'neutral', title: 'Work on our side the customer never saw' },
};

/** Where an entry came from, for the small print on the timeline. */
export const SOURCE_LABEL = {
  MANUAL: 'logged by hand',
  TASK: 'from a task',
  MEETING: 'from a meeting',
  SYSTEM: 'recorded automatically',
  EMAIL_IMPORT: 'from an imported email',
  CALENDAR_IMPORT: 'from an imported calendar event',
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
  awaiting_reply: {
    label: 'Chased, no reply', severity: 'warning',
    action: 'Try another contact or channel — or mark it waiting on them, with a date',
  },
  revisit_due: {
    label: 'Time to look again', severity: 'warning',
    action: 'Pick it back up, or set a new date with a reason',
  },
  commitment_overdue: {
    label: 'Customer commitment missed', severity: 'warning',
    action: 'Ask them about it, then mark it kept or missed',
  },
  handover_unconfirmed: {
    label: 'Handover not confirmed', severity: 'warning',
    action: 'Confirm you have it, or tell whoever handed it over',
  },
  blocker_overdue: {
    label: 'Blocker past its date', severity: 'critical',
    action: 'Clear it, or give it an honest new date',
  },
  next_action_overdue: {
    label: 'Next action overdue', severity: 'warning',
    action: 'Do it, or agree a new one with a date',
  },
  no_next_action: {
    label: 'No next action', severity: 'warning',
    action: 'Agree what happens next, and by when',
  },
  next_action_incomplete: {
    label: 'Next action incomplete', severity: 'warning',
    action: 'Name who owes it and by when',
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
  blocker_waiting: {
    label: 'Blocker unanswered', severity: 'warning',
    action: 'Reply, bring in someone who can help, or close it with what was decided',
  },
};

/**
 * The states and union territories of India, for the lead's State field.
 * A pick list rather than free text, so "Maharashtra", "MH" and "maharastra" do
 * not become three different rows in the state-wise view.
 */
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan',
  'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

/** How a lead is being worked, as the state-wise view classifies it. */
export const FOLLOW_UP_META = {
  active: { label: 'Active', tone: 'good', color: 'var(--good)' },
  inactive: { label: 'Needs follow-up', tone: 'warning', color: 'var(--warning)' },
  paused: { label: 'Paused', tone: 'neutral', color: 'var(--axis)' },
  closed: { label: 'Won or lost', tone: 'neutral', color: 'var(--ink-muted)' },
};

export const POTENTIAL_META = {
  high: { label: 'High potential', short: 'High', tone: 'good' },
  medium: { label: 'Medium potential', short: 'Medium', tone: 'brand' },
  low: { label: 'Lower potential', short: 'Lower', tone: 'neutral' },
  unknown: { label: 'Value not known', short: 'Not known', tone: 'neutral' },
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

// ------------------------------------------------------------ trustworthy progress

/** "3 days ago", "today", "never" — for the three clocks. */
export function agoWords(days) {
  if (days === null || days === undefined) return 'never';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * The three clocks a deal keeps, never folded into one: when the customer last
 * engaged, when we last reached out, and when anything was last done on our
 * side. Tidying a record moves only the third.
 */
export const CLOCKS = [
  { key: 'days_since_customer', label: 'Customer last responded', short: 'Them',
    hint: 'A reply, a call or meeting that took place, an order received' },
  { key: 'days_since_outbound', label: 'We last followed up', short: 'Us',
    hint: 'Something sent, an attempt, or an exchange we were part of' },
  { key: 'days_since_internal', label: 'Last internal update', short: 'Inside',
    hint: 'Notes, edits, stage changes and finished tasks — never contact with them' },
];

/** How worried to be about a clock: fresh, getting old, or old. */
export function clockTone(days, quietAfter = 7) {
  if (days === null || days === undefined) return 'critical';
  if (days <= Math.max(1, Math.floor(quietAfter / 2))) return 'good';
  if (days <= quietAfter) return 'neutral';
  return days <= quietAfter * 2 ? 'warning' : 'critical';
}

/** Today in India, as YYYY-MM-DD — the calendar every due date is read in. */
export const todayInIndia = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

export const NEXT_ACTION_GAP_META = {
  no_next_action: { label: 'No next action', short: 'what' },
  no_next_action_owner: { label: 'Nobody named for it', short: 'who' },
  no_next_action_due: { label: 'No date for it', short: 'when' },
  next_action_overdue: { label: 'Next action overdue', short: 'overdue' },
};

/**
 * What a next action is missing, worked out the way the server does: what, who
 * and by when, and whether that date has gone. Empty for a deal that is not live.
 */
export function nextActionGaps(opportunity, todayDate = todayInIndia()) {
  if (!opportunity || opportunity.status !== 'ACTIVE') return [];
  if (opportunity.stage_kind && opportunity.stage_kind !== 'open') return [];
  const gaps = [];
  if (!String(opportunity.next_step || '').trim()) gaps.push('no_next_action');
  if (!opportunity.next_step_owner_id) gaps.push('no_next_action_owner');
  const due = opportunity.next_step_due ? String(opportunity.next_step_due).slice(0, 10) : null;
  if (!due) gaps.push('no_next_action_due');
  else if (due < todayDate) gaps.push('next_action_overdue');
  return gaps;
}

/** A first name, for the tight spaces where a whole name does not fit. */
export const firstName = (name = '') => String(name).trim().split(/\s+/)[0] || '';

/** The rules a stage can carry — the same words the server uses when one is missing. */
export const STAGE_RULE_META = {
  proposal: {
    label: 'A dated proposal on record',
    hint: 'Record the proposal: the date it was sent, and its amount if it had one.',
  },
  order: {
    label: 'An accepted order or contract on record',
    hint: 'Record the purchase order, contract, work order or MoU: its date and its number or link.',
  },
  meeting_completed: {
    label: 'A meeting or demo that actually happened, with its outcome recorded',
    hint: 'Record the outcome on the meeting. A booked meeting is not one that took place.',
  },
  contact: {
    label: 'Someone named at the organization for this deal',
    hint: 'Add the person you are dealing with on the deal.',
  },
  value: {
    label: 'A value, or the value marked as not yet known',
    hint: 'Enter the estimate, or tick "not yet known" so a blank is a decision and not an oversight.',
  },
  close_date: { label: 'An expected close date', hint: 'Set when you expect this to be decided.' },
  must_haves_met: {
    label: 'Every must-have requirement met or waived',
    hint: 'Resolve the open must-haves, or waive them with a note.',
  },
};

export const STAGE_RULE_KEYS = Object.keys(STAGE_RULE_META);

/** Whether the deal's own counts already show a rule as met (the server has the final say). */
function ruleLooksMet(rule, opportunity) {
  switch (rule) {
    case 'proposal': return (opportunity.proposal_count ?? 0) > 0;
    case 'order': return (opportunity.order_count ?? 0) > 0;
    case 'meeting_completed': return (opportunity.completed_meetings ?? 0) > 0;
    case 'contact': return (opportunity.contact_count ?? 0) > 0;
    case 'value': return opportunity.value_unknown || opportunity.eligible_value !== null
      || opportunity.eligible_basis === 'non_commercial';
    case 'close_date': return Boolean(opportunity.expected_close);
    case 'must_haves_met': return !opportunity.unmet_must_haves;
    default: return false;
  }
}

/**
 * The evidence a move needs, in the order the server checks it: the rules for
 * leaving the current stage, then for entering the next one. Only going
 * forward — moving back or to Lost needs none.
 */
export function evidenceNeeds({ opportunity, from, to }) {
  if (!to || to.kind === 'lost') return [];
  const forward = !from || (to.position ?? 0) > (from.position ?? 0) || to.kind === 'won';
  if (!forward) return [];
  const needs = [];
  if (from && from.id !== to.id && from.kind === 'open') {
    for (const rule of from.exit_rules || []) {
      needs.push({ rule, phase: 'exit', stage: from.name, met: ruleLooksMet(rule, opportunity),
        ...(STAGE_RULE_META[rule] || { label: rule }) });
    }
  }
  for (const rule of to.entry_rules || []) {
    if (needs.some((n) => n.rule === rule)) continue;
    needs.push({ rule, phase: 'entry', stage: to.name, met: ruleLooksMet(rule, opportunity),
      ...(STAGE_RULE_META[rule] || { label: rule }) });
  }
  return needs;
}

export const ORDER_KINDS = [
  { value: 'PURCHASE_ORDER', label: 'Purchase order' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'WORK_ORDER', label: 'Work order' },
  { value: 'MOU', label: 'MoU' },
  { value: 'OTHER', label: 'Other signed acceptance' },
];
export const ORDER_KIND_LABEL = Object.fromEntries(ORDER_KINDS.map((k) => [k.value, k.label]));

export const PROPOSAL_STATUS_META = {
  SENT: { label: 'Sent', tone: 'brand' },
  ACCEPTED: { label: 'Accepted', tone: 'good' },
  DECLINED: { label: 'Declined', tone: 'critical' },
  SUPERSEDED: { label: 'Replaced', tone: 'neutral' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};

/** The four commercial figures, each its own claim. Never added together. */
export const LEDGER_FIGURES = [
  { key: 'latest_proposal', label: 'Proposed', hint: 'The latest proposal we sent' },
  { key: 'booked', label: 'Booked', hint: 'Accepted orders and contracts — a commitment, not money' },
  { key: 'invoiced', label: 'Invoiced', hint: 'Revenue billed and not cancelled' },
  { key: 'cash_received', label: 'Cash received', hint: 'Payments that actually arrived, voids excluded' },
];

/** Who a deal paused on purpose is waiting on. Mirrors the server's list. */
export const WAITING_ON = [
  { value: 'CUSTOMER', label: 'Waiting on the customer', short: 'the customer',
    hint: 'It stays on the board and is not chased until the date. It ends by itself when they respond.' },
  { value: 'THIRD_PARTY', label: 'Waiting on a third party', short: 'a third party',
    hint: 'Their lab, a funder, a partner. It stays on the board and is not chased until the date.' },
  { value: 'INTERNAL', label: 'Waiting on us', short: 'us',
    hint: 'Our own pricing approval, samples or sign-off. It stays on the board until the date.' },
];
export const waitingWords = (value) => WAITING_ON.find((w) => w.value === value)?.short || 'someone';

/** The longest a deal may be parked before it counts as forgotten. The server's limit. */
export const MAX_PAUSE_DAYS = 180;

/** What is wrong with the date to look at a paused deal again, or null. */
export function revisitProblem(day, todayDate = todayInIndia()) {
  if (!day) return 'Give the date to look at it again';
  if (day < todayDate) return 'That date has already passed';
  const limit = new Date(`${todayDate}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + MAX_PAUSE_DAYS);
  if (day > limit.toISOString().slice(0, 10)) {
    return `Pick a date within ${MAX_PAUSE_DAYS} days — a deal parked longer than that is forgotten, not waiting`;
  }
  return null;
}

/** What became of something the customer said they would do. */
export const COMMITMENT_STATUS_META = {
  OPEN: { label: 'Open', tone: 'brand' },
  KEPT: { label: 'Kept', tone: 'good' },
  MISSED: { label: 'Missed', tone: 'critical' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};

/** Monday to Monday (India) around a day, as YYYY-MM-DD; the end is exclusive. The server's rule. */
export function weekOf(day = todayInIndia()) {
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00Z`);
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** The start of the week `weeks` before or after the week starting `start`. */
export function shiftWeek(start, weeks) {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

/** "5 – 11 Oct 2026", Monday to Sunday. */
export function weekLabel(start) {
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(first);
  last.setUTCDate(first.getUTCDate() + 6);
  const fmt = (d, opts) => d.toLocaleDateString('en-IN', { timeZone: 'UTC', ...opts });
  const sameMonth = first.getUTCMonth() === last.getUTCMonth();
  return `${fmt(first, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** "3 emails, 1 call" from counts by activity type; empty when nothing was logged. */
export function effortWords(counts = {}) {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => {
      const label = (ACTIVITY_META[type]?.label || type).toLowerCase();
      return `${n} ${n === 1 ? label : `${label}${/s$/.test(label) ? '' : 's'}`}`;
    })
    .join(', ');
}

/**
 * A reporting period in India's financial year (April to March; quarters start
 * in April, July, October and January): 'year' and 'quarter' run to today,
 * 'last_quarter' and 'last_year' are whole.
 */
export function financialPeriod(preset, todayDate = todayInIndia()) {
  const [y, m] = todayDate.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  const fyStart = m >= 4 ? y : y - 1;
  const quarterMonth = m >= 10 ? 10 : m >= 7 ? 7 : m >= 4 ? 4 : 1;
  switch (preset) {
    case 'quarter':
      return { from: `${y}-${pad(quarterMonth)}-01`, to: todayDate };
    case 'last_quarter': {
      const month = quarterMonth === 1 ? 10 : quarterMonth - 3;
      const year = quarterMonth === 1 ? y - 1 : y;
      return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month + 2)}-${pad(lastDay(year, month + 2))}` };
    }
    case 'last_year':
      return { from: `${fyStart - 1}-04-01`, to: `${fyStart}-03-31` };
    default:
      return { from: `${fyStart}-04-01`, to: todayDate };
  }
}
