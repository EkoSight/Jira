/**
 * WhatsApp broadcasts: one approved template to a filtered list of CRM leads
 * (docs/WHATSAPP_BROADCASTS.md).
 *
 *   DRAFT → IN_REVIEW → APPROVED → (SCHEDULED) → SENDING ⇄ PAUSED → SENT.
 *   Also CANCELLED, from any state before SENT.
 *
 * - The list is the lead list with the same filters, inside the view of the
 *   CRM of the broadcast's owner, so its count equals the lead list's.
 * - A message goes only to a number that agreed to WhatsApp messages and has
 *   not opted out (whatsappOptins.js). Everyone else is listed with the reason.
 * - Approval is like email campaigns: the same permissions and the same
 *   approval settings. It is of exactly what the approver saw: a change to
 *   the list, the template or its blanks sends it back to draft.
 * - Who gets it is worked out when sending starts, and each number is
 *   checked again just before its message goes. A message is never sent
 *   twice: each has an idempotency key.
 * - Messages go only inside the sending hours, at most the daily limit in
 *   any 24 hours, a batch per pass of the sales worker.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { loadUser } from '../../middleware/auth.js';
import { getSettings } from '../settings.js';
import { notify } from '../activity.js';
import { recordAuditEvent } from '../audit.js';
import { crmScope, normalizePhone, salesSettings } from './core.js';
import { leadListConditions } from './leads.js';
import { fillTemplate, retryWhatsApp, sendWhatsApp, whatsappStatus } from './comms.js';

export const STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'SENDING', 'PAUSED', 'SENT', 'CANCELLED'];

/** What can fill a blank ({{1}}, {{2}}…) in the template. */
export const VALUE_SOURCES = {
  first_name: 'First name',
  contact_name: 'Full name',
  organization_name: 'Organisation',
  district: 'District',
  city: 'City / town / village',
  state: 'State',
  owner_first_name: "Lead owner's first name",
  owner_name: "Lead owner's full name",
  fixed: 'The same text for everyone',
};

/** Why someone in the list does not get the message. */
export const SKIP_WORDS = {
  NO_PHONE: 'No full phone number',
  SAME_NUMBER: 'Same number as another lead in the list (one message per number)',
  OPTED_OUT: 'Opted out of WhatsApp',
  NO_OPTIN: 'No WhatsApp opt-in recorded',
  RECENT: 'Got a broadcast recently',
  MISSING_VALUE: 'Nothing to fill a blank in the message',
  CHANGED: 'No longer in the list, or no longer agreed, when the message was due',
  CANCELLED: 'The broadcast was cancelled before this message went',
};

// the lead list's views that make sense for a broadcast (not the routing queues or archived leads)
export const BROADCAST_VIEWS = ['open', 'mine', 'unassigned', 'new', 'stale', 'nurture', 'won', 'converted', 'disqualified', 'all'];
const FILTER_KEYS = ['q', 'category', 'status', 'priority', 'owner_id', 'department_id', 'source_id', 'campaign_id', 'state', 'tag', 'from', 'to',
  'min_score', 'entry_channel', 'call_status_id', 'rating', 'city', 'district', 'block', 'pincode', 'wa_optin'];

/** Only the lead list's own filters, as text. */
export function cleanFilters(input = {}) {
  const out = { view: BROADCAST_VIEWS.includes(input.view) ? input.view : 'open' };
  for (const [k, v] of Object.entries(input || {})) {
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (FILTER_KEYS.includes(k) || /^cf_[a-z][a-z0-9_]{1,40}$/.test(k)) out[k] = String(v).trim().slice(0, 200);
  }
  return out;
}

const sortedJson = (o) => JSON.stringify(Object.keys(o || {}).sort().reduce((acc, k) => { acc[k] = o[k]; return acc; }, {}));

/** A hash of everything the approver approves: the list, the template and what fills it. */
export function fingerprint(b) {
  const essence = `${sortedJson(b.filters)}|${b.template_name || ''}|${b.template_language || ''}|${JSON.stringify(b.variables || [])}`;
  return crypto.createHash('sha256').update(essence).digest('hex');
}

// ---------------------------------------------------------------- templates

/** Whether a broadcast can use this template, and why not. */
export function templateSupport(t) {
  if (!t) return { ok: false, why: 'That template is not in the synced list' };
  if (t.status && t.status !== 'APPROVED') return { ok: false, why: `Meta has it as ${String(t.status).toLowerCase()}, not approved` };
  for (const c of t.components || []) {
    const type = String(c.type || '').toUpperCase();
    if (type === 'HEADER' && c.format && String(c.format).toUpperCase() !== 'TEXT') return { ok: false, why: 'It needs a header image, video or file, which broadcasts do not send yet' };
    if (type === 'HEADER' && /\{\{\d+\}\}/.test(c.text || '')) return { ok: false, why: 'Its heading has a blank to fill, which broadcasts do not fill yet' };
    if (type === 'BUTTONS' && (c.buttons || []).some((btn) => /\{\{\d+\}\}/.test(btn.url || ''))) return { ok: false, why: 'A button link has a blank to fill, which broadcasts do not fill yet' };
  }
  return { ok: true, why: null };
}

