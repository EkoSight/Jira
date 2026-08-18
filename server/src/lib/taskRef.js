import { badRequest } from './errors.js';

export async function nextTaskRef(client, departmentId) {
  const { rows } = await client.query('SELECT key FROM departments WHERE id = $1 FOR UPDATE', [
    departmentId,
  ]);

  if (!rows[0]) throw badRequest('Department not found');

  const departmentKey = rows[0].key;

  const { rows: seq } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(ref, '^.*-', ''), '')::int), 0) + 1 AS next
       FROM tasks WHERE department_id = $1`,
    [departmentId],
  );

  let next = seq[0].next;

  while (true) {
    const candidate = `${departmentKey}-${next}`;

    const { rows: existing } = await client.query(
      'SELECT 1 FROM tasks WHERE ref = $1 LIMIT 1',
      [candidate],
    );

    if (existing.length === 0) {
      return candidate;
    }

    next += 1;
  }
}