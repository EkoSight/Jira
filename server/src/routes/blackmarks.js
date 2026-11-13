import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../lib/permissions.js';
import { audit } from '../services/attendance.js';
import { marksToRecheck, recordBlackMark, runBlackMarkScan, monthlyReview } from '../services/blackmarks.js';
import { SUBSTANTIVE, applyBackfill, previewBackfill, rulesReport } from '../services/blackmarkRules.js';
import { notify } from '../services/activity.js';

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
    // escalations count the owner's working days, and say so
    res.json({ rules: rows.map((r) => ({ ...r, repeat_unit: r.repeat_every_days ? 'working days' : null })) });
  }),
);

/** The live rules in words, their overlaps, and what one late task costs (read only). */
router.get(
  '/rules/report',
  requirePermission('blackmark.view'),
  asyncHandler(async (req, res) => res.json(await rulesReport())),
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
          repeat_every_days, max_points_per_task, severity, is_active, effective_from)
       VALUES ($1,$2,$3,$4,COALESCE($5,0),COALESCE($6::text[],'{}'::text[]),
               COALESCE($7::int[],'{}'::int[]),$8,$9,
               COALESCE($10,'normal'),COALESCE($11,TRUE), now())
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
    // a new rule applies from now: earlier work only through a previewed, approved backfill
    res.status(201).json({ rule: rows[0], note: 'This rule applies to deadlines from now on. To apply it to earlier work, preview it and approve the preview.' });
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
    const { rows: [current] } = await query('SELECT * FROM blackmark_rules WHERE id = $1', [Number(req.params.id)]);
    if (!current) throw notFound('Rule not found');
    // new terms (or switching a rule back on) apply from now, never to the past by themselves
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
      || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v) => b.map(String).includes(String(v))))
      || (a != null && b != null && Number(a) === Number(b));
    const restarts = SUBSTANTIVE.some((k) => data[k] !== undefined && !same(data[k], current[k]))
      || (data.is_active === true && current.is_active === false);
    if (restarts) fields.push('effective_from = now()');

    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE blackmark_rules SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Rule not found');
    await audit(null, {
      entityType: 'BLACKMARK_RULE', entityId: rows[0].id, actorId: req.currentUser.id, action: 'UPDATED',
      before: current, after: rows[0], reason: restarts ? 'New terms apply from now' : null,
    });
    res.json({ rule: rows[0], restarted: restarts });
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

/** Runs the scan now: records the marks that are due under the rules (the same as the scheduled scan). */
router.post(
  '/scan',
  requirePermission('blackmark.rules'),
  asyncHandler(async (req, res) => {
    const result = await runBlackMarkScan();
    res.json(result);
  }),
);

// ---------------------------------------------------------------- applying a rule to earlier work

router.post(
  '/rules/:id/backfill/preview',
  requirePermission('blackmark.rules'),
  asyncHandler(async (req, res) => res.json(await previewBackfill(Number(req.params.id), req.currentUser))),
);

