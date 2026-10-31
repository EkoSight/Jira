import express, { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { sendCsv } from '../lib/csv.js';
import { recordAuditEvent } from '../services/audit.js';
import { getSettings, updateSetting } from '../services/settings.js';
import {
  CATEGORY_LABEL, DECISION_ROLES, FOLLOWUP_KINDS, KNOWN_CATEGORIES, LEAD_CATEGORIES, LEAD_STATUSES, isExcluded, isOrgCategory,
  ORG_ROLES, ORG_TYPES, PARTY_ROLES, PRIORITIES, canSee, crmScope, isEligible, rememberRouting, salesSettings,
} from '../services/sales/core.js';
import {
  LEAD_VIEWS, archiveLead, convertLead, createLead, findDuplicates, getLead, leadCounts, leadRouting, leadTimeline, listLeads,
  logLeadActivity, updateLead,
} from '../services/sales/leads.js';
import { autoAssignLead, chooseOwner, reassignLead, STRATEGIES } from '../services/sales/assignment.js';
import { CRITERIA, forgetScoringModels, scoreLead, scoringModels } from '../services/sales/scoring.js';
import { callStatuses, categoryFromFields, cleanCustomFields, leadFields } from '../services/sales/calling.js';
import {
  HANDOFF_HEADER, classifyAccount, confirmHandoff, handoffRow, listHandoffs, markExported, remediationQueue, routeLead,
} from '../services/sales/routing.js';
import {
  FOLLOWUP_SELECT, completeFollowUp, createFollowUp, handOffFollowUp, myDay, rescheduleFollowUp, snoozeFollowUp,
} from '../services/sales/followups.js';
import { createCaptureKey } from '../services/sales/capture.js';
import { mergeRecords, previewMerge } from '../services/sales/merge.js';
import { sendTable } from '../services/sales/files.js';

/**
 * The sales CRM for staff: leads, routing, assignment, follow-ups, merging and
 * configuration. Mounted behind sign-in and crm.view; every record a person
 * opens, lists, searches or exports is limited to what they may see.
 */
const router = Router();

const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const settingsOnly = requirePermission('crm.settings');
const routingOnly = requirePermission('crm.routing');

async function visibleLead(req, leadId) {
  const scope = await crmScope(req.currentUser);
  if (!(await canSee(scope, 'lead', leadId))) throw notFound('Lead not found');
  const lead = await getLead(leadId);
  if (!lead) throw notFound('Lead not found');
  // the classification queue and TeleCRM's leads are for the people who route them
  if (lead.destination !== 'TASKFLOW' && !hasPermission(req.currentUser, 'crm.routing')
      && lead.owner_user_id !== req.currentUser.id && lead.created_by !== req.currentUser.id) throw notFound('Lead not found');
  return lead;
}

const canWorkLead = (user, lead) => lead.owner_user_id === user.id || lead.created_by === user.id
  || hasPermission(user, 'crm.assign') || hasPermission(user, 'crm.manage.any');

// ---------------------------------------------------------------- the catalogue

router.get('/meta', asyncHandler(async (req, res) => {
  const user = req.currentUser;
  const [pipelines, stages, sources, campaigns, users, departments, settings, statuses, fields] = await Promise.all([
    query('SELECT * FROM crm_pipelines ORDER BY position, id'),
    query(`SELECT id, name, slug, kind, color, position, pipeline_id, default_probability, is_active, retired_at, required_fields,
                  allowed_to, aging_days, approval_gate, counts_in_forecast, entry_rules, exit_rules, checklist
             FROM account_stages ORDER BY position, id`),
    query('SELECT * FROM crm_sources ORDER BY position, id'),
    query('SELECT c.*, s.name AS source_name FROM crm_campaigns c LEFT JOIN crm_sources s ON s.id = c.source_id ORDER BY c.created_at DESC'),
    query(`SELECT u.id, u.full_name, u.role, u.department_id, u.is_active, u.avatar_color FROM users u ORDER BY u.full_name`),
    query('SELECT id, name, key FROM departments WHERE is_active = TRUE ORDER BY position, name'),
    salesSettings(),
    callStatuses(),
    leadFields(),
  ]);
  const can = Object.fromEntries(['crm.create', 'crm.manage.any', 'crm.activity.log', 'crm.view.all', 'crm.view.team', 'crm.assign', 'crm.routing',
    'crm.import', 'crm.export', 'crm.export.sensitive', 'crm.merge', 'crm.approve', 'crm.finance', 'crm.recordings', 'crm.audit',
    'crm.settings', 'crm.automation', 'crm.stages.manage'].map((p) => [p, hasPermission(user, p)]));
  res.json({
    categories: LEAD_CATEGORIES.map((key) => ({ key, label: CATEGORY_LABEL[key], eligible: isEligible(key), excluded: isExcluded(key), organization: isOrgCategory(key) })),
    call_statuses: statuses, lead_fields: fields, tele_sales_here: isEligible('RETAILER'),
    lead_statuses: LEAD_STATUSES, priorities: PRIORITIES, followup_kinds: FOLLOWUP_KINDS, views: LEAD_VIEWS,
    org_types: ORG_TYPES, org_roles: ORG_ROLES, party_roles: PARTY_ROLES, decision_roles: DECISION_ROLES,
    assignment_strategies: STRATEGIES, scoring_criteria: Object.entries(CRITERIA).map(([key, c]) => ({ key, label: c.label })),
    pipelines: pipelines.rows, stages: stages.rows, sources: sources.rows, campaigns: campaigns.rows,
    users: users.rows, departments: departments.rows,
    settings: {
      visibility: settings.visibility, calendar: settings.calendar, followUps: settings.followUps, routing: settings.routing,
      assignment: settings.assignment, automation: settings.automation, calls: settings.calls, whatsapp: settings.whatsapp, quotes: settings.quotes,
      calling: settings.calling,
    },
    can, me: { id: user.id, role: user.role, department_id: user.department_id },
  });
}));

// ---------------------------------------------------------------- leads

const leadInput = z.object({
  category: z.enum(LEAD_CATEGORIES),
  organization_name: z.string().max(200).nullable().optional(),
  account_id: z.number().int().positive().nullable().optional(),
  contact_name: z.string().max(160).nullable().optional(),
  designation: z.string().max(160).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  website: z.string().max(300).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(80).nullable().optional(),
  country: z.string().max(80).nullable().optional(),
  enquiry: z.string().max(20000).nullable().optional(),
  requirement: z.string().max(20000).nullable().optional(),
  budget_amount: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  budget_confirmed: z.boolean().nullable().optional(),
  timeline: z.enum(['IMMEDIATE', 'QUARTER', 'HALF_YEAR', 'YEAR', 'UNKNOWN']).nullable().optional(),
  decision_maker_engaged: z.boolean().nullable().optional(),
  need_clarity: z.enum(['CLEAR', 'PARTIAL', 'VAGUE']).nullable().optional(),
  fit: z.enum(['STRONG', 'PARTIAL', 'WEAK']).nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  source_id: z.number().int().positive().nullable().optional(),
  campaign_id: z.number().int().positive().nullable().optional(),
  utm: z.record(z.string().max(200)).optional(),
  referral: z.string().max(300).nullable().optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  department_id: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  next_follow_up_at: z.string().max(40).nullable().optional(),
  custom_fields: z.record(z.any()).optional(),
  external_id: z.string().max(200).nullable().optional(),
  source_system: z.string().max(80).nullable().optional(),
  consent: z.record(z.any()).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  call_status_id: z.number().int().positive().nullable().optional(),
});

/**
 * Custom field answers checked against their definitions; an answer that says
 * who the lead is ("Agri retailer") gives an unclassified lead its category.
 */
async function withLeadFields(data, current = null) {
  if (data.custom_fields === undefined) return data;
  const fields = await leadFields({ activeOnly: true });
  const { clean, errors } = cleanCustomFields(data.custom_fields, fields);
  if (Object.keys(errors).length) throw badRequest(`${fields.find((f) => f.key === Object.keys(errors)[0])?.label || Object.keys(errors)[0]}: ${Object.values(errors)[0]}`, { fields: errors });
  const out = { ...data, custom_fields: clean };
  const category = data.category ?? current?.category ?? 'UNCLASSIFIED';
  const implied = categoryFromFields({ ...(current?.custom_fields || {}), ...clean }, fields);
  if (implied && category === 'UNCLASSIFIED') { out.category = implied.category; out.reason = out.reason || `${implied.field.label}: ${implied.option.label}`; }
  return out;
}

router.get('/leads', asyncHandler(async (req, res) => {
  const view = String(req.query.view || 'open');
  if (['needs_classification', 'telecrm'].includes(view) && !hasPermission(req.currentUser, 'crm.routing')) throw forbidden('The classification and TeleCRM queues are for the people who route leads');
  const scope = await crmScope(req.currentUser);
  res.json(await listLeads({ ...req.query, view, userId: req.currentUser.id }, scope));
}));

router.get('/leads/counts', asyncHandler(async (req, res) => {
  const counts = await leadCounts(await crmScope(req.currentUser), req.currentUser.id);
  if (!hasPermission(req.currentUser, 'crm.routing')) { delete counts.needs_classification; delete counts.telecrm_pending; }
  res.json({ counts });
}));

router.post('/leads/duplicates', asyncHandler(async (req, res) => {
  const found = await findDuplicates(req.body || {});
  // only what the person may see is named
  const scope = await crmScope(req.currentUser);
  const leads = [];
  for (const l of found.leads) if (await canSee(scope, 'lead', l.id)) leads.push(l); else leads.push({ id: null, reasons: l.reasons, hidden: true });
  const accounts = [];
  for (const a of found.accounts) if (await canSee(scope, 'account', a.id)) accounts.push(a); else accounts.push({ id: null, reasons: a.reasons, hidden: true, owner_name: a.owner_name });
  res.json({ leads, accounts, contacts: found.contacts.filter(() => scope.all) });
}));

router.post('/leads', requirePermission('crm.create'), asyncHandler(async (req, res) => {
  const data = await withLeadFields(leadInput.parse(req.body));
  if (data.owner_user_id && data.owner_user_id !== req.currentUser.id && !hasPermission(req.currentUser, 'crm.assign')) {
    throw forbidden('Assigning a lead to someone else needs the assign permission');
  }
  const result = await createLead(data, { actor: req.currentUser, channel: 'MANUAL' });
  res.status(result.created ? 201 : 200).json(result);
}));

router.get('/leads/:id', asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  const models = await scoringModels();
  const [timeline, routing, followups, duplicates, calls, messages] = await Promise.all([
    leadTimeline(lead.id),
    leadRouting(lead.id),
    query(`${FOLLOWUP_SELECT} WHERE t.crm_lead_id = $1 AND t.followup_kind IS NOT NULL ORDER BY t.completed_at DESC NULLS FIRST, t.due_date`, [lead.id]),
    findDuplicates({ ...lead }),
    query(`SELECT c.*, u.full_name AS agent_name FROM crm_calls c LEFT JOIN users u ON u.id = c.agent_user_id WHERE c.lead_id = $1 ORDER BY COALESCE(c.started_at, c.created_at) DESC`, [lead.id]),
    query(`SELECT m.id, m.direction, m.kind, m.template_name, m.body, m.status, m.error_title, m.created_at, m.sent_at, m.delivered_at, m.read_at,
                  u.full_name AS agent_name
             FROM crm_wa_messages m LEFT JOIN users u ON u.id = m.agent_user_id WHERE m.lead_id = $1 ORDER BY m.created_at DESC`, [lead.id]),
  ]);
  const scored = scoreLead(lead, models[lead.category]);
  const canRecordings = hasPermission(req.currentUser, 'crm.recordings');
  res.json({
    lead,
    timeline,
    routing,
    followups: followups.rows,
    duplicates: { leads: duplicates.leads.filter((d) => d.id !== lead.id), accounts: duplicates.accounts, contacts: duplicates.contacts },
    calls: calls.rows.map((c) => ({ ...c, recording_ref: undefined, has_recording: Boolean(c.recording_ref), can_play: Boolean(c.recording_ref) && (canRecordings || c.agent_user_id === req.currentUser.id) })),
    messages: messages.rows,
    score: scored,
    can: { edit: canWorkLead(req.currentUser, lead), assign: hasPermission(req.currentUser, 'crm.assign'), route: hasPermission(req.currentUser, 'crm.routing') },
  });
}));

