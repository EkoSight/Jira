/**
 * Account emails (docs/ACCOUNT_EMAILS.md): a person's sign-in details when an
 * administrator creates their account or resets their password, a temporary
 * password from "Forgot password?", and "your password was changed".
 *
 * These are system emails, not marketing: they go through the email provider
 * the server already has, but no unsubscribe link, no marketing footer, no
 * marketing contact, no campaign figures and no consent check.
 *
 * A password is passed in only to be written into the one email. It is never
 * stored, logged, put in an error message or kept in `account_emails`.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { getSetting, getSettings } from './settings.js';
import { activeProvider, providerStatus } from './marketing/providers.js';
import { currentBranding } from './branding.js';
import { generateSignInPassword, hashPassword } from '../lib/password.js';
import { audit } from './attendance.js';

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const KINDS = ['WELCOME', 'RESET', 'FORGOT', 'PASSWORD_CHANGED', 'TEST'];

// ---------------------------------------------------------------- settings and readiness

export async function accountEmailSettings() {
  const s = (await getSetting('accountEmails')) || {};
  const hours = Number(s.expiryHours);
  return {
    senderName: String(s.senderName || 'TaskFlow').replace(/[\r\n]/g, ' ').slice(0, 80),
    senderEmail: String(s.senderEmail || '').trim(),
    replyTo: String(s.replyTo || '').trim(),
    expiryHours: Number.isFinite(hours) ? Math.min(168, Math.max(1, Math.round(hours))) : 24,
    forgotPassword: s.forgotPassword !== false,
  };
}

/**
 * Whether account emails can go out now and, when not, why, in words for the
 * screen. A production server set to "outbox only" counts as not set up: the
 * outbox would keep a password in memory and deliver nothing.
 */
export async function emailReadiness() {
  const settings = await accountEmailSettings();
  const status = providerStatus();
  let reason = null;
  if (!status.name) reason = 'No email service is set up on the server';
  else if (!status.configured) reason = `The email service is missing settings: ${status.missing.join(', ')}`;
  else if (status.name === 'log' && config.env === 'production') reason = 'The server only records emails (outbox only), so nothing would reach them';
  else if (!EMAIL_RE.test(settings.senderEmail)) reason = 'No sender address for account emails yet (Settings → Email)';
  else if (settings.replyTo && !EMAIL_RE.test(settings.replyTo)) reason = 'The reply-to address for account emails is not a valid email address';
  return {
    ready: !reason,
    reason,
    provider: status.name,
    provider_label: status.label,
    delivers: Boolean(status.delivers),
    missing: status.missing || [],
    settings,
  };
}

/** A new temporary password, its hash and when it stops working. */
export async function newTempPassword(now = new Date()) {
  const { expiryHours } = await accountEmailSettings();
  const password = generateSignInPassword();
  return { password, hash: await hashPassword(password), expiresAt: new Date(now.getTime() + expiryHours * 3600e3) };
}

// ---------------------------------------------------------------- the words

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

async function clockOf() {
  const all = await getSettings();
  return all.organisation?.timezone || 'Asia/Kolkata';
}
const whenWords = (date, timeZone) => {
  const d = new Date(date);
  const text = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value;
  return `${text}${zone ? ` (${timeZone === 'Asia/Kolkata' ? 'India time' : zone})` : ''}`;
};

/**
 * Each email as { subject, lines, password? }. A line is a paragraph; a
 * password is shown set apart. Kept as data so the HTML and the plain text
 * always say the same thing.
 */
