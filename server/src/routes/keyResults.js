import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { notify } from '../services/activity.js';
import {
  KEY_RESULT_STATUSES,
  HEALTH_STATUSES,
  MEASUREMENT_TYPES,
  DIRECTIONS,
  CONFIDENCE_LEVELS,
} from '../lib/okrConstants.js';
import {
  KEY_RESULT_SELECT,
  getKeyResult,
  getObjective,
  listKeyResults,
  decorateKeyResult,
  healthThresholds,
  logOkrActivity,
} from '../services/okr.js';
import { visibilityClause, canAccess } from './tasks.js';

const router = Router();

/**
 * Who may change a key result: whoever owns it, whoever owns the objective it
 * belongs to, or someone with okr.manage.any. Ownership at either level is
 * enough — the same shape as canEdit() for tasks.
 */
async function loadKeyResult(id) {
  const { rows } = await query(
    `SELECT kr.*, o.owner_user_id AS objective_owner_id, o.title AS objective_title,
            o.start_date AS objective_start_date, o.end_date AS objective_end_date,
            o.is_archived AS objective_archived
       FROM key_results kr JOIN objectives o ON o.id = kr.objective_id
      WHERE kr.id = $1`,
    [id],
  );
  return rows[0] || null;
}

export const canManageKeyResult = (user, keyResult) =>
  hasPermission(user, 'okr.manage.any')
  || keyResult.owner_user_id === user.id
  || keyResult.objective_owner_id === user.id;

const keyResultInput = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(5000).nullable().optional(),
  owner_user_id: z.number().int().positive(),
  measurement_type: z.enum(MEASUREMENT_TYPES),
  direction: z.enum(DIRECTIONS),
  baseline_value: z.number(),
  target_value: z.number().nullable(),
  current_value: z.number(),
  unit: z.string().max(30).nullable(),
  weight: z.number().min(0).max(1000),
  status: z.enum(KEY_RESULT_STATUSES),
  start_date: z.string().min(8).nullable(),
  end_date: z.string().min(8).nullable(),
});

// ---------------------------------------------------------------- list

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const thresholds = await healthThresholds();
    const params = [];
    const where = ['kr.is_archived = FALSE', 'o.is_archived = FALSE'];

    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (req.query.owner_id) where.push(`kr.owner_user_id = ${push(Number(req.query.owner_id))}`);
    if (req.query.objective_id) where.push(`kr.objective_id = ${push(Number(req.query.objective_id))}`);
    if (req.query.status) where.push(`kr.status = ${push(req.query.status)}`);
    if (req.query.department_id) where.push(`o.department_id = ${push(Number(req.query.department_id))}`);

    const { rows } = await query(
      `${KEY_RESULT_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY kr.last_check_in_at NULLS FIRST, kr.id
        LIMIT 300`,
      params,
    );

    // the objective's period comes through KEY_RESULT_SELECT, so no second query
    const keyResults = rows.map((row) => decorateKeyResult(row, null, thresholds));

    res.json({
      key_results: req.query.health ? keyResults.filter((k) => k.health === req.query.health) : keyResults,
    });
  }),
);

// ---------------------------------------------------------------- detail

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const keyResult = await getKeyResult(Number(req.params.id));
    if (!keyResult) throw notFound('Key result not found');

    const [checkIns, activity, raw] = await Promise.all([
      query(
        `SELECT c.*, u.full_name AS user_name, u.avatar_color
           FROM key_result_check_ins c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.key_result_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
        [keyResult.id],
      ),
      query(
        `SELECT a.*, u.full_name AS actor_name
           FROM okr_activity a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.entity_type = 'KEY_RESULT' AND a.entity_id = $1
          ORDER BY a.created_at DESC LIMIT 50`,
        [keyResult.id],
      ),
      loadKeyResult(Number(req.params.id)),
    ]);

    res.json({
      key_result: keyResult,
      check_ins: checkIns.rows,
      activity: activity.rows,
      can_edit: canManageKeyResult(req.currentUser, raw),
      can_check_in:
        hasPermission(req.currentUser, 'okr.checkin') && canManageKeyResult(req.currentUser, raw),
    });
  }),
);

// ---------------------------------------------------------------- update

const TRACKED = [
  'title', 'description', 'owner_user_id', 'measurement_type', 'direction',
  'baseline_value', 'target_value', 'unit', 'weight', 'status', 'start_date', 'end_date',
];

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = keyResultInput.partial().parse(req.body);
    const id = Number(req.params.id);

    const existing = await loadKeyResult(id);
    if (!existing) throw notFound('Key result not found');
    if (!canManageKeyResult(req.currentUser, existing)) {
      throw forbidden('Only the key result or objective owner can change it');
    }

    // the current value moves through a check-in so the history stays complete
    if (data.current_value !== undefined && Number(data.current_value) !== Number(existing.current_value)) {
      throw badRequest('Post a check-in to change the current value');
    }

    await withTransaction(async (client) => {
      const fields = [];
      const params = [];
      for (const key of TRACKED) {
        if (data[key] === undefined) continue;
        params.push(data[key]);
        fields.push(`${key} = $${params.length}`);
      }
      if (!fields.length) return;

      params.push(id);
      await client.query(
        `UPDATE key_results SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
        params,
      );

      for (const key of TRACKED) {
        if (data[key] === undefined) continue;
        if (String(existing[key] ?? '') === String(data[key] ?? '')) continue;
        await logOkrActivity(client, {
          entityType: 'KEY_RESULT',
          entityId: id,
          actorId: req.currentUser.id,
          action: 'updated',
          field: key,
          from: existing[key],
          to: data[key],
        });
      }
    });

    res.json({ key_result: await getKeyResult(id) });
  }),
);

