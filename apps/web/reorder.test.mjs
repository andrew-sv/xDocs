import * as Y from 'yjs';
import { resolveMove, resolveNudge, applyMove } from './src/lib/reorder.ts';

let fail = 0;
const ck = (l, ok) => {
  if (!ok) {
    console.log('FAIL  ' + l);
    fail++;
  }
};

const ids = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(97 + i), type: 'paragraph' }));

/** Run a drop through resolveMove + applyMove and return the resulting order. */
function drop(count, draggedId, targetId, edge) {
  const d = new Y.Doc();
  const arr = d.getArray('blocks');
  arr.push(ids(count));
  const blocks = arr.toArray();
  const m = resolveMove(blocks, draggedId, targetId, edge);
  if (m) applyMove(arr, m.from, m.to);
  return arr
    .toArray()
    .map((b) => b.id)
    .join('');
}

// a b c d
ck('drop a below b  -> bacd', drop(4, 'a', 'b', 'below') === 'bacd');
ck('drop a below d  -> bcda', drop(4, 'a', 'd', 'below') === 'bcda');
ck('drop a above d  -> bcad', drop(4, 'a', 'd', 'above') === 'bcad');
ck('drop d above a  -> dabc', drop(4, 'd', 'a', 'above') === 'dabc');
ck('drop d above b  -> adbc', drop(4, 'd', 'b', 'above') === 'adbc');
ck('drop c above b  -> acbd', drop(4, 'c', 'b', 'above') === 'acbd');
ck('drop b below c  -> acbd', drop(4, 'b', 'c', 'below') === 'acbd');

// No-ops must not reorder or duplicate.
ck('drop a above a is no-op', drop(4, 'a', 'a', 'above') === 'abcd');
ck('drop a below a is no-op', drop(4, 'a', 'a', 'below') === 'abcd');
ck('drop a above b is no-op', drop(4, 'a', 'b', 'above') === 'abcd');
ck('drop b below a is no-op', drop(4, 'b', 'a', 'below') === 'abcd');
ck('resolveMove returns null for no-op', resolveMove(ids(4), 'a', 'b', 'above') === null);
ck('resolveMove null for unknown id', resolveMove(ids(4), 'z', 'b', 'above') === null);
ck('two blocks swap', drop(2, 'a', 'b', 'below') === 'ba');

// Keyboard nudges
function nudge(count, id, dir) {
  const d = new Y.Doc();
  const arr = d.getArray('blocks');
  arr.push(ids(count));
  const m = resolveNudge(arr.toArray(), id, dir);
  if (m) applyMove(arr, m.from, m.to);
  return arr
    .toArray()
    .map((b) => b.id)
    .join('');
}
ck('nudge b up    -> bacd', nudge(4, 'b', -1) === 'bacd');
ck('nudge a down  -> bacd', nudge(4, 'a', 1) === 'bacd');
ck('nudge c down  -> abdc', nudge(4, 'c', 1) === 'abdc');
ck('nudge d down clamps', nudge(4, 'd', 1) === 'abcd');
ck('nudge a up clamps', nudge(4, 'a', -1) === 'abcd');
ck(
  'nudge round-trips',
  (() => {
    const d = new Y.Doc();
    const a = d.getArray('b');
    a.push(ids(4));
    let m = resolveNudge(a.toArray(), 'a', 1);
    applyMove(a, m.from, m.to);
    m = resolveNudge(a.toArray(), 'a', -1);
    applyMove(a, m.from, m.to);
    return a
      .toArray()
      .map((x) => x.id)
      .join('');
  })() === 'abcd',
);

// Every permutation of drop must preserve the exact set of blocks.
for (const from of 'abcd')
  for (const to of 'abcd')
    for (const e of ['above', 'below']) {
      const r = drop(4, from, to, e);
      if ([...r].sort().join('') !== 'abcd') {
        console.log(`FAIL  lost/duplicated block: ${from}->${to} ${e} = ${r}`);
        fail++;
      }
    }

// A moved block must keep its own rich-text fragment.
const d = new Y.Doc();
const arr = d.getArray('blocks');
arr.push(ids(3));
d.getXmlFragment('block-a').insert(0, [new Y.XmlText('content of a')]);
const m = resolveMove(arr.toArray(), 'a', 'c', 'below');
applyMove(arr, m.from, m.to);
ck(
  'moved block keeps its fragment',
  d.getXmlFragment('block-a').toString().includes('content of a'),
);
ck(
  'order after fragment move',
  arr
    .toArray()
    .map((b) => b.id)
    .join('') === 'bca',
);

// Shift+Enter inserts directly below the current block (DocumentEditor's
// handleInsertBelow: find the index, insert at index + 1).
function insertBelow(count, afterId) {
  const d = new Y.Doc();
  const arr = d.getArray('blocks');
  arr.push(ids(count));
  const i = arr.toArray().findIndex((b) => b.id === afterId);
  arr.insert(i + 1, [{ id: 'n', type: 'paragraph' }]);
  return arr
    .toArray()
    .map((b) => b.id)
    .join('');
}
ck('insert below first block', insertBelow(3, 'a') === 'anbc');
ck('insert below middle block', insertBelow(3, 'b') === 'abnc');
ck('insert below last block', insertBelow(3, 'c') === 'abcn');
ck('insert below only block', insertBelow(1, 'a') === 'an');

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
process.exit(fail ? 1 : 0);
