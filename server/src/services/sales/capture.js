/**
 * Lead capture from outside: websites, ad platforms (through their own
 * webhooks or a connector such as Zapier or Make), other systems, and
 * TaskFlow's hosted form. One validated contract for all of them:
 *
 *   POST /api/taskflow/s/leads           Authorization: Bearer <capture key>
 *   POST /api/taskflow/s/hooks/<key>     the same, for systems that cannot set headers
 *   POST /api/taskflow/s/f/<form id>     the hosted form
 *
 * Keys are created in Settings and stored only as a hash. Every request is
 * rate limited; a retried request with the same idempotency key (or the same
 * external id from the same system) returns the lead it already made.
 */
import crypto from 'node:crypto';
import { query } from '../../db/pool.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { categoryFromInput } from './routing.js';
import { createLead } from './leads.js';
import { cleanText } from './core.js';

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

/** A new capture key: returned once, stored as a hash. */
export async function createCaptureKey({ name, source_id = null, campaign_id = null, entry_channel = 'API' }, actor) {
  const key = `tfk_${crypto.randomBytes(24).toString('base64url')}`;
  const { rows } = await query(
    `INSERT INTO crm_capture_keys (name, prefix, key_hash, source_id, campaign_id, entry_channel, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, prefix, source_id, campaign_id, entry_channel, created_at`,
    [String(name || 'Capture key').slice(0, 120), key.slice(0, 10), hashKey(key), source_id, campaign_id, entry_channel, actor.id],
  );
  return { ...rows[0], key };
}

export async function keyFromRequest(raw) {
  const key = String(raw || '').replace(/^Bearer\s+/i, '').trim();
  if (!key) throw unauthorized('A capture key is needed');
  const { rows } = await query(
    `SELECT * FROM crm_capture_keys WHERE key_hash = $1 AND is_active = TRUE AND revoked_at IS NULL`, [hashKey(key)],
  );
  if (!rows[0]) throw unauthorized('This capture key is not valid');
  await query('UPDATE crm_capture_keys SET last_used_at = now() WHERE id = $1', [rows[0].id]);
  return rows[0];
}

// ---------------------------------------------------------------- rate limiting

const buckets = new Map();
/** At most `limit` requests per `windowMs` per key; returns false when over. */
export function allow(key, limit = 60, windowMs = 60_000) {
  const now = Date.now();
  const b = buckets.get(key) || { start: now, count: 0 };
  if (now - b.start > windowMs) { b.start = now; b.count = 0; }
  b.count += 1;
  buckets.set(key, b);
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
  return b.count <= limit;
}

// ---------------------------------------------------------------- the contract

const FIELD_ALIASES = {
  organization_name: ['organization', 'organisation', 'organization_name', 'company', 'company_name', 'org', 'business', 'business_name'],
  contact_name: ['name', 'full_name', 'contact_name', 'contact', 'your_name', 'first_name'],
  last_name: ['last_name', 'surname'],
  designation: ['designation', 'job_title', 'title', 'role'],
  email: ['email', 'email_address', 'work_email', 'e_mail'],
  phone: ['phone', 'phone_number', 'mobile', 'mobile_number', 'whatsapp', 'contact_number'],
  website: ['website', 'company_website', 'url'],
  city: ['city', 'town', 'district'],
  state: ['state', 'region', 'province'],
  country: ['country'],
  enquiry: ['enquiry', 'inquiry', 'message', 'comments', 'query', 'description'],
  requirement: ['requirement', 'requirements', 'need', 'interest', 'product_interest'],
  category: ['category', 'lead_category', 'who', 'who_are_you', 'customer_type', 'type'],
  external_id: ['external_id', 'lead_id', 'id', 'leadgen_id'],
  source_system: ['source_system', 'platform', 'system'],
  source: ['source', 'lead_source'],
  campaign: ['campaign', 'campaign_name'],
  referral: ['referral', 'referred_by', 'referrer'],
  landing_page: ['landing_page', 'page_url', 'page'],
  idempotency_key: ['idempotency_key', 'submission_id'],
};

