import type { DocumentDTO, SearchResultDTO, TrashEntryDTO } from '@xdocs/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiKeysDialog } from './components/ApiKeysDialog';
import { DocumentEditor } from './components/DocumentEditor';
import { MoveDialog } from './components/MoveDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DocumentList } from './components/DocumentList';
import { LoginGate } from './components/LoginGate';
import { Toast } from './components/Toast';
import { api } from './lib/api';
import { ForbiddenError, UnauthorizedError, clearToken, signOut, useSession } from './lib/auth';
import { useDocumentsChanged } from './lib/collab';
import { documentIdFromLocation, documentPath } from './lib/route';

/**
 * The trail ending at `doc`, reached from `trail`.
 *
 * A document already on the path is a step back to it, not a step deeper. The
 * sidebar's "Current" row is the last crumb and opens like any other row, so
 * appending unconditionally stacked a duplicate crumb on every click (#11).
 * Otherwise the document goes right after its parent: at the top level if it
 * has none, after the parent's crumb if that is on the path, and at the end of
 * the trail when neither is known.
 */
function pathTo(trail: DocumentDTO[], doc: DocumentDTO): DocumentDTO[] {
  const at = trail.findIndex((d) => d.id === doc.id);
  if (at !== -1) return [...trail.slice(0, at), doc];
  if (doc.parentId === null) return [doc];
  const parentAt = trail.findIndex((d) => d.id === doc.parentId);
  return parentAt === -1 ? [...trail, doc] : [...trail.slice(0, parentAt + 1), doc];
}

