import { Extension } from '@tiptap/react';

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
      'Shift-Enter': () => {
        const insertBelow = this.options.onInsertBelow;
        if (!insertBelow) return false;
        insertBelow();
        return true;
      },
    };
  },
});
