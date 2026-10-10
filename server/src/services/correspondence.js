/**
 * Correspondence that already happened, turned into suggested updates.
 *
 * The FarMart follow-up was an email. The Coromandel call was on the calendar.
 * Typing either of them into TaskFlow again is a second, manual activity log —
 * which is the thing that falls behind. Instead an email or a calendar file is
 * imported (or, for people who switch it on, read from their own Gmail and
 * Calendar), matched to the organization and the person at it, and offered as a
 * suggestion: one click to confirm, or dismiss.
 *
 * Nothing reaches a deal's timeline until a person confirms it. Matching is
 * exact (a known contact's address) or by the organization's own domain, never
 * by a webmail domain anyone can have. The same email or event can never be
 * logged twice.
 */

import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { logActivity } from './crm.js';
import { addCommitment } from './commitments.js';
import { setNextAction } from './opportunities.js';

// a domain anyone can have proves nothing about which organization wrote
export const WEBMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com',
  'rediffmail.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me', 'zoho.com', 'ymail.com',
]);

const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
export const addressesIn = (text) => [...new Set((String(text || '').match(ADDRESS) || []).map((a) => a.toLowerCase()))];
export const domainOf = (address) => String(address).split('@')[1]?.toLowerCase() || '';

// ---------------------------------------------------------------- reading an email

/** RFC 2047 encoded words in a header, e.g. =?UTF-8?B?...?= */
function decodeWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf8');
      return Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    } catch {
      return text;
    }
  });
}

function parseHeaders(block) {
  const headers = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (headers[key] === undefined) headers[key] = match[2];
  }
  return headers;
}

function decodeBody(body, encoding = '') {
  const kind = encoding.toLowerCase();
  if (kind.includes('base64')) {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return body; }
  }
  if (kind.includes('quoted-printable')) {
    return Buffer.from(
      body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))),
      'latin1',
    ).toString('utf8');
  }
  return body;
}

const stripHtml = (html) => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The readable text of a message body, from a multipart message if it is one. */
function readableText(headers, body) {
  const type = headers['content-type'] || 'text/plain';
  const boundary = type.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/multipart\//i.test(type) && boundary) {
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--'));
    let html = null;
    for (const part of parts) {
      const split = part.replace(/^\r?\n/, '').search(/\r?\n\r?\n/);
      if (split < 0) continue;
      const trimmed = part.replace(/^\r?\n/, '');
      const partHeaders = parseHeaders(trimmed.slice(0, split));
      const partBody = trimmed.slice(split).replace(/^\r?\n\r?\n/, '');
      const partType = partHeaders['content-type'] || 'text/plain';
      if (/multipart\//i.test(partType)) {
        const nested = readableText(partHeaders, partBody);
        if (nested) return nested;
      } else if (/text\/plain/i.test(partType)) {
        return decodeBody(partBody, partHeaders['content-transfer-encoding']);
      } else if (/text\/html/i.test(partType) && html === null) {
        html = stripHtml(decodeBody(partBody, partHeaders['content-transfer-encoding']));
      }
    }
    return html || '';
  }
  const text = decodeBody(body, headers['content-transfer-encoding']);
  return /text\/html/i.test(type) ? stripHtml(text) : text;
}

/** The new part of a reply: quoted history and signatures' "On … wrote:" cut off. */
export function freshText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .{4,200}wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(line.trim())) break;
    if (/^From:\s.+/.test(line) && out.length > 2) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Reads an email: a raw .eml file, or a message copied out of a mail client
 * with its From / To / Date / Subject lines at the top. Returns null for text
 * that has no sender to go on.
 */