// ---------------------------------------------------------------- archive

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await loadKeyResult(id);
    if (!existing) throw notFound('Key result not found');
    if (!canManageKeyResult(req.currentUser, existing)) {
      throw forbidden('Only the key result or objective owner can archive it');
    }

    // archived, never deleted: its check-in history is the record of what happened
    await query('UPDATE key_results SET is_archived = TRUE, updated_at = now() WHERE id = $1', [id]);
    await logOkrActivity(null, {
      entityType: 'KEY_RESULT',
      entityId: id,
      actorId: req.currentUser.id,
      action: 'archived',
    });

    const objective = await getObjective(existing.objective_id);
    res.json({ ok: true, archived: true, key_results: await listKeyResults(existing.objective_id, objective) });
  }),
);

// ---------------------------------------------------------------- check-ins

router.get(
  '/:id/check-ins',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT c.*, u.full_name AS user_name, u.avatar_color
         FROM key_result_check_ins c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.key_result_id = $1 ORDER BY c.created_at DESC LIMIT 200`,
      [Number(req.params.id)],
    );
    res.json({ check_ins: rows });
  }),
);

const checkInInput = z.object({
  current_value: z.number(),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  note: z.string().max(5000).optional(),
  next_action: z.string().max(2000).optional(),
  status: z.enum(KEY_RESULT_STATUSES).optional(),
});

/**
 * A check-in is the only way the current value moves. It appends a row rather
 * than overwriting the last one, so the shape of the progress over time survives.
 */
router.post(
  '/:id/check-ins',
  requirePermission('okr.checkin'),
  asyncHandler(async (req, res) => {
    const data = checkInInput.parse(req.body);
    const id = Number(req.params.id);

    const existing = await loadKeyResult(id);
    if (!existing) throw notFound('Key result not found');
    if (!canManageKeyResult(req.currentUser, existing)) {
      throw forbidden('Only the key result or objective owner can check in');
    }
    if (existing.is_archived) throw badRequest('This key result has been archived');

    const thresholds = await healthThresholds();

    const checkIn = await withTransaction(async (client) => {
      await client.query(
        `UPDATE key_results
            SET current_value = $1,
                status = COALESCE($2, status),
                last_check_in_at = now(),
                updated_at = now()
          WHERE id = $3`,
        [data.current_value, data.status ?? null, id],
      );

      // read the derived numbers back inside the transaction so the check-in row
      // records exactly the progress this update produced
      const { rows: fresh } = await client.query(`${KEY_RESULT_SELECT} WHERE kr.id = $1`, [id]);
      const decorated = decorateKeyResult(fresh[0], null, thresholds);

      const { rows } = await client.query(
        `INSERT INTO key_result_check_ins
           (key_result_id, user_id, previous_value, current_value, resulting_progress,
            confidence, health_status, note, next_action)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          id,
          req.currentUser.id,
          existing.current_value,
          data.current_value,
          decorated.progress_percent,
          data.confidence ?? null,
          decorated.health,
          data.note?.trim() || null,
          data.next_action?.trim() || null,
        ],
      );

      await logOkrActivity(client, {
        entityType: 'KEY_RESULT',
        entityId: id,
        actorId: req.currentUser.id,
        action: 'checked_in',
        field: 'current_value',
        from: existing.current_value,
        to: data.current_value,
        meta: { progress: decorated.progress_percent, confidence: data.confidence ?? null },
      });

      // the objective owner hears about movement on someone else's key result
      if (existing.objective_owner_id !== req.currentUser.id) {
        await notify(client, {
          userId: existing.objective_owner_id,
          type: 'okr_check_in',
          title: `Check-in on "${existing.title}"`,
          body: `${req.currentUser.full_name} moved it to ${data.current_value}${existing.unit ? ` ${existing.unit}` : ''} (${decorated.progress_percent ?? '—'}%).`,
        });
      }

      return rows[0];
    });

    res.status(201).json({ check_in: checkIn, key_result: await getKeyResult(id) });
  }),
);

// ---------------------------------------------------------------- health override

