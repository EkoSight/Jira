import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, badRequest, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { assertDate, holidaysBetween, visibleUserIds } from '../services/attendance.js';
import {
  CORRECTION_PERMISSION, COVERAGE, KINDS, applyCorrection, calendarView, decideRequest, entryHistory, listCorrections, proposeChange,
  rejectCorrection, requestDetail, reverseCorrection, withdrawRequest,
} from '../services/holidays.js';

/**
 * Holidays and closures: Settings → Attendance & pay → Holidays.
 *
 * Reading the holidays in force is open to everyone (they are published).
 * Proposing a change needs "attendance.policy"; putting it in force needs
 * "holiday.approve"; each correction it leaves needs the permission for the
 * record it touches. Nothing is ever deleted: a cancelled date is kept.
 */
const router = Router();

const MANAGE = ['attendance.policy', 'holiday.approve'];

const fields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(KINDS).optional(),
  start_date: z.string(),
  end_date: z.string().optional(),
  coverage: z.enum(COVERAGE).optional(),
  scope: z.enum(['COMPANY', 'DEPARTMENT', 'PERSON']).optional(),
  department_id: z.number().int().positive().nullable().optional(),
  user_id: z.number().int().positive().nullable().optional(),
  reason: z.string().trim().min(3).max(500),
};
const change = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ADD'), ...fields }),
  z.object({ action: z.literal('AMEND'), target_ids: z.array(z.number().int().positive()).min(1).max(62), ...fields, name: fields.name.optional(), start_date: z.string().optional() }),
  z.object({ action: z.literal('CANCEL'), target_ids: z.array(z.number().int().positive()).min(1).max(62), reason: fields.reason }),
]);

const checkDates = (body) => {
  if (body.start_date) assertDate(body.start_date, 'start date');
  if (body.end_date) assertDate(body.end_date, 'end date');
  return body;
};

/** The holidays in force for a year: what everyone sees. */
router.get(
  '/holidays',
  asyncHandler(async (req, res) => {
    const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : new Date().getFullYear();
    res.json({ holidays: await holidaysBetween(`${year}-01-01`, `${year}-12-31`) });
  }),
);

/** The managed calendar: every entry whatever its status, and the changes around it. */
router.get(
  '/holidays/manage',
  requirePermission(...MANAGE),
  asyncHandler(async (req, res) => {
    const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());
    const from = req.query.from ? assertDate(req.query.from) : `${year}-01-01`;
    const to = req.query.to ? assertDate(req.query.to) : `${year}-12-31`;
    if (to < from) throw badRequest('The end of the period is before its start');
    const view = await calendarView({ from, to });
    res.json({
      ...view,
      can: {
        propose: hasPermission(req.currentUser, 'attendance.policy'),
        approve: hasPermission(req.currentUser, 'holiday.approve'),
      },
    });
  }),
);

/** Kept for older screens: adding a date proposes it. Nothing is in force until approved. */
router.post(
  '/holidays',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const body = z.object({
      holiday_date: z.string(), name: fields.name, department_id: z.number().int().nullable().optional(),
      reason: z.string().trim().min(3).max(500).optional(),
    }).parse(req.body);
    assertDate(body.holiday_date, 'holiday date');
    const request = await proposeChange(req.currentUser, {
      action: 'ADD', name: body.name, start_date: body.holiday_date, end_date: body.holiday_date,
      scope: body.department_id ? 'DEPARTMENT' : 'COMPANY', department_id: body.department_id ?? null,
      reason: body.reason || 'Added to the holiday list',
    });
    res.status(202).json({ request, in_force: false });
  }),
);

/** Kept for older screens: removing a date proposes cancelling it. Nothing is deleted. */
router.delete(
  '/holidays/:id',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const reason = String(req.body?.reason || req.query.reason || '').trim();
    if (reason.length < 3) throw badRequest('Say why the holiday is being cancelled');
    const request = await proposeChange(req.currentUser, { action: 'CANCEL', target_ids: [Number(req.params.id)], reason });
    res.status(202).json({ request, in_force: false });
  }),
);

router.get(
  '/holidays/:id/history',
  requirePermission(...MANAGE),
  asyncHandler(async (req, res) => {
    res.json(await entryHistory(Number(req.params.id)));
  }),
);

// ---------------------------------------------------------------- changes

router.post(
  '/holiday-requests',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const body = checkDates(change.parse(req.body));
    const request = await proposeChange(req.currentUser, body);
    res.status(201).json({ request });
  }),
);

/** A request with its impact: live while it waits, as the approver saw it once decided. */
router.get(
  '/holiday-requests/:id',
  requirePermission(...MANAGE),
  asyncHandler(async (req, res) => {
    res.json(await requestDetail(Number(req.params.id)));
  }),
);

router.post(
  '/holiday-requests/:id/approve',
  requirePermission('holiday.approve'),
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().trim().max(500).nullable().optional() }).parse(req.body || {});
    const result = await decideRequest(req.currentUser, Number(req.params.id), { approve: true, note: note || null });
    res.json({ request: result.request, created: result.created, cancelled: result.cancelled, corrections: result.corrections, summary: result.impact.summary });
  }),
);

router.post(
  '/holiday-requests/:id/reject',
  requirePermission('holiday.approve'),
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body || {});
    res.json(await decideRequest(req.currentUser, Number(req.params.id), { approve: false, note }));
  }),
);

router.post(
  '/holiday-requests/:id/withdraw',
  requirePermission(...MANAGE),
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().trim().max(500).nullable().optional() }).parse(req.body || {});
    res.json({ request: await withdrawRequest(req.currentUser, Number(req.params.id), note || null) });
  }),
);

// ---------------------------------------------------------------- corrections

const REVIEWERS = ['holiday.approve', 'attendance.policy', 'blackmark.waive', 'blackmark.create', 'standup.review', 'leave.approve'];

router.get(
  '/holiday-corrections',
  requirePermission(...REVIEWERS),
  asyncHandler(async (req, res) => {
    const status = ['PROPOSED', 'APPLIED', 'REJECTED', 'REVERSED', 'STALE'].includes(req.query.status) ? req.query.status : null;
    const corrections = await listCorrections({ requestId: req.query.request_id ? Number(req.query.request_id) : null, status });
    // holiday managers see every correction; anyone else only the kinds they may
    // decide, never their own, and leave only for people they are authorised for
    const viewer = req.currentUser;
    if (hasPermission(viewer, 'holiday.approve') || hasPermission(viewer, 'attendance.policy')) return res.json({ corrections });
    const team = await visibleUserIds(viewer);
    res.json({
      corrections: corrections.filter((c) => c.user_id !== viewer.id
        && hasPermission(viewer, CORRECTION_PERMISSION[c.kind])
        && (c.target_type !== 'LEAVE_REQUEST' || team === null || team.includes(c.user_id))),
    });
  }),
);

const decision = (fn, key) => asyncHandler(async (req, res) => {
  const body = z.object({ note: z.string().trim().max(500).optional(), reason: z.string().trim().max(500).optional() }).parse(req.body || {});
  if (key === 'reason' && !body.reason) throw badRequest('Say why it is reversed');
  if (!req.currentUser) throw forbidden('Sign in first');
  res.json(await fn(req.currentUser, Number(req.params.id), body));
});

router.post('/holiday-corrections/:id/apply', requirePermission(...REVIEWERS), decision(applyCorrection));
router.post('/holiday-corrections/:id/reject', requirePermission(...REVIEWERS), decision(rejectCorrection));
router.post('/holiday-corrections/:id/reverse', requirePermission(...REVIEWERS), decision(reverseCorrection, 'reason'));

export default router;
