/**
 * The email providers TaskFlow can send through, and how each one's delivery
 * reports are read back.
 *
 *   log    records every message on the server and never delivers it — for
 *          development, tests and a staging site. Never the default in production.
 *   smtp   any SMTP service (Amazon SES SMTP, Zoho ZeptoMail, Google Workspace
 *          relay…). Sends only; SMTP has no delivery reports, so bounces and
 *          complaints are not seen unless the service also posts webhooks.
 *   ses    Amazon SES API v2 — the recommended choice: cheapest at volume, with
 *          delivery, bounce and complaint events through SNS.
 *   brevo  Brevo's transactional API, with its webhook events.
 *
 * Credentials come only from the server's environment. Nothing here returns
 * them; `status()` says only which are present.
 *
 * Every send result is { providerMessageId }. A failure throws a SendError
 * whose `transient` says whether trying again later could work.
 */

import crypto from 'node:crypto';
import { config } from '../../config.js';
import { signRequest } from '../../lib/awsSign.js';
import { buildMime } from '../../lib/mime.js';

export class SendError extends Error {
  constructor(message, { transient = false, code = null } = {}) {
    super(message);
    this.transient = transient;
    this.code = code;
  }
}

// ---------------------------------------------------------------- the outbox (log)

const OUTBOX = [];
export const outbox = () => OUTBOX;
export const clearOutbox = () => { OUTBOX.length = 0; };
// tests can make the next sends fail, to exercise retries
let failNext = [];
export const failNextSends = (errors) => { failNext = [...errors]; };

const logProvider = {
  name: 'log',
  label: 'Outbox only (nothing is delivered)',
  events: { delivery: false, bounce: false, complaint: false },
  missing: () => [],
  async send(message) {
    if (failNext.length) {
      const next = failNext.shift();
      throw new SendError(next.message || 'Simulated failure', { transient: next.transient !== false });
    }
    const { raw, messageId } = buildMime({ ...message, messageId: `<${crypto.randomUUID()}@outbox.taskflow>` });
    const providerMessageId = messageId.slice(1, -1);
    OUTBOX.push({ ...message, raw, providerMessageId, at: new Date().toISOString() });
    if (OUTBOX.length > 500) OUTBOX.shift();
    return { providerMessageId };
  },
};

// ---------------------------------------------------------------- SMTP

let smtpTransport = null;
const smtpProvider = {
  name: 'smtp',
  label: 'SMTP',
  events: { delivery: false, bounce: false, complaint: false },
  missing: () => {
    const s = config.email.smtp;
    return [!s.host && 'SMTP_HOST', !s.user && 'SMTP_USER', !s.password && 'SMTP_PASSWORD'].filter(Boolean);
  },
  async send(message) {
    const s = config.email.smtp;
    if (!smtpTransport) {
      const nodemailer = (await import('nodemailer')).default;
      smtpTransport = nodemailer.createTransport({
        host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.password },
        pool: true, maxConnections: 3,
      });
    }
    const { raw, messageId } = buildMime(message);
    try {
      await smtpTransport.sendMail({ envelope: { from: message.from, to: [message.to] }, raw });
      return { providerMessageId: messageId.slice(1, -1) };
    } catch (err) {
      const code = Number(err.responseCode);
      // 4xx is "try later"; 5xx is a refusal; no code is a connection problem
      throw new SendError(err.message, { transient: !code || (code >= 400 && code < 500), code: err.responseCode || err.code });
    }
  },
};

// ---------------------------------------------------------------- Amazon SES

