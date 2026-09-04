import { badRequest } from './errors.js';

/**
 * What counts as a usable deadline.
 *
 * Every task needs one — work with no date is work nobody is accountable for,
 * and it never appears in the overdue list, the bandwidth figures or a review.
 *
 * "Usable" also means the date has to be worth setting. A deadline already in
 * the past creates a task that is born late and earns a black mark for nothing,
 * which is the same pathology that used to bite recurring tasks. A deadline
 * years out is a way of avoiding a commitment rather than making one.
 */

export const DEFAULT_MAX_HORIZON_DAYS = 730;

/**
 * How far ahead the FIRST occurrence of a repeating task may sit. Later ones are
 * created automatically as each is completed, so a daily task starting six months
 * from now is a mistake rather than a plan.
 */
const RECURRENCE_HORIZON_DAYS = {
  daily: 14,
  weekdays: 14,
  weekly: 60,
  monthly: 200,
};

const DAY = 86_400_000;
// the browser clock and the server clock are never exactly the same
const SKEW_MS = 5 * 60 * 1000;

/**
 * Validates a deadline and returns it as a Date.
 * Throws a 400 with a plain-language reason if it cannot be used.
 */
export function assertUsableDeadline(
  value,
  { recurrence = 'none', maxHorizonDays = DEFAULT_MAX_HORIZON_DAYS, now = new Date() } = {},
) {
  if (value === undefined || value === null || value === '') {
    throw badRequest('A deadline is required — every task needs a date it is expected by');
  }

  const due = new Date(value);
  if (Number.isNaN(due.getTime())) {
    throw badRequest('That deadline is not a date the system can read');
  }

  if (due.getTime() < now.getTime() - SKEW_MS) {
    throw badRequest('That deadline has already passed — pick a date and time in the future');
  }

  const horizon = Math.max(1, Number(maxHorizonDays) || DEFAULT_MAX_HORIZON_DAYS);
  if (due.getTime() > now.getTime() + horizon * DAY) {
    throw badRequest(
      `That deadline is more than ${horizon} days away — pick something the team can work towards`,
    );
  }

  const cadence = RECURRENCE_HORIZON_DAYS[recurrence];
  if (cadence && due.getTime() > now.getTime() + cadence * DAY) {
    throw badRequest(
      `A task that repeats ${recurrence} should start within ${cadence} days — the later occurrences are created for you`,
    );
  }

  return due;
}
