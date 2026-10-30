import express, { Router } from 'express';
import { asyncHandler } from '../lib/errors.js';
import { escapeHtml as e } from '../lib/emailRender.js';
import { page } from '../services/marketing/publicPages.js';
import { FORM_WHO, captureWithKey, getForm, keyFromRequest, submitForm } from '../services/sales/capture.js';

/**
 * What the outside world reaches for the sales CRM, with no sign-in: lead
 * capture by key, webhooks, and the hosted enquiry form. Provider webhooks
 * (calls, WhatsApp) are added by their own modules. Mounted before
 * authentication.
 */
const router = Router();

const json = express.json({ limit: '256kb' });
const form = express.urlencoded({ extended: false, limit: '64kb' });

const accepted = (res, { lead, created, duplicate }) => res.status(created ? 201 : 200).json({
  status: created ? 'accepted' : 'already_received',
  ref: lead.ref,
  // where it went, so the sending system can report it; never a promise that anyone was contacted
  routed_to: lead.destination,
  duplicate: duplicate || null,
});

const fail = (res, err) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status >= 500 ? 'The lead could not be stored; retry with the same idempotency key' : err.message, fields: err.details?.fields });
};

/** POST /s/leads — Authorization: Bearer <capture key> (or X-TaskFlow-Key). */
router.post('/leads', json, form, async (req, res) => {
  try {
    const key = await keyFromRequest(req.get('authorization') || req.get('x-taskflow-key'));
    accepted(res, await captureWithKey(key, req.body, { ip: req.ip }));
  } catch (err) {
    fail(res, err);
  }
});

/** POST /s/hooks/<key> — for systems that cannot set a header. */
router.post('/hooks/:key', json, form, async (req, res) => {
  try {
    const key = await keyFromRequest(req.params.key);
    accepted(res, await captureWithKey(key, req.body, { ip: req.ip }));
  } catch (err) {
    fail(res, err);
  }
});

const html = (res, status, body) => {
  res.status(status);
  res.set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; form-action 'self'; frame-ancestors 'self' https:; base-uri 'none'",
  });
  res.send(body);
};

const FIELD_LABEL = { designation: 'Your role', website: 'Website', city: 'City', state: 'State', requirement: 'What do you need?' };

function formHtml(f, { error = null, values = {} } = {}) {
  const optional = Array.isArray(f.fields) ? f.fields : [];
  const input = (name, label, type = 'text', required = false) => `<label class="field"><span>${e(label)}${required ? ' *' : ''}</span>
    <input type="${type}" name="${name}" value="${e(values[name] ?? '')}" ${required ? 'required' : ''} autocomplete="on"></label>`;
  return page({
    title: f.title,
    body: `<h1>${e(f.title)}</h1>${f.intro ? `<p class="muted">${e(f.intro)}</p>` : ''}
${error ? `<div class="notice" role="alert">${e(error)}</div>` : ''}
<form method="post" action="./${encodeURIComponent(f.public_id)}">
  ${input('organization', 'Organization')}
  ${input('name', 'Your name', 'text', true)}
  ${input('email', 'Email', 'email')}
  ${input('phone', 'Phone', 'tel')}
  ${optional.filter((k) => k !== 'requirement').map((k) => input(k, FIELD_LABEL[k] || k)).join('')}
  <fieldset class="field" style="border:0;padding:0;margin:0 0 14px"><span>Who are you? *</span>
    ${FORM_WHO.map(([v, l]) => `<label class="row"><input type="radio" name="who" value="${v}" ${values.who === v ? 'checked' : ''} required><span>${e(l)}</span></label>`).join('')}
  </fieldset>
  <label class="field"><span>${e(FIELD_LABEL.requirement)}</span><textarea name="requirement" rows="4" style="width:100%;padding:12px 14px;border:1px solid var(--line-strong);border-radius:14px;font:inherit">${e(values.requirement ?? '')}</textarea></label>
  ${f.consent_text ? `<label class="row"><input type="checkbox" name="consent" value="1" required><span>${e(f.consent_text)}</span></label>` : ''}
  <div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website_url_confirm" tabindex="-1" autocomplete="off"></label></div>
  <input type="hidden" name="submission_id" value="${e(values.submission_id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)}">
  <div class="actions"><button class="primary" type="submit">Send</button></div>
</form>`,
  });
}

router.get('/f/:publicId', asyncHandler(async (req, res) => {
  const f = await getForm(String(req.params.publicId));
  if (!f) return html(res, 404, page({ title: 'Form not found', body: '<h1>This form is not available</h1>' }));
  return html(res, 200, formHtml(f));
}));

router.post('/f/:publicId', form, json, asyncHandler(async (req, res) => {
  const f = await getForm(String(req.params.publicId));
  if (!f) return html(res, 404, page({ title: 'Form not found', body: '<h1>This form is not available</h1>' }));
  const body = { ...req.body, category: req.body.who || req.body.category };
  try {
    await submitForm(f, body, { ip: req.ip });
  } catch (err) {
    if ((err.status || err.statusCode) && (err.status || err.statusCode) < 500) return html(res, err.status || err.statusCode, formHtml(f, { error: err.message, values: req.body }));
    throw err;
  }
  // the same thanks for every kind of enquiry: where it is routed is internal
  return html(res, 200, page({ title: 'Thank you', body: `<h1>Thank you</h1><p>${e(f.success_message || 'We have your enquiry and will be in touch soon.')}</p>` }));
}));

export default router;
