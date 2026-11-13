/**
 * Task reminders, every minute: send what is due, tell the fallback person
 * about Chat messages that could not be delivered, re-plan near deadlines
 * every ten minutes, send the weekly backlog review on the first working day
 * of the week, and store the coverage check once the morning messages have
 * had time to go. One step failing never stops the others; several servers
 * can run it (rows are claimed with SKIP LOCKED or unique keys).
 */
import { query } from '../db/pool.js';
import { followUpFailedChats, hhmm, reminderSettings, replanSweep, sendDueTaskReminders } from '../services/taskReminders.js';
import { queueBacklogReviews } from '../services/taskSummaries.js';
import { coverageReport } from '../services/coverage.js';
import { deadlineClock } from '../services/deadlines.js';

const SWEEP_EVERY_MS = 10 * 60 * 1000;
let timer = null;
let running = false;
let lastSweep = 0;

async function step(name, fn, out) {
  try {
    out[name] = await fn();
  } catch (err) {
    out[name] = { error: err.message };
    console.error(`[taskflow] reminders: ${name} failed:`, err.message);
  }
}

export async function runReminderTick({ now = new Date(), force = false } = {}) {
  const out = {};
  const s = await reminderSettings();
  if (force || Date.now() - lastSweep > SWEEP_EVERY_MS) {
    lastSweep = Date.now();
    await step('planned', () => replanSweep({ now }), out);
  }
  await step('sent', () => sendDueTaskReminders(now), out);
  await step('fallbacks', () => followUpFailedChats(now), out);
  await step('backlog', () => queueBacklogReviews(now), out);
  const c = await deadlineClock(now);
  if (hhmm(now, c.timezone) >= s.coverageTime) {
    const { rows } = await query('SELECT 1 FROM coverage_reports WHERE report_date = $1', [c.today]);
    if (!rows.length || force) await step('coverage', () => coverageReport({ now, store: true }), out);
  }
  return out;
}

export function startReminderWorker({ intervalSeconds = 60 } = {}) {
  if (timer) return timer;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await runReminderTick();
      const sent = out.sent?.sent || 0;
      if (sent || out.sent?.covered) console.log(`[taskflow] reminders: sent ${sent}, fallback told ${out.sent?.covered || 0}`);
    } catch (err) {
      console.error('[taskflow] reminder worker failed:', err.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalSeconds * 1000);
  timer.unref?.();
  console.log('[taskflow] task reminder worker running');
  return timer;
}

export function stopReminderWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
