/**
 * My workspace: the caller's own layout, home choice and widget data, and
 * (with settings.manage) the templates and the rollout.
 *
 * Every personal route is keyed by the signed-in caller: there is no user id
 * to pass, so nobody can read or change another person's layout, snoozes or
 * reminders through it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, forbidden } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../lib/permissions.js';
import { getSettings, updateSetting } from '../services/settings.js';
import {
  ROLLOUT_MODES, REMINDER_MODES, listTemplates, resetLayout, saveLayout, saveTemplate, setHome,
  templateFor, templateUsage, whoIs, workspaceFor, workspaceSettings, catalogueFor,
} from '../services/workspace/layout.js';
import { query } from '../db/pool.js';
import { analyse } from '../services/okrInsights.js';
import { VIEWS, attentionFor, snoozeItem, unsnoozeItem } from '../services/workspace/attention.js';
import { decisionsFor } from '../services/workspace/decisions.js';
import { waitingFor } from '../services/workspace/waiting.js';
import { listOpportunities } from '../services/opportunities.js';
import { crmScope } from '../services/sales/core.js';
import { RULES, cancelMine, effectivePref, occurrencesFor, replanMine, replanRecord, rulePrefs } from '../services/workspace/reminders.js';
import { addPersonalReminder, cancelPersonalReminder, changePersonalReminder, myPersonalReminders } from '../services/workspace/personal.js';
import { ENTITY_TYPES } from '../services/workspace/access.js';
import '../services/workspace/rules.js';
import { chatRoute, reminderSettings } from '../services/taskReminders.js';
import { widgetAccess } from '../../../shared/workspaceWidgets.js';

const router = Router();

const widget = z.object({
  id: z.string().max(40).optional(),
  type: z.string().min(1).max(40),
  typeVersion: z.number().int().optional(),
  width: z.enum(['full', 'half']).optional(),
  config: z.record(z.any()).optional(),
});

router.get('/', asyncHandler(async (req, res) => {
  res.json(await workspaceFor(req.currentUser));
}));

router.put('/layout', asyncHandler(async (req, res) => {
  const body = z.object({
    version: z.number().int().min(0),
    widgets: z.array(widget).max(30),
    force: z.boolean().optional(),
  }).parse(req.body || {});
  res.json(await saveLayout(req.currentUser, body));
}));

router.post('/layout/reset', asyncHandler(async (req, res) => {
  res.json(await resetLayout(req.currentUser));
}));

router.put('/home', asyncHandler(async (req, res) => {
  const { home } = z.object({ home: z.enum(['WORKSPACE', 'OVERVIEW']).nullable() }).parse(req.body || {});
  res.json({ home: await setHome(req.currentUser, home), home_choice: home });
}));

// ---------------------------------------------------------------- widget data the modules do not already serve

/** Guards one widget's data with the same rule the catalogue uses. */
async function mustUse(req, type) {
  const who = await whoIs(req.currentUser);
  const access = widgetAccess(type, who);
  if (!access.ok) throw forbidden(access.why);
  return who;
}

/** My key results that need a check-in or are behind, from the OKR attention engine. */
router.get('/widgets/key_results', asyncHandler(async (req, res) => {
  await mustUse(req, 'key_results');
  const { attention } = await analyse({});
  const mine = attention.filter((s) => s.entity_type === 'KEY_RESULT' && s.owner_user_id === req.currentUser.id);
  res.json({
    total: mine.length,
    items: mine.map((s) => ({
      key_result_id: s.key_result_id, objective_id: s.objective_id, title: s.title, objective_title: s.objective_title,
      kind: s.kind, severity: s.severity, detail: s.detail, days: s.days, url: `/goals/${s.objective_id}`,
    })),
  });
}));

// ---------------------------------------------------------------- attention, decisions, waiting

const page = (list, req) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { items: list.slice(offset, offset + limit), limit, offset };
};

router.get('/attention', asyncHandler(async (req, res) => {
  const view = Object.keys(VIEWS).includes(req.query.view) ? req.query.view : 'all';
  const data = await attentionFor(req.currentUser, { view, includeSnoozed: req.query.snoozed === '1' });
  res.json({ ...data, ...page(data.items, req), view });
}));

