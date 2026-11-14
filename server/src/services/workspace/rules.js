/**
 * The workspace's reminder rules (Part E of docs/MY_WORKSPACE_PLAN.md), as
 * planners for the reminder engine in ./reminders.js. Each rule reaches the
 * record's current owner (meetings: the owner and colleagues taking part),
 * by default at 09:00 in their own timezone. Never everyone, never all
 * supporters, never the person who assigned it.
 *
 *   APPLICATION_DEADLINE           3 calendar days before (date-only deadlines keep their date;
 *                                  exact ones their instant), while submission is outstanding.
 *                                  Also a CSR / NGO deal's proposal deadline, until a proposal is sent.
 *   APPLICATION_DEADLINE_1D/_SAME_DAY  opt-in extras
 *   APPLICATION_STATUS_CHECK       the next check chosen, else the organiser's date, else 15 days
 *                                  after the submitted date; ends with a substantive update
 *   MEETING_TO_ARRANGE             the arrange-by date, to the person arranging it
 *   MEETING_PREP / MEETING_START   the day before / 30 minutes before a confirmed meeting
 *   DEAL_NEXT_STEP                 the next action's date, unless a task tracks it
 *   DEAL_WAITING_UNTIL, DEAL_REVISIT  those dates
 */
import { addDays } from '../../../../shared/deadlineHealth.js';
import { localDate, zonedInstant } from '../sales/core.js';
import { registerPlanner } from './reminders.js';
import {
  APPLICATION_SELECT, deadlineDay, deadlineEnds, deadlineOf, deadlineWords, statusCheck,
} from './applications.js';

const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const COMPANY_TZ = 'Asia/Kolkata';

async function personTz(runner, userId) {
  const { rows } = await runner.query(
    `SELECT u.timezone, (SELECT value->>'timezone' FROM settings WHERE key = 'organisation') AS company FROM users u WHERE u.id = $1`, [userId],
  );
  return rows[0]?.timezone || rows[0]?.company || COMPANY_TZ;
}
const endOfDay = (date, tz) => zonedInstant(addDays(date, 1), '00:00', tz);
const fmtAt = (at, tz) => `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)} ${tz === 'Asia/Kolkata' ? 'IST' : tz}`;

// ---------------------------------------------------------------- applications

const DEADLINE_RULES = [['APPLICATION_DEADLINE', 3], ['APPLICATION_DEADLINE_1D', 1], ['APPLICATION_DEADLINE_SAME_DAY', 0]];

function deadlineWanted(recipientId, dl, tz, keyPrefix, label) {
  const day = deadlineDay(dl, tz);
  const until = deadlineEnds(dl, tz);
  const id = dl.dateOnly ? `date:${dl.date}` : `at:${dl.at.toISOString()}`;
  return DEADLINE_RULES.map(([ruleKey, before]) => ({
    recipientId, ruleKey, occurrenceKey: `${keyPrefix}${id}`, date: addDays(day, -before), until,
    facts: { deadline: dl.dateOnly ? { date: dl.date } : { at: dl.at.toISOString(), timezone: dl.timezone }, label },
  }));
}

