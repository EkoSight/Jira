/**
 * Follow-ups are TaskFlow tasks — one record, in My Tasks like any other task,
 * on the board, in reports — with a kind (call, callback, meeting…), an outcome
 * and a link to the lead, organization or deal they are for. There is no
 * second to-do list.
 *
 * Overdue (a scheduled follow-up past its time) and stale (a lead or deal
 * nobody has had two-way contact with for a while) are different facts with
 * different escalations; both are computed here and in the worker.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { nextTaskRef } from '../../lib/taskRef.js';
import { logActivity as logTaskActivity, notify } from '../activity.js';
import { logActivity as logAccountActivity } from '../crm.js';
import { logLeadActivity } from './leads.js';
import { FOLLOWUP_KINDS, cleanText, emitEvent, salesSettings, scopeCondition, workCalendar } from './core.js';

const PRIORITY = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', URGENT: 'critical' };
const OPEN = `t.is_archived = FALSE AND t.completed_at IS NULL AND t.crm_cancel_reason IS NULL`;

export const FOLLOWUP_SELECT = `
  SELECT t.id, t.ref, t.title, t.description, t.due_date, t.priority, t.assignee_id, t.completed_at, t.followup_kind,
         t.followup_outcome, t.snoozed_until, t.reminder_at, t.escalated_at, t.crm_lead_id, t.account_id, t.opportunity_id,
         t.due_date_changes, t.original_due_date, t.crm_cancel_reason, t.completion_note, t.recurrence,
         u.full_name AS assignee_name, l.ref AS lead_ref, COALESCE(l.organization_name, l.contact_name) AS lead_name,
         a.name AS account_name, o.name AS opportunity_name, ws.stage AS status_stage,
         COALESCE(l.phone, (SELECT c.phone FROM account_contacts c WHERE c.account_id = t.account_id AND c.is_active = TRUE
                            ORDER BY c.is_primary DESC, c.id LIMIT 1)) AS phone
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN crm_leads l ON l.id = t.crm_lead_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN opportunities o ON o.id = t.opportunity_id
    LEFT JOIN workflow_statuses ws ON ws.id = t.status_id`;

async function departmentFor(client, { assigneeId, leadId, accountId, actor }) {
  const settings = await salesSettings();
  const { rows } = await client.query(
    `SELECT COALESCE(
        (SELECT department_id FROM users WHERE id = $1),
        (SELECT department_id FROM crm_leads WHERE id = $2),
        (SELECT department_id FROM accounts WHERE id = $3),
        $4::int, $5::int) AS id`,
    [assigneeId, leadId, accountId, settings.followUps?.departmentId ?? null, actor?.department_id ?? null],
  );
  return rows[0]?.id ?? null;
}

/** Keeps a lead's "next follow-up" in step with its earliest open follow-up. */
export async function refreshLeadNextFollowUp(client, leadId) {
  if (!leadId) return;
  await client.query(
    `UPDATE crm_leads SET next_follow_up_at = (
        SELECT MIN(t.due_date) FROM tasks t WHERE t.crm_lead_id = $1 AND t.followup_kind IS NOT NULL AND ${OPEN})
      WHERE id = $1`,
    [leadId],
  );
}