export async function broadcastTemplates() {
  const { rows } = await query('SELECT name, language, category, status, components, variable_count, synced_at FROM crm_wa_templates ORDER BY name, language');
  return rows.map((t) => ({ ...t, body: fillTemplate(t.components, []), ...(({ ok, why }) => ({ usable: ok, why_not: why }))(templateSupport(t)) }));
}

async function templateOf(b) {
  if (!b.template_name) return null;
  const { rows } = await query('SELECT * FROM crm_wa_templates WHERE name = $1 AND language = $2', [b.template_name, b.template_language || 'en']);
  return rows[0] || null;
}

// ---------------------------------------------------------------- filling the blanks

const firstWord = (v) => (v ? String(v).trim().split(/\s+/)[0] : null);
function valueFor(source, lead) {
  switch (source) {
    case 'first_name': return firstWord(lead.contact_name);
    case 'contact_name': return lead.contact_name;
    case 'organization_name': return lead.organization_name;
    case 'district': return lead.district;
    case 'city': return lead.city;
    case 'state': return lead.state;
    case 'owner_first_name': return firstWord(lead.owner_name);
    case 'owner_name': return lead.owner_name;
    default: return null;
  }
}

/** The values for one lead's blanks, and which blanks had nothing to fill them. */
export function fillValues(variables, count, lead) {
  const values = [];
  const missing = [];
  for (let i = 0; i < count; i += 1) {
    const v = variables[i] || {};
    let text = v.source === 'fixed' ? v.text : valueFor(v.source, lead);
    text = text === null || text === undefined ? '' : String(text).replace(/\s+/g, ' ').trim();
    if (!text && v.fallback) text = String(v.fallback).trim();
    if (!text) missing.push(i + 1);
    values.push(text.slice(0, 200));
  }
  return { values, missing };
}

function checkVariables(variables, count) {
  const problems = [];
  for (let i = 0; i < count; i += 1) {
    const v = variables[i];
    if (!v || !VALUE_SOURCES[v.source]) problems.push(`Choose what fills {{${i + 1}}}`);
    else if (v.source === 'fixed' && !String(v.text || '').trim()) problems.push(`Write the text for {{${i + 1}}}`);
  }
  return problems;
}

// ---------------------------------------------------------------- the list

const tzOf = (s) => s.calendar?.timezone || s.organisation?.timezone || 'Asia/Kolkata';
const broadcastSettings = (all) => ({
  enabled: true, dailyLimit: 250, sendFrom: '09:00', sendUntil: '20:00', minDaysBetween: 3, batchSize: 40,
  ...(all.crm?.sales?.whatsapp?.broadcasts || {}),
});

/**
 * Everyone the lead list gives for the broadcast's filters (inside the
 * owner's view of the CRM), each with the reason they are skipped, if any.
 */
async function listRows(b, owner, settings) {
  const scope = await crmScope(owner);
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const { where } = leadListConditions({ ...b.filters, userId: owner?.id ?? 0 }, scope, await salesSettings(), push);
  const days = push(Number(broadcastSettings(settings).minDaysBetween) || 0);
  const me = push(b.id || 0);
  const { rows } = await query(
    `WITH base AS (
       SELECT l.id, l.ref, l.contact_name, l.organization_name, l.district, l.city, l.state, l.phone, l.phone_normalized, u.full_name AS owner_name
         FROM crm_leads l LEFT JOIN users u ON u.id = l.owner_user_id
        WHERE ${where.join(' AND ')}
     ), ranked AS (
       SELECT b.*, row_number() OVER (PARTITION BY b.phone_normalized ORDER BY b.id) AS number_rank,
              first_value(b.ref) OVER (PARTITION BY b.phone_normalized ORDER BY b.id) AS first_ref
         FROM base b
     )
     SELECT r.*,
       CASE
         WHEN r.phone_normalized IS NULL OR length(r.phone_normalized) NOT BETWEEN 11 AND 15 THEN 'NO_PHONE'
         WHEN r.number_rank > 1 THEN 'SAME_NUMBER'
         WHEN EXISTS (SELECT 1 FROM crm_optouts o WHERE o.channel = 'WHATSAPP' AND o.address = r.phone_normalized AND o.lifted_at IS NULL) THEN 'OPTED_OUT'
         WHEN NOT (EXISTS (SELECT 1 FROM crm_wa_optins oi WHERE oi.phone_normalized = r.phone_normalized AND oi.removed_at IS NULL)
                   OR EXISTS (SELECT 1 FROM crm_wa_messages im WHERE im.phone_normalized = r.phone_normalized AND im.direction = 'INBOUND')) THEN 'NO_OPTIN'
         WHEN ${days}::int > 0 AND EXISTS (
           SELECT 1 FROM crm_wa_messages bm WHERE bm.phone_normalized = r.phone_normalized AND bm.broadcast_id IS NOT NULL AND bm.broadcast_id <> ${me}
              AND bm.direction = 'OUTBOUND' AND bm.provider_message_id IS NOT NULL AND bm.created_at > now() - make_interval(days => ${days}::int)) THEN 'RECENT'
       END AS skip
       FROM ranked r ORDER BY r.id`,
    params,
  );
  return rows;
}

