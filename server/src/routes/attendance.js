import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { computeMonth, decimalHours, hhmm } from '../lib/attendanceCalc.js';
import { sendCsv } from '../lib/csv.js';
import {
  DEFAULT_POLICY, PROPOSED_KEYS, SETUP_ITEMS, currentPolicy, listPolicies, mergePolicy, setupStatus,
} from '../services/attendancePolicy.js';
import {
  addDays, assertDate, attendanceGate, audit, canSee, canSeeLocation, checkIn, checkOut, dateIn,
  getProfile, holidaysBetween, resetGateCache, scheduleOn, sessionById, sessionOn, shapeSession,
  visibleUserIds,
} from '../services/attendance.js';
import { buildLedgers, datesBetween, isLocked, monthBounds, monthLedger } from '../services/attendanceLedger.js';
import {
  CORRECTION_KINDS, cancelCorrection, createCorrection, decideCorrection, getCorrection, reviewDay, reviewExtra,
} from '../services/attendanceCorrections.js';
import { computePayroll } from '../services/attendanceLedger.js';

const router = Router();

/**
 * Daily attendance.
 *
 * Every route here is open to a person for their own record, and is never
 * behind the check-in requirement — someone who cannot check in can always
 * reach their attendance, ask for a correction, and sign out. Anything about
 * another person goes through `canSee`, which only opens the teams a manager
 * has been granted.
 */

export const PRIVACY_NOTICE = 'Task Flow records your current location when you check in and check out for attendance. It does not continuously track your location.';

const monthParam = (value, timezone) => {
  if (!value) return `${dateIn(timezone).slice(0, 7)}-01`;
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(value)) throw badRequest('Give the month as YYYY-MM');
  return `${value.slice(0, 7)}-01`;
};

const localTime = (instant, timezone) => (instant
  ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant))
  : '');

const policySummary = (config) => ({
  timezone: config.timezone,
  office_start: config.officeStart,
  office_end: config.officeEnd,
  grace_minutes: config.graceMinutes,
  working_days: config.workingDays,
  start_date: config.startDate,
  enforcement: config.enforcement,
  location_timeout_seconds: config.locationTimeoutSeconds,
  low_accuracy_meters: config.lowAccuracyMeters,
  max_age_seconds: config.locationMaxAgeSeconds,
  missing_checkout_cutoff: config.missingCheckoutCutoff,
  map_links: config.mapLinks,
  breaks: config.breaks,
  breaks_confirmed: config.breaksConfirmed,
});

// ---------------------------------------------------------------- me

router.get('/privacy', (req, res) => res.json({ notice: PRIVACY_NOTICE }));

/** Today, for the person asking: the card at the top of the dashboard. */
router.get(
  '/today',
  asyncHandler(async (req, res) => {
    const me = req.currentUser;
    const { config } = await currentPolicy();
    const gate = await attendanceGate(me);
    const today = gate.today;
    const ledgers = await buildLedgers([me.id], today, today);
    const day = ledgers.get(me.id)?.days[0] || null;
    const session = await sessionOn(me.id, today);
    // an overnight session still open from yesterday is the one to check out of
    const { rows: openRows } = await query(
      `SELECT * FROM attendance_sessions WHERE user_id = $1 AND status = 'OPEN' LIMIT 1`, [me.id],
    );
    const { rows: missing } = await query(
      `SELECT id, work_date FROM attendance_sessions s WHERE user_id = $1 AND status = 'MISSING_CHECKOUT'
          AND NOT EXISTS (SELECT 1 FROM attendance_corrections c WHERE c.user_id = s.user_id AND c.work_date = s.work_date AND c.status = 'PENDING')
        ORDER BY work_date DESC LIMIT 5`,
      [me.id],
    );
    const { rows: corrections } = await query(
      `SELECT id, work_date, kind, status, created_at FROM attendance_corrections
        WHERE user_id = $1 AND (status = 'PENDING' OR work_date = $2) ORDER BY created_at DESC LIMIT 10`,
      [me.id, today],
    );
    res.json({
      today,
      server_time: new Date().toISOString(),
      policy: policySummary(config),
      privacy_notice: PRIVACY_NOTICE,
      gate,
      session: shapeSession(session, { withLocation: true }),
      open_session: shapeSession(openRows[0] || null, { withLocation: true }),
      day,
      missing_checkouts: missing,
      corrections,
    });
  }),
);

