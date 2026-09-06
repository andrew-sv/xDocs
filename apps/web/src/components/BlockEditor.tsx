import type { HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { blockFragmentName, type BlockMeta } from '@xdocs/shared';
import { useState } from 'react';
import type * as Y from 'yjs';
import { localUser } from '../lib/identity';
import { Toolbar } from './Toolbar';

type Props = {
  block: BlockMeta;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  onRemove: () => void;
  canRemove: boolean;
};

export function BlockEditor({ block, ydoc, provider, onRemove, canRemove }: Props) {
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

  return (
    <div className={focused ? 'block focused' : 'block'}>
      <div className="block-gutter">
        {canRemove && (
          <button type="button" className="block-remove" title="Delete block" onClick={onRemove}>
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
