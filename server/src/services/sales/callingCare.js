/**
 * Telling people, and respecting "don't call me".
 *
 *   texts         the opening sentence for recorded calls, the company phone
 *                 policy (acknowledged in the app) and the privacy notice for
 *                 leads; all stored in Settings → Calling in English and
 *                 Hindi, with placeholders filled from settings
 *   opt-outs      "Asked not to be called again" from the outcome form stops
 *                 retries, call-backs and call follow-ups; "and no WhatsApp or
 *                 SMS" opts messages out too. Lifting needs a reason.
 *   complaints    recorded with what the customer said, opt the number out and
 *                 tell administrators; three within ten days raise a warning
 *   import        a list of numbers to opt out, previewed before anything is
 *                 saved, and applied only exactly as previewed
 *   review        a weekly summary for administrators: opt-outs, complaints,
 *                 calls outside hours, leads that hit the daily cap
 *
 * Notifications go to the bell (type crm_calling). Google Chat copies them
 * only where an administrator has switched that alert type on.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { notify } from '../activity.js';
import { recordAuditEvent } from '../audit.js';
import { liftOptOut, optOut } from './comms.js';
import { cancelReminders } from './followupReminders.js';
import { logLeadActivity } from './leads.js';
import { localDate, localParts, normalizePhone, salesSettings, zonedInstant } from './core.js';

export const NOTICE_LANGS = ['en', 'hi'];

// ---------------------------------------------------------------- who to tell

/** Active people who look after the CRM's settings. */
export async function crmAdmins(runner = { query }) {
  const { rows } = await runner.query(
    `SELECT id, role, extra_permissions, revoked_permissions, is_active FROM users WHERE is_active = TRUE ORDER BY id`,
  );
  return rows.filter((u) => hasPermission(u, 'crm.settings'));
}

async function tellAdmins(client, { title, body = null, leadId = null, accountId = null }) {
  for (const admin of await crmAdmins(client)) {
    await notify(client, { userId: admin.id, type: 'crm_calling', title, body, leadId, accountId });
  }
}

// ---------------------------------------------------------------- texts

const fill = (text, values) => String(text || '').replace(/\{([a-z_]+)\}/g, (m, k) => (values[k] !== undefined && values[k] !== null && values[k] !== '' ? String(values[k]) : m));

const firstName = (user) => String(user?.full_name || '').trim().split(/\s+/)[0] || '';

/** What is still missing before the privacy notice can be published. */
export function noticeMissing(calls = {}) {
  const n = calls.privacyNotice || {};
  const missing = [];
  if (!String(n.legalName || '').trim()) missing.push('the company’s legal name');
  if (!String(n.address || '').trim()) missing.push('the address');
  if (!String(n.contactName || '').trim()) missing.push('a person to contact');
  if (!String(n.contactPhone || '').trim() && !String(n.contactEmail || '').trim()) missing.push('a phone number or email for questions and complaints');
  if (!String(calls.companyName || '').trim()) missing.push('the name leads hear on calls');
  return missing;
}

/**
 * The notice leads see: the copy made when it was last published. Edits in
 * Settings are a draft until published again, so the public page never
 * disappears or changes while someone is still typing.
 */
export const publishedNotice = (calls = {}) => (calls.privacyNoticePublished?.publishedAt ? calls.privacyNoticePublished : null);

/** Whether the draft differs from what is published. */
export function noticeDraftChanged(calls = {}) {
  const pub = publishedNotice(calls);
  if (!pub) return true;
  const keys = ['legalName', 'address', 'contactName', 'contactPhone', 'contactEmail', 'en', 'hi', 'formLine'];
  return keys.some((k) => JSON.stringify(pub[k] ?? null) !== JSON.stringify(calls.privacyNotice?.[k] ?? null))
    || (pub.companyName ?? null) !== (calls.companyName ?? null);
}

/** What is missing before recordings can be switched on. */
export function recordingBlockers(calls = {}) {
  const out = [];
  if (!String(calls.openingSentence?.en || '').trim()) out.push('the opening sentence');
  if (!String(calls.companyName || '').trim()) out.push('the name leads hear on calls');
  if (!publishedNotice(calls)) out.push('a published privacy notice');
  return out;
}