export function accountEmailWords(kind, d) {
  const app = d.appName;
  const actor = d.actorName || 'Your administrator';
  const expiry = d.expiresAt ? `It works until ${d.expiresAt}.` : null;
  const own = 'When you sign in, you will choose your own password. This one then stops working.';
  switch (kind) {
    case 'WELCOME':
      return {
        subject: `Your ${app} account is ready`,
        heading: `${firstName(d.name)}, your ${app} account is ready.`,
        lines: [
          d.resend ? 'These sign-in details replace the ones sent to you earlier.' : null,
          `Sign in with your work email: ${d.email}`,
          d.password ? null : `${actor} will give you your password.`,
          d.password ? 'Your temporary password:' : null,
        ].filter(Boolean),
        password: d.password || null,
        after: [
          d.password ? expiry : null,
          d.password ? own : null,
          `${actor} created your account. If you need help, ask ${d.actorName || 'them'}.`,
          `If you weren't expecting this, tell ${d.actorName || 'your administrator'} or ignore this email.`,
        ].filter(Boolean),
      };
    case 'RESET':
      return {
        subject: `Your ${app} password was reset`,
        heading: `${firstName(d.name)}, your ${app} password was reset.`,
        lines: [
          `${actor} reset it on ${d.when}. Your old password no longer works, and you were signed out everywhere.`,
          `Sign in with your work email: ${d.email}`,
          'Your temporary password:',
        ],
        password: d.password,
        after: [expiry, own, `If you didn't ask for this, tell ${d.actorName || 'your administrator'}.`].filter(Boolean),
      };
    case 'FORGOT':
      return {
        subject: `Reset your ${app} password`,
        heading: `${firstName(d.name)}, here is a temporary password.`,
        lines: [
          `Someone asked to reset the ${app} password for ${d.email}. If it was you, sign in with this temporary password:`,
        ],
        password: d.password,
        after: [
          expiry,
          'Your current password keeps working too, until you use this one.',
          'When you sign in with it, you will choose a new password, and you will be signed out everywhere else.',
          "If you didn't ask for this, ignore this email: nothing changes.",
        ].filter(Boolean),
      };
    case 'PASSWORD_CHANGED':
      return {
        subject: `Your ${app} password was changed`,
        heading: `${firstName(d.name)}, your ${app} password was changed.`,
        lines: [`It was changed on ${d.when}, for ${d.email}.`],
        password: null,
        after: ["If this wasn't you, tell your administrator now."],
      };
    case 'TEST':
      return {
        subject: `${app} account emails: a test`,
        heading: 'This is a test.',
        lines: [
          `${actor} sent it from Settings → Email on ${d.when}.`,
          `Account emails (welcome, password reset, "your password was changed") will come from this address.`,
        ],
        password: null,
        after: ['It contains no password, and nothing was changed.'],
      };
    default:
      throw new Error(`Unknown account email: ${kind}`);
  }
}

/** The email in HTML and plain text, readable on a phone. */
export async function renderAccountEmail(kind, d) {
  const branding = await currentBranding();
  const words = accountEmailWords(kind, { ...d, appName: branding.appName });
  const signIn = `${config.publicUrl}/login`;
  const green = '#073F2A';
  const p = (t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#1f2933">${esc(t)}</p>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(words.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<tr><td style="background:${green};padding:16px 24px;color:#ffffff;font-size:17px;font-weight:700">${esc(branding.appName)}${branding.byline ? ` <span style="font-weight:400;opacity:.8;font-size:13px">${esc(branding.byline)}</span>` : ''}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827">${esc(words.heading)}</h1>
${words.lines.map(p).join('\n')}
${words.password ? `<div style="margin:0 0 16px;padding:14px 16px;border:1px solid #cfd8d3;border-radius:8px;background:#f6faf7;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:20px;letter-spacing:2px;color:#111827;text-align:center">${esc(words.password)}</div>` : ''}
${kind === 'TEST' || kind === 'PASSWORD_CHANGED' ? '' : `<p style="margin:0 0 18px"><a href="${esc(signIn)}" style="display:inline-block;background:${green};color:#ffffff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px">Sign in to ${esc(branding.appName)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#52606d">Or open: <a href="${esc(signIn)}" style="color:${green}">${esc(signIn)}</a></p>`}
${words.after.map(p).join('\n')}
<p style="margin:18px 0 0;font-size:12px;color:#7b8794">Never share your password. ${esc(branding.appName)} will never ask you for it by email or phone.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    words.heading,
    '',
    ...words.lines,
    ...(words.password ? ['', `    ${words.password}`, ''] : []),
    ...(kind === 'TEST' || kind === 'PASSWORD_CHANGED' ? [] : [`Sign in: ${signIn}`, '']),
    ...words.after,
    '',
    `Never share your password. ${branding.appName} will never ask you for it by email or phone.`,
  ].join('\n');
  return { subject: words.subject, html, text };
}

// ---------------------------------------------------------------- sending

const cleanError = (err, secret) => {
  let text = String(err?.message || err || 'The email service refused it').replace(/\s+/g, ' ').trim();
  if (secret) text = text.split(secret).join('•••');
  return text.slice(0, 300);
};

/**
 * Sends one account email and records it. Never throws for a delivery problem:
 * the result says { sent, status, reason }. `password`, when given, goes only
 * into the email.
 */
