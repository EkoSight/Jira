/**
 * The overdue review screen and the decisions behind it: new deadlines,
 * deferrals and blocks, asked for and decided. Owners see their own overdue
 * work; approvers see their scope. Every proposed change is previewed before
 * it is saved, and every change is recorded (task activity and the change
 * records).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { logActivity } from '../services/activity.js';
import { runBlackMarkScan } from '../services/blackmarks.js';
import { spawnNextOccurrenceAfterCompletion } from '../services/recurrence.js';
import { isDealTask } from '../services/taskOutcomes.js';
import { deadlineClock, withHealth } from '../services/deadlines.js';
import { APPROVER_SQL, canApprove } from '../services/taskPeople.js';
import { replanTask } from '../services/taskReminders.js';
import {
  clearBlock, decideBlock, decideChange, decideOnRequest, loadTask, recordBlock, requestDeferral, requestNewDeadline,
  resumeDeferred, taskHistory, withdrawChange,
} from '../services/deadlineChanges.js';
import { canAccess } from './tasks.js';

const router = Router();
const id = (v) => Number(v);

const TASKS = `SELECT t.id, t.ref, t.title, t.due_date, t.original_due_date, t.due_date_changes, t.review_date, t.deferral_id, t.next_action,
         t.assignee_id, t.reporter_id, t.department_id, t.priority, t.status_id, t.blocked_reason, t.account_id, t.opportunity_id,
         t.parent_task_id, t.task_type, t.tags, t.follower_id,
         s.stage, s.name AS status_name, s.color AS status_color, u.full_name AS assignee_name, u.avatar_color AS assignee_color,
         d.name AS department_name, r.full_name AS reporter_name, f.full_name AS follower_name,
         p.ref AS parent_ref, p.title AS parent_title, acc.name AS account_name, opp.name AS opportunity_name,
         (SELECT COALESCE(json_agg(json_build_object('id', cu.id, 'name', cu.full_name)), '[]'::json)
            FROM task_collaborators tc JOIN users cu ON cu.id = tc.user_id WHERE tc.task_id = t.id) AS tagged,
         (SELECT COALESCE(json_agg(DISTINCT jsonb_build_object('id', o.id, 'title', o.title)), '[]'::json)
            FROM task_key_result_links l JOIN key_results kr ON kr.id = l.key_result_id JOIN objectives o ON o.id = kr.objective_id
           WHERE l.task_id = t.id AND kr.is_archived = FALSE AND o.is_archived = FALSE) AS goals,
         (SELECT row_to_json(c) FROM task_deadline_changes c WHERE c.task_id = t.id AND c.status = 'PENDING' ORDER BY c.id DESC LIMIT 1) AS pending_change,
         (SELECT row_to_json(b) FROM task_blocks b WHERE b.task_id = t.id AND b.status IN ('PENDING', 'ACCEPTED') ORDER BY b.id DESC LIMIT 1) AS open_block
    FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id JOIN departments d ON d.id = t.department_id
    LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN users r ON r.id = t.reporter_id LEFT JOIN users f ON f.id = t.follower_id
    LEFT JOIN tasks p ON p.id = t.parent_task_id
    LEFT JOIN accounts acc ON acc.id = t.account_id LEFT JOIN opportunities opp ON opp.id = t.opportunity_id`;

const DAY_MS = 86_400_000;

/**
 * What each overdue task can be filtered by, and the value(s) it has for each:
 * department, owner, who asked for it, supporters, project (the parent task
 * that groups subtasks; a parent counts as its own project), goal, lead or
 * organisation, deal, tag, priority, status and type.
 */
