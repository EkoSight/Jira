/**
 * The attendance and payroll policy, effective-dated.
 *
 * Three kinds of value live here and are kept visibly apart:
 *
 *   CONFIRMED — supplied by the company (office hours, the 20-minute arrival
 *   window, two paid days a month, two days' notice for planned leave).
 *
 *   PROPOSED — the brief's suggested interpretations (how grace interacts with
 *   pay, how lateness is measured, how extra time offsets). They are used for
 *   draft reports, listed in Settings, and must be accepted by an admin before
 *   any month can be finalised.
 *
 *   NOT SUPPLIED — break payability and the salary method. Drafts run without
 *   them, labelled as assumptions; finalisation is blocked until someone sets
 *   them.
 *
 * A version is never edited once a locked month has used it. Changing policy
 * means adding a version with an effective date.
 */

import { query } from '../db/pool.js';
import { clock } from '../lib/attendanceCalc.js';

export const DEFAULT_POLICY = {
  timezone: 'Asia/Kolkata',
  officeStart: '09:00',
  officeEnd: '18:00',
  workingDays: [1, 2, 3, 4, 5, 6],
  graceMinutes: 20,

  // PROPOSED: arrival inside the window is credited for the minutes it was late;
  // after the window there is no grace and lateness counts from 09:00
  graceMode: 'THRESHOLD',
  // CONFIRMED (12 October 2026): time before 09:00 counts as extra time, like
  // time after 18:00 — people who arrive before office hours have it counted
  creditBeforeStart: true,
  // CONFIRMED (12 October 2026): time outside office hours counts by itself —
  // nobody has to approve it. A reviewer can still mark a day's time as not
  // counted, and a session longer than maxSessionHours (usually a forgotten
  // check-out) is still held for a person to look at.
  extraRequiresReview: false,
  offsetWindow: 'SAME_MONTH',

  // NOT SUPPLIED: no break is assumed; drafts say so; finalising needs a decision
  breaks: [],
  breaksConfirmed: false,

  // operational
  maxSessionHours: 14,
  missingCheckoutCutoff: '04:00',
  lowAccuracyMeters: 200,
  locationTimeoutSeconds: 15,
  locationMaxAgeSeconds: 120,
  halfDaySplit: '13:30',

  // attendance requirement: off until an admin sets the date it starts
  enforcement: 'REQUIRE',
  startDate: null,
  reminders: { checkInAfterMinutes: 30, checkOutAfterMinutes: 30 },
  mapLinks: 'GOOGLE',
  retentionMonths: null,

  leave: {
    // CONFIRMED: two paid days a month, after approval
    monthlyPaidDays: 2,
    // PROPOSED: the two days are one pool, not one casual and one sick
    allowanceMode: 'POOLED',
    // PROPOSED: the allowance applies in months that begin on or after joining
    eligibility: 'JOINED_BEFORE_MONTH',
    // CONFIRMED: at least two days' notice; PROPOSED: measured as 48 elapsed hours
    noticeHours: 48,
    noticeMode: 'ELAPSED_HOURS',
  },

  payroll: {
    // NOT SUPPLIED until accepted: the proposed scheduled-hours method
    method: 'SCHEDULED_HOURS',
    methodConfirmed: false,
    currency: 'INR',
    // whether people can see their own salary estimate
    employeesSeeOwnEstimate: false,
  },
};

/** The decisions an admin must make or accept before money can be finalised. */
export const SETUP_ITEMS = [
  { key: 'accepted', label: 'Policy version accepted by an administrator (including its proposed defaults)' },
  { key: 'breaksConfirmed', label: 'Lunch and rest breaks: which exist, and whether each is paid' },
  { key: 'methodConfirmed', label: 'Salary method and divisor confirmed by HR or payroll' },
  { key: 'startDate', label: 'The date attendance tracking starts' },
];

