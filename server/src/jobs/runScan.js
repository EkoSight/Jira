/**
 * One-shot deadline / black mark scan, for running from cron instead of keeping
 * the in-process scheduler enabled:
 *
 *   *\/15 * * * * cd /srv/taskflow && node server/src/jobs/runScan.js
 */
import { runScanOnce } from './deadlineScanner.js';
import { closePool } from '../db/pool.js';

runScanOnce()
  .then((result) => {
    console.log(
      `[taskflow] scanned ${result.scanned} task(s), recorded ${result.created.length} black mark(s)`,
    );
    return closePool();
  })
  .catch(async (err) => {
    console.error('[taskflow] scan failed:', err.message);
    await closePool();
    process.exit(1);
  });
