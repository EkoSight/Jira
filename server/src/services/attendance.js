/**
 * Daily attendance: Check In / Start Work and Check Out / End Work.
 *
 * Separate from signing in. Signing in, refreshing, opening a second device or
 * signing out never creates, closes or moves an attendance record. Only the two
 * explicit actions do, and both are judged by the server's clock.
 *
 * A work date is a calendar date in the policy timezone. A session belongs to
 * the date it was checked in on; a check-out after midnight (but before the
 * cutoff) completes that session rather than starting a new day.
 */

import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { clock, creditableIntervals } from '../lib/attendanceCalc.js';
import { currentPolicy, policyOn, policyTimeline } from './attendancePolicy.js';

const DAY = 86_400_000;

// ---------------------------------------------------------------- time

/** Calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function dateIn(timezone, value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value instanceof Date ? value : new Date(value));
}

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Milliseconds the timezone is ahead of UTC at an instant. */
function offsetAt(timezone, instantMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The instant (ms) at which a work date begins in the timezone. */
export function localMidnight(date, timezone) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const first = guess - offsetAt(timezone, guess);
  // a second pass settles dates where the offset changes near midnight
  return guess - offsetAt(timezone, first);
}

/** An instant as whole seconds after the start of a work date. */
export function secondsInto(date, instant, timezone) {
  if (!instant) return null;
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  return Math.floor((ms - localMidnight(date, timezone)) / 1000);
}

/** Seconds after the start of a work date, back to an instant. */
export const instantAt = (date, seconds, timezone) => new Date(localMidnight(date, timezone) + seconds * 1000);

/** When an open session for a work date becomes a missing check-out. */
export const cutoffFor = (date, config) => instantAt(addDays(date, 1), clock(config.missingCheckoutCutoff || '04:00'), config.timezone);

// ---------------------------------------------------------------- audit

export async function audit(client, entry) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO attendance_audit (entity_type, entity_id, subject_user_id, action, actor_id, reason, before, after, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.entityType, String(entry.entityId), entry.subjectUserId ?? null, entry.action, entry.actorId ?? null,
      entry.reason ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.source ?? null,
    ],
  );
}

// ---------------------------------------------------------------- who may see whom

/**
 * The people whose attendance a viewer may see: null means everyone.
 *
 * Holding a manager role does not on its own open anyone's attendance or
 * location. A manager sees the departments an admin has granted them and the
 * people who report to them; everyone sees themselves.
 */
export async function visibleUserIds(viewer) {
  if (hasPermission(viewer, 'attendance.all')) return null;
  if (!hasPermission(viewer, 'attendance.team')) return [viewer.id];
  const { rows } = await query(
    `SELECT u.id FROM users u
      WHERE u.id = $1
         OR u.department_id IN (SELECT department_id FROM attendance_team_access WHERE manager_id = $1)
         OR u.id IN (SELECT user_id FROM employee_work_profiles WHERE reporting_manager_id = $1)`,
    [viewer.id],
  );
  return rows.map((r) => r.id);
}

export async function canSee(viewer, userId) {
  if (Number(userId) === viewer.id) return true;
  const ids = await visibleUserIds(viewer);
  return ids === null || ids.includes(Number(userId));
}

/** Throws unless the viewer may act on this person's attendance as a reviewer. */
export async function assertReviewer(viewer, userId, permission) {
  if (Number(userId) === viewer.id) throw forbidden('You cannot approve your own request');
  if (!hasPermission(viewer, permission)) throw forbidden(`Requires permission: ${permission}`);
  const ids = await visibleUserIds(viewer);
  if (ids !== null && !ids.includes(Number(userId))) {
    throw forbidden('This person is not in a team you are authorised to review');
  }
}

/** Whether coordinates may be shown to this viewer for this person. */
export async function canSeeLocation(viewer, userId) {
  if (Number(userId) === viewer.id) return true;
  if (!hasPermission(viewer, 'attendance.location')) return false;
  return canSee(viewer, userId);
}

