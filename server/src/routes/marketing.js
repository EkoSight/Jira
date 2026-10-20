import express, { Router } from 'express';
import { z } from 'zod';

import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { sendCsv } from '../lib/csv.js';
import { BLOCK_TYPES, MERGE_TAGS, renderEmail } from '../lib/emailRender.js';
import { getSettings, updateSetting } from '../services/settings.js';
import {
  localParts, logContactActivity, marketingSettings, normalizeEmail, publicBase, recordConsent, suppress,
} from '../services/marketing/core.js';
import {
  allTags, archiveContact, changeTags, contactDetail, getContact, guessMapping, importContacts, listContacts, parseCsv,
  updateContact, upsertContact,
} from '../services/marketing/contacts.js';
import {
  AUDIENCE_KINDS, addToAudience, getAudience, listAudiences, listMembers, listTopics, removeFromAudience, saveAudience,
  saveTopic, setTopics, unsubscribe,
} from '../services/marketing/audiences.js';
import { OPERATORS, SEGMENT_FIELDS, compileRules, getSegment, listSegments, previewSegment, saveSegment } from '../services/marketing/segments.js';
import { embedCode, listForms, saveForm } from '../services/marketing/forms.js';
import { getTemplate, listAssets, listTemplates, saveAsset, saveTemplate } from '../services/marketing/templates.js';
import {
  approveCampaign, calendar, cancelCampaign, duplicateCampaign, finishTest, getCampaign, listCampaigns, pauseCampaign,
  requestChanges, resumeCampaign, reviewChecks, saveCampaign, scheduleCampaign, submitForReview, unscheduleCampaign,
} from '../services/marketing/campaigns.js';
import {
  ACTIONS, CONDITIONS, NODE_TYPES, TASKFLOW_EVENTS, TRIGGERS, approveWorkflow, enrollManually, enrollmentsFor, getWorkflow,
  listWorkflows, saveWorkflow, setWorkflowStatus, submitWorkflow, validateWorkflow,
} from '../services/marketing/automations.js';
import { personFor, retryFailed, sendTest } from '../services/marketing/queue.js';
import { recordEvent } from '../services/marketing/events.js';
import { listFollowUps } from '../services/marketing/followups.js';
import {
  audienceReport, campaignEventsCsv, campaignRecipientsCsv, campaignReport, consentsCsv, contactsCsv, overview, suppressionsCsv,
  TRACKING_NOTES,
} from '../services/marketing/reports.js';
import { PROVIDER_LIST, clearOutbox, outbox, providerName, providerStatus } from '../services/marketing/providers.js';
import { checkDomain } from '../services/marketing/dns.js';
import { repliesStatus, syncReplies } from '../services/marketing/replies.js';
import { syncFromCrm } from '../services/marketing/crmSync.js';
import { aiAvailable, assist } from '../services/marketing/ai.js';
import { runMarketingTick } from '../jobs/marketingWorker.js';

/**
 * Email marketing for staff: contacts and audiences, content, campaigns,
 * automations, reports and the sending set-up. Mounted behind sign-in,
 * attendance and marketing.view; each change asks its own permission.
 */
const router = Router();

const manage = requirePermission('marketing.manage');
const send = requirePermission('marketing.send');
const approve = requirePermission('marketing.approve');
const settingsOnly = requirePermission('marketing.settings');
const exporter = requirePermission('marketing.export');

const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- overview and the catalogue

router.get('/overview', asyncHandler(async (req, res) => res.json(await overview())));

/** Everything the screens need to build forms: fields, operators, triggers, block types. */
router.get('/meta', asyncHandler(async (req, res) => {
  const user = req.currentUser;
  const [{ rows: fields }, { rows: users }, { rows: segments }, topics, audiences] = await Promise.all([
    query('SELECT * FROM mkt_fields ORDER BY position, id'),
    query(`SELECT id, full_name FROM users WHERE is_active ORDER BY full_name`),
    query('SELECT id, name FROM crm_segments ORDER BY name').catch(() => ({ rows: [] })),
    listTopics(),
    listAudiences(),
  ]);
  res.json({
    segment_fields: SEGMENT_FIELDS, operators: OPERATORS, custom_fields: fields, merge_tags: MERGE_TAGS, block_types: BLOCK_TYPES,
    triggers: TRIGGERS, taskflow_events: TASKFLOW_EVENTS, node_types: NODE_TYPES, conditions: CONDITIONS, actions: ACTIONS,
    audience_kinds: AUDIENCE_KINDS, audiences, topics, users, crm_segments: segments,
    providers: PROVIDER_LIST, provider: providerStatus(), ai: aiAvailable(), tracking_notes: TRACKING_NOTES,
    can: Object.fromEntries(['manage', 'send', 'approve', 'settings', 'export'].map((p) => [p, hasPermission(user, `marketing.${p}`)])),
    public_base: publicBase(),
  });
}));

// ---------------------------------------------------------------- contacts

const contactInput = z.object({
  email: z.string().max(320).optional(),
  first_name: z.string().max(200).nullable().optional(),
  last_name: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  organization: z.string().max(200).nullable().optional(),
  designation: z.string().max(200).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  state: z.string().max(200).nullable().optional(),
  country: z.string().max(200).nullable().optional(),
  language: z.enum(['en', 'hi']).optional(),
  tags: z.array(z.string().max(60)).max(50).optional(),
  custom: z.record(z.string(), z.any()).optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  account_id: z.number().int().positive().nullable().optional(),
});

router.get('/contacts', asyncHandler(async (req, res) => {
  const segment = req.query.segment_id ? await getSegment(id(req.query.segment_id)) : null;
  res.json(await listContacts({
    search: String(req.query.search || '').slice(0, 200),
    audienceId: req.query.audience_id ? id(req.query.audience_id) : null,
    tag: req.query.tag || null,
    status: req.query.status || null,
    rules: segment?.rules || null,
    compile: compileRules,
    limit: req.query.limit, offset: req.query.offset,
  }));
}));