router.post(
  '/check-in',
  asyncHandler(async (req, res) => {
    const result = await checkIn(req.currentUser, {
      requestId: req.body?.request_id,
      location: req.body?.location,
      userAgent: req.headers['user-agent'],
    });
    resetGateCache();
    res.status(result.created ? 201 : 200).json({
      ...result,
      session: shapeSession(result.session, { withLocation: true }),
      message: result.created ? 'Checked in. Have a good day.' : result.already ? 'You are already checked in.' : 'Already recorded.',
    });
  }),
);

router.post(
  '/check-out',
  asyncHandler(async (req, res) => {
    const result = await checkOut(req.currentUser, {
      requestId: req.body?.request_id,
      location: req.body?.location,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      ...result,
      session: shapeSession(result.session, { withLocation: true }),
      message: result.completed ? 'Checked out.' : 'You have already checked out.',
    });
  }),
);

/** A person's month, day by day. Their own, or someone a reviewer can see. */
async function monthFor(req, userId) {
  const { config } = await currentPolicy();
  const month = monthParam(req.query.month, config.timezone);
  const ledger = await monthLedger(userId, month);
  if (!ledger) throw notFound('Person not found');
  const { first, last } = monthBounds(month);
  const withLocation = await canSeeLocation(req.currentUser, userId);
  const { rows: sessions } = await query(
    `SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date`,
    [userId, first, last],
  );
  const { rows: corrections } = await query(
    `SELECT c.*, r.full_name AS reviewer_name FROM attendance_corrections c LEFT JOIN users r ON r.id = c.reviewer_id
      WHERE c.user_id = $1 AND c.work_date BETWEEN $2 AND $3 ORDER BY c.created_at DESC`,
    [userId, first, last],
  );
  return {
    month: first,
    user: ledger.user,
    profile: ledger.profile,
    policy: policySummary(config),
    days: ledger.days,
    totals: ledger.totals,
    day_counts: ledger.day_counts,
    allocations: ledger.allocations,
    blockers: ledger.blockers,
    final: ledger.final,
    sessions: sessions.map((s) => shapeSession(s, { withLocation })),
    corrections,
    locked: await isLocked(userId, first),
  };
}

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const data = await monthFor(req, req.currentUser.id);
    const { config } = await currentPolicy();
    // a person sees their own salary estimate only when the company has chosen to show it
    if (config.payroll?.employeesSeeOwnEstimate) {
      const payroll = await computePayroll(req.currentUser.id, data.month);
      data.salary = payroll?.salary || null;
      data.salary_status = payroll?.status;
    }
    res.json(data);
  }),
);

router.get(
  '/people/:id',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!(await canSee(req.currentUser, userId))) throw forbidden('This person is not in a team you can see');
    res.json(await monthFor(req, userId));
  }),
);

/** Coordinates for one session, with an audit entry when someone else looks. */
router.get(
  '/sessions/:id/location',
  asyncHandler(async (req, res) => {
    const session = await sessionById(Number(req.params.id));
    if (!(await canSeeLocation(req.currentUser, session.user_id))) throw forbidden('You cannot see this location');
    if (session.user_id !== req.currentUser.id) {
      await audit(null, {
        entityType: 'ATTENDANCE_SESSION', entityId: session.id, subjectUserId: session.user_id,
        actorId: req.currentUser.id, action: 'LOCATION_VIEWED',
      });
    }
    const point = (prefix) => (session[`${prefix}_lat`] === null ? null : {
      latitude: session[`${prefix}_lat`], longitude: session[`${prefix}_lng`],
      accuracy_m: session[`${prefix}_accuracy_m`], device_time: session[`${prefix}_location_at`],
      recorded_at: session[`${prefix}_at`], source: session[`${prefix}_source`],
    });
    const { config } = await currentPolicy();
    res.json({
      session_id: session.id, user_id: session.user_id, work_date: session.work_date,
      check_in: point('check_in'), check_out: point('check_out'),
      review_flags: session.review_flags, map_links: config.mapLinks,
      note: 'Device-reported location. It is not proof of where someone was, and no address lookup is made.',
    });
  }),
);

// ---------------------------------------------------------------- team

const requireTeamView = requirePermission('attendance.team', 'attendance.all');

