/**
 * Deadline changes, deferrals and blocks: every one with a reason, every
 * decision recorded, nothing changed behind anyone's back.
 *
 *   D1  the owner may move their own deadline once, before it passes, with a
 *       reason; any other change, or any change after the deadline, waits for
 *       an approver (the reporter when they are not the owner, the owner's
 *       reporting manager, the department's managers, or someone who may edit
 *       every task). The owner never approves their own.
 *   Defer   records the reason, the next action, a review date and any
 *       dependency; keeps the previous status and deadline; approved the same
 *       way. While approved, the deadline is paused: never overdue, no
 *       reminders, no black marks. Resuming needs a new deadline, approved the
 *       same way; the deferral ends when that is approved.
 *   D3  a block records what the task waits on; an approver accepts it. An
 *       accepted block pauses black marks for the deadlines it covers until it
 *       is cleared.
 *
 * CRM follow-up tasks keep their own reschedule flow and are not covered here.
 */
import { query, withTransaction } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { assertUsableDeadline } from '../lib/deadline.js';
import { logActivity, notify } from './activity.js';
import { getSettings } from './settings.js';
import { canApprove, departmentManagers, reportingManager } from './taskPeople.js';
import { replanTask } from './taskReminders.js';

const TASK = `SELECT t.*, s.stage, s.name AS status_name, u.full_name AS owner_name
                FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id LEFT JOIN users u ON u.id = t.assignee_id`;

export async function loadTask(taskId, runner = { query }) {
  const { rows } = await runner.query(`${TASK} WHERE t.id = $1`, [taskId]);
  if (!rows[0]) throw notFound('Task not found');
  return rows[0];
}

const when = (d) => (d ? new Date(d).toISOString() : null);

/** The people asked to decide, to be told about a request. */
async function approversToTell(task, runner) {
  const out = new Map();
  if (task.reporter_id && task.reporter_id !== task.assignee_id) out.set(task.reporter_id, true);
  const m = await reportingManager(task.assignee_id, runner);
  if (m && m.id !== task.assignee_id) out.set(m.id, true);
  for (const d of await departmentManagers(task.department_id, runner)) if (d.id !== task.assignee_id) out.set(d.id, true);
  return [...out.keys()];
}

/**
 * What happens to a request to move this task's deadline (or defer it) now,
 * before anything is written: APPROVED (and whether as the owner's one move)
 * or PENDING.
 */
export async function decideOnRequest(task, user, now = new Date(), runner = { query }) {
  const beforeDeadline = !task.due_date || now.getTime() < new Date(task.due_date).getTime();
  if (await canApprove(user, task, runner)) return { status: 'APPROVED', auto: false, beforeDeadline, by: user.id };
  if (user.id === task.assignee_id && !task.due_date) return { status: 'APPROVED', auto: false, beforeDeadline, by: user.id, firstDate: true };
  if (user.id === task.assignee_id && beforeDeadline) {
    const { rows } = await runner.query(
      `SELECT COUNT(*)::int AS n FROM task_deadline_changes WHERE task_id = $1 AND requested_by = $2 AND auto_approved`,
      [task.id, user.id],
    );
    if (rows[0].n === 0) return { status: 'APPROVED', auto: true, beforeDeadline, by: null };
    return { status: 'PENDING', beforeDeadline, why: 'You have already moved this deadline once yourself; another move needs approval' };
  }
  return {
    status: 'PENDING', beforeDeadline,
    why: user.id === task.assignee_id ? 'The deadline has passed: a new one needs approval' : 'Only the owner (once, before the deadline) or an approver can move it directly',
  };
}

/** Writes a deadline move that is approved: the task, its history and its reminders. */
async function applyNewDeadline(client, task, change, actorId) {
  await client.query(
    `UPDATE tasks SET due_date = $2, due_date_changes = due_date_changes + 1,
            original_due_date = COALESCE(original_due_date, due_date, $2), updated_at = now() WHERE id = $1`,
    [task.id, change.to_due],
  );
  await logActivity(client, {
    taskId: task.id, actorId, action: 'updated', field: 'due_date', from: task.due_date, to: change.to_due,
    meta: { reason: change.reason, change_id: change.id, approved_by: change.decided_by, auto_approved: change.auto_approved },
  });
}

/**
 * Records a request to move the deadline and, when allowed, applies it.
 * `client` is the caller's transaction (the task edit), so a refusal changes nothing.
 */
