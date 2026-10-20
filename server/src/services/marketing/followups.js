/**
 * Where email activity meets TaskFlow's work: follow-up tasks, and the
 * organization's history in the pipeline.
 *
 * A person gets one follow-up task per campaign (or automation step), however
 * many times they click, reply or convert: a later reason is added to the same
 * task as a comment. The task is an ordinary TaskFlow task — it lands in My
 * Tasks, notifies its assignee, and is linked to the organization.
 *
 * History entries are written as their own type, CAMPAIGN, and never count as a
 * salesperson's touch: they do not move a deal's "last spoke to the customer"
 * or "last worked" clocks, which stay about real work.
 */

import { query, withTransaction } from '../../db/pool.js';
import { nextTaskRef } from '../../lib/taskRef.js';
import { notify, logActivity as logTaskActivity } from '../activity.js';
import { firstName, instantAtLocal, localParts, marketingSettings } from './core.js';

export const REASON_WORDS = {
  CLICK: 'clicked a link in',
  REPLY: 'replied to',
  CONVERSION: 'converted after',
  AUTOMATION: 'reached a step in',
  UNSUBSCRIBE: 'unsubscribed from',
};

const personName = (contact) => [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email;

async function resolveAssignee(client, { assign, contact, campaign, workflow }) {
  const candidates = [];
  const owner = campaign?.owner_user_id ?? workflow?.owner_user_id ?? null;
  const creator = campaign?.created_by ?? workflow?.created_by ?? null;
  // a named person first
  if (assign !== null && assign !== undefined && /^\d+$/.test(String(assign))) candidates.push(Number(assign));
  if (assign === 'CAMPAIGN_OWNER' || assign === 'WORKFLOW_OWNER') candidates.push(owner, creator);
  // the person who looks after this contact or their organization, then the campaign's owner
  candidates.push(contact.owner_user_id);
  if (contact.account_id) {
    const { rows } = await client.query('SELECT owner_user_id FROM accounts WHERE id = $1', [contact.account_id]);
    candidates.push(rows[0]?.owner_user_id);
  }
  candidates.push(owner, creator);
  for (const id of candidates.filter(Boolean)) {
    const { rows } = await client.query('SELECT id, department_id FROM users WHERE id = $1 AND is_active', [id]);
    if (rows[0]) return rows[0];
  }
  return null;
}

/**
 * Creates the follow-up task for this person and campaign, once.
 * Returns { task, created } — created false when an earlier one exists (the
 * new reason is then added to it as a comment).
 */
export async function createFollowUp({
  contact, campaign = null, workflow = null, nodeKey = null, message = null, reason, detail = '',
  assign = 'CONTACT_OWNER', dueDays = null, title = null,
}) {
  const settings = await marketingSettings();
  const key = campaign
    ? `campaign:${campaign.id}:${contact.id}`
    : workflow ? `workflow:${workflow.id}:${nodeKey || 'reply'}:${contact.id}` : `message:${message?.id}:${reason}`;

  return withTransaction(async (client) => {
    // claim the key first, so two events at once cannot make two tasks
    const { rows: claimed } = await client.query(
      `INSERT INTO mkt_followups (dedupe_key, contact_id, campaign_id, workflow_id, message_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [key, contact.id, campaign?.id ?? null, workflow?.id ?? null, message?.id ?? null, reason],
    );
    const what = `${personName(contact)} ${REASON_WORDS[reason] || 'acted on'} “${campaign?.name || workflow?.name || 'an email'}”`;
    if (!claimed[0]) {
      const { rows } = await client.query(
        `SELECT f.*, t.id AS tid FROM mkt_followups f LEFT JOIN tasks t ON t.id = f.task_id WHERE f.dedupe_key = $1`, [key],
      );
      const existing = rows[0];
      if (existing?.tid && existing.reason !== reason) {
        await client.query('INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, NULL, $2)', [existing.tid, `Also: ${what}.${detail ? ` ${detail}` : ''}`]);
      }
      return { task: existing?.tid ? { id: existing.tid } : null, created: false };
    }

    const assignee = await resolveAssignee(client, { assign, contact, campaign, workflow });
    if (!assignee) return { task: null, created: false, reason: 'Nobody to assign it to' };
    let departmentId = assignee.department_id || settings.followUps?.departmentId || null;
    if (!departmentId) {
      const { rows } = await client.query('SELECT id FROM departments ORDER BY position, id LIMIT 1');
      departmentId = rows[0]?.id;
    }
    const { rows: statuses } = await client.query(
      'SELECT id FROM workflow_statuses WHERE is_active = TRUE ORDER BY is_default DESC, position ASC LIMIT 1',
    );
    if (!departmentId || !statuses[0]) return { task: null, created: false, reason: 'No department or board column to put it in' };

    const days = Math.max(0, Number(dueDays ?? settings.followUps?.dueDays ?? 2));
    const dueDay = localParts(new Date(Date.now() + days * 86_400_000), settings.timezone).date;
    const due = instantAtLocal(dueDay, 18, settings.timezone);
    const taskTitle = (title || `Follow up with ${personName(contact)} — ${REASON_WORDS[reason] || 'acted on'} “${campaign?.name || workflow?.name || 'an email'}”`).slice(0, 240);
    const description = [
      `${what}.`,
      detail,
      '',
      `Email: ${contact.email}`,
      contact.phone ? `Phone: ${contact.phone}` : null,
      contact.organization ? `Organization: ${contact.organization}` : null,
      '',
      'Created by Email marketing. Their full email history is under Email marketing → Contacts.',
    ].filter((l) => l !== null).join('\n');

    const ref = await nextTaskRef(client, departmentId);
    const { rows: tasks } = await client.query(
      `INSERT INTO tasks (ref, title, description, department_id, status_id, priority, task_type, assignee_id, reporter_id,
                          created_by, due_date, original_due_date, account_id, tags, position)
       VALUES ($1,$2,$3,$4,$5,'medium','campaign',$6,$7,$7,$8,$8,$9,ARRAY['email-follow-up'],
               (SELECT COALESCE(MAX(position),0)+100 FROM tasks WHERE status_id = $5))
       RETURNING *`,
      [ref, taskTitle, description, departmentId, statuses[0].id, assignee.id,
        campaign?.owner_user_id ?? workflow?.owner_user_id ?? null, due, contact.account_id ?? null],
    );
    const task = tasks[0];
    await logTaskActivity(client, { taskId: task.id, actorId: null, action: 'created', meta: { source: 'email_marketing', reason } });
    await client.query('UPDATE mkt_followups SET task_id = $2 WHERE id = $1', [claimed[0].id, task.id]);
    await notify(client, {
      userId: assignee.id, type: 'assigned', title: `Follow up with ${firstName(personName(contact))}: ${REASON_WORDS[reason] || 'acted on'} an email`,
      body: taskTitle, taskId: task.id, accountId: contact.account_id ?? null,
    });
    return { task, created: true };
  });
}

/**
 * Writes an email event into the organization's history, once per key.
 * Only for contacts linked to an organization in the pipeline.
 */
export async function recordCrmHistory(client, contact, { key, subject, body = null, occurredAt = null, taskId = null, meta = {} }) {
  if (!contact?.account_id) return null;
  const runner = client || { query };
  const { rows: exists } = await runner.query(
    `SELECT 1 FROM account_activities WHERE account_id = $1 AND type = 'CAMPAIGN' AND meta->>'mkt_key' = $2 LIMIT 1`,
    [contact.account_id, key],
  );
  if (exists[0]) return null;
  const { rows } = await runner.query(
    `INSERT INTO account_activities
       (account_id, type, actor_id, subject, body, task_id, occurred_at, meta, contact_id, channel, direction, outcome, is_external, source)
     VALUES ($1,'CAMPAIGN',NULL,$2,$3,$4,COALESCE($5, now()),$6,$7,'EMAIL',NULL,'NOTED',TRUE,'SYSTEM')
     RETURNING id`,
    [contact.account_id, subject.slice(0, 240), body, taskId, occurredAt, { ...meta, mkt_key: key }, contact.crm_contact_id ?? null],
  );
  return rows[0];
}

/** Every follow-up made from marketing, newest first, with the task's state. */
export async function listFollowUps({ campaignId = null, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT f.*, c.email, c.first_name, c.last_name, c.organization, t.ref AS task_ref, t.title AS task_title,
            t.due_date, ws.stage AS task_stage, ws.name AS task_status, u.full_name AS assignee_name,
            cam.name AS campaign_name, w.name AS workflow_name
       FROM mkt_followups f
       JOIN mkt_contacts c ON c.id = f.contact_id
       LEFT JOIN tasks t ON t.id = f.task_id
       LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN mkt_campaigns cam ON cam.id = f.campaign_id
       LEFT JOIN mkt_workflows w ON w.id = f.workflow_id
      WHERE ($1::int IS NULL OR f.campaign_id = $1)
      ORDER BY f.created_at DESC LIMIT $2`,
    [campaignId, limit],
  );
  return rows;
}