async function visibleActive(viewer, departmentId) {
  const ids = await visibleUserIds(viewer);
  const { rows } = await query(
    `SELECT id FROM users WHERE is_active AND ($1::int[] IS NULL OR id = ANY($1::int[]))
        AND ($2::int IS NULL OR department_id = $2) ORDER BY full_name`,
    [ids, departmentId || null],
  );
  return rows.map((r) => r.id);
}

/** Who has checked in today — for the people this viewer is authorised to see. */
router.get(
  '/team/today',
  requireTeamView,
  asyncHandler(async (req, res) => {
    const { config } = await currentPolicy();
    const date = req.query.date ? assertDate(req.query.date) : dateIn(config.timezone);
    const ids = await visibleActive(req.currentUser, Number(req.query.department_id) || null);
    const ledgers = ids.length ? await buildLedgers(ids, date, date) : new Map();
    const showLocation = hasPermission(req.currentUser, 'attendance.location');
    const people = [...ledgers.values()].map(({ user, profile, days }) => ({
      user: { id: user.id, full_name: user.full_name, avatar_color: user.avatar_color, department_name: user.department_name, job_title: user.job_title },
      work_mode: profile?.work_mode || 'OFFICE',
      attendance_required: profile ? profile.attendance_required : true,
      day: days[0],
      can_view_location: showLocation && Boolean(days[0].session?.has_location),
    }));
    const count = (pred) => people.filter(pred).length;
    res.json({
      date,
      people,
      counts: {
        people: people.length,
        checked_in: count((p) => p.day.session?.status === 'OPEN'),
        checked_out: count((p) => p.day.session?.status === 'COMPLETED'),
        not_checked_in: count((p) => p.day.classification === 'NOT_CHECKED_IN' || p.day.classification === 'UNRECORDED_NEEDS_REVIEW'),
        on_leave: count((p) => ['PAID_LEAVE', 'UNPAID_LEAVE', 'PENDING_LEAVE'].includes(p.day.classification) || p.day.L > 0),
        late: count((p) => p.day.flags.includes('LATE')),
        missing_checkout: count((p) => p.day.session?.status === 'MISSING_CHECKOUT'),
        needs_review: count((p) => (p.day.session?.review_flags || []).length > 0),
        regularized: count((p) => p.day.flags.includes('MANUALLY_REGULARIZED')),
        off: count((p) => ['WEEKLY_OFF', 'HOLIDAY', 'NOT_EMPLOYED'].includes(p.day.schedule_state)),
      },
    });
  }),
);

/** Everyone's month at a glance. */
router.get(
  '/team/month',
  requireTeamView,
  asyncHandler(async (req, res) => {
    const { config } = await currentPolicy();
    const month = monthParam(req.query.month, config.timezone);
    const { first, last } = monthBounds(month);
    const ids = await visibleActive(req.currentUser, Number(req.query.department_id) || null);
    const ledgers = ids.length ? await buildLedgers(ids, first, last) : new Map();
    const people = [...ledgers.values()].map(({ user, days }) => {
      const m = computeMonth(days);
      return {
        user: { id: user.id, full_name: user.full_name, avatar_color: user.avatar_color, department_name: user.department_name },
        totals: m.totals, day_counts: m.days, blockers: m.blockers, final: m.final,
      };
    });
    res.json({ month: first, people });
  }),
);

/**
 * Day-level CSV. Coordinates only on request, and only for people whose
 * location this viewer may see. Text cells are guarded against formulas.
 */