const snoozeBody = z.object({ key: z.string().min(3).max(200), until: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Choose when to bring it back') });
router.post('/attention/snooze', asyncHandler(async (req, res) => {
  const { key, until } = snoozeBody.parse(req.body || {});
  const at = new Date(until);
  if (at <= new Date()) throw badRequest('Choose a time in the future');
  if (at > new Date(Date.now() + 90 * 86_400_000)) throw badRequest('Snooze for at most 90 days');
  // only an item that is in the person's own queue can be snoozed
  const { items } = await attentionFor(req.currentUser, { includeSnoozed: true });
  const it = items.find((x) => x.key === key);
  if (!it) throw badRequest('That item is not in your list any more');
  await snoozeItem(req.currentUser, key, at);
  res.json({ ok: true, key, until: at, note: 'Only your list changes. The record, its dates and its owner stay as they are.' });
}));

router.post('/attention/unsnooze', asyncHandler(async (req, res) => {
  const { key } = z.object({ key: z.string().min(3).max(200) }).parse(req.body || {});
  await unsnoozeItem(req.currentUser, key);
  res.json({ ok: true });
}));

router.get('/decisions', asyncHandler(async (req, res) => {
  const list = await decisionsFor(req.currentUser);
  res.json({ total: list.length, ...page(list, req) });
}));

router.get('/waiting', asyncHandler(async (req, res) => {
  const data = await waitingFor(req.currentUser);
  res.json({ ...data, ...page(data.items, req) });
}));

/** The summary tiles: each count is the length of the list it opens. */
router.get('/widgets/summary', asyncHandler(async (req, res) => {
  const [att, waiting] = await Promise.all([attentionFor(req.currentUser), waitingFor(req.currentUser)]);
  res.json({
    tiles: [
      { key: 'attention', label: 'Needs attention', count: att.counts.all, url: '/workspace/attention?view=all' },
      { key: 'overdue', label: 'Overdue', count: att.counts.overdue, url: '/workspace/attention?view=overdue', tone: 'critical' },
      { key: 'due_today', label: 'Due today', count: att.counts.due_today, url: '/workspace/attention?view=due_today', tone: 'warning' },
      { key: 'waiting', label: 'Waiting on others', count: waiting.total, url: '/workspace/waiting' },
      { key: 'decisions', label: 'Decisions', count: att.counts.decisions, url: '/workspace/attention?view=decisions' },
    ],
    snoozed: att.snoozed,
  });
}));

/**
 * My deals (or my team's, for people whose CRM access shows team records),
 * outside the applications pipeline: stage, next action and date, waiting,
 * last update from the customer. "No next action" and "Overdue" are separate.
 */
router.get('/widgets/deals', asyncHandler(async (req, res) => {
  const who = await mustUse(req, 'deals');
  const team = req.query.scope === 'team';
  if (team && !who.teamScope.crm) throw forbidden('My team is not available to you here');
  const scope = await crmScope(req.currentUser);
  const deals = await listOpportunities({
    ...(team ? { departmentId: req.currentUser.department_id || -1 } : { ownerId: req.currentUser.id }),
    statuses: ['ACTIVE', 'ON_HOLD', 'NURTURE'], scope, limit: 1000,
  });
  const { rows: apps } = await query(`SELECT id FROM crm_pipelines WHERE category = 'APPLICATIONS'`);
  const appIds = new Set(apps.map((r) => r.id));
  const list = deals.filter((d) => !appIds.has(d.pipeline_id) && d.stage_kind === 'open').map((d) => ({
    id: d.id, name: d.name, account_id: d.account_id, account_name: d.account_name, owner_name: d.owner_name,
    stage_name: d.stage_name, status: d.status, next_step: d.next_step, next_step_due: d.next_step_due,
    waiting_on: d.waiting_on, waiting_until: d.waiting_until, revisit_on: d.revisit_on,
    last_customer_at: d.last_customer_at, last_external_at: d.last_external_at,
    no_next_action: d.status === 'ACTIVE' && !d.next_step && !d.waiting_on,
    overdue: Boolean(d.next_step_overdue),
    url: `/accounts/${d.account_id}?deal=${d.id}`,
  }));
  list.sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.no_next_action) - Number(a.no_next_action)
    || String(a.next_step_due || '9999').localeCompare(String(b.next_step_due || '9999')));
  res.json({
    total: list.length,
    counts: { no_next_action: list.filter((d) => d.no_next_action).length, overdue: list.filter((d) => d.overdue).length },
    scope: team ? 'team' : 'mine',
    ...page(list, req),
  });
}));

// ---------------------------------------------------------------- my reminders (private to the caller)

/**
 * Every reminder rule that can reach the caller, old and new: the workspace
 * rules (with their default, the caller's choice, channels and time) and the
 * engines that already existed (task reminders, daily summary, CRM
 * follow-ups, goal alerts), which keep their own settings.
 */
