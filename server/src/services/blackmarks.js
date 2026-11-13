import { query } from '../db/pool.js';
import { clock } from '../lib/attendanceCalc.js';
import { getSettings } from './settings.js';
import { notify } from './activity.js';
import { policyAt, policyOn, policyTimeline } from './attendancePolicy.js';
import {
  addDays, dateIn, holidaysBetween, instantAt, localMidnight, profilesFor, scheduleOn, secondsInto,
} from './attendance.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// the furthest a deadline is carried past days off, and the longest overdue
// stretch counted day by day
const MAX_SHIFT_DAYS = 90;
const MAX_COUNT_DAYS = 730;

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** The calendar month an instant falls in, in the organisation's timezone. */
export const periodMonth = (date, timezone = DEFAULT_TIMEZONE) => `${dateIn(timezone, date).slice(0, 7)}-01`;

const ruleMatches = (rule, task) => {
  if (rule.priorities?.length && !rule.priorities.includes(task.priority)) return false;
  if (rule.department_ids?.length && !rule.department_ids.includes(task.department_id)) return false;
  return true;
};

/** How specific a rule is: a priority or department filter beats none; both beat one. */
export const ruleSpecificity = (rule) => (rule.priorities?.length ? 1 : 0) + (rule.department_ids?.length ? 1 : 0);

/**
 * D2: of the active rules of one kind that match a task, the one that applies:
 * the most specific; between equally specific rules the narrower list, then
 * the oldest. Points are never added up across overlapping rules.
 */
export function pickRule(rules, task, trigger = 'deadline_missed') {
  const matching = rules.filter((r) => r.trigger_type === trigger && ruleMatches(r, task));
  const width = (r) => (r.priorities?.length || 99) + (r.department_ids?.length || 99);
  matching.sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a) || width(a) - width(b) || a.id - b.id);
  return matching[0] || null;
}

const ruleSnapshot = (rule) => ({
  id: rule.id, name: rule.name, trigger_type: rule.trigger_type, points: Number(rule.points),
  grace_hours: rule.grace_hours ?? 0, repeat_every_days: rule.repeat_every_days ?? null,
  max_points_per_task: rule.max_points_per_task === null || rule.max_points_per_task === undefined ? null : Number(rule.max_points_per_task),
  updated_at: rule.updated_at ?? null,
});

/**
 * Inserts a black mark unless one with the same occurrence key already exists.
 * The unique index on occurrence_key makes repeated scans idempotent.
 */
export async function recordBlackMark({
  userId,
  taskId = null,
  ruleId = null,
  points,
  reason,
  source = 'auto',
  occurredAt = new Date(),
  occurrenceKey,
  createdBy = null,
  evidence = null,
  timezone = null,
  client = null,
}) {
  const runner = client || { query };
  const tz = timezone || policyAt(await policyTimeline(), occurredAt)?.config?.timezone || DEFAULT_TIMEZONE;
  const { rows } = await runner.query(
    `INSERT INTO black_marks
       (user_id, task_id, rule_id, points, reason, source, occurred_at, period_month, occurrence_key, created_by, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (occurrence_key) DO NOTHING
     RETURNING *`,
    [
      userId, taskId, ruleId, points, reason, source, occurredAt, periodMonth(occurredAt, tz), occurrenceKey, createdBy,
      evidence ? JSON.stringify(evidence) : null,
    ],
  );
  return rows[0] || null;
}

