import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';

const router = Router();

export const STAGES = ['backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled'];

const slugify = (value) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const statusInput = z.object({
  name: z.string().min(2).max(60),
  stage: z.enum(STAGES),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  position: z.number().int().optional(),
  wip_limit: z.number().int().min(1).nullable().optional(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.*, COUNT(t.id) FILTER (WHERE t.is_archived = FALSE)::int AS task_count
         FROM workflow_statuses s
         LEFT JOIN tasks t ON t.status_id = s.id
        ${req.query.active === 'all' ? '' : 'WHERE s.is_active = TRUE'}
        GROUP BY s.id
        ORDER BY s.position, s.id`,
    );
    res.json({ statuses: rows, stages: STAGES });
  }),
);

router.post(
  '/',
  requirePermission('workflow.manage'),
  asyncHandler(async (req, res) => {
    const data = statusInput.parse(req.body);
    if (data.is_default) await query('UPDATE workflow_statuses SET is_default = FALSE');

    const { rows } = await query(
      `INSERT INTO workflow_statuses (name, slug, stage, color, position, wip_limit, is_default)
       VALUES ($1, $2, $3, COALESCE($4, '#64748b'),
               COALESCE($5, (SELECT COALESCE(MAX(position), 0) + 1 FROM workflow_statuses)),
               $6, COALESCE($7, FALSE))
       RETURNING *`,
      [
        data.name,
        slugify(data.name),
        data.stage,
        data.color ?? null,
        data.position ?? null,
        data.wip_limit ?? null,
        data.is_default ?? null,
      ],
    );
    res.status(201).json({ status: rows[0] });
  }),
);

router.patch(
  '/:id',
  requirePermission('workflow.manage'),
  asyncHandler(async (req, res) => {
    const data = statusInput.partial().parse(req.body);
    if (data.is_default) await query('UPDATE workflow_statuses SET is_default = FALSE');

    const fields = [];
    const params = [];
    for (const key of ['name', 'stage', 'color', 'position', 'wip_limit', 'is_default', 'is_active']) {
      if (data[key] !== undefined) {
        params.push(data[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (data.name !== undefined) {
      params.push(slugify(data.name));
      fields.push(`slug = $${params.length}`);
    }
    if (!fields.length) throw badRequest('Nothing to update');

    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE workflow_statuses SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Status not found');

    // If this status is now a done stage, tasks sitting in it are complete —
    // stamp completed_at so they show up in the completion figures rather than
    // becoming board-done but month-invisible.
    if (data.stage === 'done') {
      await query(
        `UPDATE tasks
            SET completed_at = COALESCE(completed_at, updated_at, created_at, now()),
                progress = 100
          WHERE status_id = $1 AND completed_at IS NULL`,
        [req.params.id],
      );
    }

    res.json({ status: rows[0] });
  }),
);

/** Reorder the whole board in one call: { order: [statusId, ...] } */
router.post(
  '/reorder',
  requirePermission('workflow.manage'),
  asyncHandler(async (req, res) => {
    const { order } = z.object({ order: z.array(z.number().int()) }).parse(req.body);
    for (const [index, id] of order.entries()) {
      await query('UPDATE workflow_statuses SET position = $1 WHERE id = $2', [index + 1, id]);
    }
    const { rows } = await query('SELECT * FROM workflow_statuses ORDER BY position');
    res.json({ statuses: rows });
  }),
);

router.delete(
  '/:id',
  requirePermission('workflow.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { rows: counts } = await query('SELECT COUNT(*)::int AS n FROM tasks WHERE status_id = $1', [id]);

    if (counts[0].n > 0) {
      const moveTo = Number(req.query.move_to);
      if (!moveTo) {
        throw badRequest(
          `This status still holds ${counts[0].n} card(s). Pass ?move_to=<statusId> to move them first.`,
        );
      }
      await query('UPDATE tasks SET status_id = $1 WHERE status_id = $2', [moveTo, id]);
    }

    const { rows: remaining } = await query('SELECT COUNT(*)::int AS n FROM workflow_statuses WHERE id <> $1', [id]);
    if (remaining[0].n === 0) throw badRequest('At least one status must remain');

    await query('DELETE FROM workflow_statuses WHERE id = $1', [id]);
    res.json({ ok: true });
  }),
);

export default router;