router.get('/reminders', asyncHandler(async (req, res) => {
  const user = req.currentUser;
  const [settings, prefs, ts, route, ws] = await Promise.all([
    getSettings(), rulePrefs([user.id]), reminderSettings(), chatRoute(user.id), workspaceSettings(),
  ]);
  const mine = prefs.get(user.id) || {};
  const crm = settings.crm?.enabled !== false && hasPermission(user, 'crm.view');
  const rules = Object.entries(RULES).filter(([, r]) => r.entity !== 'DEAL' && r.entity !== 'APPLICATION' ? true : crm).map(([key, r]) => {
    const p = effectivePref(mine, key);
    return {
      key, group: r.group, label: r.label, description: r.description, opt_in: Boolean(r.optIn), personal: Boolean(r.personal),
      default: { enabled: r.defaults.enabled, at: r.defaults.at }, enabled: p.enabled, at: p.at, chat: p.chat, chosen: p.chosen, relative: Boolean(r.relative),
    };
  });
  const { rows: chatPref } = await query('SELECT instant, morning_summary FROM chat_preferences WHERE user_id = $1', [user.id]);
  const { rows: crmPref } = await query('SELECT offsets, channels FROM crm_reminder_prefs WHERE user_id = $1', [user.id]);
  const existing = [
    { key: 'TASK_REMINDERS', label: 'Task deadlines', description: `Before a task's deadline (${ts.beforeDueHours} h), at the deadline, and to your fallback person after the grace period.`, choice: ts.mode === 'LIVE' ? 'On for everyone' : ts.mode === 'TEST' ? 'In test mode' : 'Off', manage: '/settings?tab=account' },
    { key: 'DAILY_SUMMARY', label: 'Morning summary', description: 'Your open work each working morning, in Google Chat.', choice: chatPref[0]?.morning_summary === false ? 'Off' : 'On', manage: '/settings?tab=account' },
    ...(crm ? [{ key: 'CRM_FOLLOWUPS', label: 'CRM follow-ups', description: 'Before a follow-up is due, and the daily follow-up digest.', choice: crmPref[0] ? `${crmPref[0].offsets.join(', ')} min before · ${crmPref[0].channels.map((c) => (c === 'CHAT' ? 'Google Chat' : 'in-app')).join(' and ')}` : '15 min before · in-app', manage: '/settings?tab=account' }] : []),
    ...(settings.okr?.enabled !== false && hasPermission(user, 'okr.view') ? [{ key: 'OKR_ALERTS', label: 'Goal and key result alerts', description: 'When one of your key results goes quiet or falls behind.', choice: 'As set for the company', manage: '/goals' }] : []),
  ];
  res.json({
    rules, existing,
    personal: await myPersonalReminders(user),
    channels: { app: true, chat: route.ok, chat_why: route.ok ? null : route.why, email: false, push: false },
    mode: ws.reminderMode,
    timezone: user.timezone || ws.timezone, timezone_is_personal: Boolean(user.timezone), company_timezone: ws.timezone,
  });
}));

router.put('/reminders/rules/:key', asyncHandler(async (req, res) => {
  const key = req.params.key;
  const rule = RULES[key];
  if (!rule || rule.personal) throw badRequest('There is no such rule to change');
  const body = z.object({
    enabled: z.boolean(),
    at_time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use HH:MM').nullable().optional(),
    chat: z.boolean().nullable().optional(),
  }).parse(req.body || {});
  if (body.at_time && rule.relative) throw badRequest('This reminder is set relative to the meeting, not to a time of day');
  await query(
    `INSERT INTO reminder_rule_prefs (user_id, rule_key, enabled, at_time, chat) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, rule_key) DO UPDATE SET enabled = EXCLUDED.enabled, at_time = EXCLUDED.at_time, chat = EXCLUDED.chat, updated_at = now()`,
    [req.currentUser.id, key, body.enabled, body.at_time ?? null, body.chat ?? null],
  );
  // off: only my pending reminders of this rule are cancelled. On: planned afresh (at most one current each)
  const cancelled = await cancelMine(req.currentUser.id, key);
  const replanned = await replanMine(req.currentUser.id, key);
  res.json({ ok: true, cancelled, replanned, note: 'Only your own reminders change. The records and everyone else\'s reminders stay as they are.' });
}));