/** Adds one person by hand: the reason they may be emailed is required to put them on an audience. */
router.post('/contacts', manage, asyncHandler(async (req, res) => {
  const data = contactInput.extend({
    email: z.string().max(320),
    audience_ids: z.array(z.number().int().positive()).max(20).optional(),
    basis: z.string().max(500).optional(),
  }).parse(req.body);
  if (data.audience_ids?.length && String(data.basis || '').trim().length < 5) {
    throw badRequest('Say how this person agreed to hear from you before adding them to an audience');
  }
  const result = await withTransaction(async (client) => {
    const { contact, created } = await upsertContact(client, data, { source: 'MANUAL', actorId: req.currentUser.id });
    const joined = [];
    for (const audienceId of data.audience_ids || []) {
      joined.push({ audience_id: audienceId, ...(await addToAudience(client, contact.id, audienceId, { status: 'SUBSCRIBED', source: 'MANUAL', basis: data.basis, actorId: req.currentUser.id })) });
    }
    if (!data.audience_ids?.length && created && data.basis) {
      await recordConsent(client, { contactId: contact.id, action: 'SUBSCRIBE', source: 'MANUAL', basis: data.basis, actorId: req.currentUser.id, meta: { note: 'Contact database only' } });
    }
    return { contact, created, joined };
  });
  res.status(result.created ? 201 : 200).json(result);
}));

router.get('/contacts/export.csv', exporter, asyncHandler(async (req, res) => {
  const { header, rows } = await contactsCsv({ audienceId: req.query.audience_id ? id(req.query.audience_id) : null });
  sendCsv(res, `contacts-${today()}.csv`, header, rows);
}));

