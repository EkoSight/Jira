/**
 * Field days and leave protect that day's deadlines.
 *
 * Someone working in the field, or away on leave, cannot meet a deadline at
 * their desk. Their open tasks due on those days are MOVED to the first day
 * they are back — never marked done. A task marked done that was not done
 * would disappear from everyone's boards, inflate completion figures, and
 * earn a "reopened" black mark the moment someone noticed.
 *
 * A move made this way:
 *   - is recorded in task_deadline_moves (who, why, from, to), and in the
 *     task's own history;
 *   - is not counted as the person pushing a deadline;
 *   - is told to whoever handed the work over, so nothing is missed;
 *   - happens once per deadline, however often it is triggered.
 *
 * Black marks already recorded for a moved deadline are waived only by a
 * reviewer's decision (approving the leave, or a field-duty correction) and
 * only if that reviewer holds the right to waive black marks. Nothing here
 * waives a person's own marks for them.
 */

import { query, withTransaction } from '../db/pool.js';
import { conflict } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { logActivity, notify } from './activity.js';
import { currentPolicy, policyOn, policyTimeline } from './attendancePolicy.js';
import {
  addDays, audit, dateIn, getProfile, holidaysBetween, instantAt, scheduleOn, secondsInto, sessionOn,
} from './attendance.js';

const MAX_LOOKAHEAD_DAYS = 60;

const dayWords = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
  .format(new Date(`${date}T00:00:00Z`));

/**
 * The first day after `after` that this person is scheduled to work and is
 * not on approved full-day leave. Weekly offs and holidays are skipped.
 */
export async function nextWorkingDay(userId, departmentId, after) {
  const timeline = await policyTimeline();
  const profile = await getProfile(userId);
  const horizon = addDays(after, MAX_LOOKAHEAD_DAYS);
  const holidays = await holidaysBetween(addDays(after, 1), horizon);
  const { rows: leave } = await query(
    `SELECT start_date::text AS start_date, end_date::text AS end_date FROM leave_requests
      WHERE user_id = $1 AND status IN ('APPROVED_PAID', 'APPROVED_UNPAID') AND day_part = 'FULL'
        AND end_date > $2 AND start_date <= $3`,
    [userId, after, horizon],
  );
  for (let d = addDays(after, 1); d <= horizon; d = addDays(d, 1)) {
    const { config } = policyOn(timeline, d);
    const schedule = scheduleOn(d, { config, profile, holidays, departmentId, ignoreStart: true, ignoreEmployment: true });
    if (schedule.state !== 'WORKDAY') continue;
    if (leave.some((l) => l.start_date <= d && l.end_date >= d)) continue;
    return d;
  }
  return addDays(after, 1);
}

/** Open tasks of this person due on these calendar days (in the organisation's timezone). */
export async function tasksDueBetween(userId, from, to, { now = new Date(), client = null } = {}) {
  const { config } = await currentPolicy(now);
  const runner = client || { query };
  const { rows } = await runner.query(
    `SELECT t.id, t.ref, t.title, t.due_date, t.priority, t.reporter_id, t.created_by
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.assignee_id = $1 AND t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled')
        AND t.due_date IS NOT NULL AND (t.due_date AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY t.due_date`,
    [userId, from, to, config.timezone],
  );
  return rows;
}

/**
 * Moves this person's open deadlines on [from, to] to the first working day
 * after `to` (and never into the past), keeping each one's time of day.
 * Runs inside the caller's transaction. Returns what moved, and where to.
 */
