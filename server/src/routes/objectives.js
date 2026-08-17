import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import {
  OBJECTIVE_SCOPES,
  OBJECTIVE_STATUSES,
  HEALTH_STATUSES,
  PRIORITIES,
  MEASUREMENT_TYPES,
  DIRECTIONS,
} from '../lib/okrConstants.js';
import {
  listObjectives,
  getObjective,
  listKeyResults,
  dashboard,
  logOkrActivity,
} from '../services/okr.js';

const router = Router();

/**
 * Who may change an objective: its owner, or someone with okr.manage.any.
 * Mirrors how canEdit works for tasks — ownership grants control without needing
 * a blanket permission.
 */
export const canManageObjective = (user, objective) =>
  hasPermission(user, 'okr.manage.any') || objective.owner_user_id === user.id;

const objectiveInput = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(20000).nullable().optional(),
  scope_type: z.enum(OBJECTIVE_SCOPES).optional(),
  department_id: z.number().int().positive().nullable().optional(),
  parent_objective_id: z.number().int().positive().nullable().optional(),
  owner_user_id: z.number().int().positive(),
  start_date: z.string().min(8),
  end_date: z.string().min(8),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(OBJECTIVE_STATUSES).optional(),
});

/**
 * Key results may be supplied inline by the creation wizard.
 * current_value is optional and falls back to the baseline — starting a
 * "should come down" metric at zero would report it as already achieved.
 */
const inlineKeyResult = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(5000).nullable().optional(),
  owner_user_id: z.number().int().positive().optional(),
  measurement_type: z.enum(MEASUREMENT_TYPES).optional(),
  direction: z.enum(DIRECTIONS).optional(),
  baseline_value: z.number().optional(),
  target_value: z.number().nullable().optional(),
  current_value: z.number().optional(),
  unit: z.string().max(30).nullable().optional(),
  weight: z.number().min(0).max(1000).optional(),
  start_date: z.string().min(8).nullable().optional(),
  end_date: z.string().min(8).nullable().optional(),
});

/** Company objectives need a wider permission than department ones. */
function assertMayCreate(user, scopeType) {
  if (scopeType === 'COMPANY') {
    if (!hasPermission(user, 'okr.create.company')) {
      throw forbidden('Only an administrator can create company-wide objectives');
    }
    return;
  }
  if (!hasPermission(user, 'okr.create.department')) {
    throw forbidden('You do not have permission to create objectives');
  }
}

function assertScopeConsistent(scopeType, departmentId) {
  if (scopeType === 'COMPANY' && departmentId) {
    throw badRequest('A company-wide objective does not belong to a department');
  }
  if (scopeType === 'DEPARTMENT' && !departmentId) {
    throw badRequest('Pick the department this objective belongs to');
  }
}

// ---------------------------------------------------------------- dashboard

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const data = await dashboard({
      departmentId: req.query.department_id,
      ownerId: req.query.owner_id,
      status: req.query.status,
      priority: req.query.priority,
      health: req.query.health,
      scopeType: req.query.scope_type,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(data);
  }),
);

// ---------------------------------------------------------------- list

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const objectives = await listObjectives({
      departmentId: req.query.department_id,
      ownerId: req.query.owner_id,
      status: req.query.status,
      priority: req.query.priority,
      health: req.query.health,
      scopeType: req.query.scope_type,
      parentId: req.query.parent_id,
      search: req.query.search,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });
    res.json({ objectives });
  }),
);

// ---------------------------------------------------------------- detail

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const objective = await getObjective(Number(req.params.id));
    if (!objective) throw notFound('Objective not found');

    const [keyResults, children, activity] = await Promise.all([
      listKeyResults(objective.id, objective),
      query(
        `SELECT id, title, status, scope_type, department_id FROM objectives
          WHERE parent_objective_id = $1 AND is_archived = FALSE ORDER BY id`,
        [objective.id],
      ),
      query(
        `SELECT a.*, u.full_name AS actor_name
           FROM okr_activity a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.entity_type = 'OBJECTIVE' AND a.entity_id = $1
          ORDER BY a.created_at DESC LIMIT 50`,
        [objective.id],
      ),
    ]);

    res.json({
      objective,
      key_results: keyResults,
      children: children.rows,
      activity: activity.rows,
      can_edit: canManageObjective(req.currentUser, objective),
    });
  }),
);

