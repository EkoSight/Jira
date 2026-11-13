/**
 * Where a lead is: state, district, city/town/village, block or tehsil, an
 * address and a PIN code.
 *
 *   - **States** are the 36 states and union territories, as TaskFlow already
 *     recognises them ("UP", "Maharastra" → the standard name).
 *   - **Districts** are not guessed. No verified district list ships with
 *     TaskFlow; the picker suggests districts already recorded for the state,
 *     and accepts a new one. A verified list (for example the Local Government
 *     Directory) can be dropped in as server/src/data/districts.json, shaped
 *     { "<State>": ["<District>", …] }, and is then offered first.
 *   - **PIN codes** are checked for shape only (six digits, not starting with
 *     0). A PIN does not prove where someone is, and is never used to fill in
 *     a state or district.
 *   - **Suggestions** for existing leads (an import's District column that
 *     went into City, a state or PIN written in a note) wait for a person to
 *     accept or reject. Nothing is filled in by itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { INDIAN_STATES, normalizeState } from './core.js';
import { logLeadActivity } from './leads.js';

export const LOCATION_FIELDS = ['state', 'district', 'city', 'block', 'address_line1', 'address_line2', 'pincode'];
export const LOCATION_LABEL = {
  state: 'State', district: 'District', city: 'City, town or village', block: 'Block or tehsil',
  address_line1: 'Address', address_line2: 'Address (line 2)', pincode: 'PIN code',
};

const PIN = /^[1-9][0-9]{5}$/;
/** A PIN code in the expected shape, or null. Shape only: it says nothing about where the person is. */
export function cleanPincode(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const v = String(value).replace(/\s+/g, '');
  if (!PIN.test(v)) throw badRequest('A PIN code is six digits and does not start with 0', { code: 'BAD_PINCODE' });
  return v;
}

const tidy = (v, max) => {
  if (v === null || v === undefined) return v;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, max);
  if (!s) return null;
  // typed all in lower case: capitalise the words; anything else stays as typed
  return s === s.toLowerCase() ? s.replace(/\b([a-z])/g, (c) => c.toUpperCase()) : s;
};

/**
 * Cleans the location fields present in an input (absent ones stay absent).
 * A state must be one of the states and union territories; "Not known" is a
 * blank, not a guess.
 */
export function cleanLocation(input = {}, { strictState = true } = {}) {
  const out = {};
  if (input.state !== undefined) {
    if (input.state === null || String(input.state).trim() === '') out.state = null;
    else {
      const s = normalizeState(input.state);
      if (!s && strictState) throw badRequest(`"${input.state}" is not an Indian state or union territory; choose one from the list, or leave it blank`, { code: 'BAD_STATE' });
      out.state = s || tidy(input.state, 80);
    }
  }
  for (const [k, max] of [['district', 120], ['city', 120], ['block', 120], ['address_line1', 300], ['address_line2', 300]]) {
    if (input[k] !== undefined) out[k] = tidy(input[k], max);
  }
  if (input.pincode !== undefined) out.pincode = cleanPincode(input.pincode);
  return out;
}

let fileDistricts;
function districtFile() {
  if (fileDistricts !== undefined) return fileDistricts;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    fileDistricts = JSON.parse(fs.readFileSync(path.join(here, '../../data/districts.json'), 'utf8'));
  } catch {
    fileDistricts = null;
  }
  return fileDistricts;
}

