import { HocuspocusProvider } from '@hocuspocus/provider';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import {
  BLOCKS_KEY,
  TITLE_KEY,
  collabDocName,
  type BlockMeta,
  type DocumentDTO,
} from '@xdocs/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { Editor } from '@tiptap/react';
import { useYArray } from '../hooks/useYArray';
import type { CommandId } from '../lib/commands';
import { exportDocumentToPdf } from '../lib/exportPdf';
import { getToken } from '../lib/auth';
import { applyMove, resolveMove, resolveNudge, type DropEdge } from '../lib/reorder';
import { BlockEditor } from './BlockEditor';
import { TitleEditor } from './TitleEditor';
import { VisibilityToggle } from './VisibilityToggle';
import { Toast } from './Toast';

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:3001';

type Status = 'connecting' | 'connected' | 'disconnected';

type Props = {
  document: DocumentDTO;
  onTitleChange: (id: string, title: string) => void;
  onVisibilityChange: (id: string, visibility: DocumentDTO['visibility']) => Promise<void>;
  /** Create a sub-document of this one and open it. */
  onAddSubDocument: () => void;
};

export function DocumentEditor({
  document: doc,
  onTitleChange,
  onVisibilityChange,
  onAddSubDocument,
}: Props) {
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [synced, setSynced] = useState(false);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: DropEdge } | null>(null);
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);

  useEffect(() => {
    // One Y.Doc + one socket per open document. Every block is a fragment on
    // this same doc, so opening a 40-block document is still one connection.
    const ydoc = new Y.Doc();
    const next = new HocuspocusProvider({
      url: COLLAB_URL,
      name: collabDocName(doc.id),
      document: ydoc,
      // Read lazily so a reconnect picks up the current token. Harmless when
      // the server has no password configured: it simply ignores it.
      token: () => getToken() ?? '',
      onStatus: ({ status }) => setStatus(status as Status),
      onSynced: () => setSynced(true),
    });

    /*
     * One undo stack for the whole document.
     *
     * Each block editor gets handed this same manager (see BlockEditor), so a
     * single Cmd+Z walks back through text edits, title edits, reordering and
     * block deletion in the order they happened — rather than each block
     * keeping a private history that cannot see structural changes at all.
     *
     * trackedOrigins: our own mutations transact with origin null, while
     * ProseMirror's edits arrive under ySyncPluginKey. Remote peers' changes
     * carry the provider as origin and are deliberately absent, so undo never
     * reverts somebody else's typing.
     */
    const undo = new Y.UndoManager([ydoc.getArray(BLOCKS_KEY), ydoc.getText(TITLE_KEY)], {
      trackedOrigins: new Set([null, ySyncPluginKey]),
    });

    setProvider(next);
    setUndoManager(undo);
    setStatus('connecting');
    setSynced(false);
    setToast(null);

    return () => {
      undo.destroy();
      next.destroy();
      ydoc.destroy();
      setProvider(null);
      setUndoManager(null);
    };
  }, [doc.id]);

  const ydoc = provider?.document ?? null;
  const blocksArray = useMemo(() => ydoc?.getArray<BlockMeta>(BLOCKS_KEY) ?? null, [ydoc]);
  const blocks = useYArray(blocksArray);
  const titleText = useMemo(() => ydoc?.getText(TITLE_KEY) ?? null, [ydoc]);

  const handleTitleChange = useCallback(
    (title: string) => onTitleChange(doc.id, title),
    [doc.id, onTitleChange],
  );

  const clearPendingFocus = useCallback(() => setPendingFocusId(null), []);

  /*
   * Every block is its own editor, so exporting the document needs all of them.
   * Each BlockEditor registers here on mount and clears its entry on unmount.
   */
  const editorsRef = useRef(new Map<string, Editor>());
  const registerEditor = useCallback((blockId: string, editor: Editor | null) => {
    if (editor) editorsRef.current.set(blockId, editor);
    else editorsRef.current.delete(blockId);
  }, []);

  const runCommand = useCallback(
    async (id: CommandId) => {
      if (id !== 'exportToPdf') return;
      // Walk the CRDT's block order, not the Map's insertion order.
      const html = blocksArray
        ? blocksArray
            .toArray()
            .map((b) => editorsRef.current.get(b.id)?.getHTML() ?? '')
            .filter(Boolean)
        : [];
      const title = titleText?.toString().trim() || doc.title;
      await exportDocumentToPdf(title, html);
    },
    [blocksArray, titleText, doc.title],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  /*
   * Close the current undo step before a structural change.
   *
   * Yjs merges edits made within its 500ms captureTimeout into one stack item,
   * so deleting or moving a block just after typing would fold both into a
   * single undo — one Cmd+Z would then revert the deletion AND the sentence
   * before it. Adding, deleting and moving a block are discrete actions and
   * each deserves its own undo step.
   */
  const beginUndoStep = useCallback(() => undoManager?.stopCapturing(), [undoManager]);

  const runUndo = useCallback(() => {
    undoManager?.undo();
    setToast(null);
  }, [undoManager]);

  // Cmd/Ctrl+Z outside a block editor. A focused ProseMirror binds Mod-z
  // itself, and since it holds this very manager we let it handle its own.
  useEffect(() => {
    if (!undoManager) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      if (event.target instanceof Element && event.target.closest('.tiptap')) return;
      event.preventDefault();
      if (event.shiftKey) undoManager.redo();
      else undoManager.undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undoManager]);

  // Any later change makes the offer stale, so retire it. The deletion's own
  // stack item is added before setToast runs, so this never eats its own toast.
  useEffect(() => {
    if (!undoManager) return;
    const invalidate = () => setToast(null);
    undoManager.on('stack-item-added', invalidate);
    undoManager.on('stack-item-popped', invalidate);
    return () => {
      undoManager.off('stack-item-added', invalidate);
      undoManager.off('stack-item-popped', invalidate);
    };
  }, [undoManager]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  const endDrag = useCallback(() => {
    setDraggingId(null);
    setDropTarget(null);
  }, []);

  const handleDragOverBlock = useCallback(
    (id: string, edge: DropEdge) => {
      if (!draggingId) return;
      // Only mark a target when the drop would actually change the order, so
      // no indicator appears for a drag that would land where it started.
      setDropTarget(resolveMove(blocks, draggingId, id, edge) ? { id, edge } : null);
    },
    [draggingId, blocks],
  );

  const handleDrop = useCallback(() => {
    if (draggingId && dropTarget && blocksArray) {
      const move = resolveMove(blocks, draggingId, dropTarget.id, dropTarget.edge);
      if (move) {
        beginUndoStep();
        applyMove(blocksArray, move.from, move.to);
      }
    }
    endDrag();
  }, [draggingId, dropTarget, blocks, blocksArray, endDrag, beginUndoStep]);

  const handleNudge = useCallback(
    (id: string, direction: -1 | 1) => {
      if (!blocksArray) return;
      const move = resolveNudge(blocks, id, direction);
      if (move) {
        beginUndoStep();
        applyMove(blocksArray, move.from, move.to);
      }
    },
    [blocks, blocksArray, beginUndoStep],
  );

  const addBlock = useCallback(
    (afterIndex?: number) => {
      if (!blocksArray) return;
      beginUndoStep();
      const block: BlockMeta = { id: crypto.randomUUID(), type: 'paragraph' };
      blocksArray.insert(afterIndex === undefined ? blocksArray.length : afterIndex + 1, [block]);
      setPendingFocusId(block.id);
    },
    [blocksArray, beginUndoStep],
  );

  const handleInsertBelow = useCallback(
    (id: string) => {
      if (!blocksArray) return;
      const index = blocksArray.toArray().findIndex((b) => b.id === id);
      addBlock(index === -1 ? undefined : index);
    },
    [blocksArray, addBlock],
  );

  function removeBlock(id: string) {
    if (!blocksArray) return;
    const index = blocksArray.toArray().findIndex((b) => b.id === id);
    if (index === -1) return;
    beginUndoStep();
    blocksArray.delete(index, 1);
    // The block's Y.XmlFragment is intentionally left behind: Yjs has no API to
    // drop a root type, and an empty fragment costs a few bytes. It also means
    // undoing this deletion restores the text for free — only the metadata
    // entry has to come back.
    setToast({ id: Date.now(), message: 'Paragraph deleted' });
  }

  return (
    <main className="editor">
      <header className="editor-header">
        {synced && titleText ? (
          <TitleEditor title={titleText} onChange={handleTitleChange} />
        ) : (
          // Until the CRDT has synced its Y.Text is empty, which would render as
          // the "Untitled" placeholder. Show the title the list already knows
          // from REST, with a spinner, rather than flashing a wrong name.
          <span className="title-loading" data-testid="title-loading">
            <span className="title-name">{doc.title}</span>
            <span className="spinner" role="status" aria-label="Loading document" />
          </span>
        )}
        <VisibilityToggle
          visibility={doc.visibility}
          isOwner={doc.isOwner}
          onChange={(next) => onVisibilityChange(doc.id, next)}
        />
        <span className={`status status-${status}`}>
          {status === 'connected' && synced ? 'Live' : status === 'connected' ? 'Syncing…' : status}
        </span>
      </header>

      {synced && provider && ydoc && undoManager && (
        <>
          <div className={draggingId ? 'blocks dragging' : 'blocks'}>
            {blocks.map((block) => (
              <BlockEditor
                key={block.id}
                block={block}
                ydoc={ydoc}
                provider={provider}
                canRemove={blocks.length > 1}
                onRemove={() => removeBlock(block.id)}
                autoFocus={block.id === pendingFocusId}
                onAutoFocusHandled={clearPendingFocus}
                canReorder={blocks.length > 1}
                isDragging={block.id === draggingId}
                dropEdge={dropTarget?.id === block.id ? dropTarget.edge : null}
                onDragStart={setDraggingId}
                onDragEnd={endDrag}
                onDragOverBlock={handleDragOverBlock}
                onDropBlock={handleDrop}
                onNudge={handleNudge}
                undoManager={undoManager}
                documentId={doc.id}
                onInsertBelow={handleInsertBelow}
                onRunCommand={(id) => void runCommand(id)}
                registerEditor={registerEditor}
              />
            ))}
          </div>
          <div className="block-actions">
          <button
            type="button"
            className="add-block"
            data-testid="add-block"
            // Without this, mousedown blurs the editor, the focused block's
            // toolbar unmounts, the layout shifts up and the button slides out
            // from under the pointer before mouseup — so the first click only
            // ever exited edit mode and a second was needed to actually add.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => addBlock()}
          >
            + Add paragraph
          </button>
          <button
            type="button"
            className="add-block add-document"
            data-testid="add-document"
            // Same reason as the add-paragraph button: mousedown would blur the
            // editor, unmount the toolbar and shift this out from under the
            // pointer before mouseup.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onAddSubDocument}
          >
            + Add document
          </button>
          </div>
        </>
      )}

      {toast && <Toast message={toast.message} onUndo={runUndo} onDismiss={dismissToast} />}
    </main>
  );
}