/** A new follow-up on a lead, organization or deal. */
export async function createFollowUp(client, {
  leadId = null, accountId = null, opportunityId = null, kind = 'CALL', title = null, dueAt, assigneeId = null, priority = 'MEDIUM',
  notes = null, actor, recurrence = 'none', reminderMinutes = 15, origin = 'USER', depth = 0, automationRunId = null, causeRuleId = null,
}) {
  if (!FOLLOWUP_KINDS.includes(kind)) throw badRequest('Unknown kind of follow-up');
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw badRequest('Give the follow-up a date and time');
  if (due.getTime() < Date.now() - 5 * 60_000 && origin === 'USER') throw badRequest('A follow-up cannot be scheduled in the past');
  if (!leadId && !accountId && !opportunityId) throw badRequest('A follow-up must be for a lead, an organization or a deal');
  let ownerId = assigneeId;
  let name = null;
  if (leadId) {
    const { rows } = await client.query('SELECT owner_user_id, ref, organization_name, contact_name, account_id, converted_opportunity_id FROM crm_leads WHERE id = $1', [leadId]);
    if (!rows[0]) throw notFound('Lead not found');
    ownerId = ownerId || rows[0].owner_user_id;
    name = rows[0].organization_name || rows[0].contact_name || rows[0].ref;
    accountId = accountId || rows[0].account_id;
    opportunityId = opportunityId || rows[0].converted_opportunity_id;
  }
  if (opportunityId && !accountId) accountId = (await client.query('SELECT account_id FROM opportunities WHERE id = $1', [opportunityId])).rows[0]?.account_id ?? null;
  if (!name && accountId) name = (await client.query('SELECT name FROM accounts WHERE id = $1', [accountId])).rows[0]?.name;
  ownerId = ownerId || actor?.id || null;
  if (ownerId) {
    const { rows } = await client.query('SELECT is_active FROM users WHERE id = $1', [ownerId]);
    if (!rows[0]?.is_active) throw badRequest('The follow-up must be owed by an active person');
  }
  const departmentId = await departmentFor(client, { assigneeId: ownerId, leadId, accountId, actor });
  if (!departmentId) throw badRequest('There is no department to file this follow-up in: set one in Settings → Sales CRM → Follow-ups');
  const { rows: status } = await client.query(
    `SELECT id FROM workflow_statuses WHERE is_active = TRUE AND stage IN ('todo', 'backlog') ORDER BY is_default DESC, (stage = 'todo') DESC, position LIMIT 1`,
  );
  const ref = await nextTaskRef(client, departmentId);
  const verb = { CALL: 'Call', CALLBACK: 'Call back', MEETING: 'Meet', EMAIL: 'Email', WHATSAPP: 'WhatsApp', DEMO: 'Demo for', DOCUMENT: 'Get documents from', VISIT: 'Visit', OTHER: 'Follow up with' }[kind];
  const { rows } = await client.query(
    `INSERT INTO tasks (ref, title, description, department_id, status_id, priority, assignee_id, reporter_id, created_by, due_date,
                        original_due_date, account_id, opportunity_id, crm_lead_id, followup_kind, reminder_at, recurrence, automation_run_id, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9,$10,$11,$12,$13,$14,$15,$16,(SELECT COALESCE(MAX(position),0)+100 FROM tasks WHERE status_id = $5))
     RETURNING *`,
    [ref, cleanText(title, 300) || `${verb} ${name || ''}`.trim(), cleanText(notes, 5000), departmentId, status[0].id,
      PRIORITY[priority] || 'medium', ownerId, actor?.id ?? null, due, accountId, opportunityId, leadId, kind,
      reminderMinutes ? new Date(due.getTime() - reminderMinutes * 60_000) : null, recurrence || 'none', automationRunId],
  );
  const task = rows[0];
  await logTaskActivity(client, { taskId: task.id, actorId: actor?.id ?? null, action: 'created', meta: { followup: kind, origin } });
  if (leadId) {
    await refreshLeadNextFollowUp(client, leadId);
    // the due time in the CRM's own time zone, as people read it
    const tz = (await salesSettings()).calendar?.timezone || 'Asia/Kolkata';
    const dueText = due.toLocaleString('en-IN', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    await logLeadActivity(client, leadId, { type: 'FOLLOWUP', subject: `${task.title} — due ${dueText}`, actorId: actor?.id ?? null, taskId: task.id, meta: { kind, due_at: due.toISOString() } });
  }
  if (ownerId && ownerId !== actor?.id) {
    await notify(client, { userId: ownerId, type: 'crm_followup', title: `Follow-up: ${task.title}`, body: `Due ${due.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`, taskId: task.id, leadId, accountId });
  }
  await emitEvent(client, { type: 'followup.created', entityType: 'TASK', entityId: task.id, origin, depth, ruleId: causeRuleId, actorId: actor?.id ?? null, payload: { lead_id: leadId, account_id: accountId, opportunity_id: opportunityId, kind } });
  return task;
}

async function loadFollowUp(client, taskId, actor, { forUpdate = true } = {}) {
  const { rows } = await client.query(`SELECT * FROM tasks WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [taskId]);
  const task = rows[0];
  if (!task || !task.followup_kind) throw notFound('Follow-up not found');
  const mayAct = task.assignee_id === actor.id || task.created_by === actor.id
    || hasPermission(actor, 'crm.assign') || hasPermission(actor, 'crm.manage.any');
  if (!mayAct) throw forbidden('Only the person who owes this follow-up, or someone who can assign work, can change it');
  return task;
}

const KIND_ACTIVITY = { CALL: 'CALL', CALLBACK: 'CALL', MEETING: 'MEETING', DEMO: 'DEMO', VISIT: 'IN_PERSON', EMAIL: 'EMAIL', WHATSAPP: 'WHATSAPP', DOCUMENT: 'NOTE', OTHER: 'NOTE' };

/**
 * Records what happened and, optionally, books the next follow-up in the same
 * step — the way a call is actually worked.
 *   outcome: CONNECTED | NO_ANSWER | BUSY | WRONG_NUMBER | LEFT_MESSAGE | DONE | NOT_DONE
 */
export async function completeFollowUp(taskId, { outcome = 'DONE', notes = null, next = null, noNextReason = null }, actor) {
  return withTransaction(async (client) => {
    const task = await loadFollowUp(client, taskId, actor);
    if (task.completed_at) return { task, already: true };
    if (task.crm_cancel_reason) throw badRequest('This follow-up was cancelled');
    if (!cleanText(notes) && !['NO_ANSWER', 'BUSY', 'WRONG_NUMBER'].includes(outcome)) throw badRequest('Write what happened');
    // a deal that would be left with nothing next says so, or gets a next step
    if (task.opportunity_id && !next) {
      const { rows } = await client.query(`SELECT status, next_step_task_id FROM opportunities WHERE id = $1`, [task.opportunity_id]);
      if (rows[0]?.status === 'ACTIVE' && rows[0].next_step_task_id === task.id && !cleanText(noNextReason)) {
        throw badRequest('This was the deal\'s next action: book the next follow-up, or say why there is none');
      }
    }
    const { rows: done } = await client.query(`SELECT id FROM workflow_statuses WHERE stage = 'done' AND is_active = TRUE ORDER BY position LIMIT 1`);
    const reached = !['NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'NOT_DONE'].includes(outcome);
    await client.query(
      `UPDATE tasks SET status_id = $2, completed_at = now(), followup_outcome = $3, completion_note = $4, progress = 100,
              outcome_status = $5, updated_at = now()
        WHERE id = $1`,
      [taskId, done[0].id, outcome, cleanText(notes, 5000), reached ? 'ACHIEVED' : 'NOT_ACHIEVED'],
    );
    await logTaskActivity(client, { taskId, actorId: actor.id, action: 'completed', meta: { outcome } });
    const actType = KIND_ACTIVITY[task.followup_kind] || 'NOTE';
    const outcomeWord = reached ? 'COMPLETED' : 'ATTEMPTED';
    if (task.crm_lead_id) {
      await logLeadActivity(client, task.crm_lead_id, {
        type: actType, direction: 'OUTBOUND', outcome: outcomeWord, subject: `${task.title}: ${outcome.toLowerCase().replace('_', ' ')}`,
        body: cleanText(notes, 5000), actorId: actor.id, taskId,
      });
    }
    if (task.account_id) {
      await logAccountActivity(client, {
        accountId: task.account_id, opportunityId: task.opportunity_id, type: actType, leadId: task.crm_lead_id,
        actorId: actor.id, subject: `${task.title}: ${outcome.toLowerCase().replace('_', ' ')}`, body: cleanText(notes, 5000),
        outcome: outcomeWord, direction: 'OUTBOUND', source: 'TASK',
      });
    }
    let nextTask = null;
    if (next?.due_at) {
      nextTask = await createFollowUp(client, {
        leadId: task.crm_lead_id, accountId: task.account_id, opportunityId: task.opportunity_id, kind: next.kind || task.followup_kind,
        title: next.title, dueAt: next.due_at, assigneeId: next.assignee_id || task.assignee_id, priority: next.priority || 'MEDIUM',
        notes: next.notes, actor,
      });
      if (task.opportunity_id) {
        await client.query(
          `UPDATE opportunities SET next_step = $2, next_step_due = $3::date, next_step_owner_id = $4, next_step_task_id = $5,
                  next_step_set_at = now(), next_step_set_by = $6, next_action_absent_reason = NULL, updated_at = now()
            WHERE id = $1 AND status = 'ACTIVE'`,
          [task.opportunity_id, nextTask.title, new Date(next.due_at).toISOString().slice(0, 10), nextTask.assignee_id, nextTask.id, actor.id],
        );
      }
    } else if (task.opportunity_id && cleanText(noNextReason)) {
      await client.query('UPDATE opportunities SET next_action_absent_reason = $2 WHERE id = $1', [task.opportunity_id, cleanText(noNextReason, 500)]);
    }
    if (task.crm_lead_id) await refreshLeadNextFollowUp(client, task.crm_lead_id);
    await emitEvent(client, { type: 'followup.completed', entityType: 'TASK', entityId: taskId, actorId: actor.id, payload: { lead_id: task.crm_lead_id, account_id: task.account_id, outcome } });
    return { task: (await client.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0], next: nextTask };
  });
}

/** Moves a follow-up to a new time; the change is counted and its reason kept. */
export async function rescheduleFollowUp(taskId, { dueAt, reason = null }, actor) {
  return withTransaction(async (client) => {
    const task = await loadFollowUp(client, taskId, actor);
    if (task.completed_at || task.crm_cancel_reason) throw badRequest('Only an open follow-up can be rescheduled');
    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime()) || due.getTime() < Date.now() - 60_000) throw badRequest('Choose a time from now on');
    await client.query(
      `UPDATE tasks SET due_date = $2, due_date_changes = due_date_changes + 1, reminder_at = $2::timestamptz - interval '15 minutes',
              reminder_sent_at = NULL, escalated_at = NULL, snoozed_until = NULL, breach_evaluated_at = NULL, updated_at = now()
        WHERE id = $1`,
      [taskId, due],
    );
    await logTaskActivity(client, { taskId, actorId: actor.id, action: 'rescheduled', field: 'due_date', from: task.due_date?.toISOString?.() ?? null, to: due.toISOString(), meta: { reason } });
    if (task.crm_lead_id) {
      await refreshLeadNextFollowUp(client, task.crm_lead_id);
      await logLeadActivity(client, task.crm_lead_id, { type: 'FOLLOWUP', subject: `Rescheduled: ${task.title}`, body: reason, actorId: actor.id, taskId });
    }
    return (await client.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
  });
}

/** Hides a follow-up from My Day until a time, without changing when it is due. */
export async function snoozeFollowUp(taskId, { until }, actor) {
  return withTransaction(async (client) => {
    const task = await loadFollowUp(client, taskId, actor);
    const when = new Date(until);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) throw badRequest('Snooze until a time from now on');
    await client.query('UPDATE tasks SET snoozed_until = $2, updated_at = now() WHERE id = $1', [taskId, when]);
    await logTaskActivity(client, { taskId, actorId: actor.id, action: 'snoozed', to: when.toISOString() });
    return { ...task, snoozed_until: when };
  });
}

/** Gives a follow-up to someone else, with a reason. */
export async function handOffFollowUp(taskId, { toUserId, reason = null }, actor) {
  return withTransaction(async (client) => {
    const task = await loadFollowUp(client, taskId, actor);
    const { rows } = await client.query('SELECT id, full_name, is_active FROM users WHERE id = $1', [toUserId]);
    if (!rows[0]?.is_active) throw badRequest('Choose an active person');
    await client.query('UPDATE tasks SET assignee_id = $2, updated_at = now(), escalated_at = NULL WHERE id = $1', [taskId, toUserId]);
    await logTaskActivity(client, { taskId, actorId: actor.id, action: 'assigned', field: 'assignee_id', from: task.assignee_id, to: toUserId, meta: { reason } });
    await notify(client, { userId: toUserId, type: 'crm_followup', title: `Follow-up handed to you: ${task.title}`, body: reason, taskId, leadId: task.crm_lead_id, accountId: task.account_id });
    if (task.crm_lead_id) await logLeadActivity(client, task.crm_lead_id, { type: 'FOLLOWUP', subject: `Handed to ${rows[0].full_name}: ${task.title}`, body: reason, actorId: actor.id, taskId });
    return { ...task, assignee_id: toUserId };
  });
}

/**
 * The day's work for one person (or, for a manager, their team): overdue,
 * today, upcoming, done today, and the leads waiting for a first response.
 */
export async function myDay(user, { userId = null, scope = null, teamUserIds = null } = {}) {
  const cal = await workCalendar();
  const tz = cal.timeZone;
  const people = teamUserIds?.length ? teamUserIds : [userId || user.id];
  const settings = await salesSettings();
  const { rows } = await query(
    `${FOLLOWUP_SELECT}
      WHERE t.followup_kind IS NOT NULL AND t.assignee_id = ANY($1::int[]) AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL
        AND (t.completed_at IS NULL OR t.completed_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)
        AND (t.completed_at IS NOT NULL OR t.due_date < (date_trunc('day', now() AT TIME ZONE $2) + interval '8 days') AT TIME ZONE $2)
      ORDER BY t.due_date ASC NULLS LAST`,
    [people, tz],
  );
  const now = Date.now();
  const startOfTomorrow = new Date(new Date(new Date().toLocaleString('en-US', { timeZone: tz })).setHours(24, 0, 0, 0));
  const offset = new Date().getTime() - new Date(new Date().toLocaleString('en-US', { timeZone: tz })).getTime();
  const tomorrow = startOfTomorrow.getTime() + offset;
  const escalateMs = (Number(settings.followUps?.overdueEscalateHours) || 24) * 3600 * 1000;
  const buckets = { overdue: [], missed: [], today: [], upcoming: [], done_today: [], snoozed: [] };
  for (const t of rows) {
    const due = t.due_date ? new Date(t.due_date).getTime() : null;
    if (t.completed_at) buckets.done_today.push(t);
    else if (t.snoozed_until && new Date(t.snoozed_until).getTime() > now) buckets.snoozed.push(t);
    else if (due !== null && due < now - escalateMs) buckets.missed.push(t);
    else if (due !== null && due < now) buckets.overdue.push(t);
    else if (due !== null && due < tomorrow) buckets.today.push(t);
    else buckets.upcoming.push(t);
  }
  const params = [people];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const firstResponse = await query(
    `SELECT l.id, l.ref, COALESCE(l.organization_name, l.contact_name) AS name, l.phone, l.email, l.captured_at, l.assigned_at,
            l.owner_user_id, l.category, l.priority
       FROM crm_leads l
      WHERE l.owner_user_id = ANY($1::int[]) AND l.status = 'NEW' AND l.last_contacted_at IS NULL AND l.first_response_at IS NULL
        AND l.is_archived = FALSE AND l.destination = 'TASKFLOW' ${scope ? `AND ${scopeCondition(scope, 'lead', 'l', push)}` : ''}
      ORDER BY l.captured_at ASC LIMIT 50`,
    params,
  );
  const meetings = await query(
    `SELECT m.id, m.title, m.kind, m.scheduled_at, m.status, m.account_id, a.name AS account_name
       FROM crm_meetings m JOIN accounts a ON a.id = m.account_id
      WHERE m.owner_user_id = ANY($1::int[]) AND m.status = 'SCHEDULED'
        AND m.scheduled_at < (date_trunc('day', now() AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2
        AND m.scheduled_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
      ORDER BY m.scheduled_at`,
    [people, tz],
  );
  return { ...buckets, awaiting_first_response: firstResponse.rows, meetings_today: meetings.rows, timezone: tz };
}
