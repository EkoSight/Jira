/**
 * Prints the legacy-leave reconciliation report. Dry run only.
 *
 *   npm run leave:reconcile            JSON on stdout
 *
 * Everything runs in a READ ONLY transaction that is rolled back at the end,
 * so the database refuses any write this tool could attempt. There is no
 * apply mode: decisions are made by people in the app, where each one is
 * approved and audited.
 */

import { pool } from './pool.js';
import { legacyLeaveReport } from '../services/leaveReconciliation.js';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const report = await legacyLeaveReport(client, { asOf: new Date().toISOString() });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
