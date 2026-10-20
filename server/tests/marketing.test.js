/**
 * Email marketing, end to end.
 *
 * The flow that matters: a contact joins an audience, a campaign is approved by
 * a second person and sent, the provider reports delivery, the person clicks
 * and replies, a follow-up task lands with their account owner and the
 * organization's history records it — and once they unsubscribe, nothing
 * reaches them again, whatever route a later email takes.
 *
 * Sending uses the outbox provider (EMAIL_PROVIDER unset outside production):
 * every message is built exactly as it would be for a real provider, kept in
 * memory, and never delivered.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.MARKETING_INBOUND_KEY = 'inbound-test-key';
process.env.MARKETING_CONVERSION_KEY = 'conversion-test-key';
process.env.EMAIL_WEBHOOK_SECRET = 'webhook-test-secret';
delete process.env.EMAIL_PROVIDER;
delete process.env.AWS_SES_SNS_TOPIC_ARN;

const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { query, closePool } = await import('../src/db/pool.js');
const { hashPassword } = await import('../src/lib/password.js');
const { getAccount } = await import('../src/services/crm.js');
const { applyMerge, checkDesign, renderEmail, stripActiveHtml } = await import('../src/lib/emailRender.js');
const { buildMime, encodeWord, parseMime } = await import('../src/lib/mime.js');
const { signRequest, signingKey } = await import('../src/lib/awsSign.js');
const { clearOutbox, outbox, parseBrevo, parseSesEvent, snsStringToSign, verifySns } = await import('../src/services/marketing/providers.js');
const { bestHour, engagementScore, looksAutomatic } = await import('../src/services/marketing/events.js');
const { compileRules } = await import('../src/services/marketing/segments.js');
const { pickWinner, splitForTest, startCampaign } = await import('../src/services/marketing/campaigns.js');
const { isAutomaticReply, normalizeInbound } = await import('../src/services/marketing/replies.js');
const { sniffImage } = await import('../src/services/marketing/templates.js');
const { setAiClientForTests } = await import('../src/services/marketing/ai.js');
const { checkDomain, setResolverForTests } = await import('../src/services/marketing/dns.js');
const { parseCsv } = await import('../src/services/marketing/contacts.js');

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

const call = async (method, path, { token, body, headers = {}, raw = false } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(typeof body === 'string' ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
};

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const tick = () => call('POST', '/marketing/worker/run', { token: tokens.admin, body: {} });
const outboxTo = (email) => outbox().filter((m) => m.to.toLowerCase() === email);
const messageFor = async (campaignId, email) => (await query(
  `SELECT * FROM mkt_messages WHERE campaign_id = $1 AND kind = 'CAMPAIGN' AND email = $2`, [campaignId, email],
)).rows[0];
const trackedLink = (raw) => {
  const html = parseMime(raw).html;
  const m = html.match(/\/m\/c\/([A-Za-z0-9_-]+)\/(\d+)/);
  return m ? { token: m[1], linkId: Number(m[2]) } : null;
};

const skipIfUnavailable = (t) => {
  if (!available) { t.skip('no database'); return true; }
  return false;
};

/** Create → review → approve (by someone else) → send now. */
async function approveAndSend(campaignId) {
  const submitted = await call('POST', `/marketing/campaigns/${campaignId}/submit`, { token: tokens.mgr1, body: {} });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const approved = await call('POST', `/marketing/campaigns/${campaignId}/approve`, { token: tokens.mgr2, body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const scheduled = await call('POST', `/marketing/campaigns/${campaignId}/schedule`, { token: tokens.mgr1, body: { strategy: 'NOW' } });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  return scheduled.body.campaign;
}

async function activate(automationId) {
  assert.equal((await call('POST', `/marketing/automations/${automationId}/submit`, { token: tokens.mgr1, body: {} })).status, 200);
  assert.equal((await call('POST', `/marketing/automations/${automationId}/approve`, { token: tokens.mgr2, body: {} })).status, 200);
  const on = await call('POST', `/marketing/automations/${automationId}/status`, { token: tokens.mgr1, body: { status: 'ACTIVE' } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
}

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try {
    await query('SELECT 1');
  } catch {
    available = false;
    console.log('[tests] no database reachable — skipping email marketing tests');
    return;
  }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('MKT', 'Marketing', '#1f7a4d', 1)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );
  ids.department = (await query(`SELECT id FROM departments WHERE key = 'MKT'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  const insertUser = async (name, email, role) => (await query(
    `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
     VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`, [name, email, password, role, ids.department],
  )).rows[0].id;
  ids.admin = await insertUser('Admin', 'mkt-admin@test.local', 'admin');
  ids.mgr1 = await insertUser('Vartika Marketing', 'mkt-mgr1@test.local', 'manager');
  ids.mgr2 = await insertUser('Saumya Approver', 'mkt-mgr2@test.local', 'manager');
  ids.member = await insertUser('Team Member', 'mkt-member@test.local', 'member');

  await new Promise((resolve) => {
    server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  for (const [key, email] of Object.entries({ admin: 'mkt-admin@test.local', mgr1: 'mkt-mgr1@test.local', mgr2: 'mkt-mgr2@test.local', member: 'mkt-member@test.local' })) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email, password: 'Password123!' } })).body.token;
  }
  const settings = await call('PUT', '/marketing/settings', {
    token: tokens.admin,
    body: {
      postalAddress: 'EkoSight, Plot 12, Sector 5, Noida, Uttar Pradesh 201301, India',
      defaultFromEmail: 'news@ekosight.com', defaultReplyTo: 'replies@ekosight.com', replyPlusAddressing: true,
      senders: [{ email: 'news@ekosight.com', name: 'EkoSight' }],
      // the flow below sends several emails to one person in a day; the limit has its own test
      limits: { perContactPerDay: 0, perContactPerWeek: 0, ratePerMinute: 600 },
    },
  });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  const audiences = (await call('GET', '/marketing/audiences', { token: tokens.mgr1 })).body.audiences;
  for (const a of audiences) ids[`aud_${a.slug}`] = a.id;
  const topics = (await call('GET', '/marketing/topics', { token: tokens.mgr1 })).body.topics;
  for (const t of topics) ids[`topic_${t.key}`] = t.id;
  clearOutbox();
});

after(async () => {
  setAiClientForTests(null);
  setResolverForTests(null);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ================================================================ pure parts

test('merge values are escaped for where they land, and cannot change the email', () => {
  const person = { first_name: '<img src=x onerror=alert(1)>', email: 'a+b@x.in', custom: { district: 'Indore & Dewas' } };
  const { html, text } = renderEmail({ blocks: [
    { type: 'heading', text: 'Hello {{first_name}}' },
    { type: 'text', text: 'District: {{custom.district}}. [Book](https://soildoctor.in/book?e={{email}})' },
  ] }, { person, data: { unsubscribe_url: 'https://t/u/1', preferences_url: 'https://t/u/1' }, footer: { company: 'EkoSight', address: 'Noida' } });
  assert.ok(!html.includes('<img src=x'), 'a name is text, never markup');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('Indore &amp; Dewas'));
  assert.ok(html.includes('e=a%2Bb%40x.in'), 'inside a link a value is URL-encoded');
  assert.ok(text.includes('Unsubscribe: https://t/u/1'), 'the plain-text part carries the way out too');
  assert.equal(applyMerge('Hi {{first_name|friend}}', {}), 'Hi friend');
});

test('every email carries the footer, in the reader’s language, and Hindi content goes to Hindi readers', () => {
  const design = { blocks: [{ type: 'text', text: { en: 'Book a soil test', hi: 'मिट्टी जाँच बुक करें' } }] };
  const footer = { company: 'EkoSight', address: 'Noida', reason: { en: 'you are a customer.', hi: 'आप ग्राहक हैं।' } };
  const hi = renderEmail(design, { lang: 'hi', data: { unsubscribe_url: 'https://t/u/2' }, footer });
  assert.ok(hi.html.includes('मिट्टी जाँच बुक करें'));
  assert.ok(hi.html.includes('सदस्यता समाप्त करें'));
  assert.ok(hi.html.includes('lang="hi"'));
  const en = renderEmail(design, { lang: 'en', data: { unsubscribe_url: 'https://t/u/2' }, footer });
  assert.ok(en.html.includes('Book a soil test') && en.html.includes('Unsubscribe') && en.html.includes('Noida'));
});

test('dynamic content shows a block only to the people it is meant for', () => {
  const design = { blocks: [
    { type: 'text', text: 'For dealers', condition: { type: 'tag', op: 'has', value: 'dealer' } },
    { type: 'text', text: 'For leads', condition: { type: 'crm', value: 'LEAD' } },
    { type: 'text', text: 'For Indore', condition: { type: 'field', key: 'custom.district', op: 'is', value: 'indore' } },
  ] };
  const a = renderEmail(design, { person: { tags: ['dealer'], account_type: 'CUSTOMER', custom: { district: 'Indore' } } }).html;
  assert.ok(a.includes('For dealers') && !a.includes('For leads') && a.includes('For Indore'));
  const b = renderEmail(design, { person: { tags: [], account_type: 'LEAD', custom: {} } }).html;
  assert.ok(!b.includes('For dealers') && b.includes('For leads') && !b.includes('For Indore'));
});

test('custom HTML blocks lose anything that runs', () => {
  const cleaned = stripActiveHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="https://e"></iframe><scr<script>x</script>ipt>alert(2)</script>');
  assert.ok(!/script|onclick|javascript:|iframe|alert\(1\)/i.test(cleaned), cleaned);
  assert.ok(cleaned.includes('<p>Hi</p>'));
});

test('checks before sending catch an empty subject, a button without a link and an unknown merge tag', () => {
  const { problems } = checkDesign({ blocks: [{ type: 'button', text: 'Go' }, { type: 'text', text: 'Hi {{nickname}}' }] }, { subject: '' });
  assert.ok(problems.some((p) => /subject/i.test(p)));
  assert.ok(problems.some((p) => /button/i.test(p)));
  assert.ok(problems.some((p) => /nickname/.test(p)));
});

test('the message is valid MIME with a Hindi subject and the unsubscribe headers', () => {
  const { raw } = buildMime({
    from: 'news@ekosight.com', fromName: 'EkoSight', to: 'ravi@x.in', subject: 'नमस्ते — खरीफ ऑफ़र', html: '<p>नमस्ते</p>', text: 'नमस्ते',
    headers: { 'List-Unsubscribe': '<https://t/u/1/one-click>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
  const parsed = parseMime(raw);
  assert.equal(parsed.subject, 'नमस्ते — खरीफ ऑफ़र');
  assert.equal(parsed.html, '<p>नमस्ते</p>');
  assert.equal(parsed.headers['list-unsubscribe-post'], 'List-Unsubscribe=One-Click');
  assert.ok(raw.split('\r\n').every((line) => line.length <= 998), 'no line longer than RFC 5322 allows');
  assert.ok(encodeWord('plain').startsWith('plain'));
});

test('AWS Signature V4 matches AWS’s own published example', () => {
  const key = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
  assert.equal(key.toString('hex'), 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  const headers = signRequest({
    method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', body: '',
    headers: { host: 'iam.amazonaws.com', 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    region: 'us-east-1', service: 'iam', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(headers.__debug.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

test('an SNS message is accepted only with a valid signature', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const msg = {
    Type: 'Notification', MessageId: 'm-1', TopicArn: 'arn:aws:sns:ap-south-1:1:ses', Message: '{"eventType":"Delivery"}',
    Timestamp: '2026-10-20T10:00:00.000Z', SignatureVersion: '2', SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/x.pem',
  };
  msg.Signature = crypto.createSign('RSA-SHA256').update(snsStringToSign(msg)).sign(privateKey, 'base64');
  assert.equal(await verifySns(msg, { getCert: async () => pem }), true);
  assert.equal(await verifySns({ ...msg, Message: '{"eventType":"Bounce"}' }, { getCert: async () => pem }), false, 'a changed message fails');
  assert.equal(await verifySns({ ...msg, Signature: undefined }, { getCert: async () => pem }), false);
});

test('provider reports are read into bounces, complaints and deliveries', () => {
  const [bounce] = parseSesEvent({
    eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'x@y.in', diagnosticCode: '550 no such user' }], timestamp: '2026-10-20T10:00:00Z' },
    mail: { messageId: 'ses-1', tags: { tf_message: ['tok123'] } },
  }, 'sns-1');
  assert.equal(bounce.type, 'BOUNCE_HARD');
  assert.equal(bounce.reference, 'tok123');
  assert.equal(parseSesEvent({ eventType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'x@y.in' }] }, mail: {} }, 's')[0].type, 'BOUNCE_SOFT');
  assert.deepEqual(parseSesEvent({ eventType: 'Open', mail: {} }, 's'), [], 'opens come from TaskFlow’s own tracking');
  const brevo = parseBrevo([{ event: 'spam', email: 'x@y.in', 'message-id': '<b-1>', tags: ['tf-tok9'], ts_event: 1792488000 }]);
  assert.equal(brevo[0].type, 'COMPLAINT');
  assert.equal(brevo[0].reference, 'tok9');
  assert.equal(brevo[0].occurredAt, new Date(1792488000 * 1000).toISOString());
});

test('opens and clicks by scanners are told apart from people', () => {
  const sentAt = new Date('2026-10-20T10:00:00Z');
  assert.equal(looksAutomatic({ type: 'CLICK', userAgent: BROWSER, occurredAt: new Date(sentAt.getTime() + 3000), sentAt }), true, 'nobody clicks 3 seconds after delivery');
  assert.equal(looksAutomatic({ type: 'CLICK', userAgent: 'Mimecast Safe Links', occurredAt: new Date(sentAt.getTime() + 3_600_000), sentAt }), true);
  assert.equal(looksAutomatic({ type: 'CLICK', userAgent: BROWSER, occurredAt: new Date(sentAt.getTime() + 3_600_000), sentAt }), false);
});

test('the engagement score rises with real activity, fades with time, and ignores machines', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const recent = [{ type: 'CLICK', occurred_at: now }, { type: 'OPEN', occurred_at: now }];
  const old = [{ type: 'CLICK', occurred_at: new Date(now - 80 * 86_400_000) }, { type: 'OPEN', occurred_at: new Date(now - 80 * 86_400_000) }];
  assert.ok(engagementScore(recent, now) > engagementScore(old, now));
  assert.equal(engagementScore([{ type: 'CLICK', occurred_at: now, is_machine: true }], now), 0);
  assert.equal(engagementScore([], now), 0);
  const morning = (d) => ({ type: 'OPEN', occurred_at: new Date(`2026-10-0${d}T03:30:00Z`) }); // 09:00 in India
  assert.equal(bestHour([morning(1), morning(2), morning(3)]), 9);
  assert.equal(bestHour([morning(1)]), null, 'one reading is not a habit');
});

test('segment rules are compiled with every value bound, never spliced into SQL', () => {
  const params = [];
  const sql = compileRules({ match: 'all', conditions: [
    { field: 'state', op: 'is', value: "x'); DROP TABLE mkt_contacts; --" },
    { match: 'any', conditions: [{ field: 'tag', op: 'has', value: 'fpo' }, { field: 'engagement_score', op: 'gte', value: 40 }] },
  ] }, params);
  assert.ok(!sql.includes('DROP TABLE'));
  assert.equal(params[0], "x'); drop table mkt_contacts; --");
  assert.throws(() => compileRules({ conditions: [{ field: 'password_hash', op: 'is', value: 'x' }] }, []), /Unknown field/);
  assert.throws(() => compileRules({ conditions: [{ field: 'state', op: 'gt', value: 'x' }] }, []), /does not apply/);
});

test('an A/B test splits the test group evenly and picks the winner by its measure', () => {
  const { assignments, held } = splitForTest(10, ['A', 'B'], 40);
  assert.equal(assignments.filter((a) => a === 'A').length, 2);
  assert.equal(assignments.filter((a) => a === 'B').length, 2);
  assert.equal(held, 6);
  assert.equal(splitForTest(3, ['A', 'B', 'C'], 100).held, 0);
  assert.equal(pickWinner([{ variant: 'A', sent: 10, clicked: 1 }, { variant: 'B', sent: 10, clicked: 3 }], 'CLICKS'), 'B');
  assert.equal(pickWinner([{ variant: 'A', sent: 10, clicked: 2 }, { variant: 'B', sent: 10, clicked: 2 }], 'CLICKS'), 'A', 'a tie goes to the first version');
});

test('automatic replies are not counted as people replying', () => {
  assert.equal(isAutomaticReply({ headers: { 'Auto-Submitted': 'auto-replied' }, subject: 'Re: Offer' }), true);
  assert.equal(isAutomaticReply({ subject: 'Out of office: back Monday' }), true);
  assert.equal(isAutomaticReply({ from: 'MAILER-DAEMON@x.in', subject: 'Undelivered' }), true);
  assert.equal(isAutomaticReply({ headers: {}, subject: 'Re: Kharif offer', from: 'ravi@x.in' }), false);
  const postmark = normalizeInbound({ From: 'Ravi <ravi@x.in>', To: 'replies+abc@x.in', Subject: 'Re: hi', TextBody: 'yes', Headers: [{ Name: 'In-Reply-To', Value: '<m1@x>' }] });
  assert.equal(postmark.inReplyTo, '<m1@x>');
  assert.deepEqual(postmark.to, ['replies+abc@x.in']);
});

test('only real PNG, JPEG, GIF and WebP files are accepted as images', () => {
  assert.equal(sniffImage(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')), 'image/png');
  assert.equal(sniffImage(Buffer.from('ffd8ffe000104a4649', 'hex')), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('<svg onload="x()"></svg>')), null);
});

test('CSV files with quotes, commas and line breaks inside fields are read correctly', () => {
  const rows = parseCsv('﻿email,name\r\n"a@x.in","Kumar, Ravi"\r\n"b@x.in","Line\nbreak ""quoted"""\r\n');
  assert.deepEqual(rows, [['email', 'name'], ['a@x.in', 'Kumar, Ravi'], ['b@x.in', 'Line\nbreak "quoted"']]);
});

test('the DNS check reports SPF, DKIM and DMARC and what to fix', async () => {
  setResolverForTests({
    resolveTxt: async (name) => {
      if (name === 'ekosight.com') return [['v=spf1 include:_spf.google.com ~all']];
      if (name === 'brevo1._domainkey.ekosight.com') return [['k=rsa; p=MIGf']];
      const err = new Error('none'); err.code = 'ENODATA'; throw err;
    },
    resolveCname: async () => [],
    resolveNs: async (name) => { if (name === 'ekosight.com') return ['ns1.example.net']; const err = new Error('none'); err.code = 'ENOTFOUND'; throw err; },
  });
  const unknown = await checkDomain('no-such-domain-here.in');
  assert.match(unknown.error, /could not be looked up/, 'no answer at all is not reported as missing records');
  assert.equal(unknown.checks.length, 0);
  const result = await checkDomain('ekosight.com', { dkimSelectors: ['brevo1'] });
  const by = Object.fromEntries(result.checks.map((c) => [c.key, c]));
  assert.equal(by.spf.status, 'ok');
  assert.equal(by['dkim:brevo1'].status, 'ok');
  assert.equal(by.dmarc.status, 'missing');
  assert.match(by.dmarc.fix, /_dmarc\.ekosight\.com/);
  assert.equal(result.ready, false);
  setResolverForTests(null);
});

// ================================================================ the module, through its API

test('people without email marketing permissions see nothing; settings are the admin’s', async (t) => {
  if (skipIfUnavailable(t)) return;
  assert.equal((await call('GET', '/marketing/overview', { token: tokens.member })).status, 403);
  assert.equal((await call('GET', '/marketing/contacts', { token: tokens.member })).status, 403);
  assert.equal((await call('GET', '/marketing/overview', { token: tokens.mgr1 })).status, 200);
  assert.equal((await call('PUT', '/marketing/settings', { token: tokens.mgr1, body: { company: 'X' } })).status, 403);
  const settings = await call('GET', '/marketing/settings', { token: tokens.mgr1 });
  assert.equal(settings.body.provider.name, 'log');
  assert.ok(!JSON.stringify(settings.body).includes('webhook-test-secret'), 'no credential is ever sent to the screen');
  assert.ok(!JSON.stringify(settings.body).includes('inbound-test-key'));
});

test('one contact per address: a second sighting fills gaps instead of making a duplicate', async (t) => {
  if (skipIfUnavailable(t)) return;
  const noBasis = await call('POST', '/marketing/contacts', { token: tokens.mgr1, body: { email: 'asha@farm.in', audience_ids: [ids.aud_farmers] } });
  assert.equal(noBasis.status, 400, 'adding someone to an audience needs the reason they may be emailed');
  const first = await call('POST', '/marketing/contacts', {
    token: tokens.mgr1, body: { email: 'Asha@Farm.in', first_name: 'Asha', audience_ids: [ids.aud_farmers], basis: 'Signed up at the Krishi Mela stall' },
  });
  assert.equal(first.status, 201);
  const second = await call('POST', '/marketing/contacts', { token: tokens.mgr1, body: { email: '  asha@farm.in ', first_name: 'Someone else', last_name: 'Patil' } });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  const { rows } = await query(`SELECT * FROM mkt_contacts WHERE email_normalized = 'asha@farm.in'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_name, 'Asha', 'what is there is not overwritten');
  assert.equal(rows[0].last_name, 'Patil', 'what was blank is filled');
  ids.asha = rows[0].id;
  const consent = await query(`SELECT * FROM mkt_consents WHERE contact_id = $1 AND action = 'SUBSCRIBE'`, [ids.asha]);
  assert.equal(consent.rows[0].basis, 'Signed up at the Krishi Mela stall');
  assert.equal(consent.rows[0].actor_id, ids.mgr1);
});

test('people at organizations in the pipeline join the audiences their organization matches', async (t) => {
  if (skipIfUnavailable(t)) return;
  const org = await call('POST', '/accounts', {
    token: tokens.mgr1, body: { name: 'Green Valley FPO', type: 'LEAD', owner_user_id: ids.mgr1, department_id: ids.department, source: 'Referral' },
  });
  assert.equal(org.status, 201, JSON.stringify(org.body));
  ids.account = org.body.account.id;
  for (const [name, email] of [['Ravi Kumar', 'ravi@greenvalley.in'], ['Meera Devi', 'meera@greenvalley.in'], ['Bounce Test', 'bounce@greenvalley.in'], ['Gone Already', 'gone@greenvalley.in']]) {
    const c = await call('POST', `/accounts/${ids.account}/contacts`, { token: tokens.mgr1, body: { full_name: name, email } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
  }
  const off = await call('POST', '/marketing/settings/sync-crm', { token: tokens.admin, body: {} });
  assert.match(off.body.skipped, /switched off/, 'nothing is synced until an admin switches it on');
  await call('PUT', '/marketing/settings', { token: tokens.admin, body: { crmSync: { enabled: true } } });
  const sync = await call('POST', '/marketing/settings/sync-crm', { token: tokens.admin, body: {} });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.created, 4);
  const { rows } = await query(
    `SELECT c.id, c.email_normalized, c.account_id, c.first_name, m.status, m.synced FROM mkt_contacts c
       JOIN mkt_memberships m ON m.contact_id = c.id AND m.audience_id = $1 WHERE c.account_id = $2 ORDER BY c.id`,
    [ids.aud_leads, ids.account],
  );
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.status === 'SUBSCRIBED' && r.synced));
  for (const r of rows) ids[r.email_normalized.split('@')[0]] = r.id;
  assert.equal(rows.find((r) => r.email_normalized === 'ravi@greenvalley.in').first_name, 'Ravi');
  // a second pass changes nothing
  const again = await call('POST', '/marketing/settings/sync-crm', { token: tokens.admin, body: {} });
  assert.equal(again.body.created, 0);
  assert.equal(again.body.joined, 0);

  // Gone asked a salesperson to stop, before any campaign
  const stop = await call('POST', `/marketing/contacts/${ids.gone}/unsubscribe`, { token: tokens.mgr1, body: { all: true, reason: 'Said so on a call' } });
  assert.equal(stop.status, 200);
});

test('a campaign is approved by someone else, any later change needs approving again, and it goes only to subscribers', async (t) => {
  if (skipIfUnavailable(t)) return;
  const created = await call('POST', '/marketing/campaigns', {
    token: tokens.mgr1,
    body: {
      name: 'Kharif soil test offer', audience_id: ids.aud_leads,
      subject: 'Test your soil before Kharif, {{first_name|friend}}', subject_hi: 'खरीफ से पहले मिट्टी जाँच, {{first_name|}}',
      preheader: 'Book a Soil Doctor test this month',
      design: { blocks: [
        { type: 'heading', text: { en: 'Hello {{first_name|there}}', hi: 'नमस्ते {{first_name|}}' } },
        { type: 'text', text: { en: 'Book a soil test before sowing.', hi: 'बुवाई से पहले मिट्टी की जाँच कराएँ।' } },
        { type: 'button', text: { en: 'Book now', hi: 'अभी बुक करें' }, href: 'https://soildoctor.in/book' },
      ] },
      follow_up: { on_click: true, on_reply: true, on_conversion: true, assign: 'CONTACT_OWNER', due_days: 2 },
      deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      create_task: true,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const campaign = created.body.campaign;
  ids.campaign1 = campaign.id;
  assert.ok(campaign.task_id, 'the campaign has its own task');
  const { rows: tasks } = await query('SELECT * FROM tasks WHERE id = $1', [campaign.task_id]);
  assert.equal(tasks[0].assignee_id, ids.mgr1);
  assert.equal(tasks[0].task_type, 'campaign');

  const checks = await call('GET', `/marketing/campaigns/${campaign.id}/checks`, { token: tokens.mgr1 });
  assert.deepEqual(checks.body.problems, []);
  assert.equal(checks.body.recipients, 3, 'Gone unsubscribed, so three people would get it');

  assert.equal((await call('POST', `/marketing/campaigns/${campaign.id}/schedule`, { token: tokens.mgr1, body: { strategy: 'NOW' } })).status, 409, 'a draft cannot be sent');
  assert.equal((await call('POST', `/marketing/campaigns/${campaign.id}/submit`, { token: tokens.mgr1, body: {} })).body.campaign.status, 'IN_REVIEW');
  assert.equal((await call('POST', `/marketing/campaigns/${campaign.id}/approve`, { token: tokens.mgr1, body: {} })).status, 403, 'nobody approves their own campaign');
  assert.equal((await call('POST', `/marketing/campaigns/${campaign.id}/approve`, { token: tokens.mgr2, body: {} })).body.campaign.status, 'APPROVED');

  const edited = await call('PATCH', `/marketing/campaigns/${campaign.id}`, { token: tokens.mgr1, body: { subject: 'Test your soil before Kharif sowing, {{first_name|friend}}' } });
  assert.equal(edited.body.campaign.status, 'DRAFT', 'changing what was approved sends it back');
  assert.equal(edited.body.campaign.approved_fingerprint, null);

  const sent = await approveAndSend(campaign.id);
  assert.equal(sent.status, 'SENDING');
  assert.equal(sent.recipient_count, 3);
  const { rows: queued } = await query(`SELECT email, status FROM mkt_messages WHERE campaign_id = $1 AND kind = 'CAMPAIGN' ORDER BY email`, [campaign.id]);
  assert.deepEqual(queued.map((m) => m.email), ['bounce@greenvalley.in', 'meera@greenvalley.in', 'ravi@greenvalley.in']);
});

test('the worker hands each email over once, with one-click unsubscribe, the footer and tracking', async (t) => {
  if (skipIfUnavailable(t)) return;
  const run = await tick();
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.queue.sent, 3);
  const mail = outboxTo('ravi@greenvalley.in');
  assert.equal(mail.length, 1);
  const parsed = parseMime(mail[0].raw);
  assert.equal(parsed.subject, 'Test your soil before Kharif sowing, Ravi');
  assert.match(parsed.headers['list-unsubscribe'], /\/m\/u\/[A-Za-z0-9_-]+\/one-click>$/);
  assert.equal(parsed.headers['list-unsubscribe-post'], 'List-Unsubscribe=One-Click');
  assert.match(parsed.headers['reply-to'], /^replies\+[0-9a-f]{16}@ekosight\.com$/, 'replies come back with the message’s own code');
  assert.ok(parsed.html.includes('Plot 12, Sector 5, Noida'), 'the postal address is in the footer');
  assert.ok(parsed.html.includes('/m/o/'), 'opens are tracked');
  assert.ok(trackedLink(mail[0].raw), 'links are tracked');
  assert.ok(parsed.text.includes('Unsubscribe:'));

  const again = await tick();
  assert.equal(again.body.queue.sent || 0, 0, 'nothing is sent twice');
  assert.equal(outboxTo('ravi@greenvalley.in').length, 1);
  const { rows } = await query('SELECT status FROM mkt_campaigns WHERE id = $1', [ids.campaign1]);
  assert.equal(rows[0].status, 'SENT');
  assert.equal((await startCampaign(ids.campaign1)).started, false, 'a sent campaign cannot be started again');
  await assert.rejects(
    query(`INSERT INTO mkt_messages (kind, campaign_id, contact_id, email, token, reply_code) VALUES ('CAMPAIGN', $1, $2, 'x', 'tok-dup', 'code-dup')`, [ids.campaign1, ids.ravi]),
    /duplicate key/, 'the database itself refuses a second copy for the same person',
  );
});

test('a delivery report, a human click and a reply become one follow-up task for the account owner and lines in the organization’s history', async (t) => {
  if (skipIfUnavailable(t)) return;
  const before = await getAccount(ids.account);
  const ravi = await messageFor(ids.campaign1, 'ravi@greenvalley.in');
  // as if it was sent an hour ago, so the click is plainly a person's
  await query(`UPDATE mkt_messages SET sent_at = now() - interval '1 hour' WHERE campaign_id = $1`, [ids.campaign1]);

  const delivered = await call('POST', '/marketing/dev/simulate', { token: tokens.admin, body: { message_id: Number(ravi.id), type: 'DELIVERED' } });
  assert.equal(delivered.body.recorded, true);
  assert.equal((await messageFor(ids.campaign1, 'ravi@greenvalley.in')).status, 'DELIVERED');

  const open = await call('GET', `/m/o/${ravi.token}.gif`, { headers: { 'user-agent': BROWSER }, raw: true });
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('content-type'), 'image/gif');

  const link = trackedLink(outboxTo('ravi@greenvalley.in')[0].raw);
  const click = await call('GET', `/m/c/${link.token}/${link.linkId}`, { headers: { 'user-agent': BROWSER }, raw: true });
  assert.equal(click.status, 302);
  const target = new URL(click.headers.get('location'));
  assert.equal(`${target.origin}${target.pathname}`, 'https://soildoctor.in/book');
  assert.equal(target.searchParams.get('utm_source'), 'taskflow');
  assert.equal(target.searchParams.get('tf_ref'), ravi.reply_code);

  const { rows: followups } = await query('SELECT * FROM mkt_followups WHERE campaign_id = $1', [ids.campaign1]);
  assert.equal(followups.length, 1);
  const { rows: tasks } = await query('SELECT * FROM tasks WHERE id = $1', [followups[0].task_id]);
  assert.equal(tasks[0].assignee_id, ids.mgr1, 'the organization’s owner follows up');
  assert.equal(tasks[0].account_id, ids.account, 'the task sits on the organization');
  assert.deepEqual(tasks[0].tags, ['email-follow-up']);
  assert.ok(tasks[0].due_date);
  const { rows: notes } = await query(`SELECT * FROM notifications WHERE user_id = $1 AND task_id = $2`, [ids.mgr1, tasks[0].id]);
  assert.equal(notes.length, 1);

  // clicking again, or a link scanner at Meera's company, makes no more tasks
  assert.equal((await call('GET', `/m/c/${link.token}/${link.linkId}`, { headers: { 'user-agent': BROWSER }, raw: true })).status, 302);
  const meera = await messageFor(ids.campaign1, 'meera@greenvalley.in');
  const meeraLink = trackedLink(outboxTo('meera@greenvalley.in')[0].raw);
  assert.equal((await call('GET', `/m/c/${meeraLink.token}/${meeraLink.linkId}`, { headers: { 'user-agent': 'Mimecast Safe Links Scanner' }, raw: true })).status, 302);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM mkt_followups')).rows[0].n, 1);
  const { rows: machine } = await query(`SELECT is_machine FROM mkt_events WHERE message_id = $1 AND type = 'CLICK'`, [meera.id]);
  assert.deepEqual(machine.map((m) => m.is_machine), [true]);
  assert.equal((await messageFor(ids.campaign1, 'ravi@greenvalley.in')).click_count, 2);

  // someone else's message token cannot be used to reach another campaign's links
  assert.equal((await call('GET', `/m/c/${link.token}/999999`, { raw: true })).status, 404);

  // the reply, matched by the code in the Reply-To address
  const reply = await call('POST', '/m/inbound/inbound-test-key', {
    body: { From: 'Ravi Kumar <ravi@greenvalley.in>', To: `replies+${ravi.reply_code}@ekosight.com`, Subject: 'Re: Test your soil', TextBody: 'Yes, please call me tomorrow.', MessageID: '<r1@mail>' },
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.matched, true);
  assert.equal((await call('POST', '/m/inbound/inbound-test-key', {
    body: { From: 'ravi@greenvalley.in', To: `replies+${ravi.reply_code}@ekosight.com`, Subject: 'Re: Test your soil', TextBody: 'Yes', MessageID: '<r1@mail>' },
  })).body.recorded, false, 'the same reply posted twice is one reply');
  const autoReply = await call('POST', '/m/inbound/inbound-test-key', {
    body: { From: 'meera@greenvalley.in', To: `replies+${meera.reply_code}@ekosight.com`, Subject: 'Out of office', TextBody: 'Back Monday', Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied' }] },
  });
  assert.equal(autoReply.body.matched, false);
  assert.equal((await call('POST', '/m/inbound/wrong-key', { body: {} })).status, 403);

  const { rows: comments } = await query('SELECT body FROM task_comments WHERE task_id = $1', [tasks[0].id]);
  assert.ok(comments.some((c) => /replied to/.test(c.body) && /call me tomorrow/.test(c.body)), 'the reply is added to the same task');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM tasks WHERE $1 = ANY(tags)', ['email-follow-up'])).rows[0].n, 1);

  // the organization's history says what happened, and no pipeline clock moved
  const { rows: history } = await query(`SELECT subject, type, is_external, outcome FROM account_activities WHERE account_id = $1 AND type = 'CAMPAIGN' ORDER BY id`, [ids.account]);
  assert.deepEqual(history.map((h) => h.subject.split(' “')[0]), ['Clicked a link in', 'Replied to']);
  const afterAccount = await getAccount(ids.account);
  assert.equal(afterAccount.last_customer_at, before.last_customer_at, 'an email click is not the customer speaking to us');
  assert.equal(afterAccount.last_outbound_at, before.last_outbound_at, 'a bulk email is not a salesperson reaching out');
  assert.equal(String(afterAccount.last_activity_at), String(before.last_activity_at));

  const { rows: contact } = await query('SELECT engagement_score, last_clicked_at, last_replied_at FROM mkt_contacts WHERE id = $1', [ids.ravi]);
  assert.ok(contact[0].engagement_score > 0);
  assert.ok(contact[0].last_clicked_at && contact[0].last_replied_at);
});

test('a conversion the website reports is counted once, against the click that led to it', async (t) => {
  if (skipIfUnavailable(t)) return;
  const ravi = await messageFor(ids.campaign1, 'ravi@greenvalley.in');
  const body = { ref: ravi.reply_code, value: 25000, label: 'Soil test booked', id: 'order-1' };
  assert.equal((await call('POST', '/m/conversions', { body })).status, 403, 'only with the key');
  const first = await call('POST', '/m/conversions', { body, headers: { 'x-taskflow-key': 'conversion-test-key' } });
  assert.equal(first.body.recorded, true);
  const second = await call('POST', '/m/conversions', { body, headers: { 'x-taskflow-key': 'conversion-test-key' } });
  assert.equal(second.body.recorded, false, 'the website retrying is one conversion');
  assert.ok((await messageFor(ids.campaign1, 'ravi@greenvalley.in')).converted_at);
});

test('a hard bounce suppresses the address for good', async (t) => {
  if (skipIfUnavailable(t)) return;
  const bounce = await messageFor(ids.campaign1, 'bounce@greenvalley.in');
  await call('POST', '/marketing/dev/simulate', { token: tokens.admin, body: { message_id: Number(bounce.id), type: 'BOUNCE_HARD' } });
  const { rows: s } = await query(`SELECT reason FROM mkt_suppressions WHERE email_normalized = 'bounce@greenvalley.in'`);
  assert.equal(s[0].reason, 'HARD_BOUNCE');
  const { rows: m } = await query('SELECT status FROM mkt_memberships WHERE contact_id = $1', [ids.bounce]);
  assert.ok(m.every((x) => x.status !== 'SUBSCRIBED'));
  const lift = await call('DELETE', '/marketing/suppressions/bounce%40greenvalley.in?note=Checked%20the%20address', { token: tokens.admin });
  assert.equal(lift.status, 403, 'a hard bounce is never lifted');
});

test('one-click unsubscribe works without a page, and a scanner fetching the address changes nothing', async (t) => {
  if (skipIfUnavailable(t)) return;
  const meera = await messageFor(ids.campaign1, 'meera@greenvalley.in');
  const peek = await call('GET', `/m/u/${meera.token}/one-click`, { raw: true });
  assert.equal(peek.status, 302);
  assert.equal((await query('SELECT status FROM mkt_memberships WHERE contact_id = $1 AND audience_id = $2', [ids.meera, ids.aud_leads])).rows[0].status, 'SUBSCRIBED');

  const page = await call('GET', `/m/u/${meera.token}`, { raw: true });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Meera') && page.text.includes('Unsubscribe from all emails'));
  assert.ok(!page.text.includes('<script'), 'the page runs no scripts');

  const res = await call('POST', `/m/u/${meera.token}/one-click`, { body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: true });
  assert.equal(res.status, 200);
  assert.equal((await query('SELECT status FROM mkt_memberships WHERE contact_id = $1 AND audience_id = $2', [ids.meera, ids.aud_leads])).rows[0].status, 'UNSUBSCRIBED');
  const { rows: consent } = await query(`SELECT * FROM mkt_consents WHERE contact_id = $1 AND action = 'UNSUBSCRIBE'`, [ids.meera]);
  assert.equal(consent[0].source, 'ONE_CLICK');
  assert.ok(consent[0].ip, 'where it came from is kept');
  assert.ok((await messageFor(ids.campaign1, 'meera@greenvalley.in')).unsubscribed_at);
  // a CRM sync does not put her back
  const sync = await call('POST', '/marketing/settings/sync-crm', { token: tokens.admin, body: {} });
  assert.equal(sync.body.joined, 0);
  assert.equal((await query('SELECT status FROM mkt_memberships WHERE contact_id = $1 AND audience_id = $2', [ids.meera, ids.aud_leads])).rows[0].status, 'UNSUBSCRIBED');
});

test('an unsubscribe that arrives after a campaign started still stops that person’s email', async (t) => {
  if (skipIfUnavailable(t)) return;
  const created = await call('POST', '/marketing/campaigns', {
    token: tokens.mgr1,
    body: { name: 'Rabi follow-up', audience_id: ids.aud_leads, subject: 'Rabi season soil tests', design: { blocks: [{ type: 'text', text: 'Rabi is here.' }] } },
  });
  ids.campaign2 = created.body.campaign.id;
  const checks = await call('GET', `/marketing/campaigns/${ids.campaign2}/checks`, { token: tokens.mgr1 });
  assert.equal(checks.body.recipients, 1, 'only Ravi: Meera and Gone unsubscribed, Bounce is suppressed');
  await approveAndSend(ids.campaign2);
  const queued = await messageFor(ids.campaign2, 'ravi@greenvalley.in');
  assert.equal(queued.status, 'QUEUED');

  // before the worker runs, Ravi leaves everything from the preference page of the first email
  const first = await messageFor(ids.campaign1, 'ravi@greenvalley.in');
  const leave = await call('POST', `/m/u/${first.token}`, { body: 'action=unsubscribe_all', headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: true });
  assert.equal(leave.status, 200);
  assert.ok(leave.text.includes('You are unsubscribed'));

  await tick();
  const after = await messageFor(ids.campaign2, 'ravi@greenvalley.in');
  assert.equal(after.status, 'SKIPPED');
  assert.match(after.skip_reason, /UNSUBSCRIBED_ALL/);
  assert.equal(outboxTo('ravi@greenvalley.in').length, 1, 'only the first campaign ever reached him');

  // nobody but Ravi can bring him back: not an import, not a colleague, not the CRM
  const csv = 'email,first name\nravi@greenvalley.in,Ravi\n';
  const imported = await call('POST', `/marketing/contacts/import?audience_id=${ids.aud_leads}&basis=${encodeURIComponent('Trade fair list 2026')}`, {
    token: tokens.mgr1, body: csv, headers: { 'content-type': 'text/csv' },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.totals.suppressed, 1);
  const colleague = await call('POST', `/marketing/contacts/${ids.ravi}/audiences`, { token: tokens.mgr1, body: { audience_id: ids.aud_farmers, basis: 'He seemed interested' } });
  assert.equal(colleague.body.result, 'SUPPRESSED');
  const lift = await call('DELETE', '/marketing/suppressions/ravi%40greenvalley.in?note=He%20asked%20again', { token: tokens.admin });
  assert.equal(lift.status, 403, 'an unsubscribe is lifted only by the person');
});

test('the campaign report counts what really happened and says where each figure comes from', async (t) => {
  if (skipIfUnavailable(t)) return;
  const report = await call('GET', `/marketing/campaigns/${ids.campaign1}/report`, { token: tokens.mgr1 });
  assert.equal(report.status, 200);
  const totals = report.body.totals;
  assert.equal(totals.recipients, 3);
  assert.equal(totals.sent, 3);
  assert.equal(totals.unique_clicks, 1, 'the scanner is not a person');
  assert.equal(totals.machine_clicks, 1);
  assert.equal(totals.replies, 1);
  assert.equal(totals.conversions, 1);
  assert.equal(totals.conversion_value, 25000);
  assert.equal(totals.hard_bounces, 1);
  assert.equal(totals.unsubscribes, 2);
  assert.equal(totals.delivered, null, 'the outbox reports no deliveries, so none are claimed');
  assert.equal(report.body.base_label, 'sent');
  assert.equal(report.body.followups.length, 1);
  assert.ok(report.body.notes.some((n) => /Apple Mail/.test(n)));
  const csv = await call('GET', `/marketing/campaigns/${ids.campaign1}/recipients.csv`, { token: tokens.mgr1, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.split('\r\n')[0].includes('Email'));
  assert.equal(csv.text.trim().split('\r\n').length, 4);
  assert.equal((await call('GET', '/marketing/consents.csv', { token: tokens.mgr1, raw: true })).status, 200);
});

test('a signup form needs consent, ignores bots, and double opt-in waits for the confirmation click', async (t) => {
  if (skipIfUnavailable(t)) return;
  const made = await call('POST', '/marketing/forms', {
    token: tokens.mgr1,
    body: { name: 'Student signup', audience_id: ids.aud_students, title: 'Jobs and internships at EkoSight', fields: [{ key: 'email' }, { key: 'first_name', required: true }, { key: 'custom.college' }], topic_ids: [ids.topic_careers] },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pid = made.body.form.public_id;
  const page = await call('GET', `/m/f/${pid}`, { raw: true });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('I agree to receive emails'));

  const post = (fields) => call('POST', `/m/f/${pid}`, { body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: true });
  assert.equal((await post({ email: 'priya@college.edu', first_name: 'Priya' })).status, 400, 'no consent, no subscription');
  assert.equal((await post({ email: 'bot@spam.example', first_name: 'Bot', consent: '1', website: 'http://spam' })).status, 200);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM mkt_contacts WHERE email_normalized = 'bot@spam.example'`)).rows[0].n, 0, 'the hidden field catches the bot');

  const ok = await post({ email: 'priya@college.edu', first_name: 'Priya', 'custom.college': 'IARI', consent: '1', [`topic_${ids.topic_careers}`]: '1' });
  assert.equal(ok.status, 200);
  assert.ok(ok.text.includes('Check your email'));
  const { rows: c } = await query(`SELECT * FROM mkt_contacts WHERE email_normalized = 'priya@college.edu'`);
  assert.equal(c[0].custom.college, 'IARI');
  const { rows: m } = await query('SELECT status FROM mkt_memberships WHERE contact_id = $1 AND audience_id = $2', [c[0].id, ids.aud_students]);
  assert.equal(m[0].status, 'PENDING', 'nobody is mailed before they confirm');

  await tick();
  const confirmation = outboxTo('priya@college.edu');
  assert.equal(confirmation.length, 1);
  const confirmUrl = parseMime(confirmation[0].raw).html.match(/\/m\/confirm\/([A-Za-z0-9_-]+)/);
  assert.ok(confirmUrl, 'the confirmation email carries the link');
  const confirmed = await call('GET', `/m/confirm/${confirmUrl[1]}`, { raw: true });
  assert.equal(confirmed.status, 200);
  assert.equal((await query('SELECT status FROM mkt_memberships WHERE contact_id = $1 AND audience_id = $2', [c[0].id, ids.aud_students])).rows[0].status, 'SUBSCRIBED');
  const { rows: k } = await query(`SELECT * FROM mkt_consents WHERE contact_id = $1 ORDER BY id`, [c[0].id]);
  assert.deepEqual(k.map((x) => x.action), ['PENDING', 'CONFIRM']);
  assert.ok(k[0].consent_text.includes('I agree'), 'the words they agreed to are kept');
  assert.ok(k[0].ip && k[0].user_agent);
});

test('someone who unsubscribed can come back only through their own confirmed signup', async (t) => {
  if (skipIfUnavailable(t)) return;
  const made = await call('POST', '/marketing/forms', {
    token: tokens.mgr1, body: { name: 'Lead magnet', audience_id: ids.aud_leads, fields: [{ key: 'email' }] },
  });
  const pid = made.body.form.public_id;
  const res = await call('POST', `/m/f/${pid}`, { body: 'email=ravi%40greenvalley.in&consent=1', headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: true });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Check your email'), 'even on a single opt-in form, a past unsubscribe needs confirming');
  const { rows: still } = await query(`SELECT reason FROM mkt_suppressions WHERE email_normalized = 'ravi@greenvalley.in'`);
  assert.equal(still[0]?.reason, 'UNSUBSCRIBED_ALL', 'typing his address on a form does not undo his choice');
  await tick();
  const mail = outboxTo('ravi@greenvalley.in').at(-1);
  const token = parseMime(mail.raw).html.match(/\/m\/confirm\/([A-Za-z0-9_-]+)/)[1];
  await call('GET', `/m/confirm/${token}`, { raw: true });
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM mkt_suppressions WHERE email_normalized = 'ravi@greenvalley.in'`)).rows[0].n, 0);
  assert.equal((await query('SELECT status FROM mkt_memberships WHERE contact_id = $1 AND audience_id = $2', [ids.ravi, ids.aud_leads])).rows[0].status, 'SUBSCRIBED');
});

test('an import deduplicates, reports bad rows, and records why the people may be emailed', async (t) => {
  if (skipIfUnavailable(t)) return;
  const csv = [
    'Email,First Name,Company,Tags,District',
    'd1@dealers.in,Arun,Agro One,"dealer;north",Indore',
    'D1@dealers.in,Arun again,Agro One,,',
    'not-an-email,Bad,,,',
    'd2@dealers.in,Bina,Agro Two,dealer,Dewas',
    'd3@dealers.in,Chetan,Agro Three,dealer,Ujjain',
    'd4@dealers.in,Divya,Agro Four,dealer,Bhopal',
  ].join('\n');
  const preview = await call('POST', '/marketing/contacts/import/preview', { token: tokens.mgr1, body: csv, headers: { 'content-type': 'text/csv' } });
  assert.deepEqual(preview.body.mapping, ['email', 'first_name', 'organization', 'tags', 'custom.district']);
  const res = await call('POST', `/marketing/contacts/import?audience_id=${ids.aud_dealers}&basis=${encodeURIComponent('Dealer agreement 2026 includes email updates')}&filename=dealers.csv&mapping=${encodeURIComponent(JSON.stringify(preview.body.mapping))}`, {
    token: tokens.mgr1, body: csv, headers: { 'content-type': 'text/csv' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.totals.created, 4);
  assert.equal(res.body.totals.duplicate_in_file, 1);
  assert.equal(res.body.totals.invalid, 1);
  assert.equal(res.body.totals.subscribed, 4);
  assert.equal(res.body.problems[0].line, 4);
  const { rows } = await query(`SELECT tags, custom FROM mkt_contacts WHERE email_normalized = 'd1@dealers.in'`);
  assert.deepEqual(rows[0].tags.sort(), ['dealer', 'north']);
  assert.equal(rows[0].custom.district, 'Indore');
  assert.equal((await call('POST', `/marketing/contacts/import?basis=x&audience_id=${ids.aud_dealers}`, { token: tokens.mgr1, body: csv, headers: { 'content-type': 'text/csv' } })).status, 400, 'a basis is required');
});

test('an A/B test sends each version to part of the audience, then the winner to the rest', async (t) => {
  if (skipIfUnavailable(t)) return;
  const created = await call('POST', '/marketing/campaigns', {
    token: tokens.mgr1,
    body: {
      name: 'Dealer scheme', audience_id: ids.aud_dealers, subject: 'Version A subject',
      design: { blocks: [{ type: 'text', text: 'New dealer scheme.' }, { type: 'button', text: 'Read', href: 'https://soildoctor.in/dealers' }] },
      ab_test: { metric: 'CLICKS', test_percent: 50, wait_hours: 4 },
      variants: [{ subject: 'Version A subject' }, { subject: 'Version B subject' }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  const started = await approveAndSend(id);
  assert.equal(started.status, 'TESTING');
  await tick();
  const subjects = outbox().filter((m) => m.to.endsWith('@dealers.in')).map((m) => m.subject).sort();
  assert.deepEqual(subjects, ['Version A subject', 'Version B subject']);
  const { rows: held } = await query(`SELECT COUNT(*)::int AS n FROM mkt_messages WHERE campaign_id = $1 AND status = 'HELD'`, [id]);
  assert.equal(held[0].n, 2);
  const finished = await call('POST', `/marketing/campaigns/${id}/finish-test`, { token: tokens.mgr1, body: { winner: 'B' } });
  assert.equal(finished.body.winner, 'B');
  await tick();
  const all = outbox().filter((m) => m.to.endsWith('@dealers.in')).map((m) => m.subject);
  assert.equal(all.length, 4);
  assert.equal(all.filter((s) => s === 'Version B subject').length, 3);
  assert.equal((await query('SELECT status FROM mkt_campaigns WHERE id = $1', [id])).rows[0].status, 'SENT');
  ids.campaignAb = id;
});

test('Brevo reports are accepted only at the secret address, and SES only from the configured topic', async (t) => {
  if (skipIfUnavailable(t)) return;
  const m = (await query(`SELECT * FROM mkt_messages WHERE campaign_id = $1 ORDER BY id LIMIT 1`, [ids.campaignAb])).rows[0];
  const event = [{ event: 'delivered', email: m.email, 'message-id': `<${m.provider_message_id}>`, tags: [`tf-${m.token}`], ts_event: Math.floor(Date.now() / 1000) }];
  assert.equal((await call('POST', '/m/webhooks/brevo/wrong', { body: event })).status, 403);
  const ok = await call('POST', '/m/webhooks/brevo/webhook-test-secret', { body: event });
  assert.equal(ok.body.recorded, 1);
  assert.equal((await call('POST', '/m/webhooks/brevo/webhook-test-secret', { body: event })).body.recorded, 0, 'a retried webhook is recorded once');
  assert.ok((await query('SELECT delivered_at FROM mkt_messages WHERE id = $1', [m.id])).rows[0].delivered_at);
  const ses = await call('POST', '/m/webhooks/ses', { body: JSON.stringify({ Type: 'Notification', TopicArn: 'arn:aws:sns:x:1:other' }), headers: { 'content-type': 'text/plain' } });
  assert.equal(ses.status, 403);
});

test('a welcome automation sends, waits, branches on whether they opened, and makes a task — once', async (t) => {
  if (skipIfUnavailable(t)) return;
  const made = await call('POST', '/marketing/automations', {
    token: tokens.mgr1,
    body: {
      name: 'Farmer welcome', audience_id: ids.aud_farmers, trigger: { type: 'AUDIENCE_JOINED', audience_id: ids.aud_farmers },
      graph: { start: 'e1', nodes: {
        e1: { type: 'email', config: { subject: 'Welcome {{first_name|}}', design: { blocks: [{ type: 'text', text: 'Welcome to EkoSight.' }] } }, next: 'd1' },
        d1: { type: 'delay', config: { amount: 2, unit: 'days' }, next: 'c1' },
        c1: { type: 'condition', config: { kind: 'opened' }, yes: 'a1', no: 'e2' },
        a1: { type: 'action', config: { kind: 'add_tag', value: 'engaged' }, next: null },
        e2: { type: 'email', config: { subject: 'Did you see our welcome?', design: { blocks: [{ type: 'text', text: 'A quick reminder.' }] } }, next: 't1' },
        t1: { type: 'action', config: { kind: 'create_task', title: 'Call {{name}} about soil testing', due_days: 1 }, next: null },
      } },
    },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.automation.id;
  assert.equal((await call('POST', `/marketing/automations/${id}/status`, { token: tokens.mgr1, body: { status: 'ACTIVE' } })).status, 409, 'it needs approving first');
  await activate(id);

  const looped = await call('PATCH', `/marketing/automations/${id}`, { token: tokens.mgr1, body: { name: 'Farmer welcome v2' } });
  assert.equal(looped.status, 200, 'renaming an active automation is fine');
  assert.equal((await call('PATCH', `/marketing/automations/${id}`, { token: tokens.mgr1, body: { graph: { start: 'x', nodes: {} } } })).status, 409, 'changing its path needs a pause and a new approval');

  const joined = await call('POST', '/marketing/contacts', { token: tokens.mgr1, body: { email: 'mohan@village.in', first_name: 'Mohan', audience_ids: [ids.aud_farmers], basis: 'Asked at a field demo in Sehore' } });
  assert.equal(joined.status, 201);
  ids.mohan = joined.body.contact.id;
  await tick();
  assert.deepEqual(outboxTo('mohan@village.in').map((m) => m.subject), ['Welcome Mohan']);
  assert.equal(outboxTo('asha@farm.in').length, 0, 'Asha joined before it was switched on');

  const { rows: [enrollment] } = await query('SELECT * FROM mkt_enrollments WHERE workflow_id = $1 AND contact_id = $2', [id, ids.mohan]);
  assert.equal(enrollment.current_node, 'd1');
  // two days later
  const past = new Date(Date.now() - 60_000).toISOString();
  await query(`UPDATE mkt_enrollments SET next_run_at = $2, context = context || jsonb_build_object('wait_until', $3::text) WHERE id = $1`, [enrollment.id, past, past]);
  await tick();
  assert.deepEqual(outboxTo('mohan@village.in').map((m) => m.subject), ['Welcome Mohan', 'Did you see our welcome?'], 'he did not open, so he gets the reminder');
  const { rows: [done] } = await query('SELECT status FROM mkt_enrollments WHERE id = $1', [enrollment.id]);
  assert.equal(done.status, 'COMPLETED');
  const { rows: task } = await query(`SELECT t.title, t.assignee_id FROM mkt_followups f JOIN tasks t ON t.id = f.task_id WHERE f.workflow_id = $1`, [id]);
  assert.equal(task.length, 1);
  assert.equal(task[0].title, 'Call Mohan about soil testing');
  assert.equal(task[0].assignee_id, ids.mgr1);

  await tick();
  assert.equal(outboxTo('mohan@village.in').length, 2);
  // joining again does not start it again
  await call('DELETE', `/marketing/contacts/${ids.mohan}/audiences/${ids.aud_farmers}`, { token: tokens.mgr1 });
  await call('POST', `/marketing/contacts/${ids.mohan}/audiences`, { token: tokens.mgr1, body: { audience_id: ids.aud_farmers, basis: 'Asked again at the demo' } });
  await tick();
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM mkt_enrollments WHERE workflow_id = $1 AND contact_id = $2', [id, ids.mohan])).rows[0].n, 1);
  ids.welcome = id;
});

test('a new lead in TaskFlow starts an automation for the people at it', async (t) => {
  if (skipIfUnavailable(t)) return;
  const made = await call('POST', '/marketing/automations', {
    token: tokens.mgr1,
    body: {
      name: 'New lead nurture', trigger: { type: 'TASKFLOW_EVENT', event: 'LEAD_CREATED' },
      graph: { start: 'e1', nodes: { e1: { type: 'email', config: { subject: 'Thanks for your interest, {{first_name|}}', design: { blocks: [{ type: 'text', text: 'Here is how Soil Doctor works.' }] } }, next: null } } },
    },
  });
  await activate(made.body.automation.id);
  const org = await call('POST', '/accounts', { token: tokens.mgr1, body: { name: 'Sunrise Agro', type: 'LEAD', owner_user_id: ids.mgr2, department_id: ids.department } });
  await call('POST', `/accounts/${org.body.account.id}/contacts`, { token: tokens.mgr1, body: { full_name: 'Kavita Rao', email: 'kavita@sunrise.in' } });
  await tick();
  assert.deepEqual(outboxTo('kavita@sunrise.in').map((m) => m.subject), ['Thanks for your interest, Kavita']);
  await tick();
  assert.equal(outboxTo('kavita@sunrise.in').length, 1);
});

test('a festival greeting goes out on a confirmed date only, once per person', async (t) => {
  if (skipIfUnavailable(t)) return;
  const istToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const unconfirmed = await call('POST', '/marketing/festivals', { token: tokens.admin, body: { name: 'Unchecked Day', date: istToday } });
  const confirmed = await call('POST', '/marketing/festivals', { token: tokens.admin, body: { name: 'Test Festival', name_hi: 'परीक्षण पर्व', date: istToday, is_confirmed: true } });
  assert.equal(confirmed.status, 201);
  assert.equal((await call('POST', '/marketing/festivals', { token: tokens.mgr1, body: { name: 'X', date: istToday } })).status, 403, 'festival dates are set by an admin');
  const made = await call('POST', '/marketing/automations', {
    token: tokens.mgr1,
    body: {
      name: 'Festival greetings', audience_id: ids.aud_farmers,
      trigger: { type: 'FESTIVAL', festival_ids: [confirmed.body.festival.id, unconfirmed.body.festival.id], days_before: 0, send_hour: 0 },
      graph: { start: 'e1', nodes: { e1: { type: 'email', config: { subject: 'Happy {{festival}}', design: { blocks: [{ type: 'text', text: 'Warm wishes from EkoSight.' }] } }, next: null } } },
    },
  });
  await activate(made.body.automation.id);
  await tick();
  await tick();
  assert.deepEqual(outboxTo('asha@farm.in').map((m) => m.subject), ['Happy Test Festival']);
  assert.ok(outboxTo('mohan@village.in').some((m) => m.subject === 'Happy Test Festival'));
  assert.ok(!outbox().some((m) => m.subject === 'Happy Unchecked Day'), 'an unconfirmed date never sends');
  const cal = await call('GET', `/marketing/calendar?from=${istToday}&to=${istToday}`, { token: tokens.mgr1 });
  assert.ok(cal.body.festivals.some((f) => f.name === 'Test Festival'));
  assert.ok(cal.body.automations.some((a) => a.festival === 'Test Festival'));
});

test('the per-person limit holds back a campaign to someone already emailed today', async (t) => {
  if (skipIfUnavailable(t)) return;
  await call('PUT', '/marketing/settings', { token: tokens.admin, body: { limits: { perContactPerDay: 1, perContactPerWeek: 3, ratePerMinute: 600 } } });
  const created = await call('POST', '/marketing/campaigns', {
    token: tokens.mgr1, body: { name: 'Farmers newsletter', audience_id: ids.aud_farmers, subject: 'Newsletter', design: { blocks: [{ type: 'text', text: 'News.' }] } },
  });
  await approveAndSend(created.body.campaign.id);
  await tick();
  const mohan = await messageFor(created.body.campaign.id, 'mohan@village.in');
  assert.equal(mohan.status, 'SKIPPED');
  assert.equal(mohan.skip_reason, 'FREQUENCY_LIMIT');
  await call('PUT', '/marketing/settings', { token: tokens.admin, body: { limits: { perContactPerDay: 0, perContactPerWeek: 0, ratePerMinute: 600 } } });
});

test('test emails go to staff only, and their links change nothing', async (t) => {
  if (skipIfUnavailable(t)) return;
  const res = await call('POST', `/marketing/campaigns/${ids.campaign1}/test`, { token: tokens.mgr1, body: { emails: ['vartika@ekosight.com'], contact_id: ids.asha } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const mail = outboxTo('vartika@ekosight.com');
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /^\[Test\] /);
  const token = parseMime(mail[0].raw).html.match(/\/m\/u\/([A-Za-z0-9_-]+)/)[1];
  const page = await call('POST', `/m/u/${token}`, { body: 'action=unsubscribe_all', headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: true });
  assert.ok(page.text.includes('This was a test email'));
  assert.equal((await query('SELECT unsubscribed_all_at FROM mkt_contacts WHERE id = $1', [ids.asha])).rows[0].unsubscribed_all_at, null, 'the sample contact is untouched');
  const report = await call('GET', `/marketing/campaigns/${ids.campaign1}/report`, { token: tokens.mgr1 });
  assert.equal(report.body.totals.sent, 3, 'tests are not part of the campaign’s figures');
});

test('the writing assistant returns suggestions, and says so plainly when it is not set up', async (t) => {
  if (skipIfUnavailable(t)) return;
  const unset = await call('POST', '/marketing/ai', { token: tokens.mgr1, body: { task: 'subjects', text: 'Kharif soil testing offer' } });
  assert.equal(unset.status, 400);
  assert.match(unset.body.error || unset.body.message || JSON.stringify(unset.body), /ANTHROPIC_API_KEY/);
  let request = null;
  setAiClientForTests({ beta: { messages: { create: async (r) => { request = r; return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: '{"suggestions":["Test your soil before Kharif","Kharif is coming: is your soil ready?"]}' }] }; } } } });
  const ok = await call('POST', '/marketing/ai', { token: tokens.mgr1, body: { task: 'subjects', text: 'Kharif soil testing offer' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.suggestions.length, 2);
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.output_config.format.type, 'json_schema');
  setAiClientForTests({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } });
  assert.equal((await call('POST', '/marketing/ai', { token: tokens.mgr1, body: { task: 'rewrite', text: 'x' } })).status, 400);
  setAiClientForTests(null);
  assert.equal((await call('POST', '/marketing/ai', { token: tokens.member, body: { task: 'subjects', text: 'x' } })).status, 403);
});

test('contacts, segments and the overview answer from the same database', async (t) => {
  if (skipIfUnavailable(t)) return;
  const list = await call('GET', '/marketing/contacts?search=greenvalley', { token: tokens.mgr1 });
  assert.equal(list.body.total, 4);
  const segment = await call('POST', '/marketing/segments', {
    token: tokens.mgr1, body: { name: 'Indore dealers', rules: { match: 'all', conditions: [{ field: 'tag', op: 'has', value: 'dealer' }, { field: 'custom', key: 'district', op: 'is', value: 'indore' }] } },
  });
  assert.equal(segment.status, 201);
  const inSegment = await call('GET', `/marketing/contacts?segment_id=${segment.body.segment.id}`, { token: tokens.mgr1 });
  assert.deepEqual(inSegment.body.contacts.map((c) => c.email), ['d1@dealers.in']);
  const preview = await call('POST', '/marketing/segments/preview', { token: tokens.mgr1, body: { rules: { conditions: [{ field: 'crm_type', op: 'is', value: 'LEAD' }] } } });
  assert.ok(preview.body.count >= 5);
  const detail = await call('GET', `/marketing/contacts/${ids.ravi}`, { token: tokens.mgr1 });
  assert.ok(detail.body.events.some((e) => e.type === 'REPLY'));
  assert.ok(detail.body.followups.length === 1);
  const overview = await call('GET', '/marketing/overview', { token: tokens.mgr1 });
  assert.ok(overview.body.last30.sent >= 10);
  const exported = await call('GET', '/marketing/contacts/export.csv', { token: tokens.mgr1, raw: true });
  assert.equal(exported.status, 200);
  assert.ok(exported.text.includes('ravi@greenvalley.in'));
});

test('switching the module off hides the staff API but keeps unsubscribe links working', async (t) => {
  if (skipIfUnavailable(t)) return;
  await call('PUT', '/marketing/settings', { token: tokens.admin, body: { enabled: false } });
  assert.equal((await call('GET', '/marketing/overview', { token: tokens.mgr1 })).status, 404);
  const m = await messageFor(ids.campaignAb, 'd2@dealers.in');
  assert.equal((await call('GET', `/m/u/${m.token}`, { raw: true })).status, 200);
  await query(`UPDATE settings SET value = value || '{"enabled": true}'::jsonb WHERE key = 'marketing'`);
  assert.equal((await call('GET', '/marketing/overview', { token: tokens.mgr1 })).status, 200);
});
