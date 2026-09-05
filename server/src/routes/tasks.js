import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import {
  upload,
  assertSafeUrl,
  detectProvider,
  deleteStoredFile,
  resolveStoredFile,
} from '../lib/uploads.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { logActivity, notify } from '../services/activity.js';
import { handleTaskReopened, runBlackMarkScan } from '../services/blackmarks.js';
import { spawnNextOccurrenceAfterCompletion } from '../services/recurrence.js';
import { nextTaskRef } from '../lib/taskRef.js';
import { assertUsableDeadline } from '../lib/deadline.js';
import { getSettings } from '../services/settings.js';
import {
  addMessage, canRaiseReview, createThread, listMessages, listThreads,
} from '../services/threads.js';

const router = Router();

const TASK_SELECT = `
  SELECT t.*,
         s.name AS status_name, s.slug AS status_slug, s.stage, s.color AS status_color,
         d.name AS department_name, d.key AS department_key, d.color AS department_color,
         a.full_name AS assignee_name, a.avatar_color AS assignee_color, a.email AS assignee_email,
         f.full_name AS follower_name, f.avatar_color AS follower_color,
         r.full_name AS reporter_name,
         c.full_name AS created_by_name,
         p.ref AS parent_ref, p.title AS parent_title,
         acc.name AS account_name, acc.type AS account_type,
         (t.due_date IS NOT NULL AND t.due_date < now() AND s.stage NOT IN ('done','cancelled')) AS is_overdue,
         -- comments live in discussion threads now; counting the old table here
         -- would freeze every card's badge at its pre-upgrade number
         (SELECT COUNT(*)::int
            FROM discussion_messages dm
            JOIN discussion_threads dt ON dt.id = dm.thread_id
           WHERE dt.entity_type = 'TASK' AND dt.entity_id = t.id) AS comment_count,
         (SELECT COUNT(*)::int FROM discussion_threads dt
           WHERE dt.entity_type = 'TASK' AND dt.entity_id = t.id
             AND dt.status = 'open' AND dt.kind = 'review') AS open_reviews,
         (SELECT COUNT(*)::int FROM discussion_threads dt
           WHERE dt.entity_type = 'TASK' AND dt.entity_id = t.id
             AND dt.status = 'open' AND dt.kind = 'help_needed') AS open_help,
         (SELECT COUNT(*)::int FROM task_checklist_items ci WHERE ci.task_id = t.id) AS checklist_total,
         (SELECT COUNT(*)::int FROM task_checklist_items ci WHERE ci.task_id = t.id AND ci.is_done) AS checklist_done,
         (SELECT COUNT(*)::int FROM task_attachments ta WHERE ta.task_id = t.id) AS attachment_count,
         (SELECT COUNT(*)::int FROM task_collaborators tcol WHERE tcol.task_id = t.id) AS collaborator_count,
         (SELECT COUNT(*)::int FROM tasks st WHERE st.parent_task_id = t.id AND st.is_archived = FALSE) AS subtask_total,
         (SELECT COUNT(*)::int FROM tasks st
            JOIN workflow_statuses ss ON ss.id = st.status_id
           WHERE st.parent_task_id = t.id AND st.is_archived = FALSE AND ss.stage = 'done') AS subtask_done,
         -- when a card has sub tasks its progress is the average of theirs, so a
         -- parent can never claim to be further along than its children
         COALESCE((
           SELECT ROUND(AVG(CASE WHEN ss.stage = 'done' THEN 100 ELSE st.progress END))::int
             FROM tasks st
             JOIN workflow_statuses ss ON ss.id = st.status_id
            WHERE st.parent_task_id = t.id AND st.is_archived = FALSE
         ), t.progress) AS effective_progress
    FROM tasks t
    JOIN workflow_statuses s ON s.id = t.status_id
    JOIN departments d ON d.id = t.department_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN users f ON f.id = t.follower_id
    LEFT JOIN users r ON r.id = t.reporter_id
    LEFT JOIN users c ON c.id = t.created_by
    LEFT JOIN tasks p ON p.id = t.parent_task_id
    LEFT JOIN accounts acc ON acc.id = t.account_id
`;

/**
 * Restricts the visible task set to what the caller is allowed to see.
 * Being tagged on a card grants access to it regardless of department — that is
 * the whole point of tagging someone from another team.
 */