// ---------------------------------------------------------------- the calendar

export async function getProfile(userId) {
  const { rows } = await query('SELECT * FROM employee_work_profiles WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

export async function profilesFor(userIds) {
  const { rows } = await query('SELECT * FROM employee_work_profiles WHERE user_id = ANY($1::int[])', [userIds]);
  return new Map(rows.map((r) => [r.user_id, r]));
}

export async function holidaysBetween(from, to) {
  const { rows } = await query(
    `SELECT h.*, d.name AS department_name FROM work_holidays h
       LEFT JOIN departments d ON d.id = h.department_id
      WHERE holiday_date BETWEEN $1 AND $2 ORDER BY holiday_date`,
    [from, to],
  );
  return rows;
}

/**
 * One person's schedule on one date: whether it is a working day at all, and
 * its creditable hours. `ignoreEmployment` gives the full-month schedule a
 * mid-month joiner is prorated against.
 */
export function scheduleOn(date, { config, profile, holidays, departmentId, ignoreEmployment = false, ignoreStart = false }) {
  const base = { start: clock(config.officeStart), end: clock(config.officeEnd), breaks: (config.breaks || []).map((b) => ({ start: clock(b.start), end: clock(b.end), paid: Boolean(b.paid), name: b.name })) };
  if (!ignoreEmployment) {
    if (!ignoreStart && (!config.startDate || date < config.startDate)) return { ...base, state: 'BEFORE_START' };
    if (profile?.joining_date && date < profile.joining_date) return { ...base, state: 'NOT_EMPLOYED' };
    if (profile?.exit_date && date > profile.exit_date) return { ...base, state: 'NOT_EMPLOYED' };
  }
  const days = profile?.working_days?.length ? profile.working_days : config.workingDays;
  if (!days.includes(weekday(date))) return { ...base, state: 'WEEKLY_OFF' };
  const holiday = holidays.find((h) => h.holiday_date === date && (h.department_id === null || h.department_id === departmentId));
  if (holiday) return { ...base, state: 'HOLIDAY', holiday: holiday.name };
  return { ...base, state: 'WORKDAY' };
}

export const requiredSeconds = (schedule) => (schedule.state === 'WORKDAY' ? creditableIntervals(schedule).reduce((s, [a, b]) => s + b - a, 0) : 0);

// ---------------------------------------------------------------- sessions

const SESSION_COLUMNS = `
  s.id, s.user_id, s.work_date, s.status, s.regularized, s.review_flags,
  s.check_in_at, s.check_in_source, s.check_in_accuracy_m, s.check_in_location_at,
  s.check_out_at, s.check_out_source, s.check_out_accuracy_m, s.check_out_location_at,
  s.check_in_lat, s.check_in_lng, s.check_out_lat, s.check_out_lng, s.created_at, s.updated_at
`;

/** A session for the wire. Coordinates only when the viewer may see them. */
export function shapeSession(row, { withLocation }) {
  if (!row) return null;
  const out = { ...row };
  out.has_check_in_location = row.check_in_lat !== null && row.check_in_lat !== undefined;
  out.has_check_out_location = row.check_out_lat !== null && row.check_out_lat !== undefined;
  if (row.check_in_at && row.check_out_at) {
    out.recorded_seconds = Math.floor((new Date(row.check_out_at) - new Date(row.check_in_at)) / 1000);
  }
  if (!withLocation) {
    delete out.check_in_lat; delete out.check_in_lng; delete out.check_out_lat; delete out.check_out_lng;
  }
  return out;
}

/**
 * Turns open sessions whose cutoff has passed into missing check-outs. Run
 * lazily before anything reads or writes sessions, so nobody depends on a
 * background job having run. Nothing is invented: the check-out stays empty.
 */
export async function settleMissingCheckouts(userId = null, now = new Date()) {
  const policy = await currentPolicy();
  const { rows } = await query(
    `SELECT id, user_id, work_date FROM attendance_sessions WHERE status = 'OPEN' ${userId ? 'AND user_id = $1' : ''}`,
    userId ? [userId] : [],
  );
  for (const row of rows) {
    if (cutoffFor(row.work_date, policy.config) <= now) {
      const { rowCount } = await query(
        `UPDATE attendance_sessions SET status = 'MISSING_CHECKOUT', updated_at = now()
          WHERE id = $1 AND status = 'OPEN'`,
        [row.id],
      );
      if (rowCount) {
        await audit(null, {
          entityType: 'ATTENDANCE_SESSION', entityId: row.id, subjectUserId: row.user_id,
          action: 'MARKED_MISSING_CHECKOUT', source: 'SYSTEM',
          reason: 'No check-out before the cutoff; the time was not guessed',
        });
      }
    }
  }
}

export async function openSession(userId) {
  const { rows } = await query(`SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = $1 AND status = 'OPEN'`, [userId]);
  return rows[0] || null;
}

export async function sessionOn(userId, date) {
  const { rows } = await query(`SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = $1 AND work_date = $2`, [userId, date]);
  return rows[0] || null;
}

// ---------------------------------------------------------------- location

/**
 * Validates a browser location reading.
 *
 * Coordinates and accuracy must be real numbers in range. Freshness is judged
 * by `age_ms`, which the device measured against its own clock the moment the
 * reading arrived — so a phone whose clock is minutes out is not punished for
 * it. Doubtful readings (old, very imprecise, accuracy unknown) are accepted
 * and flagged for a reviewer: an attendance record with a weak indoor fix is
 * worth far more than no record at all. Nothing here invents a location.
 */
export function validateLocation(location, config, now = Date.now()) {
  if (!location || typeof location !== 'object') {
    throw badRequest('Your current location is needed to record attendance', { code: 'LOCATION_REQUIRED' });
  }
  const lat = Number(location.latitude);
  const lng = Number(location.longitude);
  const accuracy = Number(location.accuracy);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw badRequest('That latitude is not valid', { code: 'LOCATION_INVALID' });
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw badRequest('That longitude is not valid', { code: 'LOCATION_INVALID' });
  if (lat === 0 && lng === 0) throw badRequest('That location reading is empty', { code: 'LOCATION_INVALID' });
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10_000_000) {
    throw badRequest('The location reading has no usable accuracy', { code: 'LOCATION_INVALID' });
  }

  const flags = [];
  // the reading's age as the device measured it; absent or implausible means unknown
  const age = Number(location.age_ms);
  const ageKnown = Number.isFinite(age) && age >= -60_000 && age <= 24 * 3600_000;
  const maxAge = (Number(config.locationMaxAgeSeconds) || 120) * 1000;
  if (ageKnown && age > maxAge) flags.push('STALE_READING');
  if (accuracy === 0) flags.push('ACCURACY_UNKNOWN');
  else if (accuracy > (Number(config.lowAccuracyMeters) || 200)) flags.push('LOW_ACCURACY');
  // how the fix was obtained, when the device said: GPS, network (Wi-Fi/cell) or a second attempt
  if (location.method === 'NETWORK') flags.push('NETWORK_LOCATION');

  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    accuracy: Math.round(accuracy * 100) / 100,
    // when the reading was taken, on the server's clock
    at: new Date(now - (ageKnown ? Math.max(0, age) : 0)),
    flags,
  };
}