router.patch('/leads/:id', asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  if (!canWorkLead(req.currentUser, lead)) throw forbidden('Only the lead\'s owner, or someone who can assign leads, can change it');
  const data = await withLeadFields(leadInput.partial().extend({
    status: z.enum(LEAD_STATUSES).optional(),
    disqualify_reason: z.string().max(2000).nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
    score_override: z.number().int().min(0).max(100).nullable().optional(),
    score_override_reason: z.string().max(1000).nullable().optional(),
  }).parse(req.body), lead);
  if (data.owner_user_id !== undefined && data.owner_user_id !== lead.owner_user_id && !hasPermission(req.currentUser, 'crm.assign')) {
    throw forbidden('Reassigning a lead needs the assign permission');
  }
  // taking a lead out of the review queues (or back) is the router's call
  if (data.category !== undefined && data.category !== lead.category && lead.destination !== 'TASKFLOW' && !hasPermission(req.currentUser, 'crm.routing')) {
    throw forbidden('Only people who route leads can reclassify a lead in the review queues');
  }
  if (data.score_override !== undefined && !hasPermission(req.currentUser, 'crm.assign')) throw forbidden('Overriding a score needs the assign permission');
  res.json({ lead: await updateLead(lead.id, data, { actor: req.currentUser }) });
}));

