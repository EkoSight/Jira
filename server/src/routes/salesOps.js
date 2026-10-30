import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { recordAuditEvent } from '../services/audit.js';
import { assertVisible, canSee, crmScope, salesSettings, scopeCondition } from '../services/sales/core.js';
import {
  CALL_OUTCOMES, clickToCall, exotelStatus, liftOptOut, logCall, mayHearRecording, optOut, retryWhatsApp, sendWhatsApp, syncTemplates,
  whatsappStatus,
} from '../services/sales/comms.js';
import { ACTIONS, CANCEL_ON, TRIGGERS, previewRule, retryRun, validateRule } from '../services/sales/automation.js';
import {
  IMPORT_FIELDS, TEMPLATE, correctionRows, startImport, undoImport, uploadImport, validateImport,
} from '../services/sales/imports.js';
import { sendTable } from '../services/sales/files.js';
import { listLeads } from '../services/sales/leads.js';
import { agentPerformance, drill, salesSummary, sourcePerformance, stageReport, targetsVsActuals } from '../services/sales/reports.js';

/**
 * The sales CRM's communication, automation, import/export, reporting and
 * operations routes. Behind sign-in and crm.view; each checks its own
 * permission and the record's visibility on the server.
 */
const router = Router();

const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const settingsOnly = requirePermission('crm.settings');
const automationOnly = requirePermission('crm.automation');

/** The record a call or message is about must be inside the person's book. */
async function assertLinks(req, { lead_id: leadId, account_id: accountId, opportunity_id: opportunityId }) {
  const scope = await crmScope(req.currentUser);
  if (leadId && !(await canSee(scope, 'lead', leadId))) throw notFound('Lead not found');
  if (accountId) await assertVisible(req.currentUser, 'account', accountId, 'Organization');
  if (opportunityId) await assertVisible(req.currentUser, 'opportunity', opportunityId, 'Opportunity');
}

// ---------------------------------------------------------------- calls

const followUpNext = z.object({
  kind: z.string().max(20).optional(), due_at: z.string().min(10), title: z.string().max(300).nullable().optional(),
  assignee_id: z.number().int().positive().nullable().optional(), priority: z.string().max(10).optional(), notes: z.string().max(5000).nullable().optional(),
}).nullable().optional();

router.post('/calls', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const data = z.object({
    lead_id: z.number().int().positive().nullable().optional(), account_id: z.number().int().positive().nullable().optional(),
    opportunity_id: z.number().int().positive().nullable().optional(), contact_id: z.number().int().positive().nullable().optional(),
    phone: z.string().max(40).nullable().optional(), direction: z.enum(['OUTBOUND', 'INBOUND']).default('OUTBOUND'),
    outcome: z.enum(CALL_OUTCOMES), notes: z.string().max(5000).nullable().optional(), duration_sec: z.number().int().min(0).max(86400).nullable().optional(),
    started_at: z.string().max(40).nullable().optional(), next: followUpNext,
  }).parse(req.body);
  if (['CONNECTED', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK_REQUESTED'].includes(data.outcome) && !data.notes?.trim()) {
    throw badRequest('Note what was said: a connected call with no notes cannot be followed up');
  }
  await assertLinks(req, data);
  res.status(201).json(await logCall(data, req.currentUser));
}));

router.post('/calls/click-to-call', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const data = z.object({
    phone: z.string().min(6).max(40), lead_id: z.number().int().positive().nullable().optional(), account_id: z.number().int().positive().nullable().optional(),
    contact_id: z.number().int().positive().nullable().optional(), opportunity_id: z.number().int().positive().nullable().optional(),
  }).parse(req.body);
  await assertLinks(req, data);
  res.status(201).json(await clickToCall({ actor: req.currentUser, phone: data.phone, leadId: data.lead_id, accountId: data.account_id, contactId: data.contact_id, opportunityId: data.opportunity_id }));
}));

