/**
 * What every part of email marketing shares: its settings, public addresses,
 * tokens, the email-address rule, consent records and the suppression list.
 */

import crypto from 'node:crypto';
import { config } from '../../config.js';
import { query } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { getSettings } from '../settings.js';

export async function marketingSettings() {
  const all = await getSettings();
  return all.marketing;
}

/** The public base every tracking, unsubscribe and form address starts with. */
export const publicBase = () => `${config.publicUrl}${config.apiPrefix}/m`;

export const newToken = () => crypto.randomBytes(24).toString('base64url');
// short and unambiguous, because it sits in a Reply-To address
export const newReplyCode = () => crypto.randomBytes(8).toString('hex');

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** The one form of an address a person is matched on: trimmed and lower case. */
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  if (email.length > 254 || !EMAIL.test(email)) return false;
  const [local, domain] = email.split('@');
  return local.length <= 64 && !domain.endsWith('.') && /\.[a-z]{2,}$/.test(domain);
}

export function requireEmail(value) {
  if (!isValidEmail(value)) throw badRequest(`"${String(value ?? '').slice(0, 80)}" is not an email address`);
  return normalizeEmail(value);
}

export const domainOf = (email) => normalizeEmail(email).split('@')[1] || '';

/** Appends to the consent record. Never updated or deleted. */
export async function recordConsent(client, {
  contactId, audienceId = null, topicId = null, action, source, basis = null, consentText = null,
  ip = null, userAgent = null, actorId = null, meta = {},
}) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO mkt_consents (contact_id, audience_id, topic_id, action, source, basis, consent_text, ip, user_agent, actor_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [contactId, audienceId, topicId, action, source, basis, consentText, ip ? String(ip).slice(0, 64) : null,
      userAgent ? String(userAgent).slice(0, 300) : null, actorId, meta],
  );
}

/** A contact's non-email history, which automations start from. */
export async function logContactActivity(client, contactId, type, { audienceId = null, data = {}, actorId = null } = {}) {
  const runner = client || { query };
  await runner.query(
    'INSERT INTO mkt_contact_activity (contact_id, type, audience_id, data, actor_id) VALUES ($1,$2,$3,$4,$5)',
    [contactId, type, audienceId, data, actorId],
  );
}

export async function isSuppressed(client, email) {
  const runner = client || { query };
  const { rows } = await runner.query('SELECT reason FROM mkt_suppressions WHERE email_normalized = $1', [normalizeEmail(email)]);
  return rows[0]?.reason || null;
}

/** Adds an address to the suppression list; the first reason given is kept. */
export async function suppress(client, email, { reason, source, note = null, actorId = null }) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO mkt_suppressions (email_normalized, reason, source, note, created_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email_normalized) DO NOTHING`,
    [normalizeEmail(email), reason, source, note, actorId],
  );
}

export const STATUS_WORDS = {
  SUBSCRIBED: 'Subscribed',
  PENDING: 'Waiting for confirmation',
  UNSUBSCRIBED: 'Unsubscribed',
  CLEANED: 'Removed after bouncing',
  ARCHIVED: 'No longer on this audience',
};

/** India time, as the organisation counts days. */
export function localParts(date = new Date(), timeZone = 'Asia/Kolkata') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** The instant a local date and hour in the organisation's timezone falls at (IST has no DST). */
export function instantAtLocal(date, hour, timeZone = 'Asia/Kolkata') {
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const local = localParts(guess, timeZone);
  const offsetHours = (local.hour - hour + 24) % 24;
  const minutes = local.minute;
  return new Date(guess.getTime() - offsetHours * 3_600_000 - minutes * 60_000);
}

export const firstName = (name) => (name ? String(name).trim().split(/\s+/)[0] : '');
