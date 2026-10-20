import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';

import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler } from '../lib/errors.js';
import { applyMerge } from '../lib/emailRender.js';
import { marketingSettings } from '../services/marketing/core.js';
import { confirmMembership, setTopics, unsubscribe } from '../services/marketing/audiences.js';
import { recordConversion, recordEvent } from '../services/marketing/events.js';
import { parseBrevo, parseSesEvent, verifySns } from '../services/marketing/providers.js';
import { formPage, messagePage, preferencesPage, unsubscribedPage, wordsFor } from '../services/marketing/publicPages.js';
import { publicForm, submitForm } from '../services/marketing/forms.js';
import { readAsset } from '../services/marketing/templates.js';
import { handleReply, normalizeInbound } from '../services/marketing/replies.js';
import { BRAND_FILES } from '../lib/brand.js';

const BRAND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/brand');

/**
 * Everything people and services outside TaskFlow reach, with no sign-in:
 * the open image and link redirect in emails, the preference and unsubscribe
 * pages, confirmation links, signup forms, email images, and the reports
 * providers send back. Mounted before authentication.
 *
 * Nothing here reveals who a token belongs to beyond the person's own first
 * name on their own preference page, and every token is random and long.
 */
const router = Router();

const form = express.urlencoded({ extended: false, limit: '64kb' });
const json = express.json({ limit: '2mb' });
const text = express.text({ type: () => true, limit: '2mb' });

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

const clientIp = (req) => String(req.ip || '').slice(0, 64) || null;
const ua = (req) => String(req.get('user-agent') || '').slice(0, 300) || null;

const html = (res, status, body) => {
  res.status(status);
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // the pages carry no scripts and are never framed; the brand fonts come from Google Fonts
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.send(body);
};

async function messageByToken(token) {
  if (!TOKEN.test(String(token || ''))) return null;
  const { rows } = await query('SELECT * FROM mkt_messages WHERE token = $1', [token]);
  return rows[0] || null;
}

// ---------------------------------------------------------------- opens and clicks

router.get('/o/:file', asyncHandler(async (req, res) => {
  const token = String(req.params.file).replace(/\.gif$/, '');
  try {
    const message = await messageByToken(token);
    if (message && message.sent_at) {
      await recordEvent({ type: 'OPEN', messageId: message.id, source: 'TRACKING', ip: clientIp(req), userAgent: ua(req) });
    }
  } catch (err) {
    console.error('[taskflow] email marketing: recording an open failed:', err.message);
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' });
  res.send(GIF);
}));

/** Adds the campaign reference so the website can report a conversion against this click. */
function destination(url, message, contact, campaign) {
  let target = applyMerge(url, contact ? { ...contact, custom: contact.custom || {} } : {}, { mode: 'url' });
  try {
    const u = new URL(target);
    if (!['http:', 'https:'].includes(u.protocol)) return target;
    if (!u.searchParams.has('utm_source')) {
      u.searchParams.set('utm_source', 'taskflow');
      u.searchParams.set('utm_medium', 'email');
      if (campaign) u.searchParams.set('utm_campaign', campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60));
    }
    if (message && ['CAMPAIGN', 'AUTOMATION'].includes(message.kind)) u.searchParams.set('tf_ref', message.reply_code);
    target = u.toString();
  } catch {
    // not a URL we can add to; send them where it points
  }
  return target;
}

router.get('/c/:token/:linkId', asyncHandler(async (req, res) => {
  const linkId = Number(req.params.linkId);
  const message = await messageByToken(req.params.token);
  if (!message || !Number.isInteger(linkId)) return html(res, 404, messagePage({ title: 'Link not found', text: 'This link is not valid.' }));
  // only to a link that is in the email itself: never an open redirect
  const { rows } = await query(
    `SELECT * FROM mkt_links WHERE id = $1 AND (($2::int IS NOT NULL AND campaign_id = $2) OR ($3::int IS NOT NULL AND workflow_id = $3))`,
    [linkId, message.campaign_id, message.workflow_id],
  );
  const link = rows[0];
  if (!link) return html(res, 404, messagePage({ title: 'Link not found', text: 'This link is not valid.' }));
  const [{ rows: contacts }, { rows: campaigns }] = await Promise.all([
    message.contact_id && message.kind !== 'TEST' ? query('SELECT * FROM mkt_contacts WHERE id = $1', [message.contact_id]) : { rows: [] },
    message.campaign_id ? query('SELECT id, name FROM mkt_campaigns WHERE id = $1', [message.campaign_id]) : { rows: [] },
  ]);
  try {
    await recordEvent({ type: 'CLICK', messageId: message.id, linkId: link.id, url: link.url, source: 'TRACKING', ip: clientIp(req), userAgent: ua(req) });
  } catch (err) {
    console.error('[taskflow] email marketing: recording a click failed:', err.message);
  }
  res.set('Cache-Control', 'no-store');
  res.redirect(302, destination(link.url, message, contacts[0], campaigns[0]));
}));

