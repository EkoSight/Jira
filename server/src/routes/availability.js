import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { notify } from '../services/activity.js';
import {
  AVAILABILITY_STATUSES, DAY_PARTS, STATUS_LABEL,
  addDays, checkAssignment, dateIn, findOverlap, getEntry, listAvailability, orgCalendar,
  statusOn, tasksDueDuring,
} from '../services/availability.js';

const router = Router();

/**
 * Leave and availability.
 *
 * Anyone signed in can see who is away and when — that is the point: work gets
 * planned around it. Anyone can record their own. Recording or changing it for
 * somebody else is a management act (someone rings in sick and their manager
 * puts it in), so it needs the permission to edit team members.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-14');

// how far ahead leave may be planned, and how far back it may be recorded
const MAX_AHEAD_DAYS = 400;
const MAX_BACK_DAYS = 31;
const MAX_LENGTH_DAYS = 120;

const canManageFor = (user, userId) => userId === user.id || hasPermission(user, 'user.edit');

function validateRange({ start, end, status, dayPart }, today) {
  if (end < start) throw badRequest('The last day cannot be before the first');
  if (status === 'HALF_DAY' && start !== end) throw badRequest('A half day is a single date');
  if (status === 'HALF_DAY' && !dayPart) throw badRequest('Say which half — morning or afternoon');
  if (start < addDays(today, -MAX_BACK_DAYS)) {
    throw badRequest(`Leave can be recorded up to ${MAX_BACK_DAYS} days back, not further`);
  }
  if (start > addDays(today, MAX_AHEAD_DAYS)) {
    throw badRequest('That is more than a year away — book it nearer the time');
  }
  const length = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (length > MAX_LENGTH_DAYS) {
    throw badRequest(`One entry can cover at most ${MAX_LENGTH_DAYS} days — split a longer absence`);
  }
}

// ---------------------------------------------------------------- reading

/** Everyone's entries over a window: the team calendar. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { timezone } = await orgCalendar();
    const today = dateIn(timezone);
    const from = req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
    const to = req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : addDays(from, 27);
    if (to < from) throw badRequest('The window ends before it starts');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 370) {
      throw badRequest('Ask for at most a year at a time');
    }

    const userIds = req.query.user_id ? [Number(req.query.user_id)] : null;
    let entries = await listAvailability({ from, to, userIds });
    if (req.query.department_id) {
      const dept = Number(req.query.department_id);
      entries = entries.filter((e) => e.department_id === dept);
    }
    res.json({ today, from, to, timezone, entries });
  }),
);

/** Who is away today, and who is next — the dashboard's card. */
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { timezone } = await orgCalendar();
    const today = dateIn(timezone);
    const horizon = addDays(today, Number(req.query.days) > 0 ? Math.min(Number(req.query.days), 60) : 14);
    const entries = await listAvailability({ from: today, to: horizon });
    res.json({
      today,
      horizon,
      away_today: entries.filter((e) => e.is_current),
      upcoming: entries.filter((e) => e.is_upcoming),
      mine: entries.filter((e) => e.user_id === req.currentUser.id),
    });
  }),
);

/**
 * Where everyone stands on one date — so an assignee picker can mark who is
 * away on the deadline before anyone picks them.
 */
router.get(
  '/on',
  asyncHandler(async (req, res) => {
    const { timezone } = await orgCalendar();
    let date = req.query.date;
    if (req.query.at) date = dateIn(timezone, new Date(req.query.at));
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Give a date');
    const map = await statusOn(date);
    res.json({ date, away: Object.fromEntries(map) });
  }),
);

/** The warning shown before a task is given to someone who will be away. */
router.get(
  '/check',
  asyncHandler(async (req, res) => {
    const userId = Number(req.query.user_id);
    if (!userId) throw badRequest('Say whose availability to check');
    const due = req.query.due ? new Date(req.query.due) : null;
    if (!due || Number.isNaN(due.getTime())) throw badRequest('Give the deadline to check against');
    res.json({ conflict: await checkAssignment(userId, due) });
  }),
);

// ---------------------------------------------------------------- recording