const FACETS = {
  department_id: (t) => [[t.department_id, t.department_name]],
  assignee_id: (t) => [[t.assignee_id || 'none', t.assignee_name || 'No owner']],
  reporter_id: (t) => (t.reporter_id ? [[t.reporter_id, t.reporter_name]] : []),
  supporter_id: (t) => [...(t.follower_id ? [[t.follower_id, t.follower_name]] : []), ...(t.tagged || []).map((p) => [p.id, p.name])],
  // a subtask belongs to its parent's project; a task with subtasks is a project itself
  project_id: (t) => [
    ...(t.parent_task_id ? [[t.parent_task_id, `${t.parent_ref} ${t.parent_title}`]] : []),
    ...(t.subtask_count > 0 ? [[t.id, `${t.ref} ${t.title}`]] : []),
  ],
  goal_id: (t) => (t.goals || []).map((g) => [g.id, g.title]),
  account_id: (t) => (t.account_id ? [[t.account_id, t.account_name]] : []),
  opportunity_id: (t) => (t.opportunity_id ? [[t.opportunity_id, t.opportunity_name]] : []),
  tag: (t) => (t.tags || []).map((tag) => [tag, tag]),
  priority: (t) => [[t.priority, t.priority]],
  stage: (t) => [[t.stage, t.status_name]],
  task_type: (t) => [[t.task_type, t.task_type]],
};
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];

/** Overdue work: mine, and (for approvers) the work I can decide on, with filters and what can be filtered by. */
router.get('/overdue', asyncHandler(async (req, res) => {
  const c = await deadlineClock();
  const all = hasPermission(req.currentUser, 'task.edit.any');
  const { rows } = await query(
    `${TASKS}
      WHERE t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled') AND t.deferral_id IS NULL AND t.due_date < now()
        AND t.followup_kind IS NULL
        AND (t.assignee_id = $1 OR ${APPROVER_SQL})
      ORDER BY t.due_date ASC LIMIT 2000`,
    [req.currentUser.id, all],
  );
  // which of these are projects (have subtasks of their own)
  const ids = rows.map((r) => r.id);
  const { rows: parents } = ids.length
    ? await query('SELECT parent_task_id AS id, COUNT(*)::int AS n FROM tasks WHERE parent_task_id = ANY($1::int[]) AND is_archived = FALSE GROUP BY parent_task_id', [ids])
    : { rows: [] };
  const subtasks = new Map(parents.map((p) => [p.id, p.n]));
  const base = withHealth(rows, c).map((t) => ({ ...t, subtask_count: subtasks.get(t.id) || 0, mine: t.assignee_id === req.currentUser.id }));

  // the filters asked for: each one narrows; several values of one filter are "any of"
  const q = req.query;
  const wanted = {};
  for (const key of Object.keys(FACETS)) if (q[key]) wanted[key] = String(q[key]).split(',').filter(Boolean);
  const minDays = Number(q.overdue_days) || 0;
  const term = String(q.search || '').trim().toLowerCase();
  const inScope = (t) => (q.scope === 'mine' ? t.mine : q.scope === 'team' ? !t.mine : true);
  /** Whether a task passes every filter, leaving one out (to count that filter's choices). */
  const passes = (t, except = null) => {
    for (const [key, w] of Object.entries(wanted)) {
      if (key === except) continue;
      if (!FACETS[key](t).some(([v]) => w.includes(String(v)))) return false;
    }
    if (minDays && (c.now.getTime() - new Date(t.due_date).getTime()) < minDays * DAY_MS) return false;
    if (q.waiting === '1' && !t.pending_change && !(t.open_block && t.open_block.status === 'PENDING')) return false;
    if (term && !`${t.ref} ${t.title} ${t.next_action || ''}`.toLowerCase().includes(term)) return false;
    return true;
  };
  const filtered = base.filter((t) => passes(t));
  const tasks = filtered.filter(inScope);
  if (q.sort === 'newest') tasks.sort((x, y) => new Date(y.due_date) - new Date(x.due_date));
  else if (q.sort === 'priority') tasks.sort((x, y) => PRIORITY_ORDER.indexOf(x.priority) - PRIORITY_ORDER.indexOf(y.priority) || new Date(x.due_date) - new Date(y.due_date));
  else tasks.sort((x, y) => new Date(x.due_date) - new Date(y.due_date));

  // Every choice, with how many tasks it would show given the other filters and
  // the Mine / My team switch. Choices come from everything in scope, so a
  // chosen one keeps its name even when it now matches nothing.
  const facets = {};
  for (const [key, valuesOf] of Object.entries(FACETS)) {
    const options = new Map();
    for (const t of base) {
      for (const [value, label] of valuesOf(t)) {
        if (value === null || value === undefined) continue;
        const k = String(value);
        if (!options.has(k)) options.set(k, { value: k, label: label || k, count: 0 });
      }
    }
    for (const t of base) {
      if (!inScope(t) || !passes(t, key)) continue;
      for (const k of new Set(valuesOf(t).map(([v]) => String(v)))) if (options.has(k)) options.get(k).count += 1;
    }
    facets[key] = [...options.values()].sort((x, y) => (key === 'priority'
      ? PRIORITY_ORDER.indexOf(x.value) - PRIORITY_ORDER.indexOf(y.value)
      : y.count - x.count || String(x.label).localeCompare(String(y.label))));
  }

  res.json({
    tasks: tasks.slice(0, 500),
    total: base.filter(inScope).length,
    matching: tasks.length,
    // how many match the filters on each side of the Mine / My team switch
    mine: filtered.filter((t) => t.mine).length,
    team: filtered.filter((t) => !t.mine).length,
    all_mine: base.filter((t) => t.mine).length,
    all_team: base.filter((t) => !t.mine).length,
    // more than 2000 overdue in scope: the choices and counts cover the oldest 2000
    capped: rows.length >= 2000,
    facets,
  });
}));