registerPlanner({
  name: 'applications',
  entityType: 'APPLICATION',
  rules: ['APPLICATION_DEADLINE', 'APPLICATION_DEADLINE_1D', 'APPLICATION_DEADLINE_SAME_DAY', 'APPLICATION_STATUS_CHECK', 'DEAL_NEXT_STEP'],
  async plan(runner, id) {
    const { rows } = await runner.query(`${APPLICATION_SELECT} WHERE o.id = $1`, [id]);
    const a = rows[0];
    if (!a || a.is_archived) return { desired: [], why: 'The application was removed' };
    if (a.stage_kind === 'won' || a.stage_kind === 'lost' || a.status !== 'ACTIVE') {
      return { desired: [], why: `Outcome recorded: ${a.stage_name}` };
    }
    if (!a.owner_user_id) return { desired: [], why: 'Nobody owns the application' };
    const tz = await personTz(runner, a.owner_user_id);
    const desired = [];
    const dl = deadlineOf(a);
    if (dl && !a.submitted_on) desired.push(...deadlineWanted(a.owner_user_id, dl, tz, '', null));
    const { rows: rounds } = await runner.query(`SELECT * FROM application_rounds WHERE opportunity_id = $1 AND status = 'OPEN'`, [id]);
    for (const r of rounds) {
      const rd = deadlineOf(r);
      if (rd) desired.push(...deadlineWanted(a.owner_user_id, rd, tz, `round${r.id}:`, r.name));
    }
    const check = statusCheck(a);
    if (check) {
      desired.push({ recipientId: a.owner_user_id, ruleKey: 'APPLICATION_STATUS_CHECK', occurrenceKey: `check:${check.date}`, date: check.date, facts: { source: check.source, words: check.words } });
    }
    if (a.next_step && a.next_step_due && !a.next_step_task_id) {
      desired.push({ recipientId: a.owner_user_id, ruleKey: 'DEAL_NEXT_STEP', occurrenceKey: `next:${dayOf(a.next_step_due)}`, date: dayOf(a.next_step_due), facts: { step: a.next_step } });
    }
    return { desired, why: a.submitted_on ? `Submitted on ${dayOf(a.submitted_on)}` : 'The deadline changed or was removed' };
  },
  async sweep(runner, { forUser = null } = {}) {
    const { rows } = await runner.query(
      `SELECT o.id FROM opportunities o JOIN crm_pipelines p ON p.id = o.pipeline_id AND p.category = 'APPLICATIONS'
        WHERE o.is_archived = FALSE AND o.status = 'ACTIVE' AND ($1::int IS NULL OR o.owner_user_id = $1)`, [forUser],
    );
    return rows.map((r) => r.id);
  },
  async words(runner, o, { tz, label, now }) {
    const { rows } = await runner.query(`${APPLICATION_SELECT} WHERE o.id = $1`, [o.entity_id]);
    const a = rows[0];
    const name = label?.label || 'An application';
    const why = 'You own this application';
    if (o.rule_key === 'APPLICATION_STATUS_CHECK') {
      const check = statusCheck(a);
      return {
        title: `Check application status: ${name}`,
        body: [`Submitted on ${dayOf(a.submitted_on)}${a.acknowledged_on ? ` and acknowledged on ${dayOf(a.acknowledged_on)}` : ''}. No update recorded.`,
          `This date comes from ${check?.words || 'the status check'}. Log what you hear, or set the next check date.`].join('\n'),
        why,
      };
    }
    if (o.rule_key === 'DEAL_NEXT_STEP') {
      return { title: `Next action due: ${a.next_step}`, body: `${name}\nDue ${dayOf(a.next_step_due)}.`, why };
    }
    const f = o.facts?.deadline;
    const dl = f?.date ? { date: f.date, dateOnly: true } : { at: new Date(f.at), timezone: f.timezone, dateOnly: false };
    const w = deadlineWords(dl, tz, now);
    const left = w.text.split(' · ').pop();
    const what = o.facts?.label ? `${o.facts.label} (${name})` : name;
    return {
      title: `${left} to submit: ${what}`,
      body: [`Deadline: ${w.text}`, 'The submission is still outstanding.', a.opportunity_url ? `Link: ${a.opportunity_url}` : null].filter(Boolean).join('\n'),
      why,
    };
  },
});

// ---------------------------------------------------------------- meetings

const MEETING_FOR_PLAN = `
  SELECT m.*, a.name AS account_name,
         ARRAY(SELECT p.user_id FROM crm_meeting_participants p JOIN users pu ON pu.id = p.user_id WHERE p.meeting_id = m.id AND pu.is_active) AS colleague_ids
    FROM crm_meetings m LEFT JOIN accounts a ON a.id = m.account_id`;

