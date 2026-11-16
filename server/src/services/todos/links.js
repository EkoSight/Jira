/**
 * What a to-do is linked to, and everything that follows from that link.
 *
 * A to-do stores at most one link (todos.link_type + link_id). The rest of
 * the chain — the task's project, the departments, the key results and their
 * objectives — is worked out here when read (section 2.3), so moving a task to
 * another project moves every to-do on it with no change to the to-do row.
 *
 * Every record goes through canSeeRecord first: a to-do on a record its owner
 * can no longer see shows "Not available", with no title.
 */
import { query } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { TASK_REF } from '../../lib/standup.js';
import { getSettings } from '../settings.js';
import { canSeeRecord } from '../workspace/access.js';
import { projectVisibilitySql } from '../projects/index.js';
import { taskVisibilitySql } from '../taskAccess.js';

export const LINK_TYPES = ['TASK', 'PROJECT', 'KEY_RESULT', 'OBJECTIVE', 'DEAL', 'APPLICATION', 'MEETING'];
export const LINK_WORD = {
  TASK: 'task', PROJECT: 'project', KEY_RESULT: 'key result', OBJECTIVE: 'objective',
  DEAL: 'deal', APPLICATION: 'application', MEETING: 'meeting',
};
const OPEN_STAGES = ['backlog', 'todo', 'in_progress', 'review', 'blocked'];

const keyOf = (type, id) => `${type}:${Number(id)}`;

/** Projects among `ids` this person may see. */
async function visibleProjectIds(user, ids) {
  const list = [...new Set(ids.filter(Boolean).map(Number))];
  if (!list.length) return new Set();
  const params = [list];
  const visible = projectVisibilitySql(user, params);
  const { rows } = await query(`SELECT p.id FROM projects p WHERE p.id = ANY($1::int[]) AND ${visible}`, params);
  return new Set(rows.map((r) => r.id));
}

/**
 * Describe links: Map of "TYPE:id" -> { type, id, visible, label, url, word,
 * project: {id, name} | null, ref? }. One query per record type.
 */
