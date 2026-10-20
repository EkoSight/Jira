/**
 * Signup forms: hosted at a public address, or pasted into a website.
 *
 * A submission needs the consent box ticked; the words they agreed to, the
 * time, their IP address and browser are kept in the consent record. Where
 * the audience asks for double opt-in, they are not mailed until they click
 * the link in the confirmation email. A hidden field catches most bots, and
 * each address and IP can only submit so often.
 */

import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { isValidEmail, logContactActivity, publicBase } from './core.js';
import { upsertContact } from './contacts.js';
import { addToAudience, mustConfirm, setTopics } from './audiences.js';
import { queueConfirmation } from './queue.js';

const STANDARD_FIELDS = ['email', 'first_name', 'last_name', 'phone', 'organization', 'designation', 'city', 'state'];

export const DEFAULT_CONSENT = {
  en: 'I agree to receive emails from EkoSight / Soil Doctor about the topics I chose. I can unsubscribe at any time.',
  hi: 'मैं चुने गए विषयों पर EkoSight / Soil Doctor से ईमेल प्राप्त करने के लिए सहमत हूँ। मैं कभी भी सदस्यता समाप्त कर सकता/सकती हूँ।',
};

export async function listForms() {
  const { rows } = await query(
    `SELECT f.*, a.name AS audience_name FROM mkt_forms f JOIN mkt_audiences a ON a.id = f.audience_id ORDER BY f.created_at DESC`,
  );
  return rows.map((f) => ({ ...f, url: `${publicBase()}/f/${f.public_id}` }));
}

function cleanFields(fields, customFields) {
  const known = new Map(customFields.map((f) => [`custom.${f.key}`, f]));
  const list = [];
  for (const f of fields || []) {
    const key = String(f.key || '');
    if (!STANDARD_FIELDS.includes(key) && !known.has(key)) continue;
    const def = known.get(key);
    list.push({ key, label: f.label ? String(f.label).slice(0, 80) : (def?.label || null), required: Boolean(f.required) || key === 'email', type: def?.type || 'TEXT', options: def?.options || [] });
  }
  if (!list.some((f) => f.key === 'email')) list.unshift({ key: 'email', label: null, required: true, type: 'TEXT', options: [] });
  return list;
}