/** The list with each person's values filled in, and the counts by reason. */
async function workOut(b, { settings = null, owner = null } = {}) {
  const s = settings || await getSettings();
  const who = owner || (b.owner_user_id ? await loadUser(b.owner_user_id) : null);
  const template = await templateOf(b);
  const count = template?.variable_count || 0;
  const rows = await listRows(b, who, s);
  const people = rows.map((r) => {
    let skip = r.skip;
    let values = [];
    let missing = [];
    if (!skip && template) {
      ({ values, missing } = fillValues(b.variables || [], count, r));
      if (missing.length) skip = 'MISSING_VALUE';
    }
    return {
      lead_id: r.id, ref: r.ref, name: r.contact_name || r.organization_name || r.ref, organization_name: r.organization_name,
      phone: r.phone, phone_normalized: r.phone_normalized, values, missing, skip,
      why: skip ? (skip === 'SAME_NUMBER' ? `Same number as ${r.first_ref}` : skip === 'MISSING_VALUE' ? `Nothing to fill {{${missing.join('}}, {{')}}}` : SKIP_WORDS[skip]) : null,
    };
  });
  const skipped = {};
  for (const p of people) if (p.skip) skipped[p.skip] = (skipped[p.skip] || 0) + 1;
  return { template, people, matched: people.length, will_send: people.filter((p) => !p.skip).length, skipped };
}

// ---------------------------------------------------------------- reading

const SELECT = `SELECT b.*, o.full_name AS owner_name, c.full_name AS created_by_name, sb.full_name AS submitted_by_name,
                       ap.full_name AS approved_by_name, st.full_name AS started_by_name
                  FROM crm_wa_broadcasts b
                  LEFT JOIN users o ON o.id = b.owner_user_id LEFT JOIN users c ON c.id = b.created_by
                  LEFT JOIN users sb ON sb.id = b.submitted_by LEFT JOIN users ap ON ap.id = b.approved_by
                  LEFT JOIN users st ON st.id = b.started_by`;

async function getRow(id) {
  const { rows } = await query(`${SELECT} WHERE b.id = $1`, [Number(id)]);
  if (!rows[0]) throw notFound('Broadcast not found');
  return rows[0];
}

