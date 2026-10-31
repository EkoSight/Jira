/**
 * Rehearsal of the sales CRM migration on a database shaped like the live one.
 *
 * The schema is built up to the migration before the sales CRM, filled the way
 * the live site is (organizations in several segments, contacts, deals in
 * open, won and lost stages, history, activities including CAMPAIGN entries,
 * orders, invoices and payments), and fingerprinted column by column. Then the
 * real migrator runs, exactly as a deploy would. Every column that existed
 * before must hold exactly what it held; the only existing values allowed to
 * change are the positions of Won and Lost (one place down, to make room for
 * Approval / Contracting). Then the application must serve the old records to
 * the people who could see them before.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const FIRST_NEW = '027_sales_crm.sql';
const TABLES = [
  'accounts', 'account_contacts', 'account_stages', 'crm_segments', 'opportunities', 'opportunity_contacts', 'opportunity_history',
  'account_activities', 'opportunity_orders', 'opportunity_invoices', 'opportunity_payments', 'crm_ownership_history', 'tasks', 'users', 'settings',
];

let available = true;
let server;
let baseUrl;
const ids = {};

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };

/** Each table's columns as they are now, so the fingerprint covers exactly the columns that existed before. */
async function columnsNow() {
  const { rows } = await query(
    `SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS cols
       FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[]) GROUP BY table_name`,
    [config.db.schema, TABLES],
  );
  return Object.fromEntries(rows.map((r) => [r.table_name, r.cols]));
}

