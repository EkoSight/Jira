/**
 * Data quality: what in the pipeline cannot be trusted as it stands, and who
 * can put it right.
 *
 * Every check reads the record as it is and lists the exact deals, organizations
 * or tasks behind its count. Nothing here changes data: a check says what is
 * missing or inconsistent, and the person who owns it fixes it on the deal.
 * Organizations that look alike are flagged, never merged — merging is a
 * judgement, and an irreversible one.
 */

import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { OPPORTUNITY_SELECT, decorateOpportunity, eligibleValue } from './opportunities.js';
import { STAGE_RULES, evidenceFor, nextActionGaps, ruleHolds, today } from './dealRules.js';
import { WEBMAIL, domainOf, ownDomains } from './correspondence.js';

const LIVE = ['ACTIVE', 'ON_HOLD', 'NURTURE'];
// the stage rules that need something on the record; the rest have checks of their own
const EVIDENCE_RULES = ['proposal', 'order', 'meeting_completed'];
const ITEM_LIMIT = 150;

export const DQ_CHECKS = [
  {
    key: 'no_owner', severity: 'critical',
    label: 'Deals nobody is accountable for',
    why: 'With no owner, nobody is reminded and nobody answers for the deal.',
    fix: 'Open the deal and name its owner.',
  },
  {
    key: 'org_no_owner', severity: 'warning',
    label: 'Organizations nobody leads',
    why: 'The relationship has no lead, so nothing about it lands with anyone.',
    fix: 'Edit the organization and name who leads it.',
  },
  {
    key: 'no_next_action', severity: 'critical',
    label: 'Live deals without a complete next action',
    why: 'Every live deal owes a specific action, one person and a date — or it has stalled without anyone saying so.',
    fix: 'Set what happens next, who owes it and by when.',
  },
  {
    key: 'no_value', severity: 'warning',
    label: 'Live deals with no value',
    why: 'They add nothing to the pipeline total, and nobody has said the value is unknown.',
    fix: 'Record an estimate, or mark the value as not yet known.',
  },
  {
    key: 'no_close_date', severity: 'warning',
    label: 'Deals far along with no expected close date',
    why: 'Past the early stages, a deal with no date cannot be forecast.',
    fix: 'Set when you expect it to be decided.',
  },
  {
    key: 'close_date_passed', severity: 'warning',
    label: 'Live deals past their expected close date',
    why: 'The date has gone by and the deal is still open: the forecast is wrong until the date is moved honestly.',
    fix: 'Move the close date, with the reason, or close the deal.',
  },
  {
    key: 'no_contact', severity: 'warning',
    label: 'Live deals with nobody named at the organization',
    why: 'Without a named person, there is nobody to follow up with and no way to tell who decides.',
    fix: 'Add the person you deal with on the organization’s People tab.',
  },
  {
    key: 'stage_unsupported', severity: 'critical',
    label: 'Stages the record does not support',
    why: 'The stage claims something the record does not show — a deal in Proposal with no proposal, a Won deal with no accepted order.',
    fix: 'Record the proposal, order or meeting — or move the deal to the stage it is really in.',
  },
  {
    key: 'stage_misplaced', severity: 'critical',
    label: 'Status and stage disagree',
    why: 'A live deal sitting in a closed stage (or none), or a won or lost deal still in an open stage.',
    fix: 'Move the deal to the stage that matches where it stands.',
  },
  {
    key: 'paused_no_revisit', severity: 'warning',
    label: 'Paused deals with no date to look again',
    why: 'On hold or in nurture with no date, a deal is forgotten rather than paused.',
    fix: 'Give it a date to look again, with the reason.',
  },
  {
    key: 'duplicate_orgs', severity: 'warning',
    label: 'Organizations that may be the same',
    why: 'Two records for one organization split its deals, contacts and history in two.',
    fix: 'Check them. If they are different, say so; if they are the same, move the deals onto one and archive the other.',
  },
  {
    key: 'task_no_evidence', severity: 'warning',
    label: 'Finished deal tasks with no outcome or evidence',
    why: 'A task marked done with no outcome, or with no link to what it produced, cannot be checked.',
    fix: 'Open the task and record what came of it, with a link.',
  },
];

const CHECK_META = Object.fromEntries(DQ_CHECKS.map((c) => [c.key, c]));

