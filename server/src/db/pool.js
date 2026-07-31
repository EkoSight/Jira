import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

// Return DATE columns as plain 'YYYY-MM-DD' strings rather than JS Dates so that
// values do not shift across timezones on the way to the client.
types.setTypeParser(1082, (value) => value);
// NUMERIC -> number (all numeric columns here are small money/hours values)
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

// Applied by postgres at connection time, so every pooled client is already
// pointed at the TaskFlow schema before the first query runs.
const searchPathOption = `-c search_path="${config.db.schema}",public`;

const poolConfig = config.db.connectionString
  ? {
      connectionString: config.db.connectionString,
      ssl: config.db.ssl,
      max: config.db.max,
      options: searchPathOption,
    }
  : {
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      ssl: config.db.ssl,
      max: config.db.max,
      options: searchPathOption,
    };

// Every pooled connection works inside the TaskFlow schema. This keeps the module
// self-contained when it shares a database with the main EkoSight application.
export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[taskflow] unexpected postgres pool error', err);
});

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
