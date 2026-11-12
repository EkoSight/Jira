/**
 * The daily standup's content rules, without a database: reading what people
 * post in Chat, and the review's checks and wording. Synthetic text only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  feedbackText, isMeasurable, isVagueAction, normaliseForm, parseClock, parseDate, parseStandupText, reminderText,
  reviewContent, taskReference,
} from '../src/lib/standup.js';

const TODAY = '2026-11-16';
const GOOD = `@TaskFlow standup
Name | Date | Role
Asha Rao | 16 Nov 2026 | Sales executive
1. SLS-12 | Call the dealers on the Kanpur list | call notes logged in TaskFlow | 12:30
2. https://taskflow.example/?task=41 | Send the revised quotation | quotation PDF sent to the client | 3pm
3. OPS-7 | Draft the stock reconciliation | reconciliation sheet shared with accounts | 17:00
Blockers: Need price approval | Owner: Rahul | By: 11:00`;

test('reads the template, with or without the header row, bullets and a mention', () => {
  const p = parseStandupText(GOOD, { today: TODAY });
  assert.equal(p.name, 'Asha Rao');
  assert.equal(p.date, TODAY);
  assert.equal(p.role, 'Sales executive');
  assert.equal(p.items.length, 3);
  assert.deepEqual(p.items[1], { task: 'https://taskflow.example/?task=41', action: 'Send the revised quotation', target: 'quotation PDF sent to the client', done_by: 15 * 3600, done_by_text: '3pm' });
  assert.deepEqual(p.blockers, [{ text: 'Need price approval', owner: 'Rahul', needed_by: 11 * 3600 }]);
  assert.deepEqual(p.problems, []);
  const none = parseStandupText('Asha Rao | today | Sales\n- SLS-1 | a | b | 10:00\nBlockers: none', { today: TODAY });
  assert.equal(none.no_blockers, true);
  assert.equal(none.blockers.length, 0);
});

test('dates, times and task references in the forms people actually type', () => {
  for (const d of ['16 Nov 2026', '16/11/2026', '2026-11-16', 'Mon, 16 Nov', 'Nov 16, 2026', 'today']) assert.equal(parseDate(d, TODAY), TODAY, d);
  assert.equal(parseDate('16 Nob', TODAY), null);
  assert.equal(parseClock('09:30'), 9.5 * 3600);
  assert.equal(parseClock('3:30 pm'), 15.5 * 3600);
  assert.equal(parseClock('12am'), 0);
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock('by 17:00'), 17 * 3600);
  assert.deepEqual(taskReference('SLS-12'), { ref: 'SLS-12', text: 'SLS-12' });
  assert.equal(taskReference('https://taskflow.example/?task=41').taskId, 41);
  assert.equal(taskReference('the dealer thing'), null);
});

test('a clear plan passes the review untouched', () => {
  const p = parseStandupText(GOOD, { today: TODAY });
  const tasks = new Map([
    ['SLS-12', { exists: true, ref: 'SLS-12', stage: 'todo' }],
    ['https://taskflow.example/?task=41', { exists: true, ref: 'SLS-14', stage: 'todo' }],
    ['OPS-7', { exists: true, ref: 'OPS-7', stage: 'in_progress' }],
  ]);
  assert.deepEqual(reviewContent(p, { submittedAtSeconds: 9.6 * 3600, tasks }), []);
});

test('vague or unmeasurable plans get specific findings, item by item', () => {
  const p = parseStandupText(`Ravi Kumar | today | Operations
1. OPS-9 | work on | progress | 12:00
2. follow up with vendor | follow up | done |
Blockers: waiting`, { today: TODAY });
  const findings = reviewContent(p, { submittedAtSeconds: 13 * 3600, tasks: new Map([['OPS-9', { exists: false }]]) });
  const codes = findings.map((f) => `${f.code}:${f.item ?? '-'}`);
  for (const expected of ['TOO_FEW_ITEMS:-', 'TASK_NOT_FOUND:1', 'VAGUE_ACTION:1', 'NOT_MEASURABLE:1', 'TIME_PASSED:1',
    'NO_TASK:2', 'VAGUE_ACTION:2', 'NOT_MEASURABLE:2', 'NO_TIME:2', 'BLOCKER_NO_OWNER:-', 'BLOCKER_NO_TIME:-']) {
    assert.ok(codes.includes(expected), `${expected} in ${codes.join(', ')}`);
  }
});

test('a number someone writes is their own plan — never compared with a quota', () => {
  // any count is measurable as written; a different count is not "wrong"
  for (const target of ['3 calls logged', '30 calls logged', '1 visit report']) assert.equal(isMeasurable(target), true, target);
  const p = parseStandupText('Asha Rao | today | Sales\n1. SLS-1 | Call dealers | 2 calls logged | 12:00', { today: TODAY });
  const findings = reviewContent(p, { minItems: 1, tasks: new Map([['SLS-1', { exists: true, ref: 'SLS-1', stage: 'todo' }]]) });
  assert.deepEqual(findings, []);
});

test('the words: what counts as vague, and what can be checked', () => {
  for (const a of ['work on', 'check', 'follow up', 'misc', 'work on task']) assert.equal(isVagueAction(a), true, a);
  for (const a of ['Call the three distributors in Lucknow', 'Draft the training deck', 'check the invoice list against the ledger']) assert.equal(isVagueAction(a), false, a);
  for (const t of ['done', 'progress', 'as much as possible', '', 'update']) assert.equal(isMeasurable(t), false, t);
  for (const t of ['draft shared with Meera', 'invoice sent', 'report uploaded']) assert.equal(isMeasurable(t), true, t);
});

test('feedback is polite, specific, and about the plan only — no suggested numbers', () => {
  const findings = [{ code: 'NOT_MEASURABLE', item: 2, message: 'Item 2 (OPS-9): the target “progress” can’t be checked at the end of the day — say what will exist or be finished when it is done (a document, a reply, a count you set yourself).' }];
  const text = feedbackText({ firstName: 'Ravi', findings, link: 'https://taskflow.example/standup' });
  assert.match(text, /^Thanks, Ravi\./);
  assert.match(text, /Item 2 \(OPS-9\)/);
  assert.match(text, /says nothing about your effort/);
  assert.doesNotMatch(text, /\b(must|failed|lazy|warning|black mark)\b/i);
});

test('the reminder carries the template and no sales figures', () => {
  const text = reminderText({ dateLabel: 'Monday, 16 November', deadline: '09:40', link: 'https://taskflow.example/standup' });
  assert.match(text, /Name \| Date \| Role/);
  assert.match(text, /by \*09:40\*/);
  assert.match(text, /share a login, write your own name/);
  assert.doesNotMatch(text, /₹|dealers?|calls?|leads?|sales/i);
});

test('the form is read the same way as Chat', () => {
  const c = normaliseForm({
    name: 'Asha Rao', role: 'Sales executive',
    items: [{ task: 'SLS-12', action: 'Call', target: 'notes logged', done_by: '12:30' }],
    blockers: [{ text: '', owner: '' }],
  }, { today: TODAY });
  assert.equal(c.items[0].done_by, 12.5 * 3600);
  assert.equal(c.blockers.length, 0, 'an empty blocker row is no blocker');
  assert.equal(c.no_blockers, true);
});