// ---------------------------------------------------------------- duplicates

const SUFFIXES = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation',
  'the', 'and', 'india', 'opc', 'plc', 'llc', 'gmbh', 'pte',
]);

/** A name reduced to what identifies it: "FarMart Agri Pvt. Ltd." → "farmart agri". */
export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !SUFFIXES.has(word))
    .join(' ')
    .trim();
}

/** The host a website points at, without www: "https://www.farmart.co/about" → "farmart.co". */
export function websiteDomain(url) {
  const text = String(url || '').trim().toLowerCase();
  if (!text) return '';
  const host = text.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  return host.replace(/^www\./, '');
}

/** The last ten digits of a phone number, enough to compare Indian numbers written any way. */
export function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-10) : '';
}

/** Edit distance, stopping early once it exceeds `limit`. */
function distanceWithin(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

/** Whether two normalized names are close enough to be worth a look. */
export function namesAlike(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const compactA = a.replace(/\s/g, '');
  const compactB = b.replace(/\s/g, '');
  if (compactA === compactB) return true;
  // short names must match exactly: "Agro Tech" and "Agri Tech" are two firms
  const shorter = Math.min(compactA.length, compactB.length);
  if (shorter < 10) return false;
  return distanceWithin(compactA, compactB, shorter >= 16 ? 2 : 1);
}

/**
 * Clusters of organizations that may be one: alike names, the same website, a
 * shared company email domain, or the same phone number. Pairs somebody has
 * already checked and called different are left apart.
 */
export async function duplicateClusters({ departmentId = null } = {}) {
  const [{ rows: accounts }, { rows: contacts }, { rows: dismissed }, own] = await Promise.all([
    query(
      `SELECT a.id, a.name, a.type, a.website, a.contact_email, a.contact_phone, a.department_id,
              a.owner_user_id, u.full_name AS owner_name,
              (SELECT COUNT(*)::int FROM opportunities o
                WHERE o.account_id = a.id AND o.is_archived = FALSE) AS deals
         FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id
        WHERE a.is_archived = FALSE`,
    ),
    query(
      `SELECT c.account_id, LOWER(c.email) AS email, c.phone FROM account_contacts c
         JOIN accounts a ON a.id = c.account_id
        WHERE c.is_active = TRUE AND a.is_archived = FALSE`,
    ),
    query('SELECT account_a, account_b FROM crm_duplicate_dismissals'),
    ownDomains(),
  ]);

  const notSame = new Set(dismissed.map((d) => `${d.account_a}:${d.account_b}`));
  const pairKey = (x, y) => (x < y ? `${x}:${y}` : `${y}:${x}`);
  const reasons = new Map();
  const link = (x, y, why) => {
    if (x === y || notSame.has(pairKey(x, y))) return;
    const key = pairKey(x, y);
    const list = reasons.get(key) || new Set();
    list.add(why);
    reasons.set(key, list);
  };

  // shared identifiers: the same website, company email domain or phone
  const byKey = new Map();
  const index = (kind, value, accountId) => {
    if (!value) return;
    const key = `${kind}:${value}`;
    const set = byKey.get(key) || new Set();
    set.add(accountId);
    byKey.set(key, set);
  };
  const companyDomain = (email) => {
    const domain = domainOf(email || '');
    return domain && !WEBMAIL.has(domain) && !own.has(domain) ? domain : '';
  };
  for (const a of accounts) {
    index('website', websiteDomain(a.website), a.id);
    index('email domain', companyDomain(a.contact_email), a.id);
    index('phone', phoneKey(a.contact_phone), a.id);
  }
  for (const c of contacts) {
    index('email domain', companyDomain(c.email), c.account_id);
    index('phone', phoneKey(c.phone), c.account_id);
  }
  for (const [key, ids] of byKey) {
    if (ids.size < 2 || ids.size > 6) continue; // a value shared that widely is not an identity
    const [kind, value] = key.split(/:(.*)/s);
    const list = [...ids];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) link(list[i], list[j], `same ${kind} (${value})`);
    }
  }

  // alike names
  const named = accounts.map((a) => ({ id: a.id, norm: normalizeName(a.name) })).filter((a) => a.norm);
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      if (namesAlike(named[i].norm, named[j].norm)) {
        link(named[i].id, named[j].id, named[i].norm === named[j].norm ? 'same name' : 'very similar name');
      }
    }
  }

  // join the pairs into clusters
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== undefined && parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  for (const key of reasons.keys()) {
    const [x, y] = key.split(':').map(Number);
    if (!parent.has(x)) parent.set(x, x);
    if (!parent.has(y)) parent.set(y, y);
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(ry, rx);
  }
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    const list = groups.get(root) || [];
    list.push(id);
    groups.set(root, list);
  }
  const clusters = [];
  for (const ids of groups.values()) {
    const members = ids.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => a.id - b.id);
    if (departmentId && !members.some((m) => m.department_id === Number(departmentId))) continue;
    const why = new Set();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        for (const reason of reasons.get(pairKey(members[i].id, members[j].id)) || []) why.add(reason);
      }
    }
    clusters.push({
      accounts: members.map((m) => ({
        id: m.id, name: m.name, type: m.type, owner_name: m.owner_name, deals: m.deals,
      })),
      reasons: [...why],
    });
  }
  return clusters.sort((a, b) => a.accounts[0].name.localeCompare(b.accounts[0].name));
}