export async function describeLinks(user, pairs, settings = null) {
  const s = settings || await getSettings();
  const out = new Map();
  const distinct = new Map();
  for (const p of pairs) if (p?.type && p?.id) distinct.set(keyOf(p.type, p.id), { type: p.type, id: Number(p.id) });
  const byType = {};
  for (const [key, p] of distinct) {
    const seen = await canSeeRecord(user, p.type, p.id, s);
    if (!seen) { out.set(key, { type: p.type, id: p.id, visible: false, label: 'Not available', url: null, word: LINK_WORD[p.type], project: null }); continue; }
    (byType[p.type] ||= []).push(p.id);
  }
  const put = (type, id, value) => out.set(keyOf(type, id), { type, id, visible: true, word: LINK_WORD[type], project: null, ...value });

  if (byType.TASK) {
    const { rows } = await query(
      `SELECT t.id, t.ref, t.title, t.project_id, pj.name AS project_name, ws.stage,
              COALESCE(pj.color, pd.color) AS project_color, td.color AS task_dept_color
         FROM tasks t LEFT JOIN projects pj ON pj.id = t.project_id
         LEFT JOIN departments pd ON pd.id = pj.department_id
         LEFT JOIN departments td ON td.id = t.department_id
         LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
        WHERE t.id = ANY($1::int[])`, [byType.TASK]);
    const seenProjects = s.projects?.enabled === false ? new Set() : await visibleProjectIds(user, rows.map((r) => r.project_id));
    for (const r of rows) {
      const project = r.project_id && seenProjects.has(r.project_id) ? { id: r.project_id, name: r.project_name, color: r.project_color } : null;
      put('TASK', r.id, {
        label: `${r.ref} ${r.title}`, ref: r.ref, title: r.title, stage: r.stage, url: `/?task=${r.id}`, project,
        // the notebook's stamp: the task reference, in its project's colour (else its department's)
        stamp: { text: r.ref, color: project?.color || r.task_dept_color || null },
      });
    }
  }
  if (byType.PROJECT) {
    const { rows } = await query(
      'SELECT p.id, p.name, COALESCE(p.color, d.color) AS color FROM projects p JOIN departments d ON d.id = p.department_id WHERE p.id = ANY($1::int[])',
      [byType.PROJECT]);
    for (const r of rows) {
      put('PROJECT', r.id, { label: r.name, url: `/projects/${r.id}`, project: { id: r.id, name: r.name, color: r.color }, stamp: { text: r.name, color: r.color } });
    }
  }
  if (byType.KEY_RESULT) {
    const { rows } = await query('SELECT id, title, objective_id FROM key_results WHERE id = ANY($1::int[])', [byType.KEY_RESULT]);
    for (const r of rows) put('KEY_RESULT', r.id, { label: r.title, url: `/goals/${r.objective_id}` });
  }
  if (byType.OBJECTIVE) {
    const { rows } = await query('SELECT id, title FROM objectives WHERE id = ANY($1::int[])', [byType.OBJECTIVE]);
    for (const r of rows) put('OBJECTIVE', r.id, { label: r.title, url: `/goals/${r.id}` });
  }
  for (const type of ['DEAL', 'APPLICATION']) {
    if (!byType[type]) continue;
    const { rows } = await query(
      `SELECT o.id, o.name, o.account_id, a.name AS account FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE o.id = ANY($1::int[])`,
      [byType[type]]);
    for (const r of rows) {
      put(type, r.id, { label: `${r.name} · ${r.account}`, url: type === 'DEAL' ? `/accounts/${r.account_id}?deal=${r.id}` : `/applications/${r.id}` });
    }
  }
  if (byType.MEETING) {
    const { rows } = await query(
      `SELECT m.id, m.title, m.project_id, pj.name AS project_name FROM crm_meetings m LEFT JOIN projects pj ON pj.id = m.project_id WHERE m.id = ANY($1::int[])`,
      [byType.MEETING]);
    const seenProjects = s.projects?.enabled === false ? new Set() : await visibleProjectIds(user, rows.map((r) => r.project_id));
    for (const r of rows) {
      put('MEETING', r.id, {
        label: r.title, url: `/meetings?meeting=${r.id}`,
        project: r.project_id && seenProjects.has(r.project_id) ? { id: r.project_id, name: r.project_name } : null,
      });
    }
  }
  return out;
}

/** One link, described, or null. */
export async function describeLink(user, type, id, settings = null) {
  if (!type || !id) return null;
  return (await describeLinks(user, [{ type, id }], settings)).get(keyOf(type, id)) || null;
}

/** The record must exist and be visible to this person; otherwise "not available" (404). */
export async function assertLinkable(user, type, id, settings = null) {
  if (!LINK_TYPES.includes(type)) return false;
  return canSeeRecord(user, type, Number(id), settings || await getSettings());
}

// ---------------------------------------------------------------- typed task references

/**
 * The only thing read from a to-do's text: a task reference ("WS-12 send the
 * budget annex"). It links only if the person can see that task; otherwise
 * the to-do is saved unlinked, with "No task WS-12 you can see". No dates are
 * guessed from the words.
 */
export async function referenceIn(user, text) {
  const m = String(text || '').match(TASK_REF);
  if (!m) return null;
  const ref = m[1];
  const params = [ref];
  const visible = taskVisibilitySql(user, params, 't');
  const { rows } = await query(`SELECT t.id, t.ref, t.title FROM tasks t WHERE t.ref = $1 AND t.is_archived = FALSE AND ${visible}`, params);
  if (!rows[0]) return { ref, task: null, note: `No task ${ref} you can see` };
  return { ref, task: rows[0], note: null };
}

// ---------------------------------------------------------------- the chain (for "What I did")

/**
 * Everything a link leads to, for its owner only: the project, the task and its
 * parents, the key results and their objectives, the departments, and the
 * record itself. Only what this person can see is named.
 */
