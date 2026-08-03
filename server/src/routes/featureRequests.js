import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../lib/permissions.js';
import { notify } from '../services/activity.js';

const router = Router();

const SELECT_REQUEST = `
  SELECT fr.*,
         u.full_name AS created_by_name, u.avatar_color,
         d.name AS department_name,
         r.full_name AS reviewed_by_name,
         (SELECT COUNT(*)::int FROM feature_request_votes v WHERE v.request_id = fr.id) AS votes
    FROM feature_requests fr
    LEFT JOIN users u ON u.id = fr.created_by
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN users r ON r.id = fr.reviewed_by
`;

const requestInput = z.object({
  title: z.string().min(5).max(200),
  detail: z.string().max(5000).nullable().optional(),
  category: z.enum(['feature', 'improvement', 'bug', 'other']).optional(),
  urgency: z.enum(['nice_to_have', 'useful', 'important', 'blocking']).optional(),
  contact: z.string().max(200).nullable().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = [];
    const filters = [];

    if (req.query.status) {
      params.push(req.query.status);
      filters.push(`fr.status = $${params.length}`);
    }
    if (req.query.mine === 'true') {
      params.push(req.currentUser.id);
      filters.push(`fr.created_by = $${params.length}`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await query(
      `${SELECT_REQUEST}
       ${where}
       ORDER BY
         CASE fr.status WHEN 'new' THEN 0 WHEN 'reviewing' THEN 1 WHEN 'planned' THEN 2
                        WHEN 'in_progress' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,
         votes DESC, fr.created_at DESC
       LIMIT 300`,
      params,
    );

    // which ones has the caller already voted for
    const { rows: mine } = await query(
      'SELECT request_id FROM feature_request_votes WHERE user_id = $1',
      [req.currentUser.id],
    );
    const voted = new Set(mine.map((r) => r.request_id));

    res.json({
      requests: rows.map((r) => ({ ...r, has_voted: voted.has(r.id) })),
      can_manage: hasPermission(req.currentUser, 'feature.manage'),
    });
  }),
);

router.post(
  '/',
  requirePermission('feature.request'),
  asyncHandler(async (req, res) => {
    const data = requestInput.parse(req.body);

    const { rows } = await query(
      `INSERT INTO feature_requests (title, detail, category, urgency, contact, created_by)
       VALUES ($1, $2, COALESCE($3,'feature'), COALESCE($4,'useful'), $5, $6)
       RETURNING id`,
      [
        data.title.trim(),
        data.detail?.trim() || null,
        data.category ?? null,
        data.urgency ?? null,
        data.contact?.trim() || req.currentUser.email,
        req.currentUser.id,
      ],
    );

    // let every admin know there is something to look at
    const { rows: admins } = await query(
      `SELECT id FROM users WHERE is_active = TRUE AND role IN ('admin', 'manager')`,
    );
    for (const admin of admins) {
      if (admin.id === req.currentUser.id) continue;
      await notify(null, {
        userId: admin.id,
        type: 'feature_request',
        title: `Feature request from ${req.currentUser.full_name}`,
        body: data.title,
      });
    }

    const { rows: created } = await query(`${SELECT_REQUEST} WHERE fr.id = $1`, [rows[0].id]);
    res.status(201).json({ request: created[0] });
  }),
);

router.post(
  '/:id/vote',
  asyncHandler(async (req, res) => {
    const { rows: exists } = await query('SELECT id FROM feature_requests WHERE id = $1', [req.params.id]);
    if (!exists[0]) throw notFound('Request not found');

    const { rowCount } = await query(
      'DELETE FROM feature_request_votes WHERE request_id = $1 AND user_id = $2',
      [req.params.id, req.currentUser.id],
    );
    if (!rowCount) {
      await query('INSERT INTO feature_request_votes (request_id, user_id) VALUES ($1, $2)', [
        req.params.id,
        req.currentUser.id,
      ]);
    }

    const { rows } = await query(`${SELECT_REQUEST} WHERE fr.id = $1`, [req.params.id]);
    res.json({ request: { ...rows[0], has_voted: !rowCount } });
  }),
);

router.patch(
  '/:id',
  requirePermission('feature.manage'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        status: z.enum(['new', 'reviewing', 'planned', 'in_progress', 'done', 'declined']).optional(),
        admin_note: z.string().max(2000).nullable().optional(),
      })
      .parse(req.body);

    const fields = [];
    const params = [];
    for (const key of ['status', 'admin_note']) {
      if (data[key] !== undefined) {
        params.push(data[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (!fields.length) throw badRequest('Nothing to update');

    params.push(req.currentUser.id, req.params.id);
    const { rows } = await query(
      `UPDATE feature_requests SET ${fields.join(', ')}, reviewed_by = $${params.length - 1}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING created_by, title, status`,
      params,
    );
    if (!rows[0]) throw notFound('Request not found');

    if (data.status && rows[0].created_by && rows[0].created_by !== req.currentUser.id) {
      await notify(null, {
        userId: rows[0].created_by,
        type: 'feature_update',
        title: `Your request is now "${data.status.replace(/_/g, ' ')}"`,
        body: rows[0].title,
      });
    }

    const { rows: updated } = await query(`${SELECT_REQUEST} WHERE fr.id = $1`, [req.params.id]);
    res.json({ request: updated[0] });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT created_by FROM feature_requests WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw notFound('Request not found');
    if (rows[0].created_by !== req.currentUser.id && !hasPermission(req.currentUser, 'feature.manage')) {
      throw badRequest('You can only withdraw your own requests');
    }
    await query('DELETE FROM feature_requests WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }),
);

export default router;
