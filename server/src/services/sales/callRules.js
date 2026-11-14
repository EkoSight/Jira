/**
 * Whether a call may go out now, checked the same way whichever button starts
 * it (the lead page, the Calling screen, My Day, a deal, a contact, or the
 * Android app):
 *
 *   opt-out       a number that asked not to be called is refused, unless it
 *                 called the company in the last 24 hours ("they called you")
 *   daily cap     at most N attempts on a lead (or number) per day, retries
 *                 included; a callback the lead asked for may go past it
 *   calling hours outside them a call needs a reason, unless it is a callback
 *                 the lead asked for or they called in the last 24 hours
 *
 * Nothing here dials anything: it answers yes (with labels to record on the
 * call) or refuses with a code the screens explain.
 */
import { query } from '../../db/pool.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { isOptedOut } from './comms.js';
import { localParts, normalizePhone, salesSettings, workCalendar } from './core.js';

const toMinutes = (hm, fallback) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

/** Whether an instant is inside calling hours, and the hours in words. */
export async function callingHoursCheck(at = new Date(), settings = null) {
  const s = settings || await salesSettings();
  const hours = s.calls?.callingHours || {};
  const tz = s.calendar?.timezone || 'Asia/Kolkata';
  const start = toMinutes(hours.start, 9 * 60);
  const end = toMinutes(hours.end, 21 * 60);
  const p = localParts(at, tz);
  const minutes = p.hour * 60 + p.minute;
  const window = `${hours.start || '09:00'}–${hours.end || '21:00'}${hours.workingDaysOnly === false ? '' : ' on working days'}`;
  if (hours.workingDaysOnly !== false) {
    const cal = await workCalendar();
    if (!cal.isWorkingDay(p.date)) return { ok: false, window, why: 'Today is not a working day.' };
  }
  if (minutes < start || minutes >= end) return { ok: false, window, why: `It is ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} now.` };
  return { ok: true, window };
}

/** A Call-back follow-up on the lead due within two hours either side: the lead asked for this call. */
async function askedCallback(runner, leadId, at) {
  if (!leadId) return null;
  const { rows } = await runner.query(
    `SELECT id, due_date FROM tasks
      WHERE crm_lead_id = $1 AND followup_kind = 'CALLBACK' AND completed_at IS NULL AND is_archived = FALSE AND crm_cancel_reason IS NULL
        AND due_date BETWEEN $2::timestamptz - interval '2 hours' AND $2::timestamptz + interval '2 hours'
      ORDER BY due_date LIMIT 1`,
    [leadId, at],
  );
  return rows[0] || null;
}

/** Outbound attempts on a lead (or, without a lead, a number) since the start of today. */
export async function attemptsToday(runner, { leadId = null, phone = null, at = new Date(), timezone = 'Asia/Kolkata' }) {
  const { rows } = await runner.query(
    `SELECT COUNT(*)::int AS n FROM crm_calls c
      WHERE c.direction = 'OUTBOUND' AND c.voided_at IS NULL
        AND ${leadId ? 'c.lead_id = $3' : 'c.counterpart_normalized = $3'}
        AND COALESCE(c.dialled_at, c.started_at, c.created_at) >= date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2`,
    [at, timezone, leadId || phone],
  );
  return rows[0].n;
}

/**
 * Checks a call before it starts. Returns the labels to keep on the call
 * ({ callbackReason, hoursOverrideReason }) or throws a 409 with a code:
 * OPTED_OUT, DAILY_CAP or OUTSIDE_HOURS.
 */
export async function callPermit({ phone, leadId = null, overrideReason = null, at = new Date(), runner = { query } }) {
  const settings = await salesSettings();
  const calls = settings.calls || {};
  const timezone = settings.calendar?.timezone || 'Asia/Kolkata';
  const number = normalizePhone(phone);
  if (!number) throw badRequest('That is not a phone number');
  const out = { phone: number, callbackReason: null, hoursOverrideReason: null };
  const asked = await askedCallback(runner, leadId, at);

  if (await isOptedOut('CALL', number, runner)) {
    const { rows } = await runner.query(
      `SELECT 1 FROM crm_calls WHERE direction = 'INBOUND' AND counterpart_normalized = $1
          AND COALESCE(started_at, created_at) BETWEEN $2::timestamptz - interval '24 hours' AND $2::timestamptz LIMIT 1`,
      [number, at],
    );
    if (!rows[0]) {
      throw conflict('This number asked not to be called. Only an administrator can lift that, with a reason.', { code: 'OPTED_OUT' });
    }
    out.callbackReason = 'THEY_CALLED';
  }

  const cap = Number(calls.dailyAttemptCap) || 0;
  if (cap > 0) {
    const n = await attemptsToday(runner, { leadId, phone: number, at, timezone });
    if (n >= cap) {
      if (asked) out.callbackReason = out.callbackReason || 'ASKED_CALLBACK';
      else if (out.callbackReason !== 'THEY_CALLED') {
        throw conflict(`Already tried ${n} times today; the most is ${cap}. Try again tomorrow, or book a callback if they asked for one.`, { code: 'DAILY_CAP', attempts: n, cap });
      }
    }
  }

  const hours = await callingHoursCheck(at, settings);
  if (!hours.ok) {
    if (asked) out.callbackReason = out.callbackReason || 'ASKED_CALLBACK';
    else if (out.callbackReason !== 'THEY_CALLED') {
      const why = String(overrideReason || '').trim();
      if (why.length < 3) {
        throw conflict(`Calls go out ${hours.window}. ${hours.why} Say why this call cannot wait, or call during calling hours.`, { code: 'OUTSIDE_HOURS', window: hours.window });
      }
      out.hoursOverrideReason = why.slice(0, 300);
    }
  }
  return out;
}
