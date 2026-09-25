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

// ------------------------------------------------------------ meetings

test('a scheduled demo is not a completed demo', async (t) => {
  if (skipIfUnavailable(t)) return;

  const before = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  const clockBefore = new Date(before.body.account.last_external_at).getTime();

  const booked = await call('POST', '/meetings', {
    token: tokens.manager,
    body: {
      account_id: ids.account,
      opportunity_id: ids.secondOpportunity,
      kind: 'DEMO',
      mode: 'IN_PERSON',
      title: 'Soil Doctor demo at their Pune office',
      objective: 'Show the device and the advisory flow end to end',
      scheduled_at: new Date(Date.now() + 3 * 86400000).toISOString(),
      location: 'KVF head office, Pune',
      participant_contact_ids: [ids.meera],
      participant_user_ids: [ids.manager],
    },
  });
  assert.equal(booked.status, 201);
  ids.meeting = booked.body.meeting.id;
  assert.equal(booked.body.meeting.status, 'SCHEDULED');
  assert.equal(booked.body.meeting.happened, false);
  // and it says plainly that nothing was sent to anyone outside
  assert.match(booked.body.note, /No calendar invitation or message was sent/);

  // booking it is not engaging them
  const after = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.equal(
    new Date(after.body.account.last_external_at).getTime(),
    clockBefore,
    'putting a demo in the diary is not the same as having given one',
  );

  // the timeline distinguishes it
  const scheduled = after.body.activities.find((a) => a.meeting_id === ids.meeting);
  assert.ok(scheduled);
  assert.equal(scheduled.outcome, 'SCHEDULED');
});

test('scheduling a demo creates its preparation work as ordinary tasks, once', async (t) => {
  if (skipIfUnavailable(t)) return;

  const detail = await call('GET', `/meetings/${ids.meeting}`, { token: tokens.manager });
  const prep = detail.body.tasks.filter((task) => task.meeting_role === 'PREP');
  assert.ok(prep.length >= 3, 'a demo has prerequisites worth tracking');

  // they are real task records, in the ordinary system
  const first = await call('GET', `/tasks/${prep[0].id}`, { token: tokens.manager });
  assert.equal(first.status, 200);
  assert.equal(first.body.task.meeting_id, ids.meeting);
  assert.ok(first.body.task.ref.startsWith('PAR-'), 'it takes a reference in the ordinary department series');

  // asking again does not mint a second set
  const again = await call('POST', `/meetings/${ids.meeting}/prep-tasks`, { token: tokens.manager });
  assert.equal(again.body.created, 0, 'preparation work is created once, not once per save');

  const still = await call('GET', `/meetings/${ids.meeting}`, { token: tokens.manager });
  assert.equal(still.body.tasks.filter((task) => task.meeting_role === 'PREP').length, prep.length);
});

