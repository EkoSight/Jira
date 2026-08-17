import { config } from '../config.js';
import { query } from '../db/pool.js';
import { runBlackMarkScan } from '../services/blackmarks.js';
import { runOkrScan } from './okrScanner.js';
import { runAccountScan } from './accountScanner.js';
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

  // the OKR nudges ride the same interval; a failure here must not stop the
  // black-mark scan from having run
  try {
    const okr = await runOkrScan();
    if (okr.notified?.length) {
      console.log(`[taskflow] OKR scan reminded ${okr.notified.length} person(s)`);
    }
  } catch (err) {
    console.error('[taskflow] OKR scan failed:', err.message);
  }

  try {
    const crm = await runAccountScan();
    if (crm.notified?.length) {
      console.log(`[taskflow] CRM scan nudged ${crm.notified.length} person(s)`);
    }
  } catch (err) {
    console.error('[taskflow] CRM scan failed:', err.message);
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
