import { badRequest } from './errors.js';

/**
 * Allocates the next task reference for a department (e.g. MKT-14).
 *
 * The department row is locked FOR UPDATE first, so two transactions allocating a
 * reference for the same department serialise instead of both reading the same
 * MAX(...) and colliding on the unique tasks.ref index. Every path that creates a
 * task must go through here — a path that skips the lock reintroduces the race.
 */
export async function nextTaskRef(client, departmentId) {
  const { rows } = await client.query('SELECT key FROM departments WHERE id = $1 FOR UPDATE', [
    departmentId,
  ]);
  if (!rows[0]) throw badRequest('Department not found');

  const { rows: seq } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(ref, '^.*-', ''), '')::int), 0) + 1 AS next
       FROM tasks WHERE department_id = $1`,
    [departmentId],
  );

  return `${rows[0].key}-${seq[0].next}`;
}
