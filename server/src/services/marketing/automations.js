/**
 * Automations: a trigger, then a path of steps each person follows.
 *
 * Steps: email, delay, condition (yes/no branch), action (tag, audience, task,
 * notify, field, language) and exit. The path cannot loop back on itself.
 *
 * Triggers: someone joins an audience, gets a tag, submits a form; a festival
 * or season date (only dates a person has confirmed); a date field such as a
 * birthday; activity on a campaign; going quiet; and TaskFlow events about
 * their organization — a new lead, a lead becoming a customer, a deal moving,
 * won or lost, a task finished.
 *
 * Each person goes through a given run once: a run has a key (the festival,
 * the event, "once"), and the database refuses a second enrollment with the
 * same key. People who unsubscribe, bounce or complain leave at their next step.
 */

import crypto from 'node:crypto';
import { query } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { checkDesign } from '../../lib/emailRender.js';
import { notify } from '../activity.js';
import { isSuppressed, localParts, logContactActivity, marketingSettings, newReplyCode, newToken } from './core.js';
import { addToAudience } from './audiences.js';
import { changeTags } from './contacts.js';
import { createFollowUp } from './followups.js';

export const TRIGGERS = ['AUDIENCE_JOINED', 'TAG_ADDED', 'FORM_SUBMITTED', 'FESTIVAL', 'DATE_FIELD', 'CAMPAIGN_ACTIVITY', 'INACTIVE', 'TASKFLOW_EVENT', 'MANUAL'];
export const TASKFLOW_EVENTS = ['LEAD_CREATED', 'BECAME_CUSTOMER', 'DEAL_STAGE', 'DEAL_WON', 'DEAL_LOST', 'TASK_COMPLETED'];
export const NODE_TYPES = ['email', 'delay', 'condition', 'action', 'exit'];
export const CONDITIONS = ['opened', 'clicked', 'replied', 'converted', 'tag', 'field', 'audience', 'engagement_at_least', 'crm_type', 'has_open_deal'];
export const ACTIONS = ['add_tag', 'remove_tag', 'add_to_audience', 'remove_from_audience', 'create_task', 'notify_owner', 'update_field', 'set_language'];
const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 7 * 86_400_000 };

export function workflowFingerprint(w) {
  return crypto.createHash('sha256').update(JSON.stringify({
    trigger: w.trigger, graph: w.graph, audience_id: w.audience_id ?? null, topic_id: w.topic_id ?? null,
    from_name: w.from_name ?? null, from_email: w.from_email ?? null, reply_to: w.reply_to ?? null, allow_reentry: Boolean(w.allow_reentry),
  })).digest('hex');
}