const csvBody = express.text({ type: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'], limit: '15mb' });

/** A first look at a file: its columns, the suggested fields and a few rows. */
router.post('/contacts/import/preview', manage, csvBody, asyncHandler(async (req, res) => {
  const rows = parseCsv(typeof req.body === 'string' ? req.body : '');
  if (!rows.length) throw badRequest('The file is empty, or not a CSV file');
  const { rows: fields } = await query('SELECT key FROM mkt_fields');
  const [header, ...data] = rows;
  res.json({ header, mapping: guessMapping(header, fields.map((f) => f.key)), sample: data.slice(0, 5), rows: data.length });
}));

router.post('/contacts/import', manage, csvBody, asyncHandler(async (req, res) => {
  const q = z.object({
    audience_id: z.coerce.number().int().positive().optional(),
    status: z.enum(['SUBSCRIBED', 'PENDING', 'NONE']).default('SUBSCRIBED'),
    basis: z.string().max(500),
    tags: z.string().max(500).optional(),
    mode: z.enum(['fill', 'overwrite']).default('fill'),
    filename: z.string().max(200).optional(),
    mapping: z.string().max(20000).optional(),
  }).parse(req.query);
  let mapping = null;
  if (q.mapping) {
    try { mapping = JSON.parse(q.mapping); } catch { throw badRequest('The column choices could not be read'); }
    if (!Array.isArray(mapping)) throw badRequest('The column choices could not be read');
    const allowed = new Set(['email', 'first_name', 'last_name', 'full_name', 'phone', 'organization', 'designation', 'city', 'state', 'country', 'language', 'tags']);
    const { rows: fields } = await query('SELECT key FROM mkt_fields');
    fields.forEach((f) => allowed.add(`custom.${f.key}`));
    mapping = mapping.map((m) => (m && allowed.has(m) ? m : null));
  }
  const result = await importContacts({
    csv: typeof req.body === 'string' ? req.body : '', mapping, audienceId: q.audience_id || null, status: q.status, basis: q.basis,
    tags: q.tags ? q.tags.split(',') : [], mode: q.mode, filename: q.filename || null, actor: req.currentUser,
  }, { addToAudience });
  res.json(result);
}));

router.get('/imports', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT i.id, i.filename, i.audience_id, a.name AS audience_name, i.status_given, i.basis, i.tags, i.totals, i.created_at, u.full_name AS created_by_name
       FROM mkt_imports i LEFT JOIN mkt_audiences a ON a.id = i.audience_id LEFT JOIN users u ON u.id = i.created_by
      ORDER BY i.created_at DESC LIMIT 50`,
  );
  res.json({ imports: rows });
}));

router.post('/contacts/tags', manage, asyncHandler(async (req, res) => {
  const data = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(5000),
    add: z.array(z.string().max(60)).max(20).default([]),
    remove: z.array(z.string().max(60)).max(20).default([]),
  }).parse(req.body);
  res.json(await changeTags(data.ids, { add: data.add, remove: data.remove }, req.currentUser.id));
}));

router.get('/contacts/:id', asyncHandler(async (req, res) => res.json(await contactDetail(id(req.params.id)))));

router.patch('/contacts/:id', manage, asyncHandler(async (req, res) => {
  const data = contactInput.parse(req.body);
  res.json({ contact: await updateContact(id(req.params.id), data, req.currentUser) });
}));

router.post('/contacts/:id/archive', manage, asyncHandler(async (req, res) => {
  const archived = z.object({ archived: z.boolean().default(true) }).parse(req.body || {}).archived;
  await archiveContact(id(req.params.id), archived);
  res.json({ contact: await getContact(id(req.params.id)) });
}));

router.post('/contacts/:id/audiences', manage, asyncHandler(async (req, res) => {
  const data = z.object({ audience_id: z.number().int().positive(), basis: z.string().min(5).max(500) }).parse(req.body);
  const result = await addToAudience(null, id(req.params.id), data.audience_id, { status: 'SUBSCRIBED', source: 'MANUAL', basis: data.basis, actorId: req.currentUser.id });
  res.json(result);
}));

router.delete('/contacts/:id/audiences/:audienceId', manage, asyncHandler(async (req, res) => {
  await removeFromAudience(id(req.params.id), id(req.params.audienceId), req.currentUser);
  res.json({ ok: true });
}));

/** The person asked a member of staff (by phone, in person) to stop. Recorded as theirs. */
router.post('/contacts/:id/unsubscribe', manage, asyncHandler(async (req, res) => {
  const data = z.object({ audience_id: z.number().int().positive().optional(), all: z.boolean().default(false), reason: z.string().max(300).optional() }).parse(req.body);
  if (!data.all && !data.audience_id) throw badRequest('Say which audience, or all of them');
  const result = await unsubscribe(null, id(req.params.id), {
    audienceId: data.audience_id || null, all: data.all, source: 'STAFF', reason: data.reason || 'Asked a member of staff', actorId: req.currentUser.id,
  });
  res.json(result);
}));

router.put('/contacts/:id/topics', manage, asyncHandler(async (req, res) => {
  const data = z.object({ choices: z.record(z.string(), z.boolean()) }).parse(req.body);
  await setTopics(null, id(req.params.id), data.choices, { source: 'STAFF', actorId: req.currentUser.id });
  res.json(await contactDetail(id(req.params.id)));
}));

router.post('/contacts/:id/notes', manage, asyncHandler(async (req, res) => {
  const data = z.object({ note: z.string().min(1).max(2000) }).parse(req.body);
  await logContactActivity(null, id(req.params.id), 'NOTE', { data: { note: data.note }, actorId: req.currentUser.id });
  res.json({ ok: true });
}));

/** A reply or conversion someone saw outside TaskFlow, recorded by hand. */
router.post('/messages/:id/events', manage, asyncHandler(async (req, res) => {
  const data = z.object({ type: z.enum(['REPLY', 'CONVERSION']), value: z.number().nonnegative().max(1e12).optional(), note: z.string().max(1000).optional() }).parse(req.body);
  const messageId = id(req.params.id);
  const { rows } = await query(`SELECT id, kind FROM mkt_messages WHERE id = $1`, [messageId]);
  if (!rows[0] || !['CAMPAIGN', 'AUTOMATION'].includes(rows[0].kind)) throw notFound('Email not found');
  const outcome = await recordEvent({
    type: data.type, messageId, source: 'MANUAL', value: data.value ?? null,
    providerEventId: `manual:${data.type}:${messageId}`,
    meta: { snippet: data.note || null, recorded_by: req.currentUser.id, label: data.note || null },
  });
  res.json({ recorded: outcome.recorded, duplicate: outcome.duplicate });
}));

router.get('/tags', asyncHandler(async (req, res) => res.json({ tags: await allTags() })));

// ---------------------------------------------------------------- custom fields

router.get('/fields', asyncHandler(async (req, res) => {
  res.json({ fields: (await query('SELECT * FROM mkt_fields ORDER BY position, id')).rows });
}));

const fieldInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower-case letters, numbers and _').optional(),
  label: z.string().min(1).max(80).optional(),
  type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN']).optional(),
  options: z.array(z.string().max(80)).max(50).optional(),
  position: z.number().int().optional(),
});

router.post('/fields', manage, asyncHandler(async (req, res) => {
  const data = fieldInput.parse(req.body);
  if (!data.key || !data.label) throw badRequest('A field needs a key and a label');
  const { rows } = await query(
    `INSERT INTO mkt_fields (key, label, type, options, position, created_by) VALUES ($1,$2,$3,$4,COALESCE($5, 100),$6)
     ON CONFLICT (key) DO NOTHING RETURNING *`,
    [data.key, data.label, data.type || 'TEXT', JSON.stringify(data.options || []), data.position ?? null, req.currentUser.id],
  );
  if (!rows[0]) throw conflict('A field with that key exists already');
  res.status(201).json({ field: rows[0] });
}));

// the key is what stored values and merge tags refer to, so it never changes
router.patch('/fields/:id', manage, asyncHandler(async (req, res) => {
  const data = fieldInput.omit({ key: true }).parse(req.body);
  const { rows } = await query(
    `UPDATE mkt_fields SET label = COALESCE($2, label), type = COALESCE($3, type), options = COALESCE($4, options), position = COALESCE($5, position)
      WHERE id = $1 RETURNING *`,
    [id(req.params.id), data.label ?? null, data.type ?? null, data.options ? JSON.stringify(data.options) : null, data.position ?? null],
  );
  if (!rows[0]) throw notFound('Field not found');
  res.json({ field: rows[0] });
}));

// ---------------------------------------------------------------- audiences and topics

router.get('/audiences', asyncHandler(async (req, res) => res.json({ audiences: await listAudiences({ includeArchived: req.query.archived === 'true' }) })));
const crmRuleNeedsSettings = (req) => {
  // a rule that adds people from the CRM is a decision about consent
  if (req.body?.crm_sync !== undefined && req.body?.crm_sync !== null && !hasPermission(req.currentUser, 'marketing.settings')) {
    throw forbidden('Choosing who the CRM adds to an audience needs marketing.settings');
  }
};
router.post('/audiences', manage, asyncHandler(async (req, res) => {
  crmRuleNeedsSettings(req);
  res.status(201).json({ audience: await saveAudience(null, req.body || {}, req.currentUser) });
}));
router.get('/audiences/:id', asyncHandler(async (req, res) => {
  const audienceId = id(req.params.id);
  res.json({ audience: await getAudience(audienceId), report: await audienceReport(audienceId) });
}));
router.patch('/audiences/:id', manage, asyncHandler(async (req, res) => {
  if (req.body?.crm_sync !== undefined && !hasPermission(req.currentUser, 'marketing.settings')) {
    throw forbidden('Changing who the CRM adds to an audience needs marketing.settings');
  }
  res.json({ audience: await saveAudience(id(req.params.id), req.body || {}, req.currentUser) });
}));
router.get('/audiences/:id/members', asyncHandler(async (req, res) => {
  res.json({ members: await listMembers(id(req.params.id), {
    status: req.query.status || null, search: String(req.query.search || ''), limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0,
  }) });
}));

router.get('/topics', asyncHandler(async (req, res) => res.json({ topics: await listTopics() })));
router.post('/topics', manage, asyncHandler(async (req, res) => res.status(201).json({ topic: await saveTopic(null, req.body || {}) })));
router.patch('/topics/:id', manage, asyncHandler(async (req, res) => res.json({ topic: await saveTopic(id(req.params.id), req.body || {}) })));

// ---------------------------------------------------------------- segments

router.get('/segments', asyncHandler(async (req, res) => res.json({ segments: await listSegments() })));
router.post('/segments/preview', asyncHandler(async (req, res) => {
  res.json(await previewSegment(req.body?.rules, { audienceId: req.body?.audience_id || null, limit: 25 }));
}));
router.post('/segments', manage, asyncHandler(async (req, res) => res.status(201).json({ segment: await saveSegment(null, req.body || {}, req.currentUser) })));
router.patch('/segments/:id', manage, asyncHandler(async (req, res) => res.json({ segment: await saveSegment(id(req.params.id), req.body || {}, req.currentUser) })));

// ---------------------------------------------------------------- signup forms

router.get('/forms', asyncHandler(async (req, res) => res.json({ forms: await listForms() })));
router.post('/forms', manage, asyncHandler(async (req, res) => res.status(201).json({ form: await saveForm(null, req.body || {}, req.currentUser) })));
router.patch('/forms/:id', manage, asyncHandler(async (req, res) => res.json({ form: await saveForm(id(req.params.id), req.body || {}, req.currentUser) })));
router.get('/forms/:id/embed', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM mkt_forms WHERE id = $1', [id(req.params.id)]);
  if (!rows[0]) throw notFound('Form not found');
  res.json({ html: embedCode(rows[0]), url: `${publicBase()}/f/${rows[0].public_id}` });
}));

// ---------------------------------------------------------------- templates and images

router.get('/templates', asyncHandler(async (req, res) => res.json(await listTemplates({ includeArchived: req.query.archived === 'true' }))));
router.get('/templates/:id', asyncHandler(async (req, res) => res.json({ template: await getTemplate(id(req.params.id)) })));
router.post('/templates', manage, asyncHandler(async (req, res) => res.status(201).json({ template: await saveTemplate(null, req.body || {}, req.currentUser) })));
router.patch('/templates/:id', manage, asyncHandler(async (req, res) => res.json({ template: await saveTemplate(id(req.params.id), req.body || {}, req.currentUser) })));

router.get('/assets', asyncHandler(async (req, res) => res.json({ assets: await listAssets() })));
router.post('/assets', manage, express.raw({ type: ['image/*', 'application/octet-stream'], limit: '2mb' }), asyncHandler(async (req, res) => {
  res.status(201).json({ asset: await saveAsset({ buffer: Buffer.isBuffer(req.body) ? req.body : null, filename: req.query.filename }, req.currentUser) });
}));

// ---------------------------------------------------------------- previews and tests

async function sampleContact(contactId) {
  if (contactId) return getContact(id(contactId));
  return { id: 0, email: 'sample@example.com', first_name: 'Ramesh', last_name: 'Kumar', organization: 'Kisan FPO', city: 'Indore', state: 'Madhya Pradesh', language: 'en', tags: [], custom: {} };
}

/** A design as one person would see it — links shown, not tracked. */
async function preview({ design, subject = '', preheader = '', lang = 'en', contactId = null, festival = '' }) {
  const settings = await marketingSettings();
  const contact = await sampleContact(contactId);
  const person = contact.id ? await personFor(null, contact) : { ...contact, audience_ids: [], account_type: 'NONE' };
  const { date } = localParts(new Date(), settings.timezone);
  const data = { festival, campaign: '', today: date, year: date.slice(0, 4), unsubscribe_url: '#unsubscribe', preferences_url: '#preferences' };
  const rendered = renderEmail(design, {
    person: { ...person, language: lang }, lang, data, preheader, subject,
    footer: { company: settings.company, address: settings.postalAddress || '(postal address not set — Settings)', reason: { en: 'you are on our list.', hi: 'आप हमारी सूची में हैं।' } },
  });
  return { ...rendered, contact: { id: contact.id, email: contact.email, first_name: contact.first_name } };
}

router.post('/preview', asyncHandler(async (req, res) => {
  const data = z.object({
    design: z.object({ blocks: z.array(z.any()) }).passthrough(),
    subject: z.string().max(500).optional(), preheader: z.string().max(500).optional(),
    lang: z.enum(['en', 'hi']).default('en'), contact_id: z.number().int().positive().nullable().optional(), festival: z.string().max(100).optional(),
  }).parse(req.body);
  res.json(await preview({ design: data.design, subject: data.subject, preheader: data.preheader, lang: data.lang, contactId: data.contact_id, festival: data.festival }));
}));

/** A test of any design — an automation step or an unsaved draft — to staff addresses. */
router.post('/test', manage, asyncHandler(async (req, res) => {
  const data = z.object({
    design: z.object({ blocks: z.array(z.any()) }).passthrough(),
    subject: z.string().min(1).max(500), subject_hi: z.string().max(500).nullable().optional(), preheader: z.string().max(500).nullable().optional(),
    emails: z.array(z.string().max(320)).min(1).max(10), contact_id: z.number().int().positive().nullable().optional(),
  }).parse(req.body);
  res.json(await sendTest({
    content: { subject: data.subject, subject_hi: data.subject_hi || null, preheader: data.preheader || '', design: data.design },
    emails: data.emails, sampleContactId: data.contact_id || null, actor: req.currentUser,
  }));
}));

// ---------------------------------------------------------------- campaigns

router.get('/campaigns', asyncHandler(async (req, res) => {
  res.json({ campaigns: await listCampaigns({ status: req.query.status || null, search: String(req.query.search || '').slice(0, 200) }) });
}));

router.get('/calendar', asyncHandler(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = day.test(req.query.from) ? req.query.from : today();
  const to = day.test(req.query.to) ? req.query.to : new Date(Date.now() + 42 * 86_400_000).toISOString().slice(0, 10);
  res.json(await calendar(from, to));
}));

const campaignInput = z.object({
  name: z.string().min(1).max(200).optional(),
  audience_id: z.number().int().positive().nullable().optional(),
  segment_id: z.number().int().positive().nullable().optional(),
  topic_id: z.number().int().positive().nullable().optional(),
  subject: z.string().max(500).nullable().optional(),
  subject_hi: z.string().max(500).nullable().optional(),
  preheader: z.string().max(500).nullable().optional(),
  preheader_hi: z.string().max(500).nullable().optional(),
  from_name: z.string().max(200).nullable().optional(),
  from_email: z.string().max(320).nullable().optional(),
  reply_to: z.string().max(320).nullable().optional(),
  design: z.object({ blocks: z.array(z.any()).max(200) }).passthrough().optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  task_id: z.number().int().positive().nullable().optional(),
  deadline: z.string().datetime({ offset: true }).nullable().optional(),
  send_strategy: z.enum(['NOW', 'SCHEDULED', 'OPTIMIZED']).optional(),
  ab_test: z.object({
    metric: z.enum(['OPENS', 'CLICKS', 'REPLIES', 'MANUAL']), test_percent: z.number().min(5).max(100), wait_hours: z.number().min(1).max(168),
  }).passthrough().nullable().optional(),
  variants: z.array(z.object({
    subject: z.string().max(500).nullable().optional(), subject_hi: z.string().max(500).nullable().optional(),
    preheader: z.string().max(500).nullable().optional(), from_name: z.string().max(200).nullable().optional(),
    design: z.object({ blocks: z.array(z.any()).max(200) }).passthrough().nullable().optional(),
  })).max(8).optional(),
  follow_up: z.object({
    on_click: z.boolean(), on_reply: z.boolean(), on_conversion: z.boolean(),
    assign: z.union([z.literal('CONTACT_OWNER'), z.literal('CAMPAIGN_OWNER'), z.string().regex(/^\d+$/)]),
    due_days: z.number().int().min(0).max(30), link_urls: z.array(z.string().max(2000)).max(50).optional(),
  }).optional(),
  conversion_window_days: z.number().int().min(1).max(365).optional(),
  track_opens: z.boolean().optional(),
  track_clicks: z.boolean().optional(),
  create_task: z.boolean().optional(),
});

router.post('/campaigns', manage, asyncHandler(async (req, res) => {
  res.status(201).json({ campaign: await saveCampaign(null, campaignInput.parse(req.body), req.currentUser) });
}));
router.get('/campaigns/:id', asyncHandler(async (req, res) => res.json({ campaign: await getCampaign(id(req.params.id)) })));
router.patch('/campaigns/:id', manage, asyncHandler(async (req, res) => {
  res.json({ campaign: await saveCampaign(id(req.params.id), campaignInput.parse(req.body), req.currentUser) });
}));
router.post('/campaigns/:id/archive', manage, asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    `UPDATE mkt_campaigns SET is_archived = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('SENDING', 'TESTING', 'SCHEDULED')`,
    [id(req.params.id), req.body?.archived !== false],
  );
  if (!rowCount) throw conflict('Pause or cancel the campaign before archiving it');
  res.json({ ok: true });
}));
router.post('/campaigns/:id/duplicate', manage, asyncHandler(async (req, res) => {
  res.status(201).json({ campaign: await duplicateCampaign(id(req.params.id), req.currentUser) });
}));
router.get('/campaigns/:id/checks', asyncHandler(async (req, res) => res.json(await reviewChecks(await getCampaign(id(req.params.id))))));

router.post('/campaigns/:id/preview', asyncHandler(async (req, res) => {
  const campaign = await getCampaign(id(req.params.id));
  const data = z.object({ lang: z.enum(['en', 'hi']).default('en'), contact_id: z.number().int().positive().nullable().optional(), variant: z.string().regex(/^[A-H]$/).nullable().optional() }).parse(req.body || {});
  const v = data.variant ? campaign.variants.find((x) => x.key === data.variant) : null;
  const subject = data.lang === 'hi' ? (v?.subject_hi || campaign.subject_hi || v?.subject || campaign.subject) : (v?.subject || campaign.subject);
  const out = await preview({
    design: v?.design || campaign.design, subject: subject || '', preheader: (data.lang === 'hi' ? campaign.preheader_hi : null) || v?.preheader || campaign.preheader || '',
    lang: data.lang, contactId: data.contact_id,
  });
  res.json({ ...out, subject });
}));

router.post('/campaigns/:id/test', manage, asyncHandler(async (req, res) => {
  const campaign = await getCampaign(id(req.params.id));
  const data = z.object({ emails: z.array(z.string().max(320)).min(1).max(10), contact_id: z.number().int().positive().nullable().optional(), variant: z.string().regex(/^[A-H]$/).nullable().optional() }).parse(req.body);
  const v = data.variant ? campaign.variants.find((x) => x.key === data.variant) : null;
  res.json(await sendTest({
    content: {
      subject: v?.subject || campaign.subject, subject_hi: v?.subject_hi || campaign.subject_hi, preheader: v?.preheader || campaign.preheader,
      preheader_hi: campaign.preheader_hi, design: v?.design || campaign.design, from_name: v?.from_name || null,
    },
    emails: data.emails, campaignId: campaign.id, sampleContactId: data.contact_id || null, actor: req.currentUser,
  }));
}));

router.post('/campaigns/:id/submit', manage, asyncHandler(async (req, res) => res.json({ campaign: await submitForReview(id(req.params.id), req.currentUser) })));
router.post('/campaigns/:id/approve', approve, asyncHandler(async (req, res) => {
  res.json({ campaign: await approveCampaign(id(req.params.id), req.currentUser, req.body?.note ? String(req.body.note).slice(0, 1000) : null) });
}));
router.post('/campaigns/:id/request-changes', approve, asyncHandler(async (req, res) => {
  res.json({ campaign: await requestChanges(id(req.params.id), req.currentUser, String(req.body?.note || '').slice(0, 1000)) });
}));
router.post('/campaigns/:id/schedule', send, asyncHandler(async (req, res) => {
  const data = z.object({ at: z.string().datetime({ offset: true }).nullable().optional(), strategy: z.enum(['NOW', 'SCHEDULED', 'OPTIMIZED']).optional() }).parse(req.body || {});
  res.json({ campaign: await scheduleCampaign(id(req.params.id), { at: data.at || null, strategy: data.strategy || null }, req.currentUser) });
}));
router.post('/campaigns/:id/unschedule', send, asyncHandler(async (req, res) => res.json({ campaign: await unscheduleCampaign(id(req.params.id)) })));
router.post('/campaigns/:id/pause', send, asyncHandler(async (req, res) => res.json({ campaign: await pauseCampaign(id(req.params.id)) })));
router.post('/campaigns/:id/resume', send, asyncHandler(async (req, res) => res.json({ campaign: await resumeCampaign(id(req.params.id)) })));
router.post('/campaigns/:id/cancel', send, asyncHandler(async (req, res) => res.json(await cancelCampaign(id(req.params.id)))));
router.post('/campaigns/:id/finish-test', send, asyncHandler(async (req, res) => {
  const winner = req.body?.winner && /^[A-H]$/.test(req.body.winner) ? req.body.winner : null;
  res.json(await finishTest(id(req.params.id), { winner, actor: req.currentUser }));
}));
router.post('/campaigns/:id/retry-failed', send, asyncHandler(async (req, res) => res.json({ requeued: await retryFailed(id(req.params.id)) })));

router.get('/campaigns/:id/report', asyncHandler(async (req, res) => res.json(await campaignReport(id(req.params.id)))));
router.get('/campaigns/:id/recipients.csv', exporter, asyncHandler(async (req, res) => {
  const { header, rows } = await campaignRecipientsCsv(id(req.params.id));
  sendCsv(res, `campaign-${req.params.id}-recipients.csv`, header, rows);
}));
router.get('/campaigns/:id/events.csv', exporter, asyncHandler(async (req, res) => {
  const { header, rows } = await campaignEventsCsv(id(req.params.id));
  sendCsv(res, `campaign-${req.params.id}-events.csv`, header, rows);
}));

// ---------------------------------------------------------------- automations

router.get('/automations', asyncHandler(async (req, res) => res.json({ automations: await listWorkflows() })));
router.post('/automations', manage, asyncHandler(async (req, res) => res.status(201).json({ automation: await saveWorkflow(null, req.body || {}, req.currentUser) })));
router.get('/automations/:id', asyncHandler(async (req, res) => {
  const w = await getWorkflow(id(req.params.id));
  res.json({ automation: w, problems: validateWorkflow(w) });
}));
router.patch('/automations/:id', manage, asyncHandler(async (req, res) => res.json({ automation: await saveWorkflow(id(req.params.id), req.body || {}, req.currentUser) })));
router.post('/automations/:id/submit', manage, asyncHandler(async (req, res) => res.json({ automation: await submitWorkflow(id(req.params.id), req.currentUser) })));
router.post('/automations/:id/approve', approve, asyncHandler(async (req, res) => {
  res.json({ automation: await approveWorkflow(id(req.params.id), req.currentUser, req.body?.note ? String(req.body.note).slice(0, 1000) : null) });
}));
router.post('/automations/:id/status', send, asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT']) }).parse(req.body);
  res.json({ automation: await setWorkflowStatus(id(req.params.id), status, req.currentUser) });
}));
router.post('/automations/:id/enroll', send, asyncHandler(async (req, res) => {
  const { contact_ids: ids } = z.object({ contact_ids: z.array(z.number().int().positive()).min(1).max(5000) }).parse(req.body);
  res.json(await enrollManually(id(req.params.id), ids));
}));
router.get('/automations/:id/enrollments', asyncHandler(async (req, res) => res.json({ enrollments: await enrollmentsFor(id(req.params.id)) })));

// ---------------------------------------------------------------- festivals

router.get('/festivals', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT f.*, u.full_name AS created_by_name FROM mkt_festivals f LEFT JOIN users u ON u.id = f.created_by
      WHERE f.date >= CURRENT_DATE - 30 OR $1 ORDER BY f.date`,
    [req.query.all === 'true'],
  );
  res.json({ festivals: rows });
}));

