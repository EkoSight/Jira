/**
 * Leave requests: planned, emergency and unpaid, with approval.
 *
 * Paid leave is never automatic. A request is paid only when a reviewer
 * approves it as paid, and then only up to the month's allowance — the rest of
 * the same request is approved unpaid and says so. Statutory leave sits outside
 * the allowance entirely.
 *
 * Notice is measured from when TaskFlow received the request. An employee can
 * say they told someone earlier (with an email reference); that is shown to the
 * reviewer as their claim and never used to backdate the record. TaskFlow has
 * no mail service configured, so it does not send email and never says it did.
 */

import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { effectivePermissions } from '../lib/permissions.js';
import { notify } from './activity.js';
import { currentPolicy, policyTimeline, policyOn } from './attendancePolicy.js';
import {
  addDays, audit, dateIn, getProfile, holidaysBetween, instantAt, scheduleOn, visibleUserIds,
} from './attendance.js';
import { APPROVED_LEAVE, PENDING_LEAVE, isLocked, leaveSpan, monthBounds } from './attendanceLedger.js';

export const LEAVE_CATEGORIES = ['CASUAL', 'SICK', 'UNPAID', 'STATUTORY', 'OTHER'];
export const CATEGORY_LABEL = { CASUAL: 'Casual', SICK: 'Sick', UNPAID: 'Unpaid', STATUTORY: 'Statutory', OTHER: 'Other' };

export const STATUS_LABEL = {
  DRAFT: 'Draft',
  SUBMITTED: 'Pending approval',
  EMERGENCY_REVIEW: 'Emergency — under review',
  NOTICE_EXCEPTION: 'Short notice — needs a decision',
  APPROVED_PAID: 'Approved — paid',
  APPROVED_UNPAID: 'Approved — unpaid',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

export const EMAIL_NOTE = 'TaskFlow does not send email — no mail service is configured. Tell your manager or HR directly as well.';

const MAX_BACK_DAYS = 31;
const MAX_AHEAD_DAYS = 400;

/** The scheduled working days a request covers, with how much of each. */
export async function leaveDays(userId, departmentId, start, end, dayPart) {
  const profile = await getProfile(userId);
  const timeline = await policyTimeline();
  const holidays = await holidaysBetween(start, end);
  const out = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const { config } = policyOn(timeline, date);
    const schedule = scheduleOn(date, { config, profile, holidays, departmentId, ignoreStart: true });
    if (schedule.state !== 'WORKDAY') continue;
    out.push({ date, portion: dayPart === 'FULL' ? 1 : 0.5 });
  }
  return { days: out, profile };
}

/** Which allowance a category draws on: one pool, or its own bucket. */
export function bucketOf(category, mode) {
  if (category === 'UNPAID' || category === 'STATUTORY') return null;
  if (mode === 'SPLIT') return category === 'OTHER' ? null : category;
  return 'POOL';
}

/** The paid days a bucket allows in a month — pooled or split, never both. */
export function allowanceFor(bucket, month, config, profile) {
  if (!bucket) return 0;
  const leave = config.leave || {};
  const { first } = monthBounds(month);
  if (leave.eligibility === 'JOINED_BEFORE_MONTH' && profile?.joining_date && profile.joining_date > first) return 0;
  const total = Number(leave.monthlyPaidDays ?? 2);
  return leave.allowanceMode === 'SPLIT' ? total / 2 : total;
}

/** Paid days already approved from a bucket in a month. */
export async function usedInMonth(userId, month, bucket, mode, { excludeId = null, client = null } = {}) {
  const { first, last } = monthBounds(month);
  const runner = client || { query };
  const { rows } = await runner.query(
    `SELECT id, category, day_allocation FROM leave_requests
      WHERE user_id = $1 AND status = 'APPROVED_PAID' AND end_date >= $2 AND start_date <= $3
        AND ($4::int IS NULL OR id <> $4)`,
    [userId, first, last, excludeId],
  );
  let used = 0;
  for (const row of rows) {
    if (bucketOf(row.category, mode) !== bucket) continue;
    for (const d of row.day_allocation || []) if (d.date >= first && d.date <= last) used += Number(d.paid) || 0;
  }
  return used;
}

