import test from 'node:test';
import assert from 'node:assert/strict';
import {
  designHasHindi, insertAt, insertNode, monthGrid, moveItem, needsValue, newBlock, newCondition, nodeSummary, pathTree,
  percent, pick, removeNode, setLang, skipWords, sourceWords, triggerSummary, withIds,
} from '../src/lib/marketing.js';

test('blocks move to where they are dropped', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(list, 0, 3), ['b', 'c', 'a', 'd'], 'dropped above d');
  assert.deepEqual(moveItem(list, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(list, 1, 4), ['a', 'c', 'd', 'b'], 'dropped at the end');
  assert.deepEqual(moveItem(list, 2, 2), list);
  assert.deepEqual(insertAt(list, 1, 'x'), ['a', 'x', 'b', 'c', 'd']);
});

test('every new block has an id and both languages ready', () => {
  const a = newBlock('text');
  const b = newBlock('text');
  assert.notEqual(a.id, b.id);
  assert.equal(typeof a.text.hi, 'string');
  const design = withIds({ blocks: [{ type: 'heading', text: 'Hi' }] });
  assert.ok(design.blocks[0].id);
});

test('a field is read and written per language', () => {
  assert.equal(pick({ en: 'Hello', hi: 'नमस्ते' }, 'hi'), 'नमस्ते');
  assert.equal(pick('Hello', 'hi'), '', 'plain text is English');
  assert.deepEqual(setLang('Hello', 'hi', 'नमस्ते'), { en: 'Hello', hi: 'नमस्ते' });
  assert.equal(designHasHindi({ blocks: [{ type: 'text', text: { en: 'x', hi: '' } }] }), false);
  assert.equal(designHasHindi({ blocks: [{ type: 'text', text: { en: 'x', hi: 'नमस्ते' } }] }), true);
});

test('adding a step keeps what came after it', () => {
  let graph = { start: null, nodes: {} };
  let r = insertNode(graph, { parent: null }, 'email');
  graph = r.graph;
  const first = r.id;
  r = insertNode(graph, { parent: first, branch: 'next' }, 'delay');
  graph = r.graph;
  const delay = r.id;
  // a condition added between the email and the wait takes the wait as its "yes"
  r = insertNode(graph, { parent: first, branch: 'next' }, 'condition');
  graph = r.graph;
  assert.equal(graph.nodes[first].next, r.id);
  assert.equal(graph.nodes[r.id].yes, delay);
  const tree = pathTree(graph);
  assert.equal(tree.length, 2);
  assert.equal(tree[1].yes[0].id, delay);
  assert.deepEqual(tree[1].no, []);
});

test('removing a step joins its neighbours; removing an if/else keeps the yes path', () => {
  const graph = {
    start: 'e1',
    nodes: {
      e1: { type: 'email', next: 'c1' },
      c1: { type: 'condition', yes: 'a1', no: 'e2' },
      a1: { type: 'action', next: null },
      e2: { type: 'email', next: 'a2' },
      a2: { type: 'action', next: null },
    },
  };
  const noCondition = removeNode(graph, 'c1');
  assert.equal(noCondition.nodes.e1.next, 'a1');
  assert.deepEqual(Object.keys(noCondition.nodes).sort(), ['a1', 'e1'], 'the no path goes with it');
  const noFirst = removeNode(graph, 'e1');
  assert.equal(noFirst.start, 'c1');
  const noMiddle = removeNode(graph, 'e2');
  assert.equal(noMiddle.nodes.c1.no, 'a2');
});

test('triggers and steps are described in words', () => {
  assert.equal(triggerSummary({ type: 'AUDIENCE_JOINED', audience_id: 3 }, { audiences: [{ id: 3, name: 'Farmers' }] }), 'Joins Farmers');
  assert.equal(triggerSummary({ type: 'FESTIVAL', days_before: 2, festival_ids: [1] }, { festivals: [{ id: 1, name: 'Diwali' }] }), '2 day(s) before Diwali');
  assert.equal(nodeSummary({ type: 'delay', config: { amount: 3, unit: 'days' } }), '3 days');
  assert.equal(nodeSummary({ type: 'condition', config: { kind: 'tag', value: 'dealer' } }), 'Has a tag: dealer');
});

test('why an email was not sent reads as a reason', () => {
  assert.equal(skipWords('SUPPRESSED_HARD_BOUNCE'), 'Blocked: the address bounced');
  assert.equal(skipWords('FREQUENCY_LIMIT'), 'Already emailed as often as the limit allows');
  assert.equal(skipWords('ADDRESS_COMPLAINED'), 'Address marked as spam');
  assert.equal(sourceWords('PROVIDER:ses'), 'Reported by SES');
  assert.equal(sourceWords('PROVIDER:log'), 'Reported by the outbox');
});

test('segment conditions start with a sensible operator and value', () => {
  const operators = { text: ['is', 'contains'], date: ['within_days'], tag: ['has'] };
  assert.deepEqual(newCondition({ key: 'state', type: 'text' }, operators), { field: 'state', op: 'is', value: '' });
  assert.equal(newCondition({ key: 'last_opened_at', type: 'date' }, operators).value, 30);
  assert.equal(needsValue('empty'), false);
  assert.equal(needsValue('contains'), true);
});

test('percentages show a dash when there is nothing to measure', () => {
  assert.equal(percent(null), '—');
  assert.equal(percent(12.5), '12.5%');
  assert.equal(percent(40), '40%');
});

test('the calendar month starts on a Monday and covers whole weeks', () => {
  const weeks = monthGrid(2026, 9); // October 2026 begins on a Thursday
  assert.equal(weeks[0][0].date, '2026-09-28');
  assert.equal(weeks[0][3].date, '2026-10-01');
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(weeks.at(-1).at(-1).date, '2026-11-01');
});
