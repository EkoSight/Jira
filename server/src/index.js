import { createApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { startDeadlineScanner, stopDeadlineScanner } from './jobs/deadlineScanner.js';
import { closePool } from './db/pool.js';

const app = createApp();

/** Turns the usual first-run stumbles into something you can act on. */
function explainStartupFailure(err) {
  const { db } = config;
  const target = db.connectionString
    ? db.connectionString.replace(/:\/\/[^@]*@/, '://***@')
    : `${db.user}@${db.host}:${db.port}/${db.database}`;

  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return [
      `Cannot reach PostgreSQL at ${target}.`,
      '',
      '  • Is the database running?   macOS: brew services start postgresql',
      '                               Linux: sudo service postgresql start',
      '  • Check the PG* values in server/.env (copy it from server/.env.example).',
    ].join('\n');
  }
  if (err.code === '28P01') {
    return `PostgreSQL rejected the password for user "${db.user}". Check PGUSER and PGPASSWORD in server/.env.`;
  }
  if (err.code === '3D000') {
    return [
      `The database "${db.database}" does not exist yet. Create it with:`,
      '',
      `  createdb ${db.database}`,
      `  # or:  psql -U ${db.user} -c 'CREATE DATABASE ${db.database};'`,
    ].join('\n');
  }
  return null;
}

async function main() {
  if (process.env.AUTO_MIGRATE !== 'false') {
    await runMigrations({ verbose: true });
  }

  const server = app.listen(config.port, () => {
    console.log(`[taskflow] API listening on http://localhost:${config.port}${config.apiPrefix}`);
  });

  if (config.jobs.enabled) startDeadlineScanner();

  const shutdown = async (signal) => {
    console.log(`[taskflow] ${signal} received, shutting down`);
    stopDeadlineScanner();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  const explanation = explainStartupFailure(err);
  if (explanation) {
    console.error(`\n[taskflow] cannot start\n\n${explanation}\n`);
  } else {
    console.error('[taskflow] failed to start:', err);
  }
  process.exit(1);
});