registerPlanner({
  name: 'meetings',
  entityType: 'MEETING',
  rules: ['MEETING_TO_ARRANGE', 'MEETING_PREP', 'MEETING_START'],
  async plan(runner, id) {
    const { rows } = await runner.query(`${MEETING_FOR_PLAN} WHERE m.id = $1`, [id]);
    const m = rows[0];
    if (!m) return { desired: [], why: 'The meeting was removed' };
    if (m.status === 'CANCELLED') return { desired: [], why: 'The meeting was cancelled' };
    if (m.status === 'COMPLETED' || m.status === 'NO_SHOW') return { desired: [], why: 'The meeting has taken place' };
    const desired = [];
    if (['TO_ARRANGE', 'TIME_PROPOSED'].includes(m.status)) {
      const who = m.scheduling_owner_id || m.owner_user_id || m.created_by;
      if (m.arrange_by && who) desired.push({ recipientId: who, ruleKey: 'MEETING_TO_ARRANGE', occurrenceKey: `arrange:${dayOf(m.arrange_by)}`, date: dayOf(m.arrange_by), facts: {} });
      // never a start-time reminder without a confirmed time
      return { desired, why: 'The meeting has no confirmed time yet' };
    }
    if (m.status === 'SCHEDULED' && m.scheduled_at) {
      const at = new Date(m.scheduled_at);
      const people = [...new Set([m.owner_user_id, ...(m.colleague_ids || [])].filter(Boolean))];
      for (const p of people) {
        const tz = await personTz(runner, p);
        desired.push({ recipientId: p, ruleKey: 'MEETING_PREP', occurrenceKey: `prep:${at.toISOString()}`, date: addDays(localDate(at, tz), -1), until: at, facts: {} });
        desired.push({ recipientId: p, ruleKey: 'MEETING_START', occurrenceKey: `start:${at.toISOString()}`, at: new Date(at.getTime() - 30 * 60_000), until: at, facts: {} });
      }
    }
    return { desired, why: 'The meeting time changed' };
  },
  async sweep(runner, { forUser = null } = {}) {
    const { rows } = await runner.query(
      `SELECT id FROM crm_meetings m
        WHERE ((status IN ('TO_ARRANGE', 'TIME_PROPOSED') AND arrange_by IS NOT NULL)
               OR (status = 'SCHEDULED' AND scheduled_at > now() - interval '1 day' AND scheduled_at < now() + interval '60 days'))
          AND ($1::int IS NULL OR m.owner_user_id = $1 OR m.scheduling_owner_id = $1
               OR EXISTS (SELECT 1 FROM crm_meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $1))`, [forUser],
    );
    return rows.map((r) => r.id);
  },
  async words(runner, o, { tz }) {
    const { rows } = await runner.query(`${MEETING_FOR_PLAN} WHERE m.id = $1`, [o.entity_id]);
    const m = rows[0];
    const about = [m.account_name, m.objective].filter(Boolean).join(' · ');
    const where = m.meeting_url || m.location;
    if (o.rule_key === 'MEETING_TO_ARRANGE') {
      return {
        title: `Arrange the meeting: ${m.title}`,
        body: [`You wanted this arranged by ${dayOf(m.arrange_by)}.${m.proposed_at ? ` A time was proposed (${fmtAt(new Date(m.proposed_at), tz)}), not yet confirmed.` : ' No time is confirmed yet.'}`, about || null].filter(Boolean).join('\n'),
        why: 'You are arranging this meeting',
      };
    }
    const at = new Date(m.scheduled_at);
    const own = m.timezone && m.timezone !== tz ? ` (${fmtAt(at, m.timezone)})` : '';
    return {
      title: o.rule_key === 'MEETING_START' ? `Starts in 30 minutes: ${m.title}` : `Meeting tomorrow: ${m.title}`,
      body: [`${fmtAt(at, tz)}${own}`, about || null, where ? `Where: ${where}` : null, o.rule_key === 'MEETING_PREP' ? 'Prepare: the purpose, who is coming, and what you need from it.' : null].filter(Boolean).join('\n'),
      why: o.recipient_id === m.owner_user_id ? 'You own this meeting' : 'You are taking part in this meeting',
    };
  },
});

// ---------------------------------------------------------------- deals

const DEAL_FOR_PLAN = `
  SELECT o.*, a.name AS account_name, s.kind AS stage_kind, s.name AS stage_name, p.category AS pipeline_category,
         nt.id AS task_open
    FROM opportunities o JOIN accounts a ON a.id = o.account_id
    LEFT JOIN account_stages s ON s.id = o.stage_id
    LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id
    LEFT JOIN LATERAL (SELECT t.id FROM tasks t JOIN workflow_statuses ws ON ws.id = t.status_id
                        WHERE t.id = o.next_step_task_id AND t.is_archived = FALSE AND ws.stage NOT IN ('done', 'cancelled')) nt ON TRUE`;