export async function chainFor(user, link, settings = null, cache = new Map()) {
  if (!link?.visible) return null;
  const key = keyOf(link.type, link.id);
  if (cache.has(key)) return cache.get(key);
  const s = settings || await getSettings();
  const okrOn = s.okr?.enabled !== false && hasPermission(user, 'okr.view');
  const chain = { record: { type: link.type, id: link.id, label: link.label, url: link.url }, project: link.project || null, tasks: [], key_results: [], objectives: [], departments: [] };
  const deptIds = new Set();
  const krIds = new Set();
  const objIds = new Set();

  if (link.type === 'TASK') {
    // the task and its parents, nearest first; only the ones this person can see
    const { rows } = await query(
      `WITH RECURSIVE up AS (
         SELECT t.id, t.parent_task_id, 0 AS depth FROM tasks t WHERE t.id = $1
         UNION ALL
         SELECT p.id, p.parent_task_id, up.depth + 1 FROM tasks p JOIN up ON p.id = up.parent_task_id WHERE up.depth < 10
       ) SELECT id FROM up ORDER BY depth`, [link.id]);
    const ids = rows.map((r) => r.id);
    const params = [ids];
    const visible = taskVisibilitySql(user, params, 't');
    const { rows: tasks } = await query(`SELECT t.id, t.ref, t.title, t.department_id FROM tasks t WHERE t.id = ANY($1::int[]) AND ${visible}`, params);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) continue;
      chain.tasks.push({ id: t.id, ref: t.ref, title: t.title, url: `/?task=${t.id}` });
      if (t.department_id) deptIds.add(t.department_id);
    }
    if (okrOn && tasks.length) {
      const { rows: krs } = await query('SELECT DISTINCT key_result_id FROM task_key_result_links WHERE task_id = ANY($1::int[])', [tasks.map((t) => t.id)]);
      for (const r of krs) krIds.add(r.key_result_id);
    }
  }
  if (link.type === 'OBJECTIVE') objIds.add(link.id);
  if (link.type === 'KEY_RESULT') krIds.add(link.id);
  if (link.type === 'DEAL' || link.type === 'APPLICATION') {
    // deals have no department: the owner's is used
    const { rows } = await query('SELECT u.department_id FROM opportunities o JOIN users u ON u.id = o.owner_user_id WHERE o.id = $1', [link.id]);
    if (rows[0]?.department_id) deptIds.add(rows[0].department_id);
  }
  if (chain.project) {
    const { rows } = await query('SELECT department_id FROM projects WHERE id = $1', [chain.project.id]);
    if (rows[0]) deptIds.add(rows[0].department_id);
    if (okrOn) {
      const { rows: krs } = await query('SELECT key_result_id FROM project_key_result_links WHERE project_id = $1', [chain.project.id]);
      for (const r of krs) krIds.add(r.key_result_id);
    }
  }
  if (okrOn && krIds.size) {
    const { rows } = await query('SELECT id, title, objective_id FROM key_results WHERE id = ANY($1::int[]) AND is_archived = FALSE ORDER BY id', [[...krIds]]);
    for (const r of rows) { chain.key_results.push({ id: r.id, title: r.title, url: `/goals/${r.objective_id}` }); objIds.add(r.objective_id); }
  }
  if (okrOn && objIds.size) {
    const { rows } = await query('SELECT id, title, department_id FROM objectives WHERE id = ANY($1::int[]) ORDER BY id', [[...objIds]]);
    for (const r of rows) { chain.objectives.push({ id: r.id, title: r.title, url: `/goals/${r.id}` }); if (r.department_id) deptIds.add(r.department_id); }
  }
  if (deptIds.size) {
    const { rows } = await query('SELECT id, name FROM departments WHERE id = ANY($1::int[]) ORDER BY name', [[...deptIds]]);
    chain.departments = rows.map((r) => ({ id: r.id, name: r.name }));
  }
  cache.set(key, chain);
  return chain;
}

// ---------------------------------------------------------------- suggestions (never applied silently)

