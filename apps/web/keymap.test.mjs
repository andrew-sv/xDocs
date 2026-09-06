/**
 * Shift+Enter must insert a block below and NOT fall through to StarterKit's
 * HardBreak, which owns that key by default. Dispatches real KeyboardEvents at
 * the ProseMirror view, so it exercises the binding reaching its handler.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'DOMParser', 'Node', 'Element', 'HTMLElement', 'Text', 'Range', 'getComputedStyle', 'MutationObserver', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], writable: true, configurable: true });
}

const { Editor } = await import('@tiptap/react');
const StarterKit = (await import('@tiptap/starter-kit')).default;
const { BlockKeymap } = await import('./src/lib/blockKeymap.ts');

let fail = 0;
const ck = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) fail++; };

let calls = 0;
const element = dom.window.document.createElement('div');
dom.window.document.body.appendChild(element);

const editor = new Editor({
  element,
  extensions: [
    StarterKit.configure({ undoRedo: false }),
    BlockKeymap.configure({ onInsertBelow: () => { calls += 1; } }),
  ],
  content: '<p>hello</p>',
});

const press = (key, opts = {}) =>
  editor.view.dom.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
  );

editor.commands.focus('end');

press('Enter', { shiftKey: true });
ck('Shift+Enter calls onInsertBelow', calls === 1);
ck('Shift+Enter does not insert a hard break', !editor.getHTML().includes('<br'));
ck('Shift+Enter leaves the current block text alone', editor.getText().trim() === 'hello');

press('Enter');
ck('plain Enter does not insert a block below', calls === 1);
ck('plain Enter still splits the paragraph', editor.getHTML().match(/<p>/g).length === 2);

press('Enter', { shiftKey: true });
ck('Shift+Enter fires again on the next press', calls === 2);

// A block without a handler must fall back to the default hard break.
const el2 = dom.window.document.createElement('div');
dom.window.document.body.appendChild(el2);
const plain = new Editor({
  element: el2,
  extensions: [StarterKit.configure({ undoRedo: false }), BlockKeymap],
  content: '<p>hi</p>',
});
plain.commands.focus('end');
plain.view.dom.dispatchEvent(
  new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
);
ck('without a handler Shift+Enter falls back to hard break', plain.getHTML().includes('<br'));

editor.destroy();
plain.destroy();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
