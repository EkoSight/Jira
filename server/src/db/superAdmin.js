/**
 * Names the super admins: the founders.
 *
 *   npm run access:super-admin                         list admins and super admins
 *   npm run access:super-admin -- --grant a@x b@y      make these accounts super admins
 *   npm run access:super-admin -- --revoke a@x         make a super admin an admin again
 *
 * Run it on the server, against the database the app uses. Each change is
 * written to the audit trail; the people changed are signed out once so their
 * new role takes effect. Nothing is changed if any email is unknown or
 * switched off, or if no active super admin would remain.
 */

import { pool } from './pool.js';
import { administrators, grantSuperAdmin, revokeSuperAdmin } from '../services/access.js';

const LABEL = { super_admin: 'super admin', admin: 'admin' };

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--grant') ? 'grant' : args.includes('--revoke') ? 'revoke' : 'list';
  const emails = args.filter((a) => !a.startsWith('--'));

  if (mode === 'grant' || mode === 'revoke') {
    const result = mode === 'grant' ? await grantSuperAdmin(emails) : await revokeSuperAdmin(emails);
    for (const r of result) {
      console.log(r.changed
        ? `  ${r.email}: ${LABEL[r.before] || r.before} → ${LABEL[r.after] || r.after}`
        : `  ${r.email}: already ${LABEL[r.after] || r.after}, unchanged`);
    }
  }
  console.log('\nAdministrators now:');
  for (const a of await administrators()) {
    console.log(`  ${(LABEL[a.role] || a.role).padEnd(12)} ${a.email}${a.is_active ? '' : '  (switched off)'}`);
  }
}

main()
  .catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
