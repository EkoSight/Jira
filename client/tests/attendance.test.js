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

/** A pretend device: GPS readings arrive over time; a network fix on request. */
function device({ gps = [], gpsError = null, network = null, networkError = null, clock = () => Date.now() } = {}) {
  const calls = [];
  const timers = [];
  return {
    calls,
    cleanup: () => timers.forEach(clearTimeout),
    watchPosition(ok, fail, options) {
      calls.push({ kind: 'watch', options });
      for (const [afterMs, accuracy] of gps) {
        timers.push(setTimeout(() => ok({ coords: { latitude: 28.61, longitude: 77.2, accuracy }, timestamp: clock() - 400 }), afterMs));
      }
      if (gpsError) timers.push(setTimeout(() => fail({ code: gpsError }), 5));
      return 7;
    },
    clearWatch(id) { calls.push({ kind: 'clear', id }); },
    getCurrentPosition(ok, fail, options) {
      calls.push({ kind: 'current', options });
      if (networkError) { fail({ code: networkError }); return; }
      if (network) ok({ coords: { latitude: 28.62, longitude: 77.21, accuracy: network }, timestamp: clock() - 2000 });
    },
  };
}
const read = (dev, extra = {}) => readLocation({ timeoutSeconds: 0.2, fallbackSeconds: 0.1, settleSeconds: 0.1, geolocation: dev, secure: true, ...extra }).finally(dev.cleanup);

test('a good GPS fix is taken the moment it arrives, fresh and precise', async () => {
  const dev = device({ gps: [[10, 120], [30, 18]] });
  const reading = await read(dev);
  assert.equal(reading.accuracy, 18);
  assert.equal(reading.method, 'GPS');
  assert.ok(reading.age_ms >= 0 && reading.age_ms < 5000, 'age measured on the device');
  assert.deepEqual(dev.calls[0].options, { enableHighAccuracy: true, maximumAge: 0, timeout: 200 });
  assert.ok(dev.calls.some((c) => c.kind === 'clear'), 'the watch is stopped');
  assert.ok(!dev.calls.some((c) => c.kind === 'current'), 'no fallback was needed');
});

test('inside a building: a rough GPS fix gets a moment to sharpen, then the best is used rather than giving up', async () => {
  const dev = device({ gps: [[10, 900], [40, 350], [70, 600]] });
  const started = Date.now();
  const reading = await read(dev);
  assert.equal(reading.accuracy, 350, 'the best of what arrived');
  assert.equal(reading.method, 'GPS');
  assert.ok(Date.now() - started < 190, 'taken once it stopped improving, before the deadline');

  // a fix that never improves is still taken, after the settle window
  const steady = device({ gps: [[10, 1200]] });
  assert.equal((await read(steady)).accuracy, 1200);
});

test('no GPS at all: a Wi-Fi / network fix is taken instead, and recorded as such', async () => {
  const dev = device({ gps: [], network: 1500 });
  const reading = await read(dev);
  assert.equal(reading.accuracy, 1500);
  assert.equal(reading.method, 'NETWORK');
  const fallback = dev.calls.find((c) => c.kind === 'current');
  assert.equal(fallback.options.enableHighAccuracy, false);

  // GPS failing fast goes to the fallback too, without waiting out the deadline
  const quick = device({ gpsError: 2, network: 2200 });
  const started = Date.now();
  assert.equal((await read(quick)).method, 'NETWORK');
  assert.ok(Date.now() - started < 150);
});

test('a browser without watchPosition still works', async () => {
  const dev = device({ network: 30 });
  delete dev.watchPosition;
  const reading = await read(dev);
  assert.equal(reading.accuracy, 30);
});

test('an old iPhone timestamp from another epoch gives an unknown age, not a wrong one', async () => {
  const dev = device({ gps: [[5, 20]], clock: () => 978_307_200_000 + 1_000_000 });
  const reading = await read(dev, { now: () => Date.now() });
  assert.equal(reading.age_ms, null);
});

test('no reading means a reason, never a substitute location', async () => {
  const failing = (code) => device({ gpsError: code, networkError: code });
  await assert.rejects(read(failing(1)), { code: 'DENIED' });
  await assert.rejects(read(failing(2)), { code: 'UNAVAILABLE' });
  await assert.rejects(read(failing(3)), { code: 'TIMEOUT' });
  await assert.rejects(read(device({ gps: [], networkError: 3 })), { code: 'TIMEOUT' });
  await assert.rejects(readLocation({ geolocation: null, secure: true }), { code: 'UNSUPPORTED' });
  await assert.rejects(readLocation({ geolocation: failing(1), secure: false }), { code: 'INSECURE' });
  // a permission prompt nobody answers does not leave the button spinning for ever
  const silent = { watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: () => {} };
  await assert.rejects(readLocation({ geolocation: silent, secure: true, timeoutSeconds: 5, watchdogSeconds: 0.05 }), { code: 'NO_ANSWER' });
  for (const code of ['DENIED', 'UNAVAILABLE', 'TIMEOUT', 'UNSUPPORTED', 'INSECURE', 'NO_ANSWER']) {
    assert.ok(LOCATION_PROBLEM[code].length > 20, `${code} explains what to do`);
  }
  assert.match(LOCATION_PROBLEM.TIMEOUT, /Wi-Fi/, 'the indoor advice is given');
});

test('accuracy is described honestly', async () => {
  const { accuracyWords } = await import('../src/lib/attendance.js');
  assert.equal(accuracyWords(12), '±12 m');
  assert.match(accuracyWords(350), /rough, as expected indoors/);
  assert.match(accuracyWords(2400), /2\.4 km — approximate/);
  assert.equal(accuracyWords(0), 'accuracy unknown');
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
