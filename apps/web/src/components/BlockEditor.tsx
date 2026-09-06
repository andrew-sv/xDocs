import type { HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { blockFragmentName, type BlockMeta } from '@xdocs/shared';
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { localUser } from '../lib/identity';
import { BLOCK_DRAG_MIME, type DropEdge } from '../lib/reorder';
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
  canReorder: boolean;
  isDragging: boolean;
  /** Which side of this block the drop indicator sits on, if any. */
  dropEdge: DropEdge | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverBlock: (id: string, edge: DropEdge) => void;
  onDropBlock: () => void;
  onNudge: (id: string, direction: -1 | 1) => void;
};

function DragDots() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="3" r="1.2" /><circle cx="7.5" cy="3" r="1.2" />
      <circle cx="2.5" cy="8" r="1.2" /><circle cx="7.5" cy="8" r="1.2" />
      <circle cx="2.5" cy="13" r="1.2" /><circle cx="7.5" cy="13" r="1.2" />
    </svg>
  );
}

export function BlockEditor({
  block,
  ydoc,
  provider,
  onRemove,
  canRemove,
  autoFocus,
  onAutoFocusHandled,
  canReorder,
  isDragging,
  dropEdge,
  onDragStart,
  onDragEnd,
  onDragOverBlock,
  onDropBlock,
  onNudge,
}: Props) {
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const className = [
    'block',
    focused && 'focused',
    isDragging && 'dragging',
    dropEdge === 'above' && 'drop-above',
    dropEdge === 'below' && 'drop-below',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={containerRef}
      className={className}
      onDragOver={(event) => {
        // Without preventDefault the browser refuses the drop outright.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        const edge: DropEdge = event.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
        onDragOverBlock(block.id, edge);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropBlock();
      }}
    >
      <div className="block-gutter">
        {canReorder && (
          // A span rather than a button: draggable <button> is unreliable in
          // some browsers, so this carries its own role and key handling.
          <span
            className="block-handle"
            role="button"
            tabIndex={0}
            draggable
            aria-label="Reorder block. Press arrow up or arrow down to move it."
            title="Drag to reorder"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(BLOCK_DRAG_MIME, block.id);
              // Drag the whole block, not the little handle glyph.
              if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                event.dataTransfer.setDragImage(
                  containerRef.current,
                  event.clientX - rect.left,
                  event.clientY - rect.top,
                );
              }
              onDragStart(block.id);
            }}
            onDragEnd={onDragEnd}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              onNudge(block.id, event.key === 'ArrowUp' ? -1 : 1);
            }}
          >
            <DragDots />
          </span>
        )}
        {canRemove && (
          <button
            type="button"
            className="block-remove"
            title="Delete block"
            aria-label="Delete block"
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