const festivalInput = z.object({
  name: z.string().min(1).max(120).optional(), name_hi: z.string().max(120).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), region: z.string().max(120).nullable().optional(),
  is_confirmed: z.boolean().optional(), notes: z.string().max(500).nullable().optional(),
});

router.post('/festivals', settingsOnly, asyncHandler(async (req, res) => {
  const data = festivalInput.parse(req.body);
  if (!data.name || !data.date) throw badRequest('A festival needs a name and a date');
  const { rows } = await query(
    `INSERT INTO mkt_festivals (name, name_hi, date, region, is_confirmed, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (name, date) DO NOTHING RETURNING *`,
    [data.name, data.name_hi ?? null, data.date, data.region ?? null, Boolean(data.is_confirmed), data.notes ?? null, req.currentUser.id],
  );
  if (!rows[0]) throw conflict('That festival is already on that date');
  res.status(201).json({ festival: rows[0] });
}));

router.patch('/festivals/:id', settingsOnly, asyncHandler(async (req, res) => {
  const data = festivalInput.parse(req.body);
  const { rows } = await query(
    `UPDATE mkt_festivals SET name = COALESCE($2, name), name_hi = COALESCE($3, name_hi), date = COALESCE($4::date, date),
            region = COALESCE($5, region), is_confirmed = COALESCE($6, is_confirmed), notes = COALESCE($7, notes)
      WHERE id = $1 RETURNING *`,
    [id(req.params.id), data.name ?? null, data.name_hi ?? null, data.date ?? null, data.region ?? null, data.is_confirmed ?? null, data.notes ?? null],
  );
  if (!rows[0]) throw notFound('Festival not found');
  res.json({ festival: rows[0] });
}));

