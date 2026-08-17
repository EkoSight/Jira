import { query } from '../db/pool.js';
import { getSettings } from '../services/settings.js';
import { analyse, SEVERITY_RANK } from '../services/okrInsights.js';

/**
 * Turns the attention signals into reminders.
 *
 * One digest per person rather than a ping per problem — the accountable owner
 * gets a single "here is what needs you" nudge, at most once inside the cooldown,
 * however often the scanner runs. Managers get the dashboard; owners get the tap
 * on the shoulder.
 */

const DIGEST_TYPE = 'okr_digest';

/** Groups the owner-facing signals by the person accountable for them. */
function groupByOwner(signals) {
  const byOwner = new Map();
  for (const signal of signals) {
    if (!signal.owner_user_id) continue; // department signals have no single owner
    const bucket = byOwner.get(signal.owner_user_id) || [];
    bucket.push(signal);
    byOwner.set(signal.owner_user_id, bucket);
  }
  return byOwner;
}

/** The one line a reminder leads with, and the goal it should open. */
function digestFor(signals) {
  const ordered = [...signals].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const top = ordered.slice(0, 3);
  const body = top
    .map((s) => (s.entity_type === 'OBJECTIVE' ? `“${s.title}” ${s.detail}` : `“${s.title}” ${s.detail}`))
    .join(' · ');
  const primary = ordered.find((s) => s.objective_id) || ordered[0];
  const n = signals.length;
  const title = n === 1 ? 'A goal needs your attention' : `${n} things on your goals need attention`;
  return { title, body, objectiveId: primary?.objective_id ?? null };
}

export async function runOkrScan({ force = false } = {}) {
  const settings = await getSettings();
  if (settings.okr?.enabled === false) return { skipped: 'module_off', notified: [] };
  const attention = settings.okr?.attention || {};
  if (attention.enabled === false) return { skipped: 'attention_off', notified: [] };

  const { attention: signals, by_department: byDepartment } = await analyse({});
  const cooldownHours = Number(attention.reminderHours) || 24;

  const byOwner = groupByOwner(signals);
  const notified = [];

  for (const [userId, ownerSignals] of byOwner) {
    // one reminder per person per cooldown window, unless a manual run forces it
    if (!force) {
      const { rows } = await query(
        `SELECT 1 FROM notifications
          WHERE user_id = $1 AND type = $2 AND created_at > now() - ($3 || ' hours')::interval
          LIMIT 1`,
        [userId, DIGEST_TYPE, cooldownHours],
      );
      if (rows.length) continue;
    }

    const { title, body, objectiveId } = digestFor(ownerSignals);
    await query(
      `INSERT INTO notifications (user_id, type, title, body, objective_id) VALUES ($1, $2, $3, $4, $5)`,
      [userId, DIGEST_TYPE, title, body, objectiveId],
    );
    notified.push(userId);
  }

  // optional: copy department managers on their department going quiet or red
  if (attention.notifyManagers) {
    for (const department of byDepartment) {
      if (!department.is_idle && department.off_track === 0) continue;
      const { rows: managers } = await query(
        `SELECT id FROM users WHERE role = 'manager' AND department_id = $1 AND is_active = TRUE`,
        [department.department_id],
      );
      for (const manager of managers) {
        if (!force) {
          const { rows } = await query(
            `SELECT 1 FROM notifications
              WHERE user_id = $1 AND type = $2 AND created_at > now() - ($3 || ' hours')::interval
              LIMIT 1`,
            [manager.id, 'okr_department', cooldownHours],
          );
          if (rows.length) continue;
        }
        const reason = department.is_idle
          ? `has had no check-ins for ${department.idle_days ?? 'a while'} days`
          : `has ${department.off_track} goal(s) off track`;
        await query(
          `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`,
          [manager.id, 'okr_department', `${department.name} needs a look`, `Your department ${reason}.`],
        );
        notified.push(manager.id);
      }
    }
  }

  return { notified, signals: signals.length };
}
