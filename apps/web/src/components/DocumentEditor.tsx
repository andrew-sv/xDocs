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
import { useCollaborators } from '../hooks/useCollaborators';
import { useThreads } from '../hooks/useThreads';
import type { CommandId } from '../lib/commands';
import { exportDocumentToPdf } from '../lib/exportPdf';
import { getToken, useSession } from '../lib/auth';
import { collaboratorFrom } from '../lib/identity';
import {
  addComment,
  createThread,
  deleteComment,
  editComment,
  quoteFor,
  readRailCollapsed,
  setResolved,
  writeRailCollapsed,
} from '../lib/comments';
import { COLLAB_URL } from '../lib/collab';
import { attachmentIdsIn } from '../lib/attachments';
import { applyMove, resolveMove, resolveNudge, type DropEdge } from '../lib/reorder';
import { BlockEditor } from './BlockEditor';
import { Collaborators } from './Collaborators';
import { CommentsRail } from './CommentsRail';
import { DocumentFiles } from './DocumentFiles';
import { TitleEditor } from './TitleEditor';
import { VersionHistory } from './VersionHistory';
import { VisibilityToggle } from './VisibilityToggle';
import { Toast } from './Toast';

type Status = 'connecting' | 'connected' | 'disconnected';

type Props = {
  document: DocumentDTO;
  onTitleChange: (id: string, title: string) => void;
  onVisibilityChange: (id: string, visibility: DocumentDTO['visibility']) => Promise<void>;
  /** Create a sub-document of this one and open it. */
  onAddSubDocument: () => void;
  /** This document's children, linked at its foot. */
  subDocuments: DocumentDTO[];
  onOpenSubDocument: (child: DocumentDTO) => void;
};

function DocIcon() {
  return (
    <svg
      width="14"
      height="16"
      viewBox="0 0 14 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M2.5 1.5h6l3 3v10h-9z M8.5 1.5v3h3" strokeLinejoin="round" />
    </svg>
  );
}

