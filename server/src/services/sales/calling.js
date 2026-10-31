/**
 * Tele-sales: the way a calling team works, which TeleCRM used to provide.
 *
 *   calling statuses  TeleCRM-style statuses ("Ringing Not Responding",
 *                     "Interested", "Lost"…), each mapped onto the lead's
 *                     lifecycle. Setting one logs the call, counts the attempt,
 *                     schedules a retry for no answer or busy (until the
 *                     status's attempt limit), books a callback when one is
 *                     agreed, and closes the lead when the status is won or lost
 *   the call queue    what to call next: callbacks that are due, then new
 *                     leads nobody has called, then retries that are due
 *   lead fields       custom questions on a lead; a choice can carry a
 *                     category ("Agri retailer" → Retailer), so the answer
 *                     says who the lead is
 *
 * Nothing here dials or records a call: a phone opens its own dialler from a
 * tel: link, and a call is what the person says happened. Calls placed through
 * a telephony provider arrive through comms.js instead.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { recordAuditEvent } from '../audit.js';
import { reassignLead, autoAssignLead } from './assignment.js';
import { recordManualCall } from './comms.js';
import { createFollowUp } from './followups.js';
import { LEAD_SELECT, cancelLeadFollowUps, decorateLead, getLead, logLeadActivity } from './leads.js';
import { classifyAccount, routeLead } from './routing.js';
import { refreshScore } from './scoring.js';
import {
  KNOWN_CATEGORIES, OPEN_LEAD_STATUSES, cleanText, emitEvent, isEligible, salesSettings, teleSalesHere,
} from './core.js';

export const LIFECYCLES = ['NEW', 'CONTACTED', 'QUALIFYING', 'QUALIFIED', 'NURTURE', 'WON', 'DISQUALIFIED'];
export const CALL_OUTCOMES = ['NONE', 'NOT_CONNECTED', 'CONNECTED'];
export const FIELD_TYPES = ['TEXT', 'LONG_TEXT', 'SELECT', 'MULTI_SELECT', 'NUMBER', 'DATE', 'URL'];
const CLOSED = ['WON', 'DISQUALIFIED'];

const slug = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// ---------------------------------------------------------------- calling statuses

export async function callStatuses({ activeOnly = false, runner = { query } } = {}) {
  const { rows } = await runner.query(
    `SELECT * FROM crm_call_statuses ${activeOnly ? 'WHERE is_active = TRUE' : ''} ORDER BY position, id`,
  );
  return rows;
}

/** Finds a status by its label, key or id, as an import or a person names it. */
export function findStatus(statuses, value) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim().toLowerCase();
  return statuses.find((s) => String(s.id) === v || s.key === v || s.label.toLowerCase() === v || slug(s.label) === slug(v)) || null;
}

