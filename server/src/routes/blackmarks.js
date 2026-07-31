import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../lib/permissions.js';
import { recordBlackMark, runBlackMarkScan, monthlyReview } from '../services/blackmarks.js';

const router = Router();

// ---------------------------------------------------------------- rules

const ruleInput = z.object({
  name: z.string().min(3).max(120),
  description: z.string().max(500).nullable().optional(),
  trigger_type: z.enum(['deadline_missed', 'overdue_escalation', 'completed_late', 'task_reopened', 'manual']),
  points: z.number().min(0).max(100),
  grace_hours: z.number().int().min(0).max(2000).optional(),
  priorities: z.array(z.enum(['low', 'medium', 'high', 'critical'])).optional(),
  department_ids: z.array(z.number().int().positive()).optional(),
  repeat_every_days: z.number().int().min(1).max(365).nullable().optional(),
  max_points_per_task: z.number().min(0).max(1000).nullable().optional(),
  severity: z.enum(['low', 'normal', 'high']).optional(),
  is_active: z.boolean().optional(),
});

router.get(
  '/rules',
  requirePermission('blackmark.view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT r.*, COUNT(bm.id)::int AS marks_generated
         FROM blackmark_rules r
         LEFT JOIN black_marks bm ON bm.rule_id = r.id
        GROUP BY r.id
        ORDER BY r.is_active DESC, r.id`,
    );
    res.json({ rules: rows });
  }),
);

router.post(
  '/rules',
  requirePermission('blackmark.rules'),
  asyncHandler(async (req, res) => {
    const data = ruleInput.parse(req.body);
    if (data.trigger_type === 'overdue_escalation' && !data.repeat_every_days) {
      throw badRequest('Escalating rules need "repeat every N days"');
    }
    const { rows } = await query(
      `INSERT INTO blackmark_rules
         (name, description, trigger_type, points, grace_hours, priorities, department_ids,
          repeat_every_days, max_points_per_task, severity, is_active)
       VALUES ($1,$2,$3,$4,COALESCE($5,0),COALESCE($6::text[],'{}'::text[]),
               COALESCE($7::int[],'{}'::int[]),$8,$9,
               COALESCE($10,'normal'),COALESCE($11,TRUE))
       RETURNING *`,
      [
        data.name,
        data.description ?? null,
        data.trigger_type,
        data.points,
        data.grace_hours ?? null,
        data.priorities ?? null,
        data.department_ids ?? null,
        data.repeat_every_days ?? null,
        data.max_points_per_task ?? null,
        data.severity ?? null,
        data.is_active ?? null,
      ],
    );
    res.status(201).json({ rule: rows[0] });
  }),
);

router.patch(
  '/rules/:id',
  requirePermission('blackmark.rules'),
  asyncHandler(async (req, res) => {
    const data = ruleInput.partial().parse(req.body);
    const fields = [];
    const params = [];
    for (const key of [
      'name', 'description', 'trigger_type', 'points', 'grace_hours', 'priorities',
      'department_ids', 'repeat_every_days', 'max_points_per_task', 'severity', 'is_active',
    ]) {
      if (data[key] !== undefined) {
        params.push(data[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (!fields.length) throw badRequest('Nothing to update');

    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE blackmark_rules SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Rule not found');
    res.json({ rule: rows[0] });
  }),
);

router.delete(
  '/rules/:id',
  requirePermission('blackmark.rules'),
  asyncHandler(async (req, res) => {
    await query('DELETE FROM blackmark_rules WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }),
);

/** Dry run: shows what a rule set would produce without writing anything. */
router.post(
  '/scan',
  requirePermission('blackmark.rules'),
  asyncHandler(async (req, res) => {
    const result = await runBlackMarkScan();
    res.json(result);
  }),
);

// ---------------------------------------------------------------- marks

router.get(
  '/',
  requirePermission('blackmark.view'),
  asyncHandler(async (req, res) => {
    const params = [];
    const filters = [];
    const push = (v) => {
      params.push(v);
      return `$${params.length}`;
    };

    // members without the wider view only ever see their own record
    if (!hasPermission(req.currentUser, 'blackmark.waive') && !hasPermission(req.currentUser, 'report.view')) {
      filters.push(`bm.user_id = ${push(req.currentUser.id)}`);
    } else if (req.query.user_id) {
      filters.push(`bm.user_id = ${push(Number(req.query.user_id))}`);
    }

    if (req.query.status) filters.push(`bm.status = ${push(req.query.status)}`);
    if (req.query.month) {
      filters.push(`bm.period_month = ${push(`${req.query.month}-01`)}`);
    }
    if (req.query.department_id) filters.push(`u.department_id = ${push(Number(req.query.department_id))}`);

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT bm.*, u.full_name, u.avatar_color, d.name AS department,
              t.ref AS task_ref, t.title AS task_title,
              r.name AS rule_name, r.trigger_type,
              w.full_name AS waived_by_name
         FROM black_marks bm
         JOIN users u ON u.id = bm.user_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN tasks t ON t.id = bm.task_id
         LEFT JOIN blackmark_rules r ON r.id = bm.rule_id
         LEFT JOIN users w ON w.id = bm.waived_by
         ${where}
        ORDER BY bm.occurred_at DESC
        LIMIT 500`,
      params,
    );
    res.json({ marks: rows });
  }),
);

router.post(
  '/',
  requirePermission('blackmark.create'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        user_id: z.number().int().positive(),
        task_id: z.number().int().positive().nullable().optional(),
        points: z.number().min(0).max(100),
        reason: z.string().min(3).max(500),
      })
      .parse(req.body);

    const mark = await recordBlackMark({
      userId: data.user_id,
      taskId: data.task_id ?? null,
      points: data.points,
      reason: data.reason,
      source: 'manual',
      occurrenceKey: `manual:${data.user_id}:${Date.now()}`,
      createdBy: req.currentUser.id,
    });
    res.status(201).json({ mark });
  }),
);

router.post(
  '/:id/waive',
  requirePermission('blackmark.waive'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const { rows } = await query(
      `UPDATE black_marks
          SET status = 'waived', waived_by = $1, waived_reason = $2, waived_at = now()
        WHERE id = $3 RETURNING *`,
      [req.currentUser.id, reason, req.params.id],
    );
    if (!rows[0]) throw notFound('Black mark not found');
    res.json({ mark: rows[0] });
  }),
);

router.post(
  '/:id/restore',
  requirePermission('blackmark.waive'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE black_marks SET status = 'active', waived_by = NULL, waived_reason = NULL, waived_at = NULL
        WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Black mark not found');
    res.json({ mark: rows[0] });
  }),
);

router.get(
  '/review',
  requirePermission('blackmark.view'),
  asyncHandler(async (req, res) => {
    const review = await monthlyReview({
      month: req.query.month,
      departmentId: req.query.department_id ? Number(req.query.department_id) : null,
    });
    res.json(review);
  }),
);

export default router;
