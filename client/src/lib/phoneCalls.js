/**
 * Calls on company phones: the small decisions the screens make, kept apart
 * so they can be tested on their own.
 */

/** Where a call's length came from, in words. */
export const LENGTH_SOURCE = {
  DEVICE_LOG: ['from the phone', 'good'],
  RECORDING: ['from the recording', 'good'],
  TYPED: ['typed', 'neutral'],
  ESTIMATED: ['estimated', 'warning'],
  CORRECTED: ['corrected', 'neutral'],
};

/** "3m 12s · from the phone", "About 4 min · estimated", "—". */
export function lengthWords(sec, source) {
  if (sec === null || sec === undefined || sec === '') return '—';
  const s = Math.max(0, Math.round(Number(sec)));
  const m = Math.floor(s / 60);
  const exact = m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  if (source === 'ESTIMATED') return `About ${estimateMinutes(s)} min · estimated`;
  const label = LENGTH_SOURCE[source]?.[0];
  return label ? `${exact} · ${label}` : exact;
}

/** Whole minutes, at least one, for an estimate in words. */
export const estimateMinutes = (sec) => Math.max(1, Math.round(Number(sec) / 60));

/**
 * The length estimated from the time away from TaskFlow after dialling: from
 * when the page was hidden (or, if that was missed, when the dialler opened)
 * until it came back. Null when it cannot be told.
 */
export function estimateFromAway({ dialledAt, hiddenAt = null, visibleAt = null }) {
  const from = hiddenAt ?? dialledAt;
  if (!from || !visibleAt) return null;
  const ms = new Date(visibleAt).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 5000) return null;
  // more than three hours away is not a call
  if (ms > 3 * 3600_000) return null;
  return Math.round(ms / 1000);
}

/** A number as a tel: link: digits and a leading +. */
export function telHref(phone) {
  const raw = String(phone || '').trim();
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 6 ? `tel:${plus}${digits}` : null;
}

/** How a Call button will dial: through the TaskFlow Android app, the phone's dialler, or not at all. */
export function callPath({ bridge, phone }) {
  if (!telHref(phone)) return 'NONE';
  return bridge ? 'APP' : 'DIALLER';
}

/** What the server's refusals mean, for the person who tapped Call. */
export const REFUSAL = {
  OPTED_OUT: 'This number asked not to be called.',
  DAILY_CAP: 'Already tried the most times allowed today.',
  OUTSIDE_HOURS: 'Outside calling hours.',
};

/** Why a call was allowed past a limit. */
export const CALLBACK_REASON = {
  ASKED_CALLBACK: 'A callback they asked for',
  THEY_CALLED: 'They called the company',
};

/**
 * For a recording shared from the phone: the call it most likely belongs to.
 * A recording file is usually last modified when its call ended, so the call
 * whose end is nearest wins; calls that already have a recording are skipped.
 * Returns the call id, or null when nothing fits within two hours.
 */
export function suggestCall(calls, fileModifiedAt) {
  const t = new Date(fileModifiedAt).getTime();
  if (!Number.isFinite(t)) return calls.find((c) => !c.has_recording)?.id ?? null;
  let best = null;
  for (const c of calls) {
    if (c.has_recording) continue;
    const start = new Date(c.started_at || c.dialled_at).getTime();
    if (!Number.isFinite(start)) continue;
    const end = start + (Number(c.talk_sec) || 0) * 1000;
    const gap = t < start ? start - t + 600_000 : Math.abs(t - end);
    if (gap <= 2 * 3600_000 && (!best || gap < best.gap)) best = { id: c.id, gap };
  }
  return best?.id ?? null;
}

/** The phone-call target of a record, as the server takes it. */
export function targetKey(target = {}) {
  if (target.lead_id) return `lead:${target.lead_id}`;
  if (target.opportunity_id) return `deal:${target.opportunity_id}`;
  if (target.contact_id) return `contact:${target.contact_id}`;
  if (target.account_id) return `account:${target.account_id}`;
  return null;
}

/** Whether an active call belongs to a record (a deal's call also belongs to its organization). */
export function sameTarget(callTarget = {}, target = {}) {
  if (!callTarget || !target) return false;
  if (target.lead_id) return callTarget.lead_id === target.lead_id;
  if (target.opportunity_id) return callTarget.opportunity_id === target.opportunity_id;
  if (target.account_id) return callTarget.account_id === target.account_id;
  if (target.contact_id) return callTarget.contact_id === target.contact_id;
  return false;
}

/**
 * The make of phone, for its own setup steps: Samsung, the OPPO family
 * (ColorOS, where ODialer runs) or Motorola. Null for any other make, whose
 * recording an administrator confirms.
 */
export function brandOf(maker) {
  const m = String(maker || '').toLowerCase();
  if (m.includes('samsung')) return 'samsung';
  if (['oppo', 'oneplus', 'realme'].some((b) => m.includes(b))) return 'oppo';
  if (m.includes('motorola') || m === 'moto') return 'motorola';
  return null;
}
