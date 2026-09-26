/**
 * The pipeline suggestions: where a lead is, what it is worth, whether winning
 * it is counted, which states need following up, and raising what is in the way.
 *
 * The regressions worth guarding are the quiet ones. A lead dragged to Won that
 * never counted as won. An expected value typed on a lead that the next edit
 * silently discarded. A state view that drops leads nobody placed. A blocker
 * that tells nobody.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { potentialTier } from '../src/services/leadFigures.js';

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

const skipIfUnavailable = (t) => {
  if (!available) {
    t.skip('no database');
    return true;
  }
  return false;
};

const newLead = async (body, token = tokens.manager) => {
  const res = await call('POST', '/accounts', {
    token,
    body: { owner_user_id: ids.manager, department_id: ids.department, ...body },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.account;
};

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try {
    await query('SELECT 1');
  } catch {
    available = false;
    return;
  }

  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('SAL', 'Sales', '#2a78d6', 1)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE),
      ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'SAL'`);
  ids.department = dept[0].id;

  const password = await hashPassword('Password123!');
  for (const [key, name, role] of [
    ['manager', 'Lead Owner', 'manager'],
    ['colleague', 'Field Colleague', 'member'],
    ['member', 'Someone Else', 'member'],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [name, `pipe-${key}@test.local`, password, role, ids.department],
    );
    ids[key] = rows[0].id;
  }

  const { rows: stages } = await query('SELECT id, slug FROM account_stages');
  for (const stage of stages) ids[`stage_${stage.slug.replace(/-/g, '_')}`] = stage.id;

  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  for (const key of ['manager', 'colleague', 'member']) {
    const login = await call('POST', '/auth/login', {
      body: { email: `pipe-${key}@test.local`, password: 'Password123!' },
    });
    tokens[key] = login.body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- location

test('a new lead can say which state it is in and where its office is', async (t) => {
  if (skipIfUnavailable(t)) return;

  const lead = await newLead({
    name: 'Nashik Grape Growers FPO',
    state: 'Maharashtra',
    hq_address: 'Plot 12, MIDC Ambad, Nashik',
    value: 1800000,
  });
  assert.equal(lead.state, 'Maharashtra');
  assert.equal(lead.hq_address, 'Plot 12, MIDC Ambad, Nashik');
  ids.grapes = lead.id;

  // and an existing lead can have them added or changed later
  const older = await newLead({ name: 'Old Lead With No Place' });
  const patched = await call('PATCH', `/accounts/${older.id}`, {
    token: tokens.manager,
    body: { state: 'Karnataka', hq_address: 'Hubli' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.account.state, 'Karnataka');
  ids.karnataka = older.id;
});

// ---------------------------------------------------------------- value

test('expected revenue typed on a lead lands on its deal, and survives the next edit', async (t) => {
  if (skipIfUnavailable(t)) return;

  const lead = await newLead({ name: 'Revenue Test Co', state: 'Gujarat' });
  const edited = await call('PATCH', `/accounts/${lead.id}`, {
    token: tokens.manager, body: { value: 750000 },
  });
  assert.equal(edited.status, 200);

  const detail = await call('GET', `/accounts/${lead.id}`, { token: tokens.manager });
  const deal = detail.body.opportunities[0];
  assert.equal(Number(deal.estimated_value), 750000, 'the deal carries the number now');

  // editing the deal for an unrelated reason used to rewrite the lead's value
  // from the deal — which, before, had no value — and the typed number vanished
  await call('PATCH', `/opportunities/${deal.id}`, {
    token: tokens.manager, body: { next_step: 'Send the price sheet' },
  });
  const after = await call('GET', `/accounts/${lead.id}`, { token: tokens.manager });
  assert.equal(Number(after.body.account.value), 750000, 'the typed value is still there');
  ids.gujarat = lead.id;
});

test('the board totals what open deals are worth, and counts the leads with no value', async (t) => {
  if (skipIfUnavailable(t)) return;

  // a lead with two open deals is worth both, not only the headline one
  const detail = await call('GET', `/accounts/${ids.grapes}`, { token: tokens.manager });
  await call('POST', '/opportunities', {
    token: tokens.manager,
    body: {
      account_id: ids.grapes, name: 'Second season', estimated_value: 200000,
      stage_id: detail.body.account.stage_id,
    },
  });
  // and an unpaid pilot is worth nothing to the forecast, whatever is typed on it
  await call('POST', '/opportunities', {
    token: tokens.manager,
    body: {
      account_id: ids.grapes, name: 'Free trial', engagement_model: 'UNPAID_PILOT',
      estimated_value: 999999, stage_id: detail.body.account.stage_id,
    },
  });

  const board = await call('GET', '/accounts/pipeline', { token: tokens.manager });
  assert.equal(board.status, 200);
  const cards = board.body.stages.flatMap((s) => s.accounts);
  const grapes = cards.find((c) => c.id === ids.grapes);
  assert.equal(grapes.eligible_value, 2000000, '1.8M + 0.2M, the unpaid pilot excluded');
  assert.equal(grapes.open_deals, 3);
  assert.equal(grapes.non_commercial_deals, 1);

  const noValue = cards.find((c) => c.id === ids.karnataka);
  assert.equal(noValue.eligible_value, null, 'no value is not ₹0');
  assert.equal(noValue.deals_without_value, 1);
  assert.ok(board.body.leads_without_value >= 1, 'the board says how many have none');

  // filtering the board by state
  const gujarat = await call('GET', '/accounts/pipeline?state=gujarat', { token: tokens.manager });
  const onlyGujarat = gujarat.body.stages.flatMap((s) => s.accounts);
  assert.deepEqual(onlyGujarat.map((a) => a.id), [ids.gujarat]);
});

// ---------------------------------------------------------------- conversions

test('a lead moved to Won on the board counts as won on the dashboard', async (t) => {
  if (skipIfUnavailable(t)) return;

  const before = await call('GET', '/accounts/dashboard/b2b', { token: tokens.manager });
  const lead = await newLead({ name: 'Board Winner', value: 400000 });

  const moved = await call('POST', `/accounts/${lead.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_won },
  });
  assert.equal(moved.status, 200);

  // the deal moved with it — this is what used to be missed
  const detail = await call('GET', `/accounts/${lead.id}`, { token: tokens.manager });
  assert.equal(detail.body.opportunities[0].status, 'WON');
  assert.ok(detail.body.opportunities[0].closed_at);

  const after = await call('GET', '/accounts/dashboard/b2b', { token: tokens.manager });
  assert.equal(after.body.activity.won, before.body.activity.won + 1);
  assert.ok(
    after.body.activity.won_list.some((row) => row.account_id === lead.id),
    'and the month lists which lead it was',
  );
});

test('a lead dropped to Lost from the board still has to say why', async (t) => {
  if (skipIfUnavailable(t)) return;

  const lead = await newLead({ name: 'Board Loser' });
  const silent = await call('POST', `/accounts/${lead.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_lost },
  });
  assert.equal(silent.status, 400);

  const explained = await call('POST', `/accounts/${lead.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_lost, reason: 'Chose a cheaper kit' },
  });
  assert.equal(explained.status, 200);
  const detail = await call('GET', `/accounts/${lead.id}`, { token: tokens.manager });
  assert.equal(detail.body.opportunities[0].outcome_reason, 'Chose a cheaper kit');
});

test('marking a lead as a customer wins the deal it signed, and the month shows it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const lead = await newLead({ name: 'Converted FPO', value: 1200000 });
  const detail = await call('GET', `/accounts/${lead.id}`, { token: tokens.manager });
  const deal = detail.body.opportunities[0];

  const converted = await call('POST', `/accounts/${lead.id}/convert`, {
    token: tokens.manager,
    body: {
      type: 'CUSTOMER', opportunity_id: deal.id, agreed_value: 1100000,
      agreement_type: 'Purchase order',
    },
  });
  assert.equal(converted.status, 200);
  assert.equal(converted.body.account.type, 'CUSTOMER');

  const won = await call('GET', `/accounts/${lead.id}`, { token: tokens.manager });
  const signed = won.body.opportunities.find((o) => o.id === deal.id);
  assert.equal(signed.status, 'WON');
  assert.equal(Number(signed.agreed_value), 1100000);

  const dashboard = await call('GET', '/accounts/dashboard/b2b', { token: tokens.manager });
  assert.ok(dashboard.body.activity.won_list.some((r) => r.id === deal.id));
  const row = dashboard.body.activity.converted_list.find((r) => r.id === lead.id);
  assert.ok(row, 'it is listed among this month’s new customers');
  assert.equal(row.won_deal, deal.name);

  // a deal from somebody else's lead cannot be claimed
  const other = await newLead({ name: 'Unrelated Lead' });
  const wrong = await call('POST', `/accounts/${other.id}/convert`, {
    token: tokens.manager, body: { type: 'CUSTOMER', opportunity_id: deal.id },
  });
  assert.equal(wrong.status, 400);
});

test('a conversion that names no deal is still counted as a new customer, not as a win', async (t) => {
  if (skipIfUnavailable(t)) return;

  const before = await call('GET', '/accounts/dashboard/b2b', { token: tokens.manager });
  const lead = await newLead({ name: 'Converted Without A Deal' });
  await call('POST', `/accounts/${lead.id}/convert`, {
    token: tokens.manager, body: { type: 'CUSTOMER', opportunity_id: null },
  });
  const after = await call('GET', '/accounts/dashboard/b2b', { token: tokens.manager });
  assert.equal(after.body.activity.won, before.body.activity.won, 'no deal was won');
  assert.equal(after.body.activity.became_customers, before.body.activity.became_customers + 1);
});

// ---------------------------------------------------------------- state view

test('the state view groups every lead, including the ones nobody placed', async (t) => {
  if (skipIfUnavailable(t)) return;

  const unplaced = await newLead({ name: 'Nowhere Yet' });
  const res = await call('GET', '/accounts/views/states', { token: tokens.manager });
  assert.equal(res.status, 200);

  const maharashtra = res.body.states.find((s) => s.state === 'Maharashtra');
  assert.ok(maharashtra);
  const none = res.body.states.find((s) => s.state === null);
  assert.ok(none && none.total >= 1, 'a lead with no state is its own group, not dropped');
  assert.ok(res.body.leads.some((l) => l.id === unplaced.id && l.state === null));

  // the rules come with it, so "inactive" means something anyone can read
  assert.match(res.body.definitions.activity.inactive, /30 days/);
  assert.match(res.body.definitions.potential.unknown, /Not the same as low/);

  // nobody has spoken to the grape growers: open deal, no external contact
  const grapes = res.body.leads.find((l) => l.id === ids.grapes);
  assert.equal(grapes.activity, 'inactive');
  assert.equal(grapes.potential, 'medium', '₹20 lakh sits between 5 and 25');

  // once they are called, they are active
  await call('POST', `/accounts/${ids.grapes}/activities`, {
    token: tokens.manager,
    body: { type: 'CALL', subject: 'Spoke to the chairman', outcome: 'COMPLETED' },
  });
  const later = await call('GET', '/accounts/views/states', { token: tokens.manager });
  assert.equal(later.body.leads.find((l) => l.id === ids.grapes).activity, 'active');

  // a lead with no value anywhere is unknown, never "low"
  const karnataka = later.body.leads.find((l) => l.id === ids.karnataka);
  assert.equal(karnataka.potential, 'unknown');
});

test('potential tiers follow the stated thresholds', () => {
  const rules = { lowPotentialBelow: 500000, highPotentialFrom: 2500000 };
  assert.equal(potentialTier(null, rules), 'unknown');
  assert.equal(potentialTier(0, rules), 'low', 'a recorded zero is a real, low number');
  assert.equal(potentialTier(499999, rules), 'low');
  assert.equal(potentialTier(500000, rules), 'medium');
  assert.equal(potentialTier(2500000, rules), 'high');
});

// ---------------------------------------------------------------- blockers

test('the lead owner can raise a blocker, and the people asked are told', async (t) => {
  if (skipIfUnavailable(t)) return;

  const detail = await call('GET', `/accounts/${ids.grapes}`, { token: tokens.manager });
  const deal = detail.body.opportunities[0];
  const clockBefore = detail.body.account.last_external_at;

  const raised = await call('POST', '/threads', {
    token: tokens.manager,
    body: {
      entity_type: 'OPPORTUNITY',
      entity_id: deal.id,
      kind: 'blocker',
      category: 'APPROVAL',
      title: 'Board will not approve before the co-operative audit',
      body: 'Their board meets after the audit in November. Can we offer a pilot in one taluka first?',
      participant_user_ids: [ids.colleague],
    },
  });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  assert.equal(raised.body.thread.kind, 'blocker');
  assert.equal(raised.body.thread.category, 'APPROVAL');
  ids.blocker = raised.body.thread.id;

  const { rows } = await query(
    `SELECT title, account_id FROM notifications WHERE user_id = $1 AND type = 'crm_blocker'`,
    [ids.colleague],
  );
  assert.equal(rows.length, 1, 'the colleague asked to help hears about it');
  assert.equal(rows[0].account_id, ids.grapes, 'and the alert opens the lead');

  // it is on the lead's own timeline, as an internal note
  const after = await call('GET', `/accounts/${ids.grapes}`, { token: tokens.manager });
  assert.ok(after.body.activities.some((a) => /Blocker raised/.test(a.subject)));
  assert.equal(
    after.body.account.last_external_at, clockBefore,
    'raising a blocker is not the same as speaking to the partner',
  );

  // and the board card says so
  const board = await call('GET', '/accounts/pipeline', { token: tokens.manager });
  const card = board.body.stages.flatMap((s) => s.accounts).find((a) => a.id === ids.grapes);
  assert.equal(card.open_blockers, 1);
});

test('somebody who does not work the lead cannot raise a blocker on it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const denied = await call('POST', '/threads', {
    token: tokens.member,
    body: {
      entity_type: 'ACCOUNT', entity_id: ids.grapes, kind: 'blocker',
      body: 'Not mine to raise',
    },
  });
  assert.equal(denied.status, 403);

  // and a blocker only makes sense on a lead
  const wrongPlace = await call('POST', '/threads', {
    token: tokens.manager,
    body: { entity_type: 'ACCOUNT', entity_id: ids.grapes, kind: 'blocker', body: 'x', category: 'NOT_A_CATEGORY' },
  });
  assert.equal(wrongPlace.status, 400);
});

test('the people asked can discuss it, and it closes only with a conclusion', async (t) => {
  if (skipIfUnavailable(t)) return;

  const reply = await call('POST', `/threads/${ids.blocker}/messages`, {
    token: tokens.colleague,
    body: { body: 'I know their auditor. A one-taluka pilot is within their CEO’s own limit.' },
  });
  assert.equal(reply.status, 201);

  // everything about the lead in one list, with who was brought in
  const listed = await call('GET', `/threads/lead/${ids.grapes}`, { token: tokens.manager });
  assert.equal(listed.status, 200);
  const blocker = listed.body.threads.find((th) => th.id === ids.blocker);
  assert.equal(blocker.messages.length, 2);
  assert.deepEqual(blocker.participants.map((p) => p.id), [ids.colleague]);
  assert.ok(blocker.about, 'it says which deal it is about');

  const noConclusion = await call('POST', `/threads/${ids.blocker}/resolve`, {
    token: tokens.manager, body: { conclusion: '' },
  });
  assert.equal(noConclusion.status, 400);

  const closed = await call('POST', `/threads/${ids.blocker}/resolve`, {
    token: tokens.manager,
    body: { conclusion: 'Proposing a one-taluka pilot under the CEO’s limit; full rollout after the audit.' },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.thread.status, 'resolved');

  const board = await call('GET', '/accounts/pipeline', { token: tokens.manager });
  const card = board.body.stages.flatMap((s) => s.accounts).find((a) => a.id === ids.grapes);
  assert.equal(card.open_blockers, 0);
});

test('a blocker nobody answers becomes a nudge', async (t) => {
  if (skipIfUnavailable(t)) return;

  const raised = await call('POST', '/threads', {
    token: tokens.manager,
    body: {
      entity_type: 'ACCOUNT', entity_id: ids.gujarat, kind: 'blocker', category: 'BUDGET',
      title: 'Budget frozen until April', body: 'Anyone know another route in?',
      participant_user_ids: [ids.colleague],
    },
  });
  assert.equal(raised.status, 201);

  // not yet — it was only just raised
  let nudges = await call('GET', '/accounts/nudges', { token: tokens.manager });
  assert.ok(!nudges.body.attention.some((n) => n.kind === 'blocker_waiting'));

  await query(
    `UPDATE discussion_messages SET created_at = now() - interval '5 days' WHERE thread_id = $1`,
    [raised.body.thread.id],
  );
  await query(
    `UPDATE discussion_threads SET created_at = now() - interval '5 days' WHERE id = $1`,
    [raised.body.thread.id],
  );
  nudges = await call('GET', '/accounts/nudges', { token: tokens.manager });
  const nudge = nudges.body.attention.find((n) => n.kind === 'blocker_waiting');
  assert.ok(nudge, 'a blocker left unanswered is not forgotten');
  assert.equal(nudge.account_id, ids.gujarat);
  assert.match(nudge.detail, /nobody has replied/);
});
