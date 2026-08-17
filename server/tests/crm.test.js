/**
 * CRM: leads, pipeline, activities, and the momentum watchdog.
 *
 * Also proves the additive link is inert: an ordinary task with no account
 * behaves exactly as it did before this module existed.
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
    console.log('[tests] no database reachable — skipping CRM tests');
    return;
  }

  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('SLS', 'Sales', '#2a78d6', 1)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE),
      ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );

  const password = await hashPassword('Password123!');
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'SLS'`);
  ids.sales = dept[0].id;

  const insertUser = async (name, email, role) => {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id`,
      [name, email, password, role, ids.sales],
    );
    return rows[0].id;
  };

  ids.admin = await insertUser('Admin', 'crm-admin@test.local', 'admin');
  ids.rep = await insertUser('Sales Rep', 'crm-rep@test.local', 'member');
  ids.rep2 = await insertUser('Other Rep', 'crm-rep2@test.local', 'member');
  ids.viewer = await insertUser('Viewer', 'crm-viewer@test.local', 'viewer');

  const { rows: statuses } = await query('SELECT id, slug FROM workflow_statuses ORDER BY position');
  ids.todo = statuses[0].id;
  ids.done = statuses[1].id;

  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  for (const [key, email] of Object.entries({
    admin: 'crm-admin@test.local',
    rep: 'crm-rep@test.local',
    rep2: 'crm-rep2@test.local',
    viewer: 'crm-viewer@test.local',
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

test('the pipeline ships with default stages', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { body } = await call('GET', '/accounts/stages', { token: tokens.rep });
  const slugs = body.stages.map((s) => s.slug);
  assert.ok(slugs.includes('new') && slugs.includes('proposal') && slugs.includes('won'));
  ids.newStage = body.stages.find((s) => s.slug === 'new').id;
  ids.proposalStage = body.stages.find((s) => s.slug === 'proposal').id;
  ids.wonStage = body.stages.find((s) => s.slug === 'won').id;
});

test('a rep creates a lead and lands it in the first stage, leading it themselves', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/accounts', {
    token: tokens.rep,
    body: {
      name: 'Acme Agro', value: 500000, source: 'Referral',
      contact_name: 'R. Patil', follower_user_id: ids.rep2,
      next_step: 'Send the intro deck', next_step_due: '2026-09-01',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.account.type, 'LEAD');
  assert.equal(created.body.account.stage_slug, 'new');
  assert.equal(created.body.account.owner_user_id, ids.rep, 'creator leads it by default');
  assert.equal(created.body.account.follower_user_id, ids.rep2);
  ids.acme = created.body.account.id;
});

test('logging activities keeps a timeline and the deal warm', async (t) => {
  if (skipIfUnavailable(t)) return;

  const email = await call('POST', `/accounts/${ids.acme}/activities`, {
    token: tokens.rep,
    body: { type: 'EMAIL', subject: 'Sent the intro deck', next_step: 'Follow up in 3 days' },
  });
  assert.equal(email.status, 201);
  assert.ok(email.body.account.last_activity_at, 'the account is now freshly worked');

  await call('POST', `/accounts/${ids.acme}/activities`, {
    token: tokens.rep,
    body: { type: 'CALL', subject: 'Discovery call', body: 'They want a field demo.' },
  });

  const { body } = await call('GET', `/accounts/${ids.acme}/activities`, { token: tokens.rep });
  // two logged touches plus the "Lead created" note
  const types = body.activities.map((a) => a.type);
  assert.ok(types.includes('EMAIL') && types.includes('CALL') && types.includes('NOTE'));

  // the follower was told about the real touches
  const inbox = await call('GET', '/notifications', { token: tokens.rep2 });
  assert.ok(inbox.body.notifications.some((n) => n.type === 'crm_activity' && n.account_id === ids.acme));
});

test('a meeting can spin off a follow-up task tied to the lead', async (t) => {
  if (skipIfUnavailable(t)) return;

  // the client creates the task against the account, then links the activity
  const task = await call('POST', '/tasks', {
    token: tokens.rep,
    body: {
      title: 'Prepare the field demo for Acme', department_id: ids.sales,
      assignee_id: ids.rep, status_id: ids.todo, account_id: ids.acme,
    },
  });
  assert.equal(task.status, 201);
  ids.demoTask = task.body.task.id;

  const meeting = await call('POST', `/accounts/${ids.acme}/activities`, {
    token: tokens.rep,
    body: {
      type: 'MEETING', subject: 'Kickoff meeting',
      body: 'Agreed to run a demo next week.',
      next_step: 'Run the field demo', task_id: ids.demoTask,
    },
  });
  assert.equal(meeting.status, 201);

  // the task shows which lead it serves, and the account lists it
  const taskDetail = await call('GET', `/tasks/${ids.demoTask}`, { token: tokens.rep });
  assert.equal(taskDetail.body.task.account_id, ids.acme);
  assert.equal(taskDetail.body.task.account_name, 'Acme Agro');

  const account = await call('GET', `/accounts/${ids.acme}`, { token: tokens.rep });
  assert.ok(account.body.tasks.some((t2) => t2.id === ids.demoTask));
  assert.ok(account.body.activities.some((a) => a.task_id === ids.demoTask));
});

test('moving the lead a stage records it and resets the clock', async (t) => {
  if (skipIfUnavailable(t)) return;

  const moved = await call('POST', `/accounts/${ids.acme}/stage`, {
    token: tokens.rep,
    body: { stage_id: ids.proposalStage },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.account.stage_slug, 'proposal');
  assert.equal(moved.body.account.days_since_stage_change, 0);

  const { body } = await call('GET', `/accounts/${ids.acme}/activities`, { token: tokens.rep });
  assert.ok(body.activities.some((a) => a.type === 'STAGE_CHANGE'));
});

test('winning the deal and converting the lead into a customer', async (t) => {
  if (skipIfUnavailable(t)) return;

  const won = await call('POST', `/accounts/${ids.acme}/stage`, {
    token: tokens.rep,
    body: { stage_id: ids.wonStage },
  });
  assert.equal(won.body.account.status, 'WON', 'a won stage settles the deal');

  const converted = await call('POST', `/accounts/${ids.acme}/convert`, {
    token: tokens.rep,
    body: { type: 'CUSTOMER' },
  });
  assert.equal(converted.status, 200);
  assert.equal(converted.body.account.type, 'CUSTOMER');
  assert.ok(converted.body.account.converted_at);

  const { body } = await call('GET', `/accounts/${ids.acme}/activities`, { token: tokens.rep });
  assert.ok(body.activities.some((a) => a.type === 'CONVERTED'));
});

test('the pipeline board groups open leads by stage', async (t) => {
  if (skipIfUnavailable(t)) return;

  // a couple more open leads to populate the board
  for (const name of ['Green Fields', 'Sunrise Farms']) {
    await call('POST', '/accounts', { token: tokens.rep, body: { name, value: 100000 } });
  }
  const { body } = await call('GET', '/accounts/pipeline', { token: tokens.rep });
  const newStage = body.stages.find((s) => s.slug === 'new');
  assert.ok(newStage.accounts.length >= 2);
  assert.ok(newStage.value >= 200000, 'the stage carries its total deal value');
  // the converted customer is no longer an open lead on the board
  assert.ok(!body.stages.some((s) => s.accounts.some((a) => a.id === ids.acme)));
});

test('only the owner, follower or a manager can edit a lead', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/accounts', { token: tokens.rep, body: { name: 'Locked Co' } });
  const id = created.body.account.id;

  const outsider = await call('PATCH', `/accounts/${id}`, {
    token: tokens.rep2,
    body: { value: 999 },
  });
  assert.equal(outsider.status, 403);

  const owner = await call('PATCH', `/accounts/${id}`, { token: tokens.rep, body: { value: 250000 } });
  assert.equal(owner.status, 200);
  assert.equal(Number(owner.body.account.value), 250000);

  // an admin can, through crm.manage.any
  const admin = await call('PATCH', `/accounts/${id}`, { token: tokens.admin, body: { source: 'Event' } });
  assert.equal(admin.status, 200);
});

test('a viewer can see the pipeline but not change it', async (t) => {
  if (skipIfUnavailable(t)) return;
  const read = await call('GET', '/accounts/pipeline', { token: tokens.viewer });
  assert.equal(read.status, 200);
  const attempt = await call('POST', '/accounts', { token: tokens.viewer, body: { name: 'Nope Ltd' } });
  assert.equal(attempt.status, 403);
});

test('the watchdog flags a lead that has stopped moving, and reminds the owner', async (t) => {
  if (skipIfUnavailable(t)) return;

  // a lead created then left untouched: backdate it past the cadence window
  const created = await call('POST', '/accounts', {
    token: tokens.rep,
    body: { name: 'Drifting Deal', next_step: 'Chase the quote' },
  });
  const id = created.body.account.id;
  await query(
    `UPDATE accounts SET stage_changed_at = now() - interval '12 days',
                         last_activity_at = now() - interval '12 days' WHERE id = $1`,
    [id],
  );
  await query(`UPDATE account_activities SET occurred_at = now() - interval '12 days' WHERE account_id = $1`, [id]);

  const insights = await call('GET', '/accounts/insights', { token: tokens.rep });
  const drifting = insights.body.attention.find((s) => s.account_id === id);
  assert.equal(drifting.kind, 'account_stalled');
  assert.ok(insights.body.summary.stalled >= 1);
  assert.ok(insights.body.by_person.some((p) => p.user_id === ids.rep));

  const scan = await call('POST', '/accounts/scan', { token: tokens.admin });
  assert.ok(scan.body.notified.includes(ids.rep));

  const inbox = await call('GET', '/notifications', { token: tokens.rep });
  const digest = inbox.body.notifications.find((n) => n.type === 'crm_digest');
  assert.ok(digest && digest.account_id, 'the nudge links to a lead');

  // once inside the cooldown it does not nag again
  const second = await call('POST', '/accounts/scan', { token: tokens.admin });
  assert.equal(second.body.notified.length, 0);
});

test('only an admin can trigger the scan', async (t) => {
  if (skipIfUnavailable(t)) return;
  const attempt = await call('POST', '/accounts/scan', { token: tokens.rep });
  assert.equal(attempt.status, 403);
});

test('an ordinary task with no account behaves exactly as before', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/tasks', {
    token: tokens.rep,
    body: { title: 'Nothing to do with a deal', department_id: ids.sales, assignee_id: ids.rep, status_id: ids.todo },
  });
  assert.equal(created.status, 201);

  const detail = await call('GET', `/tasks/${created.body.task.id}`, { token: tokens.rep });
  assert.equal(detail.body.task.account_id, null);
  assert.equal(detail.body.task.account_name, null);
});

test('switching the module off makes the pipeline disappear without touching tasks', async (t) => {
  if (skipIfUnavailable(t)) return;

  const off = await call('PUT', '/settings/crm', { token: tokens.admin, body: { value: { enabled: false } } });
  assert.equal(off.status, 200);

  assert.equal((await call('GET', '/accounts/pipeline', { token: tokens.admin })).status, 404);
  assert.equal((await call('GET', '/tasks', { token: tokens.admin })).status, 200);

  await call('PUT', '/settings/crm', { token: tokens.admin, body: { value: { enabled: true } } });
  assert.equal((await call('GET', '/accounts/pipeline', { token: tokens.admin })).status, 200);
});