router.get(
  '/backfills',
  requirePermission('blackmark.rules'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT b.id, b.rule_id, r.name AS rule_name, b.status, b.previewed_at, p.full_name AS previewed_by_name, b.occurrences, b.people, b.points,
              b.approved_at, a.full_name AS approved_by_name, b.approval_note, b.created_marks
         FROM blackmark_backfills b LEFT JOIN blackmark_rules r ON r.id = b.rule_id
         LEFT JOIN users p ON p.id = b.previewed_by LEFT JOIN users a ON a.id = b.approved_by
        ORDER BY b.id DESC LIMIT 50`,
    );
    res.json({ backfills: rows });
  }),
);

router.post(
  '/backfills/:id/apply',
  requirePermission('blackmark.rules'),
  asyncHandler(async (req, res) => {
    const body = z.object({ fingerprint: z.string().min(10), note: z.string().max(500) }).parse(req.body || {});
    res.json(await applyBackfill(Number(req.params.id), req.currentUser, body));
  }),
);

// ---------------------------------------------------------------- appeals

/** The person appeals one of their own marks, with a reason and any evidence. */
router.post(
  '/:id/appeal',
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().trim().min(10).max(2000), evidence_url: z.string().max(1000).nullable().optional() }).parse(req.body || {});
    const { rows: [mark] } = await query('SELECT * FROM black_marks WHERE id = $1', [Number(req.params.id)]);
    if (!mark) throw notFound('Black mark not found');
    if (mark.user_id !== req.currentUser.id) throw forbidden('You can appeal your own marks only');
    if (mark.status !== 'active') throw badRequest('This mark is already waived');
    const { rows: open } = await query(`SELECT id FROM black_mark_appeals WHERE mark_id = $1 AND status = 'OPEN'`, [mark.id]);
    if (open[0]) throw badRequest('This mark already has an appeal waiting for a decision');
    const { rows } = await query(
      `INSERT INTO black_mark_appeals (mark_id, user_id, reason, evidence_url) VALUES ($1, $2, $3, $4) RETURNING *`,
      [mark.id, req.currentUser.id, body.reason, body.evidence_url || null],
    );
    await audit(null, {
      entityType: 'BLACK_MARK', entityId: mark.id, subjectUserId: mark.user_id, actorId: req.currentUser.id,
      action: 'APPEALED', reason: body.reason, after: { appeal_id: rows[0].id }, source: 'appeal',
    });
    res.status(201).json({ appeal: rows[0] });
  }),
);

router.get(
  '/appeals',
  asyncHandler(async (req, res) => {
    const reviewer = hasPermission(req.currentUser, 'blackmark.waive');
    const status = ['OPEN', 'UPHELD', 'WAIVED', 'WITHDRAWN'].includes(req.query.status) ? req.query.status : null;
    const { rows } = await query(
      `SELECT a.*, u.full_name, bm.points, bm.reason AS mark_reason, bm.occurred_at, bm.status AS mark_status, t.ref AS task_ref, t.title AS task_title,
              d.full_name AS decided_by_name
         FROM black_mark_appeals a JOIN black_marks bm ON bm.id = a.mark_id JOIN users u ON u.id = a.user_id
         LEFT JOIN tasks t ON t.id = bm.task_id LEFT JOIN users d ON d.id = a.decided_by
        WHERE ($1::boolean OR a.user_id = $2) AND ($3::text IS NULL OR a.status = $3)
        ORDER BY (a.status = 'OPEN') DESC, a.created_at DESC LIMIT 200`,
      [reviewer, req.currentUser.id, status],
    );
    res.json({ appeals: rows, can_decide: reviewer });
  }),
);

/** Someone who may waive marks decides an appeal: uphold the mark, or waive it. Never their own. */
router.post(
  '/appeals/:id/decide',
  requirePermission('blackmark.waive'),
  asyncHandler(async (req, res) => {
    const body = z.object({ decision: z.enum(['UPHOLD', 'WAIVE']), reason: z.string().trim().min(5).max(1000) }).parse(req.body || {});
    const { rows: [appeal] } = await query('SELECT * FROM black_mark_appeals WHERE id = $1', [Number(req.params.id)]);
    if (!appeal) throw notFound('Appeal not found');
    if (appeal.status !== 'OPEN') throw badRequest('This appeal has already been decided');
    if (appeal.user_id === req.currentUser.id) throw forbidden('Someone else has to decide your own appeal');
    const { rows: [before] } = await query('SELECT * FROM black_marks WHERE id = $1', [appeal.mark_id]);
    const status = body.decision === 'WAIVE' ? 'WAIVED' : 'UPHELD';
    await query(
      `UPDATE black_mark_appeals SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1`,
      [appeal.id, status, req.currentUser.id, body.reason],
    );
    if (body.decision === 'WAIVE') {
      const { rows } = await query(
        `UPDATE black_marks SET status = 'waived', waived_by = $1, waived_reason = $2, waived_at = now() WHERE id = $3 RETURNING *`,
        [req.currentUser.id, `Appeal #${appeal.id} upheld: ${body.reason}`, appeal.mark_id],
      );
      await audit(null, {
        entityType: 'BLACK_MARK', entityId: appeal.mark_id, subjectUserId: before.user_id, actorId: req.currentUser.id,
        action: 'WAIVED', reason: body.reason, before: markState(before), after: markState(rows[0]), source: `appeal:${appeal.id}`,
      });
    } else {
      await audit(null, {
        entityType: 'BLACK_MARK', entityId: appeal.mark_id, subjectUserId: before.user_id, actorId: req.currentUser.id,
        action: 'APPEAL_DECLINED', reason: body.reason, source: `appeal:${appeal.id}`,
      });
    }
    await notify(null, {
      userId: appeal.user_id, type: 'blackmark_appeal',
      title: body.decision === 'WAIVE' ? 'Your appeal was accepted: the mark is waived' : 'Your appeal was not accepted: the mark stands',
      body: body.reason, taskId: before.task_id,
    });
    res.json({ status });
  }),
);

