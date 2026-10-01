/**
 * Every minute: turn new notifications into Chat alerts, queue the morning
 * summaries when it is time, and send whatever is waiting. Runs only when the
 * Google Chat credentials are present on the server.
 */
import { chatConfig } from '../lib/googleChat.js';
import { runChatWork } from '../services/googleChat.js';

let timer = null;
let running = false;

export function startChatWorker({ intervalSeconds = 60 } = {}) {
  if (timer || !chatConfig().configured) return null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runChatWork();
      const sent = result.delivered?.sent || 0;
      if (sent || result.delivered?.failed) {
        console.log(`[taskflow] Google Chat: sent ${sent}, gave up on ${result.delivered.failed || 0}`);
      }
    } catch (err) {
      console.error('[taskflow] Google Chat worker failed:', err.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalSeconds * 1000);
  timer.unref?.();
  console.log(`[taskflow] Google Chat worker running as ${chatConfig().clientEmail}`);
  return timer;
}

export function stopChatWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