router.get('/calls', asyncHandler(async (req, res) => {
  const scope = await crmScope(req.currentUser);
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['TRUE'];
  if (!scope.all) {
    where.push(`(c.agent_user_id = ${push(req.currentUser.id)}
      OR (c.lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm_leads l WHERE l.id = c.lead_id AND ${scopeCondition(scope, 'lead', 'l', push)}))
      OR (c.opportunity_id IS NOT NULL AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = c.opportunity_id AND ${scopeCondition(scope, 'opportunity', 'o', push)})))`);
  }
  if (req.query.mine === '1') where.push(`c.agent_user_id = ${push(req.currentUser.id)}`);
  const { rows } = await query(
    `SELECT c.id, c.provider, c.direction, c.status, c.from_number, c.to_number, c.started_at, c.duration_sec, c.outcome, c.notes, c.logged_manually,
            c.lead_id, c.account_id, c.opportunity_id, c.agent_user_id, (c.recording_ref IS NOT NULL) AS has_recording,
            u.full_name AS agent_name, l.ref AS lead_ref, COALESCE(a.name, l.organization_name, l.contact_name) AS about
       FROM crm_calls c LEFT JOIN users u ON u.id = c.agent_user_id LEFT JOIN crm_leads l ON l.id = c.lead_id LEFT JOIN accounts a ON a.id = c.account_id
      WHERE ${where.join(' AND ')} ORDER BY COALESCE(c.started_at, c.created_at) DESC LIMIT 200`, params,
  );
  const others = hasPermission(req.currentUser, 'crm.recordings');
  res.json({ calls: rows.map((c) => ({ ...c, can_play: c.has_recording && mayHearRecording(req.currentUser, c, others) })), outcomes: CALL_OUTCOMES });
}));

/** The recording, streamed through TaskFlow to people allowed to hear it; the provider's link never leaves the server. */
router.get('/calls/:id/recording', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM crm_calls WHERE id = $1', [id(req.params.id)]);
  const call = rows[0];
  if (!call) throw notFound('Call not found');
  if (!mayHearRecording(req.currentUser, call, hasPermission(req.currentUser, 'crm.recordings'))) throw forbidden('Recordings of other people’s calls need the recordings permission');
  if (call.agent_user_id !== req.currentUser.id) await assertLinks(req, call);
  if (!call.recording_ref) throw notFound('No recording is kept for this call');
  if (!/^https:\/\//.test(call.recording_ref)) throw notFound('The recording link is not usable');
  const e = config.sales.exotel;
  const headers = call.provider === 'exotel' && e.apiKey ? { authorization: `Basic ${Buffer.from(`${e.apiKey}:${e.apiToken}`).toString('base64')}` } : {};
  const upstream = await fetch(call.recording_ref, { headers }).catch(() => null);
  if (!upstream?.ok) throw notFound('The provider did not return the recording; it may have expired there');
  await recordAuditEvent(null, { action: 'CALL_RECORDING_PLAYED', entityType: 'CALL', entityId: call.id, actorId: req.currentUser.id });
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

// ---------------------------------------------------------------- WhatsApp

router.get('/whatsapp/templates', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM crm_wa_templates ORDER BY name, language');
  res.json({ templates: rows, status: whatsappStatus() });
}));

router.post('/whatsapp/templates/sync', settingsOnly, asyncHandler(async (req, res) => {
  const n = await syncTemplates();
  await recordAuditEvent(null, { action: 'WHATSAPP_TEMPLATES_SYNCED', entityType: 'SETTINGS', actorId: req.currentUser.id, summary: `${n} template(s)` });
  res.json({ synced: n });
}));

router.post('/whatsapp/send', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const data = z.object({
    to: z.string().min(6).max(40), body: z.string().max(4096).optional(), template_name: z.string().max(200).optional(), language: z.string().max(20).optional(),
    variables: z.array(z.string().max(1000)).max(20).optional(), lead_id: z.number().int().positive().nullable().optional(),
    account_id: z.number().int().positive().nullable().optional(), contact_id: z.number().int().positive().nullable().optional(),
    opportunity_id: z.number().int().positive().nullable().optional(), idempotency_key: z.string().max(200).optional(),
  }).parse(req.body);
  await assertLinks(req, data);
  const r = await sendWhatsApp({ ...data, idempotency_key: data.idempotency_key ? `user:${req.currentUser.id}:${data.idempotency_key}` : null }, { actor: req.currentUser });
  res.status(r.duplicate ? 200 : 201).json(r);
}));

router.post('/whatsapp/messages/:id/retry', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM crm_wa_messages WHERE id = $1', [id(req.params.id)]);
  if (!rows[0]) throw notFound('Message not found');
  await assertLinks(req, rows[0]);
  res.json({ message: await retryWhatsApp(rows[0].id) });
}));

