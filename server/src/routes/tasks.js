import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { logActivity, notify } from '../services/activity.js';
import { handleTaskReopened, runBlackMarkScan } from '../services/blackmarks.js';

const router = Router();

const TASK_SELECT = `
  SELECT t.*,
         s.name AS status_name, s.slug AS status_slug, s.stage, s.color AS status_color,
         d.name AS department_name, d.key AS department_key, d.color AS department_color,
         a.full_name AS assignee_name, a.avatar_color AS assignee_color, a.email AS assignee_email,
         r.full_name AS reporter_name,
         c.full_name AS created_by_name,
         (t.due_date IS NOT NULL AND t.due_date < now() AND s.stage NOT IN ('done','cancelled')) AS is_overdue,
         (SELECT COUNT(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count,
         (SELECT COUNT(*)::int FROM task_checklist_items ci WHERE ci.task_id = t.id) AS checklist_total,
         (SELECT COUNT(*)::int FROM task_checklist_items ci WHERE ci.task_id = t.id AND ci.is_done) AS checklist_done
    FROM tasks t
    JOIN workflow_statuses s ON s.id = t.status_id
    JOIN departments d ON d.id = t.department_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN users r ON r.id = t.reporter_id
    LEFT JOIN users c ON c.id = t.created_by
`;

/** Restricts the visible task set to what the caller is allowed to see. */
function visibilityClause(user, params) {
  if (hasPermission(user, 'task.view.all')) return '1=1';
  params.push(user.id, user.department_id);
  const uid = `$${params.length - 1}`;
  const dept = `$${params.length}`;
  return `(t.assignee_id = ${uid} OR t.reporter_id = ${uid} OR t.created_by = ${uid} OR t.department_id = ${dept})`;
}

function canEdit(user, task) {
  if (hasPermission(user, 'task.edit.any')) return true;
  if (!hasPermission(user, 'task.edit.own')) return false;
  return [task.assignee_id, task.reporter_id, task.created_by].includes(user.id);
}

async function nextRef(client, departmentId) {
  const { rows } = await client.query(
    'SELECT key FROM departments WHERE id = $1 FOR UPDATE',
    [departmentId],
  );
  if (!rows[0]) throw badRequest('Department not found');
  const key = rows[0].key;
  const { rows: seq } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(ref, '^.*-', ''), '')::int), 0) + 1 AS next
       FROM tasks WHERE department_id = $1`,
    [departmentId],
  );
  return `${key}-${seq[0].next}`;
}

const taskInput = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(20000).nullable().optional(),
  department_id: z.number().int().positive(),
  status_id: z.number().int().positive().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  task_type: z.string().max(40).optional(),
  assignee_id: z.number().int().positive().nullable().optional(),
  reporter_id: z.number().int().positive().nullable().optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().datetime({ offset: true }).or(z.string().min(8)).nullable().optional(),
  estimate_hours: z.number().min(0).max(9999).nullable().optional(),
  spent_hours: z.number().min(0).max(9999).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  tags: z.array(z.string().max(40)).optional(),
  blocked_reason: z.string().max(500).nullable().optional(),
});

// ---------------------------------------------------------------- list

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = [];
    const filters = [visibilityClause(req.currentUser, params)];

    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (req.query.archived === 'true') filters.push('t.is_archived = TRUE');
    else filters.push('t.is_archived = FALSE');

    if (req.query.department_id) filters.push(`t.department_id = ${push(Number(req.query.department_id))}`);
    if (req.query.status_id) filters.push(`t.status_id = ${push(Number(req.query.status_id))}`);
    if (req.query.stage) filters.push(`s.stage = ${push(req.query.stage)}`);
    if (req.query.priority) {
      const list = String(req.query.priority).split(',');
      filters.push(`t.priority = ANY(${push(list)})`);
    }
    if (req.query.assignee_id === 'none') filters.push('t.assignee_id IS NULL');
    else if (req.query.assignee_id) filters.push(`t.assignee_id = ${push(Number(req.query.assignee_id))}`);
    if (req.query.task_type) filters.push(`t.task_type = ${push(req.query.task_type)}`);
    if (req.query.tag) filters.push(`${push(req.query.tag)} = ANY(t.tags)`);
    if (req.query.overdue === 'true') {
      filters.push(`t.due_date < now() AND s.stage NOT IN ('done','cancelled')`);
    }
    if (req.query.due_within_days) {
      filters.push(
        `t.due_date IS NOT NULL AND t.due_date < now() + (${push(Number(req.query.due_within_days))} || ' days')::interval
         AND s.stage NOT IN ('done','cancelled')`,
      );
    }
    if (req.query.open === 'true') filters.push(`s.stage NOT IN ('done','cancelled')`);
    if (req.query.search) {
      const term = push(`%${req.query.search}%`);
      filters.push(`(t.title ILIKE ${term} OR t.description ILIKE ${term} OR t.ref ILIKE ${term})`);
    }

    const sortMap = {
      position: 't.position ASC, t.id DESC',
      due_date: 't.due_date ASC NULLS LAST',
      priority: `CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.due_date ASC NULLS LAST`,
      created: 't.created_at DESC',
      updated: 't.updated_at DESC',
    };
    const orderBy = sortMap[req.query.sort] || sortMap.position;
    const limit = Math.min(Number(req.query.limit) || 500, 1000);

    const { rows } = await query(
      `${TASK_SELECT} WHERE ${filters.join(' AND ')} ORDER BY ${orderBy} LIMIT ${limit}`,
      params,
    );
    res.json({ tasks: rows });
  }),
);

router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `${TASK_SELECT}
        WHERE t.assignee_id = $1 AND t.is_archived = FALSE AND s.stage NOT IN ('done','cancelled')
        ORDER BY t.due_date ASC NULLS LAST,
                 CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
      [req.currentUser.id],
    );
    res.json({ tasks: rows });
  }),
);

