/**
 * Migration 009 — repairing goal periods stored a day early.
 *
 * This migration edits rows people have already been working against, so what
 * matters most is what it does NOT touch. Every shape below is seeded together
 * and the migration is run over all of them at once.
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

const migrationFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'db', 'migrations', '009_fix_preset_goal_dates.sql',
);

let available = true;
let migrationSql;
const ids = {};

const skipIfUnavailable = (t) => {
  if (!available) {
    t.skip('no database');
    return true;
  }
  return false;
};

/** Seeds one objective and returns its id. */
const seedObjective = async (title, start, end) => {
  const { rows } = await query(
    `INSERT INTO objectives (title, scope_type, department_id, owner_user_id, start_date, end_date, status, created_by)
     VALUES ($1, 'DEPARTMENT', $2, $3, $4, $5, 'ACTIVE', $3) RETURNING id`,
    [title, ids.department, ids.user, start, end],
  );
  return rows[0].id;
};

const periodOf = async (id) => {
  const { rows } = await query('SELECT start_date, end_date FROM objectives WHERE id = $1', [id]);
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  return `${iso(rows[0].start_date)} → ${iso(rows[0].end_date)}`;
};

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try {
    await query('SELECT 1');
  } catch {
    available = false;
    return;
  }

  migrationSql = await fs.readFile(migrationFile, 'utf8');

  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, position) VALUES ('GRO', 'Growth', 1)`);
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'GRO'`);
  ids.department = dept[0].id;

  const { rows: user } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, must_change_password)
     VALUES ('Owner', 'period@test.local', $1, 'admin', FALSE) RETURNING id`,
    [await hashPassword('Password123!')],
  );
  ids.user = user[0].id;

  // ---- what the bug produced
  ids.buggyQuarter = await seedObjective('Day-early quarter', '2026-06-30', '2026-09-29');
  ids.buggyQ1 = await seedObjective('Day-early first quarter', '2025-12-31', '2026-03-30');
  ids.buggyYear = await seedObjective('Day-early year', '2025-12-31', '2026-12-30');
  ids.buggyHalf = await seedObjective('Day-early half', '2026-06-30', '2026-12-30');

  // ---- what must not be touched
  ids.correctQuarter = await seedObjective('Correct quarter', '2026-07-01', '2026-09-30');
  ids.correctYear = await seedObjective('Correct year', '2026-01-01', '2026-12-31');
  ids.handTyped = await seedObjective('Hand-typed period', '2026-05-14', '2026-11-03');
  // one end matching is not the fingerprint — both must
  ids.halfMatch = await seedObjective('Only the start looks shifted', '2026-06-30', '2026-11-03');
  ids.shortSprint = await seedObjective('A two-week push', '2026-08-03', '2026-08-14');
});

after(async () => {
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('it moves exactly the periods the bug produced, and nothing else', async (t) => {
  if (skipIfUnavailable(t)) return;

  const before = {
    correctQuarter: await periodOf(ids.correctQuarter),
    correctYear: await periodOf(ids.correctYear),
    handTyped: await periodOf(ids.handTyped),
    halfMatch: await periodOf(ids.halfMatch),
    shortSprint: await periodOf(ids.shortSprint),
  };

  await query(migrationSql);

  // repaired to the real calendar periods
  assert.equal(await periodOf(ids.buggyQuarter), '2026-07-01 → 2026-09-30');
  assert.equal(await periodOf(ids.buggyQ1), '2026-01-01 → 2026-03-31');
  assert.equal(await periodOf(ids.buggyYear), '2026-01-01 → 2026-12-31');
  assert.equal(await periodOf(ids.buggyHalf), '2026-07-01 → 2026-12-31');

  // and everything else is exactly as it was
  assert.equal(await periodOf(ids.correctQuarter), before.correctQuarter, 'an already-correct quarter is left alone');
  assert.equal(await periodOf(ids.correctYear), before.correctYear, 'an already-correct year is left alone');
  assert.equal(await periodOf(ids.handTyped), before.handTyped, 'a hand-typed period is left alone');
  assert.equal(await periodOf(ids.halfMatch), before.halfMatch, 'one matching end is not enough to shift a row');
  assert.equal(await periodOf(ids.shortSprint), before.shortSprint, 'a short custom period is left alone');
});

test('every adjustment is recorded on the goal it changed', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { rows } = await query(
    `SELECT entity_id, from_value, to_value FROM okr_activity
      WHERE action = 'period_corrected' AND entity_type = 'OBJECTIVE'
      ORDER BY entity_id`,
  );
  assert.equal(rows.length, 4, 'one entry per repaired goal, and only those');

  const repaired = rows.find((r) => r.entity_id === ids.buggyQuarter);
  assert.equal(repaired.from_value, '2026-06-30 → 2026-09-29');
  assert.equal(repaired.to_value, '2026-07-01 → 2026-09-30');

  const untouched = rows.some((r) => r.entity_id === ids.handTyped);
  assert.equal(untouched, false, 'nothing is logged against a goal that was not changed');
});

test('running it again changes nothing', async (t) => {
  if (skipIfUnavailable(t)) return;

  const snapshot = async () => {
    const { rows } = await query(
      'SELECT id, start_date, end_date FROM objectives ORDER BY id',
    );
    return JSON.stringify(rows);
  };

  const before = await snapshot();
  await query(migrationSql);
  assert.equal(await snapshot(), before, 'a corrected period no longer matches the fingerprint');

  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM okr_activity WHERE action = 'period_corrected'`);
  assert.equal(rows[0].n, 4, 'and no second round of log entries');
});

test('no goal is lost, and none ends before it starts', async (t) => {
  if (skipIfUnavailable(t)) return;

  const { rows } = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE end_date < start_date)::int AS inverted
       FROM objectives`,
  );
  assert.equal(rows[0].total, 9, 'every seeded goal is still there');
  assert.equal(rows[0].inverted, 0);
});