/** Problems with a trigger and path: missing steps, loops, emails without content. */
export function validateWorkflow({ trigger, graph }) {
  const problems = [];
  if (!trigger || !TRIGGERS.includes(trigger.type)) problems.push('Choose what starts the automation');
  if (trigger?.type === 'AUDIENCE_JOINED' && !trigger.audience_id) problems.push('Choose the audience people join');
  if (trigger?.type === 'TAG_ADDED' && !String(trigger.tag || '').trim()) problems.push('Choose the tag');
  if (trigger?.type === 'FORM_SUBMITTED' && !trigger.form_id) problems.push('Choose the form');
  if (trigger?.type === 'DATE_FIELD' && !trigger.field) problems.push('Choose the date field');
  if (trigger?.type === 'CAMPAIGN_ACTIVITY' && (!trigger.campaign_id || !['CLICKED', 'OPENED', 'NOT_OPENED'].includes(trigger.activity))) problems.push('Choose the campaign and the activity');
  if (trigger?.type === 'TASKFLOW_EVENT' && !TASKFLOW_EVENTS.includes(trigger.event)) problems.push('Choose the TaskFlow event');
  if (trigger?.type === 'INACTIVE' && !(Number(trigger.days) >= 14)) problems.push('Going quiet needs a number of days (at least 14)');

  const nodes = graph?.nodes || {};
  const ids = Object.keys(nodes);
  if (!ids.length || !graph.start || !nodes[graph.start]) problems.push('Add at least one step');
  for (const [id, node] of Object.entries(nodes)) {
    if (!NODE_TYPES.includes(node.type)) problems.push(`Step ${id} is of an unknown kind`);
    const targets = node.type === 'condition' ? [node.yes, node.no] : [node.next];
    for (const t of targets) if (t && !nodes[t]) problems.push(`Step ${id} leads to a step that does not exist`);
    if (node.type === 'email') {
      const c = checkDesign(node.config?.design, { subject: node.config?.subject || '' });
      problems.push(...c.problems.map((p) => `Email step: ${p}`));
    }
    if (node.type === 'delay' && !(Number(node.config?.amount) > 0 && UNIT_MS[node.config?.unit])) problems.push('A wait step needs an amount and a unit');
    if (node.type === 'condition' && !CONDITIONS.includes(node.config?.kind)) problems.push('A condition step needs a condition');
    if (node.type === 'action' && !ACTIONS.includes(node.config?.kind)) problems.push('An action step needs an action');
  }
  // no loops: every path ends
  const state = {};
  const visit = (id, depth = 0) => {
    if (!id || !nodes[id]) return;
    if (state[id] === 1) { problems.push('The path loops back on itself'); return; }
    if (state[id] === 2 || depth > 200) return;
    state[id] = 1;
    const n = nodes[id];
    (n.type === 'condition' ? [n.yes, n.no] : [n.next]).forEach((t) => visit(t, depth + 1));
    state[id] = 2;
  };
  visit(graph?.start);
  return [...new Set(problems)];
}

export async function listWorkflows() {
  const { rows } = await query(
    `SELECT w.*, a.name AS audience_name, o.full_name AS owner_name,
            (SELECT COUNT(*)::int FROM mkt_enrollments e WHERE e.workflow_id = w.id) AS enrolled,
            (SELECT COUNT(*)::int FROM mkt_enrollments e WHERE e.workflow_id = w.id AND e.status = 'ACTIVE') AS in_progress,
            (SELECT COUNT(*)::int FROM mkt_messages m WHERE m.workflow_id = w.id AND m.sent_at IS NOT NULL) AS emails_sent
       FROM mkt_workflows w LEFT JOIN mkt_audiences a ON a.id = w.audience_id LEFT JOIN users o ON o.id = w.owner_user_id
      WHERE w.status <> 'ARCHIVED' ORDER BY w.updated_at DESC`,
  );
  return rows;
}

