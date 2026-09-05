/**
 * Adds a second person, a repeating task with a routine, and a couple of review
 * threads to the LOCAL DEV database, so the discussion screens can be looked at
 * with something real in them. Development aid only.
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

token = (await call('POST', '/auth/login', { email: 'admin@ekosight.com', password: 'ChangeMe123!' })).token;

const { users } = await call('GET', '/users');
let asha = users.find((u) => u.email === 'asha@ekosight.local');
if (!asha) {
  const { departments } = await call('GET', '/departments');
  const dept = departments.find((d) => /market/i.test(d.name)) || departments[0];
  asha = (await call('POST', '/users', {
    full_name: 'Asha Kulkarni',
    email: 'asha@ekosight.local',
    password: 'Welcome123!',
    role: 'member',
    department_id: dept.id,
    job_title: 'Field lead',
  })).user;
}

const { objectives } = await call('GET', '/objectives?limit=50');
const goal = objectives[0];
const detail = await call('GET', `/objectives/${goal.id}`);
const dept = goal.department_id;

// a review on the goal, and one on its vaguest key result
const vague = detail.key_results.find((k) => k.needs_target) || detail.key_results[1];

if (!detail.threads?.length) {
  await call('POST', '/threads', {
    entity_type: 'OBJECTIVE',
    entity_id: goal.id,
    kind: 'review',
    title: 'What does "the default" mean here?',
    body: 'The goal reads well but nobody can tell when it is met. Say what share of farmers '
      + 'counts as "default", and over what window we measure it.',
  });

  await call('POST', '/threads', {
    entity_type: 'KEY_RESULT',
    entity_id: vague.id,
    kind: 'review',
    title: 'Needs a number and a date',
    body: 'This is a direction, not a result. How many dealers, signed by when, and counted from '
      + 'which list?',
  });
}

// a repeating task with a routine and a one-off, plus a blocked person
const daily = (await call('POST', '/tasks', {
  title: 'Run the morning advisory desk',
  description: 'Open the queue, clear yesterday’s escalations, publish the daily bulletin.',
  department_id: dept,
  assignee_id: asha.id,
  recurrence: 'weekdays',
  // no deadline: it is filled in
})).task;

for (const step of ['Clear the overnight queue', 'Publish the daily bulletin']) {
  await call('POST', '/tasks', {
    title: step,
    department_id: dept,
    assignee_id: asha.id,
    parent_task_id: daily.id,
    repeats_with_parent: true,
    due_date: daily.due_date,
  });
}
await call('POST', '/tasks', {
  title: 'Chase the SMS gateway outage (one-off)',
  department_id: dept,
  assignee_id: asha.id,
  parent_task_id: daily.id,
  due_date: daily.due_date,
});

await call('POST', '/threads', {
  entity_type: 'TASK',
  entity_id: daily.id,
  kind: 'progress',
  body: 'Queue cleared by 09:20 all week. The bulletin is the slow part — the template needs work.',
});

console.log(`goal /goals/${goal.id} · daily task ${daily.ref} (${daily.id}) due ${daily.due_date}`);
