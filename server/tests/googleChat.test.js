/**
 * Google Chat.
 *
 * Guarded here: nothing reaches TaskFlow from the Chat endpoint unless Google
 * signed it for this endpoint; people are linked only to the TaskFlow account
 * with their own email; switching Chat on never replays history; each alert
 * is sent once, and a Google outage delays it rather than losing it; and a
 * team space never sees why someone is on leave.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import {
  ChatError, chatLink, chatText, setCertFetcher, setChatConfig, setChatTransport, setChatVerifier, verifyChatToken,
} from '../src/lib/googleChat.js';
import {
  deliverOutbox, dispatchNotifications, morningSummary, queueSummaries, teamSummary,
} from '../src/services/googleChat.js';
import { updateSetting } from '../src/services/settings.js';
import { dateIn } from '../src/services/attendance.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const sent = [];
const ENDPOINT = 'https://taskflow.example.test/api/taskflow/integrations/google-chat/events';

// a stand-in for Google: its own signing key, published the way Google publishes
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googlePem = google.publicKey.export({ type: 'spki', format: 'pem' });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

const googleToken = (claims = {}, { key = google.privateKey, kid = 'k1' } = {}) => jwt.sign(
  { iss: 'https://accounts.google.com', aud: ENDPOINT, email: 'chat@system.gserviceaccount.com', email_verified: true, ...claims },
  key, { algorithm: 'RS256', keyid: kid, expiresIn: '5m' },
);

const call = async (method, path, { token, body, headers = {} } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const event = (body) => call('POST', '/integrations/google-chat/events', { body, headers: { authorization: `Bearer ${googleToken()}` } });
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };

before(async () => {
  setChatConfig({ clientEmail: 'taskflow-chat@demo.iam.gserviceaccount.com', privateKey: serviceKey, projectId: 'demo', projectNumber: '1234567890', audience: ENDPOINT });
  setCertFetcher(async () => ({ ok: true, headers: new Headers({ 'cache-control': 'max-age=60' }), json: async () => ({ k1: googlePem }) }));
  setChatTransport(async (space, message) => {
    sent.push({ space, message });
    return { name: `${space}/messages/${sent.length}` };
  });

  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  ids.dept = (await query(`SELECT id FROM departments`)).rows[0].id;
  ids.status = (await query(`SELECT id FROM workflow_statuses WHERE slug = 'to-do'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, name, role] of [['admin', 'Asha Admin', 'admin'], ['rohan', 'Rohan Field', 'member'], ['meera', 'Meera Rao', 'member']]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [name, `${key}@ekosight.test`, password, role, ids.dept],
    );
    ids[key] = rows[0].id;
  }
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'rohan', 'meera']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `${key}@ekosight.test`, password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  setChatConfig(null); setCertFetcher(null); setChatTransport(null); setChatVerifier(null);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- trust

test('only a token Google signed for this endpoint is accepted', async () => {
  const ok = await verifyChatToken(`Bearer ${googleToken()}`);
  assert.equal(ok.email, 'chat@system.gserviceaccount.com');

  const refused = [
    ['no token', undefined],
    ['garbage', 'Bearer not-a-jwt'],
    ['another endpoint', `Bearer ${googleToken({ aud: 'https://evil.example/hook' })}`],
    ['not from Chat', `Bearer ${googleToken({ email: 'someone@gmail.com' })}`],
    ['signed by someone else', `Bearer ${googleToken({}, { key: stranger.privateKey })}`],
    ['unknown key id', `Bearer ${googleToken({}, { kid: 'k9' })}`],
    ['expired', `Bearer ${jwt.sign({ iss: 'https://accounts.google.com', aud: ENDPOINT, email: 'chat@system.gserviceaccount.com', exp: Math.floor(Date.now() / 1000) - 60 }, google.privateKey, { algorithm: 'RS256', keyid: 'k1' })}`],
    ['wrong issuer', `Bearer ${googleToken({ iss: 'https://evil.example' })}`],
  ];
  for (const [label, header] of refused) {
    await assert.rejects(verifyChatToken(header), `${label} is refused`);
  }
});

test('the project-number audience works too', async () => {
  const token = jwt.sign({ iss: 'chat@system.gserviceaccount.com', aud: '1234567890' }, google.privateKey, { algorithm: 'RS256', keyid: 'k1', expiresIn: '5m' });
  const claims = await verifyChatToken(`Bearer ${token}`);
  assert.equal(claims.aud, '1234567890');
  const wrong = jwt.sign({ iss: 'chat@system.gserviceaccount.com', aud: '999' }, google.privateKey, { algorithm: 'RS256', keyid: 'k1', expiresIn: '5m' });
  await assert.rejects(verifyChatToken(`Bearer ${wrong}`));
});

test('text from people is shown as text, never as Chat markup or a link', () => {
  assert.equal(chatText('<https://evil.example|Click> & co'), '&lt;https://evil.example|Click&gt; &amp; co');
  assert.equal(chatLink('https://taskflow.ekosight.com/?task=1', 'A|B <x>'), '<https://taskflow.ekosight.com/?task=1|A/B &lt;x&gt;>');
});

test('the events endpoint refuses anything Google did not sign', async (t) => {
  if (skip(t)) return;
  const forged = await call('POST', '/integrations/google-chat/events', {
    body: { type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA', spaceType: 'DIRECT_MESSAGE' }, user: { email: 'rohan@ekosight.test' } },
  });
  assert.equal(forged.status, 401);
  const wrongAudience = await call('POST', '/integrations/google-chat/events', {
    body: { type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA', spaceType: 'DIRECT_MESSAGE' }, user: { email: 'rohan@ekosight.test' } },
    headers: { authorization: `Bearer ${googleToken({ aud: 'https://other.example/x' })}` },
  });
  assert.equal(wrongAudience.status, 401);
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM chat_spaces');
  assert.equal(rows[0].n, 0, 'nothing was recorded');
});

// ---------------------------------------------------------------- linking

test('adding the app links the direct message to the TaskFlow account with that email', async (t) => {
  if (skip(t)) return;
  const res = await event({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/DM-ROHAN', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true }, user: { email: 'Rohan@Ekosight.test', displayName: 'Rohan Field' } });
  assert.equal(res.status, 200);
  assert.match(res.body.text, /Hi Rohan\. You’re connected/);
  const { rows } = await query(`SELECT user_id, kind, active FROM chat_spaces WHERE space_name = 'spaces/DM-ROHAN'`);
  assert.deepEqual(rows[0], { user_id: ids.rohan, kind: 'DM', active: true });

  const me = await call('GET', '/chat/me', { token: tokens.rohan });
  assert.equal(me.body.linked, true);
});

test('someone without a TaskFlow account is told so and linked to nobody', async (t) => {
  if (skip(t)) return;
  const res = await event({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/DM-X', spaceType: 'DIRECT_MESSAGE' }, user: { email: 'visitor@gmail.com' } });
  assert.match(res.body.text, /couldn’t find an active TaskFlow account for visitor@gmail\.com/);
  const { rows } = await query(`SELECT user_id FROM chat_spaces WHERE space_name = 'spaces/DM-X'`);
  assert.equal(rows[0].user_id, null);
});

test('commands in the direct message: tasks, stop and start', async (t) => {
  if (skip(t)) return;
  await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, due_date)
     VALUES ('OPS-1', 'Send <b>quote</b> to Nashik dealer', $1, $2, $3, $3, now() + interval '2 days')`,
    [ids.dept, ids.status, ids.rohan],
  );
  const msg = (text) => event({ type: 'MESSAGE', space: { name: 'spaces/DM-ROHAN', spaceType: 'DIRECT_MESSAGE' }, user: { email: 'rohan@ekosight.test' }, message: { text, argumentText: text } });
  const tasks = await msg('tasks');
  assert.match(tasks.body.text, /Send &lt;b&gt;quote&lt;\/b&gt; to Nashik dealer/);
  assert.match(tasks.body.text, /\?task=\d+\|OPS-1/);

  await msg('stop');
  assert.equal((await call('GET', '/chat/me', { token: tokens.rohan })).body.preferences.instant, false);
  await msg('start');
  assert.equal((await call('GET', '/chat/me', { token: tokens.rohan })).body.preferences.instant, true);
  assert.match((await msg('hello')).body.text, /Reply with/);
});

test('a space is recorded, waits for an admin to point it at a department, and removal stops it', async (t) => {
  if (skip(t)) return;
  const added = await event({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/OPS-TEAM', spaceType: 'SPACE', displayName: 'Ops team' }, user: { email: 'admin@ekosight.test' } });
  assert.match(added.body.text, /admin can now choose which department/);
  const admin = await call('GET', '/chat/admin', { token: tokens.admin });
  const space = admin.body.spaces.find((s) => s.space_name === 'spaces/OPS-TEAM');
  assert.equal(space.department_id, null);
  assert.equal((await call('PATCH', `/chat/admin/spaces/${space.id}`, { token: tokens.rohan, body: { department_id: ids.dept } })).status, 403);
  const set = await call('PATCH', `/chat/admin/spaces/${space.id}`, { token: tokens.admin, body: { department_id: ids.dept } });
  assert.equal(set.body.space.department_id, ids.dept);
  assert.equal(admin.body.client_email, 'taskflow-chat@demo.iam.gserviceaccount.com');
  assert.ok(!JSON.stringify(admin.body).includes('PRIVATE KEY'), 'the key is never sent to the browser');

  await event({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/OLD-ROOM', spaceType: 'SPACE', displayName: 'Old room' }, user: { email: 'admin@ekosight.test' } });
  await event({ type: 'REMOVED_FROM_SPACE', space: { name: 'spaces/OLD-ROOM', spaceType: 'SPACE' }, user: { email: 'admin@ekosight.test' } });
  const { rows } = await query(`SELECT active FROM chat_spaces WHERE space_name = 'spaces/OLD-ROOM'`);
  assert.equal(rows[0].active, false, 'removing the app stops messages to that space');
});

// ---------------------------------------------------------------- alerts

test('switching Chat on does not replay history; new alerts go once, to linked people who want them', async (t) => {
  if (skip(t)) return;
  const notify = (userId, type, title, taskId = null) => query(
    'INSERT INTO notifications (user_id, type, title, task_id) VALUES ($1, $2, $3, $4)', [userId, type, title, taskId],
  );
  await notify(ids.rohan, 'assigned', 'An old assignment from last year');

  assert.deepEqual(await dispatchNotifications(), { queued: 0 }, 'off by default');
  await updateSetting('googleChat', { enabled: true }, ids.admin);
  const first = await dispatchNotifications();
  assert.equal(first.started, true, 'the first run only marks where to start');

  const { rows: task } = await query(`SELECT id FROM tasks WHERE ref = 'OPS-1'`);
  await notify(ids.rohan, 'assigned', 'Meera assigned you OPS-1', task[0].id);
  await notify(ids.rohan, 'kudos', 'Kudos from Meera');           // not a chosen type
  await notify(ids.meera, 'assigned', 'For someone not linked');  // no Chat link
  const second = await dispatchNotifications();
  assert.equal(second.queued, 1);
  assert.equal((await dispatchNotifications()).queued, 0, 'a second pass queues nothing new');

  await query(`INSERT INTO chat_preferences (user_id, instant) VALUES ($1, FALSE) ON CONFLICT (user_id) DO UPDATE SET instant = FALSE`, [ids.rohan]);
  await notify(ids.rohan, 'assigned', 'While paused');
  assert.equal((await dispatchNotifications()).queued, 0, 'paused means paused');
  await query(`UPDATE chat_preferences SET instant = TRUE WHERE user_id = $1`, [ids.rohan]);

  sent.length = 0;
  const result = await deliverOutbox();
  assert.equal(result.sent, 1);
  assert.equal(sent[0].space, 'spaces/DM-ROHAN');
  assert.match(sent[0].message.text, /\*Meera assigned you OPS-1\*/);
  assert.match(sent[0].message.text, /\?task=\d+\|Open OPS-1 in TaskFlow/);
  assert.equal((await deliverOutbox()).sent, 0, 'never sent twice');
  const { rows } = await query(`SELECT status, message_name FROM chat_outbox WHERE kind = 'ALERT'`);
  assert.equal(rows[0].status, 'SENT');
  assert.ok(rows[0].message_name.startsWith('spaces/DM-ROHAN/messages/'));
});