async function pointsAlreadyOnTask(taskId, ruleId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(points), 0) AS total FROM black_marks
     WHERE task_id = $1 AND rule_id = $2 AND status = 'active'`,
    [taskId, ruleId],
  );
  return Number(rows[0].total);
}

// ---------------------------------------------------------------- whose day off

/**
 * Holidays cancelled after their day had begun. Deadlines on them were set and
 * worked around while the day was a holiday, so the automatic scan does not
 * turn them into marks afterwards: any mark for them comes through a reviewed
 * correction on the cancellation.
 */
async function lateCancelledHolidays(from, to, timezone) {
  const { rows } = await query(
    `SELECT h.* FROM work_holidays h
      WHERE h.status = 'CANCELLED' AND h.holiday_date BETWEEN $1 AND $2 AND h.cancelled_at IS NOT NULL`,
    [from, to],
  );
  return rows
    .filter((h) => new Date(h.cancelled_at).getTime() >= localMidnight(h.holiday_date, timezone))
    .map((h) => ({ ...h, status: 'APPROVED', protected: true, name: `${h.name} (cancelled after the day)` }));
}

/**
 * The calendar black marks are judged against, for a set of people: their own
 * weekly days, the holidays that cover them (company, department, personal;
 * full or half day) and their approved leave. Built once per scan.
 *
 *   holidays    override the holiday list (an impact preview passes the
 *               calendar as it would be)
 *   protect     include holidays cancelled after their day (the scan does;
 *               a preview of "what the plain calendar says" does not)
 */
export async function markCalendar(userIds, { from, to, now = new Date(), holidays = null, protect = true } = {}) {
  const timeline = await policyTimeline();
  const timezone = policyAt(timeline, now)?.config?.timezone || DEFAULT_TIMEZONE;
  const ids = [...new Set(userIds.map(Number))];
  const [users, profiles, leave] = await Promise.all([
    ids.length ? query('SELECT id, department_id FROM users WHERE id = ANY($1::int[])', [ids]) : { rows: [] },
    ids.length ? profilesFor(ids) : new Map(),
    ids.length ? query(
      `SELECT id, user_id, start_date::text AS start_date, end_date::text AS end_date, day_part, status FROM leave_requests
        WHERE user_id = ANY($1::int[]) AND status IN ('APPROVED_PAID', 'APPROVED_UNPAID') AND end_date >= $2 AND start_date <= $3`,
      [ids, from, to],
    ) : { rows: [] },
  ]);
  let list = holidays ?? await holidaysBetween(from, to);
  if (protect) list = [...list, ...await lateCancelledHolidays(from, to, timezone)];
  const userBy = new Map(users.rows.map((u) => [u.id, u]));
  const leaveBy = new Map();
  for (const l of leave.rows) leaveBy.set(l.user_id, [...(leaveBy.get(l.user_id) || []), l]);

  /** Why this person is not working at this time of this date, or null. */
  function offAt(userId, date, seconds) {
    const { config } = policyOn(timeline, date);
    const s = scheduleOn(date, {
      config, profile: profiles.get(userId) || null, holidays: list, departmentId: userBy.get(userId)?.department_id ?? null,
      userId, ignoreStart: true, ignoreEmployment: true,
    });
    if (s.state === 'WEEKLY_OFF') return { date, code: 'WEEKLY_OFF' };
    if (s.state === 'HOLIDAY') return { date, code: 'HOLIDAY', name: s.holiday, holiday_ids: s.holidayIds };
    const split = clock(config.halfDaySplit || '13:30');
    const inOffHalf = (half) => (half === 'FIRST_HALF' ? seconds < split : half === 'SECOND_HALF' ? seconds >= split : false);
    if (s.holidayHalf && inOffHalf(s.holidayHalf)) return { date, code: 'HOLIDAY_HALF', half: s.holidayHalf, name: s.holiday, holiday_ids: s.holidayIds };
    const l = (leaveBy.get(userId) || []).find((x) => x.start_date <= date && x.end_date >= date
      && (x.day_part === 'FULL' || inOffHalf(x.day_part)));
    if (l) return { date, code: l.day_part === 'FULL' ? 'LEAVE' : 'LEAVE_HALF', half: l.day_part === 'FULL' ? undefined : l.day_part, leave_request_id: l.id };
    return null;
  }

  /**
   * The deadline in force: a deadline that falls while the person is not
   * working (weekly off, holiday, approved leave — or the half of the day that
   * is off) moves to the same time on their next working day. The task's own
   * due date is never changed.
   */
  function effectiveDeadline(userId, due) {
    const at = new Date(due);
    let date = dateIn(timezone, at);
    const seconds = secondsInto(date, at, timezone);
    const shifted = [];
    for (let i = 0; i < MAX_SHIFT_DAYS; i += 1) {
      const off = offAt(userId, date, seconds);
      if (!off) break;
      shifted.push(off);
      date = addDays(date, 1);
    }
    return { at: shifted.length ? instantAt(date, seconds, timezone) : at, shifted };
  }

  /**
   * The instants of an escalation's cycles up to now: every `every` working
   * days of this person's after the deadline, at the deadline's time of day.
   */
  function cycleInstants(userId, deadline, every, until) {
    const start = dateIn(timezone, deadline);
    const seconds = secondsInto(start, deadline, timezone);
    const out = [];
    let working = 0;
    for (let i = 1; i <= MAX_COUNT_DAYS; i += 1) {
      const d = addDays(start, i);
      const at = instantAt(d, seconds, timezone);
      if (at > until) break;
      if (offAt(userId, d, seconds)) continue;
      working += 1;
      if (working % every === 0) out.push(at);
    }
    return out;
  }

  return { timezone, timeline, offAt, effectiveDeadline, cycleInstants, policyIdOn: (date) => policyOn(timeline, date)?.id ?? null };
}

/**
 * Every mark the rules call for on one task under a calendar, without writing
 * anything. Each carries its occurrence key, the person it belongs to and the
 * evidence it rests on.
 *
 * Fairness (no-missed-tasks brief, problems 14–17):
 *   - D2: of the matching rules of one kind, only the most specific applies;
 *     overlapping rules never add up. "Delivered late" applies only when no
 *     missed-deadline mark was recorded for the task.
 *   - The mark belongs to whoever owned the task at its effective deadline
 *     (ctx.ownerAt), not to whoever owns it when the scan runs. Escalation
 *     stops once the task changes hands (ctx.reassignedAfter).
 *   - No marks while a deferral is approved, while an accepted block covers
 *     the deadline (ctx.blocks), or for a deactivated owner (ctx.inactive).
 *   - A rule applies from its effective_from onwards; earlier work only
 *     through a previewed, approved backfill (ctx.backfill).
 * Without ctx it judges against the current owner, as before.
 */
export function evaluateTask(task, rules, cal, now, ctx = {}) {
  const out = [];
  if (task.stage === 'cancelled' || !task.due_date) return out;
  if (task.deferral_id) return out;
  const due = new Date(task.due_date);
  const ownerAt = ctx.ownerAt || (() => task.assignee_id);
  let owner = ownerAt(due);
  if (!owner) return out;
  let { at: effectiveDue, shifted } = cal.effectiveDeadline(owner, task.due_date);
  const atDeadline = ownerAt(effectiveDue);
  if (atDeadline && atDeadline !== owner) {
    owner = atDeadline;
    ({ at: effectiveDue, shifted } = cal.effectiveDeadline(owner, task.due_date));
  }
  if (!owner || ctx.inactive?.has(owner)) return out;
  const isDone = task.stage === 'done';
  const blocked = (instant) => (ctx.blocks || []).some((b) => new Date(b.recorded_at) <= instant
    && (!b.cleared_at || new Date(b.cleared_at) > effectiveDue));
  const applies = (rule, instant) => {
    if (ctx.backfill) return rule.effective_from && instant < new Date(rule.effective_from);
    return !rule.effective_from || instant >= new Date(rule.effective_from);
  };
  const evidenceBase = (rule, deadline) => ({
    basis: 'TASK_DEADLINE',
    task_id: task.id,
    task_ref: task.ref,
    due: due.toISOString(),
    effective_due: effectiveDue.toISOString(),
    deadline_with_grace: deadline.toISOString(),
    shifted_past: shifted,
    owner_at_deadline: owner,
    rule: ruleSnapshot(rule),
    precedence: { applied: rule.id, overlapping: rules.filter((r) => r.trigger_type === rule.trigger_type && r.id !== rule.id && ruleMatches(r, task)).map((r) => r.id) },
    attendance_policy_id: cal.policyIdOn(dateIn(cal.timezone, due)),
    calendar: 'weekly days, approved holidays and approved leave of the owner at the deadline',
  });

  // D2: one rule per kind, the most specific
  const missedRule = pickRule(rules, task, 'deadline_missed');
  const lateRule = pickRule(rules, task, 'completed_late');
  const escalationRule = pickRule(rules, task, 'overdue_escalation');
  let missedNow = false;

  if (missedRule) {
    const deadline = new Date(effectiveDue.getTime() + (missedRule.grace_hours || 0) * HOUR_MS);
    const passed = now.getTime() > deadline.getTime();
    if (!isDone && passed && !blocked(deadline) && applies(missedRule, deadline) && !ctx.missedRecorded) {
      missedNow = true;
      out.push({
        rule: missedRule, userId: owner, points: Number(missedRule.points), occurredAt: deadline,
        reason: `Missed deadline on ${task.ref} — ${task.title}`,
        occurrenceKey: `rule:${missedRule.id}:task:${task.id}:missed`,
        evidence: evidenceBase(missedRule, deadline),
      });
    }
  }

  if (lateRule && isDone && task.completed_at && !ctx.missedRecorded && !ctx.lateRecorded && !missedNow) {
    const deadline = new Date(effectiveDue.getTime() + (lateRule.grace_hours || 0) * HOUR_MS);
    const completedAt = new Date(task.completed_at);
    if (completedAt.getTime() > deadline.getTime() && !blocked(deadline) && applies(lateRule, completedAt)) {
      out.push({
        rule: lateRule, userId: owner, points: Number(lateRule.points), occurredAt: completedAt,
        reason: `Completed ${task.ref} after the deadline`,
        occurrenceKey: `rule:${lateRule.id}:task:${task.id}:late`,
        evidence: { ...evidenceBase(lateRule, deadline), completed_at: completedAt.toISOString() },
      });
    }
  }

  if (escalationRule && !isDone) {
    const deadline = new Date(effectiveDue.getTime() + (escalationRule.grace_hours || 0) * HOUR_MS);
    if (now.getTime() > deadline.getTime()) {
      const every = Math.max(1, escalationRule.repeat_every_days || 1);
      // the escalation follows the person who owned the task at its deadline, and stops when it changes hands
      const handedOver = ctx.reassignedAfter ? ctx.reassignedAfter(effectiveDue) : null;
      const until = handedOver && handedOver < now ? handedOver : now;
      let instants = cal.cycleInstants(owner, deadline, every, until).filter((at) => !blocked(at) && applies(escalationRule, at));
      const points = Number(escalationRule.points);
      if (escalationRule.max_points_per_task != null && points > 0) instants = instants.slice(0, Math.floor(Number(escalationRule.max_points_per_task) / points));
      instants.forEach((at, i) => {
        const cycle = i + 1;
        out.push({
          rule: escalationRule, userId: owner, points, occurredAt: at, cycle,
          reason: `${task.ref} still overdue after ${cycle * every} working day(s)`,
          occurrenceKey: `rule:${escalationRule.id}:task:${task.id}:overdue:${cycle}`,
          evidence: { ...evidenceBase(escalationRule, deadline), cycle, counting: 'working days of the owner', every_working_days: every },
        });
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- who owned it when

/**
 * Owner history for tasks (task_owner_changes, filled by a trigger on every
 * change and backfilled from the activity log), as two functions per task.
 */
export async function ownershipFor(tasks, runner = { query }) {
  const ids = tasks.map((t) => t.id);
  const byTask = new Map();
  if (ids.length) {
    const { rows } = await runner.query(
      'SELECT task_id, from_user_id, to_user_id, changed_at FROM task_owner_changes WHERE task_id = ANY($1::int[]) ORDER BY changed_at, id',
      [ids],
    );
    for (const r of rows) byTask.set(r.task_id, [...(byTask.get(r.task_id) || []), r]);
  }
  const fns = new Map();
  for (const t of tasks) {
    const changes = byTask.get(t.id) || [];
    fns.set(t.id, {
      ownerAt: (instant) => {
        const at = new Date(instant).getTime();
        let owner;
        for (const c of changes) if (new Date(c.changed_at).getTime() <= at) owner = c.to_user_id;
        if (owner !== undefined) return owner;
        const next = changes.find((c) => new Date(c.changed_at).getTime() > at);
        return next ? next.from_user_id : t.assignee_id;
      },
      reassignedAfter: (instant) => {
        const at = new Date(instant).getTime();
        const next = changes.find((c) => new Date(c.changed_at).getTime() > at && c.from_user_id !== c.to_user_id);
        return next ? new Date(next.changed_at) : null;
      },
      people: [...new Set([t.assignee_id, ...changes.flatMap((c) => [c.from_user_id, c.to_user_id])].filter(Boolean))],
    });
  }
  return fns;
}

/** Everything evaluateTask needs to be fair, for a set of tasks. */
export async function fairnessContext(tasks, runner = { query }) {
  const ids = tasks.map((t) => t.id);
  const owners = await ownershipFor(tasks, runner);
  const people = [...new Set([...owners.values()].flatMap((o) => o.people))];
  const [missed, blocks, inactive] = await Promise.all([
    ids.length ? runner.query(
      `SELECT DISTINCT bm.task_id, r.trigger_type FROM black_marks bm JOIN blackmark_rules r ON r.id = bm.rule_id
        WHERE bm.task_id = ANY($1::int[]) AND r.trigger_type IN ('deadline_missed', 'completed_late')`,
      [ids],
    ) : { rows: [] },
    ids.length ? runner.query(
      `SELECT task_id, recorded_at, decided_at, cleared_at FROM task_blocks
        WHERE task_id = ANY($1::int[]) AND (status = 'ACCEPTED' OR (status = 'CLEARED' AND decided_at IS NOT NULL))`,
      [ids],
    ) : { rows: [] },
    people.length ? runner.query('SELECT id FROM users WHERE id = ANY($1::int[]) AND is_active = FALSE', [people]) : { rows: [] },
  ]);
  const missedSet = new Set(missed.rows.filter((r) => r.trigger_type === 'deadline_missed').map((r) => r.task_id));
  // one "delivered late" mark per task, whichever rule recorded it
  const lateSet = new Set(missed.rows.filter((r) => r.trigger_type === 'completed_late').map((r) => r.task_id));
  const blocksBy = new Map();
  for (const b of blocks.rows) blocksBy.set(b.task_id, [...(blocksBy.get(b.task_id) || []), b]);
  const inactiveSet = new Set(inactive.rows.map((r) => r.id));
  return {
    people,
    for: (task) => ({
      ownerAt: owners.get(task.id)?.ownerAt,
      reassignedAfter: owners.get(task.id)?.reassignedAfter,
      missedRecorded: missedSet.has(task.id),
      lateRecorded: lateSet.has(task.id),
      blocks: blocksBy.get(task.id) || [],
      inactive: inactiveSet,
    }),
  };
}

/** The marks rules that depend on a deadline. */
export const DEADLINE_TRIGGERS = ['deadline_missed', 'completed_late', 'overdue_escalation'];

/**
 * Whether a recorded mark would have been recorded under a calendar: judged
 * as if the scan had run all along, up to completion (done) or now (open).
 * An escalation cycle of a task still open only moves in time when the
 * calendar changes, so it counts as eligible while the task is overdue at all.
 */
export function markEligible(mark, task, cal, now) {
  const userId = mark.user_id;
  const snapshot = mark.evidence?.rule || {};
  const grace = Number(snapshot.grace_hours ?? mark.rule_grace_hours ?? 0);
  const { at } = cal.effectiveDeadline(userId, task.due_date);
  const deadline = new Date(at.getTime() + grace * 3600 * 1000);
  const done = task.stage === 'done' && task.completed_at;
  const until = done ? new Date(task.completed_at) : now;
  if (mark.trigger_type === 'deadline_missed') return until > deadline;
  if (mark.trigger_type === 'completed_late') return Boolean(done) && new Date(task.completed_at) > deadline;
  if (mark.trigger_type === 'overdue_escalation') {
    if (!done) return until > deadline;
    const cycle = Number(String(mark.occurrence_key).split(':overdue:')[1]) || 1;
    const every = Math.max(1, Number(snapshot.repeat_every_days ?? mark.rule_repeat_every_days ?? 1));
    return cal.cycleInstants(userId, deadline, every, until).length >= cycle;
  }
  return true;
}

/**
 * Active automatic marks that would not be recorded today, for someone who can
 * waive marks to look at, each with why. Nothing is changed here; nothing is
 * waived automatically.
 *   CALENDAR          a holiday or leave approved after the mark moved the deadline in force
 *   STACKED           another missed-deadline mark on the same task comes from the rule that applies (D2)
 *   LATE_AFTER_MISSED a "delivered late" mark on a task that already has a missed-deadline mark
 *   WRONG_OWNER       someone else owned the task at its effective deadline
 *   DEFERRED          the task now has an approved deferral
 *   BLOCKED           an accepted block covered the deadline
 *   INACTIVE_OWNER    the person's account is switched off
 */
export const RECHECK_WORDS = {
  CALENDAR: 'The calendar now moves the deadline in force (a holiday or leave approved since)',
  STACKED: 'A second missed-deadline mark for the same miss, from a rule that no longer applies (one rule per miss now)',
  LATE_AFTER_MISSED: 'Marked "delivered late" on top of a missed deadline for the same task',
  WRONG_OWNER: 'Someone else owned the task at its deadline',
  DEFERRED: 'The task has an approved deferral',
  BLOCKED: 'An accepted block covered the deadline',
  INACTIVE_OWNER: 'The person\'s account is switched off',
};

export async function marksToRecheck({ now = new Date(), userIds = null } = {}) {
  const { rows: marks } = await query(
    `SELECT bm.*, r.trigger_type, r.grace_hours AS rule_grace_hours, r.repeat_every_days AS rule_repeat_every_days,
            r.priorities AS rule_priorities, r.department_ids AS rule_department_ids, r.id AS rule_row_id,
            r.name AS rule_name, t.ref AS task_ref, t.title AS task_title, t.due_date, t.completed_at, t.priority, t.department_id,
            t.deferral_id, t.assignee_id, s.stage, u.full_name, u.is_active AS user_active
       FROM black_marks bm
       JOIN blackmark_rules r ON r.id = bm.rule_id
       JOIN tasks t ON t.id = bm.task_id
       JOIN workflow_statuses s ON s.id = t.status_id
       JOIN users u ON u.id = bm.user_id
      WHERE bm.status = 'active' AND bm.source = 'auto' AND r.trigger_type = ANY($1::text[]) AND t.due_date IS NOT NULL
        AND ($2::int[] IS NULL OR bm.user_id = ANY($2::int[]))
      ORDER BY bm.occurred_at DESC
      LIMIT 1000`,
    [DEADLINE_TRIGGERS, userIds],
  );
  if (!marks.length) return [];
  const taskRows = [...new Map(marks.map((m) => [m.task_id, { id: m.task_id, assignee_id: m.assignee_id, due_date: m.due_date }])).values()];
  const fair = await fairnessContext(taskRows);
  const cal = await calendarForTasks([...marks.map((m) => ({ assignee_id: m.user_id, due_date: m.due_date })), ...fair.people.map((id) => ({ assignee_id: id, due_date: null }))], now);
  const byTask = new Map();
  for (const m of marks) byTask.set(m.task_id, [...(byTask.get(m.task_id) || []), m]);
  const out = [];
  for (const mark of marks) {
    const reasons = [];
    const task = { id: mark.task_id, due_date: mark.due_date, completed_at: mark.completed_at, stage: mark.stage, priority: mark.priority, department_id: mark.department_id };
    if (!markEligible(mark, task, cal, now)) reasons.push('CALENDAR');
    const siblings = byTask.get(mark.task_id) || [];
    if (mark.trigger_type === 'deadline_missed') {
      const missedRules = siblings.filter((x) => x.trigger_type === 'deadline_missed').map((x) => ({ id: x.rule_row_id, trigger_type: 'deadline_missed', priorities: x.rule_priorities, department_ids: x.rule_department_ids }));
      if (missedRules.length > 1 && pickRule(missedRules, task)?.id !== mark.rule_row_id) reasons.push('STACKED');
    }
    if (mark.trigger_type === 'completed_late' && siblings.some((x) => x.trigger_type === 'deadline_missed')) reasons.push('LATE_AFTER_MISSED');
    const ctx = fair.for(task);
    const effective = cal.effectiveDeadline(mark.user_id, mark.due_date).at;
    const owner = ctx.ownerAt ? ctx.ownerAt(effective) : mark.assignee_id;
    if (owner && owner !== mark.user_id) reasons.push('WRONG_OWNER');
    if (mark.deferral_id) reasons.push('DEFERRED');
    if ((ctx.blocks || []).some((b) => new Date(b.recorded_at) <= new Date(mark.occurred_at) && (!b.cleared_at || new Date(b.cleared_at) > effective))) reasons.push('BLOCKED');
    if (!mark.user_active) reasons.push('INACTIVE_OWNER');
    if (!reasons.length) continue;
    const { at, shifted } = cal.effectiveDeadline(mark.user_id, mark.due_date);
    out.push({
      mark_id: mark.id, user_id: mark.user_id, full_name: mark.full_name, task_id: mark.task_id, task_ref: mark.task_ref,
      task_title: mark.task_title, rule_name: mark.rule_name, trigger_type: mark.trigger_type, points: Number(mark.points), occurred_at: mark.occurred_at,
      due: mark.due_date, effective_due: at.toISOString(), because: shifted, reasons, reason_words: reasons.map((r) => RECHECK_WORDS[r]),
    });
  }
  return out;
}

const SCAN_TASKS = `
  SELECT t.*, s.stage, d.name AS department_name, u.full_name AS assignee_name, u.department_id AS assignee_department_id
    FROM tasks t
    JOIN workflow_statuses s ON s.id = t.status_id
    JOIN departments d ON d.id = t.department_id
    LEFT JOIN users u ON u.id = t.assignee_id
   WHERE t.is_archived = FALSE
     AND t.due_date IS NOT NULL`;

/** The tasks a scan or a preview looks at. */
export async function scanTasks({ taskId = null, assigneeIds = null, dueFrom = null, dueTo = null } = {}) {
  const { rows } = await query(
    `${SCAN_TASKS}
       AND ($1::int IS NULL OR t.id = $1::int)
       AND ($2::int[] IS NULL OR t.assignee_id = ANY($2::int[]))
       AND ($3::timestamptz IS NULL OR t.due_date >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR t.due_date < $4::timestamptz)`,
    [taskId, assigneeIds, dueFrom, dueTo],
  );
  return rows;
}

/** A calendar wide enough for these tasks: from the earliest deadline to past now. */
export async function calendarForTasks(tasks, now, options = {}) {
  const tz = policyAt(await policyTimeline(), now)?.config?.timezone || DEFAULT_TIMEZONE;
  const earliest = tasks.reduce((min, t) => (t.due_date && new Date(t.due_date) < min ? new Date(t.due_date) : min), now);
  const from = addDays(dateIn(tz, earliest), -1);
  const to = addDays(dateIn(tz, now), MAX_SHIFT_DAYS + 7);
  return markCalendar(tasks.map((t) => t.assignee_id), { from, to, now, ...options });
}

/**
 * Evaluates every active rule against the current task set.
 * Safe to call as often as you like — nothing is double counted.
 *
 * Deadlines are judged against the calendar of the person who owned the task
 * at its deadline: one falling on a weekly off, an approved holiday or
 * approved leave is in force from the same time on their next working day,
 * and an escalation counts their working days. See evaluateTask for the
 * fairness rules (precedence, owner at the deadline, deferrals, blocks,
 * deactivated people, rules applying from a date).
 *
 * @returns {Promise<{scanned:number, created:Array}>}
 */
export async function runBlackMarkScan({ now = new Date(), taskId = null } = {}) {
  const settings = await getSettings();

  const { rows: rules } = await query(
    `SELECT * FROM blackmark_rules WHERE is_active = TRUE AND trigger_type <> 'manual'`,
  );
  if (rules.length === 0) return { scanned: 0, created: [] };

  const tasks = await scanTasks({ taskId });
  const created = [];
  if (!tasks.length) return { scanned: 0, created };
  const fair = await fairnessContext(tasks);
  // the calendar of everyone who owned one of these tasks, not just the owners now
  const cal = await calendarForTasks([...tasks, ...fair.people.map((id) => ({ assignee_id: id, due_date: null }))], now);

  for (const task of tasks) {
    if (task.stage === 'cancelled') continue;
    for (const occurrence of evaluateTask(task, rules, cal, now, fair.for(task))) {
      const { rule } = occurrence;
      if (rule.trigger_type === 'overdue_escalation' && rule.max_points_per_task != null) {
        const existing = await pointsAlreadyOnTask(task.id, rule.id);
        if (existing + Number(rule.points) > Number(rule.max_points_per_task)) continue;
      }
      const mark = await recordBlackMark({
        userId: occurrence.userId || task.assignee_id,
        taskId: task.id,
        ruleId: rule.id,
        points: occurrence.points,
        reason: occurrence.reason,
        occurredAt: occurrence.occurredAt,
        occurrenceKey: occurrence.occurrenceKey,
        evidence: occurrence.evidence,
        timezone: cal.timezone,
      });
      if (mark) created.push({ ...mark, rule_name: rule.name, task_ref: task.ref });
    }

    if (task.stage !== 'done' && now.getTime() > new Date(task.due_date).getTime()) {
      await query('UPDATE tasks SET breach_evaluated_at = now() WHERE id = $1', [task.id]);
    }
  }

  if (settings.blackmarks.notifyMember) {
    for (const mark of created) {
      await notify(null, {
        userId: mark.user_id,
        type: 'blackmark',
        title: `Black mark recorded (${Number(mark.points)} pt)`,
        body: mark.reason,
        taskId: mark.task_id,
      });
    }
  }

  return { scanned: tasks.length, created };
}

/** Fired from the task routes when a card is moved out of a done status. */
export async function handleTaskReopened({ task, actorId }) {
  const { rows: rules } = await query(
    `SELECT * FROM blackmark_rules WHERE is_active = TRUE AND trigger_type = 'task_reopened'`,
  );
  const created = [];
  // D2: one mark per reopening, from the most specific matching rule
  const picked = pickRule(rules, task, 'task_reopened');
  for (const rule of picked ? [picked] : []) {
    if (!task.assignee_id) continue;
    if (rule.effective_from && new Date() < new Date(rule.effective_from)) continue;
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM task_activity
        WHERE task_id = $1 AND action = 'reopened'`,
      [task.id],
    );
    const mark = await recordBlackMark({
      userId: task.assignee_id,
      taskId: task.id,
      ruleId: rule.id,
      points: Number(rule.points),
      reason: `${task.ref} was reopened after being marked done`,
      occurrenceKey: `rule:${rule.id}:task:${task.id}:reopen:${rows[0].n}`,
      createdBy: actorId,
      evidence: { basis: 'TASK_REOPENED', task_id: task.id, task_ref: task.ref, reopened_count: rows[0].n, rule: ruleSnapshot(rule), reopened_by: actorId ?? null },
    });
    if (mark) created.push(mark);
  }
  return created;
}