const sesProvider = {
  name: 'ses',
  label: 'Amazon SES',
  events: { delivery: true, bounce: true, complaint: true },
  missing: () => {
    const s = config.email.ses;
    return [
      !s.accessKeyId && 'AWS_SES_ACCESS_KEY_ID',
      !s.secretAccessKey && 'AWS_SES_SECRET_ACCESS_KEY',
      !s.configurationSet && 'AWS_SES_CONFIGURATION_SET (needed for delivery, bounce and complaint events)',
    ].filter(Boolean);
  },
  async call(method, path, body, fetchImpl = fetch) {
    const s = config.email.ses;
    const host = `email.${s.region}.amazonaws.com`;
    const url = `https://${host}${path}`;
    const payload = body ? JSON.stringify(body) : '';
    const headers = signRequest({
      method, url, body: payload, region: s.region, service: 'ses',
      accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey,
      headers: { host, 'content-type': 'application/json' },
    });
    delete headers.__debug;
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: payload || undefined });
    } catch (err) {
      throw new SendError(`Could not reach Amazon SES: ${err.message}`, { transient: true });
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500;
      throw new SendError(`Amazon SES: ${data.message || data.Message || res.status}`, { transient, code: data.__type || res.status });
    }
    return data;
  },
  async send(message, { fetchImpl } = {}) {
    const s = config.email.ses;
    const { raw } = buildMime(message);
    const data = await this.call('POST', '/v2/email/outbound-emails', {
      FromEmailAddress: message.from,
      Destination: { ToAddresses: [message.to] },
      Content: { Raw: { Data: Buffer.from(raw, 'utf8').toString('base64') } },
      ...(s.configurationSet ? { ConfigurationSetName: s.configurationSet } : {}),
      // our own reference rides along on every event SES reports
      EmailTags: [{ Name: 'tf_message', Value: message.reference }],
    }, fetchImpl);
    return { providerMessageId: data.MessageId };
  },
  /** The domain's DKIM status as SES sees it. */
  async identity(domain) {
    const data = await this.call('GET', `/v2/email/identities/${encodeURIComponent(domain)}`);
    return {
      verified: data.VerifiedForSendingStatus === true,
      dkimStatus: data.DkimAttributes?.Status || null,
      dkimTokens: data.DkimAttributes?.Tokens || [],
      mailFrom: data.MailFromAttributes || null,
    };
  },
};

// ---------------------------------------------------------------- Brevo

