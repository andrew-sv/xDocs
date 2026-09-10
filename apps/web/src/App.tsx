import type { DocumentDTO } from '@xdocs/shared';
import { useCallback, useEffect, useState } from 'react';
import { DocumentEditor } from './components/DocumentEditor';
import { DocumentList } from './components/DocumentList';
import { LoginGate } from './components/LoginGate';
import { Toast } from './components/Toast';
import { api } from './lib/api';
import { ForbiddenError, UnauthorizedError, clearToken, signOut, useSession } from './lib/auth';

export function App() {
  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  const [selected, setSelected] = useState<DocumentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ id: string; title: string } | null>(null);
  const [locked, setLocked] = useState(false);
  /*
   * Breadcrumb trail; empty means the top level. Clicking a document both opens
   * it and drills into it, so the trail is also the sidebar's current level.
   * A client-side trail is enough — there is no router and nothing deep-links.
   */
  const [trail, setTrail] = useState<DocumentDTO[]>([]);
  const [deniedReason, setDeniedReason] = useState<string | null>(null);
  const { data: session } = useSession();

  const handleVisibilityChange = useCallback(
    async (id: string, visibility: DocumentDTO['visibility']) => {
      const updated = await api.setVisibility(id, visibility);
      setDocuments((prev) => prev.map((d) => (d.id === id ? updated : d)));
      setSelected((prev) => (prev?.id === id ? updated : prev));
    },
    [],
  );

  const handleSignOut = useCallback(async () => {
    await signOut();
    clearToken();
    setDocuments([]);
    setSelected(null);
    setTrail([]);
    setLocked(true);
  }, []);

  const currentParentId = trail.length > 0 ? trail[trail.length - 1]!.id : null;

  const refresh = useCallback(async () => {
    try {
      setDocuments(await api.listDocuments(currentParentId));
      setLocked(false);
      setError(null);
    } catch (e) {
      // A gated deployment answers 401 until a valid password is supplied;
      // that is a login prompt, not an error to render.
      if (e instanceof UnauthorizedError) {
        setLocked(true);
        return;
      }
      if (e instanceof ForbiddenError) {
        // Signed in, but not on the allowlist — say so instead of looping.
        setDeniedReason(e.message);
        setLocked(true);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [currentParentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createDocument() {
    // Created at whatever level the sidebar is showing.
    const doc = await api.createDocument('Untitled', currentParentId);
    setDocuments((prev) => [doc, ...prev]);
    setSelected(doc);
  }

  /** Open a document AND show its sub-documents in the sidebar. */
  const openDocument = useCallback((doc: DocumentDTO) => {
    setSelected(doc);
    setTrail((prev) => [...prev, doc]);
  }, []);

  /** Jump to a crumb; index -1 is the top level. */
  const navigateToCrumb = useCallback((index: number) => {
    setTrail((prev) => {
      const next = prev.slice(0, index + 1);
      // The crumb you land on is also the document that opens.
      setSelected(next.length > 0 ? next[next.length - 1]! : null);
      return next;
    });
  }, []);

  /** "+ Add document" inside a document: create a child and drill into it. */
  const addSubDocument = useCallback(async (parent: DocumentDTO) => {
    const child = await api.createDocument('Untitled', parent.id);
    setTrail((prev) => (prev.some((d) => d.id === parent.id) ? prev : [...prev, parent]));
    setSelected(child);
    setDocuments((prev) => [child, ...prev]);
  }, []);

  // The DB copy of the title is only written on Hocuspocus's debounce, so keep
  // the sidebar in step with what the author is typing right now.
  const handleTitleChange = useCallback((id: string, title: string) => {
    setDocuments((prev) =>
      prev.map((d) => (d.id === id ? (d.title === title ? d : { ...d, title }) : d)),
    );
    // The open document is usually NOT a sidebar row any more — it is the last
    // breadcrumb — so the trail has to track renames or the crumb goes stale.
    setTrail((prev) =>
      prev.map((d) => (d.id === id ? (d.title === title ? d : { ...d, title }) : d)),
    );
  }, []);

  async function deleteDocument(doc: DocumentDTO) {
    await api.deleteDocument(doc.id);
    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    setSelected((prev) => (prev?.id === doc.id ? null : prev));
    setPendingRestore({ id: doc.id, title: doc.title });
  }

  const restoreDocument = useCallback(async () => {
    if (!pendingRestore) return;
    setPendingRestore(null);
    const restored = await api.restoreDocument(pendingRestore.id);
    // Refetch rather than splice it back: the list is ordered by updatedAt and
    // restore leaves that untouched, so this returns it to its original place.
    await refresh();
    setSelected(restored);
  }, [pendingRestore, refresh]);

  /*
   * Cmd/Ctrl+Z for an undoable document deletion.
   *
   * Captured, not bubbled: an open DocumentEditor has its own window listener
   * for the CRDT undo stack. Handling this in the capture phase lets the most
   * recent action win — while a deletion is undoable it claims the keystroke
   * and stops propagation; otherwise the editor's handler runs untouched.
   */
  useEffect(() => {
    if (!pendingRestore) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      void restoreDocument();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [pendingRestore, restoreDocument]);

  useEffect(() => {
    if (!pendingRestore) return;
    const timer = setTimeout(() => setPendingRestore(null), 7000);
    return () => clearTimeout(timer);
  }, [pendingRestore]);

  if (locked) {
    return (
      <LoginGate
        deniedReason={deniedReason}
        onSignedIn={() => {
          setDeniedReason(null);
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="app">
      <DocumentList
        user={session?.user ?? null}
        onSignOut={handleSignOut}
        documents={documents}
        selectedId={selected?.id ?? null}
        onSelect={openDocument}
        trail={trail}
        onNavigateCrumb={navigateToCrumb}
        onCreate={() => void createDocument()}
        onDelete={(doc) => void deleteDocument(doc)}
      />
      {error && <main className="editor"><p className="error">{error}</p></main>}
      {!error && selected && (
        <DocumentEditor
          key={selected.id}
          document={selected}
          onTitleChange={handleTitleChange}
          onVisibilityChange={handleVisibilityChange}
          onAddSubDocument={() => addSubDocument(selected)}
        />
      )}
      {!error && !selected && (
        <main className="editor empty-state">
          <p>Select a document, or create one to start writing.</p>
        </main>
      )}
      {pendingRestore && (
        <Toast
          message={`Deleted “${pendingRestore.title}”`}
          onUndo={() => void restoreDocument()}
          onDismiss={() => setPendingRestore(null)}
        />
      )}
    </div>
  );
}
