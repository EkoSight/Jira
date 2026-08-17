/**
 * The OKR attention engine.
 *
 * Proves the system notices, on its own, the four things it is meant to catch —
 * goals off track, key results stuck, departments gone quiet, people behind —
 * and that its reminders reach the right person without repeating.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';

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

/** Adds a key result and returns its id. */
const addKeyResult = async (objectiveId, token, body) => {
  const before = await call('GET', `/objectives/${objectiveId}`, { token });
  const existing = new Set(before.body.key_results.map((k) => k.id));
  const res = await call('POST', `/objectives/${objectiveId}/key-results`, { token, body });
  return res.body.key_results.find((k) => !existing.has(k.id)).id;
};

/** Backdates a key result's activity so "days since" is deterministic. */
const ageKeyResult = (keyResultId, days) =>
  query(
    `UPDATE key_results
        SET last_check_in_at = now() - ($1::int || ' days')::interval,
            created_at = now() - (($1::int + 5) || ' days')::interval
      WHERE id = $2`,
    [days, keyResultId],
  );

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try {
    await query('SELECT 1');
  } catch {
    available = false;
    console.log('[tests] no database reachable — skipping insight tests');
    return;
  }

  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('GRO', 'Growth', '#2a78d6', 1)`);
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('SLS', 'Sales', '#eb6834', 2)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE),
      ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );

  const password = await hashPassword('Password123!');
  const { rows: departments } = await query('SELECT id, key FROM departments ORDER BY position');
  ids.growth = departments[0].id;
  ids.sales = departments[1].id;

  const insertUser = async (name, email, role, departmentId) => {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id`,
      [name, email, password, role, departmentId],
    );
    return rows[0].id;
  };

  ids.admin = await insertUser('Admin', 'ins-admin@test.local', 'admin', ids.growth);
  ids.manager = await insertUser('Manager', 'ins-manager@test.local', 'manager', ids.growth);
  ids.m1 = await insertUser('Member One', 'ins-m1@test.local', 'member', ids.growth);
  ids.m2 = await insertUser('Member Two', 'ins-m2@test.local', 'member', ids.sales);

  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  for (const [key, email] of Object.entries({
    admin: 'ins-admin@test.local',
    manager: 'ins-manager@test.local',
    m1: 'ins-m1@test.local',
    m2: 'ins-m2@test.local',
  })) {
    const login = await call('POST', '/auth/login', { body: { email, password: 'Password123!' } });
    tokens[key] = login.body.token;
  }

  if (!available) return;

  // ---- Goal OFF: badly behind, and a key result that has never been touched
  const off = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Off-track goal', scope_type: 'DEPARTMENT', department_id: ids.growth,
      owner_user_id: ids.m1, start_date: dateOnly(-60), end_date: dateOnly(5), status: 'ACTIVE',
    },
  });
  ids.offObjective = off.body.objective.id;
  ids.offKeyResult = await addKeyResult(ids.offObjective, tokens.admin, {
    title: 'Barely started', owner_user_id: ids.m1, baseline_value: 0, target_value: 100, current_value: 5,
  });
  await ageKeyResult(ids.offKeyResult, 30);
  await query('UPDATE key_results SET last_check_in_at = NULL WHERE id = $1', [ids.offKeyResult]);

  // ---- Goal STALL: healthy by pace, but nobody has checked in for two weeks
  const stall = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Stalled goal', scope_type: 'DEPARTMENT', department_id: ids.growth,
      owner_user_id: ids.manager, start_date: dateOnly(-20), end_date: dateOnly(40), status: 'ACTIVE',
    },
  });
  ids.stallObjective = stall.body.objective.id;
  ids.stallKeyResult = await addKeyResult(ids.stallObjective, tokens.admin, {
    title: 'Quietly on track', owner_user_id: ids.m2, baseline_value: 0, target_value: 100, current_value: 40,
  });
  await ageKeyResult(ids.stallKeyResult, 15);

  // ---- Goal FLAT: a key result checked in twice with no movement, and behind
  const flat = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Flat goal', scope_type: 'DEPARTMENT', department_id: ids.growth,
      owner_user_id: ids.m1, start_date: dateOnly(-21), end_date: dateOnly(39), status: 'ACTIVE',
    },
  });
  ids.flatObjective = flat.body.objective.id;
  ids.flatKeyResult = await addKeyResult(ids.flatObjective, tokens.admin, {
    title: 'Stuck at twenty', owner_user_id: ids.m1, baseline_value: 0, target_value: 100, current_value: 0,
  });
  await call('POST', `/key-results/${ids.flatKeyResult}/check-ins`, { token: tokens.admin, body: { current_value: 20 } });
  await call('POST', `/key-results/${ids.flatKeyResult}/check-ins`, { token: tokens.admin, body: { current_value: 20 } });

  // ---- Goal SALES: the whole Sales department has gone quiet
  const sales = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Sales goal', scope_type: 'DEPARTMENT', department_id: ids.sales,
      owner_user_id: ids.m2, start_date: dateOnly(-30), end_date: dateOnly(30), status: 'ACTIVE',
    },
  });
  ids.salesObjective = sales.body.objective.id;
  ids.salesKeyResult = await addKeyResult(ids.salesObjective, tokens.admin, {
    title: 'Deals closed', owner_user_id: ids.m2, baseline_value: 0, target_value: 50, current_value: 20,
  });
  await ageKeyResult(ids.salesKeyResult, 20);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('the system spots an off-track goal and the key result under it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { body } = await call('GET', '/objectives/insights', { token: tokens.admin });
  const kinds = body.attention.map((s) => s.kind);

  assert.ok(kinds.includes('objective_off_track') || kinds.includes('objective_overdue'));
  const offKr = body.attention.find((s) => s.key_result_id === ids.offKeyResult);
  assert.equal(offKr.kind, 'key_result_off_track');
  assert.equal(offKr.severity, 'critical');
});