router.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const { config } = await currentPolicy();
    const tz = config.timezone;
    const from = req.query.from ? assertDate(req.query.from, 'start date') : monthBounds(dateIn(tz)).first;
    const to = req.query.to ? assertDate(req.query.to, 'end date') : monthBounds(from).last;
    if (to < from) throw badRequest('The range ends before it starts');
    if (datesBetween(from, to).length > 93) throw badRequest('Export at most three months at a time');

    let ids;
    if (req.query.user_id) {
      const id = Number(req.query.user_id);
      if (!(await canSee(req.currentUser, id))) throw forbidden('This person is not in a team you can see');
      ids = [id];
    } else if (hasPermission(req.currentUser, 'attendance.team') || hasPermission(req.currentUser, 'attendance.all')) {
      ids = await visibleActive(req.currentUser, Number(req.query.department_id) || null);
    } else {
      ids = [req.currentUser.id];
    }
    const wantLocation = req.query.include_location === '1';
    const ledgers = ids.length ? await buildLedgers(ids, from, to) : new Map();
    const { rows: sessions } = await query(
      'SELECT * FROM attendance_sessions WHERE user_id = ANY($1::int[]) AND work_date BETWEEN $2 AND $3',
      [ids, from, to],
    );
    const sessionBy = new Map(sessions.map((s) => [`${s.user_id}|${s.work_date}`, s]));

    const header = [
      'Date', 'Employee', 'Email', 'Department', 'Day', 'Status', 'Check in', 'Check out', 'Check-in source', 'Check-out source',
      'Recorded attendance duration (HH:MM)', 'Recorded attendance duration (hours)', 'Within office hours (HH:MM)',
      'Paid leave (HH:MM)', 'Grace credit (HH:MM)', 'Late by (HH:MM)', 'Left early by (HH:MM)', 'Extra after hours (HH:MM)', 'Flags',
    ];
    if (wantLocation) header.push('Check-in latitude', 'Check-in longitude', 'Check-in accuracy (m)', 'Check-out latitude', 'Check-out longitude', 'Check-out accuracy (m)');
    const rows = [];
    for (const { user, days } of ledgers.values()) {
      const locationOk = wantLocation && (await canSeeLocation(req.currentUser, user.id));
      for (const d of days) {
        const s = sessionBy.get(`${user.id}|${d.date}`);
        const row = [
          d.date, user.full_name, user.email, user.department_name || '', d.schedule_state, d.classification,
          localTime(s?.check_in_at, tz), localTime(s?.check_out_at, tz), s?.check_in_source || '', s?.check_out_source || '',
          d.duration ? hhmm(d.duration) : '', d.duration ? decimalHours(d.duration) : '', hhmm(d.C), hhmm(d.L), hhmm(d.G),
          hhmm(d.late_seconds), hhmm(d.early_departure), hhmm(d.E_recorded), [...d.flags, ...(s?.review_flags || [])].join(' '),
        ];
        if (wantLocation) {
          row.push(...(locationOk && s
            ? [s.check_in_lat, s.check_in_lng, s.check_in_accuracy_m, s.check_out_lat, s.check_out_lng, s.check_out_accuracy_m]
            : ['', '', '', '', '', '']));
        }
        rows.push(row);
      }
    }
    await audit(null, {
      entityType: 'ATTENDANCE_EXPORT', entityId: `${from}:${to}`, actorId: req.currentUser.id, action: 'EXPORTED',
      after: { users: ids.length, include_location: wantLocation },
    });
    sendCsv(res, `attendance-${from}-to-${to}.csv`, header, rows);
  }),
);

// ---------------------------------------------------------------- corrections

router.get(
  '/corrections',
  asyncHandler(async (req, res) => {
    const scope = req.query.scope === 'team' ? 'team' : 'mine';
    let ids = [req.currentUser.id];
    if (scope === 'team') {
      if (!hasPermission(req.currentUser, 'attendance.approve')) throw forbidden('Requires permission: attendance.approve');
      ids = (await visibleUserIds(req.currentUser));
    }
    const status = req.query.status && req.query.status !== 'ALL' ? req.query.status : null;
    const { rows } = await query(
      `SELECT c.*, u.full_name, u.avatar_color, r.full_name AS reviewer_name
         FROM attendance_corrections c JOIN users u ON u.id = c.user_id LEFT JOIN users r ON r.id = c.reviewer_id
        WHERE ($1::int[] IS NULL OR c.user_id = ANY($1::int[]))
          AND ($2::text IS NULL OR c.status = $2)
          AND ($3 = 'mine' OR c.user_id <> $4)
        ORDER BY (c.status = 'PENDING') DESC, c.created_at DESC LIMIT 300`,
      [ids, status, scope, req.currentUser.id],
    );
    res.json({ corrections: rows, kinds: CORRECTION_KINDS });
  }),
);

router.post(
  '/corrections',
  asyncHandler(async (req, res) => {
    const body = z.object({
      work_date: z.string(),
      kind: z.string(),
      check_in: z.string().optional().nullable(),
      check_out: z.string().optional().nullable(),
      check_out_next_day: z.boolean().optional(),
      reason: z.string().max(2000),
    }).parse(req.body);
    assertDate(body.work_date, 'work date');
    res.status(201).json({ correction: await createCorrection(req.currentUser, body) });
  }),
);