const STOP = new Set(('the and for with from into onto this that these those then than have has had will shall would could should '
  + 'about after before again also just only some more most very your their there here what when where which while '
  + 'send sent make made call check prepare update review follow plan draft write meet meeting today tomorrow week').split(' '));

/** The words that matter in a line: lower case, four letters or more, not a common word. */
export function significantWords(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !STOP.has(w)))];
}

/**
 * The person's own open records to match against: tasks assigned to them,
 * projects they lead or are in, key results they own, deals and applications
 * they own, and today's meetings they are in.
 */
export async function suggestionCandidates(user, { day, tz, settings = null } = {}) {
  const s = settings || await getSettings();
  const out = [];
  const { rows: tasks } = await query(
    `SELECT t.id, t.ref, t.title FROM tasks t JOIN workflow_statuses ws ON ws.id = t.status_id
      WHERE t.assignee_id = $1 AND t.is_archived = FALSE AND ws.stage = ANY($2::text[]) ORDER BY t.id DESC LIMIT 200`,
    [user.id, OPEN_STAGES]);
  for (const t of tasks) out.push({ type: 'TASK', id: t.id, label: `${t.ref} ${t.title}`, text: t.title });
  if (s.projects?.enabled !== false) {
    const { rows } = await query(
      `SELECT p.id, p.name FROM projects p
        WHERE p.status IN ('PLANNED', 'ACTIVE', 'ON_HOLD') AND p.archived_at IS NULL
          AND (p.lead_user_id = $1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1))`, [user.id]);
    for (const p of rows) out.push({ type: 'PROJECT', id: p.id, label: p.name, text: p.name });
  }
  if (s.okr?.enabled !== false && hasPermission(user, 'okr.view')) {
    const { rows } = await query('SELECT id, title FROM key_results WHERE owner_user_id = $1 AND is_archived = FALSE', [user.id]);
    for (const k of rows) out.push({ type: 'KEY_RESULT', id: k.id, label: k.title, text: k.title });
  }
  if (s.crm?.enabled !== false && hasPermission(user, 'crm.view')) {
    const { rows } = await query(
      `SELECT o.id, o.name, p.category FROM opportunities o
         JOIN crm_pipelines p ON p.id = o.pipeline_id
         LEFT JOIN account_stages st ON st.id = o.stage_id
        WHERE o.owner_user_id = $1 AND o.is_archived = FALSE AND COALESCE(st.kind, 'open') NOT IN ('won', 'lost')`, [user.id]);
    for (const o of rows) out.push({ type: o.category === 'APPLICATIONS' ? 'APPLICATION' : 'DEAL', id: o.id, label: o.name, text: o.name });
  }
  if (day && tz) {
    for (const m of await meetingsOn(user, day, tz)) out.push({ type: 'MEETING', id: m.id, label: m.title, text: m.title });
  }
  return out.map((c) => ({ ...c, words: significantWords(c.text) }));
}

/**
 * One suggested link for an unlinked line: the record sharing the most
 * significant words. Two shared words, or one word of six letters or more, are
 * needed; a tie between two records suggests nothing.
 */
export function suggestFor(title, candidates) {
  const words = significantWords(title);
  if (!words.length) return null;
  let best = null;
  let tie = false;
  for (const c of candidates) {
    const shared = c.words.filter((w) => words.includes(w));
    if (!shared.length) continue;
    if (shared.length < 2 && shared[0].length < 6) continue;
    if (!best || shared.length > best.score) { best = { ...c, score: shared.length, shared }; tie = false; }
    else if (shared.length === best.score) tie = true;
  }
  if (!best || tie) return null;
  return { type: best.type, id: best.id, label: best.label, word: LINK_WORD[best.type], because: best.shared };
}

