/**
 * B2B CRM: organizations, the deals inside them, and the people who decide.
 *
 * The things worth guarding here are the ones that make a pipeline lie:
 * winning one deal quietly closing a whole relationship, a blank value being
 * read as zero, an unsigned MoU counted as revenue, a forecast presented as a
 * fact, and tidying up a record looking like having engaged the partner.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { eligibleValue, probabilityOf, stageGaps, topBlocker } from '../src/services/opportunities.js';

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

const dateOnly = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

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
    console.log('[tests] no database reachable — skipping B2B tests');
    return;
  }

  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('PAR', 'Partnerships', '#2a78d6', 1)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE),
      ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );

  const password = await hashPassword('Password123!');
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'PAR'`);
  ids.department = dept[0].id;

  const insertUser = async (name, email, role) => {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [name, email, password, role, ids.department],
    );
    return rows[0].id;
  };

  ids.admin = await insertUser('Admin User', 'b2b-admin@test.local', 'admin');
  ids.manager = await insertUser('Relationship Manager', 'b2b-manager@test.local', 'manager');
  ids.member = await insertUser('Team Member', 'b2b-member@test.local', 'member');

  const { rows: statuses } = await query('SELECT id FROM workflow_statuses ORDER BY position');
  ids.todo = statuses[0].id;
  ids.done = statuses[1].id;

  const { rows: stages } = await query('SELECT id, slug FROM account_stages ORDER BY position');
  for (const stage of stages) ids[`stage_${stage.slug.replace(/-/g, '_')}`] = stage.id;

  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  for (const [key, email] of Object.entries({
    admin: 'b2b-admin@test.local',
    manager: 'b2b-manager@test.local',
    member: 'b2b-member@test.local',
  })) {
    const login = await call('POST', '/auth/login', { body: { email, password: 'Password123!' } });
    tokens[key] = login.body.token;
  }

  const org = await call('POST', '/accounts', {
    token: tokens.manager,
    body: {
      name: 'Krishi Vikas Foundation',
      owner_user_id: ids.manager,
      department_id: ids.department,
      source: 'Referral',
    },
  });
  ids.account = org.body.account.id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ------------------------------------------------------------ pure engine

test('the forecast uses the most committed number there is, and says which', () => {
  const base = { engagement_model: 'COMMERCIAL', stage_name: 'Proposal', stage_probability: 70 };

  assert.equal(eligibleValue({ ...base, estimated_value: 100 }).basis, 'estimated');
  assert.equal(eligibleValue({ ...base, estimated_value: 100, proposed_value: 250 }).basis, 'proposed');
  assert.equal(
    eligibleValue({ ...base, estimated_value: 100, proposed_value: 250, agreed_value: 200 }).amount,
    200,
    'a signed amount beats whatever we hoped for',
  );
});

test('a blank value is "not known", never zero', () => {
  const nothing = eligibleValue({ engagement_model: 'COMMERCIAL' });
  assert.equal(nothing.amount, null);
  assert.notEqual(nothing.amount, 0);
  assert.equal(eligibleValue({ engagement_model: 'COMMERCIAL', value_unknown: true, estimated_value: 900 }).amount,
    null, 'marked unknown wins over a stale number');
});

test('an unpaid pilot or a partnership is not pipeline money', () => {
  for (const model of ['UNPAID_PILOT', 'CSR_PROJECT', 'PARTNERSHIP']) {
    const value = eligibleValue({ engagement_model: model, estimated_value: 5000000 });
    assert.equal(value.amount, null, `${model} contributes nothing to the forecast`);
    assert.equal(value.basis, 'non_commercial');
  }
  assert.equal(eligibleValue({ engagement_model: 'PAID_PILOT', estimated_value: 5000000 }).amount, 5000000);
});

test('a probability is disclosed as a stage default or somebody’s call', () => {
  const fromStage = probabilityOf({ stage_probability: 45, stage_name: 'Meeting / Demo' });
  assert.equal(fromStage.percent, 45);
  assert.equal(fromStage.source, 'stage');

  const byHand = probabilityOf({ stage_probability: 45, probability: 80, probability_reason: 'Budget approved' });
  assert.equal(byHand.percent, 80);
  assert.equal(byHand.source, 'explicit');
  assert.equal(byHand.reason, 'Budget approved');
});

test('the stage gate reports what is missing rather than refusing anything', () => {
  const gaps = stageGaps({
    requires_contact: true, requires_next_action: true, requires_value: true,
    contact_count: 0, next_step: null, stage_kind: 'open', stage_position: 7,
    engagement_model: 'COMMERCIAL', unmet_must_haves: 2,
  });
  const kinds = gaps.map((g) => g.kind);
  assert.ok(kinds.includes('no_contact'));
  assert.ok(kinds.includes('no_next_step'));
  assert.ok(kinds.includes('no_value'));
  assert.ok(kinds.includes('no_close_date'));
  assert.ok(kinds.includes('unmet_must_haves'));

  // early capture stays light: a new lead is not nagged
  assert.deepEqual(
    stageGaps({ requires_contact: false, requires_next_action: false, requires_value: false,
      stage_kind: 'open', stage_position: 1, contact_count: 0, unmet_must_haves: 0 }),
    [],
  );
});

test('the top blocker is the must-have that is actually stuck', () => {
  const requirements = [
    { id: 1, importance: 'SHOULD_HAVE', status: 'BLOCKED' },
    { id: 2, importance: 'MUST_HAVE', status: 'OPEN' },
    { id: 3, importance: 'MUST_HAVE', status: 'BLOCKED' },
    { id: 4, importance: 'MUST_HAVE', status: 'MET' },
  ];
  assert.equal(topBlocker(requirements).id, 3);
  assert.equal(topBlocker([{ id: 9, importance: 'MUST_HAVE', status: 'MET' }]), null);
  assert.equal(topBlocker([]), null);
});

// ------------------------------------------------------------ the relationship

test('an existing lead already has the one deal it was carrying', async (t) => {
  if (skipIfUnavailable(t)) return;

  const detail = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.opportunities.length, 1, 'creating a lead gives it a deal to work');
  ids.firstOpportunity = detail.body.opportunities[0].id;
  assert.equal(detail.body.account.primary_opportunity_id, ids.firstOpportunity);
});

test('one organization carries several independent deals', async (t) => {
  if (skipIfUnavailable(t)) return;

  const second = await call('POST', '/opportunities', {
    token: tokens.manager,
    body: {
      account_id: ids.account,
      name: 'Soil testing contract 2027',
      engagement_model: 'TESTING_CONTRACT',
      stage_id: ids.stage_discovery,
      estimated_value: 1800000,
      expected_close: dateOnly(75),
    },
  });
  assert.equal(second.status, 201);
  ids.secondOpportunity = second.body.opportunity.id;

  const first = await call('PATCH', `/opportunities/${ids.firstOpportunity}`, {
    token: tokens.manager,
    body: { name: 'Advisory pilot', engagement_model: 'PAID_PILOT', estimated_value: 450000 },
  });
  assert.equal(first.status, 200);

  const detail = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.equal(detail.body.opportunities.length, 2);

  // each keeps its own stage and its own money
  const byName = Object.fromEntries(detail.body.opportunities.map((o) => [o.name, o]));
  assert.equal(byName['Advisory pilot'].eligible_value, 450000);
  assert.equal(byName['Soil testing contract 2027'].eligible_value, 1800000);
  assert.notEqual(byName['Advisory pilot'].stage_id, byName['Soil testing contract 2027'].stage_id);
});

test('winning one deal does not close the relationship or the other deal', async (t) => {
  if (skipIfUnavailable(t)) return;

  const won = await call('POST', `/opportunities/${ids.firstOpportunity}/stage`, {
    token: tokens.manager,
    body: {
      stage_id: ids.stage_won,
      agreement_type: 'Signed pilot agreement',
      agreement_date: dateOnly(0),
      agreed_value: 420000,
      financial_status: 'INVOICED',
    },
  });
  assert.equal(won.status, 200);
  assert.equal(won.body.opportunity.status, 'WON');
  assert.equal(won.body.opportunity.eligible_basis, 'agreed', 'the signed number takes over');
  assert.equal(won.body.opportunity.eligible_value, 420000);

  const detail = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  // the organization is still live, and so is the second deal
  assert.notEqual(detail.body.account.status, 'LOST');
  const second = detail.body.opportunities.find((o) => o.id === ids.secondOpportunity);
  assert.equal(second.status, 'ACTIVE', 'the other deal is untouched');
  assert.equal(second.is_open, true);

  // and the organization's headline now follows the deal still in flight
  assert.equal(detail.body.account.primary_opportunity_id, ids.secondOpportunity);
});

test('a signed agreement is not collected revenue', async (t) => {
  if (skipIfUnavailable(t)) return;

  const detail = await call('GET', `/opportunities/${ids.firstOpportunity}`, { token: tokens.manager });
  const opportunity = detail.body.opportunity;
  assert.equal(opportunity.agreed_value, 420000);
  assert.equal(opportunity.collected_value, null, 'nothing has arrived yet, and that is not zero');
  assert.equal(opportunity.financial_status, 'INVOICED');

  // they are different fields and neither is the sum of the others
  assert.notEqual(opportunity.agreed_value, opportunity.collected_value);
});

test('losing a deal needs a reason', async (t) => {
  if (skipIfUnavailable(t)) return;

  const third = await call('POST', '/opportunities', {
    token: tokens.manager,
    body: { account_id: ids.account, name: 'Device bulk order', estimated_value: 900000 },
  });
  const id = third.body.opportunity.id;

  const silent = await call('POST', `/opportunities/${id}/stage`, {
    token: tokens.manager,
    body: { stage_id: ids.stage_lost },
  });
  assert.equal(silent.status, 400, 'a closed deal with no reason teaches nobody anything');

  const explained = await call('POST', `/opportunities/${id}/stage`, {
    token: tokens.manager,
    body: { stage_id: ids.stage_lost, outcome_reason: 'Budget moved to next financial year', revisit_on: dateOnly(120) },
  });
  assert.equal(explained.status, 200);
  assert.equal(explained.body.opportunity.status, 'LOST');
  assert.equal(explained.body.opportunity.outcome_reason, 'Budget moved to next financial year');
  assert.ok(explained.body.opportunity.revisit_on, 'and a date to come back to it');
});

test('a move backwards down the pipeline is recorded as a reversal', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('POST', `/opportunities/${ids.secondOpportunity}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_proposal },
  });
  await call('POST', `/opportunities/${ids.secondOpportunity}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_discovery, reason: 'They reopened the requirements' },
  });

  const detail = await call('GET', `/opportunities/${ids.secondOpportunity}`, { token: tokens.manager });
  const reversal = detail.body.history.find((h) => h.is_reversal);
  assert.ok(reversal, 'going backwards is visible in the history');
  assert.equal(reversal.reason, 'They reopened the requirements');
});

test('a slipping close date is counted, not quietly rewritten', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('PATCH', `/opportunities/${ids.secondOpportunity}`, {
    token: tokens.manager, body: { expected_close: dateOnly(110) },
  });
  const detail = await call('GET', `/opportunities/${ids.secondOpportunity}`, { token: tokens.manager });
  assert.equal(detail.body.opportunity.close_date_changes, 1);
  assert.ok(detail.body.opportunity.original_close, 'the date first promised is kept');
});

// ------------------------------------------------------------ the people

test('an organization holds many contacts, each with their own details', async (t) => {
  if (skipIfUnavailable(t)) return;

  const meera = await call('POST', `/accounts/${ids.account}/contacts`, {
    token: tokens.manager,
    body: {
      full_name: 'Meera Joshi',
      designation: 'Programme Director',
      email: 'meera@kvf.example',
      whatsapp: '+91 98200 11111',
      preferred_channel: 'WHATSAPP',
      influence: 'HIGH',
      is_primary: true,
    },
  });
  assert.equal(meera.status, 201);
  ids.meera = meera.body.contact.id;

  // a number that is not Indian is still a number
  const sven = await call('POST', `/accounts/${ids.account}/contacts`, {
    token: tokens.manager,
    body: { full_name: 'Sven Andersson', designation: 'Technical advisor', phone: '+46 70 123 4567' },
  });
  assert.equal(sven.status, 201, 'contacts are not assumed to be in India');
  ids.sven = sven.body.contact.id;

  const list = await call('GET', `/accounts/${ids.account}/contacts`, { token: tokens.manager });
  assert.equal(list.body.contacts.length, 2);
  assert.equal(list.body.contacts[0].full_name, 'Meera Joshi', 'the primary contact leads');
});

test('a possible duplicate is reported, never merged', async (t) => {
  if (skipIfUnavailable(t)) return;

  const again = await call('POST', `/accounts/${ids.account}/contacts`, {
    token: tokens.manager,
    body: { full_name: 'Meera Joshi', email: 'meera@kvf.example', designation: 'Director' },
  });
  assert.equal(again.status, 201, 'it is still saved — the system does not overrule the person');
  assert.ok(again.body.possible_duplicates.length >= 1, 'but the match is flagged for a human');
  assert.equal(again.body.possible_duplicates[0].id, ids.meera);

  // both rows exist; nothing was silently combined
  const list = await call('GET', `/accounts/${ids.account}/contacts`, { token: tokens.manager });
  assert.equal(list.body.contacts.filter((c) => c.full_name === 'Meera Joshi').length, 2);
  ids.duplicate = again.body.contact.id;
});

test('the same person can hold different roles on different deals', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('POST', `/opportunities/${ids.firstOpportunity}/contacts`, {
    token: tokens.manager,
    body: { contact_id: ids.meera, role: 'CHAMPION', involvement: 'HIGH' },
  });
  await call('POST', `/opportunities/${ids.secondOpportunity}/contacts`, {
    token: tokens.manager,
    body: { contact_id: ids.meera, role: 'APPROVER', involvement: 'MEDIUM' },
  });

  const contacts = await call('GET', `/accounts/${ids.account}/contacts`, { token: tokens.manager });
  const meera = contacts.body.contacts.find((c) => c.id === ids.meera);
  const roles = meera.roles.map((r) => r.role).sort();
  assert.deepEqual(roles, ['APPROVER', 'CHAMPION']);
});

test('a contact from another organization cannot be attached to this deal', async (t) => {
  if (skipIfUnavailable(t)) return;

  const other = await call('POST', '/accounts', {
    token: tokens.manager, body: { name: 'Unrelated Agri Co', owner_user_id: ids.manager },
  });
  const stranger = await call('POST', `/accounts/${other.body.account.id}/contacts`, {
    token: tokens.manager, body: { full_name: 'Somebody Else' },
  });

  const denied = await call('POST', `/opportunities/${ids.firstOpportunity}/contacts`, {
    token: tokens.manager,
    body: { contact_id: stranger.body.contact.id, role: 'DECISION_MAKER' },
  });
  assert.equal(denied.status, 400);
});

test('a contact who leaves is deactivated, not erased', async (t) => {
  if (skipIfUnavailable(t)) return;

  const gone = await call('DELETE', `/accounts/${ids.account}/contacts/${ids.duplicate}`, {
    token: tokens.manager,
  });
  assert.equal(gone.status, 200);

  const active = await call('GET', `/accounts/${ids.account}/contacts`, { token: tokens.manager });
  assert.ok(!active.body.contacts.some((c) => c.id === ids.duplicate));

  const all = await call('GET', `/accounts/${ids.account}/contacts?all=true`, { token: tokens.manager });
  assert.ok(all.body.contacts.some((c) => c.id === ids.duplicate), 'the record survives so history still reads');
});

// ------------------------------------------------------------ requirements

test('requirements carry an owner, a date and what would prove them met', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', `/opportunities/${ids.secondOpportunity}/requirements`, {
    token: tokens.manager,
    body: {
      category: 'VALIDATION',
      description: 'Third-party lab correlation on 200 samples',
      importance: 'MUST_HAVE',
      owner_user_id: ids.member,
      due_date: dateOnly(30),
    },
  });
  assert.equal(created.status, 201);
  ids.requirement = created.body.requirement.id;

  await call('POST', `/opportunities/${ids.secondOpportunity}/requirements`, {
    token: tokens.manager,
    body: { category: 'COMMERCIAL', description: 'Rate card for bulk testing', importance: 'SHOULD_HAVE' },
  });

  const listed = await call('GET', `/opportunities/${ids.secondOpportunity}/requirements`, {
    token: tokens.manager,
  });
  assert.equal(listed.body.requirements.length, 2);
  assert.equal(listed.body.top_blocker.id, ids.requirement, 'the must-have leads');

  // and the deal itself reports how many must-haves are still open
  const detail = await call('GET', `/opportunities/${ids.secondOpportunity}`, { token: tokens.manager });
  assert.equal(detail.body.opportunity.unmet_must_haves, 1);
  assert.ok(detail.body.opportunity.gaps.some((g) => g.kind === 'unmet_must_haves'));
});

test('a met requirement stops being a blocker', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('PATCH', `/opportunities/${ids.secondOpportunity}/requirements/${ids.requirement}`, {
    token: tokens.manager,
    body: { status: 'MET', evidence_url: 'https://drive.example/lab-report' },
  });

  const detail = await call('GET', `/opportunities/${ids.secondOpportunity}`, { token: tokens.manager });
  assert.equal(detail.body.opportunity.unmet_must_haves, 0);
  assert.ok(!detail.body.opportunity.gaps.some((g) => g.kind === 'unmet_must_haves'));
});

// ------------------------------------------------------------ engagement clock

test('editing the organization does not count as having engaged them', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('POST', `/accounts/${ids.account}/activities`, {
    token: tokens.manager,
    body: { type: 'CALL', subject: 'Spoke to Meera about the pilot' },
  });

  const before = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  const clockBefore = before.body.account.last_external_at;
  assert.ok(clockBefore, 'a real call sets the clock');

  // change the banner and the summary — housekeeping, not engagement
  await call('PATCH', `/accounts/${ids.account}`, {
    token: tokens.manager,
    body: { banner_url: 'https://cdn.example/banner.png', relationship_summary: 'Long-term CSR partner' },
  });
  // and log something internal
  await call('POST', `/accounts/${ids.account}/activities`, {
    token: tokens.manager,
    body: { type: 'NOTE', subject: 'Internal: check the rate card' },
  });

  const after = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.equal(
    new Date(after.body.account.last_external_at).getTime(),
    new Date(clockBefore).getTime(),
    'the follow-up clock only moves when somebody actually spoke to them',
  );
});

test('an attempted call is not a conversation', async (t) => {
  if (skipIfUnavailable(t)) return;

  const before = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  const clockBefore = new Date(before.body.account.last_external_at).getTime();

  await call('POST', `/accounts/${ids.account}/activities`, {
    token: tokens.manager,
    body: { type: 'CALL', subject: 'Rang, no answer', outcome: 'ATTEMPTED' },
  });

  const after = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.equal(
    new Date(after.body.account.last_external_at).getTime(),
    clockBefore,
    'trying to reach someone is not reaching them',
  );

  // but it is still on the record, distinguishable from a completed call
  const outcomes = after.body.activities.filter((a) => a.type === 'CALL').map((a) => a.outcome);
  assert.ok(outcomes.includes('ATTEMPTED'));
  assert.ok(outcomes.includes('COMPLETED'));
});

// ------------------------------------------------------------ permissions

test('someone who neither owns the deal nor the relationship cannot change it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const denied = await call('PATCH', `/opportunities/${ids.secondOpportunity}`, {
    token: tokens.member,
    body: { estimated_value: 1 },
  });
  assert.equal(denied.status, 403);

  const stage = await call('POST', `/opportunities/${ids.secondOpportunity}/stage`, {
    token: tokens.member,
    body: { stage_id: ids.stage_won },
  });
  assert.equal(stage.status, 403);
});

test('the relationship owner can hand a deal to someone else, and it is recorded', async (t) => {
  if (skipIfUnavailable(t)) return;

  const handed = await call('PATCH', `/opportunities/${ids.secondOpportunity}`, {
    token: tokens.manager,
    body: { owner_user_id: ids.member },
  });
  assert.equal(handed.status, 200);
  assert.equal(handed.body.opportunity.owner_user_id, ids.member);

  // the relationship itself did not change hands
  const account = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.equal(account.body.account.owner_user_id, ids.manager);

  // and who held it before is not rewritten
  const { rows } = await query(
    `SELECT * FROM crm_ownership_history
      WHERE entity_type = 'OPPORTUNITY' AND entity_id = $1`,
    [ids.secondOpportunity],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from_user_id, ids.manager);
  assert.equal(rows[0].to_user_id, ids.member);

  // the new owner can now work it
  const asMember = await call('PATCH', `/opportunities/${ids.secondOpportunity}`, {
    token: tokens.member,
    body: { next_step: 'Share the rate card' },
  });
  assert.equal(asMember.status, 200);
});

// ------------------------------------------------------------ regression

test('an ordinary task is untouched by any of this', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', '/tasks', {
    token: tokens.member,
    body: {
      title: 'Nothing to do with a partner',
      department_id: ids.department,
      assignee_id: ids.member,
      due_date: new Date(Date.now() + 5 * 86400000).toISOString(),
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.account_id, null);
  assert.equal(created.body.task.opportunity_id, null);

  const detail = await call('GET', `/tasks/${created.body.task.id}`, { token: tokens.member });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.task.engagement_id, null);
});