// ---------------------------------------------------------------- follow-ups and reports

router.get('/followups', asyncHandler(async (req, res) => {
  res.json({ followups: await listFollowUps({ campaignId: req.query.campaign_id ? id(req.query.campaign_id) : null }) });
}));
router.get('/reports/audiences', asyncHandler(async (req, res) => res.json(await audienceReport(req.query.audience_id ? id(req.query.audience_id) : null))));

// ---------------------------------------------------------------- the writing assistant

const aiCalls = new Map();
router.post('/ai', manage, asyncHandler(async (req, res) => {
  const data = z.object({
    task: z.enum(['subjects', 'preheader', 'rewrite', 'shorten', 'translate_hi', 'translate_en', 'draft']),
    text: z.string().max(8000).default(''), context: z.string().max(2000).default(''), language: z.enum(['en', 'hi']).default('en'),
  }).parse(req.body);
  // a few requests a minute per person: it costs money and is never urgent
  const now = Date.now();
  const recent = (aiCalls.get(req.currentUser.id) || []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 30) throw badRequest('That is a lot of suggestions in a short time; try again in a few minutes');
  aiCalls.set(req.currentUser.id, [...recent, now]);
  res.json(await assist(data));
}));

// ---------------------------------------------------------------- settings, compliance and delivery