test('a Google outage delays a message; a removed app stops the retries', async (t) => {
  if (skip(t)) return;
  const enqueue = (key, space) => query(
    `INSERT INTO chat_outbox (dedupe_key, space_name, kind, payload) VALUES ($1, $2, 'TEST', '{"text":"hi"}')`, [key, space],
  );
  await enqueue('outage', 'spaces/DM-ROHAN');
  setChatTransport(async () => { throw new ChatError('Google Chat: backend error', { status: 503 }); });
  await deliverOutbox();
  let { rows } = await query(`SELECT status, attempts, next_attempt_at > now() AS later FROM chat_outbox WHERE dedupe_key = 'outage'`);
  assert.deepEqual(rows[0], { status: 'PENDING', attempts: 1, later: true });

  await enqueue('gone', 'spaces/DM-X');
  await query(`UPDATE chat_outbox SET next_attempt_at = now() WHERE dedupe_key IN ('outage', 'gone')`);
  setChatTransport(async (space) => {
    if (space === 'spaces/DM-X') throw new ChatError('Google Chat: not found', { status: 404, permanent: true, spaceGone: true });
    sent.push({ space }); return { name: `${space}/messages/x` };
  });
  await deliverOutbox();
  ({ rows } = await query(`SELECT dedupe_key, status FROM chat_outbox WHERE dedupe_key IN ('outage', 'gone') ORDER BY dedupe_key`));
  assert.deepEqual(rows, [{ dedupe_key: 'gone', status: 'FAILED' }, { dedupe_key: 'outage', status: 'SENT' }]);
  const space = await query(`SELECT active FROM chat_spaces WHERE space_name = 'spaces/DM-X'`);
  assert.equal(space.rows[0].active, false);
  setChatTransport(async (s, message) => { sent.push({ space: s, message }); return { name: `${s}/messages/${sent.length}` }; });
});