const requestIdOf = (value) => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw badRequest('Each attendance action needs a request id');
  return id;
};

// ---------------------------------------------------------------- check in / out

/**
 * Check In / Start Work. Safe to repeat: the same request id returns the
 * session it made, and a second device finds the session already open.
 */
export async function checkIn(user, { requestId, location, userAgent }, now = new Date()) {
  const id = requestIdOf(requestId);
  const { config } = await currentPolicy();

  const replay = await query(`SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = $1 AND check_in_request_id = $2`, [user.id, id]);
  if (replay.rows[0]) return { session: replay.rows[0], replayed: true };

  await settleMissingCheckouts(user.id, now);
  const open = await openSession(user.id);
  if (open) return { session: open, already: true };

  const workDate = dateIn(config.timezone, now);
  const existing = await sessionOn(user.id, workDate);
  // another device may have opened it a moment ago: that is "already checked in", not an error
  if (existing?.status === 'OPEN') return { session: existing, already: true };
  if (existing) {
    throw conflict('You have already recorded attendance today. To change it, request a correction.', { code: 'ALREADY_RECORDED', session: existing });
  }

  const loc = validateLocation(location, config, now.getTime());
  const session = await withTransaction(async (client) => {
    // ON CONFLICT covers a second device racing this one: whichever lands
    // first wins, and the other reads it back
    const { rows } = await client.query(
      `INSERT INTO attendance_sessions
         (user_id, work_date, status, check_in_at, check_in_lat, check_in_lng, check_in_accuracy_m,
          check_in_location_at, check_in_source, check_in_request_id, review_flags, check_in_user_agent)
       VALUES ($1, $2, 'OPEN', $3, $4, $5, $6, $7, 'DEVICE_LOCATION', $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [user.id, workDate, now, loc.lat, loc.lng, loc.accuracy, loc.at, id, loc.flags, (userAgent || '').slice(0, 300)],
    );
    if (!rows[0]) return null;
    await audit(client, {
      entityType: 'ATTENDANCE_SESSION', entityId: rows[0].id, subjectUserId: user.id, actorId: user.id,
      action: 'CHECK_IN', source: 'DEVICE_LOCATION', after: { at: now.toISOString(), accuracy_m: loc.accuracy, flags: loc.flags },
    });
    return rows[0].id;
  });

  if (session === null) {
    const winner = (await openSession(user.id)) || (await sessionOn(user.id, workDate));
    return { session: winner, already: true };
  }
  return { session: await sessionOn(user.id, workDate), created: true };
}

/** Check Out / End Work. Completes the open session, even after midnight. */
export async function checkOut(user, { requestId, location, userAgent }, now = new Date()) {
  const id = requestIdOf(requestId);
  const { config } = await currentPolicy();

  const replay = await query(`SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = $1 AND check_out_request_id = $2`, [user.id, id]);
  if (replay.rows[0]) return { session: replay.rows[0], replayed: true };

  await settleMissingCheckouts(user.id, now);
  const open = await openSession(user.id);
  if (!open) {
    const today = await sessionOn(user.id, dateIn(config.timezone, now));
    if (today?.status === 'COMPLETED') return { session: today, already: true };
    const { rows } = await query(
      `SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE user_id = $1 AND status = 'MISSING_CHECKOUT' ORDER BY work_date DESC LIMIT 1`,
      [user.id],
    );
    if (rows[0]) {
      throw conflict('The check-out cutoff for your last session has passed. Request a correction with the time you finished.', { code: 'MISSING_CHECKOUT', session: rows[0] });
    }
    throw conflict('You are not checked in', { code: 'NOT_CHECKED_IN' });
  }

  const loc = validateLocation(location, config, now.getTime());
  const flags = [...new Set([...(open.review_flags || []), ...loc.flags.map((f) => `${f}_OUT`)])];
  const seconds = (now - new Date(open.check_in_at)) / 1000;
  if (seconds > (Number(config.maxSessionHours) || 14) * 3600) flags.push('LONG_SESSION');

  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE attendance_sessions
          SET status = 'COMPLETED', check_out_at = $2, check_out_lat = $3, check_out_lng = $4,
              check_out_accuracy_m = $5, check_out_location_at = $6, check_out_source = 'DEVICE_LOCATION',
              check_out_request_id = $7, review_flags = $8, check_out_user_agent = $9, updated_at = now()
        WHERE id = $1 AND status = 'OPEN'`,
      [open.id, now, loc.lat, loc.lng, loc.accuracy, loc.at, id, flags, (userAgent || '').slice(0, 300)],
    );
    if (rowCount) {
      await audit(client, {
        entityType: 'ATTENDANCE_SESSION', entityId: open.id, subjectUserId: user.id, actorId: user.id,
        action: 'CHECK_OUT', source: 'DEVICE_LOCATION', after: { at: now.toISOString(), accuracy_m: loc.accuracy, flags },
      });
    }
  });
  const { rows } = await query(`SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE id = $1`, [open.id]);
  return { session: rows[0], completed: true };
}

