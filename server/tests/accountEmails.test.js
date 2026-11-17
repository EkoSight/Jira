/**
 * Account emails (docs/ACCOUNT_EMAILS.md), against the outbox stand-in: no
 * real email is sent, and every person here is made up (example.com).
 *
 *   1  a new account with the box ticked: one WELCOME email, its password signs
 *      in, the answer and the record carry no password
 *   2  the box unticked, or email not set up: the password on screen, as before
 *   3  the provider fails: the password on screen with the reason; FAILED
 *   4  a password the administrator typed is never emailed
 *   5  an administrator's reset: emailed, old password and sessions end, the
 *      rules on whose password may be reset are unchanged
 *   6  expiry, and accounts from before this release keep working
 *   7  one use, and "your password was changed"
 *   8  "Resend sign-in details" replaces the earlier password
 *   9  "Forgot password?": the same answer, no lock-out, limits, nobody it
 *      should not reach, the switch
 *  10  the failed sign-in limit
 *  11  no password anywhere but the one email
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword, generateSignInPassword } from '../src/lib/password.js';
import { resetLimits } from '../src/lib/limits.js';
import { updateSetting } from '../src/services/settings.js';
import { outbox, clearOutbox, failNextSends } from '../src/services/marketing/providers.js';
import { forgotPasswordWork } from '../src/services/accountEmail.js';
import { recordEvent } from '../src/services/marketing/events.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};
const issued = []; // every password TaskFlow issued in this file, for test 11

// everything the server writes to the console while these tests run
const logged = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); original.apply(console, args); };
}

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const login = (email, password) => call('POST', '/auth/login', { body: { email, password } });
const accountMail = (to) => outbox().filter((m) => String(m.reference || '').startsWith('acct-') && (!to || m.to === to));
// the temporary password sits on its own line, indented, in the plain text
const passwordIn = (message) => { const p = message.text.match(/^ {4}(\S+)$/m)?.[1] || null; if (p) issued.push(p); return p; };
const SENDER = { senderName: 'TaskFlow', senderEmail: 'accounts@example.com', replyTo: '', expiryHours: 24, forgotPassword: true };
const setEmail = (patch = {}) => updateSetting('accountEmails', { ...SENDER, ...patch }, ids.admin);
const rowsFor = async (userId) => (await query('SELECT * FROM account_emails WHERE user_id = $1 ORDER BY id', [userId])).rows;
let counter = 0;
const newPerson = async (extra = {}, token = tokens.admin) => {
  counter += 1;
  const email = `joiner${counter}@example.com`;
  const res = await call('POST', '/users', { token, body: { full_name: `Joiner${counter} Sample`, email, role: 'member', ...extra } });
  return { res, email };
};

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  const password = await hashPassword('Password123!');
  for (const [key, name, role] of [
    ['founder', 'Founder Sample', 'super_admin'], ['admin', 'Admin Sample', 'admin'],
    ['manager', 'Manager Sample', 'manager'], ['member', 'Member Sample', 'member'], ['gone', 'Gone Sample', 'member'],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, must_change_password, is_active) VALUES ($1,$2,$3,$4,FALSE,$5) RETURNING id`,
      [name, `${key}@example.com`, password, role, key !== 'gone'],
    );
    ids[key] = rows[0].id;
  }
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['founder', 'admin', 'manager', 'member']) tokens[key] = ok(await login(`${key}@example.com`, 'Password123!')).token;
  await setEmail();
});

beforeEach(() => { clearOutbox(); resetLimits(); });

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('temporary passwords: 14 characters, no look-alikes, all different', () => {
  const many = Array.from({ length: 200 }, () => generateSignInPassword());
  assert.equal(new Set(many).size, 200);
  for (const p of many) {
    assert.equal(p.length, 14);
    assert.doesNotMatch(p, /[0O1lI]/);
    assert.match(p, /^[A-Za-z2-9]+$/);
  }
});

test('1 a new account with the box ticked: one welcome email, and its password signs in', async (t) => {
  if (skip(t)) return;
  const { res, email } = await newPerson({ email_details: true });
  const body = ok(res, 201);
  assert.equal(body.temporary_password, undefined, 'the password is not on screen once emailed');
  assert.deepEqual({ sent: body.email.sent, status: body.email.status, to: body.email.to }, { sent: true, status: 'SENT', to: email });
  assert.ok(body.temporary_password_expires_at, 'when it stops working is known');

  const mail = accountMail(email);
  assert.equal(mail.length, 1, 'exactly one email');
  assert.equal(mail[0].subject, 'Your TaskFlow account is ready');
  assert.equal(mail[0].from, 'accounts@example.com');
  assert.ok(!mail[0].subject.includes(passwordIn(mail[0])), 'no secret in the subject');
  const password = passwordIn(mail[0]);
  assert.equal(password.length, 14);
  assert.match(mail[0].text, new RegExp(`Sign in: ${config.publicUrl}/login`));
  assert.match(mail[0].text, /Admin Sample created your account/);
  assert.match(mail[0].text, /It works until .*India time/);
  assert.match(mail[0].text, /choose your own password/);
  assert.ok(mail[0].html.includes(password) && mail[0].html.includes('Sign in to TaskFlow'), 'the HTML says the same');
  assert.doesNotMatch(mail[0].html + mail[0].text, /unsubscribe/i, 'not a marketing email');

  const signedIn = ok(await login(email, password));
  assert.equal(signedIn.user.must_change_password, true, 'they are made to choose their own');

  const rows = await rowsFor(body.user.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.status, r.to_address, r.triggered_by]), [['WELCOME', 'SENT', email, ids.admin]]);
  assert.ok(!JSON.stringify(rows).includes(password), 'the record holds no password');
  assert.ok(!JSON.stringify(body).includes(password), 'the answer holds no password');

  // marketing never sees it: not in its outbox list, and its delivery reports are ignored
  const marketingOutbox = ok(await call('GET', '/marketing/dev/outbox', { token: tokens.admin }));
  assert.ok(marketingOutbox.messages.every((m) => !String(m.reference || '').startsWith('acct-')));
  const before = (await query('SELECT COUNT(*)::int AS n FROM mkt_events')).rows[0].n;
  const ignored = await recordEvent({ type: 'BOUNCE_HARD', reference: mail[0].reference, email, source: 'test' });
  assert.equal(ignored.system, true);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM mkt_events')).rows[0].n, before);
});

test('2 the box unticked, or email not set up: the password on screen, as before', async (t) => {
  if (skip(t)) return;
  const plain = await newPerson();
  const body = ok(plain.res, 201);
  assert.ok(body.temporary_password, 'shown once, as today');
  issued.push(body.temporary_password);
  assert.equal(body.email, undefined);
  assert.equal(accountMail(plain.email).length, 0);
  assert.equal((await rowsFor(body.user.id)).length, 0);
  ok(await login(plain.email, body.temporary_password));

  await setEmail({ senderEmail: '' });
  try {
    const status = ok(await call('GET', '/users/account-email-status', { token: tokens.admin }));
    assert.equal(status.ready, false);
    assert.match(status.reason, /sender address/);
    const notSetUp = await newPerson({ email_details: true });
    const b = ok(notSetUp.res, 201);
    assert.ok(b.temporary_password, 'falls back to showing it');
    issued.push(b.temporary_password);
    assert.equal(b.email.sent, false);
    assert.equal(b.email.status, 'NOT_SET_UP');
    assert.match(b.email.reason, /sender address/);
    assert.equal(accountMail(notSetUp.email).length, 0, 'never claims an email went');
    assert.deepEqual((await rowsFor(b.user.id)).map((r) => r.status), ['NOT_SET_UP']);
  } finally {
    await setEmail();
  }
  // a member may not ask
  assert.equal((await call('GET', '/users/account-email-status', { token: tokens.member })).status, 403);
});

test('3 the provider fails: the password on screen with the reason, recorded as FAILED', async (t) => {
  if (skip(t)) return;
  failNextSends([{ message: 'Mailbox unavailable', transient: false }]);
  const { res, email } = await newPerson({ email_details: true });
  const body = ok(res, 201);
  assert.ok(body.temporary_password);
  issued.push(body.temporary_password);
  assert.deepEqual([body.email.sent, body.email.status, body.email.reason], [false, 'FAILED', 'Mailbox unavailable']);
  assert.equal(accountMail(email).length, 0);
  assert.deepEqual((await rowsFor(body.user.id)).map((r) => [r.status, r.error]), [['FAILED', 'Mailbox unavailable']]);
  ok(await login(email, body.temporary_password));
});

test('4 a password the administrator typed is never emailed', async (t) => {
  if (skip(t)) return;
  const typed = 'TypedByAdmin-123';
  const { res, email } = await newPerson({ email_details: true, password: typed });
  const body = ok(res, 201);
  assert.equal(body.temporary_password, undefined);
  assert.equal(body.email.sent, true);
  const [mail] = accountMail(email);
  assert.ok(!mail.text.includes(typed) && !mail.html.includes(typed), 'the typed password is not in the email');
  assert.match(mail.text, /Admin Sample will give you your password/);
  assert.equal(passwordIn(mail), null, 'no password block at all');
  ok(await login(email, typed));
});

test('5 an administrator\'s reset: emailed; the old password and every session end; the rules are unchanged', async (t) => {
  if (skip(t)) return;
  const oldToken = tokens.member;
  const res = ok(await call('POST', `/users/${ids.member}/reset-password`, { token: tokens.admin, body: { email_details: true } }));
  assert.equal(res.temporary_password, undefined);
  assert.equal(res.email.sent, true);
  const [mail] = accountMail('member@example.com');
  assert.equal(mail.subject, 'Your TaskFlow password was reset');
  assert.match(mail.text, /Admin Sample reset it on /);
  const password = passwordIn(mail);
  assert.equal((await login('member@example.com', 'Password123!')).status, 401, 'the old password no longer works');
  assert.equal((await call('GET', '/auth/me', { token: oldToken })).status, 401, 'signed out everywhere');
  const fresh = ok(await login('member@example.com', password));
  assert.equal(fresh.user.must_change_password, true);
  ok(await call('POST', '/auth/change-password', { token: fresh.token, body: { currentPassword: password, newPassword: 'Password123!x' } }));
  tokens.member = ok(await login('member@example.com', 'Password123!x')).token;

  // whose password may be reset: unchanged
  assert.equal((await call('POST', `/users/${ids.founder}/reset-password`, { token: tokens.admin, body: { email_details: true } })).status, 403);
  assert.equal((await call('POST', `/users/${ids.admin}/reset-password`, { token: tokens.manager, body: { email_details: true } })).status, 403);
  assert.equal((await call('POST', `/users/${ids.manager}/reset-password`, { token: tokens.member })).status, 403);
  assert.equal(accountMail('founder@example.com').length + accountMail('admin@example.com').length, 0, 'nothing sent when refused');

  // without the box: the password on screen, as before
  const shown = ok(await call('POST', `/users/${ids.manager}/reset-password`, { token: tokens.admin }));
  assert.ok(shown.temporary_password);
  issued.push(shown.temporary_password);
  assert.equal(accountMail('manager@example.com').length, 0);
  const m = ok(await login('manager@example.com', shown.temporary_password));
  ok(await call('POST', '/auth/change-password', { token: m.token, body: { currentPassword: shown.temporary_password, newPassword: 'Password123!' } }));
  tokens.manager = ok(await login('manager@example.com', 'Password123!')).token;
});

test('6 an expired temporary password is refused; one from before this release still works', async (t) => {
  if (skip(t)) return;
  const { res, email } = await newPerson();
  const body = ok(res, 201);
  issued.push(body.temporary_password);
  await query(`UPDATE users SET temp_password_expires_at = now() - interval '1 minute' WHERE id = $1`, [body.user.id]);
  const refused = await login(email, body.temporary_password);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, 'This temporary password has expired. Ask your administrator to send a new one.');
  // a wrong password still gets the usual answer, not the expiry message
  assert.equal((await login(email, 'wrong-guess')).body.error, 'Email or password is incorrect');

  // an account from before this release: a temporary password with no expiry
  await query(
    `INSERT INTO users (full_name, email, password_hash, role, must_change_password) VALUES ('Older Sample', 'older@example.com', $1, 'member', TRUE)`,
    [await hashPassword('OldTemp-1234')],
  );
  const older = ok(await login('older@example.com', 'OldTemp-1234'));
  assert.equal(older.user.must_change_password, true, 'it works as before');
});

test('7 one use: choosing their own password ends the temporary one, and "your password was changed" goes out', async (t) => {
  if (skip(t)) return;
  const { res, email } = await newPerson({ email_details: true });
  const body = ok(res, 201);
  const temp = passwordIn(accountMail(email)[0]);
  const s = ok(await login(email, temp));
  clearOutbox();
  ok(await call('POST', '/auth/change-password', { token: s.token, body: { currentPassword: temp, newPassword: 'MyOwnPassword-9' } }));
  assert.equal((await login(email, temp)).status, 401, 'the emailed one no longer works');
  ok(await login(email, 'MyOwnPassword-9'));
  const { rows: [u] } = await query('SELECT must_change_password, temp_password_expires_at FROM users WHERE id = $1', [body.user.id]);
  assert.deepEqual([u.must_change_password, u.temp_password_expires_at], [false, null]);
  const [changed] = accountMail(email);
  assert.equal(changed.subject, 'Your TaskFlow password was changed');
  assert.match(changed.text, /If this wasn't you, tell your administrator now/);
  assert.ok(!changed.text.includes('MyOwnPassword-9') && !changed.text.includes(temp), 'no password in it');
  assert.equal(passwordIn(changed), null);
  assert.deepEqual((await rowsFor(body.user.id)).map((r) => r.kind), ['WELCOME', 'PASSWORD_CHANGED']);
  // the same temporary password cannot be reused as the new one
  const again = await newPerson({ email_details: true });
  const t2 = passwordIn(accountMail(again.email)[0]);
  const s2 = ok(await login(again.email, t2));
  assert.equal((await call('POST', '/auth/change-password', { token: s2.token, body: { currentPassword: t2, newPassword: t2 } })).status, 400);
});

test('8 "Resend sign-in details" replaces the earlier password', async (t) => {
  if (skip(t)) return;
  const { res, email } = await newPerson({ email_details: true });
  const body = ok(res, 201);
  const first = passwordIn(accountMail(email)[0]);
  clearOutbox();
  const resent = ok(await call('POST', `/users/${body.user.id}/resend-sign-in`, { token: tokens.admin }));
  assert.equal(resent.temporary_password, undefined);
  assert.equal(resent.email.sent, true);
  const [mail] = accountMail(email);
  assert.match(mail.text, /replace the ones sent to you earlier/);
  const second = passwordIn(mail);
  assert.notEqual(second, first);
  assert.equal((await login(email, first)).status, 401, 'the earlier one stopped working');
  const s = ok(await login(email, second));

  // email not set up: refused, and nothing changes
  await setEmail({ senderEmail: '' });
  try {
    const refused = await call('POST', `/users/${body.user.id}/resend-sign-in`, { token: tokens.admin });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Email is not set up/);
    ok(await login(email, second));
  } finally { await setEmail(); }

  // once they have chosen their own: Reset password instead
  ok(await call('POST', '/auth/change-password', { token: s.token, body: { currentPassword: second, newPassword: 'Chosen-Password-1' } }));
  const done = await call('POST', `/users/${body.user.id}/resend-sign-in`, { token: tokens.admin });
  assert.equal(done.status, 400);
  assert.match(done.body.error, /Use Reset password/);
  // the history, with who sent each, never a password
  const history = ok(await call('GET', `/users/${body.user.id}/account-emails`, { token: tokens.admin })).emails;
  assert.deepEqual(history.map((e) => e.kind), ['PASSWORD_CHANGED', 'WELCOME', 'WELCOME']);
  assert.equal(history[1].triggered_by_name, 'Admin Sample');
  assert.ok(!JSON.stringify(history).includes(first) && !JSON.stringify(history).includes(second));
  assert.equal((await call('GET', `/users/${body.user.id}/account-emails`, { token: tokens.member })).status, 403);
});

test('9 "Forgot password?": the same answer for anyone, no lock-out, limits, and the switch', async (t) => {
  if (skip(t)) return;
  assert.equal(ok(await call('GET', '/auth/options')).forgot_password, true);
  const memberToken = tokens.member;
  const known = ok(await call('POST', '/auth/forgot-password', { body: { email: 'Member@Example.com' } }));
  const unknown = ok(await call('POST', '/auth/forgot-password', { body: { email: 'nobody-here@example.com' } }));
  assert.deepEqual(known, unknown, 'the same answer whether or not the account exists');
  await forgotPasswordWork();
  assert.equal(accountMail('nobody-here@example.com').length, 0);
  const [mail] = accountMail('member@example.com');
  assert.equal(mail.subject, 'Reset your TaskFlow password');
  assert.match(mail.text, /Your current password keeps working too/);
  const temp = passwordIn(mail);

  // no lock-out: the current password still works, and so does the session
  ok(await login('member@example.com', 'Password123!x'));
  ok(await call('GET', '/auth/me', { token: memberToken }));

  // using it: a new password is required, every other session ends
  const s = ok(await login('member@example.com', temp));
  assert.equal(s.user.must_change_password, true);
  assert.equal((await call('GET', '/auth/me', { token: memberToken })).status, 401, 'other sessions signed out');
  assert.equal((await login('member@example.com', 'Password123!x')).status, 401, 'it replaced the old password');
  ok(await call('POST', '/auth/change-password', { token: s.token, body: { currentPassword: temp, newPassword: 'Password123!x' } }));
  tokens.member = ok(await login('member@example.com', 'Password123!x')).token;
  const audits = (await query(`SELECT action FROM attendance_audit WHERE entity_type = 'USER_ACCESS' AND subject_user_id = $1 ORDER BY id`, [ids.member])).rows.map((r) => r.action);
  assert.ok(audits.includes('PASSWORD_RESET_REQUESTED') && audits.includes('SIGNED_IN_WITH_RESET'));

  // only the newest request works; a password change ends the rest
  resetLimits();
  clearOutbox();
  ok(await call('POST', '/auth/forgot-password', { body: { email: 'member@example.com' } }));
  ok(await call('POST', '/auth/forgot-password', { body: { email: 'member@example.com' } }));
  await forgotPasswordWork();
  const [older, newer] = accountMail('member@example.com').map(passwordIn);
  assert.equal((await login('member@example.com', older)).status, 401, 'the older request was replaced');

  // limits: 3 per address an hour; beyond that the same answer and nothing sent
  ok(await call('POST', '/auth/forgot-password', { body: { email: 'member@example.com' } }));
  const fourth = ok(await call('POST', '/auth/forgot-password', { body: { email: 'member@example.com' } }));
  assert.deepEqual(fourth, known);
  await forgotPasswordWork();
  assert.equal(accountMail('member@example.com').length, 3, 'the fourth sent nothing');
  assert.equal((await login('member@example.com', newer)).status, 401, 'the third replaced the second');
  resetLimits();

  // nobody it should not reach: a deactivated account, a super admin
  clearOutbox();
  ok(await call('POST', '/auth/forgot-password', { body: { email: 'gone@example.com' } }));
  ok(await call('POST', '/auth/forgot-password', { body: { email: 'founder@example.com' } }));
  await forgotPasswordWork();
  assert.equal(accountMail().length, 0);

  // 20 per IP address an hour
  resetLimits();
  for (let i = 0; i < 20; i += 1) ok(await call('POST', '/auth/forgot-password', { body: { email: `someone${i}@example.com` } }));
  ok(await call('POST', '/auth/forgot-password', { body: { email: 'member@example.com' } }));
  await forgotPasswordWork();
  assert.equal(accountMail('member@example.com').length, 0, 'over the IP limit: nothing sent');
  resetLimits();

  // the switch
  await setEmail({ forgotPassword: false });
  try {
    assert.equal(ok(await call('GET', '/auth/options')).forgot_password, false);
    assert.equal((await call('POST', '/auth/forgot-password', { body: { email: 'member@example.com' } })).status, 404);
  } finally { await setEmail(); }
  ok(await login('member@example.com', 'Password123!x'));
});

test('10 the failed sign-in limit: 10 in 15 minutes, the same for unknown accounts', async (t) => {
  if (skip(t)) return;
  for (let i = 0; i < 10; i += 1) assert.equal((await login('manager@example.com', `wrong-${i}`)).status, 401);
  const blocked = await login('manager@example.com', 'Password123!');
  assert.equal(blocked.status, 429, 'even the right password waits');
  assert.match(blocked.body.error, /Too many sign-in attempts. Wait \d+ minutes? and try again/);
  for (let i = 0; i < 10; i += 1) assert.equal((await login('not-a-person@example.com', `wrong-${i}`)).status, 401);
  const unknown = await login('not-a-person@example.com', 'anything');
  assert.equal(unknown.status, 429, 'an unknown account is treated the same');
  assert.equal(unknown.body.error.replace(/\d+/, 'N'), blocked.body.error.replace(/\d+/, 'N'));
  // another person is not affected, and a success clears the count
  ok(await login('admin@example.com', 'Password123!'));
  resetLimits();
  for (let i = 0; i < 9; i += 1) await login('manager@example.com', `wrong-${i}`);
  ok(await login('manager@example.com', 'Password123!'));
  for (let i = 0; i < 9; i += 1) assert.equal((await login('manager@example.com', `wrong-${i}`)).status, 401, 'the count started again');
});

test('Settings → Email: status, a test with no password, the sender checked', async (t) => {
  if (skip(t)) return;
  const status = ok(await call('GET', '/account-emails/status', { token: tokens.admin }));
  assert.equal(status.ready, true);
  assert.equal(status.outbox_only, true);
  const sent = ok(await call('POST', '/account-emails/test', { token: tokens.admin }));
  assert.equal(sent.email.sent, true);
  const [mail] = accountMail('admin@example.com');
  assert.equal(mail.subject, 'TaskFlow account emails: a test');
  assert.equal(passwordIn(mail), null);
  const dev = ok(await call('GET', '/account-emails/dev/outbox', { token: tokens.admin }));
  assert.equal(dev.messages[0].subject, 'TaskFlow account emails: a test');
  assert.equal((await call('POST', '/account-emails/test', { token: tokens.member })).status, 403);
  const bad = await call('PUT', '/settings/accountEmails', { token: tokens.admin, body: { value: { ...SENDER, senderEmail: 'not an address' } } });
  assert.equal(bad.status, 400);
  const tooLong = await call('PUT', '/settings/accountEmails', { token: tokens.admin, body: { value: { ...SENDER, expiryHours: 500 } } });
  assert.equal(tooLong.status, 400);
  ok(await call('PUT', '/settings/accountEmails', { token: tokens.admin, body: { value: { ...SENDER, expiryHours: 48 } } }));
  const { res } = await newPerson();
  const expires = new Date(ok(res, 201).temporary_password_expires_at).getTime();
  issued.push(res.body.temporary_password);
  assert.ok(Math.abs(expires - (Date.now() + 48 * 3600e3)) < 60_000, 'the expiry follows the setting');
  await setEmail();
});

test('11 no password anywhere but the one email: logs, audit trail, records', async (t) => {
  if (skip(t)) return;
  assert.ok(issued.length >= 10, `${issued.length} passwords issued in this file`);
  const audit = JSON.stringify((await query('SELECT * FROM attendance_audit')).rows);
  const records = JSON.stringify((await query('SELECT * FROM account_emails')).rows);
  const requests = JSON.stringify((await query('SELECT * FROM password_reset_requests')).rows);
  const consoleText = logged.join('\n');
  for (const p of issued) {
    assert.ok(!audit.includes(p), 'not in the audit trail');
    assert.ok(!records.includes(p), 'not in account_emails');
    assert.ok(!requests.includes(p), 'only hashes in reset requests');
    assert.ok(!consoleText.includes(p), 'not in the server logs');
  }
});