/** A month's allowance picture for one person: used, left and pending. */
export async function balance(userId, month) {
  const { config } = await currentPolicy();
  const profile = await getProfile(userId);
  const mode = config.leave?.allowanceMode || 'POOLED';
  const buckets = mode === 'SPLIT' ? ['CASUAL', 'SICK'] : ['POOL'];
  const out = [];
  for (const bucket of buckets) {
    const allowance = allowanceFor(bucket, month, config, profile);
    const used = await usedInMonth(userId, month, bucket, mode);
    out.push({ bucket, label: bucket === 'POOL' ? 'Paid leave (casual, sick or other)' : `${CATEGORY_LABEL[bucket]} leave`, allowance, used, left: Math.max(0, allowance - used) });
  }
  return { month: monthBounds(month).first, mode, buckets: out };
}

/**
 * The day-by-day split fixed at approval. Each day draws on its own month's
 * allowance, in date order, in half-day steps.
 */
export async function allocate(request, approveAsPaid, { client } = {}) {
  const { config } = await currentPolicy();
  const mode = config.leave?.allowanceMode || 'POOLED';
  const profile = await getProfile(request.user_id);
  const { days } = await leaveDays(request.user_id, request.department_id, request.start_date, request.end_date, request.day_part);
  if (!approveAsPaid || request.category === 'UNPAID') return days.map((d) => ({ ...d, paid: 0 }));
  if (request.category === 'STATUTORY') return days.map((d) => ({ ...d, paid: d.portion }));

  const bucket = bucketOf(request.category, mode);
  const left = new Map();
  const out = [];
  for (const day of days) {
    const month = day.date.slice(0, 7);
    if (!left.has(month)) {
      const allowance = allowanceFor(bucket, day.date, config, profile);
      const used = await usedInMonth(request.user_id, day.date, bucket, mode, { excludeId: request.id, client });
      left.set(month, Math.max(0, allowance - used));
    }
    const paid = Math.min(day.portion, Math.floor(left.get(month) * 2) / 2);
    left.set(month, left.get(month) - paid);
    out.push({ ...day, paid });
  }
  return out;
}

/** Who may decide on this person's leave. */
export async function leaveReviewers(userId) {
  const { rows } = await query(
    `SELECT u.id, u.role, u.extra_permissions, u.revoked_permissions, u.department_id,
            (SELECT reporting_manager_id FROM employee_work_profiles WHERE user_id = $1) AS manager_of_subject,
            EXISTS (SELECT 1 FROM attendance_team_access a JOIN users s ON s.department_id = a.department_id
                     WHERE a.manager_id = u.id AND s.id = $1) AS has_team_access
       FROM users u WHERE u.is_active AND u.id <> $1`,
    [userId],
  );
  return rows.filter((u) => {
    const perms = effectivePermissions(u);
    if (!perms.includes('leave.approve')) return false;
    if (perms.includes('attendance.all')) return true;
    return perms.includes('attendance.team') && (u.manager_of_subject === u.id || u.has_team_access);
  }).map((u) => u.id);
}

const REQUEST_SELECT = `
  SELECT l.*, u.full_name, u.department_id, u.avatar_color, r.full_name AS reviewer_name, n.full_name AS notified_name
    FROM leave_requests l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN users r ON r.id = l.reviewer_id
    LEFT JOIN users n ON n.id = l.notified_user_id`;

export async function getRequest(id) {
  const { rows } = await query(`${REQUEST_SELECT} WHERE l.id = $1`, [id]);
  if (!rows[0]) throw notFound('Leave request not found');
  return rows[0];
}

/**
 * For the wire. A reviewer and the person see the reason; anyone else sees
 * only that leave exists.
 */
export function shapeRequest(row, { private: showPrivate }) {
  const out = {
    ...row,
    status_label: STATUS_LABEL[row.status],
    category_label: CATEGORY_LABEL[row.category],
    email_sent_by_taskflow: false,
  };
  if (!showPrivate) {
    delete out.reason; delete out.emergency_explanation; delete out.email_reference; delete out.review_note; delete out.override_reason;
  }
  return out;
}