const brevoProvider = {
  name: 'brevo',
  label: 'Brevo',
  events: { delivery: true, bounce: true, complaint: true },
  missing: () => [!config.email.brevo.apiKey && 'BREVO_API_KEY', !config.email.webhookSecret && 'EMAIL_WEBHOOK_SECRET (for its delivery events)'].filter(Boolean),
  async send(message, { fetchImpl = fetch } = {}) {
    const body = {
      sender: { email: message.from, ...(message.fromName ? { name: message.fromName } : {}) },
      to: [{ email: message.to, ...(message.toName ? { name: message.toName } : {}) }],
      ...(message.replyTo ? { replyTo: { email: message.replyTo } } : {}),
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
      headers: { ...message.headers, 'X-TaskFlow-Ref': message.reference },
      tags: [`tf-${message.reference}`.slice(0, 100)],
    };
    let res;
    try {
      res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': config.email.brevo.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SendError(`Could not reach Brevo: ${err.message}`, { transient: true });
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new SendError(`Brevo: ${data.message || res.status}`, { transient: res.status === 429 || res.status >= 500, code: data.code || res.status });
    return { providerMessageId: String(data.messageId || '').replace(/^<|>$/g, '') };
  },
};

const PROVIDERS = { log: logProvider, smtp: smtpProvider, ses: sesProvider, brevo: brevoProvider };

/** The provider in use. In production nothing is chosen for you. */
export function providerName() {
  const chosen = config.email.provider;
  if (chosen) return chosen;
  return config.env === 'production' ? '' : 'log';
}

export function activeProvider() {
  return PROVIDERS[providerName()] || null;
}

/** What the settings screen shows: never a credential, only whether each is present. */
export function providerStatus() {
  const name = providerName();
  const provider = PROVIDERS[name];
  if (!name) {
    return { name: null, label: 'Not set up', configured: false, missing: ['EMAIL_PROVIDER (ses, brevo or smtp)'], delivers: false, events: {} };
  }
  if (!provider) return { name, label: name, configured: false, missing: [`EMAIL_PROVIDER "${name}" is not one TaskFlow knows (ses, brevo, smtp, log)`], delivers: false, events: {} };
  const missing = provider.missing();
  return {
    name,
    label: provider.label,
    configured: missing.length === 0,
    missing,
    delivers: name !== 'log',
    events: provider.events,
    region: name === 'ses' ? config.email.ses.region : undefined,
    webhook: {
      ses: `${config.publicUrl}${config.apiPrefix}/m/webhooks/ses`,
      brevo: config.email.webhookSecret ? `${config.publicUrl}${config.apiPrefix}/m/webhooks/brevo/<EMAIL_WEBHOOK_SECRET>` : null,
    }[name] || null,
  };
}

// ---------------------------------------------------------------- reading delivery reports

/**
 * The normalised form every provider's report is turned into:
 *   { type, providerMessageId, reference, email, occurredAt, providerEventId, diagnostic, url, userAgent, ip }
 * type is one of DELIVERED, DEFERRED, BOUNCE_HARD, BOUNCE_SOFT, COMPLAINT, REJECTED.
 */

const SNS_CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const certCache = new Map();

async function fetchCert(url, fetchImpl = fetch) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !SNS_CERT_HOST.test(u.hostname) || !u.pathname.endsWith('.pem')) {
    throw new Error('The signing certificate is not from Amazon SNS');
  }
  if (certCache.has(url)) return certCache.get(url);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Could not fetch the SNS certificate (${res.status})`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

/** The exact text Amazon SNS signs, for its two message types. */
export function snsStringToSign(msg) {
  const keys = msg.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.filter((k) => msg[k] !== undefined && msg[k] !== null).map((k) => `${k}\n${msg[k]}\n`).join('');
}

/** Checks an SNS message really came from Amazon, signed by the certificate it names. */
export async function verifySns(msg, { getCert = fetchCert } = {}) {
  if (!msg || !msg.Signature || !msg.SigningCertURL) return false;
  const pem = await getCert(msg.SigningCertURL);
  const algorithm = String(msg.SignatureVersion) === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  return crypto.createVerify(algorithm).update(snsStringToSign(msg), 'utf8').verify(pem, msg.Signature, 'base64');
}

const sesType = (event) => {
  const kind = event.eventType || event.notificationType;
  switch (kind) {
    case 'Delivery': return 'DELIVERED';
    case 'DeliveryDelay': return 'DEFERRED';
    case 'Complaint': return 'COMPLAINT';
    case 'Reject': return 'REJECTED';
    case 'Bounce': return event.bounce?.bounceType === 'Permanent' ? 'BOUNCE_HARD' : 'BOUNCE_SOFT';
    default: return null; // Send, Open, Click: TaskFlow's own tracking covers these
  }
};

/** An SES event (inside an SNS notification) → normalised events, one per recipient. */
export function parseSesEvent(event, snsMessageId) {
  const type = sesType(event);
  if (!type) return [];
  const mail = event.mail || {};
  const tag = mail.tags?.tf_message?.[0] || null;
  const recipients = event.bounce?.bouncedRecipients?.map((r) => ({ email: r.emailAddress, diagnostic: r.diagnosticCode || r.status }))
    || event.complaint?.complainedRecipients?.map((r) => ({ email: r.emailAddress, diagnostic: event.complaint?.complaintFeedbackType }))
    || (event.delivery?.recipients || mail.destination || []).map((email) => ({ email, diagnostic: event.delivery?.smtpResponse || event.deliveryDelay?.delayType }));
  const occurredAt = event.bounce?.timestamp || event.complaint?.timestamp || event.delivery?.timestamp
    || event.deliveryDelay?.timestamp || mail.timestamp;
  return recipients.map((r) => ({
    type,
    providerMessageId: mail.messageId,
    reference: tag,
    email: String(r.email || '').replace(/^.*<|>.*$/g, ''),
    occurredAt,
    providerEventId: `ses:${snsMessageId}:${r.email}`,
    diagnostic: r.diagnostic || event.bounce?.bounceSubType || null,
  }));
}

const BREVO_TYPES = {
  delivered: 'DELIVERED', hard_bounce: 'BOUNCE_HARD', soft_bounce: 'BOUNCE_SOFT', blocked: 'REJECTED',
  spam: 'COMPLAINT', invalid_email: 'BOUNCE_HARD', deferred: 'DEFERRED', error: 'REJECTED',
};

/** A Brevo webhook body (one event, or a batch) → normalised events. */
export function parseBrevo(body) {
  const list = Array.isArray(body) ? body : [body];
  return list.map((e) => {
    const type = BREVO_TYPES[e.event];
    if (!type) return null;
    const ref = (e.tags || []).find((t) => String(t).startsWith('tf-'));
    return {
      type,
      providerMessageId: String(e['message-id'] || '').replace(/^<|>$/g, ''),
      reference: ref ? String(ref).slice(3) : null,
      email: e.email,
      // the epoch timestamp is unambiguous; the date string's timezone is not
      occurredAt: e.ts_event ? new Date(Number(e.ts_event) * 1000).toISOString() : (e.date ? new Date(String(e.date).replace(' ', 'T')).toISOString() : null),
      providerEventId: `brevo:${e['message-id'] || e.id}:${e.event}:${e.ts_event || e.ts || e.date || ''}`,
      diagnostic: e.reason || null,
    };
  }).filter(Boolean);
}

export const PROVIDER_LIST = Object.values(PROVIDERS).map((p) => ({ name: p.name, label: p.label, events: p.events }));
