/**
 * Reading a person's own Gmail and Calendar for correspondence with known
 * contacts — only for people who switch it on, and only after an admin has
 * turned it on and granted the access in Google Workspace.
 *
 * What it reads is narrow on purpose: messages to or from an address at an
 * organization in the pipeline (headers and Google's short snippet, never the
 * full message or attachments), and calendar events with someone from such an
 * organization invited. Each becomes a suggestion only that person sees, and
 * nothing reaches a deal until they confirm it. Personal mail that matches no
 * organization is never stored.
 */

import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { chatConfig, workspaceApi } from '../lib/googleChat.js';
import { getSettings } from './settings.js';
import { domainOf, ownDomains, suggestFromEmail, suggestFromEvent } from './correspondence.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

const WEBMAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|live|rediffmail|icloud|me|aol|protonmail|proton|zoho|ymail)\./;

/** Whether reading mailboxes is possible at all here, and why not if it is not. */
export async function syncAvailability() {
  const settings = await getSettings();
  const cfg = chatConfig();
  if (!settings.crm?.mailboxSync?.enabled) return { available: false, reason: 'An admin has not turned on reading Gmail and Calendar' };
  if (!cfg.usable) return { available: false, reason: 'The Google service account is not set up on the server' };
  return { available: true, reason: null, lookbackDays: Number(settings.crm.mailboxSync.lookbackDays) || 3 };
}

export async function mySyncSettings(userId) {
  const { rows } = await query('SELECT * FROM crm_mailbox_sync WHERE user_id = $1', [userId]);
  return rows[0] || { user_id: userId, gmail_enabled: false, calendar_enabled: false, last_synced_at: null, last_error: null };
}

export async function setMySyncSettings(userId, { gmail_enabled: gmail, calendar_enabled: calendar }) {
  const { rows } = await query(
    `INSERT INTO crm_mailbox_sync (user_id, gmail_enabled, calendar_enabled)
     VALUES ($1, COALESCE($2, FALSE), COALESCE($3, FALSE))
     ON CONFLICT (user_id) DO UPDATE
       SET gmail_enabled = COALESCE($2, crm_mailbox_sync.gmail_enabled),
           calendar_enabled = COALESCE($3, crm_mailbox_sync.calendar_enabled),
           updated_at = now()
     RETURNING *`,
    [userId, gmail ?? null, calendar ?? null],
  );
  return rows[0];
}

/** The addresses and domains of the organizations in the pipeline. */
async function knownCorrespondents() {
  const { rows } = await query(
    `SELECT DISTINCT LOWER(c.email) AS email FROM account_contacts c
       JOIN accounts a ON a.id = c.account_id
      WHERE a.is_archived = FALSE AND c.is_active = TRUE AND c.email LIKE '%@%'`,
  );
  const addresses = rows.map((r) => r.email);
  const domains = [...new Set(addresses.map(domainOf))].filter((d) => d && !WEBMAIL.test(d));
  // a webmail address is searched for exactly; a company domain as a whole
  const exact = addresses.filter((a) => WEBMAIL.test(domainOf(a)));
  return [...domains, ...exact];
}

const header = (message, name) =>
  message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

