/**
 * Attendance on the client: labels, time display, and reading the device's
 * location for a check-in.
 *
 * Times are always shown in the organisation's timezone (Asia/Kolkata by
 * default), whatever the phone is set to, and durations are always H:MM —
 * 8 hours 30 minutes is "8:30", never "8.30".
 */

export const PRIVACY_NOTICE =
  'Task Flow records your current location when you check in and check out for attendance. It does not continuously track your location.';

/** 30 600 seconds → "8:30". */
export function hhmm(seconds, { signed = false } = {}) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const negative = seconds < 0;
  const total = Math.round(Math.abs(seconds) / 60);
  const text = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  if (negative) return `−${text}`;
  return signed && seconds > 0 ? `+${text}` : text;
}

/** A spoken duration for sentences: "8 h 30 min". */
export function words(seconds) {
  if (!seconds) return '0 min';
  const total = Math.round(Math.abs(seconds) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min';
}

/** "09:04" for an instant, in the attendance timezone. */
export function clockIn(value, timezone = 'Asia/Kolkata') {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

/** "Thu 1 Oct" for a YYYY-MM-DD date, read as a calendar date. */
export function dayName(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T00:00:00Z`));
}

export function monthName(month) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}

export function shiftMonth(month, by) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + by;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}

export const todayIn = (timezone = 'Asia/Kolkata') =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** What a day was, in words a person would use, with a tone for the badge. */
export const DAY_META = {
  ATTENDED: { label: 'Attended', tone: 'good' },
  ATTENDED_WITH_PARTIAL_LEAVE: { label: 'Attended, part leave', tone: 'good' },
  IN_PROGRESS: { label: 'Checked in', tone: 'brand' },
  NOT_CHECKED_IN: { label: 'Not checked in', tone: 'neutral' },
  UPCOMING: { label: 'Upcoming', tone: 'neutral' },
  PAID_LEAVE: { label: 'Paid leave', tone: 'brand' },
  UNPAID_LEAVE: { label: 'Unpaid leave', tone: 'warning' },
  PARTIAL_LEAVE: { label: 'Part leave', tone: 'brand' },
  PENDING_LEAVE: { label: 'Leave pending', tone: 'warning' },
  UNAPPROVED_ABSENCE: { label: 'Unapproved absence', tone: 'critical' },
  UNRECORDED_NEEDS_REVIEW: { label: 'Unrecorded — needs review', tone: 'warning' },
  MISSING_CHECKOUT: { label: 'Missing check-out', tone: 'critical' },
  WEEKLY_OFF: { label: 'Weekly off', tone: 'neutral' },
  HOLIDAY: { label: 'Holiday', tone: 'neutral' },
  NOT_EMPLOYED: { label: 'Not employed', tone: 'neutral' },
  BEFORE_START: { label: 'Before tracking started', tone: 'neutral' },
};

export const dayMeta = (classification) => DAY_META[classification] || { label: classification || '—', tone: 'neutral' };

export const FLAG_LABEL = {
  LATE: 'Late',
  WITHIN_GRACE: 'Within grace',
  EARLY_DEPARTURE: 'Left early',
  LONG_SESSION: 'Unusually long',
  MANUALLY_REGULARIZED: 'Manually regularised',
  WORKED_DURING_PAID_LEAVE: 'Worked during paid leave',
  MISSING_CHECKOUT: 'Missing check-out',
  WORKED_ON_NON_WORKING_DAY: 'Worked on a day off',
  LOW_ACCURACY: 'Low location accuracy (in)',
  LOW_ACCURACY_OUT: 'Low location accuracy (out)',
};

export const BLOCKER_LABEL = {
  UNRECORDED: 'No attendance and no review',
  MISSING_CHECKOUT: 'Missing check-out',
  PENDING_LEAVE: 'Leave still pending',
  EXTRA_PENDING: 'Extra time not reviewed',
  MONTH_NOT_OVER: 'Month not over',
};

export const CORRECTION_KINDS = [
  { value: 'MISSED_CHECK_IN', label: 'I forgot to check in', needs: ['in'] },
  { value: 'MISSED_CHECK_OUT', label: 'I forgot to check out', needs: ['out'] },
  { value: 'WRONG_TIME', label: 'A time is wrong', needs: [] },
  { value: 'TECHNICAL', label: 'Location or technical problem', needs: ['in'] },
  { value: 'FIELD_DUTY', label: 'Field duty / working away', needs: ['in'] },
  { value: 'REOPEN', label: 'Reopen today (checked out by mistake)', needs: [] },
];
export const CORRECTION_LABEL = Object.fromEntries(CORRECTION_KINDS.map((k) => [k.value, k.label]));

export const CORRECTION_STATUS = {
  PENDING: { label: 'Pending', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'good' },
  REJECTED: { label: 'Not approved', tone: 'critical' },
  CANCELLED: { label: 'Withdrawn', tone: 'neutral' },
};

export const LEAVE_STATUS = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUBMITTED: { label: 'Pending approval', tone: 'warning' },
  EMERGENCY_REVIEW: { label: 'Emergency — under review', tone: 'warning' },
  NOTICE_EXCEPTION: { label: 'Short notice — needs a decision', tone: 'serious' },
  APPROVED_PAID: { label: 'Approved — paid', tone: 'good' },
  APPROVED_UNPAID: { label: 'Approved — unpaid', tone: 'brand' },
  REJECTED: { label: 'Not approved', tone: 'critical' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};
export const PENDING_LEAVE = ['SUBMITTED', 'EMERGENCY_REVIEW', 'NOTICE_EXCEPTION'];

export const LEAVE_CATEGORIES = [
  { value: 'CASUAL', label: 'Casual' },
  { value: 'SICK', label: 'Sick' },
  { value: 'UNPAID', label: 'Unpaid' },
  { value: 'STATUTORY', label: 'Statutory' },
  { value: 'OTHER', label: 'Other' },
];
export const DAY_PART = { FULL: 'Full day', FIRST_HALF: 'First half', SECOND_HALF: 'Second half' };

export const PAYROLL_STATUS = {
  NEEDS_SETUP: { label: 'Needs setup', tone: 'serious' },
  PROVISIONAL: { label: 'Provisional', tone: 'warning' },
  READY: { label: 'Ready to submit', tone: 'brand' },
};
export const RECORD_STATUS = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  IN_REVIEW: { label: 'In review', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'brand' },
  LOCKED: { label: 'Locked', tone: 'good' },
  SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
};

export const money = (value, currency = 'INR') => (value === null || value === undefined ? '—'
  : new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value));

/** A fresh id for one attendance action, so a retry is recognised as the same one. */
export function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Why a location could not be read, in plain words, with what to do next. */
export const LOCATION_PROBLEM = {
  UNSUPPORTED: 'This browser cannot share a location. Use a phone or a recent version of Chrome, Edge, Safari or Firefox — or ask for a correction.',
  DENIED: 'Location permission is turned off for TaskFlow. Allow location for this site in your browser settings, then try again. If you cannot, ask for a correction.',
  UNAVAILABLE: 'Your device could not find its location. Move near a window or turn on location services, then try again.',
  TIMEOUT: 'Finding your location took too long. Try again — it is often quicker the second time.',
  INSECURE: 'Location only works on a secure (https) connection.',
  NO_ANSWER: 'Your browser has not shared a location yet. Look for a location permission prompt near the address bar, allow it, then try again.',
};

/**
 * Reads the current position once — high accuracy, never a cached reading.
 * Resolves { latitude, longitude, accuracy, timestamp } or rejects with
 * { code } from LOCATION_PROBLEM. Nothing is ever invented as a fallback.
 */
export function readLocation({
  timeoutSeconds = 15,
  // the browser's own timeout only starts once permission is given; an
  // unanswered permission prompt would otherwise wait for ever
  watchdogSeconds = timeoutSeconds + 25,
  geolocation = typeof navigator !== 'undefined' ? navigator.geolocation : null,
  secure = typeof window === 'undefined' || window.isSecureContext !== false,
} = {}) {
  return new Promise((resolveOuter, rejectOuter) => {
    if (!secure) { rejectOuter({ code: 'INSECURE' }); return; }
    if (!geolocation) { rejectOuter({ code: 'UNSUPPORTED' }); return; }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; rejectOuter({ code: 'NO_ANSWER' }); } }, watchdogSeconds * 1000);
    const resolve = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolveOuter(v); } };
    const reject = (e) => { if (!settled) { settled = true; clearTimeout(timer); rejectOuter(e); } };
    geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: position.timestamp,
      }),
      (error) => reject({ code: error?.code === 1 ? 'DENIED' : error?.code === 3 ? 'TIMEOUT' : 'UNAVAILABLE' }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutSeconds * 1000 },
    );
  });
}

/** A link the person chooses to open; nothing is sent anywhere until they do. */
export const mapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