router.post(
  '/corrections/:id/decide',
  asyncHandler(async (req, res) => {
    const body = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(2000).optional().nullable() }).parse(req.body);
    const result = await decideCorrection(req.currentUser, Number(req.params.id), body);
    resetGateCache();
    res.json(result);
  }),
);

router.post(
  '/corrections/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json({ correction: await cancelCorrection(req.currentUser, Number(req.params.id)) });
  }),
);

router.get(
  '/corrections/:id',
  asyncHandler(async (req, res) => {
    const correction = await getCorrection(Number(req.params.id));
    if (!(await canSee(req.currentUser, correction.user_id))) throw forbidden('You cannot see this request');
    res.json({ correction });
  }),
);

// ---------------------------------------------------------------- reviews

router.post(
  '/reviews/day',
  asyncHandler(async (req, res) => {
    const body = z.object({
      user_id: z.number().int(), work_date: z.string(),
      decision: z.enum(['UNAPPROVED_ABSENCE', 'CLEAR']), note: z.string().max(2000).optional().nullable(),
    }).parse(req.body);
    assertDate(body.work_date, 'work date');
    await reviewDay(req.currentUser, body);
    res.json({ ok: true });
  }),
);

const extraItem = z.object({
  user_id: z.number().int(), work_date: z.string(),
  status: z.enum(['ELIGIBLE', 'REJECTED']),
  eligible_seconds: z.number().int().min(0).optional().nullable(),
  reason: z.string().max(2000).optional().nullable(),
});

/** One day's extra time, or several at once ({ items: [...] }). */
router.post(
  '/reviews/extra',
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? z.array(extraItem).max(200).parse(req.body.items) : [extraItem.parse(req.body)];
    const results = [];
    for (const item of items) {
      assertDate(item.work_date, 'work date');
      try {
        await reviewExtra(req.currentUser, item);
        results.push({ ...item, ok: true });
      } catch (err) {
        if (items.length === 1) throw err;
        results.push({ ...item, ok: false, error: err.message });
      }
    }
    res.json({ results });
  }),
);

/** Days that need a reviewer: extra time waiting, unrecorded days, missing check-outs. */
router.get(
  '/review-queue',
  requirePermission('attendance.approve', 'attendance.extra.review'),
  asyncHandler(async (req, res) => {
    const { config } = await currentPolicy();
    const month = monthParam(req.query.month, config.timezone);
    const { first, last } = monthBounds(month);
    const ids = (await visibleActive(req.currentUser, null)).filter((id) => id !== req.currentUser.id);
    const ledgers = ids.length ? await buildLedgers(ids, first, last) : new Map();
    const items = [];
    for (const { user, days } of ledgers.values()) {
      for (const d of days) {
        for (const blocker of d.blockers) {
          items.push({
            user: { id: user.id, full_name: user.full_name, avatar_color: user.avatar_color },
            date: d.date, kind: blocker, extra_seconds: d.E_recorded, classification: d.classification,
            session_id: d.session?.id || null, check_in_at: d.session?.check_in_at || null, check_out_at: d.session?.check_out_at || null,
            long_session: d.flags.includes('LONG_SESSION'),
          });
        }
      }
    }
    res.json({ month: first, items });
  }),
);

// ---------------------------------------------------------------- policy & setup

