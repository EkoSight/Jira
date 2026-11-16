/**
 * To-dos from Google Chat (a direct message with TaskFlow), through the same
 * service as the app:
 *
 *   todo <words>  or  + <words>   adds a private to-do for today
 *   todos                          today's plan, numbered (open lines only)
 *   done <n>                       ticks line n of that same list, and names it
 *   undo                           reverts the last to-do change made here
 *
 * A message delivered twice acts once: an add carries the message name as its
 * client key, and a tick or undo remembers the message it came from. Ticking
 * a line never completes a task; a pinned task is completed in TaskFlow.
 */
import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { getSettings } from '../settings.js';
import { createTodo, removeTodo, todayPlan, updateMyStep, updateTodo } from './index.js';

const appUrl = (path) => `${config.publicUrl}${path}`;

export const TODO_HELP = [
  '• `todo <words>` or `+ <words>`: add a private to-do to today’s plan',
  '• `todos`: today’s plan, numbered',
  '• `done 2`: tick line 2 of that list',
  '• `undo`: undo the last to-do change made here',
];

/** Which to-do command a message is, if any. The words of a new to-do keep their case. */
export function parseTodoCommand(raw) {
  const text = String(raw || '').trim().replace(/^\//, '');
  let m = text.match(/^(?:todo|to-do)\s+(.+)$/is) || text.match(/^\+\s*(.+)$/s);
  if (m) return { kind: 'ADD', title: m[1].replace(/\s+/g, ' ').trim() };
  const lower = text.toLowerCase();
  if (['todos', 'to-dos', 'my todos', 'my to-dos', 'plan'].includes(lower)) return { kind: 'LIST' };
  m = lower.match(/^done\s+#?(\d{1,3})$/);
  if (m) return { kind: 'DONE', n: Number(m[1]) };
  if (lower === 'undo') return { kind: 'UNDO' };
  return null;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const leftWords = (n) => (n ? `${n} left` : 'nothing left');

/** The open lines of today's plan, in the plan's own order: what `done n` counts. */
function openLines(plan) {
  return [...plan.carried, ...plan.items].filter((i) => !i.done);
}

function lineWords(item) {
  const extra = [];
  if (item.planned_time) extra.push(item.planned_time);
  if (item.carried_from) extra.push(`from ${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${item.carried_from}T00:00:00Z`))}`);
  if (item.source === 'STEP') extra.push(`step on ${item.task.ref}`);
  if (item.source === 'PIN') extra.push(`task ${item.task.ref}, pinned`);
  return `${item.title}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

async function activeUser(userId) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1 AND is_active', [userId]);
  return rows[0] || null;
}

async function remember(userId, change, messageName) {
  await query(
    `INSERT INTO todo_chat_undo (user_id, kind, source, item_id, title, message_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET kind = EXCLUDED.kind, source = EXCLUDED.source, item_id = EXCLUDED.item_id,
       title = EXCLUDED.title, message_name = EXCLUDED.message_name, created_at = now()`,
    [userId, change.kind, change.source, change.id, change.title, messageName]);
}

/** The reply to one to-do command. */
export async function todoChatReply(userId, command, { messageName = null } = {}) {
  if ((await getSettings()).todos?.enabled === false) return { text: 'To-dos are switched off in TaskFlow.' };
  const user = await activeUser(userId);
  if (!user) return { text: 'Your TaskFlow account is not active.' };

  if (command.kind === 'ADD') {
    const result = await createTodo(user, {
      title: command.title, planned_on: 'TODAY', source: 'CHAT',
      client_key: messageName ? `chat:${messageName}` : null,
    });
    if (!result.duplicate) await remember(user.id, { kind: 'ADDED', source: 'TODO', id: result.todo.id, title: result.todo.title }, messageName);
    const plan = await todayPlan(user);
    const lines = [`Added “${result.todo.title}” to today’s plan. ${leftWords(plan.left)[0].toUpperCase()}${leftWords(plan.left).slice(1)}. Reply \`undo\` to take it back.`];
    if (result.todo.link) lines.push(`Linked privately to ${result.todo.link.label}.`);
    if (result.ref_note) lines.push(`${result.ref_note}, so it is not linked.`);
    return { text: lines.join('\n') };
  }

  if (command.kind === 'LIST') {
    const plan = await todayPlan(user);
    const open = openLines(plan);
    if (!open.length) {
      return { text: `*Today’s plan*: nothing left${plan.done_count ? ` (${plan.done_count} done)` : ''}. Add one with \`todo <words>\`.` };
    }
    return {
      text: [
        `*Today’s plan*: ${leftWords(plan.left)}${plan.done_count ? `, ${plan.done_count} done` : ''}`,
        ...open.map((item, i) => `${i + 1}. ${lineWords(item)}`),
        'Reply `done 2` to tick line 2.',
      ].join('\n'),
    };
  }

  if (command.kind === 'DONE') {
    const { rows: last } = await query('SELECT * FROM todo_chat_undo WHERE user_id = $1', [user.id]);
    if (messageName && last[0]?.message_name === messageName) {
      const plan = await todayPlan(user);
      return { text: `Ticked “${last[0].title}”. ${leftWords(plan.left)[0].toUpperCase()}${leftWords(plan.left).slice(1)}.` };
    }
    const plan = await todayPlan(user);
    const open = openLines(plan);
    const item = open[command.n - 1];
    if (!item) return { text: `There is no line ${command.n}. Reply \`todos\` to see today’s plan.` };
    if (item.source === 'PIN') {
      return { text: `Line ${command.n} is the task ${item.task.ref}. Tasks are completed in TaskFlow, with their outcome: ${appUrl(`/?task=${item.task.id}`)}` };
    }
    let ask = null;
    if (item.source === 'TODO') await updateTodo(user, item.id, { done: true });
    else ask = (await updateMyStep(user, item.id, { done: true })).ask_complete;
    await remember(user.id, { kind: 'TICKED', source: item.source, id: item.id, title: item.title }, messageName);
    const after = await todayPlan(user);
    const lines = [`Ticked “${item.title}”. ${leftWords(after.left)[0].toUpperCase()}${leftWords(after.left).slice(1)}. Reply \`undo\` to untick it.`];
    if (ask) lines.push(`${ask.words} Complete it in TaskFlow: ${appUrl(`/?task=${ask.task_id}`)}`);
    return { text: lines.join('\n') };
  }

  if (command.kind === 'UNDO') {
    const { rows } = await query('DELETE FROM todo_chat_undo WHERE user_id = $1 RETURNING *', [user.id]);
    const last = rows[0];
    if (!last) return { text: 'Nothing to undo.' };
    try {
      if (last.kind === 'ADDED') await removeTodo(user, last.item_id);
      else if (last.source === 'TODO') await updateTodo(user, last.item_id, { done: false });
      else await updateMyStep(user, last.item_id, { done: false });
    } catch {
      return { text: `“${last.title}” has changed since, so it was left as it is.` };
    }
    return { text: last.kind === 'ADDED' ? `Took back “${last.title}”.` : `Unticked “${last.title}”.` };
  }
  return null;
}

/**
 * The morning summary's line, for people with something on today's plan:
 * "Today's plan: 4 to-dos (1 carried over)". Null when there is nothing.
 */
export async function planSummaryLine(userId, now = new Date()) {
  if ((await getSettings()).todos?.enabled === false) return null;
  const user = await activeUser(userId);
  if (!user) return null;
  const plan = await todayPlan(user, { now });
  if (!plan.left) return null;
  return `Today’s plan: ${plural(plan.left, 'to-do')}${plan.carried_count ? ` (${plan.carried_count} carried over)` : ''}`;
}
