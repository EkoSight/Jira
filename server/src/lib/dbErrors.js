import { config } from '../config.js';

/**
 * Node reports a refused connection to a dual-stack host (Windows resolves
 * localhost to both ::1 and 127.0.0.1) as an AggregateError with an empty
 * message. Unwrap it so the real cause is not lost.
 */
export function rootCause(err) {
  if (!err) return err;
  if (err instanceof AggregateError && err.errors?.length) return err.errors[0];
  if (Array.isArray(err.errors) && err.errors.length && !err.message) return err.errors[0];
  return err;
}

/** A description of the failure that is never empty. */
export function describeError(err) {
  const cause = rootCause(err);
  return cause?.message || cause?.code || String(cause);
}

/**
 * Maps the database failures that are almost always a setup problem onto the
 * command that fixes them. Returns null for anything else, so genuine bugs are
 * still reported as bugs.
 */
export function explainDatabaseError(err) {
  const cause = rootCause(err) || {};
  const { schema, database, user, host, port, connectionString } = config.db;
  const target = connectionString
    ? connectionString.replace(/:\/\/[^@]*@/, '://***@')
    : `${user}@${host}:${port}/${database}`;

  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(cause.code)) {
    return [
      `Cannot reach PostgreSQL at ${target}.`,
      '',
      '  • Is the database running?',
      '      Windows: open Services and start "postgresql-x64-…"',
      '      macOS:   brew services start postgresql',
      '      Linux:   sudo service postgresql start',
      '  • Check the PG* values in server/.env (copied from server/.env.example).',
    ].join('\n');
  }
  if (cause.code === '28P01' || cause.code === '28000') {
    return [
      `PostgreSQL rejected the credentials for user "${user}".`,
      '',
      '  Set PGUSER and PGPASSWORD in server/.env to the ones you chose when',
      '  installing PostgreSQL.',
    ].join('\n');
  }
  if (cause.code === '3D000') {
    return [
      `The database "${database}" does not exist yet. Create it with:`,
      '',
      `  createdb ${database}`,
      `  # or:  psql -U ${user} -c "CREATE DATABASE ${database};"`,
    ].join('\n');
  }
  if (cause.code === '42P01') {
    return [
      `The TaskFlow tables are missing from schema "${schema}" in database "${database}".`,
      '',
      '  npm run migrate',
      '  npm run seed',
    ].join('\n');
  }
  if (cause.code === '42501' || cause.code === '3F000') {
    return `The user "${user}" does not have access to schema "${schema}" in database "${database}".`;
  }
  return null;
}

/** Prints the explanation if there is one, otherwise the error itself. */
export function reportStartupFailure(prefix, err) {
  const explanation = explainDatabaseError(err);
  if (explanation) {
    console.error(`\n[${prefix}] cannot continue\n\n${explanation}\n`);
  } else {
    console.error(`[${prefix}] failed: ${describeError(err)}`);
    const cause = rootCause(err);
    if (cause?.stack) console.error(cause.stack);
  }
}