export async function moveDeadlines(client, {
  user, from, to, reason, sessionId = null, leaveRequestId = null, actorId, now = new Date(), why,
}) {
  const { config } = await currentPolicy(now);
  const tz = config.timezone;
  const today = dateIn(tz, now);
  const { rows: tasks } = await client.query(
    `SELECT t.id, t.ref, t.title, t.due_date, t.reporter_id, t.created_by
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.assignee_id = $1 AND t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled')
        AND t.due_date IS NOT NULL AND (t.due_date AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY t.due_date
      FOR UPDATE OF t`,
    [user.id, from, to, tz],
  );
  if (!tasks.length) return { moved: [], target: null };

  // the day they are back — for leave already over, the next working day from now
  const target = await nextWorkingDay(user.id, user.department_id, to >= today ? to : addDays(today, -1));
  const moved = [];
  for (const task of tasks) {
    const day = dateIn(tz, new Date(task.due_date));
    const seconds = secondsInto(day, task.due_date, tz);
    let date = target;
    let due = instantAt(date, seconds, tz);
    // a time already gone today is no deadline at all: the next working day, then
    for (let i = 0; due <= now && i < 5; i += 1) {
      date = await nextWorkingDay(user.id, user.department_id, date);
      due = instantAt(date, seconds, tz);
    }
    const { rows: recorded } = await client.query(
      `INSERT INTO task_deadline_moves (task_id, user_id, reason, work_date, session_id, leave_request_id, from_due, to_due, moved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (task_id, from_due) DO NOTHING
       RETURNING id`,
      [task.id, user.id, reason, day, sessionId, leaveRequestId, task.due_date, due, actorId],
    );
    if (!recorded[0]) continue; // already moved for this deadline
    // not counted in due_date_changes: this is not the person pushing a deadline
    await client.query(
      `UPDATE tasks
          SET due_date = $2,
              original_due_date = COALESCE(original_due_date, $3),
              reminder_at = CASE WHEN reminder_at IS NULL THEN NULL ELSE reminder_at + ($2::timestamptz - $3::timestamptz) END,
              updated_at = now()
        WHERE id = $1`,
      [task.id, due, task.due_date],
    );
    await logActivity(client, {
      taskId: task.id, actorId, action: 'updated', field: 'due_date',
      from: new Date(task.due_date).toISOString(), to: due.toISOString(),
      meta: { reason, protected_date: day, leave_request_id: leaveRequestId, session_id: sessionId, counted_as_push: false },
    });
    moved.push({ task_id: task.id, ref: task.ref, title: task.title, from: new Date(task.due_date).toISOString(), to: due.toISOString(), reporter_id: task.reporter_id || task.created_by });
  }

  // whoever handed the work over hears once, with the list
  const byReporter = new Map();
  for (const m of moved) {
    if (!m.reporter_id || m.reporter_id === user.id) continue;
    byReporter.set(m.reporter_id, [...(byReporter.get(m.reporter_id) || []), m]);
  }
  for (const [reporterId, list] of byReporter) {
    await notify(client, {
      userId: reporterId,
      type: 'deadline_moved',
      title: `${user.full_name} ${why} — ${list.length === 1 ? `${list[0].ref} moved` : `${list.length} tasks you assigned moved`} to ${dayWords(target)}`,
      body: list.map((m) => `${m.ref} ${m.title}`).join(' · ').slice(0, 200),
      taskId: list.length === 1 ? list[0].task_id : null,
    });
  }
  // recorded on someone's behalf: they hear too
  if (moved.length && actorId !== user.id) {
    await notify(client, {
      userId: user.id,
      type: 'deadline_moved',
      title: `${moved.length === 1 ? `${moved[0].ref} moved` : `${moved.length} of your deadlines moved`} to ${dayWords(target)} while you are away`,
      body: moved.map((m) => `${m.ref} ${m.title}`).join(' · ').slice(0, 200),
      taskId: moved.length === 1 ? moved[0].task_id : null,
    });
  }
  return { moved, target: moved.length ? target : null };
}

/**
 * Black marks recorded for deadlines that were later moved because of a
 * protected day. Waived only when `reviewer` may waive black marks; otherwise
 * they are counted and left for someone who can.
 */
export async function waiveMarksForMoves(client, { reviewer, leaveRequestId = null, taskIds = null, reason }) {
  const { rows } = await client.query(
    `SELECT DISTINCT bm.id FROM black_marks bm
       JOIN blackmark_rules r ON r.id = bm.rule_id
       JOIN task_deadline_moves m ON m.task_id = bm.task_id
      WHERE bm.status = 'active' AND r.trigger_type IN ('deadline_missed', 'overdue_escalation')
        AND bm.occurred_at >= m.from_due
        AND ($1::int IS NULL OR m.leave_request_id = $1)
        AND ($2::int[] IS NULL OR m.task_id = ANY($2::int[]))`,
    [leaveRequestId, taskIds],
  );
  if (!rows.length) return { waived: 0, waiting: 0 };
  if (!hasPermission(reviewer, 'blackmark.waive')) return { waived: 0, waiting: rows.length };
  const { rowCount } = await client.query(
    `UPDATE black_marks SET status = 'waived', waived_by = $2, waived_reason = $3, waived_at = now()
      WHERE id = ANY($1::int[]) AND status = 'active'`,
    [rows.map((r) => r.id), reviewer.id, reason],
  );
  return { waived: rowCount, waiting: 0 };
}

/**
 * "I am working in the field today." Marks today's attendance as a field day
 * and, unless asked not to, moves today's open deadlines to the next working
 * day. Today only: a day already gone is a correction for a reviewer.
 */
export async function declareFieldDay(user, { note = null, moveTasks = true } = {}, now = new Date()) {
  const { config } = await currentPolicy(now);
  const today = dateIn(config.timezone, now);
  const session = await sessionOn(user.id, today);
  if (!session) {
    throw conflict('Check in first — a field day is marked on the day you are working. For a day already gone, ask for a field-duty correction.', { code: 'NOT_CHECKED_IN' });
  }
  const cleanNote = String(note || '').trim().slice(0, 300) || null;
  return withTransaction(async (client) => {
    const { rows: before } = await client.query('SELECT field_day FROM attendance_sessions WHERE id = $1 FOR UPDATE', [session.id]);
    await client.query(
      `UPDATE attendance_sessions
          SET field_day = TRUE, field_note = COALESCE($2, field_note), field_declared_at = COALESCE(field_declared_at, $3), updated_at = now()
        WHERE id = $1`,
      [session.id, cleanNote, now],
    );
    if (!before[0].field_day) {
      await audit(client, {
        entityType: 'ATTENDANCE_SESSION', entityId: session.id, subjectUserId: user.id, actorId: user.id,
        action: 'FIELD_DAY', after: { field_day: true, note: cleanNote },
      });
    }
    const { moved, target } = moveTasks
      ? await moveDeadlines(client, {
        user, from: today, to: today, reason: 'FIELD_DAY', sessionId: session.id, actorId: user.id, now,
        why: 'is working in the field today',
      })
      : { moved: [], target: null };
    return { session_id: session.id, field_day: true, work_date: today, moved, moved_to: target };
  });
}
