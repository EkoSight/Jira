import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { canSeeRecord, recordLabel } from '../services/workspace/access.js';

const router = Router();

/**
 * The bell. Besides read and unread, a notification can be resolved (what it
 * was about no longer needs anyone), snoozed by its reader until a time, or
 * cancelled. Older notifications have none of these and work as before.
 *
 * A notification about a record the reader can no longer see keeps its row
 * but shows a neutral "not available", with no title or contact.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT n.*, t.ref AS task_ref, o.title AS objective_title, a.name AS account_name
         FROM notifications n
         LEFT JOIN tasks t ON t.id = n.task_id
         LEFT JOIN objectives o ON o.id = n.objective_id
         LEFT JOIN accounts a ON a.id = n.account_id
        WHERE n.user_id = $1
          AND (n.snoozed_until IS NULL OR n.snoozed_until <= now())
        ORDER BY n.created_at DESC
        LIMIT 50`,
      [req.currentUser.id],
    );
    const out = [];
    for (const n of rows) {
      if (n.entity_type && n.entity_id && !(await canSeeRecord(req.currentUser, n.entity_type, n.entity_id))) {
        out.push({ id: n.id, type: n.type, is_read: n.is_read, created_at: n.created_at, entity_type: n.entity_type, available: false,
          title: 'This item is not available to you', body: null, resolved_at: n.resolved_at, cancelled_at: n.cancelled_at });
        continue;
      }
      out.push({ ...n, available: true });
    }
    const { rows: snoozed } = await query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND snoozed_until > now()', [req.currentUser.id]);
    // what still asks for the reader's eye: unread, not resolved or cancelled
    const unread = out.filter((r) => !r.is_read && !r.resolved_at && !r.cancelled_at).length;
    res.json({ notifications: out, unread, snoozed: snoozed[0].n });
  }),
);

/** Reading marks it read; it never completes, approves or moves anything. */
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

async function own(req) {
  const { rows } = await query('SELECT * FROM notifications WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.currentUser.id]);
  if (!rows[0]) throw notFound('Notification not found');
  return rows[0];
}

/**
 * Snooze: this notification leaves the reader's bell until then. The record,
 * its deadline, its owner and its state do not change, and still show
 * everywhere else.
 */
router.post(
  '/:id/snooze',
  asyncHandler(async (req, res) => {
    const n = await own(req);
    const { until } = z.object({ until: z.string() }).parse(req.body || {});
    const at = new Date(until);
    if (Number.isNaN(at.getTime()) || at <= new Date()) throw badRequest('Choose a time in the future');
    if (at > new Date(Date.now() + 90 * 86_400_000)) throw badRequest('Snooze for at most 90 days');
    await query('UPDATE notifications SET snoozed_until = $2, is_read = TRUE, updated_at = now() WHERE id = $1', [n.id, at]);
    res.json({ ok: true, snoozed_until: at, note: 'Only your bell changes. The record, its dates and its owner stay as they are.' });
  }),
);

router.post(
  '/:id/unsnooze',
  asyncHandler(async (req, res) => {
    const n = await own(req);
    await query('UPDATE notifications SET snoozed_until = NULL, updated_at = now() WHERE id = $1', [n.id]);
    res.json({ ok: true });
  }),
);

/** Where "Open" goes, checked now: a record the reader cannot see is "not available". */
router.get(
  '/:id/open',
  asyncHandler(async (req, res) => {
    const n = await own(req);
    if (!n.entity_type) return res.json({ available: true, url: null });
    if (!(await canSeeRecord(req.currentUser, n.entity_type, n.entity_id))) return res.json({ available: false, url: null });
    const label = await recordLabel(n.entity_type, n.entity_id);
    res.json({ available: Boolean(label), url: label?.url || null, label: label?.label || null });
  }),
);

export default router;