export function visibilityClause(user, params) {
  if (hasPermission(user, 'task.view.all')) return '1=1';
  params.push(user.id, user.department_id);
  const uid = `$${params.length - 1}`;
  const dept = `$${params.length}`;
  return `(
    t.assignee_id = ${uid}
    OR t.follower_id = ${uid}
    OR t.reporter_id = ${uid}
    OR t.created_by = ${uid}
    OR t.department_id = ${dept}
    OR EXISTS (SELECT 1 FROM task_collaborators tc WHERE tc.task_id = t.id AND tc.user_id = ${uid})
  )`;
}

function canEdit(user, task) {
  if (hasPermission(user, 'task.edit.any')) return true;
  if (!hasPermission(user, 'task.edit.own')) return false;
  // the follower is a second owner, so they can move and update the card too
  return [task.assignee_id, task.follower_id, task.reporter_id, task.created_by].includes(user.id);
}

/** Tagged people and the follower may comment even when they cannot edit. */
export async function canAccess(user, taskId) {
  if (hasPermission(user, 'task.view.all')) return true;
  const { rows } = await query(
    `SELECT 1 FROM tasks t
      WHERE t.id = $1
        AND (t.assignee_id = $2 OR t.follower_id = $2 OR t.reporter_id = $2 OR t.created_by = $2
             OR t.department_id = $3
             OR EXISTS (SELECT 1 FROM task_collaborators tc WHERE tc.task_id = t.id AND tc.user_id = $2))`,
    [taskId, user.id, user.department_id],
  );
  return rows.length > 0;
}

// reference allocation is shared with the recurrence spawner — see lib/taskRef.js
const nextRef = nextTaskRef;

