/**
 * My workspace in the browser: editing a draft layout (move, place, add,
 * remove, width) and how dates read ("Tue 17 Nov, in 3 days"; a date with no
 * time is never given one).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  daysBetween, layoutBody, layoutChanged, moveWidget, newWidget, placeWidget, relativeDays, removeWidget, updateWidget, whenWords,
} from '../src/lib/workspace.js';
import { boardLink, taskWidgetFilters } from '../../shared/workspaceWidgets.js';
import { addDays } from '../../shared/deadlineHealth.js';

const L = [
  { id: 'a', type: 'today', typeVersion: 1, width: 'half', config: {} },
  { id: 'b', type: 'attention', typeVersion: 1, width: 'half', config: {} },
  { id: 'c', type: 'my_tasks', typeVersion: 1, width: 'full', config: {} },
];

test('Move up and Move down, with nothing past either end', () => {
  assert.deepEqual(moveWidget(L, 1, -1).map((w) => w.id), ['b', 'a', 'c']);
  assert.deepEqual(moveWidget(L, 1, 1).map((w) => w.id), ['a', 'c', 'b']);
  assert.equal(moveWidget(L, 0, -1), L);
  assert.equal(moveWidget(L, 2, 1), L);
});

test('drag and drop places a widget where it is dropped', () => {
  assert.deepEqual(placeWidget(L, 'c', 'a').map((w) => w.id), ['c', 'a', 'b']);
  assert.equal(placeWidget(L, 'a', 'a'), L);
});

test('a new widget gets an id nobody has; removing hides it from the draft only', () => {
  const w = newWidget('deals', [...L, { id: 'w4', type: 'x' }]);
  assert.equal(w.id, 'w5');
  assert.equal(w.width, 'half');
  assert.deepEqual(removeWidget(L, 'b').map((x) => x.id), ['a', 'c']);
  assert.equal(L.length, 3, 'the saved list is untouched');
});

test('width and settings change the draft; Save is offered only when something changed', () => {
  assert.equal(layoutChanged(L, L.map((x) => ({ ...x, available: true }))), false, 'what the server adds is not a change');
  const wide = updateWidget(L, 'a', { width: 'full' });
  assert.equal(layoutChanged(L, wide), true);
  const titled = updateWidget(L, 'c', { config: { title: 'Mine today' } });
  assert.equal(titled[2].config.title, 'Mine today');
  assert.deepEqual(Object.keys(layoutBody(titled.map((x) => ({ ...x, available: true, why: null })))[0]).sort(), ['config', 'id', 'type', 'typeVersion', 'width']);
});

test('dates read as an absolute date with a relative label; a date-only value gets no time', () => {
  const now = new Date('2026-11-14T06:00:00Z'); // Saturday 14 Nov, 11:30 in India
  assert.equal(whenWords({ date: '2026-11-17' }, { now }), 'Tue 17 Nov, in 3 days');
  assert.equal(whenWords({ date: '2026-11-14' }, { now }), 'Sat 14 Nov, today');
  assert.equal(whenWords({ date: '2026-11-13' }, { now }), 'Fri 13 Nov, yesterday');
  assert.equal(whenWords({ at: '2026-11-15T03:30:00Z' }, { now }), 'Sun 15 Nov 09:00, tomorrow');
  assert.equal(whenWords({ at: '2027-03-29T16:00:00Z' }, { now: new Date('2027-03-26T04:00:00Z') }), 'Mon 29 Mar 21:30, in 3 days');
  assert.equal(relativeDays(-5), '5 days ago');
  assert.equal(daysBetween('2027-03-26', '2027-03-29'), 3);
});

test('a task widget\'s filters are the board link it opens', () => {
  const f = taskWidgetFilters('deadlines', { range: 7 }, { userId: 4, departmentId: 2, today: '2026-11-14', addDays });
  assert.deepEqual(f, { stage: 'backlog,todo,in_progress,review,blocked', assignee_id: '4', due: 'range', due_from: '2026-11-14', due_to: '2026-11-20' });
  assert.equal(boardLink(f), '/board?stage=backlog%2Ctodo%2Cin_progress%2Creview%2Cblocked&assignee_id=4&due=range&due_from=2026-11-14&due_to=2026-11-20');
  assert.deepEqual(taskWidgetFilters('my_tasks', { scope: 'team' }, { userId: 4, departmentId: 2, today: '', addDays }), { stage: 'backlog,todo,in_progress,review,blocked', department_id: '2' });
});
