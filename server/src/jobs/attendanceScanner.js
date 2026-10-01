/**
 * Attendance reminders, once a day each, and the missing-check-out sweep.
 *
 * A reminder is a nudge, not a record: it never checks anyone in or out. Off
 * until the policy has a start date.
 */

import { query } from '../db/pool.js';
import { clock } from '../lib/attendanceCalc.js';
import { currentPolicy } from '../services/attendancePolicy.js';
import {
  dateIn, holidaysBetween, profilesFor, scheduleOn, secondsInto, settleMissingCheckouts,
} from '../services/attendance.js';

async function remindOnce(userId, type, date, title, body) {
  // the date in the title makes "once a day" a simple lookup
  const { rows } = await query(
    `SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2 AND title LIKE $3 LIMIT 1`,
    [userId, type, `%${date}%`],
  );
  if (rows[0]) return false;
  await query(
    'INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)',
    [userId, type, title, body],
  );
  return true;
}

export async function runAttendanceScan(now = new Date()) {
  await settleMissingCheckouts(null, now);
  const { config } = await currentPolicy();
  const today = dateIn(config.timezone, now);
  if (!config.startDate || today < config.startDate) return { notified: [] };

  const seconds = secondsInto(today, now, config.timezone);
  const inAfter = clock(config.officeStart) + (config.reminders?.checkInAfterMinutes ?? 30) * 60;
  const outAfter = clock(config.officeEnd) + (config.reminders?.checkOutAfterMinutes ?? 30) * 60;
  if (seconds < inAfter) return { notified: [] };

  const { rows: users } = await query(
    `SELECT u.id, u.department_id,
            s.status AS session_status,
            EXISTS (SELECT 1 FROM leave_requests l WHERE l.user_id = u.id AND l.status IN ('APPROVED_PAID', 'APPROVED_UNPAID')
                     AND l.day_part = 'FULL' AND $1::date BETWEEN l.start_date AND l.end_date) AS on_leave
       FROM users u
       LEFT JOIN attendance_sessions s ON s.user_id = u.id AND s.work_date = $1
      WHERE u.is_active`,
    [today],
  );
  const profiles = await profilesFor(users.map((u) => u.id));
  const holidays = await holidaysBetween(today, today);
  const notified = [];

  for (const user of users) {
    const profile = profiles.get(user.id);
    if (profile && !profile.attendance_required) continue;
    const schedule = scheduleOn(today, { config, profile, holidays, departmentId: user.department_id });
    if (schedule.state !== 'WORKDAY' || user.on_leave) continue;
    if (!user.session_status) {
      if (await remindOnce(user.id, 'attendance_reminder', today, `Check in to start work — ${today}`,
        'You have not checked in yet today. If you cannot, ask for a correction from your attendance page.')) {
        notified.push(user.id);
      }
    } else if (user.session_status === 'OPEN' && seconds >= outAfter) {
      if (await remindOnce(user.id, 'attendance_checkout_reminder', today, `Still checked in — ${today}`,
        'Remember to Check Out / End Work when you finish. TaskFlow never checks you out automatically.')) {
        notified.push(user.id);
      }
    }
  }
  return { notified };
}