const personalInput = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.number().int().positive(),
  remind_at: z.string().min(10),
  note: z.string().max(500).nullable().optional(),
});
router.get('/reminders/personal', asyncHandler(async (req, res) => {
  const type = ENTITY_TYPES.includes(req.query.entity_type) ? req.query.entity_type : null;
  res.json({ reminders: await myPersonalReminders(req.currentUser, { entityType: type, entityId: type ? Number(req.query.entity_id) || null : null }) });
}));
router.post('/reminders/personal', asyncHandler(async (req, res) => {
  res.status(201).json({ reminder: await addPersonalReminder(req.currentUser, personalInput.parse(req.body || {})) });
}));
router.put('/reminders/personal/:id', asyncHandler(async (req, res) => {
  const body = z.object({ remind_at: z.string().min(10), note: z.string().max(500).nullable().optional() }).parse(req.body || {});
  res.json({ reminder: await changePersonalReminder(req.currentUser, Number(req.params.id), body) });
}));
router.post('/reminders/personal/:id/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelPersonalReminder(req.currentUser, Number(req.params.id)));
}));

router.get('/reminders/log', asyncHandler(async (req, res) => {
  res.json({ occurrences: await occurrencesFor(req.currentUser.id, { days: Math.min(60, Math.max(1, Number(req.query.days) || 14)) }) });
}));

/** D4: an optional personal timezone; empty means the company calendar's. */
router.get('/timezones', asyncHandler(async (req, res) => {
  res.json({ timezones: Intl.supportedValuesOf('timeZone'), company: (await workspaceSettings()).timezone });
}));
router.put('/me/timezone', asyncHandler(async (req, res) => {
  const { timezone } = z.object({ timezone: z.string().max(64).nullable() }).parse(req.body || {});
  if (timezone && !Intl.supportedValuesOf('timeZone').includes(timezone)) throw badRequest('Choose a timezone from the list');
  await query('UPDATE users SET timezone = $2 WHERE id = $1', [req.currentUser.id, timezone || null]);
  // dated reminders move to the new local time
  const { rows } = await query(`SELECT DISTINCT entity_type, entity_id FROM reminder_occurrences WHERE recipient_id = $1 AND status = 'PENDING'`, [req.currentUser.id]);
  for (const r of rows) await replanRecord(r.entity_type, r.entity_id);
  res.json({ timezone: timezone || null, replanned: rows.length });
}));

// ---------------------------------------------------------------- templates and rollout (settings.manage)

router.get('/templates', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const [templates, usage, who] = await Promise.all([listTemplates(), templateUsage(), whoIs(req.currentUser)]);
  res.json({ templates, usage, catalogue: catalogueFor({ ...who, can: () => true, modules: {}, tracksDay: true, teamScope: { tasks: true, crm: true } }) });
}));

const templateInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullable().optional(),
  layout: z.object({ widgets: z.array(widget).min(1).max(30) }),
  applies_departments: z.array(z.number().int().positive()).max(100).optional(),
  applies_roles: z.array(z.enum(['super_admin', 'admin', 'manager', 'member', 'viewer'])).max(5).optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

router.put('/templates/:key', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const key = String(req.params.key);
  if (!/^[a-z0-9_-]{2,40}$/.test(key)) throw badRequest('A template key is 2 to 40 lowercase letters, digits, - or _');
  res.json({ template: await saveTemplate(req.currentUser, key, templateInput.parse(req.body || {})) });
}));

router.get('/settings', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  res.json(await workspaceSettings());
}));

router.put('/settings', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const body = z.object({
    rollout: z.object({ mode: z.enum(ROLLOUT_MODES), departmentIds: z.array(z.number().int().positive()).max(100) }).optional(),
    reminderMode: z.enum(REMINDER_MODES).optional(),
  }).parse(req.body || {});
  const current = (await getSettings()).workspace || {};
  const next = { ...current };
  if (body.rollout) next.rollout = body.rollout;
  if (body.reminderMode) {
    next.reminderMode = body.reminderMode;
    // in test mode the administrator who switched it is the one person who receives anything
    if (body.reminderMode === 'TEST') next.testRecipientId = req.currentUser.id;
  }
  await updateSetting('workspace', next, req.currentUser.id);
  res.json(await workspaceSettings());
}));

// people with settings.manage may look at another person's effective template (never their layout)
router.get('/templates/for/:userId', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  if (!hasPermission(req.currentUser, 'user.view')) throw forbidden();
  const { rows } = await query('SELECT id, role, department_id FROM users WHERE id = $1', [Number(req.params.userId)]);
  if (!rows[0]) throw badRequest('No such person');
  const t = await templateFor(rows[0]);
  res.json({ key: t.key, name: t.name, matched: t.matched });
}));

export default router;