// ---------------------------------------------------------------- preferences and unsubscribing

async function preferenceData(message) {
  const contactId = message.contact_id;
  const [{ rows: contacts }, { rows: memberships }, { rows: topics }, { rows: audiences }] = await Promise.all([
    query('SELECT * FROM mkt_contacts WHERE id = $1', [contactId]),
    query(`SELECT m.audience_id, m.status, a.name AS audience_name, a.purpose FROM mkt_memberships m JOIN mkt_audiences a ON a.id = m.audience_id
            WHERE m.contact_id = $1 ORDER BY a.name`, [contactId]),
    query(`SELECT t.id, t.name, t.name_hi, t.description, COALESCE(ct.opted_in, TRUE) AS opted_in FROM mkt_topics t
             LEFT JOIN mkt_contact_topics ct ON ct.topic_id = t.id AND ct.contact_id = $1 WHERE t.is_active ORDER BY t.position`, [contactId]),
    message.audience_id ? query('SELECT id, name FROM mkt_audiences WHERE id = $1', [message.audience_id]) : { rows: [] },
  ]);
  return { contact: contacts[0], memberships, topics, currentAudience: audiences[0] || null };
}

async function audienceOf(message) {
  if (message.audience_id) return message.audience_id;
  if (message.workflow_id) {
    const { rows } = await query('SELECT audience_id FROM mkt_workflows WHERE id = $1', [message.workflow_id]);
    return rows[0]?.audience_id || null;
  }
  return null;
}

const testPage = (settings) => messagePage({
  title: 'This was a test email', text: 'Unsubscribe links in test emails do not change anything.', company: settings.company,
});

// a mail app or scanner fetching the one-click address changes nothing
router.get('/u/:token/one-click', (req, res) => res.redirect(302, `../${encodeURIComponent(req.params.token)}`));

router.get('/u/:token', asyncHandler(async (req, res) => {
  const settings = await marketingSettings();
  const message = await messageByToken(req.params.token);
  if (!message) return html(res, 404, messagePage({ title: 'Link not valid', text: wordsFor('en').notFound, company: settings.company }));
  if (message.kind === 'TEST' || !message.contact_id) return html(res, 200, testPage(settings));
  const data = await preferenceData(message);
  if (!data.contact) return html(res, 404, messagePage({ title: 'Link not valid', text: wordsFor('en').notFound, company: settings.company }));
  html(res, 200, preferencesPage({ token: message.token, ...data, lang: data.contact.language, company: settings.company, saved: req.query.saved === '1' }));
}));

async function recordUnsubscribe(message, req, via) {
  await recordEvent({
    type: 'UNSUBSCRIBE', messageId: message.id, source: 'TRACKING', ip: clientIp(req), userAgent: ua(req),
    providerEventId: `unsub:${message.id}:${via}`, meta: { via },
  });
}

/** RFC 8058 one-click: the mail app's own Unsubscribe button. No page, no questions. */
router.post('/u/:token/one-click', form, text, asyncHandler(async (req, res) => {
  const message = await messageByToken(req.params.token);
  if (!message || message.kind === 'TEST' || !message.contact_id) return res.status(200).type('text/plain').send('OK');
  const audienceId = await audienceOf(message);
  await withTransaction(async (client) => {
    await unsubscribe(client, message.contact_id, {
      audienceId, all: !audienceId, source: 'ONE_CLICK', reason: 'One-click unsubscribe from the mail app', ip: clientIp(req), userAgent: ua(req), messageId: message.id,
    });
  });
  await recordUnsubscribe(message, req, 'one-click');
  res.status(200).type('text/plain').send('You are unsubscribed.');
}));

