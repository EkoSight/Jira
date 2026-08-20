/**
 * Goal period presets.
 *
 * These are client-side pure functions, tested here because they decide which
 * dates a goal is saved with — and a preset that is a day out silently mislabels
 * every goal the company sets. The bug this guards against only appeared outside
 * UTC, which is where the whole team actually works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { periodPresets } from '../../client/src/lib/okr.js';

/** Runs a function with the process pinned to a timezone. */
function inTimezone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    process.env.TZ = previous;
  }
}

const byKey = (presets) => Object.fromEntries(presets.map((p) => [p.key, p]));

test('a quarter runs from its first day to its last, whatever the timezone', () => {
  // 20 August 2026 sits in Q3, so Q3 is "this" and Q4 is "next"
  const when = new Date(2026, 7, 20, 12, 0, 0);

  for (const zone of ['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    const presets = inTimezone(zone, () => byKey(periodPresets(when)));

    assert.equal(presets['this-quarter'].start_date, '2026-07-01', `Q3 starts on 1 July in ${zone}`);
    assert.equal(presets['this-quarter'].end_date, '2026-09-30', `Q3 ends on 30 September in ${zone}`);
    assert.equal(presets['next-quarter'].start_date, '2026-10-01', `Q4 starts on 1 October in ${zone}`);
    assert.equal(presets['next-quarter'].end_date, '2026-12-31', `Q4 ends on 31 December in ${zone}`);
    assert.equal(presets['this-year'].start_date, '2026-01-01', `the year starts on 1 January in ${zone}`);
    assert.equal(presets['this-year'].end_date, '2026-12-31', `the year ends on 31 December in ${zone}`);
  }
});

test('consecutive quarters meet without a gap or an overlap', () => {
  const presets = inTimezone('Asia/Kolkata', () => byKey(periodPresets(new Date(2026, 7, 20))));
  const dayAfter = new Date(`${presets['this-quarter'].end_date}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

  assert.equal(
    presets['next-quarter'].start_date,
    dayAfter.toISOString().slice(0, 10),
    'next quarter begins the day after this one ends',
  );
});

test('the last quarter of the year rolls into the next year', () => {
  const presets = inTimezone('Asia/Kolkata', () => byKey(periodPresets(new Date(2026, 11, 15))));
  assert.equal(presets['this-quarter'].start_date, '2026-10-01');
  assert.equal(presets['next-quarter'].start_date, '2027-01-01');
  assert.equal(presets['next-quarter'].end_date, '2027-03-31');
});

test('"all periods" carries no dates, so it filters nothing out', () => {
  const presets = inTimezone('Asia/Kolkata', () => byKey(periodPresets(new Date(2026, 7, 20))));
  assert.equal(presets.all.start_date, null);
  assert.equal(presets.all.end_date, null);
});
