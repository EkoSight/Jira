/**
 * Writes capacitor.config.json from the environment, so no company address
 * is kept in the repository.
 *
 *   TASKFLOW_URL     the company's TaskFlow address, https only (required)
 *   TASKFLOW_APP_ID  the Android application id (default com.ekosight.taskflow);
 *                    decide it before the first install: phones treat another
 *                    id as another app
 *
 * The app opens TaskFlow from that address, so the web client is updated by
 * deploying TaskFlow, not by a new app. Only that host may load inside the app
 * (the phone features are offered to it alone); every other link opens in the
 * phone's browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = process.env.TASKFLOW_URL || '';
let url;
try { url = new URL(raw); } catch { url = null; }
if (!url || url.protocol !== 'https:') {
  console.error('Set TASKFLOW_URL to the company\'s TaskFlow address, for example TASKFLOW_URL=https://taskflow.example.com');
  process.exit(1);
}
const appId = process.env.TASKFLOW_APP_ID || 'com.ekosight.taskflow';
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(appId)) {
  console.error('TASKFLOW_APP_ID must look like com.example.app');
  process.exit(1);
}
const config = {
  appId,
  appName: 'TaskFlow',
  webDir: 'www',
  server: {
    url: url.origin,
    cleartext: false,
    allowNavigation: [url.host],
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
};
fs.writeFileSync(path.join(here, '..', 'capacitor.config.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`capacitor.config.json: ${appId} opens ${url.origin}`);