export async function requestNewDeadline(client, task, user, { toDue, reason, endsDeferral = false }, now = new Date()) {
  if (task.followup_kind) throw badRequest('A CRM follow-up is rescheduled from the lead, not here');
  const why = String(reason || '').trim();
  if (why.length < 5) throw badRequest('Say why the deadline is moving (a few words), so the change can be reviewed');
  const settings = await getSettings();
  const due = assertUsableDeadline(toDue, { recurrence: task.recurrence, maxHorizonDays: settings.deadlines?.maxHorizonDays, now });
  const decision = await decideOnRequest(task, user, now, client);
  // one request waiting at a time: a new one replaces the old
  await client.query(
    `UPDATE task_deadline_changes SET status = 'WITHDRAWN', decision_note = 'Replaced by a newer request', decided_at = now()
      WHERE task_id = $1 AND kind = 'EXTEND' AND status = 'PENDING'`,
    [task.id],
  );
  const { rows } = await client.query(
    `INSERT INTO task_deadline_changes (task_id, kind, requested_by, reason, from_due, to_due, before_deadline, status, auto_approved, decided_by, decided_at, decision_note)
     VALUES ($1, 'EXTEND', $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 'APPROVED' THEN now() END, $10) RETURNING *`,
    [task.id, user.id, why, task.due_date, due, decision.beforeDeadline, decision.status, Boolean(decision.auto), decision.by ?? null,
      endsDeferral ? 'Resumes the deferred task' : decision.firstDate ? 'A first deadline for a task that had none' : null],
  );
  const change = rows[0];
  if (decision.status === 'APPROVED') {
    await applyNewDeadline(client, task, change, user.id);
    if (endsDeferral) await endDeferralRecord(client, task, user.id, `Resumed with a new deadline: ${why}`);
  } else {
    for (const id of await approversToTell(task, client)) {
      await notify(client, {
        userId: id, type: 'deadline_request',
        title: `${task.ref}: a new deadline is waiting for your decision`,
        body: `${task.title} · asked by ${user.full_name || 'someone'} · ${why}`, taskId: task.id,
      });
    }
  }
  return { ...change, why: decision.why || null, applied: decision.status === 'APPROVED' };
}

/** The first backlog-stage status, where deferred work waits. */
async function backlogStatus(runner) {
  const { rows } = await runner.query(`SELECT id FROM workflow_statuses WHERE stage = 'backlog' AND is_active ORDER BY position LIMIT 1`);
  return rows[0]?.id || null;
}

async function applyDeferral(client, task, change, actorId) {
  const backlog = await backlogStatus(client);
  await client.query(
    `UPDATE tasks SET deferral_id = $2, review_date = $3, next_action = COALESCE($4, next_action),
            status_id = COALESCE($5, status_id), updated_at = now() WHERE id = $1`,
    [task.id, change.id, change.review_date, change.next_action, backlog],
  );
  await logActivity(client, {
    taskId: task.id, actorId, action: 'deferred', from: task.status_name, to: change.review_date,
    meta: { reason: change.reason, change_id: change.id, previous_status_id: task.status_id, previous_due: when(task.due_date), dependency_task_id: change.dependency_task_id, dependency_text: change.dependency_text },
  });
}

async function endDeferralRecord(client, task, actorId, note) {
  if (!task.deferral_id) return;
  const { rows } = await client.query('SELECT * FROM task_deadline_changes WHERE id = $1', [task.deferral_id]);
  const d = rows[0];
  await client.query(
    `UPDATE task_deadline_changes SET status = 'ENDED', ended_by = $2, ended_at = now(), end_note = $3 WHERE id = $1`,
    [task.deferral_id, actorId, note],
  );
  await client.query(
    `UPDATE tasks SET deferral_id = NULL, status_id = COALESCE($2, status_id), updated_at = now() WHERE id = $1`,
    [task.id, d?.from_status_id ?? null],
  );
  await logActivity(client, { taskId: task.id, actorId, action: 'deferral_ended', meta: { change_id: task.deferral_id, note } });
}