/** Today's meetings this person takes part in (owner, organiser, creator or invited). */
export async function meetingsOn(user, day, tz) {
  const { rows } = await query(
    `SELECT m.id, m.title, m.scheduled_at, m.timezone, m.status, m.project_id,
            to_char(m.scheduled_at AT TIME ZONE $3::text, 'HH24:MI') AS local_time
       FROM crm_meetings m
      WHERE (m.scheduled_at AT TIME ZONE $3::text)::date = $2::date
        AND m.status IN ('SCHEDULED', 'COMPLETED')
        AND (m.owner_user_id = $1 OR m.scheduling_owner_id = $1 OR m.created_by = $1
             OR EXISTS (SELECT 1 FROM crm_meeting_participants mp WHERE mp.meeting_id = m.id AND mp.user_id = $1))
      ORDER BY m.scheduled_at, m.id`, [user.id, day, tz]);
  return rows;
}

// ---------------------------------------------------------------- the link picker

/** Records this person can see whose name matches `q`, a few of each kind. */
export async function searchLinks(user, q, { type = null, limit = 6 } = {}) {
  const s = await getSettings();
  const text = String(q || '').trim();
  if (text.length < 2) return [];
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const want = (t) => !type || type === t;
  const results = [];
  const keepVisible = async (t, rows, label) => {
    let n = 0;
    for (const r of rows) {
      if (n >= limit) break;
      if (await canSeeRecord(user, t, r.id, s)) { results.push({ type: t, id: r.id, label: label(r), word: LINK_WORD[t] }); n += 1; }
    }
  };
  if (want('TASK')) {
    const params = [like];
    const visible = taskVisibilitySql(user, params, 't');
    params.push(limit);
    const { rows } = await query(
      `SELECT t.id, t.ref, t.title FROM tasks t WHERE t.is_archived = FALSE AND (t.title ILIKE $1 OR t.ref ILIKE $1) AND ${visible}
        ORDER BY t.updated_at DESC NULLS LAST, t.id DESC LIMIT $${params.length}`, params);
    for (const r of rows) results.push({ type: 'TASK', id: r.id, label: `${r.ref} ${r.title}`, word: 'task' });
  }
  if (want('PROJECT') && s.projects?.enabled !== false) {
    const params = [like];
    const visible = projectVisibilitySql(user, params);
    params.push(limit);
    const { rows } = await query(`SELECT p.id, p.name FROM projects p WHERE p.archived_at IS NULL AND p.name ILIKE $1 AND ${visible} ORDER BY p.name LIMIT $${params.length}`, params);
    for (const r of rows) results.push({ type: 'PROJECT', id: r.id, label: r.name, word: 'project' });
  }
  if (want('KEY_RESULT')) {
    const { rows } = await query('SELECT id, title FROM key_results WHERE is_archived = FALSE AND title ILIKE $1 ORDER BY id DESC LIMIT 20', [like]);
    await keepVisible('KEY_RESULT', rows, (r) => r.title);
  }
  if (want('OBJECTIVE')) {
    const { rows } = await query('SELECT id, title FROM objectives WHERE is_archived = FALSE AND title ILIKE $1 ORDER BY id DESC LIMIT 20', [like]);
    await keepVisible('OBJECTIVE', rows, (r) => r.title);
  }
  for (const t of ['DEAL', 'APPLICATION']) {
    if (!want(t)) continue;
    const { rows } = await query(
      `SELECT o.id, o.name, a.name AS account FROM opportunities o
         JOIN crm_pipelines p ON p.id = o.pipeline_id JOIN accounts a ON a.id = o.account_id
        WHERE o.is_archived = FALSE AND (o.name ILIKE $1 OR a.name ILIKE $1)
          AND ${t === 'APPLICATION' ? "p.category = 'APPLICATIONS'" : "p.category IS DISTINCT FROM 'APPLICATIONS'"}
        ORDER BY o.id DESC LIMIT 20`, [like]);
    await keepVisible(t, rows, (r) => `${r.name} · ${r.account}`);
  }
  if (want('MEETING')) {
    const { rows } = await query("SELECT id, title FROM crm_meetings WHERE status <> 'CANCELLED' AND title ILIKE $1 ORDER BY scheduled_at DESC NULLS LAST, id DESC LIMIT 20", [like]);
    await keepVisible('MEETING', rows, (r) => r.title);
  }
  return results;
}