/** Requests and blocks waiting for my decision. */
router.get('/waiting', asyncHandler(async (req, res) => {
  const all = hasPermission(req.currentUser, 'task.edit.any');
  const { rows: changes } = await query(
    `SELECT c.*, t.ref, t.title, t.due_date, u.full_name AS requested_by_name, o.full_name AS owner_name
       FROM task_deadline_changes c JOIN tasks t ON t.id = c.task_id LEFT JOIN users u ON u.id = c.requested_by LEFT JOIN users o ON o.id = t.assignee_id
      WHERE c.status = 'PENDING' AND ${APPROVER_SQL} ORDER BY c.requested_at`,
    [req.currentUser.id, all],
  );
  const { rows: blocks } = await query(
    `SELECT b.*, t.ref, t.title, t.due_date, u.full_name AS recorded_by_name, o.full_name AS owner_name
       FROM task_blocks b JOIN tasks t ON t.id = b.task_id LEFT JOIN users u ON u.id = b.recorded_by LEFT JOIN users o ON o.id = t.assignee_id
      WHERE b.status = 'PENDING' AND ${APPROVER_SQL} ORDER BY b.recorded_at`,
    [req.currentUser.id, all],
  );
  const { rows: mine } = await query(
    `SELECT c.*, t.ref, t.title FROM task_deadline_changes c JOIN tasks t ON t.id = c.task_id
      WHERE c.requested_by = $1 AND c.status = 'PENDING' ORDER BY c.requested_at`,
    [req.currentUser.id],
  );
  res.json({ changes, blocks, my_requests: mine });
}));

// ---------------------------------------------------------------- bulk review: preview, then apply

const item = z.object({
  task_id: z.number().int().positive(),
  action: z.enum(['NEW_DATE', 'BLOCKED', 'DONE', 'DEFER']),
  due: z.string().optional(),
  reason: z.string().max(1000).optional(),
  review_date: z.string().optional(),
  next_action: z.string().max(500).optional(),
  dependency_text: z.string().max(500).optional(),
  evidence: z.string().max(2000).optional(),
  evidence_url: z.string().max(1000).optional(),
});
const batch = z.object({ items: z.array(item).min(1).max(100) });

const fmt = (d) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d)) : 'none');

