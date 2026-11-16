/**
 * The notebook's pure logic (Part N): weeks and the month index, when a swipe
 * turns a page (never from the screen edge or while selecting text), the
 * page-turn and undo keys, the offline queue (kept in order, sent once, a
 * line added offline known by its temporary key until it has an id), and the
 * 20-step undo. Made-up content only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, applyQueue, isUndoKey, isoWeek, longDay, mondayOf, monthGrid, nextToSend, pageTurnKey, pushUndo, queueAdd,
  resolveTemp, shortDay, swipeDirection, UNDO_LIMIT,
} from '../src/lib/notebook.js';

test('the page header: the day written out, its ISO week, its Monday', () => {
  assert.equal(longDay('2026-11-16'), 'Monday 16 November');
  assert.equal(shortDay('2026-11-16'), 'Mon 16 Nov');
  assert.equal(isoWeek('2026-11-16'), 47);
  assert.equal(isoWeek('2027-01-01'), 53, '1 Jan 2027 belongs to week 53 of 2026');
  assert.equal(isoWeek('2027-01-04'), 1);
  assert.equal(mondayOf('2026-11-22'), '2026-11-16', 'Sunday belongs to the week that started on Monday');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
});

test('the month index: Monday-first weeks, blanks outside the month', () => {
  const nov = monthGrid('2026-11');
  assert.equal(nov[0].filter(Boolean)[0], '2026-11-01');
  assert.equal(nov[0].indexOf('2026-11-01'), 6, '1 Nov 2026 is a Sunday');
  assert.ok(nov.every((w) => w.length === 7));
  assert.equal(nov.flat().filter(Boolean).length, 30);
  assert.equal(monthGrid('2027-02').flat().filter(Boolean).length, 28);
});

test('44: a swipe turns the page, but not from the screen edge, not while selecting, not when scrolling', () => {
  const base = { startY: 400, endY: 410, screenWidth: 390 };
  assert.equal(swipeDirection({ ...base, startX: 300, endX: 120 }), 'next');
  assert.equal(swipeDirection({ ...base, startX: 100, endX: 300 }), 'previous');
  assert.equal(swipeDirection({ ...base, startX: 10, endX: 250 }), null, 'from the left edge: the phone’s back gesture');
  assert.equal(swipeDirection({ ...base, startX: 380, endX: 100 }), null, 'from the right edge');
  assert.equal(swipeDirection({ ...base, startX: 300, endX: 120, selecting: true }), null, 'selecting text');
  assert.equal(swipeDirection({ startX: 200, endX: 230, startY: 100, endY: 500, screenWidth: 390 }), null, 'a scroll');
  assert.equal(swipeDirection({ ...base, startX: 200, endX: 170 }), null, 'too short');
});

test('43: the page-turn keys are Alt+, and Alt+.; undo is Ctrl/Cmd+Z without Shift', () => {
  assert.equal(pageTurnKey({ altKey: true, code: 'Comma' }), 'previous');
  assert.equal(pageTurnKey({ altKey: true, code: 'Period' }), 'next');
  assert.equal(pageTurnKey({ altKey: false, code: 'Period' }), null);
  assert.equal(pageTurnKey({ altKey: true, ctrlKey: true, code: 'Period' }), null);
  assert.equal(isUndoKey({ ctrlKey: true, key: 'z' }), true);
  assert.equal(isUndoKey({ metaKey: true, key: 'z' }), true);
  assert.equal(isUndoKey({ ctrlKey: true, shiftKey: true, key: 'z' }), false, 'that is redo');
  assert.equal(isUndoKey({ key: 'z' }), false);
});

test('46: offline changes are kept in order, shown on the page, and a line added offline is known by its key until it has an id', () => {
  let q = [];
  q = queueAdd(q, { kind: 'add', target: 'TMP:k1', client_key: 'k1', body: { title: 'Sample A' }, at: '2026-11-16T05:00:00Z' });
  q = queueAdd(q, { kind: 'add', target: 'TMP:k2', client_key: 'k2', body: { title: 'Sample B' }, at: '2026-11-16T05:00:01Z' });
  q = queueAdd(q, { kind: 'tick', target: 'TMP:k1', body: { done: true }, at: '2026-11-16T05:00:02Z' });
  q = queueAdd(q, { kind: 'edit', target: 'TODO:7', body: { title: 'Sample C, changed' }, at: '2026-11-16T05:00:03Z' });
  q = queueAdd(q, { kind: 'note', target: 'NOTE:2026-11-16', body: { day: '2026-11-16', body: 'Sample note' }, at: '2026-11-16T05:00:04Z' });
  assert.deepEqual(q.map((o) => o.seq), [1, 2, 3, 4, 5]);
  assert.equal(nextToSend(q).target, 'TMP:k1', 'the first change goes first');

  const page = { day: '2026-11-16', carried: [], items: [{ key: 'TODO:7', title: 'Sample C', done: false }], note: { body: '' } };
  const shown = applyQueue(page, q);
  assert.deepEqual(shown.items.map((i) => [i.key, i.title, i.done]), [
    ['TODO:7', 'Sample C, changed', false], ['TMP:k1', 'Sample A', true], ['TMP:k2', 'Sample B', false],
  ]);
  assert.ok(shown.items.every((i) => i.sync === 'local'), 'each says "Saved on this device · will sync"');
  assert.equal(shown.note.body, 'Sample note');
  assert.equal(shown.left, 2);
  assert.equal(page.items[0].title, 'Sample C', 'the page itself is not changed');

  // once the first add is confirmed, the tick on it waits for nothing more
  const rest = resolveTemp(q.slice(1), 'TMP:k1', 41);
  assert.equal(rest.find((o) => o.kind === 'tick').target, 'TODO:41');
  assert.equal(rest.find((o) => o.kind === 'add').client_key, 'k2', 'the next add keeps its client key, so a resend makes no duplicate');
});

test('undo keeps the last 20 changes of the session', () => {
  let s = [];
  for (let i = 1; i <= 25; i += 1) s = pushUndo(s, { label: `change ${i}` });
  assert.equal(s.length, UNDO_LIMIT);
  assert.equal(s[0].label, 'change 6');
  assert.equal(s.at(-1).label, 'change 25');
});
