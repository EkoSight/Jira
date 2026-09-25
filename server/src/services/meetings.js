/**
 * Meetings and demos, as workflows rather than diary entries.
 *
 * The distinction the whole thing hangs on: a SCHEDULED demo is not a COMPLETED
 * demo. One is an intention, the other is evidence, and a pipeline that counts
 * them together reports meetings that never happened.
 *
 * Preparation and follow-up work goes through the ordinary task engine — there
 * is one task record, and it appears in the assignee's My Tasks like any other.
 * Creating it is idempotent: a repeated save, a retry, or a reschedule can never
 * mint a second set of cards.
 *
 * Nothing here sends anything. An internal meeting record is not a calendar
 * invitation, and this never claims one was issued.
 */

import { query } from '../db/pool.js';
import { hasPermission } from '../lib/permissions.js';
import { nextTaskRef } from '../lib/taskRef.js';
import { notify } from './activity.js';
import { logActivity } from './crm.js';

export const MEETING_KINDS = ['MEETING', 'DEMO', 'SITE_VISIT', 'WORKSHOP', 'REVIEW'];
export const MEETING_MODES = ['VIRTUAL', 'IN_PERSON'];
export const MEETING_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'];

/** The statuses that mean it actually happened. */
const HAPPENED = new Set(['COMPLETED']);

export const MEETING_SELECT = `
  SELECT m.*,
         a.name AS account_name,
         o.name AS opportunity_name,
         u.full_name AS owner_name, u.avatar_color AS owner_color,
         c.full_name AS created_by_name,
         (SELECT COUNT(*)::int FROM tasks t
           WHERE t.meeting_id = m.id AND t.meeting_role = 'PREP' AND t.is_archived = FALSE) AS prep_total,
         (SELECT COUNT(*)::int FROM tasks t
            JOIN workflow_statuses ws ON ws.id = t.status_id
           WHERE t.meeting_id = m.id AND t.meeting_role = 'PREP'
             AND t.is_archived = FALSE AND ws.stage = 'done') AS prep_done,
         (SELECT COUNT(*)::int FROM tasks t
           WHERE t.meeting_id = m.id AND t.meeting_role = 'FOLLOW_UP' AND t.is_archived = FALSE) AS followup_total,
         COALESCE((
           SELECT json_agg(json_build_object(
             'user_id', p.user_id, 'contact_id', p.contact_id, 'attended', p.attended,
             'name', COALESCE(pu.full_name, pc.full_name),
             'color', pu.avatar_color,
             'designation', pc.designation,
             'external', (p.contact_id IS NOT NULL)))
             FROM crm_meeting_participants p
             LEFT JOIN users pu ON pu.id = p.user_id
             LEFT JOIN account_contacts pc ON pc.id = p.contact_id
            WHERE p.meeting_id = m.id), '[]'::json) AS participants
    FROM crm_meetings m
    JOIN accounts a ON a.id = m.account_id
    LEFT JOIN opportunities o ON o.id = m.opportunity_id
    LEFT JOIN users u ON u.id = m.owner_user_id
    LEFT JOIN users c ON c.id = m.created_by
`;

/** Adds what can be worked out but should never be stored. */
export function decorateMeeting(row, now = Date.now()) {
  const when = new Date(row.scheduled_at).getTime();
  return {
    ...row,
    happened: HAPPENED.has(row.status),
    is_upcoming: row.status === 'SCHEDULED' && when >= now,
    // scheduled, in the past, and nobody has said what came of it
    awaiting_outcome: row.status === 'SCHEDULED' && when < now,
    was_rescheduled: row.reschedule_count > 0,
  };
}

export const canEditMeeting = (user, row) =>
  hasPermission(user, 'crm.manage.any')
  || row.owner_user_id === user.id
  || row.created_by === user.id
  || row.relationship_owner_id === user.id;

