/**
 * My workspace: one person's layout, the templates it starts from, and who
 * has it as their home.
 *
 *   - A layout belongs to one person (user_dashboards). Nobody else can read
 *     or change it through any route: every call is keyed by the caller.
 *   - Until a person saves a change, they follow their template (department
 *     first, then role, then "everyone"), so template edits still reach them.
 *     Saving copies nothing but presentation.
 *   - Saving sends the version it started from. A newer saved version is
 *     refused (409) unless the person chose "Keep mine" (force).
 *   - Resetting clears the person's layout and nothing else.
 */
import { query, withTransaction } from '../../db/pool.js';
import { conflict, badRequest } from '../../lib/errors.js';
import { hasPermission, tracksAttendance } from '../../lib/permissions.js';
import { getSettings } from '../settings.js';
import { crmScope } from '../sales/core.js';
import {
  WIDGET_TYPES, WIDGET_KEYS, normaliseLayout, scopesFor, widgetAccess,
} from '../../../../shared/workspaceWidgets.js';

export const ROLLOUT_MODES = ['PILOT', 'EVERYONE', 'OFF'];
export const REMINDER_MODES = ['OFF', 'TEST', 'LIVE'];

export async function workspaceSettings(settings = null) {
  const s = settings || await getSettings();
  const w = s.workspace || {};
  const r = w.rollout || {};
  return {
    rollout: {
      mode: ROLLOUT_MODES.includes(r.mode) ? r.mode : 'PILOT',
      departmentIds: Array.isArray(r.departmentIds) ? r.departmentIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [],
    },
    reminderMode: REMINDER_MODES.includes(w.reminderMode) ? w.reminderMode : 'TEST',
    testRecipientId: w.testRecipientId ?? null,
    timezone: s.organisation?.timezone || 'Asia/Kolkata',
    modules: { crm: s.crm?.enabled !== false, okr: s.okr?.enabled !== false, marketing: s.marketing?.enabled !== false },
  };
}

/** What the widget guards need to know about a person. */
export async function whoIs(user, settings = null) {
  const ws = await workspaceSettings(settings);
  let crmTeam = false;
  if (ws.modules.crm && hasPermission(user, 'crm.view')) {
    const scope = await crmScope(user);
    crmTeam = scope.all || !scope.own;
  }
  return {
    can: (p) => hasPermission(user, p),
    modules: ws.modules,
    tracksDay: tracksAttendance(user),
    teamScope: {
      tasks: Boolean(user.department_id) && (hasPermission(user, 'task.view.department') || hasPermission(user, 'task.view.all')),
      crm: crmTeam,
    },
  };
}