/** What one item would do, without writing anything. */
async function previewItem(it, user) {
  const task = await loadTask(it.task_id);
  const mayEdit = [task.assignee_id, task.follower_id, task.reporter_id, task.created_by].includes(user.id) || hasPermission(user, 'task.edit.any');
  const approver = await canApprove(user, task);
  if (!mayEdit && !approver) return { task_id: task.id, ok: false, error: 'You cannot change this task' };
  if (task.followup_kind) return { task_id: task.id, ok: false, error: 'A CRM follow-up is rescheduled from the lead' };
  const base = { task_id: task.id, ref: task.ref, title: task.title, action: it.action };
  const why = String(it.reason || '').trim();
  switch (it.action) {
    case 'NEW_DATE': {
      if (why.length < 5) return { ...base, ok: false, error: 'Say why the deadline is moving' };
      if (!it.due || Number.isNaN(new Date(it.due).getTime())) return { ...base, ok: false, error: 'Choose the new deadline' };
      if (new Date(it.due) < new Date()) return { ...base, ok: false, error: 'The new deadline has to be in the future' };
      const d = await decideOnRequest(task, user);
      return { ...base, ok: true, applies_now: d.status === 'APPROVED', effect: `Deadline ${fmt(task.due_date)} → ${fmt(it.due)}${d.status === 'APPROVED' ? (d.auto ? ' (your one move as the owner)' : '') : ', after approval'}`, note: d.why || null };
    }
    case 'DEFER': {
      if (why.length < 5) return { ...base, ok: false, error: 'Say why it is being deferred' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(it.review_date || ''))) return { ...base, ok: false, error: 'Choose a review date' };
      if (String(it.next_action || '').trim().length < 3) return { ...base, ok: false, error: 'Say what the next action is' };
      const d = await decideOnRequest(task, user);
      return { ...base, ok: true, applies_now: d.status === 'APPROVED', effect: `To Backlog, deadline ${fmt(task.due_date)} paused, review on ${it.review_date}${d.status === 'APPROVED' ? '' : ', after approval'}`, note: d.why || null };
    }
    case 'BLOCKED':
      if (why.length < 5) return { ...base, ok: false, error: 'Say what the task is waiting on' };
      return { ...base, ok: true, applies_now: true, effect: `Marked blocked: "${why}"${approver ? ', accepted by you' : ', waiting for an approver to accept it (until then marks are not paused)'}` };
    case 'DONE': {
      if (String(it.evidence || '').trim().length < 5) return { ...base, ok: false, error: 'Say what was done (the evidence)' };
      if (isDealTask(task)) return { ...base, ok: false, error: 'Finish deal work from the task itself: it records the deal\'s outcome' };
      const late = task.due_date && new Date(task.due_date) < new Date();
      return { ...base, ok: true, applies_now: true, effect: `Moved to Done with your note${late ? '. It was finished after its deadline, so the black-mark rules may record it as delivered late' : ''}` };
    }
    default:
      return { ...base, ok: false, error: 'Unknown action' };
  }
}

router.post('/preview', asyncHandler(async (req, res) => {
  const { items } = batch.parse(req.body || {});
  const out = [];
  for (const it of items) {
    try { out.push(await previewItem(it, req.currentUser)); } catch (err) { out.push({ task_id: it.task_id, ok: false, error: err.message }); }
  }
  res.json({ items: out, ready: out.every((x) => x.ok) });
}));

async function completeWithEvidence(taskId, user, { evidence, evidence_url: url }) {
  const task = await withTransaction(async (client) => {
    const t = await loadTask(taskId, client);
    const { rows } = await client.query(`SELECT id FROM workflow_statuses WHERE stage = 'done' AND is_active ORDER BY position LIMIT 1`);
    if (!rows[0]) throw badRequest('No "done" status is configured');
    const note = `${String(evidence).trim()}${url ? `\nEvidence: ${url}` : ''}`;
    await client.query(
      `UPDATE tasks SET status_id = $2, completed_at = now(), progress = 100, completion_note = $3, updated_at = now() WHERE id = $1`,
      [taskId, rows[0].id, note],
    );
    await logActivity(client, { taskId, actorId: user.id, action: 'completed', to: note, meta: { via: 'overdue review', evidence_url: url || null } });
    return { ...t, stage: 'done', completed_at: new Date() };
  });
  await spawnNextOccurrenceAfterCompletion(task).catch((err) => console.error('[taskflow] next occurrence failed:', err.message));
  await runBlackMarkScan({ taskId }).catch((err) => console.error('[taskflow] black mark scan failed:', err.message));
  await replanTask(taskId);
}