/** Districts to offer for a state: a verified list if one is installed, then those already recorded. */
export async function districtSuggestions(state, q = '') {
  const s = normalizeState(state);
  if (!s) return [];
  const needle = String(q || '').trim().toLowerCase();
  const verified = (districtFile()?.[s] || []).map((name) => ({ name, source: 'LIST' }));
  const { rows } = await query(
    `SELECT district AS name, COUNT(*)::int AS leads FROM crm_leads
      WHERE lower(state) = lower($1) AND district IS NOT NULL AND ($2 = '' OR district ILIKE $2 || '%')
      GROUP BY district ORDER BY COUNT(*) DESC, district LIMIT 50`,
    [s, needle],
  );
  const seen = new Set(verified.map((d) => d.name.toLowerCase()));
  const recorded = rows.filter((r) => !seen.has(r.name.toLowerCase())).map((r) => ({ name: r.name, source: 'RECORDED', leads: r.leads }));
  return [...verified.filter((d) => !needle || d.name.toLowerCase().startsWith(needle)), ...recorded].slice(0, 60);
}

export const indianStates = () => [...INDIAN_STATES];

// ---------------------------------------------------------------- suggestions for people to confirm

const STATE_WORDS = INDIAN_STATES.map((s) => [s, new RegExp(`\\b${s.replace(/ /g, '\\s+')}\\b`, 'i')]);
const PIN_IN_TEXT = /\bpin\s*(?:code)?\s*(?:no\.?|number)?\s*[:\-]?\s*([1-9]\d{2}\s?\d{3})\b/i;

/**
 * Builds the review list. Writes suggestions only; never a lead.
 *   IMPORT_DISTRICT_COLUMN  an import mapped a "District" column into City
 *   NOTE_STATE              a lead with no state whose notes name exactly one state
 *   NOTE_PINCODE            a lead with no PIN whose notes say "PIN 452001"
 */
export async function generateLocationSuggestions() {
  const out = { IMPORT_DISTRICT_COLUMN: 0, NOTE_STATE: 0, NOTE_PINCODE: 0 };
  const add = async (leadId, field, value, source, evidence) => {
    const { rowCount } = await query(
      `INSERT INTO crm_location_suggestions (lead_id, field, value, source, evidence) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lead_id, field, value) DO NOTHING`,
      [leadId, field, value, source, evidence ? String(evidence).slice(0, 300) : null],
    );
    out[source] += rowCount;
  };
  const { rows: imported } = await query(
    `SELECT r.entity_id AS lead_id, r.raw, j.mapping->>'city' AS header, j.filename, l.district, l.city
       FROM crm_import_rows r JOIN crm_import_jobs j ON j.id = r.job_id JOIN crm_leads l ON l.id = r.entity_id
      WHERE r.status IN ('IMPORTED', 'UPDATED') AND r.entity_id IS NOT NULL AND j.mapping->>'city' ~* 'district'
        AND l.district IS NULL`,
  );
  for (const r of imported) {
    const value = tidy(r.raw?.[r.header], 120);
    if (value) await add(r.lead_id, 'district', value, 'IMPORT_DISTRICT_COLUMN', `Column "${r.header}" of ${r.filename || 'an import'} (it was stored as City: "${r.city || ''}")`);
  }
  const { rows: notes } = await query(
    `SELECT l.id, l.state, l.pincode, string_agg(COALESCE(a.body, ''), ' ' ORDER BY a.id) || ' ' || COALESCE(l.enquiry, '') || ' ' || COALESCE(l.requirement, '') AS text
       FROM crm_leads l LEFT JOIN crm_lead_activities a ON a.lead_id = l.id AND a.type IN ('CALL', 'NOTE', 'CALL_STATUS', 'IMPORT_NOTE') AND a.body IS NOT NULL
      WHERE l.merged_into_id IS NULL AND (l.state IS NULL OR l.pincode IS NULL)
      GROUP BY l.id`,
  );
  for (const n of notes) {
    if (!n.state) {
      const found = STATE_WORDS.filter(([, re]) => re.test(n.text)).map(([s]) => s);
      // exactly one state named: a suggestion; more than one is ambiguous and left alone
      if (found.length === 1) await add(n.id, 'state', found[0], 'NOTE_STATE', `"${found[0]}" appears in the lead's notes`);
    }
    if (!n.pincode) {
      const m = PIN_IN_TEXT.exec(n.text);
      if (m) await add(n.id, 'pincode', m[1].replace(/\s/g, ''), 'NOTE_PINCODE', `"${m[0]}" in the lead's notes`);
    }
  }
  return { added: out, note: 'Suggestions only: each waits on its lead for someone to accept or reject. No lead was changed.' };
}

