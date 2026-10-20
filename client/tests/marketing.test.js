import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS, NUMBERS_BLOCKS, blockSummary, designHasHindi, fileSlug, insertAt, insertNode, monthGrid, moveItem, needsValue, newBlock, newCondition,
  newItem, nodeSummary, pathTree, percent, pick, removeNode, setLang, skipWords, sourceWords, templateSource, triggerSummary, withIds, withoutExample,
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

test('every brand section starts with content to edit, and figures start as examples to replace', () => {
  const placed = Object.entries(BLOCKS).filter(([, b]) => b.group !== 'legacy').map(([type]) => type);
  for (const type of placed) {
    const block = newBlock(type);
    assert.equal(block.type, type);
    assert.equal(Boolean(block.example), NUMBERS_BLOCKS.includes(type), `${type} example flag`);
    // nothing a new section offers is a free colour: only the brand's own choices
    assert.doesNotMatch(JSON.stringify(block), /#[0-9a-f]{3,6}\b|"color"/i, `${type} has no colour of its own`);
  }
  assert.ok(!placed.includes('columns'), 'the older two-column block is not offered for new emails');
  assert.equal(newBlock('hero').button.style, 'primary');
  assert.equal(newBlock('stats').items.length, 2);
  assert.deepEqual(Object.keys(newItem('data')).sort(), ['label', 'level', 'status', 'value']);
  const edited = withoutExample({ ...newBlock('stats'), note: { en: 'Real', hi: '' } });
  assert.equal('example' in edited, false);
});

test('the outline names each section by its own words', () => {
  assert.equal(blockSummary({ type: 'hero', title: { en: 'Sow with the right dose', hi: 'सही मात्रा' } }), 'Sow with the right dose');
  assert.equal(blockSummary({ type: 'hero', title: { en: 'Sow', hi: 'बुवाई' } }, 'hi'), 'बुवाई');
  assert.equal(blockSummary({ type: 'stats', items: [{ value: '62%', label: 'low zinc' }, { value: '38', label: 'villages' }] }), '62% low zinc · 38 villages');
  assert.equal(blockSummary({ type: 'details', items: [{ label: 'Date', value: '14 Nov' }] }), 'Date: 14 Nov');
  assert.equal(blockSummary({ type: 'text', text: 'Hello **there**, [book](https://x.in)' }), 'Hello there, book');
  assert.equal(blockSummary({ type: 'pulse' }), '');
});

test('templates are named for files and by where they came from', () => {
  assert.equal(fileSlug('Rabi advisory — Sehore!'), 'rabi-advisory-sehore');
  assert.equal(fileSlug(''), 'template');
  assert.equal(templateSource('starter:welcome'), 'From a starter');
  assert.equal(templateSource('upload:html'), 'Uploaded HTML');
  assert.equal(templateSource(null), 'Designed here');
});

test('a field is read and written per language', () => {
  assert.equal(pick({ en: 'Hello', hi: 'नमस्ते' }, 'hi'), 'नमस्ते');
  assert.equal(pick('Hello', 'hi'), '', 'plain text is English');
  assert.deepEqual(setLang('Hello', 'hi', 'नमस्ते'), { en: 'Hello', hi: 'नमस्ते' });
  assert.equal(designHasHindi({ blocks: [{ type: 'text', text: { en: 'x', hi: '' } }] }), false);
  assert.equal(designHasHindi({ blocks: [{ type: 'text', text: { en: 'x', hi: 'नमस्ते' } }] }), true);
  assert.equal(designHasHindi({ blocks: [{ type: 'cards', items: [{ title: { en: 'x', hi: 'ब' } }] }] }), true, 'Hindi inside a section’s items counts');
  assert.equal(designHasHindi({ blocks: [{ type: 'text', text: { en: 'x' }, condition: { type: 'language', hi: 'x' } }] }), false);
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
