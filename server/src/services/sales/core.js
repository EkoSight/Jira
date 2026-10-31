/**
 * The sales CRM's shared rules: lead categories and where each is worked,
 * who may see which records, contact normalization, exact money arithmetic,
 * reference numbers and the event stream automation reads.
 */
import { query } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { getSettings, DEFAULT_SETTINGS } from '../settings.js';

// ---------------------------------------------------------------- categories

/** Organizations sold to as organizations: always worked in TaskFlow. */
export const ORG_CATEGORIES = ['B2B_CORPORATE', 'CSR_NGO'];
/**
 * Retailers, FPOs and individuals: tele-sales. Worked in TaskFlow, or handed to
 * TeleCRM while the setting says so (routing.excludedDestination).
 */
export const TELE_CATEGORIES = ['RETAILER', 'FPO', 'INDIVIDUAL'];
/** Older names, kept for the code and screens that use them. */
export const ELIGIBLE_CATEGORIES = ORG_CATEGORIES;
export const EXCLUDED_CATEGORIES = TELE_CATEGORIES;
export const LEAD_CATEGORIES = [...ORG_CATEGORIES, ...TELE_CATEGORIES, 'UNCLASSIFIED'];
/** Every category a person can give a lead. */
export const KNOWN_CATEGORIES = [...ORG_CATEGORIES, ...TELE_CATEGORIES];

export const CATEGORY_LABEL = {
  B2B_CORPORATE: 'B2B corporate',
  CSR_NGO: 'CSR / NGO',
  RETAILER: 'Retailer',
  FPO: 'FPO (farmer producer organization)',
  INDIVIDUAL: 'Individual / consumer',
  UNCLASSIFIED: 'Needs classification',
};

// Whether tele-sales categories are worked here. Read from the settings each
// time they are loaded (every CRM request and worker pass loads them) and at
// start-up, so the synchronous checks below follow the setting.
let teleHere = true;
export function rememberRouting(settings) {
  teleHere = (settings?.routing?.excludedDestination || 'TASKFLOW') === 'TASKFLOW';
}
export const teleSalesHere = () => teleHere;

/** Worked in TaskFlow's CRM (pipelines, assignment, scoring, totals). */
export const isEligible = (category) => ORG_CATEGORIES.includes(category) || (teleHere && TELE_CATEGORIES.includes(category));
/** Kept out of TaskFlow's active work: handed to TeleCRM or held for review. */
export const isExcluded = (category) => !teleHere && TELE_CATEGORIES.includes(category);
/** An organization sold to as such: it needs an organization name. */
export const isOrgCategory = (category) => ORG_CATEGORIES.includes(category);
/** The categories worked here now. */
export const workedCategories = () => (teleHere ? KNOWN_CATEGORIES : ORG_CATEGORIES);

/** The pipeline key a category's deals live in. */
export const PIPELINE_FOR_CATEGORY = { B2B_CORPORATE: 'b2b', CSR_NGO: 'csr', RETAILER: 'retail', FPO: 'retail', INDIVIDUAL: 'retail' };
/** The categories each pipeline holds. */
export const PIPELINE_CATEGORIES = { b2b: ['B2B_CORPORATE'], csr: ['CSR_NGO'], retail: TELE_CATEGORIES };

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFYING', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED', 'NURTURE', 'WON'];
export const OPEN_LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFYING', 'QUALIFIED'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const ENTRY_CHANNELS = ['MANUAL', 'IMPORT', 'FORM', 'API', 'WEBHOOK', 'EMAIL', 'CALL', 'WHATSAPP', 'ORGANIZATION_FORM'];
export const ORG_TYPES = ['COMPANY', 'CSR_FOUNDATION', 'NGO', 'GOVERNMENT', 'ACADEMIC', 'FPO', 'RETAILER', 'INDIVIDUAL', 'OTHER'];
export const ORG_ROLES = ['COMMERCIAL_CUSTOMER', 'CSR_FUNDER', 'NGO_BUYER', 'IMPLEMENTING_PARTNER', 'REFERRAL_SOURCE', 'CHANNEL_PARTNER', 'VENDOR'];
export const PARTY_ROLES = ['FUNDER', 'CONTRACTING', 'PAYING', 'IMPLEMENTING_PARTNER', 'BUYER', 'REFERRAL', 'PARTNER', 'OTHER'];
export const DECISION_ROLES = ['DECISION_MAKER', 'INFLUENCER', 'PROCUREMENT', 'FINANCE', 'CSR', 'IMPLEMENTING', 'TECHNICAL', 'USER', 'CHAMPION'];
export const FOLLOWUP_KINDS = ['CALL', 'CALLBACK', 'MEETING', 'EMAIL', 'WHATSAPP', 'DEMO', 'DOCUMENT', 'VISIT', 'OTHER'];

