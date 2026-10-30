/**
 * The sales CRM's shared rules: lead categories and the Taskflow / TeleCRM
 * boundary, who may see which records, contact normalization, exact money
 * arithmetic, reference numbers and the event stream automation reads.
 */
import { query } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { getSettings, DEFAULT_SETTINGS } from '../settings.js';

// ---------------------------------------------------------------- categories

/** Leads Taskflow's CRM works. */
export const ELIGIBLE_CATEGORIES = ['B2B_CORPORATE', 'CSR_NGO'];
/** Leads that belong in TeleCRM. */
export const EXCLUDED_CATEGORIES = ['RETAILER', 'FPO', 'INDIVIDUAL'];
export const LEAD_CATEGORIES = [...ELIGIBLE_CATEGORIES, ...EXCLUDED_CATEGORIES, 'UNCLASSIFIED'];

export const CATEGORY_LABEL = {
  B2B_CORPORATE: 'B2B corporate',
  CSR_NGO: 'CSR / NGO',
  RETAILER: 'Retailer',
  FPO: 'FPO (farmer producer organization)',
  INDIVIDUAL: 'Individual / consumer',
  UNCLASSIFIED: 'Needs classification',
};

export const isEligible = (category) => ELIGIBLE_CATEGORIES.includes(category);
export const isExcluded = (category) => EXCLUDED_CATEGORIES.includes(category);

/** The pipeline key a category's deals live in. */
export const PIPELINE_FOR_CATEGORY = { B2B_CORPORATE: 'b2b', CSR_NGO: 'csr' };

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFYING', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED', 'NURTURE'];
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
  return all.crm?.sales || DEFAULT_SETTINGS.crm.sales;
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
  return `(${alias}.lead_category IN ('B2B_CORPORATE', 'CSR_NGO')${legacy} OR (${alias}.lead_category IS NULL AND ${alias}.routing_status IS NULL))`;
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
