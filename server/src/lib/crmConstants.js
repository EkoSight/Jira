/** Shared CRM vocabulary, kept in one place. */

export const ACCOUNT_TYPES = ['LEAD', 'CUSTOMER', 'PARTNER'];
export const ACCOUNT_STATUSES = ['ACTIVE', 'WON', 'LOST', 'ON_HOLD'];
export const STAGE_KINDS = ['open', 'won', 'lost'];

/** The kinds of touch that move a deal along. */
export const ACTIVITY_TYPES = [
  'NOTE',
  'EMAIL',
  'CALL',
  'PPT',
  'PROPOSAL',
  'MEETING',
  'DEMO',
  'IN_PERSON',
  'SUMMARY',
  'STAGE_CHANGE',
  'CONVERTED',
];

/** How long a lead may sit still before the system says something, in days. */
export const DEFAULT_CADENCE = {
  // a lead that hasn't advanced a stage in this long needs a push
  stageStaleDays: 7,
  // a lead with no logged activity in this long has gone cold
  engagementDays: 7,
  // at most one reminder to the same person inside this many hours
  reminderHours: 24,
};