test('it flags a key result nobody has checked in on', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { body } = await call('GET', '/objectives/insights', { token: tokens.admin });
  const stale = body.attention.find((s) => s.key_result_id === ids.stallKeyResult);
  assert.equal(stale.kind, 'key_result_stale');
  assert.ok(stale.days >= 14, 'it says how long it has been quiet');
});

test('it flags a whole goal that has stopped moving', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { body } = await call('GET', '/objectives/insights', { token: tokens.admin });
  const stalled = body.attention.find(
    (s) => s.kind === 'objective_stalled' && s.objective_id === ids.stallObjective,
  );
  assert.ok(stalled, 'the stalled goal is reported');
  assert.ok(body.summary.goals_stalled >= 1);
});

test('it spots a key result being updated but not moving', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { body } = await call('GET', '/objectives/insights', { token: tokens.admin });
  const flat = body.attention.find((s) => s.key_result_id === ids.flatKeyResult);
  assert.equal(flat.kind, 'key_result_flat');
});

test('it names the departments that have gone quiet', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { body } = await call('GET', '/objectives/insights', { token: tokens.admin });
  const sales = body.by_department.find((d) => d.department_id === ids.sales);
  assert.equal(sales.is_idle, true);
  assert.ok(sales.idle_days >= 19);
  assert.ok(body.attention.some((s) => s.kind === 'department_inactive' && s.department_id === ids.sales));
});

test('it names who is behind, and on how much', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { body } = await call('GET', '/objectives/insights', { token: tokens.admin });
  const one = body.by_person.find((p) => p.user_id === ids.m1);
  assert.ok(one, 'the person behind is listed');
  assert.ok(one.off_track >= 1);
  assert.ok(body.summary.people_behind >= 2);
});

test('everyone who can see goals can see what needs attention', async (t) => {
  if (skipIfUnavailable(t)) return;

  const asMember = await call('GET', '/objectives/insights', { token: tokens.m1 });
  assert.equal(asMember.status, 200);
  assert.ok(asMember.body.summary.total_signals > 0);
});

test('the department filter narrows the whole picture', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { body } = await call('GET', `/objectives/insights?department_id=${ids.sales}`, { token: tokens.admin });
  assert.ok(body.attention.every((s) => s.department_id === ids.sales || s.department_id == null ? true : s.department_id === ids.sales));
  assert.ok(body.attention.some((s) => s.objective_id === ids.salesObjective));
  assert.ok(!body.attention.some((s) => s.objective_id === ids.offObjective));
});

test('a scan reminds the people accountable, once', async (t) => {
  if (skipIfUnavailable(t)) return;

  const first = await call('POST', '/objectives/scan', { token: tokens.admin });
  assert.equal(first.status, 200);
  assert.ok(first.body.notified.includes(ids.m1));
  assert.ok(first.body.notified.includes(ids.m2));

  // the digest reached the person and points at a goal
  const inbox = await call('GET', '/notifications', { token: tokens.m1 });
  const digest = inbox.body.notifications.find((n) => n.type === 'okr_digest');
  assert.ok(digest, 'the reminder is in their notifications');
  assert.ok(digest.objective_id, 'it links to a goal');
  assert.ok(digest.objective_title, 'and the goal is named');

  // running again inside the cooldown does not nag
  const second = await call('POST', '/objectives/scan', { token: tokens.admin });
  assert.equal(second.body.notified.length, 0);

  // but a forced run can
  const forced = await call('POST', '/objectives/scan', { token: tokens.admin, body: { force: true } });
  assert.ok(forced.body.notified.length > 0);
});

test('only an admin can trigger the scan', async (t) => {
  if (skipIfUnavailable(t)) return;

  const attempt = await call('POST', '/objectives/scan', { token: tokens.m1 });
  assert.equal(attempt.status, 403);
});

test('turning the watch off silences the reminders without touching the data', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('PUT', '/settings/okr', { token: tokens.admin, body: { value: { attention: { enabled: false } } } });

  const scan = await call('POST', '/objectives/scan', { token: tokens.admin, body: { force: true } });
  assert.equal(scan.body.skipped, 'attention_off');
  assert.equal(scan.body.notified.length, 0);

  // the signals are still computed for anyone who opens the dashboard
  const insights = await call('GET', '/objectives/insights', { token: tokens.admin });
  assert.ok(insights.body.summary.total_signals > 0);

  await call('PUT', '/settings/okr', { token: tokens.admin, body: { value: { attention: { enabled: true } } } });
});