/** Which settings are proposed interpretations, shown as such in Settings. */
export const PROPOSED_KEYS = [
  'graceMode', 'offsetWindow',
  'leave.allowanceMode', 'leave.eligibility', 'leave.noticeMode', 'payroll.method',
];

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function mergePolicy(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over || {})) {
    out[key] = isObject(base[key]) && isObject(value) ? mergePolicy(base[key], value) : value;
  }
  return out;
}

/** Creates the first version from the defaults the first time anyone asks. */
async function ensureFirstVersion() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM attendance_policies');
  if (rows[0].n > 0) return;
  await query(
    `INSERT INTO attendance_policies (effective_from, config, note)
     SELECT '2000-01-01', $1::jsonb, 'Initial version from the October 2026 brief — not yet accepted'
      WHERE NOT EXISTS (SELECT 1 FROM attendance_policies)`,
    [JSON.stringify(DEFAULT_POLICY)],
  );
}

const shape = (row) => ({
  ...row,
  effective_from: typeof row.effective_from === 'string' ? row.effective_from : row.effective_from,
  config: mergePolicy(DEFAULT_POLICY, row.config),
});

export async function listPolicies() {
  await ensureFirstVersion();
  const { rows } = await query(
    `SELECT p.*, a.full_name AS accepted_by_name, c.full_name AS created_by_name
       FROM attendance_policies p
       LEFT JOIN users a ON a.id = p.accepted_by
       LEFT JOIN users c ON c.id = p.created_by
      ORDER BY p.effective_from DESC, p.id DESC`,
  );
  return rows.map(shape);
}

/** Every version, oldest first, for resolving many dates at once. */
export async function policyTimeline() {
  const versions = await listPolicies();
  return [...versions].reverse();
}

/** The version in force on a date (YYYY-MM-DD). */
export function policyOn(timeline, date) {
  let current = timeline[0];
  for (const version of timeline) {
    if (version.effective_from <= date) current = version;
  }
  return current;
}

export async function getPolicyFor(date) {
  return policyOn(await policyTimeline(), date);
}

/** The calendar date (YYYY-MM-DD) of an instant in a timezone. */
const businessDate = (timezone, now) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

/**
 * The version in force at an instant, judged by the business date in that
 * version's own timezone. A version scheduled to start later (say, a December
 * change saved in November) is never applied before its date.
 */
export function policyAt(timeline, now = new Date()) {
  const newest = timeline[timeline.length - 1];
  let version = policyOn(timeline, businessDate(newest?.config?.timezone, now));
  // the timezone itself can change between versions: settle on the date as
  // the version in force sees it
  const settled = policyOn(timeline, businessDate(version?.config?.timezone, now));
  if (settled) version = settled;
  return version;
}

/** The version in force today — what new actions (check-in, leave, reminders) are judged by. */
export async function currentPolicy(now = new Date()) {
  return policyAt(await policyTimeline(), now);
}

/**
 * The newest version by effective date, scheduled or not — the base a new
 * version is built from in Settings. Never used to judge attendance or pay.
 */
export async function latestPolicy() {
  const versions = await listPolicies();
  return versions[0];
}

/** The engine's view of a policy: seconds, not strings. */
export function enginePolicy(config) {
  return {
    graceSeconds: (Number(config.graceMinutes) || 0) * 60,
    graceMode: config.graceMode || 'THRESHOLD',
    creditBeforeStart: Boolean(config.creditBeforeStart),
    extraRequiresReview: config.extraRequiresReview !== false,
    maxSessionSeconds: (Number(config.maxSessionHours) || 14) * 3600,
  };
}

export const officeSeconds = (config) => ({ start: clock(config.officeStart), end: clock(config.officeEnd) });

/** What still stands between a version and finalised payroll. */
export function setupStatus(version) {
  const c = version.config;
  const done = {
    accepted: Boolean(version.accepted_at),
    breaksConfirmed: Boolean(c.breaksConfirmed),
    methodConfirmed: Boolean(c.payroll?.methodConfirmed),
    startDate: Boolean(c.startDate),
  };
  return {
    items: SETUP_ITEMS.map((item) => ({ ...item, done: done[item.key] })),
    complete: Object.values(done).every(Boolean),
  };
}