export function parseEmail(raw) {
  const text = String(raw || '').replace(/^﻿/, '');
  const split = text.search(/\r?\n\r?\n/);
  const headerBlock = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split).replace(/^\r?\n\r?\n/, '') : '';
  const headers = parseHeaders(headerBlock);
  const from = addressesIn(decodeWords(headers.from));
  if (!from.length) return null;
  const parsedDate = headers.date ? new Date(headers.date.replace(/ at /i, ' ')) : null;
  const subject = decodeWords(headers.subject || '').trim() || null;
  const fresh = freshText(readableText(headers, body)).slice(0, 4000);
  const ref = headers['message-id']?.trim()
    || `sha1:${crypto.createHash('sha1').update(`${from[0]}|${headers.date || ''}|${subject || ''}|${fresh.slice(0, 200)}`).digest('hex')}`;
  return {
    ref,
    from: from[0],
    to: addressesIn(decodeWords(headers.to)),
    cc: addressesIn(decodeWords(headers.cc)),
    date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    subject,
    text: fresh,
  };
}

// ---------------------------------------------------------------- reading a calendar

const unescapeIcs = (value) => String(value || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/** An iCalendar date: UTC (…Z), local with a zone (taken as India time), or a whole day. */
function icsDate(value, params = '') {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    // a zone other than UTC is read as India time — the calendars here are; a
    // different zone is said in the suggestion rather than silently converted
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : '+05:30'}`);
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || /VALUE=DATE/i.test(params)) {
    const [, y, mo, d] = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    return new Date(`${y}-${mo}-${d}T09:00:00+05:30`);
  }
  return null;
}

/** Reads the events out of an .ics file. */
export function parseCalendar(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = { attendees: [] }; continue; }
    if (line === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name, ...paramList] = left.split(';');
    const params = paramList.join(';');
    switch (name.toUpperCase()) {
      case 'UID': current.uid = value.trim(); break;
      case 'SUMMARY': current.summary = unescapeIcs(value); break;
      case 'DESCRIPTION': current.description = unescapeIcs(value); break;
      case 'LOCATION': current.location = unescapeIcs(value); break;
      case 'STATUS': current.status = value.trim().toUpperCase(); break;
      case 'DTSTART': current.start = icsDate(value, params); current.zone = params.match(/TZID=([^;]+)/)?.[1] || null; break;
      case 'DTEND': current.end = icsDate(value, params); break;
      case 'RECURRENCE-ID': current.recurrence = value.trim(); break;
      case 'ATTENDEE': current.attendees.push(...addressesIn(value)); break;
      case 'ORGANIZER': current.organizer = addressesIn(value)[0] || null; break;
      default: break;
    }
  }
  return events
    .filter((e) => e.start && !Number.isNaN(e.start.getTime()))
    .map((e) => ({
      ref: `${e.uid || crypto.createHash('sha1').update(`${e.summary}|${e.start.toISOString()}`).digest('hex')}${e.recurrence ? `#${e.recurrence}` : ''}`,
      summary: e.summary || 'Meeting',
      description: (e.description || '').slice(0, 2000),
      location: e.location || null,
      start: e.start,
      end: e.end && !Number.isNaN(e.end.getTime()) ? e.end : null,
      cancelled: e.status === 'CANCELLED',
      zone: e.zone,
      attendees: [...new Set([...(e.attendees || []), ...(e.organizer ? [e.organizer] : [])])],
      organizer: e.organizer || null,
    }));
}

// ---------------------------------------------------------------- matching

/** Our own domains: the ones TaskFlow's own people sign in with. */
export async function ownDomains() {
  const { rows } = await query(
    `SELECT DISTINCT LOWER(SPLIT_PART(email, '@', 2)) AS domain FROM users WHERE is_active = TRUE`,
  );
  return new Set(rows.map((r) => r.domain).filter(Boolean));
}

/**
 * The organization (and person) a set of outside addresses belongs to: a known
 * contact's exact address first, then the organization's own domain — from its
 * contacts or its website. A webmail domain never matches by domain.
 */
export async function matchOrganization(addresses) {
  const outside = addresses.filter(Boolean);
  if (!outside.length) return { account_id: null, contact_id: null, matched_by: null };

  const { rows: contacts } = await query(
    `SELECT c.id, c.account_id FROM account_contacts c
       JOIN accounts a ON a.id = c.account_id
      WHERE LOWER(c.email) = ANY($1::text[]) AND a.is_archived = FALSE
      ORDER BY c.is_active DESC, c.is_primary DESC, c.id LIMIT 1`,
    [outside],
  );
  if (contacts[0]) return { account_id: contacts[0].account_id, contact_id: contacts[0].id, matched_by: 'contact' };

  const domains = [...new Set(outside.map(domainOf))].filter((d) => d && !WEBMAIL.has(d));
  if (!domains.length) return { account_id: null, contact_id: null, matched_by: null };
  const { rows: byDomain } = await query(
    `SELECT a.id FROM accounts a
      WHERE a.is_archived = FALSE
        AND (EXISTS (SELECT 1 FROM account_contacts c
                      WHERE c.account_id = a.id AND LOWER(SPLIT_PART(c.email, '@', 2)) = ANY($1::text[]))
             OR LOWER(REGEXP_REPLACE(COALESCE(a.website, ''), '^(https?://)?(www\\.)?([^/]+).*$', '\\3')) = ANY($1::text[]))
      ORDER BY a.updated_at DESC LIMIT 1`,
    [domains],
  );
  if (byDomain[0]) return { account_id: byDomain[0].id, contact_id: null, matched_by: 'domain' };
  return { account_id: null, contact_id: null, matched_by: null };
}

/** The deal an entry most likely belongs to: the organization's main live deal. */
async function likelyDeal(accountId) {
  if (!accountId) return null;
  const { rows } = await query(
    `SELECT o.id FROM opportunities o JOIN accounts a ON a.id = o.account_id
      WHERE o.account_id = $1 AND o.is_archived = FALSE AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')
      ORDER BY (o.id = a.primary_opportunity_id) DESC, o.updated_at DESC LIMIT 1`,
    [accountId],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------- suggestions

async function alreadyLogged(accountId, ref) {
  if (!accountId) return false;
  const { rows } = await query(
    `SELECT 1 FROM account_activities WHERE account_id = $1 AND external_ref = $2
     UNION ALL SELECT 1 FROM crm_meetings WHERE account_id = $1 AND external_ref = $2 LIMIT 1`,
    [accountId, ref],
  );
  return rows.length > 0;
}

/**
 * Turns an email into a suggestion for `userId`. `requireMatch` drops mail that
 * matches no organization — used for mailbox reading, so personal mail is never
 * surfaced; a hand-imported email is kept so the person can pick.
 */
export async function suggestFromEmail(userId, email, { source = 'EMAIL_IMPORT', requireMatch = false, accountId = null, domains = null } = {}) {
  const own = domains || await ownDomains();
  const everyone = [email.from, ...email.to, ...email.cc];
  const outside = everyone.filter((a) => !own.has(domainOf(a)));
  if (!outside.length) return { skipped: 'internal' };
  const match = accountId ? { account_id: accountId, contact_id: null, matched_by: 'chosen' } : await matchOrganization(outside);
  if (requireMatch && !match.account_id) return { skipped: 'no_match' };
  if (await alreadyLogged(match.account_id, email.ref)) return { skipped: 'already_logged' };
  const direction = own.has(domainOf(email.from)) ? 'OUTBOUND' : 'INBOUND';
  const { rows } = await query(
    `INSERT INTO crm_suggestions
       (user_id, source, external_ref, kind, account_id, opportunity_id, contact_id, direction,
        occurred_at, subject, snippet, participants)
     VALUES ($1,$2,$3,'EMAIL',$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (user_id, source, external_ref) DO NOTHING
     RETURNING *`,
    [
      userId, source, email.ref, match.account_id, await likelyDeal(match.account_id), match.contact_id,
      direction, email.date, email.subject, email.text.slice(0, 1500),
      `${email.from} → ${[...email.to, ...email.cc].join(', ')}`.slice(0, 1000),
    ],
  );
  return rows[0] ? { suggestion: rows[0], matched_by: match.matched_by } : { skipped: 'already_suggested' };
}

export async function suggestFromEvent(userId, event, { source = 'CALENDAR_IMPORT', requireMatch = false, accountId = null, domains = null } = {}) {
  if (event.cancelled) return { skipped: 'cancelled' };
  const own = domains || await ownDomains();
  const outside = event.attendees.filter((a) => !own.has(domainOf(a)));
  if (!outside.length) return { skipped: 'internal' };
  const match = accountId ? { account_id: accountId, contact_id: null, matched_by: 'chosen' } : await matchOrganization(outside);
  if (requireMatch && !match.account_id) return { skipped: 'no_match' };
  if (await alreadyLogged(match.account_id, event.ref)) return { skipped: 'already_logged' };
  const { rows } = await query(
    `INSERT INTO crm_suggestions
       (user_id, source, external_ref, kind, account_id, opportunity_id, contact_id,
        occurred_at, ends_at, subject, snippet, participants)
     VALUES ($1,$2,$3,'MEETING',$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (user_id, source, external_ref) DO NOTHING
     RETURNING *`,
    [
      userId, source, event.ref, match.account_id, await likelyDeal(match.account_id), match.contact_id,
      event.start, event.end, event.summary,
      [event.location && `Where: ${event.location}`, event.description, event.zone && !/kolkata|calcutta/i.test(event.zone) ? `(times read as India time; the file said ${event.zone})` : null]
        .filter(Boolean).join('\n').slice(0, 1500) || null,
      event.attendees.join(', ').slice(0, 1000),
    ],
  );
  return rows[0] ? { suggestion: rows[0], matched_by: match.matched_by } : { skipped: 'already_suggested' };
}

export async function listSuggestions(userId, { status = 'PENDING' } = {}) {
  const { rows } = await query(
    `SELECT s.*, a.name AS account_name, o.name AS opportunity_name, c.full_name AS contact_name
       FROM crm_suggestions s
       LEFT JOIN accounts a ON a.id = s.account_id
       LEFT JOIN opportunities o ON o.id = s.opportunity_id
       LEFT JOIN account_contacts c ON c.id = s.contact_id
      WHERE s.user_id = $1 AND s.status = $2
      ORDER BY s.occurred_at DESC NULLS LAST, s.id DESC LIMIT 200`,
    [userId, status],
  );
  return rows;
}

async function mySuggestion(user, id) {
  const { rows } = await query('SELECT * FROM crm_suggestions WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Suggestion not found');
  if (rows[0].user_id !== user.id) throw forbidden('That suggestion is somebody else\'s');
  if (rows[0].status !== 'PENDING') throw badRequest('That suggestion was already dealt with');
  return rows[0];
}

export async function dismissSuggestion(user, id) {
  const suggestion = await mySuggestion(user, id);
  await query(
    `UPDATE crm_suggestions SET status = 'DISMISSED', decided_at = now(), decided_by = $2 WHERE id = $1`,
    [suggestion.id, user.id],
  );
  return { ok: true };
}

/**
 * Confirms a suggestion into the record. An email becomes an entry on the
 * timeline (which way it went decides whether it counts as hearing from the
 * customer). A calendar event in the future becomes a booked meeting; one in
 * the past is logged only if the person says it took place, with what came of
 * it — a calendar entry is not proof that a meeting happened.
 */
export async function confirmSuggestion(user, id, edits = {}) {
  const suggestion = await mySuggestion(user, id);
  const accountId = edits.account_id ?? suggestion.account_id;
  if (!accountId) throw badRequest('Pick the organization this belongs to');
  const { rows: accountRows } = await query('SELECT * FROM accounts WHERE id = $1 AND is_archived = FALSE', [accountId]);
  const account = accountRows[0];
  if (!account) throw badRequest('That organization does not exist');
  if (!hasPermission(user, 'crm.activity.log')) throw forbidden('You cannot log activity on organizations');

  let opportunityId = edits.opportunity_id !== undefined ? edits.opportunity_id : suggestion.opportunity_id;
  if (opportunityId) {
    const { rows } = await query('SELECT id FROM opportunities WHERE id = $1 AND account_id = $2', [opportunityId, accountId]);
    if (!rows[0]) opportunityId = null;
  }
  if (edits.account_id && edits.account_id !== suggestion.account_id && edits.opportunity_id === undefined) {
    opportunityId = await likelyDeal(accountId);
  }
  const subject = (edits.subject ?? suggestion.subject ?? '').trim() || null;
  const body = (edits.body ?? suggestion.snippet ?? '').trim() || null;

  return withTransaction(async (client) => {
    let activityId = null;
    let meetingId = null;

    if (suggestion.kind === 'EMAIL') {
      const direction = edits.direction ?? suggestion.direction ?? 'INBOUND';
      try {
        const created = await logActivity(client, {
          accountId, opportunityId, contactId: suggestion.contact_id, type: 'EMAIL', actorId: user.id,
          subject: subject || 'Email', body, occurredAt: suggestion.occurred_at,
          direction, outcome: direction === 'INBOUND' ? 'RECEIVED' : 'SENT',
          externalParticipants: suggestion.participants, source: 'EMAIL_IMPORT',
          externalRef: suggestion.external_ref,
        });
        activityId = created.id;
      } catch (err) {
        if (err.code === '23505') throw badRequest('That email is already on this organization\'s timeline');
        throw err;
      }
    } else {
      const start = suggestion.occurred_at ? new Date(suggestion.occurred_at) : null;
      const past = start && start.getTime() < Date.now();
      if (past && edits.took_place !== true) {
        throw badRequest('Say whether the meeting took place — a calendar entry is not proof that it happened',
          { code: 'MEETING_OUTCOME_REQUIRED' });
      }
      if (past && String(edits.outcome || '').trim().length < 3) {
        throw badRequest('Say what came of the meeting', { code: 'MEETING_OUTCOME_REQUIRED' });
      }
      const duration = suggestion.ends_at && start
        ? Math.max(5, Math.min(1440, Math.round((new Date(suggestion.ends_at) - start) / 60000))) : null;
      const { rows } = await client.query(
        `INSERT INTO crm_meetings
           (account_id, opportunity_id, kind, mode, title, scheduled_at, first_scheduled_at, duration_min,
            owner_user_id, created_by, status, completed_at, outcome, external_ref, prep_tasks_created)
         VALUES ($1,$2,'MEETING','VIRTUAL',$3,$4,$4,$5,$6,$6,$7,$8,$9,$10,TRUE)
         ON CONFLICT (account_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING
         RETURNING *`,
        [accountId, opportunityId, subject || 'Meeting', start, duration, user.id,
          past ? 'COMPLETED' : 'SCHEDULED', past ? new Date() : null,
          past ? String(edits.outcome).trim() : null, suggestion.external_ref],
      );
      if (!rows[0]) throw badRequest('That meeting is already recorded on this organization');
      meetingId = rows[0].id;
      const created = await logActivity(client, {
        accountId, opportunityId, meetingId, type: 'MEETING', actorId: user.id,
        subject: past ? `${subject || 'Meeting'} — completed` : `Meeting scheduled: ${subject || 'Meeting'}`,
        body: past ? String(edits.outcome).trim() : body,
        occurredAt: past ? start : null,
        outcome: past ? 'COMPLETED' : 'SCHEDULED', channel: 'VIRTUAL', isExternal: true,
        externalParticipants: suggestion.participants, source: 'CALENDAR_IMPORT',
      });
      activityId = created.id;
    }

    if (edits.commitment?.what) {
      await addCommitment(client, {
        accountId, opportunityId, activityId, contactId: suggestion.contact_id,
        what: edits.commitment.what, dueOn: edits.commitment.due_on ?? null, actor: user,
      });
    }

    if (edits.next_step && opportunityId) {
      const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
      if (['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(rows[0]?.status)) {
        await setNextAction(client, {
          opportunity: rows[0], step: edits.next_step, ownerId: edits.next_step_owner_id ?? rows[0].next_step_owner_id ?? user.id,
          due: edits.next_step_due, actor: user, reason: 'From imported correspondence',
        });
      }
    }

    await client.query(
      `UPDATE crm_suggestions
          SET status = 'CONFIRMED', decided_at = now(), decided_by = $2,
              account_id = $3, opportunity_id = $4, activity_id = $5, meeting_id = $6
        WHERE id = $1`,
      [suggestion.id, user.id, accountId, opportunityId, activityId, meetingId],
    );
    return { activity_id: activityId, meeting_id: meetingId, account_id: accountId };
  });
}
