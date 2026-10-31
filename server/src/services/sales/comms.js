/**
 * Calls and WhatsApp, tied to the lead, organization, contact and deal they
 * are about, on the same timeline as everything else.
 *
 * What is real and what is not is kept visible:
 *   - A call typed in by a person is "logged manually". A call from a
 *     provider's webhook is the provider's record. A tel: link opens the
 *     phone's dialler and proves nothing; it is labelled that way.
 *   - A WhatsApp message accepted by Meta stays "queued" until Meta reports it
 *     sent, delivered, read or failed. Nothing here invents those statuses.
 *   - Every provider event is stored once by its id, so retries and
 *     out-of-order deliveries cannot duplicate an entry or move a status back.
 *
 * Secrets come from the server environment (config.sales) and never reach a
 * response or a log line.
 */
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { logActivity } from '../crm.js';
import { createFollowUp } from './followups.js';
import { createLead, logLeadActivity } from './leads.js';
import { emitEvent, normalizePhone, salesSettings } from './core.js';

// ---------------------------------------------------------------- shared

/** Stores a provider event once; false when it was already received. */
export async function firstTimeEvent(client, provider, eventKey, kind, summary = {}) {
  const { rows } = await client.query(
    `INSERT INTO crm_integration_events (provider, event_key, kind, summary) VALUES ($1,$2,$3,$4)
     ON CONFLICT (provider, event_key) DO NOTHING RETURNING id`,
    [provider, String(eventKey).slice(0, 300), kind, summary],
  );
  return rows[0]?.id ?? null;
}

export async function markEvent(client, id, status, error = null) {
  if (!id) return;
  await client.query('UPDATE crm_integration_events SET status = $2, error = $3, processed_at = now() WHERE id = $1', [id, status, error ? String(error).slice(0, 500) : null]);
}

/** Who a phone number belongs to: a contact (and their organization's open deal), else an open lead. */
export async function matchPhone(runner, phone) {
  const p = normalizePhone(phone);
  if (!p) return {};
  const { rows: contacts } = await runner.query(
    `SELECT c.id AS contact_id, c.account_id,
            (SELECT o.id FROM opportunities o WHERE o.account_id = c.account_id AND o.status = 'ACTIVE' AND o.is_archived = FALSE
               ORDER BY (o.id = a.primary_opportunity_id) DESC, o.updated_at DESC LIMIT 1) AS opportunity_id
       FROM account_contacts c JOIN accounts a ON a.id = c.account_id
      WHERE c.phone_normalized = $1 AND c.is_active = TRUE AND a.is_archived = FALSE
      ORDER BY c.is_primary DESC, c.id LIMIT 1`, [p],
  );
  const { rows: leads } = await runner.query(
    `SELECT id FROM crm_leads WHERE phone_normalized = $1 AND is_archived = FALSE AND merged_into_id IS NULL
      ORDER BY (status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED')) DESC, captured_at DESC LIMIT 1`, [p],
  );
  return {
    phone: p,
    contactId: contacts[0]?.contact_id ?? null,
    accountId: contacts[0]?.account_id ?? null,
    opportunityId: contacts[0]?.opportunity_id ?? null,
    leadId: leads[0]?.id ?? null,
  };
}

// ---------------------------------------------------------------- opt-outs

export async function isOptedOut(channel, address, runner = { query }) {
  const p = normalizePhone(address) || String(address || '').toLowerCase();
  const { rows } = await runner.query('SELECT 1 FROM crm_optouts WHERE channel = $1 AND address = $2 AND lifted_at IS NULL', [channel, p]);
  return rows.length > 0;
}

export async function optOut(client, { channel, address, reason = null, source = 'MANUAL', actorId = null }) {
  const p = normalizePhone(address) || String(address || '').toLowerCase();
  if (!p) throw badRequest('Give the number or address');
  await client.query(
    `INSERT INTO crm_optouts (channel, address, reason, source, actor_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel, address) WHERE lifted_at IS NULL DO NOTHING`,
    [channel, p, reason, source, actorId],
  );
  // scheduled automation that would message them is cancelled, with the reason
  await client.query(
    `UPDATE crm_automation_runs r SET status = 'CANCELLED', cancelled_reason = 'Opted out of ' || $1, finished_at = now()
      WHERE r.status = 'SCHEDULED' AND EXISTS (
        SELECT 1 FROM crm_leads l WHERE r.entity_type = 'LEAD' AND l.id = r.entity_id AND l.phone_normalized = $2)`,
    [channel, p],
  );
}

export async function liftOptOut(client, { channel, address, actorId }) {
  const p = normalizePhone(address) || String(address || '').toLowerCase();
  const { rowCount } = await client.query(
    'UPDATE crm_optouts SET lifted_at = now(), lifted_by = $3 WHERE channel = $1 AND address = $2 AND lifted_at IS NULL', [channel, p, actorId],
  );
  if (!rowCount) throw notFound('No opt-out recorded for that number');
}