/** Asks to defer a task (or defers it, when allowed). */
export async function requestDeferral(taskId, user, body, now = new Date()) {
  return withTransaction(async (client) => {
    const task = await loadTask(taskId, client);
    if (task.followup_kind) throw badRequest('A CRM follow-up is rescheduled from the lead, not deferred');
    if (['done', 'cancelled'].includes(task.stage)) throw badRequest('This task is already closed');
    if (task.deferral_id) throw badRequest('This task is already deferred');
    const reason = String(body.reason || '').trim();
    const next = String(body.next_action || '').trim();
    if (reason.length < 5) throw badRequest('Say why the task is being deferred');
    if (next.length < 3) throw badRequest('Say what the next action is, even if it is "decide whether to drop it"');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.review_date || ''))) throw badRequest('Choose a review date');
    if (body.review_date < now.toISOString().slice(0, 10)) throw badRequest('The review date has to be today or later');
    const decision = await decideOnRequest(task, user, now, client);
    await client.query(
      `UPDATE task_deadline_changes SET status = 'WITHDRAWN', decision_note = 'Replaced by a newer request', decided_at = now()
        WHERE task_id = $1 AND kind = 'DEFER' AND status = 'PENDING'`,
      [task.id],
    );
    const { rows } = await client.query(
      `INSERT INTO task_deadline_changes (task_id, kind, requested_by, reason, from_due, before_deadline, from_status_id, review_date, next_action,
                                          dependency_task_id, dependency_text, status, auto_approved, decided_by, decided_at)
       VALUES ($1, 'DEFER', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $11 = 'APPROVED' THEN now() END) RETURNING *`,
      [task.id, user.id, reason, task.due_date, decision.beforeDeadline, task.status_id, body.review_date, next,
        body.dependency_task_id || null, body.dependency_text || null, decision.status, Boolean(decision.auto), decision.by ?? null],
    );
    const change = rows[0];
    if (decision.status === 'APPROVED') await applyDeferral(client, task, change, user.id);
    else {
      for (const id of await approversToTell(task, client)) {
        await notify(client, { userId: id, type: 'deadline_request', title: `${task.ref}: a deferral is waiting for your decision`, body: `${task.title} · ${reason}`, taskId: task.id });
      }
    }
    return { ...change, why: decision.why || null, applied: decision.status === 'APPROVED' };
  }).then(async (r) => { await replanTask(taskId); return r; });
}

/** Resumes a deferred task with a new deadline (approved under D1 like any other move). */
export async function resumeDeferred(taskId, user, { toDue, reason }, now = new Date()) {
  const r = await withTransaction(async (client) => {
    const task = await loadTask(taskId, client);
    if (!task.deferral_id) throw badRequest('This task is not deferred');
    return requestNewDeadline(client, task, user, { toDue, reason, endsDeferral: true }, now);
  });
  await replanTask(taskId);
  return r;
}

/** An approver decides on a waiting deadline change or deferral. */
export async function decideChange(changeId, user, { approve, note }) {
  const r = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM task_deadline_changes WHERE id = $1 FOR UPDATE', [changeId]);
    const change = rows[0];
    if (!change) throw notFound('Request not found');
    if (change.status !== 'PENDING') throw badRequest('This request has already been decided');
    const task = await loadTask(change.task_id, client);
    if (!(await canApprove(user, task, client))) throw forbidden('Only the reporter, the owner\'s manager or a department manager can decide this');
    if (!approve && String(note || '').trim().length < 3) throw badRequest('Say why it is declined, so the owner knows what to do next');
    await client.query(
      `UPDATE task_deadline_changes SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
      [changeId, approve ? 'APPROVED' : 'DECLINED', user.id, note || null],
    );
    const decided = { ...change, status: approve ? 'APPROVED' : 'DECLINED', decided_by: user.id };
    if (approve && change.kind === 'EXTEND') {
      await applyNewDeadline(client, task, decided, user.id);
      if (task.deferral_id && change.decision_note === 'Resumes the deferred task') await endDeferralRecord(client, task, user.id, `Resumed with a new deadline: ${change.reason}`);
    }
    if (approve && change.kind === 'DEFER') await applyDeferral(client, task, decided, user.id);
    if (!approve) await logActivity(client, { taskId: task.id, actorId: user.id, action: 'request_declined', meta: { change_id: changeId, kind: change.kind, note } });
    await notify(client, {
      userId: change.requested_by, type: 'deadline_decision',
      title: `${task.ref}: your ${change.kind === 'DEFER' ? 'deferral' : 'new deadline'} was ${approve ? 'approved' : 'declined'}`,
      body: note || task.title, taskId: task.id,
    });
    return decided;
  });
  await replanTask(r.task_id);
  return r;
}

export async function withdrawChange(changeId, user) {
  const { rows } = await query(
    `UPDATE task_deadline_changes SET status = 'WITHDRAWN', decided_at = now(), decision_note = 'Withdrawn by the person who asked'
      WHERE id = $1 AND requested_by = $2 AND status = 'PENDING' RETURNING *`,
    [changeId, user.id],
  );
  if (!rows[0]) throw badRequest('Only a waiting request of your own can be withdrawn');
  return rows[0];
}

// ---------------------------------------------------------------- blocks (D3)

export async function recordBlock(taskId, user, body) {
  const r = await withTransaction(async (client) => {
    const task = await loadTask(taskId, client);
    if (['done', 'cancelled'].includes(task.stage)) throw badRequest('This task is already closed');
    const reason = String(body.reason || '').trim();
    if (reason.length < 5) throw badRequest('Say what the task is waiting on');
    const involved = [task.assignee_id, task.follower_id, task.reporter_id, task.created_by].includes(user.id);
    if (!involved && !hasPermission(user, 'task.edit.any') && !(await canApprove(user, task, client))) throw forbidden('You cannot record a block on this task');
    const accepting = await canApprove(user, task, client);
    const { rows } = await client.query(
      `INSERT INTO task_blocks (task_id, reason, dependency_task_id, dependency_text, recorded_by, status, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 = 'ACCEPTED' THEN now() END) RETURNING *`,
      [task.id, reason, body.dependency_task_id || null, body.dependency_text || null, user.id, accepting ? 'ACCEPTED' : 'PENDING', accepting ? user.id : null],
    );
    const { rows: blocked } = await client.query(`SELECT id FROM workflow_statuses WHERE stage = 'blocked' AND is_active ORDER BY position LIMIT 1`);
    await client.query(
      `UPDATE tasks SET blocked_reason = $2, status_id = CASE WHEN $3::int IS NOT NULL AND (SELECT stage FROM workflow_statuses WHERE id = status_id) <> 'blocked' THEN $3::int ELSE status_id END, updated_at = now() WHERE id = $1`,
      [task.id, reason, blocked[0]?.id ?? null],
    );
    await logActivity(client, { taskId: task.id, actorId: user.id, action: 'blocked', to: reason, meta: { block_id: rows[0].id, accepted: accepting } });
    if (!accepting) {
      for (const id of await approversToTell(task, client)) {
        await notify(client, { userId: id, type: 'block_request', title: `${task.ref} is blocked: accept or not?`, body: reason, taskId: task.id });
      }
    }
    return rows[0];
  });
  await replanTask(taskId);
  return r;
}

export async function decideBlock(blockId, user, { accept, note }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM task_blocks WHERE id = $1 FOR UPDATE', [blockId]);
    const b = rows[0];
    if (!b) throw notFound('Block not found');
    if (b.status !== 'PENDING') throw badRequest('This block has already been decided');
    const task = await loadTask(b.task_id, client);
    if (!(await canApprove(user, task, client))) throw forbidden('Only the reporter, the owner\'s manager or a department manager can accept a block');
    await client.query(`UPDATE task_blocks SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [blockId, accept ? 'ACCEPTED' : 'DECLINED', user.id, note || null]);
    await logActivity(client, { taskId: task.id, actorId: user.id, action: accept ? 'block_accepted' : 'block_declined', meta: { block_id: blockId, note } });
    await notify(client, { userId: b.recorded_by, type: 'block_decision', title: `${task.ref}: the block was ${accept ? 'accepted' : 'not accepted'}`, body: note || b.reason, taskId: task.id });
    return { ...b, status: accept ? 'ACCEPTED' : 'DECLINED' };
  });
}