const pickField = (body, names) => {
  for (const n of names) {
    const v = body[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};

/** Turns a posted body (JSON or form fields, any common naming) into lead input. */
export function readCapture(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send the lead as a JSON object or form fields');
  const flat = { ...body, ...(typeof body.fields === 'object' && body.fields ? body.fields : {}) };
  const out = {};
  for (const [field, names] of Object.entries(FIELD_ALIASES)) {
    const v = pickField(flat, names);
    if (v !== undefined) out[field] = typeof v === 'string' ? v.trim() : v;
  }
  if (out.last_name && out.contact_name && !String(out.contact_name).includes(' ')) out.contact_name = `${out.contact_name} ${out.last_name}`;
  delete out.last_name;
  const utm = typeof flat.utm === 'object' && flat.utm ? flat.utm : {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = flat[`utm_${k}`] ?? utm[k];
    if (v) utm[k] = String(v).slice(0, 200);
  }
  out.utm = utm;
  out.category = categoryFromInput(out.category);
  const consent = flat.consent;
  if (consent !== undefined) {
    out.consent = typeof consent === 'object' ? { given: Boolean(consent.given ?? true), text: cleanText(consent.text, 1000), at: consent.at || new Date().toISOString() }
      : { given: ['1', 'true', 'yes', 'on'].includes(String(consent).toLowerCase()), at: new Date().toISOString() };
  }
  if (Array.isArray(flat.tags)) out.tags = flat.tags.map((t) => String(t).slice(0, 40)).slice(0, 10);
  for (const [k, v] of Object.entries(out)) if (typeof v === 'string' && v.length > 5000) out[k] = v.slice(0, 5000);
  return out;
}

/** Captures from an authenticated system. */
export async function captureWithKey(keyRow, body, { ip = null } = {}) {
  if (!allow(`key:${keyRow.id}`, 120)) {
    const err = new Error('Too many leads from this key in the last minute; slow down and retry');
    err.status = 429;
    throw err;
  }
  const input = readCapture(body);
  if (!input.source && keyRow.source_id) input.source_id = keyRow.source_id;
  if (!input.campaign && keyRow.campaign_id) input.campaign_id = keyRow.campaign_id;
  const idem = input.idempotency_key ? `key:${keyRow.id}:${String(input.idempotency_key).slice(0, 200)}` : null;
  delete input.idempotency_key;
  const { lead, created, duplicate } = await createLead(input, {
    channel: keyRow.entry_channel || 'API', sourceSystem: input.source_system || keyRow.name, idempotencyKey: idem, origin: 'INTEGRATION',
  });
  void ip;
  return { lead, created, duplicate };
}

// ---------------------------------------------------------------- the hosted form

export const FORM_WHO = [
  ['B2B_CORPORATE', 'A company or institution'],
  ['CSR_NGO', 'A CSR team, foundation or NGO'],
  ['RETAILER', 'A retailer or dealer'],
  ['FPO', 'A farmer producer organization (FPO)'],
  ['INDIVIDUAL', 'A farmer or individual'],
];

export async function getForm(publicId) {
  const { rows } = await query('SELECT * FROM crm_capture_forms WHERE public_id = $1 AND is_active = TRUE', [publicId]);
  return rows[0] || null;
}

export async function submitForm(form, body, { ip = null } = {}) {
  if (!allow(`form:${form.id}:${ip || 'unknown'}`, 10)) {
    const err = new Error('Too many submissions; try again in a minute');
    err.status = 429;
    throw err;
  }
  // bots fill the hidden field
  if (body.website_url_confirm) return { ignored: true };
  const input = readCapture(body);
  if (form.consent_text && !['1', 'true', 'on', 'yes'].includes(String(body.consent || '').toLowerCase())) {
    throw badRequest('Please tick the box to say we may contact you');
  }
  input.consent = form.consent_text ? { given: true, text: form.consent_text, at: new Date().toISOString(), channel: 'FORM', ip } : (input.consent || {});
  input.source_id = form.source_id;
  input.campaign_id = form.campaign_id;
  const idem = body.submission_id ? `form:${form.id}:${String(body.submission_id).slice(0, 100)}` : null;
  const result = await createLead(input, { channel: 'FORM', sourceSystem: `form:${form.public_id}`, idempotencyKey: idem, origin: 'INTEGRATION' });
  if (result.created) await query('UPDATE crm_capture_forms SET submissions = submissions + 1 WHERE id = $1', [form.id]);
  return result;
}