/** The template that applies to a person: their department's, else their role's, else everyone's. */
export async function templateFor(user, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT * FROM dashboard_templates WHERE is_active
      ORDER BY ($1::int = ANY(applies_departments)) DESC, ($2::text = ANY(applies_roles)) DESC, (key = 'everyone') DESC, position, id`,
    [user.department_id || 0, user.role],
  );
  const best = rows[0];
  if (!best) return { key: 'everyone', name: 'Everyone', layout: { widgets: [] }, version: 0, matched: 'none' };
  const matched = best.applies_departments.includes(user.department_id) ? 'department'
    : best.applies_roles.includes(user.role) ? 'role' : 'everyone';
  if (matched === 'everyone' && best.key !== 'everyone') {
    const fallback = rows.find((t) => t.key === 'everyone');
    if (fallback) return { ...fallback, matched: 'everyone' };
  }
  return { ...best, matched };
}

/** Whether My workspace is a person's home, and why. */
export async function homeFor(user, row, settings = null) {
  const ws = await workspaceSettings(settings);
  if (row?.home === 'WORKSPACE') return { workspace: true, why: 'You chose My workspace as your home' };
  if (row?.home === 'OVERVIEW') return { workspace: false, why: 'You chose the overview as your home' };
  if (ws.rollout.mode === 'EVERYONE') return { workspace: true, why: 'My workspace is everyone\'s home' };
  if (ws.rollout.mode === 'PILOT' && user.department_id && ws.rollout.departmentIds.includes(user.department_id)) {
    return { workspace: true, why: 'Your department is trying My workspace first' };
  }
  return { workspace: false, why: ws.rollout.mode === 'OFF' ? 'My workspace is not anyone\'s home yet' : 'Your department is not in the first group yet' };
}

async function rowFor(userId, runner = { query }) {
  const { rows } = await runner.query('SELECT * FROM user_dashboards WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

/** When a widget type joined the catalogue (for "New" in the catalogue). */
const ADDED_ON = '2026-11-14';
const addedOn = (type) => WIDGET_TYPES[type]?.added || ADDED_ON;

/** The catalogue for a person: every widget type, with whether they may use it and why not. */
export function catalogueFor(who, layoutSavedAt = null) {
  return WIDGET_KEYS.map((type) => {
    const w = WIDGET_TYPES[type];
    const access = widgetAccess(type, who);
    return {
      type,
      title: w.title,
      description: w.description,
      widths: w.widths,
      settings: w.settings,
      scopes: scopesFor(type, who),
      drill: w.drill,
      available: access.ok,
      why: access.ok ? null : access.why,
      // newer than the person's last save: listed under "New", never added by itself
      is_new: Boolean(layoutSavedAt) && new Date(`${addedOn(type)}T00:00:00Z`) > new Date(layoutSavedAt),
    };
  });
}

/**
 * The person's workspace: their layout (or their template's), the catalogue
 * as it applies to them, and whether it is their home.
 */
export async function workspaceFor(user) {
  const settings = await getSettings();
  const [row, template, who] = await Promise.all([rowFor(user.id), templateFor(user), whoIs(user, settings)]);
  const custom = Boolean(row?.layout);
  const layout = normaliseLayout(custom ? row.layout : template.layout);
  const home = await homeFor(user, row, settings);
  const catalogue = catalogueFor(who, custom ? row.updated_at : null);
  const byType = new Map(catalogue.map((c) => [c.type, c]));
  return {
    version: row?.version || 0,
    source: custom ? 'CUSTOM' : 'TEMPLATE',
    template: { key: template.key, name: template.name, matched: template.matched },
    based_on: row?.based_on || null,
    updated_at: row?.updated_at || null,
    widgets: layout.widgets.map((w) => {
      const c = byType.get(w.type);
      return { ...w, available: Boolean(c?.available), why: c ? c.why : 'This widget is no longer available', retired: !c };
    }),
    home,
    home_choice: row?.home || null,
    catalogue,
    scope_label: 'Mine',
    timezone: user.timezone || (await workspaceSettings(settings)).timezone,
    timezone_is_personal: Boolean(user.timezone),
  };
}

/**
 * Saves a person's layout. `version` is the one their draft started from; a
 * newer saved version is refused unless `force` (the person confirmed "Keep
 * mine"). A widget they may not use can stay if it was already there (it
 * shows as "not available to you"), but cannot be added.
 */
export async function saveLayout(user, { version, widgets, force = false }) {
  const layout = normaliseLayout({ widgets });
  const who = await whoIs(user);
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO user_dashboards (user_id, version, layout) VALUES ($1, 0, NULL) ON CONFLICT (user_id) DO NOTHING`,
      [user.id],
    );
    const { rows } = await client.query('SELECT * FROM user_dashboards WHERE user_id = $1 FOR UPDATE', [user.id]);
    const row = rows[0];
    if (!force && Number(version) !== row.version) {
      throw conflict('Your layout was changed on another device', { code: 'LAYOUT_CONFLICT', current_version: row.version });
    }
    const template = await templateFor(user, client);
    const before = new Set(normaliseLayout(row.layout || template.layout).widgets.map((w) => w.type));
    for (const w of layout.widgets) {
      if (!WIDGET_TYPES[w.type]) {
        if (!before.has(w.type)) throw badRequest(`Unknown widget "${w.type}"`);
        continue;
      }
      const access = widgetAccess(w.type, who);
      if (!access.ok && !before.has(w.type)) throw badRequest(`${WIDGET_TYPES[w.type].title}: ${access.why}`, { code: 'WIDGET_NOT_AVAILABLE', type: w.type });
      if (w.config.scope && !scopesFor(w.type, who).includes(w.config.scope)) {
        throw badRequest(`${WIDGET_TYPES[w.type].title}: that scope is not available to you`, { code: 'SCOPE_NOT_AVAILABLE', type: w.type });
      }
    }
    const { rows: saved } = await client.query(
      `UPDATE user_dashboards SET layout = $2, version = version + 1, based_on = COALESCE(based_on, $3), updated_at = now()
        WHERE user_id = $1 RETURNING version, updated_at`,
      [user.id, JSON.stringify(layout), template.key],
    );
    return { version: saved[0].version, updated_at: saved[0].updated_at, widgets: layout.widgets };
  });
}