/** The preference page's buttons. */
router.post('/u/:token', form, asyncHandler(async (req, res) => {
  const settings = await marketingSettings();
  const message = await messageByToken(req.params.token);
  if (!message) return html(res, 404, messagePage({ title: 'Link not valid', text: wordsFor('en').notFound, company: settings.company }));
  if (message.kind === 'TEST' || !message.contact_id) return html(res, 200, testPage(settings));
  const data = await preferenceData(message);
  if (!data.contact) return html(res, 404, messagePage({ title: 'Link not valid', text: wordsFor('en').notFound, company: settings.company }));
  const body = req.body || {};
  const action = String(body.action || 'save');
  const ctx = { ip: clientIp(req), userAgent: ua(req), messageId: message.id };
  const lang = data.contact.language;

  if (action === 'unsubscribe_all') {
    await unsubscribe(null, message.contact_id, { all: true, source: 'PREFERENCES', reason: 'Unsubscribed from everything on the preference page', ...ctx });
    await recordUnsubscribe(message, req, 'all');
    return html(res, 200, unsubscribedPage({ all: true, lang, company: settings.company }));
  }
  if (action === 'unsubscribe_audience' && data.currentAudience) {
    await unsubscribe(null, message.contact_id, { audienceId: data.currentAudience.id, source: 'PREFERENCES', reason: 'Unsubscribed on the preference page', ...ctx });
    await recordUnsubscribe(message, req, 'audience');
    return html(res, 200, unsubscribedPage({ all: false, audience: data.currentAudience.name, lang, company: settings.company }));
  }

  // save: unticked lists are left, topics as ticked, and the language
  let left = 0;
  await withTransaction(async (client) => {
    for (const m of data.memberships.filter((x) => ['SUBSCRIBED', 'PENDING'].includes(x.status))) {
      if (!body[`audience_${m.audience_id}`]) {
        await unsubscribe(client, message.contact_id, { audienceId: m.audience_id, source: 'PREFERENCES', reason: 'Unticked on the preference page', ...ctx });
        left += 1;
      }
    }
    await setTopics(client, message.contact_id, Object.fromEntries(data.topics.map((t) => [t.id, Boolean(body[`topic_${t.id}`])])), { source: 'PREFERENCES', ip: ctx.ip, userAgent: ctx.userAgent });
    if (['en', 'hi'].includes(body.language) && body.language !== data.contact.language) {
      await client.query('UPDATE mkt_contacts SET language = $2, updated_at = now() WHERE id = $1', [message.contact_id, body.language]);
    }
  });
  if (left) await recordUnsubscribe(message, req, 'preferences');
  res.redirect(303, `./${encodeURIComponent(message.token)}?saved=1`);
}));

// ---------------------------------------------------------------- double opt-in

router.get('/confirm/:token', asyncHandler(async (req, res) => {
  const settings = await marketingSettings();
  const token = String(req.params.token || '');
  const result = TOKEN.test(token) ? await confirmMembership(token, { ip: clientIp(req), userAgent: ua(req) }) : { ok: false, reason: 'This confirmation link is not valid.' };
  if (!result.ok) return html(res, 400, messagePage({ title: 'Not confirmed', text: result.reason, company: settings.company }));
  html(res, 200, messagePage({
    title: 'You are subscribed',
    text: `Thank you — you will now get emails from ${settings.company} on ${result.audience}. Every email has a link to change your choices or unsubscribe.`,
    company: settings.company,
  }));
}));

// ---------------------------------------------------------------- signup forms

router.get('/f/:publicId', asyncHandler(async (req, res) => {
  const settings = await marketingSettings();
  const loaded = await publicForm(String(req.params.publicId).slice(0, 40));
  if (!loaded) return html(res, 404, messagePage({ title: 'Form not found', text: 'This signup form is not available.', company: settings.company }));
  html(res, 200, formPage({ form: loaded.form, fields: loaded.form.fields, topics: loaded.topics, lang: loaded.form.language, company: settings.company }));
}));

router.post('/f/:publicId', form, json, asyncHandler(async (req, res) => {
  const settings = await marketingSettings();
  const publicId = String(req.params.publicId).slice(0, 40);
  const wantsJson = req.is('application/json') || /application\/json/.test(req.get('accept') || '');
  const result = await submitForm(publicId, req.body || {}, { ip: clientIp(req), userAgent: ua(req) });
  if (result.notFound) return wantsJson ? res.status(404).json({ ok: false }) : html(res, 404, messagePage({ title: 'Form not found', text: 'This signup form is not available.', company: settings.company }));
  if (wantsJson) {
    return res.status(result.ok ? 200 : 400).json({ ok: result.ok, status: result.status || null, error: result.error || null });
  }
  if (!result.ok) {
    const loaded = await publicForm(publicId);
    return html(res, 400, formPage({ form: loaded.form, fields: loaded.form.fields, topics: loaded.topics, lang: loaded.form.language, company: settings.company, error: result.error, values: req.body || {} }));
  }
  const f = result.form || (await publicForm(publicId))?.form;
  if (f?.redirect_url) return res.redirect(303, f.redirect_url);
  const hi = f?.language === 'hi';
  const pending = result.status === 'PENDING';
  html(res, 200, messagePage({
    title: pending ? (hi ? 'अपना ईमेल देखें' : 'Check your email') : (hi ? 'धन्यवाद!' : 'Thank you!'),
    text: f?.success_message || (pending
      ? (hi ? 'हमने आपको एक पुष्टि ईमेल भेजा है। सदस्यता पूरी करने के लिए उसमें दिए लिंक पर क्लिक करें।' : 'We have sent you an email. Click the link in it to finish subscribing.')
      : (hi ? 'आपकी सदस्यता हो गई है।' : 'You are subscribed.')),
    lang: f?.language, company: settings.company,
  }));
}));

