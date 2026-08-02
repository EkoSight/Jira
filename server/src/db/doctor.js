/**
 * `npm run doctor` — checks everything TaskFlow needs, in the order it needs it,
 * and stops at the first thing that is wrong with the command that fixes it.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { closePool, query } from './pool.js';
import { explainDatabaseError, describeError, rootCause } from '../lib/dbErrors.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ok = (msg, detail) => console.log(`  \u001b[32m✓\u001b[0m ${msg}${detail ? `  ${detail}` : ''}`);
const warn = (msg) => console.log(`  \u001b[33m!\u001b[0m ${msg}`);
const bad = (msg) => console.log(`  \u001b[31m✗\u001b[0m ${msg}`);

const nextSteps = (...lines) => {
  console.log('\nNext step:\n');
  for (const line of lines) console.log(`  ${line}`);
  console.log('');
};

/**
 * On Windows, find the installed PostgreSQL service so the advice can name it
 * exactly rather than guessing a version number.
 */
function windowsPostgresService() {
  if (process.platform !== 'win32') return null;
  try {
    const output = execSync('sc query type= service state= all', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const match = output.match(/SERVICE_NAME:\s*(postgresql[-\w]*)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Where the PostgreSQL command line tools live, when they are not on PATH. */
function windowsPsqlHint() {
  if (process.platform !== 'win32') return null;
  const base = 'C:\\Program Files\\PostgreSQL';
  try {
    const versions = fs
      .readdirSync(base)
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a));
    if (versions.length) return `${base}\\${versions[0]}\\bin`;
  } catch {
    /* not installed there */
  }
  return `${base}\\<version>\\bin`;
}

/** Is anything listening on the database port at all? */
const portOpen = (host, port, timeout = 2500) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });

async function main() {
  const { host, port, user, database, schema, connectionString } = config.db;

  console.log('\nTaskFlow setup check\n');

  // 1. environment file -----------------------------------------------------
  const envPath = path.join(serverRoot, '.env');
  if (fs.existsSync(envPath)) {
    ok('server/.env found');
  } else {
    warn('server/.env is missing — the built-in defaults are being used');
    console.log('      Windows:  copy server\\.env.example server\\.env');
    console.log('      mac/Linux: cp server/.env.example server/.env');
  }

  // 2. node version ---------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else {
    bad(`Node ${process.versions.node} — TaskFlow needs Node 20 or newer`);
    return nextSteps('Install Node 20+ from https://nodejs.org and run this again.');
  }

  const target = connectionString ? '(from DATABASE_URL)' : `${user}@${host}:${port}`;

  // 3. is the server up? ----------------------------------------------------
  if (!connectionString) {
    if (await portOpen(host, port)) {
      ok(`something is listening on ${host}:${port}`);
    } else {
      bad(`nothing is listening on ${host}:${port} — PostgreSQL is not running`);

      const service = windowsPostgresService();
      if (service) {
        return nextSteps(
          `The "${service}" service is installed but not running. Starting it needs`,
          'administrator rights — a normal prompt fails with "Access is denied".',
          '',
          '  Press the Windows key, type cmd, then right-click "Command Prompt"',
          '  and choose "Run as administrator". In that window:',
          '',
          `      net start ${service}`,
          '',
          '  Or without the command line: Win+R, services.msc, find',
          `  "${service}", right-click, Start.`,
          '',
          '  To have it start with Windows from now on, open its Properties in',
          '  services.msc and set Startup type to Automatic.',
        );
      }

      if (process.platform === 'win32') {
        return nextSteps(
          'No PostgreSQL service was found. Install it from',
          'https://www.postgresql.org/download/windows/ and note the password you',
          'set for the "postgres" user — it goes in server/.env as PGPASSWORD.',
        );
      }

      return nextSteps(
        'macOS:  brew services start postgresql',
        'Linux:  sudo service postgresql start',
        '',
        'Not installed yet? See https://www.postgresql.org/download/ and note the',
        'password you set for the "postgres" user — it goes in server/.env as PGPASSWORD.',
      );
    }
  }

  // 4. can we authenticate? does the database exist? ------------------------
  try {
    await query('SELECT 1');
    ok(`connected to database "${database}"`, target);
  } catch (err) {
    const cause = rootCause(err);
    bad(`cannot connect: ${describeError(err)}`);

    if (cause?.code === '3D000') {
      const psqlHint = windowsPsqlHint();
      return nextSteps(
        `The database "${database}" does not exist yet. Create it with:`,
        '',
        `  psql -U ${user} -c "CREATE DATABASE ${database};"`,
        ...(psqlHint
          ? ['', `If psql is not recognised, it lives in ${psqlHint}`, 'or you can create the database from pgAdmin.']
          : []),
      );
    }
    if (cause?.code === '28P01' || cause?.code === '28000') {
      return nextSteps(
        `PostgreSQL rejected the password for "${user}".`,
        'Put the password you chose when installing PostgreSQL into server/.env as PGPASSWORD.',
      );
    }
    const explanation = explainDatabaseError(err);
    return nextSteps(...(explanation ? explanation.split('\n') : ['Check the PG* values in server/.env.']));
  }

  // 5. have the migrations run? ---------------------------------------------
  let migrated = false;
  try {
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    migrated = rows[0].n > 0;
    if (migrated) ok(`schema "${schema}" is migrated`, `${rows[0].n} migration(s) applied`);
  } catch {
    migrated = false;
  }

  if (!migrated) {
    bad(`the TaskFlow tables are not in schema "${schema}" yet`);
    return nextSteps('npm run migrate', 'npm run seed');
  }

  // 6. is there anything to sign in with? -----------------------------------
  const { rows: counts } = await query(`
    SELECT (SELECT COUNT(*)::int FROM users)               AS users,
           (SELECT COUNT(*)::int FROM users WHERE role = 'admin' AND is_active) AS admins,
           (SELECT COUNT(*)::int FROM departments)         AS departments,
           (SELECT COUNT(*)::int FROM workflow_statuses)   AS statuses,
           (SELECT COUNT(*)::int FROM blackmark_rules)     AS rules,
           (SELECT COUNT(*)::int FROM tasks)               AS tasks
  `);
  const { users, admins, departments, statuses, rules, tasks } = counts[0];

  if (admins === 0) {
    bad('no active admin account exists');
    return nextSteps('npm run seed');
  }

  ok(`${admins} admin account(s)`, `${users} user(s) in total`);
  ok(`${departments} departments, ${statuses} board statuses, ${rules} black mark rules`);
  ok(`${tasks} task card(s)`);

  const { rows: admin } = await query(
    `SELECT email, must_change_password FROM users WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1`,
  );

  console.log('\n\u001b[32mEverything checks out.\u001b[0m\n');
  console.log(`  Sign in as:  ${admin[0].email}`);
  if (admin[0].must_change_password) {
    console.log('               password ChangeMe123! unless you set ADMIN_PASSWORD');
    console.log('               (you will be asked to change it straight away)');
  } else {
    console.log('               with the password you already set');
  }
  nextSteps('npm run dev', '', 'then open http://localhost:5173');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(`\n[doctor] check failed: ${describeError(err)}\n`);
    await closePool();
    process.exit(1);
  });
