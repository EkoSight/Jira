/**
 * Discussion and review threads.
 *
 * The thing being guarded here is that a conversation never becomes a back door:
 * a thread must not let anyone read work they could not already see, and asking
 * someone to change their own goal must stay a management act. The rest is that
 * a thread reaches a conclusion rather than trailing off.
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
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const daysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString();
const dateOnly = (days) => daysFromNow(days).slice(0, 10);

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
    console.log('[tests] no database reachable — skipping thread tests');
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

  ids.admin = await insertUser('Admin User', 'th-admin@test.local', 'admin', ids.growth);
  ids.manager = await insertUser('Manager User', 'th-manager@test.local', 'manager', ids.growth);
  ids.member = await insertUser('Member User', 'th-member@test.local', 'member', ids.growth);
  ids.outsider = await insertUser('Other Team', 'th-outsider@test.local', 'member', ids.agronomy);

  const { rows: statuses } = await query('SELECT id FROM workflow_statuses ORDER BY position');
  ids.todo = statuses[0].id;
  ids.done = statuses[2].id;

  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  for (const [key, email] of Object.entries({
    admin: 'th-admin@test.local',
    manager: 'th-manager@test.local',
    member: 'th-member@test.local',
    outsider: 'th-outsider@test.local',
  })) {
    const login = await call('POST', '/auth/login', { body: { email, password: 'Password123!' } });
    tokens[key] = login.body.token;
  }

  // a goal with one key result, and a task under it
  const objective = await call('POST', '/objectives', {
    token: tokens.admin,
    body: {
      title: 'Grow the advisory base',
      scope_type: 'DEPARTMENT',
      department_id: ids.growth,
      owner_user_id: ids.member,
      start_date: dateOnly(-30),
      end_date: dateOnly(60),
      key_results: [{ title: 'Sign up farmers', measurement_type: 'NUMBER', target_value: 100 }],
    },
  });
  ids.objective = objective.body.objective.id;
  const detail = await call('GET', `/objectives/${ids.objective}`, { token: tokens.admin });
  ids.keyResult = detail.body.key_results[0].id;

  const task = await call('POST', '/tasks', {
    token: tokens.member,
    body: {
      title: 'Run the Nashik field day',
      department_id: ids.growth,
      assignee_id: ids.member,
      due_date: daysFromNow(5),
    },
  });
  ids.task = task.body.task.id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ------------------------------------------------------------ raising one

test('a manager can ask for a vague key result to be improved', async (t) => {
  if (skipIfUnavailable(t)) return;

  const raised = await call('POST', '/threads', {
    token: tokens.manager,
    body: {
      entity_type: 'KEY_RESULT',
      entity_id: ids.keyResult,
      kind: 'review',
      title: 'Too vague to measure',
      body: '"Sign up farmers" — how many, by when, and counted from where?',
    },
  });
  assert.equal(raised.status, 201);
  assert.equal(raised.body.thread.kind, 'review');
  assert.equal(raised.body.thread.status, 'open');
  assert.equal(raised.body.thread.messages.length, 1);
  // it is aimed at whoever owns the thing, without having to be told
  assert.equal(raised.body.thread.awaiting_user, ids.member);
  ids.reviewThread = raised.body.thread.id;

  // and the owner is told about it
  const inbox = await call('GET', '/notifications', { token: tokens.member });
  assert.ok(
    inbox.body.notifications.some((n) => n.type === 'review'),
    'the owner hears that a change was asked for',
  );
});

test('an ordinary member cannot tell someone to change their work', async (t) => {
  if (skipIfUnavailable(t)) return;

  const denied = await call('POST', '/threads', {
    token: tokens.member,
    body: {
      entity_type: 'KEY_RESULT',
      entity_id: ids.keyResult,
      kind: 'review',
      body: 'Rewrite this',
    },
  });
  assert.equal(denied.status, 403);
});

test('but anyone may say they are blocked, or ask a question', async (t) => {
  if (skipIfUnavailable(t)) return;

  for (const kind of ['help_needed', 'question', 'progress', 'challenge']) {
    const opened = await call('POST', '/threads', {
      token: tokens.member,
      body: { entity_type: 'TASK', entity_id: ids.task, kind, body: `A ${kind} note` },
    });
    assert.equal(opened.status, 201, `${kind} is open to everyone`);
    if (kind === 'help_needed') ids.helpThread = opened.body.thread.id;
  }

  // and the card carries the counts, so being blocked is visible without asking
  const task = await call('GET', `/tasks/${ids.task}`, { token: tokens.member });
  assert.equal(task.body.task.open_help, 1);
  assert.equal(task.body.threads.length, 4);
});

// ------------------------------------------------------------ the conversation

test('a thread is a conversation, and it closes with what was concluded', async (t) => {
  if (skipIfUnavailable(t)) return;

  const replied = await call('POST', `/threads/${ids.reviewThread}/messages`, {
    token: tokens.member,
    body: { body: 'Fair. Making it "600 farmers on weekly advisory by 31 Oct".' },
  });
  assert.equal(replied.status, 201);

  // closing without saying how it came out is refused
  const silent = await call('POST', `/threads/${ids.reviewThread}/resolve`, {
    token: tokens.manager,
    body: {},
  });
  assert.equal(silent.status, 400, 'a thread cannot end without a conclusion');

  const closed = await call('POST', `/threads/${ids.reviewThread}/resolve`, {
    token: tokens.manager,
    body: { conclusion: 'Target and date added — good to go.' },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.thread.status, 'resolved');
  assert.equal(closed.body.thread.conclusion, 'Target and date added — good to go.');
  assert.equal(closed.body.thread.resolved_by, ids.manager);
  assert.equal(closed.body.thread.messages.length, 2, 'the discussion is kept, not replaced');

  // and it can be picked back up if it was closed too early
  const reopened = await call('POST', `/threads/${ids.reviewThread}/reopen`, { token: tokens.manager });
  assert.equal(reopened.body.thread.status, 'open');
  assert.equal(reopened.body.thread.conclusion, 'Target and date added — good to go.',
    'reopening does not erase what was concluded last time');
  await call('POST', `/threads/${ids.reviewThread}/resolve`, {
    token: tokens.manager,
    body: { conclusion: 'Closed again.' },
  });
});

test('a bystander cannot close someone else’s thread', async (t) => {
  if (skipIfUnavailable(t)) return;

  const denied = await call('POST', `/threads/${ids.helpThread}/resolve`, {
    token: tokens.outsider,
    body: { conclusion: 'Nothing to do with me' },
  });
  assert.ok([403, 404].includes(denied.status));

  // the person who asked can close their own
  const closed = await call('POST', `/threads/${ids.helpThread}/resolve`, {
    token: tokens.member,
    body: { conclusion: 'Sorted — the dealer list arrived.' },
  });
  assert.equal(closed.status, 200);
});

// ------------------------------------------------------------ access

test('a thread is not a way to read work you cannot see', async (t) => {
  if (skipIfUnavailable(t)) return;

  // a task in a department the outsider is not in and holds no part of
  const hidden = await call('POST', '/tasks', {
    token: tokens.admin,
    body: {
      title: 'Growth-only work',
      department_id: ids.growth,
      assignee_id: ids.admin,
      due_date: daysFromNow(4),
    },
  });
  const hiddenId = hidden.body.task.id;

  const listed = await call('GET', `/threads?entity_type=TASK&entity_id=${hiddenId}`, {
    token: tokens.outsider,
  });
  assert.equal(listed.status, 403, 'reading the conversation needs access to the thing');

  const posted = await call('POST', '/threads', {
    token: tokens.outsider,
    body: { entity_type: 'TASK', entity_id: hiddenId, kind: 'question', body: 'What is this?' },
  });
  assert.equal(posted.status, 403, 'nor can they start one');

  // the owner can, of course
  const allowed = await call('GET', `/threads?entity_type=TASK&entity_id=${hiddenId}`, {
    token: tokens.admin,
  });
  assert.equal(allowed.status, 200);
});

// ------------------------------------------------------------ old comments

test('the comments that existed before threads are still there, and still work', async (t) => {
  if (skipIfUnavailable(t)) return;

  // the old endpoint, unchanged, as anything already integrated would call it
  const posted = await call('POST', `/tasks/${ids.task}/comments`, {
    token: tokens.member,
    body: { body: 'Posted the old way' },
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.comment.body, 'Posted the old way');

  const detail = await call('GET', `/tasks/${ids.task}`, { token: tokens.member });
  assert.ok(
    detail.body.comments.some((c) => c.body === 'Posted the old way'),
    'and it reads back through the same field it always did',
  );
  // it landed in the general discussion thread rather than inventing a new store
  assert.ok(detail.body.threads.some((th) => th.kind === 'discussion'));

  // the card's badge counts the new home, so it does not freeze at the old total
  assert.ok(detail.body.task.comment_count >= 1);
});

test('the migration copied the old comments forward rather than moving them', async (t) => {
  if (skipIfUnavailable(t)) return;

  // an old-world row, written straight to the table the way 001 shipped it
  const { rows: legacy } = await query(
    `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, 'From before the upgrade')
     RETURNING id`,
    [ids.task, ids.member],
  );

  await runMigrations({ verbose: false });

  // still in its original table, untouched
  const { rows: original } = await query('SELECT body FROM task_comments WHERE id = $1', [legacy[0].id]);
  assert.equal(original.length, 1, 'the original row is not deleted or moved');
  assert.equal(original[0].body, 'From before the upgrade');
});

// ------------------------------------------------------------ goals and tasks

test('a goal carries its own conversation, separately from its key results', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('POST', '/threads', {
    token: tokens.admin,
    body: {
      entity_type: 'OBJECTIVE',
      entity_id: ids.objective,
      kind: 'review',
      body: 'This goal does not say what "grow" means.',
    },
  });

  const goal = await call('GET', `/objectives/${ids.objective}`, { token: tokens.admin });
  assert.equal(goal.body.threads.length, 1, 'the goal has its own thread');
  assert.equal(goal.body.threads[0].kind, 'review');
  // and the key result's threads are counted on the key result, not the goal
  const keyResult = goal.body.key_results.find((k) => k.id === ids.keyResult);
  assert.equal(keyResult.open_threads, 0, 'the key result review was closed earlier');

  const krDetail = await call('GET', `/key-results/${ids.keyResult}`, { token: tokens.admin });
  assert.equal(krDetail.body.threads.length, 1);
  assert.equal(krDetail.body.threads[0].status, 'resolved');
});