const hhmmString = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');
const policyInput = z.object({
  timezone: z.string().min(1).max(64),
  officeStart: hhmmString,
  officeEnd: hhmmString,
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  graceMinutes: z.number().int().min(0).max(120),
  graceMode: z.enum(['THRESHOLD', 'FORGIVE_FIRST', 'NONE']),
  creditBeforeStart: z.boolean(),
  extraRequiresReview: z.boolean(),
  offsetWindow: z.enum(['SAME_MONTH']),
  breaks: z.array(z.object({ name: z.string().min(1).max(60), start: hhmmString, end: hhmmString, paid: z.boolean() })).max(5),
  breaksConfirmed: z.boolean(),
  maxSessionHours: z.number().min(4).max(24),
  missingCheckoutCutoff: hhmmString,
  lowAccuracyMeters: z.number().min(10).max(100_000),
  locationTimeoutSeconds: z.number().int().min(5).max(120),
  locationMaxAgeSeconds: z.number().int().min(10).max(3600),
  halfDaySplit: hhmmString,
  enforcement: z.enum(['REQUIRE', 'OFF']),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  reminders: z.object({ checkInAfterMinutes: z.number().int().min(0).max(600), checkOutAfterMinutes: z.number().int().min(0).max(600) }).partial(),
  mapLinks: z.enum(['GOOGLE', 'NONE']),
  retentionMonths: z.number().int().min(1).max(240).nullable(),
  leave: z.object({
    monthlyPaidDays: z.number().min(0).max(10),
    allowanceMode: z.enum(['POOLED', 'SPLIT']),
    eligibility: z.enum(['JOINED_BEFORE_MONTH', 'IMMEDIATE']),
    noticeHours: z.number().int().min(0).max(720),
    noticeMode: z.enum(['ELAPSED_HOURS']),
  }).partial(),
  payroll: z.object({
    method: z.enum(['SCHEDULED_HOURS']),
    methodConfirmed: z.boolean(),
    currency: z.string().length(3),
    employeesSeeOwnEstimate: z.boolean(),
  }).partial(),
}).partial();

function checkConfig(config) {
  if (config.officeEnd <= config.officeStart) throw badRequest('Office hours must end after they start');
  for (const b of config.breaks || []) {
    if (b.end <= b.start || b.start < config.officeStart || b.end > config.officeEnd) {
      throw badRequest(`The break "${b.name}" must sit inside office hours`);
    }
  }
  try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }); } catch { throw badRequest('Unknown timezone'); }
}

/** The month after which policy may still change: nothing at or before a closed month. */
async function lastClosedMonth() {
  const { rows } = await query(`SELECT MAX(month) AS month FROM payroll_results WHERE status IN ('APPROVED', 'LOCKED')`);
  return rows[0].month;
}

router.get(
  '/policy',
  asyncHandler(async (req, res) => {
    const versions = await listPolicies();
    const canManage = hasPermission(req.currentUser, 'attendance.policy');
    const { rows: used } = await query(
      `SELECT DISTINCT policy_id FROM payroll_results WHERE status IN ('APPROVED', 'LOCKED') AND policy_id IS NOT NULL`,
    );
    const usedIds = new Set(used.map((r) => r.policy_id));
    res.json({
      versions: versions.map((v) => ({
        ...v,
        setup: setupStatus(v),
        in_use_by_closed_payroll: usedIds.has(v.id),
        ...(canManage ? {} : { config: { ...v.config, payroll: undefined } }),
      })),
      defaults: DEFAULT_POLICY,
      proposed_keys: PROPOSED_KEYS,
      setup_items: SETUP_ITEMS,
      last_closed_month: await lastClosedMonth(),
      privacy_notice: PRIVACY_NOTICE,
    });
  }),
);