export async function saveCallStatus(id, data, actor) {
  const clean = {
    label: cleanText(data.label, 80), lifecycle: data.lifecycle, outcome: data.outcome,
    retry_after_minutes: data.retry_after_minutes ?? null, max_attempts: data.max_attempts ?? null,
    needs_reason: data.needs_reason, implies_category: data.implies_category ?? null, color: cleanText(data.color, 20),
    is_active: data.is_active,
  };
  if (clean.lifecycle !== undefined && !LIFECYCLES.includes(clean.lifecycle)) throw badRequest('Unknown lifecycle');
  if (clean.outcome !== undefined && !CALL_OUTCOMES.includes(clean.outcome)) throw badRequest('Unknown call outcome');
  if (clean.implies_category && !KNOWN_CATEGORIES.includes(clean.implies_category)) throw badRequest('Unknown category');
  return withTransaction(async (client) => {
    let row;
    if (!id) {
      if (!clean.label || !clean.lifecycle) throw badRequest('A status needs a name and what it means for the lead');
      const { rows } = await client.query(
        `INSERT INTO crm_call_statuses (key, label, lifecycle, outcome, retry_after_minutes, max_attempts, needs_reason, implies_category, color, position)
         VALUES ($1,$2,$3,COALESCE($4,'CONNECTED'),$5,$6,COALESCE($7,FALSE),$8,$9,(SELECT COALESCE(MAX(position),0) + 1 FROM crm_call_statuses))
         ON CONFLICT (key) DO NOTHING RETURNING *`,
        [slug(clean.label) || `status-${Date.now()}`, clean.label, clean.lifecycle, clean.outcome ?? null, clean.retry_after_minutes,
          clean.max_attempts, clean.needs_reason ?? null, clean.implies_category, clean.color],
      );
      if (!rows[0]) throw conflict('A status with that name already exists');
      row = rows[0];
    } else {
      const { rows } = await client.query(
        `UPDATE crm_call_statuses SET label = COALESCE($2, label), lifecycle = COALESCE($3, lifecycle), outcome = COALESCE($4, outcome),
                retry_after_minutes = CASE WHEN $5::boolean THEN $6::int ELSE retry_after_minutes END,
                max_attempts = CASE WHEN $7::boolean THEN $8::int ELSE max_attempts END,
                needs_reason = COALESCE($9, needs_reason),
                implies_category = CASE WHEN $10::boolean THEN $11::text ELSE implies_category END,
                color = COALESCE($12, color), is_active = COALESCE($13, is_active), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, clean.label ?? null, clean.lifecycle ?? null, clean.outcome ?? null, data.retry_after_minutes !== undefined, clean.retry_after_minutes,
          data.max_attempts !== undefined, clean.max_attempts, clean.needs_reason ?? null, data.implies_category !== undefined, clean.implies_category,
          clean.color ?? null, clean.is_active ?? null],
      );
      if (!rows[0]) throw notFound('Status not found');
      row = rows[0];
    }
    await recordAuditEvent(client, { action: id ? 'CALL_STATUS_CHANGED' : 'CALL_STATUS_CREATED', entityType: 'SETTINGS', entityId: row.id, actorId: actor.id, summary: row.label, detail: data });
    return row;
  });
}

export async function reorderCallStatuses(ids) {
  await withTransaction(async (client) => {
    for (const [i, id] of ids.entries()) await client.query('UPDATE crm_call_statuses SET position = $2, updated_at = now() WHERE id = $1', [id, i + 1]);
  });
  return callStatuses();
}

// ---------------------------------------------------------------- lead fields

export async function leadFields({ activeOnly = false, runner = { query } } = {}) {
  const { rows } = await runner.query(`SELECT * FROM crm_lead_fields ${activeOnly ? 'WHERE is_active = TRUE' : ''} ORDER BY position, id`);
  return rows;
}

const optionKey = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The choice a piece of text names: its value, its label or one of its
 * aliases, ignoring case and spacing. A multi-choice field also accepts a cell
 * naming several choices ("Kit, Clinic Setup", or labels run together).
 */
export function matchOption(field, text) {
  if (text === null || text === undefined || String(text).trim() === '') return null;
  const options = field.options || [];
  const names = (o) => [o.value, o.label, ...(o.aliases || [])].map(optionKey).filter(Boolean);
  const t = optionKey(text);
  const exact = options.find((o) => names(o).includes(t));
  if (field.type === 'SELECT') return exact ? exact.value : null;
  if (exact) return [exact.value];
  const parts = String(text).split(/[,;|/]+/).map(optionKey).filter(Boolean);
  const found = new Set();
  for (const p of parts) { const o = options.find((x) => names(x).includes(p)); if (o) found.add(o.value); }
  // labels run together without separators: look for each choice's longest name inside the text
  if (!found.size) {
    for (const o of options) {
      const name = names(o).filter((n) => n.length >= 6).sort((a, b) => b.length - a.length).find((n) => t.includes(n));
      if (name) found.add(o.value);
    }
  }
  return found.size ? [...found] : null;
}

/**
 * Checks custom field values against their definitions. Unknown keys and
 * values that do not fit are reported, never stored silently.
 */
export function cleanCustomFields(values = {}, fields = []) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const clean = {};
  const errors = {};
  for (const [key, raw] of Object.entries(values || {})) {
    const field = byKey.get(key);
    if (!field) { errors[key] = 'Not a lead field'; continue; }
    if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && !raw.length)) { clean[key] = null; continue; }
    const choices = new Set((field.options || []).map((o) => o.value));
    switch (field.type) {
      case 'SELECT':
        if (!choices.has(String(raw))) errors[key] = `"${raw}" is not one of the choices`; else clean[key] = String(raw);
        break;
      case 'MULTI_SELECT': {
        const list = (Array.isArray(raw) ? raw : [raw]).map(String);
        const bad = list.filter((v) => !choices.has(v));
        if (bad.length) errors[key] = `"${bad.join('", "')}" is not one of the choices`; else clean[key] = [...new Set(list)];
        break;
      }
      case 'NUMBER': {
        const n = Number(String(raw).replace(/[,\s₹]/g, ''));
        if (!Number.isFinite(n)) errors[key] = 'Not a number'; else clean[key] = n;
        break;
      }
      case 'DATE':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) errors[key] = 'Use a date (YYYY-MM-DD)'; else clean[key] = String(raw);
        break;
      case 'URL':
        if (!/^https?:\/\/\S+$/i.test(String(raw))) errors[key] = 'Not a web address'; else clean[key] = String(raw).slice(0, 500);
        break;
      default:
        clean[key] = String(raw).trim().slice(0, field.type === 'LONG_TEXT' ? 5000 : 500);
    }
  }
  return { clean, errors };
}

/** The category an answer implies ("Agri retailer" → RETAILER), from the first choice field that carries one. */
export function categoryFromFields(custom = {}, fields = []) {
  for (const f of fields) {
    if (f.type !== 'SELECT' || !custom?.[f.key]) continue;
    const o = (f.options || []).find((x) => x.value === custom[f.key]);
    if (o?.category && KNOWN_CATEGORIES.includes(o.category)) return { category: o.category, field: f, option: o };
  }
  return null;
}

export async function saveLeadField(id, data, actor) {
  if (data.type !== undefined && !FIELD_TYPES.includes(data.type)) throw badRequest('Unknown field type');
  const options = data.options === undefined ? undefined : (data.options || []).map((o) => ({
    value: String(o.value || slug(o.label).replace(/-/g, '_')).slice(0, 60),
    label: String(o.label || o.value).slice(0, 120),
    aliases: (o.aliases || []).map((a) => String(a).slice(0, 200)).filter(Boolean).slice(0, 30),
    ...(o.category && KNOWN_CATEGORIES.includes(o.category) ? { category: o.category } : {}),
  })).filter((o) => o.value);
  if (options && new Set(options.map((o) => o.value)).size !== options.length) throw badRequest('Two choices have the same value');
  return withTransaction(async (client) => {
    let row;
    if (!id) {
      const key = String(data.key || slug(data.label).replace(/-/g, '_')).slice(0, 40);
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) throw badRequest('Give the field a name that starts with a letter');
      if (!cleanText(data.label) || !data.type) throw badRequest('A field needs a name and a type');
      const { rows } = await client.query(
        `INSERT INTO crm_lead_fields (key, label, type, options, help, position, show_in_list, filterable)
         VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(position),0) + 1 FROM crm_lead_fields WHERE position < 90),COALESCE($6,FALSE),COALESCE($7,FALSE))
         ON CONFLICT (key) DO NOTHING RETURNING *`,
        [key, cleanText(data.label, 120), data.type, JSON.stringify(options || []), cleanText(data.help, 500) ?? null, data.show_in_list ?? null, data.filterable ?? null],
      );
      if (!rows[0]) throw conflict('A field with that name already exists');
      row = rows[0];
    } else {
      const { rows } = await client.query(
        `UPDATE crm_lead_fields SET label = COALESCE($2, label), options = COALESCE($3, options), help = CASE WHEN $4::boolean THEN $5 ELSE help END,
                show_in_list = COALESCE($6, show_in_list), filterable = COALESCE($7, filterable), is_active = COALESCE($8, is_active),
                position = COALESCE($9, position), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, cleanText(data.label, 120) ?? null, options ? JSON.stringify(options) : null, data.help !== undefined, cleanText(data.help, 500) ?? null,
          data.show_in_list ?? null, data.filterable ?? null, data.is_active ?? null, data.position ?? null],
      );
      if (!rows[0]) throw notFound('Field not found');
      // a choice in use cannot disappear from under the leads holding it
      if (options && rows[0].type.includes('SELECT')) {
        const kept = new Set(options.map((o) => o.value));
        const { rows: used } = await client.query(
          `SELECT DISTINCT v FROM crm_leads l,
                  LATERAL (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(l.custom_fields->$1) = 'array' THEN l.custom_fields->$1 ELSE jsonb_build_array(l.custom_fields->>$1) END) AS v) x
            WHERE l.custom_fields ? $1`, [rows[0].key],
        );
        const lost = used.map((u) => u.v).filter((v) => v && !kept.has(v));
        if (lost.length) throw conflict(`Leads still hold ${lost.map((v) => `"${v}"`).join(', ')}; keep those choices (rename their labels instead)`);
      }
      row = rows[0];
    }
    await recordAuditEvent(client, { action: id ? 'LEAD_FIELD_CHANGED' : 'LEAD_FIELD_CREATED', entityType: 'SETTINGS', entityId: row.id, actorId: actor.id, summary: row.label });
    return row;
  });
}

