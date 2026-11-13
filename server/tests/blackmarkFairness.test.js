/**
 * Black marks that are reliable and fair. Problems from the brief, each
 * reproduced:
 *
 *   14  overlapping rules no longer stack: with the default rules a critical
 *       task missed and finished three weeks late cost 5.5 points; now 4
 *   15  a new or edited rule applies from when it is saved; earlier work only
 *       through a preview and an approval that applies exactly what was shown
 *   16  the mark belongs to whoever owned the task at its deadline, not to
 *       whoever owns it when the scan runs; escalation stops when it changes hands
 *   17  no marks while deferred, while an accepted block covers the deadline, or
 *       for a deactivated person; Backlog without a deferral still counts
 *   18  the person can appeal; someone with blackmark.waive decides, never their own
 *   19  escalation counts working days, and the rules say so
 *   +   the recheck list says why a mark would not be given today; existing
 *       marks are never changed automatically; three counts kept apart
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { marksToRecheck, monthlyReview, recordBlackMark, runBlackMarkScan } from '../src/services/blackmarks.js';
import { updateSetting } from '../src/services/settings.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};
const st = {};
const rules = {};

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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let refN = 0;

async function mkTask({ title, owner = ids.ana, dueMs, stage = 'todo', priority = 'medium' }) {
  refN += 1;
  const due = new Date(dueMs);
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, priority, assignee_id, created_by, reporter_id, due_date, original_due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $8) RETURNING id`,
    [`BF-${refN}`, title, ids.dept, st[stage], priority, owner, ids.admin, due],
  );
  return rows[0].id;
}
const marks = async (taskId) => (await query(
  `SELECT bm.*, r.trigger_type FROM black_marks bm LEFT JOIN blackmark_rules r ON r.id = bm.rule_id WHERE bm.task_id = $1 ORDER BY bm.id`, [taskId],
)).rows;

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1)`);
  ids.dept = (await query('SELECT id FROM departments')).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('Backlog', 'backlog', 'backlog', '#999', 1, FALSE), ('To Do', 'to-do', 'todo', '#3b82f6', 2, TRUE),
    ('Blocked', 'blocked', 'blocked', '#ef4444', 3, FALSE), ('Done', 'done', 'done', '#22c55e', 4, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) st[r.stage] = r.id;
  const password = await hashPassword('Password123!');
  for (const [key, role] of [['admin', 'admin'], ['ana', 'member'], ['bo', 'member'], ['meera', 'manager'], ['gone', 'member']]) {
    const email = `${key}.f@test.local`;
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, email, password, role, ids.dept],
    );
    ids[key] = rows[0].id;
    ids[`${key}_email`] = email;
  }
  // the default rules (db/seed.js), in force for a while
  const { rows } = await query(
    `INSERT INTO blackmark_rules (name, trigger_type, points, grace_hours, priorities, repeat_every_days, max_points_per_task, effective_from) VALUES
      ('Missed deadline', 'deadline_missed', 1, 24, '{}', NULL, NULL, now() - interval '400 days'),
      ('Missed deadline on a critical task', 'deadline_missed', 2, 4, '{critical,high}', NULL, NULL, now() - interval '400 days'),
      ('Still overdue — weekly escalation', 'overdue_escalation', 1, 24, '{}', 7, 3, now() - interval '400 days'),
      ('Delivered late', 'completed_late', 0.5, 24, '{}', NULL, NULL, now() - interval '400 days')
     RETURNING id, trigger_type, points`,
  );
  rules.general = rows[0].id;
  rules.critical = rows[1].id;
  rules.escalation = rows[2].id;
  rules.late = rows[3].id;
  await updateSetting('blackmarks', { warningPoints: 3, criticalPoints: 6, missedDeadlineLimit: 3, rollingWindowMonths: 1, notifyMember: false });
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'ana', 'bo', 'meera']) {
    tokens[key] = ok(await call('POST', '/auth/login', { body: { email: ids[`${key}_email`], password: 'Password123!' } })).token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('14: a critical task missed and finished three weeks late: one missed mark, capped escalation, no late mark on top', async (t) => {
  if (skip(t)) return;
  const due = Date.now() - 22 * DAY;
  const id = await mkTask({ title: 'Critical: file the licence renewal', dueMs: due, priority: 'critical' });
  // the scan as it would have run: after each grace period, then every few days
  for (const at of [due + 5 * HOUR, due + 25 * HOUR, due + 8 * DAY, due + 15 * DAY, due + 21 * DAY]) await runBlackMarkScan({ now: new Date(at) });
  await query('UPDATE tasks SET status_id = $1, completed_at = $2 WHERE id = $3', [st.done, new Date(due + 21 * DAY), id]);
  await runBlackMarkScan({ now: new Date(due + 21 * DAY + HOUR) });
  const got = await marks(id);
  const byKind = got.reduce((a, m) => ({ ...a, [m.trigger_type]: (a[m.trigger_type] || 0) + Number(m.points) }), {});
  assert.deepEqual(Object.keys(byKind).sort(), ['deadline_missed', 'overdue_escalation']);
  assert.equal(got.filter((m) => m.trigger_type === 'deadline_missed').length, 1, 'one missed mark, not two');
  assert.equal(got.find((m) => m.trigger_type === 'deadline_missed').rule_id, rules.critical, 'from the most specific rule');
  assert.equal(byKind.deadline_missed, 2);
  const total = got.reduce((a, m) => a + Number(m.points), 0);
  assert.ok(total <= 4, `at most 4 points now (was 5.5): ${total}`);
  const evidence = got.find((m) => m.trigger_type === 'deadline_missed').evidence;
  assert.deepEqual(evidence.precedence, { applied: rules.critical, overlapping: [rules.general] });

  // the live rules, in words: the overlap and the before/after cost
  const report = ok(await call('GET', '/blackmarks/rules/report', { token: tokens.meera }));
  assert.ok(report.overlaps.some((p) => p.includes('Missed deadline') && p.includes('Missed deadline on a critical task')));
  const critical = report.examples.find((e) => e.priority === 'critical');
  assert.deepEqual([critical.points_before, critical.points_now], [5.5, 4]);
});

test('19: escalation counts working days, and the rules say so', async (t) => {
  if (skip(t)) return;
  const list = ok(await call('GET', '/blackmarks/rules', { token: tokens.meera }));
  assert.equal(list.rules.find((r) => r.id === rules.escalation).repeat_unit, 'working days');
});

test('16: the mark belongs to whoever owned the task at its deadline; escalation stops when it changes hands', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Send the soil samples', owner: ids.ana, dueMs: Date.now() - 2 * HOUR });
  // handed to Bo inside the grace period (the trigger records the change)
  await query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [ids.bo, id]);
  await runBlackMarkScan({ now: new Date(Date.now() + 23 * HOUR) });
  const got = await marks(id);
  assert.equal(got.length, 1);
  assert.equal(got[0].user_id, ids.ana, 'Ana owned it at the deadline');
  assert.equal(got[0].evidence.owner_at_deadline, ids.ana);
  // ten days later still open: no escalation for either of them (it changed hands)
  await runBlackMarkScan({ now: new Date(Date.now() + 10 * DAY) });
  assert.equal((await marks(id)).filter((m) => m.trigger_type === 'overdue_escalation').length, 0);
});

test('17: deferred, blocked (accepted), deactivated: no marks; Backlog without a deferral still counts', async (t) => {
  if (skip(t)) return;
  const deadline = Date.now() - 2 * DAY;
  // an approved deferral pauses the deadline
  const deferred = await mkTask({ title: 'Deferred work', dueMs: deadline, stage: 'backlog' });
  const { rows: [change] } = await query(
    `INSERT INTO task_deadline_changes (task_id, kind, requested_by, reason, from_due, before_deadline, review_date, next_action, status)
     VALUES ($1, 'DEFER', $2, 'Waiting for the season', $3, TRUE, now()::date + 10, 'Look again', 'APPROVED') RETURNING id`,
    [deferred, ids.ana, new Date(deadline)],
  );
  await query('UPDATE tasks SET deferral_id = $1 WHERE id = $2', [change.id, deferred]);
  // an accepted block recorded before the deadline
  const blocked = await mkTask({ title: 'Blocked work', dueMs: deadline, stage: 'blocked' });
  await query(
    `INSERT INTO task_blocks (task_id, reason, recorded_by, recorded_at, status, decided_by, decided_at) VALUES ($1, 'Waiting for customs', $2, $3, 'ACCEPTED', $4, $3)`,
    [blocked, ids.ana, new Date(deadline - HOUR), ids.meera],
  );
  // a block nobody accepted does not pause anything
  const unaccepted = await mkTask({ title: 'Unaccepted block', dueMs: deadline, stage: 'blocked' });
  await query(`INSERT INTO task_blocks (task_id, reason, recorded_by, recorded_at) VALUES ($1, 'Says it is blocked', $2, $3)`, [unaccepted, ids.ana, new Date(deadline - HOUR)]);
  // a deactivated owner
  const gone = await mkTask({ title: 'Left the company', owner: ids.gone, dueMs: deadline });
  await query('UPDATE users SET is_active = FALSE WHERE id = $1', [ids.gone]);
  // Backlog, no deferral: still a commitment with a deadline
  const backlog = await mkTask({ title: 'Backlog with a deadline', dueMs: deadline, stage: 'backlog' });

  await runBlackMarkScan({ now: new Date() });
  assert.equal((await marks(deferred)).length, 0, 'deferred');
  assert.equal((await marks(blocked)).length, 0, 'accepted block');
  assert.equal((await marks(gone)).length, 0, 'deactivated');
  assert.equal((await marks(unaccepted)).length, 1, 'a block nobody accepted');
  assert.equal((await marks(backlog)).length, 1, 'Backlog without a deferral');
});

test('15: a new rule applies from when it is saved; earlier work only by preview and approval', async (t) => {
  if (skip(t)) return;
  // finished three weeks ago, ten days after its deadline, at a time no "delivered late" rule existed
  const old = await mkTask({ title: 'Old late finish', dueMs: Date.now() - 30 * DAY });
  await query('UPDATE tasks SET status_id = $1, completed_at = now() - interval \'20 days\' WHERE id = $2', [st.done, old]);
  await query('UPDATE blackmark_rules SET is_active = FALSE WHERE id = $1', [rules.late]);
  await runBlackMarkScan();
  assert.equal((await marks(old)).length, 0);
  const created = ok(await call('POST', '/blackmarks/rules', {
    token: tokens.admin, body: { name: 'Finished late (Operations)', trigger_type: 'completed_late', points: 3, grace_hours: 0, department_ids: [ids.dept] },
  }), 201);
  assert.ok(created.rule.effective_from, 'applies from now');
  await runBlackMarkScan();
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM black_marks WHERE rule_id = $1`, [created.rule.id])).rows[0].n, 0, 'saving a rule creates nothing for the past');

  const preview = ok(await call('POST', `/blackmarks/rules/${created.rule.id}/backfill/preview`, { token: tokens.admin }));
  assert.ok(preview.occurrences >= 1);
  assert.ok(preview.preview.some((p) => p.task_id === old && p.person === 'Ana Sample'));
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM black_marks WHERE rule_id = $1`, [created.rule.id])).rows[0].n, 0, 'the preview wrote nothing');
  assert.equal((await call('POST', `/blackmarks/backfills/${preview.id}/apply`, { token: tokens.admin, body: { fingerprint: 'not-the-one-shown', note: 'Agreed at the review' } })).status, 400);
  assert.equal((await call('POST', `/blackmarks/backfills/${preview.id}/apply`, { token: tokens.ana, body: { fingerprint: preview.fingerprint, note: 'x' } })).status, 403);
  const applied = ok(await call('POST', `/blackmarks/backfills/${preview.id}/apply`, { token: tokens.admin, body: { fingerprint: preview.fingerprint, note: 'Agreed at the monthly review' } }));
  assert.equal(applied.created, preview.occurrences);
  const mark = (await query(`SELECT evidence FROM black_marks WHERE rule_id = $1 AND task_id = $2`, [created.rule.id, old])).rows[0];
  assert.equal(mark.evidence.backfill_id, preview.id);
  assert.equal((await call('POST', `/blackmarks/backfills/${preview.id}/apply`, { token: tokens.admin, body: { fingerprint: preview.fingerprint, note: 'Again please' } })).status, 400, 'once');
  await query('UPDATE blackmark_rules SET is_active = TRUE WHERE id = $1', [rules.late]);

  // editing a rule's terms restarts its effective date; renaming it does not
  const renamed = ok(await call('PATCH', `/blackmarks/rules/${rules.general}`, { token: tokens.admin, body: { name: 'Missed deadline (all work)' } }));
  assert.equal(renamed.restarted, false);
  const repointed = ok(await call('PATCH', `/blackmarks/rules/${rules.general}`, { token: tokens.admin, body: { grace_hours: 12 } }));
  assert.equal(repointed.restarted, true);
  assert.ok(new Date(repointed.rule.effective_from) > new Date(Date.now() - 60_000));
});

test('18: the person appeals; a reviewer decides, never their own', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Appealed task', dueMs: Date.now() - 3 * DAY });
  await query('UPDATE blackmark_rules SET effective_from = now() - interval \'400 days\' WHERE id = $1', [rules.general]);
  await runBlackMarkScan();
  const mark = (await marks(id))[0];
  assert.equal((await call('POST', `/blackmarks/${mark.id}/appeal`, { token: tokens.bo, body: { reason: 'Not mine but I want it gone' } })).status, 403, 'only your own');
  const appeal = ok(await call('POST', `/blackmarks/${mark.id}/appeal`, { token: tokens.ana, body: { reason: 'The client moved the meeting; see the email', evidence_url: 'https://example.test/mail/1' } }), 201);
  assert.equal((await call('POST', `/blackmarks/${mark.id}/appeal`, { token: tokens.ana, body: { reason: 'Second appeal while the first waits' } })).status, 400);
  const mine = ok(await call('GET', '/blackmarks/appeals', { token: tokens.ana }));
  assert.equal(mine.can_decide, false);
  assert.equal(mine.appeals.length, 1);
  assert.equal((await call('POST', `/blackmarks/appeals/${appeal.appeal.id}/decide`, { token: tokens.ana, body: { decision: 'WAIVE', reason: 'I agree with myself' } })).status, 403);
  ok(await call('POST', `/blackmarks/appeals/${appeal.appeal.id}/decide`, { token: tokens.meera, body: { decision: 'WAIVE', reason: 'The email shows the client moved it' } }));
  const now = (await marks(id))[0];
  assert.equal(now.status, 'waived');
  assert.match(now.waived_reason, /^Appeal #\d+ upheld: The email shows/);
  const history = ok(await call('GET', `/blackmarks/${mark.id}/history`, { token: tokens.ana }));
  assert.deepEqual(history.audit.map((a) => a.action), ['APPEALED', 'WAIVED']);
  const told = (await query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'blackmark_appeal'`, [ids.ana])).rows[0];
  assert.match(told.title, /accepted: the mark is waived/);
});

test('the recheck list says why an existing mark would not be given today; nothing is waived automatically', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Stacked under the old rules', dueMs: Date.now() - 4 * DAY, priority: 'high' });
  await query('UPDATE tasks SET status_id = $1, completed_at = $2 WHERE id = $3', [st.done, new Date(Date.now() - 2 * DAY), id]);
  // marks as the old rules recorded them: both missed-deadline rules, and "delivered late" on top
  for (const [rule, key, pts] of [[rules.general, 'missed', 1], [rules.critical, 'missed', 2], [rules.late, 'late', 0.5]]) {
    await recordBlackMark({ userId: ids.ana, taskId: id, ruleId: rule, points: pts, reason: 'old', occurredAt: new Date(Date.now() - 3 * DAY), occurrenceKey: `rule:${rule}:task:${id}:${key}` });
  }
  const list = await marksToRecheck();
  const reasonsFor = (rule) => list.find((m) => m.task_id === id && m.rule_name === rule)?.reasons || [];
  assert.deepEqual(reasonsFor('Missed deadline (all work)'), ['STACKED']);
  assert.deepEqual(reasonsFor('Missed deadline on a critical task'), []);
  assert.deepEqual(reasonsFor('Delivered late'), ['LATE_AFTER_MISSED']);
  assert.ok((await marks(id)).every((m) => m.status === 'active'), 'listed, not waived');
});

test('three counts kept apart: tasks missed, mark events, weighted points', async (t) => {
  if (skip(t)) return;
  const review = await monthlyReview({});
  const ana = review.members.find((m) => m.user_id === ids.ana);
  assert.ok(ana.mark_events >= ana.tasks_missed);
  assert.equal(typeof ana.total_points, 'number');
  assert.ok(ana.tasks_missed >= 1);
});
