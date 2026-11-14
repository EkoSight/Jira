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