/** The review list across leads, one page at a time, limited to the leads the viewer may see. */
export async function listLocationSuggestions({ status = 'PROPOSED', page = 1, pageSize = 50, scopeSql = 'TRUE', params = [] } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const p = [...params, status];
  const where = `s.status = $${p.length} AND ${scopeSql}`;
  const [{ rows }, { rows: count }] = await Promise.all([
    query(
      `SELECT s.*, l.ref, COALESCE(l.organization_name, l.contact_name, l.phone) AS lead_name, l.state, l.district, l.city, l.pincode,
              u.full_name AS owner_name
         FROM crm_location_suggestions s JOIN crm_leads l ON l.id = s.lead_id LEFT JOIN users u ON u.id = l.owner_user_id
        WHERE ${where} ORDER BY s.created_at, s.id LIMIT ${size} OFFSET ${(Math.max(Number(page) || 1, 1) - 1) * size}`,
      p,
    ),
    query(`SELECT COUNT(*)::int AS n FROM crm_location_suggestions s JOIN crm_leads l ON l.id = s.lead_id WHERE ${where}`, p),
  ]);
  return { suggestions: rows, total: count[0].n, page: Math.max(Number(page) || 1, 1), page_size: size };
}

export async function leadSuggestions(leadId) {
  const { rows } = await query(
    `SELECT s.*, u.full_name AS decided_by_name FROM crm_location_suggestions s LEFT JOIN users u ON u.id = s.decided_by
      WHERE s.lead_id = $1 ORDER BY (s.status = 'PROPOSED') DESC, s.created_at`,
    [leadId],
  );
  return rows;
}

const SOURCE_WORDS = { IMPORT_DISTRICT_COLUMN: 'an import\'s District column', NOTE_STATE: 'the lead\'s notes', NOTE_PINCODE: 'the lead\'s notes' };

/** Applies a suggestion to an empty field, after a person accepted it. A filled field is never overwritten. */
export async function acceptSuggestion(id, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM crm_location_suggestions WHERE id = $1 FOR UPDATE', [id]);
    const s = rows[0];
    if (!s) throw notFound('Suggestion not found');
    if (s.status !== 'PROPOSED') throw conflict('That suggestion was already decided');
    const clean = cleanLocation({ [s.field]: s.value });
    const { rows: lead } = await client.query(`SELECT ${s.field} AS value FROM crm_leads WHERE id = $1 FOR UPDATE`, [s.lead_id]);
    if (lead[0]?.value) throw conflict(`The lead already has a ${LOCATION_LABEL[s.field].toLowerCase()} ("${lead[0].value}"); change it in Edit if this is better`);
    await client.query(`UPDATE crm_leads SET ${s.field} = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [s.lead_id, clean[s.field], actor.id]);
    await client.query(`UPDATE crm_location_suggestions SET status = 'ACCEPTED', decided_by = $2, decided_at = now() WHERE id = $1`, [id, actor.id]);
    await logLeadActivity(client, s.lead_id, {
      type: 'LOCATION', subject: `${LOCATION_LABEL[s.field]} set to ${clean[s.field]}`, body: `Suggested from ${SOURCE_WORDS[s.source]}; confirmed by a person.`,
      actorId: actor.id, meta: { suggestion_id: id, field: s.field, source: s.source },
    });
    return { accepted: true, field: s.field, value: clean[s.field] };
  });
}

export async function rejectSuggestion(id, actor) {
  const { rowCount } = await query(
    `UPDATE crm_location_suggestions SET status = 'REJECTED', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'PROPOSED'`,
    [id, actor.id],
  );
  if (!rowCount) throw conflict('That suggestion was already decided');
  return { rejected: true };
}
