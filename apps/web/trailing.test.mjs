/**
 * A heading or list block must not grow an unremovable empty paragraph.
 *
 * StarterKit's TrailingNode appends a paragraph whenever the document's last
 * node is not one, and re-appends it as soon as you delete it. Correct for a
 * single whole-document editor; wrong when every block is its own editor.
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
  'KeyboardEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    writable: true,
    configurable: true,
  });
}

const { Editor } = await import('@tiptap/react');
const StarterKit = (await import('@tiptap/starter-kit')).default;

function build(trailingNode) {
  const element = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit.configure({ undoRedo: false, trailingNode })],
    content: '<p>hello</p>',
  });
}

/** Node count of the block after turning it into `kind`. */
function afterToggle(trailingNode, kind) {
  const editor = build(trailingNode);
  editor.commands.focus('end');
  if (kind === 'heading') editor.chain().focus().toggleHeading({ level: 1 }).run();
  if (kind === 'bulletList') editor.chain().focus().toggleBulletList().run();
  const count = editor.state.doc.childCount;
  const html = editor.getHTML();
  editor.destroy();
  return { count, html };
}

// The behaviour the user hit, pinned so the cause stays visible.
const headingOn = afterToggle(undefined, 'heading');
check('with trailingNode ON a heading gains a trailing paragraph', headingOn.count === 2);

const headingOff = afterToggle(false, 'heading');
check('with trailingNode OFF a heading is a single node', headingOff.count === 1);
check('heading block has no empty trailing <p>', !/<p><\/p>/.test(headingOff.html));

const listOff = afterToggle(false, 'bulletList');
check('with trailingNode OFF a list is a single node', listOff.count === 1);
check('list block has no empty trailing <p>', !/<p><\/p>/.test(listOff.html));

// The real complaint was that it could not be removed: it came back.
const editor = build(false);
editor.commands.focus('end');
editor.chain().focus().toggleHeading({ level: 1 }).run();
editor.commands.insertContentAt(editor.state.doc.content.size, '<p></p>');
const withExtra = editor.state.doc.childCount;
// Delete that trailing paragraph; nothing should put it back.
editor.commands.deleteRange({
  from: editor.state.doc.content.size - 2,
  to: editor.state.doc.content.size,
});
check('a manually added trailing paragraph stays deleted', editor.state.doc.childCount < withExtra);
editor.destroy();