// ---------------------------------------------------------------- detail

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const params = [req.params.id];
    const visibility = visibilityClause(req.currentUser, params);
    const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1 AND ${visibility}`, params);
    const task = rows[0];
    if (!task) throw notFound('Task not found');

    const [comments, activity, checklist] = await Promise.all([
      query(
        `SELECT c.*, u.full_name AS author_name, u.avatar_color
           FROM task_comments c LEFT JOIN users u ON u.id = c.author_id
          WHERE c.task_id = $1 ORDER BY c.created_at ASC`,
        [task.id],
      ),
      query(
        `SELECT a.*, u.full_name AS actor_name, u.avatar_color
           FROM task_activity a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.task_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
        [task.id],
      ),
      query('SELECT * FROM task_checklist_items WHERE task_id = $1 ORDER BY position, id', [task.id]),
    ]);

    res.json({
      task,
      comments: comments.rows,
      activity: activity.rows,
      checklist: checklist.rows,
      can_edit: canEdit(req.currentUser, task),
    });
  }),
);

// ---------------------------------------------------------------- create

router.post(
  '/',
  requirePermission('task.create'),
  asyncHandler(async (req, res) => {
    const data = taskInput.parse(req.body);

    if (data.assignee_id && !hasPermission(req.currentUser, 'task.assign')) {
      if (data.assignee_id !== req.currentUser.id) {
        throw forbidden('You can only assign tasks to yourself');
      }
    }

    const task = await withTransaction(async (client) => {
      let statusId = data.status_id;
      if (!statusId) {
        const { rows } = await client.query(
          `SELECT id FROM workflow_statuses WHERE is_active = TRUE
            ORDER BY is_default DESC, position ASC LIMIT 1`,
        );
        if (!rows[0]) throw badRequest('No workflow statuses configured');
        statusId = rows[0].id;
      }

      const ref = await nextRef(client, data.department_id);

      const { rows } = await client.query(
        `INSERT INTO tasks
           (ref, title, description, department_id, status_id, priority, task_type, assignee_id,
            reporter_id, created_by, start_date, due_date, original_due_date, estimate_hours,
            progress, tags, position)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'medium'),COALESCE($7,'task'),$8,$9,$10,$11,$12,$12,$13,
                 COALESCE($14,0),COALESCE($15::text[],'{}'::text[]),
                 (SELECT COALESCE(MAX(position), 0) + 100 FROM tasks WHERE status_id = $5))
         RETURNING *`,
        [
          ref,
          data.title,
          data.description ?? null,
          data.department_id,
          statusId,
          data.priority ?? null,
          data.task_type ?? null,
          data.assignee_id ?? null,
          data.reporter_id ?? req.currentUser.id,
          req.currentUser.id,
          data.start_date || null,
          data.due_date || null,
          data.estimate_hours ?? null,
          data.progress ?? null,
          data.tags ?? null,
        ],
      );

      const created = rows[0];
      await logActivity(client, {
        taskId: created.id,
        actorId: req.currentUser.id,
        action: 'created',
        meta: { ref: created.ref },
      });

      if (created.assignee_id && created.assignee_id !== req.currentUser.id) {
        await notify(client, {
          userId: created.assignee_id,
          type: 'assigned',
          title: `You were assigned ${created.ref}`,
          body: created.title,
          taskId: created.id,
        });
      }
      return created;
    });

    const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1`, [task.id]);
    res.status(201).json({ task: rows[0] });
  }),
);

// ---------------------------------------------------------------- update

const TRACKED_FIELDS = [
  'title', 'description', 'department_id', 'status_id', 'priority', 'task_type',
  'assignee_id', 'reporter_id', 'start_date', 'due_date', 'estimate_hours',
  'spent_hours', 'progress', 'tags', 'blocked_reason',
];

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = taskInput.partial().parse(req.body);
    const id = Number(req.params.id);

    const { rows: existingRows } = await query(
      `SELECT t.*, s.stage FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id WHERE t.id = $1`,
      [id],
    );
    const existing = existingRows[0];
    if (!existing) throw notFound('Task not found');
    if (!canEdit(req.currentUser, existing)) throw forbidden('You cannot edit this task');

    if (
      data.assignee_id !== undefined &&
      data.assignee_id !== existing.assignee_id &&
      !hasPermission(req.currentUser, 'task.assign')
    ) {
      throw forbidden('You do not have permission to reassign tasks');
    }

    const updated = await withTransaction(async (client) => {
      const fields = [];
      const params = [];
      const set = (column, value) => {
        params.push(value);
        fields.push(`${column} = $${params.length}`);
      };

      let newStage = existing.stage;
      if (data.status_id !== undefined && data.status_id !== existing.status_id) {
        const { rows } = await client.query('SELECT stage FROM workflow_statuses WHERE id = $1', [data.status_id]);
        if (!rows[0]) throw badRequest('Status not found');
        newStage = rows[0].stage;
      }

      for (const key of TRACKED_FIELDS) {
        if (data[key] === undefined) continue;
        set(key, data[key] === '' ? null : data[key]);
      }

      // deadline changes are counted — repeated pushes are visible at review time
      if (data.due_date !== undefined && String(data.due_date) !== String(existing.due_date)) {
        fields.push('due_date_changes = due_date_changes + 1');
        if (!existing.original_due_date && existing.due_date) {
          set('original_due_date', existing.due_date);
        }
      }

      const enteringDone = newStage === 'done' && existing.stage !== 'done';
      const leavingDone = existing.stage === 'done' && newStage !== 'done';
      if (enteringDone) {
        fields.push('completed_at = now()');
        if (data.progress === undefined) fields.push('progress = 100');
      }
      if (leavingDone) fields.push('completed_at = NULL');

      if (!fields.length) return existing;

      params.push(id);
      const { rows } = await client.query(
        `UPDATE tasks SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
        params,
      );
      const task = rows[0];

      for (const key of TRACKED_FIELDS) {
        if (data[key] === undefined) continue;
        const before = existing[key];
        const after = task[key];
        if (String(before ?? '') === String(after ?? '')) continue;
        await logActivity(client, {
          taskId: id,
          actorId: req.currentUser.id,
          action: 'updated',
          field: key,
          from: before,
          to: after,
        });
      }

      if (enteringDone) {
        await logActivity(client, { taskId: id, actorId: req.currentUser.id, action: 'completed' });
      }
      if (leavingDone) {
        await logActivity(client, { taskId: id, actorId: req.currentUser.id, action: 'reopened' });
      }

      if (data.assignee_id !== undefined && data.assignee_id !== existing.assignee_id && data.assignee_id) {
        await notify(client, {
          userId: data.assignee_id,
          type: 'assigned',
          title: `You were assigned ${task.ref}`,
          body: task.title,
          taskId: id,
        });
      }

      return { ...task, stage: newStage, previousStage: existing.stage };
    });

    // rule hooks run outside the transaction so a rule failure never loses the edit
    if (updated.previousStage === 'done' && updated.stage !== 'done') {
      await handleTaskReopened({ task: updated, actorId: req.currentUser.id }).catch((err) =>
        console.error('[taskflow] reopen rule failed', err),
      );
    }
    if (updated.stage === 'done' && updated.previousStage !== 'done') {
      await runBlackMarkScan({ taskId: id }).catch((err) =>
        console.error('[taskflow] late-completion scan failed', err),
      );
    }

    const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
    res.json({ task: rows[0] });
  }),
);