// ---------------------------------------------------------------- summaries

test('the morning summary lists what is due and overdue, once a day', async (t) => {
  if (skip(t)) return;
  await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, due_date)
     VALUES ('OPS-2', 'Renew the warehouse lease', $1, $2, $3, $3, now() - interval '1 day')`,
    [ids.dept, ids.status, ids.rohan],
  );
  const summary = await morningSummary(ids.rohan);
  assert.match(summary.text, /Good morning, Rohan/);
  assert.match(summary.text, /\*Overdue \(1\)\*/);
  assert.match(summary.text, /Renew the warehouse lease/);
  assert.equal(await morningSummary(ids.meera), null, 'nothing to say means no message');

  // 10:00 India time on a working day: both summaries are due
  let day = dateIn('Asia/Kolkata');
  let probe = new Date(`${day}T10:00:00+05:30`);
  while (probe.getUTCDay() === 0) { probe = new Date(probe.getTime() + 86_400_000); day = dateIn('Asia/Kolkata', probe); }
  const first = await queueSummaries(probe);
  assert.ok(first.queued >= 1);
  assert.equal((await queueSummaries(probe)).queued, 0, 'once a day');
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM chat_outbox WHERE dedupe_key = $1`, [`digest:${ids.rohan}:${day}`]);
  assert.equal(rows[0].n, 1);

  const early = new Date(`${day}T07:00:00+05:30`);
  await query(`DELETE FROM chat_outbox WHERE kind IN ('DIGEST', 'TEAM_SUMMARY')`);
  assert.equal((await queueSummaries(early)).queued, 0, 'not before the configured time');
});