router.post(
  '/appeals/:id/withdraw',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE black_mark_appeals SET status = 'WITHDRAWN', decided_at = now() WHERE id = $1 AND user_id = $2 AND status = 'OPEN' RETURNING *`,
      [Number(req.params.id), req.currentUser.id],
    );
    if (!rows[0]) throw badRequest('Only your own waiting appeal can be withdrawn');
    res.json({ appeal: rows[0] });
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

const markState = (m) => ({ status: m.status, waived_by: m.waived_by, waived_reason: m.waived_reason, waived_at: m.waived_at });

// Each waive and restore is written to the audit trail with the state before
// and after, so restoring a mark never loses who waived it and why.
router.post(
  '/:id/waive',
  requirePermission('blackmark.waive'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const { rows: [before] } = await query('SELECT * FROM black_marks WHERE id = $1', [Number(req.params.id)]);
    if (!before) throw notFound('Black mark not found');
    const { rows } = await query(
      `UPDATE black_marks
          SET status = 'waived', waived_by = $1, waived_reason = $2, waived_at = now()
        WHERE id = $3 RETURNING *`,
      [req.currentUser.id, reason, before.id],
    );
    await audit(null, {
      entityType: 'BLACK_MARK', entityId: before.id, subjectUserId: before.user_id, actorId: req.currentUser.id,
      action: 'WAIVED', reason, before: markState(before), after: markState(rows[0]), source: 'black_marks_page',
    });
    res.json({ mark: rows[0] });
  }),
);

router.post(
  '/:id/restore',
  requirePermission('blackmark.waive'),
  asyncHandler(async (req, res) => {
    const { rows: [before] } = await query('SELECT * FROM black_marks WHERE id = $1', [Number(req.params.id)]);
    if (!before) throw notFound('Black mark not found');
    const { rows } = await query(
      `UPDATE black_marks SET status = 'active', waived_by = NULL, waived_reason = NULL, waived_at = NULL
        WHERE id = $1 RETURNING *`,
      [before.id],
    );
    await audit(null, {
      entityType: 'BLACK_MARK', entityId: before.id, subjectUserId: before.user_id, actorId: req.currentUser.id,
      action: 'RESTORED', reason: req.body?.reason || null, before: markState(before), after: markState(rows[0]), source: 'black_marks_page',
    });
    res.json({ mark: rows[0] });
  }),
);

/** Marks the calendar in force no longer supports, for someone to look at. Nothing changes here. */
router.get(
  '/recheck',
  requirePermission('blackmark.waive'),
  asyncHandler(async (req, res) => {
    res.json({ marks: await marksToRecheck() });
  }),
);

/**
 * Where a mark came from and everything that happened to it: the task and
 * rule, the evidence recorded with it (the rule as it stood, the deadline and
 * the deadline in force, the attendance policy version), every waive and
 * restore, and any holiday correction that touched it.
 */
router.get(
  '/:id/history',
  requirePermission('blackmark.view'),
  asyncHandler(async (req, res) => {
    const { rows: [mark] } = await query(
      `SELECT bm.*, u.full_name, t.ref AS task_ref, t.title AS task_title, t.due_date AS task_due_date,
              r.name AS rule_name, r.trigger_type, r.points AS rule_points_now, r.grace_hours AS rule_grace_hours_now,
              r.updated_at AS rule_updated_at, w.full_name AS waived_by_name, c.full_name AS created_by_name
         FROM black_marks bm JOIN users u ON u.id = bm.user_id
         LEFT JOIN tasks t ON t.id = bm.task_id LEFT JOIN blackmark_rules r ON r.id = bm.rule_id
         LEFT JOIN users w ON w.id = bm.waived_by LEFT JOIN users c ON c.id = bm.created_by
        WHERE bm.id = $1`,
      [Number(req.params.id)],
    );
    if (!mark) throw notFound('Black mark not found');
    const wide = hasPermission(req.currentUser, 'blackmark.waive') || hasPermission(req.currentUser, 'report.view');
    if (!wide && mark.user_id !== req.currentUser.id) throw forbidden('You can only see your own marks');
    const { rows: corrections } = await query(
      `SELECT c.id, c.request_id, c.kind, c.status, c.summary, c.work_date, c.decided_at, c.decision_note, c.reversed_at, c.reverse_reason,
              d.full_name AS decided_by_name, x.full_name AS reversed_by_name, r.action AS request_action, r.name AS holiday_name
         FROM holiday_corrections c JOIN holiday_requests r ON r.id = c.request_id
         LEFT JOIN users d ON d.id = c.decided_by LEFT JOIN users x ON x.id = c.reversed_by
        WHERE (c.target_type = 'BLACK_MARK' AND c.target_id = $1)
           OR (c.target_type = 'TASK' AND c.target_key = $2)
        ORDER BY c.created_at`,
      [mark.id, mark.occurrence_key],
    );
    const { rows: trail } = await query(
      `SELECT a.id, a.action, a.reason, a.before, a.after, a.source, a.created_at, u.full_name AS actor_name
         FROM attendance_audit a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.entity_type = 'BLACK_MARK' AND a.entity_id = $1 ORDER BY a.created_at`,
      [String(mark.id)],
    );
    res.json({ mark, evidence: mark.evidence || null, corrections, audit: trail });
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
