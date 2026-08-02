import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from './pool.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../lib/password.js';
import { reportStartupFailure } from '../lib/dbErrors.js';

const DEPARTMENTS = [
  ['MKT', 'Marketing', '#ec4899', 'Campaigns, branding, collateral, events'],
  ['SLS', 'Sales', '#f59e0b', 'Pipeline, quotations, dealer and channel work'],
  ['AGR', 'Agronomy', '#22c55e', 'Field trials, crop protocols, agronomy research'],
  ['ADV', 'Agronomy Advisory', '#16a34a', 'Farmer advisories, crop calendars, field queries'],
  ['CS', 'Customer Support', '#06b6d4', 'Tickets, escalations, installation and service'],
  ['CQ', 'Customer Query', '#0ea5e9', 'Inbound product and order queries'],
  ['SM', 'Social Media', '#8b5cf6', 'Channel calendar, community, paid social'],
  ['CNT', 'Content Creation', '#a855f7', 'Copy, video, photography, design'],
  ['SW', 'Software Application', '#3b82f6', 'Web and mobile application improvements'],
  ['FTR', 'Product Features', '#6366f1', 'Feature definition and enhancements'],
  ['EMB', 'Embedded Software', '#14b8a6', 'Firmware development and enhancements'],
  ['ELE', 'Electronics Product', '#0d9488', 'Hardware design, testing, certification'],
  ['PRC', 'Procurement', '#f97316', 'Vendors, purchase orders, inbound logistics'],
  ['FND', 'Funding & Grants', '#eab308', 'Grant and funding applications, investor material'],
  ['FIN', 'Finance & Accounts', '#64748b', 'Books, accounts, compliance, payables'],
  ['OPS', 'Operations & Admin', '#475569', 'General day to day operations'],
];

const STATUSES = [
  ['Backlog', 'backlog', '#94a3b8', false],
  ['To Do', 'todo', '#3b82f6', true],
  ['In Progress', 'in_progress', '#f59e0b', false],
  ['Blocked', 'blocked', '#ef4444', false],
  ['In Review', 'review', '#8b5cf6', false],
  ['Done', 'done', '#22c55e', false],
];

const RULES = [
  {
    name: 'Missed deadline',
    description: 'One black mark when a task passes its due date without being completed.',
    trigger_type: 'deadline_missed',
    points: 1,
    grace_hours: 24,
    priorities: [],
    severity: 'normal',
  },
  {
    name: 'Missed deadline on a critical task',
    description: 'Critical and high priority work carries a heavier penalty.',
    trigger_type: 'deadline_missed',
    points: 2,
    grace_hours: 4,
    priorities: ['critical', 'high'],
    severity: 'high',
  },
  {
    name: 'Still overdue — weekly escalation',
    description: 'Adds a further point for every 7 days a task stays overdue, capped at 3.',
    trigger_type: 'overdue_escalation',
    points: 1,
    grace_hours: 24,
    repeat_every_days: 7,
    max_points_per_task: 3,
    priorities: [],
    severity: 'normal',
  },
  {
    name: 'Delivered late',
    description: 'Half a point when work is finished after the deadline but still delivered.',
    trigger_type: 'completed_late',
    points: 0.5,
    grace_hours: 24,
    priorities: [],
    severity: 'low',
  },
  {
    name: 'Reopened after being marked done',
    description: 'Work marked complete that had to be reopened.',
    trigger_type: 'task_reopened',
    points: 0.5,
    grace_hours: 0,
    priorities: [],
    severity: 'low',
  },
];

async function seedDepartments() {
  for (const [index, [key, name, color, description]] of DEPARTMENTS.entries()) {
    await query(
      `INSERT INTO departments (key, name, color, description, position)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color`,
      [key, name, color, description, index + 1],
    );
  }
  console.log(`[seed] ${DEPARTMENTS.length} departments`);
}

