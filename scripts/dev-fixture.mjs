/**
 * Builds a realistic goal in the LOCAL DEV database through the ordinary API,
 * so the Goal screens can be looked at in a state that resembles real use.
 *
 * Everything here goes through the same endpoints the UI calls — nothing is
 * written straight to the tables — so the fixture cannot end up in a shape the
 * app itself could not produce. It is a development aid, never run against
 * anything but a local database.
 */

const API = process.env.API || 'http://localhost:4000/api/taskflow';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@ekosight.com';
const PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

let token = null;

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
};

const day = 86400000;
const isoDate = (offset) => {
  const d = new Date(Date.now() + offset * day);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dueAt = (offset) => new Date(Date.now() + offset * day).toISOString();

const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
token = login.token;

const { users } = await call('GET', '/users');
const { departments } = await call('GET', '/departments');
const dept = departments.find((d) => /growth|sales|market/i.test(d.name)) || departments[0];
const { statuses } = await call('GET', '/statuses');
const todo = statuses.find((s) => s.stage === 'todo');
const doing = statuses.find((s) => s.stage === 'in_progress') || todo;
const done = statuses.find((s) => s.stage === 'done');

const me = users[0];
console.log(`fixture: ${dept.name} / ${me.full_name}`);

const TITLE = 'Make advisory the default for 10,000 farmers';

// running this twice should not leave two of the same goal side by side
for (const existing of (await call('GET', '/objectives?limit=200')).objectives) {
  if (existing.title === TITLE) {
    await call('DELETE', `/objectives/${existing.id}`);
    console.log(`archived the previous fixture goal ${existing.id}`);
  }
}

// a quarter that is two thirds gone, so pace has something to say
const objective = (await call('POST', '/objectives', {
  title: TITLE,
  description:
    'Farmers stay with us when the advice arrives before they need it. This quarter is about '
    + 'getting the advisory habit established across the three districts we already serve, rather '
    + 'than opening new ones.',
  scope_type: 'DEPARTMENT',
  department_id: dept.id,
  owner_user_id: me.id,
  start_date: isoDate(-60),
  end_date: isoDate(30),
  status: 'ACTIVE',
})).objective;

const goalId = objective.id;
console.log(`goal ${goalId}`);

const addKr = (body) => call('POST', `/objectives/${goalId}/key-results`, body);

// on track, recently updated
await addKr({
  title: 'Onboard 6,000 farmers onto weekly advisory',
  owner_user_id: me.id,
  measurement_type: 'NUMBER',
  baseline_value: 1200,
  target_value: 6000,
  current_value: 4400,
  unit: 'farmers',
  weight: 2,
});

// behind, and gone quiet
await addKr({
  title: 'Sign 40 dealers as advisory distribution points',
  owner_user_id: me.id,
  measurement_type: 'NUMBER',
  baseline_value: 6,
  target_value: 40,
  current_value: 13,
  unit: 'dealers',
  weight: 1,
});

// money
await addKr({
  title: 'Reach ₹25,00,000 in advisory subscription revenue',
  owner_user_id: me.id,
  measurement_type: 'CURRENCY',
  baseline_value: 0,
  target_value: 2500000,
  current_value: 1650000,
  unit: '₹',
  weight: 1.5,
});

// a percentage heading downwards
await addKr({
  title: 'Cut advisory churn to 4%',
  owner_user_id: me.id,
  measurement_type: 'PERCENTAGE',
  direction: 'DECREASE',
  baseline_value: 11,
  target_value: 4,
  current_value: 7.5,
  weight: 1,
});

// yes/no, already done
await addKr({
  title: 'Launch the Marathi voice advisory',
  owner_user_id: me.id,
  measurement_type: 'BINARY',
  weight: 1,
});

// measured by its work
const rollup = (await addKr({
  title: 'Ship the monsoon advisory calendar',
  owner_user_id: me.id,
  measurement_type: 'TASK_ROLLUP',
  weight: 1,
})).key_results.at(-1);

const { key_results: keyResults } = await call('GET', `/objectives/${goalId}`);
const byTitle = (fragment) => keyResults.find((k) => k.title.includes(fragment));

// real work, linked to the numbers it moves
const work = [
  ['Print the district dealer pack', 'Ship the monsoon', -6, done],
  ['Record the Marathi advisory scripts', 'Ship the monsoon', -2, done],
  ['Design the monsoon calendar artwork', 'Ship the monsoon', 4, doing],
  ['Field-test the calendar with 20 farmers', 'Ship the monsoon', 9, todo],
  ['Visit the Nashik dealer cluster', 'Sign 40 dealers', -4, todo],
  ['Draft the dealer commission sheet', 'Sign 40 dealers', 6, doing],
  ['Call the 30 churned subscribers', 'Cut advisory churn', 3, doing],
];

// a task cannot be created already late — the API refuses a deadline in the
// past, on purpose — so the ones meant to be overdue are created properly and
// then aged, exactly as the tests do it
const { query, closePool } = await import('../server/src/db/pool.js');

for (const [title, krFragment, dueOffset, status] of work) {
  const task = (await call('POST', '/tasks', {
    title,
    department_id: dept.id,
    assignee_id: me.id,
    status_id: todo.id,
    due_date: dueAt(Math.abs(dueOffset)),
    priority: dueOffset < 0 ? 'high' : 'medium',
  })).task;

  await call('POST', `/key-results/${byTitle(krFragment).id}/tasks`, { task_id: task.id, is_primary: true });

  if (status.id !== todo.id) {
    await call('POST', `/tasks/${task.id}/move`, {
      status_id: status.id,
      completion_note: status.stage === 'done' ? 'Delivered and signed off' : undefined,
    });
  }

  if (dueOffset < 0) {
    await query(`UPDATE tasks SET due_date = now() - ($1 || ' days')::interval WHERE id = $2`,
      [Math.abs(dueOffset), task.id]);
  }
}

// a couple of updates, so the history and the "last updated" line have content
await call('POST', `/key-results/${byTitle('Onboard 6,000').id}/check-ins`, {
  current_value: 4400,
  confidence: 'HIGH',
  note: 'The Nashik field day added 620 in one weekend. The pattern holds where a dealer hosts it.',
  next_action: 'Repeat the format in Dhule and Jalgaon',
});

await call('POST', `/key-results/${byTitle('Reach ₹25').id}/check-ins`, {
  current_value: 1650000,
  confidence: 'MEDIUM',
  note: 'Renewals are steady; new subscriptions are behind because dealer signup is behind.',
});

await call('POST', `/key-results/${byTitle('Launch the Marathi').id}/check-ins`, {
  current_value: 1,
  confidence: 'HIGH',
  note: 'Live since Tuesday, 900 calls in the first three days.',
});

// the goal has been running two months, so its key results were not created
// today either — otherwise every "never updated" reading is about the fixture
// rather than about the goal
await query(
  `UPDATE key_results SET created_at = now() - interval '55 days' WHERE objective_id = $1`,
  [goalId],
);

await closePool();
console.log(`done — /goals/${goalId}`);