/** The values the texts' placeholders take, from the published notice when there is one. */
function noticeValues(calls, { date = null, draft = false } = {}) {
  const n = (!draft && publishedNotice(calls)) || calls.privacyNotice || {};
  const lines = [n.contactPhone ? `Phone: ${n.contactPhone}` : null, n.contactEmail ? `Email: ${n.contactEmail}` : null].filter(Boolean);
  return {
    legal_name: n.legalName, address: n.address, company: n.companyName || calls.companyName || n.legalName, contact_name: n.contactName,
    contact_phone: n.contactPhone, contact_email: n.contactEmail, contact_lines: lines.join('\n'),
    retention_months: calls.recordingRetentionMonths || 6,
    date: date || (n.publishedAt ? localDate(new Date(n.publishedAt)) : localDate()),
  };
}

/** The opening sentence and phone policy, filled in for one person. */
export function callingTexts(settings, user) {
  const calls = settings.calls || {};
  const values = { ...noticeValues(calls), first_name: firstName(user) };
  const policy = calls.staffPolicy || {};
  return {
    recording_on: calls.deviceRecordings === true,
    opening_sentence: Object.fromEntries(NOTICE_LANGS.map((l) => [l, fill(calls.openingSentence?.[l], values)])),
    staff_policy: { version: Number(policy.version) || 1, ...Object.fromEntries(NOTICE_LANGS.map((l) => [l, fill(policy[l], values)])) },
    notice_published: Boolean(publishedNotice(calls)),
    form_line: Object.fromEntries(NOTICE_LANGS.map((l) => [l, fill((publishedNotice(calls) || calls.privacyNotice)?.formLine?.[l], values)])),
  };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The privacy notice as HTML body content: "# " title, "## " headings, "- "
 * lists, blank lines between paragraphs. The published copy, unless the
 * draft is asked for (the administrator's preview).
 */
export function noticeHtml(lang, calls, { draft = false } = {}) {
  const n = (!draft && publishedNotice(calls)) || calls.privacyNotice || {};
  const text = fill(n[lang] || n.en || '', noticeValues(calls, { draft }));
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${para.map(esc).join('<br>')}</p>`); para = []; }
    if (list) { out.push(`<ul>${list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`); list = null; }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('# ')) { flush(); out.push(`<h1>${esc(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { flush(); out.push(`<h2>${esc(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('- ')) { if (para.length) { out.push(`<p>${para.map(esc).join('<br>')}</p>`); para = []; } (list ||= []).push(line.slice(2)); continue; }
    if (list) { out.push(`<ul>${list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`); list = null; }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

// ---------------------------------------------------------------- the phone policy

export async function policyStatus(userId, settings = null) {
  const s = settings || await salesSettings();
  const version = Number(s.calls?.staffPolicy?.version) || 1;
  const { rows } = await query(
    `SELECT acknowledged_at FROM crm_policy_acks WHERE user_id = $1 AND policy_key = 'PHONE' AND version = $2`, [userId, version],
  );
  return { version, acknowledged: Boolean(rows[0]), acknowledged_at: rows[0]?.acknowledged_at ?? null };
}

export async function acknowledgePolicy(userId, version, deviceId = null) {
  const current = await policyStatus(userId);
  if (Number(version) !== current.version) throw conflict('The phone policy has changed; read the new version first', { code: 'POLICY_CHANGED', version: current.version });
  await query(
    `INSERT INTO crm_policy_acks (user_id, policy_key, version, device_id) VALUES ($1, 'PHONE', $2, $3)
     ON CONFLICT (user_id, policy_key, version) DO NOTHING`,
    [userId, current.version, deviceId],
  );
  return policyStatus(userId);
}

// ---------------------------------------------------------------- opt-outs

/** Ends a lead's (or several leads') calls: retries, call-backs and call follow-ups. */
async function stopCalling(client, phone, { messages = false, reason, actorId }) {
  const { rows: leads } = await client.query(
    `UPDATE crm_leads SET retry_at = NULL, updated_at = now() WHERE phone_normalized = $1 AND merged_into_id IS NULL RETURNING id`, [phone],
  );
  const kinds = messages ? ['CALL', 'CALLBACK', 'WHATSAPP'] : ['CALL', 'CALLBACK'];
  const { rows: tasks } = await client.query(
    `UPDATE tasks SET crm_cancel_reason = $3, updated_at = now()
      WHERE completed_at IS NULL AND is_archived = FALSE AND crm_cancel_reason IS NULL AND followup_kind = ANY($2::text[])
        AND (crm_lead_id IN (SELECT id FROM crm_leads WHERE phone_normalized = $1)
             OR account_id IN (SELECT account_id FROM account_contacts WHERE phone_normalized = $1 AND is_active = TRUE))
      RETURNING id, crm_lead_id`,
    [phone, kinds, reason],
  );
  if (tasks.length) await cancelReminders(client, tasks.map((t) => t.id), reason);
  for (const lead of leads) {
    await logLeadActivity(client, lead.id, {
      type: 'NOTE', subject: messages ? 'Asked not to be called or messaged' : 'Asked not to be called again', body: reason, actorId,
    });
  }
  return { leads: leads.length, followups: tasks.length };
}

/**
 * Opts a number out of calls (and, if asked, WhatsApp and SMS), and stops
 * everything that would call it. Inside the caller's transaction.
 */
export async function optOutOfCalls(client, { phone, reason, source, actorId, callId = null, leadId = null, messages = false, complaintText = null }) {
  const number = normalizePhone(phone);
  if (!number) throw badRequest('There is no phone number to opt out');
  await optOut(client, { channel: 'CALL', address: number, reason, source, actorId });
  await client.query(
    `UPDATE crm_optouts SET call_id = COALESCE(call_id, $2), lead_id = COALESCE(lead_id, $3),
            complaint = complaint OR $4, complaint_text = COALESCE($5, complaint_text)
      WHERE channel = 'CALL' AND address = $1 AND lifted_at IS NULL`,
    [number, callId, leadId, Boolean(complaintText), complaintText],
  );
  if (messages) {
    await optOut(client, { channel: 'WHATSAPP', address: number, reason, source, actorId });
    await optOut(client, { channel: 'SMS', address: number, reason, source, actorId });
  }
  const stopped = await stopCalling(client, number, { messages, reason, actorId });
  await recordAuditEvent(client, {
    action: 'CALL_OPT_OUT', entityType: leadId ? 'LEAD' : 'CALL', entityId: leadId || callId, actorId,
    summary: `${reason}${messages ? ' (and messages)' : ''}`, detail: { source, call_id: callId, ...stopped },
  });
  return { phone: number, ...stopped };
}

/** Lifts a call opt-out: only with a reason, and recorded. */
export async function liftCallOptOut({ address, reason, actor }) {
  const why = String(reason || '').trim();
  if (why.length < 3) throw badRequest('Say why the number may be called again (for example, "the customer asked us to call them")');
  const number = normalizePhone(address);
  if (!number) throw badRequest('Give the phone number');
  return withTransaction(async (client) => {
    await client.query(`UPDATE crm_optouts SET lift_reason = $2 WHERE channel = 'CALL' AND address = $1 AND lifted_at IS NULL`, [number, why.slice(0, 500)]);
    await liftOptOut(client, { channel: 'CALL', address: number, actorId: actor.id });
    await recordAuditEvent(client, { action: 'CALL_OPT_OUT_LIFTED', entityType: 'SETTINGS', actorId: actor.id, summary: why, detail: { address: `…${number.slice(-4)}` } });
    return { lifted: true };
  });
}

/** Opt-outs and complaints, newest first, for administrators. */
export async function listOptOuts({ includeLifted = false } = {}) {
  const { rows } = await query(
    `SELECT o.id, o.channel, o.address, o.reason, o.source, o.created_at, o.lifted_at, o.lift_reason, o.complaint, o.complaint_text, o.call_id,
            u.full_name AS actor_name, lu.full_name AS lifted_by_name,
            l.id AS lead_id, l.ref AS lead_ref, COALESCE(l.organization_name, l.contact_name) AS lead_name
       FROM crm_optouts o
       LEFT JOIN users u ON u.id = o.actor_id LEFT JOIN users lu ON lu.id = o.lifted_by
       LEFT JOIN crm_leads l ON l.id = COALESCE(o.lead_id, (SELECT x.id FROM crm_leads x WHERE x.phone_normalized = o.address ORDER BY x.id DESC LIMIT 1))
      WHERE o.channel = 'CALL' ${includeLifted ? '' : 'AND o.lifted_at IS NULL'}
      ORDER BY o.created_at DESC LIMIT 500`,
  );
  const { rows: complaints } = await query(
    `SELECT k.*, u.full_name AS recorded_by_name, l.ref AS lead_ref, COALESCE(l.organization_name, l.contact_name, a.name) AS about
       FROM crm_call_complaints k LEFT JOIN users u ON u.id = k.recorded_by
       LEFT JOIN crm_leads l ON l.id = k.lead_id LEFT JOIN accounts a ON a.id = k.account_id
      ORDER BY k.created_at DESC LIMIT 200`,
  );
  const { rows: recent } = await query(`SELECT COUNT(*)::int AS n FROM crm_call_complaints WHERE created_at > now() - interval '10 days'`);
  return { optouts: rows, complaints, complaints_10_days: recent[0].n };
}

// ---------------------------------------------------------------- complaints

/** The number a complaint is about: the call's, the lead's or the contact's. */
async function complaintTarget(client, { leadId, contactId, callId }) {
  if (callId) {
    const { rows } = await client.query('SELECT id, lead_id, account_id, contact_id, counterpart_normalized FROM crm_calls WHERE id = $1', [callId]);
    if (!rows[0]) throw notFound('Call not found');
    return { phone: rows[0].counterpart_normalized, leadId: rows[0].lead_id, accountId: rows[0].account_id, contactId: rows[0].contact_id, callId };
  }
  if (leadId) {
    const { rows } = await client.query('SELECT id, phone_normalized FROM crm_leads WHERE id = $1', [leadId]);
    if (!rows[0]) throw notFound('Lead not found');
    return { phone: rows[0].phone_normalized, leadId, accountId: null, contactId: null, callId: null };
  }
  if (contactId) {
    const { rows } = await client.query('SELECT id, account_id, phone_normalized FROM account_contacts WHERE id = $1', [contactId]);
    if (!rows[0]) throw notFound('Contact not found');
    return { phone: rows[0].phone_normalized, leadId: null, accountId: rows[0].account_id, contactId, callId: null };
  }
  throw badRequest('Say which lead, contact or call the complaint is about');
}

/**
 * Records a complaint in the customer's words, opts the number out of calls,
 * and tells administrators. Three or more within ten days raise a warning,
 * once a day.
 */
export async function recordComplaint({ leadId = null, contactId = null, callId = null, whatTheySaid, actor, now = new Date() }) {
  const said = String(whatTheySaid || '').trim();
  if (said.length < 3) throw badRequest('Write what the customer said');
  return withTransaction(async (client) => {
    const t = await complaintTarget(client, { leadId, contactId, callId });
    if (!t.phone) throw badRequest('This record has no phone number to opt out');
    const { rows } = await client.query(
      `INSERT INTO crm_call_complaints (phone_normalized, lead_id, account_id, contact_id, call_id, what_they_said, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [t.phone, t.leadId, t.accountId, t.contactId, t.callId, said.slice(0, 2000), actor.id],
    );
    await optOutOfCalls(client, {
      phone: t.phone, reason: 'Complained about being called', source: 'COMPLAINT', actorId: actor.id, callId: t.callId, leadId: t.leadId, complaintText: said.slice(0, 2000),
    });
    const { rows: names } = await client.query(
      `SELECT COALESCE((SELECT COALESCE(organization_name, contact_name) FROM crm_leads WHERE id = $1),
                       (SELECT full_name FROM account_contacts WHERE id = $2), 'a customer') AS name`, [t.leadId, t.contactId],
    );
    await tellAdmins(client, { title: `Complaint from ${names[0].name}: number opted out of calls`, body: said.slice(0, 300), leadId: t.leadId, accountId: t.accountId });
    const warning = await complaintWarning(client, now);
    return { complaint: rows[0], warning };
  });
}

/** Three or more complaints within ten days: administrators are warned, once a day. */
export async function complaintWarning(client, now = new Date()) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM crm_call_complaints WHERE created_at > $1::timestamptz - interval '10 days'`, [now],
  );
  const n = rows[0].n;
  if (n < 3) return null;
  const settings = await salesSettings();
  const day = localDate(now, settings.calendar?.timezone || 'Asia/Kolkata');
  const { rows: fresh } = await client.query(
    `INSERT INTO crm_calling_alerts (kind, period, summary) VALUES ('COMPLAINT_WARNING', $1, $2) ON CONFLICT (kind, period) DO NOTHING RETURNING kind`,
    [day, JSON.stringify({ complaints_10_days: n })],
  );
  if (!fresh[0]) return { complaints: n, told: false };
  await tellAdmins(client, {
    title: `${n} call complaints in the last 10 days`,
    body: 'The telecom operator acts on complaints made to it; TaskFlow cannot see those. Check who is being called, how often, and the opt-out list.',
  });
  return { complaints: n, told: true };
}

// ---------------------------------------------------------------- importing a do-not-call list

/** Reads numbers from pasted text or a CSV: the first cell on each line with a number in it. */
export function parseNumberList(text) {
  const valid = new Map();
  const invalid = [];
  let duplicates = 0;
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const cell = cells.find((c) => (c.match(/\d/g) || []).length >= 6);
    if (!cell) {
      // a header row ("phone", "number") is not an error
      if (i === 0 && /phone|mobile|number|नंबर/i.test(line)) return;
      invalid.push({ line: i + 1, value: line.slice(0, 80) });
      return;
    }
    const n = normalizePhone(cell);
    if (!n || n.length < 10 || n.length > 15) { invalid.push({ line: i + 1, value: cell.slice(0, 40) }); return; }
    if (valid.has(n)) duplicates += 1;
    else valid.set(n, i + 1);
  });
  const numbers = [...valid.keys()].sort();
  const fingerprint = crypto.createHash('sha256').update(numbers.join(',')).digest('hex').slice(0, 16);
  return { numbers, invalid, duplicates, fingerprint };
}

/** What an import would do. Changes nothing. */
export async function previewOptOutImport(text) {
  const parsed = parseNumberList(text);
  if (!parsed.numbers.length && !parsed.invalid.length) throw badRequest('Paste numbers, one per line, or a CSV with a phone column');
  const { rows: already } = await query(
    `SELECT address FROM crm_optouts WHERE channel = 'CALL' AND lifted_at IS NULL AND address = ANY($1::text[])`, [parsed.numbers],
  );
  const { rows: leads } = await query(`SELECT COUNT(*)::int AS n FROM crm_leads WHERE phone_normalized = ANY($1::text[]) AND merged_into_id IS NULL`, [parsed.numbers]);
  const known = new Set(already.map((r) => r.address));
  return {
    fingerprint: parsed.fingerprint,
    new_numbers: parsed.numbers.filter((n) => !known.has(n)).length,
    already_opted_out: known.size,
    duplicates: parsed.duplicates,
    invalid: parsed.invalid.slice(0, 50),
    invalid_count: parsed.invalid.length,
    leads_matched: leads[0].n,
    sample: parsed.numbers.slice(0, 5).map((n) => `…${n.slice(-4)}`),
  };
}

/** Applies an import exactly as previewed (the fingerprint must match). */
export async function applyOptOutImport(text, fingerprint, actor) {
  const parsed = parseNumberList(text);
  if (parsed.fingerprint !== fingerprint) throw conflict('The list changed since the preview; preview it again', { code: 'CHANGED' });
  return withTransaction(async (client) => {
    let added = 0;
    for (const n of parsed.numbers) {
      const { rows } = await client.query(`SELECT 1 FROM crm_optouts WHERE channel = 'CALL' AND address = $1 AND lifted_at IS NULL`, [n]);
      if (rows[0]) continue;
      await optOutOfCalls(client, { phone: n, reason: 'On an imported do-not-call list', source: 'IMPORT', actorId: actor.id });
      added += 1;
    }
    await recordAuditEvent(client, {
      action: 'CALL_OPT_OUT_IMPORT', entityType: 'SETTINGS', actorId: actor.id, summary: `${added} number(s) opted out from an imported list`,
      detail: { fingerprint, added, total: parsed.numbers.length },
    });
    return { added, skipped: parsed.numbers.length - added, invalid: parsed.invalid.length };
  });
}

// ---------------------------------------------------------------- the weekly review

/** The calling review for a period: what an administrator should look at. */
export async function callingReview({ from, to }) {
  const settings = await salesSettings();
  const tz = settings.calendar?.timezone || 'Asia/Kolkata';
  const cap = Number(settings.calls?.dailyAttemptCap) || 0;
  const [optouts, complaints, outside, capped, callbacks] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE source = 'IMPORT')::int AS imported FROM crm_optouts
            WHERE channel = 'CALL' AND created_at >= $1 AND created_at < $2`, [from, to]),
    query(`SELECT k.id, k.what_they_said, k.created_at, COALESCE(l.organization_name, l.contact_name) AS about
             FROM crm_call_complaints k LEFT JOIN crm_leads l ON l.id = k.lead_id
            WHERE k.created_at >= $1 AND k.created_at < $2 ORDER BY k.created_at`, [from, to]),
    query(`SELECT c.id, c.hours_override_reason, COALESCE(c.dialled_at, c.started_at) AS at, u.full_name AS agent_name
             FROM crm_calls c LEFT JOIN users u ON u.id = c.agent_user_id
            WHERE c.hours_override_reason IS NOT NULL AND COALESCE(c.dialled_at, c.started_at) >= $1 AND COALESCE(c.dialled_at, c.started_at) < $2
            ORDER BY at`, [from, to]),
    cap > 0
      ? query(`SELECT COUNT(*)::int AS n FROM (
                 SELECT c.lead_id, (COALESCE(c.dialled_at, c.started_at, c.created_at) AT TIME ZONE $3)::date AS day
                   FROM crm_calls c WHERE c.direction = 'OUTBOUND' AND c.voided_at IS NULL AND c.lead_id IS NOT NULL
                    AND COALESCE(c.dialled_at, c.started_at, c.created_at) >= $1 AND COALESCE(c.dialled_at, c.started_at, c.created_at) < $2
                  GROUP BY 1, 2 HAVING COUNT(*) >= $4) x`, [from, to, tz, cap])
      : { rows: [{ n: 0 }] },
    query(`SELECT callback_reason, COUNT(*)::int AS n FROM crm_calls
            WHERE callback_reason IS NOT NULL AND COALESCE(dialled_at, started_at) >= $1 AND COALESCE(dialled_at, started_at) < $2
            GROUP BY 1`, [from, to]),
  ]);
  return {
    from, to,
    opt_outs: optouts.rows[0].n,
    opt_outs_imported: optouts.rows[0].imported,
    complaints: complaints.rows,
    calls_outside_hours: outside.rows,
    leads_at_daily_cap: capped.rows[0].n,
    callbacks_past_limits: Object.fromEntries(callbacks.rows.map((r) => [r.callback_reason, r.n])),
  };
}

/** The last full week (Monday to Monday, calendar time zone) before an instant. */
export function lastWeek(now = new Date(), tz = 'Asia/Kolkata') {
  const p = localParts(now, tz);
  const today = zonedInstant(p.date, '00:00', tz);
  const thisMonday = new Date(today.getTime() - (p.weekday - 1) * 86_400_000);
  const from = new Date(thisMonday.getTime() - 7 * 86_400_000);
  return { from, to: thisMonday, period: localDate(from, tz) };
}

/** On Monday morning, the previous week's review goes to administrators, once. */
export async function runWeeklyCallingReview(now = new Date()) {
  const settings = await salesSettings();
  const tz = settings.calendar?.timezone || 'Asia/Kolkata';
  const p = localParts(now, tz);
  if (p.weekday !== 1 || p.hour < 9) return { sent: false, why: 'Sent on Monday mornings' };
  const week = lastWeek(now, tz);
  const review = await callingReview(week);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO crm_calling_alerts (kind, period, summary) VALUES ('WEEKLY_REVIEW', $1, $2) ON CONFLICT (kind, period) DO NOTHING RETURNING kind`,
      [week.period, JSON.stringify(review)],
    );
    if (!rows[0]) return { sent: false, why: 'Already sent' };
    const parts = [
      `${review.opt_outs} new opt-out${review.opt_outs === 1 ? '' : 's'}`,
      `${review.complaints.length} complaint${review.complaints.length === 1 ? '' : 's'}`,
      `${review.calls_outside_hours.length} call${review.calls_outside_hours.length === 1 ? '' : 's'} outside hours`,
      `${review.leads_at_daily_cap} lead-day${review.leads_at_daily_cap === 1 ? '' : 's'} at the daily limit`,
    ];
    await tellAdmins(client, { title: `Calling review, week of ${week.period}`, body: `${parts.join(' · ')}. Open Settings → Calling → Complaints & opt-outs.` });
    return { sent: true, review };
  });
}
