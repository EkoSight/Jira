/**
 * Discussion and review threads.
 *
 * A task, key result or objective can be talked about in the same shape, because
 * the thing that needs saying — "this is too vague to measure", "I am blocked",
 * "here is where it got to" — is the same wherever the work sits.
 *
 * Two ideas, deliberately kept apart:
 *
 *   A REVIEW asks for a change. It names someone to act, shows on the item until
 *   it is answered, and closes with a written conclusion so the next reader knows
 *   what was decided rather than guessing from the last message.
 *
 *   Everything else is how the work is talked about while it happens: progress,
 *   challenges, help needed, feedback asked. These carry a kind so a blocked
 *   person is visible without having to chase anyone, but they gate nothing.
 *
 * A thread never changes the thing it is about. Raising a review does not edit
 * the goal, move the task, or alter a status — it asks a person to.
 */

import { query } from '../db/pool.js';
import { notify } from './activity.js';
import { getSettings } from './settings.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';

export const ENTITY_TYPES = ['TASK', 'KEY_RESULT', 'OBJECTIVE'];

export const THREAD_KINDS = [
  'review',
  'question',
  'progress',
  'challenge',
  'help_needed',
  'feedback',
  'discussion',
];

/** The kinds that mean somebody is waiting on somebody else. */
export const ASKING_KINDS = ['review', 'question', 'help_needed', 'feedback'];

/** How each kind reads, and whether it is asking for something. */
export const KIND_META = {
  review: { label: 'Needs improvement', asking: true, severity: 'warning' },
  question: { label: 'Question', asking: true, severity: 'info' },
  help_needed: { label: 'Help needed', asking: true, severity: 'warning' },
  feedback: { label: 'Feedback asked', asking: true, severity: 'info' },
  challenge: { label: 'Challenge', asking: false, severity: 'warning' },
  progress: { label: 'Progress', asking: false, severity: 'info' },
  discussion: { label: 'Discussion', asking: false, severity: 'info' },
};

const THREAD_SELECT = `
  SELECT t.*,
         o.full_name AS opened_by_name, o.avatar_color AS opened_by_color,
         a.full_name AS awaiting_name,  a.avatar_color AS awaiting_color,
         r.full_name AS resolved_by_name,
         (SELECT COUNT(*)::int FROM discussion_messages m WHERE m.thread_id = t.id) AS message_count,
         (SELECT MAX(m.created_at) FROM discussion_messages m WHERE m.thread_id = t.id) AS last_message_at
    FROM discussion_threads t
    LEFT JOIN users o ON o.id = t.opened_by
    LEFT JOIN users a ON a.id = t.awaiting_user
    LEFT JOIN users r ON r.id = t.resolved_by
`;

/**
 * Whether an open review is allowed to hold an item back.
 *
 * Off by default: a flag that stops a quarter because a reviewer went on leave
 * is worse than a flag that is merely visible. Admins can turn it on.
 */
export async function reviewsBlock() {
  const settings = await getSettings();
  return Boolean(settings.reviews?.blockOnOpenReview);
}

/** Threads on one item, newest activity first, open ones above resolved ones. */
export async function listThreads(entityType, entityId) {
  const { rows } = await query(
    `${THREAD_SELECT}
      WHERE t.entity_type = $1 AND t.entity_id = $2
      ORDER BY (t.status = 'open') DESC, COALESCE(t.updated_at, t.created_at) DESC`,
    [entityType, entityId],
  );
  return rows;
}

/** Every message in a thread, oldest first — a conversation reads downwards. */
export async function listMessages(threadId) {
  const { rows } = await query(
    `SELECT m.*, u.full_name AS author_name, u.avatar_color AS avatar_color
       FROM discussion_messages m
       LEFT JOIN users u ON u.id = m.author_id
      WHERE m.thread_id = $1
      ORDER BY m.created_at, m.id`,
    [threadId],
  );
  return rows;
}

/**
 * Threads for a set of items in one query, so a page listing many key results
 * does not ask per key result.
 */
export async function threadsFor(entityType, entityIds) {
  if (!entityIds.length) return new Map();
  const { rows } = await query(
    `${THREAD_SELECT} WHERE t.entity_type = $1 AND t.entity_id = ANY($2::int[])
      ORDER BY (t.status = 'open') DESC, COALESCE(t.updated_at, t.created_at) DESC`,
    [entityType, entityIds],
  );
  const byEntity = new Map(entityIds.map((id) => [id, []]));
  for (const row of rows) byEntity.get(row.entity_id)?.push(row);
  return byEntity;
}

export async function getThread(id) {
  const { rows } = await query(`${THREAD_SELECT} WHERE t.id = $1`, [id]);
  return rows[0] || null;
}

/**
 * A compact count per item: how many threads are open and how many are reviews.
 * Enough to draw a badge without shipping every message.
 */
