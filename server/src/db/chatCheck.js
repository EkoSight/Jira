/**
 * npm run chat:check — says whether the Google Chat credentials work, and if
 * not, exactly why. Prints lengths and shapes, never the key.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { config } from '../config.js';
import { chatConfig, checkSignIn, readPrivateKey } from '../lib/googleChat.js';

const envFile = path.join(process.cwd(), '.env');
const fromFile = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const raw = process.env.GOOGLE_CHAT_PRIVATE_KEY || process.env.GOOGLE_CHAT_PRIVATE_KEY_BASE64 || '';
const say = (ok, text) => console.log(`${ok ? '  ✓' : '  ✗'} ${text}`);

console.log('\nGoogle Chat credentials\n');
say(Boolean(config.googleChat.clientEmail), `GOOGLE_CHAT_CLIENT_EMAIL ${config.googleChat.clientEmail || 'is missing'}`);
say(Boolean(config.googleChat.projectId), `GOOGLE_CHAT_PROJECT_ID ${config.googleChat.projectId || 'is missing'}`);
say(Boolean(raw), raw ? `GOOGLE_CHAT_PRIVATE_KEY is ${raw.length} characters, ${raw.split('\n').length} line(s), starts ${JSON.stringify(raw.slice(0, 12))}…` : 'GOOGLE_CHAT_PRIVATE_KEY is missing');
if (fromFile.GOOGLE_CHAT_PRIVATE_KEY && process.env.GOOGLE_CHAT_PRIVATE_KEY && fromFile.GOOGLE_CHAT_PRIVATE_KEY !== process.env.GOOGLE_CHAT_PRIVATE_KEY) {
  say(false, 'The key in the environment differs from the one in server/.env — your service manager (systemd EnvironmentFile, pm2, Docker) is supplying its own copy, and .env does not override it');
}
const { key, problem } = readPrivateKey(raw);
say(Boolean(key), key ? 'The private key is readable' : problem);

if (key && config.googleChat.clientEmail) {
  try {
    await checkSignIn();
    say(true, 'Google accepted the service account sign-in — the credentials work');
  } catch (err) {
    say(false, err.message);
  }
}
console.log(`\nEndpoint to enter in Google Cloud: ${chatConfig().endpointUrl}\n`);
