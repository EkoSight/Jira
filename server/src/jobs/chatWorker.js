/**
 * Every minute: turn new notifications into Chat alerts, queue the morning
 * summaries when it is time, and send whatever is waiting. Runs only when the
 * Google Chat credentials are present on the server.
 */
import { chatConfig } from '../lib/googleChat.js';
import { runChatWork } from '../services/googleChat.js';
import { syncChats } from '../services/chatSync.js';

const SYNC_EVERY_MS = 60 * 60 * 1000;
let lastSyncAt = 0;

let timer = null;
let running = false;

export function startChatWorker({ intervalSeconds = 60 } = {}) {
  const cfg = chatConfig();
  if (timer || !cfg.configured) return null;
  if (!cfg.usable) console.error(`[taskflow] Google Chat: ${cfg.keyProblem}`);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // find chats an admin install opened — at start-up, then hourly
      if (Date.now() - lastSyncAt > SYNC_EVERY_MS) {
        lastSyncAt = Date.now();
        try {
          const sync = await syncChats();
          const linked = sync.linked?.length || sync.greeted || 0;
          if (linked) console.log(`[taskflow] Google Chat: connected ${linked} new chat(s) (${sync.mode})`);
          if (sync.errors?.length) console.error(`[taskflow] Google Chat sync: ${sync.errors[0]}`);
        } catch (err) {
          console.error('[taskflow] Google Chat sync failed:', err.message);
        }
      }
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
