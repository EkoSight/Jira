/**
 * Finding the chats an administrator install created.
 *
 * When an admin installs TaskFlow for everyone, Google Chat opens a direct
 * message between TaskFlow and each person — but nobody has said anything in
 * it, so TaskFlow has not been told whose it is. This pass finds them:
 *
 *   With the directory (preferred): each TaskFlow user's Workspace email is
 *   looked up in the Admin directory (read-only, one-time admin grant) to get
 *   their Google id, and Chat is asked for TaskFlow's DM with that id. Everyone
 *   is linked with nobody doing anything, new joiners included.
 *
 *   Without it: TaskFlow lists its direct messages and posts a one-time hello
 *   in any it cannot place, asking the person to reply. Their reply carries
 *   their email, which links them.
 *
 * Runs at start-up, hourly, and from Settings. Safe to repeat.
 */

import { query } from '../db/pool.js';
import { config } from '../config.js';
import { ChatError, chatConfig, directoryUserId, findDirectMessage, listDirectMessages, chatLink } from '../lib/googleChat.js';
import { enqueue, saveDirectMessage } from './googleChat.js';

const app = (path = '/') => `${config.publicUrl}${path}`;

const WELCOME = (firstName) => ({
  text: [
    `*Hi ${firstName || 'there'} — TaskFlow is set up in your Google Chat.*`,
    'Your task, deadline, leave and attendance alerts will arrive here, with a short summary each working morning.',
    'Reply `tasks` for your open tasks, `stop` to pause instant alerts, or `help` for more.',
    chatLink(app('/settings?tab=account'), 'Choose what you receive in TaskFlow'),
  ].join('\n'),
});

const HELLO_UNKNOWN = {
  text: 'Hi — I’m *TaskFlow*. Reply with any message (just “hi” is fine) to connect this chat to your TaskFlow account, '
    + 'and your task, deadline and leave alerts will arrive here.',
};

/** Active TaskFlow people who have no working direct message yet. */
async function unlinkedPeople() {
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, p.google_user_name
       FROM users u LEFT JOIN chat_preferences p ON p.user_id = u.id
      WHERE u.is_active
        AND NOT EXISTS (SELECT 1 FROM chat_spaces s WHERE s.kind = 'DM' AND s.user_id = u.id AND s.active)
      ORDER BY u.id`,
  );
  return rows;
}

async function welcome(spaceName, user) {
  await enqueue({
    dedupeKey: `welcome:${spaceName}`, spaceName, userId: user.id, kind: 'WELCOME',
    payload: WELCOME(user.full_name.split(' ')[0]),
  });
}

/** Directory route: link every unlinked person whose chat exists. */
async function syncWithDirectory() {
  const people = await unlinkedPeople();
  const result = { mode: 'DIRECTORY', checked: people.length, linked: [], not_installed: [], not_in_directory: [], errors: [] };
  for (const person of people) {
    try {
      let googleId = person.google_user_name?.replace(/^users\//, '') || null;
      if (!googleId) {
        googleId = await directoryUserId(person.email);
        if (!googleId) { result.not_in_directory.push(person.email); continue; }
      }
      const space = await findDirectMessage(googleId);
      if (!space?.name) {
        // remember the id, so the next pass skips the directory
        await query(
          `INSERT INTO chat_preferences (user_id, google_user_name) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET google_user_name = EXCLUDED.google_user_name`,
          [person.id, `users/${googleId}`],
        );
        result.not_installed.push(person.email);
        continue;
      }
      await saveDirectMessage({
        spaceName: space.name, userId: person.id, displayName: person.full_name, email: person.email,
        googleUserName: `users/${googleId}`, adminInstalled: Boolean(space.adminInstalled),
      });
      await welcome(space.name, person);
      result.linked.push(person.email);
    } catch (err) {
      result.errors.push(`${person.email}: ${err.message}`);
      // a refused sign-in or a missing grant fails the same way for everyone — stop at the first
      if (err instanceof ChatError && err.permanent) break;
    }
  }
  return result;
}

/** Without the directory: say hello once in any chat nobody has claimed. */
async function syncWithoutDirectory() {
  const spaces = await listDirectMessages();
  const { rows: known } = await query(`SELECT space_name, user_id, welcomed_at FROM chat_spaces WHERE kind = 'DM'`);
  const byName = new Map(known.map((r) => [r.space_name, r]));
  const result = { mode: 'LIST', found: spaces.length, greeted: 0, already_linked: 0 };
  for (const space of spaces) {
    const row = byName.get(space.name);
    if (row?.user_id) { result.already_linked += 1; continue; }
    if (row?.welcomed_at) continue;
    await saveDirectMessage({ spaceName: space.name, userId: null, adminInstalled: Boolean(space.adminInstalled) });
    await enqueue({ dedupeKey: `hello:${space.name}`, spaceName: space.name, kind: 'WELCOME', payload: HELLO_UNKNOWN });
    await query('UPDATE chat_spaces SET welcomed_at = now() WHERE space_name = $1', [space.name]);
    result.greeted += 1;
  }
  return result;
}

export async function syncChats() {
  const cfg = chatConfig();
  if (!cfg.usable) return { skipped: 'not configured' };
  const { rows } = await query(`INSERT INTO chat_sync_runs (mode) VALUES ($1) RETURNING id`, [cfg.directoryAdmin ? 'DIRECTORY' : 'LIST']);
  try {
    const result = cfg.directoryAdmin ? await syncWithDirectory() : await syncWithoutDirectory();
    await query('UPDATE chat_sync_runs SET finished_at = now(), result = $2 WHERE id = $1', [rows[0].id, JSON.stringify(result)]);
    return result;
  } catch (err) {
    await query('UPDATE chat_sync_runs SET finished_at = now(), error = $2 WHERE id = $1', [rows[0].id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

export async function lastSync() {
  const { rows } = await query('SELECT * FROM chat_sync_runs ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}
