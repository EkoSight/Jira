import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_PROVIDED, dueState, durationWords, exactTime, importedAttempts, locationLine, locationRows, pinProblem, reminderWords,
} from '../src/lib/crmWork.js';

test('a PIN code is checked for shape only', () => {
  assert.equal(pinProblem(''), null);
  assert.equal(pinProblem('452001'), null);
  assert.equal(pinProblem('452 001'), null);
  assert.match(pinProblem('045200'), /six digits/);
  assert.match(pinProblem('45200'), /six digits/);
  assert.match(pinProblem('45200A'), /six digits/);
});

test('missing location reads "Not provided", never blank or made up', () => {
  assert.equal(locationLine({}), NOT_PROVIDED);
  assert.equal(locationLine(null), NOT_PROVIDED);
  assert.equal(locationLine({ city: 'Indore', district: 'Indore', state: 'Madhya Pradesh', pincode: '452001' }), 'Indore, Madhya Pradesh · 452001');
  assert.equal(locationLine({ city: 'Chomu', district: 'Jaipur', state: 'Rajasthan' }), 'Chomu, Jaipur district, Rajasthan');
  assert.equal(locationLine({ city: 'Kalmeshwar', block: 'Kalmeshwar', district: 'Nagpur', state: 'Maharashtra' }), 'Kalmeshwar, Nagpur district, Maharashtra');
  const rows = locationRows({ state: 'Kerala' });
  assert.deepEqual(rows[0], ['State', 'Kerala', false]);
  assert.deepEqual(rows.find(([label]) => label === 'PIN code'), ['PIN code', NOT_PROVIDED, true]);
});

test('a call time shows seconds and the time zone', () => {
  assert.match(exactTime('2026-11-13T11:45:42Z'), /13 Nov 2026, 5:15:42\s?pm IST/i);
  assert.equal(exactTime(null), '');
  assert.equal(durationWords(245), '4m 05s');
  assert.equal(durationWords(45), '45s');
  assert.equal(durationWords(null), '—');
});

test('reminder choices read as a sentence', () => {
  assert.equal(reminderWords([5, 30, 15], ['APP', 'CHAT']), '30, 15 and 5 minutes before, in TaskFlow and Google Chat');
  assert.equal(reminderWords([10], ['APP']), '10 minutes before, in TaskFlow');
  assert.equal(reminderWords([], ['APP']), 'No reminders');
});

test('due now and overdue', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  assert.equal(dueState('2026-11-13T10:03:00Z', now), 'DUE_NOW');
  assert.equal(dueState('2026-11-13T09:57:00Z', now), 'DUE_NOW');
  assert.equal(dueState('2026-11-13T09:50:00Z', now), 'OVERDUE');
  assert.equal(dueState('2026-11-13T11:00:00Z', now), 'AHEAD');
  assert.equal(dueState(null, now), null);
});

test('imported attempts are those beyond the outbound calls on record', () => {
  const calls = [{ direction: 'OUTBOUND' }, { direction: 'OUTBOUND', voided_at: '2026-11-13' }, { direction: 'INBOUND' }];
  assert.equal(importedAttempts({ call_attempts: 3 }, calls), 2);
  assert.equal(importedAttempts({ call_attempts: 1 }, calls), 0);
  assert.equal(importedAttempts({ call_attempts: 0 }, []), 0);
});

test('short times in India time', async () => {
  const { indiaTime } = await import('../src/lib/crmWork.js');
  assert.match(indiaTime('2026-11-13T11:45:42Z'), /13 Nov,? 5:15\s?pm/i);
  assert.equal(indiaTime(null), '');
});
