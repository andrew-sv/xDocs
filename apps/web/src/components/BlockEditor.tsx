import type { HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { blockFragmentName, type BlockMeta } from '@xdocs/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { localUser } from '../lib/identity';
import { AttachmentLinks, attachFile } from '../lib/attachments';
import { BlockKeymap } from '../lib/blockKeymap';
import { CommandPalette, type PaletteState } from '../lib/commandPalette';
import type { CommandId } from '../lib/commands';
import { CommandPaletteMenu } from './CommandPalette';
import { DocumentUndo } from '../lib/documentUndo';
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
  /** Shift+Enter: add a block right below this one and focus it. */
  onInsertBelow: (id: string) => void;
  /** Palette commands act on the whole document, which only the parent sees. */
  onRunCommand: (id: CommandId) => void;
  /** Lets the parent read this block's HTML when exporting. */
  registerEditor: (blockId: string, editor: Editor | null) => void;
  /** Document-wide undo stack, shared by every block. */
  undoManager: Y.UndoManager;
  /** The document files are attached to. */
  documentId: string;
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
  onInsertBelow,
  onRunCommand,
  registerEditor,
  undoManager,
  documentId,
}: Props) {
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /*
   * Upload progress and attachment errors. Shown under the block, not in the
   * toolbar: the toolbar unmounts whenever focus leaves the block, which the
   * file picker alone is enough to do.
   */
  const [note, setNote] = useState<{ kind: 'progress' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (note?.kind !== 'error') return;
    const timer = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(timer);
  }, [note]);
  const fragment = useMemo(
    () => ydoc.getXmlFragment(blockFragmentName(block.id)),
    [ydoc, block.id],
  );

  // The extension list is frozen when the editor is built, so the handler is
  // read through a ref — a captured callback would go stale on re-render.
  const insertBelowRef = useRef(onInsertBelow);
  useEffect(() => {
    insertBelowRef.current = onInsertBelow;
  }, [onInsertBelow]);

  const runCommandRef = useRef(onRunCommand);
  useEffect(() => {
    runCommandRef.current = onRunCommand;
  }, [onRunCommand]);

  // The palette owns selection, so it owns the keys; the plugin calls through.
  const paletteKeyHandler = useRef<((event: KeyboardEvent) => boolean) | null>(null);

  // y-tiptap only auto-scopes an UndoManager it constructs itself, so a shared
  // one has to be told about each block's fragment or typing here is untracked.
  useEffect(() => {
    undoManager.addToScope([fragment]);
  }, [undoManager, fragment]);

  const editor = useEditor(
    {
      extensions: [
        // undoRedo: Yjs owns undo/redo via its own UndoManager; StarterKit's
        // history plugin would fight it and corrupt the shared history stack.
        //
        // trailingNode: it appends a real paragraph whenever the last node is
        // not one, so a heading or list block grew a permanent empty line that
        // came straight back when deleted. That behaviour exists so you can
        // click past a trailing table in a whole-document editor; here each
        // block IS one node, and new blocks come from Shift+Enter instead.
        StarterKit.configure({ undoRedo: false, trailingNode: false }),
        // Deliberately NOT given our undoManager: Collaboration destroys the
        // manager it is handed when this editor unmounts. See documentUndo.ts.
        Collaboration.configure({ fragment }),
        DocumentUndo.configure({ undoManager }),
        BlockKeymap.configure({ onInsertBelow: () => insertBelowRef.current(block.id) }),
        CommandPalette.configure({
          onStateChange: setPalette,
          onRun: (id) => runCommandRef.current(id),
          getKeyHandler: () => paletteKeyHandler.current,
        }),
        CollaborationCaret.configure({ provider, user: localUser }),
        AttachmentLinks.configure({ onError: (text) => setNote({ kind: 'error', text }) }),
      ],
    },
    [block.id, ydoc, provider, fragment, undoManager],
  );

  async function handleFile(file: File) {
    if (!editor) return;
    setNote({ kind: 'progress', text: `Uploading “${file.name}”…` });
    try {
      await attachFile(editor, documentId, file);
      setNote(null);
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Upload failed.' });
    }
  }

  // Expose this block's editor so the parent can read its HTML when exporting.
  useEffect(() => {
    registerEditor(block.id, editor ?? null);
    return () => registerEditor(block.id, null);
  }, [registerEditor, block.id, editor]);

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
      data-testid="block"
      data-block-id={block.id}
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
            data-testid="block-handle"
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
            data-testid="block-delete"
            title="Delete block"
            aria-label="Delete block"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
      <div
        className="block-body"
        /*
         * Focus is tracked for the whole body, not just the editor, so the
         * toolbar survives focus moving into its own link field — tracking the
         * editor alone unmounted the toolbar the moment that field was focused.
         */
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        {editor && focused && (
          <Toolbar editor={editor} onAttachFile={() => fileInputRef.current?.click()} />
        )}
        <EditorContent editor={editor} />
        <input
          ref={fileInputRef}
          type="file"
          hidden
          data-testid="attach-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so picking the same file again still fires a change.
            event.target.value = '';
            if (file) void handleFile(file);
          }}
        />
        {note && (
          <p
            className={`block-note block-note-${note.kind}`}
            role={note.kind === 'error' ? 'alert' : 'status'}
            data-testid="block-note"
          >
            {note.text}
          </p>
        )}
        {palette && (
          <CommandPaletteMenu
            state={palette}
            bindKeyHandler={(handler) => {
              paletteKeyHandler.current = handler;
            }}
          />
        )}
      </div>
    </div>
  );
}