router.post('/leads/:id/archive', asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  if (!canWorkLead(req.currentUser, lead)) throw forbidden();
  res.json({ lead: await archiveLead(lead.id, { actor: req.currentUser, reason: req.body?.reason || null }) });
}));
router.post('/leads/:id/restore', asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  if (!canWorkLead(req.currentUser, lead)) throw forbidden();
  res.json({ lead: await archiveLead(lead.id, { actor: req.currentUser, restore: true }) });
}));

router.post('/leads/:id/convert', requirePermission('crm.create'), asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  if (!canWorkLead(req.currentUser, lead)) throw forbidden();
  const body = z.object({
    account: z.object({ id: z.number().int().positive().optional(), mode: z.enum(['existing', 'new']).optional(), name: z.string().max(200).optional(),
      org_type: z.enum(ORG_TYPES).optional(), segment_id: z.number().int().positive().nullable().optional() }).optional(),
    contact: z.object({ id: z.number().int().positive().optional(), mode: z.enum(['existing', 'new', 'none']).optional(),
      decision_roles: z.array(z.enum(DECISION_ROLES)).optional() }).optional(),
    opportunity: z.object({ id: z.number().int().positive().optional(), name: z.string().max(200).optional(), stage_id: z.number().int().positive().optional(),
      estimated_value: z.number().min(0).nullable().optional(), currency: z.string().length(3).optional(), expected_close: z.string().nullable().optional(),
      next_step: z.string().max(2000).nullable().optional(), next_step_due: z.string().nullable().optional(),
      next_step_owner_id: z.number().int().positive().nullable().optional(),
      opportunity_type: z.enum(['NEW_BUSINESS', 'REPEAT', 'RENEWAL', 'UPSELL', 'CSR_FUNDING', 'NGO_PURCHASE', 'PARTNERSHIP']).optional(),
      engagement_model: z.string().optional(), requested_amount: z.number().min(0).nullable().optional(), proposed_project: z.string().max(2000).optional() }).optional(),
  }).parse(req.body || {});
  if (body.account?.id) {
    const scope = await crmScope(req.currentUser);
    if (!(await canSee(scope, 'account', body.account.id))) throw notFound('Organization not found');
  }
  const result = await convertLead(lead.id, body, { actor: req.currentUser });
  res.status(result.already ? 200 : 201).json(result);
}));

router.post('/leads/:id/activities', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  if (!canWorkLead(req.currentUser, lead)) throw forbidden();
  const data = z.object({
    type: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'VISIT']),
    direction: z.enum(['OUTBOUND', 'INBOUND', 'INTERNAL']).default('INTERNAL'),
    outcome: z.enum(['COMPLETED', 'ATTEMPTED', 'SENT', 'RECEIVED', 'NOTED']).nullable().optional(),
    subject: z.string().max(300).nullable().optional(),
    body: z.string().max(20000).nullable().optional(),
    occurred_at: z.string().max(40).nullable().optional(),
  }).parse(req.body);
  if (data.occurred_at && new Date(data.occurred_at).getTime() > Date.now() + 5 * 60_000) throw badRequest('An activity cannot be in the future; schedule a follow-up instead');
  const activity = await withTransaction((client) => logLeadActivity(client, lead.id, {
    type: data.type, direction: data.type === 'NOTE' ? 'INTERNAL' : data.direction, outcome: data.outcome ?? (data.type === 'NOTE' ? 'NOTED' : null),
    subject: data.subject, body: data.body, actorId: req.currentUser.id, occurredAt: data.occurred_at || null,
  }));
  res.status(201).json({ activity });
}));

router.post('/leads/:id/assign', asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  const data = z.object({ user_id: z.number().int().positive().nullable().optional(), reason: z.string().max(2000).nullable().optional() }).parse(req.body || {});
  if (!hasPermission(req.currentUser, 'crm.assign')) throw forbidden('Assigning leads needs the assign permission');
  const result = await withTransaction(async (client) => {
    if (data.user_id) return reassignLead(client, lead.id, { toUserId: data.user_id, reason: data.reason, actor: req.currentUser });
    return autoAssignLead(client, lead.id, { actor: req.currentUser });
  });
  res.json({ lead: await getLead(lead.id), result });
}));

const BULK_ACTIONS = ['assign', 'status', 'priority', 'tag', 'untag', 'category', 'archive'];
router.post('/leads/bulk', asyncHandler(async (req, res) => {
  const data = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
    action: z.enum(BULK_ACTIONS),
    value: z.any().optional(),
    reason: z.string().max(2000).nullable().optional(),
  }).parse(req.body);
  const user = req.currentUser;
  if (['assign'].includes(data.action) && !hasPermission(user, 'crm.assign')) throw forbidden('Bulk assignment needs the assign permission');
  if (data.action === 'category' && !hasPermission(user, 'crm.routing')) throw forbidden('Bulk reclassification needs the routing permission');
  const scope = await crmScope(user);
  const done = [];
  const refused = [];
  // each record is checked and changed on its own; one refusal does not undo the rest
  for (const leadId of data.ids) {
    try {
      if (!(await canSee(scope, 'lead', leadId))) throw notFound('Lead not found');
      const lead = await getLead(leadId);
      if (!canWorkLead(user, lead)) throw forbidden();
      if (data.action === 'assign') await updateLead(leadId, { owner_user_id: Number(data.value), reason: data.reason || 'Bulk reassignment' }, { actor: user });
      else if (data.action === 'status') await updateLead(leadId, { status: data.value, disqualify_reason: data.reason, reason: data.reason }, { actor: user });
      else if (data.action === 'priority') await updateLead(leadId, { priority: data.value }, { actor: user });
      else if (data.action === 'tag') await updateLead(leadId, { tags: [...new Set([...(lead.tags || []), String(data.value).slice(0, 40)])] }, { actor: user });
      else if (data.action === 'untag') await updateLead(leadId, { tags: (lead.tags || []).filter((t) => t !== data.value) }, { actor: user });
      else if (data.action === 'category') await updateLead(leadId, { category: data.value, reason: data.reason || 'Bulk reclassification' }, { actor: user });
      else if (data.action === 'archive') await archiveLead(leadId, { actor: user, reason: data.reason });
      done.push(leadId);
    } catch (err) {
      refused.push({ id: leadId, error: err.message });
    }
  }
  await recordAuditEvent(null, {
    action: 'LEAD_BULK_UPDATE', entityType: 'LEAD', actorId: user.id, reason: data.reason,
    summary: `${data.action} on ${done.length} lead(s)${refused.length ? `, ${refused.length} refused` : ''}`, detail: { action: data.action, value: data.value, done, refused },
  });
  res.json({ done, refused });
}));