/** Back to the team's template. Only this person's layout changes. */
export async function resetLayout(user) {
  const { rows } = await query(
    `INSERT INTO user_dashboards (user_id, version, layout) VALUES ($1, 1, NULL)
     ON CONFLICT (user_id) DO UPDATE SET layout = NULL, based_on = NULL, version = user_dashboards.version + 1, updated_at = now()
     RETURNING version`,
    [user.id],
  );
  return { version: rows[0].version };
}

/** The person's own choice of home (null: follow the rollout). */
export async function setHome(user, home) {
  if (home !== null && !['WORKSPACE', 'OVERVIEW'].includes(home)) throw badRequest('Choose My workspace or the overview');
  await query(
    `INSERT INTO user_dashboards (user_id, home) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET home = EXCLUDED.home`,
    [user.id, home],
  );
  return homeFor(user, { home });
}

// ---------------------------------------------------------------- templates (settings.manage)

export async function listTemplates() {
  const { rows } = await query(
    `SELECT t.*, u.full_name AS updated_by_name,
            (SELECT array_agg(d.name ORDER BY d.name) FROM departments d WHERE d.id = ANY(t.applies_departments)) AS department_names
       FROM dashboard_templates t LEFT JOIN users u ON u.id = t.updated_by
      ORDER BY t.position, t.id`,
  );
  return rows.map((t) => ({ ...t, layout: normaliseLayout(t.layout) }));
}

/**
 * Saves a template: presentation only. People who customised their layout
 * keep it; people who never did see the change on their next visit.
 */
export async function saveTemplate(actor, key, input) {
  const layout = normaliseLayout(input.layout);
  if (!layout.widgets.length) throw badRequest('A template needs at least one widget');
  for (const w of layout.widgets) if (!WIDGET_TYPES[w.type]) throw badRequest(`Unknown widget "${w.type}"`);
  const departments = (input.applies_departments || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const roles = (input.applies_roles || []).filter((r) => ['super_admin', 'admin', 'manager', 'member', 'viewer'].includes(r));
  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) throw badRequest('Give the template a name');
  const { rows } = await query(
    `INSERT INTO dashboard_templates (key, name, description, layout, applies_departments, applies_roles, position, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 100), $8)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, layout = EXCLUDED.layout,
       applies_departments = EXCLUDED.applies_departments, applies_roles = EXCLUDED.applies_roles,
       position = COALESCE($7, dashboard_templates.position), is_active = TRUE,
       version = dashboard_templates.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [key, name, input.description ? String(input.description).slice(0, 300) : null, JSON.stringify(layout), departments, roles, input.position ?? null, actor.id],
  );
  return rows[0];
}

/** How many people follow each template and how many customised (for the settings screen). */
export async function templateUsage() {
  const { rows: users } = await query('SELECT id, role, department_id FROM users WHERE is_active');
  const { rows: custom } = await query('SELECT user_id FROM user_dashboards WHERE layout IS NOT NULL');
  const customised = new Set(custom.map((r) => r.user_id));
  const out = {};
  for (const u of users) {
    const t = await templateFor(u);
    out[t.key] = out[t.key] || { following: 0, customised: 0 };
    out[t.key][customised.has(u.id) ? 'customised' : 'following'] += 1;
  }
  return out;
}
