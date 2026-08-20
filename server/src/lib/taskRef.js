import { badRequest } from './errors.js';

/**
 * Allocates the next task reference for a department (e.g. MKT-14).
 *
 * Two mechanisms, and both are needed:
 *
 * 1. The department row is locked FOR UPDATE first, so two transactions
 *    allocating a reference for the same department serialise instead of both
 *    reading the same MAX(...) and colliding on the unique tasks.ref index.
 *    Without this lock the probe below is racy too — two callers can find the
 *    same free candidate before either has inserted.
 * 2. The probe skips over references that already exist, which MAX(...) alone
 *    can land on when the numbering has gaps or a department key has changed.
 *
 * Every path that creates a task must go through here.
 */
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