router.post('/assignment/simulate', asyncHandler(async (req, res) => {
  if (!hasPermission(req.currentUser, 'crm.assign') && !hasPermission(req.currentUser, 'crm.settings')) throw forbidden();
  const lead = z.object({
    category: z.enum(LEAD_CATEGORIES).default('B2B_CORPORATE'), source_id: z.number().int().nullable().optional(),
    campaign_id: z.number().int().nullable().optional(), state: z.string().nullable().optional(), tags: z.array(z.string()).optional(),
    priority: z.enum(PRIORITIES).optional(), score: z.number().nullable().optional(), account_id: z.number().int().nullable().optional(),
    requirement: z.string().nullable().optional(),
  }).parse(req.body || {});
  if (!isEligible(lead.category)) return res.json({ userId: null, explain: { decided_by: { kind: 'NONE', why: `${CATEGORY_LABEL[lead.category]} leads are not assigned in Taskflow` } } });
  const account = lead.account_id ? (await query('SELECT id, name, owner_user_id FROM accounts WHERE id = $1', [lead.account_id])).rows[0] : null;
  const result = await chooseOwner({ ...lead, tags: lead.tags || [] }, { account });
  res.json(result);
}));

// ---------------------------------------------------------------- follow-ups and my day

router.get('/my-day', asyncHandler(async (req, res) => {
  const user = req.currentUser;
  let teamUserIds = null;
  let userId = req.query.user_id ? Number(req.query.user_id) : user.id;
  if (userId !== user.id || req.query.team === 'true') {
    const scope = await crmScope(user);
    if (!scope.all && !hasPermission(user, 'crm.view.team')) throw forbidden('Seeing someone else\'s day needs team access');
    if (req.query.team === 'true') {
      const { rows } = scope.all
        ? await query(`SELECT id FROM users WHERE is_active = TRUE AND role <> 'viewer'`)
        : await query('SELECT id FROM users WHERE is_active = TRUE AND department_id = ANY($1::int[])', [scope.departmentIds]);
      teamUserIds = rows.map((r) => r.id);
    } else if (!scope.all) {
      const { rows } = await query('SELECT department_id FROM users WHERE id = $1', [userId]);
      if (!scope.departmentIds.includes(rows[0]?.department_id)) throw forbidden('That person is not in your teams');
    }
  } else userId = user.id;
  const day = await myDay(user, { userId, teamUserIds, scope: await crmScope(user) });
  res.json({ ...day, team: Boolean(teamUserIds) });
}));

const followUpInput = z.object({
  lead_id: z.number().int().positive().nullable().optional(),
  account_id: z.number().int().positive().nullable().optional(),
  opportunity_id: z.number().int().positive().nullable().optional(),
  kind: z.enum(FOLLOWUP_KINDS).default('CALL'),
  title: z.string().max(300).nullable().optional(),
  due_at: z.string().min(10).max(40),
  assignee_id: z.number().int().positive().nullable().optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  notes: z.string().max(5000).nullable().optional(),
  recurrence: z.enum(['none', 'daily', 'weekdays', 'weekly', 'monthly']).default('none'),
  reminder_minutes: z.number().int().min(0).max(10080).default(15),
});

router.post('/followups', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  const data = followUpInput.parse(req.body);
  const scope = await crmScope(req.currentUser);
  if (data.lead_id) await visibleLead(req, data.lead_id);
  if (data.account_id && !(await canSee(scope, 'account', data.account_id))) throw notFound('Organization not found');
  if (data.opportunity_id && !(await canSee(scope, 'opportunity', data.opportunity_id))) throw notFound('Deal not found');
  if (data.assignee_id && data.assignee_id !== req.currentUser.id && !hasPermission(req.currentUser, 'crm.assign')) {
    // agents may hand a follow-up only to themselves; the lead's owner owes it by default
    const lead = data.lead_id ? await getLead(data.lead_id) : null;
    if (!lead || lead.owner_user_id !== data.assignee_id) throw forbidden('Giving a follow-up to someone else needs the assign permission');
  }
  const task = await withTransaction((client) => createFollowUp(client, {
    leadId: data.lead_id, accountId: data.account_id, opportunityId: data.opportunity_id, kind: data.kind, title: data.title,
    dueAt: data.due_at, assigneeId: data.assignee_id, priority: data.priority, notes: data.notes, actor: req.currentUser,
    recurrence: data.recurrence, reminderMinutes: data.reminder_minutes,
  }));
  res.status(201).json({ task });
}));