const taskInput = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(20000).nullable().optional(),
  department_id: z.number().int().positive(),
  status_id: z.number().int().positive().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  task_type: z.string().max(40).optional(),
  assignee_id: z.number().int().positive().nullable().optional(),
  follower_id: z.number().int().positive().nullable().optional(),
  parent_task_id: z.number().int().positive().nullable().optional(),
  collaborator_ids: z.array(z.number().int().positive()).optional(),
  reporter_id: z.number().int().positive().nullable().optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().datetime({ offset: true }).or(z.string().min(8)).nullable().optional(),
  estimate_hours: z.number().min(0).max(9999).nullable().optional(),
  spent_hours: z.number().min(0).max(9999).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  tags: z.array(z.string().max(40)).optional(),
  blocked_reason: z.string().max(500).nullable().optional(),
  recurrence: z.enum(['none', 'daily', 'weekdays', 'weekly', 'monthly']).optional(),
  // for a subtask: whether it comes back with each occurrence of its parent
  repeats_with_parent: z.boolean().optional(),
  completion_note: z.string().max(5000).nullable().optional(),
  // the lead or partner this task is helping — NULL for an ordinary task
  account_id: z.number().int().positive().nullable().optional(),
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
    if (req.query.account_id) filters.push(`t.account_id = ${push(Number(req.query.account_id))}`);
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
    // work someone is on includes tasks they follow — the follower works on it too,
    // so it belongs on their list even though the owner carries the deadline
    const { rows } = await query(
      `${TASK_SELECT}
        WHERE (t.assignee_id = $1 OR t.follower_id = $1)
          AND t.is_archived = FALSE
          AND s.stage NOT IN ('done','cancelled')
        ORDER BY (t.assignee_id = $1) DESC,
                 t.due_date ASC NULLS LAST,
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

    const [comments, activity, checklist, attachments, collaborators, subtasks, keyResults] = await Promise.all([
      // comments come from the thread store now. The old flat rows were copied
      // there by migration 010 and are still in task_comments untouched, so this
      // returns the same history it always did — in the same shape, so nothing
      // reading `comments` had to change.
      query(
        `SELECT m.id, m.author_id, m.body, m.created_at, m.updated_at,
                t.entity_id AS task_id, t.id AS thread_id, t.kind AS thread_kind,
                u.full_name AS author_name, u.avatar_color
           FROM discussion_messages m
           JOIN discussion_threads t ON t.id = m.thread_id
           LEFT JOIN users u ON u.id = m.author_id
          WHERE t.entity_type = 'TASK' AND t.entity_id = $1
          ORDER BY m.created_at ASC`,
        [task.id],
      ),
      query(
        `SELECT a.*, u.full_name AS actor_name, u.avatar_color
           FROM task_activity a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.task_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
        [task.id],
      ),
      query('SELECT * FROM task_checklist_items WHERE task_id = $1 ORDER BY position, id', [task.id]),
      query(
        `SELECT a.*, u.full_name AS uploaded_by_name
           FROM task_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
          WHERE a.task_id = $1 ORDER BY a.created_at`,
        [task.id],
      ),
      query(
        `SELECT u.id, u.full_name, u.avatar_color, u.email, d.name AS department_name
           FROM task_collaborators tc
           JOIN users u ON u.id = tc.user_id
           LEFT JOIN departments d ON d.id = u.department_id
          WHERE tc.task_id = $1
          ORDER BY u.full_name`,
        [task.id],
      ),
      query(
        `SELECT t.id, t.ref, t.title, t.progress, t.due_date, t.priority, t.assignee_id,
                -- without this the list cannot tell a step of the routine from
                -- something that only needed doing once
                t.repeats_with_parent,
                s.name AS status_name, s.stage, s.color AS status_color,
                u.full_name AS assignee_name, u.avatar_color AS assignee_color
           FROM tasks t
           JOIN workflow_statuses s ON s.id = t.status_id
           LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.parent_task_id = $1 AND t.is_archived = FALSE
          ORDER BY t.position, t.id`,
        [task.id],
      ),
      // strategic alignment, if this card has any. An empty array is the normal
      // case and nothing on the card depends on it.
      query(
        `SELECT kr.id, kr.title, kr.unit, kr.measurement_type, kr.status,
                l.is_primary, l.contribution_weight,
                o.id AS objective_id, o.title AS objective_title,
                o.scope_type, o.department_id AS objective_department_id
           FROM task_key_result_links l
           JOIN key_results kr ON kr.id = l.key_result_id
           JOIN objectives o ON o.id = kr.objective_id
          WHERE l.task_id = $1 AND kr.is_archived = FALSE AND o.is_archived = FALSE
          ORDER BY l.is_primary DESC, kr.id`,
        [task.id],
      ),
    ]);

    const threads = await listThreads('TASK', task.id);
    const withMessages = await Promise.all(
      threads.map(async (thread) => ({ ...thread, messages: await listMessages(thread.id) })),
    );

    res.json({
      task,
      comments: comments.rows,
      threads: withMessages,
      can_raise_review: canRaiseReview(req.currentUser),
      activity: activity.rows,
      checklist: checklist.rows,
      attachments: attachments.rows,
      collaborators: collaborators.rows,
      subtasks: subtasks.rows,
      key_results: keyResults.rows,
      can_edit: canEdit(req.currentUser, task),
      // handing the task to someone else is open to anyone who can see it
      can_reassign: hasPermission(req.currentUser, 'task.assign'),
    });
  }),
);

// ---------------------------------------------------------------- create