function settingsView(settings) {
  const base = publicBase();
  return {
    settings,
    provider: providerStatus(),
    replies: repliesStatus(settings),
    endpoints: {
      ses_sns: `${base}/webhooks/ses`,
      brevo: `${base}/webhooks/brevo/<EMAIL_WEBHOOK_SECRET>`,
      inbound: `${base}/inbound/<MARKETING_INBOUND_KEY>`,
      conversions: `${base}/conversions`,
      one_click_example: `${base}/u/<token>/one-click`,
    },
    keys: {
      webhook_secret: Boolean(config.email.webhookSecret),
      conversion_key: Boolean(config.email.conversionKey),
      inbound_key: Boolean(config.email.inboundKey),
      anthropic: Boolean(config.email.anthropicKey),
    },
    worker: { enabled: config.jobs.enabled && config.email.workerEnabled, interval_seconds: config.email.workerIntervalSeconds },
  };
}

router.get('/settings', asyncHandler(async (req, res) => res.json(settingsView(await marketingSettings()))));

const settingsInput = z.object({
  enabled: z.boolean(),
  company: z.string().max(200),
  postalAddress: z.string().max(500),
  defaultFromName: z.string().max(200),
  defaultFromEmail: z.string().max(320),
  defaultReplyTo: z.string().max(320),
  replyPlusAddressing: z.boolean(),
  senders: z.array(z.object({ email: z.string().max(320), name: z.string().max(200).optional() })).max(50),
  sendingDomain: z.string().max(253),
  dkimSelectors: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,63}$/)).max(10),
  approvals: z.object({ required: z.boolean(), allowSelfApproval: z.boolean() }),
  limits: z.object({ perContactPerDay: z.number().int().min(0).max(20), perContactPerWeek: z.number().int().min(0).max(50), ratePerMinute: z.number().int().min(1).max(3000) }),
  followUps: z.object({ dueDays: z.number().int().min(0).max(30), departmentId: z.number().int().positive().nullable() }),
  crmSync: z.object({ enabled: z.boolean() }),
  replies: z.object({ enabled: z.boolean(), mailbox: z.string().max(320), lookbackDays: z.number().int().min(1).max(30) }),
  softBounceLimit: z.number().int().min(1).max(10),
  sto: z.object({ defaultHour: z.number().int().min(0).max(23) }),
  timezone: z.literal('Asia/Kolkata'),
}).partial();

