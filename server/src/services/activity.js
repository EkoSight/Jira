import { query } from '../db/pool.js';

export async function logActivity(client, { taskId, actorId, action, field = null, from = null, to = null, meta = {} }) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO task_activity (task_id, actor_id, action, field, from_value, to_value, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, actorId, action, field, from === null ? null : String(from), to === null ? null : String(to), meta],
  );
}

export async function notify(
  client,
  { userId, type, title, body = null, taskId = null, objectiveId = null, accountId = null },
) {
  if (!userId) return;
  const runner = client || { query };
  // the same notice to the same person moments apart is one notice: a double
  // submit, or two paths reporting one event, must not ping them twice
  const { rows: recent } = await runner.query(
    `SELECT 1 FROM notifications
      WHERE user_id = $1 AND type = $2 AND title = $3 AND body IS NOT DISTINCT FROM $4
        AND task_id IS NOT DISTINCT FROM $5 AND objective_id IS NOT DISTINCT FROM $6
        AND account_id IS NOT DISTINCT FROM $7
        AND created_at > now() - interval '10 minutes'
      LIMIT 1`,
    [userId, type, title, body, taskId, objectiveId, accountId],
  );
  if (recent.length) return;
  await runner.query(
    `INSERT INTO notifications (user_id, type, title, body, task_id, objective_id, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, type, title, body, taskId, objectiveId, accountId],
  );
}
