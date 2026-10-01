import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { decimalHours, hhmm } from '../lib/attendanceCalc.js';
import { sendCsv } from '../lib/csv.js';
import { requirePermission } from '../middleware/auth.js';
import { audit, dateIn } from '../services/attendance.js';
import { currentPolicy } from '../services/attendancePolicy.js';
import { isLocked, monthBounds } from '../services/attendanceLedger.js';
import {
  ACTIONS, BLOCKER_TEXT, PAYROLL_STATUS_LABEL, history, lockedResults, markExported, payrollPeople, payrollView, transition,
} from '../services/payroll.js';

const router = Router();

/**
 * Monthly salary estimates. Behind its own permission, separate from seeing
 * attendance: a team lead can approve a correction without seeing anyone's pay.
 *
 * This produces an attendance-adjusted estimate for payroll to use. It does
 * not pay anyone, and it does not calculate tax, PF, ESI or any other
 * statutory deduction.
 */

router.use(requirePermission('payroll.view'));

// preparing, approving and reopening are separate rights
const ACTION_PERMISSION = { submit: 'payroll.manage', return: 'payroll.manage', approve: 'payroll.approve', lock: 'payroll.approve', reopen: 'payroll.reopen' };
const assertMay = (user, action) => {
  const permission = ACTION_PERMISSION[action];
  if (!hasPermission(user, permission)) throw forbidden(`Requires permission: ${permission}`);
};

const monthOf = async (value) => {
  if (value && !/^\d{4}-\d{2}(-\d{2})?$/.test(value)) throw badRequest('Give the month as YYYY-MM');
  const { config } = await currentPolicy();
  return monthBounds(value || dateIn(config.timezone)).first;
};