// ---------------------------------------------------------------- images in emails

/** The Soil Doctor logo, strata dot, pulse divider and watermark every email uses. */
router.get('/brand/:file', (req, res) => {
  const file = String(req.params.file);
  if (!BRAND_FILES.includes(file)) return res.status(404).end();
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  return fs.createReadStream(path.join(BRAND_DIR, file)).on('error', () => res.status(404).end()).pipe(res);
});

router.get('/a/:publicId/:name', asyncHandler(async (req, res) => {
  const asset = /^[A-Za-z0-9_-]{8,40}$/.test(req.params.publicId) ? await readAsset(req.params.publicId) : null;
  if (!asset) return res.status(404).end();
  res.set({ 'Content-Type': asset.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  res.send(asset.data);
}));

// ---------------------------------------------------------------- provider reports

async function applyProviderEvents(events, source) {
  let recorded = 0;
  for (const e of events) {
    const out = await recordEvent({
      type: e.type, reference: e.reference, providerMessageId: e.providerMessageId, email: e.email, source,
      providerEventId: e.providerEventId, occurredAt: e.occurredAt, meta: { diagnostic: e.diagnostic || null },
    });
    if (out.recorded) recorded += 1;
  }
  return recorded;
}

/** Amazon SES, through an SNS topic: every message is signature-checked. */
router.post('/webhooks/ses', text, asyncHandler(async (req, res) => {
  let msg;
  try { msg = JSON.parse(typeof req.body === 'string' ? req.body : '{}'); } catch { return res.status(400).end(); }
  const topic = config.email.ses.snsTopicArn;
  if (!topic || msg.TopicArn !== topic) return res.status(403).end();
  let valid = false;
  try { valid = await verifySns(msg); } catch (err) { console.error('[taskflow] email marketing: SNS check failed:', err.message); }
  if (!valid) return res.status(403).end();

  if (msg.Type === 'SubscriptionConfirmation') {
    const confirm = new URL(msg.SubscribeURL);
    if (confirm.protocol === 'https:' && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(confirm.hostname)) {
      await fetch(confirm.toString()).catch((err) => console.error('[taskflow] email marketing: confirming the SNS subscription failed:', err.message));
      console.log('[taskflow] email marketing: confirmed the SNS subscription for SES events');
    }
    return res.status(200).end();
  }
  if (msg.Type !== 'Notification') return res.status(200).end();
  let event;
  try { event = JSON.parse(msg.Message); } catch { return res.status(200).end(); }
  await applyProviderEvents(parseSesEvent(event, msg.MessageId), 'PROVIDER:ses');
  res.status(200).end();
}));

const sameSecret = (given, expected) => {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Brevo transactional webhooks, at an address that carries the shared secret. */
router.post('/webhooks/brevo/:secret', json, asyncHandler(async (req, res) => {
  if (!sameSecret(req.params.secret, config.email.webhookSecret)) return res.status(403).end();
  const recorded = await applyProviderEvents(parseBrevo(req.body), 'PROVIDER:brevo');
  res.json({ ok: true, recorded });
}));

/** Replies posted by an inbound mail service (Postmark, Mailgun, SendGrid…). */
router.post('/inbound/:key', json, form, asyncHandler(async (req, res) => {
  if (!sameSecret(req.params.key, config.email.inboundKey)) return res.status(403).end();
  const reply = normalizeInbound(req.body || {});
  const result = await handleReply({ ...reply, source: 'INBOUND' });
  res.json({ ok: true, matched: result.matched, recorded: Boolean(result.recorded) });
}));

/**
 * A conversion on the website: { ref: <tf_ref from the link>, email, value, label, id }.
 * Called by the website's server with the X-TaskFlow-Key header — never from
 * the browser, where the key would be visible to anyone.
 */
router.post('/conversions', json, asyncHandler(async (req, res) => {
  const key = req.get('x-taskflow-key') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!sameSecret(key, config.email.conversionKey)) return res.status(403).json({ ok: false });
  const b = req.body || {};
  const value = b.value === undefined || b.value === null || b.value === '' ? null : Number(b.value);
  if (value !== null && !(Number.isFinite(value) && value >= 0)) return res.status(400).json({ ok: false, error: 'value must be a number' });
  const result = await recordConversion({
    ref: b.ref ? String(b.ref).slice(0, 40) : null, email: b.email ? String(b.email).slice(0, 320) : null, value,
    label: b.label ? String(b.label).slice(0, 200) : null, source: 'API', externalId: b.id ? String(b.id).slice(0, 100) : null,
  });
  res.json({ ok: true, recorded: Boolean(result.recorded), reason: result.reason || null });
}));

export default router;
