import { createApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { startDeadlineScanner, stopDeadlineScanner } from './jobs/deadlineScanner.js';
import { closePool } from './db/pool.js';

const app = createApp();

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
  console.error('[taskflow] failed to start:', err);
  process.exit(1);
});