export function DocumentEditor({
  document: doc,
  onTitleChange,
  onVisibilityChange,
  onAddSubDocument,
  subDocuments,
  onOpenSubDocument,
}: Props) {
  // Creation order, so the links do not reshuffle every time a child is edited
  // (the sidebar's list is ordered by last update).
  const orderedSubDocuments = useMemo(
    () => [...subDocuments].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [subDocuments],
  );
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  /*
   * Who this tab is, to everyone else in the document.
   *
   * Read here rather than passed down: the session is a shared store, so asking
   * for it costs nothing, and threading it through App for the sole benefit of
   * a caret label would put it in the way of every component in between.
   */
  const { data: session } = useSession();
  const me = useMemo(() => collaboratorFrom(session?.user), [session?.user]);
  const others = useCollaborators(provider, me);

  /*
   * Comments. The threads live on the same Yjs doc as the text, so this is a
   * subscription rather than a fetch, and a comment written by somebody else
   * appears here the moment it lands.
   */
  const threads = useThreads(provider?.document ?? null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  /*
   * Whether the rail is folded away. Remembered per browser, and read once on
   * mount rather than watched: this is a preference, and it changing in another
   * tab is not worth reflowing a document someone is typing in.
   */
  const [railCollapsed, setRailCollapsed] = useState(readRailCollapsed);
  const toggleRail = useCallback((collapsed: boolean) => {
    setRailCollapsed(collapsed);
    writeRailCollapsed(collapsed);
  }, []);
  /*
   * Anything that has a comment to show must open the rail first, or the
   * composer and the thread would both be behind a fold — pressing 💬 would
   * appear to do nothing at all.
   */
  const showInRail = useCallback((threadId: string | null) => {
    setRailCollapsed(false);
    setActiveThreadId(threadId);
  }, []);
  /*
   * A thread being written but not yet created.
   *
   * Nothing is committed until Send: pressing 💬 and changing your mind should
   * leave no trace, and an empty thread would already be a highlight on
   * everyone else's screen with nothing behind it.
   */
  const [pendingThread, setPendingThread] = useState<{
    blockId: string;
    quote: string;
    apply: (threadId: string) => void;
  } | null>(null);

  const [status, setStatus] = useState<Status>('connecting');
  const [synced, setSynced] = useState(false);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: DropEdge } | null>(null);
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  /** Bumped when a block uploads a file, so the file list picks it up. */
  const [filesKey, setFilesKey] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

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
      onStatus: ({ status }) => setStatus(status),
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
    setHistoryOpen(false);
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

  /*
   * Publish this tab's identity for the carets and the collaborator list.
   *
   * CollaborationCaret also writes this field when each block editor is
   * created, which is what makes a caret appear at all. Doing it here as well
   * covers the case that ordering cannot: the session resolves a moment after
   * the first editors mount, so those were created knowing nothing, and only a
   * later write turns "no caret" into a named one. Awareness is per connection
   * rather than per editor, so this one write speaks for every block.
   */
  useEffect(() => {
    if (!provider || !me) return;
    provider.setAwarenessField('user', me);
  }, [provider, me]);

  const ydoc = provider?.document ?? null;

  /*
   * Which files this document refers to, read from the open document itself.
   *
   * The list route reports this too, but a fetch and a document that is still
   * being edited cannot agree for long: an upload's own refetch could read the
   * document before the new link had synced, and removing a link changed
   * nothing until something else happened to refetch. The open document knows
   * exactly, and re-reading it costs no request.
   *
   * Debounced, and only the SET is kept, so ordinary typing changes nothing.
   */
  const [referenced, setReferenced] = useState<string[]>([]);
  useEffect(() => {
    if (!ydoc) {
      setReferenced([]);
      return;
    }
    const read = () =>
      setReferenced((prev) => {
        const next = attachmentIdsIn(ydoc);
        return next.join(',') === prev.join(',') ? prev : next;
      });
    read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 300);
    };
    ydoc.on('update', onUpdate);
    return () => {
      clearTimeout(timer);
      ydoc.off('update', onUpdate);
    };
  }, [ydoc]);
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

  /*
   * Clear a thread's highlight wherever it ended up.
   *
   * Every block is asked, not just the one the thread was opened in: text moves
   * between blocks, and a mark left behind would point at a thread that no
   * longer exists — a highlight you could click that opened nothing.
   */
  const clearMark = useCallback((threadId: string) => {
    editorsRef.current.forEach((editor) => {
      editor.commands.unsetCommentThread(threadId);
    });
  }, []);

  /** Open a thread on a selection, then highlight exactly that range. */
  const startThread = useCallback(
    (blockId: string, quote: string, apply: (threadId: string) => void) => {
      const ydoc = provider?.document;
      if (!ydoc || !me) return;
      // Nothing is written until there is something to say, so the composer
      // opens first and the thread is created when Send is pressed.
      setPendingThread({ blockId, quote: quoteFor(quote), apply });
      showInRail(null);
    },
    [provider, me, showInRail],
  );

  /** Commit the pending thread: write it, then mark the text it quotes. */
  const sendPendingThread = useCallback(
    (text: string) => {
      const ydoc = provider?.document;
      if (!ydoc || !me || !pendingThread) return;
      const threadId = createThread(ydoc, {
        blockId: pendingThread.blockId,
        quote: pendingThread.quote,
        text,
        author: { id: me.id, name: me.name },
      });
      pendingThread.apply(threadId);
      setPendingThread(null);
      showInRail(threadId);
    },
    [provider, me, pendingThread, showInRail],
  );

  const replyToThread = useCallback(
    (threadId: string, text: string) => {
      const ydoc = provider?.document;
      if (!ydoc || !me) return;
      addComment(ydoc, threadId, text, { id: me.id, name: me.name });
    },
    [provider, me],
  );

  const editThreadComment = useCallback(
    (threadId: string, commentId: string, text: string) => {
      const ydoc = provider?.document;
      if (ydoc) editComment(ydoc, threadId, commentId, text);
    },
    [provider],
  );

  const deleteThreadComment = useCallback(
    (threadId: string, commentId: string) => {
      const ydoc = provider?.document;
      if (!ydoc) return;
      // Deleting the last comment takes the thread with it, and the highlight
      // has to go at the same time or it would open nothing.
      const { threadGone } = deleteComment(ydoc, threadId, commentId);
      if (threadGone) {
        clearMark(threadId);
        setActiveThreadId((current) => (current === threadId ? null : current));
      }
    },
    [provider, clearMark],
  );

  const resolveThread = useCallback(
    (threadId: string, resolved: boolean) => {
      const ydoc = provider?.document;
      if (ydoc) setResolved(ydoc, threadId, resolved);
    },
    [provider],
  );

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

  /*
   * The rail is a sibling of the scrolling document, not inside it: it has to
   * keep its own scroll position while the document moves, and stay put when
   * the document is scrolled to the bottom.
   */
  return (
    <div className="workspace">
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
          <Collaborators people={others} />
          <button
            type="button"
            className="header-button"
            data-testid="history-open"
            title="Earlier versions of this document"
            onClick={() => setHistoryOpen(true)}
          >
            History
          </button>
          <span className={`status status-${status}`}>
            {status === 'connected' && synced
              ? 'Live'
              : status === 'connected'
                ? 'Syncing…'
                : status}
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
                  me={me}
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
                  onAttached={() => setFilesKey((key) => key + 1)}
                  onInsertBelow={handleInsertBelow}
                  onRunCommand={(id) => void runCommand(id)}
                  registerEditor={registerEditor}
                  onComment={startThread}
                  onActivateThread={(threadId) => {
                    setPendingThread(null);
                    showInRail(threadId);
                  }}
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
            <DocumentFiles documentId={doc.id} reloadKey={filesKey} referenced={referenced} />
            {orderedSubDocuments.length > 0 && (
              <nav className="sub-docs" data-testid="sub-docs" aria-label="Sub-documents">
                <h2 className="sub-docs-title">Sub-documents</h2>
                <ul className="sub-docs-list">
                  {orderedSubDocuments.map((child) => (
                    <li key={child.id}>
                      <button
                        type="button"
                        className="sub-doc-link"
                        data-testid="sub-doc-link"
                        onClick={() => onOpenSubDocument(child)}
                      >
                        <DocIcon />
                        <span className="sub-doc-title">{child.title || 'Untitled'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
          </>
        )}

        {toast && <Toast message={toast.message} onUndo={runUndo} onDismiss={dismissToast} />}
        {historyOpen && <VersionHistory documentId={doc.id} onClose={closeHistory} />}
      </main>

      {synced && (
        <CommentsRail
          threads={threads}
          activeId={activeThreadId}
          me={me}
          pending={pendingThread ? { quote: pendingThread.quote } : null}
          onSendPending={sendPendingThread}
          onCancelPending={() => setPendingThread(null)}
          onActivate={(id) => {
            setPendingThread(null);
            setActiveThreadId(id);
          }}
          collapsed={railCollapsed}
          onToggleCollapsed={toggleRail}
          onReply={replyToThread}
          onEdit={editThreadComment}
          onDelete={deleteThreadComment}
          onResolve={resolveThread}
        />
      )}
    </div>
  );
}
