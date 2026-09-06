import { Extension } from '@tiptap/react';
import type * as Y from 'yjs';

export interface DocumentUndoOptions {
  undoManager: Y.UndoManager | null;
}

/**
 * Routes Cmd/Ctrl+Z inside a block to the DOCUMENT's undo stack.
 *
 * Why this exists rather than handing our manager to Collaboration's
 * `yUndoOptions`: the collaboration plugin assumes it owns its UndoManager's
 * lifecycle and calls `undoManager.destroy()` when the editor view tears down.
 * Yjs's destroy() detaches the `afterTransaction` handler and drops every
 * observer, so a manager shared across block editors stops recording the
 * moment ANY single block unmounts — which happens constantly, on every block
 * delete and on every StrictMode remount. Undo then silently does nothing.
 *
 * So each editor keeps the private manager TipTap can safely destroy, and this
 * extension — at a priority above Collaboration's — claims the keystroke first
 * and applies it to the document-wide stack instead.
 */
export const DocumentUndo = Extension.create<DocumentUndoOptions>({
  name: 'documentUndo',

  // Collaboration binds Mod-z at the default priority of 100; we must be
  // ordered ahead of it so our handler sees the keystroke first.
  priority: 1000,

  addOptions() {
    return { undoManager: null };
  },

  addKeyboardShortcuts() {
    const apply = (action: 'undo' | 'redo') => () => {
      const manager = this.options.undoManager;
      if (!manager) return false;
      manager[action]();
      // Returning true stops Collaboration's own binding from also firing.
      return true;
    };

    return {
      'Mod-z': apply('undo'),
      'Shift-Mod-z': apply('redo'),
      'Mod-y': apply('redo'),
    };
  },
});