/** A new version from a date. Past closed months keep the version they used. */
router.post(
  '/policy',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const effectiveFrom = assertDate(req.body?.effective_from, 'effective date');
    const changes = policyInput.parse(req.body?.config || {});
    const closed = await lastClosedMonth();
    if (closed && effectiveFrom <= monthBounds(closed).last) {
      throw conflict(`Payroll is closed up to ${closed.slice(0, 7)}. A new version must start after that month.`);
    }
    const base = (await currentPolicy()).config;
    const config = mergePolicy(base, changes);
    checkConfig(config);
    const { rows } = await query(
      `INSERT INTO attendance_policies (effective_from, config, note, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [effectiveFrom, JSON.stringify(config), req.body?.note?.trim() || null, req.currentUser.id],
    );
    await audit(null, {
      entityType: 'POLICY', entityId: rows[0].id, actorId: req.currentUser.id, action: 'VERSION_CREATED',
      reason: req.body?.note || null, after: { effective_from: effectiveFrom, config },
    });
    resetGateCache();
    res.status(201).json({ id: rows[0].id });
  }),
);

/** Edit a version no closed month has used. Any edit clears its acceptance. */
router.patch(
  '/policy/:id',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const versions = await listPolicies();
    const version = versions.find((v) => v.id === id);
    if (!version) throw notFound('Policy version not found');
    const { rows: used } = await query(
      `SELECT 1 FROM payroll_results WHERE policy_id = $1 AND status IN ('APPROVED', 'LOCKED') LIMIT 1`, [id],
    );
    if (used[0]) throw conflict('A closed payroll month used this version. Add a new version instead of editing it.');
    const changes = policyInput.parse(req.body?.config || {});
    const config = mergePolicy(version.config, changes);
    checkConfig(config);
    await query(
      `UPDATE attendance_policies SET config = $2, accepted_by = NULL, accepted_at = NULL WHERE id = $1`,
      [id, JSON.stringify(config)],
    );
    await audit(null, {
      entityType: 'POLICY', entityId: id, actorId: req.currentUser.id, action: 'EDITED',
      before: version.config, after: config, reason: req.body?.note || null,
    });
    resetGateCache();
    res.json({ ok: true, acceptance_cleared: Boolean(version.accepted_at) });
  }),
);

/** An administrator accepts a version, proposed defaults included. */
router.post(
  '/policy/:id/accept',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { rowCount } = await query(
      `UPDATE attendance_policies SET accepted_by = $2, accepted_at = now() WHERE id = $1 AND accepted_at IS NULL`,
      [id, req.currentUser.id],
    );
    if (!rowCount) throw conflict('That version is already accepted, or does not exist');
    await audit(null, { entityType: 'POLICY', entityId: id, actorId: req.currentUser.id, action: 'ACCEPTED' });
    res.json({ ok: true });
  }),
);

// holidays

router.get(
  '/holidays',
  asyncHandler(async (req, res) => {
    const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : new Date().getFullYear();
    res.json({ holidays: await holidaysBetween(`${year}-01-01`, `${year}-12-31`) });
  }),
);

router.post(
  '/holidays',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const body = z.object({ holiday_date: z.string(), name: z.string().trim().min(1).max(120), department_id: z.number().int().nullable().optional() }).parse(req.body);
    assertDate(body.holiday_date, 'holiday date');
    const closed = await lastClosedMonth();
    if (closed && body.holiday_date <= monthBounds(closed).last) throw conflict('Payroll for that month is closed');
    const { rows } = await query(
      `INSERT INTO work_holidays (holiday_date, name, department_id, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.holiday_date, body.name, body.department_id ?? null, req.currentUser.id],
    );
    await audit(null, { entityType: 'HOLIDAY', entityId: rows[0].id, actorId: req.currentUser.id, action: 'CREATED', after: rows[0] });
    resetGateCache();
    res.status(201).json({ holiday: rows[0] });
  }),
);

router.delete(
  '/holidays/:id',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM work_holidays WHERE id = $1', [Number(req.params.id)]);
    if (!rows[0]) throw notFound('Holiday not found');
    const closed = await lastClosedMonth();
    if (closed && rows[0].holiday_date <= monthBounds(closed).last) throw conflict('Payroll for that month is closed');
    await query('DELETE FROM work_holidays WHERE id = $1', [rows[0].id]);
    await audit(null, { entityType: 'HOLIDAY', entityId: rows[0].id, actorId: req.currentUser.id, action: 'REMOVED', before: rows[0] });
    resetGateCache();
    res.json({ ok: true });
  }),
);

// employee schedules

