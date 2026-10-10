/**
 * Pipeline reminders, on each person's terms.
 *
 *   - **When:** each person picks the time and the days their digest arrives
 *     (India time); without a choice, the organization's default applies.
 *   - **Leave:** nobody is reminded on a day they are away. What cannot wait —
 *     a next action due before they are back — goes to the deal's escalation
 *     point instead, as a "covering for" digest, if they have said that is fine.
 *   - **Once:** at most one digest a day each (and one cover digest a day for
 *     each person covered), and a digest with nothing new in it is not sent
 *     again for a few days. Two scanners running at once cannot both send: the
 *     database allows one row a day.
 *   - **Paused:** a person can pause their reminders for a short, dated spell.
 */

import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { addDays, orgCalendar } from './availability.js';
import { getSettings } from './settings.js';

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The weekday (Monday 1 … Sunday 7), HH:MM and date in India at an instant. */
export function indiaNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return {
    weekday: WEEKDAY[parts.weekday],
    time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** The organization's working days as Monday 1 … Sunday 7 (its calendar stores Sunday as 0). */
async function workingDays() {
  const { workingDays: days } = await orgCalendar();
  return (days || [1, 2, 3, 4, 5]).map((d) => (d === 0 ? 7 : d)).sort();
}

/** What applies to someone with no choices of their own. */
export async function reminderDefaults() {
  const settings = await getSettings();
  const r = settings.crm?.reminders || {};
  return {
    digest_time: TIME.test(String(r.digestTime)) ? r.digestTime : '09:30',
    digest_days: Array.isArray(r.digestDays) && r.digestDays.length ? r.digestDays : await workingDays(),
    paused_until: null,
    pause_reason: null,
    cover_while_away: true,
    repeat_same_days: Number(r.repeatSameDays) || 3,
    max_pause_days: Number(r.maxPauseDays) || 30,
  };
}

/** Everyone's preferences, as a map; people with none get the defaults. */
export async function allPreferences() {
  const defaults = await reminderDefaults();
  const { rows } = await query('SELECT * FROM reminder_preferences');
  const map = new Map(rows.map((row) => [row.user_id, {
    ...defaults, ...row, paused_until: row.paused_until ? String(row.paused_until).slice(0, 10) : null, is_default: false,
  }]));
  return { defaults, get: (userId) => map.get(userId) || { ...defaults, user_id: userId, is_default: true } };
}

export async function myPreferences(userId) {
  return (await allPreferences()).get(userId);
}

/** Saves someone's own choices. A pause is dated, short, and says why. */
export async function setMyPreferences(userId, input, { todayDate }) {
  const defaults = await reminderDefaults();
  const time = input.digest_time ?? defaults.digest_time;
  if (!TIME.test(String(time))) throw badRequest('Use a time like 09:30');
  const days = input.digest_days ?? defaults.digest_days;
  if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw badRequest('Pick at least one day for your reminders');
  }
  let paused = input.paused_until ?? null;
  let why = input.pause_reason ?? null;
  if (paused) {
    if (paused < todayDate) throw badRequest('The pause would already be over');
    if (paused > addDays(todayDate, defaults.max_pause_days)) {
      throw badRequest(`Reminders can be paused for at most ${defaults.max_pause_days} days — for leave, book the leave and they stop by themselves`);
    }
    if (String(why || '').trim().length < 3) throw badRequest('Say why reminders are paused');
    why = String(why).trim();
  } else {
    paused = null;
    why = null;
  }
  const { rows } = await query(
    `INSERT INTO reminder_preferences (user_id, digest_time, digest_days, paused_until, pause_reason, cover_while_away)
     VALUES ($1, $2, $3::smallint[], $4::date, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       digest_time = EXCLUDED.digest_time, digest_days = EXCLUDED.digest_days,
       paused_until = EXCLUDED.paused_until, pause_reason = EXCLUDED.pause_reason,
       cover_while_away = EXCLUDED.cover_while_away, updated_at = now()
     RETURNING *`,
    [userId, time, [...new Set(days)].sort(), paused, why, input.cover_while_away ?? true],
  );
  return { ...defaults, ...rows[0], paused_until: rows[0].paused_until ? String(rows[0].paused_until).slice(0, 10) : null, is_default: false };
}

/**
 * Whether a person's digest is due at this moment, and if not, why not. Pure,
 * so the schedule can be tested at any hour.
 */
export function digestDue(pref, clock, { away = false, ignoreSchedule = false } = {}) {
  if (pref.paused_until && pref.paused_until >= clock.date) return { due: false, why: 'paused' };
  if (away) return { due: false, why: 'away' };
  if (ignoreSchedule) return { due: true };
  if (!pref.digest_days.includes(clock.weekday)) return { due: false, why: 'not a reminder day' };
  if (clock.time < pref.digest_time) return { due: false, why: 'not yet time' };
  return { due: true };
}

/** A stable fingerprint of what a digest says, so an unchanged one is recognised. */
export function fingerprintOf(signals) {
  const keys = signals.map((s) => `${s.entity_type}:${s.entity_id}:${s.kind}`).sort();
  return crypto.createHash('sha1').update(keys.join('|')).digest('hex');
}

/** Whether this digest would only repeat the last one, sent recently. */
export function onlyRepeats(last, fingerprint, todayDate, repeatDays) {
  if (!last || last.fingerprint !== fingerprint) return false;
  const since = Math.round((Date.parse(`${todayDate}T00:00:00Z`) - Date.parse(`${String(last.sent_on).slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  return since < repeatDays;
}

/**
 * Sends one reminder, at most once per person, kind and day (and person
 * covered). Returns the notification, or null if one was already sent.
 */
export async function sendReminderOnce({
  userId, kind, sentOn, coveringFor = null, fingerprint, signalCount, type, title, body, accountId = null,
}) {
  const { rows: log } = await query(
    `INSERT INTO crm_reminder_log (user_id, kind, sent_on, covering_for, fingerprint, signal_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, kind, sentOn, coveringFor, fingerprint, signalCount],
  );
  if (!log[0]) return null;
  const { rows } = await query(
    `INSERT INTO notifications (user_id, type, title, body, account_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, type, title, body, accountId],
  );
  await query('UPDATE crm_reminder_log SET notification_id = $1 WHERE id = $2', [rows[0].id, log[0].id]);
  return rows[0];
}

/** The last digest each person was sent. */
export async function lastDigests() {
  const { rows } = await query(
    `SELECT DISTINCT ON (user_id) user_id, fingerprint, sent_on, created_at
       FROM crm_reminder_log WHERE kind = 'DIGEST'
      ORDER BY user_id, created_at DESC`,
  );
  return new Map(rows.map((r) => [r.user_id, r]));
}

/** What was sent to someone lately, newest first. */
export async function recentReminders(userId, limit = 10) {
  const { rows } = await query(
    `SELECT l.kind, l.sent_on, l.signal_count, l.created_at, l.covering_for, c.full_name AS covering_for_name,
            n.title
       FROM crm_reminder_log l
       LEFT JOIN users c ON c.id = l.covering_for
       LEFT JOIN notifications n ON n.id = l.notification_id
      WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}
