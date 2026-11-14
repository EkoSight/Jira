import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callPath, estimateFromAway, estimateMinutes, lengthWords, sameTarget, suggestCall, targetKey, telHref,
} from '../src/lib/phoneCalls.js';

test('a Call button goes through the app when it is there, else the dialler, and never without a number', () => {
  assert.equal(callPath({ bridge: {}, phone: '+91 98110 00001' }), 'APP');
  assert.equal(callPath({ bridge: null, phone: '98110 00001' }), 'DIALLER');
  assert.equal(callPath({ bridge: {}, phone: '' }), 'NONE');
  assert.equal(telHref('+91 98110-00001'), 'tel:+919811000001');
  assert.equal(telHref('12'), null);
});

test('the estimate is the time away from TaskFlow, and says so', () => {
  const dialledAt = '2026-11-14T10:00:00Z';
  assert.equal(estimateFromAway({ dialledAt, hiddenAt: '2026-11-14T10:00:02Z', visibleAt: '2026-11-14T10:04:10Z' }), 248);
  assert.equal(estimateFromAway({ dialledAt, visibleAt: '2026-11-14T10:03:00Z' }), 180, 'from the dial when the page never reported hiding');
  assert.equal(estimateFromAway({ dialledAt, visibleAt: '2026-11-14T10:00:03Z' }), null, 'a few seconds is not a call');
  assert.equal(estimateFromAway({ dialledAt, visibleAt: '2026-11-14T15:00:00Z' }), null, 'hours away is not a call');
  assert.equal(estimateMinutes(248), 4);
  assert.equal(lengthWords(248, 'ESTIMATED'), 'About 4 min · estimated');
  assert.equal(lengthWords(192, 'DEVICE_LOG'), '3m 12s · from the phone');
  assert.equal(lengthWords(9, 'RECORDING'), '9s · from the recording');
  assert.equal(lengthWords(70, 'CORRECTED'), '1m 10s · corrected');
  assert.equal(lengthWords(null, 'TYPED'), '—');
});

test('a shared recording is matched to the call that ended nearest its file time, skipping calls that have one', () => {
  const calls = [
    { id: 1, started_at: '2026-11-14T09:00:00Z', talk_sec: 60, has_recording: false },
    { id: 2, started_at: '2026-11-14T10:00:00Z', talk_sec: 300, has_recording: false },
    { id: 3, started_at: '2026-11-14T10:20:00Z', talk_sec: 30, has_recording: true },
  ];
  assert.equal(suggestCall(calls, '2026-11-14T10:05:05Z'), 2);
  assert.equal(suggestCall(calls, '2026-11-14T10:20:31Z'), 2, 'call 3 already has its recording');
  assert.equal(suggestCall(calls, '2026-11-14T18:00:00Z'), null, 'nothing within two hours');
});

test('a call belongs to the record it was made for', () => {
  assert.equal(targetKey({ lead_id: 4 }), 'lead:4');
  assert.equal(targetKey({ account_id: 2, contact_id: 9 }), 'contact:9');
  assert.ok(sameTarget({ lead_id: 4 }, { lead_id: 4 }));
  assert.ok(!sameTarget({ lead_id: 4 }, { lead_id: 5 }));
  assert.ok(sameTarget({ account_id: 2, opportunity_id: 7 }, { account_id: 2 }));
});

test('a phone’s make picks its setup steps; any other make waits for an administrator', async () => {
  const { brandOf } = await import('../src/lib/phoneCalls.js');
  assert.equal(brandOf('samsung'), 'samsung');
  assert.equal(brandOf('OPPO'), 'oppo');
  assert.equal(brandOf('OnePlus'), 'oppo', 'ColorOS phones run ODialer too');
  assert.equal(brandOf('motorola'), 'motorola');
  assert.equal(brandOf('Google'), null);
  assert.equal(brandOf(undefined), null);
});
