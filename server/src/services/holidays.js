/**
 * Holidays planned month by month or at short notice, and the reconciliation
 * of what a late change touches.
 *
 *   1. Anyone with "attendance.policy" proposes a change: add a date or range,
 *      amend entries, or cancel them. Company, department or one person; full
 *      day or a half.
 *   2. Someone with "holiday.approve" sees the impact and approves or rejects
 *      it. Approval writes the calendar and publishes it to the people it
 *      covers. Someone cannot approve their own change, except an
 *      administrator who writes down why.
 *   3. Attendance follows the calendar at once: the day ledger is worked out
 *      from it, and the original check-ins are never touched. Stored records
 *      the change touches — black marks, standup reviews, leave already
 *      counted against the allowance — are listed as corrections. Each one
 *      changes nothing until a person with the right permission applies it,
 *      and every applied correction can be reversed.
 *
 * Nothing here marks a task done or moves a task's deadline. Months whose
 * payroll is approved or locked cannot be changed.
 */

import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission, isAdmin } from '../lib/permissions.js';
import { notify } from './activity.js';
import { policyAt, policyOn, policyTimeline } from './attendancePolicy.js';
import {
  addDays, assertReviewer, audit, dateIn, holidaysBetween, instantAt, resetGateCache, scheduleOn,
} from './attendance.js';
import { buildLedgers, monthBounds } from './attendanceLedger.js';
import { leaveDays } from './leave.js';
import {
  DEADLINE_TRIGGERS, DEFAULT_TIMEZONE, evaluateTask, markCalendar, markEligible, recordBlackMark, scanTasks,
} from './blackmarks.js';

export const COVERAGE = ['FULL', 'FIRST_HALF', 'SECOND_HALF'];
export const KINDS = ['HOLIDAY', 'CLOSURE'];
export const MAX_RANGE_DAYS = 62;
// how far before a changed date a deadline can sit and still be carried onto it
const DEADLINE_LOOKBACK_DAYS = 14;

export const CORRECTION_PERMISSION = {
  MARK_WAIVE: 'blackmark.waive',
  MARK_RESTORE: 'blackmark.waive',
  MARK_CREATE: 'blackmark.create',
  STANDUP_EXCUSE: 'standup.review',
  STANDUP_UNEXCUSE: 'standup.review',
  LEAVE_DAY_RELEASE: 'leave.approve',
  LEAVE_DAY_RESTORE: 'leave.approve',
};

const COVERAGE_WORDS = { FULL: 'full day', FIRST_HALF: 'morning off', SECOND_HALF: 'afternoon off' };

const dayWords = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  .format(new Date(`${date}T00:00:00Z`));

