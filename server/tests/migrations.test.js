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