test('the team summary names who is away but never why', async (t) => {
  if (skip(t)) return;
  const today = dateIn('Asia/Kolkata');
  await query(
    `INSERT INTO user_availability (user_id, status, start_date, end_date, note) VALUES ($1, 'ON_LEAVE', $2, $2, 'Hospital appointment for my mother')`,
    [ids.meera, today],
  );
  const summary = await teamSummary(ids.dept);
  assert.match(summary.text, /\*Away today:\* Meera Rao/);
  assert.ok(!summary.text.includes('Hospital'), 'the reason stays private');
  assert.match(summary.text, /Renew the warehouse lease/);
});

test('a person can test their own link and change what they receive', async (t) => {
  if (skip(t)) return;
  sent.length = 0;
  const test1 = await call('POST', '/chat/me/test', { token: tokens.rohan });
  assert.equal(test1.body.ok, true);
  assert.match(sent.at(-1).message.text, /Test message from TaskFlow/);
  const notLinked = await call('POST', '/chat/me/test', { token: tokens.meera });
  assert.equal(notLinked.status, 400);
  assert.match(notLinked.body.error, /Add the TaskFlow app/);
  const prefs = await call('PUT', '/chat/me/preferences', { token: tokens.meera, body: { morning_summary: false } });
  assert.deepEqual(prefs.body.preferences, { instant: true, morning_summary: false });
  assert.equal((await call('GET', '/chat/admin', { token: tokens.meera })).status, 403);
});
