/**
 * Words and checks for working leads: location, exact call times, reminders
 * and the work queue. Pure, so they are tested without a browser.
 */

export const NOT_PROVIDED = 'Not provided';

// the 36 states and union territories, as the server recognises them
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan',
  'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

export const LOCATION_FIELDS = [
  ['state', 'State'], ['district', 'District'], ['city', 'City, town or village'], ['block', 'Block or tehsil'],
  ['address_line1', 'Address'], ['address_line2', 'Address (line 2)'], ['pincode', 'PIN code'],
];

/** Whether a PIN code has the right shape (six digits, not starting with 0). Shape only: it is not proof of a place. */
export function pinProblem(value) {
  const v = String(value || '').replace(/\s+/g, '');
  if (!v) return null;
  return /^[1-9][0-9]{5}$/.test(v) ? null : 'A PIN code is six digits and does not start with 0';
}

/** "Indore, Indore district, Madhya Pradesh · 452001", or "Not provided". */
export function locationLine(lead) {
  if (!lead) return NOT_PROVIDED;
  const district = lead.district && lead.district !== lead.city ? `${lead.district} district` : null;
  const place = [lead.city, lead.block, district, lead.state].filter(Boolean).join(', ');
  const text = [place, lead.pincode].filter(Boolean).join(' · ');
  return text || NOT_PROVIDED;
}

/** The location rows of a lead, each with "Not provided" where missing. */
export const locationRows = (lead) => LOCATION_FIELDS.map(([k, label]) => [label, lead?.[k] || NOT_PROVIDED, !lead?.[k]]);

/** A call's time to the second, with the timezone: "13 Nov 2026, 5:15:42 pm IST". */
export function exactTime(value, timeZone = 'Asia/Kolkata') {
  if (!value) return '';
  const text = new Date(value).toLocaleString('en-IN', {
    timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
  return `${text} ${timeZone === 'Asia/Kolkata' ? 'IST' : timeZone}`;
}

/** "4m 05s", "45s", "—". */
export function durationWords(sec) {
  if (sec === null || sec === undefined || sec === '') return '—';
  const s = Math.max(0, Math.round(Number(sec)));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export const RECORDED_VIA = {
  OUTCOME_FORM: 'How did the call go?', LOG_CALL: 'Log call', FOLLOWUP: 'Completed follow-up', IMPORT: 'Imported',
};

export const REMINDER_OFFSETS = [30, 15, 10, 5];
export const REMINDER_STATUS = {
  PENDING: ['Planned', 'neutral'], SENDING: ['Sending', 'brand'], SENT: ['Sent', 'good'], FAILED: ['Not sent', 'critical'],
  CANCELLED: ['Cancelled', 'neutral'], SKIPPED: ['Skipped', 'neutral'],
};
export const CHANNEL_LABEL = { APP: 'In TaskFlow', CHAT: 'Google Chat' };

/** "30, 15 and 5 minutes before, in TaskFlow and Google Chat"; "No reminders". */
export function reminderWords(offsets, channels) {
  const o = [...new Set(offsets || [])].sort((a, b) => b - a);
  if (!o.length) return 'No reminders';
  const list = o.length === 1 ? `${o[0]}` : `${o.slice(0, -1).join(', ')} and ${o[o.length - 1]}`;
  const where = (channels || []).map((c) => CHANNEL_LABEL[c]).filter(Boolean);
  return `${list} minutes before${where.length ? `, ${where.join(' and ')}` : ''}`;
}

/** Where a follow-up stands against now: due now (within five minutes), overdue, or ahead. */
export function dueState(dueAt, now = Date.now()) {
  if (!dueAt) return null;
  const diff = new Date(dueAt).getTime() - now;
  if (diff < -5 * 60_000) return 'OVERDUE';
  if (diff <= 5 * 60_000) return 'DUE_NOW';
  return 'AHEAD';
}

/** The difference between the three things people mix up on a call. */
export const STATUS_EXPLAINED = [
  ['Call outcome', 'What happened on this call: no answer, busy, spoke to them, interested…'],
  ['Lead stage', 'Where the lead stands overall: new, contacted, qualifying, qualified, won or lost.'],
  ['Deal stage', 'Where a sale stands once the lead becomes a deal: proposal, negotiation, won.'],
];
export const NO_AUTOMATIC_WIN = 'A call never marks a lead won or creates revenue by itself. "Won" is a step someone takes on purpose.';

/**
 * Attempts on a lead that have no call record: the lead's attempt count is
 * raised by each outbound call (and lowered when a repeat is marked), so
 * anything beyond the outbound calls on record came in with an import.
 */
export function importedAttempts(lead, calls = []) {
  const outbound = calls.filter((c) => !c.voided_at && c.direction === 'OUTBOUND').length;
  return Math.max((lead?.call_attempts || 0) - outbound, 0);
}