export async function sendAccountEmail({ kind, user, actor = null, password = null, expiresAt = null, resend = false, to = null }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown account email: ${kind}`);
  const readiness = await emailReadiness();
  const address = to || user.email;
  const record = (status, extra = {}) => query(
    `INSERT INTO account_emails (user_id, kind, to_address, triggered_by, status, provider, provider_message_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [user.id ?? null, kind, address, actor?.id ?? null, status, readiness.provider || null, extra.providerMessageId ?? null, extra.error ?? null],
  );
  if (!readiness.ready) {
    await record('NOT_SET_UP', { error: readiness.reason });
    return { sent: false, status: 'NOT_SET_UP', reason: readiness.reason, to: address };
  }
  const timeZone = await clockOf();
  const content = await renderAccountEmail(kind, {
    name: user.full_name,
    email: user.email,
    password,
    resend,
    actorName: actor?.full_name || null,
    when: whenWords(new Date(), timeZone),
    expiresAt: expiresAt ? whenWords(expiresAt, timeZone) : null,
  });
  const { settings } = readiness;
  try {
    const { providerMessageId } = await activeProvider().send({
      from: settings.senderEmail,
      fromName: settings.senderName,
      to: address,
      toName: user.full_name || undefined,
      replyTo: settings.replyTo || undefined,
      subject: content.subject,
      html: content.html,
      text: content.text,
      // "acct-" keeps these out of the marketing outbox, events and figures
      reference: `acct-${crypto.randomUUID()}`,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-TaskFlow-Kind': `account-${kind.toLowerCase()}` },
      system: true,
    });
    await record('SENT', { providerMessageId });
    return { sent: true, status: 'SENT', reason: null, to: address };
  } catch (err) {
    const reason = cleanError(err, password);
    await record('FAILED', { error: reason });
    return { sent: false, status: 'FAILED', reason, to: address };
  }
}

/** A person's account emails, newest first: what, when, whether it went, who sent it. */
export async function accountEmailsOf(userId, limit = 20) {
  const { rows } = await query(
    `SELECT e.id, e.kind, e.to_address, e.status, e.error, e.created_at, e.triggered_by, u.full_name AS triggered_by_name
       FROM account_emails e LEFT JOIN users u ON u.id = e.triggered_by
      WHERE e.user_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** Every open "Forgot password?" request of this person stops working. */
export async function cancelResetRequests(runner, userId) {
  await (runner || { query }).query(
    'UPDATE password_reset_requests SET cancelled_at = now() WHERE user_id = $1 AND used_at IS NULL AND cancelled_at IS NULL',
    [userId],
  );
}

// ---------------------------------------------------------------- "Forgot password?"

const pending = new Set();
/** Tests wait for the work that runs after "Forgot password?" has answered. */
export const forgotPasswordWork = () => Promise.all([...pending]);

/**
 * The work behind "Forgot password?", started after the page has answered, so
 * a known and an unknown address take the same time to answer. Nothing goes to
 * an unknown, deactivated or super admin account. The person's current
 * password is never touched here.
 */
export function startForgotPassword(email, ip) {
  const job = (async () => {
    const { rows: [user] } = await query(
      'SELECT id, full_name, email, role, is_active FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    );
    if (!user || !user.is_active || user.role === 'super_admin') return;
    const readiness = await emailReadiness();
    if (!readiness.ready) {
      await sendAccountEmail({ kind: 'FORGOT', user }); // records NOT_SET_UP, sends nothing
      return;
    }
    const issued = await newTempPassword();
    const requestId = await withTransaction(async (client) => {
      // only the newest request works
      await cancelResetRequests(client, user.id);
      const { rows } = await client.query(
        'INSERT INTO password_reset_requests (user_id, password_hash, expires_at, requested_ip) VALUES ($1, $2, $3, $4) RETURNING id',
        [user.id, issued.hash, issued.expiresAt, ip ? String(ip).slice(0, 64) : null],
      );
      return rows[0].id;
    });
    const result = await sendAccountEmail({ kind: 'FORGOT', user, password: issued.password, expiresAt: issued.expiresAt });
    if (!result.sent) {
      await query('UPDATE password_reset_requests SET cancelled_at = now() WHERE id = $1', [requestId]);
    }
    await audit(null, {
      entityType: 'USER_ACCESS', entityId: user.id, subjectUserId: user.id, actorId: null,
      action: 'PASSWORD_RESET_REQUESTED', after: { emailed: result.sent, status: result.status }, source: 'forgot_password',
    });
  })().catch((err) => {
    // the address and the reason only; there is no password to leak at this point
    console.error('[taskflow] forgot password:', err?.message || err);
  });
  pending.add(job);
  job.finally(() => pending.delete(job));
  return job;
}