export function datesOf(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export const scopeOf = (row) => (row.user_id ? 'PERSON' : row.department_id ? 'DEPARTMENT' : 'COMPANY');

async function timezoneNow(now = new Date()) {
  return policyAt(await policyTimeline(), now)?.config?.timezone || DEFAULT_TIMEZONE;
}

/** The last date of the latest month whose payroll is approved or locked. */
export async function closedThrough(runner = { query }) {
  const { rows } = await runner.query(`SELECT MAX(month) AS month FROM payroll_results WHERE status IN ('APPROVED', 'LOCKED')`);
  return rows[0].month ? monthBounds(rows[0].month).last : null;
}

async function assertOpenMonths(dates, runner) {
  const closed = await closedThrough(runner);
  const blocked = dates.filter((d) => closed && d <= closed);
  if (blocked.length) {
    throw conflict(`Payroll is approved or locked up to ${closed}. ${blocked.map(dayWords).join(', ')} cannot change; reopen that payroll month first.`);
  }
}

async function entriesById(ids, runner = { query }) {
  if (!ids.length) return [];
  const { rows } = await runner.query(
    `SELECT h.*, d.name AS department_name, u.full_name AS user_name FROM work_holidays h
       LEFT JOIN departments d ON d.id = h.department_id LEFT JOIN users u ON u.id = h.user_id
      WHERE h.id = ANY($1::int[]) ORDER BY h.holiday_date, h.id`,
    [ids],
  );
  return rows;
}

/** The calendar entries a request would put in force, before it is approved. */
function proposedEntries(request) {
  if (request.action === 'CANCEL') return [];
  return datesOf(request.start_date, request.end_date).map((date) => ({
    id: null,
    proposed: true,
    holiday_date: date,
    name: request.name,
    kind: request.kind || 'HOLIDAY',
    coverage: request.coverage || 'FULL',
    department_id: request.scope === 'DEPARTMENT' ? request.department_id : null,
    user_id: request.scope === 'PERSON' ? request.user_id : null,
    status: 'APPROVED',
  }));
}

/** Entries already in force that would clash with these new ones (same date and scope). */
async function clashes(entries, excludeIds = []) {
  if (!entries.length) return [];
  const dates = entries.map((e) => e.holiday_date);
  const live = await holidaysBetween(dates.reduce((a, b) => (a < b ? a : b)), dates.reduce((a, b) => (a > b ? a : b)));
  return live.filter((h) => !excludeIds.includes(h.id) && entries.some((e) => e.holiday_date === h.holiday_date
    && (e.department_id ?? null) === (h.department_id ?? null) && (e.user_id ?? null) === (h.user_id ?? null)));
}

// ---------------------------------------------------------------- reading

export async function requestById(id, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT r.*, d.name AS department_name, u.full_name AS user_name,
            p.full_name AS proposed_by_name, x.full_name AS decided_by_name
       FROM holiday_requests r
       LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN users p ON p.id = r.proposed_by LEFT JOIN users x ON x.id = r.decided_by
      WHERE r.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * The managed calendar for a period: every entry whatever its status, with
 * who added, approved and cancelled it; the requests touching the period or
 * still waiting; and how many corrections each request left open.
 */
export async function calendarView({ from, to }) {
  const { rows: entries } = await query(
    `SELECT h.*, d.name AS department_name, u.full_name AS user_name,
            c.full_name AS created_by_name, a.full_name AS approved_by_name, x.full_name AS cancelled_by_name
       FROM work_holidays h
       LEFT JOIN departments d ON d.id = h.department_id LEFT JOIN users u ON u.id = h.user_id
       LEFT JOIN users c ON c.id = h.created_by LEFT JOIN users a ON a.id = h.approved_by
       LEFT JOIN users x ON x.id = h.cancelled_by
      WHERE h.holiday_date BETWEEN $1 AND $2
      ORDER BY h.holiday_date, h.id`,
    [from, to],
  );
  const ids = entries.map((e) => e.id);
  const { rows: requests } = await query(
    `SELECT r.*, d.name AS department_name, u.full_name AS user_name,
            p.full_name AS proposed_by_name, x.full_name AS decided_by_name,
            (SELECT COUNT(*)::int FROM holiday_corrections c WHERE c.request_id = r.id AND c.status = 'PROPOSED') AS open_corrections,
            (SELECT COUNT(*)::int FROM holiday_corrections c WHERE c.request_id = r.id) AS all_corrections
       FROM holiday_requests r
       LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN users p ON p.id = r.proposed_by LEFT JOIN users x ON x.id = r.decided_by
      WHERE r.status = 'PROPOSED'
         OR (r.start_date <= $2 AND r.end_date >= $1)
         OR r.target_ids && $3::int[]
         OR r.result_ids && $3::int[]
         OR EXISTS (SELECT 1 FROM holiday_corrections c WHERE c.request_id = r.id AND c.status = 'PROPOSED')
      ORDER BY (r.status = 'PROPOSED') DESC, r.proposed_at DESC
      LIMIT 200`,
    [from, to, ids],
  );
  return { from, to, entries, requests };
}

// ---------------------------------------------------------------- proposing

/**
 * Records a proposed change. Nothing is in force until it is approved.
 *
 *   ADD     name, kind, start_date, end_date, coverage, scope (+ department_id | user_id), reason
 *   AMEND   target_ids and the same fields as ADD: the targets end and the new entries replace them
 *   CANCEL  target_ids, reason
 */
export async function proposeChange(actor, input) {
  if (!hasPermission(actor, 'attendance.policy')) throw forbidden('Requires permission: attendance.policy');
  const action = input.action;
  const reason = String(input.reason || '').trim();
  if (reason.length < 3) throw badRequest('Say why: the reason is kept with the change and shown to whoever approves it');

  const targets = action === 'ADD' ? [] : await entriesById([...new Set((input.target_ids || []).map(Number))]);
  if (action !== 'ADD') {
    if (!targets.length || targets.length !== new Set(input.target_ids).size) throw notFound('Choose the holiday dates to change');
    const ended = targets.filter((t) => t.status !== 'APPROVED');
    if (ended.length) throw conflict(`${ended.map((t) => dayWords(t.holiday_date)).join(', ')} is already cancelled`);
    const { rows: pending } = await query(
      `SELECT id FROM holiday_requests WHERE status = 'PROPOSED' AND target_ids && $1::int[]`,
      [targets.map((t) => t.id)],
    );
    if (pending.length) throw conflict(`These dates already have a change waiting for approval (request #${pending[0].id})`);
  }

  let fields = {};
  if (action === 'ADD' || action === 'AMEND') {
    const base = targets[0] || {};
    const scope = input.scope || (action === 'AMEND' ? scopeOf(base) : 'COMPANY');
    fields = {
      name: String(input.name ?? base.name ?? '').trim(),
      kind: input.kind || base.kind || 'HOLIDAY',
      start_date: input.start_date || (action === 'AMEND' ? targets[0].holiday_date : null),
      end_date: input.end_date || input.start_date || (action === 'AMEND' ? targets[targets.length - 1].holiday_date : null),
      coverage: input.coverage || base.coverage || 'FULL',
      scope,
      department_id: scope === 'DEPARTMENT' ? Number(input.department_id ?? base.department_id) || null : null,
      user_id: scope === 'PERSON' ? Number(input.user_id ?? base.user_id) || null : null,
    };
    if (!fields.name) throw badRequest('Give the holiday a name');
    if (!KINDS.includes(fields.kind)) throw badRequest('Choose a holiday or a closure');
    if (!COVERAGE.includes(fields.coverage)) throw badRequest('Choose a full day, the morning or the afternoon');
    if (!fields.start_date || !fields.end_date || fields.end_date < fields.start_date) throw badRequest('The end date cannot be before the start date');
    if (datesOf(fields.start_date, fields.end_date).length > MAX_RANGE_DAYS) throw badRequest(`At most ${MAX_RANGE_DAYS} days in one change`);
    if (scope === 'DEPARTMENT') {
      if (!fields.department_id) throw badRequest('Choose the department');
      const { rows } = await query('SELECT 1 FROM departments WHERE id = $1', [fields.department_id]);
      if (!rows.length) throw notFound('Department not found');
    }
    if (scope === 'PERSON') {
      if (!fields.user_id) throw badRequest('Choose the person');
      const { rows } = await query('SELECT 1 FROM users WHERE id = $1', [fields.user_id]);
      if (!rows.length) throw notFound('Person not found');
    }
    const clash = await clashes(proposedEntries({ action, ...fields }), targets.map((t) => t.id));
    if (clash.length) {
      throw conflict(`Already a holiday for the same people on ${clash.map((c) => `${dayWords(c.holiday_date)} (${c.name})`).join(', ')}. Amend that entry instead.`);
    }
  }

  await assertOpenMonths([...targets.map((t) => t.holiday_date), ...(fields.start_date ? datesOf(fields.start_date, fields.end_date) : [])]);

  const { rows } = await query(
    `INSERT INTO holiday_requests (action, target_ids, name, kind, start_date, end_date, coverage, scope, department_id, user_id, reason, proposed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      action, targets.map((t) => t.id), fields.name ?? null, fields.kind ?? null, fields.start_date ?? null, fields.end_date ?? null,
      fields.coverage ?? null, fields.scope ?? null, fields.department_id ?? null, fields.user_id ?? null, reason, actor.id,
    ],
  );
  await audit(null, {
    entityType: 'HOLIDAY_REQUEST', entityId: rows[0].id, actorId: actor.id, action: 'PROPOSED', reason,
    after: { ...rows[0], targets: targets.map((t) => ({ id: t.id, date: t.holiday_date, name: t.name, coverage: t.coverage })) },
  });
  return requestById(rows[0].id);
}

export async function withdrawRequest(actor, id, note = null) {
  const request = await requestById(id);
  if (!request) throw notFound('Request not found');
  if (request.proposed_by !== actor.id && !hasPermission(actor, 'holiday.approve')) throw forbidden('Only whoever proposed it, or an approver, can withdraw it');
  const { rows } = await query(
    `UPDATE holiday_requests SET status = 'WITHDRAWN', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now()
      WHERE id = $1 AND status = 'PROPOSED' RETURNING *`,
    [id, actor.id, note],
  );
  if (!rows.length) throw conflict('That request has already been decided');
  await audit(null, { entityType: 'HOLIDAY_REQUEST', entityId: id, actorId: actor.id, action: 'WITHDRAWN', reason: note });
  return requestById(id);
}

// ---------------------------------------------------------------- impact

/** The people a set of entries covers who could be affected: active, or employed into the period. */
async function peopleCovered(entries, from) {
  const company = entries.some((e) => scopeOf(e) === 'COMPANY');
  const departments = [...new Set(entries.filter((e) => scopeOf(e) === 'DEPARTMENT').map((e) => e.department_id))];
  const people = [...new Set(entries.filter((e) => scopeOf(e) === 'PERSON').map((e) => e.user_id))];
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.department_id, u.is_active, u.role FROM users u
       LEFT JOIN employee_work_profiles p ON p.user_id = u.id
      WHERE (u.is_active OR (p.exit_date IS NOT NULL AND p.exit_date >= $1))
        AND ($2::boolean OR u.department_id = ANY($3::int[]) OR u.id = ANY($4::int[]))
      ORDER BY u.full_name`,
    [from, company, departments, people],
  );
  return rows;
}

const dayView = (d) => d && ({
  state: d.schedule_state, half: d.holiday_half || null, holiday: d.holiday || null,
  classification: d.classification, required_seconds: d.R, unpaid_seconds: d.N, unresolved_seconds: d.U,
  blockers: d.blockers || [], absence_decision: d.day_review?.decision || null, before_start: Boolean(d.before_start),
});

/** Whether the morning standup falls in this person's working time on a date. */
function standupOff(date, { config, holidays, member }) {
  const s = scheduleOn(date, {
    config, profile: { working_days: member.working_days }, holidays, departmentId: member.dept ?? null,
    userId: member.user_id ?? null, ignoreStart: true, ignoreEmployment: true,
  });
  return s.state !== 'WORKDAY' || s.holidayHalf === 'FIRST_HALF';
}

/**
 * What approving a request would change, worked out without writing anything:
 *
 *   attendance   every day whose schedule or result changes, before and after
 *   payroll      draft months that will recalculate; closed months block it
 *   marks        marks to waive, restore or create for a person to review
 *   standup      reviews to excuse or un-excuse
 *   leave        days counted against the allowance to give back or restore
 *
 * The same function, with `forCorrections`, lists the corrections to propose
 * once a request is approved.
 */
export async function computeImpact(request, { now = new Date() } = {}) {
  const timezone = await timezoneNow(now);
  const today = dateIn(timezone, now);
  const targets = await entriesById(request.target_ids || []);
  const newEntries = proposedEntries(request);
  const touched = [...targets, ...newEntries];
  const dates = [...new Set(touched.map((e) => e.holiday_date))].sort();
  if (!dates.length) return { dates: [], people: 0, attendance: { changes: [] }, marks: [], standup: [], leave: [], notes: [] };
  const from = dates[0];
  const to = dates[dates.length - 1];
  const targetIds = new Set(targets.map((t) => t.id));
  // the calendar in force now, wide enough for old deadlines and long overdue
  // stretches, and the same calendar with this change applied
  const calFrom = addDays(from, -DEADLINE_LOOKBACK_DAYS - 400);
  const calTo = addDays(to > today ? to : today, 120);
  const before = await holidaysBetween(calFrom, calTo);
  const after = [...before.filter((h) => !targetIds.has(h.id)), ...newEntries];

  const people = await peopleCovered(touched, from);
  const ids = people.map((p) => p.id);
  const nameOf = new Map(people.map((p) => [p.id, p.full_name]));
  const notes = [];
  const closed = await closedThrough();
  const blocked = dates.filter((d) => closed && d <= closed);
  if (blocked.length) notes.push({ code: 'PAYROLL_CLOSED', text: `Payroll is approved or locked up to ${closed}; ${blocked.length} date(s) cannot change.` });

  // ---- attendance: worked out from the calendar, so it follows the change at once
  const changes = [];
  // super admins are told about holidays, but their attendance is not tracked
  const tracked = people.filter((p) => p.role !== 'super_admin').map((p) => p.id);
  if (tracked.length) {
    const window = (list) => list.filter((h) => h.holiday_date >= from && h.holiday_date <= to);
    const [was, will] = await Promise.all([
      buildLedgers(tracked, from, to, { now, holidays: window(before) }),
      buildLedgers(tracked, from, to, { now, holidays: window(after) }),
    ]);
    for (const id of tracked) {
      const a = was.get(id)?.days || [];
      const b = will.get(id)?.days || [];
      a.forEach((day, i) => {
        if (!dates.includes(day.date)) return;
        const next = b[i];
        const x = dayView(day);
        const y = dayView(next);
        if (x.state === y.state && x.half === y.half && x.required_seconds === y.required_seconds && x.classification === y.classification) return;
        changes.push({ user_id: id, name: nameOf.get(id), date: day.date, past: day.date < today, before: x, after: y });
      });
    }
  }
  const count = (fn) => changes.filter(fn).length;
  const attendance = {
    changes,
    people: new Set(changes.map((c) => c.user_id)).size,
    required_seconds_change: changes.reduce((s, c) => s + (c.after.required_seconds - c.before.required_seconds), 0),
    past_days: count((c) => c.past),
    unrecorded_cleared: count((c) => c.before.blockers.includes('UNRECORDED') && !c.after.blockers.includes('UNRECORDED')),
    unrecorded_created: count((c) => !c.before.blockers.includes('UNRECORDED') && c.after.blockers.includes('UNRECORDED')),
    absences_lifted: count((c) => c.before.absence_decision === 'UNAPPROVED_ABSENCE' && c.before.unpaid_seconds > c.after.unpaid_seconds),
    // a reviewer's absence decision on a day that becomes a working day again counts again
    absences_restored: count((c) => c.after.absence_decision === 'UNAPPROVED_ABSENCE' && c.after.unpaid_seconds > c.before.unpaid_seconds),
  };

  // ---- payroll drafts that will recalculate
  const months = [...new Set(dates.map((d) => monthBounds(d).first))];
  const { rows: drafts } = ids.length ? await query(
    `SELECT pr.month, pr.user_id, pr.status, u.full_name FROM payroll_results pr JOIN users u ON u.id = pr.user_id
      WHERE pr.month = ANY($1::date[]) AND pr.user_id = ANY($2::int[]) AND pr.status IN ('DRAFT', 'IN_REVIEW')`,
    [months, ids],
  ) : { rows: [] };

  // ---- black marks
  const marks = [];
  if (ids.length) {
    const lookFrom = addDays(from, -DEADLINE_LOOKBACK_DAYS);
    const calBefore = await markCalendar(ids, { from: calFrom, to: calTo, now, holidays: before, protect: false });
    const calAfter = await markCalendar(ids, { from: calFrom, to: calTo, now, holidays: after, protect: false });
    const { rows: existing } = await query(
      `SELECT bm.*, r.trigger_type, r.grace_hours AS rule_grace_hours, r.repeat_every_days AS rule_repeat_every_days,
              r.name AS rule_name, t.ref AS task_ref, t.title AS task_title, t.due_date, t.completed_at, s.stage
         FROM black_marks bm
         JOIN blackmark_rules r ON r.id = bm.rule_id
         JOIN tasks t ON t.id = bm.task_id
         JOIN workflow_statuses s ON s.id = t.status_id
        WHERE bm.user_id = ANY($1::int[]) AND r.trigger_type = ANY($2::text[]) AND bm.source = 'auto'
          AND t.due_date < $3 AND (s.stage <> 'done' OR t.completed_at IS NULL OR t.completed_at >= $4)`,
      [ids, DEADLINE_TRIGGERS, instantAt(addDays(to, 1), 0, timezone), instantAt(lookFrom, 0, timezone)],
    );
    const { rows: waivedByHoliday } = existing.length ? await query(
      `SELECT DISTINCT ON (target_id) * FROM holiday_corrections
        WHERE target_type = 'BLACK_MARK' AND kind = 'MARK_WAIVE' AND status = 'APPLIED' AND target_id = ANY($1::int[])
        ORDER BY target_id, decided_at DESC`,
      [existing.map((m) => m.id)],
    ) : { rows: [] };
    const waivedBy = new Map(waivedByHoliday.map((c) => [c.target_id, c]));
    for (const mark of existing) {
      const task = { due_date: mark.due_date, completed_at: mark.completed_at, stage: mark.stage };
      const was = markEligible(mark, task, calBefore, now);
      const will = markEligible(mark, task, calAfter, now);
      if (was === will) continue;
      const base = {
        mark_id: mark.id, user_id: mark.user_id, name: nameOf.get(mark.user_id), task_id: mark.task_id, task_ref: mark.task_ref,
        rule: mark.rule_name, trigger: mark.trigger_type, points: Number(mark.points), occurred_at: mark.occurred_at,
        due: mark.due_date, status: mark.status, work_date: dateIn(timezone, new Date(mark.due_date)),
      };
      if (mark.status === 'active' && was && !will) {
        const { shifted } = calAfter.effectiveDeadline(mark.user_id, mark.due_date);
        marks.push({ ...base, kind: 'MARK_WAIVE', because: shifted, summary: `${mark.task_ref}: the deadline falls on ${base.name ? `${base.name}'s` : 'their'} day off once this change applies` });
      } else if (mark.status === 'waived' && !was && will && waivedBy.has(mark.id)) {
        marks.push({ ...base, kind: 'MARK_RESTORE', waived_by_correction: waivedBy.get(mark.id).id, summary: `${mark.task_ref}: waived for a holiday that this change removes` });
      }
    }

    // marks the scan would record under the plain calendar after the change
    // but not before it — a holiday cancelled after the deadlines on it. The
    // scan itself never records these: a person decides.
    const { rows: rules } = await query(`SELECT * FROM blackmark_rules WHERE is_active = TRUE AND trigger_type IN ('deadline_missed', 'completed_late')`);
    if (rules.length) {
      const tasks = await scanTasks({ assigneeIds: ids, dueFrom: instantAt(lookFrom, 0, timezone), dueTo: instantAt(addDays(to, 1), 0, timezone) });
      const keys = tasks.length ? new Set((await query(
        'SELECT occurrence_key FROM black_marks WHERE task_id = ANY($1::int[])', [tasks.map((t) => t.id)],
      )).rows.map((r) => r.occurrence_key)) : new Set();
      for (const task of tasks) {
        const wasKeys = new Set(evaluateTask(task, rules, calBefore, now).map((o) => o.occurrenceKey));
        for (const o of evaluateTask(task, rules, calAfter, now)) {
          if (keys.has(o.occurrenceKey) || wasKeys.has(o.occurrenceKey)) continue;
          marks.push({
            kind: 'MARK_CREATE', task_id: task.id, task_ref: task.ref, user_id: task.assignee_id, name: nameOf.get(task.assignee_id),
            rule: o.rule.name, rule_id: o.rule.id, trigger: o.rule.trigger_type, points: o.points, occurrence_key: o.occurrenceKey,
            occurred_at: o.occurredAt, due: task.due_date, work_date: dateIn(timezone, new Date(task.due_date)), reason: o.reason,
            evidence: o.evidence,
            summary: `${task.ref}: the deadline was on a day this change makes a working day again`,
          });
        }
      }
    }
  }

  // ---- standup reviews
  const standup = [];
  const { rows: reviews } = await query(
    `SELECT r.*, r.work_date AS date, m.user_id, m.full_name, COALESCE(m.department_id, u.department_id) AS dept, p.working_days
       FROM standup_reviews r JOIN standup_members m ON m.id = r.member_id
       LEFT JOIN users u ON u.id = m.user_id LEFT JOIN employee_work_profiles p ON p.user_id = m.user_id
      WHERE r.work_date = ANY($1::date[])`,
    [dates],
  );
  if (reviews.length) {
    const timeline = await policyTimeline();
    const { rows: excused } = await query(
      `SELECT DISTINCT ON (target_id) * FROM holiday_corrections
        WHERE target_type = 'STANDUP_REVIEW' AND kind = 'STANDUP_EXCUSE' AND status = 'APPLIED' AND target_id = ANY($1::int[])
        ORDER BY target_id, decided_at DESC`,
      [reviews.map((r) => r.id)],
    );
    const excusedBy = new Map(excused.map((c) => [c.target_id, c]));
    for (const r of reviews) {
      const config = { ...policyOn(timeline, r.date).config };
      config.workingDays = config.workingDays || [1, 2, 3, 4, 5, 6];
      const was = standupOff(r.date, { config, holidays: before, member: r });
      const will = standupOff(r.date, { config, holidays: after, member: r });
      if (was === will) continue;
      const base = { review_id: r.id, user_id: r.user_id, name: r.full_name, date: r.date, status: r.status, resolution: r.resolution };
      if (!was && will && ['MISSING', 'LATE'].includes(r.status) && !r.resolution) {
        standup.push({ ...base, kind: 'STANDUP_EXCUSE', summary: `${r.full_name}: standup recorded ${r.status.toLowerCase()} on a day that becomes a day off` });
      } else if (was && !will && r.resolution === 'EXCUSED' && excusedBy.has(r.id)) {
        standup.push({ ...base, kind: 'STANDUP_UNEXCUSE', excused_by_correction: excusedBy.get(r.id).id, summary: `${r.full_name}: excused for a holiday that this change removes` });
      } else if (!was && will) {
        standup.push({ ...base, kind: null, summary: `${r.full_name}: recorded ${r.status.toLowerCase()}${r.resolution ? `, already resolved (${r.resolution.toLowerCase()})` : ''} — nothing to change` });
      }
    }
  }
  const { rows: days } = await query(
    `SELECT work_date, status, skipped_reason FROM standup_days WHERE work_date = ANY($1::date[])`, [dates],
  );
  for (const d of days) {
    if (d.status === 'SKIPPED' && String(d.skipped_reason || '').startsWith('HOLIDAY')) {
      notes.push({ code: 'STANDUP_SKIPPED', date: d.work_date, text: `The standup on ${dayWords(d.work_date)} was not run (${d.skipped_reason}). Nobody is recorded missing for it, whatever this change does.` });
    }
  }

  // ---- leave already counted against the allowance
  const leave = [];
  if (ids.length) {
    const { rows: requests } = await query(
      `SELECT l.*, u.department_id, u.full_name FROM leave_requests l JOIN users u ON u.id = l.user_id
        WHERE l.user_id = ANY($1::int[]) AND l.status IN ('APPROVED_PAID', 'APPROVED_UNPAID')
          AND l.end_date >= $2 AND l.start_date <= $3`,
      [ids, from, to],
    );
    const { rows: released } = requests.length ? await query(
      `SELECT * FROM holiday_corrections WHERE target_type = 'LEAVE_REQUEST' AND kind = 'LEAVE_DAY_RELEASE' AND status = 'APPLIED'
          AND target_id = ANY($1::int[])`,
      [requests.map((r) => r.id)],
    ) : { rows: [] };
    for (const l of requests) {
      for (const date of dates) {
        if (date < l.start_date || date > l.end_date) continue;
        const counted = (l.day_allocation || []).find((d) => d.date === date);
        const allocated = Number(counted?.portion || 0);
        const portion = async (list) => Number((await leaveDays(l.user_id, l.department_id, date, date, l.day_part, { holidays: list.filter((h) => h.holiday_date === date) })).days[0]?.portion || 0);
        const was = await portion(before);
        const will = await portion(after);
        if (was === will) continue;
        const base = { leave_request_id: l.id, user_id: l.user_id, name: l.full_name, date, status: l.status, category: l.category, allocated, paid: Number(counted?.paid || 0) };
        const earlier = released.find((c) => c.target_id === l.id && c.work_date === date);
        if (allocated > will && was > will) {
          leave.push({
            ...base, kind: 'LEAVE_DAY_RELEASE', to_portion: will, to_paid: Math.min(Number(counted?.paid || 0), will),
            summary: `${l.full_name}: leave counted ${allocated} day on ${dayWords(date)}, which becomes ${will ? 'half ' : ''}a holiday`,
          });
        } else if (will > allocated && earlier) {
          leave.push({ ...base, kind: 'LEAVE_DAY_RESTORE', released_by_correction: earlier.id, summary: `${l.full_name}: leave day given back for a holiday that this change removes` });
        } else if (will > allocated) {
          leave.push({ ...base, kind: null, summary: `${l.full_name}: approved leave covers ${dayWords(date)} but did not count it. The day will show as unrecorded for a reviewer to settle; nothing is debited automatically.` });
        }
      }
    }
  }

  return {
    computed_at: now.toISOString(),
    timezone,
    dates,
    late: dates.some((d) => d <= today),
    people: people.length,
    covered: people.map((p) => ({ id: p.id, name: p.full_name })),
    attendance,
    payroll: { drafts, closed_through: closed },
    marks,
    standup,
    leave,
    notes,
    summary: {
      attendance_days: changes.length,
      marks_to_waive: marks.filter((m) => m.kind === 'MARK_WAIVE').length,
      marks_to_restore: marks.filter((m) => m.kind === 'MARK_RESTORE').length,
      marks_to_create: marks.filter((m) => m.kind === 'MARK_CREATE').length,
      standup_to_excuse: standup.filter((s) => s.kind === 'STANDUP_EXCUSE').length,
      standup_to_unexcuse: standup.filter((s) => s.kind === 'STANDUP_UNEXCUSE').length,
      leave_days_to_release: leave.filter((l) => l.kind === 'LEAVE_DAY_RELEASE').length,
      leave_days_to_restore: leave.filter((l) => l.kind === 'LEAVE_DAY_RESTORE').length,
      payroll_drafts: drafts.length,
    },
  };
}

/** The corrections an approved request leaves for review. Inserting twice is a no-op. */
async function proposeCorrections(client, request, impact, entriesByDate) {
  const rows = [];
  const holidayFor = (date) => entriesByDate.get(date) ?? null;
  for (const m of impact.marks) {
    if (m.kind === 'MARK_WAIVE' || m.kind === 'MARK_RESTORE') {
      rows.push([m.kind, 'BLACK_MARK', m.mark_id, '', m.work_date, m.user_id, m.summary, { ...m }]);
    } else if (m.kind === 'MARK_CREATE') {
      rows.push([m.kind, 'TASK', m.task_id, m.occurrence_key, m.work_date, m.user_id, m.summary, { ...m }]);
    }
  }
  for (const s of impact.standup) {
    if (s.kind) rows.push([s.kind, 'STANDUP_REVIEW', s.review_id, '', s.date, s.user_id, s.summary, { ...s }]);
  }
  for (const l of impact.leave) {
    if (l.kind) rows.push([l.kind, 'LEAVE_REQUEST', l.leave_request_id, l.date, l.date, l.user_id, l.summary, { ...l }]);
  }
  const created = [];
  for (const [kind, targetType, targetId, key, date, userId, summary, proposal] of rows) {
    const { rows: inserted } = await client.query(
      `INSERT INTO holiday_corrections (request_id, holiday_id, work_date, user_id, kind, target_type, target_id, target_key, summary, proposal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (request_id, kind, target_type, target_id, target_key, work_date) DO NOTHING RETURNING *`,
      [request.id, holidayFor(date), date, userId ?? null, kind, targetType, targetId, key, summary, JSON.stringify(proposal)],
    );
    if (inserted[0]) created.push(inserted[0]);
  }
  return created;
}

// ---------------------------------------------------------------- deciding

/**
 * Approves or rejects a proposed change. Approval puts it in force, keeps the
 * impact the approver was shown, lists the corrections it leaves for review,
 * and tells the people it covers.
 */
export async function decideRequest(actor, id, { approve, note = null, now = new Date() }) {
  if (!hasPermission(actor, 'holiday.approve')) throw forbidden('Requires permission: holiday.approve');
  const request = await requestById(id);
  if (!request) throw notFound('Request not found');
  if (request.status !== 'PROPOSED') throw conflict('That request has already been decided');
  const cleanNote = note ? String(note).trim() : null;

  if (!approve) {
    if (!cleanNote) throw badRequest('Say why it is rejected');
    const { rows } = await query(
      `UPDATE holiday_requests SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now()
        WHERE id = $1 AND status = 'PROPOSED' RETURNING id`,
      [id, actor.id, cleanNote],
    );
    if (!rows.length) throw conflict('That request has already been decided');
    await audit(null, { entityType: 'HOLIDAY_REQUEST', entityId: id, actorId: actor.id, action: 'REJECTED', reason: cleanNote });
    return { request: await requestById(id), corrections: [] };
  }

  const self = request.proposed_by === actor.id;
  if (self && !isAdmin(actor)) throw forbidden('Someone else must approve a change you proposed');
  if (self && !cleanNote) throw badRequest('Approving your own change needs a note saying why nobody else could');

  const impact = await computeImpact(request, { now });
  const targets = await entriesById(request.target_ids || []);
  await assertOpenMonths(impact.dates);

  const result = await withTransaction(async (client) => {
    const { rows: claimed } = await client.query(
      `SELECT * FROM holiday_requests WHERE id = $1 AND status = 'PROPOSED' FOR UPDATE`, [id],
    );
    if (!claimed.length) throw conflict('That request has already been decided');
    await assertOpenMonths(impact.dates, client);

    let cancelled = [];
    if (targets.length) {
      const { rows } = await client.query(
        `UPDATE work_holidays SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3,
                cancel_request_id = $4, updated_at = now()
          WHERE id = ANY($1::int[]) AND status = 'APPROVED' RETURNING *`,
        [targets.map((t) => t.id), actor.id, request.reason, id],
      );
      if (rows.length !== targets.length) throw conflict('Some of these dates changed after the request was made; propose it again');
      cancelled = rows;
    }

    const created = [];
    const entries = proposedEntries(request);
    const series = entries.length ? crypto.randomUUID() : null;
    for (const e of entries) {
      try {
        const { rows } = await client.query(
          `INSERT INTO work_holidays (holiday_date, name, kind, coverage, department_id, user_id, status, series_id, reason,
                                      request_id, created_by, approved_by, approved_at, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'APPROVED', $7, $8, $9, $10, $11, now(), now()) RETURNING *`,
          [e.holiday_date, e.name, e.kind, e.coverage, e.department_id, e.user_id, series, request.reason, id, request.proposed_by, actor.id],
        );
        created.push(rows[0]);
      } catch (err) {
        if (err.code === '23505') throw conflict(`There is already a holiday for the same people on ${dayWords(e.holiday_date)}`);
        throw err;
      }
    }

    await client.query(
      `UPDATE holiday_requests SET status = 'APPROVED', decided_by = $2, decided_at = now(), decision_note = $3,
              self_approved = $4, impact = $5, result_ids = $6, updated_at = now()
        WHERE id = $1`,
      [id, actor.id, cleanNote, self, JSON.stringify(impact), created.map((c) => c.id)],
    );
    // proposals nobody applied that relied on an entry this request ends are no longer offered
    if (cancelled.length) {
      await client.query(
        `UPDATE holiday_corrections SET status = 'STALE', decision_note = $2
          WHERE status = 'PROPOSED' AND holiday_id = ANY($1::int[])`,
        [cancelled.map((c) => c.id), `The holiday it relied on was ended by request #${id}`],
      );
    }
    const byDate = new Map([...cancelled, ...created].map((e) => [e.holiday_date, e.id]));
    const corrections = await proposeCorrections(client, { id }, impact, byDate);

    await audit(client, {
      entityType: 'HOLIDAY_REQUEST', entityId: id, actorId: actor.id, action: self ? 'APPROVED_OWN' : 'APPROVED', reason: cleanNote,
      after: { created: created.map((c) => c.id), cancelled: cancelled.map((c) => c.id), corrections: corrections.length, summary: impact.summary },
    });
    for (const c of cancelled) {
      await audit(client, { entityType: 'HOLIDAY', entityId: c.id, actorId: actor.id, action: 'CANCELLED', reason: request.reason, before: targets.find((t) => t.id === c.id), after: c, source: `holiday_request:${id}` });
    }
    for (const c of created) {
      await audit(client, { entityType: 'HOLIDAY', entityId: c.id, actorId: actor.id, action: 'APPROVED', reason: request.reason, after: c, source: `holiday_request:${id}` });
    }
    return { created, cancelled, corrections };
  });

  resetGateCache();
  await publish(request, result, actor, impact);
  return { request: await requestById(id), ...result, impact };
}

/** Tells the people a decided change covers, once, in their notifications. */
async function publish(request, { created, cancelled }, actor, impact) {
  const covered = impact.covered || [];
  const { rows: approver } = await query('SELECT full_name FROM users WHERE id = $1', [actor.id]);
  const by = approver[0]?.full_name || 'an approver';
  const range = (list) => {
    const ds = [...new Set(list.map((e) => e.holiday_date))].sort();
    return ds.length === 1 ? dayWords(ds[0]) : `${dayWords(ds[0])} to ${dayWords(ds[ds.length - 1])}`;
  };
  let title;
  let body;
  if (request.action === 'CANCEL') {
    title = `Holiday cancelled: ${cancelled[0]?.name || ''} — ${range(cancelled)}`;
    body = `This is a working day again. Cancelled by ${by}. Reason: ${request.reason}`;
  } else {
    const what = created[0]?.kind === 'CLOSURE' ? 'Office closed' : 'Holiday';
    title = `${what}: ${created[0]?.name || request.name} — ${range(created)} (${COVERAGE_WORDS[request.coverage] || 'full day'})`;
    body = `${request.action === 'AMEND' ? 'Changed. ' : ''}In force from approval by ${by}. Reason: ${request.reason}`;
  }
  for (const person of covered) {
    await notify(null, { userId: person.id, type: 'holiday', title, body });
  }
}

// ---------------------------------------------------------------- corrections

export async function correctionById(id, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT c.*, u.full_name AS user_name, d.full_name AS decided_by_name, x.full_name AS reversed_by_name
       FROM holiday_corrections c LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN users d ON d.id = c.decided_by LEFT JOIN users x ON x.id = c.reversed_by
      WHERE c.id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function listCorrections({ requestId = null, status = null } = {}) {
  const { rows } = await query(
    `SELECT c.*, u.full_name AS user_name, d.full_name AS decided_by_name, x.full_name AS reversed_by_name
       FROM holiday_corrections c LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN users d ON d.id = c.decided_by LEFT JOIN users x ON x.id = c.reversed_by
      WHERE ($1::int IS NULL OR c.request_id = $1) AND ($2::text IS NULL OR c.status = $2)
      ORDER BY c.request_id DESC, c.work_date, c.id
      LIMIT 500`,
    [requestId, status],
  );
  return rows;
}

async function assertMayCorrect(actor, correction) {
  const permission = CORRECTION_PERMISSION[correction.kind];
  if (correction.user_id && correction.user_id === actor.id) throw forbidden('Someone else must review a correction about you');
  if (!hasPermission(actor, permission)) throw forbidden(`Requires permission: ${permission}`);
  if (correction.target_type === 'LEAVE_REQUEST') await assertReviewer(actor, correction.user_id, permission);
}

const waiveText = (c) => `Holiday correction #${c.id} (request #${c.request_id}): ${c.summary}`;

/** Carries out one correction against its target, inside a transaction. Returns { before, after } or { stale }. */
async function perform(client, c, actor, direction) {
  const forward = direction === 'apply';
  switch (c.kind) {
    case 'MARK_WAIVE':
    case 'MARK_RESTORE': {
      const waive = (c.kind === 'MARK_WAIVE') === forward;
      const { rows: [mark] } = await client.query('SELECT * FROM black_marks WHERE id = $1 FOR UPDATE', [c.target_id]);
      if (!mark) return { stale: 'The black mark no longer exists' };
      if (waive && mark.status !== 'active') return { stale: 'The mark is no longer active' };
      if (!waive && mark.status !== 'waived') return { stale: 'The mark is no longer waived' };
      const before = { status: mark.status, waived_by: mark.waived_by, waived_reason: mark.waived_reason, waived_at: mark.waived_at };
      const reverseOf = !forward ? c.before : null;
      const { rows: [updated] } = waive
        ? await client.query(
          `UPDATE black_marks SET status = 'waived', waived_by = $2, waived_reason = $3, waived_at = now() WHERE id = $1 RETURNING *`,
          [mark.id, reverseOf?.waived_by ?? actor.id, reverseOf?.waived_reason ?? waiveText(c)],
        )
        : await client.query(
          `UPDATE black_marks SET status = 'active', waived_by = NULL, waived_reason = NULL, waived_at = NULL WHERE id = $1 RETURNING *`,
          [mark.id],
        );
      const after = { status: updated.status, waived_by: updated.waived_by, waived_reason: updated.waived_reason, waived_at: updated.waived_at };
      await audit(client, { entityType: 'BLACK_MARK', entityId: mark.id, subjectUserId: mark.user_id, actorId: actor.id, action: waive ? 'WAIVED' : 'RESTORED', reason: waiveText(c), before, after, source: `holiday_correction:${c.id}` });
      return { before, after };
    }
    case 'MARK_CREATE': {
      if (forward) {
        const p = c.proposal || {};
        const mark = await recordBlackMark({
          userId: c.user_id, taskId: c.target_id, ruleId: p.rule_id, points: p.points, reason: p.reason,
          occurredAt: new Date(p.occurred_at), occurrenceKey: c.target_key, createdBy: actor.id,
          evidence: { ...(p.evidence || {}), recorded_by_correction: c.id, holiday_request_id: c.request_id }, client,
        });
        if (!mark) return { stale: 'This mark has already been recorded' };
        await audit(client, { entityType: 'BLACK_MARK', entityId: mark.id, subjectUserId: c.user_id, actorId: actor.id, action: 'CREATED', reason: waiveText(c), after: mark, source: `holiday_correction:${c.id}` });
        return { before: null, after: { mark_id: mark.id, status: mark.status } };
      }
      const markId = c.after?.mark_id;
      const { rows: [mark] } = await client.query('SELECT * FROM black_marks WHERE id = $1 FOR UPDATE', [markId]);
      if (!mark || mark.status !== 'active') return { stale: 'The mark is no longer active' };
      await client.query(`UPDATE black_marks SET status = 'waived', waived_by = $2, waived_reason = $3, waived_at = now() WHERE id = $1`, [mark.id, actor.id, `Reversed: ${waiveText(c)}`]);
      await audit(client, { entityType: 'BLACK_MARK', entityId: mark.id, subjectUserId: c.user_id, actorId: actor.id, action: 'WAIVED', reason: `Reversed: ${waiveText(c)}`, source: `holiday_correction:${c.id}` });
      return { before: { mark_id: mark.id, status: 'active' }, after: { mark_id: mark.id, status: 'waived' } };
    }
    case 'STANDUP_EXCUSE':
    case 'STANDUP_UNEXCUSE': {
      const excuse = (c.kind === 'STANDUP_EXCUSE') === forward;
      const { rows: [review] } = await client.query('SELECT * FROM standup_reviews WHERE id = $1 FOR UPDATE', [c.target_id]);
      if (!review) return { stale: 'The standup review no longer exists' };
      const before = { resolution: review.resolution, resolution_note: review.resolution_note, resolved_by: review.resolved_by, resolved_at: review.resolved_at };
      if (excuse && review.resolution) return { stale: `Already resolved (${review.resolution.toLowerCase()})` };
      if (!excuse && review.resolution !== 'EXCUSED') return { stale: 'No longer excused' };
      const restore = !forward ? c.before : null;
      const { rows: [updated] } = excuse
        ? await client.query(
          `UPDATE standup_reviews SET resolution = 'EXCUSED', resolution_note = $2, resolved_by = $3, resolved_at = COALESCE($4, now()) WHERE id = $1 RETURNING *`,
          [review.id, restore?.resolution_note ?? waiveText(c), restore?.resolved_by ?? actor.id, restore?.resolved_at ?? null],
        )
        : await client.query(
          `UPDATE standup_reviews SET resolution = NULL, resolution_note = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = $1 RETURNING *`,
          [review.id],
        );
      const after = { resolution: updated.resolution, resolution_note: updated.resolution_note, resolved_by: updated.resolved_by, resolved_at: updated.resolved_at };
      await audit(client, { entityType: 'STANDUP_REVIEW', entityId: review.id, subjectUserId: c.user_id, actorId: actor.id, action: excuse ? 'EXCUSED' : 'UNEXCUSED', reason: waiveText(c), before, after, source: `holiday_correction:${c.id}` });
      return { before, after };
    }
    case 'LEAVE_DAY_RELEASE':
    case 'LEAVE_DAY_RESTORE': {
      const { rows: [l] } = await client.query('SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE', [c.target_id]);
      if (!l) return { stale: 'The leave request no longer exists' };
      if (!['APPROVED_PAID', 'APPROVED_UNPAID'].includes(l.status)) return { stale: 'The leave is no longer approved' };
      await assertOpenMonths([c.work_date], client);
      const allocation = [...(l.day_allocation || [])];
      const at = allocation.findIndex((d) => d.date === c.work_date);
      const current = at >= 0 ? allocation[at] : null;
      let next;
      if (forward && c.kind === 'LEAVE_DAY_RELEASE') {
        const p = c.proposal || {};
        if (!current || Number(current.portion) !== Number(p.allocated)) return { stale: 'The leave allocation for that day has changed' };
        next = Number(p.to_portion) > 0 ? { ...current, portion: Number(p.to_portion), paid: Number(p.to_paid) } : null;
      } else if (forward && c.kind === 'LEAVE_DAY_RESTORE') {
        const { rows: [earlier] } = await client.query('SELECT * FROM holiday_corrections WHERE id = $1', [c.proposal?.released_by_correction]);
        if (!earlier?.before?.entry) return { stale: 'The day that was given back is not on record' };
        if (current && Number(current.portion) >= Number(earlier.before.entry.portion)) return { stale: 'The leave already counts that day' };
        next = earlier.before.entry;
      } else {
        // reversing: put back exactly what was there before
        next = c.before?.entry ?? null;
        const expected = c.after?.entry ?? null;
        if (JSON.stringify(current) !== JSON.stringify(expected)) return { stale: 'The leave allocation for that day has changed since' };
      }
      const updated = allocation.filter((d) => d.date !== c.work_date);
      if (next) updated.push(next);
      updated.sort((a, b) => (a.date < b.date ? -1 : 1));
      const paid = updated.reduce((s, d) => s + Number(d.paid || 0), 0);
      const unpaid = updated.reduce((s, d) => s + Number(d.portion || 0) - Number(d.paid || 0), 0);
      await client.query(
        `UPDATE leave_requests SET day_allocation = $2, paid_days = $3, unpaid_days = $4, updated_at = now() WHERE id = $1`,
        [l.id, JSON.stringify(updated), paid, unpaid],
      );
      const before = { entry: current, paid_days: Number(l.paid_days), unpaid_days: Number(l.unpaid_days) };
      const after = { entry: next, paid_days: paid, unpaid_days: unpaid };
      await audit(client, { entityType: 'LEAVE', entityId: l.id, subjectUserId: l.user_id, actorId: actor.id, action: 'DAY_RECOUNTED', reason: waiveText(c), before, after, source: `holiday_correction:${c.id}` });
      return { before, after };
    }
    default:
      throw badRequest('Unknown correction');
  }
}

/** Applies a proposed correction. A record that changed meanwhile is marked stale, not overwritten. */
export async function applyCorrection(actor, id, { note = null } = {}) {
  const c = await correctionById(id);
  if (!c) throw notFound('Correction not found');
  await assertMayCorrect(actor, c);
  return withTransaction(async (client) => {
    const { rows: [claimed] } = await client.query(
      `UPDATE holiday_corrections SET status = 'APPLIED', decided_by = $2, decided_at = now(), decision_note = $3
        WHERE id = $1 AND status = 'PROPOSED' RETURNING *`,
      [id, actor.id, note],
    );
    if (!claimed) throw conflict('That correction has already been decided');
    const outcome = await perform(client, claimed, actor, 'apply');
    if (outcome.stale) {
      await client.query(`UPDATE holiday_corrections SET status = 'STALE', decision_note = $2 WHERE id = $1`, [id, outcome.stale]);
      await audit(client, { entityType: 'HOLIDAY_CORRECTION', entityId: id, subjectUserId: c.user_id, actorId: actor.id, action: 'STALE', reason: outcome.stale });
      return { correction: await correctionById(id, client), stale: outcome.stale };
    }
    await client.query('UPDATE holiday_corrections SET before = $2, after = $3 WHERE id = $1', [id, JSON.stringify(outcome.before), JSON.stringify(outcome.after)]);
    await audit(client, { entityType: 'HOLIDAY_CORRECTION', entityId: id, subjectUserId: c.user_id, actorId: actor.id, action: 'APPLIED', reason: note, before: outcome.before, after: outcome.after });
    return { correction: await correctionById(id, client) };
  });
}

export async function rejectCorrection(actor, id, { note }) {
  const c = await correctionById(id);
  if (!c) throw notFound('Correction not found');
  await assertMayCorrect(actor, c);
  if (!note || String(note).trim().length < 3) throw badRequest('Say why it is rejected');
  const { rows } = await query(
    `UPDATE holiday_corrections SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3
      WHERE id = $1 AND status = 'PROPOSED' RETURNING id`,
    [id, actor.id, String(note).trim()],
  );
  if (!rows.length) throw conflict('That correction has already been decided');
  await audit(null, { entityType: 'HOLIDAY_CORRECTION', entityId: id, subjectUserId: c.user_id, actorId: actor.id, action: 'REJECTED', reason: note });
  return { correction: await correctionById(id) };
}

/** Puts the record back as it was before the correction. Refused if it has changed since. */
export async function reverseCorrection(actor, id, { reason }) {
  const c = await correctionById(id);
  if (!c) throw notFound('Correction not found');
  await assertMayCorrect(actor, c);
  if (!reason || String(reason).trim().length < 3) throw badRequest('Say why it is reversed');
  return withTransaction(async (client) => {
    const { rows: [claimed] } = await client.query(
      `UPDATE holiday_corrections SET status = 'REVERSED', reversed_by = $2, reversed_at = now(), reverse_reason = $3
        WHERE id = $1 AND status = 'APPLIED' RETURNING *`,
      [id, actor.id, String(reason).trim()],
    );
    if (!claimed) throw conflict('Only an applied correction can be reversed');
    const outcome = await perform(client, claimed, actor, 'reverse');
    if (outcome.stale) throw conflict(`${outcome.stale}. Change the record directly instead.`);
    await audit(client, { entityType: 'HOLIDAY_CORRECTION', entityId: id, subjectUserId: c.user_id, actorId: actor.id, action: 'REVERSED', reason, before: outcome.before, after: outcome.after });
    return { correction: await correctionById(id, client) };
  });
}

// ---------------------------------------------------------------- history

/** One calendar entry with the requests that made and ended it, and its audit trail. */
export async function entryHistory(id) {
  const [entry] = await entriesById([id]);
  if (!entry) throw notFound('Holiday not found');
  const { rows: requests } = await query(
    `SELECT r.*, p.full_name AS proposed_by_name, x.full_name AS decided_by_name FROM holiday_requests r
       LEFT JOIN users p ON p.id = r.proposed_by LEFT JOIN users x ON x.id = r.decided_by
      WHERE $1 = ANY(r.target_ids) OR $1 = ANY(r.result_ids) ORDER BY r.proposed_at`,
    [id],
  );
  const { rows: trail } = await query(
    `SELECT a.*, u.full_name AS actor_name FROM attendance_audit a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity_type = 'HOLIDAY' AND a.entity_id = $1 ORDER BY a.created_at`,
    [String(id)],
  );
  return { entry, requests, audit: trail };
}

export async function requestDetail(id, { now = new Date() } = {}) {
  const request = await requestById(id);
  if (!request) throw notFound('Request not found');
  const targets = await entriesById(request.target_ids || []);
  const results = await entriesById(request.result_ids || []);
  const impact = request.status === 'PROPOSED' ? await computeImpact(request, { now }) : request.impact;
  const corrections = await listCorrections({ requestId: id });
  const { rows: trail } = await query(
    `SELECT a.*, u.full_name AS actor_name FROM attendance_audit a LEFT JOIN users u ON u.id = a.actor_id
      WHERE (a.entity_type = 'HOLIDAY_REQUEST' AND a.entity_id = $1)
         OR (a.entity_type = 'HOLIDAY_CORRECTION' AND a.entity_id = ANY($2::text[]))
      ORDER BY a.created_at`,
    [String(id), corrections.map((c) => String(c.id))],
  );
  return { request, targets, results, impact, impact_is_live: request.status === 'PROPOSED', corrections, audit: trail };
}

/** Holiday changes still open for a month: payroll readiness lists them. */
export async function openForMonth(first, last) {
  const { rows: [counts] } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM holiday_requests r WHERE r.status = 'PROPOSED'
          AND ((r.start_date <= $2 AND r.end_date >= $1)
            OR EXISTS (SELECT 1 FROM work_holidays h WHERE h.id = ANY(r.target_ids) AND h.holiday_date BETWEEN $1 AND $2))) AS requests,
       (SELECT COUNT(*)::int FROM holiday_corrections c WHERE c.status = 'PROPOSED' AND c.work_date BETWEEN $1 AND $2) AS corrections`,
    [first, last],
  );
  return counts;
}
