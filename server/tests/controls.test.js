/**
 * Reporting and controls.
 *
 * Guarded here: the data-quality report names exactly what is missing or
 * inconsistent, and never merges anything; open work with no estimate is never
 * read as spare capacity; escalations reach the deal's escalation point once and
 * are on the record; the investor summary counts only what the record supports,
 * marks estimates, and carries nobody's contact details; the audit trail shows
 * who changed what and why, and history cannot be edited or removed; and
 * reminders come on each person's schedule, never during their leave, and never
 * twice.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { notify } from '../src/services/activity.js';
import { namesAlike, normalizeName, phoneKey, websiteDomain } from '../src/services/dataQuality.js';
import { digestDue, onlyRepeats } from '../src/services/reminders.js';
import { workload } from '../src/services/metrics.js';
import { runAccountScan } from '../src/jobs/accountScanner.js';
import { runPipelineWeekly } from '../src/jobs/pipelineWeekly.js';
import { weekOf } from '../src/services/weekly.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

const call = async (method, path, { token, body, raw = false } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const day = (offset = 0) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offset * 86400000));
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const quality = async (params = '') => (await call('GET', `/crm/data-quality${params}`, { token: tokens.manager })).body;
const check = (report, key) => report.checks.find((c) => c.key === key);
const listed = (report, key, dealId) => check(report, key).items.some((i) => i.entity_id === dealId);

const lead = async (body, token = tokens.manager) => {
  const res = await call('POST', '/accounts', {
    token, body: { owner_user_id: ids.manager, department_id: ids.department, ...body },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const detail = await call('GET', `/accounts/${res.body.account.id}`, { token: tokens.manager });
  return { account: res.body.account, deal: detail.body.opportunities[0] };
};
const next = (owner, offset = 3, text = 'Call them back') => ({
  next_step: text, next_step_owner_id: owner, next_step_due: day(offset),
});

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('BIZ', 'Business', '#2a78d6', 1)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Blocked', 'blocked', 'blocked', '#ef4444', 2, FALSE),
    ('Done', 'done', 'done', '#22c55e', 3, FALSE)`);
  ids.department = (await query(`SELECT id FROM departments`)).rows[0].id;
  ids.todo = (await query(`SELECT id FROM workflow_statuses WHERE slug = 'to-do'`)).rows[0].id;
  ids.done = (await query(`SELECT id FROM workflow_statuses WHERE slug = 'done'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, name, role] of [
    ['manager', 'Vartika Head', 'manager'], ['rupendra', 'Rupendra Rep', 'member'],
    ['saumya', 'Saumya Rep', 'member'], ['admin', 'Ada Admin', 'admin'],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [name, `${key}@ekosight.com`, password, role, ids.department],
    );
    ids[key] = rows[0].id;
  }
  const { rows: stages } = await query('SELECT id, slug FROM account_stages');
  for (const s of stages) ids[`stage_${s.slug.replace(/-/g, '_')}`] = s.id;

  await new Promise((resolve) => {
    server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  for (const key of ['manager', 'rupendra', 'saumya', 'admin']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `${key}@ekosight.com`, password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- 16. history only grows

test('the history of who changed what cannot be edited or removed', async (t) => {
  if (skip(t)) return;
  const { deal } = await lead({ name: 'Ledger Seeds', ...next(ids.manager) });
  await call('PATCH', `/opportunities/${deal.id}`, { token: tokens.manager, body: { estimated_value: 120000 } });
  const { rows } = await query('SELECT id FROM opportunity_history WHERE opportunity_id = $1 LIMIT 1', [deal.id]);
  assert.ok(rows[0], 'the change is on its history');
  await assert.rejects(query(`UPDATE opportunity_history SET reason = 'rewritten' WHERE id = $1`, [rows[0].id]), /append-only/);
  await assert.rejects(query('DELETE FROM opportunity_history WHERE id = $1', [rows[0].id]), /append-only/);
  // and removing the deal outright would take its history with it, so that is refused too
  await assert.rejects(query('DELETE FROM opportunities WHERE id = $1', [deal.id]), /append-only/);
  await query(
    `INSERT INTO crm_ownership_history (entity_type, entity_id, from_user_id, to_user_id, changed_by)
     VALUES ('ACCOUNT', $1, NULL, $2, $2)`,
    [deal.account_id, ids.manager],
  );
  await assert.rejects(query(`UPDATE crm_ownership_history SET reason = 'x'`), /append-only/);
  const still = await query('SELECT COUNT(*)::int AS n FROM opportunity_history WHERE opportunity_id = $1', [deal.id]);
  assert.ok(still.rows[0].n >= 1);
});

// ---------------------------------------------------------------- 13. data quality

test('names, websites and phones are compared for what identifies them', () => {
  assert.equal(normalizeName('FarMart Agri Pvt. Ltd.'), 'farmart agri');
  assert.equal(normalizeName('The Coromandel International Limited'), 'coromandel international');
  assert.equal(normalizeName('Shah & Sons'), 'shah sons');
  assert.equal(websiteDomain('https://www.farmart.co/about?x=1'), 'farmart.co');
  assert.equal(websiteDomain('farmart.co'), 'farmart.co');
  assert.equal(phoneKey('+91 98765-43210'), '9876543210');
  assert.equal(phoneKey('098765 43210'), '9876543210');
  assert.equal(phoneKey('123'), '', 'too short to compare');
  assert.ok(namesAlike('farmart agri', 'farmartagri'));
  assert.ok(namesAlike('krishi vikas foundation', 'krishi vikaas foundation'), 'one letter apart');
  assert.ok(!namesAlike('agro tech', 'agri tech'), 'short names must match exactly');
  assert.ok(!namesAlike('coromandel', 'farmart agri'));
});

test('the data-quality report names each missing or inconsistent thing, and who can fix it', async (t) => {
  if (skip(t)) return;
  // a clean deal, for the score
  const clean = await lead({ name: 'Clean Farms', ...next(ids.manager) });
  await call('PATCH', `/opportunities/${clean.deal.id}`, { token: tokens.manager, body: { estimated_value: 100000 } });
  const contact = await call('POST', `/accounts/${clean.account.id}/contacts`, {
    token: tokens.manager, body: { full_name: 'Kiran Clean', email: 'kiran@cleanfarms.example' },
  });
  await call('POST', `/opportunities/${clean.deal.id}/contacts`, {
    token: tokens.manager, body: { contact_id: contact.body.contact.id, role: 'CHAMPION' },
  });

  const messy = await lead({ name: 'Messy Agro', ...next(ids.rupendra) });
  ids.messyDeal = messy.deal.id;
  // the kinds of gap an older record has
  await query(
    `UPDATE opportunities SET next_step_owner_id = NULL, owner_user_id = NULL, expected_close = $2::date
      WHERE id = $1`,
    [messy.deal.id, day(-4)],
  );

  const report = await quality();
  assert.equal(report.summary.live_deals >= 2, true);
  assert.ok(listed(report, 'no_owner', messy.deal.id));
  assert.ok(listed(report, 'no_next_action', messy.deal.id));
  const gap = check(report, 'no_next_action').items.find((i) => i.entity_id === messy.deal.id);
  assert.match(gap.detail, /nobody owes it/);
  assert.ok(listed(report, 'no_value', messy.deal.id));
  assert.ok(listed(report, 'close_date_passed', messy.deal.id));
  assert.ok(listed(report, 'no_contact', messy.deal.id));
  assert.ok(!listed(report, 'no_value', clean.deal.id), 'a deal with a value is not flagged for one');
  assert.ok(!['no_owner', 'no_next_action', 'no_value', 'no_contact'].some((key) => listed(report, key, clean.deal.id)));
  assert.ok(report.summary.clean_deals >= 1);
  assert.ok(report.summary.clean_percent < 100);
  for (const c of report.checks) {
    assert.ok(c.label && c.why && c.fix, `${c.key} says what it is, why it matters and how to fix it`);
  }

  // marking the value as not yet known is an answer, not a gap
  await query('UPDATE opportunities SET value_unknown = TRUE WHERE id = $1', [messy.deal.id]);
  assert.ok(!listed(await quality(), 'no_value', messy.deal.id));

  // somebody named at the organization, even if not yet linked to the deal, is not a gap
  await call('POST', `/accounts/${messy.account.id}/contacts`, {
    token: tokens.manager, body: { full_name: 'Meera Messy', email: 'meera@messyagro.example' },
  });
  assert.ok(!listed(await quality(), 'no_contact', messy.deal.id));
});

test('a stage the record does not support, and a status at odds with its stage, are flagged', async (t) => {
  if (skip(t)) return;
  // moved into Proposal before proposals were recorded
  const legacy = await lead({ name: 'Legacy Proposal Co', ...next(ids.manager) });
  await query('UPDATE opportunities SET stage_id = $2 WHERE id = $1', [legacy.deal.id, ids.stage_proposal]);
  // won in the old days, with no order
  const won = await lead({ name: 'Old Win Ltd', ...next(ids.manager) });
  await query(`UPDATE opportunities SET status = 'WON', stage_id = $2, closed_at = now() WHERE id = $1`, [won.deal.id, ids.stage_won]);
  // live, but sitting in Lost
  const odd = await lead({ name: 'Odd State Farms', ...next(ids.manager) });
  await query('UPDATE opportunities SET stage_id = $2 WHERE id = $1', [odd.deal.id, ids.stage_lost]);
  // nurtured with no date to look again
  const paused = await lead({ name: 'Forgotten Nurture', ...next(ids.manager) });
  await query(`UPDATE opportunities SET status = 'NURTURE', revisit_on = NULL WHERE id = $1`, [paused.deal.id]);

  const report = await quality();
  const unsupported = check(report, 'stage_unsupported').items;
  assert.match(unsupported.find((i) => i.entity_id === legacy.deal.id).detail, /in Proposal without a dated proposal on record/);
  assert.match(unsupported.find((i) => i.entity_id === won.deal.id).detail, /an accepted order or contract on record/);
  assert.ok(listed(report, 'stage_misplaced', odd.deal.id));
  assert.ok(listed(report, 'paused_no_revisit', paused.deal.id));

  // recording the proposal clears it
  await call('POST', `/opportunities/${legacy.deal.id}/proposals`, {
    token: tokens.manager, body: { sent_on: day(-2), amount: 300000 },
  });
  assert.ok(!listed(await quality(), 'stage_unsupported', legacy.deal.id));
});

test('organizations that look alike are flagged, never merged, and can be marked different', async (t) => {
  if (skip(t)) return;
  const a = await lead({ name: 'Bharat Krishi Pvt Ltd', website: 'https://www.bharatkrishi.in', ...next(ids.manager) });
  const b = await lead({ name: 'Bharat Krishi', ...next(ids.manager) });
  const c = await lead({ name: 'Green Valley Organics', website: 'http://bharatkrishi.in/contact', ...next(ids.manager) });
  let report = await quality();
  const cluster = check(report, 'duplicate_orgs').items.find((i) => i.accounts.some((x) => x.id === a.account.id));
  assert.ok(cluster, 'alike names and a shared website are found');
  assert.deepEqual(cluster.accounts.map((x) => x.id).sort(), [a.account.id, b.account.id, c.account.id].sort());
  assert.match(cluster.detail, /same name/);
  assert.match(cluster.detail, /same website \(bharatkrishi\.in\)/);
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM accounts WHERE id = ANY($1::int[]) AND is_archived = FALSE',
    [[a.account.id, b.account.id, c.account.id]]);
  assert.equal(rows[0].n, 3, 'nothing is merged or archived by the check');

  const notMine = await call('POST', '/crm/data-quality/duplicates/dismiss', {
    token: tokens.rupendra, body: { account_ids: [a.account.id, c.account.id], reason: 'different firms' },
  });
  assert.equal(notMine.status, 403);
  const vague = await call('POST', '/crm/data-quality/duplicates/dismiss', {
    token: tokens.manager, body: { account_ids: [a.account.id, c.account.id], reason: 'no' },
  });
  assert.equal(vague.status, 400);
  const ok = await call('POST', '/crm/data-quality/duplicates/dismiss', {
    token: tokens.manager, body: { account_ids: [c.account.id, a.account.id], reason: 'Green Valley bought the old domain; different firm' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  report = await quality();
  const after1 = check(report, 'duplicate_orgs').items.find((i) => i.accounts.some((x) => x.id === a.account.id));
  assert.deepEqual(after1.accounts.map((x) => x.id).sort(), [a.account.id, b.account.id].sort(),
    'the pair marked different is apart; the real duplicate is still flagged');
  const audit = await call('GET', '/crm/audit?group=other', { token: tokens.manager });
  assert.ok(audit.body.entries.some((e) => e.field === 'duplicate_dismissed' && /different firm/.test(e.reason)));
});

test('finished deal tasks without an outcome or evidence are listed', async (t) => {
  if (skip(t)) return;
  const { account } = await lead({ name: 'Task Trail Agro', ...next(ids.manager) });
  const insert = (ref, outcome, evidence) => query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, priority, account_id,
                        completed_at, outcome_status, outcome_evidence_url)
     VALUES ($1, $2, $3, $4, $5, $5, 'medium', $6, now() - interval '2 days', $7, $8) RETURNING id`,
    [ref, `Task ${ref}`, ids.department, ids.done, ids.rupendra, account.id, outcome, evidence],
  );
  const bare = (await insert('DQ-1', null, null)).rows[0].id;
  const noLink = (await insert('DQ-2', 'ACHIEVED', null)).rows[0].id;
  const evidenced = (await insert('DQ-3', 'ACHIEVED', 'https://drive.example/report')).rows[0].id;
  const report = await quality();
  const items = check(report, 'task_no_evidence').items;
  assert.match(items.find((i) => i.entity_id === bare).detail, /no outcome recorded/);
  assert.match(items.find((i) => i.entity_id === noLink).detail, /no link to the evidence/);
  assert.ok(!items.some((i) => i.entity_id === evidenced));
  assert.equal(items.find((i) => i.entity_id === bare).owner_user_id, ids.rupendra, 'the person who can fix it');

  // "mine" is what one person can fix
  const mine = (await call('GET', '/crm/data-quality?mine=true', { token: tokens.rupendra })).body;
  assert.ok(check(mine, 'task_no_evidence').items.some((i) => i.entity_id === bare));
  assert.ok(!check(mine, 'duplicate_orgs').count, 'organization-wide checks are not anybody\'s own list');
});

// ---------------------------------------------------------------- 14. capacity and workload

test('open work with no estimate is never read as spare capacity', async (t) => {
  if (skip(t)) return;
  const password = await hashPassword('Password123!');
  // no comfortable task count set, so hours are the only measure
  const { rows } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, department_id, weekly_capacity_hours,
                        max_concurrent_tasks, must_change_password)
     VALUES ('Partly Planned', 'partly@ekosight.com', $1, 'member', $2, 40, 0, FALSE) RETURNING id`,
    [password, ids.department],
  );
  const person = rows[0].id;
  const task = (ref, hours) => query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, priority, estimate_hours)
     VALUES ($1, $1, $2, $3, $4, $4, 'medium', $5)`,
    [ref, ids.department, ids.todo, person, hours],
  );
  await task('CAP-1', 4);
  for (let i = 2; i <= 6; i += 1) await task(`CAP-${i}`, null);

  let row = (await workload({})).find((w) => w.id === person);
  assert.equal(row.unestimated_tasks, 5);
  assert.equal(row.load_basis, 'hours_partial', '4 hours is a floor, not the load');
  assert.equal(row.status, 'unknown', 'not "has capacity"');

  // with every task estimated, hours say it
  await query(`UPDATE tasks SET estimate_hours = 2 WHERE assignee_id = $1 AND estimate_hours IS NULL`, [person]);
  row = (await workload({})).find((w) => w.id === person);
  assert.equal(row.load_basis, 'hours');
  assert.equal(row.unestimated_tasks, 0);
  assert.equal(row.status, 'available', '14 of 40 hours, measured');

  // nothing estimated and no comfortable count set: unknown, again not spare
  await query(`UPDATE tasks SET estimate_hours = NULL WHERE assignee_id = $1`, [person]);
  row = (await workload({})).find((w) => w.id === person);
  assert.equal(row.load_percent, null);
  assert.equal(row.status, 'unknown');

  // measured by count, a short list of unsized work still does not prove room…
  await query('UPDATE users SET max_concurrent_tasks = 20 WHERE id = $1', [person]);
  row = (await workload({})).find((w) => w.id === person);
  assert.equal(row.load_basis, 'tasks');
  assert.equal(row.status, 'unknown');
  // …though a long one is enough to say someone is busy
  await query('UPDATE users SET max_concurrent_tasks = 6 WHERE id = $1', [person]);
  row = (await workload({})).find((w) => w.id === person);
  assert.equal(row.status, 'overloaded');
});

test('the workload view lists what each person owes, what is blocked, and what needs escalating', async (t) => {
  if (skip(t)) return;
  const { deal } = await lead({ name: 'Escalation Agro', ...next(ids.rupendra) });
  ids.escalationDeal = deal.id;
  await call('PATCH', `/opportunities/${deal.id}`, { token: tokens.manager, body: { escalation_owner_id: ids.saumya } });
  await query('UPDATE opportunities SET next_step_due = $2::date WHERE id = $1', [deal.id, day(-5)]);
  await call('POST', '/threads', {
    token: tokens.manager,
    body: {
      entity_type: 'OPPORTUNITY', entity_id: deal.id, kind: 'blocker', category: 'PRICING_APPROVAL',
      title: 'Price needs sign-off', body: 'Their CFO has to approve the rate.', blocked_item: 'Pricing approval',
      dependency: 'EXTERNAL', external_party: 'Their CFO', responsible_user_id: ids.rupendra, expected_resolution: day(4),
    },
  });

  const view = await call('GET', '/crm/workload', { token: tokens.rupendra });
  assert.equal(view.status, 200);
  const me = view.body.people.find((p) => p.user.id === ids.rupendra);
  assert.ok(me.due.overdue.some((i) => i.kind === 'next_action' && i.opportunity_id === deal.id));
  assert.ok(me.blocked.some((b) => b.kind === 'blocker' && b.on === 'Their CFO'));
  assert.equal(me.counts.blocked >= 1, true);
  assert.ok('capacity' in me);
  const names = view.body.people.map((p) => p.user.full_name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'listed by name, never ranked by load');
  const escalation = view.body.escalations.find((e) => e.opportunity_id === deal.id && e.kind === 'next_action');
  assert.match(escalation.reason, /5 days overdue/);
  assert.equal(escalation.escalate_to, ids.saumya);
  assert.equal(escalation.escalate_to_name, 'Saumya Rep');
});

test('escalating a deal tells its escalation point once a day, on the record', async (t) => {
  if (skip(t)) return;
  const id = ids.escalationDeal;
  const vague = await call('POST', `/opportunities/${id}/escalate`, { token: tokens.rupendra, body: { reason: 'pls' } });
  assert.equal(vague.status, 400);
  const outsider = await lead({ name: 'Not Rupendras', ...next(ids.manager) });
  const forbidden = await call('POST', `/opportunities/${outsider.deal.id}/escalate`, {
    token: tokens.rupendra, body: { reason: 'Need a decision on pricing' },
  });
  assert.equal(forbidden.status, 403, 'only someone working on the deal, or a pipeline manager');
  const nowhere = await call('POST', `/opportunities/${outsider.deal.id}/escalate`, {
    token: tokens.manager, body: { reason: 'Need a decision on pricing' },
  });
  assert.equal(nowhere.status, 400, 'a deal with no escalation point needs someone named');

  const sent = await call('POST', `/opportunities/${id}/escalate`, {
    token: tokens.rupendra, body: { reason: 'Their CFO wants a call with someone senior before approving' },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.escalated_to.id, ids.saumya);
  const inbox = await call('GET', '/notifications', { token: tokens.saumya });
  assert.ok(inbox.body.notifications.some((n) => n.type === 'crm_escalation' && /escalated Escalation Agro/.test(n.title)));
  const detail = await call('GET', `/opportunities/${id}`, { token: tokens.manager });
  const entry = detail.body.history.find((h) => h.field === 'escalated_to_user_id');
  assert.equal(Number(entry.to_value), ids.saumya);
  assert.match(entry.reason, /CFO wants a call/);

  const again = await call('POST', `/opportunities/${id}/escalate`, {
    token: tokens.rupendra, body: { reason: 'Still waiting on the pricing decision' },
  });
  assert.equal(again.status, 400, 'once a day');
  const view = await call('GET', '/crm/workload', { token: tokens.manager });
  assert.ok(view.body.escalations.find((e) => e.opportunity_id === id).escalated_today);
});

// ---------------------------------------------------------------- 15. the investor summary

test('the investor summary counts only what the record supports, and marks estimates', async (t) => {
  if (skip(t)) return;
  // a won deal backed by an order, invoiced and partly paid
  const won = await lead({ name: 'Verified Buyer Pvt Ltd', ...next(ids.manager) });
  const person = await call('POST', `/accounts/${won.account.id}/contacts`, {
    token: tokens.manager, body: { full_name: 'Ravi Confidential', email: 'ravi.private@verifiedbuyer.example', phone: '+91 99999 11111' },
  });
  assert.equal(person.status, 201);
  const moved = await call('POST', `/opportunities/${won.deal.id}/stage`, {
    token: tokens.manager,
    body: { stage_id: ids.stage_won, order: { kind: 'PURCHASE_ORDER', reference: 'VB/PO/7', received_on: day(-3), amount: 900000 } },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  await call('POST', `/opportunities/${won.deal.id}/orders`, { token: tokens.manager, body: { reference: 'VB/PO/8', received_on: day(-2) } });
  await call('POST', `/opportunities/${won.deal.id}/invoices`, { token: tokens.manager, body: { number: 'INV-1', issued_on: day(-2), amount: 450000 } });
  await call('POST', `/opportunities/${won.deal.id}/payments`, { token: tokens.manager, body: { received_on: day(-1), amount: 200000 } });

  // a live deal at Proposal with a proposal, and one with only an estimate
  const proposed = await lead({ name: 'Proposal Stage Farms', ...next(ids.manager) });
  await call('POST', `/opportunities/${proposed.deal.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_proposal, proposal: { sent_on: day(-1), amount: 400000 }, ...next(ids.manager) },
  });
  const estimated = await lead({ name: 'Estimate Only Co', ...next(ids.manager) });
  await call('PATCH', `/opportunities/${estimated.deal.id}`, { token: tokens.manager, body: { estimated_value: 250000 } });
  // a move made without its evidence, and a "won" with no order
  await query(
    `INSERT INTO opportunity_history (opportunity_id, field, from_value, to_value, actor_id, reason, evidence_missing)
     VALUES ($1, 'stage', 'New', 'Proposal', $2, 'Manager override', ARRAY['proposal'])`,
    [estimated.deal.id, ids.manager],
  );
  const shaky = await lead({ name: 'Unbacked Win', ...next(ids.manager) });
  await query(`UPDATE opportunities SET status = 'WON', stage_id = $2, closed_at = now() WHERE id = $1`, [shaky.deal.id, ids.stage_won]);

  const from = day(-30);
  const res = await call('GET', `/crm/investor-summary?from=${from}&to=${day(0)}`, { token: tokens.manager });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body;
  assert.equal(s.as_of_date, day(0));
  assert.equal(s.verified.bookings.orders >= 2, true);
  assert.equal(s.verified.bookings.amount, 900000, 'an order with no amount is counted but adds nothing');
  assert.ok(s.verified.bookings.orders_without_amount >= 1);
  assert.equal(s.verified.invoiced.amount, 450000);
  assert.equal(s.verified.collections.amount, 200000);
  assert.equal(s.verified.receivable.amount, 250000);
  assert.ok(s.verified.wins.deals >= 1);
  assert.ok(s.excluded.some((e) => /without the evidence/.test(e.what) && e.count >= 1));
  assert.ok(s.excluded.some((e) => /Won with no accepted order/.test(e.what) && e.count >= 1));
  const proposalStage = s.pipeline.by_stage.find((st) => st.stage === 'Proposal');
  assert.ok(proposalStage.proposed >= 400000);
  assert.ok(s.pipeline.estimated_total >= 250000, 'estimates are kept apart');
  assert.match(s.definitions.estimated, /estimate/i);

  // nobody's contact details, and none of our staff's names
  const text = JSON.stringify(s);
  for (const secret of ['Ravi Confidential', 'ravi.private@verifiedbuyer.example', '99999', 'Vartika Head', 'Rupendra Rep']) {
    assert.ok(!text.includes(secret), `${secret} is not in the summary`);
  }
  assert.ok(text.includes('Verified Buyer Pvt Ltd'), 'organization names, unless hidden');
  const hidden = (await call('GET', `/crm/investor-summary?from=${from}&to=${day(0)}&anonymise=true`, { token: tokens.manager })).body;
  assert.ok(!JSON.stringify(hidden).includes('Verified Buyer'));
  assert.equal(hidden.customers[0].organization, 'Organization A');

  const future = await call('GET', `/crm/investor-summary?from=${from}&to=${day(5)}`, { token: tokens.manager });
  assert.equal(future.status, 400, 'no figures for days that have not happened');
  assert.equal((await call('GET', '/crm/investor-summary', { token: tokens.rupendra })).status, 403);

  const csv = await call('GET', `/crm/investor-summary.csv?from=${from}&to=${day(0)}`, { token: tokens.manager, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /Bookings — amount \(INR\),900000/);
  assert.match(csv.text, /ESTIMATE/);
  assert.ok(!csv.text.includes('ravi.private'));
  const audit = await call('GET', '/crm/audit?group=other', { token: tokens.manager });
  assert.ok(audit.body.entries.some((e) => e.field === 'investor_summary_exported' && e.actor_name === 'Vartika Head'),
    'who exported investor figures is on the audit trail');
});

// ---------------------------------------------------------------- 16. the audit trail

test('the audit trail shows who changed stage, value and owner, and why — and what was archived', async (t) => {
  if (skip(t)) return;
  const { deal, account } = await lead({ name: 'Audit Trail Agro', ...next(ids.manager) });
  await call('PATCH', `/opportunities/${deal.id}`, { token: tokens.manager, body: { estimated_value: 100000 } });
  const changed = await call('PATCH', `/opportunities/${deal.id}`, {
    token: tokens.manager, body: { estimated_value: 150000, reason: 'They added a second district' },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  await call('PATCH', `/opportunities/${deal.id}`, {
    token: tokens.manager, body: { owner_user_id: ids.rupendra, reason: 'Rupendra covers that region' },
  });
  // an older change, made before reasons were asked for
  await query(
    `INSERT INTO opportunity_history (opportunity_id, field, from_value, to_value, actor_id)
     VALUES ($1, 'agreed_value', '50000', '80000', $2)`,
    [deal.id, ids.manager],
  );

  const values = await call('GET', `/crm/audit?group=value&opportunity_id=${deal.id}`, { token: tokens.manager });
  assert.equal(values.status, 200);
  const raise = values.body.entries.find((e) => e.field === 'estimated_value' && e.to === '150000');
  assert.equal(raise.reason, 'They added a second district');
  assert.equal(raise.actor_name, 'Vartika Head');
  assert.equal(raise.no_reason, false);
  assert.ok(values.body.entries.find((e) => e.field === 'agreed_value').no_reason, 'a change with no reason is marked');
  assert.ok(values.body.entries.every((e) => e.group === 'value'));

  const owners = await call('GET', `/crm/audit?group=owner&opportunity_id=${deal.id}`, { token: tokens.manager });
  const handover = owners.body.entries.find((e) => e.field === 'owner_user_id');
  assert.equal(handover.to, 'Rupendra Rep', 'people by name');
  assert.equal(handover.reason, 'Rupendra covers that region');

  // archiving a deal and an organization are on the trail, with why
  const archived = await call('DELETE', `/opportunities/${deal.id}?reason=${encodeURIComponent('Duplicate of the Kharif deal')}`, { token: tokens.manager });
  assert.equal(archived.status, 200);
  await call('DELETE', `/accounts/${account.id}?reason=${encodeURIComponent('Merged into the parent company')}`, { token: tokens.manager });
  const status = await call('GET', `/crm/audit?group=status`, { token: tokens.manager });
  assert.ok(status.body.entries.some((e) => e.field === 'archived' && e.opportunity_id === deal.id && /Duplicate of the Kharif/.test(e.reason)));
  const other = await call('GET', `/crm/audit?group=other`, { token: tokens.manager });
  assert.ok(other.body.entries.some((e) => e.field === 'account_archived' && /Merged into the parent/.test(e.reason)));

  const csv = await call('GET', `/crm/audit.csv?opportunity_id=${deal.id}`, { token: tokens.manager, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /They added a second district/);
  assert.match(csv.text, /no reason given/);
  assert.equal((await call('GET', '/crm/audit', { token: tokens.rupendra })).status, 403);
});

// ---------------------------------------------------------------- 16. reminders

test('a digest is due on the person\'s day and time, never while paused or away', () => {
  const pref = { digest_time: '09:30', digest_days: [1, 2, 3, 4, 5], paused_until: null };
  const monday = (time) => ({ weekday: 1, time, date: '2026-10-12' });
  assert.deepEqual(digestDue(pref, monday('09:00')), { due: false, why: 'not yet time' });
  assert.deepEqual(digestDue(pref, monday('09:30')), { due: true });
  assert.deepEqual(digestDue(pref, { weekday: 6, time: '11:00', date: '2026-10-10' }), { due: false, why: 'not a reminder day' });
  assert.deepEqual(digestDue(pref, monday('11:00'), { away: true }), { due: false, why: 'away' });
  assert.deepEqual(digestDue({ ...pref, paused_until: '2026-10-12' }, monday('11:00')), { due: false, why: 'paused' });
  assert.deepEqual(digestDue({ ...pref, paused_until: '2026-10-11' }, monday('11:00')), { due: true }, 'a pause ends');
  assert.deepEqual(digestDue(pref, monday('07:00'), { ignoreSchedule: true }), { due: true });
  assert.deepEqual(digestDue(pref, monday('07:00'), { ignoreSchedule: true, away: true }).due, false, 'leave holds even then');
  assert.ok(onlyRepeats({ fingerprint: 'x', sent_on: '2026-10-11' }, 'x', '2026-10-12', 3));
  assert.ok(!onlyRepeats({ fingerprint: 'x', sent_on: '2026-10-08' }, 'x', '2026-10-12', 3), 'after a few days it is sent again');
  assert.ok(!onlyRepeats({ fingerprint: 'x', sent_on: '2026-10-11' }, 'y', '2026-10-12', 3), 'something new is sent');
});

test('each person sets their own reminder time, days and a short dated pause', async (t) => {
  if (skip(t)) return;
  const mine = await call('GET', '/crm/reminders/mine', { token: tokens.rupendra });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.preferences.is_default, true);
  assert.equal(mine.body.preferences.digest_time, '09:30');

  assert.equal((await call('PUT', '/crm/reminders/mine', { token: tokens.rupendra, body: { digest_time: '25:00' } })).status, 400);
  assert.equal((await call('PUT', '/crm/reminders/mine', { token: tokens.rupendra, body: { digest_days: [] } })).status, 400);
  const long = await call('PUT', '/crm/reminders/mine', {
    token: tokens.rupendra, body: { paused_until: day(45), pause_reason: 'Travelling' },
  });
  assert.equal(long.status, 400, 'pauses are short; leave stops reminders by itself');
  const unexplained = await call('PUT', '/crm/reminders/mine', { token: tokens.rupendra, body: { paused_until: day(3) } });
  assert.equal(unexplained.status, 400);

  const set = await call('PUT', '/crm/reminders/mine', {
    token: tokens.rupendra, body: { digest_time: '08:15', digest_days: [1, 3, 5] },
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.preferences.digest_time, '08:15');
  assert.deepEqual(set.body.preferences.digest_days, [1, 3, 5]);
  assert.equal(set.body.preferences.is_default, false);
});

test('the scheduled digest waits for the person\'s time, is sent once, and is not repeated when nothing changed', async (t) => {
  if (skip(t)) return;
  // every day, at 10:00 India time
  await call('PUT', '/crm/reminders/mine', {
    token: tokens.saumya, body: { digest_time: '10:00', digest_days: [1, 2, 3, 4, 5, 6, 7], paused_until: null },
  });
  const { deal } = await lead({ name: 'Digest Seeds', owner_user_id: ids.saumya, ...next(ids.saumya) });
  await query('UPDATE opportunities SET next_step_due = $2::date WHERE id = $1', [deal.id, day(-2)]);
  const at = (hhmm) => new Date(`${day(0)}T${hhmm}:00+05:30`);
  const digests = async () => (await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'crm_digest'`, [ids.saumya],
  )).rows[0].n;

  const early = await runAccountScan({ now: at('07:00') });
  assert.ok(early.held.some((h) => h.user_id === ids.saumya && h.why === 'not yet time'));
  assert.equal(await digests(), 0);

  const onTime = await runAccountScan({ now: at('10:05') });
  assert.ok(onTime.notified.includes(ids.saumya));
  assert.equal(await digests(), 1);
  const again = await runAccountScan({ now: at('10:20') });
  assert.ok(!again.notified.includes(ids.saumya));
  assert.equal(await digests(), 1, 'once a day');

  // the next day, with nothing new to say, it is not sent…
  await query(`UPDATE notifications SET created_at = now() - interval '26 hours' WHERE user_id = $1 AND type = 'crm_digest'`, [ids.saumya]);
  const tomorrow = new Date(`${day(1)}T10:30:00+05:30`);
  const quiet = await runAccountScan({ now: tomorrow });
  assert.ok(quiet.held.some((h) => h.user_id === ids.saumya && h.why === 'nothing new'));
  assert.equal(await digests(), 1);
  // …and when something new needs her, it is
  const other = await lead({ name: 'Second Digest Farm', owner_user_id: ids.saumya, ...next(ids.saumya) });
  await query('UPDATE opportunities SET next_step_due = $2::date WHERE id = $1', [other.deal.id, day(-1)]);
  const fresh = await runAccountScan({ now: tomorrow });
  assert.ok(fresh.notified.includes(ids.saumya));
  assert.equal(await digests(), 2);

  // a pause holds it, whatever the hour
  await call('PUT', '/crm/reminders/mine', {
    token: tokens.saumya, body: { paused_until: day(2), pause_reason: 'Offsite planning days' },
  });
  const paused = await runAccountScan({ now: at('23:00'), manual: true });
  assert.ok(paused.held.some((h) => h.user_id === ids.saumya && h.why === 'paused'));
  await call('PUT', '/crm/reminders/mine', { token: tokens.saumya, body: { paused_until: null } });
});

test('nobody is reminded on leave; what cannot wait goes to the escalation point, once', async (t) => {
  if (skip(t)) return;
  await call('PUT', '/crm/reminders/mine', {
    token: tokens.manager, body: { digest_time: '00:00', digest_days: [1, 2, 3, 4, 5, 6, 7] },
  });
  await call('PUT', '/crm/reminders/mine', {
    token: tokens.saumya, body: { digest_time: '00:00', digest_days: [1, 2, 3, 4, 5, 6, 7], paused_until: null },
  });
  const { deal } = await lead({ name: 'Leave Cover Farms', owner_user_id: ids.saumya, ...next(ids.saumya, 1, 'Send the trial report') });
  await call('PATCH', `/opportunities/${deal.id}`, { token: tokens.manager, body: { escalation_owner_id: ids.manager } });
  await query(`INSERT INTO user_availability (user_id, status, start_date, end_date, note) VALUES ($1, 'ON_LEAVE', $2, $3, 'Family wedding')`,
    [ids.saumya, day(0), day(3)]);

  const scan = await runAccountScan({ now: new Date(), manual: true });
  assert.ok(scan.held.some((h) => h.user_id === ids.saumya && h.why === 'away'), 'held while away, even when run by hand');
  const cover = scan.covered.find((c) => c.user_id === ids.manager && c.covering_for === ids.saumya);
  assert.ok(cover, 'the next action due before she is back goes to the escalation point');
  const inbox = await call('GET', '/notifications', { token: tokens.manager });
  const notice = inbox.body.notifications.find((n) => n.type === 'crm_cover');
  assert.match(notice.title, /Covering for Saumya Rep/);
  assert.match(notice.body, /Send the trial report/);

  const second = await runAccountScan({ now: new Date(), manual: true });
  assert.ok(!second.covered.some((c) => c.user_id === ids.manager && c.covering_for === ids.saumya), 'once a day');

  // the weekly review reminder is not sent to someone on leave either
  const friday = new Date(`${weekOf(day(0)).start}T10:30:00Z`);
  friday.setUTCDate(friday.getUTCDate() + 4);
  await query(`UPDATE user_availability SET start_date = $2::date, end_date = $2::date WHERE user_id = $1`,
    [ids.saumya, friday.toISOString().slice(0, 10)]);
  const weekly = await runPipelineWeekly({ now: friday });
  assert.ok(!weekly.reminded.includes(ids.saumya));
});

test('the same notice to the same person moments apart is sent once', async (t) => {
  if (skip(t)) return;
  const count = async () => (await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND title = 'Twice over'`, [ids.rupendra],
  )).rows[0].n;
  await notify(null, { userId: ids.rupendra, type: 'crm_assigned', title: 'Twice over', body: 'Same words' });
  await notify(null, { userId: ids.rupendra, type: 'crm_assigned', title: 'Twice over', body: 'Same words' });
  assert.equal(await count(), 1);
  await notify(null, { userId: ids.rupendra, type: 'crm_assigned', title: 'Twice over', body: 'Different words' });
  assert.equal(await count(), 2, 'a different notice is still sent');
});