test('rescheduling moves the meeting and its prep, it does not duplicate them', async (t) => {
  if (skipIfUnavailable(t)) return;

  const listBefore = await call('GET', `/meetings?account_id=${ids.account}`, { token: tokens.manager });
  const countBefore = listBefore.body.meetings.length;

  const moved = await call('POST', `/meetings/${ids.meeting}/reschedule`, {
    token: tokens.manager,
    body: {
      scheduled_at: new Date(Date.now() + 9 * 86400000).toISOString(),
      reason: 'Dr Rao is travelling that week',
    },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.meeting.reschedule_count, 1);
  assert.equal(moved.body.meeting.was_rescheduled, true);
  assert.ok(moved.body.meeting.first_scheduled_at, 'the date first booked is kept');

  const listAfter = await call('GET', `/meetings?account_id=${ids.account}`, { token: tokens.manager });
  assert.equal(listAfter.body.meetings.length, countBefore, 'still one meeting, not two');

  // the preparation work moved with it rather than being recreated
  const detail = await call('GET', `/meetings/${ids.meeting}`, { token: tokens.manager });
  const prep = detail.body.tasks.filter((task) => task.meeting_role === 'PREP');
  assert.ok(prep.length >= 3);
  assert.ok(
    prep.every((task) => new Date(task.due_date).getTime() > Date.now() + 6 * 86400000),
    'prep is now due just before the new date',
  );
});

test('recording the outcome is what turns a demo into evidence', async (t) => {
  if (skipIfUnavailable(t)) return;

  const silent = await call('POST', `/meetings/${ids.meeting}/outcome`, {
    token: tokens.manager,
    body: { status: 'COMPLETED' },
  });
  assert.equal(silent.status, 400, 'a demo with no outcome recorded is the same as one that never happened');

  const done = await call('POST', `/meetings/${ids.meeting}/outcome`, {
    token: tokens.manager,
    body: {
      status: 'COMPLETED',
      outcome: 'Showed the device and the advisory flow. Dr Rao wants lab correlation data.',
      objections_raised: 'Concerned the per-farmer cost is too high for their grant.',
      validations_requested: 'Third-party lab correlation on 200 samples',
      next_decision: 'Whether to fund a 2,000-farmer pilot',
      attended_contact_ids: [ids.meera],
      follow_up: { title: 'Send the lab correlation report to Dr Rao' },
    },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.meeting.status, 'COMPLETED');
  assert.equal(done.body.meeting.happened, true);
  assert.ok(done.body.meeting.completed_at);

  // the follow-up is an ordinary task, in the ordinary system
  assert.ok(done.body.follow_up_task, 'the work that came out of it exists');
  const task = await call('GET', `/tasks/${done.body.follow_up_task.id}`, { token: tokens.manager });
  assert.equal(task.body.task.title, 'Send the lab correlation report to Dr Rao');
  assert.equal(task.body.task.meeting_id, ids.meeting);
  assert.equal(task.body.task.account_id, ids.account);

  // NOW it counts as having engaged them
  const account = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  const logged = account.body.activities.find(
    (a) => a.meeting_id === ids.meeting && a.outcome === 'COMPLETED',
  );
  assert.ok(logged, 'a completed demo is evidence');
  assert.equal(logged.is_external, true);
});

test('a cancelled meeting is recorded and counts for nothing', async (t) => {
  if (skipIfUnavailable(t)) return;

  const booked = await call('POST', '/meetings', {
    token: tokens.manager,
    body: {
      account_id: ids.account,
      title: 'Follow-up call that did not happen',
      scheduled_at: new Date(Date.now() + 2 * 86400000).toISOString(),
      create_prep_tasks: false,
    },
  });
  const id = booked.body.meeting.id;

  const before = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  const clockBefore = new Date(before.body.account.last_external_at).getTime();

  const cancelled = await call('POST', `/meetings/${id}/outcome`, {
    token: tokens.manager,
    body: { status: 'CANCELLED', cancel_reason: 'They postponed to after the harvest' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.meeting.status, 'CANCELLED');
  assert.equal(cancelled.body.meeting.happened, false);

  const after = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.equal(
    new Date(after.body.account.last_external_at).getTime(),
    clockBefore,
    'a cancellation is not engagement',
  );
  // but it is on the record, distinguishable
  assert.ok(after.body.activities.some((a) => a.meeting_id === id && a.outcome === 'CANCELLED'));
});

// ------------------------------------------------------------ delivery

test('winning a deal starts delivery, and doing it twice does not split it in two', async (t) => {
  if (skipIfUnavailable(t)) return;

  const first = await call('POST', `/engagements/from-opportunity/${ids.firstOpportunity}`, {
    token: tokens.manager,
    body: { kickoff_on: dateOnly(7) },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  ids.engagement = first.body.engagement.id;
  assert.equal(first.body.engagement.state, 'PLANNING');

  // the scope and agreement came across; the money did not
  assert.equal(first.body.engagement.agreement_type, 'Signed pilot agreement');
  assert.equal(first.body.engagement.agreed_value, 420000,
    'the value is shown from the deal, not re-recorded here');
  const { rows: columns } = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'engagements'
        AND column_name IN ('agreed_value','value','collected_value')`,
    [config.db.schema],
  );
  assert.deepEqual(columns, [], 'delivery holds no amount of its own to double-count');

  // pressing it again resolves to the same engagement
  const again = await call('POST', `/engagements/from-opportunity/${ids.firstOpportunity}`, {
    token: tokens.manager,
    body: {},
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.engagement.id, ids.engagement);

  const listed = await call('GET', `/engagements?account_id=${ids.account}`, { token: tokens.manager });
  assert.equal(listed.body.engagements.length, 1, 'one delivery, not two');
});

test('delivery work is created once, through the ordinary task engine', async (t) => {
  if (skipIfUnavailable(t)) return;

  const detail = await call('GET', `/engagements/${ids.engagement}`, { token: tokens.manager });
  assert.ok(detail.body.tasks.length >= 3, 'kickoff work exists');

  const task = await call('GET', `/tasks/${detail.body.tasks[0].id}`, { token: tokens.manager });
  assert.equal(task.body.task.engagement_id, ids.engagement);
  assert.equal(task.body.task.account_id, ids.account);

  // re-running the link does not add more
  await call('POST', `/engagements/from-opportunity/${ids.firstOpportunity}`, {
    token: tokens.manager, body: {},
  });
  const again = await call('GET', `/engagements/${ids.engagement}`, { token: tokens.manager });
  assert.equal(again.body.tasks.length, detail.body.tasks.length);
});

test('delivery runs on its own state, independent of the sales stage', async (t) => {
  if (skipIfUnavailable(t)) return;

  const atRisk = await call('PATCH', `/engagements/${ids.engagement}`, {
    token: tokens.manager,
    body: { state: 'AT_RISK', blockers: 'Their field team has not been freed up' },
  });
  assert.equal(atRisk.status, 200);
  assert.equal(atRisk.body.engagement.state, 'AT_RISK');
  assert.equal(atRisk.body.engagement.needs_attention, true);

  // the deal is still won — a signed agreement says nothing about how delivery goes
  const opportunity = await call('GET', `/opportunities/${ids.firstOpportunity}`, { token: tokens.manager });
  assert.equal(opportunity.body.opportunity.status, 'WON');

  // and the relationship history carries it
  const account = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.ok(account.body.activities.some((a) => /at risk/i.test(a.subject || '')));
});

test('a milestone delivered is not a milestone accepted', async (t) => {
  if (skipIfUnavailable(t)) return;

  const created = await call('POST', `/engagements/${ids.engagement}/milestones`, {
    token: tokens.manager,
    body: { title: 'First 500 farmers onboarded', due_date: dateOnly(30) },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.milestone.status, 'PLANNED');
  const milestoneId = created.body.milestone.id;

  const delivered = await call('PATCH', `/engagements/${ids.engagement}/milestones/${milestoneId}`, {
    token: tokens.manager, body: { status: 'DELIVERED' },
  });
  assert.equal(delivered.body.milestone.accepted_at, null, 'we delivered it; they have not accepted it');

  const accepted = await call('PATCH', `/engagements/${ids.engagement}/milestones/${milestoneId}`, {
    token: tokens.manager, body: { status: 'ACCEPTED' },
  });
  assert.ok(accepted.body.milestone.accepted_at, 'acceptance is recorded with who and when');
  assert.equal(accepted.body.milestone.accepted_by, ids.manager);
});

test('delivery cannot be started on a deal that has not been won', async (t) => {
  if (skipIfUnavailable(t)) return;

  const denied = await call('POST', `/engagements/from-opportunity/${ids.secondOpportunity}`, {
    token: tokens.manager, body: {},
  });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /once the deal is won/);
});

// ------------------------------------------------------------ the link library

test('a resource is a link, and the shared library is referenced rather than copied', async (t) => {
  if (skipIfUnavailable(t)) return;

  // something reusable, in the shared library
  const global = await call('POST', '/resources', {
    token: tokens.admin,
    body: {
      title: 'Soil Doctor validation summary 2026',
      url: 'https://drive.example.com/file/validation-2026',
      category: 'Validation',
      tags: ['validation', 'evidence'],
      version_label: 'v3',
    },
  });
  assert.equal(global.status, 201);
  assert.equal(global.body.resource.account_id, null, 'it belongs to the shared library');
  assert.match(global.body.note, /has not changed who can open it/);
  ids.globalResource = global.body.resource.id;

  // two leads point at the same one
  const other = await call('POST', '/accounts', {
    token: tokens.manager, body: { name: 'Second Org For Library', owner_user_id: ids.manager },
  });
  for (const accountId of [ids.account, other.body.account.id]) {
    const referenced = await call('POST', `/resources/${ids.globalResource}/reference`, {
      token: tokens.manager, body: { account_id: accountId },
    });
    assert.equal(referenced.status, 201);
    assert.match(referenced.body.note, /Referenced, not copied/);
  }

  // one row in the library, referenced twice — no duplicates
  const { rows: copies } = await query(
    'SELECT COUNT(*)::int AS n FROM crm_resources WHERE url = $1',
    ['https://drive.example.com/file/validation-2026'],
  );
  assert.equal(copies[0].n, 1, 'referencing a shared resource never makes a second copy of it');

  // it shows in the lead's library, marked as coming from the shared one
  const library = await call('GET', `/resources?account_id=${ids.account}`, { token: tokens.manager });
  const seen = library.body.resources.find((r) => r.id === ids.globalResource);
  assert.ok(seen);
  assert.equal(seen.is_reference, true);
  assert.equal(seen.from_global, true);

  // removing the reference leaves the shared resource alone
  await call('DELETE', `/resources/${ids.globalResource}/reference/${other.body.account.id}`, {
    token: tokens.manager,
  });
  const stillThere = await call('GET', '/resources?account_id=global', { token: tokens.admin });
  assert.ok(stillThere.body.resources.some((r) => r.id === ids.globalResource),
    'the original is still in the shared library for everyone else');
});

test('a lead library starts with the shelves people actually use', async (t) => {
  if (skipIfUnavailable(t)) return;

  const library = await call('GET', `/resources?account_id=${ids.account}`, { token: tokens.manager });
  const names = library.body.folders.map((f) => f.name);
  assert.ok(names.includes('Proposals & Offers'));
  assert.ok(names.includes('Validation & Evidence'));
  assert.ok(names.includes('Agreements'));
});

test('only real, reachable web links are saved', async (t) => {
  if (skipIfUnavailable(t)) return;

  for (const url of ['not a url', 'ftp://files.example.com/x', 'http://localhost:4000/admin',
    'http://192.168.1.10/internal']) {
    const refused = await call('POST', '/resources', {
      token: tokens.manager,
      body: { account_id: ids.account, title: 'Bad link', url },
    });
    assert.equal(refused.status, 400, `${url} is not a link worth storing`);
  }
});

test('saving a link is not sending it, and sending it is recorded separately', async (t) => {
  if (skipIfUnavailable(t)) return;

  const before = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  const clockBefore = new Date(before.body.account.last_external_at).getTime();

  const saved = await call('POST', '/resources', {
    token: tokens.manager,
    body: {
      account_id: ids.account,
      opportunity_id: ids.secondOpportunity,
      title: 'Testing contract proposal v2',
      url: 'https://docs.example.com/proposal-v2',
      version_label: 'v2',
    },
  });
  assert.equal(saved.status, 201);
  ids.resource = saved.body.resource.id;

  // putting it in the library did not engage anyone
  const afterSave = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.equal(
    new Date(afterSave.body.account.last_external_at).getTime(),
    clockBefore,
    'a document in the library is not a document that was sent',
  );

  // actually sending it is a separate claim, and that one counts
  const shared = await call('POST', `/resources/${ids.resource}/shares`, {
    token: tokens.manager,
    body: {
      account_id: ids.account,
      opportunity_id: ids.secondOpportunity,
      contact_id: ids.meera,
      channel: 'EMAIL',
      purpose: 'For her board meeting on Friday',
    },
  });
  assert.equal(shared.status, 201);
  assert.match(shared.body.note, /did not send anything and cannot grant access/);

  const afterShare = await call('GET', `/accounts/${ids.account}`, { token: tokens.manager });
  assert.ok(
    new Date(afterShare.body.account.last_external_at).getTime() > clockBefore,
    'sending something to a person is engagement',
  );

  // and the record says which version went to whom, by which channel
  const shares = await call('GET', `/resources/${ids.resource}/shares`, { token: tokens.manager });
  assert.equal(shares.body.shares.length, 1);
  assert.equal(shares.body.shares[0].contact_name, 'Meera Joshi');
  assert.equal(shares.body.shares[0].channel, 'EMAIL');
  assert.equal(shares.body.shares[0].version_label, 'v2');
});

test('removing a link does not pretend to delete the document behind it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const temp = await call('POST', '/resources', {
    token: tokens.manager,
    body: { account_id: ids.account, title: 'A link to drop', url: 'https://docs.example.com/drop-me' },
  });
  const removed = await call('DELETE', `/resources/${temp.body.resource.id}`, { token: tokens.manager });
  assert.equal(removed.status, 200);
  assert.match(removed.body.note, /document itself is untouched/);
});

test('only a manager may change the shared library', async (t) => {
  if (skipIfUnavailable(t)) return;

  const denied = await call('POST', '/resources', {
    token: tokens.member,
    body: { title: 'Member adding to the shared shelf', url: 'https://docs.example.com/nope' },
  });
  assert.equal(denied.status, 403);

  // but they can add to a lead they work on
  const allowed = await call('POST', '/resources', {
    token: tokens.member,
    body: { account_id: ids.account, title: 'Notes from the field day', url: 'https://docs.example.com/field-day' },
  });
  assert.equal(allowed.status, 201);
});

// ------------------------------------------------------------ the dashboards

test('the dashboard keeps the current book apart from what happened in a month', async (t) => {
  if (skipIfUnavailable(t)) return;

  const dash = await call('GET', '/accounts/dashboard/b2b', { token: tokens.admin });
  assert.equal(dash.status, 200);

  // two separate objects, not one blended figure
  assert.ok(dash.body.portfolio, 'how things stand');
  assert.ok(dash.body.activity, 'what happened in the month');
  assert.ok(dash.body.period.start && dash.body.period.end);

  // every figure ships its own definition and date basis
  assert.ok(dash.body.definitions.won_this_month);
  assert.equal(dash.body.definitions.won_this_month.basis, 'month');
  assert.equal(dash.body.definitions.eligible_pipeline.basis, 'now');
  assert.match(dash.body.definitions.value_won.detail, /Not revenue collected/);
});

test('the pipeline total never counts money it is not entitled to', async (t) => {
  if (skipIfUnavailable(t)) return;

  const dash = await call('GET', '/accounts/dashboard/b2b', { token: tokens.admin });
  const { portfolio } = dash.body;

  // the MoU is open but non-commercial, so it adds nothing
  const opportunities = await call('GET', '/opportunities?open=true', { token: tokens.admin });
  const eligible = opportunities.body.opportunities
    .filter((o) => o.is_open)
    .reduce((sum, o) => sum + (o.eligible_value ?? 0), 0);
  assert.equal(portfolio.eligible_pipeline, eligible);

  // and deals with no value are counted separately rather than treated as zero
  assert.equal(
    portfolio.without_value,
    opportunities.body.opportunities.filter((o) => o.is_open && o.eligible_value === null).length,
    'a deal with no value recorded is reported as such, not folded in as nothing',
  );
});

test('a person with nothing on file is described that way, not as having done nothing', async (t) => {
  if (skipIfUnavailable(t)) return;

  const people = await call('GET', '/accounts/dashboard/people', { token: tokens.admin });
  assert.equal(people.status, 200);

  const manager = people.body.summaries.find((s) => s.user.id === ids.manager);
  assert.ok(manager, 'the person working deals appears');
  assert.equal(typeof manager.nothing_recorded, 'boolean');
  assert.ok(manager.metrics.open_deals >= 1);

  // attempts and conversations are different columns, never summed into "activity"
  assert.ok('conversations' in manager.metrics);
  assert.ok('attempts' in manager.metrics);
  assert.ok('demos_completed' in manager.metrics);
});

test('a member cannot read everyone’s numbers', async (t) => {
  if (skipIfUnavailable(t)) return;

  const denied = await call('GET', '/accounts/dashboard/people', { token: tokens.member });
  assert.equal(denied.status, 403);
  const tree = await call('GET', '/accounts/views/tree', { token: tokens.member });
  assert.equal(tree.status, 403);
});

// ------------------------------------------------------------ the views

test('the tree groups an organization under exactly one person', async (t) => {
  if (skipIfUnavailable(t)) return;

  const tree = await call('GET', '/accounts/views/tree', { token: tokens.admin });
  assert.equal(tree.status, 200);
  assert.equal(tree.body.grouping, 'relationship_owner');

  // no organization appears under two managers, so portfolio totals cannot
  // double-count
  const seen = new Map();
  for (const manager of tree.body.managers) {
    for (const org of manager.organizations) {
      assert.ok(!seen.has(org.id), `${org.name} is under one manager only`);
      seen.set(org.id, manager.user.id);
    }
  }

  const manager = tree.body.managers.find((m) => m.user.id === ids.manager);
  assert.ok(manager);
  assert.equal(manager.totals.organizations, manager.organizations.length);
});

test('the map shows only pins somebody entered, and keeps the rest findable', async (t) => {
  if (skipIfUnavailable(t)) return;

  await call('POST', `/accounts/${ids.account}/locations`, {
    token: tokens.manager,
    body: { label: 'Head office', kind: 'HQ', city: 'Pune', latitude: 18.5204, longitude: 73.8567, precision: 'EXACT' },
  });
  await call('POST', `/accounts/${ids.account}/locations`, {
    token: tokens.manager,
    body: { label: 'Field ops', kind: 'OPERATING', city: 'Nashik', latitude: 19.9975, longitude: 73.7898 },
  });
  // a location with no coordinates: known city, unknown pin
  await call('POST', `/accounts/${ids.account}/locations`, {
    token: tokens.manager, body: { label: 'Warehouse', city: 'Dhule' },
  });

  const map = await call('GET', '/accounts/views/map', { token: tokens.manager });
  assert.equal(map.status, 200);

  const org = map.body.mapped.find((o) => o.id === ids.account);
  assert.ok(org, 'it has pins, so it is on the map');
  assert.equal(org.pins.length, 2, 'only the two with coordinates — nothing was geocoded');
  assert.ok(org.pins.some((p) => p.kind === 'HQ'), 'headquarters is distinguishable from operating areas');
  assert.ok(org.pins.some((p) => p.precision === 'APPROXIMATE'), 'an approximate pin says so');

  // two sites, one organization — counted once
  assert.equal(
    map.body.mapped.filter((o) => o.id === ids.account).length, 1,
    'an organization with two locations is still one organization',
  );

  // and organizations with no pin are listed rather than dropped
  assert.ok(map.body.organizations_unmapped >= 1);
  assert.ok(map.body.unmapped.length === map.body.organizations_unmapped);
});

// ------------------------------------------------------------ nudges

test('a deal that has gone quiet is chased according to how far along it is', async (t) => {
  if (skipIfUnavailable(t)) return;

  const nudges = await call('GET', '/accounts/nudges', { token: tokens.manager });
  assert.equal(nudges.status, 200);
  assert.ok(nudges.body.attention.length > 0, 'something in this pipeline needs attention');

  // signals are per deal, not per organization — one healthy deal must not hide
  // a drifting one at the same partner
  assert.ok(nudges.body.attention.every((s) => s.entity_type && s.entity_id));
  assert.ok(nudges.body.attention.some((s) => s.entity_type === 'OPPORTUNITY'));
});

test('a meeting that happened with nothing recorded is chased', async (t) => {
  if (skipIfUnavailable(t)) return;

  const booked = await call('POST', '/meetings', {
    token: tokens.manager,
    body: {
      account_id: ids.account,
      title: 'Review that nobody wrote up',
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      create_prep_tasks: false,
    },
  });
  // age it past the grace window
  await query(
    `UPDATE crm_meetings SET scheduled_at = now() - interval '3 days' WHERE id = $1`,
    [booked.body.meeting.id],
  );

  const nudges = await call('GET', '/accounts/nudges', { token: tokens.manager });
  const signal = nudges.body.attention.find(
    (s) => s.entity_type === 'MEETING' && s.entity_id === booked.body.meeting.id,
  );
  assert.ok(signal, 'a meeting with no outcome is not silently forgotten');
  assert.equal(signal.kind, 'meeting_outcome_missing');

  // and it shows as awaiting an outcome in its own list
  const awaiting = await call('GET', '/meetings?awaiting_outcome=true', { token: tokens.manager });
  assert.ok(awaiting.body.meetings.some((m) => m.id === booked.body.meeting.id));
  assert.ok(awaiting.body.meetings.every((m) => m.awaiting_outcome));
  ids.unrecordedMeeting = booked.body.meeting.id;
});

test('a nudge can be put down, but only with a reason and a date', async (t) => {
  if (skipIfUnavailable(t)) return;

  const noReason = await call('POST', '/accounts/nudges/snooze', {
    token: tokens.manager,
    body: { entity_type: 'MEETING', entity_id: ids.unrecordedMeeting, kind: 'meeting_outcome_missing' },
  });
  assert.equal(noReason.status, 400, 'a nudge dismissed without a reason is a nudge nobody learns from');

  const snoozed = await call('POST', '/accounts/nudges/snooze', {
    token: tokens.manager,
    body: {
      entity_type: 'MEETING',
      entity_id: ids.unrecordedMeeting,
      kind: 'meeting_outcome_missing',
      reason: 'Waiting on their notes before I write it up',
      days: 5,
    },
  });
  assert.equal(snoozed.status, 201);

  const after = await call('GET', '/accounts/nudges', { token: tokens.manager });
  assert.ok(
    !after.body.attention.some(
      (s) => s.entity_type === 'MEETING' && s.entity_id === ids.unrecordedMeeting,
    ),
    'it is quiet for now',
  );

  // and it is quiet for a stated reason, visible to anyone who looks
  const snoozes = await call('GET', '/accounts/nudges/snoozes', { token: tokens.manager });
  const record = snoozes.body.snoozes.find((s) => s.entity_id === ids.unrecordedMeeting);
  assert.ok(record);
  assert.equal(record.reason, 'Waiting on their notes before I write it up');
  assert.ok(new Date(record.until).getTime() > Date.now());
});