router.post('/apply', asyncHandler(async (req, res) => {
  const { items } = batch.parse(req.body || {});
  const results = [];
  for (const it of items) {
    try {
      const preview = await previewItem(it, req.currentUser);
      if (!preview.ok) { results.push(preview); continue; }
      let detail = null;
      if (it.action === 'NEW_DATE') {
        detail = await withTransaction(async (client) => requestNewDeadline(client, await loadTask(it.task_id, client), req.currentUser, { toDue: it.due, reason: it.reason }));
        await replanTask(it.task_id);
      }
      if (it.action === 'DEFER') detail = await requestDeferral(it.task_id, req.currentUser, it);
      if (it.action === 'BLOCKED') detail = await recordBlock(it.task_id, req.currentUser, { reason: it.reason, dependency_text: it.dependency_text });
      if (it.action === 'DONE') await completeWithEvidence(it.task_id, req.currentUser, it);
      results.push({ ...preview, done: true, status: detail?.status || 'APPLIED' });
    } catch (err) {
      results.push({ task_id: it.task_id, ok: false, error: err.message });
    }
  }
  res.json({ results });
}));

// ---------------------------------------------------------------- one task

router.get('/task/:id', asyncHandler(async (req, res) => {
  if (!(await canAccess(req.currentUser, id(req.params.id)))) throw forbidden('You cannot see this task');
  const task = await loadTask(id(req.params.id));
  res.json({ ...(await taskHistory(task.id)), can_approve: await canApprove(req.currentUser, task) });
}));

router.post('/task/:id/defer', asyncHandler(async (req, res) => {
  const tid = id(req.params.id);
  if (!(await canAccess(req.currentUser, tid))) throw forbidden('You cannot see this task');
  res.status(201).json(await requestDeferral(tid, req.currentUser, req.body || {}));
}));

router.post('/task/:id/resume', asyncHandler(async (req, res) => {
  const body = z.object({ due: z.string(), reason: z.string() }).parse(req.body || {});
  res.json(await resumeDeferred(id(req.params.id), req.currentUser, { toDue: body.due, reason: body.reason }));
}));

router.post('/task/:id/block', asyncHandler(async (req, res) => {
  res.status(201).json(await recordBlock(id(req.params.id), req.currentUser, req.body || {}));
}));

router.post('/changes/:id/approve', asyncHandler(async (req, res) => res.json(await decideChange(id(req.params.id), req.currentUser, { approve: true, note: req.body?.note }))));
router.post('/changes/:id/decline', asyncHandler(async (req, res) => res.json(await decideChange(id(req.params.id), req.currentUser, { approve: false, note: req.body?.note }))));
router.post('/changes/:id/withdraw', asyncHandler(async (req, res) => res.json(await withdrawChange(id(req.params.id), req.currentUser))));
router.post('/blocks/:id/accept', asyncHandler(async (req, res) => res.json(await decideBlock(id(req.params.id), req.currentUser, { accept: true, note: req.body?.note }))));
router.post('/blocks/:id/decline', asyncHandler(async (req, res) => res.json(await decideBlock(id(req.params.id), req.currentUser, { accept: false, note: req.body?.note }))));
router.post('/blocks/:id/clear', asyncHandler(async (req, res) => res.json(await clearBlock(id(req.params.id), req.currentUser, { note: req.body?.note }))));

export default router;