/** The counts once sending has started: from the recipients and their messages. */
async function progress(id) {
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE r.status = 'PENDING')::int AS pending,
       COUNT(*) FILTER (WHERE r.status = 'SENT')::int AS sent,
       COUNT(*) FILTER (WHERE r.status = 'FAILED' OR (r.status = 'SENT' AND m.status = 'FAILED'))::int AS failed,
       COUNT(*) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped,
       COUNT(*) FILTER (WHERE m.status IN ('DELIVERED', 'READ'))::int AS delivered,
       COUNT(*) FILTER (WHERE m.status = 'READ')::int AS read,
       COUNT(*) FILTER (WHERE r.status = 'SENT' AND EXISTS (
         SELECT 1 FROM crm_wa_messages im WHERE im.phone_normalized = r.phone_normalized AND im.direction = 'INBOUND'
            AND im.created_at > m.created_at AND im.created_at < m.created_at + interval '7 days'))::int AS replied,
       COUNT(*) FILTER (WHERE r.status = 'SENT' AND EXISTS (
         SELECT 1 FROM crm_optouts o WHERE o.channel = 'WHATSAPP' AND o.address = r.phone_normalized AND o.created_at > m.created_at))::int AS opted_out_after
       FROM crm_wa_broadcast_recipients r LEFT JOIN crm_wa_messages m ON m.id = r.message_id
      WHERE r.broadcast_id = $1`,
    [id],
  );
  const { rows: reasons } = await query(
    `SELECT COALESCE(r.reason, m.error_title, 'Failed') AS reason, r.status, COUNT(*)::int AS n
       FROM crm_wa_broadcast_recipients r LEFT JOIN crm_wa_messages m ON m.id = r.message_id
      WHERE r.broadcast_id = $1 AND (r.status IN ('FAILED', 'SKIPPED') OR (r.status = 'SENT' AND m.status = 'FAILED'))
      GROUP BY 1, 2 ORDER BY n DESC`,
    [id],
  );
  return { ...rows[0], reasons };
}

function shape(row, user) {
  return {
    ...row,
    can: {
      edit: hasPermission(user, 'marketing.manage') && ['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(row.status),
      submit: hasPermission(user, 'marketing.manage') && row.status === 'DRAFT',
      approve: hasPermission(user, 'marketing.approve') && row.status === 'IN_REVIEW',
      send: hasPermission(user, 'marketing.send') && row.status === 'APPROVED',
      pause: hasPermission(user, 'marketing.send') && row.status === 'SENDING',
      resume: hasPermission(user, 'marketing.send') && row.status === 'PAUSED',
      cancel: (hasPermission(user, 'marketing.manage') || hasPermission(user, 'marketing.send')) && !['SENT', 'CANCELLED'].includes(row.status),
      test: (hasPermission(user, 'marketing.manage') || hasPermission(user, 'marketing.approve')) && !['SENT', 'CANCELLED'].includes(row.status),
    },
  };
}

export async function listBroadcasts(user) {
  const { rows } = await query(`${SELECT} ORDER BY CASE WHEN b.status IN ('SENDING', 'PAUSED', 'SCHEDULED', 'IN_REVIEW') THEN 0 ELSE 1 END, b.updated_at DESC LIMIT 200`);
  const out = [];
  for (const r of rows) out.push({ ...shape(r, user), progress: ['SENDING', 'PAUSED', 'SENT', 'CANCELLED'].includes(r.status) ? await progress(r.id) : null });
  return out;
}

/** One broadcast: its list worked out now (before sending) or its progress (after). */
export async function getBroadcast(id, user, { people = false, reason = null, offset = 0, limit = 50 } = {}) {
  const row = await getRow(id);
  const settings = await getSettings();
  const template = await templateOf(row);
  const out = {
    broadcast: shape(row, user),
    template: template ? { ...template, body: fillTemplate(template.components, []), ...(({ ok, why }) => ({ usable: ok, why_not: why }))(templateSupport(template)) } : null,
    whatsapp: (({ configured, missing }) => ({ configured, missing }))(whatsappStatus()),
    settings: broadcastSettings(settings),
    changed_since_approval: Boolean(row.approved_fingerprint) && row.approved_fingerprint !== fingerprint(row),
  };
  const started = ['SENDING', 'PAUSED', 'SENT'].includes(row.status) || (row.status === 'CANCELLED' && row.started_at);
  if (started) {
    out.progress = await progress(row.id);
    if (people) {
      const params = [row.id];
      const filter = reason ? ` AND (r.status = $2 OR r.reason = $2)` : '';
      if (reason) params.push(reason);
      const { rows } = await query(
        `SELECT r.id, r.lead_id, r.status, r.reason, r.variables AS values, r.processed_at, l.ref, COALESCE(l.contact_name, l.organization_name, l.ref) AS name, l.phone,
                m.status AS message_status, m.error_title, m.delivered_at, m.read_at
           FROM crm_wa_broadcast_recipients r
           LEFT JOIN crm_leads l ON l.id = r.lead_id LEFT JOIN crm_wa_messages m ON m.id = r.message_id
          WHERE r.broadcast_id = $1${filter} ORDER BY r.id LIMIT ${Math.min(Number(limit) || 50, 200)} OFFSET ${Math.max(Number(offset) || 0, 0)}`,
        params,
      );
      out.people = rows;
    }
    return out;
  }
  const list = await workOut(row, { settings });
  out.list = { matched: list.matched, will_send: list.will_send, skipped: Object.entries(list.skipped).map(([code, n]) => ({ code, n, words: SKIP_WORDS[code] })) };
  out.sample = list.people.filter((p) => !p.skip).slice(0, 3).map((p) => ({ ref: p.ref, name: p.name, values: p.values, text: template ? fillTemplate(template.components, p.values) : null }));
  if (people) {
    const chosen = reason === 'SEND' ? list.people.filter((p) => !p.skip) : reason ? list.people.filter((p) => p.skip === reason) : list.people;
    out.people = chosen.slice(Math.max(Number(offset) || 0, 0), Math.max(Number(offset) || 0, 0) + Math.min(Number(limit) || 50, 200))
      .map((p) => ({ lead_id: p.lead_id, ref: p.ref, name: p.name, phone: p.phone, skip: p.skip, why: p.why }));
    out.people_total = chosen.length;
  }
  return out;
}

// ---------------------------------------------------------------- changing it

const need = (user, perm) => { if (!hasPermission(user, perm)) throw forbidden(`Requires permission: ${perm}`); };

function readInput(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (name.length < 3) throw badRequest('Give the broadcast a name of at least 3 characters');
    out.name = name.slice(0, 160);
  }
  if (!partial || input.filters !== undefined) out.filters = cleanFilters(input.filters || {});
  if (input.template_name !== undefined) {
    out.template_name = input.template_name ? String(input.template_name).slice(0, 200) : null;
    out.template_language = input.template_language ? String(input.template_language).slice(0, 20) : 'en';
  }
  if (input.variables !== undefined) {
    if (!Array.isArray(input.variables) || input.variables.length > 20) throw badRequest('Say what fills each blank');
    out.variables = input.variables.map((v) => ({
      source: VALUE_SOURCES[v?.source] ? v.source : null,
      text: v?.source === 'fixed' ? String(v.text ?? '').slice(0, 200) : null,
      fallback: v?.fallback ? String(v.fallback).slice(0, 200) : null,
    }));
  }
  return out;
}

export async function createBroadcast(user, input) {
  need(user, 'marketing.manage');
  const data = readInput(input);
  const { rows } = await query(
    `INSERT INTO crm_wa_broadcasts (name, filters, template_name, template_language, variables, owner_user_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
    [data.name, JSON.stringify(data.filters), data.template_name ?? null, data.template_language ?? null, JSON.stringify(data.variables || []), user.id],
  );
  return getBroadcast(rows[0].id, user);
}

