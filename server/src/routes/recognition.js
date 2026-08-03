import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { notify } from '../services/activity.js';
import { leaderboard, awardsFor, award } from '../services/recognition.js';

const router = Router();

router.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    const board = await leaderboard({
      month: req.query.month,
      departmentId: req.query.department_id ? Number(req.query.department_id) : null,
    });
    res.json({ ...board, awards: await awardsFor(req.query.month) });
  }),
);

router.get(
  '/awards',
  asyncHandler(async (req, res) => {
    // the full wall of past winners
    const { rows } = await query(
      `SELECT r.*, u.full_name, u.avatar_color, u.job_title, d.name AS department,
              a.full_name AS awarded_by_name
         FROM recognitions r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN users a ON a.id = r.awarded_by
        ORDER BY r.period_month DESC, r.created_at
        LIMIT 120`,
    );
    res.json({ awards: rows });
  }),
);

router.post(
  '/awards',
  requirePermission('recognition.manage'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        user_id: z.number().int().positive(),
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        title: z.string().max(120).optional(),
        citation: z.string().max(1000).optional(),
      })
      .parse(req.body);

    const recognition = await award({
      userId: data.user_id,
      month: data.month,
      title: data.title,
      citation: data.citation,
      awardedBy: req.currentUser.id,
    });

    await notify(null, {
      userId: data.user_id,
      type: 'recognition',
      title: `🏆 ${recognition.title}`,
      body: recognition.citation || 'Congratulations from the whole team!',
    });

    res.status(201).json({ award: recognition });
  }),
);

router.delete(
  '/awards/:id',
  requirePermission('recognition.manage'),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM recognitions WHERE id = $1', [req.params.id]);
    if (!rowCount) throw notFound('Award not found');
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- kudos

router.get(
  '/kudos',
  asyncHandler(async (req, res) => {
    const params = [];
    let where = '';
    if (req.query.user_id) {
      params.push(Number(req.query.user_id));
      where = `WHERE k.to_user = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT k.*, f.full_name AS from_name, f.avatar_color AS from_color,
              t.full_name AS to_name, t.avatar_color AS to_color,
              task.ref AS task_ref
         FROM kudos k
         JOIN users f ON f.id = k.from_user
         JOIN users t ON t.id = k.to_user
         LEFT JOIN tasks task ON task.id = k.task_id
         ${where}
        ORDER BY k.created_at DESC
        LIMIT 60`,
      params,
    );
    res.json({ kudos: rows });
  }),
);

router.post(
  '/kudos',
  requirePermission('kudos.give'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        to_user: z.number().int().positive(),
        message: z.string().min(3).max(500),
        task_id: z.number().int().positive().nullable().optional(),
      })
      .parse(req.body);

    if (data.to_user === req.currentUser.id) throw badRequest('Kudos are for other people');

    const { rows } = await query(
      `INSERT INTO kudos (from_user, to_user, message, task_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.currentUser.id, data.to_user, data.message.trim(), data.task_id ?? null],
    );

    await notify(null, {
      userId: data.to_user,
      type: 'kudos',
      title: `${req.currentUser.full_name} gave you kudos`,
      body: data.message.trim(),
      taskId: data.task_id ?? null,
    });

    res.status(201).json({ kudos: rows[0] });
  }),
);

export default router;
