/**
 * Saved board views: a name for a set of filters (the board's URL query).
 * Personal by default; a department's manager can share one with everyone in
 * that department.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { managedDepartmentIds } from '../services/taskPeople.js';

const router = Router();

// only the board's own filters are kept, so a saved view cannot carry anything else
const ALLOWED = new Set(['department_id', 'assignee_id', 'supporter_id', 'priority', 'stage', 'status_id', 'search', 'due', 'due_from', 'due_to', 'sort', 'exclude_stage', 'view', 'show_done']);
const cleanQuery = (raw) => {
  const params = new URLSearchParams(String(raw || '').replace(/^\?/, ''));
  const out = new URLSearchParams();
  for (const [k, v] of params) if (ALLOWED.has(k) && v) out.set(k, v.slice(0, 200));
  return out.toString();
};

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT v.*, u.full_name AS owner_name, d.name AS department_name
         FROM task_saved_views v JOIN users u ON u.id = v.user_id LEFT JOIN departments d ON d.id = v.department_id
        WHERE v.user_id = $1 OR v.department_id = $2
        ORDER BY (v.user_id = $1) DESC, v.name`,
      [req.currentUser.id, req.currentUser.department_id],
    );
    res.json({ views: rows.map((v) => ({ ...v, mine: v.user_id === req.currentUser.id })), can_share: await managedDepartmentIds(req.currentUser) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = z.object({
      name: z.string().trim().min(2).max(60),
      query: z.string().max(1000),
      department_id: z.number().int().positive().nullable().optional(),
    }).parse(req.body);
    const q = cleanQuery(body.query);
    if (!q) throw badRequest('Choose some filters first, then save them as a view');
    if (body.department_id) {
      const managed = await managedDepartmentIds(req.currentUser);
      if (!managed.includes(body.department_id) && !hasPermission(req.currentUser, 'task.view.all')) {
        throw forbidden('Only a manager of that department can share a view with it');
      }
    }
    const { rows } = await query(
      `INSERT INTO task_saved_views (user_id, name, query, department_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.currentUser.id, body.name, q, body.department_id ?? null],
    );
    res.status(201).json({ view: rows[0] });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM task_saved_views WHERE id = $1', [Number(req.params.id)]);
    if (!rows[0]) throw notFound('View not found');
    if (rows[0].user_id !== req.currentUser.id) throw forbidden('Only the person who saved a view can remove it');
    // a saved view is a person's own shortcut, not company data: removing it is theirs to do
    await query('DELETE FROM task_saved_views WHERE id = $1', [rows[0].id]);
    res.json({ ok: true });
  }),
);

export default router;