router.put('/settings', settingsOnly, asyncHandler(async (req, res) => {
  const changes = settingsInput.parse(req.body);
  for (const s of changes.senders || []) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) throw badRequest(`${s.email} is not an email address`);
  // the stored value replaces the whole group, so start from what is there now
  const current = (await getSettings()).marketing;
  const next = { ...current, ...changes };
  for (const key of ['approvals', 'limits', 'followUps', 'crmSync', 'replies', 'sto']) if (changes[key]) next[key] = { ...current[key], ...changes[key] };
  if (changes.senders) next.senders = changes.senders.map((s) => ({ email: normalizeEmail(s.email), name: s.name || '' }));
  await updateSetting('marketing', next, req.currentUser.id);
  res.json(settingsView(await marketingSettings()));
}));

router.post('/settings/dns-check', settingsOnly, asyncHandler(async (req, res) => {
  const settings = await marketingSettings();
  const domain = req.body?.domain || settings.sendingDomain || (settings.defaultFromEmail || '').split('@')[1];
  res.json(await checkDomain(domain, { dkimSelectors: settings.dkimSelectors || [] }));
}));
router.post('/settings/sync-crm', settingsOnly, asyncHandler(async (req, res) => res.json(await syncFromCrm({ force: req.body?.force === true }))));
router.post('/settings/sync-replies', settingsOnly, asyncHandler(async (req, res) => res.json(await syncReplies())));
router.post('/worker/run', settingsOnly, asyncHandler(async (req, res) => res.json(await runMarketingTick({ force: true }))));