// ---------------------------------------------------------------- setting a calling status

/**
 * Records how a call went: the status, the call itself, the attempt, the next
 * step. One transaction, so a lead never shows a status without its call.
 *
 * An unanswered call does not undo what an earlier conversation established:
 * an interested lead that does not pick up stays interested (its lifecycle is
 * kept) while its calling status says what happened this time.
 */
export async function setCallStatus(leadId, {
  statusId, note = null, lostReason = null, callbackAt = null, callbackKind = 'CALLBACK', rating, logCall = true, durationSec = null,
}, { actor, source = 'USER', client: outer = null }) {
  const run = async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE', [leadId]);
    const lead = rows[0];
    if (!lead) throw notFound('Lead not found');
    if (lead.merged_into_id) throw conflict('This lead was merged into another; work that one');
    if (lead.status === 'CONVERTED') throw conflict('This lead became a deal; record calls on the deal');
    const { rows: st } = await client.query('SELECT * FROM crm_call_statuses WHERE id = $1', [statusId]);
    const status = st[0];
    if (!status || !status.is_active) throw badRequest('Choose one of the calling statuses');
    const reason = cleanText(lostReason, 500);
    if (status.needs_reason && !reason) throw badRequest(`Say why the lead is ${status.label.toLowerCase()}`, { code: 'REASON_REQUIRED' });
    if (rating !== undefined && rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw badRequest('A rating is one to five stars');
    const text = cleanText(note, 5000);

    // whoever calls an unowned lead takes it
    if (!lead.owner_user_id && actor?.id) {
      await reassignLead(client, leadId, { toUserId: actor.id, reason: 'Took it from the call queue', actor });
    }
    const dialled = logCall && status.outcome !== 'NONE';
    if (dialled) {
      await recordManualCall(client, {
        lead_id: leadId, phone: lead.phone, direction: 'OUTBOUND', notes: text, duration_sec: durationSec,
        outcome: status.outcome === 'NOT_CONNECTED' ? (status.key === 'busy' ? 'BUSY' : 'NO_ANSWER') : 'CONNECTED',
      }, actor);
    } else if (text) {
      await logLeadActivity(client, leadId, { type: 'NOTE', subject: 'Note', body: text, actorId: actor?.id ?? null });
    }
    const attempts = lead.call_attempts + (dialled ? 1 : 0);
    const keepLifecycle = status.outcome === 'NOT_CONNECTED' && ['QUALIFYING', 'QUALIFIED', 'NURTURE'].includes(lead.status);
    const lifecycle = keepLifecycle ? lead.status : status.lifecycle;
    const closed = CLOSED.includes(lifecycle);
    let retryAt = null;
    let exhausted = false;
    if (!closed && status.retry_after_minutes && !callbackAt) {
      if (status.max_attempts && attempts >= status.max_attempts) exhausted = true;
      else retryAt = new Date(Date.now() + status.retry_after_minutes * 60_000);
    }
    await client.query(
      `UPDATE crm_leads SET call_status_id = $2, call_status_at = now(), call_status_by = $3, call_status_source = $4,
              call_attempts = $5, last_called_at = CASE WHEN $6 THEN now() ELSE last_called_at END, retry_at = $7,
              rating = COALESCE($8, rating), status = $9,
              disqualify_reason = CASE WHEN $9 = 'DISQUALIFIED' THEN COALESCE($10, disqualify_reason) ELSE disqualify_reason END,
              updated_at = now(), updated_by = $3
        WHERE id = $1`,
      [leadId, status.id, actor?.id ?? null, source, attempts, dialled, retryAt, rating ?? null, lifecycle,
        lifecycle === 'DISQUALIFIED' ? (reason || status.label) : null],
    );
    await logLeadActivity(client, leadId, {
      type: 'CALL_STATUS', subject: `Status: ${status.label}`, body: reason,
      actorId: actor?.id ?? null, meta: { from_status_id: lead.call_status_id, to_status_id: status.id, lifecycle, attempts, source },
    });
    // a status that says who they are settles an unknown category
    if (status.implies_category && lead.category === 'UNCLASSIFIED') {
      const fresh = (await client.query('SELECT * FROM crm_leads WHERE id = $1', [leadId])).rows[0];
      await routeLead(client, fresh, { category: status.implies_category, actor, channel: 'CALL', reason: `From the calling status "${status.label}"` });
    }
    if (lifecycle !== lead.status) {
      await emitEvent(client, { type: 'lead.status_changed', entityType: 'LEAD', entityId: leadId, actorId: actor?.id ?? null, payload: { from: lead.status, to: lifecycle } });
      if (closed) await cancelLeadFollowUps(client, leadId, lifecycle === 'WON' ? 'Lead won' : `Lead closed: ${reason || status.label}`, actor);
    }
    await emitEvent(client, {
      type: 'lead.call_status_changed', entityType: 'LEAD', entityId: leadId, actorId: actor?.id ?? null,
      payload: { status: status.key, label: status.label, lifecycle, attempts },
    });
    let callback = null;
    if (callbackAt && !closed) {
      callback = await createFollowUp(client, {
        leadId, kind: callbackKind, dueAt: callbackAt, assigneeId: lead.owner_user_id || actor?.id, notes: text, actor,
        title: null,
      });
    }
    await refreshScore(client, leadId);
    return { exhausted, attempts, callback };
  };
  const result = outer ? await run(outer) : await withTransaction(run);
  return { ...result, lead: await getLead(leadId, { client: outer }) };
}

