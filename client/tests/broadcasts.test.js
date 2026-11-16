import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROADCAST_VIEWS, broadcastFilters, fillBlanks, filterWords, roomWords, standingWords, variablesFor,
} from '../src/lib/broadcasts.js';

test('a broadcast keeps only the lead list\'s filters, and a usable view', () => {
  assert.deepEqual(broadcastFilters('all', { category: 'RETAILER', district: ' Sample District ', sort: 'newest', for_user: '4', q: '', cf_crop: 'wheat' }),
    { view: 'all', category: 'RETAILER', district: 'Sample District', cf_crop: 'wheat' });
  assert.equal(broadcastFilters('telecrm', {}).view, 'open', 'the routing queues are not broadcast lists');
  assert.ok(!BROADCAST_VIEWS.includes('archived'));
});

test('the list in words', () => {
  const words = filterWords({ view: 'all', category: 'RETAILER', owner_id: '7', district: 'Sample District', wa_optin: 'yes' }, {
    categories: { RETAILER: { label: 'Retailer' } }, users: [{ id: 7, full_name: 'Mona Sample' }],
  });
  assert.deepEqual(words, ['All leads (not archived)', 'Retailer', 'Owner Mona Sample', 'District Sample District', 'Agreed to WhatsApp']);
  assert.deepEqual(filterWords({}), ['Open leads']);
});

test('blanks are filled, a missing one stays visible', () => {
  assert.equal(fillBlanks('Namaste {{1}}, your {{2}} offer', ['Asha', 'soil test']), 'Namaste Asha, your soil test offer');
  assert.equal(fillBlanks('Namaste {{1}}, in {{3}}', ['Asha']), 'Namaste Asha, in {{3}}');
});

test('one entry per blank, keeping what was chosen', () => {
  assert.deepEqual(variablesFor(2, [{ source: 'first_name', fallback: 'farmer' }]),
    [{ source: 'first_name', text: '', fallback: 'farmer' }, { source: '', text: '', fallback: '' }]);
  assert.deepEqual(variablesFor(0, [{ source: 'x' }]), []);
});

test('where a number stands, in a sentence', () => {
  assert.match(standingWords(null), /No phone number/);
  assert.match(standingWords({ phone: '91', opted_out: { reason: 'Replied "STOP"' } }), /^Opted out of WhatsApp \(Replied "STOP"\)/);
  assert.equal(standingWords({ phone: '91', optin: { how: 'ON_CALL', recorded_by_name: 'Mona Sample' } }), 'Agreed on a call to WhatsApp messages, recorded by Mona Sample.');
  assert.match(standingWords({ phone: '91', wrote_first_at: '2026-11-01' }), /Wrote to us on WhatsApp first/);
  assert.match(standingWords({ phone: '91' }), /No WhatsApp opt-in recorded/);
});

test('the sending room in words', () => {
  assert.equal(roomWords({ sent_last_24h: 12, left_today: 238, dailyLimit: 250, sendFrom: '09:00', sendUntil: '20:00' }),
    '12 of 250 broadcast messages sent in the last 24 hours · sending hours 09:00–20:00');
  assert.equal(roomWords(null), '');
});