// ---------------------------------------------------------------- settings

export async function salesSettings() {
  const all = await getSettings();
  const settings = all.crm?.sales || DEFAULT_SETTINGS.crm.sales;
  rememberRouting(settings);
  return settings;
}

export async function legacyIncluded() {
  return (await salesSettings()).routing?.legacyUnclassified !== 'EXCLUDE';
}

/**
 * The SQL condition for "this organization is inside Taskflow's CRM": an
 * eligible category, or a legacy record still awaiting confirmation when the
 * setting keeps those in.
 */
export function accountEligibleSql(alias = 'a', includeLegacy = true) {
  const legacy = includeLegacy ? ` OR (${alias}.lead_category IS NULL AND ${alias}.routing_status = 'LEGACY_UNCONFIRMED')` : '';
  const worked = workedCategories().map((c) => `'${c}'`).join(', ');
  return `(${alias}.lead_category IN (${worked})${legacy} OR (${alias}.lead_category IS NULL AND ${alias}.routing_status IS NULL))`;
}

/** A pipeline id from its key or id; the default pipeline when none is given. */
export async function pipelineId(keyOrId = null) {
  if (keyOrId && /^\d+$/.test(String(keyOrId))) return Number(keyOrId);
  const { rows } = await query(
    keyOrId ? 'SELECT id FROM crm_pipelines WHERE key = $1' : 'SELECT id FROM crm_pipelines ORDER BY is_default DESC, position LIMIT 1',
    keyOrId ? [String(keyOrId)] : [],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------- normalization

const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'rediffmail.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'ymail.com',
]);

export const normalizeEmail = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
};

/** Digits only, with the country code; a 10-digit Indian mobile gets 91. */
export function normalizePhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return null;
  if (digits.length === 10) digits = `91${digits}`;
  else if (/^0\d{10}$/.test(digits)) digits = `91${digits.slice(1)}`;
  else if (/^00\d+/.test(digits)) digits = digits.slice(2);
  return digits;
}

/** The registrable part of a website address or an email, or null. */
export function domainOf(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  const host = v.includes('@') && !v.includes('/') ? v.split('@').pop() : v.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

/** A company domain — never gmail.com and the like. */
export const companyDomain = (value) => {
  const d = domainOf(value);
  return d && !PUBLIC_DOMAINS.has(d) ? d : null;
};
export const isPublicDomain = (d) => PUBLIC_DOMAINS.has(String(d || '').toLowerCase());

export const cleanText = (value, max = 2000) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const v = String(value).trim();
  return v ? v.slice(0, max) : null;
};

// ---------------------------------------------------------------- reference numbers

/** The next number in a named sequence, safely under concurrency. */
export async function nextNumber(client, key) {
  const { rows } = await client.query(
    `INSERT INTO crm_counters (key, value) VALUES ($1, 1)
     ON CONFLICT (key) DO UPDATE SET value = crm_counters.value + 1
     RETURNING value`,
    [key],
  );
  return Number(rows[0].value);
}

// ---------------------------------------------------------------- money

/**
 * Exact decimal arithmetic for money. Amounts travel as strings ("1250.50")
 * and are held as BigInt hundredths, so nothing is lost to floating point.
 */
export const money = {
  parse(value, scale = 2) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw badRequest(`"${s}" is not an amount`);
    const negative = s.startsWith('-');
    const [whole, frac = ''] = s.replace('-', '').split('.');
    const f = (frac + '0'.repeat(scale)).slice(0, scale);
    // round half up on the digit after the scale
    let units = BigInt(whole) * 10n ** BigInt(scale) + BigInt(f || '0');
    if (frac.length > scale && Number(frac[scale]) >= 5) units += 1n;
    return negative ? -units : units;
  },
  format(units, scale = 2) {
    if (units === null || units === undefined) return null;
    const negative = units < 0n;
    const abs = negative ? -units : units;
    const base = 10n ** BigInt(scale);
    const whole = abs / base;
    const frac = (abs % base).toString().padStart(scale, '0');
    return `${negative ? '-' : ''}${whole}.${frac}`;
  },
  /** a × b, where b has `bScale` decimals; result keeps `a`'s scale, rounded half up */
  mul(a, b, bScale) {
    const base = 10n ** BigInt(bScale);
    const product = a * b;
    const half = base / 2n;
    return product >= 0n ? (product + half) / base : -((-product + half) / base);
  },
  /** a × pct / 100, with pct at two decimals */
  pct(a, pctUnits) {
    return money.mul(a, pctUnits, 4);
  },
};