// ---------------------------------------------------------------- create

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = objectiveInput
      .extend({ key_results: z.array(inlineKeyResult).optional() })
      .parse(req.body);

    const scopeType = data.scope_type || 'DEPARTMENT';

    assertMayCreate(req.currentUser, scopeType);
    // checked against what was actually sent, so a contradiction is reported
    // rather than quietly thrown away
    assertScopeConsistent(scopeType, data.department_id ?? null);
    const departmentId = scopeType === 'COMPANY' ? null : data.department_id ?? null;
    if (new Date(data.end_date) < new Date(data.start_date)) {
      throw badRequest('The target date cannot be before the start date');
    }

    const objective = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO objectives
           (title, description, scope_type, department_id, parent_objective_id, owner_user_id,
            start_date, end_date, priority, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'medium'),COALESCE($10,'DRAFT'),$11)
         RETURNING *`,
        [
          data.title.trim(),
          data.description ?? null,
          scopeType,
          departmentId,
          data.parent_objective_id ?? null,
          data.owner_user_id,
          data.start_date,
          data.end_date,
          data.priority ?? null,
          data.status ?? null,
          req.currentUser.id,
        ],
      );
      const created = rows[0];

      await logOkrActivity(client, {
        entityType: 'OBJECTIVE',
        entityId: created.id,
        actorId: req.currentUser.id,
        action: 'created',
        meta: { title: created.title, scope: scopeType },
      });

      // the wizard can send its key results with the objective in one call
      for (const keyResult of data.key_results || []) {
        const { rows: krRows } = await client.query(
          `INSERT INTO key_results
             (objective_id, title, description, owner_user_id, measurement_type, direction,
              baseline_value, target_value, current_value, unit, weight, start_date, end_date, created_by)
           VALUES ($1,$2,$3,$4,COALESCE($5,'NUMBER'),COALESCE($6,'INCREASE'),
                   COALESCE($7::numeric,0),$8,COALESCE($9::numeric,$7::numeric,0),$10,COALESCE($11::numeric,1),$12,$13,$14)
           RETURNING id, title`,
          [
            created.id,
            keyResult.title.trim(),
            keyResult.description ?? null,
            keyResult.owner_user_id ?? data.owner_user_id,
            keyResult.measurement_type ?? null,
            keyResult.direction ?? null,
            keyResult.baseline_value ?? null,
            keyResult.target_value ?? null,
            keyResult.current_value ?? null,
            keyResult.unit ?? null,
            keyResult.weight ?? null,
            keyResult.start_date ?? null,
            keyResult.end_date ?? null,
            req.currentUser.id,
          ],
        );
        await logOkrActivity(client, {
          entityType: 'KEY_RESULT',
          entityId: krRows[0].id,
          actorId: req.currentUser.id,
          action: 'created',
          meta: { title: krRows[0].title, objective_id: created.id },
        });
      }

      return created;
    });

    res.status(201).json({ objective: await getObjective(objective.id) });
  }),
);

// ---------------------------------------------------------------- update

const TRACKED = [
  'title', 'description', 'scope_type', 'department_id', 'parent_objective_id',
  'owner_user_id', 'start_date', 'end_date', 'priority', 'status',
];

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = objectiveInput.partial().parse(req.body);
    const id = Number(req.params.id);

    const { rows: existingRows } = await query('SELECT * FROM objectives WHERE id = $1', [id]);
    const existing = existingRows[0];
    if (!existing) throw notFound('Objective not found');
    if (!canManageObjective(req.currentUser, existing)) {
      throw forbidden('Only the objective owner can change it');
    }

    const scopeType = data.scope_type ?? existing.scope_type;
    const departmentId =
      data.department_id !== undefined ? data.department_id : existing.department_id;
    // an explicit department alongside a switch to COMPANY is a contradiction;
    // an inherited one is just the old value being cleared
    assertScopeConsistent(
      scopeType,
      scopeType === 'COMPANY' && data.department_id === undefined ? null : departmentId,
    );
    if (data.scope_type === 'COMPANY') assertMayCreate(req.currentUser, 'COMPANY');

    await withTransaction(async (client) => {
      const fields = [];
      const params = [];
      for (const key of TRACKED) {
        if (data[key] === undefined) continue;
        // a company objective never keeps a department
        const value = key === 'department_id' && scopeType === 'COMPANY' ? null : data[key];
        params.push(value);
        fields.push(`${key} = $${params.length}`);
      }
      if (scopeType === 'COMPANY' && existing.department_id && data.department_id === undefined) {
        fields.push('department_id = NULL');
      }
      if (!fields.length) return;

      params.push(id);
      await client.query(
        `UPDATE objectives SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
        params,
      );

      for (const key of TRACKED) {
        if (data[key] === undefined) continue;
        if (String(existing[key] ?? '') === String(data[key] ?? '')) continue;
        await logOkrActivity(client, {
          entityType: 'OBJECTIVE',
          entityId: id,
          actorId: req.currentUser.id,
          action: 'updated',
          field: key,
          from: existing[key],
          to: data[key],
        });
      }
    });

    res.json({ objective: await getObjective(id) });
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

    const { rows } = await query('SELECT * FROM objectives WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Objective not found');
    if (!canManageObjective(req.currentUser, rows[0])) throw forbidden('Only the owner can override health');
    if (health && !reason?.trim()) throw badRequest('Give a reason for the override');

    await query(
      `UPDATE objectives
          SET manual_health = $1::text, health_override_reason = $2,
              health_override_by = $3, health_override_at = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END,
              updated_at = now()
        WHERE id = $4`,
      [health, health ? reason.trim() : null, health ? req.currentUser.id : null, id],
    );
    await logOkrActivity(null, {
      entityType: 'OBJECTIVE',
      entityId: id,
      actorId: req.currentUser.id,
      action: health ? 'health_overridden' : 'health_override_cleared',
      from: rows[0].manual_health,
      to: health,
      meta: { reason: reason || null },
    });

    res.json({ objective: await getObjective(id) });
  }),
);

