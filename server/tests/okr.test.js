/**
 * Goals / OKR module.
 *
 * Two things are being proved here: that the module does what it claims, and —
 * just as important — that a task which has nothing to do with a goal behaves
 * exactly as it did before the module existed.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { calculateHealth, timeElapsedPercent } from '../src/services/okr.js';
import { DEFAULT_HEALTH_THRESHOLDS } from '../src/lib/okrConstants.js';

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

const day = 86400000;
const dateOnly = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

const skipIfUnavailable = (t) => {
  if (!available) {
    t.skip('no database');
    return true;
  }
  return false;
};

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');

  try {
    await query('SELECT 1');
  } catch {
    available = false;
    console.log('[tests] no database reachable — skipping OKR tests');
    return;
  }

  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('GRO', 'Growth', '#2a78d6', 1)`);
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('AGR', 'Agronomy', '#22c55e', 2)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE),
      ('In Progress', 'in-progress', 'in_progress', '#f59e0b', 2, FALSE),
      ('Done', 'done', 'done', '#22c55e', 3, FALSE)`,
  );

  const password = await hashPassword('Password123!');
  const { rows: departments } = await query('SELECT id, key FROM departments ORDER BY position');
  ids.growth = departments[0].id;
  ids.agronomy = departments[1].id;

  const insertUser = async (name, email, role, departmentId) => {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id`,
      [name, email, password, role, departmentId],
    );
    return rows[0].id;
  };

  ids.admin = await insertUser('Admin User', 'okr-admin@test.local', 'admin', ids.growth);
  ids.manager = await insertUser('Manager User', 'okr-manager@test.local', 'manager', ids.growth);
  ids.member = await insertUser('Member User', 'okr-member@test.local', 'member', ids.growth);
  ids.other = await insertUser('Other Member', 'okr-other@test.local', 'member', ids.growth);
  ids.viewer = await insertUser('Viewer User', 'okr-viewer@test.local', 'viewer', ids.growth);

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

  for (const [key, email] of Object.entries({
    admin: 'okr-admin@test.local',
    manager: 'okr-manager@test.local',
    member: 'okr-member@test.local',
    other: 'okr-other@test.local',
    viewer: 'okr-viewer@test.local',
  })) {
    const login = await call('POST', '/auth/login', { body: { email, password: 'Password123!' } });
    tokens[key] = login.body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- pure engine

test('time elapsed is clamped to the period', () => {
  const start = '2026-01-01';
  const end = '2026-01-11';
  assert.equal(Math.round(timeElapsedPercent(start, end, new Date('2026-01-06'))), 50);
  assert.equal(timeElapsedPercent(start, end, new Date('2025-12-01')), 0);
  assert.equal(timeElapsedPercent(start, end, new Date('2026-06-01')), 100);
});

test('health compares progress against the pace the calendar expects', () => {
  const period = { startDate: dateOnly(-50), endDate: dateOnly(50) };
  const t = DEFAULT_HEALTH_THRESHOLDS;

  // half the time gone: 50% is on pace, 35% is slipping, 10% is not going to happen
  assert.equal(calculateHealth({ ...period, progress: 50 }, t).health, 'ON_TRACK');
  assert.equal(calculateHealth({ ...period, progress: 35 }, t).health, 'AT_RISK');
  assert.equal(calculateHealth({ ...period, progress: 10 }, t).health, 'OFF_TRACK');
  // ahead of pace is on track, never "too far ahead"
  assert.equal(calculateHealth({ ...period, progress: 95 }, t).health, 'ON_TRACK');
});

test('health knows about goals that have not begun, are finished, or ran out of time', () => {
  const t = DEFAULT_HEALTH_THRESHOLDS;
  assert.equal(
    calculateHealth({ startDate: dateOnly(10), endDate: dateOnly(40), progress: 0 }, t).health,
    'NOT_STARTED',
  );
  assert.equal(
    calculateHealth({ startDate: dateOnly(-40), endDate: dateOnly(-10), progress: 60 }, t).health,
    'OFF_TRACK',
  );
  assert.equal(
    calculateHealth({ startDate: dateOnly(-40), endDate: dateOnly(-10), progress: 100 }, t).health,
    'COMPLETED',
  );
  assert.equal(
    calculateHealth({ startDate: dateOnly(-10), endDate: dateOnly(10), status: 'COMPLETED', progress: 20 }, t).health,
    'COMPLETED',
  );
});

test('an override changes what is shown without hiding what the numbers say', () => {
  const result = calculateHealth(
    { startDate: dateOnly(-50), endDate: dateOnly(50), progress: 10, manualHealth: 'ON_TRACK' },
    DEFAULT_HEALTH_THRESHOLDS,
  );
  assert.equal(result.health, 'ON_TRACK');
  assert.equal(result.auto_health, 'OFF_TRACK');
  assert.equal(result.is_overridden, true);
});

// ---------------------------------------------------------------- objectives

test('an admin creates a company objective with its key results in one call', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Grow the advisory business',
      description: 'Company-wide push for the season',
      scope_type: 'COMPANY',
      owner_user_id: ids.admin,
      start_date: dateOnly(-30),
      end_date: dateOnly(60),
      priority: 'high',
      status: 'ACTIVE',
      key_results: [
        { title: 'Onboard farmers', measurement_type: 'NUMBER', baseline_value: 0, target_value: 100, unit: 'farmers' },
        { title: 'Publish the playbook', measurement_type: 'BINARY' },
        // a fractional weight sent through the wizard, which must not be read as an integer
        { title: 'Hold the cost per farmer', baseline_value: 210.5, target_value: 150.25, weight: 0.5, unit: '₹' },
      ],
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.objective.scope_type, 'COMPANY');
  assert.equal(created.body.objective.department_id, null);
  assert.equal(created.body.objective.key_result_count, 3);
  ids.companyObjective = created.body.objective.id;
});

test('a manager creates a department objective that rolls up to the company one', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/objectives', {
    token: tokens.manager,
    body: {
      title: 'Lift Growth department output',
      scope_type: 'DEPARTMENT',
      department_id: ids.growth,
      parent_objective_id: ids.companyObjective,
      owner_user_id: ids.manager,
      start_date: dateOnly(-30),
      end_date: dateOnly(60),
      status: 'ACTIVE',
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.objective.parent_objective_id, ids.companyObjective);
  assert.equal(created.body.objective.department_name, 'Growth');
  ids.departmentObjective = created.body.objective.id;

  const parent = await call('GET', `/objectives/${ids.companyObjective}`, { token: tokens.manager });
  assert.equal(parent.body.children.length, 1);
  assert.equal(parent.body.children[0].id, ids.departmentObjective);
});

test('only an admin may raise a company-wide objective', async (t) => {
  if (skipIfUnavailable(t)) return;

  const attempt = await call('POST', '/objectives', {
    token: tokens.manager,
    body: {
      title: 'A manager reaching too far',
      scope_type: 'COMPANY',
      owner_user_id: ids.manager,
      start_date: dateOnly(0),
      end_date: dateOnly(30),
    },
  });
  assert.equal(attempt.status, 403);

  // and a plain member cannot create objectives at all
  const member = await call('POST', '/objectives', {
    token: tokens.member,
    body: {
      title: 'A member reaching too far',
      scope_type: 'DEPARTMENT',
      department_id: ids.growth,
      owner_user_id: ids.member,
      start_date: dateOnly(0),
      end_date: dateOnly(30),
    },
  });
  assert.equal(member.status, 403);
});

test('scope and dates are validated before anything is written', async (t) => {
  if (skipIfUnavailable(t)) return;

  const base = { owner_user_id: ids.admin, start_date: dateOnly(0), end_date: dateOnly(30) };

  const noDepartment = await call('POST', '/objectives', {
    token: tokens.admin,
    body: { ...base, title: 'Department objective with no department', scope_type: 'DEPARTMENT' },
  });
  assert.equal(noDepartment.status, 400);

  const backwards = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Ends before it begins',
      scope_type: 'DEPARTMENT',
      department_id: ids.growth,
      owner_user_id: ids.admin,
      start_date: dateOnly(30),
      end_date: dateOnly(10),
    },
  });
  assert.equal(backwards.status, 400);

  // a company objective silently keeping a department would be a second truth
  const companyWithDepartment = await call('POST', '/objectives', {
    token: tokens.admin,
    body: { ...base, title: 'Company objective with a department', scope_type: 'COMPANY', department_id: ids.growth },
  });
  assert.equal(companyWithDepartment.status, 400);
});

test('someone who does not own the objective cannot edit it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const attempt = await call('PATCH', `/objectives/${ids.departmentObjective}`, {
    token: tokens.member,
    body: { title: 'Hijacked' },
  });
  assert.equal(attempt.status, 403);

  // the owner can
  const owner = await call('PATCH', `/objectives/${ids.departmentObjective}`, {
    token: tokens.manager,
    body: { title: 'Lift Growth department output this season' },
  });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.objective.title, 'Lift Growth department output this season');

  // and an admin can, through okr.manage.any
  const admin = await call('PATCH', `/objectives/${ids.departmentObjective}`, {
    token: tokens.admin,
    body: { priority: 'critical' },
  });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.objective.priority, 'critical');
});

// ---------------------------------------------------------------- measurement

test('a numeric key result measures progress from baseline towards target', async (t) => {
  if (skipIfUnavailable(t)) return;

  const detail = await call('GET', `/objectives/${ids.companyObjective}`, { token: tokens.admin });
  const numeric = detail.body.key_results.find((k) => k.title === 'Onboard farmers');
  ids.numericKeyResult = numeric.id;
  assert.equal(numeric.progress_percent, 0);

  const checkIn = await call('POST', `/key-results/${numeric.id}/check-ins`, {
    token: tokens.admin,
    body: { current_value: 40, confidence: 'MEDIUM', note: 'Forty signed up at the field day' },
  });
  assert.equal(checkIn.status, 201);
  assert.equal(checkIn.body.key_result.progress_percent, 40);
  assert.equal(Number(checkIn.body.check_in.previous_value), 0);
  assert.equal(Number(checkIn.body.check_in.current_value), 40);
  assert.equal(Number(checkIn.body.check_in.resulting_progress), 40);
});

test('a decreasing key result counts progress downwards, decimals and all', async (t) => {
  if (skipIfUnavailable(t)) return;

  // page load seconds, purchase order days — real metrics are rarely whole numbers
  const decimal = await call('POST', `/objectives/${ids.companyObjective}/key-results`, {
    token: tokens.admin,
    body: {
      title: 'Cut page load time',
      measurement_type: 'NUMBER',
      direction: 'DECREASE',
      baseline_value: 4.2,
      target_value: 1.5,
      current_value: 2.85,
      unit: 's',
      weight: 0.5,
    },
  });
  assert.equal(decimal.status, 201);
  const loadTime = decimal.body.key_results.find((k) => k.title === 'Cut page load time');
  assert.equal(loadTime.progress_percent, 50);

  const created = await call('POST', `/objectives/${ids.companyObjective}/key-results`, {
    token: tokens.admin,
    body: {
      title: 'Cut response time',
      measurement_type: 'NUMBER',
      direction: 'DECREASE',
      baseline_value: 48,
      target_value: 8,
      current_value: 48,
      unit: 'hours',
    },
  });
  assert.equal(created.status, 201);
  const keyResult = created.body.key_results.find((k) => k.title === 'Cut response time');
  assert.equal(keyResult.progress_percent, 0);

  const checkIn = await call('POST', `/key-results/${keyResult.id}/check-ins`, {
    token: tokens.admin,
    body: { current_value: 28 },
  });
  // halfway down from 48 to 8
  assert.equal(checkIn.body.key_result.progress_percent, 50);
});

test('a yes/no key result is all or nothing', async (t) => {
  if (skipIfUnavailable(t)) return;

  const detail = await call('GET', `/objectives/${ids.companyObjective}`, { token: tokens.admin });
  const binary = detail.body.key_results.find((k) => k.title === 'Publish the playbook');
  assert.equal(binary.progress_percent, 0);

  const done = await call('POST', `/key-results/${binary.id}/check-ins`, {
    token: tokens.admin,
    body: { current_value: 1, note: 'Published' },
  });
  assert.equal(done.body.key_result.progress_percent, 100);
});

test('a new key result starts at its baseline, not at zero', async (t) => {
  if (skipIfUnavailable(t)) return;

  // the trap: a "should come down" metric left at 0 would read as already achieved
  const created = await call('POST', `/objectives/${ids.companyObjective}/key-results`, {
    token: tokens.admin,
    body: {
      title: 'Bring the cost per acre down',
      measurement_type: 'NUMBER',
      direction: 'DECREASE',
      baseline_value: 900,
      target_value: 600,
      unit: '₹',
    },
  });
  const fresh = created.body.key_results.find((k) => k.title === 'Bring the cost per acre down');
  assert.equal(Number(fresh.current_value), 900);
  assert.equal(fresh.progress_percent, 0, 'a brand new key result has made no progress');

  // an increasing one behaves the same way
  const rising = await call('POST', `/objectives/${ids.companyObjective}/key-results`, {
    token: tokens.admin,
    body: { title: 'Grow dealer coverage', baseline_value: 25, target_value: 80, unit: 'districts' },
  });
  const risingKeyResult = rising.body.key_results.find((k) => k.title === 'Grow dealer coverage');
  assert.equal(Number(risingKeyResult.current_value), 25);
  assert.equal(risingKeyResult.progress_percent, 0);

  // and an explicit starting point still wins
  const explicit = await call('POST', `/objectives/${ids.companyObjective}/key-results`, {
    token: tokens.admin,
    body: { title: 'Already underway', baseline_value: 0, target_value: 50, current_value: 20 },
  });
  const underway = explicit.body.key_results.find((k) => k.title === 'Already underway');
  assert.equal(underway.progress_percent, 40);
});

test('a key result that cannot be measured reports no progress rather than zero', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', `/objectives/${ids.departmentObjective}/key-results`, {
    token: tokens.manager,
    body: { title: 'Target still to be agreed', measurement_type: 'NUMBER', baseline_value: 10, target_value: null },
  });
  const unmeasurable = created.body.key_results.find((k) => k.title === 'Target still to be agreed');
  assert.equal(unmeasurable.progress_percent, null);
  assert.equal(unmeasurable.health, 'NOT_STARTED');
  ids.unmeasurableKeyResult = unmeasurable.id;
});

test('an unmeasurable key result is left out of the objective roll-up, not counted as zero', async (t) => {
  if (skipIfUnavailable(t)) return;

  const measurable = await call('POST', `/objectives/${ids.departmentObjective}/key-results`, {
    token: tokens.manager,
    body: { title: 'Field visits', measurement_type: 'NUMBER', baseline_value: 0, target_value: 10 },
  });
  const visits = measurable.body.key_results.find((k) => k.title === 'Field visits');
  ids.visitsKeyResult = visits.id;

  await call('POST', `/key-results/${visits.id}/check-ins`, {
    token: tokens.manager,
    body: { current_value: 6 },
  });

  const objective = await call('GET', `/objectives/${ids.departmentObjective}`, { token: tokens.manager });
  // 60% from the only measurable key result — the unmeasurable one does not halve it
  assert.equal(objective.body.objective.progress_percent, 60);
});

test('weights decide how much each key result moves the objective', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Weighted objective',
      scope_type: 'DEPARTMENT',
      department_id: ids.agronomy,
      owner_user_id: ids.admin,
      start_date: dateOnly(-10),
      end_date: dateOnly(20),
      status: 'ACTIVE',
      key_results: [
        { title: 'Heavy', baseline_value: 0, target_value: 100, current_value: 100, weight: 3 },
        { title: 'Light', baseline_value: 0, target_value: 100, current_value: 0, weight: 1 },
      ],
    },
  });
  // (100*3 + 0*1) / 4 = 75
  assert.equal(created.body.objective.progress_percent, 75);
  ids.weightedObjective = created.body.objective.id;

  const equalised = await call('POST', `/objectives/${ids.weightedObjective}/key-results/equalise-weights`, {
    token: tokens.admin,
  });
  assert.equal(equalised.status, 200);
  assert.ok(equalised.body.key_results.every((k) => Number(k.weight) === 1));

  const after = await call('GET', `/objectives/${ids.weightedObjective}`, { token: tokens.admin });
  assert.equal(after.body.objective.progress_percent, 50);
});

// ---------------------------------------------------------------- check-ins

test('check-ins are appended, never overwritten', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('POST', `/key-results/${ids.numericKeyResult}/check-ins`, {
    token: tokens.admin,
    body: { current_value: 65, confidence: 'HIGH', next_action: 'Push the last thirty' },
  });

  const history = await call('GET', `/key-results/${ids.numericKeyResult}/check-ins`, { token: tokens.admin });
  assert.equal(history.body.check_ins.length, 2);
  // newest first, and each one remembers where it started
  assert.equal(Number(history.body.check_ins[0].current_value), 65);
  assert.equal(Number(history.body.check_ins[0].previous_value), 40);
  assert.equal(Number(history.body.check_ins[1].current_value), 40);
  assert.equal(Number(history.body.check_ins[1].previous_value), 0);
});

test('the current value only moves through a check-in', async (t) => {
  if (skipIfUnavailable(t)) return;

  const attempt = await call('PATCH', `/key-results/${ids.numericKeyResult}`, {
    token: tokens.admin,
    body: { current_value: 99 },
  });
  assert.equal(attempt.status, 400);

  const unchanged = await call('GET', `/key-results/${ids.numericKeyResult}`, { token: tokens.admin });
  assert.equal(Number(unchanged.body.key_result.current_value), 65);
});

test('a viewer can read goals but cannot move them', async (t) => {
  if (skipIfUnavailable(t)) return;

  const read = await call('GET', '/objectives', { token: tokens.viewer });
  assert.equal(read.status, 200);
  assert.ok(read.body.objectives.length > 0);

  const attempt = await call('POST', `/key-results/${ids.numericKeyResult}/check-ins`, {
    token: tokens.viewer,
    body: { current_value: 100 },
  });
  assert.equal(attempt.status, 403);
});

test('a member cannot check in on a key result that is not theirs', async (t) => {
  if (skipIfUnavailable(t)) return;

  const attempt = await call('POST', `/key-results/${ids.numericKeyResult}/check-ins`, {
    token: tokens.member,
    body: { current_value: 100 },
  });
  assert.equal(attempt.status, 403);
});

test('a member checks in on the key result they own', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', `/objectives/${ids.departmentObjective}/key-results`, {
    token: tokens.manager,
    body: {
      title: 'Member owned metric',
      owner_user_id: ids.member,
      baseline_value: 0,
      target_value: 20,
    },
  });
  const owned = created.body.key_results.find((k) => k.title === 'Member owned metric');
  ids.memberKeyResult = owned.id;

  const checkIn = await call('POST', `/key-results/${owned.id}/check-ins`, {
    token: tokens.member,
    body: { current_value: 5, confidence: 'LOW', note: 'Slower than hoped' },
  });
  assert.equal(checkIn.status, 201);
  assert.equal(checkIn.body.key_result.progress_percent, 25);

  // the objective owner is told, because it is their objective that moved
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'okr_check_in'`,
    [ids.manager],
  );
  assert.ok(rows[0].n >= 1);
});

test('a health override needs a reason and keeps the automatic verdict visible', async (t) => {
  if (skipIfUnavailable(t)) return;

  const noReason = await call('POST', `/objectives/${ids.departmentObjective}/health`, {
    token: tokens.manager,
    body: { health: 'ON_TRACK' },
  });
  assert.equal(noReason.status, 400);

  const withReason = await call('POST', `/objectives/${ids.departmentObjective}/health`, {
    token: tokens.manager,
    body: { health: 'AT_RISK', reason: 'Two people on leave for the rest of the month' },
  });
  assert.equal(withReason.status, 200);
  assert.equal(withReason.body.objective.health, 'AT_RISK');
  assert.equal(withReason.body.objective.is_overridden, true);
  assert.ok(withReason.body.objective.auto_health);

  const cleared = await call('POST', `/objectives/${ids.departmentObjective}/health`, {
    token: tokens.manager,
    body: { health: null },
  });
  assert.equal(cleared.body.objective.is_overridden, false);
  assert.equal(cleared.body.objective.health, cleared.body.objective.auto_health);
});

// ---------------------------------------------------------------- task links

test('linking tasks to a key result drives its execution progress', async (t) => {
  if (skipIfUnavailable(t)) return;

  const rollup = await call('POST', `/objectives/${ids.departmentObjective}/key-results`, {
    token: tokens.manager,
    body: { title: 'Ship the campaign', measurement_type: 'TASK_ROLLUP' },
  });
  const keyResult = rollup.body.key_results.find((k) => k.title === 'Ship the campaign');
  ids.rollupKeyResult = keyResult.id;
  // nothing linked yet: unknown, not zero
  assert.equal(keyResult.progress_percent, null);

  const taskIds = [];
  for (const title of ['Write the brief', 'Book the media']) {
    const task = await call('POST', '/tasks', {
      token: tokens.manager,
      body: { title, department_id: ids.growth, assignee_id: ids.member, status_id: ids.todo },
    });
    assert.equal(task.status, 201);
    taskIds.push(task.body.task.id);
  }
  ids.linkedTasks = taskIds;

  for (const taskId of taskIds) {
    const linked = await call('POST', `/key-results/${keyResult.id}/tasks`, {
      token: tokens.manager,
      body: { task_id: taskId, is_primary: true },
    });
    assert.equal(linked.status, 201);
  }

  const both = await call('GET', `/key-results/${keyResult.id}`, { token: tokens.manager });
  assert.equal(both.body.key_result.linked_task_count, 2);
  assert.equal(both.body.key_result.progress_percent, 0);

  // finishing one of the two moves it to half
  await call('POST', `/tasks/${taskIds[0]}/move`, {
    token: tokens.manager,
    body: { status_id: ids.done, completion_note: 'Brief written and signed off' },
  });

  const half = await call('GET', `/key-results/${keyResult.id}`, { token: tokens.manager });
  assert.equal(half.body.key_result.progress_percent, 50);
  assert.equal(half.body.key_result.execution_progress, 50);
});

test('a task has one primary key result at most', async (t) => {
  if (skipIfUnavailable(t)) return;

  const taskId = ids.linkedTasks[1];
  const second = await call('POST', `/key-results/${ids.visitsKeyResult}/tasks`, {
    token: tokens.manager,
    body: { task_id: taskId, is_primary: true },
  });
  assert.equal(second.status, 201);

  const { rows } = await query(
    'SELECT key_result_id, is_primary FROM task_key_result_links WHERE task_id = $1 ORDER BY key_result_id',
    [taskId],
  );
  assert.equal(rows.length, 2, 'the task supports both key results');
  assert.equal(rows.filter((r) => r.is_primary).length, 1, 'but only one of them is primary');
});

test('the task detail carries its alignment and the link can be removed', async (t) => {
  if (skipIfUnavailable(t)) return;

  const taskId = ids.linkedTasks[1];
  const detail = await call('GET', `/tasks/${taskId}`, { token: tokens.manager });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.key_results.length, 2);
  assert.ok(detail.body.key_results.every((k) => k.objective_id && k.objective_title));

  const removed = await call('DELETE', `/key-results/${ids.visitsKeyResult}/tasks/${taskId}`, {
    token: tokens.manager,
  });
  assert.equal(removed.status, 200);

  const after = await call('GET', `/tasks/${taskId}`, { token: tokens.manager });
  assert.equal(after.body.key_results.length, 1);

  // removing the link leaves the task itself completely alone
  const { rows } = await query('SELECT id, title, status_id, is_archived FROM tasks WHERE id = $1', [taskId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_archived, false);
});

test('a task cannot be linked to a goal by someone who cannot see it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const hidden = await call('POST', '/tasks', {
    token: tokens.admin,
    body: { title: 'Agronomy only work', department_id: ids.agronomy, assignee_id: ids.admin, status_id: ids.todo },
  });
  assert.equal(hidden.status, 201);

  const attempt = await call('POST', `/key-results/${ids.visitsKeyResult}/tasks`, {
    token: tokens.member,
    body: { task_id: hidden.body.task.id },
  });
  assert.equal(attempt.status, 403);
});

// ---------------------------------------------------------------- regression

test('a task with no goal behaves exactly as it did before the module existed', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/tasks', {
    token: tokens.member,
    body: {
      title: 'Ordinary work with nothing strategic about it',
      department_id: ids.growth,
      assignee_id: ids.member,
      status_id: ids.todo,
      priority: 'medium',
    },
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.task.ref.startsWith('GRO-'));

  const detail = await call('GET', `/tasks/${created.body.task.id}`, { token: tokens.member });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.key_results, [], 'no alignment, and nothing invented');
  assert.equal(detail.body.task.progress, 0);
  assert.equal(detail.body.can_edit, true);

  // it moves through the board without the OKR layer being involved
  const moved = await call('POST', `/tasks/${created.body.task.id}/move`, {
    token: tokens.member,
    body: { status_id: ids.done, completion_note: 'Finished it' },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.task.stage, 'done');

  const list = await call('GET', '/tasks', { token: tokens.member });
  assert.ok(list.body.tasks.some((task) => task.id === created.body.task.id));
});

test('the tasks table itself is untouched by the module', async (t) => {
  if (skipIfUnavailable(t)) return;

  // the only bridge between a task and a goal is the join table
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'tasks'
        AND (column_name ILIKE '%objective%' OR column_name ILIKE '%key_result%' OR column_name ILIKE '%okr%')`,
    [config.db.schema],
  );
  assert.deepEqual(rows, [], 'tasks gained no OKR columns');
});

// ---------------------------------------------------------------- lifecycle

test('the goals dashboard summarises health, departments and owners', async (t) => {
  if (skipIfUnavailable(t)) return;

  const dashboard = await call('GET', '/objectives/dashboard', { token: tokens.admin });
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.summary.total >= 3);
  assert.equal(
    dashboard.body.summary.total,
    dashboard.body.summary.on_track
      + dashboard.body.summary.at_risk
      + dashboard.body.summary.off_track
      + dashboard.body.summary.completed
      + dashboard.body.summary.not_started,
    'every objective lands in exactly one health bucket',
  );
  assert.ok(dashboard.body.by_department.some((d) => d.name === 'Company-wide'));
  assert.ok(dashboard.body.by_owner.length > 0);
});

test('objectives can be filtered by department, owner and overlapping period', async (t) => {
  if (skipIfUnavailable(t)) return;

  const byDepartment = await call('GET', `/objectives?department_id=${ids.agronomy}`, { token: tokens.admin });
  assert.ok(byDepartment.body.objectives.length >= 1);
  assert.ok(byDepartment.body.objectives.every((o) => o.department_id === ids.agronomy));

  const byOwner = await call('GET', `/objectives?owner_id=${ids.manager}`, { token: tokens.admin });
  assert.ok(byOwner.body.objectives.every((o) => o.owner_user_id === ids.manager));

  // a period that ended long before anything started matches nothing
  const longAgo = await call('GET', `/objectives?from=${dateOnly(-900)}&to=${dateOnly(-800)}`, {
    token: tokens.admin,
  });
  assert.equal(longAgo.body.objectives.length, 0);

  // and a window that overlaps the live objectives matches them
  const now = await call('GET', `/objectives?from=${dateOnly(-1)}&to=${dateOnly(1)}`, { token: tokens.admin });
  assert.ok(now.body.objectives.length >= 3);
});

test('archiving hides an objective without destroying anything', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Objective to retire',
      scope_type: 'DEPARTMENT',
      department_id: ids.agronomy,
      owner_user_id: ids.admin,
      start_date: dateOnly(-5),
      end_date: dateOnly(25),
      key_results: [{ title: 'Something measured', baseline_value: 0, target_value: 10 }],
    },
  });
  const id = created.body.objective.id;

  const archived = await call('DELETE', `/objectives/${id}`, { token: tokens.admin });
  assert.equal(archived.status, 200);

  const list = await call('GET', '/objectives', { token: tokens.admin });
  assert.ok(!list.body.objectives.some((o) => o.id === id));

  // the rows are still there — archived, not deleted
  const { rows } = await query('SELECT is_archived FROM objectives WHERE id = $1', [id]);
  assert.equal(rows[0].is_archived, true);
  const { rows: keyResults } = await query('SELECT COUNT(*)::int AS n FROM key_results WHERE objective_id = $1', [id]);
  assert.equal(keyResults[0].n, 1);
});

test('every change to a goal is recorded', async (t) => {
  if (skipIfUnavailable(t)) return;

  const detail = await call('GET', `/objectives/${ids.departmentObjective}`, { token: tokens.manager });
  const actions = detail.body.activity.map((row) => row.action);
  assert.ok(actions.includes('created'));
  assert.ok(actions.includes('updated'));
  assert.ok(actions.includes('health_overridden'));

  const keyResult = await call('GET', `/key-results/${ids.memberKeyResult}`, { token: tokens.member });
  assert.ok(keyResult.body.activity.some((row) => row.action === 'checked_in'));
});

test('switching the module off makes it disappear without touching anything else', async (t) => {
  if (skipIfUnavailable(t)) return;

  const off = await call('PUT', '/settings/okr', { token: tokens.admin, body: { value: { enabled: false } } });
  assert.equal(off.status, 200);

  const goals = await call('GET', '/objectives', { token: tokens.admin });
  assert.equal(goals.status, 404);

  // the rest of TaskFlow carries on
  const tasks = await call('GET', '/tasks', { token: tokens.admin });
  assert.equal(tasks.status, 200);

  const back = await call('PUT', '/settings/okr', { token: tokens.admin, body: { value: { enabled: true } } });
  assert.equal(back.status, 200);
  assert.equal((await call('GET', '/objectives', { token: tokens.admin })).status, 200);
});
