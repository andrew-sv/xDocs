import { check } from '@xdocs/test-support/harness';
import * as Y from 'yjs';
import { resolveMove, resolveNudge, applyMove } from './src/lib/reorder.ts';

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
check('drop a below b  -> bacd', drop(4, 'a', 'b', 'below') === 'bacd');
check('drop a below d  -> bcda', drop(4, 'a', 'd', 'below') === 'bcda');
check('drop a above d  -> bcad', drop(4, 'a', 'd', 'above') === 'bcad');
check('drop d above a  -> dabc', drop(4, 'd', 'a', 'above') === 'dabc');
check('drop d above b  -> adbc', drop(4, 'd', 'b', 'above') === 'adbc');
check('drop c above b  -> acbd', drop(4, 'c', 'b', 'above') === 'acbd');
check('drop b below c  -> acbd', drop(4, 'b', 'c', 'below') === 'acbd');

// No-ops must not reorder or duplicate.
check('drop a above a is no-op', drop(4, 'a', 'a', 'above') === 'abcd');
check('drop a below a is no-op', drop(4, 'a', 'a', 'below') === 'abcd');
check('drop a above b is no-op', drop(4, 'a', 'b', 'above') === 'abcd');
check('drop b below a is no-op', drop(4, 'b', 'a', 'below') === 'abcd');
check('resolveMove returns null for no-op', resolveMove(ids(4), 'a', 'b', 'above') === null);
check('resolveMove null for unknown id', resolveMove(ids(4), 'z', 'b', 'above') === null);
check('two blocks swap', drop(2, 'a', 'b', 'below') === 'ba');

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
check('nudge b up    -> bacd', nudge(4, 'b', -1) === 'bacd');
check('nudge a down  -> bacd', nudge(4, 'a', 1) === 'bacd');
check('nudge c down  -> abdc', nudge(4, 'c', 1) === 'abdc');
check('nudge d down clamps', nudge(4, 'd', 1) === 'abcd');
check('nudge a up clamps', nudge(4, 'a', -1) === 'abcd');
check(
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

// Every permutation of drop must preserve the exact set of blocks. One check
// over all 32, naming the ones that broke, rather than 32 checks of noise.
const lost = [];
for (const from of 'abcd')
  for (const to of 'abcd')
    for (const e of ['above', 'below']) {
      const r = drop(4, from, to, e);
      if ([...r].sort().join('') !== 'abcd') lost.push(`${from}->${to} ${e} = ${r}`);
    }
check(
  `no drop loses or duplicates a block${lost.length ? ` (${lost.join('; ')})` : ''}`,
  lost.length === 0,
);

// A moved block must keep its own rich-text fragment.
const d = new Y.Doc();
const arr = d.getArray('blocks');
arr.push(ids(3));
d.getXmlFragment('block-a').insert(0, [new Y.XmlText('content of a')]);
const m = resolveMove(arr.toArray(), 'a', 'c', 'below');
applyMove(arr, m.from, m.to);
check(
  'moved block keeps its fragment',
  d.getXmlFragment('block-a').toString().includes('content of a'),
);
check(
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
check('insert below first block', insertBelow(3, 'a') === 'anbc');
check('insert below middle block', insertBelow(3, 'b') === 'abnc');
check('insert below last block', insertBelow(3, 'c') === 'abcn');
check('insert below only block', insertBelow(1, 'a') === 'an');