router.post('/followups/:id/complete', asyncHandler(async (req, res) => {
  const data = z.object({
    outcome: z.enum(['CONNECTED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'LEFT_MESSAGE', 'DONE', 'NOT_DONE']).default('DONE'),
    notes: z.string().max(5000).nullable().optional(),
    no_next_reason: z.string().max(500).nullable().optional(),
    next: z.object({ kind: z.enum(FOLLOWUP_KINDS).optional(), due_at: z.string().min(10), title: z.string().max(300).nullable().optional(),
      assignee_id: z.number().int().positive().nullable().optional(), priority: z.enum(PRIORITIES).optional(), notes: z.string().max(5000).nullable().optional() }).nullable().optional(),
  }).parse(req.body || {});
  res.json(await completeFollowUp(id(req.params.id), { outcome: data.outcome, notes: data.notes, next: data.next, noNextReason: data.no_next_reason }, req.currentUser));
}));
router.post('/followups/:id/reschedule', asyncHandler(async (req, res) => {
  const data = z.object({ due_at: z.string().min(10), reason: z.string().max(1000).nullable().optional() }).parse(req.body || {});
  res.json({ task: await rescheduleFollowUp(id(req.params.id), { dueAt: data.due_at, reason: data.reason }, req.currentUser) });
}));
router.post('/followups/:id/snooze', asyncHandler(async (req, res) => {
  const data = z.object({ until: z.string().min(10) }).parse(req.body || {});
  res.json({ task: await snoozeFollowUp(id(req.params.id), { until: data.until }, req.currentUser) });
}));
router.post('/followups/:id/handoff', asyncHandler(async (req, res) => {
  const data = z.object({ user_id: z.number().int().positive(), reason: z.string().max(1000).nullable().optional() }).parse(req.body || {});
  res.json({ task: await handOffFollowUp(id(req.params.id), { toUserId: data.user_id, reason: data.reason }, req.currentUser) });
}));

// ---------------------------------------------------------------- routing and TeleCRM

router.get('/routing/handoffs', routingOnly, asyncHandler(async (req, res) => {
  res.json({ handoffs: await listHandoffs({ status: req.query.status || null }) });
}));

router.post('/routing/handoffs/export', routingOnly, asyncHandler(async (req, res) => {
  const data = z.object({ ids: z.array(z.number().int().positive()).min(1).max(5000), format: z.enum(['CSV', 'XLSX']).default('XLSX') }).parse(req.body);
  const { handoffs } = await withTransaction((client) => markExported(client, data.ids, { actor: req.currentUser, format: data.format }));
  const rows = (await listHandoffs({ limit: 5000 })).filter((h) => handoffs.some((x) => x.id === h.id));
  await sendTable(res, { filename: `telecrm-handoff-${new Date().toISOString().slice(0, 10)}`, format: data.format, sheet: 'For TeleCRM', header: HANDOFF_HEADER, rows: rows.map(handoffRow) });
}));

router.post('/routing/handoffs/:id/confirm', routingOnly, asyncHandler(async (req, res) => {
  const data = z.object({ external_id: z.string().max(200).nullable().optional(), note: z.string().max(2000).nullable().optional(),
    failed: z.boolean().optional(), error: z.string().max(2000).nullable().optional() }).parse(req.body || {});
  await withTransaction((client) => confirmHandoff(client, id(req.params.id), { actor: req.currentUser, externalId: data.external_id, note: data.note, failed: data.failed, error: data.error }));
  res.json({ ok: true });
}));

router.get('/routing/remediation', routingOnly, asyncHandler(async (req, res) => {
  res.json({ organizations: await remediationQueue() });
}));

router.post('/routing/accounts/classify', routingOnly, asyncHandler(async (req, res) => {
  const data = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(1000),
    category: z.enum(LEAD_CATEGORIES).optional(),
    use_suggestion: z.boolean().optional(),
    reason: z.string().max(2000).nullable().optional(),
  }).parse(req.body);
  if (!data.category && !data.use_suggestion) throw badRequest('Choose a category, or confirm the suggestions');
  const done = [];
  const refused = [];
  for (const accountId of data.ids) {
    try {
      await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT suggested_category FROM accounts WHERE id = $1', [accountId]);
        const category = data.category || rows[0]?.suggested_category;
        if (!category) throw badRequest('No suggestion to confirm');
        await classifyAccount(client, accountId, { category, actor: req.currentUser, reason: data.reason || (data.use_suggestion ? 'Confirmed the suggested category' : null), source: 'REMEDIATION' });
      });
      done.push(accountId);
    } catch (err) {
      refused.push({ id: accountId, error: err.message });
    }
  }
  res.json({ done, refused });
}));

router.post('/routing/leads/:id/route', routingOnly, asyncHandler(async (req, res) => {
  const leadId = id(req.params.id);
  const data = z.object({ category: z.enum(LEAD_CATEGORIES), reason: z.string().max(2000).nullable().optional() }).parse(req.body);
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE', [leadId]);
    if (!rows[0]) throw notFound('Lead not found');
    await routeLead(client, rows[0], { category: data.category, actor: req.currentUser, channel: 'REVIEW', reason: data.reason });
    if (isEligible(data.category)) await autoAssignLead(client, leadId, { actor: req.currentUser });
  });
  res.json({ lead: await getLead(leadId) });
}));

// ---------------------------------------------------------------- merging

router.get('/merge/preview', requirePermission('crm.merge'), asyncHandler(async (req, res) => {
  const entity = String(req.query.entity || '').toUpperCase();
  const scope = await crmScope(req.currentUser);
  const kind = { ACCOUNT: 'account', LEAD: 'lead' }[entity];
  if (kind) for (const x of [req.query.survivor, req.query.merged]) if (!(await canSee(scope, kind, id(x)))) throw notFound();
  res.json(await previewMerge(entity, id(req.query.survivor), id(req.query.merged)));
}));

router.post('/merge', requirePermission('crm.merge'), asyncHandler(async (req, res) => {
  const data = z.object({
    entity: z.enum(['ACCOUNT', 'CONTACT', 'LEAD']), survivor_id: z.number().int().positive(), merged_id: z.number().int().positive(),
    choices: z.record(z.enum(['survivor', 'merged'])).default({}), reason: z.string().max(2000).nullable().optional(),
  }).parse(req.body);
  const scope = await crmScope(req.currentUser);
  const kind = { ACCOUNT: 'account', LEAD: 'lead' }[data.entity];
  if (kind) for (const x of [data.survivor_id, data.merged_id]) if (!(await canSee(scope, kind, x))) throw notFound();
  res.json(await mergeRecords(data.entity, data.survivor_id, data.merged_id, { choices: data.choices, actor: req.currentUser, reason: data.reason }));
}));

// ---------------------------------------------------------------- watchers