// ---------------------------------------------------------------- the call queue

/**
 * What a person should call next, in order: callbacks that are due (or due in
 * the next quarter hour), then new leads nobody has called yet (newest first:
 * the sooner a new enquiry hears back, the likelier it answers), then retries
 * whose time has come (oldest first). Settings can put retries before new
 * leads. Closed, nurtured, snoozed and archived leads are not in it.
 */
export async function callQueue(userId, { limit = 40 } = {}) {
  const settings = await salesSettings();
  const newFirst = settings.calling?.newLeadsFirst !== false;
  const open = OPEN_LEAD_STATUSES.map((s) => `'${s}'`).join(',');
  const { rows } = await query(
    `WITH q AS (
       SELECT l.id, fu.task_id, fu.due AS callback_due, fu.title AS callback_title,
              CASE WHEN fu.task_id IS NOT NULL THEN 1
                   WHEN l.status = 'NEW' AND l.call_attempts = 0 AND l.last_called_at IS NULL THEN ${newFirst ? 2 : 3}
                   WHEN l.retry_at IS NOT NULL AND l.retry_at <= now() THEN ${newFirst ? 3 : 2}
              END AS bucket
         FROM crm_leads l
         LEFT JOIN LATERAL (
           SELECT t.id AS task_id, t.due_date AS due, t.title FROM tasks t
            WHERE t.crm_lead_id = l.id AND t.followup_kind IN ('CALL', 'CALLBACK') AND t.completed_at IS NULL AND t.is_archived = FALSE
              AND t.crm_cancel_reason IS NULL AND t.due_date <= now() + interval '15 minutes' AND (t.snoozed_until IS NULL OR t.snoozed_until <= now())
              AND (t.assignee_id = $1 OR (t.assignee_id IS NULL AND l.owner_user_id = $1))
            ORDER BY t.due_date LIMIT 1) fu ON TRUE
        WHERE l.is_archived = FALSE AND l.merged_into_id IS NULL AND l.destination = 'TASKFLOW' AND l.status IN (${open})
          AND (l.owner_user_id = $1 OR fu.task_id IS NOT NULL))
     SELECT x.*, q.bucket, q.task_id, q.callback_due, q.callback_title,
            (SELECT a.body FROM crm_lead_activities a WHERE a.lead_id = x.id AND a.body IS NOT NULL AND a.type IN ('CALL', 'NOTE', 'CALL_STATUS', 'IMPORT_NOTE')
              ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) AS last_note
       FROM q JOIN (${LEAD_SELECT}) x ON x.id = q.id
      WHERE q.bucket IS NOT NULL
      ORDER BY q.bucket, CASE WHEN q.bucket = 1 THEN extract(epoch FROM q.callback_due) END ASC,
               CASE WHEN q.bucket = ${newFirst ? 2 : 3} THEN extract(epoch FROM x.captured_at) END DESC,
               CASE WHEN q.bucket = ${newFirst ? 3 : 2} THEN extract(epoch FROM x.retry_at) END ASC, x.id
      LIMIT ${Math.min(Math.max(Number(limit) || 40, 1), 200)}`,
    [userId],
  );
  const { rows: counts } = await query(
    `SELECT COUNT(*) FILTER (WHERE l.status = 'NEW' AND l.call_attempts = 0 AND l.last_called_at IS NULL)::int AS new,
            COUNT(*) FILTER (WHERE l.retry_at IS NOT NULL AND l.retry_at <= now())::int AS retries_due,
            COUNT(*) FILTER (WHERE l.retry_at > now())::int AS retries_later,
            (SELECT COUNT(*)::int FROM tasks t WHERE t.assignee_id = $1 AND t.followup_kind IN ('CALL','CALLBACK') AND t.completed_at IS NULL
                AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL AND t.due_date <= now() + interval '15 minutes') AS callbacks_due,
            (SELECT COUNT(*)::int FROM crm_calls c WHERE c.agent_user_id = $1 AND c.started_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS calls_today
       FROM crm_leads l
      WHERE l.owner_user_id = $1 AND l.is_archived = FALSE AND l.merged_into_id IS NULL AND l.destination = 'TASKFLOW' AND l.status IN (${open})`,
    [userId, settings.calendar?.timezone || 'Asia/Kolkata'],
  );
  const reason = { 1: 'CALLBACK', [newFirst ? 2 : 3]: 'NEW', [newFirst ? 3 : 2]: 'RETRY' };
  return {
    counts: counts[0],
    items: rows.map((r) => ({ ...decorateLead(r, settings), queue_reason: reason[r.bucket] })),
  };
}