export function App() {
  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  /*
   * Which level the loaded list belongs to.
   *
   * Without this the sidebar keeps rendering the previous level's rows until
   * the new fetch returns — you see the old tree for a moment after clicking
   * into a document. Comparing it against the current level tells us the list
   * is stale, so we show a loading state instead of the wrong documents.
   */
  const [documentsParentId, setDocumentsParentId] = useState<string | null>(null);
  const [selected, setSelected] = useState<DocumentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ id: string; title: string } | null>(null);
  const [locked, setLocked] = useState(false);

  /*
   * Whether this account is on its way out, or already gone.
   *
   * Everything fetched here is scoped to the signed-in account, so once sign-out
   * starts nothing it reads may reach the screen. A ref, not state, because the
   * fetches that have to see it are already running and hold a stale closure.
   *
   * A sequence number compared across the await is NOT enough, and that was the
   * first attempt at this: a refetch STARTING during sign-out reads the number
   * after the bump and still carries the token, which is cleared a moment later.
   * It then agrees with itself and lands. What matters is not which session a
   * response belongs to but whether any session is still current.
   */
  const signedOut = useRef(false);

  /*
   * Breadcrumb trail; empty means the top level. Clicking a document both opens
   * it and drills into it, so the trail is also the sidebar's current level.
   * A client-side trail is enough — there is no router and nothing deep-links.
   */
  const [trail, setTrail] = useState<DocumentDTO[]>([]);
  /** Delete is confirmed first — it cascades to the whole subtree. */
  const [pendingDelete, setPendingDelete] = useState<DocumentDTO | null>(null);
  const [deniedReason, setDeniedReason] = useState<string | null>(null);
  /*
   * Trash. Loaded eagerly so the sidebar can show a count without being opened;
   * the request is one row per deletion root, not per deleted document.
   */
  const [trash, setTrash] = useState<TrashEntryDTO[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  /*
   * Search. `query` is what is typed; `results` lags it by a debounce, so the
   * sidebar shows results for a query that may already be a keystroke old —
   * which is why an in-flight response is discarded unless it is still current.
   */
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultDTO[]>([]);
  const [searching, setSearching] = useState(false);
  /** Permanent deletion is confirmed first — nothing restores it afterwards. */
  const [pendingPurge, setPendingPurge] = useState<TrashEntryDTO | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  /** The document being moved, plus every visible document to move it into. */
  const [pendingMove, setPendingMove] = useState<DocumentDTO | null>(null);
  const [moveCandidates, setMoveCandidates] = useState<DocumentDTO[]>([]);
  const [moveLoading, setMoveLoading] = useState(false);
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
    /*
     * Set BEFORE anything is awaited, so no list read from here on reaches the
     * screen — neither one already in flight nor one starting inside the
     * sign-out itself. Signing out during a full parallel e2e run used to land
     * such a response a moment later, and applying it called setLocked(false):
     * the gate never appeared and the sidebar filled back up with the
     * documents the session that just ended could see (#28).
     */
    signedOut.current = true;
    await signOut();
    clearToken();
    setDocuments([]);
    setSelected(null);
    setTrail([]);
    setTrash([]);
    setTrashOpen(false);
    setQuery('');
    setResults([]);
    setLocked(true);
  }, []);

  /*
   * Debounced search.
   *
   * The guard is the same shape as the level guard above and exists for the
   * same reason: responses can arrive out of order, and an older one landing
   * last would show results for a query the user has already moved past.
   */
  const latestQuery = useRef('');
  useEffect(() => {
    const trimmed = query.trim();
    latestQuery.current = trimmed;
    if (trimmed.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const hits = await api.search(trimmed);
        if (latestQuery.current !== trimmed) return;
        setResults(hits);
      } catch {
        if (latestQuery.current === trimmed) setResults([]);
      } finally {
        if (latestQuery.current === trimmed) setSearching(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  /** Open a hit where it actually lives, so the breadcrumb is its real path. */
  const openSearchResult = useCallback((result: SearchResultDTO) => {
    setQuery('');
    setResults([]);
    setTrail([...result.path, result.document]);
    setSelected(result.document);
  }, []);

  const refreshTrash = useCallback(async () => {
    if (signedOut.current) return;
    try {
      const rows = await api.listTrash();
      if (signedOut.current) return; // signed out meanwhile
      setTrash(rows);
    } catch {
      // The count is decoration; a failure here must not blank the sidebar.
    }
  }, []);

  const currentParentId = trail.length > 0 ? trail[trail.length - 1]!.id : null;

  /*
   * The level a response must still be for to be applied.
   *
   * Two level fetches can be in flight at once (open a document while the root
   * list is still loading). Without this guard a slower EARLIER response
   * overwrites the newer one, leaving the list pinned to a level nobody is
   * looking at — and the sidebar stuck on its loading state.
   */
  const latestLevel = useRef<string | null>(currentParentId);
  latestLevel.current = currentParentId;

  /*
   * Titles typed in this tab that the server has not stored yet.
   *
   * The title column is written on the collab server's debounced save, so a
   * list fetched in the meantime still carries the old title — and since any
   * change anywhere now triggers a refetch (#22), one can land at any moment.
   * Applied as-is, it flipped a title being typed back to "Untitled". An entry
   * goes once a fetched row agrees with it, or after 30s as a backstop (the
   * save itself pings, so agreement normally comes within seconds).
   */
  const unsavedTitles = useRef(new Map<string, { title: string; at: number }>());
  const withUnsavedTitles = useCallback((rows: DocumentDTO[]): DocumentDTO[] => {
    const pending = unsavedTitles.current;
    return rows.map((row) => {
      const typed = pending.get(row.id);
      if (!typed) return row;
      if (row.title === typed.title || Date.now() - typed.at > 30_000) {
        pending.delete(row.id);
        return row;
      }
      return { ...row, title: typed.title };
    });
  }, []);

  /*
   * Which list responses may still be applied, beyond the level guard above.
   *
   * - A local change (`invalidateList`) retires every fetch already in flight:
   *   creating a document while the FIRST list fetch is outstanding is the
   *   same level, so that response would land afterwards and wipe the row just
   *   added — the new document open but missing from the sidebar.
   * - Otherwise a list older than the one on screen is dropped. "Older" is the
   *   server's read time (x-list-as-of), not the order fetches were sent:
   *   under load the server answers out of order, and a list sent later but
   *   read earlier used to land last and hide a document just restored.
   *
   * Fetches deliberately do not cancel each other. Every ping from the server
   * starts one (#22), and when each new fetch retired the last, a steady
   * stream of pings meant no response ever landed and the sidebar froze.
   */
  const changeSeq = useRef(0);
  const shownList = useRef<{ level: string | null; asOf: number } | null>(null);
  const invalidateList = () => {
    changeSeq.current += 1;
  };

  const refresh = useCallback(async () => {
    if (signedOut.current) return;
    const changesAtStart = changeSeq.current;
    try {
      const { rows, asOf } = await api.listLevel(currentParentId);
      if (signedOut.current) return; // signed out meanwhile
      if (latestLevel.current !== currentParentId) return; // navigated elsewhere
      if (changeSeq.current !== changesAtStart) return; // fetched before a local change
      const shown = shownList.current;
      if (shown?.level === currentParentId && asOf < shown.asOf) return; // older than what is shown
      shownList.current = { level: currentParentId, asOf };
      setDocuments(withUnsavedTitles(rows));
      setDocumentsParentId(currentParentId);
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
  }, [currentParentId, withUnsavedTitles]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (locked) return;
    void refreshTrash();
  }, [locked, refreshTrash]);

  /*
   * The open document lives in the URL, /doc/<id> (see lib/route.ts).
   *
   * `selected` stays the source of truth inside the app; the URL follows it,
   * and is read back only at load and on Back/Forward. `routeReady` holds the
   * sync off until a document named at load has been resolved — otherwise the
   * empty first render would rewrite /doc/<id> to / before it could open.
   * `missingId` is a URL naming a document that cannot be opened (deleted, not
   * shared with you, or never existed); it stays in the address bar, so a
   * reload after the owner shares it still works.
   */
  const [routeReady, setRouteReady] = useState(() => documentIdFromLocation() === null);
  const [missingId, setMissingId] = useState<string | null>(null);
  const routeSeq = useRef(0);

  const openFromLocation = useCallback(async () => {
    const seq = ++routeSeq.current;
    const id = documentIdFromLocation();
    if (!id) {
      setSelected(null);
      setTrail([]);
      setMissingId(null);
      setRouteReady(true);
      return;
    }
    try {
      const [doc, path] = await Promise.all([api.getDocument(id), api.getDocumentPath(id)]);
      // Back pressed twice quickly: only the latest location may land.
      if (seq !== routeSeq.current) return;
      // Drilled in, as a search result opens: breadcrumbs are the real path,
      // and the sidebar shows this document's sub-documents.
      setTrail([...path, doc]);
      setSelected(doc);
      setMissingId(null);
    } catch (e) {
      if (seq !== routeSeq.current) return;
      // Not signed in yet: the gate shows, and this runs again after sign-in.
      if (e instanceof UnauthorizedError || e instanceof ForbiddenError) return;
      setSelected(null);
      setTrail([]);
      setMissingId(id);
    }
    setRouteReady(true);
  }, []);

  useEffect(() => {
    void openFromLocation();
    const onPopState = () => void openFromLocation();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openFromLocation]);

  const selectedDocId = selected?.id ?? null;
  useEffect(() => {
    if (!routeReady) return;
    // Opening a real document leaves a not-found URL behind.
    if (selectedDocId) setMissingId(null);
    const target = documentPath(selectedDocId ?? missingId);
    // Equal when the change came from the URL itself (load, Back, Forward).
    if (window.location.pathname !== target) window.history.pushState(null, '', target);
  }, [routeReady, selectedDocId, missingId]);

  /*
   * Documents change elsewhere too — other people, other tabs, scripts, the
   * MCP server — and the sidebar used to show them only after a reload (#22).
   * Both refetches are safe to fire at any time: refresh() drops a list that a
   * local change has overtaken, or that is older than the one on screen.
   */
  const refreshFromElsewhere = useCallback(() => {
    void refresh();
    void refreshTrash();
  }, [refresh, refreshTrash]);

  /*
   * Live: the server pings when the list may have changed. Only the list is
   * refetched — pings mostly come from other people, whose changes never touch
   * this user's trash, and every ping reaches every open app.
   */
  // Returns its promise so the hook can keep one refetch in flight at a time.
  const refreshList = useCallback(() => refresh(), [refresh]);
  useDocumentsChanged(!locked, refreshList);

  // Backstop for anything the pings missed, e.g. while the laptop slept, and
  // for the trash, which pings leave alone.
  useEffect(() => {
    if (locked) return;
    const onReturn = () => {
      if (document.visibilityState === 'visible') refreshFromElsewhere();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [locked, refreshFromElsewhere]);

  const openTrash = useCallback(async () => {
    setTrashOpen(true);
    setTrashLoading(true);
    try {
      setTrash(await api.listTrash());
    } finally {
      setTrashLoading(false);
    }
  }, []);

  /**
   * Open a restored document where it actually lives, with the sidebar at its
   * parent's level.
   *
   * That is not necessarily the level on screen, and not necessarily where it
   * used to be either: restore lifts a document to the top level when its
   * parent is still deleted. The trail used to be reset to the top level,
   * which showed a nested document with no breadcrumbs and outside its tree.
   */
  const openRestored = useCallback(
    async (restored: DocumentDTO) => {
      const path = await api.getDocumentPath(restored.id).catch(() => null);
      if (path) setTrail(path);
      setSelected(restored);
      /*
       * Refetch rather than splice the row in: the list is ordered by
       * updatedAt, which restore leaves alone. When the level changed, the
       * level effect fetches the new one and this response is discarded by
       * refresh()'s own guard; when it did not, this is the fetch that
       * brings the row back.
       */
      await refresh();
    },
    [refresh],
  );

  const restoreFromTrash = useCallback(
    async (entry: TrashEntryDTO) => {
      const restored = await api.restoreDocument(entry.id);
      setTrash((prev) => prev.filter((t) => t.id !== entry.id));
      setTrashOpen(false);
      await openRestored(restored);
    },
    [openRestored],
  );

  const purgeDocument = useCallback(async (entry: TrashEntryDTO) => {
    await api.permanentlyDelete(entry.id);
    setTrash((prev) => prev.filter((t) => t.id !== entry.id));
  }, []);

  async function createDocument() {
    // Created at whatever level the sidebar is showing.
    const doc = await api.createDocument('Untitled', currentParentId);
    invalidateList();
    setDocuments((prev) => [doc, ...prev]);
    setSelected(doc);
  }

  /** Open a document AND show its sub-documents in the sidebar. */
  const openDocument = useCallback((doc: DocumentDTO) => {
    setSelected(doc);
    setTrail((prev) => pathTo(prev, doc));
  }, []);

  /**
   * Follow a sub-document link. The parent is the open document, which is not
   * always on the trail — a just-added sub-document is opened without drilling
   * into it — so it is put on the path first and the child goes under it.
   */
  const openSubDocument = useCallback((parent: DocumentDTO, child: DocumentDTO) => {
    setSelected(child);
    setTrail((prev) => pathTo(pathTo(prev, parent), child));
  }, []);

  /*
   * Sub-documents of the open document, for the links at its foot.
   *
   * When the open document is the sidebar's current level, its children ARE
   * the sidebar's list, so reuse it: a new child, a rename typed a moment ago
   * or a delete shows up at once, instead of after the server's debounced copy.
   * The open document is not always that level (a just-added sub-document, one
   * restored by undo), and then its children are fetched.
   */
  const selectedId = selected?.id ?? null;
  const childrenAreSidebarLevel = selectedId !== null && selectedId === currentParentId;
  const [fetchedChildren, setFetchedChildren] = useState<{ parentId: string; docs: DocumentDTO[] } | null>(
    null,
  );
  useEffect(() => {
    if (selectedId === null || childrenAreSidebarLevel) return;
    let current = true;
    api.listDocuments(selectedId).then(
      (docs) => {
        if (current) setFetchedChildren({ parentId: selectedId, docs: withUnsavedTitles(docs) });
      },
      // Links are a convenience; the sidebar still reaches every child.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [selectedId, childrenAreSidebarLevel]);
  const subDocuments = childrenAreSidebarLevel
    ? documentsParentId === currentParentId
      ? documents
      : []
    : fetchedChildren?.parentId === selectedId
      ? fetchedChildren.docs
      : [];

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
    invalidateList();
    /*
     * The parent now has a child, and both the trail and the list hold DTO
     * snapshots — without this they keep reporting hasChildren: false, so the
     * sidebar loses its ▸ marker and the delete dialog stops warning that
     * sub-documents will go too.
     */
    const withChild = (d: DocumentDTO) => (d.id === parent.id ? { ...d, hasChildren: true } : d);
    setTrail((prev) => {
      const updated = prev.map(withChild);
      return updated.some((d) => d.id === parent.id)
        ? updated
        : [...updated, { ...parent, hasChildren: true }];
    });
    setSelected(child);
    setDocuments((prev) => [child, ...prev.map(withChild)]);
  }, []);

  // The DB copy of the title is only written on Hocuspocus's debounce, so keep
  // the sidebar in step with what the author is typing right now.
  const handleTitleChange = useCallback((id: string, title: string) => {
    unsavedTitles.current.set(id, { title, at: Date.now() });
    setDocuments((prev) =>
      prev.map((d) => (d.id === id ? (d.title === title ? d : { ...d, title }) : d)),
    );
    // The open document is usually NOT a sidebar row any more — it is the last
    // breadcrumb — so the trail has to track renames or the crumb goes stale.
    setTrail((prev) =>
      prev.map((d) => (d.id === id ? (d.title === title ? d : { ...d, title }) : d)),
    );
  }, []);

  const startMove = useCallback(async (doc: DocumentDTO) => {
    setPendingMove(doc);
    setMoveLoading(true);
    try {
      setMoveCandidates(await api.listAllDocuments());
    } finally {
      setMoveLoading(false);
    }
  }, []);

  const moveDocument = useCallback(
    async (doc: DocumentDTO, parentId: string | null) => {
      const moved = await api.moveDocument(doc.id, parentId);
      invalidateList();
      /*
       * The document has left the level being shown, so drop it from the list
       * and walk the trail back above it — staying "inside" a document that is
       * no longer on this path would show a level nobody navigated to.
       */
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      setTrail((prev) => {
        const index = prev.findIndex((d) => d.id === doc.id);
        if (index === -1) return prev;
        const next = prev.slice(0, index);
        setSelected(next.length > 0 ? next[next.length - 1]! : null);
        return next;
      });
      setSelected((prev) => (prev?.id === doc.id ? moved : prev));
      await refresh();
    },
    [refresh],
  );

  async function deleteDocument(doc: DocumentDTO) {
    await api.deleteDocument(doc.id);
    invalidateList();
    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    setSelected((prev) => (prev?.id === doc.id ? null : prev));
    // If the deleted document is on the path, walk back above it — staying
    // inside a document that no longer exists would show an empty sidebar.
    setTrail((prev) => {
      const index = prev.findIndex((d) => d.id === doc.id);
      if (index === -1) return prev;
      const next = prev.slice(0, index);
      setSelected(next.length > 0 ? next[next.length - 1]! : null);
      return next;
    });
    setPendingRestore({ id: doc.id, title: doc.title });
    void refreshTrash();
  }

  const restoreDocument = useCallback(async () => {
    if (!pendingRestore) return;
    setPendingRestore(null);
    const restored = await api.restoreDocument(pendingRestore.id);
    void refreshTrash();
    // Usually still the level on screen, but the undo stays offered for seven
    // seconds and the user may have navigated away in that time.
    await openRestored(restored);
  }, [pendingRestore, openRestored]);

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
          // There is a session again, so reads may reach the screen once more.
          // Without this, signing back in after a sign-out would load nothing.
          signedOut.current = false;
          setDeniedReason(null);
          void refresh();
          // A link opened while signed out is resolved now.
          void openFromLocation();
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
        current={trail.length > 0 ? trail[trail.length - 1]! : null}
        loading={documentsParentId !== currentParentId}
        onNavigateCrumb={navigateToCrumb}
        onCreate={() => void createDocument()}
        onDelete={(doc) => setPendingDelete(doc)}
        onMove={(doc) => void startMove(doc)}
        trash={trash}
        trashOpen={trashOpen}
        trashLoading={trashLoading}
        onOpenTrash={() => void openTrash()}
        onCloseTrash={() => setTrashOpen(false)}
        onRestoreFromTrash={(entry) => void restoreFromTrash(entry)}
        onPurge={(entry) => setPendingPurge(entry)}
        query={query}
        results={results}
        searching={searching}
        onQueryChange={(next) => {
          setQuery(next);
          // Searching spans the whole tree, so staying in trash mode while
          // results render underneath would be showing two lists at once.
          if (next.trim().length > 0) setTrashOpen(false);
        }}
        onOpenSearchResult={openSearchResult}
        onOpenKeys={() => setKeysOpen(true)}
      />
      {error && <main className="editor"><p className="error">{error}</p></main>}
      {!error && selected && (
        <DocumentEditor
          key={selected.id}
          document={selected}
          onTitleChange={handleTitleChange}
          onVisibilityChange={handleVisibilityChange}
          onAddSubDocument={() => addSubDocument(selected)}
          subDocuments={subDocuments}
          onOpenSubDocument={(child) => openSubDocument(selected, child)}
        />
      )}
      {!error && !selected && !routeReady && (
        // A link is being opened: not the "select a document" prompt, which
        // would flash up before the document it names.
        <main className="editor empty-state" data-testid="doc-opening">
          <span className="spinner" role="status" aria-label="Opening document" />
        </main>
      )}
      {!error && !selected && routeReady && missingId && (
        <main className="editor empty-state" data-testid="doc-not-found">
          <p>This document doesn’t exist, has been deleted, or isn’t shared with you.</p>
        </main>
      )}
      {!error && !selected && routeReady && !missingId && (
        <main className="editor empty-state">
          <p>Select a document, or create one to start writing.</p>
        </main>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete document"
          message={`“${pendingDelete.title || 'Untitled'}” will be moved to the bin. You can undo this straight afterwards.`}
          warning={
            pendingDelete.hasChildren
              ? 'Its sub-documents will be deleted too, and restored together if you undo.'
              : null
          }
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const doc = pendingDelete;
            setPendingDelete(null);
            void deleteDocument(doc);
          }}
        />
      )}
      {keysOpen && <ApiKeysDialog onClose={() => setKeysOpen(false)} />}
      {pendingMove && (
        <MoveDialog
          document={pendingMove}
          candidates={moveCandidates}
          loading={moveLoading}
          onCancel={() => setPendingMove(null)}
          onMove={(parentId) => {
            const doc = pendingMove;
            setPendingMove(null);
            void moveDocument(doc, parentId);
          }}
        />
      )}
      {pendingPurge && (
        <ConfirmDialog
          title="Delete forever"
          // Deliberately not softened: this is the one action in the app that
          // destroys content, and there is no undo behind it.
          message={`“${pendingPurge.title || 'Untitled'}” and everything written in it will be permanently deleted. This cannot be undone.`}
          warning={
            pendingPurge.descendantCount > 0
              ? `${pendingPurge.descendantCount} sub-document${
                  pendingPurge.descendantCount === 1 ? '' : 's'
                } will be permanently deleted too.`
              : null
          }
          confirmLabel="Delete forever"
          onCancel={() => setPendingPurge(null)}
          onConfirm={() => {
            const entry = pendingPurge;
            setPendingPurge(null);
            void purgeDocument(entry);
          }}
        />
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
