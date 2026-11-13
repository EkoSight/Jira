import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../lib/permissions.js';
import { canSee, crmScope, scopeCondition } from '../services/sales/core.js';
import { query } from '../db/pool.js';
import { callById, callDetail, callReview, editCall, leadCalls, voidCall } from '../services/sales/callRecords.js';
import { REMINDER_CHANNELS, REMINDER_OFFSETS, acknowledgeReminders, reminderPrefs, remindersFor, saveReminderPrefs } from '../services/sales/followupReminders.js';
import {
  digestExceptions, digestLog, digestSettings, previewDigest, saveDigestSettings, sendTestDigest, setDigestException,
} from '../services/sales/followupDigest.js';
import { WORK_BUCKETS, workQueue } from '../services/sales/workQueue.js';
import {
  acceptSuggestion, districtSuggestions, generateLocationSuggestions, leadSuggestions, listLocationSuggestions, rejectSuggestion,
} from '../services/sales/location.js';
import { canWorkLead, visibleLead } from './sales.js';

/**
 * Calls as records, follow-up reminders, the daily Chat summary, the work
 * queue and lead locations. Everything here is behind crm.view (router.js);
 * changes need the permissions named on each route.
 */
const router = Router();
const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Not a valid id');
  return n;
};
const settingsOnly = requirePermission('crm.settings');

async function visibleCall(req, callId) {
  const call = await callById(callId);
  if (!call) throw notFound('Call not found');
  if (call.lead_id) await visibleLead(req, call.lead_id);
  else {
    const scope = await crmScope(req.currentUser);
    const ok = (call.account_id && await canSee(scope, 'account', call.account_id)) || (call.opportunity_id && await canSee(scope, 'opportunity', call.opportunity_id))
      || call.agent_user_id === req.currentUser.id;
    if (!ok) throw notFound('Call not found');
  }
  return call;
}

// ---------------------------------------------------------------- calls

/** Suspected repeated calls, for a person to review. Read only. */
router.get('/calls/review', requirePermission('crm.audit'), asyncHandler(async (req, res) => {
  const leadIds = String(req.query.lead_id || '').split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const since = req.query.since && /^\d{4}-\d{2}-\d{2}$/.test(req.query.since) ? req.query.since : null;
  res.json(await callReview({ leadIds, since, windowSeconds: Math.min(Math.max(Number(req.query.window) || 120, 5), 3600) }));
}));

router.get('/leads/:id/calls', asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  res.json({ calls: await leadCalls(lead.id) });
}));

router.get('/calls/:id', asyncHandler(async (req, res) => {
  await visibleCall(req, id(req.params.id));
  res.json(await callDetail(id(req.params.id)));
}));

/** Corrects a call's note or length. Never a new call; the earlier wording is kept. */
router.patch('/calls/:id', requirePermission('crm.activity.log'), asyncHandler(async (req, res) => {
  await visibleCall(req, id(req.params.id));
  const d = z.object({
    notes: z.string().max(5000).nullable().optional(), duration_sec: z.number().int().min(0).max(86400).nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
  }).parse(req.body || {});
  res.json(await editCall(id(req.params.id), { notes: d.notes, durationSec: d.duration_sec, reason: d.reason ?? null }, req.currentUser));
}));

/** Marks a call as an accidental repeat after review: kept, shown, not counted. Undoable. */
router.post('/calls/:id/void', asyncHandler(async (req, res) => {
  await visibleCall(req, id(req.params.id));
  const d = z.object({ reason: z.string().min(3).max(500) }).parse(req.body || {});
  res.json(await voidCall(id(req.params.id), { reason: d.reason }, req.currentUser));
}));
router.post('/calls/:id/restore', asyncHandler(async (req, res) => {
  await visibleCall(req, id(req.params.id));
  res.json(await voidCall(id(req.params.id), { reason: req.body?.reason || 'Restored' }, req.currentUser, { restore: true }));
}));

// ---------------------------------------------------------------- reminders

router.get('/reminder-prefs', asyncHandler(async (req, res) => {
  const settings = await digestSettings();
  res.json({ prefs: await reminderPrefs(req.currentUser.id), offsets: REMINDER_OFFSETS, channels: REMINDER_CHANNELS, chat_allowed: settings.chatReminders });
}));
router.put('/reminder-prefs', asyncHandler(async (req, res) => {
  const d = z.object({ offsets: z.array(z.number().int()).max(4), channels: z.array(z.enum(REMINDER_CHANNELS)).max(2) }).parse(req.body || {});
  res.json({ prefs: await saveReminderPrefs(req.currentUser.id, d) });
}));

async function visibleFollowUp(req, taskId) {
  const { rows } = await query('SELECT id, assignee_id, created_by, crm_lead_id, account_id, followup_kind FROM tasks WHERE id = $1', [taskId]);
  const t = rows[0];
  if (!t?.followup_kind) throw notFound('Follow-up not found');
  if (t.crm_lead_id) await visibleLead(req, t.crm_lead_id);
  else if (t.assignee_id !== req.currentUser.id && !(t.account_id && await canSee(await crmScope(req.currentUser), 'account', t.account_id))) throw notFound('Follow-up not found');
  return t;
}