export async function updateBroadcast(id, user, input) {
  need(user, 'marketing.manage');
  const row = await getRow(id);
  if (!['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(row.status)) throw conflict('Only a broadcast that has not started sending can be changed');
  const data = readInput(input, { partial: true });
  const next = { ...row, ...data };
  const contentChanged = fingerprint(next) !== fingerprint(row);
  const sets = [];
  const params = [row.id];
  for (const [k, v] of Object.entries(data)) { params.push(['filters', 'variables'].includes(k) ? JSON.stringify(v) : v); sets.push(`${k} = $${params.length}`); }
  // a change to what was approved, or to what is being reviewed, starts the approval again
  if (contentChanged && row.status !== 'DRAFT') {
    sets.push(`status = 'DRAFT'`, 'approved_by = NULL', 'approved_at = NULL', 'approved_fingerprint = NULL', 'approved_count = NULL',
      `review_note = 'Changed after it was sent for approval; approve it again'`);
  }
  if (sets.length) await query(`UPDATE crm_wa_broadcasts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  return getBroadcast(row.id, user);
}

/** What stops it going for approval or out. */
async function problemsOf(row) {
  const problems = [];
  const template = await templateOf(row);
  if (!row.template_name) problems.push('Choose the WhatsApp template');
  else {
    const support = templateSupport(template);
    if (!support.ok) problems.push(`The template cannot be used: ${support.why}`);
    else problems.push(...checkVariables(row.variables || [], template.variable_count || 0));
  }
  const list = problems.length ? null : await workOut(row);
  if (list && !list.will_send) problems.push('Nobody in the list can get it yet (see why each person is skipped)');
  return { problems, list };
}

async function approversExcept(userId) {
  const { rows } = await query('SELECT id, role, extra_permissions, revoked_permissions FROM users WHERE is_active AND id <> $1', [userId]);
  return rows.filter((u) => hasPermission(u, 'marketing.approve'));
}

export async function submitBroadcast(id, user) {
  need(user, 'marketing.manage');
  const row = await getRow(id);
  if (row.status !== 'DRAFT') throw conflict('Only a draft can be sent for approval');
  const { problems, list } = await problemsOf(row);
  if (problems.length) throw badRequest(`Fix these first: ${problems.join('; ')}`, { problems });
  const settings = await getSettings();
  // the same approval settings as email campaigns
  if (!settings.marketing?.approvals?.required) {
    await query(
      `UPDATE crm_wa_broadcasts SET status = 'APPROVED', submitted_by = $2, submitted_at = now(), approved_by = $2, approved_at = now(),
              approved_fingerprint = $3, approved_count = $4, review_note = 'Approval is switched off in Settings', updated_at = now() WHERE id = $1`,
      [row.id, user.id, fingerprint(row), list.will_send],
    );
  } else {
    await query(`UPDATE crm_wa_broadcasts SET status = 'IN_REVIEW', submitted_by = $2, submitted_at = now(), review_note = NULL, updated_at = now() WHERE id = $1`, [row.id, user.id]);
    for (const a of await approversExcept(user.id)) {
      await notify(null, { userId: a.id, type: 'marketing_review', title: 'A WhatsApp broadcast is waiting for your approval', body: `${row.name}: ${list.will_send} people, sent by ${user.full_name}` });
    }
  }
  await recordAuditEvent(null, { action: 'WA_BROADCAST_SUBMITTED', entityType: 'WA_BROADCAST', entityId: row.id, actorId: user.id, summary: row.name, detail: { will_send: list.will_send } });
  return getBroadcast(row.id, user);
}

export async function approveBroadcast(id, user, note = null) {
  need(user, 'marketing.approve');
  const row = await getRow(id);
  if (row.status !== 'IN_REVIEW') throw conflict('This broadcast is not waiting for approval');
  const settings = await getSettings();
  if (row.submitted_by === user.id && !settings.marketing?.approvals?.allowSelfApproval) {
    throw forbidden('Someone other than the person who sent it for approval approves it');
  }
  const { problems, list } = await problemsOf(row);
  if (problems.length) throw badRequest(`It cannot be approved yet: ${problems.join('; ')}`, { problems });
  await query(
    `UPDATE crm_wa_broadcasts SET status = 'APPROVED', approved_by = $2, approved_at = now(), approved_fingerprint = $3, approved_count = $4,
            review_note = $5, updated_at = now() WHERE id = $1`,
    [row.id, user.id, fingerprint(row), list.will_send, note ? String(note).slice(0, 1000) : null],
  );
  if (row.submitted_by && row.submitted_by !== user.id) {
    await notify(null, { userId: row.submitted_by, type: 'marketing_review', title: 'Your WhatsApp broadcast was approved', body: `${row.name}: ${list.will_send} people` });
  }
  await recordAuditEvent(null, { action: 'WA_BROADCAST_APPROVED', entityType: 'WA_BROADCAST', entityId: row.id, actorId: user.id, summary: row.name, detail: { will_send: list.will_send } });
  return getBroadcast(row.id, user);
}

export async function requestChanges(id, user, note) {
  need(user, 'marketing.approve');
  if (!String(note || '').trim()) throw badRequest('Say what needs to change');
  const row = await getRow(id);
  if (row.status !== 'IN_REVIEW') throw conflict('This broadcast is not waiting for approval');
  await query(`UPDATE crm_wa_broadcasts SET status = 'DRAFT', review_note = $2, updated_at = now() WHERE id = $1`, [row.id, String(note).trim().slice(0, 1000)]);
  if (row.submitted_by) await notify(null, { userId: row.submitted_by, type: 'marketing_review', title: 'Changes asked on your WhatsApp broadcast', body: `${row.name}: ${String(note).trim()}` });
  return getBroadcast(row.id, user);
}

/** Works out who gets it, now, and stores each person with their values or the reason they are skipped. */
async function buildRecipients(row) {
  const list = await workOut(row);
  await withTransaction(async (client) => {
    for (const p of list.people) {
      await client.query(
        `INSERT INTO crm_wa_broadcast_recipients (broadcast_id, lead_id, phone_normalized, variables, status, reason, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'SKIPPED' THEN now() END)
         ON CONFLICT DO NOTHING`,
        [row.id, p.lead_id, p.phone_normalized, JSON.stringify(p.values), p.skip ? 'SKIPPED' : 'PENDING', p.skip ? p.why : null],
      );
    }
  });
  return list;
}

/** "Send now" or "Send at": only exactly what was approved, and only with WhatsApp connected. */
export async function sendBroadcast(id, user, { send_at = null } = {}) {
  need(user, 'marketing.send');
  const row = await getRow(id);
  if (row.status !== 'APPROVED') throw conflict('Only an approved broadcast can be sent');
  if (row.approved_fingerprint !== fingerprint(row)) throw conflict('It changed after it was approved; it needs approving again');
  const wa = whatsappStatus();
  if (!wa.configured) throw conflict(`WhatsApp is not connected: ${wa.missing.join(', ')} not set on the server`);
  const settings = broadcastSettings(await getSettings());
  if (!settings.enabled) throw conflict('WhatsApp broadcasts are switched off in Settings');
  const at = send_at ? new Date(send_at) : null;
  if (at && Number.isNaN(at.getTime())) throw badRequest('Choose when to send it');
  if (at && at.getTime() > Date.now() + 60_000) {
    if (at.getTime() > Date.now() + 60 * 86_400_000) throw badRequest('Schedule it within the next 60 days');
    await query(`UPDATE crm_wa_broadcasts SET status = 'SCHEDULED', send_at = $2, started_by = $3, updated_at = now() WHERE id = $1`, [row.id, at, user.id]);
    await recordAuditEvent(null, { action: 'WA_BROADCAST_SCHEDULED', entityType: 'WA_BROADCAST', entityId: row.id, actorId: user.id, summary: row.name, detail: { send_at: at } });
    return getBroadcast(row.id, user);
  }
  await startSending(row, user.id);
  return getBroadcast(row.id, user);
}

async function startSending(row, starterId) {
  const { rowCount } = await query(
    `UPDATE crm_wa_broadcasts SET status = 'SENDING', started_by = COALESCE(started_by, $2), started_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('APPROVED', 'SCHEDULED')`, [row.id, starterId]);
  if (!rowCount) return null;
  const list = await buildRecipients(row);
  await recordAuditEvent(null, { action: 'WA_BROADCAST_STARTED', entityType: 'WA_BROADCAST', entityId: row.id, actorId: starterId, summary: row.name, detail: { will_send: list.will_send, matched: list.matched } });
  return list;
}

export async function pauseBroadcast(id, user) {
  need(user, 'marketing.send');
  const { rowCount } = await query(
    `UPDATE crm_wa_broadcasts SET status = 'PAUSED', paused_at = now(), pause_reason = $2, updated_at = now() WHERE id = $1 AND status = 'SENDING'`,
    [Number(id), `Paused by ${user.full_name}`]);
  if (!rowCount) throw conflict('Only a broadcast that is sending can be paused');
  return getBroadcast(id, user);
}

export async function resumeBroadcast(id, user) {
  need(user, 'marketing.send');
  const { rowCount } = await query(
    `UPDATE crm_wa_broadcasts SET status = 'SENDING', paused_at = NULL, pause_reason = NULL, updated_at = now() WHERE id = $1 AND status = 'PAUSED'`, [Number(id)]);
  if (!rowCount) throw conflict('Only a paused broadcast can be resumed');
  return getBroadcast(id, user);
}

export async function cancelBroadcast(id, user, reason = null) {
  if (!hasPermission(user, 'marketing.manage') && !hasPermission(user, 'marketing.send')) throw forbidden('Requires permission: marketing.manage or marketing.send');
  const row = await getRow(id);
  if (['SENT', 'CANCELLED'].includes(row.status)) throw conflict('It has already finished');
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE crm_wa_broadcasts SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now() WHERE id = $1`,
      [row.id, user.id, reason ? String(reason).slice(0, 500) : null]);
    await client.query(
      `UPDATE crm_wa_broadcast_recipients SET status = 'SKIPPED', reason = $2, processed_at = now() WHERE broadcast_id = $1 AND status = 'PENDING'`,
      [row.id, SKIP_WORDS.CANCELLED]);
  });
  await recordAuditEvent(null, { action: 'WA_BROADCAST_CANCELLED', entityType: 'WA_BROADCAST', entityId: row.id, actorId: user.id, summary: row.name, reason });
  return getBroadcast(row.id, user);
}