export async function saveForm(id, input, actor) {
  const { rows: customFields } = await query('SELECT key, label, type, options FROM mkt_fields');
  const fields = cleanFields(input.fields, customFields);
  const language = input.language === 'hi' ? 'hi' : 'en';
  const consent = String(input.consent_text || DEFAULT_CONSENT[language]).trim();
  if (consent.length < 20) throw badRequest('The consent wording needs to say what people agree to');
  if (input.redirect_url && !/^https:\/\//i.test(input.redirect_url)) throw badRequest('The page to go to afterwards must be an https address');
  if (!id) {
    if (!input.name?.trim() || !input.audience_id) throw badRequest('Give the form a name and an audience');
    const { rows } = await query(
      `INSERT INTO mkt_forms (public_id, name, audience_id, title, intro, fields, topic_ids, tags, language, consent_text, success_message, redirect_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [crypto.randomBytes(9).toString('base64url'), input.name.trim(), input.audience_id, input.title || null, input.intro || null,
        JSON.stringify(fields), input.topic_ids || [], input.tags || [], language, consent, input.success_message || null, input.redirect_url || null, actor.id],
    );
    return rows[0];
  }
  const { rows } = await query(
    `UPDATE mkt_forms SET name = COALESCE($2, name), audience_id = COALESCE($3, audience_id), title = $4, intro = $5, fields = $6,
            topic_ids = COALESCE($7, topic_ids), tags = COALESCE($8, tags), language = $9, consent_text = $10,
            success_message = $11, redirect_url = $12, is_active = COALESCE($13, is_active), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, input.name?.trim() || null, input.audience_id || null, input.title || null, input.intro || null, JSON.stringify(fields),
      input.topic_ids || null, input.tags || null, language, consent, input.success_message || null, input.redirect_url || null,
      input.is_active ?? null],
  );
  if (!rows[0]) throw notFound('Form not found');
  return rows[0];
}

/** The HTML to paste into a website: a plain form that posts to TaskFlow. */
export function embedCode(form) {
  const action = `${publicBase()}/f/${form.public_id}`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const inputs = (form.fields || []).map((f) => `  <label>${esc(f.label || f.key.replace('custom.', '').replace(/_/g, ' '))}${f.required ? ' *' : ''}<br>
    <input type="${f.key === 'email' ? 'email' : 'text'}" name="${esc(f.key)}"${f.required ? ' required' : ''}></label><br>`).join('\n');
  return `<form method="post" action="${esc(action)}" accept-charset="UTF-8">
${inputs}
  <label><input type="checkbox" name="consent" value="1" required> ${esc(form.consent_text)}</label><br>
  <div style="position:absolute;left:-5000px" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
  <button type="submit">Subscribe</button>
</form>`;
}

export async function publicForm(publicId) {
  const { rows } = await query(
    `SELECT f.*, a.name AS audience_name, a.double_opt_in, a.is_archived AS audience_archived
       FROM mkt_forms f JOIN mkt_audiences a ON a.id = f.audience_id WHERE f.public_id = $1`,
    [publicId],
  );
  const form = rows[0];
  if (!form || !form.is_active || form.audience_archived) return null;
  const { rows: topics } = form.topic_ids?.length
    ? await query('SELECT id, name, name_hi FROM mkt_topics WHERE id = ANY($1::int[]) AND is_active ORDER BY position', [form.topic_ids])
    : { rows: [] };
  return { form, topics };
}

// a small in-memory limit per IP and per address; enough to stop a script
const recent = new Map();
export function allowSubmission(key, { max = 8, windowMs = 10 * 60_000 } = {}) {
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { recent.set(key, list); return false; }
  list.push(now);
  recent.set(key, list);
  if (recent.size > 20_000) recent.clear();
  return true;
}

/**
 * A form submission. Returns { ok, status: 'SUBSCRIBED' | 'PENDING' | 'ALREADY' | 'SUPPRESSED', error }.
 * `body` is the posted fields.
 */
export async function submitForm(publicId, body, { ip = null, userAgent = null } = {}) {
  const loaded = await publicForm(publicId);
  if (!loaded) return { ok: false, notFound: true };
  const { form, topics } = loaded;
  // a bot fills in every field, including the one people cannot see
  if (body.website) return { ok: true, status: 'PENDING', ignored: true };
  const email = String(body.email || '').trim();
  if (!isValidEmail(email)) return { ok: false, error: form.language === 'hi' ? 'कृपया एक सही ईमेल पता लिखें।' : 'Please enter a valid email address.' };
  if (!body.consent) return { ok: false, error: form.language === 'hi' ? 'कृपया सहमति के बॉक्स पर टिक करें।' : 'Please tick the box to agree to receive emails.' };
  if (!allowSubmission(`ip:${ip}`) || !allowSubmission(`email:${email.toLowerCase()}`, { max: 3 })) {
    return { ok: false, error: form.language === 'hi' ? 'बहुत सारे प्रयास। कृपया थोड़ी देर बाद प्रयास करें।' : 'Too many attempts. Please try again a little later.' };
  }
  for (const f of form.fields || []) {
    if (f.required && !String(body[f.key] ?? '').trim()) {
      return { ok: false, error: form.language === 'hi' ? 'कृपया सभी आवश्यक जानकारी भरें।' : `Please fill in ${f.label || f.key.replace('custom.', '').replace(/_/g, ' ')}.` };
    }
  }

  return withTransaction(async (client) => {
    const input = { email, custom: {}, tags: form.tags || [], language: form.language };
    for (const f of form.fields || []) {
      const value = body[f.key];
      if (value === undefined || String(value).trim() === '' || f.key === 'email') continue;
      if (f.key.startsWith('custom.')) input.custom[f.key.slice(7)] = String(value).trim().slice(0, 500);
      else input[f.key] = String(value).slice(0, 200);
    }
    const { contact } = await upsertContact(client, input, { source: 'FORM' });
    const status = await mustConfirm(client, contact.id, { id: form.audience_id, double_opt_in: form.double_opt_in }) ? 'PENDING' : 'SUBSCRIBED';
    const joined = await addToAudience(client, contact.id, form.audience_id, {
      status, source: 'FORM', basis: 'Consent given on a signup form', consentText: form.consent_text, ip, userAgent,
      allowResubscribe: true, meta: { form_id: form.id, form: form.name },
    });
    const chosen = Object.fromEntries(topics.map((t) => [t.id, Boolean(body[`topic_${t.id}`])]));
    if (topics.length) await setTopics(client, contact.id, chosen, { source: 'FORM', ip, userAgent });
    await client.query('UPDATE mkt_forms SET submissions = submissions + 1 WHERE id = $1', [form.id]);
    await logContactActivity(client, contact.id, 'FORM_SUBMITTED', { audienceId: form.audience_id, data: { form_id: form.id, form: form.name } });
    if (joined.result === 'PENDING' && joined.confirmToken) {
      await queueConfirmation(client, { contact, audience: { id: form.audience_id, name: form.audience_name }, confirmToken: joined.confirmToken, language: form.language });
    }
    return { ok: true, status: joined.result, form };
  });
}
