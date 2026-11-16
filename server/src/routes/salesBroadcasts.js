/**
 * WhatsApp broadcasts, under /sales (CRM on, crm.view). Seeing them needs
 * marketing.view; each change checks its own permission in the service:
 * marketing.manage drafts, marketing.approve approves, marketing.send sends
 * (docs/WHATSAPP_BROADCASTS.md).
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { getSettings } from '../services/settings.js';
import { whatsappStatus } from '../services/sales/comms.js';
import {
  BROADCAST_VIEWS, SKIP_WORDS, VALUE_SOURCES, approveBroadcast, broadcastTemplates, cancelBroadcast, createBroadcast, getBroadcast,
  listBroadcasts, pauseBroadcast, requestChanges, resumeBroadcast, retryFailed, sendBroadcast, sendingRoom, submitBroadcast,
  testBroadcast, updateBroadcast,
} from '../services/sales/broadcasts.js';

const router = Router();

// switched off: the routes answer 404, and nothing is lost
router.use('/broadcasts', requirePermission('marketing.view'), asyncHandler(async (req, res, next) => {
  const s = await getSettings();
  if (s.crm?.sales?.whatsapp?.broadcasts?.enabled === false) throw notFound('WhatsApp broadcasts are switched off');
  next();
}));

const idOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound('Broadcast not found');
  return n;
};

router.get('/broadcasts', asyncHandler(async (req, res) => {
  const room = await sendingRoom();
  const wa = whatsappStatus();
  res.json({
    broadcasts: await listBroadcasts(req.currentUser),
    room: { in_hours: room.inHours, sent_last_24h: room.sentLast24h, left_today: room.left, ...room.settings },
    whatsapp: { configured: wa.configured, missing: wa.missing },
  });
}));

/** What the editor needs: the templates (and which can be used), what can fill a blank, the views. */
router.get('/broadcasts/options', asyncHandler(async (req, res) => {
  res.json({ templates: await broadcastTemplates(), sources: VALUE_SOURCES, views: BROADCAST_VIEWS, skip_words: SKIP_WORDS });
}));

router.post('/broadcasts', asyncHandler(async (req, res) => res.status(201).json(await createBroadcast(req.currentUser, req.body || {}))));

router.get('/broadcasts/:id', asyncHandler(async (req, res) => {
  const out = await getBroadcast(idOf(req.params.id), req.currentUser, {
    people: req.query.people === '1', reason: req.query.reason ? String(req.query.reason) : null, offset: req.query.offset, limit: req.query.limit,
  });
  const room = await sendingRoom();
  res.json({ ...out, room: { in_hours: room.inHours, sent_last_24h: room.sentLast24h, left_today: room.left } });
}));

router.patch('/broadcasts/:id', asyncHandler(async (req, res) => res.json(await updateBroadcast(idOf(req.params.id), req.currentUser, req.body || {}))));
router.post('/broadcasts/:id/submit', asyncHandler(async (req, res) => res.json(await submitBroadcast(idOf(req.params.id), req.currentUser))));
router.post('/broadcasts/:id/approve', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().max(1000).nullable().optional() }).parse(req.body || {});
  res.json(await approveBroadcast(idOf(req.params.id), req.currentUser, note));
}));
router.post('/broadcasts/:id/request-changes', asyncHandler(async (req, res) => {
  const { note } = z.object({ note: z.string().min(1).max(1000) }).parse(req.body || {});
  res.json(await requestChanges(idOf(req.params.id), req.currentUser, note));
}));
router.post('/broadcasts/:id/send', asyncHandler(async (req, res) => {
  const { send_at: sendAt } = z.object({ send_at: z.string().max(40).nullable().optional() }).parse(req.body || {});
  res.json(await sendBroadcast(idOf(req.params.id), req.currentUser, { send_at: sendAt || null }));
}));
router.post('/broadcasts/:id/pause', asyncHandler(async (req, res) => res.json(await pauseBroadcast(idOf(req.params.id), req.currentUser))));
router.post('/broadcasts/:id/resume', asyncHandler(async (req, res) => res.json(await resumeBroadcast(idOf(req.params.id), req.currentUser))));
router.post('/broadcasts/:id/cancel', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body || {});
  res.json(await cancelBroadcast(idOf(req.params.id), req.currentUser, reason));
}));
router.post('/broadcasts/:id/retry-failed', asyncHandler(async (req, res) => res.json(await retryFailed(idOf(req.params.id), req.currentUser))));
router.post('/broadcasts/:id/test', asyncHandler(async (req, res) => res.json(await testBroadcast(idOf(req.params.id), req.currentUser))));

export default router;