/** Puts the failed ones back in line. A message WhatsApp accepted is never sent again. */
export async function retryFailed(id, user) {
  need(user, 'marketing.send');
  const row = await getRow(id);
  if (!['SENDING', 'PAUSED', 'SENT'].includes(row.status)) throw conflict('Only a broadcast that has sent can retry its failed messages');
  const { rowCount } = await query(
    `UPDATE crm_wa_broadcast_recipients r SET status = 'PENDING', reason = NULL, processed_at = NULL
       FROM crm_wa_messages m
      WHERE r.broadcast_id = $1 AND r.status = 'FAILED' AND m.id = r.message_id AND m.provider_message_id IS NULL AND m.attempts < 5`,
    [row.id]);
  if (!rowCount) throw conflict('Nothing to retry: the failed messages were tried five times, or WhatsApp accepted them');
  if (row.status === 'SENT') await query(`UPDATE crm_wa_broadcasts SET status = 'SENDING', finished_at = NULL, updated_at = now() WHERE id = $1`, [row.id]);
  return { ...(await getBroadcast(row.id, user)), retrying: rowCount };
}

/** A test to the person's own phone (their TaskFlow profile), with the first person's values. */
export async function testBroadcast(id, user) {
  if (!hasPermission(user, 'marketing.manage') && !hasPermission(user, 'marketing.approve')) throw forbidden('Requires permission: marketing.manage or marketing.approve');
  const row = await getRow(id);
  const { rows: me } = await query('SELECT phone FROM users WHERE id = $1', [user.id]);
  const myPhone = me[0]?.phone;
  if (!normalizePhone(myPhone)) throw badRequest('Add your phone number to your profile first; the test goes to you');
  const { problems, list } = await problemsOf(row);
  const blocking = problems.filter((p) => !p.startsWith('Nobody in the list'));
  if (blocking.length) throw badRequest(`Fix these first: ${blocking.join('; ')}`, { problems: blocking });
  const first = list?.people.find((p) => !p.skip);
  const template = await templateOf(row);
  const values = first ? first.values : fillValues(row.variables || [], template.variable_count || 0, {}).values.map((v, i) => v || `{{${i + 1}}}`);
  const r = await sendWhatsApp({ to: myPhone, template_name: row.template_name, language: row.template_language, variables: values }, { actor: user });
  return { message: r.message, values, sample_of: first ? first.ref : null };
}

