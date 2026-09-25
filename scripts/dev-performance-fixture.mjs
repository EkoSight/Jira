/**
 * Gives someone a month of realistic work — finished late, finished on time,
 * still overdue — so the review screens have something true to open up.
 * Development aid only.
 */
const API = 'http://localhost:4000/api/taskflow';
let token = null;

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
};

const day = 86_400_000;
const dueAt = (days) => new Date(Date.now() + days * day).toISOString();

token = (await call('POST', '/auth/login', { email: 'admin@ekosight.com', password: 'ChangeMe123!' })).token;

const { users } = await call('GET', '/users');
let person = users.find((u) => u.email === 'vartika@ekosight.local');
const { departments } = await call('GET', '/departments');
const dept = departments.find((d) => /sales|market/i.test(d.name)) || departments[0];
if (!person) {
  person = (await call('POST', '/users', {
    full_name: 'Vartika Gupta',
    email: 'vartika@ekosight.local',
    password: 'Welcome123!',
    role: 'member',
    department_id: dept.id,
    job_title: 'Chief of Staff',
  })).user;
}

const { statuses } = await call('GET', '/statuses');
const todo = statuses.find((s) => s.stage === 'todo');
const doing = statuses.find((s) => s.stage === 'in_progress') || todo;
const done = statuses.find((s) => s.stage === 'done');

const { query, closePool } = await import('../server/src/db/pool.js');

const age = async (id, { due, completed, created }) => {
  if (created !== undefined) {
    await query(`UPDATE tasks SET created_at = now() - ($1 || ' days')::interval WHERE id = $2`,
      [created, id]);
  }
  if (due !== undefined) {
    await query(
      `UPDATE tasks SET due_date = now() - ($1 || ' days')::interval,
                        original_due_date = now() - ($1 || ' days')::interval
        WHERE id = $2`, [due, id]);
  }
  if (completed !== undefined) {
    await query(`UPDATE tasks SET completed_at = now() - ($1 || ' days')::interval WHERE id = $2`,
      [completed, id]);
  }
};

// finished late, with a real account of what happened
const late = [
  ['Send the Q3 board pack', 9, 4, 'critical',
    'Pack went out Thursday. Held up waiting on the finance annexure, which arrived two days late.'],
  ['Close the vendor comparison', 14, 11, 'high',
    'Compared four vendors, recommended Agrotech. Took longer because two of them re-quoted.'],
  ['Chase the pending dealer agreements', 6, 3, 'critical',
    'Six of eight signed. The last two are with their legal teams.'],
];
for (const [title, due, completed, priority, note] of late) {
  const task = (await call('POST', '/tasks', {
    title, department_id: dept.id, assignee_id: person.id, status_id: todo.id,
    priority, due_date: dueAt(2),
    description: 'Needed before the quarterly review.',
  })).task;
  await age(task.id, { due, created: due + 7 });
  await call('POST', `/tasks/${task.id}/comments`, { body: 'Started on this — waiting on one input.' });
  await call('POST', `/tasks/${task.id}/move`, { status_id: done.id, completion_note: note });
  await age(task.id, { completed });
}

// finished on time
for (const [title, due] of [['Publish the monthly digest', 3], ['Book the field-day venue', 8]]) {
  const task = (await call('POST', '/tasks', {
    title, department_id: dept.id, assignee_id: person.id, status_id: todo.id,
    due_date: dueAt(2), priority: 'medium',
  })).task;
  await age(task.id, { due, created: due + 5 });
  await call('POST', `/tasks/${task.id}/move`, {
    status_id: done.id, completion_note: 'Done and circulated.',
  });
  await age(task.id, { completed: due + 1 });
}

// still overdue right now
const overdue = [
  ['Reconcile the Q2 travel claims', 12, 'high'],
  ['Draft the partner MoU template', 7, 'critical'],
  ['Collect the district-wise sales split', 4, 'medium'],
];
for (const [title, due, priority] of overdue) {
  const task = (await call('POST', '/tasks', {
    title, department_id: dept.id, assignee_id: person.id, status_id: doing.id,
    due_date: dueAt(3), priority,
  })).task;
  await age(task.id, { due });
}

await closePool();
console.log(`done — /performance/${person.id}`);
