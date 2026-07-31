import { config } from '../config.js';
import { query } from '../db/pool.js';
import { runBlackMarkScan } from '../services/blackmarks.js';
import { getSettings } from '../services/settings.js';

let timer = null;

/** Warns assignees about deadlines that land inside the "due soon" window. */
async function sendDueSoonReminders() {
  const settings = await getSettings();
  const days = settings.workload.dueSoonDays;

  await query(
    `INSERT INTO notifications (user_id, type, title, body, task_id)
     SELECT t.assignee_id,
            'due_soon',
            'Deadline approaching: ' || t.ref,
            t.title,
            t.id
       FROM tasks t
       JOIN workflow_statuses s ON s.id = t.status_id
      WHERE t.assignee_id IS NOT NULL
        AND t.is_archived = FALSE
        AND s.stage NOT IN ('done','cancelled')
        AND t.due_date IS NOT NULL
        AND t.due_date >= now()
        AND t.due_date < now() + ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.task_id = t.id AND n.type = 'due_soon'
             AND n.created_at > now() - interval '24 hours'
        )`,
    [days],
  );
}

export async function runScanOnce() {
  const result = await runBlackMarkScan();
  await sendDueSoonReminders();
  if (result.created.length) {
    console.log(`[taskflow] deadline scan created ${result.created.length} black mark(s)`);
  }
  return result;
}

export function startDeadlineScanner({ intervalMinutes = config.jobs.intervalMinutes } = {}) {
  if (timer) return timer;
  const runSafely = () => runScanOnce().catch((err) => console.error('[taskflow] scan failed:', err.message));

  // give the process a moment to finish booting before the first pass
  setTimeout(runSafely, 10_000).unref?.();
  timer = setInterval(runSafely, Math.max(1, intervalMinutes) * 60_000);
  timer.unref?.();
  console.log(`[taskflow] deadline scanner running every ${intervalMinutes} minute(s)`);
  return timer;
}

export function stopDeadlineScanner() {
  if (timer) clearInterval(timer);
  timer = null;
}
