import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';

const router = Router();

const slugify = (value) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const departmentInput = z.object({
  name: z.string().min(2).max(80),
  key: z.string().min(2).max(10).regex(/^[A-Za-z0-9]+$/, 'Key must be letters and numbers only').optional(),
  description: z.string().max(500).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  position: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT d.*,
              COUNT(t.id) FILTER (WHERE t.is_archived = FALSE)::int AS task_count,
              COUNT(DISTINCT u.id)::int                             AS member_count
         FROM departments d
         LEFT JOIN tasks t ON t.department_id = d.id
         LEFT JOIN users u ON u.department_id = d.id AND u.is_active = TRUE
        ${req.query.active === 'all' ? '' : 'WHERE d.is_active = TRUE'}
        GROUP BY d.id
        ORDER BY d.position, d.name`,
    );
    res.json({ departments: rows });
  }),
);

router.post(
  '/',
  requirePermission('department.manage'),
  asyncHandler(async (req, res) => {
    const data = departmentInput.parse(req.body);
    const key = (data.key || slugify(data.name).replace(/-/g, '').slice(0, 4)).toUpperCase();

    const { rows } = await query(
      `INSERT INTO departments (name, key, description, color, position)
       VALUES ($1, $2, $3, COALESCE($4, '#64748b'),
               COALESCE($5, (SELECT COALESCE(MAX(position), 0) + 1 FROM departments)))
       RETURNING *`,
      [data.name, key, data.description ?? null, data.color ?? null, data.position ?? null],
    );
    res.status(201).json({ department: rows[0] });
  }),
);

router.patch(
  '/:id',
  requirePermission('department.manage'),
  asyncHandler(async (req, res) => {
    const data = departmentInput.partial().parse(req.body);
    const fields = [];
    const params = [];

    for (const key of ['name', 'key', 'description', 'color', 'position', 'is_active']) {
      if (data[key] !== undefined) {
        params.push(key === 'key' ? String(data[key]).toUpperCase() : data[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (!fields.length) throw badRequest('Nothing to update');

    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE departments SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Department not found');
    res.json({ department: rows[0] });
  }),
);

router.delete(
  '/:id',
  requirePermission('department.manage'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM tasks WHERE department_id = $1',
      [req.params.id],
    );
    if (rows[0].n > 0) {
      // keep the history — deactivating hides it from pickers without breaking cards
      await query('UPDATE departments SET is_active = FALSE WHERE id = $1', [req.params.id]);
      return res.json({ ok: true, deactivated: true, message: 'Department has tasks, so it was deactivated' });
    }
    await query('DELETE FROM departments WHERE id = $1', [req.params.id]);
    res.json({ ok: true, deactivated: false });
  }),
);

export default router;