export async function threadSummary(entityType, entityIds) {
  if (!entityIds.length) return new Map();
  const { rows } = await query(
    `SELECT entity_id,
            COUNT(*) FILTER (WHERE status = 'open')::int AS open_threads,
            COUNT(*) FILTER (WHERE status = 'open' AND kind = 'review')::int AS open_reviews,
            COUNT(*) FILTER (WHERE status = 'open' AND kind = 'help_needed')::int AS open_help
       FROM discussion_threads
      WHERE entity_type = $1 AND entity_id = ANY($2::int[])
      GROUP BY entity_id`,
    [entityType, entityIds],
  );
  return new Map(rows.map((r) => [r.entity_id, r]));
}

/**
 * Who may raise a review on something.
 *
 * Asking someone to improve their own goal is a management act, so it needs the
 * permission for it. Every other kind of thread is open to anyone who can
 * already see and comment on the item — being blocked is not a privilege.
 */
export function canRaiseReview(user) {
  return hasPermission(user, 'review.raise');
}

/**
 * Who may close a thread.
 *
 * The person who asked, because they are the one who knows whether they got an
 * answer; and anyone who could have raised it, so a thread never outlives the
 * person who opened it.
 */
export function canResolveThread(user, thread) {
  return thread.opened_by === user.id || canRaiseReview(user);
}

/** Creates a thread with its first message. Both, or neither. */
export async function createThread(client, {
  entityType, entityId, kind, title, body, actor, awaitingUserId = null,
}) {
  if (!ENTITY_TYPES.includes(entityType)) throw badRequest('Unknown thing to discuss');
  if (!THREAD_KINDS.includes(kind)) throw badRequest('Unknown kind of thread');

  const { rows } = await client.query(
    `INSERT INTO discussion_threads
       (entity_type, entity_id, kind, title, opened_by, awaiting_user)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [entityType, entityId, kind, title || null, actor.id, awaitingUserId],
  );
  const thread = rows[0];

  await client.query(
    `INSERT INTO discussion_messages (thread_id, author_id, body) VALUES ($1, $2, $3)`,
    [thread.id, actor.id, body],
  );

  return thread;
}

/** Appends to a thread and moves its updated_at, which is what orders the list. */
export async function addMessage(client, { threadId, actor, body }) {
  const { rows } = await client.query(
    `INSERT INTO discussion_messages (thread_id, author_id, body) VALUES ($1, $2, $3) RETURNING *`,
    [threadId, actor.id, body],
  );
  await client.query('UPDATE discussion_threads SET updated_at = now() WHERE id = $1', [threadId]);
  return rows[0];
}

/**
 * Closes a thread with what it concluded.
 *
 * The conclusion is required rather than optional: a thread that ends silently
 * makes the next person read the whole argument to find out how it came out.
 */
export async function resolveThread(client, { threadId, actor, conclusion }) {
  const { rows } = await client.query(
    `UPDATE discussion_threads
        SET status = 'resolved', resolved_by = $1, resolved_at = now(),
            conclusion = $2, updated_at = now()
      WHERE id = $3
      RETURNING *`,
    [actor.id, conclusion, threadId],
  );
  if (!rows[0]) throw notFound('Thread not found');
  return rows[0];
}

export async function reopenThread(client, { threadId, actor }) {
  const { rows } = await client.query(
    `UPDATE discussion_threads
        SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [threadId],
  );
  if (!rows[0]) throw notFound('Thread not found');
  return rows[0];
}

/**
 * Tells the people who should know.
 *
 * The person being asked always hears about it. Everyone else who has spoken in
 * the thread hears about replies, because a conversation nobody is told about is
 * a conversation that stops.
 */
export async function notifyThread(client, { thread, actor, body, entityLabel, taskId, objectiveId }) {
  const meta = KIND_META[thread.kind] || KIND_META.discussion;
  const recipients = new Set();

  if (thread.awaiting_user) recipients.add(thread.awaiting_user);
  if (thread.opened_by) recipients.add(thread.opened_by);

  const { rows } = await client.query(
    'SELECT DISTINCT author_id FROM discussion_messages WHERE thread_id = $1 AND author_id IS NOT NULL',
    [thread.id],
  );
  for (const row of rows) recipients.add(row.author_id);

  // nobody needs telling about their own message
  recipients.delete(actor.id);

  for (const userId of recipients) {
    await notify(client, {
      userId,
      type: thread.kind === 'review' ? 'review' : 'comment',
      title: `${meta.label} on ${entityLabel}`,
      body: body.slice(0, 140),
      taskId: taskId ?? null,
      objectiveId: objectiveId ?? null,
    });
  }
}

/**
 * Whether an item has an open review holding it back.
 * Always false unless an admin has turned blocking on.
 */
export async function blockedByReview(entityType, entityId) {
  if (!(await reviewsBlock())) return false;
  const { rows } = await query(
    `SELECT 1 FROM discussion_threads
      WHERE entity_type = $1 AND entity_id = $2 AND kind = 'review' AND status = 'open' LIMIT 1`,
    [entityType, entityId],
  );
  return rows.length > 0;
}

export function assertNotBlocked(blocked, what) {
  if (blocked) {
    throw forbidden(
      `${what} has an open review asking for changes. Resolve the review first, or ask an admin to turn off review blocking.`,
    );
  }
}
