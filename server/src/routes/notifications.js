import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../lib/errors.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT n.*, t.ref AS task_ref
         FROM notifications n
         LEFT JOIN tasks t ON t.id = n.task_id
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT 50`,
      [req.currentUser.id],
    );
    const unread = rows.filter((r) => !r.is_read).length;
    res.json({ notifications: rows, unread });
  }),
);

router.post(
  '/read',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (ids) {
      await query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND id = ANY($2)', [
        req.currentUser.id,
        ids,
      ]);
    } else {
      await query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.currentUser.id]);
    }
    res.json({ ok: true });
  }),
);

export default router;