router.post('/watchers', asyncHandler(async (req, res) => {
  const data = z.object({ entity_type: z.enum(['LEAD', 'ACCOUNT', 'OPPORTUNITY']), entity_id: z.number().int().positive(),
    user_id: z.number().int().positive().optional() }).parse(req.body);
  const userId = data.user_id || req.currentUser.id;
  if (userId !== req.currentUser.id && !hasPermission(req.currentUser, 'crm.assign')) throw forbidden('Adding someone else as a watcher needs the assign permission');
  const scope = await crmScope(req.currentUser);
  if (!(await canSee(scope, data.entity_type.toLowerCase(), data.entity_id))) throw notFound();
  await query(`INSERT INTO crm_watchers (entity_type, entity_id, user_id, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [data.entity_type, data.entity_id, userId, req.currentUser.id]);
  res.status(201).json({ ok: true });
}));
router.delete('/watchers/:type/:entityId/:userId', asyncHandler(async (req, res) => {
  const userId = id(req.params.userId);
  if (userId !== req.currentUser.id && !hasPermission(req.currentUser, 'crm.assign')) throw forbidden();
  await query('DELETE FROM crm_watchers WHERE entity_type = $1 AND entity_id = $2 AND user_id = $3', [String(req.params.type).toUpperCase(), id(req.params.entityId), userId]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- settings: sources, campaigns, capture, assignment, scoring

router.put('/settings', settingsOnly, asyncHandler(async (req, res) => {
  const data = z.object({
    visibility: z.object({ agents: z.enum(['OWN', 'TEAM', 'ALL']).optional(), enforced: z.boolean().optional() }).optional(),
    routing: z.object({ legacyUnclassified: z.enum(['INCLUDE', 'EXCLUDE']).optional(), excludedDestination: z.enum(['TASKFLOW', 'TELECRM', 'TRIAGE']).optional() }).optional(),
    calling: z.object({ lostReasons: z.array(z.string().trim().min(2).max(120)).max(40).optional(), newLeadsFirst: z.boolean().optional() }).optional(),
    calendar: z.object({
      timezone: z.string().max(60).optional(), currency: z.string().length(3).optional(), fyStartMonth: z.number().int().min(1).max(12).optional(),
      workingDays: z.array(z.number().int().min(1).max(7)).min(1).optional(), workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      workEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(), useAttendanceHolidays: z.boolean().optional(), confirmed: z.boolean().optional(),
    }).optional(),
    followUps: z.object({ firstResponseHours: z.number().min(0).max(240).optional(), overdueEscalateHours: z.number().min(1).max(720).optional(),
      staleLeadDays: z.number().int().min(1).max(365).optional(), staleOpportunityDays: z.number().int().min(1).max(365).optional(),
      departmentId: z.number().int().positive().nullable().optional() }).optional(),
    assignment: z.object({ enabled: z.boolean().optional(), fallbackUserId: z.number().int().positive().nullable().optional(), keepAccountOwner: z.boolean().optional() }).optional(),
    required: z.object({ lead: z.record(z.array(z.string())).optional() }).optional(),
    automation: z.object({ liveSends: z.boolean().optional(), maxDepth: z.number().int().min(1).max(5).optional() }).optional(),
    calls: z.object({ provider: z.enum(['none', 'exotel', 'webhook']).optional(), recordings: z.boolean().optional(), recordingRetentionDays: z.number().int().min(1).max(3650).optional() }).optional(),
    whatsapp: z.object({ enabled: z.boolean().optional(), messageRetentionDays: z.number().int().min(1).max(3650).nullable().optional() }).optional(),
    quotes: z.object({
      validityDays: z.number().int().min(1).max(365).optional(), terms: z.string().max(5000).optional(), brand: z.string().max(80).optional(),
      legalName: z.string().max(200).optional(), address: z.string().max(500).optional(), email: z.string().max(200).optional(),
      phone: z.string().max(60).optional(), website: z.string().max(200).optional(), taxId: z.string().max(40).optional(), taxIdLabel: z.string().max(20).optional(),
    }).optional(),
  }).parse(req.body || {});
  if (data.automation?.liveSends && !hasPermission(req.currentUser, 'crm.automation')) throw forbidden('Switching on live automation sends needs the automation permission');
  const all = await getSettings();
  const current = all.crm || {};
  const before = current.sales || {};
  const merged = { ...before };
  for (const [k, v] of Object.entries(data)) merged[k] = typeof v === 'object' && !Array.isArray(v) ? { ...(before[k] || {}), ...v } : v;
  await updateSetting('crm', { ...current, sales: merged }, req.currentUser.id);
  rememberRouting(merged);
  await recordAuditEvent(null, { action: 'CRM_SETTINGS_CHANGED', entityType: 'SETTINGS', actorId: req.currentUser.id, summary: `Sales CRM settings: ${Object.keys(data).join(', ')}`, detail: { before: Object.fromEntries(Object.keys(data).map((k) => [k, before[k]])), after: data } });
  res.json({ settings: merged });
}));

router.post('/sources', settingsOnly, asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().min(2).max(120), channel: z.string().max(40).default('OTHER') }).parse(req.body);
  const key = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const { rows } = await query(`INSERT INTO crm_sources (key, name, channel, position) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(position),0)+1 FROM crm_sources)) RETURNING *`, [key, data.name, data.channel]);
  res.status(201).json({ source: rows[0] });
}));
router.patch('/sources/:id', settingsOnly, asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().min(2).max(120).optional(), channel: z.string().max(40).optional(), is_active: z.boolean().optional() }).parse(req.body);
  const { rows } = await query(`UPDATE crm_sources SET name = COALESCE($2,name), channel = COALESCE($3,channel), is_active = COALESCE($4,is_active) WHERE id = $1 RETURNING *`,
    [id(req.params.id), data.name ?? null, data.channel ?? null, data.is_active ?? null]);
  if (!rows[0]) throw notFound();
  res.json({ source: rows[0] });
}));

const campaignInput = z.object({
  name: z.string().min(2).max(160), channel: z.string().max(60).nullable().optional(), source_id: z.number().int().positive().nullable().optional(),
  utm_campaign: z.string().max(160).nullable().optional(), starts_on: z.string().nullable().optional(), ends_on: z.string().nullable().optional(),
  spend: z.number().min(0).nullable().optional(), spend_currency: z.string().length(3).optional(), status: z.enum(['PLANNED', 'ACTIVE', 'ENDED']).optional(),
  notes: z.string().max(5000).nullable().optional(),
});
router.post('/campaigns', requirePermission('crm.settings'), asyncHandler(async (req, res) => {
  const data = campaignInput.parse(req.body);
  const key = `${data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}-${Date.now().toString(36)}`;
  const { rows } = await query(
    `INSERT INTO crm_campaigns (key, name, channel, source_id, utm_campaign, starts_on, ends_on, spend, spend_currency, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'INR'),COALESCE($10,'ACTIVE'),$11,$12) RETURNING *`,
    [key, data.name, data.channel ?? null, data.source_id ?? null, data.utm_campaign ?? null, data.starts_on || null, data.ends_on || null,
      data.spend ?? null, data.spend_currency ?? null, data.status ?? null, data.notes ?? null, req.currentUser.id],
  );
  res.status(201).json({ campaign: rows[0] });
}));
router.patch('/campaigns/:id', requirePermission('crm.settings'), asyncHandler(async (req, res) => {
  const data = campaignInput.partial().parse(req.body);
  const cols = Object.keys(data);
  if (!cols.length) throw badRequest('Nothing to change');
  const params = [id(req.params.id)];
  const sets = cols.map((c) => { params.push(data[c] === '' ? null : data[c]); return `${c} = $${params.length}`; });
  const { rows } = await query(`UPDATE crm_campaigns SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  if (!rows[0]) throw notFound();
  res.json({ campaign: rows[0] });
}));