// ---------------------------------------------------------------- visibility

/**
 * What a person may see in the sales CRM.
 *   { all: true }                               administrators and anyone granted crm.view.all
 *   { all: false, userId, departmentIds, own }  everyone else
 * Managers (crm.view.team) see their department and any department they are
 * granted; sales agents see what the visibility setting allows.
 */
export async function crmScope(user) {
  if (!user) return { all: false, userId: 0, departmentIds: [], own: true };
  if (user.role === 'admin' || hasPermission(user, 'crm.view.all')) return { all: true, userId: user.id };
  const settings = await salesSettings();
  // until an administrator switches record-level access on, everyone with CRM
  // access sees every record, as before the sales CRM
  if (settings.visibility?.enforced !== true) return { all: true, userId: user.id };
  const departmentIds = new Set(user.department_id ? [user.department_id] : []);
  if (hasPermission(user, 'crm.view.team')) {
    const { rows } = await query('SELECT department_id FROM attendance_team_access WHERE manager_id = $1', [user.id]);
    for (const r of rows) departmentIds.add(r.department_id);
    return { all: false, userId: user.id, departmentIds: [...departmentIds], own: false, routing: hasPermission(user, 'crm.routing') };
  }
  const agents = settings.visibility?.agents || 'OWN';
  const routing = hasPermission(user, 'crm.routing');
  if (agents === 'ALL') return { all: true, userId: user.id };
  if (agents === 'TEAM') return { all: false, userId: user.id, departmentIds: [...departmentIds], own: false, routing };
  return { all: false, userId: user.id, departmentIds: [], own: true, routing };
}

/**
 * SQL conditions limiting a query to what `scope` may see. `push` adds a
 * parameter and returns its placeholder. Each kind names its table alias.
 */
export function scopeCondition(scope, kind, alias, push) {
  if (!scope || scope.all) return 'TRUE';
  const me = push(scope.userId);
  const depts = scope.departmentIds?.length ? push(scope.departmentIds) : null;
  const team = (col) => (depts ? ` OR ${col} = ANY(${depts}::int[]) OR EXISTS (SELECT 1 FROM users su WHERE su.id = ${alias}.owner_user_id AND su.department_id = ANY(${depts}::int[]))` : '');
  if (kind === 'lead') {
    // the people who route leads see the whole TeleCRM and classification queues, which have no owner
    return `(${alias}.owner_user_id = ${me} OR ${alias}.created_by = ${me}
      ${scope.routing ? `OR ${alias}.destination <> 'TASKFLOW'` : ''}
      OR EXISTS (SELECT 1 FROM crm_watchers w WHERE w.entity_type = 'LEAD' AND w.entity_id = ${alias}.id AND w.user_id = ${me})
      ${team(`${alias}.department_id`)})`;
  }
  if (kind === 'account') {
    return `(${alias}.owner_user_id = ${me} OR ${alias}.follower_user_id = ${me}
      OR EXISTS (SELECT 1 FROM crm_watchers w WHERE w.entity_type = 'ACCOUNT' AND w.entity_id = ${alias}.id AND w.user_id = ${me})
      OR EXISTS (SELECT 1 FROM opportunities so WHERE so.account_id = ${alias}.id AND so.is_archived = FALSE
                   AND (so.owner_user_id = ${me} OR so.next_step_owner_id = ${me} OR so.escalation_owner_id = ${me}
                        OR EXISTS (SELECT 1 FROM opportunity_collaborators sc WHERE sc.opportunity_id = so.id AND sc.user_id = ${me})))
      ${team(`${alias}.department_id`)})`;
  }
  if (kind === 'opportunity') {
    return `(${alias}.owner_user_id = ${me} OR ${alias}.next_step_owner_id = ${me} OR ${alias}.escalation_owner_id = ${me}
      OR EXISTS (SELECT 1 FROM opportunity_collaborators sc WHERE sc.opportunity_id = ${alias}.id AND sc.user_id = ${me})
      OR EXISTS (SELECT 1 FROM crm_watchers w WHERE w.entity_type = 'OPPORTUNITY' AND w.entity_id = ${alias}.id AND w.user_id = ${me})
      OR EXISTS (SELECT 1 FROM accounts sa WHERE sa.id = ${alias}.account_id
                   AND (sa.owner_user_id = ${me} OR sa.follower_user_id = ${me}
                        ${depts ? `OR sa.department_id = ANY(${depts}::int[])` : ''}))
      ${team('NULL::int')})`;
  }
  throw new Error(`unknown scope kind ${kind}`);
}

