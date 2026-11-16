/**
 * To-dos in the browser: the words on the page, a paste split into lines,
 * Move up / Move down, and grouping by project (each line once, "No project"
 * last). Made-up content only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayLabel, doneWords, fromLabel, groupByProject, leftWords, moveKey, relativeDay, splitLines } from '../src/lib/todos.js';

test('a paste becomes one to-do per line, bullets and empty boxes taken off', () => {
  const text = '- Sample book hall\n\n* Sample print badges\n• Sample order tea\n1. Sample brief volunteers\n[ ] Sample test projector\n   \n';
  assert.deepEqual(splitLines(text), ['Sample book hall', 'Sample print badges', 'Sample order tea', 'Sample brief volunteers', 'Sample test projector']);
  assert.deepEqual(splitLines('One line only'), ['One line only']);
  assert.deepEqual(splitLines('Prepare Monday report'), ['Prepare Monday report'], 'the words are kept as written; no date is read');
});

test('days read as people say them; a carried line says where it came from, never "overdue"', () => {
  assert.equal(dayLabel('2027-01-15', '2027-01-18'), 'Fri 15 Jan');
  assert.equal(dayLabel('2026-11-13', '2027-01-18'), 'Fri 13 Nov 2026', 'another year shows the year');
  assert.equal(fromLabel('2027-01-15', '2027-01-18'), 'From Fri 15 Jan');
  assert.ok(!/overdue/i.test(fromLabel('2027-01-01', '2027-01-18')));
  assert.equal(relativeDay('2027-01-18', '2027-01-18'), 'Today, Mon 18 Jan');
  assert.equal(relativeDay('2027-01-19', '2027-01-18'), 'Tomorrow, Tue 19 Jan');
  assert.equal(dayLabel(null), 'Anytime');
  assert.equal(addDays('2027-01-31', 1), '2027-02-01');
  assert.equal(leftWords(3), '3 left');
  assert.equal(leftWords(0), 'Nothing left');
});

test('an old ticked step never gets an invented date', () => {
  assert.equal(doneWords({ done: true, done_date_unknown: true }), 'done (date not recorded)');
  assert.equal(doneWords({ done: true, done_at: '2027-01-18T05:00:00Z' }, '2027-01-18'), 'done Mon 18 Jan');
  assert.equal(doneWords({ done: false }), '');
});

test('Move up and Move down swap neighbours, and do nothing at the ends', () => {
  const keys = ['TODO:1', 'STEP:4', 'PIN:2'];
  assert.deepEqual(moveKey(keys, 'STEP:4', 'up'), ['STEP:4', 'TODO:1', 'PIN:2']);
  assert.deepEqual(moveKey(keys, 'STEP:4', 'down'), ['TODO:1', 'PIN:2', 'STEP:4']);
  assert.equal(moveKey(keys, 'TODO:1', 'up'), keys);
  assert.equal(moveKey(keys, 'PIN:2', 'down'), keys);
});

test('group by project: each line once, "No project" last', () => {
  const items = [
    { key: 'TODO:1', project: null },
    { key: 'TODO:2', project: { id: 7, name: 'Sample Seed Grant 2027' } },
    { key: 'STEP:3', project: { id: 7, name: 'Sample Seed Grant 2027' } },
    { key: 'PIN:4', project: { id: 3, name: 'Sample Partner Day' } },
  ];
  const groups = groupByProject(items);
  assert.deepEqual(groups.map((g) => g.label), ['Sample Partner Day', 'Sample Seed Grant 2027', 'No project']);
  assert.equal(groups.flatMap((g) => g.items).length, items.length);
});