/** Board drag-and-drop: change column and/or ordering in one call. */
router.post(
  '/:id/move',
  asyncHandler(async (req, res) => {
    const { status_id, position } = z
      .object({ status_id: z.number().int().positive(), position: z.number().optional() })
      .parse(req.body);
    const id = Number(req.params.id);

    const { rows: existingRows } = await query(
      `SELECT t.*, s.stage FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id WHERE t.id = $1`,
      [id],
    );
    const existing = existingRows[0];
    if (!existing) throw notFound('Task not found');
    if (!canEdit(req.currentUser, existing)) throw forbidden('You cannot move this task');

    const { rows: statusRows } = await query('SELECT * FROM workflow_statuses WHERE id = $1', [status_id]);
    const status = statusRows[0];
    if (!status) throw badRequest('Status not found');

    if (status.wip_limit && status_id !== existing.status_id) {
      const { rows: counts } = await query(
        'SELECT COUNT(*)::int AS n FROM tasks WHERE status_id = $1 AND is_archived = FALSE',
        [status_id],
      );
      if (counts[0].n >= status.wip_limit) {
        throw badRequest(`"${status.name}" is at its WIP limit of ${status.wip_limit}`);
      }
    }

    const enteringDone = status.stage === 'done' && existing.stage !== 'done';
    const leavingDone = existing.stage === 'done' && status.stage !== 'done';

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tasks
            SET status_id = $1,
                position = COALESCE($2, (SELECT COALESCE(MAX(position), 0) + 100 FROM tasks WHERE status_id = $1)),
                completed_at = CASE WHEN $3 THEN now() WHEN $4 THEN NULL ELSE completed_at END,
                progress = CASE WHEN $3 THEN 100 ELSE progress END,
                updated_at = now()
          WHERE id = $5`,
        [status_id, position ?? null, enteringDone, leavingDone, id],
      );
      await logActivity(client, {
        taskId: id,
        actorId: req.currentUser.id,
        action: enteringDone ? 'completed' : leavingDone ? 'reopened' : 'moved',
        field: 'status_id',
        from: existing.status_id,
        to: status_id,
        meta: { to_status: status.name },
      });
    });

    if (leavingDone) {
      await handleTaskReopened({ task: { ...existing, ...status }, actorId: req.currentUser.id }).catch(() => {});
    }
    if (enteringDone) {
      await runBlackMarkScan({ taskId: id }).catch(() => {});
    }

    const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
    res.json({ task: rows[0] });
  }),
);

router.delete(
  '/:id',
  requirePermission('task.delete'),
  asyncHandler(async (req, res) => {
    const permanent = req.query.permanent === 'true' && hasPermission(req.currentUser, 'task.delete');
    if (permanent) {
      const { rowCount } = await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
      if (!rowCount) throw notFound('Task not found');
      return res.json({ ok: true, deleted: true });
    }
    const { rowCount } = await query('UPDATE tasks SET is_archived = TRUE, updated_at = now() WHERE id = $1', [
      req.params.id,
    ]);
    if (!rowCount) throw notFound('Task not found');
    await logActivity(null, { taskId: Number(req.params.id), actorId: req.currentUser.id, action: 'archived' });
    res.json({ ok: true, archived: true });
  }),
);

router.post(
  '/:id/restore',
  requirePermission('task.delete'),
  asyncHandler(async (req, res) => {
    await query('UPDATE tasks SET is_archived = FALSE, updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- comments

router.post(
  '/:id/comments',
  requirePermission('task.comment'),
  asyncHandler(async (req, res) => {
    const { body } = z.object({ body: z.string().min(1).max(5000) }).parse(req.body);
    const taskId = Number(req.params.id);

    const { rows: taskRows } = await query('SELECT id, ref, title, assignee_id FROM tasks WHERE id = $1', [taskId]);
    if (!taskRows[0]) throw notFound('Task not found');

    const { rows } = await query(
      `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING *`,
      [taskId, req.currentUser.id, body],
    );
    await logActivity(null, { taskId, actorId: req.currentUser.id, action: 'commented' });

    if (taskRows[0].assignee_id && taskRows[0].assignee_id !== req.currentUser.id) {
      await notify(null, {
        userId: taskRows[0].assignee_id,
        type: 'comment',
        title: `New comment on ${taskRows[0].ref}`,
        body: body.slice(0, 140),
        taskId,
      });
    }

    res.status(201).json({
      comment: { ...rows[0], author_name: req.currentUser.full_name, avatar_color: req.currentUser.avatar_color },
    });
  }),
);

router.delete(
  '/:taskId/comments/:commentId',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM task_comments WHERE id = $1', [req.params.commentId]);
    if (!rows[0]) throw notFound('Comment not found');
    if (rows[0].author_id !== req.currentUser.id && !hasPermission(req.currentUser, 'task.edit.any')) {
      throw forbidden('You can only delete your own comments');
    }
    await query('DELETE FROM task_comments WHERE id = $1', [req.params.commentId]);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- checklist

router.post(
  '/:id/checklist',
  asyncHandler(async (req, res) => {
    const { title } = z.object({ title: z.string().min(1).max(200) }).parse(req.body);
    const { rows } = await query(
      `INSERT INTO task_checklist_items (task_id, title, position)
       VALUES ($1, $2, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_checklist_items WHERE task_id = $1))
       RETURNING *`,
      [req.params.id, title],
    );
    res.status(201).json({ item: rows[0] });
  }),
);

router.patch(
  '/:taskId/checklist/:itemId',
  asyncHandler(async (req, res) => {
    const data = z
      .object({ title: z.string().min(1).max(200).optional(), is_done: z.boolean().optional() })
      .parse(req.body);

    const fields = [];
    const params = [];
    for (const key of ['title', 'is_done']) {
      if (data[key] !== undefined) {
        params.push(data[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (!fields.length) throw badRequest('Nothing to update');

    params.push(req.params.itemId);
    const { rows } = await query(
      `UPDATE task_checklist_items SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Checklist item not found');
    res.json({ item: rows[0] });
  }),
);

router.delete(
  '/:taskId/checklist/:itemId',
  asyncHandler(async (req, res) => {
    await query('DELETE FROM task_checklist_items WHERE id = $1', [req.params.itemId]);
    res.json({ ok: true });
  }),
);

export default router;