router.get('/capture/keys', settingsOnly, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT k.id, k.name, k.prefix, k.entry_channel, k.is_active, k.last_used_at, k.created_at, k.revoked_at, s.name AS source_name, c.name AS campaign_name
       FROM crm_capture_keys k LEFT JOIN crm_sources s ON s.id = k.source_id LEFT JOIN crm_campaigns c ON c.id = k.campaign_id ORDER BY k.created_at DESC`,
  );
  res.json({ keys: rows });
}));
router.post('/capture/keys', settingsOnly, asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().min(2).max(120), source_id: z.number().int().positive().nullable().optional(),
    campaign_id: z.number().int().positive().nullable().optional(), entry_channel: z.enum(['API', 'WEBHOOK']).default('API') }).parse(req.body);
  const key = await createCaptureKey(data, req.currentUser);
  await recordAuditEvent(null, { action: 'CAPTURE_KEY_CREATED', entityType: 'CAPTURE_KEY', entityId: key.id, actorId: req.currentUser.id, summary: `${key.name} (${key.prefix}…)` });
  res.status(201).json({ key });
}));
router.post('/capture/keys/:id/revoke', settingsOnly, asyncHandler(async (req, res) => {
  await query('UPDATE crm_capture_keys SET is_active = FALSE, revoked_at = now(), revoked_by = $2 WHERE id = $1', [id(req.params.id), req.currentUser.id]);
  await recordAuditEvent(null, { action: 'CAPTURE_KEY_REVOKED', entityType: 'CAPTURE_KEY', entityId: id(req.params.id), actorId: req.currentUser.id });
  res.json({ ok: true });
}));

router.get('/capture/forms', settingsOnly, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM crm_capture_forms ORDER BY created_at DESC');
  res.json({ forms: rows });
}));
const formInput = z.object({
  name: z.string().min(2).max(120), title: z.string().min(2).max(200), intro: z.string().max(2000).nullable().optional(),
  source_id: z.number().int().positive().nullable().optional(), campaign_id: z.number().int().positive().nullable().optional(),
  consent_text: z.string().max(2000).nullable().optional(), success_message: z.string().max(1000).nullable().optional(),
  fields: z.array(z.enum(['designation', 'website', 'city', 'state', 'requirement'])).optional(), is_active: z.boolean().optional(),
});
router.post('/capture/forms', settingsOnly, asyncHandler(async (req, res) => {
  const data = formInput.parse(req.body);
  const { rows } = await query(
    `INSERT INTO crm_capture_forms (public_id, name, title, intro, fields, source_id, campaign_id, consent_text, success_message, created_by)
     VALUES (encode(gen_random_bytes(9), 'hex'),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [data.name, data.title, data.intro ?? null, JSON.stringify(data.fields || ['designation', 'city', 'state', 'requirement']), data.source_id ?? null,
      data.campaign_id ?? null, data.consent_text ?? null, data.success_message ?? null, req.currentUser.id],
  ).catch(async (err) => {
    // pgcrypto may not be installed: fall back to a random id made here
    if (!/gen_random_bytes/.test(err.message)) throw err;
    const { randomBytes } = await import('node:crypto');
    return query(
      `INSERT INTO crm_capture_forms (public_id, name, title, intro, fields, source_id, campaign_id, consent_text, success_message, created_by)
       VALUES ($10,$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [data.name, data.title, data.intro ?? null, JSON.stringify(data.fields || ['designation', 'city', 'state', 'requirement']), data.source_id ?? null,
        data.campaign_id ?? null, data.consent_text ?? null, data.success_message ?? null, req.currentUser.id, randomBytes(9).toString('hex')],
    );
  });
  res.status(201).json({ form: rows[0] });
}));
router.patch('/capture/forms/:id', settingsOnly, asyncHandler(async (req, res) => {
  const data = formInput.partial().parse(req.body);
  const cols = Object.keys(data);
  if (!cols.length) throw badRequest('Nothing to change');
  const params = [id(req.params.id)];
  const sets = cols.map((c) => { params.push(c === 'fields' ? JSON.stringify(data[c]) : data[c]); return `${c} = $${params.length}`; });
  const { rows } = await query(`UPDATE crm_capture_forms SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  res.json({ form: rows[0] });
}));

const ruleInput = z.object({
  name: z.string().min(2).max(160), description: z.string().max(2000).nullable().optional(), priority: z.number().int().min(0).max(100000).optional(),
  is_enabled: z.boolean().optional(),
  conditions: z.object({ categories: z.array(z.enum(KNOWN_CATEGORIES)).optional(), source_ids: z.array(z.number().int()).optional(),
    campaign_ids: z.array(z.number().int()).optional(), states: z.array(z.string().max(80)).optional(), tags: z.array(z.string().max(40)).optional(),
    min_score: z.number().min(0).max(100).nullable().optional(), priority: z.array(z.enum(PRIORITIES)).optional() }).default({}),
  strategy: z.enum(STRATEGIES).default('ROUND_ROBIN'), user_ids: z.array(z.number().int().positive()).default([]),
  department_id: z.number().int().positive().nullable().optional(), respect_capacity: z.boolean().optional(), skip_unavailable: z.boolean().optional(),
});
router.get('/assignment/rules', asyncHandler(async (req, res) => {
  if (!hasPermission(req.currentUser, 'crm.assign') && !hasPermission(req.currentUser, 'crm.settings')) throw forbidden();
  const [rules, profiles] = await Promise.all([
    query('SELECT r.*, c.last_user_id, c.assigned FROM crm_assignment_rules r LEFT JOIN crm_assignment_cursor c ON c.rule_id = r.id ORDER BY r.priority, r.id'),
    query(`SELECT u.id AS user_id, u.full_name, u.department_id, u.is_active, p.accepts_new_leads, p.max_open_leads, p.categories, p.states, p.specializations,
                  (SELECT COUNT(*)::int FROM crm_leads l WHERE l.owner_user_id = u.id AND l.is_archived = FALSE AND l.destination = 'TASKFLOW'
                     AND l.status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED')) AS open_leads
             FROM users u LEFT JOIN crm_agent_profiles p ON p.user_id = u.id WHERE u.role <> 'viewer' ORDER BY u.full_name`),
  ]);
  res.json({ rules: rules.rows, agents: profiles.rows });
}));
router.post('/assignment/rules', settingsOnly, asyncHandler(async (req, res) => {
  const d = ruleInput.parse(req.body);
  const { rows } = await query(
    `INSERT INTO crm_assignment_rules (name, description, priority, is_enabled, conditions, strategy, user_ids, department_id, respect_capacity, skip_unavailable, created_by, updated_by)
     VALUES ($1,$2,COALESCE($3,(SELECT COALESCE(MAX(priority),0)+10 FROM crm_assignment_rules)),COALESCE($4,TRUE),$5,$6,$7,$8,COALESCE($9,TRUE),COALESCE($10,TRUE),$11,$11) RETURNING *`,
    [d.name, d.description ?? null, d.priority ?? null, d.is_enabled ?? null, d.conditions, d.strategy, d.user_ids, d.department_id ?? null,
      d.respect_capacity ?? null, d.skip_unavailable ?? null, req.currentUser.id],
  );
  await recordAuditEvent(null, { action: 'ASSIGNMENT_RULE_CREATED', entityType: 'ASSIGNMENT_RULE', entityId: rows[0].id, actorId: req.currentUser.id, summary: d.name, detail: d });
  res.status(201).json({ rule: rows[0] });
}));
router.patch('/assignment/rules/:id', settingsOnly, asyncHandler(async (req, res) => {
  const d = ruleInput.partial().parse(req.body);
  const cols = Object.keys(d);
  if (!cols.length) throw badRequest('Nothing to change');
  const params = [id(req.params.id)];
  const sets = cols.map((c) => { params.push(d[c]); return `${c} = $${params.length}`; });
  params.push(req.currentUser.id);
  const { rows } = await query(`UPDATE crm_assignment_rules SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  if (!rows[0]) throw notFound();
  await recordAuditEvent(null, { action: 'ASSIGNMENT_RULE_CHANGED', entityType: 'ASSIGNMENT_RULE', entityId: rows[0].id, actorId: req.currentUser.id, summary: rows[0].name, detail: d });
  res.json({ rule: rows[0] });
}));
router.put('/assignment/agents/:userId', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({ accepts_new_leads: z.boolean().optional(), max_open_leads: z.number().int().positive().nullable().optional(),
    categories: z.array(z.enum(KNOWN_CATEGORIES)).optional(), states: z.array(z.string().max(80)).optional(),
    specializations: z.array(z.string().max(60)).optional() }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO crm_agent_profiles (user_id, accepts_new_leads, max_open_leads, categories, states, specializations, updated_by)
     VALUES ($1, COALESCE($2,TRUE), $3, COALESCE($4::text[],'{}'), COALESCE($5::text[],'{}'), COALESCE($6::text[],'{}'), $7)
     ON CONFLICT (user_id) DO UPDATE SET accepts_new_leads = COALESCE($2, crm_agent_profiles.accepts_new_leads),
       max_open_leads = CASE WHEN $8 THEN $3 ELSE crm_agent_profiles.max_open_leads END,
       categories = COALESCE($4::text[], crm_agent_profiles.categories), states = COALESCE($5::text[], crm_agent_profiles.states),
       specializations = COALESCE($6::text[], crm_agent_profiles.specializations), updated_by = $7, updated_at = now()
     RETURNING *`,
    [id(req.params.userId), d.accepts_new_leads ?? null, d.max_open_leads ?? null, d.categories ?? null, d.states ?? null, d.specializations ?? null,
      req.currentUser.id, d.max_open_leads !== undefined],
  );
  res.json({ agent: rows[0] });
}));
router.post('/assignment/reassign-all', requirePermission('crm.assign'), asyncHandler(async (req, res) => {
  const d = z.object({ from_user_id: z.number().int().positive(), to_user_id: z.number().int().positive(), reason: z.string().min(3).max(2000) }).parse(req.body);
  const { reassignAllFrom } = await import('../services/sales/assignment.js');
  const n = await withTransaction((client) => reassignAllFrom(client, d.from_user_id, d.to_user_id, { actor: req.currentUser, reason: d.reason }));
  res.json({ moved: n });
}));

router.get('/scoring', asyncHandler(async (req, res) => {
  res.json({ models: Object.values(await scoringModels({ fresh: true })), criteria: Object.entries(CRITERIA).map(([key, c]) => ({ key, label: c.label })) });
}));
router.put('/scoring/:category', settingsOnly, asyncHandler(async (req, res) => {
  const category = String(req.params.category).toUpperCase();
  if (!KNOWN_CATEGORIES.includes(category)) throw notFound();
  const d = z.object({ is_enabled: z.boolean().optional(),
    criteria: z.array(z.object({ key: z.enum(Object.keys(CRITERIA)), label: z.string().max(120).optional(), weight: z.number().min(0).max(100) })).optional() }).parse(req.body);
  const { rows } = await query(
    `UPDATE crm_scoring_models SET is_enabled = COALESCE($2, is_enabled), criteria = COALESCE($3, criteria), updated_by = $4, updated_at = now()
      WHERE category = $1 RETURNING *`,
    [category, d.is_enabled ?? null, d.criteria ? JSON.stringify(d.criteria) : null, req.currentUser.id],
  );
  forgetScoringModels();
  // every open lead in the category is rescored so the list reflects the new weights
  const { rows: open } = await query(`SELECT id FROM crm_leads WHERE category = $1 AND status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED') AND is_archived = FALSE`, [category]);
  const { refreshScore } = await import('../services/sales/scoring.js');
  await withTransaction(async (client) => { for (const r of open) await refreshScore(client, r.id); });
  await recordAuditEvent(null, { action: 'SCORING_CHANGED', entityType: 'SCORING', actorId: req.currentUser.id, summary: `${category} scoring`, detail: d });
  res.json({ model: rows[0], rescored: open.length });
}));

router.get('/handoffs.csv', routingOnly, asyncHandler(async (req, res) => {
  const rows = await listHandoffs({ status: req.query.status || null, limit: 5000 });
  sendCsv(res, 'telecrm-handoffs.csv', HANDOFF_HEADER, rows.map(handoffRow));
}));

export default router;
export { visibleLead, canWorkLead };
void express;