router.get('/followups/:id/reminders', asyncHandler(async (req, res) => {
  await visibleFollowUp(req, id(req.params.id));
  res.json({ reminders: await remindersFor(id(req.params.id)) });
}));
router.post('/followups/:id/acknowledge', asyncHandler(async (req, res) => {
  await visibleFollowUp(req, id(req.params.id));
  res.json({ acknowledged: await acknowledgeReminders(id(req.params.id), req.currentUser.id) });
}));

// ---------------------------------------------------------------- the daily Chat summary

router.get('/followup-digest/settings', settingsOnly, asyncHandler(async (req, res) => {
  res.json({ settings: await digestSettings(), exceptions: await digestExceptions() });
}));
router.put('/followup-digest/settings', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({
    enabled: z.boolean().optional(), testMode: z.boolean().optional(), skipHolidays: z.boolean().optional(), chatReminders: z.boolean().optional(),
    time: z.string().max(5).optional(), lastSendTime: z.string().max(5).optional(), days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  }).parse(req.body || {});
  res.json({ settings: await saveDigestSettings(d, req.currentUser.id) });
}));
/** A preview of anyone's summary for an administrator; anyone may preview their own. */
router.get('/followup-digest/preview', asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? id(req.query.user_id) : req.currentUser.id;
  if (userId !== req.currentUser.id && !hasPermission(req.currentUser, 'crm.settings')) throw forbidden('Previewing someone else\'s summary needs the CRM settings permission');
  res.json(await previewDigest(userId));
}));
/** Sends a person's summary to the administrator's own Chat only, labelled as a test. */
router.post('/followup-digest/test', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({ user_id: z.number().int().positive().optional() }).parse(req.body || {});
  res.json(await sendTestDigest(req.currentUser.id, d.user_id || req.currentUser.id));
}));
router.get('/followup-digest/log', settingsOnly, asyncHandler(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  res.json({ date, log: await digestLog(date) });
}));
router.put('/followup-digest/exceptions/:userId', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({ mode: z.enum(['SKIP', 'INCLUDE']).nullable(), until: z.string().max(10).nullable().optional(), reason: z.string().max(300).nullable().optional() }).parse(req.body || {});
  res.json({ exception: await setDigestException(id(req.params.userId), { mode: d.mode, until: d.until || null, reason: d.reason || null }, req.currentUser.id) });
}));

// ---------------------------------------------------------------- the work queue

router.get('/work-queue', asyncHandler(async (req, res) => {
  const user = req.currentUser;
  const userId = req.query.user_id ? id(req.query.user_id) : user.id;
  if (userId !== user.id && !hasPermission(user, 'crm.assign') && !hasPermission(user, 'crm.view.team') && !hasPermission(user, 'crm.view.all')) {
    throw forbidden('Seeing someone else\'s work needs team access');
  }
  const bucket = WORK_BUCKETS.includes(req.query.bucket) ? req.query.bucket : null;
  res.json(await workQueue(user, { userId, bucket, page: Number(req.query.page) || 1, pageSize: Number(req.query.page_size) || 25 }));
}));

// ---------------------------------------------------------------- location

router.get('/location/districts', asyncHandler(async (req, res) => {
  res.json({ districts: await districtSuggestions(String(req.query.state || ''), String(req.query.q || '')) });
}));
router.get('/leads/:id/location-suggestions', asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  res.json({ suggestions: await leadSuggestions(lead.id) });
}));
router.post('/location-suggestions/:id/accept', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT lead_id FROM crm_location_suggestions WHERE id = $1', [id(req.params.id)]);
  if (!rows[0]) throw notFound('Suggestion not found');
  const lead = await visibleLead(req, rows[0].lead_id);
  if (!canWorkLead(req.currentUser, lead)) throw forbidden('Only the lead\'s owner, or someone who can assign leads, can change it');
  res.json(await acceptSuggestion(id(req.params.id), req.currentUser));
}));
router.post('/location-suggestions/:id/reject', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT lead_id FROM crm_location_suggestions WHERE id = $1', [id(req.params.id)]);
  if (!rows[0]) throw notFound('Suggestion not found');
  const lead = await visibleLead(req, rows[0].lead_id);
  if (!canWorkLead(req.currentUser, lead)) throw forbidden('Only the lead\'s owner, or someone who can assign leads, can change it');
  res.json(await rejectSuggestion(id(req.params.id), req.currentUser));
}));
/** The location suggestions waiting across leads the viewer can see. */
router.get('/location-suggestions', asyncHandler(async (req, res) => {
  const scope = await crmScope(req.currentUser);
  const params = [];
  const scopeSql = scopeCondition(scope, 'lead', 'l', (v) => { params.push(v); return `$${params.length}`; });
  const status = ['PROPOSED', 'ACCEPTED', 'REJECTED'].includes(req.query.status) ? req.query.status : 'PROPOSED';
  res.json(await listLocationSuggestions({ status, page: Number(req.query.page) || 1, pageSize: Number(req.query.page_size) || 50, scopeSql, params }));
}));

/** Builds the review list of location suggestions across leads. Writes suggestions only, never a lead. */
router.post('/location-suggestions/generate', settingsOnly, asyncHandler(async (req, res) => {
  res.json(await generateLocationSuggestions());
}));

export default router;