// ---------------------------------------------------------------- the gate

let gateCache = { at: 0, policy: null };
export const resetGateCache = () => { gateCache = { at: 0, policy: null }; };

/**
 * Whether this person must check in before doing normal work right now, and
 * why. Off entirely until an admin sets the date attendance starts.
 */
export async function attendanceGate(user, now = new Date()) {
  if (!gateCache.policy || Date.now() - gateCache.at > 15_000) {
    gateCache = { at: Date.now(), policy: await currentPolicy() };
  }
  const { config } = gateCache.policy;
  const today = dateIn(config.timezone, now);
  const open = { required: false, satisfied: true, today };

  if (config.enforcement !== 'REQUIRE' || !config.startDate) return { ...open, reason: 'NOT_ENFORCED' };
  if (today < config.startDate) return { ...open, reason: 'NOT_STARTED' };

  const profile = await getProfile(user.id);
  if (profile && !profile.attendance_required) return { ...open, reason: 'NOT_REQUIRED' };
  const holidays = await holidaysBetween(today, today);
  const schedule = scheduleOn(today, { config, profile, holidays, departmentId: user.department_id });
  if (schedule.state !== 'WORKDAY') return { ...open, reason: schedule.state };

  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM attendance_sessions WHERE user_id = $1 AND (work_date = $2 OR status = 'OPEN')) AS has_session,
       EXISTS (SELECT 1 FROM leave_requests WHERE user_id = $1 AND status IN ('APPROVED_PAID', 'APPROVED_UNPAID')
                AND day_part = 'FULL' AND $2::date BETWEEN start_date AND end_date) AS on_leave`,
    [user.id, today],
  );
  if (rows[0].has_session) return { required: true, satisfied: true, today, reason: 'CHECKED_IN' };
  if (rows[0].on_leave) return { ...open, reason: 'ON_LEAVE' };
  return { required: true, satisfied: false, today, reason: 'NOT_CHECKED_IN' };
}

/**
 * Route guard for work actions. Reading stays open; writing to tasks, goals
 * and the pipeline needs today's check-in. Attendance, corrections, leave and
 * signing out are never behind it.
 */
export const requireAttendance = async (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  try {
    const gate = await attendanceGate(req.currentUser);
    if (gate.satisfied) return next();
    next(new HttpError(403, 'Check in to start work before making changes. Your attendance page is open to you.', { code: 'ATTENDANCE_REQUIRED' }));
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------- lookups

export async function userBasics(userIds) {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.avatar_color, u.department_id, u.job_title, u.is_active,
            d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE ($1::int[] IS NULL OR u.id = ANY($1::int[]))
      ORDER BY u.full_name`,
    [userIds],
  );
  return rows;
}

export async function loadPolicyTimeline() {
  const timeline = await policyTimeline();
  return { timeline, on: (date) => policyOn(timeline, date) };
}

export function assertDate(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw badRequest(`Give the ${label} as YYYY-MM-DD`);
  }
  return value;
}

export async function sessionById(id) {
  const { rows } = await query(`SELECT ${SESSION_COLUMNS} FROM attendance_sessions s WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('Attendance record not found');
  return rows[0];
}

export { SESSION_COLUMNS };
