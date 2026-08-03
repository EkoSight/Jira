import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest } from '../lib/errors.js';

const router = Router();

/**
 * Private scratch notes. Nobody — not even an admin — reads someone else's
 * notes: every query is scoped to the signed-in user.
 */

const noteInput = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(20000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  is_pinned: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  task_id: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string().max(40)).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = [req.currentUser.id];
    const filters = ['n.user_id = $1'];

    if (req.query.archived === 'true') filters.push('n.is_archived = TRUE');
    else filters.push('n.is_archived = FALSE');

    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      filters.push(`(n.title ILIKE $${params.length} OR n.body ILIKE $${params.length})`);
    }
    if (req.query.task_id) {
      params.push(Number(req.query.task_id));
      filters.push(`n.task_id = $${params.length}`);
    }

    const { rows } = await query(
      `SELECT n.*, t.ref AS task_ref, t.title AS task_title
         FROM notes n
         LEFT JOIN tasks t ON t.id = n.task_id
        WHERE ${filters.join(' AND ')}
        ORDER BY n.is_pinned DESC, n.updated_at DESC
        LIMIT 300`,
      params,
    );
    res.json({ notes: rows });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = noteInput.parse(req.body);
    if (!data.title?.trim() && !data.body?.trim()) throw badRequest('Write something first');

    const { rows } = await query(
      `INSERT INTO notes (user_id, title, body, color, task_id, tags)
       VALUES ($1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,'#fef3c7'), $5,
               COALESCE($6::text[],'{}'::text[]))
       RETURNING *`,
      [
        req.currentUser.id,
        data.title ?? null,
        data.body ?? null,
        data.color ?? null,
        data.task_id ?? null,
        data.tags ?? null,
      ],
    );
    res.status(201).json({ note: rows[0] });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = noteInput.parse(req.body);

    const fields = [];
    const params = [];
    for (const key of ['title', 'body', 'color', 'is_pinned', 'is_archived', 'task_id', 'tags']) {
      if (data[key] !== undefined) {
        params.push(data[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (!fields.length) throw badRequest('Nothing to update');

    params.push(req.params.id, req.currentUser.id);
    const { rows } = await query(
      `UPDATE notes SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length - 1} AND user_id = $${params.length}
        RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Note not found');
    res.json({ note: rows[0] });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.currentUser.id,
    ]);
    if (!rowCount) throw notFound('Note not found');
    res.json({ ok: true });
  }),
);

export default router;