router.get('/whatsapp/conversation', asyncHandler(async (req, res) => {
  const filters = z.object({ lead_id: z.coerce.number().int().positive().optional(), account_id: z.coerce.number().int().positive().optional(), opportunity_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  if (!filters.lead_id && !filters.account_id && !filters.opportunity_id) throw badRequest('Say whose conversation');
  await assertLinks(req, filters);
  const { rows } = await query(
    `SELECT m.id, m.direction, m.kind, m.template_name, m.body, m.media, m.status, m.error_title, m.created_at, m.sent_at, m.delivered_at, m.read_at,
            m.failed_at, m.provider_message_id IS NOT NULL AS accepted, u.full_name AS agent_name, m.phone
       FROM crm_wa_messages m LEFT JOIN users u ON u.id = m.agent_user_id
      WHERE ($1::int IS NOT NULL AND m.lead_id = $1) OR ($2::int IS NOT NULL AND m.account_id = $2) OR ($3::int IS NOT NULL AND m.opportunity_id = $3)
      ORDER BY m.created_at`, [filters.lead_id ?? null, filters.account_id ?? null, filters.opportunity_id ?? null],
  );
  const last = rows.filter((m) => m.direction === 'INBOUND').at(-1)?.created_at;
  res.json({ messages: rows, window_open_until: last ? new Date(new Date(last).getTime() + 24 * 3600_000).toISOString() : null, status: whatsappStatus() });
}));

router.post('/optouts', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const d = z.object({ channel: z.enum(['WHATSAPP', 'CALL', 'EMAIL', 'SMS']), address: z.string().min(3).max(200), reason: z.string().max(500).optional() }).parse(req.body);
  await withTransaction((client) => optOut(client, { ...d, source: 'MANUAL', actorId: req.currentUser.id }));
  await recordAuditEvent(null, { action: 'OPT_OUT_RECORDED', entityType: 'CONTACT', actorId: req.currentUser.id, summary: d.channel, reason: d.reason });
  res.status(201).json({ ok: true });
}));