export async function clearBlock(blockId, user, { note }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM task_blocks WHERE id = $1 FOR UPDATE', [blockId]);
    const b = rows[0];
    if (!b) throw notFound('Block not found');
    if (!['PENDING', 'ACCEPTED'].includes(b.status)) throw badRequest('This block is not open');
    const task = await loadTask(b.task_id, client);
    const involved = [task.assignee_id, task.follower_id, task.reporter_id].includes(user.id);
    if (!involved && !(await canApprove(user, task, client))) throw forbidden('You cannot clear this block');
    await client.query(`UPDATE task_blocks SET status = 'CLEARED', cleared_by = $2, cleared_at = now(), clear_note = $3 WHERE id = $1`, [blockId, user.id, note || null]);
    await logActivity(client, { taskId: task.id, actorId: user.id, action: 'block_cleared', meta: { block_id: blockId, note } });
    return { ...b, status: 'CLEARED' };
  });
}

/** The deadline changes, deferrals and blocks of one task, newest first. */
export async function taskHistory(taskId) {
  const [changes, blocks] = await Promise.all([
    query(
      `SELECT c.*, r.full_name AS requested_by_name, d.full_name AS decided_by_name, e.full_name AS ended_by_name
         FROM task_deadline_changes c LEFT JOIN users r ON r.id = c.requested_by LEFT JOIN users d ON d.id = c.decided_by LEFT JOIN users e ON e.id = c.ended_by
        WHERE c.task_id = $1 ORDER BY c.requested_at DESC, c.id DESC`,
      [taskId],
    ),
    query(
      `SELECT b.*, r.full_name AS recorded_by_name, d.full_name AS decided_by_name, c.full_name AS cleared_by_name
         FROM task_blocks b LEFT JOIN users r ON r.id = b.recorded_by LEFT JOIN users d ON d.id = b.decided_by LEFT JOIN users c ON c.id = b.cleared_by
        WHERE b.task_id = $1 ORDER BY b.recorded_at DESC, b.id DESC`,
      [taskId],
    ),
  ]);
  return { changes: changes.rows, blocks: blocks.rows };
}