export async function listRequests({ userIds = null, statuses = null, from = null, to = null }) {
  const { rows } = await query(
    `${REQUEST_SELECT}
      WHERE ($1::int[] IS NULL OR l.user_id = ANY($1::int[]))
        AND ($2::text[] IS NULL OR l.status = ANY($2::text[]))
        AND ($3::date IS NULL OR l.end_date >= $3)
        AND ($4::date IS NULL OR l.start_date <= $4)
      ORDER BY l.start_date DESC, l.id DESC
      LIMIT 500`,
    [userIds, statuses, from, to],
  );
  return rows;
}

function validate(input, today) {
  if (!LEAVE_CATEGORIES.includes(input.category)) throw badRequest('Choose a leave type');
  if (!input.start_date || !input.end_date) throw badRequest('Choose the dates');
  if (input.end_date < input.start_date) throw badRequest('The last day cannot be before the first');
  if (input.day_part !== 'FULL' && input.start_date !== input.end_date) throw badRequest('A half day is a single date');
  if (!String(input.reason || '').trim()) throw badRequest('Give a reason — only you and your approvers can see it');
  if (input.is_emergency && !String(input.emergency_explanation || '').trim()) {
    throw badRequest('Say what the emergency is, so the reviewer can decide without chasing you');
  }
  if (input.start_date < addDays(today, -MAX_BACK_DAYS)) throw badRequest(`Leave can be requested up to ${MAX_BACK_DAYS} days back`);
  if (input.start_date > addDays(today, MAX_AHEAD_DAYS)) throw badRequest('That is more than a year away');
  if (input.claimed_notified_at && new Date(input.claimed_notified_at) > new Date()) {
    throw badRequest('An earlier notification cannot be in the future');
  }
}

async function assertNoOverlap(userId, start, end, dayPart, exceptId = null) {
  const { rows } = await query(
    `SELECT id, start_date, end_date, day_part, status FROM leave_requests
      WHERE user_id = $1 AND status NOT IN ('DRAFT', 'REJECTED', 'CANCELLED')
        AND end_date >= $2 AND start_date <= $3 AND ($4::int IS NULL OR id <> $4)`,
    [userId, start, end, exceptId],
  );
  const clash = rows.find((r) => !(dayPart !== 'FULL' && r.day_part !== 'FULL' && r.day_part !== dayPart));
  if (clash) throw conflict(`This overlaps your leave request from ${clash.start_date} to ${clash.end_date}`, { request_id: clash.id });
}

/** When the leave begins, as an instant — what notice is measured to. */
async function leaveBeginsAt(start, dayPart) {
  const { config } = await currentPolicy();
  const span = leaveSpan(dayPart, { start: 0, end: 0, ...officeOf(config) }, config);
  return instantAt(start, span[0], config.timezone);
}
const officeOf = (config) => {
  const toSec = (t) => { const [h, m] = t.split(':').map(Number); return h * 3600 + m * 60; };
  return { start: toSec(config.officeStart), end: toSec(config.officeEnd) };
};

