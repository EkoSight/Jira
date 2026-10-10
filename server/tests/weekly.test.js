/**
 * Weekly visibility.
 *
 * Guarded here: a deal paused on purpose is not chased until its date, and is
 * when the date comes; hearing from the customer ends a wait on them; a deal
 * is stalled on the customer's clock and its stage's own threshold; what
 * customers commit to is tracked to kept or missed; a blocker says what is
 * blocked, on whom, who clears it and by when; the week is written down once
 * and never rewritten; owners review outcomes, not activity; and imported or
 * synced correspondence is only ever a suggestion until somebody confirms it.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { setChatConfig, setGoogleFetch } from '../src/lib/googleChat.js';
import { updateSetting } from '../src/services/settings.js';
import { freshText, parseCalendar, parseEmail } from '../src/services/correspondence.js';
import { previousWeek, weekOf } from '../src/services/weekly.js';
import { indiaClock, runPipelineWeekly } from '../src/jobs/pipelineWeekly.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const day = (offset = 0) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offset * 86400000));
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };

const lead = async (body) => {
  const res = await call('POST', '/accounts', {
    token: tokens.manager,
    body: { owner_user_id: ids.manager, department_id: ids.department, ...body },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const detail = await call('GET', `/accounts/${res.body.account.id}`, { token: tokens.manager });
  return { account: res.body.account, deal: detail.body.opportunities[0] };
};
const nudges = async () => (await call('GET', '/accounts/nudges', { token: tokens.manager })).body.attention;

const serviceKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('BIZ', 'Business', '#2a78d6', 1)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  ids.department = (await query(`SELECT id FROM departments`)).rows[0].id;
  ids.done = (await query(`SELECT id FROM workflow_statuses WHERE slug = 'done'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, name, role] of [
    ['manager', 'Vartika Head', 'manager'], ['rupendra', 'Rupendra Rep', 'member'], ['saumya', 'Saumya Rep', 'member'],
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
  for (const key of ['manager', 'rupendra', 'saumya']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `${key}@ekosight.com`, password: 'Password123!' } })).body.token;
  }

  // an organization with a known contact, used by several tests
  const farmart = await lead({ name: 'FarMart Agri', website: 'https://www.farmart.co' });
  ids.farmart = farmart.account.id;
  ids.farmartDeal = farmart.deal.id;
  const contact = await call('POST', `/accounts/${ids.farmart}/contacts`, {
    token: tokens.manager, body: { full_name: 'Rajesh Kumar', email: 'rajesh@farmart.co', designation: 'Procurement head' },
  });
  ids.rajesh = contact.body.contact.id;
  await call('POST', `/opportunities/${ids.farmartDeal}/next-action`, {
    token: tokens.manager, body: { next_step: 'Share the rate card', next_step_owner_id: ids.rupendra, next_step_due: day(3) },
  });
});

after(async () => {
  setGoogleFetch(null);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- the calendar of a week

test('a week runs Monday to Monday in India', () => {
  assert.deepEqual(weekOf('2026-10-10'), { start: '2026-10-05', end: '2026-10-12' }, 'a Saturday');
  assert.deepEqual(weekOf('2026-10-12'), { start: '2026-10-12', end: '2026-10-19' }, 'a Monday is its own start');
  assert.deepEqual(weekOf('2026-10-18'), { start: '2026-10-12', end: '2026-10-19' }, 'a Sunday ends it');
  assert.deepEqual(previousWeek('2026-10-12'), { start: '2026-10-05', end: '2026-10-12' });
  // 03:30 UTC on Monday 12 Oct is 09:00 in India
  assert.deepEqual(indiaClock(new Date('2026-10-12T03:30:00Z')), { weekday: 1, time: '09:00' });
});

// ---------------------------------------------------------------- 9. paused on purpose

test('waiting on the customer needs a reason and a date, and becomes the next action', async (t) => {
  if (skip(t)) return;
  const { deal } = await lead({ name: 'Coromandel International' });
  ids.coromandelDeal = deal.id;
  ids.coromandel = deal.account_id;
  const path = `/opportunities/${deal.id}/waiting`;

  const noReason = await call('POST', path, { token: tokens.manager, body: { waiting_on: 'CUSTOMER', reason: '', until: day(10) } });
  assert.equal(noReason.status, 400);
  const past = await call('POST', path, { token: tokens.manager, body: { waiting_on: 'CUSTOMER', reason: 'Board meeting', until: day(-1) } });
  assert.equal(past.status, 400);
  const forgotten = await call('POST', path, { token: tokens.manager, body: { waiting_on: 'CUSTOMER', reason: 'Board meeting', until: day(400) } });
  assert.equal(forgotten.status, 400, 'a pause longer than six months is forgetting, not waiting');

  const ok = await call('POST', path, {
    token: tokens.manager, body: { waiting_on: 'CUSTOMER', reason: 'Their board meets on the 20th', until: day(10) },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.opportunity.is_waiting, true);
  assert.equal(ok.body.opportunity.next_step, 'Check back: Their board meets on the 20th');
  assert.equal(ok.body.opportunity.next_step_due, day(10));
  assert.equal(ok.body.opportunity.next_action_gaps.length, 0, 'waiting keeps a complete next action');

  // not chased while it waits, even though nobody has heard from them
  await query(`UPDATE opportunities SET created_at = now() - interval '40 days' WHERE id = $1`, [deal.id]);
  assert.ok(!(await nudges()).some((n) => n.entity_id === deal.id && n.entity_type === 'OPPORTUNITY'));

  // and on the date, one nudge to look again
  await query(`UPDATE opportunities SET waiting_until = $2::date WHERE id = $1`, [deal.id, day(0)]);
  const due = (await nudges()).find((n) => n.entity_id === deal.id && n.kind === 'revisit_due');
  assert.ok(due, 'it comes back on its date');
  assert.match(due.detail, /Their board meets/);
});

test('hearing from the customer ends a wait on them, on the record', async (t) => {
  if (skip(t)) return;
  const reply = await call('POST', `/accounts/${ids.coromandel}/activities`, {
    token: tokens.manager,
    body: { type: 'EMAIL', direction: 'INBOUND', outcome: 'RECEIVED', subject: 'Board approved the pilot', opportunity_id: ids.coromandelDeal },
  });
  assert.equal(reply.status, 201);
  const detail = await call('GET', `/opportunities/${ids.coromandelDeal}`, { token: tokens.manager });
  assert.equal(detail.body.opportunity.waiting_on, null);
  const entry = detail.body.history.find((h) => h.field === 'waiting' && h.to_value === null);
  assert.match(entry.reason, /They responded/);
});

test('on hold and nurture need a date to look again, and stay quiet until it', async (t) => {
  if (skip(t)) return;
  const { deal } = await lead({ name: 'Nurture Seeds' });
  const undated = await call('POST', `/opportunities/${deal.id}/status`, {
    token: tokens.manager, body: { status: 'NURTURE', reason: 'Budget next year' },
  });
  assert.equal(undated.status, 400);
  assert.equal(undated.body.details.code, 'REVISIT_REQUIRED');

  const dated = await call('POST', `/opportunities/${deal.id}/status`, {
    token: tokens.manager, body: { status: 'NURTURE', reason: 'Budget next year', revisit_on: day(30) },
  });
  assert.equal(dated.status, 200);
  await query(`UPDATE opportunities SET created_at = now() - interval '200 days' WHERE id = $1`, [deal.id]);
  assert.ok(!(await nudges()).some((n) => n.entity_id === deal.id), 'not flagged while nurtured');

  await query(`UPDATE opportunities SET revisit_on = $2::date WHERE id = $1`, [deal.id, day(-1)]);
  assert.ok((await nudges()).some((n) => n.entity_id === deal.id && n.kind === 'revisit_due'));
});

test('a stage has its own quiet threshold, read on the customer\'s clock', async (t) => {
  if (skip(t)) return;
  const { deal } = await lead({ name: 'Threshold Farms' });
  const zero = await call('PATCH', `/accounts/stages/${deal.stage_id}`, { token: tokens.manager, body: { quiet_after_days: 0 } });
  assert.equal(zero.status, 400);
  const set = await call('PATCH', `/accounts/stages/${deal.stage_id}`, { token: tokens.manager, body: { quiet_after_days: 3 } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.stage.quiet_after_days, 3);
  const notTheirs = await call('PATCH', `/accounts/stages/${deal.stage_id}`, { token: tokens.rupendra, body: { quiet_after_days: 30 } });
  assert.equal(notTheirs.status, 403);
  await query(`UPDATE opportunities SET created_at = now() - interval '20 days' WHERE id = $1`, [deal.id]);
  await call('POST', `/opportunities/${deal.id}/next-action`, {
    token: tokens.manager, body: { next_step: 'Call them', next_step_owner_id: ids.manager, next_step_due: day(2) },
  });

  // they last spoke 5 days ago, we chased yesterday: chasing, unanswered
  await call('POST', `/accounts/${deal.account_id}/activities`, {
    token: tokens.manager,
    body: { type: 'CALL', direction: 'INBOUND', outcome: 'COMPLETED', subject: 'Intro call',
      occurred_at: new Date(Date.now() - 5 * 86400000).toISOString(), opportunity_id: deal.id },
  });
  await call('POST', `/accounts/${deal.account_id}/activities`, {
    token: tokens.manager,
    body: { type: 'EMAIL', direction: 'OUTBOUND', outcome: 'SENT', subject: 'Following up',
      occurred_at: new Date(Date.now() - 1 * 86400000).toISOString(), opportunity_id: deal.id },
  });
  let signal = (await nudges()).find((n) => n.entity_id === deal.id);
  assert.equal(signal.kind, 'awaiting_reply');
  assert.match(signal.detail, /expects every 3/);

  // an internal note does not count as hearing from them
  await call('POST', `/accounts/${deal.account_id}/activities`, {
    token: tokens.manager, body: { type: 'NOTE', subject: 'Discussed internally', opportunity_id: deal.id },
  });
  signal = (await nudges()).find((n) => n.entity_id === deal.id);
  assert.equal(signal.kind, 'awaiting_reply');

  // nobody has chased for a while either: gone quiet
  await query(
    `UPDATE account_activities SET occurred_at = now() - interval '4 days'
      WHERE opportunity_id = $1 AND direction = 'OUTBOUND'`,
    [deal.id],
  );
  signal = (await nudges()).find((n) => n.entity_id === deal.id);
  assert.equal(signal.kind, 'gone_quiet');

  const cleared = await call('PATCH', `/accounts/stages/${deal.stage_id}`, { token: tokens.manager, body: { quiet_after_days: null } });
  assert.equal(cleared.body.stage.quiet_after_days, null, 'blank goes back to the pipeline-wide threshold');
});

// ---------------------------------------------------------------- 8. commitments

test('what the customer commits to is tracked to kept or missed', async (t) => {
  if (skip(t)) return;
  const logged = await call('POST', `/accounts/${ids.farmart}/activities`, {
    token: tokens.manager,
    body: {
      type: 'CALL', direction: 'INBOUND', outcome: 'COMPLETED', subject: 'Rajesh called about samples',
      opportunity_id: ids.farmartDeal, contact_id: ids.rajesh,
      commitment: { what: 'Send 12 soil samples', due_on: day(-1) },
    },
  });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  const listed = await call('GET', `/opportunities/${ids.farmartDeal}/commitments`, { token: tokens.manager });
  const commitment = listed.body.commitments[0];
  assert.equal(commitment.what, 'Send 12 soil samples');
  assert.equal(commitment.status, 'OPEN');
  assert.ok((await nudges()).some((n) => n.kind === 'commitment_overdue' && /12 soil samples/.test(n.detail)));

  const kept = await call('POST', `/opportunities/commitments/${commitment.id}/resolve`, {
    token: tokens.manager, body: { status: 'KEPT', note: 'Samples arrived Thursday' },
  });
  assert.equal(kept.status, 200);
  const again = await call('POST', `/opportunities/commitments/${commitment.id}/resolve`, {
    token: tokens.manager, body: { status: 'MISSED' },
  });
  assert.equal(again.status, 404, 'a closed commitment is not reopened by a second answer');
  assert.ok(!(await nudges()).some((n) => n.kind === 'commitment_overdue' && /12 soil samples/.test(n.detail)));
});

// ---------------------------------------------------------------- 10. blockers

test('a blocker says what is blocked, on whom, who clears it and by when', async (t) => {
  if (skip(t)) return;
  const base = {
    entity_type: 'OPPORTUNITY', entity_id: ids.farmartDeal, kind: 'blocker', category: 'SAMPLE_VALIDATION',
    title: 'Lab validation pending', body: 'Their lab must validate our readings before procurement signs.',
  };
  const bare = await call('POST', '/threads', { token: tokens.manager, body: base });
  assert.equal(bare.status, 400);
  const external = await call('POST', '/threads', {
    token: tokens.manager,
    body: { ...base, blocked_item: 'Sample validation', dependency: 'EXTERNAL', responsible_user_id: ids.rupendra, expected_resolution: day(5) },
  });
  assert.equal(external.status, 400, 'an outside dependency names who outside');

  const raised = await call('POST', '/threads', {
    token: tokens.manager,
    body: { ...base, blocked_item: 'Sample validation', dependency: 'EXTERNAL', external_party: 'FarMart quality lab',
      responsible_user_id: ids.rupendra, expected_resolution: day(5) },
  });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  ids.blocker = raised.body.thread.id;
  assert.equal(raised.body.thread.responsible_name, 'Rupendra Rep');
  const inbox = await call('GET', '/notifications', { token: tokens.rupendra });
  assert.ok(inbox.body.notifications.some((n) => n.type === 'crm_blocker'), 'the person responsible is told');

  // past its date, it is raised as overdue with the person responsible
  await query(`UPDATE discussion_threads SET expected_resolution = $2::date WHERE id = $1`, [ids.blocker, day(-2)]);
  const late = (await nudges()).find((n) => n.kind === 'blocker_overdue');
  assert.ok(late);
  assert.equal(late.owner_user_id, ids.rupendra);
  assert.match(late.detail, /Sample validation is still blocked on FarMart quality lab/);

  // moving the date and the person is recorded in the thread, and the new person is told
  const moved = await call('PATCH', `/threads/${ids.blocker}/blocker`, {
    token: tokens.manager, body: { expected_resolution: day(9), responsible_user_id: ids.saumya, note: 'Lab is short-staffed this week' },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.thread.responsible_user_id, ids.saumya);
  assert.match(moved.body.thread.messages.at(-1).body, /expected to clear by/);
  const saumya = await call('GET', '/notifications', { token: tokens.saumya });
  assert.ok(saumya.body.notifications.some((n) => /responsible for clearing a blocker/.test(n.title)));
  const backwards = await call('PATCH', `/threads/${ids.blocker}/blocker`, { token: tokens.manager, body: { expected_resolution: day(-3) } });
  assert.equal(backwards.status, 400);
  const same = await call('PATCH', `/threads/${ids.blocker}/blocker`, {
    token: tokens.manager, body: { responsible_user_id: ids.saumya, dependency: 'EXTERNAL', note: 'Chased the lab again' },
  });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.thread.messages.at(-1).body, 'Chased the lab again', 'nothing that did not change is said to have changed');
});

// ---------------------------------------------------------------- 11. correspondence

const EML = (from, to, subject, extra = '') => [
  `From: ${from}`,
  `To: ${to}`,
  'Date: Fri, 09 Oct 2026 15:02:00 +0530',
  `Subject: ${subject}`,
  `Message-ID: <${crypto.randomUUID()}@mail.example>`,
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hi Rupendra,=0A=0AWe can do 40 centres if the price holds. Please send the revised rate card.',
  extra,
  '',
  'On Thu, 8 Oct 2026 at 10:00, Rupendra wrote:',
  '> Here is our proposal',
  '--b1--',
].join('\r\n');

test('an email is read for who, when, what — without the quoted history', () => {
  const email = parseEmail(EML('Rajesh Kumar <rajesh@farmart.co>', 'Rupendra <rupendra@ekosight.com>', 'Re: Kit pricing'));
  assert.equal(email.from, 'rajesh@farmart.co');
  assert.deepEqual(email.to, ['rupendra@ekosight.com']);
  assert.equal(email.subject, 'Re: Kit pricing');
  assert.equal(email.date.toISOString(), '2026-10-09T09:32:00.000Z');
  assert.match(email.text, /40 centres/);
  assert.doesNotMatch(email.text, /Here is our proposal/, 'quoted history is cut off');
  assert.equal(freshText('Thanks!\n> old line'), 'Thanks!');
  assert.equal(parseEmail('just some text with no sender'), null);
});

test('a calendar file is read event by event', () => {
  const events = parseCalendar([
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:abc-1', 'SUMMARY:Coromandel review',
    'DTSTART:20261008T050000Z', 'DTEND:20261008T060000Z',
    'ATTENDEE;CN=Asha:mailto:asha@coromandel.example', 'ORGANIZER:mailto:saumya@ekosight.com',
    'DESCRIPTION:Agenda:\\n1. second season', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:abc-2', 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED',
    'DTSTART;TZID=Asia/Kolkata:20261020T100000', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n'));
  assert.equal(events.length, 2);
  assert.equal(events[0].start.toISOString(), '2026-10-08T05:00:00.000Z');
  assert.deepEqual(events[0].attendees.sort(), ['asha@coromandel.example', 'saumya@ekosight.com']);
  assert.match(events[0].description, /1\. second season/);
  assert.equal(events[1].cancelled, true);
  assert.equal(events[1].start.toISOString(), '2026-10-20T04:30:00.000Z', 'a local time is read as India time');
});

test('an imported email from a known contact is suggested, confirmed once, and counts as hearing from them', async (t) => {
  if (skip(t)) return;
  const raw = EML('Rajesh Kumar <rajesh@farmart.co>', 'rupendra@ekosight.com', 'Re: Kit pricing');
  const imported = await call('POST', '/crm/import/email', { token: tokens.rupendra, body: { raw } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const suggestion = imported.body.suggestion;
  assert.equal(suggestion.account_id, ids.farmart);
  assert.equal(suggestion.contact_id, ids.rajesh);
  assert.equal(suggestion.direction, 'INBOUND');
  assert.equal(imported.body.matched_by, 'contact');

  const twice = await call('POST', '/crm/import/email', { token: tokens.rupendra, body: { raw } });
  assert.equal(twice.body.skipped, 'already_suggested');

  // somebody else cannot act on it
  const notTheirs = await call('POST', `/crm/suggestions/${suggestion.id}/confirm`, { token: tokens.saumya, body: {} });
  assert.equal(notTheirs.status, 403);

  // nothing is on the timeline until it is confirmed
  let account = await call('GET', `/accounts/${ids.farmart}`, { token: tokens.manager });
  assert.ok(!account.body.activities.some((a) => a.subject === 'Re: Kit pricing'));

  const confirmed = await call('POST', `/crm/suggestions/${suggestion.id}/confirm`, {
    token: tokens.rupendra,
    body: { next_step: 'Send the revised rate card', next_step_due: day(2), next_step_owner_id: ids.rupendra },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  account = await call('GET', `/accounts/${ids.farmart}`, { token: tokens.manager });
  const entry = account.body.activities.find((a) => a.subject === 'Re: Kit pricing');
  assert.equal(entry.source, 'EMAIL_IMPORT');
  assert.equal(entry.direction, 'INBOUND');
  assert.equal(new Date(entry.occurred_at).toISOString(), '2026-10-09T09:32:00.000Z', 'dated when it was sent, not when imported');
  const deal = await call('GET', `/opportunities/${ids.farmartDeal}`, { token: tokens.manager });
  assert.ok(deal.body.opportunity.last_customer_at, 'it counts as the customer responding');
  assert.equal(deal.body.opportunity.next_step, 'Send the revised rate card');

  // importing it again, even as someone else, cannot log it twice
  const later = await call('POST', '/crm/import/email', { token: tokens.saumya, body: { raw } });
  assert.equal(later.body.skipped, 'already_logged');
});

test('a webmail sender is never matched by domain, and an internal email is not correspondence', async (t) => {
  if (skip(t)) return;
  const webmail = await call('POST', '/crm/import/email', {
    token: tokens.rupendra, body: { raw: EML('Someone <someone@gmail.com>', 'rupendra@ekosight.com', 'Hello') },
  });
  assert.equal(webmail.status, 201);
  assert.equal(webmail.body.suggestion.account_id, null, 'gmail.com says nothing about which organization');
  const unpicked = await call('POST', `/crm/suggestions/${webmail.body.suggestion.id}/confirm`, { token: tokens.rupendra, body: {} });
  assert.equal(unpicked.status, 400);
  const picked = await call('POST', `/crm/suggestions/${webmail.body.suggestion.id}/confirm`, {
    token: tokens.rupendra, body: { account_id: ids.farmart },
  });
  assert.equal(picked.status, 200);

  const internal = await call('POST', '/crm/import/email', {
    token: tokens.rupendra, body: { raw: EML('saumya@ekosight.com', 'rupendra@ekosight.com', 'Lunch?') },
  });
  assert.equal(internal.status, 400);

  // a company domain matches the organization even from a new person there
  const colleague = await call('POST', '/crm/import/email', {
    token: tokens.rupendra, body: { raw: EML('Neha <neha@farmart.co>', 'rupendra@ekosight.com', 'Accounts query') },
  });
  assert.equal(colleague.body.suggestion.account_id, ids.farmart);
  assert.equal(colleague.body.matched_by, 'domain');
  const dismissed = await call('POST', `/crm/suggestions/${colleague.body.suggestion.id}/dismiss`, { token: tokens.rupendra });
  assert.equal(dismissed.status, 200);
  const pending = await call('GET', '/crm/suggestions', { token: tokens.rupendra });
  assert.ok(!pending.body.suggestions.some((s) => s.id === colleague.body.suggestion.id));
});

test('a past calendar event is logged only if it took place; a future one is booked', async (t) => {
  if (skip(t)) return;
  const stamp = (offset) => new Date(Date.now() + offset * 86400000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:past-1', 'SUMMARY:FarMart rate card call', `DTSTART:${stamp(-1)}`, `DTEND:${stamp(-0.97)}`,
    'ATTENDEE:mailto:rajesh@farmart.co', 'ORGANIZER:mailto:rupendra@ekosight.com', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:future-1', 'SUMMARY:FarMart site visit', `DTSTART:${stamp(4)}`, `DTEND:${stamp(4.05)}`,
    'ATTENDEE:mailto:rajesh@farmart.co', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:internal-1', 'SUMMARY:Team sync', `DTSTART:${stamp(1)}`,
    'ATTENDEE:mailto:saumya@ekosight.com', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const imported = await call('POST', '/crm/import/calendar', { token: tokens.rupendra, body: { raw: ics } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.suggested, 2);
  assert.equal(imported.body.internal, 1);

  const { body } = await call('GET', '/crm/suggestions', { token: tokens.rupendra });
  const past = body.suggestions.find((s) => s.subject === 'FarMart rate card call');
  const future = body.suggestions.find((s) => s.subject === 'FarMart site visit');

  const unsaid = await call('POST', `/crm/suggestions/${past.id}/confirm`, { token: tokens.rupendra, body: {} });
  assert.equal(unsaid.status, 400);
  assert.equal(unsaid.body.details.code, 'MEETING_OUTCOME_REQUIRED');
  const held = await call('POST', `/crm/suggestions/${past.id}/confirm`, {
    token: tokens.rupendra, body: { took_place: true, outcome: 'Agreed the rate card; they want 40 centres' },
  });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const meeting = await call('GET', `/meetings/${held.body.meeting_id}`, { token: tokens.rupendra });
  assert.equal(meeting.body.meeting.status, 'COMPLETED');

  const booked = await call('POST', `/crm/suggestions/${future.id}/confirm`, { token: tokens.rupendra, body: {} });
  assert.equal(booked.status, 200);
  const upcoming = await call('GET', `/meetings/${booked.body.meeting_id}`, { token: tokens.rupendra });
  assert.equal(upcoming.body.meeting.status, 'SCHEDULED', 'a calendar entry is not proof it happened');
});

test('Gmail and Calendar are read only for people who switch it on, and only for known organizations', async (t) => {
  if (skip(t)) return;
  const off = await call('PUT', '/crm/mailbox-sync', { token: tokens.saumya, body: { gmail_enabled: true } });
  assert.equal(off.status, 400, 'not until an admin turns it on');

  setChatConfig({ clientEmail: 'taskflow@demo.iam.gserviceaccount.com', privateKey: serviceKey, projectId: 'demo' });
  await updateSetting('crm', { mailboxSync: { enabled: true, lookbackDays: 3 } }, ids.manager);
  const requests = [];
  setGoogleFetch(async (url, init = {}) => {
    requests.push(String(url));
    const json = (data) => ({ ok: true, status: 200, json: async () => data });
    if (String(url).includes('oauth2')) {
      const assertion = new URLSearchParams(init.body).get('assertion');
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
      assert.equal(claims.sub, 'saumya@ekosight.com', 'it reads as the person who switched it on');
      return json({ access_token: `token-for-${claims.scope.split('/').pop()}`, expires_in: 3600 });
    }
    if (String(url).includes('/messages?')) return json({ messages: [{ id: 'm1' }, { id: 'm2' }] });
    if (String(url).includes('/messages/m1')) {
      return json({ id: 'm1', internalDate: String(Date.now() - 3600000), snippet: 'Can you confirm the volumes &amp; dates?',
        payload: { headers: [
          { name: 'From', value: 'Asha <asha@coromandel.example>' }, { name: 'To', value: 'saumya@ekosight.com' },
          { name: 'Subject', value: 'Second season volumes' }, { name: 'Message-ID', value: '<m1@coromandel.example>' },
        ] } });
    }
    if (String(url).includes('/messages/m2')) {
      return json({ id: 'm2', internalDate: String(Date.now()), snippet: 'Your order has shipped',
        payload: { headers: [{ name: 'From', value: 'shop@retailer.example' }, { name: 'To', value: 'saumya@ekosight.com' },
          { name: 'Subject', value: 'Personal order' }] } });
    }
    if (String(url).includes('/calendars/primary/events')) return json({ items: [] });
    throw new Error(`unexpected ${url}`);
  });

  // Asha is a contact at Coromandel
  await call('POST', `/accounts/${ids.coromandel}/contacts`, {
    token: tokens.manager, body: { full_name: 'Asha Menon', email: 'asha@coromandel.example' },
  });
  const on = await call('PUT', '/crm/mailbox-sync', { token: tokens.saumya, body: { gmail_enabled: true, calendar_enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const run = await call('POST', '/crm/mailbox-sync/run', { token: tokens.saumya });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.result.emails, 1);
  assert.equal(run.body.suggestions.length, 1, 'only correspondence with a known organization');
  assert.equal(run.body.suggestions[0].subject, 'Second season volumes');
  assert.equal(run.body.suggestions[0].snippet, 'Can you confirm the volumes & dates?');
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM crm_suggestions WHERE subject = 'Personal order'`);
  assert.equal(rows[0].n, 0, 'personal mail is never stored');
  assert.ok(requests.some((u) => u.includes('newer_than%3A3d')));
  const status = await call('GET', '/crm/mailbox-sync', { token: tokens.saumya });
  assert.ok(status.body.mine.last_synced_at);
  const calls = requests.length;
  const hammered = await call('POST', '/crm/mailbox-sync/run', { token: tokens.saumya });
  assert.equal(hammered.status, 400, 'checking again within a minute is refused');
  assert.equal(requests.length, calls, 'and Google is not called');
});

// ---------------------------------------------------------------- 12. the weekly review

test('an owner reviews outcomes per deal, with activity counted apart, and asks for help', async (t) => {
  if (skip(t)) return;
  const mine = await call('GET', '/crm/reviews/mine', { token: tokens.rupendra });
  assert.equal(mine.status, 200);
  const deal = mine.body.deals.find((d) => d.id === ids.farmartDeal);
  assert.ok(deal, 'the deals they owe the next move on are in their review');
  assert.ok(deal.outcomes.some((o) => o.kind === 'commitment'), 'what the record shows moved');
  assert.equal(typeof deal.activity, 'object', 'and, apart, what was logged');

  const early = await call('POST', '/crm/reviews/mine/submit', { token: tokens.rupendra, body: {} });
  assert.equal(early.status, 400);
  assert.equal(early.body.details.code, 'REVIEW_INCOMPLETE');

  const saved = await call('PUT', `/crm/reviews/mine/items/${ids.farmartDeal}`, {
    token: tokens.rupendra,
    body: {
      what_changed: 'Samples arrived; lab validation started', evidence_url: 'https://drive.example/samples',
      next_milestone: 'Validation report', next_milestone_due: day(7),
      help_needed: 'Need pricing approval for 40 centres', help_from_user_id: ids.manager,
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const notMine = await call('PUT', `/crm/reviews/mine/items/${ids.coromandelDeal}`, {
    token: tokens.rupendra, body: { no_change: true },
  });
  assert.equal(notMine.status, 400);

  // any other live deal of theirs needs an answer too
  const rest = (await call('GET', '/crm/reviews/mine', { token: tokens.rupendra })).body.deals
    .filter((d) => d.id !== ids.farmartDeal && ['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(d.status));
  for (const other of rest) {
    await call('PUT', `/crm/reviews/mine/items/${other.id}`, {
      token: tokens.rupendra, body: { no_change: true, next_milestone: 'Follow up', next_milestone_due: day(5) },
    });
  }
  const sent = await call('POST', '/crm/reviews/mine/submit', { token: tokens.rupendra, body: { summary: 'Good week' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.review.status, 'SUBMITTED');
  const help = await call('GET', '/notifications', { token: tokens.manager });
  assert.ok(help.body.notifications.some((n) => n.type === 'crm_help' && /pricing approval/.test(n.body)));

  const locked = await call('PUT', `/crm/reviews/mine/items/${ids.farmartDeal}`, { token: tokens.rupendra, body: { no_change: true } });
  assert.equal(locked.status, 400, 'a sent review is not rewritten');

  const team = await call('GET', '/crm/reviews/team', { token: tokens.manager });
  assert.equal(team.status, 200);
  assert.ok(team.body.sent >= 1);
  assert.ok(team.body.help_requested.some((h) => /pricing approval/.test(h.help)));
  assert.equal((await call('GET', '/crm/reviews/team', { token: tokens.saumya })).status, 403);

  // a review not yet sent stays its owner's: the team sees the record, not the draft
  const own = (await call('GET', '/crm/reviews/mine', { token: tokens.manager })).body.deals[0];
  const draft = await call('PUT', `/crm/reviews/mine/items/${own.id}`, {
    token: tokens.manager, body: { what_changed: 'Words still being drafted', next_milestone: 'Call', next_milestone_due: day(3) },
  });
  assert.equal(draft.status, 200);
  const seen = (await call('GET', '/crm/reviews/team', { token: tokens.manager })).body.reviews
    .find((r) => r.user.id === ids.manager);
  assert.equal(seen.review.status, 'DRAFT');
  assert.ok(seen.deals.every((d) => d.item === null), 'no unsent words are shown to anyone else');
  assert.ok(seen.deals.some((d) => d.outcomes.length > 0 || d.id === own.id), 'the record still is');
});

// ---------------------------------------------------------------- 8. the week, on the record

test('the week lists what moved, what was promised, sold, billed and collected, what slipped and what needs deciding', async (t) => {
  if (skip(t)) return;
  const { deal } = await lead({ name: 'Weekly Agro' });
  // a proposal, a stage move, an order and a payment this week
  const moved = await call('POST', `/opportunities/${deal.id}/stage`, {
    token: tokens.manager,
    body: { stage_id: ids.stage_proposal, proposal: { sent_on: day(0), amount: 500000 },
      next_step: 'Chase the decision', next_step_owner_id: ids.manager, next_step_due: day(2) },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  await call('POST', `/opportunities/${deal.id}/orders`, { token: tokens.manager, body: { reference: 'WA/PO/1', received_on: day(0), amount: 480000 } });
  await call('POST', `/opportunities/${deal.id}/payments`, { token: tokens.manager, body: { received_on: day(0), amount: 100000 } });
  // a deal task due this week, not done
  await call('POST', '/tasks', { token: tokens.manager, body: {
    title: 'Send validation data', department_id: ids.department, assignee_id: ids.manager,
    due_date: new Date(Date.now() - 3600000).toISOString(), opportunity_id: deal.id,
  } }).catch(() => {});

  const week = await call('GET', `/crm/week?start=${day(0)}`, { token: tokens.manager });
  assert.equal(week.status, 200);
  assert.equal(week.body.stored, false, 'the week in progress is worked out live');
  assert.ok(week.body.stage_changes.some((c) => c.opportunity_id === deal.id && c.to_value === 'Proposal'));
  assert.ok(week.body.proposals.some((p) => p.opportunity_id === deal.id && p.amount === 500000));
  assert.ok(week.body.orders.some((o) => o.opportunity_id === deal.id));
  assert.ok(week.body.payments.some((p) => p.opportunity_id === deal.id && p.amount === 100000));
  assert.ok(week.body.summary.booked >= 480000);
  assert.ok(week.body.commitments.made.some((c) => c.what === 'Send 12 soil samples'));
  assert.ok(week.body.commitments.kept.some((c) => c.what === 'Send 12 soil samples'));
  assert.ok(week.body.decisions.blockers.some((b) => b.id === ids.blocker));
  assert.ok(week.body.decisions.help_requested.some((h) => /pricing approval/.test(h.help_needed)));
  assert.ok(week.body.activity_counts, 'activity is counted apart from outcomes');
  assert.ok(week.body.activity_counts.CALL?.logged >= 1);
  for (const ledger of ['ORDER', 'PAYMENT', 'INVOICE', 'STAGE_CHANGE']) {
    assert.equal(week.body.activity_counts[ledger], undefined, `${ledger} is an outcome or bookkeeping, not effort`);
  }
  const { rows: ledgerProposals } = await query(
    `SELECT COUNT(*)::int AS n FROM account_activities WHERE type = 'PROPOSAL' AND meta ? 'proposal_id'`,
  );
  assert.ok(ledgerProposals[0].n >= 1);
  assert.equal(week.body.activity_counts.PROPOSAL, undefined, 'a proposal on the ledger is counted once, as a proposal');
  assert.ok(week.body.definitions.payments);
});

test('a finished week is written down once, and never rewritten', async (t) => {
  if (skip(t)) return;
  const current = await call('POST', '/crm/weeks/snapshot', { token: tokens.manager, body: { start: day(0) } });
  assert.equal(current.status, 400, 'a week still running is not frozen');

  // put something in last week
  const last = previousWeek(day(0));
  const { deal } = await lead({ name: 'Last Week Ltd' });
  await query(
    `INSERT INTO opportunity_history (opportunity_id, field, from_value, to_value, actor_id, created_at)
     VALUES ($1, 'stage', 'New', 'Contacted', $2, $3)`,
    [deal.id, ids.manager, `${last.start}T11:00:00+05:30`],
  );
  const stored = await call('POST', '/crm/weeks/snapshot', { token: tokens.manager, body: { start: last.start } });
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.equal(stored.body.stored, true);
  assert.ok(stored.body.week.stage_changes.some((c) => c.opportunity_id === deal.id));

  // later changes to last week do not rewrite the record
  await query(
    `INSERT INTO opportunity_history (opportunity_id, field, from_value, to_value, actor_id, created_at)
     VALUES ($1, 'stage', 'Contacted', 'Qualified', $2, $3)`,
    [deal.id, ids.manager, `${last.start}T12:00:00+05:30`],
  );
  const again = await call('POST', '/crm/weeks/snapshot', { token: tokens.manager, body: { start: last.start } });
  assert.equal(again.body.stored, false);
  const read = await call('GET', `/crm/week?start=${last.start}`, { token: tokens.manager });
  assert.equal(read.body.stored, true);
  assert.equal(read.body.stage_changes.filter((c) => c.opportunity_id === deal.id).length, 1, 'what was known at the time');
  const weeks = await call('GET', '/crm/weeks', { token: tokens.manager });
  assert.ok(weeks.body.weeks.some((w) => String(w.week_start).slice(0, 10) === last.start));
  assert.equal((await call('POST', '/crm/weeks/snapshot', { token: tokens.rupendra, body: { start: last.start } })).status, 403);
});

test('the weekly job records the week and chases reviews, each once', async (t) => {
  if (skip(t)) return;
  // a Monday morning after the snapshot time
  const monday = new Date(`${weekOf(day(0)).start}T04:00:00Z`);
  const first = await runPipelineWeekly({ now: monday });
  assert.ok(first.snapshot);
  const notices = async () => (await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'crm_weekly' AND title LIKE 'The pipeline week%'`,
    [ids.manager],
  )).rows[0].n;
  const once = await notices();
  assert.equal(once, 1, 'the manager is told the week is on the record');
  await runPipelineWeekly({ now: monday });
  assert.equal(await notices(), once, 'and told once');

  // a Friday afternoon: owners who have not sent this week's review
  const friday = new Date(`${weekOf(day(0)).start}T10:30:00Z`);
  friday.setUTCDate(friday.getUTCDate() + 4);
  const chase = await runPipelineWeekly({ now: friday });
  assert.ok(chase.reminded.includes(ids.saumya) || chase.reminded.includes(ids.manager));
  assert.ok(!chase.reminded.includes(ids.rupendra), 'nobody who has sent theirs');
  const repeat = await runPipelineWeekly({ now: friday });
  assert.equal(repeat.reminded.length, 0, 'reminded once');
});