async function fingerprint(columns, { leave = {} } = {}) {
  const out = {};
  for (const [table, cols] of Object.entries(columns)) {
    const kept = cols.filter((c) => !(leave[table] || []).includes(c));
    const key = cols.includes('id') ? 'id' : cols[0];
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(json_build_array(${kept.map((c) => `"${c}"`).join(', ')})::text, '|' ORDER BY "${key}"), '')) AS fp FROM "${table}"`,
    );
    out[table] = rows[0];
  }
  return out;
}

test('the sales CRM migration keeps every existing record, value and relationship exactly as it was', async (t) => {
  if (skip(t)) return;
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await query(`CREATE SCHEMA "${config.db.schema}"`);
  await query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files.filter((f) => f < FIRST_NEW)) {
    await query('BEGIN');
    await query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await query('COMMIT');
  }

  // ---- the live site, as it stands before the release
  await query(`INSERT INTO departments (key, name, position) VALUES ('SAL', 'Sales', 1), ('OPS', 'Operations', 2)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, position, is_default) VALUES ('To Do','to-do','todo',1,TRUE), ('Done','done','done',2,FALSE)`);
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of [['admin', 'admin', 'SAL'], ['manager', 'manager', 'SAL'], ['rep', 'member', 'SAL'], ['ops', 'member', 'OPS']]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1, $2, $3, $4, (SELECT id FROM departments WHERE key = $5), FALSE) RETURNING id`,
      [`Live ${key}`, `mig-${key}@test.local`, password, role, dept],
    );
    ids[key] = rows[0].id;
  }
  const seg = async (slug) => (await query('SELECT id FROM crm_segments WHERE slug = $1', [slug])).rows[0]?.id ?? null;
  const stage = async (slug) => (await query('SELECT id FROM account_stages WHERE slug = $1', [slug])).rows[0].id;
  const account = async (name, { segment = null, type = 'LEAD', website = null, owner = ids.rep } = {}) => (await query(
    `INSERT INTO accounts (name, type, segment_id, website, owner_user_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, type, segment ? await seg(segment) : null, website, owner, ids.admin],
  )).rows[0].id;
  ids.coromandel = await account('Coromandel International', { segment: 'agri-enterprise', type: 'CUSTOMER', website: 'https://www.Coromandel.biz/about-us' });
  ids.foundation = await account('Bharat Agro Foundation', { segment: 'foundation' });
  ids.retailer = await account('Krishna Agro Kendra', { owner: ids.ops });
  ids.fpo = await account('Sahyadri Farmers Producer Company');

  const { rows: [priya] } = await query(
    `INSERT INTO account_contacts (account_id, full_name, email, phone, is_primary) VALUES ($1, 'Priya Nair', ' Priya@Coromandel.BIZ ', '098765 43210', TRUE) RETURNING id`, [ids.coromandel],
  );
  await query(`INSERT INTO account_contacts (account_id, full_name, phone) VALUES ($1, 'Ramesh', '+91 91234 56789')`, [ids.retailer]);

  const deal = async (acc, name, slug, extra = {}) => (await query(
    `INSERT INTO opportunities (account_id, name, stage_id, status, estimated_value, agreed_value, currency, owner_user_id, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [acc, name, await stage(slug), extra.status || 'ACTIVE', extra.value ?? 250000, extra.agreed ?? null, extra.currency || 'INR', ids.rep, extra.status && extra.status !== 'ACTIVE' ? new Date() : null],
  )).rows[0].id;
  ids.open = await deal(ids.coromandel, 'Dealer soil programme', 'proposal');
  ids.usd = await deal(ids.coromandel, 'Export pilot', 'qualified', { currency: 'USD', value: 12000 });
  ids.won = await deal(ids.coromandel, 'Soil cards 2025', 'won', { status: 'WON', agreed: 480000 });
  ids.lost = await deal(ids.foundation, 'Watershed study', 'lost', { status: 'LOST' });
  ids.retailDeal = await deal(ids.retailer, 'Store kit', 'new', { value: 15000 });
  await query(`INSERT INTO opportunity_contacts (opportunity_id, contact_id, role) VALUES ($1, $2, 'DECISION_MAKER')`, [ids.open, priya.id]);
  await query(`INSERT INTO opportunity_history (opportunity_id, field, from_value, to_value, actor_id) VALUES ($1, 'stage', 'Qualified', 'Proposal', $2)`, [ids.open, ids.rep]);
  for (const [type, source] of [['CALL', 'MANUAL'], ['CAMPAIGN', 'SYSTEM'], ['STAGE_CHANGE', 'SYSTEM'], ['NOTE', 'MANUAL']]) {
    await query(`INSERT INTO account_activities (account_id, opportunity_id, type, source, subject, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ids.coromandel, ids.open, type, source, `${type} before the release`, ids.rep]);
  }
  await query(`INSERT INTO opportunity_orders (opportunity_id, kind, reference, received_on, amount) VALUES ($1, 'PURCHASE_ORDER', 'PO-77', '2025-11-02', 480000)`, [ids.won]);
  await query(`INSERT INTO opportunity_invoices (opportunity_id, number, issued_on, amount) VALUES ($1, 'INV-12', '2025-11-05', 480000)`, [ids.won]);
  await query(`INSERT INTO opportunity_payments (opportunity_id, received_on, amount, reference) VALUES ($1, '2025-11-20', 200000, 'UTR-1')`, [ids.won]);
  await query(`INSERT INTO crm_ownership_history (entity_type, entity_id, from_user_id, to_user_id, changed_by) VALUES ('ACCOUNT', $1, $2, $3, $2)`, [ids.coromandel, ids.admin, ids.rep]);
  await query(`INSERT INTO tasks (ref, title, department_id, status_id, created_by, account_id) VALUES ('SAL-1', 'Send revised pricing', (SELECT id FROM departments WHERE key = 'SAL'), (SELECT id FROM workflow_statuses WHERE slug = 'to-do'), $1, $2)`, [ids.rep, ids.coromandel]);

  const { rows: stagesBefore } = await query('SELECT id, slug, position FROM account_stages ORDER BY id');
  const columns = await columnsNow();
  const before = await fingerprint(columns, { leave: { account_stages: ['position'], settings: ['updated_at'] } });
  // the fingerprint covers real rows, not empty tables
  assert.deepEqual([before.accounts.n, before.account_contacts.n, before.opportunities.n, before.account_activities.n, before.opportunity_payments.n], [4, 2, 5, 4, 1]);

  // ---- the release, exactly as a deploy applies it
  const applied = await runMigrations({ verbose: false });
  assert.ok(applied >= 1, 'the sales CRM migration ran');

  // every column that existed holds what it held; no row was removed or rewritten
  const afterRun = await fingerprint(columns, { leave: { account_stages: ['position'], settings: ['updated_at'] } });
  for (const table of Object.keys(before)) {
    if (table === 'account_stages') continue;
    assert.deepEqual(afterRun[table], before[table], `${table}: existing rows unchanged`);
  }
  // stages: the same ids, slugs and names; sixteen rows added (Approval / Contracting, the CSR pipeline, the retail pipeline)
  assert.equal(afterRun.account_stages.n, before.account_stages.n + 16);
  const { rows: stagesAfter } = await query('SELECT id, slug, position FROM account_stages ORDER BY id');
  for (const s of stagesBefore) {
    const now = stagesAfter.find((x) => x.id === s.id);
    assert.equal(now.slug, s.slug, 'stage keeps its id and slug');
    const moved = { won: s.position + 1, lost: s.position + 1 }[s.slug];
    assert.equal(now.position, moved ?? s.position, `${s.slug}: position ${moved ? 'one place down' : 'unchanged'}`);
  }

  // what was added, and only that: nothing reclassified, everything placed where it was
  const { rows: accs } = await query('SELECT id, lead_category, routing_status, category_source, suggested_category, domain FROM accounts ORDER BY id');
  for (const a of accs) {
    assert.equal(a.lead_category, null, 'no organization is given a category by the migration');
    assert.equal(a.routing_status, 'LEGACY_UNCONFIRMED');
    assert.equal(a.category_source, 'LEGACY');
  }
  const suggestion = Object.fromEntries(accs.map((a) => [a.id, a.suggested_category]));
  assert.equal(suggestion[ids.retailer], 'RETAILER', 'a suggestion only, for a person to confirm');
  assert.equal(suggestion[ids.fpo], 'FPO');
  assert.equal(suggestion[ids.foundation], 'CSR_NGO');
  assert.equal(accs.find((a) => a.id === ids.coromandel).domain, 'coromandel.biz', 'a plain copy of the website, for duplicate checks');
  const { rows: deals } = await query(`SELECT o.id, p.key FROM opportunities o LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id`);
  assert.ok(deals.every((d) => d.key === 'b2b'), 'every existing deal stays in the pipeline it was in');
  const { rows: contacts } = await query('SELECT full_name, email_normalized, phone_normalized FROM account_contacts ORDER BY id');
  assert.deepEqual(contacts.map((c) => [c.email_normalized, c.phone_normalized]), [['priya@coromandel.biz', '919876543210'], [null, '919123456789']]);

  // a second run changes nothing
  assert.equal(await runMigrations({ verbose: false }), 0);
  assert.deepEqual(await fingerprint(columns, { leave: { account_stages: ['position'], settings: ['updated_at'] } }), afterRun);

  // ---- the application serves the old records to the people who saw them before
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  const call = async (method, url, token, body) => {
    const res = await fetch(`${baseUrl}/api/taskflow${url}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (key) => (await call('POST', '/auth/login', null, { email: `mig-${key}@test.local`, password: 'Password123!' })).body.token;
  const ops = await login('ops');
  const rep = await login('rep');
  // a member of another department saw every organization before; with record-level access off (the default) they still do
  const list = await call('GET', '/accounts', ops);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.accounts.map((a) => a.id).sort((a, b) => a - b), [ids.coromandel, ids.foundation, ids.retailer, ids.fpo].sort((a, b) => a - b));
  assert.equal((await call('GET', `/opportunities/${ids.open}`, ops)).status, 200);
  // the board still shows the open deals, including the one on a retailer-looking organization nobody has confirmed yet
  const board = await call('GET', '/opportunities/board', rep);
  assert.equal(board.status, 200);
  const onBoard = board.body.stages.flatMap((s) => s.deals.map((d) => d.id));
  for (const id of [ids.open, ids.usd, ids.retailDeal]) assert.ok(onBoard.includes(id), `deal ${id} is still on the board`);
  // the won deal's money reads as before: its own currency, the payment as received
  const won = await call('GET', `/opportunities/${ids.won}`, rep);
  assert.equal(won.status, 200);
  assert.equal(Number(won.body.opportunity.agreed_value), 480000);
  assert.equal(Number(won.body.opportunity.cash_received), 200000);
  // and an old activity type is still accepted alongside the new ones
  const { rowCount } = await query(`INSERT INTO account_activities (account_id, type, source, subject) VALUES ($1, 'CAMPAIGN', 'SYSTEM', 'after the release')`, [ids.coromandel]);
  assert.equal(rowCount, 1);
});
