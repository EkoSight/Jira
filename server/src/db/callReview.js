/**
 * Lists calls that look repeated, for a person to review. Read only: it runs
 * inside a READ ONLY transaction, so it cannot change anything.
 *
 *   npm run crm:call-review -- --lead 693 --lead 692
 *   npm run crm:call-review -- --since 2026-11-01
 *   npm run crm:call-review -- --lead 693 --window 300 --json > review.json
 *
 * For each lead, calls by the same person within --window seconds (default
 * 120) of each other are grouped, with every call's id, the second it was
 * saved, the outcome, the length, how it was recorded and the start of its
 * note. A group is labelled:
 *   LIKELY_ACCIDENTAL  same outcome and note, within 30 seconds
 *   DIFFERENT_NOTES    different notes: a correction saved as a new call, or two real calls
 *   NEEDS_A_PERSON     anything else
 * The labels are advice. Changing anything (marking a call as an accidental
 * repeat) is done one call at a time in TaskFlow by a manager, with a reason,
 * and can be undone. Nothing is ever deleted or merged.
 *
 * Works before and after migration 033: before it, the columns it added are
 * shown as unknown.
 */
import { pool } from './pool.js';
import { callReview } from '../services/sales/callRecords.js';

const arg = (args, name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : [])).filter(Boolean);

async function main() {
  const args = process.argv.slice(2);
  const leadIds = arg(args, '--lead').flatMap((v) => v.split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const since = arg(args, '--since')[0] || null;
  const windowSeconds = Math.min(Math.max(Number(arg(args, '--window')[0]) || 120, 5), 3600);
  if (!leadIds.length && !since) {
    console.error('Name the leads (--lead 693 --lead 692) or a date to start from (--since 2026-11-01).');
    process.exitCode = 2;
    return;
  }
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error('--since takes a date like 2026-11-01');
    process.exitCode = 2;
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'crm_calls' AND column_name = 'recorded_via'",
    );
    const result = await callReview({ leadIds, since, windowSeconds, legacy: !rows.length }, client);
    await client.query('ROLLBACK');
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const tz = 'Asia/Kolkata';
    const at = (d) => new Date(d).toLocaleString('en-IN', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    console.log(`Read ${result.entries.length} entries${leadIds.length ? ` on lead(s) ${leadIds.join(', ')}` : ''}${since ? ` since ${since}` : ''}; grouped within ${windowSeconds}s. Nothing was changed.`);
    if (!rows.length) console.log('Migration 033 is not applied here: how each call was recorded is not known yet.');
    if (!result.groups.length) console.log('No calls close together.');
    for (const g of result.groups) {
      console.log(`\nLead ${g.lead_id} · ${g.entries[0].agent_name || 'unknown person'} · ${g.entries.length} entries within ${g.seconds_apart}s · ${g.verdict}`);
      console.log(`  ${g.advice}`);
      for (const e of g.entries) {
        const ref = e.call_id ? `call #${e.call_id}` : `timeline entry ${e.activity_id} (no call record)`;
        console.log(`  - ${ref} · saved ${at(e.created_at)} IST · ${String(e.outcome || '').toLowerCase()} · ${e.duration_sec ?? '-'}s · ${e.recorded_via}${e.counted ? '' : ' · not counted'}`);
        console.log(`      note: ${e.notes_preview ? JSON.stringify(e.notes_preview) : '(none)'}`);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch(async (err) => {
  console.error(err.message);
  process.exitCode = 1;
  await pool.end();
});