/** Records that two organizations were checked and are different. */
export async function dismissDuplicate({ accountIds, reason, actor }) {
  const [a, b] = [...new Set(accountIds.map(Number))].sort((x, y) => x - y);
  if (!a || !b) throw badRequest('Name the two organizations that are different');
  const text = String(reason || '').trim();
  if (text.length < 5) throw badRequest('Say how you know they are different organizations');
  const { rows } = await query('SELECT id, name FROM accounts WHERE id = ANY($1::int[])', [[a, b]]);
  if (rows.length !== 2) throw badRequest('Both organizations must exist');
  await query(
    `INSERT INTO crm_duplicate_dismissals (account_a, account_b, reason, dismissed_by)
     VALUES ($1, $2, $3, $4) ON CONFLICT (account_a, account_b) DO NOTHING`,
    [a, b, text, actor.id],
  );
  await query(
    `INSERT INTO crm_audit_events (action, entity_type, entity_id, summary, detail, reason, actor_id)
     VALUES ('duplicate_dismissed', 'ACCOUNT', $1, $2, $3, $4, $5)`,
    [a, `${rows.map((r) => r.name).join(' and ')} are different organizations`, JSON.stringify({ account_ids: [a, b] }), text, actor.id],
  );
  return { account_ids: [a, b] };
}

// ---------------------------------------------------------------- the checks

const dealItem = (deal, detail) => ({
  entity_type: 'OPPORTUNITY',
  entity_id: deal.id,
  account_id: deal.account_id,
  opportunity_id: deal.id,
  title: deal.name,
  subtitle: deal.account_name,
  stage_name: deal.stage_name,
  detail,
  owner_user_id: deal.owner_user_id ?? deal.relationship_owner_id ?? null,
  owner_name: deal.owner_name ?? deal.relationship_owner_name ?? null,
});

const GAP_WORDS = {
  no_next_action: 'no next action',
  no_next_action_owner: 'nobody owes it',
  no_next_action_due: 'no date',
  next_action_overdue: 'overdue',
};

/**
 * The data-quality report. `ownerId` keeps it to what one person can fix
 * (deals they own or owe the next move on, organizations they lead, tasks
 * assigned to them); `departmentId` to a department. `taskDays` is how far back
 * finished tasks are checked.
 */
