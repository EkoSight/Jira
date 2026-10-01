import { Router } from 'express';
import { z } from 'zod';

import { query } from '../db/pool.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { chatConfig, verifyIncoming } from '../lib/googleChat.js';
import {
  ALERT_TYPE_LABEL, deliverOutbox, directSpaceFor, getPreferences, handleChatEvent, sendTest, setPreferences,
} from '../services/googleChat.js';

/**
 * Where Google Chat sends events (someone adds the app, sends it a message,
 * removes it). Public — Google carries no TaskFlow login — so every request
 * must carry a token Google signed for this endpoint, checked before the body
 * is read.
 */
export const chatEventsRouter = Router();

chatEventsRouter.post('/', async (req, res) => {
  try {
    await verifyIncoming(req.headers.authorization);
  } catch (err) {
    console.warn('[taskflow] rejected a Google Chat request:', err.message);
    return res.status(401).json({ error: 'Not a verified Google Chat request' });
  }
  try {
    res.json(await handleChatEvent(req.body || {}));
  } catch (err) {
    console.error('[taskflow] Google Chat event failed', err);
    // Chat shows the person a polite failure rather than nothing
    res.json({ text: 'Something went wrong in TaskFlow. Please try again in a minute.' });
  }
});

/** Signed-in routes: your own Chat link, and the admin's view of the set-up. */
const router = Router();

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const space = await directSpaceFor(req.currentUser.id);
    res.json({
      configured: chatConfig().configured,
      linked: Boolean(space),
      linked_at: space?.updated_at || null,
      preferences: await getPreferences(req.currentUser.id),
    });
  }),
);

router.put(
  '/me/preferences',
  asyncHandler(async (req, res) => {
    const body = z.object({ instant: z.boolean().optional(), morning_summary: z.boolean().optional() }).parse(req.body);
    res.json({ preferences: await setPreferences(req.currentUser.id, body) });
  }),
);

router.post(
  '/me/test',
  asyncHandler(async (req, res) => {
    if (!chatConfig().configured) throw badRequest('Google Chat is not set up on the server yet');
    const result = await sendTest(req.currentUser.id);
    if (result.reason === 'NOT_LINKED') throw badRequest('Add the TaskFlow app in Google Chat first, then try again');
    res.json(result);
  }),
);

router.get(
  '/admin',
  requirePermission('settings.manage'),
  asyncHandler(async (req, res) => {
    const cfg = chatConfig();
    const { rows: spaces } = await query(
      `SELECT sp.id, sp.space_name, sp.kind, sp.display_name, sp.user_id, sp.department_id, sp.team_summary, sp.active,
              sp.added_by_email, sp.created_at, sp.updated_at, u.full_name, d.name AS department_name
         FROM chat_spaces sp LEFT JOIN users u ON u.id = sp.user_id LEFT JOIN departments d ON d.id = sp.department_id
        ORDER BY sp.active DESC, sp.kind, COALESCE(u.full_name, sp.display_name)`,
    );
    const { rows: people } = await query(
      `SELECT u.id, u.full_name, u.email, u.avatar_color,
              EXISTS (SELECT 1 FROM chat_spaces sp WHERE sp.kind = 'DM' AND sp.user_id = u.id AND sp.active) AS linked
         FROM users u WHERE u.is_active ORDER BY u.full_name`,
    );
    const { rows: counts } = await query(
      `SELECT status, COUNT(*)::int AS n FROM chat_outbox
        WHERE created_at > now() - interval '7 days' AND NOT (payload ? 'skipped') GROUP BY status`,
    );
    const { rows: failures } = await query(
      `SELECT o.id, o.kind, o.space_name, o.last_error, o.attempts, o.created_at, u.full_name
         FROM chat_outbox o LEFT JOIN users u ON u.id = o.user_id
        WHERE o.status = 'FAILED' AND o.created_at > now() - interval '7 days'
        ORDER BY o.id DESC LIMIT 20`,
    );
    res.json({
      configured: cfg.configured,
      usable: cfg.usable,
      // what is wrong with the key, in words — never the key itself
      key_problem: cfg.keyProblem,
      // which service account, so an admin can check it matches Google Cloud; never the key
      client_email: cfg.clientEmail || null,
      project_id: cfg.projectId || null,
      endpoint_url: cfg.endpointUrl,
      alert_types: ALERT_TYPE_LABEL,
      spaces,
      people,
      last_7_days: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      failures,
    });
  }),
);

router.patch(
  '/admin/spaces/:id',
  requirePermission('settings.manage'),
  asyncHandler(async (req, res) => {
    const body = z.object({
      department_id: z.number().int().nullable().optional(),
      team_summary: z.boolean().optional(),
    }).parse(req.body);
    const { rows } = await query(
      `UPDATE chat_spaces SET department_id = CASE WHEN $2 THEN $3 ELSE department_id END,
              team_summary = COALESCE($4, team_summary), updated_at = now()
        WHERE id = $1 AND kind = 'SPACE' RETURNING *`,
      [Number(req.params.id), 'department_id' in body, body.department_id ?? null, body.team_summary ?? null],
    );
    if (!rows[0]) throw notFound('Space not found');
    res.json({ space: rows[0] });
  }),
);

/** Try failed messages again — after fixing credentials, say. */
router.post(
  '/admin/retry',
  requirePermission('settings.manage'),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(
      `UPDATE chat_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = now()
        WHERE status = 'FAILED' AND created_at > now() - interval '2 days'`,
    );
    const result = await deliverOutbox();
    res.json({ retried: rowCount, ...result });
  }),
);

export default router;