/** The first instant of a month (YYYY-MM or YYYY-MM-DD) in a timezone. */
const monthStart = (month, timezone) => new Date(localMidnight(`${month.slice(0, 7)}-01`, timezone));
const shiftMonth = (month, by) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * Monthly review data: per-member totals with the flag that drives the
 * "more than N missed deadlines" action list. Months run from midnight to
 * midnight in the organisation's timezone, not UTC.
 *
 * The thresholds here flag people for a conversation. They never change
 * attendance, leave or pay; no rule converts marks into absence.
 */
export async function monthlyReview({ month, departmentId = null, now = new Date() } = {}) {
  const settings = await getSettings();
  const windowMonths = Math.max(1, settings.blackmarks.rollingWindowMonths || 1);
  const timezone = policyAt(await policyTimeline(), now)?.config?.timezone || DEFAULT_TIMEZONE;
  const anchor = month && /^\d{4}-\d{2}/.test(month) ? month.slice(0, 7) : dateIn(timezone, now).slice(0, 7);
  const periodEnd = monthStart(shiftMonth(anchor, 1), timezone);
  const periodStart = monthStart(shiftMonth(anchor, -(windowMonths - 1)), timezone);

  const { rows } = await query(
    `SELECT u.id                                                AS user_id,
            u.full_name,
            u.email,
            u.role,
            d.name                                              AS department,
            COUNT(bm.id) FILTER (WHERE bm.status = 'active')     AS mark_count,
            COALESCE(SUM(bm.points) FILTER (WHERE bm.status = 'active'), 0) AS total_points,
            COUNT(bm.id) FILTER (WHERE bm.status = 'waived')     AS waived_count,
            COUNT(DISTINCT bm.task_id) FILTER (
              WHERE bm.status = 'active' AND r.trigger_type IN ('deadline_missed', 'completed_late')
            )                                                    AS missed_deadlines,
            COUNT(DISTINCT bm.task_id) FILTER (
              WHERE bm.status = 'active' AND r.trigger_type IN ('deadline_missed', 'completed_late', 'overdue_escalation')
            )                                                    AS tasks_missed
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN black_marks bm
              ON bm.user_id = u.id
             AND bm.occurred_at >= $1 AND bm.occurred_at < $2
       LEFT JOIN blackmark_rules r ON r.id = bm.rule_id
      WHERE u.is_active = TRUE
        AND ($3::int IS NULL OR u.department_id = $3::int)
      GROUP BY u.id, d.name
      ORDER BY total_points DESC, mark_count DESC, u.full_name ASC`,
    [periodStart, periodEnd, departmentId],
  );

  const limit = settings.blackmarks.missedDeadlineLimit;
  const members = rows.map((r) => ({
    ...r,
    mark_count: Number(r.mark_count),
    waived_count: Number(r.waived_count),
    missed_deadlines: Number(r.missed_deadlines),
    // three counts kept apart: tasks missed, mark events, weighted points
    tasks_missed: Number(r.tasks_missed),
    mark_events: Number(r.mark_count),
    total_points: Number(r.total_points),
    over_limit: Number(r.missed_deadlines) > limit,
    severity:
      Number(r.total_points) >= settings.blackmarks.criticalPoints
        ? 'critical'
        : Number(r.total_points) >= settings.blackmarks.warningPoints
          ? 'warning'
          : 'ok',
  }));

  return {
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString(), months: windowMonths, timezone },
    thresholds: settings.blackmarks,
    // stated, so nobody reads a threshold as a pay or attendance rule
    consequences: 'Flags for review only. Black marks do not change attendance, leave or pay, and no rule converts marks into absence.',
    members,
    flagged: members.filter((m) => m.over_limit || m.severity === 'critical'),
  };
}

export { DAY_MS };