router.post(
  '/',
  requirePermission('task.create'),
  asyncHandler(async (req, res) => {
    const data = taskInput.parse(req.body);

    // every task must have an owner accountable for it — enforced here so the API
    // cannot create an ownerless card even if the form is bypassed
    if (!data.assignee_id) {
      throw badRequest('A task owner is required');
    }

    // and a deadline it is expected by. Enforced on the API rather than the column
    // so the tasks that predate this rule keep working.
    const settings = await getSettings();
    // a daily or working-day task has one obvious deadline, so a missing one is
    // filled in rather than refused; every other cadence still has to be stated
    const dueDate = assertUsableDeadline(data.due_date, {
      recurrence: data.recurrence,
      maxHorizonDays: settings.deadlines?.maxHorizonDays,
      defaultHour: settings.deadlines?.recurringDueHour,
    });

    if (!hasPermission(req.currentUser, 'task.assign') && data.assignee_id !== req.currentUser.id) {
      throw forbidden('You can only assign tasks to yourself');
    }

    const task = await withTransaction(async (client) => {
      let statusId = data.status_id;
      let statusStage;
      if (statusId) {
        const { rows } = await client.query('SELECT stage FROM workflow_statuses WHERE id = $1', [statusId]);
        if (!rows[0]) throw badRequest('Status not found');
        statusStage = rows[0].stage;
      } else {
        const { rows } = await client.query(
          `SELECT id, stage FROM workflow_statuses WHERE is_active = TRUE
            ORDER BY is_default DESC, position ASC LIMIT 1`,
        );
        if (!rows[0]) throw badRequest('No workflow statuses configured');
        statusId = rows[0].id;
        statusStage = rows[0].stage;
      }

      // a card created straight into a done column is already complete, so stamp
      // completed_at (and full progress) — otherwise it counts as "done" on the
      // board but stays invisible to the monthly completion figures
      const bornDone = statusStage === 'done';

      const ref = await nextRef(client, data.department_id);

      const { rows } = await client.query(
        `INSERT INTO tasks
           (ref, title, description, department_id, status_id, priority, task_type, assignee_id,
            follower_id, parent_task_id, reporter_id, created_by, start_date, due_date,
            original_due_date, estimate_hours, progress, tags, position, completed_at, recurrence,
            repeats_with_parent)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'medium'),COALESCE($7,'task'),$8,$9,$10,$11,$12,$13,$14,$14,$15,
                 COALESCE($16::int,$18::int),COALESCE($17::text[],'{}'::text[]),
                 (SELECT COALESCE(MAX(position), 0) + 100 FROM tasks WHERE status_id = $5),
                 $19, COALESCE($20,'none'), COALESCE($21, FALSE))
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
          data.follower_id ?? null,
          data.parent_task_id ?? null,
          data.reporter_id ?? req.currentUser.id,
          req.currentUser.id,
          data.start_date || null,
          // the resolved deadline, which for a daily task may have been filled in
          dueDate,
          data.estimate_hours ?? null,
          data.progress ?? null,
          data.tags ?? null,
          bornDone ? 100 : 0,
          bornDone ? new Date() : null,
          data.recurrence ?? null,
          data.repeats_with_parent ?? null,
        ],
      );

      const created = rows[0];

      // a task can belong to a lead/partner. Set it after the insert so the big
      // insert above stays exactly as it shipped.
      if (data.account_id) {
        await client.query('UPDATE tasks SET account_id = $1 WHERE id = $2', [data.account_id, created.id]);
        created.account_id = data.account_id;
      }

      await logActivity(client, {
        taskId: created.id,
        actorId: req.currentUser.id,
        action: 'created',
        meta: { ref: created.ref },
      });

      for (const userId of data.collaborator_ids || []) {
        await client.query(
          `INSERT INTO task_collaborators (task_id, user_id, added_by) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [created.id, userId, req.currentUser.id],
        );
      }

      const toNotify = [
        [created.assignee_id, 'assigned', `You were assigned ${created.ref}`],
        [created.follower_id, 'follower', `You are following ${created.ref}`],
        ...(data.collaborator_ids || []).map((id) => [id, 'tagged', `You were tagged on ${created.ref}`]),
      ];
      for (const [userId, type, title] of toNotify) {
        if (userId && userId !== req.currentUser.id) {
          await notify(client, { userId, type, title, body: created.title, taskId: created.id });
        }
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
  'assignee_id', 'follower_id', 'parent_task_id', 'reporter_id', 'start_date', 'due_date',
  'estimate_hours', 'spent_hours', 'progress', 'tags', 'blocked_reason', 'account_id',
  // recurrence was validated on update but never written, so the "Repeats"
  // dropdown did nothing on a card that already existed — you could only set a
  // cadence at creation, and only by starting the task again
  'recurrence', 'repeats_with_parent',
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

    if (!canEdit(req.currentUser, existing)) {
      // Anyone may hand work to anyone, so changing only the owner or the follower
      // is allowed on any task the person can see — even one they are not part of.
      // Every other field still needs normal edit rights.
      const changingOnlyOwnership =
        Object.keys(data).length > 0 &&
        Object.keys(data).every((field) => field === 'assignee_id' || field === 'follower_id');

      const mayHandOver =
        changingOnlyOwnership &&
        hasPermission(req.currentUser, 'task.assign') &&
        (await canAccess(req.currentUser, id));

      if (!mayHandOver) throw forbidden('You cannot edit this task');
    }

    if (
      data.assignee_id !== undefined &&
      data.assignee_id !== existing.assignee_id &&
      !hasPermission(req.currentUser, 'task.assign')
    ) {
      throw forbidden('You do not have permission to reassign tasks');
    }

    // a deadline can be changed or set, but never removed, and the replacement has
    // to be as usable as one given at creation. Editing anything else on a task
    // that predates the rule leaves its missing deadline alone.
    if (data.due_date !== undefined) {
      if (data.due_date === null || data.due_date === '') {
        throw badRequest('A deadline is required — set a new date rather than clearing it');
      }
      const settings = await getSettings();
      assertUsableDeadline(data.due_date, {
        recurrence: data.recurrence ?? existing.recurrence,
        maxHorizonDays: settings.deadlines?.maxHorizonDays,
      });
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
        if (data.completion_note) set('completion_note', data.completion_note);
      }
      if (leavingDone) {
        fields.push('completed_at = NULL');
        fields.push('completion_note = NULL');
      }

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
        await logActivity(client, {
          taskId: id,
          actorId: req.currentUser.id,
          action: 'completed',
          to: data.completion_note || null,
        });
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
      if (data.follower_id !== undefined && data.follower_id !== existing.follower_id && data.follower_id) {
        await notify(client, {
          userId: data.follower_id,
          type: 'follower',
          title: `You are now following ${task.ref}`,
          body: task.title,
          taskId: id,
        });
      }

      // collaborators are replaced wholesale when the field is supplied
      if (data.collaborator_ids !== undefined) {
        const { rows: before } = await client.query(
          'SELECT user_id FROM task_collaborators WHERE task_id = $1',
          [id],
        );
        const had = new Set(before.map((r) => r.user_id));
        const wanted = new Set(data.collaborator_ids);

        await client.query(
          'DELETE FROM task_collaborators WHERE task_id = $1 AND user_id <> ALL($2::int[])',
          [id, data.collaborator_ids],
        );
        for (const userId of wanted) {
          await client.query(
            `INSERT INTO task_collaborators (task_id, user_id, added_by) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [id, userId, req.currentUser.id],
          );
          if (!had.has(userId) && userId !== req.currentUser.id) {
            await notify(client, {
              userId,
              type: 'tagged',
              title: `You were tagged on ${task.ref}`,
              body: task.title,
              taskId: id,
            });
          }
        }
      }

      return { ...task, stage: newStage, previousStage: existing.stage, enteringDone };
    });

    // the next occurrence is created after the completion has committed, so it can
    // never roll back the completion itself
    if (updated.enteringDone) {
      updated.spawnedNext = await spawnNextOccurrenceAfterCompletion(updated);
    }

    // rule hooks run outside the transaction so a rule failure never loses the edit
    if (updated.previousStage === 'done' && updated.stage !== 'done') {
      await handleTaskReopened({ task: updated, actorId: req.currentUser.id }).catch((err) =>
        console.error('[taskflow] reopen rule failed', err),
      );
    }
    if (updated.stage === 'done' && updated.previousStage !== 'done') {
      await runBlackMarkScan({ taskId: id }).catch((err) =>
        console.error(`[taskflow] black mark scan failed for task ${id}:`, err.message),
      );
    }

    const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
    res.json({
      task: rows[0],
      next_occurrence: updated.spawnedNext
        ? { id: updated.spawnedNext.id, ref: updated.spawnedNext.ref, due_date: updated.spawnedNext.due_date }
        : null,
    });
  }),
);

/** Board drag-and-drop: change column and/or ordering in one call. */
router.post(
  '/:id/move',
  asyncHandler(async (req, res) => {
    const { status_id, position, completion_note: completionNote } = z
      .object({
        status_id: z.number().int().positive(),
        position: z.number().optional(),
        completion_note: z.string().max(5000).nullable().optional(),
      })
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
                completion_note = CASE WHEN $3 THEN $6 WHEN $4 THEN NULL ELSE completion_note END,
                updated_at = now()
          WHERE id = $5`,
        [status_id, position ?? null, enteringDone, leavingDone, id, completionNote || null],
      );
      await logActivity(client, {
        taskId: id,
        actorId: req.currentUser.id,
        action: enteringDone ? 'completed' : leavingDone ? 'reopened' : 'moved',
        field: 'status_id',
        from: existing.status_id,
        to: enteringDone ? completionNote || null : status_id,
        meta: { to_status: status.name },
      });
    });

    // Everything below runs after the completion is committed, so none of it can
    // undo the work the person just recorded.
    let spawnedNext = null;
    if (enteringDone) {
      spawnedNext = await spawnNextOccurrenceAfterCompletion(existing);
    }

    if (leavingDone) {
      await handleTaskReopened({ task: { ...existing, ...status }, actorId: req.currentUser.id }).catch((err) =>
        console.error('[taskflow] reopen rule failed:', err.message),
      );
    }
    if (enteringDone) {
      // black marks must be recorded for a late completion — a failure here is
      // logged loudly rather than swallowed, so it can never go unnoticed
      await runBlackMarkScan({ taskId: id }).catch((err) =>
        console.error(`[taskflow] black mark scan failed for task ${id}:`, err.message),
      );
    }

    const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
    res.json({
      task: rows[0],
      next_occurrence: spawnedNext
        ? { id: spawnedNext.id, ref: spawnedNext.ref, due_date: spawnedNext.due_date }
        : null,
    });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT id, created_by FROM tasks WHERE id = $1', [req.params.id]);
    const existing = rows[0];
    if (!existing) throw notFound('Task not found');

    // Managers keep the delete permission; on top of that, whoever created a task
    // can remove it — this is what lets people clear accidental duplicates they
    // made themselves without needing an admin.
    const isCreator = existing.created_by === req.currentUser.id;
    const canManage = hasPermission(req.currentUser, 'task.delete');
    if (!isCreator && !canManage) {
      throw forbidden('Only the person who created a task, or a manager, can delete it');
    }

    // The caller states intent explicitly: ?permanent=true removes the row (child
    // subtasks and attachments cascade), otherwise it is archived. Both are open to
    // the creator and to managers — the creator's "delete duplicate" button asks
    // for a permanent delete, a manager's "archive" does not.
    const permanent = req.query.permanent === 'true';

    if (permanent) {
      await query('DELETE FROM tasks WHERE id = $1', [existing.id]);
      return res.json({ ok: true, deleted: true });
    }

    await query('UPDATE tasks SET is_archived = TRUE, updated_at = now() WHERE id = $1', [existing.id]);
    await logActivity(null, { taskId: existing.id, actorId: req.currentUser.id, action: 'archived' });
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

    // one comment store, not two: this writes into the task's general discussion
    // thread, creating it the first time. The endpoint and its response are
    // unchanged, so anything already calling it keeps working.
    const rows = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        `SELECT id FROM discussion_threads
          WHERE entity_type = 'TASK' AND entity_id = $1 AND kind = 'discussion'
          ORDER BY id LIMIT 1`,
        [taskId],
      );

      let threadId = existing[0]?.id;
      if (!threadId) {
        const created = await createThread(client, {
          entityType: 'TASK',
          entityId: taskId,
          kind: 'discussion',
          title: 'Discussion',
          body,
          actor: req.currentUser,
        });
        const { rows: first } = await client.query(
          'SELECT * FROM discussion_messages WHERE thread_id = $1 ORDER BY id LIMIT 1',
          [created.id],
        );
        return first;
      }

      const message = await addMessage(client, { threadId, actor: req.currentUser, body });
      return [message];
    });

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
    const { rows } = await query('SELECT * FROM discussion_messages WHERE id = $1', [req.params.commentId]);
    if (!rows[0]) throw notFound('Comment not found');
    if (rows[0].author_id !== req.currentUser.id && !hasPermission(req.currentUser, 'task.edit.any')) {
      throw forbidden('You can only delete your own comments');
    }
    await query('DELETE FROM discussion_messages WHERE id = $1', [req.params.commentId]);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- attachments

/** Attach a link — Google Docs, Sheets, Slides, Drive or any other http(s) URL. */
router.post(
  '/:id/attachments/link',
  asyncHandler(async (req, res) => {
    const { url, title } = z
      .object({ url: z.string().min(4), title: z.string().max(200).optional() })
      .parse(req.body);
    const taskId = Number(req.params.id);

    if (!(await canAccess(req.currentUser, taskId))) throw forbidden('You cannot add to this task');

    const safeUrl = assertSafeUrl(url.trim());
    const provider = detectProvider(safeUrl);

    const { rows } = await query(
      `INSERT INTO task_attachments (task_id, kind, title, url, provider, uploaded_by)
       VALUES ($1, 'link', $2, $3, $4, $5) RETURNING *`,
      [taskId, title?.trim() || null, safeUrl, provider, req.currentUser.id],
    );
    await logActivity(null, {
      taskId,
      actorId: req.currentUser.id,
      action: 'attached',
      field: 'link',
      to: title || safeUrl,
    });
    res.status(201).json({ attachment: rows[0] });
  }),
);

/** Upload an image or document. Files live on disk, never in the database. */
router.post(
  '/:id/attachments/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const taskId = Number(req.params.id);
    if (!req.file) throw badRequest('No file was received');

    if (!(await canAccess(req.currentUser, taskId))) {
      deleteStoredFile(req.file.filename);
      throw forbidden('You cannot add to this task');
    }

    const kind = req.file.mimetype.startsWith('image/') ? 'image' : 'file';
    const { rows } = await query(
      `INSERT INTO task_attachments
         (task_id, kind, title, file_name, stored_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        taskId,
        kind,
        req.body.title?.trim() || req.file.originalname,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        req.currentUser.id,
      ],
    );
    await logActivity(null, {
      taskId,
      actorId: req.currentUser.id,
      action: 'attached',
      field: kind,
      to: req.file.originalname,
    });
    res.status(201).json({ attachment: rows[0] });
  }),
);

/** Streams an uploaded file back, only to someone allowed to see the task. */
router.get(
  '/:taskId/attachments/:id/raw',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM task_attachments WHERE id = $1 AND task_id = $2',
      [req.params.id, req.params.taskId],
    );
    const attachment = rows[0];
    if (!attachment || !attachment.stored_name) throw notFound('Attachment not found');
    if (!(await canAccess(req.currentUser, Number(req.params.taskId)))) {
      throw forbidden('You cannot view this attachment');
    }

    const filePath = resolveStoredFile(attachment.stored_name);
    if (!fs.existsSync(filePath)) throw notFound('The file is no longer on the server');

    res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(attachment.file_name)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  }),
);

router.delete(
  '/:taskId/attachments/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM task_attachments WHERE id = $1 AND task_id = $2',
      [req.params.id, req.params.taskId],
    );
    const attachment = rows[0];
    if (!attachment) throw notFound('Attachment not found');
    if (attachment.uploaded_by !== req.currentUser.id && !hasPermission(req.currentUser, 'task.edit.any')) {
      throw forbidden('You can only remove attachments you added');
    }

    await query('DELETE FROM task_attachments WHERE id = $1', [attachment.id]);
    deleteStoredFile(attachment.stored_name);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- tagged people

router.post(
  '/:id/collaborators',
  asyncHandler(async (req, res) => {
    const { user_id: userId } = z.object({ user_id: z.number().int().positive() }).parse(req.body);
    const taskId = Number(req.params.id);

    const { rows: taskRows } = await query('SELECT id, ref, title FROM tasks WHERE id = $1', [taskId]);
    if (!taskRows[0]) throw notFound('Task not found');
    if (!(await canAccess(req.currentUser, taskId))) throw forbidden('You cannot change this task');

    await query(
      `INSERT INTO task_collaborators (task_id, user_id, added_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [taskId, userId, req.currentUser.id],
    );
    if (userId !== req.currentUser.id) {
      await notify(null, {
        userId,
        type: 'tagged',
        title: `You were tagged on ${taskRows[0].ref}`,
        body: taskRows[0].title,
        taskId,
      });
    }

    const { rows } = await query(
      `SELECT u.id, u.full_name, u.avatar_color, u.email, d.name AS department_name
         FROM task_collaborators tc
         JOIN users u ON u.id = tc.user_id
         LEFT JOIN departments d ON d.id = u.department_id
        WHERE tc.task_id = $1 ORDER BY u.full_name`,
      [taskId],
    );
    res.status(201).json({ collaborators: rows });
  }),
);

router.delete(
  '/:taskId/collaborators/:userId',
  asyncHandler(async (req, res) => {
    if (!(await canAccess(req.currentUser, Number(req.params.taskId)))) {
      throw forbidden('You cannot change this task');
    }
    await query('DELETE FROM task_collaborators WHERE task_id = $1 AND user_id = $2', [
      req.params.taskId,
      req.params.userId,
    ]);
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