const unescapeHtml = (text) => String(text || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const addresses = (text) => [...new Set((String(text || '').match(ADDRESS) || []).map((a) => a.toLowerCase()))];

/** Reads one person's mailbox and calendar into suggestions. */
export async function syncMailbox(user, { now = new Date() } = {}) {
  const availability = await syncAvailability();
  if (!availability.available) throw badRequest(availability.reason);
  const mine = await mySyncSettings(user.id);
  if (!mine.gmail_enabled && !mine.calendar_enabled) throw badRequest('Switch on Gmail or Calendar first');

  const own = await ownDomains();
  const result = { emails: 0, events: 0, skipped: 0 };
  const lookback = availability.lookbackDays;

  try {
    if (mine.gmail_enabled) {
      const terms = await knownCorrespondents();
      const ids = new Set();
      for (let i = 0; i < terms.length; i += 15) {
        const chunk = terms.slice(i, i + 15);
        const q = `newer_than:${lookback}d {${chunk.map((t) => `from:${t} to:${t} cc:${t}`).join(' ')}}`;
        const list = await workspaceApi(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(q)}`,
          { scope: GMAIL_SCOPE, subject: user.email },
        );
        for (const m of list.messages || []) ids.add(m.id);
      }
      for (const id of [...ids].slice(0, 100)) {
        const message = await workspaceApi(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata`
          + '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject'
          + '&metadataHeaders=Date&metadataHeaders=Message-ID',
          { scope: GMAIL_SCOPE, subject: user.email },
        );
        const from = addresses(header(message, 'From'));
        if (!from.length) continue;
        const outcome = await suggestFromEmail(user.id, {
          ref: header(message, 'Message-ID') || `gmail:${id}`,
          from: from[0],
          to: addresses(header(message, 'To')),
          cc: addresses(header(message, 'Cc')),
          date: message.internalDate ? new Date(Number(message.internalDate)) : null,
          subject: header(message, 'Subject') || null,
          text: unescapeHtml(message.snippet),
        }, { source: 'GMAIL', requireMatch: true, domains: own });
        if (outcome.suggestion) result.emails += 1; else result.skipped += 1;
      }
    }

    if (mine.calendar_enabled) {
      const from = new Date(now.getTime() - lookback * 86_400_000).toISOString();
      const to = new Date(now.getTime() + 7 * 86_400_000).toISOString();
      const events = await workspaceApi(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=100`
        + `&timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}`,
        { scope: CALENDAR_SCOPE, subject: user.email },
      );
      for (const event of events.items || []) {
        const start = event.start?.dateTime || (event.start?.date ? `${event.start.date}T09:00:00+05:30` : null);
        if (!start) continue;
        const outcome = await suggestFromEvent(user.id, {
          ref: `gcal:${event.iCalUID || event.id}${event.recurringEventId ? `#${event.originalStartTime?.dateTime || event.originalStartTime?.date || event.id}` : ''}`,
          summary: event.summary || 'Meeting',
          description: String(event.description || '').slice(0, 2000),
          location: event.location || null,
          start: new Date(start),
          end: event.end?.dateTime ? new Date(event.end.dateTime) : null,
          cancelled: event.status === 'cancelled',
          zone: null,
          attendees: [...new Set([...(event.attendees || []).map((a) => String(a.email || '').toLowerCase()).filter(Boolean),
            ...(event.organizer?.email ? [event.organizer.email.toLowerCase()] : [])])],
        }, { source: 'GOOGLE_CALENDAR', requireMatch: true, domains: own });
        if (outcome.suggestion) result.events += 1; else result.skipped += 1;
      }
    }

    await query(
      `UPDATE crm_mailbox_sync SET last_synced_at = now(), last_error = NULL WHERE user_id = $1`, [user.id],
    );
  } catch (err) {
    await query(
      `UPDATE crm_mailbox_sync SET last_error = $2 WHERE user_id = $1`, [user.id, String(err.message).slice(0, 500)],
    );
    throw err;
  }
  return result;
}

/** The hourly pass: everyone who switched it on and has not been read for an hour. */
export async function runMailboxSync() {
  const availability = await syncAvailability();
  if (!availability.available) return { skipped: availability.reason, synced: [] };
  const { rows } = await query(
    `SELECT u.* FROM crm_mailbox_sync s JOIN users u ON u.id = s.user_id
      WHERE u.is_active = TRUE AND (s.gmail_enabled OR s.calendar_enabled)
        AND (s.last_synced_at IS NULL OR s.last_synced_at < now() - interval '55 minutes')`,
  );
  const synced = [];
  for (const user of rows) {
    try {
      synced.push({ user_id: user.id, ...(await syncMailbox(user)) });
    } catch (err) {
      synced.push({ user_id: user.id, error: err.message });
    }
  }
  return { synced };
}