export async function dataQuality({ departmentId = null, ownerId = null, taskDays = 90 } = {}) {
  const todayDate = today();
  const params = [];
  const where = ['o.is_archived = FALSE', 'a.is_archived = FALSE'];
  if (departmentId) {
    params.push(Number(departmentId));
    where.push(`a.department_id = $${params.length}`);
  }
  if (ownerId) {
    params.push(Number(ownerId));
    where.push(`(o.owner_user_id = $${params.length} OR o.next_step_owner_id = $${params.length}
                 OR (o.owner_user_id IS NULL AND a.owner_user_id = $${params.length}))`);
  }
  const [{ rows: dealRows }, { rows: stageRows }, { rows: contactRows }] = await Promise.all([
    query(`${OPPORTUNITY_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.name, o.name LIMIT 3000`, params),
    query('SELECT id, name, kind, position, entry_rules FROM account_stages'),
    query('SELECT DISTINCT account_id FROM account_contacts WHERE is_active = TRUE'),
  ]);
  // organizations with at least one person named; linking them to each deal is
  // good practice, but an organization with nobody at all is the gap
  const hasPeople = new Set(contactRows.map((r) => r.account_id));
  const deals = dealRows.map((row) => decorateOpportunity(row));
  const stages = new Map(stageRows.map((s) => [s.id, s]));
  const evidence = await evidenceFor(deals.filter((d) => d.status === 'ACTIVE' || d.status === 'WON').map((d) => d.id));

  const found = Object.fromEntries(DQ_CHECKS.map((c) => [c.key, []]));
  const dealsWithIssues = new Set();
  const flag = (key, item) => {
    found[key].push(item);
    if (item.entity_type === 'OPPORTUNITY') dealsWithIssues.add(item.entity_id);
  };

  for (const deal of deals) {
    const live = LIVE.includes(deal.status);
    const active = deal.status === 'ACTIVE';
    const openStage = deal.stage_kind === 'open';

    if (live && !deal.owner_user_id) flag('no_owner', dealItem(deal, 'nobody is named as accountable'));

    if (active && openStage) {
      const gaps = nextActionGaps(deal, { todayDate });
      if (gaps.length) {
        flag('no_next_action', dealItem(deal, gaps.map((g) => GAP_WORDS[g.kind] || g.label).join(', ')));
      }
      if (eligibleValue(deal).basis === 'none') flag('no_value', dealItem(deal, 'no estimate, proposal or agreed amount'));
      if (!deal.expected_close && (deal.stage_position ?? 0) >= 4) {
        flag('no_close_date', dealItem(deal, `in ${deal.stage_name}, with no date`));
      }
      if (deal.expected_close && String(deal.expected_close).slice(0, 10) < todayDate) {
        flag('close_date_passed', dealItem(deal, `was expected to close on ${String(deal.expected_close).slice(0, 10)}`));
      }
      if (!deal.contact_count && !hasPeople.has(deal.account_id)) {
        flag('no_contact', dealItem(deal, 'no contact recorded at the organization'));
      }
    }

    // the stage's own evidence: what it says should already be on record
    const stage = stages.get(deal.stage_id);
    if ((active && openStage) || (deal.status === 'WON' && deal.stage_kind === 'won')) {
      const rules = (stage?.entry_rules || []).filter((r) => EVIDENCE_RULES.includes(r));
      const missing = rules.filter((rule) => !ruleHolds(rule, deal, evidence.get(deal.id) || {}));
      if (missing.length) {
        const words = (rule) => {
          const label = STAGE_RULES[rule]?.label || rule;
          return label.charAt(0).toLowerCase() + label.slice(1);
        };
        flag('stage_unsupported', dealItem(deal, `in ${deal.stage_name} without ${missing.map(words).join(' or ')}`));
      }
    }

    if (active && !openStage) {
      flag('stage_misplaced', dealItem(deal, deal.stage_id ? `live, but in the closed stage ${deal.stage_name}` : 'live, but in no stage'));
    }
    if (deal.status === 'WON' && deal.stage_kind !== 'won') {
      flag('stage_misplaced', dealItem(deal, `won, but in ${deal.stage_name || 'no stage'}`));
    }
    if (deal.status === 'LOST' && deal.stage_kind !== 'lost') {
      flag('stage_misplaced', dealItem(deal, `lost, but in ${deal.stage_name || 'no stage'}`));
    }

    if ((deal.status === 'ON_HOLD' || deal.status === 'NURTURE') && !deal.revisit_on) {
      flag('paused_no_revisit', dealItem(deal, `${deal.status === 'NURTURE' ? 'in nurture' : 'on hold'} with no date`));
    }
  }

  // organizations nobody leads, among those with live work
  const orgParams = [];
  const orgWhere = ['a.is_archived = FALSE', 'a.owner_user_id IS NULL'];
  if (departmentId) {
    orgParams.push(Number(departmentId));
    orgWhere.push(`a.department_id = $${orgParams.length}`);
  }
  if (!ownerId) {
    const { rows: orgs } = await query(
      `SELECT a.id, a.name, a.type FROM accounts a
        WHERE ${orgWhere.join(' AND ')}
          AND (a.type = 'LEAD' OR EXISTS (SELECT 1 FROM opportunities o
                WHERE o.account_id = a.id AND o.is_archived = FALSE
                  AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')))
        ORDER BY a.name`,
      orgParams,
    );
    for (const org of orgs) {
      flag('org_no_owner', {
        entity_type: 'ACCOUNT', entity_id: org.id, account_id: org.id, opportunity_id: null,
        title: org.name, subtitle: org.type === 'LEAD' ? 'Lead' : org.type === 'CUSTOMER' ? 'Customer' : 'Partner',
        detail: 'nobody leads the relationship', owner_user_id: null, owner_name: null,
      });
    }
  }

  // finished deal work with no outcome, or no evidence of it
  const taskParams = [Number(taskDays) || 90];
  const taskWhere = [
    't.is_archived = FALSE', "ws.stage = 'done'",
    '(t.account_id IS NOT NULL OR t.opportunity_id IS NOT NULL)',
    "t.completed_at >= now() - ($1 || ' days')::interval",
    "(t.outcome_status IS NULL OR (t.outcome_status = 'ACHIEVED' AND NULLIF(TRIM(t.outcome_evidence_url), '') IS NULL))",
  ];
  if (departmentId) {
    taskParams.push(Number(departmentId));
    taskWhere.push(`COALESCE(a.department_id, t.department_id) = $${taskParams.length}`);
  }
  if (ownerId) {
    taskParams.push(Number(ownerId));
    taskWhere.push(`t.assignee_id = $${taskParams.length}`);
  }
  const { rows: tasks } = await query(
    `SELECT t.id, t.ref, t.title, t.completed_at, t.outcome_status, t.assignee_id,
            COALESCE(t.account_id, o.account_id) AS account_id, t.opportunity_id,
            a.name AS account_name, u.full_name AS assignee_name
       FROM tasks t
       JOIN workflow_statuses ws ON ws.id = t.status_id
       LEFT JOIN opportunities o ON o.id = t.opportunity_id
       LEFT JOIN accounts a ON a.id = COALESCE(t.account_id, o.account_id)
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${taskWhere.join(' AND ')}
      ORDER BY t.completed_at DESC`,
    taskParams,
  );
  for (const task of tasks) {
    flag('task_no_evidence', {
      entity_type: 'TASK', entity_id: task.id, account_id: task.account_id, opportunity_id: task.opportunity_id,
      title: `${task.ref} ${task.title}`, subtitle: task.account_name,
      detail: task.outcome_status ? 'done, with no link to the evidence' : 'done, with no outcome recorded',
      completed_at: task.completed_at,
      owner_user_id: task.assignee_id, owner_name: task.assignee_name,
    });
  }

  // organizations that may be the same
  if (!ownerId) {
    for (const cluster of await duplicateClusters({ departmentId })) {
      flag('duplicate_orgs', {
        entity_type: 'ACCOUNT_GROUP', entity_id: cluster.accounts[0].id, account_id: cluster.accounts[0].id,
        opportunity_id: null, title: cluster.accounts.map((a) => a.name).join(' · '),
        subtitle: `${cluster.accounts.length} organizations`, detail: cluster.reasons.join('; '),
        accounts: cluster.accounts, owner_user_id: null, owner_name: null,
      });
    }
  }

  const activeDeals = deals.filter((d) => d.status === 'ACTIVE');
  const clean = activeDeals.filter((d) => !dealsWithIssues.has(d.id)).length;
  const checks = DQ_CHECKS.map((check) => ({
    ...check,
    count: found[check.key].length,
    items: found[check.key].slice(0, ITEM_LIMIT),
    truncated: found[check.key].length > ITEM_LIMIT,
  }));

  return {
    as_of: new Date().toISOString(),
    task_days: Number(taskDays) || 90,
    scope: { department_id: departmentId ? Number(departmentId) : null, owner_id: ownerId ? Number(ownerId) : null },
    summary: {
      live_deals: activeDeals.length,
      clean_deals: clean,
      clean_percent: activeDeals.length ? Math.round((clean / activeDeals.length) * 100) : null,
      issues: checks.reduce((sum, c) => sum + c.count, 0),
      checks_failing: checks.filter((c) => c.count > 0).length,
    },
    checks,
  };
}

export const dataQualityCheck = (key) => CHECK_META[key] || null;
