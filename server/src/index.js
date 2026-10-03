import { createApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { startDeadlineScanner, stopDeadlineScanner } from './jobs/deadlineScanner.js';
import { startChatWorker, stopChatWorker } from './jobs/chatWorker.js';
import { closePool } from './db/pool.js';
import { reportStartupFailure } from './lib/dbErrors.js';
import { backfillAccountImages } from './services/accountImages.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const app = createApp();

async function main() {
  if (process.env.AUTO_MIGRATE !== 'false') {
    await runMigrations({ verbose: true });
  }

  // logos and banners uploaded before they were kept in the database: copy
  // them in while their files still exist
  try {
    const { copied, missing } = await backfillAccountImages();
    if (copied) console.log(`[taskflow] moved ${copied} organization image(s) into the database`);
    if (missing.length) {
      console.warn(`[taskflow] ${missing.length} organization image(s) have no file left on this server and must be uploaded again: `
        + missing.map((m) => `account ${m.account_id} ${m.kind.toLowerCase()}`).join(', '));
    }
  } catch (err) {
    console.error('[taskflow] could not move organization images into the database:', err.message);
  }

  // task attachments stay on disk; inside the checkout they do not survive a deploy
  if (path.resolve(config.uploads.dir).startsWith(repoRoot + path.sep)) {
    console.warn(`[taskflow] WARNING: UPLOAD_DIR is inside the deployment folder (${config.uploads.dir}). `
      + 'Task attachments there are lost by a deploy that replaces the checkout. Set UPLOAD_DIR=/var/lib/taskflow/uploads — see docs/DEPLOY.md.');
  }

  const server = app.listen(config.port, () => {
    console.log(`[taskflow] API listening on http://localhost:${config.port}${config.apiPrefix}`);
  });

  if (config.jobs.enabled) {
    startDeadlineScanner();
    startChatWorker();
  }

  const shutdown = async (signal) => {
    console.log(`[taskflow] ${signal} received, shutting down`);
    stopDeadlineScanner();
    stopChatWorker();
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
  reportStartupFailure('taskflow', err);
  process.exit(1);
});