/** Whether `scope` covers one record; a record outside it is reported as not found. */
export async function canSee(scope, kind, id) {
  if (scope?.all) return true;
  const table = { lead: 'crm_leads', account: 'accounts', opportunity: 'opportunities' }[kind];
  const params = [id];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const { rows } = await query(`SELECT 1 FROM ${table} x WHERE x.id = $1 AND ${scopeCondition(scope, kind, 'x', push)}`, params);
  return rows.length > 0;
}

/**
 * Guards the existing organization and deal routes. A record outside the
 * person's book answers 403, as these routes always have for a change the
 * person may not make; a record that does not exist answers 404.
 */
export async function assertVisible(user, kind, id, label) {
  const scope = await crmScope(user);
  if (await canSee(scope, kind, id)) return scope;
  const table = { lead: 'crm_leads', account: 'accounts', opportunity: 'opportunities' }[kind];
  const { rows } = await query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`${label} not found`);
  throw forbidden(`This ${label.toLowerCase()} is outside your book. Ask its owner or a manager to add you to it`);
}

// ---------------------------------------------------------------- events

/**
 * Something happened that automation may act on. Written in the same
 * transaction as the change, so an event exists exactly when the change does.
 */
export async function emitEvent(client, {
  type, entityType, entityId, payload = {}, origin = 'USER', ruleId = null, depth = 0, actorId = null,
}) {
  await (client || { query }).query(
    `INSERT INTO crm_events (type, entity_type, entity_id, payload, origin, origin_rule_id, depth, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [type, entityType, entityId, payload, origin, ruleId, depth, actorId],
  );
}

// ---------------------------------------------------------------- time

/** Today's date (YYYY-MM-DD) in a timezone. */
export function localDate(date = new Date(), timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Hours and minutes of an instant in a timezone, and its ISO weekday (1 = Monday). */
export function localParts(date = new Date(), timeZone = 'Asia/Kolkata') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday, date: localDate(date, timeZone) };
}

/** The offset (minutes) of a timezone at an instant. */
function offsetMinutes(date, timeZone) {
  const local = new Date(date.toLocaleString('en-US', { timeZone }));
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local - utc) / 60000);
}

/** The instant a local wall-clock time occurs on a local date. */
export function zonedInstant(dateStr, timeStr, timeZone = 'Asia/Kolkata') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  return new Date(guess.getTime() - offsetMinutes(guess, timeZone) * 60000);
}

/**
 * Working-time helpers from the calendar setting and the holiday list:
 * whether an instant is inside working hours, and the next instant that is.
 */
export async function workCalendar() {
  const s = await salesSettings();
  const cal = s.calendar || {};
  let holidays = new Set();
  if (cal.useAttendanceHolidays !== false) {
    try {
      const { rows } = await query(`SELECT holiday_date::text AS d FROM work_holidays WHERE department_id IS NULL AND holiday_date >= CURRENT_DATE - 7`);
      holidays = new Set(rows.map((r) => r.d));
    } catch { /* no holiday list: working days only */ }
  }
  const tz = cal.timezone || 'Asia/Kolkata';
  const days = new Set(cal.workingDays || [1, 2, 3, 4, 5, 6]);
  const start = cal.workStart || '09:30';
  const end = cal.workEnd || '18:30';
  const isWorkingDay = (dateStr) => {
    const wd = localParts(zonedInstant(dateStr, '12:00', tz), tz).weekday;
    return days.has(wd) && !holidays.has(dateStr);
  };
  const within = (date) => {
    const p = localParts(date, tz);
    const minutes = p.hour * 60 + p.minute;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    return isWorkingDay(p.date) && minutes >= sh * 60 + sm && minutes < eh * 60 + em;
  };
  const nextWorking = (date) => {
    if (within(date)) return date;
    let day = localParts(date, tz).date;
    for (let i = 0; i < 30; i += 1) {
      const open = zonedInstant(day, start, tz);
      if (isWorkingDay(day) && open > date) return open;
      const close = zonedInstant(day, end, tz);
      if (isWorkingDay(day) && date >= open && date < close) return date;
      const next = new Date(zonedInstant(day, '12:00', tz).getTime() + 24 * 3600 * 1000);
      day = localParts(next, tz).date;
    }
    return date;
  };
  /** add working hours to an instant */
  const addWorkingHours = (date, hours) => {
    let remaining = Math.round(hours * 60);
    let cursor = nextWorking(date);
    for (let guard = 0; remaining > 0 && guard < 400; guard += 1) {
      const day = localParts(cursor, tz).date;
      const close = zonedInstant(day, end, tz);
      const available = Math.max(0, Math.round((close - cursor) / 60000));
      if (available >= remaining) return new Date(cursor.getTime() + remaining * 60000);
      remaining -= available;
      cursor = nextWorking(new Date(close.getTime() + 60000));
    }
    return cursor;
  };
  return { timeZone: tz, within, nextWorking, addWorkingHours, isWorkingDay, holidays };
}

// ---------------------------------------------------------------- Indian states, dates and sources as people type them

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan',
  'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];
const STATE_ALIASES = {
  up: 'Uttar Pradesh', mp: 'Madhya Pradesh', ap: 'Andhra Pradesh', hp: 'Himachal Pradesh', jk: 'Jammu and Kashmir', 'j&k': 'Jammu and Kashmir',
  'j & k': 'Jammu and Kashmir', wb: 'West Bengal', tn: 'Tamil Nadu', uk: 'Uttarakhand', cg: 'Chhattisgarh', orissa: 'Odisha', uttaranchal: 'Uttarakhand',
  'new delhi': 'Delhi', 'nct of delhi': 'Delhi', pondicherry: 'Puducherry', 'jammu & kashmir': 'Jammu and Kashmir',
};
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * An Indian state's standard name from how it was typed ("Maharastra",
 * "Gujrat", "karnataka", "UP"); null when it is not recognisably one.
 */
export function normalizeState(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const alias = STATE_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  const s = squash(raw);
  const exact = STATES.find((x) => squash(x) === s);
  if (exact) return exact;
  // a misspelling: one or two letters off a name long enough not to be confused with another
  if (s.length >= 5) {
    const scored = STATES.map((x) => [x, editDistance(s, squash(x))]).sort((a, b) => a[1] - b[1]);
    if (scored[0][1] <= 2 && scored[1][1] > scored[0][1]) return scored[0][0];
  }
  return null;
}

/**
 * A date and time from an import cell: ISO (2026-10-30, 2026-10-30T11:50), or
 * Indian day-first (30/10/2026, 30-10-2026 11:50:36) read in the given time
 * zone. Returns an ISO string, or null when it is not a date.
 */
export function parseImportDate(value, timeZone = 'Asia/Kolkata') {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let y; let m; let d; let hh = 12; let mm = 0; let ss = 0;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (match) [, y, m, d, hh = 12, mm = 0, ss = 0] = match;
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(raw))) {
    [, d, m, y] = match;
    if (match[4] !== undefined) { hh = Number(match[4]); mm = match[5]; ss = match[6] || 0; }
    if (match[7]) hh = (hh % 12) + (/pm/i.test(match[7]) ? 12 : 0);
  } else return null;
  [y, m, d, hh, mm, ss] = [y, m, d, hh, mm, ss].map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  // 31/02 is not a day
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d) return null;
  // the wall-clock time in that zone, turned into an instant
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(guess)).reduce((o, p) => ({ ...o, [p.type]: Number(p.value) }), {});
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - guess;
  const instant = new Date(guess - offset);
  return instant.toISOString();
}

/** The source key a "how did you hear about us" answer means, in English or Hindi, however spelt. */
export function sourceKeyFromText(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  const rules = [
    [/(insta|instgram|instargram|इंस्टाग्राम)/, 'instagram'], [/(face ?book|fcaebook|फेसबुक|^fb$)/, 'facebook'],
    [/(whats ?app|व्हाट्सऐप|व्हाट्सएप)/, 'whatsapp'], [/(reference|referral|refer|रेफरेंस|किसी के माध्यम)/, 'referral'],
    [/(google|गूगल)/, 'google'], [/(linked ?in)/, 'linkedin'], [/(youtube|यूट्यूब)/, 'youtube'],
    [/(mela|event|exhibition|expo|मेला)/, 'event'], [/^(form|web ?form|website|site)$/, 'website'],
  ];
  return rules.find(([re]) => re.test(v))?.[1] ?? null;
}