// ---------------------------------------------------------------- the sender (sales worker)

const hhmm = (date, tz) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(date);

/** Where sending stands right now: inside the hours, and how many may still go in this 24 hours. */
export async function sendingRoom(now = new Date(), all = null) {
  const settings = all || await getSettings();
  const s = broadcastSettings(settings);
  const local = hhmm(now, tzOf(settings));
  const inHours = local >= s.sendFrom && local < s.sendUntil;
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM crm_wa_messages WHERE broadcast_id IS NOT NULL AND direction = 'OUTBOUND' AND created_at > $1::timestamptz - interval '24 hours'`, [now]);
  return { inHours, local, sentLast24h: rows[0].n, left: Math.max(0, (Number(s.dailyLimit) || 0) - rows[0].n), settings: s };
}

/** A person's standing just before their message goes: still in the list's terms, still agreed. */
async function stillAgreed(recipient) {
  const { rows } = await query(
    `SELECT l.is_archived,
            EXISTS (SELECT 1 FROM crm_optouts o WHERE o.channel = 'WHATSAPP' AND o.address = $2 AND o.lifted_at IS NULL) AS opted_out,
            (EXISTS (SELECT 1 FROM crm_wa_optins oi WHERE oi.phone_normalized = $2 AND oi.removed_at IS NULL)
             OR EXISTS (SELECT 1 FROM crm_wa_messages im WHERE im.phone_normalized = $2 AND im.direction = 'INBOUND')) AS agreed
       FROM crm_leads l WHERE l.id = $1`, [recipient.lead_id, recipient.phone_normalized]);
  const r = rows[0];
  if (!r || r.is_archived) return { ok: false, why: SKIP_WORDS.CHANGED };
  if (r.opted_out) return { ok: false, why: SKIP_WORDS.OPTED_OUT };
  if (!r.agreed) return { ok: false, why: SKIP_WORDS.NO_OPTIN };
  return { ok: true };
}

const STOP_AFTER_FAILURES = 10;

/** One pass: start what was scheduled, then send a batch inside the hours and the daily limit. */
export async function runBroadcasts(now = new Date(), { fetchImpl } = {}) {
  const settings = await getSettings();
  const s = broadcastSettings(settings);
  if (!s.enabled) return { skipped: 'switched off' };
  const out = { started: 0, sent: 0, failed: 0, skipped: 0, finished: 0, paused: 0 };
  const { rows: due } = await query(`SELECT * FROM crm_wa_broadcasts WHERE status = 'SCHEDULED' AND send_at <= $1 ORDER BY send_at`, [now]);
  for (const b of due) {
    if (b.approved_fingerprint !== fingerprint(b)) {
      await query(`UPDATE crm_wa_broadcasts SET status = 'PAUSED', pause_reason = 'It changed after it was approved', updated_at = now() WHERE id = $1`, [b.id]);
      continue;
    }
    if (await startSending(b, b.started_by)) out.started += 1;
  }
  if (!whatsappStatus().configured) return { ...out, waiting: 'WhatsApp is not connected' };
  const room = await sendingRoom(now, settings);
  if (!room.inHours) return { ...out, waiting: `Outside sending hours (${s.sendFrom}–${s.sendUntil})` };
  let left = room.left;
  if (left <= 0) return { ...out, waiting: 'Daily limit reached' };

  const { rows: sending } = await query(`SELECT * FROM crm_wa_broadcasts WHERE status = 'SENDING' ORDER BY started_at, id`);
  for (const b of sending) {
    if (left <= 0) break;
    const sender = b.started_by ? await loadUser(b.started_by) : null;
    // claim a batch; a claim older than 10 minutes (a crashed pass) is taken again, and the idempotency key keeps it to one message
    const { rows: batch } = await query(
      `UPDATE crm_wa_broadcast_recipients SET processed_at = now()
        WHERE id IN (SELECT id FROM crm_wa_broadcast_recipients
                      WHERE broadcast_id = $1 AND status = 'PENDING' AND (processed_at IS NULL OR processed_at < now() - interval '10 minutes')
                      ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [b.id, Math.min(Number(s.batchSize) || 40, left)]);
    let failuresInARow = 0;
    let lastError = null;
    for (const r of batch) {
      const fresh = await query(`SELECT status FROM crm_wa_broadcasts WHERE id = $1`, [b.id]);
      if (fresh.rows[0]?.status !== 'SENDING') {
        await query(`UPDATE crm_wa_broadcast_recipients SET processed_at = NULL WHERE id = $1 AND status = 'PENDING'`, [r.id]);
        continue;
      }
      const check = await stillAgreed(r);
      if (!check.ok) {
        await query(`UPDATE crm_wa_broadcast_recipients SET status = 'SKIPPED', reason = $2, processed_at = now() WHERE id = $1`, [r.id, check.why]);
        out.skipped += 1;
        continue;
      }
      let result;
      try {
        // a message tried before (put back by "Retry the failed ones") is retried as itself, never sent anew
        result = r.message_id
          ? { message: await retryWhatsApp(r.message_id, fetchImpl ? { fetchImpl } : {}) }
          : await sendWhatsApp({
            to: r.phone_normalized, template_name: b.template_name, language: b.template_language, variables: r.variables,
            lead_id: r.lead_id, broadcast_id: b.id, idempotency_key: `wa-broadcast:${b.id}:${r.id}`,
          }, { actor: sender, ...(fetchImpl ? { fetchImpl } : {}) });
      } catch (err) {
        result = { message: null, error: err.message };
      }
      const m = result.message;
      let status;
      let reason = null;
      if (result.blocked) { status = 'SKIPPED'; reason = SKIP_WORDS.OPTED_OUT; } else if (!m) { status = 'FAILED'; reason = result.error || 'Not sent'; } else if (m.provider_message_id) status = 'SENT';
      else if (m.status === 'FAILED') { status = 'FAILED'; reason = m.error_title || 'WhatsApp did not accept it'; } else if (result.duplicate) { status = 'FAILED'; reason = 'Interrupted before WhatsApp answered; not known whether it went'; } else status = 'SENT';
      await query(`UPDATE crm_wa_broadcast_recipients SET status = $2, reason = $3, message_id = COALESCE($4, message_id), processed_at = now() WHERE id = $1`,
        [r.id, status, reason, m?.id ?? null]);
      if (status === 'SENT') { out.sent += 1; left -= 1; failuresInARow = 0; } else if (status === 'FAILED') { out.failed += 1; left -= 1; failuresInARow += 1; lastError = reason; } else out.skipped += 1;
      // many refusals in a row usually mean the number, the template or the limit: stop and let a person look
      if (failuresInARow >= STOP_AFTER_FAILURES) {
        await query(`UPDATE crm_wa_broadcasts SET status = 'PAUSED', paused_at = now(), pause_reason = $2, updated_at = now() WHERE id = $1 AND status = 'SENDING'`,
          [b.id, `Paused: WhatsApp refused ${STOP_AFTER_FAILURES} messages in a row (${lastError})`]);
        out.paused += 1;
        for (const who of new Set([b.started_by, b.created_by].filter(Boolean))) {
          await notify(null, { userId: who, type: 'marketing_review', title: `WhatsApp broadcast paused: ${b.name}`, body: `WhatsApp refused ${STOP_AFTER_FAILURES} messages in a row: ${lastError}` });
        }
        break;
      }
    }
    const { rows: pend } = await query(`SELECT COUNT(*)::int AS n FROM crm_wa_broadcast_recipients WHERE broadcast_id = $1 AND status = 'PENDING'`, [b.id]);
    if (!pend[0].n) {
      const { rowCount } = await query(`UPDATE crm_wa_broadcasts SET status = 'SENT', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'SENDING'`, [b.id]);
      if (rowCount) {
        out.finished += 1;
        const p = await progress(b.id);
        for (const who of new Set([b.started_by, b.created_by].filter(Boolean))) {
          await notify(null, { userId: who, type: 'marketing_review', title: `WhatsApp broadcast sent: ${b.name}`, body: `${p.sent} sent, ${p.failed} failed, ${p.skipped} skipped` });
        }
      }
    }
  }
  return out;
}