const entryInput = z.object({
  user_id: z.number().int().positive().optional(),
  status: z.enum(AVAILABILITY_STATUSES),
  start_date: isoDate,
  end_date: isoDate.optional(),
  day_part: z.enum(DAY_PARTS).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = entryInput.parse(req.body);
    const userId = data.user_id ?? req.currentUser.id;
    if (!canManageFor(req.currentUser, userId)) {
      throw forbidden('You can record your own leave; recording it for someone else needs a manager');
    }
    const { rows: people } = await query('SELECT id, full_name, is_active FROM users WHERE id = $1', [userId]);
    if (!people[0] || !people[0].is_active) throw notFound('No such team member');

    const { timezone } = await orgCalendar();
    const today = dateIn(timezone);
    const start = data.start_date;
    const end = data.status === 'HALF_DAY' ? start : (data.end_date ?? start);
    const dayPart = data.status === 'HALF_DAY' ? data.day_part ?? null : null;
    validateRange({ start, end, status: data.status, dayPart }, today);

    const clash = await findOverlap(userId, start, end);
    if (clash) {
      throw badRequest(
        `${userId === req.currentUser.id ? 'You are' : `${people[0].full_name} is`} already marked `
        + `${STATUS_LABEL[clash.status]} from ${clash.start_date} to ${clash.end_date}. `
        + 'Change or cancel that entry instead of adding a second one.',
      );
    }

    const conflicts = await tasksDueDuring(userId, start, end);

    const id = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO user_availability (user_id, status, start_date, end_date, day_part, note, created_by)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7) RETURNING id`,
        [userId, data.status, start, end, dayPart, data.note?.trim() || null, req.currentUser.id],
      );

      // a manager recording someone's leave tells that person it was recorded
      if (userId !== req.currentUser.id) {
        await notify(client, {
          userId,
          type: 'availability',
          title: `${req.currentUser.full_name} marked you ${STATUS_LABEL[data.status]}`,
          body: start === end ? start : `${start} to ${end}`,
        });
      }

      // whoever handed over work that now falls due while its owner is away
      // hears about it once, so it can be moved before it is missed
      const byReporter = new Map();
      for (const task of conflicts) {
        const to = task.reporter_id || task.created_by;
        if (!to || to === userId || to === req.currentUser.id) continue;
        byReporter.set(to, [...(byReporter.get(to) || []), task]);
      }
      for (const [reporterId, tasks] of byReporter) {
        await notify(client, {
          userId: reporterId,
          type: 'availability',
          title: `${people[0].full_name} will be ${STATUS_LABEL[data.status]} when ${tasks.length === 1 ? 'a task you assigned is' : `${tasks.length} tasks you assigned are`} due`,
          body: tasks.map((t) => `${t.ref} ${t.title}`).join(' · ').slice(0, 200),
          taskId: tasks.length === 1 ? tasks[0].id : null,
        });
      }
      return rows[0].id;
    });

    res.status(201).json({ entry: await getEntry(id), tasks_due_during: conflicts });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = entryInput.partial().omit({ user_id: true }).parse(req.body);
    const existing = await getEntry(Number(req.params.id));
    if (!existing || existing.cancelled_at) throw notFound('No such entry');
    if (!canManageFor(req.currentUser, existing.user_id)) throw forbidden('That is not yours to change');

    const { timezone } = await orgCalendar();
    const status = data.status ?? existing.status;
    const start = data.start_date ?? existing.start_date;
    let end = data.end_date ?? existing.end_date;
    if (status === 'HALF_DAY') end = start;
    const dayPart = status === 'HALF_DAY' ? (data.day_part ?? existing.day_part) : null;
    validateRange({ start, end, status, dayPart }, dateIn(timezone));

    const clash = await findOverlap(existing.user_id, start, end, existing.id);
    if (clash) {
      throw badRequest(`That overlaps another entry, ${clash.start_date} to ${clash.end_date}`);
    }

    await query(
      `UPDATE user_availability
          SET status = $1, start_date = $2::date, end_date = $3::date, day_part = $4,
              note = $5, updated_at = now()
        WHERE id = $6`,
      [status, start, end, dayPart,
        data.note === undefined ? existing.note : (data.note?.trim() || null), existing.id],
    );
    res.json({
      entry: await getEntry(existing.id),
      tasks_due_during: await tasksDueDuring(existing.user_id, start, end),
    });
  }),
);

/** Cancelling keeps the row, marked, so what was planned is not rewritten. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await getEntry(Number(req.params.id));
    if (!existing || existing.cancelled_at) throw notFound('No such entry');
    if (!canManageFor(req.currentUser, existing.user_id)) throw forbidden('That is not yours to cancel');
    await query(
      'UPDATE user_availability SET cancelled_at = now(), cancelled_by = $1, updated_at = now() WHERE id = $2',
      [req.currentUser.id, existing.id],
    );
    res.json({ ok: true });
  }),
);

export default router;