// ---------------------------------------------------------------- calls

const CALL_RANK = { QUEUED: 0, RINGING: 1, IN_PROGRESS: 2, COMPLETED: 3, NO_ANSWER: 3, BUSY: 3, FAILED: 3, CANCELLED: 3 };
const TERMINAL = new Set(['COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED']);
export const CALL_OUTCOMES = ['CONNECTED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'LEFT_MESSAGE', 'CALLBACK_REQUESTED', 'NOT_INTERESTED', 'INTERESTED'];

/** Puts a finished call on the timeline of what it is about, once. */
async function callOnTimeline(client, call, actorId) {
  const reached = call.status === 'COMPLETED' && (call.duration_sec ?? 1) > 0 && !['NO_ANSWER', 'BUSY', 'WRONG_NUMBER'].includes(call.outcome);
  const minutes = call.duration_sec ? ` (${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s)` : '';
  const subject = `${call.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} call${minutes}: ${(call.outcome || call.status).toLowerCase().replace(/_/g, ' ')}`;
  const ref = `call:${call.id}`;
  if (call.lead_id) {
    await logLeadActivity(client, call.lead_id, {
      type: 'CALL', direction: call.direction, outcome: reached ? 'COMPLETED' : 'ATTEMPTED', subject, body: call.notes,
      actorId, callId: call.id, externalRef: ref, occurredAt: call.started_at,
      meta: { provider: call.provider, logged_manually: call.logged_manually },
    });
  }
  if (call.account_id) {
    const { rows } = await client.query('SELECT 1 FROM account_activities WHERE call_id = $1 LIMIT 1', [call.id]);
    if (!rows[0]) {
      await logActivity(client, {
        accountId: call.account_id, opportunityId: call.opportunity_id, contactId: call.contact_id, type: 'CALL', actorId,
        subject, body: call.notes, direction: call.direction, outcome: reached ? 'COMPLETED' : 'ATTEMPTED',
        occurredAt: call.started_at, callId: call.id, source: call.logged_manually ? 'MANUAL' : 'CALL_PROVIDER',
        meta: { provider: call.provider },
      });
    }
  }
}

/**
 * A call a person logs by hand (from a mobile, a desk phone, or after a tel:
 * link). Can schedule the next follow-up in the same step.
 */
export async function logCall(input, actor) {
  return withTransaction((client) => recordManualCall(client, input, actor));
}

/** A call a person logs by hand, inside the caller's transaction. */
export async function recordManualCall(client, input, actor) {
  {
    const phone = input.phone || null;
    const match = phone ? await matchPhone(client, phone) : {};
    const leadId = input.lead_id ?? (input.account_id || input.opportunity_id ? null : match.leadId) ?? null;
    let accountId = input.account_id ?? null;
    let opportunityId = input.opportunity_id ?? null;
    if (opportunityId && !accountId) accountId = (await client.query('SELECT account_id FROM opportunities WHERE id = $1', [opportunityId])).rows[0]?.account_id ?? null;
    if (!leadId && !accountId) {
      accountId = match.accountId ?? null;
      opportunityId = opportunityId ?? match.opportunityId ?? null;
    }
    if (!leadId && !accountId) throw badRequest('Say which lead, organization or deal the call was about');
    const started = input.started_at ? new Date(input.started_at) : new Date();
    if (started.getTime() > Date.now() + 5 * 60_000) throw badRequest('A call cannot be in the future; schedule a follow-up instead');
    const status = input.outcome === 'NO_ANSWER' ? 'NO_ANSWER' : input.outcome === 'BUSY' ? 'BUSY' : 'COMPLETED';
    const { rows } = await client.query(
      `INSERT INTO crm_calls (provider, direction, status, from_number, to_number, counterpart_normalized, agent_user_id, lead_id, account_id,
                              contact_id, opportunity_id, started_at, ended_at, duration_sec, outcome, notes, logged_manually, created_by)
       VALUES ('manual',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,$6) RETURNING *`,
      [input.direction || 'OUTBOUND', status, input.direction === 'INBOUND' ? phone : null, input.direction === 'INBOUND' ? null : phone,
        normalizePhone(phone), actor.id, leadId, accountId, input.contact_id ?? match.contactId ?? null, opportunityId,
        started, input.duration_sec ? new Date(started.getTime() + input.duration_sec * 1000) : null, input.duration_sec ?? null,
        input.outcome || null, input.notes || null],
    );
    const call = rows[0];
    await callOnTimeline(client, call, actor.id);
    let next = null;
    if (input.next?.due_at) {
      next = await createFollowUp(client, {
        leadId, accountId, opportunityId, kind: input.next.kind || 'CALL', title: input.next.title || null, dueAt: input.next.due_at,
        assigneeId: input.next.assignee_id || actor.id, priority: input.next.priority || 'MEDIUM', notes: input.next.notes || null, actor,
      });
      await client.query('UPDATE crm_calls SET follow_up_task_id = $2 WHERE id = $1', [call.id, next.id]);
    }
    await emitEvent(client, { type: 'call.logged', entityType: leadId ? 'LEAD' : 'OPPORTUNITY', entityId: leadId || opportunityId || accountId, actorId: actor.id, payload: { call_id: call.id, outcome: call.outcome } });
    return { call, next };
  }
}

/**
 * Applies a provider's call event: creates the call the first time, moves its
 * status forward only, fills what was missing, and puts it on the timeline
 * once it has ended. The same event twice changes nothing.
 */
export async function applyCallEvent(provider, ev) {
  // recordings are kept only when Settings allows it
  const keepRecordings = (await salesSettings()).calls?.recordings !== false;
  return withTransaction(async (client) => {
    const eventId = await firstTimeEvent(client, provider, ev.eventKey || `${ev.providerCallId}:${ev.status}`, 'call', { call: ev.providerCallId, status: ev.status });
    if (!eventId) return { duplicate: true };
    const status = CALL_RANK[ev.status] === undefined ? 'COMPLETED' : ev.status;
    const counterpart = ev.direction === 'INBOUND' ? ev.from : ev.to;
    const { rows: existing } = await client.query('SELECT * FROM crm_calls WHERE provider = $1 AND provider_call_id = $2 FOR UPDATE', [provider, ev.providerCallId]);
    let call = existing[0] || null;
    if (!call && ev.localCallId) {
      // a click-to-call this server started: the provider's id arrives on the first event
      const { rows } = await client.query('SELECT * FROM crm_calls WHERE id = $1 AND provider = $2 FOR UPDATE', [ev.localCallId, provider]);
      call = rows[0] || null;
      if (call && !call.provider_call_id) await client.query('UPDATE crm_calls SET provider_call_id = $2 WHERE id = $1', [call.id, ev.providerCallId]);
    }
    let agentId = call?.agent_user_id ?? null;
    if (!agentId && ev.agentEmail) agentId = (await client.query('SELECT id FROM users WHERE lower(email) = lower($1) AND is_active = TRUE', [ev.agentEmail])).rows[0]?.id ?? null;
    if (!agentId && ev.agentPhone) agentId = (await client.query('SELECT id FROM users WHERE regexp_replace(phone, \'\\D\', \'\', \'g\') LIKE \'%\' || $1 AND is_active = TRUE LIMIT 1', [String(normalizePhone(ev.agentPhone) || '').slice(-10)])).rows[0]?.id ?? null;
    if (!call) {
      const match = await matchPhone(client, counterpart);
      const { rows } = await client.query(
        `INSERT INTO crm_calls (provider, provider_call_id, direction, status, from_number, to_number, counterpart_normalized, agent_user_id,
                                lead_id, account_id, contact_id, opportunity_id, started_at, answered_at, ended_at, duration_sec, recording_ref, last_event_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [provider, ev.providerCallId, ev.direction || 'INBOUND', status, ev.from || null, ev.to || null, normalizePhone(counterpart), agentId,
          match.accountId ? null : match.leadId, match.accountId ?? null, match.contactId ?? null, match.opportunityId ?? null,
          ev.startedAt || null, ev.answeredAt || null, ev.endedAt || null, ev.durationSec ?? null,
          keepRecordings ? ev.recordingUrl || null : null, ev.at || new Date()],
      );
      call = rows[0];
      // an inbound call from a number nobody knows is kept as a lead waiting for a category, not dropped
      if (!call.lead_id && !call.account_id && call.direction === 'INBOUND' && call.counterpart_normalized) {
        const { lead } = await createLead({ contact_name: `Caller ${ev.from}`, phone: ev.from, category: 'UNCLASSIFIED', enquiry: 'Inbound call from an unknown number' },
          { client, channel: 'CALL', sourceSystem: provider, origin: 'INTEGRATION', assign: false });
        await client.query('UPDATE crm_calls SET lead_id = $2 WHERE id = $1', [call.id, lead.id]);
        call.lead_id = lead.id;
      }
    } else {
      // forward only: a late "ringing" after "completed" changes nothing
      const forward = (CALL_RANK[status] ?? 0) > (CALL_RANK[call.status] ?? 0);
      const { rows } = await client.query(
        `UPDATE crm_calls SET status = CASE WHEN $2 THEN $3 ELSE status END,
                started_at = COALESCE(started_at, $4), answered_at = COALESCE(answered_at, $5), ended_at = COALESCE(ended_at, $6),
                duration_sec = COALESCE($7, duration_sec), recording_ref = COALESCE(recording_ref, $8),
                agent_user_id = COALESCE(agent_user_id, $9), last_event_at = GREATEST(COALESCE(last_event_at, $10), $10), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [call.id, forward, status, ev.startedAt || null, ev.answeredAt || null, ev.endedAt || null, ev.durationSec ?? null,
          keepRecordings ? ev.recordingUrl || null : null, agentId, ev.at || new Date()],
      );
      call = rows[0];
    }
    if (TERMINAL.has(call.status)) await callOnTimeline(client, call, call.agent_user_id);
    await markEvent(client, eventId, 'PROCESSED');
    return { call, duplicate: false };
  });
}

/** Maps the generic, signed call webhook's body. */
export function readGenericCallEvent(body) {
  const s = String(body.status || '').toUpperCase().replace(/[- ]/g, '_');
  const status = { ANSWERED: 'COMPLETED', ENDED: 'COMPLETED', MISSED: 'NO_ANSWER', NOANSWER: 'NO_ANSWER', NO_ANSWER: 'NO_ANSWER' }[s] || s;
  if (!body.call_id) throw badRequest('call_id is required');
  return {
    eventKey: body.event_id ? String(body.event_id) : null,
    providerCallId: String(body.call_id),
    direction: String(body.direction || 'INBOUND').toUpperCase() === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND',
    status, from: body.from || null, to: body.to || null,
    agentEmail: body.agent_email || null, agentPhone: body.agent_phone || null,
    startedAt: body.started_at || null, answeredAt: body.answered_at || null, endedAt: body.ended_at || null,
    durationSec: body.duration_sec === undefined || body.duration_sec === null ? null : Number(body.duration_sec),
    recordingUrl: body.recording_url || null, at: body.occurred_at || null,
  };
}

/** HMAC-SHA256 over the raw body, compared in constant time. */
export function validSignature(secret, rawBody, header) {
  if (!secret || !rawBody || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const given = String(header).trim();
  const a = Buffer.from(expected);
  const b = Buffer.from(given.startsWith('sha256=') ? given : `sha256=${given}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- Exotel click-to-call

export function exotelStatus() {
  const e = config.sales.exotel;
  const missing = [['EXOTEL_ACCOUNT_SID', e.accountSid], ['EXOTEL_API_KEY', e.apiKey], ['EXOTEL_API_TOKEN', e.apiToken], ['EXOTEL_CALLER_ID', e.callerId], ['EXOTEL_CALLBACK_SECRET', e.callbackSecret]]
    .filter(([, v]) => !v).map(([k]) => k);
  return { provider: 'exotel', configured: missing.length === 0, missing, subdomain: e.subdomain, verified: false };
}

/**
 * Asks Exotel to ring the agent, then connect them to the customer
 * (Calls/connect). The call row exists before the request so the callback can
 * find it; if Exotel refuses, the row says so.
 */
export async function clickToCall({ actor, phone, leadId = null, accountId = null, contactId = null, opportunityId = null }, { fetchImpl = fetch } = {}) {
  const st = exotelStatus();
  if (!st.configured) throw conflict(`Calling is not connected: ${st.missing.join(', ')} not set on the server`);
  const { rows: me } = await query('SELECT phone FROM users WHERE id = $1', [actor.id]);
  const agentPhone = normalizePhone(me[0]?.phone);
  if (!agentPhone) throw badRequest('Add your phone number to your profile so the call can ring you first');
  const to = normalizePhone(phone);
  if (!to) throw badRequest('That is not a phone number');
  if (await isOptedOut('CALL', to)) throw conflict('This number asked not to be called');
  const { rows } = await query(
    `INSERT INTO crm_calls (provider, direction, status, from_number, to_number, counterpart_normalized, agent_user_id, lead_id, account_id, contact_id, opportunity_id, started_at, created_by)
     VALUES ('exotel','OUTBOUND','QUEUED',$1,$2,$2,$3,$4,$5,$6,$7,now(),$3) RETURNING *`,
    [agentPhone, to, actor.id, leadId, accountId, contactId, opportunityId],
  );
  const call = rows[0];
  const e = config.sales.exotel;
  const params = new URLSearchParams({
    From: `+${agentPhone}`, To: `+${to}`, CallerId: e.callerId, Record: 'true', CustomField: String(call.id),
    StatusCallback: `${config.publicUrl}${config.apiPrefix}/s/calls/exotel/${encodeURIComponent(e.callbackSecret)}`,
  });
  params.append('StatusCallbackEvents[0]', 'terminal');
  try {
    const res = await fetchImpl(`https://${e.subdomain}/v1/Accounts/${encodeURIComponent(e.accountSid)}/Calls/connect.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${e.apiKey}:${e.apiToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.RestException?.Message || `Exotel answered ${res.status}`;
      await query(`UPDATE crm_calls SET status = 'FAILED', notes = $2, updated_at = now() WHERE id = $1`, [call.id, `Not started: ${msg}`]);
      throw conflict(`The call could not be started: ${msg}`);
    }
    const sid = data?.Call?.Sid || null;
    await query('UPDATE crm_calls SET provider_call_id = COALESCE(provider_call_id, $2), updated_at = now() WHERE id = $1', [call.id, sid]);
    return { call_id: call.id, provider_call_id: sid, status: 'QUEUED' };
  } catch (err) {
    if (err.status) throw err;
    await query(`UPDATE crm_calls SET status = 'FAILED', notes = $2, updated_at = now() WHERE id = $1`, [call.id, 'Not started: Exotel could not be reached']);
    throw conflict('Exotel could not be reached; try again, or log the call by hand');
  }
}

/** Exotel's status callback (form fields). Field names follow Exotel's connect API and are confirmed in live testing. */
export function readExotelEvent(body) {
  const raw = String(body.Status || body.CallStatus || '').toLowerCase();
  const status = { completed: 'COMPLETED', 'no-answer': 'NO_ANSWER', busy: 'BUSY', failed: 'FAILED', canceled: 'CANCELLED', 'in-progress': 'IN_PROGRESS', ringing: 'RINGING', queued: 'QUEUED' }[raw] || 'COMPLETED';
  const duration = body.ConversationDuration ?? body.DialCallDuration ?? body.Duration;
  return {
    eventKey: `${body.CallSid}:${raw || 'event'}`,
    providerCallId: String(body.CallSid || ''),
    localCallId: body.CustomField && /^\d+$/.test(String(body.CustomField)) ? Number(body.CustomField) : null,
    direction: String(body.Direction || '').toLowerCase().startsWith('inbound') ? 'INBOUND' : 'OUTBOUND',
    status, from: body.From || null, to: body.To || null,
    startedAt: body.StartTime || null, endedAt: body.EndTime || null,
    durationSec: duration === undefined || duration === null || duration === '' ? null : Number(duration),
    recordingUrl: body.RecordingUrl || null,
  };
}

// ---------------------------------------------------------------- WhatsApp (Meta Cloud API)

export function whatsappStatus() {
  const w = config.sales.whatsapp;
  const missing = [['WHATSAPP_ACCESS_TOKEN', w.accessToken], ['WHATSAPP_PHONE_NUMBER_ID', w.phoneNumberId], ['WHATSAPP_APP_SECRET', w.appSecret], ['WHATSAPP_VERIFY_TOKEN', w.verifyToken]]
    .filter(([, v]) => !v).map(([k]) => k);
  return {
    provider: 'whatsapp-cloud', configured: missing.length === 0, missing, sandbox: w.sandbox, graph_version: w.graphVersion,
    templates_sync: Boolean(w.businessAccountId), webhook_path: `${config.apiPrefix}/s/whatsapp`,
  };
}

const graph = (path) => `https://graph.facebook.com/${config.sales.whatsapp.graphVersion}/${path}`;
const WA_RANK = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/** The last inbound message from this number, for the 24-hour customer service window. */
async function lastInbound(phoneN) {
  const { rows } = await query(`SELECT MAX(created_at) AS at FROM crm_wa_messages WHERE phone_normalized = $1 AND direction = 'INBOUND'`, [phoneN]);
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

export function fillTemplate(components, variables = []) {
  const body = (components || []).find((c) => String(c.type).toUpperCase() === 'BODY');
  const text = body?.text || '';
  return text.replace(/\{\{(\d+)\}\}/g, (m, n) => (variables[Number(n) - 1] !== undefined && variables[Number(n) - 1] !== '' ? String(variables[Number(n) - 1]) : m));
}

/**
 * Sends a WhatsApp message through the Cloud API. Free text only inside the
 * 24 hours after the person last wrote to us; outside it, an approved
 * template. Opted-out numbers are refused. The same idempotency key never
 * sends twice: the first message is returned instead.
 */
export async function sendWhatsApp(input, { actor = null, automationRunId = null, fetchImpl = fetch } = {}) {
  const st = whatsappStatus();
  if (!st.configured) throw conflict(`WhatsApp is not connected: ${st.missing.join(', ')} not set on the server`);
  const to = normalizePhone(input.to);
  if (!to) throw badRequest('That is not a phone number');
  const kind = input.template_name ? 'TEMPLATE' : 'TEXT';
  let template = null;
  if (kind === 'TEMPLATE') {
    const { rows } = await query('SELECT * FROM crm_wa_templates WHERE name = $1 AND language = $2', [input.template_name, input.language || 'en']);
    template = rows[0];
    if (!template) throw badRequest('That template is not in the synced list; sync templates in Settings first');
    if (template.status && template.status !== 'APPROVED') throw badRequest(`That template is ${template.status.toLowerCase()} at Meta, not approved`);
    const vars = input.variables || [];
    if (vars.length < template.variable_count || vars.slice(0, template.variable_count).some((v) => v === undefined || String(v).trim() === '')) {
      throw badRequest(`The template needs ${template.variable_count} value(s)`);
    }
  } else {
    if (!String(input.body || '').trim()) throw badRequest('Write the message');
    const last = await lastInbound(to);
    if (!last || Date.now() - last.getTime() > 24 * 3600_000) {
      throw badRequest('More than 24 hours since they last wrote: send an approved template instead', { code: 'WINDOW_CLOSED' });
    }
  }
  const match = await matchPhone({ query }, to);
  const links = {
    leadId: input.lead_id ?? (input.account_id ? null : match.leadId) ?? null,
    accountId: input.account_id ?? match.accountId ?? null,
    contactId: input.contact_id ?? match.contactId ?? null,
    opportunityId: input.opportunity_id ?? match.opportunityId ?? null,
  };
  const body = kind === 'TEMPLATE' ? fillTemplate(template.components, input.variables) : String(input.body);
  const optedOut = await isOptedOut('WHATSAPP', to);
  const { rows: inserted } = await query(
    `INSERT INTO crm_wa_messages (direction, phone, phone_normalized, lead_id, account_id, contact_id, opportunity_id, agent_user_id, kind,
                                  template_name, template_language, variables, body, status, error_title, automation_run_id, idempotency_key, created_by)
     VALUES ('OUTBOUND',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$7)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,
    [input.to, to, links.leadId, links.accountId, links.contactId, links.opportunityId, actor?.id ?? null, kind,
      template?.name ?? null, template?.language ?? null, JSON.stringify(input.variables || []), body,
      optedOut ? 'BLOCKED' : 'QUEUED', optedOut ? 'This number opted out of WhatsApp' : null, automationRunId, input.idempotency_key || null],
  );
  if (!inserted[0]) {
    const { rows } = await query('SELECT * FROM crm_wa_messages WHERE idempotency_key = $1', [input.idempotency_key]);
    return { message: rows[0], duplicate: true };
  }
  const message = inserted[0];
  if (optedOut) return { message, blocked: true };
  return { message: await deliverWhatsApp(message, template, { fetchImpl }), duplicate: false };
}

/** The API call for one queued message. Never called twice for a message Meta accepted. */
async function deliverWhatsApp(message, template, { fetchImpl = fetch } = {}) {
  const w = config.sales.whatsapp;
  const payload = message.kind === 'TEMPLATE'
    ? {
      messaging_product: 'whatsapp', to: message.phone_normalized, type: 'template',
      template: {
        name: template.name, language: { code: template.language },
        ...(template.variable_count ? { components: [{ type: 'body', parameters: (message.variables || []).slice(0, template.variable_count).map((v) => ({ type: 'text', text: String(v) })) }] } : {}),
      },
    }
    : { messaging_product: 'whatsapp', to: message.phone_normalized, type: 'text', text: { body: message.body, preview_url: false } };
  let res;
  let data = {};
  try {
    res = await fetchImpl(graph(`${w.phoneNumberId}/messages`), {
      method: 'POST', headers: { authorization: `Bearer ${w.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => ({}));
  } catch {
    const { rows } = await query(
      `UPDATE crm_wa_messages SET status = 'FAILED', error_title = 'WhatsApp could not be reached', failed_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = $1 RETURNING *`, [message.id],
    );
    return rows[0];
  }
  if (!res.ok || !data?.messages?.[0]?.id) {
    const err = data?.error || {};
    const { rows } = await query(
      `UPDATE crm_wa_messages SET status = 'FAILED', error_code = $2, error_title = $3, failed_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [message.id, err.code ? String(err.code) : String(res.status), String(err.error_user_msg || err.message || `WhatsApp answered ${res.status}`).slice(0, 300)],
    );
    return rows[0];
  }
  // accepted by Meta; "sent", "delivered" and "read" arrive by webhook
  const { rows } = await query(
    `UPDATE crm_wa_messages SET provider_message_id = $2, attempts = attempts + 1, error_code = NULL, error_title = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`, [message.id, data.messages[0].id],
  );
  const m = rows[0];
  await withTransaction(async (client) => {
    const subject = `WhatsApp ${m.kind === 'TEMPLATE' ? `template "${m.template_name}"` : 'message'} sent to ${m.phone}`;
    if (m.lead_id) await logLeadActivity(client, m.lead_id, { type: 'WHATSAPP', direction: 'OUTBOUND', outcome: 'SENT', subject, body: m.body, actorId: m.agent_user_id, messageId: m.id, externalRef: `wa:${m.id}` });
    if (m.account_id) {
      await logActivity(client, {
        accountId: m.account_id, opportunityId: m.opportunity_id, contactId: m.contact_id, type: 'WHATSAPP', actorId: m.agent_user_id,
        subject, body: m.body, direction: 'OUTBOUND', outcome: 'SENT', messageId: m.id, source: 'WHATSAPP',
      });
    }
  });
  return m;
}

/** Sends again a message Meta never accepted. One that was accepted is never resent. */
export async function retryWhatsApp(messageId, { fetchImpl = fetch } = {}) {
  const { rows } = await query('SELECT * FROM crm_wa_messages WHERE id = $1', [messageId]);
  const m = rows[0];
  if (!m) throw notFound('Message not found');
  if (m.direction !== 'OUTBOUND' || m.status !== 'FAILED') throw badRequest('Only a failed outgoing message can be retried');
  if (m.provider_message_id) throw badRequest('WhatsApp accepted this message; it is not sent again');
  if (m.attempts >= 5) throw badRequest('Tried five times; check the number and the template, then send a new message');
  if (await isOptedOut('WHATSAPP', m.phone_normalized)) throw conflict('This number opted out of WhatsApp');
  const template = m.template_name ? (await query('SELECT * FROM crm_wa_templates WHERE name = $1 AND language = $2', [m.template_name, m.template_language])).rows[0] : null;
  await query(`UPDATE crm_wa_messages SET status = 'QUEUED', updated_at = now() WHERE id = $1`, [messageId]);
  return deliverWhatsApp({ ...m, status: 'QUEUED' }, template, { fetchImpl });
}

const STOP_WORDS = /^\s*(stop|unsubscribe|stop all|opt ?out|cancel)\s*$/i;

/** Meta's webhook payload: inbound messages and status updates. */
export async function applyWhatsAppWebhook(body) {
  const results = { messages: 0, statuses: 0, duplicates: 0, optouts: 0 };
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const msg of value.messages || []) {
        const r = await applyInbound(msg, value.contacts || []);
        if (r.duplicate) results.duplicates += 1; else results.messages += 1;
        if (r.optout) results.optouts += 1;
      }
      for (const st of value.statuses || []) {
        const r = await applyStatus(st);
        if (r.duplicate) results.duplicates += 1; else results.statuses += 1;
      }
    }
  }
  return results;
}

async function applyInbound(msg, contacts) {
  return withTransaction(async (client) => {
    const eventId = await firstTimeEvent(client, 'whatsapp', `msg:${msg.id}`, 'message', { type: msg.type });
    if (!eventId) return { duplicate: true };
    const phone = msg.from;
    const p = normalizePhone(phone);
    const text = msg.text?.body ?? msg.button?.text ?? msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title
      ?? msg[msg.type]?.caption ?? null;
    const media = ['image', 'document', 'audio', 'video', 'sticker'].includes(msg.type) ? { type: msg.type, id: msg[msg.type]?.id, mime: msg[msg.type]?.mime_type, filename: msg[msg.type]?.filename } : {};
    let match = await matchPhone(client, phone);
    if (!match.leadId && !match.accountId) {
      const name = contacts.find((c) => c.wa_id === msg.from)?.profile?.name || `WhatsApp ${phone}`;
      const { lead } = await createLead({ contact_name: name, phone, category: 'UNCLASSIFIED', enquiry: text || `(${msg.type})` },
        { client, channel: 'WHATSAPP', sourceSystem: 'whatsapp', origin: 'INTEGRATION', assign: false });
      match = { ...match, leadId: lead.id };
    }
    const at = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
    const { rows } = await client.query(
      `INSERT INTO crm_wa_messages (provider_message_id, direction, phone, phone_normalized, lead_id, account_id, contact_id, opportunity_id, kind, body, media, status, status_at, created_at)
       VALUES ($1,'INBOUND',$2,$3,$4,$5,$6,$7,$8,$9,$10,'RECEIVED',$11,$11)
       ON CONFLICT (provider, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING RETURNING *`,
      [msg.id, phone, p, match.accountId ? null : match.leadId, match.accountId ?? null, match.contactId ?? null, match.opportunityId ?? null,
        String(msg.type || 'text').toUpperCase(), text, media, at],
    );
    const m = rows[0];
    if (!m) { await markEvent(client, eventId, 'IGNORED'); return { duplicate: true }; }
    const subject = `WhatsApp from ${phone}${media.type ? ` (${media.type})` : ''}`;
    if (m.lead_id) await logLeadActivity(client, m.lead_id, { type: 'WHATSAPP', direction: 'INBOUND', outcome: 'RECEIVED', subject, body: text, messageId: m.id, externalRef: `wa:${m.id}`, occurredAt: at });
    if (m.account_id) {
      await logActivity(client, {
        accountId: m.account_id, opportunityId: m.opportunity_id, contactId: m.contact_id, type: 'WHATSAPP', actorId: null,
        subject, body: text, direction: 'INBOUND', outcome: 'RECEIVED', occurredAt: at, messageId: m.id, source: 'WHATSAPP',
      });
    }
    let optout = false;
    if (text && STOP_WORDS.test(text)) {
      await optOut(client, { channel: 'WHATSAPP', address: p, reason: `Replied "${text.trim()}"`, source: 'WHATSAPP' });
      optout = true;
    }
    // a reply cancels scheduled automation that was waiting for one
    await client.query(
      `UPDATE crm_automation_runs r SET status = 'CANCELLED', cancelled_reason = 'They replied on WhatsApp', finished_at = now()
         FROM crm_automation_rules ru
        WHERE ru.id = r.rule_id AND r.status = 'SCHEDULED' AND 'reply' = ANY(ru.cancel_on)
          AND ((r.entity_type = 'LEAD' AND r.entity_id = $1) OR (r.entity_type = 'OPPORTUNITY' AND r.entity_id = $2))`,
      [m.lead_id ?? 0, m.opportunity_id ?? 0],
    );
    await emitEvent(client, { type: 'message.received', entityType: m.lead_id ? 'LEAD' : 'OPPORTUNITY', entityId: m.lead_id || m.opportunity_id || m.account_id, origin: 'INTEGRATION', payload: { message_id: m.id, channel: 'WHATSAPP' } });
    await markEvent(client, eventId, 'PROCESSED');
    return { duplicate: false, optout };
  });
}

async function applyStatus(st) {
  return withTransaction(async (client) => {
    const status = String(st.status || '').toUpperCase();
    const eventId = await firstTimeEvent(client, 'whatsapp', `status:${st.id}:${status}`, 'status', { status });
    if (!eventId) return { duplicate: true };
    const { rows } = await client.query(`SELECT * FROM crm_wa_messages WHERE provider = 'meta' AND provider_message_id = $1 FOR UPDATE`, [st.id]);
    const m = rows[0];
    if (!m) { await markEvent(client, eventId, 'IGNORED', 'No message with that id'); return { duplicate: false }; }
    const at = st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date();
    const col = { SENT: 'sent_at', DELIVERED: 'delivered_at', READ: 'read_at', FAILED: 'failed_at' }[status];
    if (!col) { await markEvent(client, eventId, 'IGNORED'); return { duplicate: false }; }
    // the timestamp is kept whatever order it arrives in; the status only moves forward,
    // and "failed" only stands if it was never delivered or read
    const next = status === 'FAILED'
      ? (['DELIVERED', 'READ'].includes(m.status) ? m.status : 'FAILED')
      : ((WA_RANK[status] ?? 0) > (WA_RANK[m.status] ?? -1) || m.status === 'FAILED' ? status : m.status);
    const err = st.errors?.[0];
    await client.query(
      `UPDATE crm_wa_messages SET ${col} = COALESCE(${col}, $2), status = $3, status_at = GREATEST(COALESCE(status_at, $2), $2),
              error_code = COALESCE($4, error_code), error_title = COALESCE($5, error_title), updated_at = now() WHERE id = $1`,
      [m.id, at, next, err?.code ? String(err.code) : null, err ? String(err.title || err.message || 'Failed').slice(0, 300) : null],
    );
    await markEvent(client, eventId, 'PROCESSED');
    return { duplicate: false };
  });
}

/** Pulls the approved templates from the WhatsApp Business Account. */
export async function syncTemplates({ fetchImpl = fetch } = {}) {
  const w = config.sales.whatsapp;
  if (!w.accessToken || !w.businessAccountId) throw conflict('Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID on the server to sync templates');
  let url = graph(`${w.businessAccountId}/message_templates?fields=name,language,status,category,components&limit=200`);
  let n = 0;
  for (let page = 0; url && page < 10; page += 1) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${w.accessToken}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw conflict(`WhatsApp answered ${res.status}: ${data?.error?.message || 'could not list templates'}`);
    for (const t of data.data || []) {
      const body = (t.components || []).find((c) => String(c.type).toUpperCase() === 'BODY')?.text || '';
      const vars = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
      await query(
        `INSERT INTO crm_wa_templates (name, language, category, status, components, variable_count, synced_at) VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (name, language) DO UPDATE SET category = EXCLUDED.category, status = EXCLUDED.status, components = EXCLUDED.components,
           variable_count = EXCLUDED.variable_count, synced_at = now()`,
        [t.name, t.language, t.category || null, t.status || null, JSON.stringify(t.components || []), vars],
      );
      n += 1;
    }
    url = data.paging?.next || null;
  }
  return n;
}

/** What a person may hear: their own calls, or anyone's with crm.recordings. */
export const mayHearRecording = (user, call, canHearOthers) => call.agent_user_id === user.id || canHearOthers;
