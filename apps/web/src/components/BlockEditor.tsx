import type { HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { blockFragmentName, type BlockMeta } from '@xdocs/shared';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { localUser } from '../lib/identity';
import { Toolbar } from './Toolbar';

type Props = {
  block: BlockMeta;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  onRemove: () => void;
  canRemove: boolean;
  /** Set on a block that was just created, so the caret lands in it. */
  autoFocus: boolean;
  onAutoFocusHandled: () => void;
};

export function BlockEditor({
  block,
  ydoc,
  provider,
  onRemove,
  canRemove,
  autoFocus,
  onAutoFocusHandled,
}: Props) {
  const [focused, setFocused] = useState(false);

  const editor = useEditor(
    {
      extensions: [
        // Yjs owns undo/redo via its own UndoManager; StarterKit's history
        // plugin would fight it and corrupt the shared history stack.
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ fragment: ydoc.getXmlFragment(blockFragmentName(block.id)) }),
        CollaborationCaret.configure({ provider, user: localUser }),
      ],
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
    [block.id, ydoc, provider],
  );

  // `useEditor` returns null on the first render, so focusing a freshly added
  // block has to wait until the editor instance actually exists.
  useEffect(() => {
    if (!editor || !autoFocus) return;
    editor.commands.focus('end');
    onAutoFocusHandled();
  }, [editor, autoFocus, onAutoFocusHandled]);

  return (
    <div className={focused ? 'block focused' : 'block'}>
      <div className="block-gutter">
        {canRemove && (
          <button
            type="button"
            className="block-remove"
            title="Delete block"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
      <div className="block-body">
        {editor && focused && <Toolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