async function seedStatuses() {
  for (const [index, [name, stage, color, isDefault]] of STATUSES.entries()) {
    await query(
      `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color`,
      [name, name.toLowerCase().replace(/\s+/g, '-'), stage, color, index + 1, isDefault],
    );
  }
  console.log(`[seed] ${STATUSES.length} workflow statuses`);
}

async function seedRules() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM blackmark_rules');
  if (rows[0].n > 0) {
    console.log('[seed] black mark rules already present, skipping');
    return;
  }
  for (const rule of RULES) {
    await query(
      `INSERT INTO blackmark_rules
         (name, description, trigger_type, points, grace_hours, priorities, department_ids,
          repeat_every_days, max_points_per_task, severity)
       VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8,$9)`,
      [
        rule.name,
        rule.description,
        rule.trigger_type,
        rule.points,
        rule.grace_hours,
        rule.priorities,
        rule.repeat_every_days ?? null,
        rule.max_points_per_task ?? null,
        rule.severity,
      ],
    );
  }
  console.log(`[seed] ${RULES.length} black mark rules`);
}

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@ekosight.com';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

  const { rows } = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (rows[0]) {
    console.log(`[seed] admin ${email} already exists`);
    return rows[0].id;
  }

  const { rows: created } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, job_title, must_change_password, avatar_color)
     VALUES ($1,$2,$3,'admin','Administrator',TRUE,'#0f172a') RETURNING id`,
    ['Administrator', email, await hashPassword(password)],
  );
  console.log(`[seed] admin created — ${email} / ${password} (change it on first sign in)`);
  return created[0].id;
}

async function seedDemoData() {
  if (process.env.SEED_DEMO !== 'true') return;

  const { rows: existing } = await query(`SELECT COUNT(*)::int AS n FROM tasks`);
  if (existing[0].n > 0) {
    console.log('[seed] tasks already exist, skipping demo data');
    return;
  }

  const people = [
    ['Priya Nair', 'priya@ekosight.com', 'manager', 'MKT', 'Marketing Lead', '#ec4899'],
    ['Arun Kumar', 'arun@ekosight.com', 'member', 'SLS', 'Sales Executive', '#f59e0b'],
    ['Meera Joshi', 'meera@ekosight.com', 'member', 'AGR', 'Agronomist', '#22c55e'],
    ['Rahul Verma', 'rahul@ekosight.com', 'member', 'SW', 'Full Stack Developer', '#3b82f6'],
    ['Sana Sheikh', 'sana@ekosight.com', 'member', 'EMB', 'Firmware Engineer', '#14b8a6'],
    ['Vikram Rao', 'vikram@ekosight.com', 'manager', 'FIN', 'Finance Manager', '#64748b'],
  ];

  const password = await hashPassword('Welcome123!');
  const userIds = {};
  for (const [name, email, role, deptKey, title, color] of people) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, job_title, avatar_color, last_activity_at)
       VALUES ($1,$2,$3,$4,(SELECT id FROM departments WHERE key = $5),$6,$7, now() - (random() * interval '6 days'))
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [name, email, password, role, deptKey, title, color],
    );
    if (rows[0]) userIds[email] = rows[0].id;
  }

  const demoTasks = [
    ['MKT', 'Kharif campaign creative set', 'Design the full creative set for the Kharif push.', 'high', 'campaign', 'priya@ekosight.com', -2, 'in-progress'],
    ['MKT', 'Update dealer brochure', 'Refresh pricing and product photos.', 'medium', 'content', 'priya@ekosight.com', 6, 'to-do'],
    ['SLS', 'Follow up 12 Nashik dealer leads', 'Call and log outcomes in CRM.', 'high', 'task', 'arun@ekosight.com', -5, 'in-progress'],
    ['SLS', 'Quotation for Pune cooperative', 'Prepare and send the 40-unit quotation.', 'critical', 'task', 'arun@ekosight.com', 1, 'to-do'],
    ['AGR', 'Grape trial week 6 readings', 'Record trial plot readings and upload.', 'medium', 'advisory', 'meera@ekosight.com', 3, 'to-do'],
    ['ADV', 'Draft February advisory calendar', 'Crop advisory calendar for all zones.', 'medium', 'advisory', 'meera@ekosight.com', -1, 'in-progress'],
    ['SW', 'Fix report export timeout', 'Large exports time out beyond 10k rows.', 'critical', 'bug', 'rahul@ekosight.com', -3, 'in-progress'],
    ['SW', 'Add role based access to dashboard', 'Restrict finance widgets by role.', 'high', 'feature', 'rahul@ekosight.com', 8, 'to-do'],
    ['EMB', 'Sensor node power optimisation', 'Bring idle draw under 8 mA.', 'high', 'enhancement', 'sana@ekosight.com', 12, 'to-do'],
    ['ELE', 'PCB rev C bring-up', 'Assemble and test the rev C boards.', 'medium', 'task', 'sana@ekosight.com', 15, 'backlog'],
    ['PRC', 'Raise PO for enclosure batch', '500 units, compare three vendors.', 'medium', 'procurement', 'vikram@ekosight.com', 4, 'to-do'],
    ['FIN', 'Close December books', 'Reconcile and close the December ledger.', 'critical', 'compliance', 'vikram@ekosight.com', -7, 'in-progress'],
    ['FND', 'RKVY grant application draft', 'Complete sections 3 to 7.', 'high', 'task', 'vikram@ekosight.com', 20, 'backlog'],
    ['CS', 'Escalation: unit offline at Baramati', 'Customer reports repeated dropouts.', 'critical', 'customer-query', 'sana@ekosight.com', 0, 'in-progress'],
    ['SM', 'Weekly social calendar', 'Schedule posts across all channels.', 'low', 'content', 'priya@ekosight.com', 2, 'done'],
    ['CNT', 'Farmer testimonial video edit', 'Cut the 90 second version.', 'medium', 'content', 'priya@ekosight.com', -4, 'to-do'],
  ];

  for (const [deptKey, title, description, priority, type, assigneeEmail, dueOffsetDays, statusSlug] of demoTasks) {
    const assigneeId = userIds[assigneeEmail] ?? null;
    await query(
      `INSERT INTO tasks (ref, title, description, department_id, status_id, priority, task_type,
                          assignee_id, reporter_id, created_by, due_date, original_due_date, estimate_hours, position)
       SELECT d.key || '-' || (SELECT COUNT(*) + 1 FROM tasks t2 WHERE t2.department_id = d.id),
              $2, $3, d.id, s.id, $4, $5, $6, $6, $6,
              now() + ($7 || ' days')::interval, now() + ($7 || ' days')::interval,
              (3 + random() * 12)::numeric(7,2),
              (SELECT COALESCE(MAX(position), 0) + 100 FROM tasks t3 WHERE t3.status_id = s.id)
         FROM departments d, workflow_statuses s
        WHERE d.key = $1 AND s.slug = $8`,
      [deptKey, title, description, priority, type, assigneeId, dueOffsetDays, statusSlug],
    );
  }

  await query(
    `UPDATE tasks SET completed_at = now() - interval '1 day', progress = 100
      WHERE status_id = (SELECT id FROM workflow_statuses WHERE slug = 'done')`,
  );

  console.log(`[seed] demo team (password Welcome123!) and ${demoTasks.length} demo tasks`);
}

async function main() {
  await runMigrations({ verbose: false });
  await seedDepartments();
  await seedStatuses();
  await seedRules();
  await seedAdmin();
  await seedDemoData();
  console.log('[seed] done');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main()
    .then(() => closePool())
    .catch(async (err) => {
      reportStartupFailure('seed', err);
      await closePool();
      process.exit(1);
    });
}

export { main as seed };
