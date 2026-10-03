/**
 * Google Chat installed for everyone by an administrator.
 *
 * Guarded here: the chats an admin install opens are matched to the right
 * people without anyone doing anything (directory route), new joiners are
 * picked up by a later pass, each person is welcomed once, someone who is not
 * yet installed is simply skipped, and without the directory grant TaskFlow
 * says hello once in chats it cannot place — and the reply links them.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { setChatConfig, setChatTransport, setGoogleFetch } from '../src/lib/googleChat.js';
import { syncChats } from '../src/services/chatSync.js';
import { deliverOutbox, handleChatEvent } from '../src/services/googleChat.js';

let available = true;
const ids = {};
const sent = [];
const seen = { tokens: [], directory: 0 };
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const base = { clientEmail: 'taskflow-chat@demo.iam.gserviceaccount.com', privateKey: key, projectId: 'demo' };

// Google, as far as these tests need it
const directory = { 'asha@ekosight.test': '101', 'rohan@ekosight.test': '102', 'nina@ekosight.test': '103' };
const dms = { 101: 'spaces/DM-ASHA', 102: 'spaces/DM-ROHAN' }; // Nina's install has not reached her yet
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

async function fakeGoogle(url, init = {}) {
  const u = new URL(url);
  if (u.hostname === 'oauth2.googleapis.com') {
    const claims = jwt.decode(new URLSearchParams(String(init.body)).get('assertion'));
    seen.tokens.push(claims);
    return json(200, { access_token: `token:${claims.scope}:${claims.sub || ''}`, expires_in: 3600 });
  }
  const auth = init.headers?.Authorization || '';
  if (u.hostname === 'admin.googleapis.com') {
    seen.directory += 1;
    // only a token that impersonates the admin, for the read-only directory scope, is accepted
    if (!auth.includes('admin.directory.user.readonly:it-admin@ekosight.test')) return json(403, { error: { message: 'Not Authorized to access this resource/api' } });
    const email = decodeURIComponent(u.pathname.split('/').pop());
    return directory[email] ? json(200, { id: directory[email], primaryEmail: email }) : json(404, { error: { message: 'Resource Not Found: userKey' } });
  }
  if (u.hostname === 'chat.googleapis.com') {
    assert.match(auth, /chat\.bot/);
    if (u.pathname === '/v1/spaces:findDirectMessage') {
      const id = u.searchParams.get('name').replace('users/', '');
      return dms[id] ? json(200, { name: dms[id], spaceType: 'DIRECT_MESSAGE', adminInstalled: true }) : json(404, { error: { message: 'not found' } });
    }
    if (u.pathname === '/v1/spaces') {
      return json(200, { spaces: Object.values(dms).map((name) => ({ name, spaceType: 'DIRECT_MESSAGE', adminInstalled: true })) });
    }
  }
  return json(500, { error: { message: `unexpected ${url}` } });
}

const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };

before(async () => {
  setGoogleFetch(fakeGoogle);
  setChatTransport(async (space, message) => { sent.push({ space, message }); return { name: `${space}/messages/${sent.length}` }; });
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  for (const [k, name] of [['asha', 'Asha Kulkarni'], ['rohan', 'Rohan Field'], ['nina', 'Nina Rao'], ['guest', 'Gita Guest']]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, must_change_password) VALUES ($1, $2, 'x', 'member', FALSE) RETURNING id`,
      [name, `${k}@ekosight.test`],
    );
    ids[k] = rows[0].id;
  }
});

after(async () => {
  setGoogleFetch(null); setChatTransport(null); setChatConfig(null);
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('with the directory grant, everyone whose chat exists is linked and welcomed once', async (t) => {
  if (skip(t)) return;
  setChatConfig({ ...base, directoryAdmin: 'it-admin@ekosight.test' });
  const result = await syncChats();
  assert.equal(result.mode, 'DIRECTORY');
  assert.deepEqual(result.linked.sort(), ['asha@ekosight.test', 'rohan@ekosight.test']);
  assert.deepEqual(result.not_installed, ['nina@ekosight.test'], 'not installed for her yet: skipped, not an error');
  assert.deepEqual(result.not_in_directory, ['guest@ekosight.test'], 'a TaskFlow user outside Workspace is named');
  assert.deepEqual(result.errors, []);

  const dirToken = seen.tokens.find((c) => c.scope.includes('directory'));
  assert.equal(dirToken.sub, 'it-admin@ekosight.test', 'the directory is read as the named admin');
  assert.ok(!seen.tokens.some((c) => c.scope.includes('chat.bot') && c.sub), 'Chat calls are made as TaskFlow itself');

  const { rows } = await query(`SELECT user_id, space_name, google_user_name, admin_installed FROM chat_spaces ORDER BY space_name`);
  assert.deepEqual(rows, [
    { user_id: ids.asha, space_name: 'spaces/DM-ASHA', google_user_name: 'users/101', admin_installed: true },
    { user_id: ids.rohan, space_name: 'spaces/DM-ROHAN', google_user_name: 'users/102', admin_installed: true },
  ]);

  await deliverOutbox();
  assert.equal(sent.length, 2);
  assert.match(sent.find((m) => m.space === 'spaces/DM-ASHA').message.text, /Hi Asha — TaskFlow is set up/);

  // a second pass changes nothing and welcomes nobody again
  const again = await syncChats();
  assert.deepEqual(again.linked, []);
  await deliverOutbox();
  assert.equal(sent.length, 2);
});

test('a new joiner is picked up by a later pass, without another directory lookup for known people', async (t) => {
  if (skip(t)) return;
  const lookups = seen.directory;
  dms[103] = 'spaces/DM-NINA'; // the admin install reaches her
  const result = await syncChats();
  assert.deepEqual(result.linked, ['nina@ekosight.test']);
  assert.equal(seen.directory - lookups, 1, 'only the guest is looked up again; Nina’s id was remembered');
  await deliverOutbox();
  assert.match(sent.at(-1).message.text, /Hi Nina/);
});

test('a missing directory grant is reported once, not once per person', async (t) => {
  if (skip(t)) return;
  setChatConfig({ ...base, directoryAdmin: 'someone-else@ekosight.test' });
  await query(`UPDATE chat_spaces SET active = FALSE WHERE space_name IN ('spaces/DM-ASHA', 'spaces/DM-ROHAN')`);
  await query(`UPDATE chat_preferences SET google_user_name = NULL`);
  const result = await syncChats();
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Not Authorized/);
  await query(`UPDATE chat_spaces SET active = TRUE`);
});

test('without the directory, TaskFlow says hello once in chats it cannot place, and a reply links the person', async (t) => {
  if (skip(t)) return;
  setChatConfig(base);
  dms[104] = 'spaces/DM-UNKNOWN';
  const before_ = sent.length;
  const result = await syncChats();
  assert.equal(result.mode, 'LIST');
  assert.equal(result.greeted, 1);
  assert.equal((await syncChats()).greeted, 0, 'only once');
  await deliverOutbox();
  assert.equal(sent.length - before_, 1);
  assert.match(sent.at(-1).message.text, /Reply with any message/);

  await query(`INSERT INTO users (full_name, email, password_hash, role, must_change_password) VALUES ('Vik Late', 'vik@ekosight.test', 'x', 'member', FALSE)`);
  const reply = await handleChatEvent({
    type: 'MESSAGE',
    space: { name: 'spaces/DM-UNKNOWN', spaceType: 'DIRECT_MESSAGE', adminInstalled: true },
    user: { name: 'users/104', email: 'vik@ekosight.test', displayName: 'Vik Late' },
    message: { text: 'hi', argumentText: 'hi' },
  });
  assert.match(reply.text, /Hi Vik\. You’re connected/);
  const { rows } = await query(`SELECT u.email, s.google_user_name FROM chat_spaces s JOIN users u ON u.id = s.user_id WHERE s.space_name = 'spaces/DM-UNKNOWN'`);
  assert.deepEqual(rows[0], { email: 'vik@ekosight.test', google_user_name: 'users/104' });
});
