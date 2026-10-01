/**
 * How attendance reads on screen, and how a location is taken.
 *
 * Guarded here: durations are hours:minutes (8h30m is "8:30", never "8.30");
 * times are shown in India whatever the phone's timezone; the browser is asked
 * for a fresh, high-accuracy reading; and when no reading can be had, the
 * reason comes back — never a made-up coordinate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_META, LOCATION_PROBLEM, PRIVACY_NOTICE, clockIn, dayMeta, dayName, hhmm, mapsLink, money,
  newRequestId, readLocation, shiftMonth, words,
} from '../src/lib/attendance.js';

test('durations are hours and minutes, never decimal-looking', () => {
  assert.equal(hhmm(8 * 3600 + 30 * 60), '8:30');
  assert.equal(hhmm(5 * 60), '0:05');
  assert.equal(hhmm(-20 * 60), '−0:20');
  assert.equal(hhmm(45 * 60, { signed: true }), '+0:45');
  assert.equal(hhmm(null), '—');
  assert.equal(words(8 * 3600 + 30 * 60), '8 h 30 min');
  assert.equal(words(0), '0 min');
});

test('times are shown in India, whatever the device is set to', () => {
  // 03:34 UTC is 09:04 in India
  assert.equal(clockIn('2026-10-01T03:34:00Z'), '09:04');
  assert.equal(clockIn(null), '—');
  assert.equal(dayName('2026-10-01'), 'Thu 1 Oct');
});

test('months step across the year boundary', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('every day classification has words, and an unknown one still renders', () => {
  for (const meta of Object.values(DAY_META)) assert.ok(meta.label && meta.tone);
  assert.equal(dayMeta('UNRECORDED_NEEDS_REVIEW').label, 'Unrecorded — needs review');
  assert.notEqual(dayMeta('UNRECORDED_NEEDS_REVIEW').label, DAY_META.UNAPPROVED_ABSENCE.label, 'unrecorded is not absent');
  assert.equal(dayMeta('SOMETHING_NEW').label, 'SOMETHING_NEW');
});

test('the privacy notice is the agreed wording', () => {
  assert.equal(PRIVACY_NOTICE, 'Task Flow records your current location when you check in and check out for attendance. It does not continuously track your location.');
});

test('a location is asked for fresh and precise', async () => {
  let options;
  const geolocation = {
    getCurrentPosition: (ok, _fail, opts) => {
      options = opts;
      ok({ coords: { latitude: 28.61, longitude: 77.2, accuracy: 18 }, timestamp: 1_790_000_000_000 });
    },
  };
  const reading = await readLocation({ timeoutSeconds: 15, geolocation, secure: true });
  assert.deepEqual(options, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
  assert.deepEqual(reading, { latitude: 28.61, longitude: 77.2, accuracy: 18, timestamp: 1_790_000_000_000 });
});

test('no reading means a reason, never a substitute location', async () => {
  const failing = (code) => ({ getCurrentPosition: (_ok, fail) => fail({ code }) });
  await assert.rejects(readLocation({ geolocation: failing(1), secure: true }), { code: 'DENIED' });
  await assert.rejects(readLocation({ geolocation: failing(2), secure: true }), { code: 'UNAVAILABLE' });
  await assert.rejects(readLocation({ geolocation: failing(3), secure: true }), { code: 'TIMEOUT' });
  await assert.rejects(readLocation({ geolocation: null, secure: true }), { code: 'UNSUPPORTED' });
  await assert.rejects(readLocation({ geolocation: failing(1), secure: false }), { code: 'INSECURE' });
  // a permission prompt nobody answers does not leave the button spinning for ever
  const silent = { getCurrentPosition: () => {} };
  await assert.rejects(readLocation({ geolocation: silent, secure: true, watchdogSeconds: 0.05 }), { code: 'NO_ANSWER' });
  for (const code of ['DENIED', 'UNAVAILABLE', 'TIMEOUT', 'UNSUPPORTED', 'INSECURE', 'NO_ANSWER']) {
    assert.ok(LOCATION_PROBLEM[code].length > 20, `${code} explains what to do`);
  }
});

test('each attendance action gets its own id', () => {
  const a = newRequestId();
  const b = newRequestId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{8,80}$/, 'the server accepts the shape');
});

test('map links carry only the coordinates, and money is rupees with paise', () => {
  assert.equal(mapsLink(28.6139, 77.209), 'https://www.google.com/maps/search/?api=1&query=28.6139%2C77.209');
  assert.equal(money(28333.33), '₹28,333.33');
  assert.equal(money(null), '—');
});
