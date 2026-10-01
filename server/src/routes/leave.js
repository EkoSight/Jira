import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { canSee, dateIn, visibleUserIds, assertReviewer } from '../services/attendance.js';
import { currentPolicy } from '../services/attendancePolicy.js';
import {
  CATEGORY_LABEL, EMAIL_NOTE, LEAVE_CATEGORIES, STATUS_LABEL, balance, cancelRequest, createRequest,
  decideRequest, getRequest, leaveDays, listRequests, shapeRequest, submitRequest,
} from '../services/leave.js';
import { PENDING_LEAVE } from '../services/attendanceLedger.js';

const router = Router();

/**
 * Leave requests. Anyone asks for their own; approvers decide for the teams
 * they are authorised to see, never for themselves. The reason given is
 * private to the person and their approvers — colleagues see only that leave
 * exists, on the team calendar.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-14');

const isApproverFor = async (viewer, userId) =>
  viewer.id !== userId && hasPermission(viewer, 'leave.approve') && (await canSee(viewer, userId));

router.get(
  '/meta',
  asyncHandler(async (req, res) => {
    const { config } = await currentPolicy();
    res.json({
      categories: LEAVE_CATEGORIES.map((key) => ({ key, label: CATEGORY_LABEL[key] })),
      statuses: STATUS_LABEL,
      notice_hours: config.leave?.noticeHours ?? 48,
      allowance_mode: config.leave?.allowanceMode,
      monthly_paid_days: config.leave?.monthlyPaidDays,
      half_day_split: config.halfDaySplit,
      email_note: EMAIL_NOTE,
      email_service_configured: false,
    });
  }),
);

router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const rows = await listRequests({ userIds: [req.currentUser.id] });
    res.json({ requests: rows.map((r) => shapeRequest(r, { private: true })) });
  }),
);

router.get(
  '/balance',
  asyncHandler(async (req, res) => {
    const userId = req.query.user_id ? Number(req.query.user_id) : req.currentUser.id;
    if (userId !== req.currentUser.id && !(await canSee(req.currentUser, userId))) throw forbidden('This person is not in a team you can see');
    const { config } = await currentPolicy();
    const month = /^\d{4}-\d{2}/.test(req.query.month || '') ? `${req.query.month.slice(0, 7)}-01` : `${dateIn(config.timezone).slice(0, 7)}-01`;
    res.json(await balance(userId, month));
  }),
);

/** How many working days a range would use — for the form, before submitting. */
router.get(
  '/preview',
  asyncHandler(async (req, res) => {
    const start = isoDate.parse(req.query.start);
    const end = isoDate.parse(req.query.end || req.query.start);
    const dayPart = ['FIRST_HALF', 'SECOND_HALF'].includes(req.query.day_part) ? req.query.day_part : 'FULL';
    const { days } = await leaveDays(req.currentUser.id, req.currentUser.department_id, start, end, dayPart);
    res.json({ days, working_days: days.reduce((s, d) => s + d.portion, 0) });
  }),
);

/** The reviewer's queue, and the team's requests over a window. */
router.get(
  '/team',
  requirePermission('leave.approve', 'attendance.team', 'attendance.all'),
  asyncHandler(async (req, res) => {
    const ids = await visibleUserIds(req.currentUser);
    const statuses = req.query.status === 'pending' ? PENDING_LEAVE : null;
    const rows = await listRequests({ userIds: ids, statuses, from: req.query.from || null, to: req.query.to || null });
    const canApprove = hasPermission(req.currentUser, 'leave.approve');
    res.json({
      requests: rows
        .filter((r) => req.query.status !== 'pending' || r.user_id !== req.currentUser.id)
        .map((r) => ({ ...shapeRequest(r, { private: canApprove || r.user_id === req.currentUser.id }), can_decide: canApprove && r.user_id !== req.currentUser.id })),
    });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = z.object({
      user_id: z.number().int().optional(),
      category: z.enum(LEAVE_CATEGORIES),
      start_date: isoDate,
      end_date: isoDate,
      day_part: z.enum(['FULL', 'FIRST_HALF', 'SECOND_HALF']).default('FULL'),
      reason: z.string().max(2000),
      is_emergency: z.boolean().default(false),
      emergency_explanation: z.string().max(2000).optional().nullable(),
      notified_user_id: z.number().int().optional().nullable(),
      email_reference: z.string().max(300).optional().nullable(),
      claimed_notified_at: z.string().datetime({ offset: true }).optional().nullable(),
      draft: z.boolean().optional(),
    }).parse(req.body);
    const subject = body.user_id ?? req.currentUser.id;
    // someone rings in sick: an approver may record it for them; it still needs a separate decision
    if (subject !== req.currentUser.id) {
      await assertReviewer(req.currentUser, subject, 'leave.approve');
    }
    const request = await createRequest(req.currentUser, subject, body);
    res.status(201).json({ request: shapeRequest(request, { private: true }), email: { sent: false, note: EMAIL_NOTE } });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const request = await getRequest(Number(req.params.id));
    const own = request.user_id === req.currentUser.id;
    if (!own && !(await canSee(req.currentUser, request.user_id))) throw forbidden('You cannot see this request');
    res.json({ request: shapeRequest(request, { private: own || (await isApproverFor(req.currentUser, request.user_id)) }) });
  }),
);

router.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const request = await submitRequest(req.currentUser, Number(req.params.id));
    res.json({ request: shapeRequest(request, { private: true }), email: { sent: false, note: EMAIL_NOTE } });
  }),
);

router.post(
  '/:id/decide',
  asyncHandler(async (req, res) => {
    const body = z.object({
      decision: z.enum(['APPROVED_PAID', 'APPROVED_UNPAID', 'REJECTED']),
      note: z.string().max(2000).optional().nullable(),
    }).parse(req.body);
    const request = await getRequest(Number(req.params.id));
    await assertReviewer(req.currentUser, request.user_id, 'leave.approve');
    const result = await decideRequest(req.currentUser, request.id, body);
    res.json(result);
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const request = await getRequest(Number(req.params.id));
    const asReviewer = request.user_id !== req.currentUser.id;
    if (asReviewer) await assertReviewer(req.currentUser, request.user_id, 'leave.approve');
    const updated = await cancelRequest(req.currentUser, request.id, { reason: req.body?.reason, asReviewer });
    res.json({ request: shapeRequest(updated, { private: true }) });
  }),
);

export default router;