// ---------------------------------------------------------------- archive

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM objectives WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw notFound('Objective not found');
    if (!canManageObjective(req.currentUser, rows[0])) throw forbidden('Only the owner can archive it');

    // archived like tasks and notes, never destroyed
    await query('UPDATE objectives SET is_archived = TRUE, updated_at = now() WHERE id = $1', [req.params.id]);
    await logOkrActivity(null, {
      entityType: 'OBJECTIVE',
      entityId: Number(req.params.id),
      actorId: req.currentUser.id,
      action: 'archived',
    });
    res.json({ ok: true, archived: true });
  }),
);

// ---------------------------------------------------------------- key results

router.get(
  '/:id/key-results',
  asyncHandler(async (req, res) => {
    const objective = await getObjective(Number(req.params.id));
    if (!objective) throw notFound('Objective not found');
    res.json({ key_results: await listKeyResults(objective.id, objective) });
  }),
);

router.post(
  '/:id/key-results',
  asyncHandler(async (req, res) => {
    const data = inlineKeyResult.parse(req.body);
    const id = Number(req.params.id);

    const { rows } = await query('SELECT * FROM objectives WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Objective not found');
    if (!canManageObjective(req.currentUser, rows[0])) {
      throw forbidden('Only the objective owner can add key results');
    }

    const { rows: created } = await query(
      `INSERT INTO key_results
         (objective_id, title, description, owner_user_id, measurement_type, direction,
          baseline_value, target_value, current_value, unit, weight, start_date, end_date, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'NUMBER'),COALESCE($6,'INCREASE'),
               COALESCE($7::numeric,0),$8,COALESCE($9::numeric,$7::numeric,0),$10,COALESCE($11::numeric,1),$12,$13,$14)
       RETURNING id`,
      [
        id,
        data.title.trim(),
        data.description ?? null,
        data.owner_user_id ?? rows[0].owner_user_id,
        data.measurement_type ?? null,
        data.direction ?? null,
        data.baseline_value ?? null,
        data.target_value ?? null,
        data.current_value ?? null,
        data.unit ?? null,
        data.weight ?? null,
        data.start_date ?? null,
        data.end_date ?? null,
        req.currentUser.id,
      ],
    );

    await logOkrActivity(null, {
      entityType: 'KEY_RESULT',
      entityId: created[0].id,
      actorId: req.currentUser.id,
      action: 'created',
      meta: { objective_id: id },
    });

    const objective = await getObjective(id);
    res.status(201).json({ key_results: await listKeyResults(id, objective) });
  }),
);

/** Spreads weight evenly across an objective's key results. */
router.post(
  '/:id/key-results/equalise-weights',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await query('SELECT * FROM objectives WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Objective not found');
    if (!canManageObjective(req.currentUser, rows[0])) throw forbidden('Only the owner can change weights');

    await query('UPDATE key_results SET weight = 1, updated_at = now() WHERE objective_id = $1', [id]);
    const objective = await getObjective(id);
    res.json({ key_results: await listKeyResults(id, objective) });
  }),
);

export default router;
