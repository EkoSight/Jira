/**
 * My workspace, Part B: Needs attention, Needs my decision and Waiting on
 * others. Numbers refer to the build prompt's tests (section 8).
 *
 *   10  a caller's calls to describe come from the existing pending-calls
 *       query, with the same count
 *   11  a manager's decisions are the deadline changes and leave from their
 *       reporting line, and nothing outside it
 *   12  a super admin gets no attendance or standup item
 *   13  every count equals the rows its list shows
 *   B4  a deal late on a next step its task tracks: one item, linked to both
 *   +   a personal snooze hides one item for one person and changes nothing else;
 *       a recorded block is told apart from a plain Blocked status
 *
 * Made-up people and records only.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { attentionFor, foldTracked, orderItems } from '../src/services/workspace/attention.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const st = {};

const call = async (method, p, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const user = async (id) => (await query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

let refN = 0;
async function mkTask({ title, owner, by = null, due = null, stage = 'todo', dept = null }) {
  refN += 1;
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7) RETURNING id`,
    [`AT-${refN}`, title, dept || ids.ops, st[stage], owner, by || owner, due],
  );
  return rows[0].id;
}

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1), ('FLD', 'Field', '#0a7', 2)`);
  ids.ops = (await query(`SELECT id FROM departments WHERE key = 'OPS'`)).rows[0].id;
  ids.fld = (await query(`SELECT id FROM departments WHERE key = 'FLD'`)).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Blocked', 'blocked', 'blocked', '#ef4444', 2, FALSE), ('Done', 'done', 'done', '#22c55e', 3, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) st[r.stage] = r.id;
  const password = await hashPassword('Password123!');
  const people = [
    ['admin', 'admin', ids.ops], ['mona', 'manager', ids.ops], ['isha', 'member', ids.ops], ['ravi', 'member', ids.ops],
    ['kiran', 'member', ids.fld], ['caro', 'member', ids.fld], ['sam', 'super_admin', null],
  ];
  for (const [key, role, dept] of people) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.at@test.local`, password, role, dept],
    );
    ids[key] = rows[0].id;
  }
  // Mona manages Isha and Ravi (reporting line); Kiran in Field is outside it
  await query(`INSERT INTO employee_work_profiles (user_id, reporting_manager_id) VALUES ($1, $3), ($2, $3)`, [ids.isha, ids.ravi, ids.mona]);
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'mona', 'isha', 'ravi', 'kiran', 'caro', 'sam']) {
    tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.at@test.local`, password: 'Password123!' } })).token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('11: a manager decides the deadline changes and leave of their reporting line, nothing outside it', async (t) => {
  if (skip(t)) return;
  const inLine = await mkTask({ title: 'Sample stock count', owner: ids.isha, due: new Date(Date.now() + 86_400_000) });
  const outside = await mkTask({ title: 'Sample field visit', owner: ids.kiran, dept: ids.fld, due: new Date(Date.now() + 86_400_000) });
  await query(`INSERT INTO task_deadline_changes (task_id, kind, requested_by, reason, to_due) VALUES ($1, 'EXTEND', $2, 'Supplier is late', now() + interval '5 days'), ($3, 'EXTEND', $4, 'Rain', now() + interval '5 days')`, [inLine, ids.isha, outside, ids.kiran]);
  await query(`INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status, submitted_at) VALUES
    ($1, 'CASUAL', current_date + 10, current_date + 10, 'Family event', 'SUBMITTED', now()),
    ($2, 'CASUAL', current_date + 12, current_date + 12, 'Family event', 'SUBMITTED', now())`, [ids.ravi, ids.kiran]);
  // Managers hold task.edit.any by role, which already lets them decide any
  // deadline change (the overdue review's rule). The list follows that rule
  // exactly: the same changes as the review screen's "waiting for my decision".
  const review = ok(await call('GET', '/task-review/waiting', { token: tokens.mona }));
  const wide = ok(await call('GET', '/workspace/decisions', { token: tokens.mona }));
  assert.deepEqual(wide.items.filter((d) => d.kind === 'DEADLINE_CHANGE').map((d) => d.id).sort(), review.changes.map((c) => c.id).sort());
  assert.deepEqual(wide.items.filter((d) => d.kind === 'LEAVE').map((d) => d.who), ['Ravi Sample'], 'leave: only the people they can see');
  // a manager without that company-wide power (as an administrator can set
  // per person) decides only for their reporting line
  await query(`UPDATE users SET revoked_permissions = ARRAY['task.edit.any'] WHERE id = $1`, [ids.mona]);
  const mine = ok(await call('GET', '/workspace/decisions', { token: tokens.mona }));
  const kinds = mine.items.map((d) => `${d.kind}:${d.who}`).sort();
  assert.deepEqual(kinds, ['DEADLINE_CHANGE:Isha Sample', 'LEAVE:Ravi Sample']);
  for (const d of mine.items) assert.ok(d.url && d.since && d.what, 'what, who asked, since when, and Open');
  await query(`UPDATE users SET revoked_permissions = '{}' WHERE id = $1`, [ids.mona]);
  // a member decides nothing of this; the request shows under their own waiting list instead
  assert.equal(ok(await call('GET', '/workspace/decisions', { token: tokens.isha })).total, 0);
  const waiting = ok(await call('GET', '/workspace/waiting', { token: tokens.isha }));
  assert.ok(waiting.items.some((w) => w.kind === 'MY_REQUEST' && /New deadline for AT-1/.test(w.what)));
  // decisions sit in tier 3 of the manager's attention list
  const att = ok(await call('GET', '/workspace/attention?view=decisions', { token: tokens.mona }));
  assert.equal(att.total, wide.total);
  assert.ok(att.items.every((it) => it.tier === 3));
});

test('B4 and B2: a deal late on a next step its task tracks gives one item linked to both; the order is the tiers', async (t) => {
  if (skip(t)) return;
  const acc = (await query(`INSERT INTO accounts (name, owner_user_id) VALUES ('Sample Agro Ltd', $1) RETURNING id`, [ids.isha])).rows[0].id;
  const stage = (await query(`SELECT id FROM account_stages WHERE slug = 'qualified'`)).rows[0].id;
  const pipe = (await query(`SELECT id FROM crm_pipelines WHERE key = 'b2b'`)).rows[0].id;
  const task = await mkTask({ title: 'Send the sample proposal', owner: ids.isha, due: new Date(Date.now() - 2 * 86_400_000) });
  const deal = (await query(
    `INSERT INTO opportunities (account_id, name, owner_user_id, stage_id, pipeline_id, next_step, next_step_due, next_step_owner_id, next_step_task_id)
     VALUES ($1, 'Soil kits pilot', $2, $3, $4, 'Send the proposal', current_date - 2, $2, $5) RETURNING id`,
    [acc, ids.isha, stage, pipe, task],
  )).rows[0].id;
  await query(`UPDATE tasks SET opportunity_id = $1 WHERE id = $2`, [deal, task]);
  // a second deal with no next action at all
  await query(`INSERT INTO opportunities (account_id, name, owner_user_id, stage_id, pipeline_id) VALUES ($1, 'Sample renewal', $2, $3, $4)`, [acc, ids.isha, stage, pipe]);
  const { items } = await attentionFor(await user(ids.isha));
  const dealItems = items.filter((it) => it.record.id === deal && it.record.type === 'DEAL');
  assert.equal(dealItems.length, 1);
  assert.equal(dealItems[0].kind, 'DEAL_ACTION_DUE');
  assert.deepEqual(dealItems[0].related, [{ type: 'TASK', id: task }]);
  assert.equal(items.filter((it) => it.record.type === 'TASK' && it.record.id === task).length, 0, 'the task is folded into the deal\'s item');
  const none = items.find((it) => it.kind === 'DEAL_NO_NEXT_ACTION');
  assert.equal(none.reason, 'None recorded');
  assert.equal(none.tier, 5);
  assert.deepEqual(items.map((it) => it.tier), [...items.map((it) => it.tier)].sort((a, b) => a - b), 'tiers in order');
  // pure: folding and ordering
  const folded = foldTracked([
    { key: 'a', tier: 2, record: { type: 'TASK', id: 7 }, related: [] },
    { key: 'b', tier: 2, record: { type: 'DEAL', id: 1 }, related: [{ type: 'TASK', id: 7 }] },
  ]);
  assert.deepEqual(folded.map((x) => x.key), ['b']);
  assert.deepEqual(orderItems([{ key: 'x', tier: 4, when: { date: '2026-01-02' } }, { key: 'y', tier: 1, when: {} }, { key: 'z', tier: 4, when: { date: '2026-01-01' } }]).map((x) => x.key), ['y', 'z', 'x']);
});

test('13: every count equals the rows its list shows', async (t) => {
  if (skip(t)) return;
  await mkTask({ title: 'Sample overdue report', owner: ids.isha, due: new Date(Date.now() - 86_400_000) });
  await mkTask({ title: 'Sample due later today', owner: ids.isha, due: new Date(Date.now() + 60_000) });
  for (const key of ['isha', 'mona']) {
    const summary = ok(await call('GET', '/workspace/widgets/summary', { token: tokens[key] }));
    for (const tile of summary.tiles) {
      const list = ok(await call('GET', `${tile.url}${tile.url.includes('?') ? '&' : '?'}limit=200`, { token: tokens[key] }));
      assert.equal(list.items.length, tile.count, `${key}: ${tile.label}`);
      assert.equal(list.total, tile.count);
    }
  }
  const deals = ok(await call('GET', '/workspace/widgets/deals?limit=200', { token: tokens.isha }));
  assert.equal(deals.items.length, deals.total);
  assert.equal(deals.counts.no_next_action, deals.items.filter((d) => d.no_next_action).length);
  assert.equal(deals.counts.overdue, deals.items.filter((d) => d.overdue).length);
  assert.ok(deals.counts.no_next_action >= 1 && deals.counts.overdue >= 1, 'flagged separately');
});

test('10: calls to describe are the pending-calls query, with the same count', async (t) => {
  if (skip(t)) return;
  await query(
    `INSERT INTO crm_calls (provider, direction, status, agent_user_id, started_at, dialled_at)
     VALUES ('device', 'OUTBOUND', 'COMPLETED', $1, now() - interval '1 hour', now() - interval '1 hour'),
            ('device', 'OUTBOUND', 'COMPLETED', $1, now() - interval '2 hours', now() - interval '2 hours')`,
    [ids.caro],
  );
  const pending = ok(await call('GET', '/sales/calls/pending', { token: tokens.caro }));
  const att = ok(await call('GET', '/workspace/attention?limit=200', { token: tokens.caro }));
  assert.equal(att.items.filter((it) => it.kind === 'CALL_TO_DESCRIBE').length, pending.calls.length);
  assert.equal(pending.calls.length, 2);
  // nobody else sees Caro's calls
  const isha = ok(await call('GET', '/workspace/attention?limit=200', { token: tokens.isha }));
  assert.equal(isha.items.filter((it) => it.kind === 'CALL_TO_DESCRIBE').length, 0);
});

test('12: a super admin gets no attendance or standup item, and sees no attendance decisions for themselves', async (t) => {
  if (skip(t)) return;
  const att = ok(await call('GET', '/workspace/attention?limit=200', { token: tokens.sam }));
  assert.equal(att.items.filter((it) => it.kind === 'STANDUP_DUE').length, 0);
  const ws = ok(await call('GET', '/workspace', { token: tokens.sam }));
  assert.equal(ws.catalogue.find((c) => c.type === 'today').available, false);
});

test('a personal snooze hides one item for one person; the record, its date and other people\'s lists are unchanged', async (t) => {
  if (skip(t)) return;
  const shared = await mkTask({ title: 'Sample shared deadline', owner: ids.ravi, by: ids.mona, due: new Date(Date.now() - 3 * 86_400_000) });
  const before1 = (await query('SELECT * FROM tasks WHERE id = $1', [shared])).rows[0];
  const ravi = ok(await call('GET', '/workspace/attention?limit=200', { token: tokens.ravi }));
  const it = ravi.items.find((x) => x.record.type === 'TASK' && x.record.id === shared);
  assert.equal(it.kind, 'TASK_OVERDUE');
  // someone else cannot snooze an item that is not in their list
  assert.equal((await call('POST', '/workspace/attention/snooze', { token: tokens.isha, body: { key: it.key, until: new Date(Date.now() + 86_400_000).toISOString() } })).status, 400);
  const snooze = ok(await call('POST', '/workspace/attention/snooze', { token: tokens.ravi, body: { key: it.key, until: new Date(Date.now() + 86_400_000).toISOString() } }));
  assert.match(snooze.note, /record, its dates and its owner stay as they are/);
  const after1 = ok(await call('GET', '/workspace/attention?limit=200', { token: tokens.ravi }));
  assert.equal(after1.items.some((x) => x.key === it.key), false);
  assert.equal(after1.snoozed, 1);
  assert.deepEqual((await query('SELECT * FROM tasks WHERE id = $1', [shared])).rows[0], before1, 'nothing about the task changed');
  // Mona handed the work out: it still shows in her Waiting on others, overdue
  const mona = ok(await call('GET', '/workspace/waiting', { token: tokens.mona }));
  assert.ok(mona.items.some((w) => w.record.id === shared && w.overdue));
  // and the board still shows it overdue
  const board = ok(await call('GET', `/tasks?due=overdue&assignee_id=${ids.ravi}`, { token: tokens.ravi }));
  assert.ok(board.tasks.some((x) => x.id === shared));
  ok(await call('POST', '/workspace/attention/unsnooze', { token: tokens.ravi, body: { key: it.key } }));
  assert.ok(ok(await call('GET', '/workspace/attention?limit=200', { token: tokens.ravi })).items.some((x) => x.key === it.key));
});

test('D4: waiting on others tells a recorded block from a task merely marked Blocked', async (t) => {
  if (skip(t)) return;
  const recorded = await mkTask({ title: 'Sample lab results', owner: ids.isha, by: ids.mona, stage: 'blocked' });
  await query(`INSERT INTO task_blocks (task_id, reason, dependency_text, recorded_by, status) VALUES ($1, 'Waiting on the lab', 'The soil lab sends results', $2, 'ACCEPTED')`, [recorded, ids.isha]);
  const plain = await mkTask({ title: 'Sample shelf labels', owner: ids.isha, by: ids.mona, stage: 'blocked' });
  const w = ok(await call('GET', '/workspace/waiting', { token: tokens.mona }));
  const a = w.items.find((x) => x.record.id === recorded);
  const b = w.items.find((x) => x.record.id === plain);
  assert.equal(a.specific, true);
  assert.equal(a.what, 'The soil lab sends results');
  assert.equal(b.specific, false);
  assert.match(b.what, /nothing recorded about what it waits on/);
  // blocked work is not repeated in the owner's attention list
  const isha = ok(await call('GET', '/workspace/attention?limit=200', { token: tokens.isha }));
  assert.equal(isha.items.some((x) => x.record.id === recorded || x.record.id === plain), false);
});