router.post(
  '/:id/health',
  asyncHandler(async (req, res) => {
    const { health, reason } = z
      .object({
        health: z.enum(HEALTH_STATUSES).nullable(),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body);
    const id = Number(req.params.id);

    const existing = await loadKeyResult(id);
    if (!existing) throw notFound('Key result not found');
    if (!canManageKeyResult(req.currentUser, existing)) throw forbidden('Only the owner can override health');
    if (health && !reason?.trim()) throw badRequest('Give a reason for the override');

    await query(
      `UPDATE key_results
          SET manual_health = $1::text, health_override_reason = $2,
              health_override_by = $3, health_override_at = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END,
              updated_at = now()
        WHERE id = $4`,
      [health, health ? reason.trim() : null, health ? req.currentUser.id : null, id],
    );
    await logOkrActivity(null, {
      entityType: 'KEY_RESULT',
      entityId: id,
      actorId: req.currentUser.id,
      action: health ? 'health_overridden' : 'health_override_cleared',
      from: existing.manual_health,
      to: health,
      meta: { reason: reason || null },
    });

    res.json({ key_result: await getKeyResult(id) });
  }),
);

// ---------------------------------------------------------------- task links

router.get(
  '/:id/tasks',
  asyncHandler(async (req, res) => {
    const params = [Number(req.params.id)];
    const visibility = visibilityClause(req.currentUser, params);

    const { rows } = await query(
      `SELECT t.id, t.ref, t.title, t.progress, t.due_date, t.priority, t.assignee_id,
              s.name AS status_name, s.stage, s.color AS status_color,
              d.name AS department_name, d.color AS department_color,
              u.full_name AS assignee_name, u.avatar_color AS assignee_color,
              l.is_primary, l.contribution_weight
         FROM task_key_result_links l
         JOIN tasks t ON t.id = l.task_id AND t.is_archived = FALSE
         JOIN workflow_statuses s ON s.id = t.status_id
         JOIN departments d ON d.id = t.department_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE l.key_result_id = $1 AND ${visibility}
        ORDER BY l.is_primary DESC, t.id`,
      params,
    );
    res.json({ tasks: rows });
  }),
);

const linkInput = z.object({
  task_id: z.number().int().positive(),
  is_primary: z.boolean().optional(),
  contribution_weight: z.number().min(0).max(1000).nullable().optional(),
});

router.post(
  '/:id/tasks',
  requirePermission('okr.link.task'),
  asyncHandler(async (req, res) => {
    const data = linkInput.parse(req.body);
    const id = Number(req.params.id);

    const keyResult = await loadKeyResult(id);
    if (!keyResult) throw notFound('Key result not found');
    if (keyResult.is_archived || keyResult.objective_archived) {
      throw badRequest('That goal is archived');
    }
    if (!(await canAccess(req.currentUser, data.task_id))) {
      throw forbidden('You cannot link a task you are not able to see');
    }

    await withTransaction(async (client) => {
      // only one key result may be a task's primary alignment
      if (data.is_primary) {
        await client.query(
          'UPDATE task_key_result_links SET is_primary = FALSE WHERE task_id = $1',
          [data.task_id],
        );
      }
      await client.query(
        `INSERT INTO task_key_result_links (task_id, key_result_id, is_primary, contribution_weight, created_by)
         VALUES ($1,$2,COALESCE($3,FALSE),$4,$5)
         ON CONFLICT (task_id, key_result_id) DO UPDATE
           SET is_primary = EXCLUDED.is_primary,
               contribution_weight = EXCLUDED.contribution_weight`,
        [data.task_id, id, data.is_primary ?? null, data.contribution_weight ?? null, req.currentUser.id],
      );
      await logOkrActivity(client, {
        entityType: 'LINK',
        entityId: id,
        actorId: req.currentUser.id,
        action: 'task_linked',
        meta: { task_id: data.task_id, key_result_id: id },
      });
    });

    res.status(201).json({ key_result: await getKeyResult(id) });
  }),
);

router.delete(
  '/:id/tasks/:taskId',
  requirePermission('okr.link.task'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const taskId = Number(req.params.taskId);

    const keyResult = await loadKeyResult(id);
    if (!keyResult) throw notFound('Key result not found');
    if (!(await canAccess(req.currentUser, taskId))) throw forbidden('You cannot change that task');

    const { rowCount } = await query(
      'DELETE FROM task_key_result_links WHERE key_result_id = $1 AND task_id = $2',
      [id, taskId],
    );
    if (!rowCount) throw notFound('That task is not linked to this key result');

    await logOkrActivity(null, {
      entityType: 'LINK',
      entityId: id,
      actorId: req.currentUser.id,
      action: 'task_unlinked',
      meta: { task_id: taskId, key_result_id: id },
    });

    res.json({ ok: true, key_result: await getKeyResult(id) });
  }),
);

export default router;
