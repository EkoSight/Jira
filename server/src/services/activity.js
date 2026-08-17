import { query } from '../db/pool.js';

export async function logActivity(client, { taskId, actorId, action, field = null, from = null, to = null, meta = {} }) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO task_activity (task_id, actor_id, action, field, from_value, to_value, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, actorId, action, field, from === null ? null : String(from), to === null ? null : String(to), meta],
  );
}

export async function notify(client, { userId, type, title, body = null, taskId = null, objectiveId = null }) {
  if (!userId) return;
  const runner = client || { query };
  await runner.query(
    `INSERT INTO notifications (user_id, type, title, body, task_id, objective_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, type, title, body, taskId, objectiveId],
  );
}
