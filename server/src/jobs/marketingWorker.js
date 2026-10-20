/**
 * Email marketing's background work, every few seconds:
 *   keep the CRM's people in their audiences (hourly, when switched on),
 *   read TaskFlow's own changes and contact activity into automations,
 *   start festival and date automations, move people along their paths,
 *   start scheduled campaigns and decide A/B tests,
 *   hand due emails to the provider (within the per-minute rate),
 *   read the reply mailbox (every five minutes, when connected).
 * One step failing never stops the others.
 */
import { config } from '../config.js';
import { marketingSettings } from '../services/marketing/core.js';
import { pollTaskflowEvents, syncFromCrm } from '../services/marketing/crmSync.js';
import { advanceDue, processActivity, runDateTriggers } from '../services/marketing/automations.js';
import { runCampaignSchedule } from '../services/marketing/campaigns.js';
import { processQueue } from '../services/marketing/queue.js';
import { syncReplies } from '../services/marketing/replies.js';

const CRM_EVERY_MS = 60 * 60 * 1000;
const REPLIES_EVERY_MS = 5 * 60 * 1000;
const DATES_EVERY_MS = 10 * 60 * 1000;

let timer = null;
let running = false;
const last = { crm: 0, replies: 0, dates: 0 };

async function step(name, fn, out) {
  try {
    out[name] = await fn();
  } catch (err) {
    out[name] = { error: err.message };
    console.error(`[taskflow] email marketing: ${name} failed:`, err.message);
  }
}

/** One pass. `force` runs the hourly and five-minute steps now as well. */
export async function runMarketingTick({ force = false } = {}) {
  const settings = await marketingSettings();
  const out = {};
  if (settings.enabled === false) return { skipped: 'Email marketing is switched off' };
  const now = Date.now();
  if (settings.crmSync?.enabled && (force || now - last.crm > CRM_EVERY_MS)) {
    last.crm = now;
    await step('crm', () => syncFromCrm(), out);
  }
  await step('taskflow', () => pollTaskflowEvents(), out);
  await step('activity', () => processActivity(), out);
  if (force || now - last.dates > DATES_EVERY_MS) {
    last.dates = now;
    await step('dates', () => runDateTriggers(new Date()), out);
  }
  await step('paths', () => advanceDue(), out);
  await step('campaigns', () => runCampaignSchedule(), out);
  const perTick = Math.max(1, Math.round(((Number(settings.limits?.ratePerMinute) || 120) * config.email.workerIntervalSeconds) / 60));
  await step('queue', () => processQueue({ limit: perTick }), out);
  if (settings.replies?.enabled && (force || now - last.replies > REPLIES_EVERY_MS)) {
    last.replies = now;
    await step('replies', () => syncReplies(), out);
  }
  return out;
}

export function startMarketingWorker() {
  if (timer || !config.email.workerEnabled) return null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await runMarketingTick();
      const sent = out.queue?.sent || 0;
      if (sent || out.queue?.failed) console.log(`[taskflow] email marketing: sent ${sent}, failed ${out.queue?.failed || 0}`);
    } catch (err) {
      console.error('[taskflow] email marketing worker failed:', err.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, Math.max(5, config.email.workerIntervalSeconds) * 1000);
  timer.unref?.();
  console.log(`[taskflow] email marketing worker running every ${config.email.workerIntervalSeconds}s`);
  return timer;
}

export function stopMarketingWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
