/**
 * Importing leads and organizations from Excel or CSV, in steps a person can
 * see and stop:
 *
 *   upload    the file is read (every cell as the text it shows) and kept as rows
 *   map       columns are matched to fields; the guess is shown and editable
 *   validate  each row is checked and given a status: valid, invalid (with the
 *             reasons), duplicate (with what it duplicates), or routed (a
 *             retailer, FPO or individual, while those go to the TeleCRM queue)
 *   process   in the background, a batch at a time; a row is applied once, by
 *             its own idempotency key, so a retry or a restart continues
 *             instead of importing twice
 *   undo      records the import made are archived (never deleted) unless
 *             someone has worked on them since; fields it filled are put back
 *             only where nobody has changed them since. What was kept is listed.
 *
 * Nothing is skipped or overwritten silently: every row ends with a status,
 * and a corrections file lists the invalid ones with their reasons.
 *
 * A TeleCRM export is recognised by its columns and read with a preset: its
 * statuses become calling statuses, its form questions lead fields, "-" and "_"
 * mean blank, dates are day-first in India time, the agent's notes go on the
 * lead's timeline, and the TeleCRM lead id makes a later export of the same
 * leads update them instead of adding them again.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { recordAuditEvent } from '../audit.js';
import {
  LEAD_CATEGORIES, ORG_TYPES, PIPELINE_FOR_CATEGORY, cleanText, companyDomain, isEligible, isExcluded, normalizeEmail, normalizePhone,
  normalizeState, parseImportDate, salesSettings, sourceKeyFromText, teleSalesHere,
} from './core.js';
import { categoryFromInput } from './routing.js';
import { createLead, logLeadActivity, validateLead } from './leads.js';
import { callStatuses, categoryFromFields, findStatus, leadFields, matchOption } from './calling.js';
import { readTable } from './files.js';

export const MAX_ROWS = 20_000;

/** The fields each import fills, with the column names that map to them. */
export const IMPORT_FIELDS = {
  LEADS: {
    category: ['category', 'lead category', 'type', 'customer type', 'who'],
    organization_name: ['organization', 'organisation', 'company', 'company name', 'organization name', 'account'],
    contact_name: ['name', 'contact', 'contact name', 'full name', 'person'],
    designation: ['designation', 'title', 'job title', 'role'],
    email: ['email', 'email address', 'e-mail'],
    phone: ['phone', 'mobile', 'phone number', 'mobile number', 'contact number', 'whatsapp'],
    website: ['website', 'url', 'web'],
    city: ['city', 'district', 'town'],
    state: ['state', 'region'],
    country: ['country'],
    requirement: ['requirement', 'requirements', 'need', 'product interest'],
    enquiry: ['enquiry', 'inquiry', 'message', 'notes', 'comments'],
    budget_amount: ['budget', 'budget amount', 'value', 'expected value'],
    currency: ['currency'],
    priority: ['priority'],
    owner_email: ['owner', 'owner email', 'assigned to', 'sales owner'],
    source: ['source', 'lead source', 'original source'],
    campaign: ['campaign', 'campaign name'],
    utm_source: ['utm_source', 'utm source'],
    utm_medium: ['utm_medium', 'utm medium'],
    utm_campaign: ['utm_campaign', 'utm campaign'],
    external_id: ['external id', 'external_id', 'lead id', 'id', 'crm id'],
    source_system: ['source system', 'system', 'platform'],
    captured_at: ['captured at', 'created', 'created at', 'created on', 'date', 'enquiry date'],
    modified_at: ['modified on', 'modified at', 'updated on', 'updated at', 'last modified'],
    tags: ['tags', 'labels', 'lists', 'batch names'],
    call_status: ['status', 'calling status', 'call status', 'lead status', 'disposition'],
    lost_reason: ['lost reason', 'reason lost', 'disqualify reason'],
    rating: ['rating', 'stars'],
    notes: ['remarks', 'call notes', 'agent notes', 'first call description', 'first call descripton'],
  },
  ACCOUNTS: {
    category: ['category', 'lead category', 'customer type'],
    name: ['organization', 'organisation', 'company', 'name', 'organization name', 'account'],
    org_type: ['organization type', 'org type', 'type'],
    website: ['website', 'url', 'domain'],
    industry: ['industry', 'sector'],
    city: ['city', 'district'],
    state: ['state', 'region'],
    country: ['country'],
    pincode: ['pincode', 'pin code', 'postal code', 'zip'],
    owner_email: ['owner', 'owner email', 'account owner'],
    registration_id: ['registration id', 'cin', 'gstin', 'pan', 'registration number', 'csr registration'],
    external_id: ['external id', 'external_id', 'crm id'],
  },
};

const norm = (h) => String(h || '').trim().toLowerCase().replace(/[_\s]+/g, ' ');

/** TeleCRM's export columns, and what each fills. A "cf:" field is a lead field. */
const TELECRM_COLUMNS = {
  'status': 'call_status', 'lost reason': 'lost_reason', 'rating': 'rating', 'assignee emailid': 'owner_email', 'full name': 'contact_name',
  'mobile number': 'phone', 'first call descripton': 'notes', 'first call description': 'notes',
  'you are associated with agriculture as': 'cf:agri_role', 'service needed': 'cf:service_needed', 'state lead belongs to': 'state',
  'company name or shop name': 'organization_name', 'shop duration': 'cf:shop_duration', 'event name': 'cf:event_name', 'district': 'city',
  'designation': 'designation', 'e-mail address': 'email', 'campaign name': 'campaign', 'how did you hear about us': 'source',
  'created on': 'captured_at', 'modified on': 'modified_at', 'lead link': 'cf:telecrm_link', 'lead id': 'external_id',
  'batch names': 'tags', 'date': 'cf:telecrm_date',
};

/** Which preset reads a file, from its columns. */
export function detectPreset(header) {
  const h = new Set(header.map(norm));
  return h.has('lead id') && (h.has('lead link') || h.has('assignee emailid')) ? 'TELECRM' : null;
}

/** How a preset reads a file unless the person says otherwise. */
export const PRESET_OPTIONS = {
  TELECRM: { source_system: 'telecrm', duplicate_strategy: 'UPDATE', create_campaigns: true, run_automation: false, unknown_owner: 'WARN', blank_markers: true },
};