router.get(
  '/profiles',
  requirePermission('attendance.policy', 'attendance.all', 'payroll.view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id AS user_id, u.full_name, u.email, u.role, u.avatar_color, u.department_id, d.name AS department_name, u.is_active,
              p.joining_date, p.exit_date, p.working_days, COALESCE(p.attendance_required, TRUE) AS attendance_required,
              COALESCE(p.work_mode, 'OFFICE') AS work_mode, p.reporting_manager_id, m.full_name AS reporting_manager_name,
              p.updated_at, (p.user_id IS NOT NULL) AS has_profile
         FROM users u LEFT JOIN employee_work_profiles p ON p.user_id = u.id
         LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN users m ON m.id = p.reporting_manager_id
        WHERE u.is_active OR p.user_id IS NOT NULL
        ORDER BY u.full_name`,
    );
    res.json({ profiles: rows });
  }),
);

router.put(
  '/profiles/:userId',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    const body = z.object({
      joining_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      exit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      working_days: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
      attendance_required: z.boolean().optional(),
      work_mode: z.enum(['OFFICE', 'REMOTE', 'FIELD', 'HYBRID']).optional(),
      reporting_manager_id: z.number().int().nullable().optional(),
    }).parse(req.body);
    if (body.reporting_manager_id === userId) throw badRequest('Nobody reports to themselves');
    const before = await getProfile(userId);
    const next = { ...(before || {}), ...body };
    if (next.joining_date && next.exit_date && next.exit_date < next.joining_date) throw badRequest('The exit date is before the joining date');
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO employee_work_profiles (user_id, joining_date, exit_date, working_days, attendance_required, work_mode, reporting_manager_id, updated_by)
         VALUES ($1, $2, $3, $4, COALESCE($5, TRUE), COALESCE($6, 'OFFICE'), $7, $8)
         ON CONFLICT (user_id) DO UPDATE SET joining_date = EXCLUDED.joining_date, exit_date = EXCLUDED.exit_date,
           working_days = EXCLUDED.working_days, attendance_required = EXCLUDED.attendance_required,
           work_mode = EXCLUDED.work_mode, reporting_manager_id = EXCLUDED.reporting_manager_id,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [userId, next.joining_date || null, next.exit_date || null, next.working_days?.length ? next.working_days : null,
          next.attendance_required ?? true, next.work_mode || 'OFFICE', next.reporting_manager_id ?? null, req.currentUser.id],
      );
      await audit(client, {
        entityType: 'WORK_PROFILE', entityId: userId, subjectUserId: userId, actorId: req.currentUser.id,
        action: before ? 'UPDATED' : 'CREATED', before, after: body,
      });
    });
    resetGateCache();
    res.json({ profile: await getProfile(userId) });
  }),
);

// which departments each manager may see

router.get(
  '/team-access',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.manager_id, a.department_id, d.name AS department_name, u.full_name AS manager_name
         FROM attendance_team_access a JOIN departments d ON d.id = a.department_id JOIN users u ON u.id = a.manager_id
        ORDER BY u.full_name, d.name`,
    );
    res.json({ access: rows });
  }),
);

router.put(
  '/team-access/:managerId',
  requirePermission('attendance.policy'),
  asyncHandler(async (req, res) => {
    const managerId = Number(req.params.managerId);
    const departmentIds = z.array(z.number().int()).max(100).parse(req.body?.department_ids || []);
    const { rows: before } = await query('SELECT department_id FROM attendance_team_access WHERE manager_id = $1', [managerId]);
    await withTransaction(async (client) => {
      await client.query(
        'DELETE FROM attendance_team_access WHERE manager_id = $1 AND NOT (department_id = ANY($2::int[]))',
        [managerId, departmentIds],
      );
      for (const departmentId of departmentIds) {
        await client.query(
          `INSERT INTO attendance_team_access (manager_id, department_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [managerId, departmentId, req.currentUser.id],
        );
      }
      await audit(client, {
        entityType: 'TEAM_ACCESS', entityId: managerId, subjectUserId: managerId, actorId: req.currentUser.id,
        action: 'SET', before: before.map((r) => r.department_id), after: departmentIds,
      });
    });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- audit

router.get(
  '/audit',
  requirePermission('attendance.all', 'payroll.view', 'attendance.policy'),
  asyncHandler(async (req, res) => {
    const userId = req.query.user_id ? Number(req.query.user_id) : null;
    const { rows } = await query(
      `SELECT a.*, u.full_name AS actor_name, s.full_name AS subject_name
         FROM attendance_audit a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN users s ON s.id = a.subject_user_id
        WHERE ($1::int IS NULL OR a.subject_user_id = $1)
          AND ($2::text IS NULL OR a.entity_type = $2)
        ORDER BY a.created_at DESC, a.id DESC LIMIT 300`,
      [userId, req.query.entity_type || null],
    );
    res.json({ entries: rows });
  }),
);

// a schedule preview for a date range, for the calendar in Settings
router.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    const { config } = await currentPolicy();
    const from = req.query.from ? assertDate(req.query.from) : monthBounds(dateIn(config.timezone)).first;
    const to = req.query.to ? assertDate(req.query.to) : addDays(from, 41);
    if (datesBetween(from, to).length > 93) throw badRequest('At most three months at a time');
    const profile = await getProfile(req.currentUser.id);
    const holidays = await holidaysBetween(from, to);
    res.json({
      days: datesBetween(from, to).map((date) => {
        const s = scheduleOn(date, { config, profile, holidays, departmentId: req.currentUser.department_id, ignoreStart: true });
        return { date, state: s.state, holiday: s.holiday || null };
      }),
    });
  }),
);

export default router;
