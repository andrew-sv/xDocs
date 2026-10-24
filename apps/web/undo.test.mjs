/**
 * Regression test for the shared-UndoManager lifecycle bug.
 *
 * Collaboration calls undoManager.destroy() when its editor view tears down.
 * Yjs's destroy() detaches the afterTransaction handler, so a manager shared
 * across block editors stops recording as soon as ANY block unmounts. Pure
 * CRDT tests cannot see this — it only happens on editor teardown.
 */
import { check } from '@xdocs/test-support/harness';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of [
  'window',
  'document',
  'DOMParser',
  'Node',
  'Element',
  'HTMLElement',
  'Text',
  'Range',
  'getComputedStyle',
  'MutationObserver',
]) {
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    writable: true,
    configurable: true,
  });
}

const { Editor } = await import('@tiptap/react');
const StarterKit = (await import('@tiptap/starter-kit')).default;
const Collaboration = (await import('@tiptap/extension-collaboration')).default;
const { ySyncPluginKey } = await import('@tiptap/y-tiptap');
const { DocumentUndo } = await import('./src/lib/documentUndo.ts');
const Y = await import('yjs');

function makeDoc() {
  const ydoc = new Y.Doc();
  const blocks = ydoc.getArray('blocks');
  const undoManager = new Y.UndoManager([blocks, ydoc.getText('title')], {
    trackedOrigins: new Set([null, ySyncPluginKey]),
  });
  return { ydoc, blocks, undoManager };
}

function makeEditor(ydoc, id, undoManager, { shareWithPlugin }) {
  const element = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      shareWithPlugin
        ? Collaboration.configure({
            fragment: ydoc.getXmlFragment(`block-${id}`),
            yUndoOptions: { undoManager },
          })
        : Collaboration.configure({ fragment: ydoc.getXmlFragment(`block-${id}`) }),
      ...(shareWithPlugin ? [] : [DocumentUndo.configure({ undoManager })]),
    ],
  });
}

/**
 * Does the manager still record a block deletion after one editor unmounts?
 *
 * clear() establishes a clean baseline AFTER setup: Yjs merges changes made
 * within captureTimeout (500ms) into a single stack item, so measuring growth
 * against a dirty stack would conflate the setup writes with the deletion.
 */
function stillRecordsAfterUnmount(shareWithPlugin) {
  const { ydoc, blocks, undoManager } = makeDoc();
  blocks.push([
    { id: 'a', type: 'paragraph' },
    { id: 'b', type: 'paragraph' },
  ]);
  const e1 = makeEditor(ydoc, 'a', undoManager, { shareWithPlugin });
  const e2 = makeEditor(ydoc, 'b', undoManager, { shareWithPlugin });
  undoManager.addToScope([ydoc.getXmlFragment('block-a'), ydoc.getXmlFragment('block-b')]);
  undoManager.clear();

  e2.destroy(); // one block unmounts, as on delete/remount
  blocks.delete(0, 1); // a subsequent structural change
  const recorded = undoManager.undoStack.length === 1;

  let restored = false;
  if (recorded) {
    undoManager.undo();
    restored = blocks.length === 2 && blocks.toArray()[0].id === 'a';
  }
  e1.destroy();
  return { recorded, restored };
}

// The old wiring, kept as an executable record of the bug.
const shared = stillRecordsAfterUnmount(true);
check(
  'old wiring (shared with plugin) stops recording after an unmount',
  shared.recorded === false,
);

// The shipped wiring.
const fixed = stillRecordsAfterUnmount(false);
check('fixed wiring still records after an unmount', fixed.recorded === true);
check('fixed wiring undo restores the deleted block', fixed.restored === true);

// And undo must survive several editors coming and going.
const { ydoc, blocks, undoManager } = makeDoc();
blocks.push([
  { id: 'a', type: 'paragraph' },
  { id: 'b', type: 'paragraph' },
  { id: 'c', type: 'paragraph' },
]);
const editors = ['a', 'b', 'c'].map((id) =>
  makeEditor(ydoc, id, undoManager, { shareWithPlugin: false }),
);
editors[1].destroy();
editors[2].destroy();
const remounted = makeEditor(ydoc, 'b', undoManager, { shareWithPlugin: false });
undoManager.clear();

blocks.delete(2, 1);
check('records after repeated mount/unmount churn', undoManager.undoStack.length === 1);
undoManager.undo();
check('undo restores after churn', blocks.length === 3 && blocks.toArray()[2].id === 'c');
editors[0].destroy();
remounted.destroy();