function presetMapping(preset, header) {
  if (preset !== 'TELECRM') return null;
  const mapping = {};
  for (const h of header) {
    const field = TELECRM_COLUMNS[norm(h)];
    if (field && !mapping[field]) mapping[field] = h;
  }
  return mapping;
}

export function guessMapping(entity, header) {
  const fields = IMPORT_FIELDS[entity];
  const mapping = {};
  const taken = new Set();
  for (const [field, names] of Object.entries(fields)) {
    const i = header.findIndex((h, idx) => !taken.has(idx) && (norm(h) === norm(field) || names.includes(norm(h))));
    if (i >= 0) { mapping[field] = header[i]; taken.add(i); }
  }
  return mapping;
}

// ---------------------------------------------------------------- upload

export async function uploadImport({ entity, buffer, filename, actor }) {
  if (!IMPORT_FIELDS[entity]) throw badRequest('Import leads or organizations');
  const table = await readTable(buffer, filename);
  if (!table.header.length || table.header.every((h) => !h)) throw badRequest('The first row must name the columns');
  if (table.rows.length > MAX_ROWS) throw badRequest(`At most ${MAX_ROWS.toLocaleString('en-IN')} rows per file; split it`);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const { rows: earlier } = await query(
    `SELECT id, created_at, status FROM crm_import_jobs WHERE file_hash = $1 AND entity = $2 AND status IN ('DONE','RUNNING') ORDER BY id DESC LIMIT 1`, [hash, entity],
  );
  // phone-like columns Excel stored as numbers have lost leading zeros and + signs
  const numericColumns = new Set();
  for (const key of table.numericCells) numericColumns.add(Number(key.split(':')[1]) - 1);
  const preset = entity === 'LEADS' ? detectPreset(table.header) : null;
  const mapping = presetMapping(preset, table.header) || guessMapping(entity, table.header);
  const job = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO crm_import_jobs (entity, filename, file_kind, file_hash, header, mapping, total_rows, created_by, preset)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [entity, String(filename || 'upload').slice(0, 200), table.kind, hash, table.header, mapping, table.rows.length, actor.id, preset],
    );
    const j = rows[0];
    // rows go in a few hundred at a time
    for (let i = 0; i < table.rows.length; i += 500) {
      const chunk = table.rows.slice(i, i + 500);
      const values = [];
      const params = [j.id];
      chunk.forEach((r, k) => {
        const raw = Object.fromEntries(table.header.map((h, c) => [h || `Column ${c + 1}`, r[c] ?? '']));
        params.push(table.rowNumbers[i + k], JSON.stringify(raw));
        values.push(`($1, $${params.length - 1}, $${params.length}::jsonb)`);
      });
      await client.query(`INSERT INTO crm_import_rows (job_id, row_no, raw) VALUES ${values.join(',')}`, params);
    }
    return j;
  });
  const phoneish = /(phone|mobile|whatsapp|contact number|registration|gstin|cin|pincode|pin code|id)/i;
  const unmapped = preset ? table.header.filter((h) => h && !TELECRM_COLUMNS[norm(h)]) : [];
  return {
    job,
    preset,
    preset_options: preset ? PRESET_OPTIONS[preset] : null,
    // columns the preset deliberately leaves out (names repeated elsewhere, empty manager columns)
    preset_ignored: unmapped,
    sample: table.rows.slice(0, 5),
    warnings: [
      ...(earlier[0] ? [`This exact file was imported before (import #${earlier[0].id}, ${new Date(earlier[0].created_at).toISOString().slice(0, 10)}). Rows already imported will be found as duplicates.`] : []),
      ...[...numericColumns].filter((c) => phoneish.test(table.header[c] || '')).map((c) => `"${table.header[c]}" was stored by Excel as numbers, so leading zeros or a + may be lost. Format the column as Text and upload again if that matters.`),
    ],
    fields: Object.keys(IMPORT_FIELDS[entity]),
    custom_fields: entity === 'LEADS' ? (await leadFields({ activeOnly: true })).map((f) => ({ key: `cf:${f.key}`, label: f.label })) : [],
  };
}

// ---------------------------------------------------------------- validate

const BLANK_MARKERS = new Set(['-', '_', '--', 'n/a', 'na', 'null', 'none']);
const pick = (raw, mapping, field, options = {}) => {
  const col = mapping[field];
  if (!col) return undefined;
  const v = raw[col];
  if (v === undefined || v === null) return undefined;
  const t = String(v).trim();
  if (t === '' || (options.blank_markers && BLANK_MARKERS.has(t.toLowerCase()))) return undefined;
  return t;
};

async function lookups() {
  const [{ rows: users }, { rows: sources }, { rows: campaigns }, statuses, fields, settings] = await Promise.all([
    query('SELECT id, lower(email) AS email, is_active FROM users'),
    query('SELECT id, key, lower(name) AS name FROM crm_sources'),
    query('SELECT id, lower(name) AS name FROM crm_campaigns'),
    callStatuses(),
    leadFields({ activeOnly: true }),
    salesSettings(),
  ]);
  const sourceBy = (v) => sources.find((s) => s.key === String(v).toLowerCase() || s.name === String(v).toLowerCase())?.id ?? null;
  return {
    user: new Map(users.map((u) => [u.email, u])),
    source: (v) => sourceBy(v) ?? (sourceKeyFromText(v) ? sourceBy(sourceKeyFromText(v)) : null),
    sourceKey: sourceBy,
    campaign: (v) => campaigns.find((c) => c.name === String(v).trim().toLowerCase())?.id ?? null,
    statuses,
    fields: new Map(fields.map((f) => [f.key, f])),
    fieldList: fields,
    tz: settings.calendar?.timezone || 'Asia/Kolkata',
  };
}

// a district or city typed all in lower case is given capitals; anything else is kept as typed
const tidyPlace = (v) => (v && v === v.toLowerCase() ? v.replace(/\b([a-z])/g, (c) => c.toUpperCase()) : v);

