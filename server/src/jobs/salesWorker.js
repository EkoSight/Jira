/**
 * The sales CRM's background work, every half minute by default:
 *   turn new events into scheduled automation runs, run the ones that are
 *   due, apply running imports a batch at a time, and (every five minutes)
 *   the clock: reminders, overdue and stale escalations, deadlines, payments,
 *   renewals, quotation expiry and recording retention.
 * One step failing never stops the others. Several servers can run it: every
 * step takes its rows with SKIP LOCKED or a unique key.
 */
import { config } from '../config.js';
import { getSettings } from '../services/settings.js';
import { processEvents, runDue, scanTimers } from '../services/sales/automation.js';
import { processImports } from '../services/sales/imports.js';

const TIMERS_EVERY_MS = 5 * 60 * 1000;

let timer = null;
let running = false;
let lastTimers = 0;

async function step(name, fn, out) {
  try {
    out[name] = await fn();
  } catch (err) {
    out[name] = { error: err.message };
    console.error(`[taskflow] sales CRM: ${name} failed:`, err.message);
  }
}

/** One pass. `force` runs the clock now as well. */
export async function runSalesTick({ force = false, now = new Date() } = {}) {
  const settings = await getSettings();
  if (settings.crm?.enabled === false) return { skipped: 'The CRM is switched off' };
  const out = {};
  await step('events', () => processEvents(), out);
  await step('runs', () => runDue(), out);
  await step('imports', () => processImports(), out);
  if (force || Date.now() - lastTimers > TIMERS_EVERY_MS) {
    lastTimers = Date.now();
    await step('timers', () => scanTimers(now), out);
  }
  return out;
}

export function startSalesWorker() {
  if (timer || !config.sales.workerEnabled) return null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSalesTick();
    } catch (err) {
      console.error('[taskflow] sales CRM worker failed:', err.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, Math.max(10, config.sales.workerIntervalSeconds) * 1000);
  timer.unref?.();
  console.log(`[taskflow] sales CRM worker running every ${config.sales.workerIntervalSeconds}s`);
  return timer;
}

export function stopSalesWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
