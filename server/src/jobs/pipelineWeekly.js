import { query } from '../db/pool.js';
import { hasPermission } from '../lib/permissions.js';
import { getSettings } from '../services/settings.js';
import { dateIn } from '../services/availability.js';
import { previousWeek, storeWeek, weekOf } from '../services/weekly.js';
import { runMailboxSync } from '../services/mailboxSync.js';

/**
 * The pipeline's weekly rhythm, run on the scanner's interval:
 *
 *   - after the snapshot time on the snapshot day (Monday 08:30 by default),
 *     the week just ended is written down once, and the people who run the
 *     pipeline are told it is ready;
 *   - after the reminder time on the reminder day (Friday 15:00), owners with
 *     live deals who have not sent this week's review are reminded once;
 *   - people who switched on reading their Gmail and Calendar are read hourly.
 *
 * Every notice is sent at most once, however often the scanner runs.
 */

const TZ = 'Asia/Kolkata';
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The weekday (Monday 1 … Sunday 7) and HH:MM in India. */
export function indiaClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { weekday: WEEKDAY[parts.weekday], time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

/** Sends a notice once per key — a second scan, or two scanners, cannot repeat it. */
async function notifyOnce({ key, userId, type, title, body = null, kind, accountId = null }) {
  const { rows } = await query(
    `INSERT INTO crm_nudge_events (event_key, user_id, kind) VALUES ($1, $2, $3)
     ON CONFLICT (event_key) DO NOTHING RETURNING id`,
    [key, userId, kind],
  );
  if (!rows[0]) return false;
  await query(
    `INSERT INTO notifications (user_id, type, title, body, account_id) VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, body, accountId],
  );
  return true;
}

export async function runPipelineWeekly({ now = new Date() } = {}) {
  const settings = await getSettings();
  if (settings.crm?.enabled === false) return { skipped: 'module_off' };
  const weekly = settings.crm?.weekly || {};
  const clock = indiaClock(now);
  const today = dateIn(TZ, now);
  const result = { snapshot: null, reminded: [], mailbox: null };

  const reached = (dayNumber, time) => clock.weekday > Number(dayNumber)
    || (clock.weekday === Number(dayNumber) && clock.time >= String(time));

  // ---- the week just ended, on the record
  if (reached(weekly.snapshotDay ?? 1, weekly.snapshotTime ?? '08:30')) {
    const last = previousWeek(today);
    const stored = await storeWeek(last.start);
    result.snapshot = { week_start: last.start, stored: stored.stored };
    if (stored.stored || stored.reason === 'already recorded') {
      const { rows: people } = await query(
        `SELECT id, role, extra_permissions, revoked_permissions FROM users WHERE is_active = TRUE`,
      );
      for (const person of people.filter((p) => hasPermission(p, 'crm.manage.any'))) {
        await notifyOnce({
          key: `weekly_snapshot:${last.start}:${person.id}`,
          userId: person.id,
          type: 'crm_weekly',
          kind: 'weekly_snapshot',
          title: `The pipeline week of ${last.start} is on the record`,
          body: 'Stage changes, commitments, proposals, orders, collections, what slipped and what needs a decision.',
        });
      }
    }
  }

  // ---- this week's reviews, chased once
  if (reached(weekly.reviewReminderDay ?? 5, weekly.reviewReminderTime ?? '15:00')) {
    const week = weekOf(today);
    const { rows: owners } = await query(
      `SELECT DISTINCT u.id FROM users u
         JOIN opportunities o ON (o.owner_user_id = u.id OR o.next_step_owner_id = u.id)
         JOIN accounts a ON a.id = o.account_id
        WHERE u.is_active = TRUE AND o.is_archived = FALSE AND a.is_archived = FALSE
          AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')
          AND NOT EXISTS (SELECT 1 FROM weekly_reviews r
                           WHERE r.user_id = u.id AND r.week_start = $1 AND r.status = 'SUBMITTED')`,
      [week.start],
    );
    for (const owner of owners) {
      const sent = await notifyOnce({
        key: `weekly_review:${week.start}:${owner.id}`,
        userId: owner.id,
        type: 'crm_weekly',
        kind: 'weekly_review',
        title: 'Your weekly pipeline review is due',
        body: 'For each of your deals: what changed, the evidence, the next milestone, and any help you need.',
      });
      if (sent) result.reminded.push(owner.id);
    }
  }

  // ---- correspondence, for the people who switched it on
  try {
    result.mailbox = await runMailboxSync();
  } catch (err) {
    result.mailbox = { error: err.message };
  }
  return result;
}
