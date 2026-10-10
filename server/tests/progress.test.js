/**
 * Progress that can be trusted.
 *
 * An audit found real work happening while the pipeline showed old stages and
 * old next steps. These tests guard what fixes that:
 *
 *   - every live deal owes a specific next action, a person and a date;
 *   - "last customer response", "last outbound follow-up" and "last internal
 *     update" are three different clocks, and tidying a record moves only the
 *     third;
 *   - a stage needs evidence (a dated proposal, an accepted order, a meeting
 *     that happened), and a finished task is never that evidence;
 *   - finishing deal work records what actually happened, and "will send
 *     samples" does not complete "test samples";
 *   - a customer's live deals stay on the board;
 *   - proposals, bookings, revenue billed and cash are kept apart, and unknown
 *     amounts stay unknown;
 *   - one accountable owner, with the next-action owner, escalation point and
 *     helpers named separately, and every handover explicit.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { missingForMove, nextActionGaps, problemWithNextAction } from '../src/services/dealRules.js';
import { outcomeProblem, readsLikeAPlan } from '../src/services/taskOutcomes.js';

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

// dates in India, the way the server reads them
const day = (offset = 0) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offset * 86400000));

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
  const detail = await call('GET', `/accounts/${res.body.account.id}`, { token });
  return { account: res.body.account, deal: detail.body.opportunities[0] };
};

const deal = async (id, token = tokens.manager) => {
  const res = await call('GET', `/opportunities/${id}`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

const nextAction = (owner = ids.manager, offset = 3, step = 'Call them about the pilot terms') => ({
  next_step: step, next_step_owner_id: owner, next_step_due: day(offset),
});

const dealTask = async (body, token = tokens.manager) => {
  const res = await call('POST', '/tasks', {
    token,
    body: {
      department_id: ids.department,
      assignee_id: ids.manager,
      due_date: new Date(Date.now() + 4 * 86400000).toISOString(),
      ...body,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.task;
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

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('BIZ', 'Business', '#2a78d6', 1)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE),
      ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'BIZ'`);
  ids.department = dept[0].id;
  const { rows: statuses } = await query('SELECT id FROM workflow_statuses ORDER BY position');
  ids.todo = statuses[0].id;
  ids.done = statuses[1].id;

  const password = await hashPassword('Password123!');
  for (const [key, name, role] of [
    ['manager', 'Vartika Head', 'manager'],
    ['rupendra', 'Rupendra Rep', 'member'],
    ['saumya', 'Saumya Rep', 'member'],
    ['outsider', 'Not On It', 'member'],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [name, `prog-${key}@test.local`, password, role, ids.department],
    );
    ids[key] = rows[0].id;
  }
  const { rows: gone } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, is_active)
     VALUES ('Left Already', 'prog-left@test.local', $1, 'member', $2, FALSE, FALSE) RETURNING id`,
    [password, ids.department],
  );
  ids.inactive = gone[0].id;

  const { rows: stages } = await query('SELECT id, slug FROM account_stages');
  for (const stage of stages) ids[`stage_${stage.slug.replace(/-/g, '_')}`] = stage.id;

  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  for (const key of ['manager', 'rupendra', 'saumya', 'outsider']) {
    const login = await call('POST', '/auth/login', {
      body: { email: `prog-${key}@test.local`, password: 'Password123!' },
    });
    tokens[key] = login.body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- the rules, on their own

test('a live deal owes a next action: what, who and by when', () => {
  const today = '2026-10-10';
  const gaps = (row) => nextActionGaps({ status: 'ACTIVE', stage_kind: 'open', ...row }, { todayDate: today })
    .map((g) => g.kind);

  assert.deepEqual(gaps({}), ['no_next_action', 'no_next_action_owner', 'no_next_action_due']);
  assert.deepEqual(gaps({ next_step: 'Send pricing', next_step_owner_id: 4 }), ['no_next_action_due']);
  assert.deepEqual(gaps({ next_step: 'Send pricing', next_step_owner_id: 4, next_step_due: '2026-10-09' }),
    ['next_action_overdue']);
  assert.deepEqual(gaps({ next_step: 'Send pricing', next_step_owner_id: 4, next_step_due: '2026-10-10' }), []);
  // a won, lost or paused deal owes nothing
  assert.deepEqual(nextActionGaps({ status: 'WON', stage_kind: 'won' }, { todayDate: today }), []);
  assert.deepEqual(nextActionGaps({ status: 'NURTURE', stage_kind: 'open' }, { todayDate: today }), []);

  assert.match(problemWithNextAction({ step: 'Send pricing', ownerId: 4, due: '2026-10-09' }, { todayDate: today }),
    /already passed/);
  assert.match(problemWithNextAction({ step: 'Send pricing', due: '2026-10-12' }, { todayDate: today }), /who owes/);
  assert.equal(problemWithNextAction({ step: 'Send pricing', ownerId: 4, due: '2026-10-12' }, { todayDate: today }), null);
});

test('a stage asks for evidence going forward, never going back or to Lost', () => {
  const proposal = { id: 7, name: 'Proposal', kind: 'open', position: 7, entry_rules: ['proposal'], exit_rules: [] };
  const demo = { id: 5, name: 'Meeting / Demo', kind: 'open', position: 5, entry_rules: [], exit_rules: ['meeting_completed'] };
  const won = { id: 9, name: 'Won', kind: 'won', position: 9, entry_rules: ['order'], exit_rules: [] };
  const lost = { id: 10, name: 'Lost', kind: 'lost', position: 10, entry_rules: [], exit_rules: [] };
  const none = { proposals: 0, accepted_orders: 0, completed_meetings: 0, contacts: 0, unmet_must_haves: 0 };

  const rules = (from, to, evidence = none) =>
    missingForMove({ opportunity: {}, from, to, evidence }).map((m) => `${m.phase}:${m.rule}`);

  assert.deepEqual(rules(demo, proposal), ['exit:meeting_completed', 'entry:proposal']);
  assert.deepEqual(rules(demo, proposal, { ...none, completed_meetings: 1, proposals: 1 }), []);
  assert.deepEqual(rules(proposal, won), ['entry:order']);
  assert.deepEqual(rules(proposal, demo), [], 'backwards needs nothing');
  assert.deepEqual(rules(demo, lost), [], 'losing needs a reason, not evidence');
  // an unknown rule is reported, never silently passed
  assert.equal(missingForMove({
    opportunity: {}, from: null, to: { ...proposal, entry_rules: ['typo_rule'] }, evidence: none,
  })[0].rule, 'typo_rule');
});

test('an outcome is a result, not a status and not a plan', () => {
  assert.ok(readsLikeAPlan('Will send samples'));
  assert.ok(readsLikeAPlan('We will send the samples on Monday'));
  assert.ok(readsLikeAPlan("We'll share the report"));
  assert.ok(readsLikeAPlan('Awaiting lab confirmation'));
  assert.ok(readsLikeAPlan('Samples to be sent by courier'));
  assert.ok(!readsLikeAPlan('Tested 40 samples; will share the report Friday'), 'a result, then a plan');
  assert.ok(!readsLikeAPlan('Sent the samples to the lab on 3 Oct'));
  assert.ok(!readsLikeAPlan('Lab confirmed the correlation on 200 samples'));

  assert.match(outcomeProblem('Done'), /status, not an outcome/);
  assert.match(outcomeProblem('ok'), /status, not an outcome/);
  assert.match(outcomeProblem('Sent it'), /in a sentence/);
  assert.equal(outcomeProblem('Sent the revised rate card to Meera'), null);
});

// ---------------------------------------------------------------- 1. the next action

test('a deal with no next action is flagged for each missing part', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { deal: fresh } = await newLead({ name: 'FarMart Agri' });
  ids.farmart = fresh.account_id;
  ids.farmartDeal = fresh.id;
  const kinds = fresh.flags.map((f) => f.kind);
  assert.ok(kinds.includes('no_next_action'));
  assert.ok(kinds.includes('no_next_action_owner'));
  assert.ok(kinds.includes('no_next_action_due'));
});

test('setting a next action needs all three, a real person, and a date not already gone', async (t) => {
  if (skipIfUnavailable(t)) return;
  const path = `/opportunities/${ids.farmartDeal}/next-action`;

  const past = await call('POST', path, { token: tokens.manager, body: nextAction(ids.rupendra, -1) });
  assert.equal(past.status, 400);
  assert.match(past.body.error, /already passed/);

  const nobody = await call('POST', path, { token: tokens.manager, body: nextAction(ids.inactive, 2) });
  assert.equal(nobody.status, 400);
  assert.match(nobody.body.error, /no longer active/);

  const set = await call('POST', path, {
    token: tokens.manager, body: nextAction(ids.rupendra, 2, 'Send FarMart the revised rate card'),
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const o = set.body.opportunity;
  assert.equal(o.next_step, 'Send FarMart the revised rate card');
  assert.equal(o.next_step_owner_id, ids.rupendra);
  assert.equal(o.next_step_owner_name, 'Rupendra Rep');
  assert.equal(o.next_action_gaps.length, 0);
  assert.ok(o.next_step_set_at, 'when it was agreed is kept');

  // the person who owes it is told
  const inbox = await call('GET', '/notifications', { token: tokens.rupendra });
  assert.ok(inbox.body.notifications.some((n) => n.type === 'crm_next_action' && /next move is yours/.test(n.title)));

  // and the timeline says so, as internal work — not as contact with FarMart
  const account = await call('GET', `/accounts/${ids.farmart}`, { token: tokens.manager });
  const entry = account.body.activities.find((a) => a.type === 'NEXT_ACTION');
  assert.ok(entry);
  assert.equal(entry.direction, 'INTERNAL');
  assert.equal(entry.is_external, false);
  assert.equal(account.body.account.last_external_at, null, 'planning is not engagement');
});

test('handing the next action to someone else is a handover both people hear about', async (t) => {
  if (skipIfUnavailable(t)) return;
  const moved = await call('POST', `/opportunities/${ids.farmartDeal}/next-action`, {
    token: tokens.manager,
    body: { ...nextAction(ids.saumya, 2, 'Send FarMart the revised rate card'), reason: 'Rupendra is on the road' },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  const detail = await deal(ids.farmartDeal);
  const handover = detail.handovers.find((h) => h.role === 'NEXT_ACTION');
  assert.equal(handover.from_user_id, ids.rupendra);
  assert.equal(handover.to_user_id, ids.saumya);
  assert.equal(handover.reason, 'Rupendra is on the road');
  assert.equal(handover.acknowledged_at, null, 'waiting for Saumya to confirm');

  const forRupendra = await call('GET', '/notifications', { token: tokens.rupendra });
  assert.ok(forRupendra.body.notifications.some((n) => n.type === 'crm_handover' && /moved to someone else/.test(n.title)));

  // only Saumya can confirm she has it
  const notHers = await call('POST', `/opportunities/handovers/${handover.id}/acknowledge`, { token: tokens.rupendra });
  assert.equal(notHers.status, 403);
  const hers = await call('POST', `/opportunities/handovers/${handover.id}/acknowledge`, { token: tokens.saumya });
  assert.equal(hers.status, 200);
  assert.equal(hers.body.handover.acknowledged_by, ids.saumya);

  // the history keeps who it moved from and why
  const changes = detail.history.filter((h) => h.field === 'next_step_owner_id');
  assert.ok(changes.some((h) => Number(h.from_value) === ids.rupendra && Number(h.to_value) === ids.saumya
    && h.reason === 'Rupendra is on the road'));
});

test('a live deal cannot have its next action cleared, only changed', async (t) => {
  if (skipIfUnavailable(t)) return;
  const cleared = await call('PATCH', `/opportunities/${ids.farmartDeal}`, {
    token: tokens.manager, body: { next_step: null },
  });
  assert.equal(cleared.status, 400);
  assert.equal(cleared.body.details.code, 'NEXT_ACTION_INVALID');

  // and repeating the current one (a form saved with nothing changed) is not refused
  const current = await deal(ids.farmartDeal);
  const same = await call('PATCH', `/opportunities/${ids.farmartDeal}`, {
    token: tokens.manager,
    body: {
      next_step: current.opportunity.next_step,
      next_step_owner_id: current.opportunity.next_step_owner_id,
      next_step_due: current.opportunity.next_step_due,
      name: 'FarMart soil testing kits',
    },
  });
  assert.equal(same.status, 200, JSON.stringify(same.body));
});

test('a next step logged with an activity lands on the deal, and stays there', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { account, deal: d } = await newLead({ name: 'Coromandel International' });
  ids.coromandel = account.id;
  ids.coromandelDeal = d.id;

  // the old bug: this went onto the organization only, and the next change to
  // the deal put the old step back on the card
  const logged = await call('POST', `/accounts/${account.id}/activities`, {
    token: tokens.manager,
    body: {
      type: 'CALL', subject: 'Spoke to procurement', outcome: 'COMPLETED',
      next_step: 'Share validation data with procurement', next_step_due: day(4),
      next_step_owner_id: ids.rupendra,
    },
  });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));

  const after = await deal(d.id);
  assert.equal(after.opportunity.next_step, 'Share validation data with procurement');
  assert.equal(after.opportunity.next_step_owner_id, ids.rupendra);
  assert.equal(after.opportunity.next_step_due, day(4));

  // an unrelated edit to the deal leaves the organization's card showing it
  await call('PATCH', `/opportunities/${d.id}`, { token: tokens.manager, body: { expected_close: day(60) } });
  const card = await call('GET', `/accounts/${account.id}`, { token: tokens.manager });
  assert.equal(card.body.account.next_step, 'Share validation data with procurement');

  // a next step without a date is refused rather than half-recorded
  const undated = await call('POST', `/accounts/${account.id}/activities`, {
    token: tokens.manager, body: { type: 'NOTE', subject: 'Note', next_step: 'Something vague' },
  });
  assert.equal(undated.status, 400);
  assert.match(undated.body.error, /date/);
});

test('a next step typed on the organization is set on its deal', async (t) => {
  if (skipIfUnavailable(t)) return;
  const edited = await call('PATCH', `/accounts/${ids.coromandel}`, {
    token: tokens.manager,
    body: { next_step: 'Book the plant visit', next_step_due: day(6), next_step_owner_id: ids.saumya },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const after = await deal(ids.coromandelDeal);
  assert.equal(after.opportunity.next_step, 'Book the plant visit');
  assert.equal(after.opportunity.next_step_owner_id, ids.saumya);
  assert.equal(edited.body.account.next_step, 'Book the plant visit', 'the card follows the deal');
});

// ---------------------------------------------------------------- 2. three clocks

test('a customer reply, our follow-up and internal work move different clocks', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { account, deal: d } = await newLead({ name: 'Clockwork Seeds' });

  const log = (body) => call('POST', `/accounts/${account.id}/activities`, {
    token: tokens.manager, body: { opportunity_id: d.id, ...body },
  });

  const inbound = await log({ type: 'EMAIL', subject: 'They asked for pricing', direction: 'INBOUND', outcome: 'RECEIVED',
    occurred_at: new Date(Date.now() - 5 * 86400000).toISOString() });
  assert.equal(inbound.status, 201);
  await log({ type: 'EMAIL', subject: 'Sent pricing', direction: 'OUTBOUND', outcome: 'SENT',
    occurred_at: new Date(Date.now() - 2 * 86400000).toISOString() });
  await log({ type: 'NOTE', subject: 'Internal: discussed discount with finance' });

  const now = await deal(d.id);
  assert.equal(now.opportunity.days_since_customer, 5, 'last customer response');
  assert.equal(now.opportunity.days_since_outbound, 2, 'last outbound follow-up');
  assert.equal(now.opportunity.days_since_internal, 0, 'last internal update');
  assert.equal(now.opportunity.awaiting_customer, true, 'we have chased since they last spoke');

  // an internal note never counts as hearing from them
  const account2 = await call('GET', `/accounts/${account.id}`, { token: tokens.manager });
  const note = account2.body.activities.find((a) => a.subject === 'Internal: discussed discount with finance');
  assert.equal(note.direction, 'INTERNAL');
  assert.equal(note.source, 'MANUAL');
  assert.equal(account2.body.account.days_since_customer, 5);

  // an internal entry can be marked as such whatever its type
  const internalCall = await log({ type: 'CALL', subject: 'Internal call about this deal', direction: 'INTERNAL' });
  assert.equal(internalCall.body.activity.is_external, false);
  const still = await deal(d.id);
  assert.equal(still.opportunity.days_since_customer, 5);
  assert.equal(still.opportunity.days_since_outbound, 2);
});

// ---------------------------------------------------------------- 3. stage evidence

test('Proposal needs a dated proposal on record, and a move says exactly what is missing', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { deal: d } = await newLead({ name: 'Evidence Agro' });
  ids.evidenceDeal = d.id;

  const bare = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_proposal, ...nextAction() },
  });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.details.code, 'STAGE_EVIDENCE_REQUIRED');
  assert.deepEqual(bare.body.details.missing.map((m) => m.rule), ['proposal']);
  assert.ok(bare.body.details.missing[0].hint);
  // nothing moved, and the next action given with the refused move was not kept either
  const unchanged = await deal(d.id);
  assert.equal(unchanged.opportunity.stage_slug, 'new');
  assert.equal(unchanged.opportunity.next_step, null);

  const future = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager,
    body: { stage_id: ids.stage_proposal, ...nextAction(), proposal: { sent_on: day(2) } },
  });
  assert.equal(future.status, 400);
  assert.match(future.body.error, /future/);

  const moved = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager,
    body: {
      stage_id: ids.stage_proposal, ...nextAction(),
      proposal: { sent_on: day(0), title: 'Kits and testing, year one', amount: 640000,
        link: 'https://drive.example/proposal-v1.pdf' },
    },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.opportunity.stage_slug, 'proposal');
  assert.equal(moved.body.opportunity.proposed_value, 640000, 'the amount put to them is the proposed value');
  assert.equal(moved.body.opportunity.proposal_count, 1);

  const detail = await deal(d.id);
  assert.equal(detail.commercial.proposals[0].link, 'https://drive.example/proposal-v1.pdf');
});

test('a link must be one anyone can open', async (t) => {
  if (skipIfUnavailable(t)) return;
  const bad = await call('POST', `/opportunities/${ids.evidenceDeal}/proposals`, {
    token: tokens.manager, body: { sent_on: day(0), link: 'javascript:alert(1)' },
  });
  assert.equal(bad.status, 400);
});

test('Won needs an accepted order or contract, with something anyone can check', async (t) => {
  if (skipIfUnavailable(t)) return;
  const vague = await call('POST', `/opportunities/${ids.evidenceDeal}/stage`, {
    token: tokens.manager,
    body: { stage_id: ids.stage_won, order: { received_on: day(0), amount: 600000 } },
  });
  assert.equal(vague.status, 400);
  assert.match(vague.body.error, /number, or a link/);

  const won = await call('POST', `/opportunities/${ids.evidenceDeal}/stage`, {
    token: tokens.manager,
    body: { stage_id: ids.stage_won, order: { kind: 'PURCHASE_ORDER', reference: 'EA/PO/551', received_on: day(0), amount: 600000 } },
  });
  assert.equal(won.status, 200, JSON.stringify(won.body));
  assert.equal(won.body.opportunity.status, 'WON');
  assert.equal(won.body.opportunity.agreed_value, 600000, 'the first order fills a blank agreed value');
  assert.equal(won.body.opportunity.booked_value, 600000);
  // a received order counts as hearing from the customer
  assert.equal(won.body.opportunity.days_since_customer, 0);
});

test('leaving Meeting / Demo forward needs a meeting that actually happened', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { account, deal: d } = await newLead({ name: 'Demo First Farms' });
  const toDemo = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_meeting_demo, ...nextAction() },
  });
  assert.equal(toDemo.status, 200, JSON.stringify(toDemo.body));

  const onwards = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_scope_alignment },
  });
  assert.equal(onwards.status, 400);
  assert.deepEqual(onwards.body.details.missing.map((m) => `${m.phase}:${m.rule}`), ['exit:meeting_completed']);

  // a booked demo is not enough
  const booked = await call('POST', '/meetings', {
    token: tokens.manager,
    body: {
      account_id: account.id, opportunity_id: d.id, kind: 'DEMO', title: 'Field demo',
      scheduled_at: new Date(Date.now() - 3600000).toISOString(), create_prep_tasks: false,
    },
  });
  assert.equal(booked.status, 201);
  const stillNo = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_scope_alignment },
  });
  assert.equal(stillNo.status, 400);

  await call('POST', `/meetings/${booked.body.meeting.id}/outcome`, {
    token: tokens.manager, body: { status: 'COMPLETED', outcome: 'Ran the demo with their agronomists; they want a trial.' },
  });
  const now = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_scope_alignment },
  });
  assert.equal(now.status, 200, JSON.stringify(now.body));
});

test('a manager can move without the evidence only by saying why, and it stays visible', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { deal: d } = await newLead({ name: 'Exception Traders', owner_user_id: ids.rupendra }, tokens.rupendra);

  // the deal's own owner, who is not a pipeline manager, cannot override
  const rep = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.rupendra,
    body: { stage_id: ids.stage_proposal, ...nextAction(ids.rupendra), override_reason: 'Trust me, it went out by hand' },
  });
  assert.equal(rep.status, 400);
  assert.equal(rep.body.details.can_override, false);

  const terse = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager,
    body: { stage_id: ids.stage_proposal, ...nextAction(ids.rupendra), override_reason: 'ok' },
  });
  assert.equal(terse.status, 400);
  assert.ok(terse.body.details.override_problem);

  const allowed = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager,
    body: {
      stage_id: ids.stage_proposal, ...nextAction(ids.rupendra),
      override_reason: 'Proposal was handed over in person at Krishi Mela; the PDF follows',
    },
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  const detail = await deal(d.id);
  const move = detail.history.find((h) => h.field === 'stage');
  assert.deepEqual(move.evidence_missing, ['proposal']);
  assert.match(move.reason, /Krishi Mela/);
});

test('a deal moving into a live stage must leave with a complete next action', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { deal: d } = await newLead({ name: 'Next Step Nurseries' });
  const silent = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_contacted },
  });
  assert.equal(silent.status, 400);
  assert.equal(silent.body.details.code, 'NEXT_ACTION_REQUIRED');

  const half = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_contacted, next_step: 'Send the deck' },
  });
  assert.equal(half.status, 400);

  const whole = await call('POST', `/opportunities/${d.id}/stage`, {
    token: tokens.manager, body: { stage_id: ids.stage_contacted, ...nextAction(ids.saumya, 1, 'Send the deck') },
  });
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  assert.equal(whole.body.opportunity.next_step_owner_id, ids.saumya);
});

// ---------------------------------------------------------------- 4. finishing deal work

test('finishing a deal task asks what happened, and a status is not an answer', async (t) => {
  if (skipIfUnavailable(t)) return;
  const task = await dealTask({ title: 'Test samples for FarMart', opportunity_id: ids.farmartDeal });
  assert.equal(task.account_id, ids.farmart, 'naming the deal files it under the organization');
  assert.equal(task.opportunity_name, 'FarMart soil testing kits');
  ids.samplesTask = task.id;

  const none = await call('POST', `/tasks/${task.id}/move`, { token: tokens.manager, body: { status_id: ids.done } });
  assert.equal(none.status, 400);
  assert.equal(none.body.details.code, 'OUTCOME_REQUIRED');

  const bare = await call('POST', `/tasks/${task.id}/move`, {
    token: tokens.manager, body: { status_id: ids.done, completion_note: 'Done', outcome_status: 'ACHIEVED' },
  });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /status, not an outcome/);

  const noResult = await call('POST', `/tasks/${task.id}/move`, {
    token: tokens.manager, body: { status_id: ids.done, completion_note: 'Tested the 12 samples they sent' },
  });
  assert.equal(noResult.status, 400);
  assert.equal(noResult.body.details.field, 'outcome_status');
});

test('"will send samples" does not complete "test samples"', async (t) => {
  if (skipIfUnavailable(t)) return;
  const plan = await call('POST', `/tasks/${ids.samplesTask}/move`, {
    token: tokens.manager,
    body: { status_id: ids.done, completion_note: 'Will send samples to the lab', outcome_status: 'ACHIEVED' },
  });
  assert.equal(plan.status, 400);
  assert.equal(plan.body.details.code, 'OUTCOME_READS_AS_PLAN');

  // the honest answer: record progress, and the task stays open
  const progress = await call('POST', `/tasks/${ids.samplesTask}/progress`, {
    token: tokens.manager, body: { note: 'Will send samples to the lab on Monday' },
  });
  assert.equal(progress.status, 201, JSON.stringify(progress.body));
  assert.notEqual(progress.body.task.stage, 'done');
  const account = await call('GET', `/accounts/${ids.farmart}`, { token: tokens.manager });
  const note = account.body.activities.find((a) => /Progress on/.test(a.subject || ''));
  assert.ok(note);
  assert.equal(note.direction, 'INTERNAL');
  assert.equal(note.source, 'TASK');
});

test('a finished deal task records its evidence on the timeline and never moves the stage', async (t) => {
  if (skipIfUnavailable(t)) return;
  const before = await deal(ids.farmartDeal);

  const badLink = await call('POST', `/tasks/${ids.samplesTask}/move`, {
    token: tokens.manager,
    body: {
      status_id: ids.done, completion_note: 'Lab tested all 12 samples; results match their reference lab',
      outcome_status: 'ACHIEVED', outcome_evidence_url: 'ftp://lab.example/report',
    },
  });
  assert.equal(badLink.status, 400);

  const done = await call('POST', `/tasks/${ids.samplesTask}/move`, {
    token: tokens.manager,
    body: {
      status_id: ids.done, completion_note: 'Lab tested all 12 samples; results match their reference lab',
      outcome_status: 'ACHIEVED', outcome_evidence_url: 'https://drive.example/farmart-lab-report',
    },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.task.outcome_status, 'ACHIEVED');
  assert.equal(done.body.task.outcome_evidence_url, 'https://drive.example/farmart-lab-report');

  const after = await deal(ids.farmartDeal);
  assert.equal(after.opportunity.stage_id, before.opportunity.stage_id, 'a finished task is not a stage move');
  assert.equal(after.opportunity.status, before.opportunity.status);

  const account = await call('GET', `/accounts/${ids.farmart}`, { token: tokens.manager });
  const entry = account.body.activities.find((a) => a.type === 'TASK_DONE' && a.task_id === ids.samplesTask);
  assert.ok(entry, 'the timeline shows the work was finished');
  assert.equal(entry.is_external, false);
  assert.equal(entry.meta.evidence_url, 'https://drive.example/farmart-lab-report');
  assert.equal(account.body.account.last_external_at, null, 'finishing our own task is not contact with them');
});

test('finishing the task that was the deal\'s next action asks what happens next', async (t) => {
  if (skipIfUnavailable(t)) return;
  const task = await dealTask({ title: 'Send the revised rate card', opportunity_id: ids.farmartDeal });
  // make this task the deal's next action
  await query('UPDATE opportunities SET next_step_task_id = $1 WHERE id = $2', [task.id, ids.farmartDeal]);

  const context = await call('GET', `/tasks/${task.id}/completion-context`, { token: tokens.manager });
  assert.equal(context.status, 200);
  assert.equal(context.body.deal_task, true);
  assert.equal(context.body.requires_next_step, true);
  assert.equal(context.body.deals[0].is_this_task, true);

  const noNext = await call('PATCH', `/tasks/${task.id}`, {
    token: tokens.manager,
    body: { status_id: ids.done, completion_note: 'Sent the revised rate card to their buyer', outcome_status: 'ACHIEVED' },
  });
  assert.equal(noNext.status, 400);
  assert.equal(noNext.body.details.code, 'NEXT_ACTION_REQUIRED');

  const withNext = await call('PATCH', `/tasks/${task.id}`, {
    token: tokens.manager,
    body: {
      status_id: ids.done, completion_note: 'Sent the revised rate card to their buyer',
      outcome_status: 'ACHIEVED',
      next_step: { text: 'Chase their buyer for a decision', owner_id: ids.saumya, due: day(5) },
    },
  });
  assert.equal(withNext.status, 200, JSON.stringify(withNext.body));
  assert.equal(withNext.body.task.outcome_next_step, 'Chase their buyer for a decision');
  const after = await deal(ids.farmartDeal);
  assert.equal(after.opportunity.next_step, 'Chase their buyer for a decision');
  assert.equal(after.opportunity.next_step_owner_id, ids.saumya);
  assert.equal(after.opportunity.next_step_due, day(5));
  assert.equal(after.opportunity.next_step_task_id, null);
});

test('confirming a plan-like outcome is allowed, and recorded as the person\'s own claim', async (t) => {
  if (skipIfUnavailable(t)) return;
  const task = await dealTask({ title: 'Arrange the sample pickup', opportunity_id: ids.farmartDeal });
  const done = await call('POST', `/tasks/${task.id}/move`, {
    token: tokens.manager,
    body: {
      status_id: ids.done, completion_note: 'Pickup to be arranged by their logistics team — confirmed by phone',
      outcome_status: 'ACHIEVED', confirm_intent: true,
    },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.task.outcome_intent_confirmed, true);

  // reopening clears the outcome it was closed with; the history keeps it
  const reopened = await call('POST', `/tasks/${task.id}/move`, { token: tokens.manager, body: { status_id: ids.todo } });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.task.outcome_status, null);
});

test('an ordinary task finishes exactly as it always did', async (t) => {
  if (skipIfUnavailable(t)) return;
  const task = await dealTask({ title: 'Renew the office printer contract' });
  const done = await call('POST', `/tasks/${task.id}/move`, {
    token: tokens.manager, body: { status_id: ids.done, completion_note: 'Renewed' },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.outcome_status, null);
  const context = await call('GET', `/tasks/${task.id}/completion-context`, { token: tokens.manager });
  assert.equal(context.body.deal_task, false);
});

test('a task cannot name a deal from another organization', async (t) => {
  if (skipIfUnavailable(t)) return;
  const res = await call('POST', '/tasks', {
    token: tokens.manager,
    body: {
      title: 'Mismatched link', department_id: ids.department, assignee_id: ids.manager,
      due_date: new Date(Date.now() + 86400000).toISOString(),
      account_id: ids.coromandel, opportunity_id: ids.farmartDeal,
    },
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------- 5. the board

test('a customer\'s live deals stay on the board', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { account, deal: first } = await newLead({ name: 'Repeat Buyer Co' });
  // first deal won, organization becomes a customer
  const converted = await call('POST', `/accounts/${account.id}/convert`, {
    token: tokens.manager,
    body: {
      type: 'CUSTOMER', opportunity_id: first.id,
      order: { reference: 'RB-PO-1', received_on: day(0), amount: 250000 },
    },
  });
  assert.equal(converted.status, 200, JSON.stringify(converted.body));

  // a second deal with the same customer
  const second = await call('POST', '/opportunities', {
    token: tokens.manager,
    body: {
      account_id: account.id, name: 'Second season kits', estimated_value: 300000,
      stage_id: ids.stage_qualified, ...nextAction(ids.manager, 3, 'Confirm second-season volumes'),
    },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  // the old board was leads only, so this deal was nowhere
  const legacy = await call('GET', '/accounts/pipeline', { token: tokens.manager });
  assert.ok(!legacy.body.stages.some((s) => s.accounts.some((a) => a.id === account.id)));

  const board = await call('GET', '/opportunities/board', { token: tokens.manager });
  assert.equal(board.status, 200);
  const card = board.body.stages.flatMap((s) => s.deals).find((dd) => dd.id === second.body.opportunity.id);
  assert.ok(card, 'the customer\'s new deal is on the board');
  assert.equal(card.account_kind, 'CUSTOMER');
  assert.equal(card.next_step_owner_name, 'Vartika Head');
  assert.ok(!board.body.stages.flatMap((s) => s.deals).some((dd) => dd.id === first.id), 'the won deal is not');
  assert.ok(board.body.closed.find((s) => s.kind === 'won').count >= 1);
  assert.ok(board.body.organizations >= 1);
});

test('"mine" means every deal a person is on, not only the ones they own', async (t) => {
  if (skipIfUnavailable(t)) return;
  const board = await call('GET', '/opportunities/board?mine=true', { token: tokens.saumya });
  const mine = board.body.stages.flatMap((s) => s.deals).map((dd) => dd.id);
  assert.ok(mine.includes(ids.farmartDeal), 'she owes FarMart\'s next action');
  assert.ok(mine.includes(ids.coromandelDeal), 'and Coromandel\'s');
});

// ---------------------------------------------------------------- 6. the commercial record

test('proposals, bookings, revenue billed and cash are separate, and blanks stay blank', async (t) => {
  if (skipIfUnavailable(t)) return;
  const id = ids.coromandelDeal;
  const base = `/opportunities/${id}`;

  const order = await call('POST', `${base}/orders`, {
    token: tokens.manager, body: { kind: 'PURCHASE_ORDER', reference: 'CIL/PO/77', received_on: day(-1) },
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.totals.booked, null, 'an order with no amount is counted but adds no number');
  assert.equal(order.body.totals.booked_incomplete, true);

  const amountless = await call('POST', `${base}/invoices`, {
    token: tokens.manager, body: { issued_on: day(0) },
  });
  assert.equal(amountless.status, 400, 'an invoice needs its amount');

  const invoice = await call('POST', `${base}/invoices`, {
    token: tokens.manager,
    body: { number: 'INV-2026-031', issued_on: day(0), amount: 200000, order_id: order.body.orders[0].id },
  });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
  assert.equal(invoice.body.totals.invoiced, 200000);
  assert.equal(invoice.body.totals.cash_received, null, 'billed is not received');
  assert.equal(invoice.body.opportunity.financial_status, 'INVOICED');

  const early = await call('POST', `${base}/payments`, {
    token: tokens.manager, body: { received_on: day(3), amount: 50000 },
  });
  assert.equal(early.status, 400, 'money expected later has not arrived');

  const part = await call('POST', `${base}/payments`, {
    token: tokens.manager,
    body: { received_on: day(0), amount: 80000, reference: 'UTR 4411', invoice_id: invoice.body.invoices[0].id },
  });
  assert.equal(part.status, 201);
  assert.equal(part.body.totals.cash_received, 80000);
  assert.equal(part.body.opportunity.financial_status, 'PART_PAID');
  assert.equal(part.body.invoices[0].paid, 80000);

  // a typed "collected" figure cannot contradict the payments on record
  const typed = await call('PATCH', base, { token: tokens.manager, body: { collected_value: 500000 } });
  assert.equal(typed.status, 400);

  // a mistaken payment is voided with a reason and stays on the record
  const silentVoid = await call('POST', `${base}/payments/${part.body.payments[0].id}/void`, {
    token: tokens.manager, body: { reason: '' },
  });
  assert.equal(silentVoid.status, 400);
  const voided = await call('POST', `${base}/payments/${part.body.payments[0].id}/void`, {
    token: tokens.manager, body: { reason: 'Entered against the wrong customer' },
  });
  assert.equal(voided.status, 201);
  assert.equal(voided.body.totals.cash_received, null);
  assert.equal(voided.body.payments.length, 1, 'still there');
  assert.equal(voided.body.payments[0].is_void, true);
  assert.equal(voided.body.opportunity.financial_status, 'INVOICED');

  const full = await call('POST', `${base}/payments`, {
    token: tokens.manager, body: { received_on: day(0), amount: 200000, reference: 'UTR 4502' },
  });
  assert.equal(full.body.opportunity.financial_status, 'PAID');

  // the month on the dashboard counts each on its own date
  const dashboard = await call('GET', '/accounts/dashboard/b2b', { token: tokens.manager });
  const activity = dashboard.body.activity;
  assert.ok(activity.invoiced >= 200000);
  assert.ok(activity.cash_received >= 200000);
  assert.ok(activity.orders_without_amount >= 1, 'the response says how many orders had no amount');
  assert.ok(dashboard.body.definitions.booked && dashboard.body.definitions.cash_received);
});

// ---------------------------------------------------------------- 7. people and reasons

test('changing a value somebody relied on needs a reason; filling a blank does not', async (t) => {
  if (skipIfUnavailable(t)) return;
  const { deal: d } = await newLead({ name: 'Value Watch Ltd' });
  const first = await call('PATCH', `/opportunities/${d.id}`, { token: tokens.manager, body: { estimated_value: 400000 } });
  assert.equal(first.status, 200);

  const silent = await call('PATCH', `/opportunities/${d.id}`, { token: tokens.manager, body: { estimated_value: 900000 } });
  assert.equal(silent.status, 400);
  assert.equal(silent.body.details.code, 'REASON_REQUIRED');

  const explained = await call('PATCH', `/opportunities/${d.id}`, {
    token: tokens.manager, body: { estimated_value: 900000, reason: 'They added two more districts' },
  });
  assert.equal(explained.status, 200);
  const detail = await deal(d.id);
  const change = detail.history.find((h) => h.field === 'estimated_value' && h.to_value === '900000');
  assert.equal(change.reason, 'They added two more districts');
  assert.equal(change.from_value, '400000');

  // the same rule on the organization's "expected value"
  const account = await call('PATCH', `/accounts/${d.account_id}`, { token: tokens.manager, body: { value: 1 } });
  assert.equal(account.status, 400);
});

test('helpers can work a deal but only its leaders decide who leads it', async (t) => {
  if (skipIfUnavailable(t)) return;
  const id = ids.coromandelDeal;

  const outsider = await call('POST', `/opportunities/${id}/next-action`, {
    token: tokens.outsider, body: nextAction(ids.outsider),
  });
  assert.equal(outsider.status, 403);

  const added = await call('POST', `/opportunities/${id}/collaborators`, {
    token: tokens.manager, body: { user_id: ids.outsider, role: 'Agronomy validation' },
  });
  assert.equal(added.status, 201);
  assert.ok(added.body.opportunity.collaborators.some((c) => c.user_id === ids.outsider && c.role === 'Agronomy validation'));
  const inbox = await call('GET', '/notifications', { token: tokens.outsider });
  assert.ok(inbox.body.notifications.some((n) => n.type === 'crm_collaborator'));

  // now they can update the next action
  const helping = await call('POST', `/opportunities/${id}/next-action`, {
    token: tokens.outsider, body: nextAction(ids.outsider, 2, 'Share the validation protocol'),
  });
  assert.equal(helping.status, 200, JSON.stringify(helping.body));

  // but not hand the deal to someone else
  const takeover = await call('PATCH', `/opportunities/${id}`, {
    token: tokens.outsider, body: { owner_user_id: ids.outsider, reason: 'I am doing all the work' },
  });
  assert.equal(takeover.status, 403);

  const escalation = await call('PATCH', `/opportunities/${id}`, {
    token: tokens.manager, body: { escalation_owner_id: ids.manager },
  });
  assert.equal(escalation.status, 200);
  assert.equal(escalation.body.opportunity.escalation_owner_name, 'Vartika Head');
});

test('a live deal cannot be left with nobody owning it', async (t) => {
  if (skipIfUnavailable(t)) return;
  const res = await call('PATCH', `/opportunities/${ids.coromandelDeal}`, {
    token: tokens.manager, body: { owner_user_id: null, reason: 'Testing' },
  });
  assert.equal(res.status, 400);
});