function leadRow(raw, mapping, options, look) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const g = (f) => pick(raw, mapping, f, options);
  const data = {
    organization_name: g('organization_name'), contact_name: g('contact_name'), designation: g('designation'),
    email: g('email'), phone: g('phone'), website: g('website'), city: tidyPlace(g('city')), country: g('country'),
    requirement: g('requirement'), enquiry: g('enquiry'), currency: g('currency')?.toUpperCase(),
    priority: g('priority')?.toUpperCase(), external_id: g('external_id'), source_system: g('source_system') || options.source_system || null,
    tags: g('tags') ? g('tags').split(/[,;]/).map((t) => t.trim()).filter(Boolean).slice(0, 10) : undefined,
    utm: Object.fromEntries([['source', g('utm_source')], ['medium', g('utm_medium')], ['campaign', g('utm_campaign')]].filter(([, v]) => v)),
  };
  // an address or a state as people type them
  if (data.email && !normalizeEmail(data.email)) { warnings.push(`Email "${data.email}" is not an email address; left out`); delete data.email; }
  const state = g('state');
  if (state) {
    data.state = normalizeState(state) || state;
    if (!normalizeState(state)) warnings.push(`State "${state}" is not an Indian state TaskFlow recognises; kept as given`);
  }
  // the answers to the lead's own questions
  const custom = {};
  for (const [field, col] of Object.entries(mapping)) {
    if (!field.startsWith('cf:') || !col) continue;
    const key = field.slice(3);
    const def = look.fields.get(key);
    const v = g(field);
    if (!def || v === undefined) continue;
    if (def.type === 'SELECT' || def.type === 'MULTI_SELECT') {
      const m = matchOption(def, v);
      if (m) custom[key] = m;
      else { warnings.push(`${def.label}: "${v}" is not one of its choices; kept as a note`); notes.push(`${def.label}: ${v}`); }
    } else if (def.type === 'URL') {
      if (/^https?:\/\/\S+$/i.test(v)) custom[key] = v.slice(0, 500); else notes.push(`${def.label}: ${v}`);
    } else if (def.type === 'NUMBER') {
      const n = Number(v.replace(/[,\s₹]/g, ''));
      if (Number.isFinite(n)) custom[key] = n; else notes.push(`${def.label}: ${v}`);
    } else custom[key] = v.slice(0, def.type === 'LONG_TEXT' ? 5000 : 500);
  }
  if (Object.keys(custom).length) data.custom_fields = custom;
  // the calling status, and what it says about the lead
  const statusText = g('call_status');
  const status = statusText ? findStatus(look.statuses, statusText) : null;
  if (statusText && !status) warnings.push(`Calling status "${statusText}" is not in the list; add it in Settings, or the lead starts without one`);
  if (status) {
    data.call_status_id = status.id;
    data.status = status.lifecycle;
    if (status.lifecycle === 'DISQUALIFIED') data.disqualify_reason = g('lost_reason') || status.label;
  } else if (g('lost_reason')) notes.push(`Lost reason: ${g('lost_reason')}`);
  const rating = g('rating');
  if (rating !== undefined) {
    const n = Number(rating);
    if (Number.isInteger(n) && n >= 1 && n <= 5) data.rating = n; else warnings.push(`Rating "${rating}" is not one to five; left out`);
  }
  // who it is: the file's category column, else what an answer or the status says, else the import's default
  const categoryText = g('category') ?? null;
  let category = categoryText ? categoryFromInput(categoryText) : 'UNCLASSIFIED';
  if (categoryText && category === 'UNCLASSIFIED' && !/^unclassified$/i.test(categoryText)) warnings.push(`Category "${categoryText}" was not recognised; the lead waits for classification`);
  if (category === 'UNCLASSIFIED') category = categoryFromFields(custom, look.fieldList)?.category || status?.implies_category || 'UNCLASSIFIED';
  if (category === 'UNCLASSIFIED' && options.default_category) category = categoryFromInput(options.default_category);
  data.category = category;
  if (g('budget_amount') !== undefined) {
    const n = Number(String(g('budget_amount')).replace(/[,\s₹]/g, ''));
    if (!Number.isFinite(n) || n < 0) errors.push(`Budget "${g('budget_amount')}" is not an amount`); else data.budget_amount = n;
  }
  if (data.currency && !/^[A-Z]{3}$/.test(data.currency)) errors.push(`Currency "${data.currency}" is not a three-letter code`);
  if (data.priority && !['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(data.priority)) errors.push(`Priority must be Low, Medium, High or Urgent`);
  for (const [field, out] of [['captured_at', 'captured_at'], ['modified_at', 'modified_at']]) {
    const text = g(field);
    if (!text) continue;
    const iso = parseImportDate(text, look.tz) || (Number.isNaN(new Date(text).getTime()) ? null : new Date(text).toISOString());
    if (!iso || new Date(iso).getTime() > Date.now() + 86_400_000) {
      if (field === 'captured_at') errors.push(`Date "${text}" is not a past date`); else warnings.push(`Last-modified "${text}" is not a date; left out`);
    } else data[out] = iso;
  }
  // the business source is kept as given; "imported" is how it came in, not where it came from
  const src = g('source');
  if (src) {
    data.source_id = look.source(src);
    if (!data.source_id) warnings.push(`Source "${src}" is not in the list; add it in Settings or the lead keeps no source`);
  } else if (custom.event_name) data.source_id = look.sourceKey('event');
  else if (options.source_id) data.source_id = options.source_id;
  const camp = g('campaign');
  if (camp) {
    data.campaign_id = look.campaign(camp);
    if (!data.campaign_id) {
      if (options.create_campaigns) data.campaign_name = camp.slice(0, 160);
      else warnings.push(`Campaign "${camp}" is not in the list`);
    }
  } else if (options.campaign_id) data.campaign_id = options.campaign_id;
  // the agent's notes, kept on the timeline
  const text = g('notes');
  if (text) notes.unshift(text);
  if (notes.length) data.import_notes = notes;
  // the owner: worked here means owned here, whatever the category
  const worked = isEligible(category) || (category === 'UNCLASSIFIED' && teleSalesHere());
  const ownerEmail = g('owner_email');
  if (ownerEmail) {
    const u = look.user.get(ownerEmail.toLowerCase());
    const problem = !u ? `"${ownerEmail}" is not a TaskFlow user` : !u.is_active ? `"${ownerEmail}" is no longer active` : null;
    if (problem && options.unknown_owner === 'WARN') {
      warnings.push(`Owner ${problem}; ${options.default_owner_id ? 'given to the default owner instead' : 'left unassigned'}`);
      if (options.default_owner_id && worked) data.owner_user_id = options.default_owner_id;
    } else if (problem) errors.push(`Owner ${problem}`);
    else if (worked) data.owner_user_id = u.id;
  } else if (options.default_owner_id && worked) data.owner_user_id = options.default_owner_id;
  for (const [f, msg] of Object.entries(validateLead(data))) errors.push(`${f.replace(/_/g, ' ')}: ${msg}`);
  return { data, errors, warnings };
}

function accountRow(raw, mapping, options, look) {
  const errors = [];
  const warnings = [];
  const g = (f) => pick(raw, mapping, f);
  const categoryText = g('category') ?? options.default_category;
  const category = categoryText ? categoryFromInput(categoryText) : 'UNCLASSIFIED';
  const data = {
    category, name: g('name'), website: g('website'), industry: g('industry'), city: g('city'), state: g('state'), country: g('country'),
    pincode: g('pincode'), registration_id: g('registration_id'), external_id: g('external_id'),
  };
  const orgType = g('org_type')?.toUpperCase().replace(/[\s/-]+/g, '_');
  if (orgType) { if (!ORG_TYPES.includes(orgType)) warnings.push(`Organization type "${g('org_type')}" was not recognised`); else data.org_type = orgType; }
  if (!data.name) errors.push('name: The organization name is needed');
  if (!categoryText) warnings.push('No category: the organization waits for classification');
  const ownerEmail = g('owner_email');
  if (ownerEmail) {
    const u = look.user.get(ownerEmail.toLowerCase());
    if (!u?.is_active) errors.push(`Owner "${ownerEmail}" is not an active TaskFlow user`); else data.owner_user_id = u.id;
  } else if (options.default_owner_id) data.owner_user_id = options.default_owner_id;
  return { data, errors, warnings };
}

/** Checks every row with the mapping and options, and records each row's status. */
export async function validateImport(jobId, { mapping, options: given = {} }, actor) {
  const { rows: jobs } = await query('SELECT * FROM crm_import_jobs WHERE id = $1', [jobId]);
  const job = jobs[0];
  if (!job) throw notFound('Import not found');
  if (!['UPLOADED', 'VALIDATED'].includes(job.status)) throw conflict('This import has already run');
  // a preset's way of reading the file, unless the person chose otherwise
  const options = { ...(PRESET_OPTIONS[job.preset] || {}), ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
  const fields = IMPORT_FIELDS[job.entity];
  const look = await lookups();
  for (const [f, col] of Object.entries(mapping || {})) {
    const known = fields[f] || (job.entity === 'LEADS' && f.startsWith('cf:') && look.fields.has(f.slice(3)));
    if (!known) throw badRequest(`Unknown field "${f}"`);
    if (col && !job.header.includes(col)) throw badRequest(`The file has no column "${col}"`);
  }
  const strategy = ['SKIP', 'UPDATE', 'CREATE'].includes(options.duplicate_strategy) ? options.duplicate_strategy : 'SKIP';
  const { rows } = await query('SELECT id, row_no, raw FROM crm_import_rows WHERE job_id = $1 ORDER BY row_no', [jobId]);
  const seen = { ext: new Map(), email: new Map(), phone: new Map(), domain: new Map(), name: new Map() };
  const counts = { total: rows.length, valid: 0, invalid: 0, duplicate: 0, routed: 0, warnings: 0 };
  await withTransaction(async (client) => {
    for (const r of rows) {
      const built = job.entity === 'LEADS' ? leadRow(r.raw, mapping, options, look) : accountRow(r.raw, mapping, options, look);
      const { data, errors, warnings } = built;
      let status = errors.length ? 'INVALID' : 'VALID';
      let duplicateOf = null;
      if (status !== 'INVALID') {
        if (job.entity === 'LEADS') {
          const email = normalizeEmail(data.email);
          const phone = normalizePhone(data.phone);
          // inside the file first. Two rows the other system keeps under different ids are
          // two records there: they are both imported, and a shared email or phone is flagged
          const extKey = data.external_id ? `${data.source_system}|${data.external_id}` : null;
          const sameExt = extKey && seen.ext.get(extKey);
          const shared = (email && seen.email.get(email)) || (phone && seen.phone.get(phone));
          if (sameExt) { status = 'DUPLICATE'; warnings.push(`Same record as row ${sameExt} of this file`); }
          else if (shared && !extKey) { status = 'DUPLICATE'; warnings.push(`Same person as row ${shared.row} of this file`); }
          else if (shared) warnings.push(`Shares an email or phone with row ${shared.row}, which ${shared.ext ? 'the other system keeps as a different record' : 'has no id'}; check for a duplicate after importing`);
          if (extKey) seen.ext.set(extKey, r.row_no);
          if (email && !seen.email.has(email)) seen.email.set(email, { row: r.row_no, ext: extKey });
          if (phone && !seen.phone.has(phone)) seen.phone.set(phone, { row: r.row_no, ext: extKey });
          if (status !== 'DUPLICATE') {
            const { rows: found } = await client.query(
              `SELECT id, ref, external_id, source_system FROM crm_leads WHERE merged_into_id IS NULL AND (
                 ($1::text IS NOT NULL AND external_id = $1 AND source_system IS NOT DISTINCT FROM $2)
                 OR ($3::text IS NOT NULL AND email_normalized = $3) OR ($4::text IS NOT NULL AND phone_normalized = $4))
               ORDER BY (external_id = $1 AND source_system IS NOT DISTINCT FROM $2) DESC NULLS LAST, id LIMIT 5`,
              [data.external_id ?? null, data.source_system ?? null, email, phone],
            );
            const exact = found.find((f) => data.external_id && f.external_id === data.external_id && f.source_system === data.source_system);
            // a lead the same system knows under another id is a different record of that system
            const match = exact || found.find((f) => !(data.external_id && f.external_id && f.source_system === data.source_system));
            if (match) {
              duplicateOf = match.id;
              // the same external id is always the same record; a shared email or phone is the person's choice
              status = exact || strategy !== 'CREATE' ? 'DUPLICATE' : status;
              warnings.push(`Matches lead ${match.ref}${exact ? ' (same external id)' : ''}`);
            } else if (found[0]) warnings.push(`Shares an email or phone with lead ${found[0].ref}, a different record in ${data.source_system}; check for a duplicate`);
          }
          if (status === 'VALID' && isExcluded(data.category)) status = 'ROUTED';
        } else {
          const domain = companyDomain(data.website);
          const nameKey = String(data.name || '').toLowerCase().replace(/\b(private|pvt|limited|ltd|llp|inc)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
          const inFile = (domain && seen.domain.get(domain)) || (nameKey && seen.name.get(nameKey));
          if (inFile) { status = 'DUPLICATE'; warnings.push(`Same organization as row ${inFile} of this file`); }
          if (domain) seen.domain.set(domain, r.row_no);
          if (nameKey) seen.name.set(nameKey, r.row_no);
          if (status !== 'DUPLICATE') {
            const { rows: found } = await client.query(
              `SELECT id, name FROM accounts WHERE merged_into_id IS NULL AND is_archived = FALSE AND (
                 ($1::text IS NOT NULL AND lower(domain) = $1) OR regexp_replace(regexp_replace(lower(name), '\\m(private|pvt|limited|ltd|llp|inc)\\M\\.?', '', 'g'), '[^a-z0-9]', '', 'g') = $2)
               LIMIT 1`, [domain, nameKey],
            );
            if (found[0]) { duplicateOf = found[0].id; status = strategy === 'CREATE' ? status : 'DUPLICATE'; warnings.push(`Matches organization "${found[0].name}"`); }
          }
          if (status === 'VALID' && (isExcluded(data.category))) status = 'ROUTED';
        }
      }
      counts[status === 'VALID' ? 'valid' : status.toLowerCase()] += 1;
      if (warnings.length) counts.warnings += 1;
      await client.query(
        'UPDATE crm_import_rows SET data = $2, status = $3, errors = $4, warnings = $5, duplicate_of = $6 WHERE id = $1',
        [r.id, JSON.stringify(data), status, errors, warnings, duplicateOf],
      );
    }
    await client.query(
      `UPDATE crm_import_jobs SET mapping = $2, options = $3, counts = $4, status = 'VALIDATED', validated_at = now() WHERE id = $1`,
      [jobId, mapping, { ...options, duplicate_strategy: strategy }, counts],
    );
  });
  void actor;
  return counts;
}

// ---------------------------------------------------------------- process

export async function startImport(jobId, actor) {
  const { rows } = await query(
    `UPDATE crm_import_jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status IN ('VALIDATED','RUNNING','FAILED') RETURNING *`, [jobId],
  );
  if (!rows[0]) throw conflict('Validate the import before running it');
  await recordAuditEvent(null, { action: 'CRM_IMPORT_STARTED', entityType: 'IMPORT', entityId: jobId, actorId: actor.id, summary: `${rows[0].entity} from ${rows[0].filename}`, detail: rows[0].counts });
  return rows[0];
}

const FILLABLE_LEAD = ['organization_name', 'contact_name', 'designation', 'email', 'phone', 'website', 'city', 'state', 'country', 'requirement', 'enquiry'];

/**
 * Applies pending rows of running imports, a batch at a time. Called by the
 * worker; safe to call again at any point.
 */
export async function processImports({ batch = 200 } = {}) {
  const { rows: jobs } = await query(`SELECT * FROM crm_import_jobs WHERE status = 'RUNNING' ORDER BY id LIMIT 3`);
  let applied = 0;
  for (const job of jobs) {
    const { rows: users } = await query('SELECT * FROM users WHERE id = $1', [job.created_by]);
    const actor = users[0] || { id: null };
    const { rows: pending } = await query(
      `SELECT * FROM crm_import_rows WHERE job_id = $1 AND applied_at IS NULL AND status IN ('VALID','ROUTED','DUPLICATE') ORDER BY row_no LIMIT $2`, [job.id, batch],
    );
    for (const row of pending) {
      try {
        await applyRow(job, row, actor);
        applied += 1;
      } catch (err) {
        await query(`UPDATE crm_import_rows SET status = 'INVALID', errors = errors || $2::text[], applied_at = now() WHERE id = $1`, [row.id, [`Not imported: ${err.message}`]]);
      }
    }
    const { rows: left } = await query(`SELECT COUNT(*)::int AS n FROM crm_import_rows WHERE job_id = $1 AND applied_at IS NULL AND status IN ('VALID','ROUTED','DUPLICATE')`, [job.id]);
    const { rows: tally } = await query(`SELECT status, COUNT(*)::int AS n FROM crm_import_rows WHERE job_id = $1 GROUP BY status`, [job.id]);
    const counts = { ...job.counts, result: Object.fromEntries(tally.map((t) => [t.status.toLowerCase(), t.n])) };
    const processed = tally.filter((t) => ['IMPORTED', 'UPDATED', 'SKIPPED', 'ROUTED'].includes(t.status)).reduce((s, t) => s + t.n, 0);
    await query(
      `UPDATE crm_import_jobs SET counts = $2, processed_rows = $3, status = CASE WHEN $4 = 0 THEN 'DONE' ELSE status END,
              finished_at = CASE WHEN $4 = 0 THEN now() ELSE finished_at END WHERE id = $1`,
      [job.id, counts, processed, left[0].n],
    );
    if (left[0].n === 0) await recordAuditEvent(null, { action: 'CRM_IMPORT_DONE', entityType: 'IMPORT', entityId: job.id, actorId: job.created_by, summary: `${job.entity}: ${JSON.stringify(counts.result)}` });
  }
  return { applied };
}

async function campaignFor(client, data) {
  if (data.campaign_id || !data.campaign_name) return data.campaign_id ?? null;
  const { rows: found } = await client.query('SELECT id FROM crm_campaigns WHERE lower(name) = lower($1) LIMIT 1', [data.campaign_name]);
  if (found[0]) return found[0].id;
  const key = data.campaign_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || `campaign-${Date.now()}`;
  const { rows } = await client.query(
    `INSERT INTO crm_campaigns (key, name, notes) VALUES ($1, $2, 'Added by an import; set its dates and spend in Settings')
     ON CONFLICT (key) DO UPDATE SET name = crm_campaigns.name RETURNING id`, [key, data.campaign_name],
  );
  return rows[0].id;
}

/**
 * What an imported lead brings from the system it came from: the agent's
 * notes on its timeline (marked as imported, dated now: the file does not say
 * when they were written), and its clocks. The other system's last-modified
 * time stands in for the last call when its status says someone was called,
 * and for the last conversation when its status says they spoke — so leads
 * worked before are not raised as never contacted.
 */
async function applyHistory(client, leadId, data, job, rowNo) {
  const { rows: done } = await client.query(
    `SELECT 1 FROM crm_lead_activities WHERE lead_id = $1 AND type = 'IMPORT_NOTE' AND meta->>'import_row' = $2 LIMIT 1`, [leadId, `${job.id}:${rowNo}`],
  );
  if (done[0]) return;
  const from = job.preset === 'TELECRM' ? 'TeleCRM' : job.filename;
  for (const body of data.import_notes || []) {
    await logLeadActivity(client, leadId, { type: 'IMPORT_NOTE', subject: `Notes from ${from}`, body, meta: { import_row: `${job.id}:${rowNo}`, from } });
  }
  if (!(data.import_notes || []).length) {
    await client.query(`INSERT INTO crm_lead_activities (lead_id, type, direction, subject, meta) VALUES ($1, 'IMPORT_NOTE', 'INTERNAL', $2, $3)`,
      [leadId, `Imported from ${from}`, { import_row: `${job.id}:${rowNo}`, from }]);
  }
  const { rows: st } = data.call_status_id ? await client.query('SELECT * FROM crm_call_statuses WHERE id = $1', [data.call_status_id]) : { rows: [] };
  const status = st[0];
  const at = data.modified_at || data.captured_at || null;
  const called = status && status.outcome !== 'NONE';
  const spoke = status?.outcome === 'CONNECTED';
  const retry = status?.retry_after_minutes && !['WON', 'DISQUALIFIED'].includes(status.lifecycle);
  await client.query(
    `UPDATE crm_leads SET last_activity_at = COALESCE($2::timestamptz, captured_at),
            disqualify_reason = CASE WHEN status = 'DISQUALIFIED' THEN COALESCE($7, disqualify_reason) ELSE disqualify_reason END,
            last_called_at = CASE WHEN $3 THEN $2::timestamptz ELSE last_called_at END,
            first_response_at = CASE WHEN $3 THEN COALESCE(first_response_at, $2::timestamptz) ELSE first_response_at END,
            last_contacted_at = CASE WHEN $4 THEN $2::timestamptz ELSE last_contacted_at END,
            retry_at = CASE WHEN $5 THEN $2::timestamptz + make_interval(mins => $6::int) ELSE retry_at END
      WHERE id = $1`,
    [leadId, at, Boolean(called && at), Boolean(spoke && at), Boolean(retry && at), status?.retry_after_minutes ?? 0, data.disqualify_reason ?? null],
  );
}

async function applyRow(job, row, actor) {
  const strategy = job.options?.duplicate_strategy || 'SKIP';
  const data = row.data || {};
  if (job.entity === 'LEADS') {
    if (row.status === 'DUPLICATE') {
      if (strategy !== 'UPDATE' || !row.duplicate_of) {
        await query(`UPDATE crm_import_rows SET status = 'SKIPPED', applied_at = now() WHERE id = $1`, [row.id]);
        return;
      }
      // fill what the existing lead is missing; never overwrite a value with a blank or a different one —
      // except what the other system owns (its status, rating, lost reason) while nobody here has changed it
      await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE', [row.duplicate_of]);
        const lead = rows[0];
        const before = {};
        const sets = [];
        const kept = [];
        const params = [lead.id];
        for (const f of FILLABLE_LEAD) {
          if (data[f] && !lead[f]) { before[f] = lead[f]; params.push(cleanText(data[f], 2000)); sets.push(`${f} = $${params.length}`); }
        }
        if (data.email && !lead.email) { params.push(normalizeEmail(data.email)); sets.push(`email_normalized = $${params.length}`); }
        if (data.phone && !lead.phone) { params.push(normalizePhone(data.phone)); sets.push(`phone_normalized = $${params.length}`); }
        if (data.owner_user_id && !lead.owner_user_id) { before.owner_user_id = null; params.push(data.owner_user_id); sets.push(`owner_user_id = $${params.length}`, 'assigned_at = now()'); }
        const custom = { ...(lead.custom_fields || {}) };
        let customChanged = false;
        for (const [k, v] of Object.entries(data.custom_fields || {})) if (custom[k] === undefined || custom[k] === null) { custom[k] = v; customChanged = true; }
        if (customChanged) { before.custom_fields = lead.custom_fields; params.push(custom); sets.push(`custom_fields = $${params.length}`); }
        const ownedThere = !lead.call_status_source || lead.call_status_source === 'IMPORT';
        if (data.call_status_id && data.call_status_id !== lead.call_status_id) {
          if (ownedThere && lead.status !== 'CONVERTED') {
            Object.assign(before, { call_status_id: lead.call_status_id, status: lead.status, disqualify_reason: lead.disqualify_reason });
            params.push(data.call_status_id); sets.push(`call_status_id = $${params.length}`, `call_status_at = now()`, `call_status_source = 'IMPORT'`);
            params.push(data.status); sets.push(`status = $${params.length}`);
            if (data.disqualify_reason) { params.push(data.disqualify_reason); sets.push(`disqualify_reason = $${params.length}`); }
          } else kept.push('Calling status changed in TaskFlow since; kept');
        }
        if (data.rating && data.rating !== lead.rating && ownedThere) { before.rating = lead.rating; params.push(data.rating); sets.push(`rating = $${params.length}`); }
        if (sets.length) await client.query(`UPDATE crm_leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
        // notes the lead has not had yet
        const { rows: had } = await client.query(`SELECT body FROM crm_lead_activities WHERE lead_id = $1 AND type = 'IMPORT_NOTE' AND body IS NOT NULL`, [lead.id]);
        const fresh = (data.import_notes || []).filter((n) => !had.some((h) => h.body === n));
        for (const body of fresh) {
          await logLeadActivity(client, lead.id, { type: 'IMPORT_NOTE', subject: `Notes from ${job.preset === 'TELECRM' ? 'TeleCRM' : job.filename}`, body, meta: { import_row: `${job.id}:${row.row_no}` } });
        }
        const changed = sets.length > 0 || fresh.length > 0;
        await client.query(
          `UPDATE crm_import_rows SET status = $2, entity_id = $3, before = $4, applied_at = now(), warnings = warnings || $5::text[] WHERE id = $1`,
          [row.id, changed ? 'UPDATED' : 'SKIPPED', lead.id, before, [...kept, ...(changed ? [] : ['Nothing new to add to the existing lead'])]],
        );
      });
      return;
    }
    const campaignId = await withTransaction((client) => campaignFor(client, data));
    const input = { ...data, campaign_id: campaignId };
    delete input.campaign_name;
    const { lead } = await createLead(input, {
      actor, channel: 'IMPORT', sourceSystem: data.source_system || null, idempotencyKey: `import:${job.id}:${row.row_no}`, importJobId: job.id, origin: 'USER',
      quiet: job.options?.run_automation === false,
    });
    await withTransaction((client) => applyHistory(client, lead.id, data, job, row.row_no));
    await query(`UPDATE crm_import_rows SET status = $2, entity_id = $3, applied_at = now() WHERE id = $1`,
      [row.id, lead.destination === 'TELECRM' ? 'ROUTED' : 'IMPORTED', lead.id]);
    return;
  }
  // organizations
  if (row.status === 'DUPLICATE') {
    await query(`UPDATE crm_import_rows SET status = 'SKIPPED', applied_at = now(), warnings = warnings || $2::text[] WHERE id = $1`,
      [row.id, ['Existing organization kept as it is; update it on its page if needed']]);
    return;
  }
  if (isExcluded(data.category)) {
    // a retailer, FPO or individual is not an organization here: it goes to TeleCRM as a lead
    const { lead } = await createLead({ category: data.category, organization_name: data.name, website: data.website, city: data.city, state: data.state, country: data.country },
      { actor, channel: 'IMPORT', idempotencyKey: `import:${job.id}:${row.row_no}`, importJobId: job.id });
    await query(`UPDATE crm_import_rows SET status = 'ROUTED', entity_id = $2, applied_at = now() WHERE id = $1`, [row.id, lead.id]);
    return;
  }
  await withTransaction(async (client) => {
    const { rows: done } = await client.query('SELECT entity_id FROM crm_import_rows WHERE id = $1 FOR UPDATE', [row.id]);
    if (done[0]?.entity_id) return;
    const eligible = isEligible(data.category);
    const { rows: stage } = await client.query(
      `SELECT s.id FROM account_stages s JOIN crm_pipelines p ON p.id = s.pipeline_id
        WHERE p.key = $1 AND s.kind = 'open' AND s.retired_at IS NULL AND s.is_active = TRUE ORDER BY s.position LIMIT 1`,
      [PIPELINE_FOR_CATEGORY[data.category] || 'b2b'],
    );
    const { rows: owner } = await client.query('SELECT department_id FROM users WHERE id = $1', [data.owner_user_id ?? actor.id ?? 0]);
    const { rows } = await client.query(
      `INSERT INTO accounts (name, type, stage_id, owner_user_id, department_id, website, domain, industry, city, state, country, pincode,
                             lead_category, routing_status, category_source, category_set_at, category_set_by, org_type, registration_ids, created_by)
       VALUES ($1,'LEAD',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'IMPORT',now(),$14,$15,$16,$14) RETURNING id`,
      [data.name, stage[0]?.id ?? null, data.owner_user_id ?? actor.id ?? null, owner[0]?.department_id ?? null, data.website || null,
        companyDomain(data.website), data.industry || null, data.city || null, data.state || null, data.country || null, data.pincode || null,
        eligible ? data.category : null, eligible ? 'ACTIVE' : 'NEEDS_CLASSIFICATION', actor.id ?? null, data.org_type || null,
        data.registration_id ? JSON.stringify({ imported: data.registration_id }) : '{}'],
    );
    await client.query(`UPDATE crm_import_rows SET status = 'IMPORTED', entity_id = $2, applied_at = now() WHERE id = $1`, [row.id, rows[0].id]);
  });
}

// ---------------------------------------------------------------- undo

/**
 * Undoes an import without losing later work: a record the import created is
 * archived only if nobody has touched it since; a field the import filled is
 * cleared only if it still holds what the import put there.
 */
export async function undoImport(jobId, actor) {
  const { rows: jobs } = await query('SELECT * FROM crm_import_jobs WHERE id = $1', [jobId]);
  const job = jobs[0];
  if (!job) throw notFound('Import not found');
  if (job.status !== 'DONE') throw conflict(job.status === 'UNDONE' ? 'This import was already undone' : 'Only a finished import can be undone');
  const summary = { archived: 0, restored: 0, kept: 0, reasons: [] };
  await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM crm_import_rows WHERE job_id = $1 AND status IN ('IMPORTED','UPDATED','ROUTED') ORDER BY row_no FOR UPDATE`, [jobId]);
    for (const r of rows) {
      const keep = async (why) => {
        summary.kept += 1;
        if (summary.reasons.length < 200) summary.reasons.push({ row: r.row_no, why });
        await client.query(`UPDATE crm_import_rows SET status = 'KEPT', warnings = warnings || $2::text[] WHERE id = $1`, [r.id, [`Kept on undo: ${why}`]]);
      };
      if (job.entity === 'LEADS' && ['IMPORTED', 'ROUTED'].includes(r.status)) {
        const { rows: l } = await client.query(
          `SELECT l.*, (SELECT COUNT(*)::int FROM crm_lead_activities a WHERE a.lead_id = l.id
                          AND a.type NOT IN ('CAPTURE', 'ASSIGNMENT', 'ROUTING', 'IMPORT_NOTE')) AS worked,
                  (SELECT COUNT(*)::int FROM tasks t WHERE t.crm_lead_id = l.id) AS tasks,
                  (SELECT COUNT(*)::int FROM crm_handoffs h WHERE h.lead_id = l.id AND h.status <> 'PENDING') AS handed
             FROM crm_leads l WHERE l.id = $1 FOR UPDATE`, [r.entity_id],
        );
        const lead = l[0];
        if (!lead) { await keep('the lead no longer exists'); continue; }
        if (lead.status === 'CONVERTED') { await keep(`${lead.ref} has been converted`); continue; }
        if (lead.worked || lead.tasks) { await keep(`${lead.ref} has been worked on since (activities or follow-ups)`); continue; }
        if (lead.handed) { await keep(`${lead.ref} was already exported to TeleCRM`); continue; }
        if (lead.merged_into_id) { await keep(`${lead.ref} was merged`); continue; }
        await client.query(`UPDATE crm_leads SET is_archived = TRUE, archived_at = now(), archived_by = $2, archive_reason = $3, updated_at = now() WHERE id = $1`,
          [lead.id, actor.id, `Import #${jobId} undone`]);
        await client.query(`UPDATE crm_handoffs SET status = 'CANCELLED', cancelled_reason = $2, updated_at = now() WHERE lead_id = $1 AND status = 'PENDING'`, [lead.id, `Import #${jobId} undone`]);
        await client.query(`UPDATE crm_import_rows SET status = 'UNDONE' WHERE id = $1`, [r.id]);
        summary.archived += 1;
      } else if (job.entity === 'LEADS' && r.status === 'UPDATED') {
        const { rows: l } = await client.query('SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE', [r.entity_id]);
        const lead = l[0];
        const restore = Object.keys(r.before || {}).filter((f) => lead && String(lead[f] ?? '') === String(cleanText(r.data?.[f], 2000) ?? ''));
        if (!restore.length) { await keep('the fields it filled have been changed since'); continue; }
        await client.query(`UPDATE crm_leads SET ${restore.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
          [lead.id, ...restore.map((f) => r.before[f])]);
        await client.query(`UPDATE crm_import_rows SET status = 'UNDONE' WHERE id = $1`, [r.id]);
        summary.restored += 1;
      } else if (job.entity === 'ACCOUNTS' && r.status === 'IMPORTED') {
        const { rows: a } = await client.query(
          `SELECT a.*, (SELECT COUNT(*)::int FROM opportunities o WHERE o.account_id = a.id) AS deals,
                  (SELECT COUNT(*)::int FROM account_contacts c WHERE c.account_id = a.id) AS contacts,
                  (SELECT COUNT(*)::int FROM account_activities x WHERE x.account_id = a.id) AS activities
             FROM accounts a WHERE a.id = $1 FOR UPDATE`, [r.entity_id],
        );
        const acc = a[0];
        if (!acc) { await keep('the organization no longer exists'); continue; }
        if (acc.deals || acc.contacts || acc.activities) { await keep(`${acc.name} has deals, contacts or history since`); continue; }
        await client.query(`UPDATE accounts SET is_archived = TRUE, archived_at = now(), archived_by = $2, archive_reason = $3, updated_at = now() WHERE id = $1`,
          [acc.id, actor.id, `Import #${jobId} undone`]);
        await client.query(`UPDATE crm_import_rows SET status = 'UNDONE' WHERE id = $1`, [r.id]);
        summary.archived += 1;
      } else if (r.status === 'ROUTED') {
        await keep('routed leads from an organization import are kept for TeleCRM review');
      }
    }
    await client.query(`UPDATE crm_import_jobs SET status = 'UNDONE', undone_at = now(), undone_by = $2, undo_summary = $3 WHERE id = $1`, [jobId, actor.id, summary]);
    await recordAuditEvent(client, { action: 'CRM_IMPORT_UNDONE', entityType: 'IMPORT', entityId: jobId, actorId: actor.id, summary: `archived ${summary.archived}, restored ${summary.restored}, kept ${summary.kept}`, detail: summary });
  });
  return summary;
}

/** The rows a person needs to fix, with the reasons, ready to correct and upload again. */
export async function correctionRows(jobId) {
  const { rows: jobs } = await query('SELECT header FROM crm_import_jobs WHERE id = $1', [jobId]);
  if (!jobs[0]) throw notFound('Import not found');
  const { rows } = await query(`SELECT row_no, raw, status, errors, warnings FROM crm_import_rows WHERE job_id = $1 AND (status = 'INVALID' OR array_length(warnings, 1) > 0) ORDER BY row_no`, [jobId]);
  const header = ['Row', 'Status', 'Problems', ...jobs[0].header];
  return { header, rows: rows.map((r) => [r.row_no, r.status, [...r.errors, ...r.warnings].join('; '), ...jobs[0].header.map((h) => r.raw[h] ?? '')]) };
}

export const TEMPLATE = {
  LEADS: {
    header: ['Category', 'Organization', 'Contact name', 'Designation', 'Email', 'Phone', 'Website', 'City', 'State', 'Requirement', 'Budget', 'Currency', 'Source', 'Campaign', 'Owner email', 'External ID', 'Source system'],
    rows: [
      ['B2B Corporate', 'Coromandel Agro Inputs Pvt Ltd', 'Priya Nair', 'Head of Retail', 'priya@example.com', '09876543210', 'https://example.com', 'Hyderabad', 'Telangana', 'Soil testing for 400 dealers', '1200000', 'INR', 'Website enquiry', '', '', 'WEB-1001', 'website'],
      ['CSR/NGO', 'Bharat Agro Foundation', 'Meera Iyer', 'CSR Manager', 'meera@example.org', '+91 98200 00000', 'https://example.org', 'Nagpur', 'Maharashtra', 'Soil health cards for 5,000 farmers', '2500000', 'INR', 'Referral', '', '', 'WEB-1002', 'website'],
      ['Retailer', 'Krishna Agro Store', 'Mahesh', '', '', '09811100011', '', 'Pune', 'Maharashtra', 'Wants to stock kits (goes to TeleCRM)', '', '', 'Inbound call', '', '', '', ''],
    ],
    textColumns: [5, 15],
  },
  ACCOUNTS: {
    header: ['Category', 'Organization', 'Organization type', 'Website', 'Industry', 'City', 'State', 'Country', 'Pincode', 'Owner email', 'Registration ID', 'External ID'],
    rows: [
      ['B2B Corporate', 'Greenfields Agritech Pvt Ltd', 'Company', 'https://greenfields.example', 'Agri inputs', 'Pune', 'Maharashtra', 'India', '411001', '', 'U01100MH2015PTC000000', 'ACC-1'],
      ['CSR/NGO', 'Gram Vikas Trust', 'NGO', 'https://gramvikas.example', 'Rural development', 'Wardha', 'Maharashtra', 'India', '442001', '', '', 'ACC-2'],
    ],
    textColumns: [8, 10, 11],
  },
};

export { LEAD_CATEGORIES };