router.get(
  '/salary/:userId',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.*, u.full_name AS created_by_name FROM salary_basis s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.user_id = $1 ORDER BY s.effective_from DESC`,
      [Number(req.params.userId)],
    );
    res.json({ basis: rows });
  }),
);

/** A salary amount from a date. Earlier amounts are kept; nothing is overwritten. */
router.post(
  '/salary/:userId',
  requirePermission('payroll.salary.edit'),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    const body = z.object({
      effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      attendance_sensitive: z.number().min(0).max(100_000_000),
      fixed_components: z.number().min(0).max(100_000_000).default(0),
      currency: z.string().length(3).default('INR'),
      note: z.string().max(500).optional().nullable(),
    }).parse(req.body);
    if (await isLocked(userId, body.effective_from)) {
      throw conflict('Payroll for that month is approved or locked for this person — reopen it first');
    }
    const { rows: before } = await query('SELECT * FROM salary_basis WHERE user_id = $1 AND effective_from = $2', [userId, body.effective_from]);
    if (before[0]) throw conflict('There is already an amount from that date. Add one from a different date.');
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO salary_basis (user_id, effective_from, attendance_sensitive, fixed_components, currency, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [userId, body.effective_from, body.attendance_sensitive, body.fixed_components, body.currency, body.note || null, req.currentUser.id],
      );
      await audit(client, {
        entityType: 'SALARY_BASIS', entityId: rows[0].id, subjectUserId: userId, actorId: req.currentUser.id,
        action: 'CREATED', reason: body.note || null, after: body,
      });
      return rows[0];
    });
    res.status(201).json({ basis: row });
  }),
);

/** Everyone's month: one row each, with what stands in the way. */
router.get(
  '/:month',
  asyncHandler(async (req, res) => {
    const month = await monthOf(req.params.month);
    const ids = await payrollPeople(month);
    const people = [];
    for (const id of ids) {
      const view = await payrollView(month, id);
      if (!view) continue;
      people.push({
        user: view.user,
        status: view.status,
        record: view.record,
        frozen: view.frozen,
        setup: view.setup,
        blockers: view.blockers.map((b) => ({ code: b, label: BLOCKER_TEXT[b] || b })),
        totals: view.totals,
        day_counts: view.day_counts,
        salary: view.salary ? {
          status: view.salary.status,
          entitlement: view.salary.entitlement,
          attendance_adjustment: view.salary.attendance_adjustment,
          attendance_adjusted_earnings: view.salary.attendance_adjusted_earnings,
          fixed_components: view.salary.fixed_components,
          currency: view.salary.currency,
        } : null,
      });
    }
    res.json({ month, people, statuses: PAYROLL_STATUS_LABEL });
  }),
);

/** One person's month in full: every day, every allocation, every version. */
router.get(
  '/:month/people/:userId',
  asyncHandler(async (req, res) => {
    const month = await monthOf(req.params.month);
    const userId = Number(req.params.userId);
    const view = await payrollView(month, userId);
    if (!view) throw notFound('Person not found');
    res.json({
      ...view,
      blockers: view.blockers.map((b) => ({ code: b, label: BLOCKER_TEXT[b] || b })),
      versions: await history(month, userId),
    });
  }),
);

router.post(
  '/:month/people/:userId/:action',
  asyncHandler(async (req, res) => {
    const month = await monthOf(req.params.month);
    if (!ACTIONS.includes(req.params.action)) throw notFound('Unknown action');
    assertMay(req.currentUser, req.params.action);
    res.json(await transition(req.currentUser, month, Number(req.params.userId), req.params.action, { reason: req.body?.reason }));
  }),
);

/** The same action for several people; each succeeds or says why not. */
router.post(
  '/:month/bulk',
  asyncHandler(async (req, res) => {
    const month = await monthOf(req.params.month);
    const body = z.object({
      action: z.enum(['submit', 'approve', 'lock', 'return']),
      user_ids: z.array(z.number().int()).min(1).max(500),
      reason: z.string().max(1000).optional().nullable(),
    }).parse(req.body);
    assertMay(req.currentUser, body.action);
    const results = [];
    for (const userId of body.user_ids) {
      try {
        results.push({ user_id: userId, ok: true, ...(await transition(req.currentUser, month, userId, body.action, { reason: body.reason })) });
      } catch (err) {
        results.push({ user_id: userId, ok: false, error: err.message });
      }
    }
    res.json({ results });
  }),
);

/**
 * The locked month for payroll, from the frozen snapshots. No coordinates and
 * no leave reasons — only what payroll needs.
 */
router.get(
  '/:month/export.csv',
  requirePermission('payroll.manage'),
  asyncHandler(async (req, res) => {
    const month = await monthOf(req.params.month);
    const rows = await lockedResults(month);
    if (!rows.length) throw conflict('No locked results for that month yet — lock the month before exporting it');
    const header = [
      'Month', 'Employee', 'Email', 'Department', 'Version', 'Locked at',
      'Required (HH:MM)', 'Required (hours)', 'Within office hours (HH:MM)', 'Paid leave (HH:MM)', 'Grace credit (HH:MM)',
      'Extra time used to offset (HH:MM)', 'Unpaid (HH:MM)', 'Unpaid (hours)', 'Salary-credited (HH:MM)',
      'Paid leave days', 'Unpaid leave days', 'Unapproved absence days',
      'Currency', 'Attendance-sensitive entitlement', 'Attendance adjustment', 'Attendance-adjusted earnings', 'Fixed components (not adjusted)',
      'Policy version',
    ];
    const out = rows.map((r) => {
      const s = r.snapshot || {};
      const t = s.totals || {};
      const c = s.day_counts || {};
      const pay = s.salary || {};
      return [
        month.slice(0, 7), r.full_name, r.email, r.department_name || '', r.version, r.locked_at,
        hhmm(t.required), decimalHours(t.required || 0), hhmm(t.in_schedule), hhmm(t.paid_leave), hhmm(t.grace),
        hhmm((t.same_day_offset || 0) + (t.cross_day_offset || 0)), hhmm(t.unpaid), decimalHours(t.unpaid || 0), hhmm(t.salary_credited),
        c.paid_leave ?? '', c.unpaid_leave ?? '', c.unapproved_absence ?? '',
        pay.currency || 'INR', pay.entitlement ?? '', pay.attendance_adjustment ?? '', pay.attendance_adjusted_earnings ?? '', pay.fixed_components ?? '',
        r.policy_id,
      ];
    });
    await markExported(req.currentUser, rows.map((r) => r.id), month);
    sendCsv(res, `payroll-${month.slice(0, 7)}.csv`, header, out);
  }),
);

export default router;