export async function listMeetings(filters = {}) {
  const params = [];
  const where = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.accountId) where.push(`m.account_id = ${push(Number(filters.accountId))}`);
  if (filters.opportunityId) where.push(`m.opportunity_id = ${push(Number(filters.opportunityId))}`);
  if (filters.ownerId) where.push(`m.owner_user_id = ${push(Number(filters.ownerId))}`);
  if (filters.status) where.push(`m.status = ${push(filters.status)}`);
  if (filters.kind) where.push(`m.kind = ${push(filters.kind)}`);
  if (filters.from) where.push(`m.scheduled_at >= ${push(filters.from)}`);
  if (filters.to) where.push(`m.scheduled_at < ${push(filters.to)}`);
  // scheduled, in the past, still no outcome — the list a manager actually wants
  if (filters.awaitingOutcome) where.push(`m.status = 'SCHEDULED' AND m.scheduled_at < now()`);

  const { rows } = await query(
    `${MEETING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.scheduled_at DESC LIMIT ${Math.min(Number(filters.limit) || 200, 500)}`,
    params,
  );
  return rows.map((row) => decorateMeeting(row));
}

export async function getMeeting(id) {
  const { rows } = await query(`${MEETING_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? decorateMeeting(rows[0]) : null;
}

/** The raw row plus what the permission check needs. */
export async function loadMeeting(id) {
  const { rows } = await query(
    `SELECT m.*, a.owner_user_id AS relationship_owner_id, a.department_id, a.name AS account_name
       FROM crm_meetings m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/** Replaces the participant list wholesale — it is a set, not a log. */
export async function setParticipants(client, meetingId, { userIds = [], contactIds = [] }) {
  await client.query('DELETE FROM crm_meeting_participants WHERE meeting_id = $1', [meetingId]);
  for (const userId of userIds) {
    await client.query(
      `INSERT INTO crm_meeting_participants (meeting_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [meetingId, userId],
    );
  }
  for (const contactId of contactIds) {
    await client.query(
      `INSERT INTO crm_meeting_participants (meeting_id, contact_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [meetingId, contactId],
    );
  }
}

/** The steps a demo needs before it can happen, by the kind of meeting it is. */
const PREP_TEMPLATES = {
  DEMO: [
    'Confirm the demo environment and sample data',
    'Check the hardware and connectivity',
    'Send the agenda and joining details',
  ],
  MEETING: ['Send the agenda and joining details', 'Prepare the discussion notes'],
  SITE_VISIT: ['Confirm the site, route and timing', 'Pack the demonstration kit'],
  WORKSHOP: ['Send the agenda and pre-reading', 'Prepare the materials'],
  REVIEW: ['Pull the numbers for the review', 'Send the agenda'],
};

/**
 * Creates the preparation work, once.
 *
 * Guarded by a flag on the meeting rather than by looking for tasks with
 * matching titles: somebody renaming a prep task should not cause a second set
 * to appear on the next save.
 */
export async function createPrepTasks(client, meeting, actor) {
  if (meeting.prep_tasks_created) return [];

  const titles = PREP_TEMPLATES[meeting.kind] || PREP_TEMPLATES.MEETING;
  const { rows: statusRows } = await client.query(
    `SELECT id FROM workflow_statuses WHERE is_active = TRUE
      ORDER BY is_default DESC, position ASC LIMIT 1`,
  );
  if (!statusRows[0]) return [];

  const { rows: accountRows } = await client.query(
    'SELECT department_id, name FROM accounts WHERE id = $1', [meeting.account_id],
  );
  const departmentId = accountRows[0]?.department_id ?? actor.department_id;
  if (!departmentId) return [];

  // prep is due the day before, and never in the past
  const due = new Date(new Date(meeting.scheduled_at).getTime() - 86_400_000);
  const dueDate = due.getTime() > Date.now() ? due : new Date(Date.now() + 3_600_000);

  const created = [];
  for (const title of titles) {
    const ref = await nextTaskRef(client, departmentId);
    const { rows } = await client.query(
      `INSERT INTO tasks
         (ref, title, department_id, status_id, priority, assignee_id, reporter_id, created_by,
          due_date, original_due_date, account_id, opportunity_id, meeting_id, meeting_role, position)
       VALUES ($1,$2,$3,$4,'medium',$5,$6,$6,$7,$7,$8,$9,$10,'PREP',
               (SELECT COALESCE(MAX(position),0)+100 FROM tasks WHERE status_id = $4))
       RETURNING *`,
      [
        ref, `${title} — ${meeting.title}`, departmentId, statusRows[0].id,
        meeting.owner_user_id ?? actor.id, actor.id, dueDate,
        meeting.account_id, meeting.opportunity_id ?? null, meeting.id,
      ],
    );
    created.push(rows[0]);
  }

  await client.query('UPDATE crm_meetings SET prep_tasks_created = TRUE WHERE id = $1', [meeting.id]);
  return created;
}

/**
 * Moves the meeting's own tasks when the meeting moves.
 *
 * Rescheduling updates the existing event and the work hanging off it — it does
 * not produce a second meeting and a second set of prep cards, which is what
 * "rescheduling must not duplicate it" means in practice.
 */
export async function shiftPrepTasks(client, meetingId, scheduledAt) {
  const due = new Date(new Date(scheduledAt).getTime() - 86_400_000);
  const dueDate = due.getTime() > Date.now() ? due : new Date(Date.now() + 3_600_000);
  await client.query(
    `UPDATE tasks SET due_date = $1, updated_at = now()
      WHERE meeting_id = $2 AND meeting_role = 'PREP' AND is_archived = FALSE
        AND status_id IN (SELECT id FROM workflow_statuses WHERE stage NOT IN ('done','cancelled'))`,
    [dueDate, meetingId],
  );
}

/**
 * The work that comes out of a meeting, created once when the outcome is recorded.
 * An ordinary task, so it lands in My Tasks like everything else.
 */
export async function createFollowUpTask(client, meeting, { title, assigneeId, dueDate }, actor) {
  const { rows: statusRows } = await client.query(
    `SELECT id FROM workflow_statuses WHERE is_active = TRUE
      ORDER BY is_default DESC, position ASC LIMIT 1`,
  );
  const { rows: accountRows } = await client.query(
    'SELECT department_id FROM accounts WHERE id = $1', [meeting.account_id],
  );
  const departmentId = accountRows[0]?.department_id ?? actor.department_id;
  if (!statusRows[0] || !departmentId) return null;

  const ref = await nextTaskRef(client, departmentId);
  const { rows } = await client.query(
    `INSERT INTO tasks
       (ref, title, department_id, status_id, priority, assignee_id, reporter_id, created_by,
        due_date, original_due_date, account_id, opportunity_id, meeting_id, meeting_role, position)
     VALUES ($1,$2,$3,$4,'medium',$5,$6,$6,$7,$7,$8,$9,$10,'FOLLOW_UP',
             (SELECT COALESCE(MAX(position),0)+100 FROM tasks WHERE status_id = $4))
     RETURNING *`,
    [
      ref, title, departmentId, statusRows[0].id,
      assigneeId ?? meeting.owner_user_id ?? actor.id, actor.id,
      dueDate ?? new Date(Date.now() + 3 * 86_400_000),
      meeting.account_id, meeting.opportunity_id ?? null, meeting.id,
    ],
  );
  return rows[0];
}

/**
 * Writes the meeting into the relationship's history.
 *
 * The outcome decides whether it counts as engagement: a completed demo does, a
 * cancellation or a no-show does not, and a meeting merely booked certainly does
 * not. That is what keeps the follow-up clock honest.
 */
export async function logMeetingActivity(client, meeting, { actorId, subject, body, outcome }) {
  return logActivity(client, {
    accountId: meeting.account_id,
    opportunityId: meeting.opportunity_id ?? null,
    meetingId: meeting.id,
    type: meeting.kind === 'DEMO' ? 'DEMO' : meeting.mode === 'IN_PERSON' ? 'IN_PERSON' : 'MEETING',
    actorId,
    subject,
    body: body ?? null,
    outcome,
    channel: meeting.mode,
    isExternal: true,
  });
}

/** Tells the people on our side. External contacts are never messaged from here. */
export async function notifyInternal(client, meeting, { actorId, title, body }) {
  const { rows } = await query(
    'SELECT user_id FROM crm_meeting_participants WHERE meeting_id = $1 AND user_id IS NOT NULL',
    [meeting.id],
  );
  const recipients = new Set(rows.map((r) => r.user_id));
  if (meeting.owner_user_id) recipients.add(meeting.owner_user_id);
  recipients.delete(actorId);

  for (const userId of recipients) {
    await notify(client, {
      userId,
      type: 'crm_activity',
      title,
      body: body ?? null,
      accountId: meeting.account_id,
    });
  }
}
