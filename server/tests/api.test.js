/**
 * End to end tests against a real postgres database.
 *
 * `npm test` loads .env.test, which points DB_SCHEMA at taskflow_test so the
 * suite never touches working data. Tests skip cleanly with no database.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { pool, query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { runBlackMarkScan, monthlyReview } from '../src/services/blackmarks.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

const call = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};

const daysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString();

before(async () => {
  // guard against ever pointing the destructive setup at a working schema
  assert.match(
    config.db.schema,
    /test/,
    'refusing to run: DB_SCHEMA must contain "test" (run via `npm test`, which loads .env.test)',
  );

  try {
    await query('SELECT 1');
  } catch {
    available = false;
    console.log('[tests] no database reachable — skipping API tests');
    return;
  }

  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(
    `INSERT INTO departments (key, name, color, position) VALUES ('TST', 'Testing', '#2a78d6', 1)`,
  );
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE),
      ('In Progress', 'in-progress', 'in_progress', '#f59e0b', 2, FALSE),
      ('Done', 'done', 'done', '#22c55e', 3, FALSE)`,
  );

  const password = await hashPassword('Password123!');
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'TST'`);
  ids.department = dept[0].id;

  const { rows: admin } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, must_change_password)
     VALUES ('Admin User', 'admin@test.local', $1, 'admin', FALSE) RETURNING id`,
    [password],
  );
  const { rows: member } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
     VALUES ('Member User', 'member@test.local', $1, 'member', $2, FALSE) RETURNING id`,
    [password, ids.department],
  );
  ids.admin = admin[0].id;
  ids.member = member[0].id;

  const { rows: statuses } = await query('SELECT id, slug FROM workflow_statuses ORDER BY position');
  ids.todo = statuses[0].id;
  ids.inProgress = statuses[1].id;
  ids.done = statuses[2].id;

  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) {
    await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  }
  await closePool().catch(() => {});
});

const skipIfUnavailable = (t) => {
  if (!available) {
    t.skip('no database');
    return true;
  }
  return false;
};

test('rejects a bad password and issues a token for a good one', async (t) => {
  if (skipIfUnavailable(t)) return;

  const bad = await call('POST', '/auth/login', { body: { email: 'admin@test.local', password: 'nope' } });
  assert.equal(bad.status, 401);

  const good = await call('POST', '/auth/login', {
    body: { email: 'admin@test.local', password: 'Password123!' },
  });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);
  assert.equal(good.body.user.role, 'admin');
  tokens.admin = good.body.token;

  const memberLogin = await call('POST', '/auth/login', {
    body: { email: 'member@test.local', password: 'Password123!' },
  });
  tokens.member = memberLogin.body.token;
});

test('protected routes need a token', async (t) => {
  if (skipIfUnavailable(t)) return;
  const anonymous = await call('GET', '/tasks');
  assert.equal(anonymous.status, 401);
});

test('creates a task with a department-prefixed reference', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/tasks', {
    token: tokens.admin,
    body: {
      title: 'Prepare the vendor comparison',
      department_id: ids.department,
      priority: 'high',
      assignee_id: ids.member,
      due_date: daysFromNow(3),
      estimate_hours: 6,
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.task.ref, 'TST-1');
  assert.equal(created.body.task.status_name, 'To Do');
  assert.equal(created.body.task.assignee_id, ids.member);
  ids.task = created.body.task.id;

  const second = await call('POST', '/tasks', {
    token: tokens.admin,
    body: { title: 'A second card', department_id: ids.department, assignee_id: ids.member },
  });
  assert.equal(second.body.task.ref, 'TST-2', 'references increment per department');
  ids.secondTask = second.body.task.id;
});

test('rejects a task with no title', async (t) => {
  if (skipIfUnavailable(t)) return;
  const result = await call('POST', '/tasks', {
    token: tokens.admin,
    body: { title: 'x', department_id: ids.department },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Validation failed');
});

test('rejects a task with no owner', async (t) => {
  if (skipIfUnavailable(t)) return;
  const result = await call('POST', '/tasks', {
    token: tokens.admin,
    body: { title: 'Nobody owns this', department_id: ids.department },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /task owner is required/i);
});

test('a member cannot reassign someone else’s work', async (t) => {
  if (skipIfUnavailable(t)) return;
  const result = await call('PATCH', `/tasks/${ids.task}`, {
    token: tokens.member,
    body: { assignee_id: ids.admin },
  });
  assert.equal(result.status, 403);
});

test('moving a card to a done status stamps completion, and reopening clears it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const done = await call('POST', `/tasks/${ids.secondTask}/move`, {
    token: tokens.admin,
    body: { status_id: ids.done },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.progress, 100);
  assert.ok(done.body.task.completed_at);

  const reopened = await call('POST', `/tasks/${ids.secondTask}/move`, {
    token: tokens.admin,
    body: { status_id: ids.inProgress },
  });
  assert.equal(reopened.body.task.completed_at, null);

  const detail = await call('GET', `/tasks/${ids.secondTask}`, { token: tokens.admin });
  const actions = detail.body.activity.map((a) => a.action);
  assert.ok(actions.includes('completed'));
  assert.ok(actions.includes('reopened'));
});

test('changing the deadline is counted and the original is kept', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('PATCH', `/tasks/${ids.task}`, {
    token: tokens.admin,
    body: { due_date: daysFromNow(10) },
  });
  const detail = await call('GET', `/tasks/${ids.task}`, { token: tokens.admin });
  assert.equal(detail.body.task.due_date_changes, 1);
  assert.ok(detail.body.task.original_due_date);
});

test('a WIP limit blocks an over-full column', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('PATCH', `/statuses/${ids.inProgress}`, { token: tokens.admin, body: { wip_limit: 1 } });
  const blocked = await call('POST', `/tasks/${ids.task}/move`, {
    token: tokens.admin,
    body: { status_id: ids.inProgress },
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /WIP limit/);
  await call('PATCH', `/statuses/${ids.inProgress}`, { token: tokens.admin, body: { wip_limit: null } });
});

test('black marks are recorded once per rule and task, however often the scan runs', async (t) => {
  if (skipIfUnavailable(t)) return;

  const rule = await call('POST', '/blackmarks/rules', {
    token: tokens.admin,
    body: { name: 'Missed deadline', trigger_type: 'deadline_missed', points: 1, grace_hours: 0 },
  });
  assert.equal(rule.status, 201);

  // a task that is already past its deadline
  const overdue = await call('POST', '/tasks', {
    token: tokens.admin,
    body: {
      title: 'This one slipped',
      department_id: ids.department,
      assignee_id: ids.member,
      due_date: daysFromNow(-5),
    },
  });

  const first = await runBlackMarkScan();
  const second = await runBlackMarkScan();
  const third = await runBlackMarkScan();

  assert.equal(first.created.length, 1, 'first scan records the breach');
  assert.equal(second.created.length, 0, 'repeat scans are idempotent');
  assert.equal(third.created.length, 0);
  assert.equal(first.created[0].user_id, ids.member);
  assert.equal(first.created[0].task_ref, overdue.body.task.ref);
});

test('a rule scoped to critical work ignores lower priorities', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('POST', '/blackmarks/rules', {
    token: tokens.admin,
    body: {
      name: 'Critical only',
      trigger_type: 'deadline_missed',
      points: 5,
      grace_hours: 0,
      priorities: ['critical'],
    },
  });

  const before = await runBlackMarkScan();
  assert.equal(before.created.length, 0, 'the medium priority overdue task does not match');

  await call('POST', '/tasks', {
    token: tokens.admin,
    body: {
      title: 'Critical slip',
      department_id: ids.department,
      assignee_id: ids.member,
      priority: 'critical',
      due_date: daysFromNow(-2),
    },
  });

  const after = await runBlackMarkScan();
  assert.equal(after.created.length, 2, 'both the general and the critical rule fire');
  assert.ok(after.created.some((mark) => Number(mark.points) === 5));
});

test('a grace period holds the mark back until it expires', async (t) => {
  if (skipIfUnavailable(t)) return;

  await query(`UPDATE blackmark_rules SET is_active = FALSE`);
  await call('POST', '/blackmarks/rules', {
    token: tokens.admin,
    body: { name: 'Two day grace', trigger_type: 'deadline_missed', points: 1, grace_hours: 48 },
  });

  const fresh = await call('POST', '/tasks', {
    token: tokens.admin,
    body: {
      title: 'Only just late',
      department_id: ids.department,
      assignee_id: ids.member,
      due_date: daysFromNow(-1),
    },
  });

  const within = await runBlackMarkScan();
  assert.equal(
    within.created.filter((m) => m.task_ref === fresh.body.task.ref).length,
    0,
    'still inside the grace window',
  );

  const later = await runBlackMarkScan({ now: new Date(Date.now() + 3 * 86400000) });
  assert.ok(
    later.created.some((m) => m.task_ref === fresh.body.task.ref),
    'recorded once the grace window has passed',
  );
});

test('the monthly review counts points and flags people over the limit', async (t) => {
  if (skipIfUnavailable(t)) return;

  const review = await monthlyReview({});
  const member = review.members.find((m) => m.user_id === ids.member);

  assert.ok(member, 'the member appears in the review');
  assert.ok(member.total_points > 0);
  assert.ok(member.missed_deadlines >= 1);
  assert.equal(typeof member.over_limit, 'boolean');
  assert.ok(['ok', 'warning', 'critical'].includes(member.severity));
});

test('waiving a black mark takes it out of the active total', async (t) => {
  if (skipIfUnavailable(t)) return;

  const marks = await call('GET', '/blackmarks', { token: tokens.admin });
  // the grace-period test deliberately scans with a future clock, and those marks
  // land outside the current review window — pick one that is actually counted
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const target = marks.body.marks.find(
    (m) =>
      m.status === 'active' &&
      new Date(m.occurred_at) >= monthStart &&
      new Date(m.occurred_at) <= new Date(),
  );
  assert.ok(target, 'expected at least one active mark inside the current month');

  const before = await monthlyReview({});
  const beforePoints = before.members.find((m) => m.user_id === target.user_id).total_points;

  const waived = await call('POST', `/blackmarks/${target.id}/waive`, {
    token: tokens.admin,
    body: { reason: 'Deadline moved by the customer' },
  });
  assert.equal(waived.status, 200);
  assert.equal(waived.body.mark.status, 'waived');

  const after = await monthlyReview({});
  const afterPoints = after.members.find((m) => m.user_id === target.user_id).total_points;
  assert.equal(afterPoints, beforePoints - Number(target.points));
});

test('a member cannot waive black marks or see other people’s', async (t) => {
  if (skipIfUnavailable(t)) return;

  const marks = await call('GET', '/blackmarks', { token: tokens.member });
  assert.equal(marks.status, 200);
  assert.ok(marks.body.marks.every((mark) => mark.user_id === ids.member));

  const attempt = await call('POST', `/blackmarks/${marks.body.marks[0].id}/waive`, {
    token: tokens.member,
    body: { reason: 'let me off' },
  });
  assert.equal(attempt.status, 403);
});

test('adding a team member returns a one-time password and applies role defaults', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/users', {
    token: tokens.admin,
    body: {
      full_name: 'New Joiner',
      email: 'joiner@test.local',
      role: 'member',
      department_id: ids.department,
    },
  });

  assert.equal(created.status, 201);
  assert.ok(created.body.temporary_password);
  assert.equal(created.body.user.must_change_password, true);
  assert.ok(created.body.user.permissions.includes('task.create'));
  assert.ok(!created.body.user.permissions.includes('user.permissions'));

  const login = await call('POST', '/auth/login', {
    body: { email: 'joiner@test.local', password: created.body.temporary_password },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.must_change_password, true);
});

test('a member cannot add people or hand out permissions', async (t) => {
  if (skipIfUnavailable(t)) return;

  const attempt = await call('POST', '/users', {
    token: tokens.member,
    body: { full_name: 'Sneaky Admin', email: 'sneaky@test.local', role: 'admin' },
  });
  assert.equal(attempt.status, 403);
});

test('the last active admin cannot be demoted or deactivated', async (t) => {
  if (skipIfUnavailable(t)) return;

  const demote = await call('PATCH', `/users/${ids.admin}`, {
    token: tokens.admin,
    body: { role: 'member' },
  });
  assert.equal(demote.status, 400);
  assert.match(demote.body.error, /admin must remain/);
});

test('the dashboard reports overdue, critical and unassigned counts', async (t) => {
  if (skipIfUnavailable(t)) return;

  const dashboard = await call('GET', '/reports/dashboard', { token: tokens.admin });
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.summary.total > 0);
  assert.ok(dashboard.body.summary.overdue >= 1);
  assert.ok(Array.isArray(dashboard.body.workload));
  assert.ok(Array.isArray(dashboard.body.trend));
  assert.equal(dashboard.body.trend.length, 14);

  const memberRow = dashboard.body.workload.find((w) => w.id === ids.member);
  assert.ok(memberRow.open_tasks > 0);
  assert.ok(['idle', 'available', 'busy', 'overloaded', 'stalled'].includes(memberRow.status));
});

test('workload reports the basis it measured load from, so the meter caption matches', async (t) => {
  if (skipIfUnavailable(t)) return;

  // give a member several open tasks with no hour estimates, so load is by count
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'TST'`);
  const { rows: statusRows } = await query(`SELECT id FROM workflow_statuses WHERE stage = 'in_progress' LIMIT 1`);
  const { rows: victim } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, department_id, weekly_capacity_hours, max_concurrent_tasks, must_change_password)
     VALUES ('Loaded Person', 'loaded@test.local', $1, 'member', $2, 40, 3, FALSE) RETURNING id`,
    [await hashPassword('Password123!'), dept[0].id],
  );

  for (let i = 0; i < 5; i += 1) {
    await query(
      `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, priority)
       VALUES ($1, $2, $3, $4, $5, $5, 'medium')`,
      [`LOAD-${i}`, `No estimate ${i}`, dept[0].id, statusRows[0].id, victim[0].id],
    );
  }

  const dashboard = await call('GET', '/reports/workload', { token: tokens.admin });
  const row = dashboard.body.workload.find((w) => w.id === victim[0].id);

  assert.equal(row.load_basis, 'tasks', 'no estimates → load measured by task count');
  assert.equal(row.committed_hours, 0, 'and committed hours is genuinely zero');
  assert.ok(row.open_tasks >= 5);
  // 5 open against a comfort of 3 is over capacity, and it is the task count, not
  // the (zero) hours, that says so — the client caption must therefore be task-based
  assert.equal(row.status, 'overloaded');

  // now add an estimate and the basis flips to hours
  await query(`UPDATE tasks SET estimate_hours = 4 WHERE assignee_id = $1`, [victim[0].id]);
  const after = await call('GET', '/reports/workload', { token: tokens.admin });
  const updated = after.body.workload.find((w) => w.id === victim[0].id);
  assert.equal(updated.load_basis, 'hours');
  assert.ok(updated.committed_hours > 0);
});

test('settings round trip and drive the review thresholds', async (t) => {
  if (skipIfUnavailable(t)) return;

  const saved = await call('PUT', '/settings/blackmarks', {
    token: tokens.admin,
    body: { value: { missedDeadlineLimit: 1 } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.blackmarks.missedDeadlineLimit, 1);
  assert.equal(saved.body.settings.blackmarks.warningPoints, 3, 'untouched keys keep their defaults');

  const review = await monthlyReview({});
  const member = review.members.find((m) => m.user_id === ids.member);
  assert.equal(member.over_limit, member.missed_deadlines > 1);
});

test('an unknown settings key is rejected', async (t) => {
  if (skipIfUnavailable(t)) return;
  const result = await call('PUT', '/settings/nonsense', { token: tokens.admin, body: { value: 1 } });
  assert.equal(result.status, 400);
});

test('comments are recorded against the task', async (t) => {
  if (skipIfUnavailable(t)) return;

  const posted = await call('POST', `/tasks/${ids.task}/comments`, {
    token: tokens.member,
    body: { body: 'Vendor quotes are in.' },
  });
  assert.equal(posted.status, 201);

  const detail = await call('GET', `/tasks/${ids.task}`, { token: tokens.admin });
  assert.equal(detail.body.comments.length, 1);
  assert.equal(detail.body.comments[0].body, 'Vendor quotes are in.');
});

test('a setup problem answers with the fix, not a bare 500', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { errorHandler } = await import('../src/middleware/error.js');
  const cases = [
    [{ code: '42P01' }, /npm run migrate/],
    [{ code: 'ECONNREFUSED' }, /Is the database running/],
    [{ code: '3D000' }, /createdb/],
    [{ code: '28P01' }, /PGUSER and PGPASSWORD/],
    // Windows resolves localhost to both ::1 and 127.0.0.1, so a refused
    // connection arrives wrapped in an AggregateError with an empty message
    [new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })]), /Is the database running/],
  ];

  for (const [error, expected] of cases) {
    let status;
    let payload;
    const res = {
      status(code) {
        status = code;
        return this;
      },
      json(body) {
        payload = body;
      },
    };
    errorHandler(error, {}, res, () => {});
    assert.equal(status, 503, `${error.code || 'AggregateError'} should be a 503`);
    assert.match(payload.error, expected);
    assert.equal(payload.setup_required, true);
    assert.ok(!payload.error.includes('\n'), 'the UI message stays on one line');
  }
});

test('an error explanation is never empty, whatever the shape of the error', async (t) => {
  const { describeError } = await import('../src/lib/dbErrors.js');

  assert.equal(describeError(new Error('plain')), 'plain');
  assert.equal(describeError({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(
    describeError(new AggregateError([new Error('inner cause')])),
    'inner cause',
    'AggregateError reports its first inner error rather than an empty string',
  );
  assert.ok(describeError(new AggregateError([])).length > 0);
  assert.ok(describeError(undefined).length > 0);
});

// ---------------------------------------------------------------- collaboration

test('a tagged person sees a task from another department', async (t) => {
  if (skipIfUnavailable(t)) return;

  // a second department with its own member, who shares nothing with ids.department
  await query(`INSERT INTO departments (key, name, position) VALUES ('OTH', 'Other Team', 2)`);
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'OTH'`);
  const { rows: outsider } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
     VALUES ('Outside Person', 'outsider@test.local', $1, 'member', $2, FALSE) RETURNING id`,
    [await hashPassword('Password123!'), dept[0].id],
  );
  ids.outsider = outsider[0].id;

  const login = await call('POST', '/auth/login', {
    body: { email: 'outsider@test.local', password: 'Password123!' },
  });
  tokens.outsider = login.body.token;

  const secret = await call('POST', '/tasks', {
    token: tokens.admin,
    body: { title: 'Work in another department', department_id: ids.department, assignee_id: ids.admin },
  });
  const secretId = secret.body.task.id;

  const before = await call('GET', `/tasks/${secretId}`, { token: tokens.outsider });
  assert.equal(before.status, 404, 'not visible before being tagged');

  const tagged = await call('POST', `/tasks/${secretId}/collaborators`, {
    token: tokens.admin,
    body: { user_id: ids.outsider },
  });
  assert.equal(tagged.status, 201);

  const after = await call('GET', `/tasks/${secretId}`, { token: tokens.outsider });
  assert.equal(after.status, 200, 'visible once tagged, despite the department');
  assert.equal(after.body.task.id, secretId);

  const list = await call('GET', '/tasks', { token: tokens.outsider });
  assert.ok(list.body.tasks.some((task) => task.id === secretId), 'and it appears in their list');

  // and it goes away again when the tag is removed
  await call('DELETE', `/tasks/${secretId}/collaborators/${ids.outsider}`, { token: tokens.admin });
  const removed = await call('GET', `/tasks/${secretId}`, { token: tokens.outsider });
  assert.equal(removed.status, 404);
});

test('a task can be created with people already tagged on it', async (t) => {
  if (skipIfUnavailable(t)) return;

  // this is the path the "New task" screen uses, so tagging works at creation
  const created = await call('POST', '/tasks', {
    token: tokens.admin,
    body: {
      title: 'Tagged from the start',
      department_id: ids.department,
      assignee_id: ids.admin,
      collaborator_ids: [ids.member, ids.outsider],
    },
  });
  assert.equal(created.status, 201);

  const detail = await call('GET', `/tasks/${created.body.task.id}`, { token: tokens.admin });
  assert.deepEqual(
    detail.body.collaborators.map((c) => c.id).sort(),
    [ids.member, ids.outsider].sort(),
  );

  // and the outsider can see it immediately, without a second request
  const asOutsider = await call('GET', `/tasks/${created.body.task.id}`, { token: tokens.outsider });
  assert.equal(asOutsider.status, 200);

  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE task_id = $1 AND type = 'tagged'`,
    [created.body.task.id],
  );
  assert.equal(rows[0].n, 2, 'both tagged people are notified');
});

test('the follower can see and move the task, but the owner keeps the black mark', async (t) => {
  if (skipIfUnavailable(t)) return;

  const task = await call('POST', '/tasks', {
    token: tokens.admin,
    body: {
      title: 'Two people on this one',
      department_id: ids.department,
      assignee_id: ids.member,
      follower_id: ids.outsider,
      due_date: daysFromNow(-3),
    },
  });
  const taskId = task.body.task.id;
  assert.equal(task.body.task.follower_name, 'Outside Person');

  const seen = await call('GET', `/tasks/${taskId}`, { token: tokens.outsider });
  assert.equal(seen.status, 200, 'the follower can open it');
  assert.equal(seen.body.can_edit, true, 'and can work on it');

  await query(`UPDATE blackmark_rules SET is_active = FALSE`);
  await call('POST', '/blackmarks/rules', {
    token: tokens.admin,
    body: { name: 'Owner accountability', trigger_type: 'deadline_missed', points: 1, grace_hours: 0 },
  });

  const scan = await runBlackMarkScan();
  const mark = scan.created.find((m) => m.task_id === taskId);
  assert.ok(mark, 'the missed deadline is recorded');
  assert.equal(mark.user_id, ids.member, 'against the owner, not the follower');
});

test('sub tasks drive the parent progress', async (t) => {
  if (skipIfUnavailable(t)) return;

  const parent = await call('POST', '/tasks', {
    token: tokens.admin,
    body: { title: 'Parent with steps', department_id: ids.department, assignee_id: ids.admin },
  });
  const parentId = parent.body.task.id;

  const children = [];
  for (const title of ['Step one', 'Step two', 'Step three', 'Step four']) {
    const child = await call('POST', '/tasks', {
      token: tokens.admin,
      body: { title, department_id: ids.department, parent_task_id: parentId, assignee_id: ids.admin },
    });
    children.push(child.body.task.id);
  }

  const fresh = await call('GET', `/tasks/${parentId}`, { token: tokens.admin });
  assert.equal(fresh.body.subtasks.length, 4);
  assert.equal(fresh.body.task.effective_progress, 0);

  await call('POST', `/tasks/${children[0]}/move`, { token: tokens.admin, body: { status_id: ids.done } });
  await call('POST', `/tasks/${children[1]}/move`, { token: tokens.admin, body: { status_id: ids.done } });

  const halfway = await call('GET', `/tasks/${parentId}`, { token: tokens.admin });
  assert.equal(halfway.body.task.effective_progress, 50, 'two of four done reads as 50%');
  assert.equal(halfway.body.task.subtask_done, 2);
});

test('attachments accept safe links and reject dangerous ones', async (t) => {
  if (skipIfUnavailable(t)) return;

  const good = await call('POST', `/tasks/${ids.task}/attachments/link`, {
    token: tokens.admin,
    body: { url: 'https://docs.google.com/presentation/d/xyz/edit', title: 'Launch deck' },
  });
  assert.equal(good.status, 201);
  assert.equal(good.body.attachment.provider, 'google-slides');

  for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'not a url']) {
    const bad = await call('POST', `/tasks/${ids.task}/attachments/link`, {
      token: tokens.admin,
      body: { url },
    });
    assert.equal(bad.status, 400, `${url} should be rejected`);
  }
});

// ---------------------------------------------------------------- notes

test('notes are private to their owner', async (t) => {
  if (skipIfUnavailable(t)) return;

  const mine = await call('POST', '/notes', {
    token: tokens.member,
    body: { title: 'Private thought', body: 'Only I should see this' },
  });
  assert.equal(mine.status, 201);

  const asOwner = await call('GET', '/notes', { token: tokens.member });
  assert.ok(asOwner.body.notes.some((n) => n.id === mine.body.note.id));

  // even an admin cannot see or touch someone else's notes
  const asAdmin = await call('GET', '/notes', { token: tokens.admin });
  assert.ok(!asAdmin.body.notes.some((n) => n.id === mine.body.note.id), 'admins do not see other people’s notes');

  const edit = await call('PATCH', `/notes/${mine.body.note.id}`, {
    token: tokens.admin,
    body: { title: 'Hijacked' },
  });
  assert.equal(edit.status, 404);

  const remove = await call('DELETE', `/notes/${mine.body.note.id}`, { token: tokens.admin });
  assert.equal(remove.status, 404);
});

// ---------------------------------------------------------------- feature requests

test('anyone can raise a feature request and vote once', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/feature-requests', {
    token: tokens.member,
    body: { title: 'Send reminders on WhatsApp', detail: 'Field staff do not read email', urgency: 'important' },
  });
  assert.equal(created.status, 201);
  const requestId = created.body.request.id;

  const first = await call('POST', `/feature-requests/${requestId}/vote`, { token: tokens.member });
  assert.equal(first.body.request.votes, 1);
  assert.equal(first.body.request.has_voted, true);

  const second = await call('POST', `/feature-requests/${requestId}/vote`, { token: tokens.member });
  assert.equal(second.body.request.votes, 0, 'voting again takes the vote back');

  // only someone with feature.manage may set the status
  const denied = await call('PATCH', `/feature-requests/${requestId}`, {
    token: tokens.member,
    body: { status: 'planned' },
  });
  assert.equal(denied.status, 403);

  const allowed = await call('PATCH', `/feature-requests/${requestId}`, {
    token: tokens.admin,
    body: { status: 'planned', admin_note: 'Good idea — scheduled for next month' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.request.status, 'planned');
});

// ---------------------------------------------------------------- recognition

test('the leaderboard rewards on-time delivery and penalises black marks', async (t) => {
  if (skipIfUnavailable(t)) return;

  const board = await call('GET', '/recognition/leaderboard', { token: tokens.admin });
  assert.equal(board.status, 200);

  const withMarks = board.body.members.find((m) => m.mark_count > 0);
  if (withMarks) {
    assert.ok(withMarks.score < withMarks.done_count + 1, 'black marks pull the score down');
  }

  for (const member of board.body.members) {
    assert.equal(typeof member.score, 'number');
    assert.ok(Number.isFinite(member.score));
  }

  // the board is sorted best first
  const scores = board.body.members.map((m) => m.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('an award notifies the winner and records their stats', async (t) => {
  if (skipIfUnavailable(t)) return;

  const given = await call('POST', '/recognition/awards', {
    token: tokens.admin,
    body: { user_id: ids.member, citation: 'Carried the launch single handed.' },
  });
  assert.equal(given.status, 201);
  assert.equal(given.body.award.user_id, ids.member);
  assert.ok(given.body.award.stats);

  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'recognition'`,
    [ids.member],
  );
  assert.equal(rows[0].n, 1, 'the winner is told');

  // awarding the same month again updates rather than duplicating
  const again = await call('POST', '/recognition/awards', {
    token: tokens.admin,
    body: { user_id: ids.member, citation: 'Updated citation.' },
  });
  assert.equal(again.status, 201);
  const { rows: awards } = await query('SELECT COUNT(*)::int AS n FROM recognitions WHERE user_id = $1', [
    ids.member,
  ]);
  assert.equal(awards[0].n, 1);
});

test('a member cannot award themselves the month', async (t) => {
  if (skipIfUnavailable(t)) return;
  const attempt = await call('POST', '/recognition/awards', {
    token: tokens.member,
    body: { user_id: ids.member, citation: 'I am great' },
  });
  assert.equal(attempt.status, 403);
});

test('kudos go to someone else, never yourself', async (t) => {
  if (skipIfUnavailable(t)) return;

  const valid = await call('POST', '/recognition/kudos', {
    token: tokens.member,
    body: { to_user: ids.admin, message: 'Thanks for unblocking the vendor payment.' },
  });
  assert.equal(valid.status, 201);

  const self = await call('POST', '/recognition/kudos', {
    token: tokens.member,
    body: { to_user: ids.member, message: 'I am wonderful' },
  });
  assert.equal(self.status, 400);
});

test('completing a task stores the outcome note and logs it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/tasks', {
    token: tokens.admin,
    body: { title: 'Needs a sign-off note', department_id: ids.department, assignee_id: ids.member },
  });
  const id = created.body.task.id;

  const done = await call('POST', `/tasks/${id}/move`, {
    token: tokens.member,
    body: { status_id: ids.done, completion_note: 'Verified with the customer and closed the ticket.' },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.completion_note, 'Verified with the customer and closed the ticket.');
  assert.equal(done.body.next_occurrence, null, 'a one-off task spawns nothing');

  const detail = await call('GET', `/tasks/${id}`, { token: tokens.admin });
  const completed = detail.body.activity.find((a) => a.action === 'completed');
  assert.ok(completed, 'a completed entry is logged');
  assert.equal(completed.to_value, 'Verified with the customer and closed the ticket.');
});

test('a recurring task spawns its next occurrence when completed', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/tasks', {
    token: tokens.admin,
    body: {
      title: 'Close the till',
      department_id: ids.department,
      assignee_id: ids.member,
      recurrence: 'daily',
      due_date: daysFromNow(0),
    },
  });
  const id = created.body.task.id;
  assert.equal(created.body.task.recurrence, 'daily');

  const done = await call('POST', `/tasks/${id}/move`, {
    token: tokens.member,
    body: { status_id: ids.done, completion_note: 'Counted and locked up.' },
  });
  assert.ok(done.body.next_occurrence, 'the next occurrence is created');
  assert.notEqual(done.body.next_occurrence.id, id, 'it is a new card');

  // the next card is a fresh, open, un-completed instance that still recurs
  const next = await call('GET', `/tasks/${done.body.next_occurrence.id}`, { token: tokens.admin });
  assert.equal(next.body.task.recurrence, 'daily');
  assert.equal(next.body.task.stage !== 'done', true);
  assert.equal(next.body.task.completed_at, null);
  assert.equal(next.body.task.assignee_id, ids.member, 'same owner carries forward');
  assert.equal(next.body.task.recurrence_parent_id, id, 'linked back to the series');

  // due date advanced by a day
  const firstDue = new Date(created.body.task.due_date).getTime();
  const nextDue = new Date(next.body.task.due_date).getTime();
  assert.ok(nextDue - firstDue >= 23 * 3600 * 1000, 'due date rolled forward roughly a day');

  // completing the second one makes a third — the series continues
  const done2 = await call('POST', `/tasks/${done.body.next_occurrence.id}/move`, {
    token: tokens.member,
    body: { status_id: ids.done, completion_note: 'Done again.' },
  });
  assert.ok(done2.body.next_occurrence, 'the series keeps going');
});

test('a task created straight into a done status counts as completed this month', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/tasks', {
    token: tokens.admin,
    body: { title: 'Already finished when logged', department_id: ids.department, status_id: ids.done, assignee_id: ids.admin },
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.task.completed_at, 'completed_at is stamped at creation');
  assert.equal(created.body.task.progress, 100);

  // the "Completed overall" ring (stage-based) and "Done this month"
  // (completed_at-based) must agree that this card is done — no done task may be
  // invisible to the monthly figure
  const dashboard = await call('GET', '/reports/dashboard', { token: tokens.admin });
  const { summary } = dashboard.body;
  assert.ok(summary.completed_this_month >= 1);

  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE s.stage = 'done' AND t.is_archived = FALSE AND t.completed_at IS NULL`,
  );
  assert.equal(rows[0].n, 0, 'no done task is left without a completion date');
});

test('archiving hides a card from the default list', async (t) => {
  if (skipIfUnavailable(t)) return;

  const before = await call('GET', '/tasks', { token: tokens.admin });
  await call('DELETE', `/tasks/${ids.secondTask}`, { token: tokens.admin });
  const after = await call('GET', '/tasks', { token: tokens.admin });

  assert.equal(after.body.tasks.length, before.body.tasks.length - 1);
  const archived = await call('GET', '/tasks?archived=true', { token: tokens.admin });
  assert.ok(archived.body.tasks.some((task) => task.id === ids.secondTask));
});
