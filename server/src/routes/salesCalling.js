import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, forbidden, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../lib/permissions.js';
import { KNOWN_CATEGORIES, crmScope } from '../services/sales/core.js';
import {
  CALL_OUTCOMES, FIELD_TYPES, LIFECYCLES, bringIntoTaskflow, callQueue, callStatuses, leadFields, reorderCallStatuses,
  saveCallStatus, saveLeadField, setCallStatus,
} from '../services/sales/calling.js';
import { callingReport } from '../services/sales/reports.js';
import { canWorkLead, visibleLead } from './sales.js';

/**
 * Tele-sales: calling statuses, the call queue, custom lead fields and the
 * calling report. Mounted under /sales, after the CRM's own checks.
 */
const router = Router();
const settingsOnly = requirePermission('crm.settings');
const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

// ---------------------------------------------------------------- calling statuses

router.get('/call-statuses', asyncHandler(async (req, res) => res.json({ statuses: await callStatuses(), lifecycles: LIFECYCLES, outcomes: CALL_OUTCOMES })));

const statusInput = z.object({
  label: z.string().trim().min(2).max(80).optional(), lifecycle: z.enum(LIFECYCLES).optional(), outcome: z.enum(CALL_OUTCOMES).optional(),
  retry_after_minutes: z.number().int().min(5).max(60 * 24 * 30).nullable().optional(), max_attempts: z.number().int().min(1).max(50).nullable().optional(),
  needs_reason: z.boolean().optional(), implies_category: z.enum(KNOWN_CATEGORIES).nullable().optional(),
  color: z.string().max(20).nullable().optional(), is_active: z.boolean().optional(),
});
router.post('/call-statuses', settingsOnly, asyncHandler(async (req, res) => {
  res.status(201).json({ status: await saveCallStatus(null, statusInput.parse(req.body), req.currentUser) });
}));
router.patch('/call-statuses/:id', settingsOnly, asyncHandler(async (req, res) => {
  res.json({ status: await saveCallStatus(id(req.params.id), statusInput.parse(req.body), req.currentUser) });
}));
router.post('/call-statuses/order', settingsOnly, asyncHandler(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).parse(req.body);
  res.json({ statuses: await reorderCallStatuses(ids) });
}));

// ---------------------------------------------------------------- lead fields

router.get('/lead-fields', asyncHandler(async (req, res) => res.json({ fields: await leadFields(), types: FIELD_TYPES })));

const fieldInput = z.object({
  key: z.string().max(40).optional(), label: z.string().trim().min(2).max(120).optional(), type: z.enum(FIELD_TYPES).optional(),
  options: z.array(z.object({
    value: z.string().max(60).optional(), label: z.string().max(120), aliases: z.array(z.string().max(200)).max(30).optional(),
    category: z.enum(KNOWN_CATEGORIES).nullable().optional(),
  })).max(100).optional(),
  help: z.string().max(500).nullable().optional(), show_in_list: z.boolean().optional(), filterable: z.boolean().optional(),
  is_active: z.boolean().optional(), position: z.number().int().min(0).max(1000).optional(),
});
router.post('/lead-fields', settingsOnly, asyncHandler(async (req, res) => {
  res.status(201).json({ field: await saveLeadField(null, fieldInput.parse(req.body), req.currentUser) });
}));
router.patch('/lead-fields/:id', settingsOnly, asyncHandler(async (req, res) => {
  res.json({ field: await saveLeadField(id(req.params.id), fieldInput.parse(req.body), req.currentUser) });
}));

// ---------------------------------------------------------------- working a lead

router.post('/leads/:id/call-status', asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  // an unowned lead can be taken by whoever calls it; an owned one is its owner's or an assigner's
  if (lead.owner_user_id && !canWorkLead(req.currentUser, lead)) throw forbidden('This lead is someone else\'s; ask them or a manager to hand it over');
  const d = z.object({
    status_id: z.number().int().positive(), note: z.string().max(5000).nullable().optional(), lost_reason: z.string().max(500).nullable().optional(),
    callback_at: z.string().max(40).nullable().optional(), callback_kind: z.enum(['CALL', 'CALLBACK', 'WHATSAPP', 'VISIT', 'MEETING']).optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(), log_call: z.boolean().optional(), duration_sec: z.number().int().min(0).max(36000).nullable().optional(),
  }).parse(req.body);
  res.json(await setCallStatus(lead.id, {
    statusId: d.status_id, note: d.note ?? null, lostReason: d.lost_reason ?? null, callbackAt: d.callback_at || null, callbackKind: d.callback_kind || 'CALLBACK',
    rating: d.rating ?? undefined, logCall: d.log_call !== false, durationSec: d.duration_sec ?? null,
  }, { actor: req.currentUser }));
}));

// several leads at once: the status only, no call is claimed
router.post('/leads/bulk-call-status', requirePermission('crm.assign'), asyncHandler(async (req, res) => {
  const d = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500), status_id: z.number().int().positive(), lost_reason: z.string().max(500).nullable().optional() }).parse(req.body);
  const scope = await crmScope(req.currentUser);
  const out = { changed: 0, skipped: [] };
  for (const leadId of d.ids) {
    try {
      await visibleLead(req, leadId);
      await setCallStatus(leadId, { statusId: d.status_id, lostReason: d.lost_reason ?? null, logCall: false }, { actor: req.currentUser, source: 'BULK' });
      out.changed += 1;
    } catch (err) {
      out.skipped.push({ id: leadId, why: err.message });
    }
  }
  void scope;
  res.json(out);
}));

router.get('/call-queue', asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? id(req.query.user_id) : req.currentUser.id;
  if (userId !== req.currentUser.id && !hasPermission(req.currentUser, 'crm.assign') && !hasPermission(req.currentUser, 'crm.view.team')) {
    throw forbidden('Seeing someone else\'s call queue needs team access');
  }
  res.json(await callQueue(userId, { limit: req.query.limit }));
}));

router.post('/routing/bring-in', requirePermission('crm.routing'), settingsOnly, asyncHandler(async (req, res) => {
  res.json(await bringIntoTaskflow(req.currentUser));
}));

router.get('/reports/calling', asyncHandler(async (req, res) => res.json(await callingReport(req.query, await crmScope(req.currentUser)))));

export default router;