router.get('/suppressions', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, u.full_name AS created_by_name, c.id AS contact_id FROM mkt_suppressions s
       LEFT JOIN users u ON u.id = s.created_by LEFT JOIN mkt_contacts c ON c.email_normalized = s.email_normalized
      WHERE ($1 = '' OR s.email_normalized LIKE '%' || lower($1) || '%') ORDER BY s.created_at DESC LIMIT 500`,
    [String(req.query.search || '')],
  );
  res.json({ suppressions: rows });
}));
router.get('/suppressions.csv', exporter, asyncHandler(async (req, res) => {
  const { header, rows } = await suppressionsCsv();
  sendCsv(res, `suppressions-${today()}.csv`, header, rows);
}));
router.post('/suppressions', settingsOnly, asyncHandler(async (req, res) => {
  const data = z.object({ email: z.string().max(320), note: z.string().max(500).optional() }).parse(req.body);
  const email = normalizeEmail(data.email);
  if (!email.includes('@')) throw badRequest('That is not an email address');
  await withTransaction(async (client) => {
    await suppress(client, email, { reason: 'MANUAL', source: 'STAFF', note: data.note || null, actorId: req.currentUser.id });
    const { rows } = await client.query('SELECT id FROM mkt_contacts WHERE email_normalized = $1', [email]);
    if (rows[0]) await recordConsent(client, { contactId: rows[0].id, action: 'SUPPRESS', source: 'STAFF', actorId: req.currentUser.id, meta: { note: data.note || null } });
  });
  res.status(201).json({ ok: true });
}));

/**
 * Lifting a suppression. Only one staff put there, or repeated soft bounces —
 * never an unsubscribe (only the person can take that back, from a form) and
 * never a hard bounce or a spam complaint.
 */
router.delete('/suppressions/:email', settingsOnly, asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.params.email);
  const note = String(req.query.note || '').trim();
  if (note.length < 5) throw badRequest('Say why it is safe to email this address again');
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM mkt_suppressions WHERE email_normalized = $1 FOR UPDATE', [email]);
    if (!rows[0]) throw notFound('That address is not suppressed');
    if (!['MANUAL', 'SOFT_BOUNCES'].includes(rows[0].reason)) {
      throw forbidden(rows[0].reason === 'UNSUBSCRIBED_ALL'
        ? 'This person unsubscribed. Only they can subscribe again, from a signup form.'
        : 'Hard bounces and spam complaints are never lifted: mailing them again harms delivery for everyone.');
    }
    await client.query('DELETE FROM mkt_suppressions WHERE email_normalized = $1', [email]);
    const { rows: contacts } = await client.query(
      `UPDATE mkt_contacts SET email_status = CASE WHEN email_status = 'BOUNCED' THEN 'ACTIVE' ELSE email_status END, soft_bounces = 0
        WHERE email_normalized = $1 RETURNING id`, [email],
    );
    if (contacts[0]) await recordConsent(client, { contactId: contacts[0].id, action: 'UNSUPPRESS', source: 'STAFF', actorId: req.currentUser.id, meta: { note, previous_reason: rows[0].reason } });
  });
  res.json({ ok: true });
}));

router.get('/consents.csv', exporter, asyncHandler(async (req, res) => {
  const { header, rows } = await consentsCsv();
  sendCsv(res, `consent-records-${today()}.csv`, header, rows);
}));

// ---------------------------------------------------------------- the outbox (development and staging)

// With EMAIL_PROVIDER unset outside production, nothing is delivered: emails
// are kept in memory so the whole flow can be tried. These two routes exist
// only then.
const outboxOnly = (req, res, next) => {
  if (config.env === 'production' || providerName() !== 'log') return next(notFound());
  next();
};

router.get('/dev/outbox', settingsOnly, outboxOnly, asyncHandler(async (req, res) => {
  const list = outbox().slice(-50).reverse();
  const { rows } = await query('SELECT id, token, kind FROM mkt_messages WHERE token = ANY($1::text[])', [list.map((m) => m.reference)]);
  const byToken = new Map(rows.map((r) => [r.token, r]));
  res.json({ messages: list.map(({ raw, ...m }) => ({ ...m, size: raw.length, message_id: byToken.get(m.reference)?.id ?? null, kind: byToken.get(m.reference)?.kind ?? null })) });
}));
router.delete('/dev/outbox', settingsOnly, outboxOnly, (req, res) => { clearOutbox(); res.json({ ok: true }); });

/** What a provider would report, for trying bounces and complaints without a real mailbox. */
router.post('/dev/simulate', settingsOnly, outboxOnly, asyncHandler(async (req, res) => {
  const data = z.object({ message_id: z.number().int().positive(), type: z.enum(['DELIVERED', 'BOUNCE_HARD', 'BOUNCE_SOFT', 'COMPLAINT', 'REPLY']) }).parse(req.body);
  const outcome = await recordEvent({
    type: data.type, messageId: data.message_id, source: 'PROVIDER:log',
    meta: { simulated: true, by: req.currentUser.id, snippet: data.type === 'REPLY' ? 'Simulated reply' : undefined },
  });
  res.json({ recorded: outcome.recorded });
}));

export default router;