export async function getWorkflow(id) {
  const { rows } = await query(
    `SELECT w.*, a.name AS audience_name, sb.full_name AS submitted_by_name, ap.full_name AS approved_by_name
       FROM mkt_workflows w LEFT JOIN mkt_audiences a ON a.id = w.audience_id
       LEFT JOIN users sb ON sb.id = w.submitted_by LEFT JOIN users ap ON ap.id = w.approved_by
      WHERE w.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Automation not found');
  const { rows: steps } = await query(
    `SELECT workflow_node,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
            COUNT(*) FILTER (WHERE first_opened_at IS NOT NULL)::int AS opened,
            COUNT(*) FILTER (WHERE first_clicked_at IS NOT NULL)::int AS clicked
       FROM mkt_messages WHERE workflow_id = $1 GROUP BY workflow_node`,
    [id],
  );
  return { ...rows[0], step_stats: Object.fromEntries(steps.map((s) => [s.workflow_node, s])) };
}

const EDITABLE = ['name', 'description', 'audience_id', 'topic_id', 'trigger', 'graph', 'allow_reentry', 'from_name', 'from_email', 'reply_to', 'owner_user_id'];

export async function saveWorkflow(id, input, actor) {
  const values = Object.fromEntries(EDITABLE.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  if (!id) {
    if (!String(values.name || '').trim()) throw badRequest('Give the automation a name');
    const insert = { trigger: { type: 'MANUAL' }, ...values, created_by: actor.id, owner_user_id: values.owner_user_id || actor.id };
    const cols = Object.keys(insert);
    const { rows } = await query(
      `INSERT INTO mkt_workflows (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => insert[c]),
    );
    return getWorkflow(rows[0].id);
  }
  const current = await getWorkflow(id);
  if (current.status === 'ACTIVE' && ['trigger', 'graph', 'audience_id', 'topic_id', 'from_email', 'from_name', 'reply_to', 'allow_reentry'].some((k) => values[k] !== undefined)) {
    throw conflict('Pause the automation before changing it; it will need approving again');
  }
  const sets = [];
  const params = [id];
  for (const [k, v] of Object.entries(values)) { params.push(v); sets.push(`${k} = $${params.length}`); }
  if (sets.length) await query(`UPDATE mkt_workflows SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  const after = await getWorkflow(id);
  if (current.approved_fingerprint && workflowFingerprint(after) !== current.approved_fingerprint) {
    await query(`UPDATE mkt_workflows SET approved_by = NULL, approved_at = NULL, approved_fingerprint = NULL, submitted_at = NULL,
                       review_note = 'Changed after approval, so it needs approving again' WHERE id = $1`, [id]);
  }
  return getWorkflow(id);
}

export async function submitWorkflow(id, actor) {
  const w = await getWorkflow(id);
  const problems = validateWorkflow(w);
  if (problems.length) throw badRequest(`Fix these first: ${problems.join('; ')}`, { problems });
  const settings = await marketingSettings();
  if (!settings.approvals?.required) {
    await query(`UPDATE mkt_workflows SET submitted_by = $2, submitted_at = now(), approved_by = $2, approved_at = now(), approved_fingerprint = $3 WHERE id = $1`,
      [id, actor.id, workflowFingerprint(w)]);
  } else {
    await query(`UPDATE mkt_workflows SET submitted_by = $2, submitted_at = now(), review_note = NULL WHERE id = $1`, [id, actor.id]);
    const { rows } = await query('SELECT id, role, extra_permissions, revoked_permissions FROM users WHERE is_active AND id <> $1', [actor.id]);
    for (const u of rows.filter((x) => hasPermission(x, 'marketing.approve'))) {
      await notify(null, { userId: u.id, type: 'marketing_review', title: 'An email automation is waiting for your approval', body: w.name });
    }
  }
  return getWorkflow(id);
}

export async function approveWorkflow(id, actor, note = null) {
  if (!hasPermission(actor, 'marketing.approve')) throw forbidden('Requires permission: marketing.approve');
  const settings = await marketingSettings();
  const w = await getWorkflow(id);
  if (!w.submitted_at) throw conflict('This automation has not been sent for review');
  if (w.submitted_by === actor.id && !settings.approvals?.allowSelfApproval) throw forbidden('Someone other than the person who sent it for review approves it');
  const problems = validateWorkflow(w);
  if (problems.length) throw badRequest(`It cannot be approved yet: ${problems.join('; ')}`);
  await query(`UPDATE mkt_workflows SET approved_by = $2, approved_at = now(), approved_fingerprint = $3, review_note = $4 WHERE id = $1`,
    [id, actor.id, workflowFingerprint(w), note]);
  return getWorkflow(id);
}

export async function setWorkflowStatus(id, status, actor) {
  const w = await getWorkflow(id);
  if (status === 'ACTIVE') {
    if (!w.approved_fingerprint || workflowFingerprint(w) !== w.approved_fingerprint) throw conflict('It needs approving before it can start');
    const problems = validateWorkflow(w);
    if (problems.length) throw badRequest(problems.join('; '));
    await query(`UPDATE mkt_workflows SET status = 'ACTIVE', activated_by = $2, activated_at = COALESCE(activated_at, now()), updated_at = now() WHERE id = $1`, [id, actor.id]);
  } else if (['PAUSED', 'ARCHIVED', 'DRAFT'].includes(status)) {
    await query('UPDATE mkt_workflows SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
    if (status === 'ARCHIVED') await query(`UPDATE mkt_enrollments SET status = 'EXITED', exit_reason = 'Automation archived' WHERE workflow_id = $1 AND status = 'ACTIVE'`, [id]);
  } else throw badRequest('Unknown status');
  return getWorkflow(id);
}

// ---------------------------------------------------------------- enrolling

async function eligible(client, workflow, contactId) {
  const { rows } = await client.query('SELECT * FROM mkt_contacts WHERE id = $1', [contactId]);
  const c = rows[0];
  if (!c || c.is_archived || c.email_status !== 'ACTIVE' || c.unsubscribed_all_at) return null;
  if (await isSuppressed(client, c.email_normalized)) return null;
  if (workflow.audience_id) {
    const { rows: m } = await client.query('SELECT status FROM mkt_memberships WHERE audience_id = $1 AND contact_id = $2', [workflow.audience_id, contactId]);
    if (m[0]?.status !== 'SUBSCRIBED') return null;
  }
  return c;
}

/** Puts one person on an automation's path, once per run key. Returns true when they were added. */
export async function enroll(workflow, contactId, runKey, context = {}) {
  if (workflow.status !== 'ACTIVE') return false;
  const key = workflow.allow_reentry ? runKey : (['FESTIVAL', 'DATE_FIELD', 'INACTIVE', 'TASKFLOW_EVENT', 'CAMPAIGN_ACTIVITY'].includes(workflow.trigger.type) ? runKey : 'once');
  const person = await eligible({ query }, workflow, contactId);
  if (!person) return false;
  const { rows } = await query(
    `INSERT INTO mkt_enrollments (workflow_id, contact_id, run_key, current_node, next_run_at, context)
     VALUES ($1,$2,$3,$4,now(),$5) ON CONFLICT (workflow_id, contact_id, run_key) DO NOTHING RETURNING id`,
    [workflow.id, contactId, key, workflow.graph.start, context],
  );
  if (rows[0]) await logContactActivity(null, contactId, 'ENROLLED', { data: { workflow_id: workflow.id, workflow: workflow.name, run_key: key } });
  return Boolean(rows[0]);
}

export async function enrollManually(id, contactIds) {
  const w = await getWorkflow(id);
  if (w.status !== 'ACTIVE') throw conflict('Start the automation first');
  let added = 0;
  for (const cid of contactIds.slice(0, 5000)) if (await enroll(w, cid, `manual:${new Date().toISOString().slice(0, 10)}`)) added += 1;
  return { added };
}

const activeWorkflows = async () => (await query(`SELECT * FROM mkt_workflows WHERE status = 'ACTIVE'`)).rows;

/** Contact activity since the last pass → enrollments. */
export async function processActivity({ batch = 500 } = {}) {
  const { rows: cursorRows } = await query(`SELECT position FROM mkt_cursors WHERE key = 'activity'`);
  let position = Number(cursorRows[0]?.position || 0);
  const { rows } = await query('SELECT * FROM mkt_contact_activity WHERE id > $1 ORDER BY id LIMIT $2', [position, batch]);
  if (!rows.length) return { read: 0, enrolled: 0 };
  const workflows = await activeWorkflows();
  let enrolled = 0;
  for (const a of rows) {
    position = Number(a.id);
    for (const w of workflows) {
      if (w.activated_at && new Date(a.created_at) < new Date(w.activated_at)) continue;
      const t = w.trigger || {};
      let match = false;
      let context = {};
      if (t.type === 'AUDIENCE_JOINED' && a.type === 'JOINED' && Number(a.audience_id) === Number(t.audience_id)) match = true;
      if (t.type === 'TAG_ADDED' && a.type === 'TAG_ADDED' && String(a.data?.tag) === String(t.tag).toLowerCase()) match = true;
      if (t.type === 'FORM_SUBMITTED' && a.type === 'FORM_SUBMITTED' && Number(a.data?.form_id) === Number(t.form_id)) match = true;
      if (t.type === 'TASKFLOW_EVENT' && a.type === 'TASKFLOW_EVENT' && a.data?.event === t.event
          && (!t.stage || String(a.data?.stage || '').toLowerCase() === String(t.stage).toLowerCase())) {
        match = true;
        context = { event: a.data };
      }
      if (!match) continue;
      const runKey = t.type === 'TASKFLOW_EVENT' ? `event:${a.data.event}:${a.data.entity_id}` : `activity:${a.id}`;
      if (await enroll(w, a.contact_id, runKey, context)) enrolled += 1;
    }
  }
  await query(`UPDATE mkt_cursors SET position = $1, updated_at = now() WHERE key = 'activity'`, [position]);
  return { read: rows.length, enrolled };
}

/** Email activity → CAMPAIGN_ACTIVITY automations (clicked or opened). */
export async function onEmailEvent({ event, message, contact, human }) {
  if (!human || !message?.campaign_id || !['OPEN', 'CLICK'].includes(event.type)) return;
  for (const w of await activeWorkflows()) {
    const t = w.trigger || {};
    if (t.type !== 'CAMPAIGN_ACTIVITY' || Number(t.campaign_id) !== Number(message.campaign_id)) continue;
    if ((t.activity === 'CLICKED' && event.type === 'CLICK') || (t.activity === 'OPENED' && ['OPEN', 'CLICK'].includes(event.type))) {
      await enroll(w, contact.id, `campaign:${message.campaign_id}`);
    }
  }
}

const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function audienceMembers(audienceId) {
  if (!audienceId) {
    const { rows } = await query(`SELECT DISTINCT contact_id FROM mkt_memberships WHERE status = 'SUBSCRIBED'`);
    return rows.map((r) => r.contact_id);
  }
  const { rows } = await query(`SELECT contact_id FROM mkt_memberships WHERE audience_id = $1 AND status = 'SUBSCRIBED'`, [audienceId]);
  return rows.map((r) => r.contact_id);
}

/** Date-driven triggers: festivals, date fields, going quiet, campaigns not opened. Safe to run often. */
export async function runDateTriggers(now = new Date()) {
  const settings = await marketingSettings();
  const { date: today, hour } = localParts(now, settings.timezone);
  let enrolled = 0;
  for (const w of await activeWorkflows()) {
    const t = w.trigger || {};
    if (t.type === 'FESTIVAL') {
      if (hour < (Number(t.send_hour) || 9)) continue;
      const target = addDays(today, Number(t.days_before) || 0);
      const { rows: festivals } = await query(
        `SELECT * FROM mkt_festivals WHERE is_confirmed AND date = $1 AND ($2::int[] IS NULL OR id = ANY($2::int[]))`,
        [target, t.festival_ids?.length ? t.festival_ids : null],
      );
      for (const f of festivals) {
        for (const cid of await audienceMembers(w.audience_id)) {
          if (await enroll(w, cid, `festival:${f.id}`, { festival: f.name, festival_hi: f.name_hi, festival_date: String(f.date).slice(0, 10) })) enrolled += 1;
        }
      }
    }
    if (t.type === 'DATE_FIELD' && /^[a-z][a-z0-9_]*$/.test(t.field || '')) {
      if (hour < (Number(t.send_hour) || 9)) continue;
      const target = addDays(today, Number(t.days_before) || 0);
      const { rows } = await query(
        `SELECT id FROM mkt_contacts WHERE is_archived = FALSE AND custom ->> $1 ~ '^\\d{4}-\\d{2}-\\d{2}' AND substring(custom ->> $1, 6, 5) = $2`,
        [t.field, target.slice(5)],
      );
      for (const r of rows) if (await enroll(w, r.id, `date:${t.field}:${target.slice(0, 4)}`)) enrolled += 1;
    }
    if (t.type === 'INACTIVE') {
      const days = Math.max(14, Number(t.days) || 90);
      const params = [days];
      const audienceClause = w.audience_id ? `AND EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.audience_id = $2 AND m.status = 'SUBSCRIBED')` : '';
      if (w.audience_id) params.push(w.audience_id);
      const { rows } = await query(
        `SELECT c.id FROM mkt_contacts c
          WHERE c.is_archived = FALSE AND c.email_status = 'ACTIVE'
            AND c.last_sent_at IS NOT NULL AND c.created_at < now() - make_interval(days => $1)
            AND COALESCE(GREATEST(c.last_opened_at, c.last_clicked_at), to_timestamp(0)) < now() - make_interval(days => $1)
            AND EXISTS (SELECT 1 FROM mkt_messages m WHERE m.contact_id = c.id AND m.sent_at > now() - make_interval(days => $1))
            ${audienceClause}
          LIMIT 5000`,
        params,
      );
      for (const r of rows) if (await enroll(w, r.id, `inactive:${today.slice(0, 7)}`)) enrolled += 1;
    }
    if (t.type === 'CAMPAIGN_ACTIVITY' && t.activity === 'NOT_OPENED') {
      const after = Math.max(1, Number(t.after_days) || 3);
      const { rows } = await query(
        `SELECT m.contact_id FROM mkt_messages m
          WHERE m.campaign_id = $1 AND m.kind = 'CAMPAIGN' AND m.sent_at IS NOT NULL AND m.sent_at < now() - make_interval(days => $2)
            AND m.first_opened_at IS NULL AND m.status IN ('SENT', 'DELIVERED')`,
        [t.campaign_id, after],
      );
      for (const r of rows) if (await enroll(w, r.contact_id, `campaign:${t.campaign_id}`)) enrolled += 1;
    }
  }
  return { enrolled };
}

// ---------------------------------------------------------------- following the path

async function evaluate(condition, enrollment, contact) {
  const c = condition || {};
  const inRun = `SELECT 1 FROM mkt_messages m WHERE m.enrollment_id = $1`;
  switch (c.kind) {
    case 'opened': return (await query(`${inRun} AND m.first_opened_at IS NOT NULL LIMIT 1`, [enrollment.id])).rows.length > 0;
    case 'clicked': return (await query(`${inRun} AND m.first_clicked_at IS NOT NULL LIMIT 1`, [enrollment.id])).rows.length > 0;
    case 'replied': return (await query(`${inRun} AND m.replied_at IS NOT NULL LIMIT 1`, [enrollment.id])).rows.length > 0;
    case 'converted': return Boolean(contact.last_converted_at && new Date(contact.last_converted_at) >= new Date(enrollment.enrolled_at));
    case 'tag': return (contact.tags || []).includes(String(c.value || '').toLowerCase());
    case 'field': {
      const raw = String(c.key || '').startsWith('custom.') ? contact.custom?.[c.key.slice(7)] : contact[c.key];
      const v = raw === null || raw === undefined ? '' : String(raw).toLowerCase();
      const want = String(c.value ?? '').toLowerCase();
      if (c.op === 'empty') return v === '';
      if (c.op === 'not_empty') return v !== '';
      if (c.op === 'contains') return v.includes(want);
      return v === want;
    }
    case 'audience': return (await query(`SELECT 1 FROM mkt_memberships WHERE contact_id = $1 AND audience_id = $2 AND status = 'SUBSCRIBED'`, [contact.id, c.value])).rows.length > 0;
    case 'engagement_at_least': return contact.engagement_score >= Number(c.value || 0);
    case 'crm_type': {
      if (!contact.account_id) return c.value === 'NONE';
      return (await query('SELECT type FROM accounts WHERE id = $1', [contact.account_id])).rows[0]?.type === c.value;
    }
    case 'has_open_deal': return Boolean(contact.account_id) && (await query(`SELECT 1 FROM opportunities WHERE account_id = $1 AND status IN ('ACTIVE','ON_HOLD','NURTURE') LIMIT 1`, [contact.account_id])).rows.length > 0;
    default: return false;
  }
}

async function act(action, { workflow, enrollment, contact, nodeId }) {
  const a = action || {};
  switch (a.kind) {
    case 'add_tag': await changeTags([contact.id], { add: [a.value] }); return `tagged ${a.value}`;
    case 'remove_tag': await changeTags([contact.id], { remove: [a.value] }); return `untagged ${a.value}`;
    case 'add_to_audience': {
      const r = await addToAudience(null, contact.id, Number(a.value), { status: 'SUBSCRIBED', source: 'AUTOMATION', basis: `Added by the automation “${workflow.name}”` });
      return `audience ${a.value}: ${r.result}`;
    }
    case 'remove_from_audience':
      await query(`UPDATE mkt_memberships SET status = 'ARCHIVED', updated_at = now() WHERE contact_id = $1 AND audience_id = $2 AND status IN ('SUBSCRIBED','PENDING')`, [contact.id, Number(a.value)]);
      await logContactActivity(null, contact.id, 'LEFT', { audienceId: Number(a.value), data: { source: 'AUTOMATION', workflow_id: workflow.id } });
      return `left audience ${a.value}`;
    case 'create_task': {
      const made = await createFollowUp({
        contact, workflow, nodeKey: `${nodeId}:${enrollment.run_key}`, reason: 'AUTOMATION',
        title: a.title ? String(a.title).replace(/\{\{\s*name\s*\}\}/g, [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email) : null,
        assign: a.assign || 'CONTACT_OWNER', dueDays: a.due_days, detail: a.detail || '',
      });
      return made.created ? `task ${made.task.ref}` : 'task already there';
    }
    case 'notify_owner': {
      const owner = contact.owner_user_id || (contact.account_id ? (await query('SELECT owner_user_id FROM accounts WHERE id = $1', [contact.account_id])).rows[0]?.owner_user_id : null) || workflow.owner_user_id;
      if (owner) await notify(null, { userId: owner, type: 'marketing', title: a.title || `${contact.first_name || contact.email} reached a step in “${workflow.name}”`, body: a.detail || contact.email, accountId: contact.account_id || null });
      return 'notified';
    }
    case 'update_field':
      if (/^[a-z][a-z0-9_]{0,39}$/.test(a.key || '')) await query(`UPDATE mkt_contacts SET custom = custom || jsonb_build_object($2::text, $3::text), updated_at = now() WHERE id = $1`, [contact.id, a.key, String(a.value ?? '')]);
      return `set ${a.key}`;
    case 'set_language':
      if (['en', 'hi'].includes(a.value)) await query('UPDATE mkt_contacts SET language = $2 WHERE id = $1', [contact.id, a.value]);
      return `language ${a.value}`;
    default: return 'nothing';
  }
}

/** Moves one person along their path as far as it goes now. */
export async function advance(enrollmentId, now = new Date()) {
  const { rows } = await query(
    `SELECT e.*, row_to_json(w.*) AS workflow FROM mkt_enrollments e JOIN mkt_workflows w ON w.id = e.workflow_id WHERE e.id = $1`,
    [enrollmentId],
  );
  const enrollment = rows[0];
  if (!enrollment || enrollment.status !== 'ACTIVE') return null;
  const workflow = enrollment.workflow;
  const history = [...(enrollment.history || [])];
  const context = { ...(enrollment.context || {}) };
  let nodeId = enrollment.current_node;
  let nextRun = null;
  let status = 'ACTIVE';
  let exitReason = null;

  if (workflow.status !== 'ACTIVE') return null;
  const contact = await eligible({ query }, workflow, enrollment.contact_id);
  if (!contact) {
    status = 'EXITED';
    exitReason = 'No longer subscribed, or the address cannot be emailed';
  }

  for (let steps = 0; status === 'ACTIVE' && steps < 25; steps += 1) {
    const node = workflow.graph?.nodes?.[nodeId];
    if (!node) { status = 'COMPLETED'; break; }
    if (node.type === 'exit') { status = 'COMPLETED'; history.push({ node: nodeId, at: now.toISOString(), did: 'exit' }); break; }
    if (node.type === 'delay') {
      if (context.wait_node === nodeId) {
        if (new Date(context.wait_until) > now) { nextRun = new Date(context.wait_until); break; }
        delete context.wait_node; delete context.wait_until;
        history.push({ node: nodeId, at: now.toISOString(), did: 'waited' });
        nodeId = node.next;
        continue;
      }
      const until = new Date(now.getTime() + Number(node.config.amount) * UNIT_MS[node.config.unit]);
      context.wait_node = nodeId;
      context.wait_until = until.toISOString();
      nextRun = until;
      break;
    }
    if (node.type === 'email') {
      await query(
        `INSERT INTO mkt_messages (kind, workflow_id, workflow_node, enrollment_id, audience_id, contact_id, email, token, reply_code)
         VALUES ('AUTOMATION', $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (enrollment_id, workflow_node) WHERE kind = 'AUTOMATION' DO NOTHING`,
        [workflow.id, nodeId, enrollment.id, workflow.audience_id, contact.id, contact.email, newToken(), newReplyCode()],
      );
      history.push({ node: nodeId, at: now.toISOString(), did: 'queued email' });
      nodeId = node.next;
      continue;
    }
    if (node.type === 'condition') {
      const yes = await evaluate(node.config, enrollment, contact);
      history.push({ node: nodeId, at: now.toISOString(), did: yes ? 'yes' : 'no' });
      nodeId = yes ? node.yes : node.no;
      continue;
    }
    if (node.type === 'action') {
      const did = await act(node.config, { workflow, enrollment, contact, nodeId });
      history.push({ node: nodeId, at: now.toISOString(), did });
      nodeId = node.next;
      continue;
    }
    status = 'FAILED';
    exitReason = `Unknown step ${nodeId}`;
  }

  await query(
    `UPDATE mkt_enrollments SET status = $2, current_node = $3, next_run_at = $4, context = $5, history = $6, exit_reason = $7,
            completed_at = CASE WHEN $2 IN ('COMPLETED', 'EXITED', 'FAILED') THEN now() ELSE completed_at END
      WHERE id = $1`,
    [enrollment.id, status, nodeId, status === 'ACTIVE' ? nextRun : null, context, JSON.stringify(history.slice(-100)), exitReason],
  );
  return { status, node: nodeId, nextRun };
}

/** Everyone whose next step is due. */
export async function advanceDue({ limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT e.id FROM mkt_enrollments e JOIN mkt_workflows w ON w.id = e.workflow_id
      WHERE e.status = 'ACTIVE' AND w.status = 'ACTIVE' AND e.next_run_at <= now()
      ORDER BY e.next_run_at LIMIT $1`,
    [limit],
  );
  for (const r of rows) {
    try {
      await advance(r.id);
    } catch (err) {
      await query(`UPDATE mkt_enrollments SET status = 'FAILED', exit_reason = $2 WHERE id = $1`, [r.id, String(err.message).slice(0, 300)]);
    }
  }
  return { advanced: rows.length };
}

export async function enrollmentsFor(id, { limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT e.id, e.status, e.current_node, e.next_run_at, e.enrolled_at, e.completed_at, e.exit_reason, e.run_key, e.history,
            c.id AS contact_id, c.email, c.first_name, c.last_name
       FROM mkt_enrollments e JOIN mkt_contacts c ON c.id = e.contact_id
      WHERE e.workflow_id = $1 ORDER BY e.enrolled_at DESC LIMIT $2`,
    [id, limit],
  );
  return rows;
}