router.post('/optouts/lift', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({ channel: z.enum(['WHATSAPP', 'CALL', 'EMAIL', 'SMS']), address: z.string().min(3).max(200), reason: z.string().min(5).max(500) }).parse(req.body);
  await withTransaction((client) => liftOptOut(client, { ...d, actorId: req.currentUser.id }));
  await recordAuditEvent(null, { action: 'OPT_OUT_LIFTED', entityType: 'CONTACT', actorId: req.currentUser.id, summary: d.channel, reason: d.reason });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- integrations health

router.get('/integrations', asyncHandler(async (req, res) => {
  const settings = await salesSettings();
  const [{ rows: events }, { rows: failures }] = await Promise.all([
    query(`SELECT provider, MAX(received_at) AS last_event, COUNT(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS last_24h,
                  COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
             FROM crm_integration_events GROUP BY provider`),
    query(`SELECT provider, kind, error, received_at FROM crm_integration_events WHERE status = 'FAILED' ORDER BY received_at DESC LIMIT 20`),
  ]);
  const wa = whatsappStatus();
  const ex = exotelStatus();
  const byProvider = Object.fromEntries(events.map((e) => [e.provider, e]));
  const state = (configured, provider) => (!configured ? 'Not connected' : byProvider[provider]?.last_event ? 'Receiving events' : 'Awaiting live verification');
  res.json({
    telecrm: { mode: 'Manual export hand-off', state: 'Working (manual)', note: 'No TeleCRM API is connected. Leads for TeleCRM are exported and confirmed by a person.' },
    whatsapp: { ...wa, state: state(wa.configured, 'whatsapp'), enabled_in_settings: settings.whatsapp?.enabled === true, last_event: byProvider.whatsapp?.last_event ?? null, events_24h: byProvider.whatsapp?.last_24h ?? 0 },
    calling: {
      provider_setting: settings.calls?.provider || 'none', exotel: { ...ex, state: state(ex.configured, 'exotel') },
      webhook: { configured: Boolean(config.sales.callWebhookSecret), state: state(Boolean(config.sales.callWebhookSecret), 'call-webhook'), path: `${config.apiPrefix}/s/calls/hook` },
      manual: { state: 'Working', note: 'Calls logged by hand; a tel: link opens the phone’s dialler and records nothing by itself.' },
    },
    capture: { path: `${config.apiPrefix}/s/leads` },
    failures,
  });
}));

// ---------------------------------------------------------------- automation

const ruleInput = z.object({
  name: z.string().min(2).max(160), description: z.string().max(2000).nullable().optional(), owner_user_id: z.number().int().positive().nullable().optional(),
  priority: z.number().int().min(0).max(100000).optional(), trigger: z.string().max(60),
  conditions: z.array(z.object({ field: z.string().max(60), op: z.string().max(12).optional(), value: z.any().optional() })).max(20).default([]),
  actions: z.array(z.record(z.any())).min(1).max(10), delay_minutes: z.number().int().min(0).max(60 * 24 * 60).default(0),
  business_hours_only: z.boolean().default(false), cancel_on: z.array(z.string()).max(5).default(['terminal']),
});

router.get('/automation/rules', asyncHandler(async (req, res) => {
  if (!hasPermission(req.currentUser, 'crm.automation') && !hasPermission(req.currentUser, 'crm.settings')) throw forbidden();
  const { rows } = await query(
    `SELECT r.*, u.full_name AS owner_name,
            (SELECT COUNT(*)::int FROM crm_automation_runs x WHERE x.rule_id = r.id AND x.created_at > now() - interval '30 days') AS runs_30d,
            (SELECT COUNT(*)::int FROM crm_automation_runs x WHERE x.rule_id = r.id AND x.status = 'FAILED') AS failed
       FROM crm_automation_rules r LEFT JOIN users u ON u.id = r.owner_user_id ORDER BY r.priority, r.id`,
  );
  res.json({ rules: rows, triggers: TRIGGERS, actions: ACTIONS, cancel_on: CANCEL_ON, live_sends: (await salesSettings()).automation?.liveSends === true });
}));

router.post('/automation/rules', automationOnly, asyncHandler(async (req, res) => {
  const d = ruleInput.parse(req.body);
  validateRule(d);
  // a new rule starts switched off and in test mode, whatever was asked
  const { rows } = await query(
    `INSERT INTO crm_automation_rules (name, description, owner_user_id, is_enabled, test_mode, priority, trigger, conditions, actions, delay_minutes,
                                       business_hours_only, cancel_on, created_by, updated_by)
     VALUES ($1,$2,$3,FALSE,TRUE,COALESCE($4,100),$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
    [d.name, d.description ?? null, d.owner_user_id ?? req.currentUser.id, d.priority ?? null, d.trigger, JSON.stringify(d.conditions), JSON.stringify(d.actions),
      d.delay_minutes, d.business_hours_only, d.cancel_on, req.currentUser.id],
  );
  await recordAuditEvent(null, { action: 'AUTOMATION_RULE_CREATED', entityType: 'AUTOMATION', entityId: rows[0].id, actorId: req.currentUser.id, summary: d.name, detail: d });
  res.status(201).json({ rule: rows[0] });
}));

router.patch('/automation/rules/:rid', automationOnly, asyncHandler(async (req, res) => {
  const d = ruleInput.partial().extend({ is_enabled: z.boolean().optional(), test_mode: z.boolean().optional() }).parse(req.body);
  const rid = id(req.params.rid);
  const { rows: cur } = await query('SELECT * FROM crm_automation_rules WHERE id = $1', [rid]);
  if (!cur[0]) throw notFound('Rule not found');
  const merged = { ...cur[0], ...d };
  validateRule(merged);
  if (d.test_mode === false && merged.actions.some((a) => a.type === 'send_whatsapp_template') && (await salesSettings()).automation?.liveSends !== true) {
    throw badRequest('This rule sends WhatsApp messages: switch on live sends in Settings → Automation first');
  }
  const sets = [];
  const params = [rid];
  for (const [k, v] of Object.entries(d)) {
    params.push(['conditions', 'actions'].includes(k) ? JSON.stringify(v) : v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) throw badRequest('Nothing to change');
  params.push(req.currentUser.id);
  const { rows } = await query(`UPDATE crm_automation_rules SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  // switching a rule off cancels what it had scheduled
  if (d.is_enabled === false) await query(`UPDATE crm_automation_runs SET status = 'CANCELLED', cancelled_reason = 'Rule switched off', finished_at = now() WHERE rule_id = $1 AND status = 'SCHEDULED'`, [rid]);
  await recordAuditEvent(null, { action: 'AUTOMATION_RULE_CHANGED', entityType: 'AUTOMATION', entityId: rid, actorId: req.currentUser.id, summary: rows[0].name, detail: { before: Object.fromEntries(Object.keys(d).map((k) => [k, cur[0][k]])), after: d } });
  res.json({ rule: rows[0] });
}));

router.post('/automation/preview', automationOnly, asyncHandler(async (req, res) => {
  const d = z.object({ rule: ruleInput, entity_type: z.enum(['LEAD', 'OPPORTUNITY']), entity_id: z.number().int().positive() }).parse(req.body);
  await assertLinks(req, d.entity_type === 'LEAD' ? { lead_id: d.entity_id } : { opportunity_id: d.entity_id });
  res.json(await previewRule(d.rule, d.entity_type, d.entity_id));
}));

router.get('/automation/runs', asyncHandler(async (req, res) => {
  if (!hasPermission(req.currentUser, 'crm.automation') && !hasPermission(req.currentUser, 'crm.settings')) throw forbidden();
  const { rows } = await query(
    `SELECT x.*, r.name AS rule_name FROM crm_automation_runs x JOIN crm_automation_rules r ON r.id = x.rule_id
      WHERE ($1::int IS NULL OR x.rule_id = $1) AND ($2::text IS NULL OR x.status = $2) ORDER BY x.id DESC LIMIT 200`,
    [req.query.rule_id ? Number(req.query.rule_id) : null, req.query.status || null],
  );
  res.json({ runs: rows });
}));

router.post('/automation/runs/:id/retry', automationOnly, asyncHandler(async (req, res) => {
  const runId = await retryRun(id(req.params.id));
  await recordAuditEvent(null, { action: 'AUTOMATION_RUN_RETRIED', entityType: 'AUTOMATION', entityId: runId, actorId: req.currentUser.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- imports

const importBody = express.raw({ type: () => true, limit: '15mb' });

router.get('/imports/template', asyncHandler(async (req, res) => {
  const entity = String(req.query.entity || 'LEADS').toUpperCase();
  const t = TEMPLATE[entity];
  if (!t) throw badRequest('Unknown import');
  await sendTable(res, { filename: `taskflow-${entity.toLowerCase()}-template`, format: req.query.format || 'XLSX', sheet: entity === 'LEADS' ? 'Leads' : 'Organizations', header: t.header, rows: t.rows, textColumns: t.textColumns });
}));

router.post('/imports', requirePermission('crm.import'), importBody, asyncHandler(async (req, res) => {
  const entity = String(req.query.entity || 'LEADS').toUpperCase();
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Attach the file');
  const result = await uploadImport({ entity, buffer: req.body, filename: String(req.query.filename || 'upload'), actor: req.currentUser });
  res.status(201).json(result);
}));

router.get('/imports', requirePermission('crm.import'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT j.id, j.entity, j.filename, j.status, j.counts, j.total_rows, j.processed_rows, j.created_at, j.finished_at, j.undone_at, j.undo_summary, u.full_name AS created_by_name
       FROM crm_import_jobs j LEFT JOIN users u ON u.id = j.created_by ORDER BY j.id DESC LIMIT 100`,
  );
  res.json({ jobs: rows, fields: Object.fromEntries(Object.entries(IMPORT_FIELDS).map(([k, v]) => [k, Object.keys(v)])) });
}));

router.get('/imports/:id', requirePermission('crm.import'), asyncHandler(async (req, res) => {
  const jobId = id(req.params.id);
  const { rows } = await query('SELECT * FROM crm_import_jobs WHERE id = $1', [jobId]);
  if (!rows[0]) throw notFound('Import not found');
  const { rows: preview } = await query(
    `SELECT row_no, status, errors, warnings, duplicate_of, entity_id, data FROM crm_import_rows WHERE job_id = $1
      ORDER BY (status = 'INVALID') DESC, (status = 'DUPLICATE') DESC, row_no LIMIT 200`, [jobId],
  );
  res.json({ job: rows[0], rows: preview });
}));

router.post('/imports/:id/validate', requirePermission('crm.import'), asyncHandler(async (req, res) => {
  const d = z.object({
    mapping: z.record(z.string().max(200)),
    options: z.object({
      duplicate_strategy: z.enum(['SKIP', 'UPDATE', 'CREATE']).optional(), default_category: z.string().max(40).optional(),
      default_owner_id: z.number().int().positive().nullable().optional(), source_id: z.number().int().positive().nullable().optional(),
      campaign_id: z.number().int().positive().nullable().optional(), source_system: z.string().max(80).nullable().optional(),
    }).default({}),
  }).parse(req.body);
  if (d.options.default_owner_id && !hasPermission(req.currentUser, 'crm.assign') && d.options.default_owner_id !== req.currentUser.id) {
    throw forbidden('Giving imported leads to someone else needs the assign permission');
  }
  res.json({ counts: await validateImport(id(req.params.id), d, req.currentUser) });
}));

router.post('/imports/:id/run', requirePermission('crm.import'), asyncHandler(async (req, res) => {
  const job = await startImport(id(req.params.id), req.currentUser);
  // the worker applies it in batches; the screen polls the job
  res.status(202).json({ job, note: 'Importing in the background. This page updates as rows are applied.' });
}));

router.post('/imports/:id/undo', requirePermission('crm.import'), asyncHandler(async (req, res) => {
  res.json({ summary: await undoImport(id(req.params.id), req.currentUser) });
}));

router.get('/imports/:id/corrections', requirePermission('crm.import'), asyncHandler(async (req, res) => {
  const { header, rows } = await correctionRows(id(req.params.id));
  await sendTable(res, { filename: `import-${req.params.id}-corrections`, format: req.query.format || 'XLSX', sheet: 'Corrections', header, rows });
}));

// ---------------------------------------------------------------- exports

const SENSITIVE = new Set(['email', 'phone', 'registration_ids']);

async function exportAudit(req, what, count, filters) {
  await recordAuditEvent(null, { action: 'CRM_EXPORT', entityType: 'EXPORT', actorId: req.currentUser.id, summary: `${what}: ${count} row(s)`, detail: { filters, sensitive: hasPermission(req.currentUser, 'crm.export.sensitive') } });
}

router.get('/exports/leads', requirePermission('crm.export'), asyncHandler(async (req, res) => {
  const scope = await crmScope(req.currentUser);
  const view = String(req.query.view || 'open');
  if (['needs_classification', 'telecrm'].includes(view) && !hasPermission(req.currentUser, 'crm.routing')) throw forbidden();
  const all = [];
  for (let page = 1; page <= 50; page += 1) {
    const r = await listLeads({ ...req.query, view, page, page_size: 200, userId: req.currentUser.id }, scope);
    all.push(...r.leads);
    if (all.length >= r.total) break;
  }
  if (all.length >= 10_000) throw badRequest('More than 10,000 leads match; narrow the filters (for example by date or owner) and export in parts');
  const sensitive = hasPermission(req.currentUser, 'crm.export.sensitive');
  const cols = [['ref', 'Ref'], ['category', 'Category'], ['status', 'Status'], ['organization_name', 'Organization'], ['contact_name', 'Contact'],
    ['email', 'Email'], ['phone', 'Phone'], ['city', 'City'], ['state', 'State'], ['owner_name', 'Owner'], ['source_name', 'Source'],
    ['campaign_name', 'Campaign'], ['score', 'Score'], ['priority', 'Priority'], ['captured_at', 'Captured'], ['last_activity_at', 'Last activity']]
    .filter(([k]) => sensitive || !SENSITIVE.has(k));
  await exportAudit(req, 'leads', all.length, req.query);
  await sendTable(res, {
    filename: `leads-${new Date().toISOString().slice(0, 10)}`, format: req.query.format || 'XLSX', sheet: 'Leads',
    header: cols.map(([, h]) => h), rows: all.map((l) => cols.map(([k]) => (l[k] instanceof Date ? l[k].toISOString() : l[k] ?? ''))),
    textColumns: cols.map(([k], i) => (k === 'phone' ? i : -1)).filter((i) => i >= 0),
  });
}));

router.get('/exports/opportunities', requirePermission('crm.export'), asyncHandler(async (req, res) => {
  const scope = await crmScope(req.currentUser);
  const { listOpportunities } = await import('../services/opportunities.js');
  const deals = await listOpportunities({ scope, eligibleOnly: true, pipelineId: req.query.pipeline_id ? Number(req.query.pipeline_id) : null, status: req.query.status || null });
  if (deals.length >= 10_000) throw badRequest('More than 10,000 deals match; narrow the filters');
  const finance = hasPermission(req.currentUser, 'crm.finance') || hasPermission(req.currentUser, 'crm.view.all') || req.currentUser.role === 'admin';
  const cols = [['id', 'Id'], ['name', 'Deal'], ['account_name', 'Organization'], ['stage_name', 'Stage'], ['status', 'Status'], ['owner_name', 'Owner'],
    ['currency', 'Currency'], ['estimated_value', 'Estimated value'], ['probability', 'Probability %'], ['expected_close', 'Expected close'],
    ['agreed_value', 'Agreed value'], ...(finance ? [['cash_received', 'Received (deal currency)']] : []), ['next_step', 'Next action'], ['next_step_due', 'Next action due']];
  await exportAudit(req, 'opportunities', deals.length, req.query);
  await sendTable(res, { filename: `deals-${new Date().toISOString().slice(0, 10)}`, format: req.query.format || 'XLSX', sheet: 'Deals',
    header: cols.map(([, h]) => h), rows: deals.map((d) => cols.map(([k]) => d[k] ?? '')) });
}));

router.get('/exports/report', requirePermission('crm.export'), asyncHandler(async (req, res) => {
  const scope = await crmScope(req.currentUser);
  const r = await drill(String(req.query.metric || ''), req.query, scope);
  const header = r.rows.length ? Object.keys(r.rows[0]) : ['(no rows)'];
  await exportAudit(req, `report ${req.query.metric}`, r.rows.length, req.query);
  await sendTable(res, { filename: `report-${req.query.metric}-${r.filters.from}-${r.filters.to}`, format: req.query.format || 'XLSX', sheet: 'Records',
    header, rows: r.rows.map((row) => header.map((h) => (row[h] instanceof Date ? row[h].toISOString() : row[h] ?? ''))) });
}));

// ---------------------------------------------------------------- reports

router.get('/reports/summary', asyncHandler(async (req, res) => res.json(await salesSummary(req.query, await crmScope(req.currentUser)))));
router.get('/reports/sources', asyncHandler(async (req, res) => res.json(await sourcePerformance(req.query, await crmScope(req.currentUser)))));
router.get('/reports/agents', asyncHandler(async (req, res) => res.json(await agentPerformance(req.query, await crmScope(req.currentUser)))));
router.get('/reports/stages', asyncHandler(async (req, res) => res.json(await stageReport(req.query, await crmScope(req.currentUser)))));
router.get('/reports/targets', asyncHandler(async (req, res) => res.json(await targetsVsActuals(req.query, await crmScope(req.currentUser)))));
router.get('/reports/drill', asyncHandler(async (req, res) => res.json(await drill(String(req.query.metric || ''), req.query, await crmScope(req.currentUser), { limit: 500 }))));

router.post('/targets', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    scope: z.enum(['COMPANY', 'TEAM', 'USER']).default('COMPANY'), user_id: z.number().int().positive().nullable().optional(),
    department_id: z.number().int().positive().nullable().optional(), pipeline_id: z.number().int().positive().nullable().optional(),
    metric: z.enum(['NEW_LEADS', 'CONVERTED_LEADS', 'WON_DEALS', 'WON_VALUE', 'CSR_COMMITTED', 'RECEIPTS', 'ACTIVITIES']),
    target: z.number().min(0), currency: z.string().length(3).nullable().optional(),
  }).parse(req.body);
  if (d.period_end < d.period_start) throw badRequest('The period ends before it starts');
  const { rows } = await query(
    `INSERT INTO crm_targets (period_start, period_end, scope, user_id, department_id, pipeline_id, metric, target, currency, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [d.period_start, d.period_end, d.scope, d.user_id ?? null, d.department_id ?? null, d.pipeline_id ?? null, d.metric, d.target,
      ['WON_VALUE', 'CSR_COMMITTED', 'RECEIPTS'].includes(d.metric) ? d.currency || 'INR' : null, req.currentUser.id],
  );
  await recordAuditEvent(null, { action: 'TARGET_SET', entityType: 'SETTINGS', entityId: rows[0].id, actorId: req.currentUser.id, detail: d });
  res.status(201).json({ target: rows[0] });
}));

router.get('/report-schedules', settingsOnly, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, u.full_name AS created_by_name,
            (SELECT COALESCE(json_agg(json_build_object('id', r.id, 'full_name', r.full_name, 'is_active', r.is_active) ORDER BY r.full_name), '[]')
               FROM users r WHERE r.id = ANY(s.recipient_ids)) AS recipients
       FROM crm_report_schedules s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.is_enabled DESC, s.name`,
  );
  res.json({ schedules: rows });
}));

router.patch('/report-schedules/:id', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({
    name: z.string().min(2).max(120).optional(), is_enabled: z.boolean().optional(),
    recipient_ids: z.array(z.number().int().positive()).min(1).max(50).optional(),
  }).parse(req.body);
  const { rows } = await query(
    `UPDATE crm_report_schedules SET name = COALESCE($2, name), is_enabled = COALESCE($3, is_enabled),
            recipient_ids = COALESCE($4::int[], recipient_ids), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id(req.params.id), d.name ?? null, d.is_enabled ?? null, d.recipient_ids ?? null],
  );
  if (!rows[0]) throw notFound('Schedule not found');
  await recordAuditEvent(null, { action: 'REPORT_SCHEDULE_CHANGED', entityType: 'SETTINGS', entityId: rows[0].id, actorId: req.currentUser.id, detail: d });
  res.json({ schedule: rows[0] });
}));

router.post('/report-schedules', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({
    name: z.string().min(2).max(120), report: z.enum(['summary', 'sources', 'agents', 'stages']), frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
    recipient_ids: z.array(z.number().int().positive()).min(1).max(50), filters: z.record(z.any()).default({}),
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO crm_report_schedules (name, report, filters, frequency, recipient_ids, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [d.name, d.report, d.filters, d.frequency, d.recipient_ids, req.currentUser.id],
  );
  await recordAuditEvent(null, { action: 'REPORT_SCHEDULE_CREATED', entityType: 'SETTINGS', entityId: rows[0].id, actorId: req.currentUser.id, detail: d });
  res.status(201).json({ schedule: rows[0], note: 'Sent as an in-app notice to each recipient, with numbers limited to what that person may see.' });
}));

// ---------------------------------------------------------------- saved views

router.get('/views', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM crm_saved_views WHERE (user_id = $1 OR is_shared) AND area = $2 ORDER BY name', [req.currentUser.id, String(req.query.area || 'leads')]);
  res.json({ views: rows });
}));
router.post('/views', asyncHandler(async (req, res) => {
  const d = z.object({ area: z.string().max(30), name: z.string().min(1).max(80), filters: z.record(z.any()), is_shared: z.boolean().optional() }).parse(req.body);
  if (d.is_shared && !hasPermission(req.currentUser, 'crm.view.team') && !hasPermission(req.currentUser, 'crm.settings')) throw forbidden('Sharing a view with everyone needs team access');
  const { rows } = await query('INSERT INTO crm_saved_views (user_id, area, name, filters, is_shared) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.currentUser.id, d.area, d.name, d.filters, d.is_shared || false]);
  res.status(201).json({ view: rows[0] });
}));
router.delete('/views/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM crm_saved_views WHERE id = $1 AND user_id = $2', [id(req.params.id), req.currentUser.id]);
  if (!rowCount) throw notFound('View not found');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- audit

router.get('/audit', requirePermission('crm.audit'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.id, e.action, e.entity_type, e.entity_id, e.summary, e.reason, e.created_at, u.full_name AS actor_name
       FROM crm_audit_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE ($1::text IS NULL OR e.action = $1) AND ($2::text IS NULL OR e.entity_type = $2) AND ($3::int IS NULL OR e.entity_id = $3)
        AND ($4::text IS NULL OR e.summary ILIKE '%' || $4 || '%' OR e.action ILIKE '%' || $4 || '%')
      ORDER BY e.id DESC LIMIT 300`,
    [req.query.action || null, req.query.entity_type || null, req.query.entity_id ? Number(req.query.entity_id) : null, req.query.q || null],
  );
  res.json({ events: rows });
}));

export default router;
