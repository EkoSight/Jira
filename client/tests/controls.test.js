/**
 * How the reporting screens read: India's financial-year periods, and capacity
 * that never claims room nobody measured.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { financialPeriod } from '../src/lib/crm.js';
import { WORKLOAD_STATUS, loadSummary } from '../src/lib/format.js';

test('periods follow the April-to-March financial year', () => {
  const october = '2026-10-10';
  assert.deepEqual(financialPeriod('year', october), { from: '2026-04-01', to: october });
  assert.deepEqual(financialPeriod('quarter', october), { from: '2026-10-01', to: october });
  assert.deepEqual(financialPeriod('last_quarter', october), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(financialPeriod('last_year', october), { from: '2025-04-01', to: '2026-03-31' });

  const february = '2026-02-15';
  assert.deepEqual(financialPeriod('year', february), { from: '2025-04-01', to: february }, 'still last April’s year');
  assert.deepEqual(financialPeriod('quarter', february), { from: '2026-01-01', to: february });
  assert.deepEqual(financialPeriod('last_quarter', february), { from: '2025-10-01', to: '2025-12-31' });
  assert.deepEqual(financialPeriod('last_year', february), { from: '2024-04-01', to: '2025-03-31' });

  assert.deepEqual(financialPeriod('last_quarter', '2026-05-20'), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(financialPeriod('last_quarter', '2026-08-31'), { from: '2026-04-01', to: '2026-06-30' });
});

test('capacity that was not measured is said to be unknown, never spare', () => {
  assert.ok(WORKLOAD_STATUS.unknown);
  assert.doesNotMatch(WORKLOAD_STATUS.unknown.label, /has capacity|room|available/i);
  assert.equal(
    loadSummary({ open_tasks: 6, load_basis: 'hours_partial', committed_hours: 4, capacity_hours: 40, unestimated_tasks: 5 }),
    'at least 4h of 40h · 5 without an estimate',
  );
  assert.equal(
    loadSummary({ open_tasks: 3, load_basis: 'tasks', max_concurrent_tasks: 8, unestimated_tasks: 3 }),
    '3 of 8 tasks · 3 without an estimate',
  );
  assert.equal(
    loadSummary({ open_tasks: 2, load_basis: 'hours', committed_hours: 6, capacity_hours: 40, unestimated_tasks: 0 }),
    '6h planned of 40h',
  );
  assert.equal(loadSummary({ open_tasks: 0 }), 'No open work');
});
