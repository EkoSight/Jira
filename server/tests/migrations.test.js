/**
 * Upgrade safety.
 *
 * TaskFlow is deployed and holding real data, so a release must never drop or
 * rewrite what is already there. These tests apply the migrations to a populated
 * database and assert the data is untouched.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);

let available = true;

const skipIfUnavailable = (t) => {
  if (!available) {
    t.skip('no database');
    return true;
  }
  return false;
};

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try {
    await query('SELECT 1');
  } catch {
    available = false;
    return;
  }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
});

after(async () => {
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('every migration after the first is additive only', async () => {
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length > 0);

  // 001 creates the world; everything after it must not destroy any of it
  for (const file of files.slice(1)) {
    const sql = (await fs.readFile(path.join(migrationsDir, file), 'utf8')).toUpperCase();

    for (const forbidden of ['DROP TABLE', 'DROP COLUMN', 'DROP SCHEMA', 'TRUNCATE', 'DELETE FROM']) {
      assert.ok(!sql.includes(forbidden), `${file} must not contain "${forbidden}"`);
    }
    // renaming loses data for anything still reading the old name
    assert.ok(!/ALTER TABLE \w+ RENAME/.test(sql), `${file} must not rename tables`);
    // a NOT NULL column with no default fails on a populated table
    const badNotNull = /ADD COLUMN (?!IF NOT EXISTS)[^;]*NOT NULL(?![^;]*DEFAULT)/.test(sql);
    assert.ok(!badNotNull, `${file} adds a NOT NULL column with no default, which breaks existing rows`);
  }
});

test('a check constraint redefined later still allows every value it allowed before', async () => {
  // Widening a CHECK means dropping and re-adding it. Re-adding it with a value
  // missing fails the migration on a database that already holds that value,
  // and rejects new rows of that kind afterwards.
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const allowed = new Map();
  const definition = /ADD CONSTRAINT (\w+)\s+CHECK \((\w+) IN \(([^)]*)\)\)/g;
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    for (const [, name, column, list] of sql.matchAll(definition)) {
      const values = new Set([...list.matchAll(/'([^']*)'/g)].map((m) => m[1]));
      const before = allowed.get(name);
      if (before) {
        const lost = [...before.values].filter((v) => !values.has(v));
        assert.deepEqual(lost, [], `${file} redefines ${name} (${column}) without ${lost.join(', ')}, which ${before.file} allowed`);
      }
      allowed.set(name, { values, file });
    }
  }
  assert.ok(allowed.size > 0);
});

test('running the migrations on a populated database preserves every row', async (t) => {
  if (skipIfUnavailable(t)) return;

  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  // Apply only the first migration, then fill the database as a live site would be.
  await query(`CREATE SCHEMA IF NOT EXISTS "${config.db.schema}"`);
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const first = await fs.readFile(path.join(migrationsDir, files[0]), 'utf8');
  await query(first);
  await query('INSERT INTO schema_migrations (name) VALUES ($1)', [files[0]]);

  await query(
    `INSERT INTO departments (key, name, position) VALUES ('LIV', 'Live Department', 1)`,
  );
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, position, is_default)
     VALUES ('To Do', 'to-do', 'todo', 1, TRUE), ('Done', 'done', 'done', 2, FALSE)`,
  );
  await query(
    `INSERT INTO users (full_name, email, password_hash, role, must_change_password)
     VALUES ('Live Admin', 'live@test.local', $1, 'admin', FALSE)`,
    [await hashPassword('Password123!')],
  );

  const { rows: seed } = await query(`
    SELECT (SELECT id FROM departments WHERE key = 'LIV') AS dept,
           (SELECT id FROM workflow_statuses WHERE slug = 'to-do') AS status,
           (SELECT id FROM users WHERE email = 'live@test.local') AS usr
  `);
  const { dept, status, usr } = seed[0];

  for (let index = 1; index <= 12; index += 1) {
    await query(
      `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, priority, progress, tags)
       VALUES ($1, $2, $3, $4, $5, $5, 'high', $6, ARRAY['live'])`,
      [`LIV-${index}`, `Real task ${index}`, dept, status, usr, index * 5],
    );
  }
  await query(
    `INSERT INTO task_comments (task_id, author_id, body)
     SELECT id, $1, 'A real comment' FROM tasks`,
    [usr],
  );
  await query(
    `INSERT INTO black_marks (user_id, points, reason, period_month, occurrence_key)
     VALUES ($1, 2, 'A real black mark', date_trunc('month', now())::date, 'live-1')`,
    [usr],
  );
  await query(`INSERT INTO settings (key, value) VALUES ('blackmarks', '{"missedDeadlineLimit": 5}'::jsonb)`);

  const snapshot = async () => {
    const { rows } = await query(`
      SELECT (SELECT COUNT(*)::int FROM tasks)          AS tasks,
             (SELECT COUNT(*)::int FROM users)          AS users,
             (SELECT COUNT(*)::int FROM task_comments)  AS comments,
             (SELECT COUNT(*)::int FROM black_marks)    AS marks,
             (SELECT COUNT(*)::int FROM departments)    AS departments,
             (SELECT md5(string_agg(ref || title || priority || progress::text, '|' ORDER BY id))
                FROM tasks)                             AS task_fingerprint,
             (SELECT value->>'missedDeadlineLimit' FROM settings WHERE key = 'blackmarks') AS setting
    `);
    return rows[0];
  };

  const before = await snapshot();
  assert.equal(before.tasks, 12);

  // now upgrade, exactly as a deploy would
  const applied = await runMigrations({ verbose: false });
  assert.ok(applied >= 1, 'the later migrations actually ran');

  const after = await snapshot();
  assert.deepEqual(after, before, 'nothing changed for the existing data');

  // and a second run is a no-op
  assert.equal(await runMigrations({ verbose: false }), 0);
  assert.deepEqual(await snapshot(), before);
});

test('the new features work on data created before them', async (t) => {
  if (skipIfUnavailable(t)) return;

  // rows written before migration 002 must read cleanly through the new columns
  const { rows } = await query(`
    SELECT t.id, t.parent_task_id, t.follower_id,
           (SELECT COUNT(*)::int FROM task_collaborators c WHERE c.task_id = t.id) AS collaborators,
           (SELECT COUNT(*)::int FROM task_attachments a WHERE a.task_id = t.id)   AS attachments
      FROM tasks t ORDER BY t.id LIMIT 1
  `);
  assert.equal(rows[0].parent_task_id, null);
  assert.equal(rows[0].follower_id, null);
  assert.equal(rows[0].collaborators, 0);
  assert.equal(rows[0].attachments, 0);

  // and the new tables are usable straight away
  const { rows: note } = await query(
    `INSERT INTO notes (user_id, title, body)
     SELECT id, 'After upgrade', 'works' FROM users LIMIT 1 RETURNING id`,
  );
  assert.ok(note[0].id);
});

test('an existing lead keeps everything it had when it becomes an organization', async (t) => {
  if (skipIfUnavailable(t)) return;

  // The riskiest change in the B2B upgrade: `accounts` held the organization AND
  // the deal, and 011 splits them. Production is holding real leads, so this
  // builds a database at the old shape and upgrades it, exactly as a deploy does.
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const beforeSplit = files.filter((f) => f < '011');

  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await query(`CREATE SCHEMA "${config.db.schema}"`);
  await query(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  for (const file of beforeSplit) {
    await query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }

  await query(`INSERT INTO departments (key, name, position) VALUES ('CRM', 'Partnerships', 1)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, position, is_default)
     VALUES ('To Do', 'to-do', 'todo', 1, TRUE), ('Done', 'done', 'done', 2, FALSE)`,
  );
  await query(
    `INSERT INTO users (full_name, email, password_hash, role, must_change_password)
     VALUES ('Lead Owner', 'crm-owner@test.local', $1, 'manager', FALSE)`,
    [await hashPassword('Password123!')],
  );

  const { rows: seed } = await query(`
    SELECT (SELECT id FROM departments WHERE key = 'CRM') AS dept,
           (SELECT id FROM workflow_statuses WHERE slug = 'to-do') AS status,
           (SELECT id FROM users WHERE email = 'crm-owner@test.local') AS usr,
           (SELECT id FROM account_stages WHERE slug = 'proposal') AS proposal
  `);
  const { dept, status, usr, proposal } = seed[0];

  // a lead worked the old way: a stage, a value, one contact, a next step
  const { rows: leadRows } = await query(
    `INSERT INTO accounts
       (name, type, stage_id, status, owner_user_id, department_id, value, currency,
        contact_name, contact_email, contact_phone, next_step, next_step_due, created_by)
     VALUES ('Krishi Foundation', 'LEAD', $1, 'ACTIVE', $2, $3, 1250000, 'INR',
             'Meera Joshi', 'meera@krishi.example', '+91 98200 11111',
             'Send the pilot proposal', CURRENT_DATE + 3, $2)
     RETURNING id`,
    [proposal, usr, dept],
  );
  const leadId = leadRows[0].id;

  // a lost lead too, so the outcome is not quietly revived by the split
  await query(
    `INSERT INTO accounts (name, type, stage_id, status, owner_user_id, created_by)
     VALUES ('Cold Co', 'LEAD', (SELECT id FROM account_stages WHERE slug = 'lost'), 'LOST', $1, $1)`,
    [usr],
  );

  await query(
    `INSERT INTO account_activities (account_id, type, actor_id, subject, occurred_at)
     VALUES ($1, 'CALL', $2, 'Intro call', now() - interval '9 days'),
            ($1, 'PROPOSAL', $2, 'Sent the deck', now() - interval '2 days'),
            ($1, 'NOTE', $2, 'Internal note', now() - interval '1 day')`,
    [leadId, usr],
  );

  await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, account_id)
     VALUES ('CRM-1', 'Follow up on the proposal', $1, $2, $3, $3, $4)`,
    [dept, status, usr, leadId],
  );

  const before = await query(
    `SELECT COUNT(*)::int AS accounts,
            (SELECT COUNT(*)::int FROM account_activities) AS activities,
            (SELECT COUNT(*)::int FROM tasks WHERE account_id IS NOT NULL) AS linked_tasks
       FROM accounts`,
  );

  // ---- upgrade
  assert.ok(await runMigrations({ verbose: false }) >= 1, 'the split actually ran');

  const after = await query(
    `SELECT COUNT(*)::int AS accounts,
            (SELECT COUNT(*)::int FROM account_activities) AS activities,
            (SELECT COUNT(*)::int FROM tasks WHERE account_id IS NOT NULL) AS linked_tasks
       FROM accounts`,
  );
  assert.deepEqual(after.rows[0], before.rows[0], 'no lead, activity or task link was lost');

  // every lead now has exactly one opportunity carrying the deal it already held
  const { rows: opps } = await query(
    `SELECT o.*, a.primary_opportunity_id, s.slug AS stage_slug
       FROM opportunities o
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN account_stages s ON s.id = o.stage_id
      WHERE o.account_id = $1`,
    [leadId],
  );
  assert.equal(opps.length, 1, 'one opportunity, not none and not two');
  const opportunity = opps[0];
  assert.equal(opportunity.stage_slug, 'proposal', 'it kept the stage it was in');
  assert.equal(Number(opportunity.estimated_value), 1250000, 'and the value it was worth');
  assert.equal(opportunity.status, 'ACTIVE');
  assert.equal(opportunity.next_step, 'Send the pilot proposal');
  assert.equal(opportunity.primary_opportunity_id, opportunity.id, 'the lead points at it');

  // a settled lead stays settled
  const { rows: lost } = await query(
    `SELECT o.status FROM opportunities o JOIN accounts a ON a.id = o.account_id
      WHERE a.name = 'Cold Co'`,
  );
  assert.equal(lost[0].status, 'LOST', 'a lost deal is not revived by the split');

  // the one contact it had is now the first stakeholder, not a lost field
  const { rows: contacts } = await query(
    'SELECT * FROM account_contacts WHERE account_id = $1',
    [leadId],
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].full_name, 'Meera Joshi');
  assert.equal(contacts[0].email, 'meera@krishi.example');
  assert.equal(contacts[0].is_primary, true);
  // and the original columns are untouched, so a rollback still reads them
  const { rows: original } = await query('SELECT contact_name FROM accounts WHERE id = $1', [leadId]);
  assert.equal(original[0].contact_name, 'Meera Joshi');

  // history and work are attached to the deal they belonged to
  const { rows: attached } = await query(
    `SELECT (SELECT COUNT(*)::int FROM account_activities WHERE opportunity_id = $1) AS activities,
            (SELECT COUNT(*)::int FROM tasks WHERE opportunity_id = $1) AS tasks`,
    [opportunity.id],
  );
  assert.equal(attached[0].activities, 3);
  assert.equal(attached[0].tasks, 1, 'the follow-up task follows the deal');

  // the external clock ignores the internal note: the last real touch was the deck
  const { rows: clock } = await query(
    `SELECT last_external_at, (SELECT occurred_at FROM account_activities
       WHERE account_id = $1 AND type = 'PROPOSAL') AS deck_at
       FROM accounts WHERE id = $1`,
    [leadId],
  );
  assert.equal(
    new Date(clock[0].last_external_at).getTime(),
    new Date(clock[0].deck_at).getTime(),
    'an internal note does not count as having engaged them',
  );

  // running it twice must not mint a second opportunity for the same lead
  assert.equal(await runMigrations({ verbose: false }), 0);
  const { rows: again } = await query(
    'SELECT COUNT(*)::int AS n FROM opportunities WHERE account_id = $1', [leadId],
  );
  assert.equal(again[0].n, 1, 'the backfill is not repeated');
});

test('existing leads get a state only where a person already recorded one', async (t) => {
  if (skipIfUnavailable(t)) return;

  // Build the database as it was before 014, place three leads the way a live
  // site would have them, then upgrade.
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await query(`CREATE SCHEMA "${config.db.schema}"`);
  await query(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  for (const file of files.filter((f) => f < '014')) {
    await query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }

  const lead = async (name, hqAddress = null) => {
    const { rows } = await query(
      `INSERT INTO accounts (name, type, hq_address) VALUES ($1, 'LEAD', $2) RETURNING id`,
      [name, hqAddress],
    );
    return rows[0].id;
  };
  const place = (accountId, kind, state) => query(
    `INSERT INTO account_locations (account_id, kind, state) VALUES ($1, $2, $3)`,
    [accountId, kind, state],
  );

  const withHq = await lead('Has a head office');
  await place(withHq, 'HQ', 'Maharashtra');
  await place(withHq, 'OPERATING', 'Gujarat');

  const agreeing = await lead('Two sites, one state');
  await place(agreeing, 'OPERATING', 'Karnataka');
  await place(agreeing, 'SITE', 'karnataka ');

  const conflicting = await lead('Two sites, two states');
  await place(conflicting, 'OPERATING', 'Punjab');
  await place(conflicting, 'SITE', 'Haryana');

  // a state appears in the address text, but nobody recorded it as the state
  const addressOnly = await lead('Address only', '14 Mall Road, Shimla, Himachal Pradesh');

  assert.ok(await runMigrations({ verbose: false }) >= 1);

  const stateOf = async (id) =>
    (await query('SELECT state, hq_address FROM accounts WHERE id = $1', [id])).rows[0];

  assert.equal((await stateOf(withHq)).state, 'Maharashtra', 'the head office wins');
  assert.equal((await stateOf(agreeing)).state, 'Karnataka', 'locations that agree are used');
  assert.equal((await stateOf(conflicting)).state, null, 'disagreement is left for a person');
  const parsed = await stateOf(addressOnly);
  assert.equal(parsed.state, null, 'nothing is parsed out of free text');
  assert.equal(parsed.hq_address, '14 Mall Road, Shimla, Himachal Pradesh', 'and the address is untouched');

  // a thread written before blockers existed still reads, and the widened
  // constraint still refuses nonsense
  await assert.rejects(
    query(`INSERT INTO discussion_threads (entity_type, entity_id, kind) VALUES ('WIDGET', 1, 'blocker')`),
  );
});

test('time before office hours: a new policy version, never an edit, and earlier reviews keep what they decided', async (t) => {
  if (skipIfUnavailable(t)) return;

  // the database as it was before 023, holding attendance the way the live site does
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await query(`CREATE SCHEMA "${config.db.schema}"`);
  await query(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  for (const file of files.filter((f) => f < '023')) {
    await query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }

  const password = await hashPassword('Password123!');
  const person = async (name, email, role) => (await query(
    `INSERT INTO users (full_name, email, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, FALSE) RETURNING id`,
    [name, email, password, role],
  )).rows[0].id;
  const admin = await person('Live Admin', 'admin-023@test.local', 'admin');
  const nikita = await person('Nikita', 'nikita-023@test.local', 'member');

  const office = {
    timezone: 'Asia/Kolkata', officeStart: '09:00', officeEnd: '18:00', graceMinutes: 20,
    graceMode: 'THRESHOLD', extraRequiresReview: true, startDate: '2026-09-01',
    payroll: { method: 'SCHEDULED_HOURS', methodConfirmed: true },
  };
  const version = async (effectiveFrom, config, accepted) => (await query(
    `INSERT INTO attendance_policies (effective_from, config, note, accepted_by, accepted_at)
     VALUES ($1, $2, 'as set up', $3, $4) RETURNING id`,
    [effectiveFrom, JSON.stringify(config), accepted ? admin : null, accepted ? '2026-09-02T10:00:00Z' : null],
  )).rows[0].id;
  // an old version that counted early time, then the one in force, which does not
  await version('2000-01-01', { ...office, creditBeforeStart: true }, true);
  const inForce = await version('2026-06-01', { ...office, creditBeforeStart: false }, true);
  // September is paid and locked under it
  await query(
    `INSERT INTO payroll_results (month, user_id, status, policy_id, snapshot) VALUES ('2026-09-01', $1, 'LOCKED', $2, '{}'::jsonb)`,
    [nikita, inForce],
  );
  const review = (date, status, eligible, reason) => query(
    `INSERT INTO extra_time_reviews (user_id, work_date, status, eligible_seconds, reason, reviewer_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [nikita, date, status, eligible, reason, admin],
  );
  await review('2026-05-15', 'ELIGIBLE', null, null);
  await review('2026-09-10', 'REJECTED', null, 'Not agreed in advance');
  await review('2026-10-07', 'ELIGIBLE', 1200, null);

  const policiesBefore = (await query('SELECT * FROM attendance_policies ORDER BY id')).rows;
  const reviewsBefore = (await query('SELECT * FROM extra_time_reviews ORDER BY work_date')).rows;

  // 023 on its own first, as a deploy between the two changes would apply it
  const file023 = files.find((f) => f.startsWith('023'));
  const file024 = files.find((f) => f.startsWith('024'));
  await query(await fs.readFile(path.join(migrationsDir, file023), 'utf8'));
  await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file023]);

  // every earlier version is exactly as it was: nothing edited, nothing unaccepted
  const policiesAfter = (await query('SELECT * FROM attendance_policies ORDER BY id')).rows;
  assert.deepEqual(policiesAfter.slice(0, policiesBefore.length), policiesBefore);

  // one new version, copied from the one in force with only early time changed
  assert.equal(policiesAfter.length, policiesBefore.length + 1);
  const added = policiesAfter[policiesAfter.length - 1];
  assert.equal(added.effective_from, '2026-10-01', 'from October, after the locked September');
  assert.deepEqual(added.config, { ...office, creditBeforeStart: true });
  assert.equal(added.accepted_at, null, 'waiting for an administrator to accept it');
  assert.equal(added.accepted_by, null);
  assert.match(added.note, /before office hours/i);
  const { rows: trail } = await query(`SELECT * FROM attendance_audit WHERE entity_type = 'POLICY'`);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].entity_id, String(added.id));
  assert.equal(trail[0].action, 'VERSION_CREATED');
  assert.equal(trail[0].source, 'MIGRATION 023');

  // each review says whether its reviewer saw early time; nothing else about it moved
  const reviewsAfter = (await query('SELECT * FROM extra_time_reviews ORDER BY work_date')).rows;
  assert.deepEqual(reviewsAfter.map((r) => r.covers_before_start), [true, false, false]);
  assert.deepEqual(reviewsAfter.map(({ covers_before_start: _, ...rest }) => rest), reviewsBefore);

  // run again by hand, the change neither repeats nor reinterprets the reviews
  await query(await fs.readFile(path.join(migrationsDir, file023), 'utf8'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM attendance_policies')).rows[0].n, policiesAfter.length);
  assert.deepEqual((await query('SELECT * FROM extra_time_reviews ORDER BY work_date')).rows, reviewsAfter);

  // then 024: extra time counts automatically, as one more version on top
  assert.ok(await runMigrations({ verbose: false }) >= 1);
  const withAuto = (await query('SELECT * FROM attendance_policies ORDER BY id')).rows;
  assert.deepEqual(withAuto.slice(0, policiesAfter.length), policiesAfter, 'every earlier version, 023’s included, untouched');
  assert.equal(withAuto.length, policiesAfter.length + 1);
  const auto = withAuto[withAuto.length - 1];
  assert.equal(auto.effective_from, '2026-10-01');
  assert.deepEqual(auto.config, { ...office, creditBeforeStart: true, extraRequiresReview: false }, 'both changes, nothing else');
  assert.equal(auto.accepted_at, null, 'waiting for an administrator to accept it');
  assert.match(auto.note, /counts automatically/i);
  const { rows: trail024 } = await query(`SELECT * FROM attendance_audit WHERE entity_type = 'POLICY' AND source = 'MIGRATION 024'`);
  assert.deepEqual(trail024.map((r) => r.entity_id), [String(auto.id)]);
  assert.deepEqual((await query('SELECT * FROM extra_time_reviews ORDER BY work_date')).rows, reviewsAfter, 'every review stands as decided');

  // neither repeats when run again
  await query(await fs.readFile(path.join(migrationsDir, file023), 'utf8'));
  await query(await fs.readFile(path.join(migrationsDir, file024), 'utf8'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM attendance_policies')).rows[0].n, withAuto.length);
  assert.equal(await runMigrations({ verbose: false }), 0);

  // had October already been closed under a version without either change,
  // the new versions would start after it — a closed month never changes underneath
  const october = await version('2026-10-20', { ...office, creditBeforeStart: false }, true);
  await query(
    `INSERT INTO payroll_results (month, user_id, status, policy_id, snapshot) VALUES ('2026-10-01', $1, 'APPROVED', $2, '{}'::jsonb)`,
    [nikita, october],
  );
  await query(await fs.readFile(path.join(migrationsDir, file023), 'utf8'));
  await query(await fs.readFile(path.join(migrationsDir, file024), 'utf8'));
  const { rows: latest } = await query('SELECT effective_from, config FROM attendance_policies ORDER BY id DESC LIMIT 2');
  assert.deepEqual(latest.map((v) => v.effective_from), ['2026-11-01', '2026-11-01']);
  assert.equal(latest[0].config.creditBeforeStart, true);
  assert.equal(latest[0].config.extraRequiresReview, false);
});

test('a fresh install starts with early time counted and extra time automatic, and with no version to copy, none is added', async (t) => {
  if (skipIfUnavailable(t)) return;
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  assert.ok(await runMigrations({ verbose: false }) >= 1);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM attendance_policies')).rows[0].n, 0);
  const { DEFAULT_POLICY, PROPOSED_KEYS } = await import('../src/services/attendancePolicy.js');
  assert.equal(DEFAULT_POLICY.creditBeforeStart, true);
  assert.equal(DEFAULT_POLICY.extraRequiresReview, false, 'extra time counts with no one approving it');
  for (const key of ['creditBeforeStart', 'extraRequiresReview']) {
    assert.ok(!PROPOSED_KEYS.includes(key), `${key} is confirmed by the company, not a proposal`);
  }
});