/** Submits (or saves as a draft) a request. Notice is fixed from server time now. */
export async function createRequest(actor, subjectUserId, input, now = new Date()) {
  const { config } = await currentPolicy();
  const today = dateIn(config.timezone, now);
  const data = { day_part: 'FULL', ...input };
  validate(data, today);
  const { rows: subject } = await query('SELECT id, department_id, full_name FROM users WHERE id = $1 AND is_active', [subjectUserId]);
  if (!subject[0]) throw notFound('Person not found');
  const { days } = await leaveDays(subjectUserId, subject[0].department_id, data.start_date, data.end_date, data.day_part);
  if (!days.length) throw badRequest('Those dates have no scheduled working days — no leave is needed');
  if (!data.draft) await assertNoOverlap(subjectUserId, data.start_date, data.end_date, data.day_part);

  const requested = days.reduce((s, d) => s + d.portion, 0);
  const id = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO leave_requests (user_id, category, start_date, end_date, day_part, reason, is_emergency,
          emergency_explanation, status, notified_user_id, email_reference, claimed_notified_at, unpaid_days, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, $10, $11, 0, $12) RETURNING id`,
      [subjectUserId, data.category, data.start_date, data.end_date, data.day_part, data.reason.trim(),
        Boolean(data.is_emergency), data.emergency_explanation?.trim() || null, data.notified_user_id || null,
        data.email_reference?.trim() || null, data.claimed_notified_at || null, actor.id],
    );
    await audit(client, {
      entityType: 'LEAVE_REQUEST', entityId: rows[0].id, subjectUserId, actorId: actor.id, action: 'CREATED',
      after: { category: data.category, start: data.start_date, end: data.end_date, day_part: data.day_part, days: requested },
    });
    return rows[0].id;
  });
  if (!data.draft) return submitRequest(actor, id, now);
  return getRequest(id);
}

export async function submitRequest(actor, id, now = new Date()) {
  const request = await getRequest(id);
  if (request.user_id !== actor.id && request.created_by !== actor.id) throw forbidden('This is not your request');
  if (request.status !== 'DRAFT') throw conflict('This request has already been submitted');
  await assertNoOverlap(request.user_id, request.start_date, request.end_date, request.day_part, request.id);
  const { config } = await currentPolicy();
  const begins = await leaveBeginsAt(request.start_date, request.day_part);
  const notice = Math.floor((begins - now) / 1000);
  const compliant = notice >= (Number(config.leave?.noticeHours) || 48) * 3600;
  const status = request.is_emergency ? 'EMERGENCY_REVIEW' : compliant ? 'SUBMITTED' : 'NOTICE_EXCEPTION';

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE leave_requests SET status = $2, submitted_at = $3, first_notified_at = $3, notice_seconds = $4,
              notice_compliant = $5, updated_at = now() WHERE id = $1`,
      [id, status, now, notice, compliant],
    );
    await audit(client, {
      entityType: 'LEAVE_REQUEST', entityId: id, subjectUserId: request.user_id, actorId: actor.id, action: 'SUBMITTED',
      after: { status, notice_seconds: notice, notice_compliant: compliant },
    });
    const reviewers = await leaveReviewers(request.user_id);
    for (const reviewerId of reviewers) {
      await notify(client, {
        userId: reviewerId,
        type: 'leave_request',
        title: `${request.full_name} asked for leave: ${request.start_date}${request.end_date !== request.start_date ? ` to ${request.end_date}` : ''}`,
        body: status === 'EMERGENCY_REVIEW' ? 'Emergency request — needs a decision' : status === 'NOTICE_EXCEPTION' ? 'Less than the required notice — needs a decision' : null,
      });
    }
  });
  return getRequest(id);
}

