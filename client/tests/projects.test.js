/**
 * Projects in the browser: grouping tasks by project and by milestone (each
 * task exactly once), departments in order, and the words on the screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityWords, byDepartment, byMilestone, dateWords, groupByProject, progressWords } from '../src/lib/projects.js';

const tasks = [
  { id: 1, project_id: 7, project_name: 'Sample Seed Grant', milestone_id: 70 },
  { id: 2, project_id: null },
  { id: 3, project_id: 9, project_name: 'Sample warehouse move', milestone_id: null },
  { id: 4, project_id: 7, project_name: 'Sample Seed Grant', milestone_id: 71 },
  { id: 5, project_id: 7, project_name: 'Sample Seed Grant', milestone_id: 99 },
];

test('group by project: one group per project in first-seen order, "No project" last, every task once', () => {
  const groups = groupByProject(tasks);
  assert.deepEqual(groups.map((g) => g.name), ['Sample Seed Grant', 'Sample warehouse move', 'No project']);
  assert.deepEqual(groups.map((g) => g.tasks.map((t) => t.id)), [[1, 4, 5], [3], [2]]);
  assert.equal(groups.flatMap((g) => g.tasks).length, tasks.length);
  assert.deepEqual(groupByProject(tasks.filter((t) => t.project_id)).map((g) => g.name), ['Sample Seed Grant', 'Sample warehouse move'], 'no empty "No project" group');
});

test('by milestone: in the milestones\' order, a milestone from elsewhere falls into "No milestone"', () => {
  const groups = byMilestone(tasks.filter((t) => t.project_id === 7), [{ id: 71, name: 'Sample draft ready' }, { id: 70, name: 'Sample idea agreed' }]);
  assert.deepEqual(groups.map((g) => g.name), ['Sample draft ready', 'Sample idea agreed', 'No milestone']);
  assert.deepEqual(groups.map((g) => g.tasks.map((t) => t.id)), [[4], [1], [5]]);
  assert.deepEqual(byMilestone([], [{ id: 1, name: 'Sample empty' }]).map((g) => g.tasks.length), [0], 'empty milestones still show');
});

test('projects by department, in the order the server sent them', () => {
  const groups = byDepartment([
    { id: 1, department_id: 2, department_name: 'Operations' },
    { id: 2, department_id: 1, department_name: 'Programmes' },
    { id: 3, department_id: 2, department_name: 'Operations' },
  ]);
  assert.deepEqual(groups.map((g) => [g.name, g.projects.map((p) => p.id)]), [['Operations', [1, 3]], ['Programmes', [2]]]);
});

test('words: progress, dates with no timezone shift, activity', () => {
  assert.equal(progressWords({ total: 5, done: 2, progress: 40 }), '2 of 5 tasks done (40%)');
  assert.equal(progressWords({ total: 1, done: 1, progress: 100 }), '1 of 1 task done (100%)');
  assert.equal(progressWords({ total: 0 }), 'No tasks yet');
  assert.equal(dateWords('2027-03-29'), '29 Mar 2027');
  assert.equal(dateWords(null), '');
  assert.equal(activityWords({ action: 'milestone_removed', detail: { name: 'Sample venue', tasks_cleared: 2 } }), 'removed the milestone "Sample venue" (2 tasks kept, without it)');
  assert.equal(activityWords({ action: 'member_added', detail: { user_id: 4 } }, { 4: 'Omar Sample' }), 'added Omar Sample as a member');
  assert.equal(activityWords({ action: 'changed', detail: { field: 'status', to: 'ON_HOLD' } }), 'changed the status to On hold');
});