registerPlanner({
  name: 'deals',
  entityType: 'DEAL',
  rules: ['DEAL_NEXT_STEP', 'DEAL_WAITING_UNTIL', 'DEAL_REVISIT', 'APPLICATION_DEADLINE'],
  async plan(runner, id) {
    const { rows } = await runner.query(`${DEAL_FOR_PLAN} WHERE o.id = $1`, [id]);
    const d = rows[0];
    if (!d || d.is_archived) return { desired: [], why: 'The deal was removed' };
    if (d.pipeline_category === 'APPLICATIONS') return { desired: [], why: 'An application: its own rules apply' };
    if (d.status === 'WON') return { desired: [], why: 'Deal won' };
    if (d.status === 'LOST') return { desired: [], why: 'Deal lost' };
    if (!d.owner_user_id) return { desired: [], why: 'Nobody owns the deal' };
    const who = d.owner_user_id;
    const desired = [];
    if (d.status === 'ACTIVE' && d.stage_kind === 'open' && d.next_step && d.next_step_due && !d.task_open) {
      desired.push({ recipientId: who, ruleKey: 'DEAL_NEXT_STEP', occurrenceKey: `next:${dayOf(d.next_step_due)}`, date: dayOf(d.next_step_due), facts: {} });
    }
    if (d.status === 'ACTIVE' && d.waiting_on && d.waiting_until) {
      desired.push({ recipientId: who, ruleKey: 'DEAL_WAITING_UNTIL', occurrenceKey: `wait:${dayOf(d.waiting_until)}`, date: dayOf(d.waiting_until), facts: {} });
    }
    if (['ON_HOLD', 'NURTURE'].includes(d.status) && d.revisit_on) {
      desired.push({ recipientId: who, ruleKey: 'DEAL_REVISIT', occurrenceKey: `revisit:${dayOf(d.revisit_on)}`, date: dayOf(d.revisit_on), facts: {} });
    }
    // a CSR / NGO proposal deadline is a date-only deadline: the same rule as applications
    if (d.pipeline_category === 'CSR_NGO' && d.status === 'ACTIVE' && d.proposal_deadline) {
      const { rows: sentRows } = await runner.query(`SELECT 1 FROM opportunity_proposals WHERE opportunity_id = $1 AND status <> 'WITHDRAWN' LIMIT 1`, [id]);
      if (!sentRows.length) {
        const tz = await personTz(runner, who);
        const date = dayOf(d.proposal_deadline);
        desired.push({ recipientId: who, ruleKey: 'APPLICATION_DEADLINE', occurrenceKey: `proposal:${date}`, date: addDays(date, -3), until: endOfDay(date, tz), facts: { deadline: { date }, label: 'Proposal' } });
      }
    }
    return { desired, why: 'The date changed, or the deal moved on' };
  },
  async sweep(runner, { forUser = null } = {}) {
    const { rows } = await runner.query(
      `SELECT o.id FROM opportunities o LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id
        WHERE o.is_archived = FALSE AND o.status IN ('ACTIVE', 'ON_HOLD', 'NURTURE') AND COALESCE(p.category, '') <> 'APPLICATIONS'
          AND (o.next_step_due IS NOT NULL OR o.waiting_until IS NOT NULL OR o.revisit_on IS NOT NULL OR o.proposal_deadline IS NOT NULL)
          AND ($1::int IS NULL OR o.owner_user_id = $1)`, [forUser],
    );
    return rows.map((r) => r.id);
  },
  async words(runner, o, { tz, label, now }) {
    const { rows } = await runner.query(`${DEAL_FOR_PLAN} WHERE o.id = $1`, [o.entity_id]);
    const d = rows[0];
    const name = label?.label || d.name;
    const why = 'You own this deal';
    if (o.rule_key === 'DEAL_WAITING_UNTIL') return { title: `Check in with ${d.waiting_on}: ${name}`, body: `You were waiting for: ${d.waiting_reason || 'their next move'}, expected by ${dayOf(d.waiting_until)}.`, why };
    if (o.rule_key === 'DEAL_REVISIT') return { title: `Revisit: ${name}`, body: `The deal is ${d.status === 'ON_HOLD' ? 'on hold' : 'in nurture'}; its revisit date is ${dayOf(d.revisit_on)}.`, why };
    if (o.rule_key === 'APPLICATION_DEADLINE') {
      const w = deadlineWords({ date: o.facts.deadline.date, dateOnly: true }, tz, now);
      return { title: `${w.text.split(' · ').pop()} to send the proposal: ${name}`, body: `Proposal deadline: ${w.text}\nNo proposal is recorded as sent yet.`, why };
    }
    return { title: `Next action due: ${d.next_step}`, body: `${name}\nDue ${dayOf(d.next_step_due)}.`, why };
  },
});
