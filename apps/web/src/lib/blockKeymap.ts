import { Extension } from '@tiptap/react';

/** Two spaces per level — matches the tab-size used to render code blocks. */
const INDENT = '  ';

export interface BlockKeymapOptions {
  /** Insert a fresh block directly below this one and move the caret into it. */
  onInsertBelow: (() => void) | null;
}

/**
 * Block-level keys that have to beat the editor's own bindings.
 *
 * StarterKit's HardBreak already claims Shift-Enter (it inserts a <br>), so
 * this sits above it at priority 1000 and takes the keystroke first. Returning
 * true stops HardBreak from also running.
 */
export const BlockKeymap = Extension.create<BlockKeymapOptions>({
  name: 'blockKeymap',
  priority: 1000,

  addOptions() {
    return { onInsertBelow: null };
  },

  addKeyboardShortcuts() {
    return {
      /*
       * Tab indents inside a code block only.
       *
       * Everywhere else Tab must keep moving focus — capturing it globally
       * would trap keyboard users in the editor. By default it escapes even
       * inside a code block, so indentation was impossible to type.
       */
      Tab: () => {
        if (!this.editor.isActive('codeBlock')) return false;
        return this.editor.commands.insertContent(INDENT);
      },

      'Shift-Tab': () => {
        if (!this.editor.isActive('codeBlock')) return false;
        const { state, view } = this.editor;
        const { from } = state.selection;
        const blockStart = state.doc.resolve(from).start();
        const before = state.doc.textBetween(blockStart, from, '\n', '\n');
        const lineStart = from - (before.length - before.lastIndexOf('\n') - 1);
        const lead = state.doc.textBetween(
          lineStart,
          Math.min(lineStart + INDENT.length, from),
          '\n',
          '\n',
        );

        const remove = lead.startsWith(INDENT) ? INDENT.length : lead.startsWith(' ') ? 1 : 0;
        // Consume the key regardless, so Shift-Tab never escapes mid-code.
        if (remove > 0) view.dispatch(state.tr.delete(lineStart, lineStart + remove));
        return true;
      },

      'Shift-Enter': () => {
        const insertBelow = this.options.onInsertBelow;
        if (!insertBelow) return false;
        insertBelow();
        return true;
      },
    };
  },
});