// ---------------------------------------------------------------- bringing TeleCRM's leads in

/**
 * Once retailers, FPOs and individuals are worked in TaskFlow, the leads that
 * were waiting for TeleCRM or for review come in: each is routed again by its
 * own category (with a record of why), unowned ones go through assignment, and
 * organizations held out as TeleCRM's are made active. Nothing is lost: hand-off
 * records stay as history.
 */
export async function bringIntoTaskflow(actor) {
  await salesSettings();
  if (!teleSalesHere()) throw conflict('First set retailers, FPOs and individuals to be worked in TaskFlow (Settings → Visibility, routing & calendar)');
  return withTransaction(async (client) => {
    const settings = await salesSettings();
    const { rows: leads } = await client.query(
      `SELECT * FROM crm_leads WHERE destination IN ('TELECRM', 'TRIAGE') AND merged_into_id IS NULL AND is_archived = FALSE ORDER BY id FOR UPDATE`,
    );
    const out = { leads: 0, assigned: 0, organizations: 0 };
    for (const lead of leads) {
      const r = await routeLead(client, lead, { category: lead.category, actor, channel: 'SETTINGS', reason: 'Worked in TaskFlow now that TeleCRM is being retired', settings });
      if (!r.changed) continue;
      out.leads += 1;
      if (!lead.owner_user_id && isEligible(lead.category)) {
        const a = await autoAssignLead(client, lead.id, { actor });
        if (a?.userId) out.assigned += 1;
      }
    }
    const { rows: orgs } = await client.query(`SELECT id, lead_category FROM accounts WHERE routing_status = 'EXCLUDED' AND is_archived = FALSE ORDER BY id`);
    for (const a of orgs) {
      const r = await classifyAccount(client, a.id, { category: a.lead_category, actor, reason: 'Worked in TaskFlow now that TeleCRM is being retired', source: 'MANUAL' });
      if (r.changed) out.organizations += 1;
    }
    await recordAuditEvent(client, {
      action: 'TELECRM_LEADS_BROUGHT_IN', entityType: 'SETTINGS', actorId: actor.id,
      summary: `${out.leads} lead(s) and ${out.organizations} organization(s) brought into TaskFlow`, detail: out,
    });
    return out;
  });
}