/** Approve (paid or unpaid) or reject. Never one's own. */
export async function decideRequest(reviewer, id, { decision, note }) {
  const request = await getRequest(id);
  if (!['APPROVED_PAID', 'APPROVED_UNPAID', 'REJECTED'].includes(decision)) throw badRequest('Choose approve as paid, approve as unpaid, or reject');
  if (!PENDING_LEAVE.includes(request.status)) throw conflict(`This request is ${STATUS_LABEL[request.status].toLowerCase()} — nothing to decide`);
  if (decision === 'REJECTED' && !String(note || '').trim()) throw badRequest('Say why it is rejected');
  const exception = request.status !== 'SUBMITTED';
  if (decision === 'APPROVED_PAID' && exception && !String(note || '').trim()) {
    throw badRequest('Paying short-notice or emergency leave needs a reason on record');
  }
  for (let d = request.start_date; d <= request.end_date; d = addDays(d, 1)) {
    if (await isLocked(request.user_id, d)) throw conflict(`Payroll for ${d.slice(0, 7)} is locked for this person — reopen it first`);
  }

  return withTransaction(async (client) => {
    let allocation = null;
    let paidDays = 0;
    let unpaidDays = 0;
    let availabilityId = null;
    if (decision !== 'REJECTED') {
      allocation = await allocate(request, decision === 'APPROVED_PAID', { client });
      paidDays = allocation.reduce((s, d) => s + d.paid, 0);
      unpaidDays = allocation.reduce((s, d) => s + d.portion - d.paid, 0);
      const half = request.day_part !== 'FULL';
      const { rows } = await client.query(
        `INSERT INTO user_availability (user_id, status, start_date, end_date, day_part, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [request.user_id, half ? 'HALF_DAY' : 'ON_LEAVE', request.start_date, request.end_date,
          half ? (request.day_part === 'FIRST_HALF' ? 'MORNING' : 'AFTERNOON') : null,
          'Approved leave', reviewer.id],
      );
      availabilityId = rows[0].id;
    }
    // paid as asked, but beyond the allowance the remainder is unpaid
    const status = decision === 'APPROVED_PAID' && paidDays === 0 ? 'APPROVED_UNPAID' : decision;
    await client.query(
      `UPDATE leave_requests SET status = $2, reviewer_id = $3, reviewed_at = now(), review_note = $4,
              override_reason = $5, day_allocation = $6, paid_days = $7, unpaid_days = $8,
              availability_id = $9, updated_at = now()
        WHERE id = $1`,
      [id, status, reviewer.id, note?.trim() || null, exception && decision !== 'REJECTED' ? note?.trim() || null : null,
        allocation ? JSON.stringify(allocation) : null, paidDays, unpaidDays, availabilityId],
    );
    await audit(client, {
      entityType: 'LEAVE_REQUEST', entityId: id, subjectUserId: request.user_id, actorId: reviewer.id,
      action: status, reason: note || null,
      before: { status: request.status }, after: { status, paid_days: paidDays, unpaid_days: unpaidDays, allocation },
    });
    const words = status === 'REJECTED' ? 'was not approved'
      : status === 'APPROVED_PAID' ? (unpaidDays > 0 ? `was approved: ${paidDays} paid, ${unpaidDays} unpaid (beyond the monthly allowance)` : 'was approved as paid leave')
        : 'was approved as unpaid leave';
    await notify(client, {
      userId: request.user_id, type: 'leave_decision',
      title: `Your leave from ${request.start_date} ${words}`,
      body: note || null,
    });
    return { id, status, paid_days: paidDays, unpaid_days: unpaidDays };
  });
}

/** Withdraw before it starts, or (as a reviewer) cancel with a reason. */
export async function cancelRequest(actor, id, { reason, asReviewer }) {
  const request = await getRequest(id);
  if (['REJECTED', 'CANCELLED'].includes(request.status)) throw conflict('This request is already closed');
  const { config } = await currentPolicy();
  const today = dateIn(config.timezone);
  if (!asReviewer) {
    if (request.user_id !== actor.id) throw forbidden('This is not your request');
    if (APPROVED_LEAVE.includes(request.status) && request.start_date <= today) {
      throw conflict('Approved leave that has started can only be changed by your approver');
    }
  } else if (!String(reason || '').trim()) {
    throw badRequest('Say why the leave is being cancelled');
  }
  if (APPROVED_LEAVE.includes(request.status)) {
    for (let d = request.start_date; d <= request.end_date; d = addDays(d, 1)) {
      if (await isLocked(request.user_id, d)) throw conflict(`Payroll for ${d.slice(0, 7)} is locked — reopen it first`);
    }
  }
  await withTransaction(async (client) => {
    await client.query(`UPDATE leave_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [id]);
    if (request.availability_id) {
      await client.query(
        'UPDATE user_availability SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1 AND cancelled_at IS NULL',
        [request.availability_id, actor.id],
      );
    }
    await audit(client, {
      entityType: 'LEAVE_REQUEST', entityId: id, subjectUserId: request.user_id, actorId: actor.id,
      action: 'CANCELLED', reason: reason || null, before: { status: request.status }, after: { status: 'CANCELLED' },
    });
    if (asReviewer) {
      await notify(client, { userId: request.user_id, type: 'leave_decision', title: `Your leave from ${request.start_date} was cancelled`, body: reason });
    }
  });
  return getRequest(id);
}

export { visibleUserIds };
