import type { DocumentDTO, SearchResultDTO, TrashEntryDTO } from '@xdocs/shared';
import { SearchResults } from './SearchResults';
import { TrashList } from './TrashList';

type SignedInUser = { name?: string | null; email: string; image?: string | null };

type Props = {
  user: SignedInUser | null;
  /** Breadcrumb path; empty means the top level. */
  trail: DocumentDTO[];
  /** The document currently open — pinned above its sub-documents. */
  current: DocumentDTO | null;
  /** The loaded list belongs to a different level; do not render it. */
  loading: boolean;
  onNavigateCrumb: (index: number) => void;
  onSignOut: () => void;
  documents: DocumentDTO[];
  selectedId: string | null;
  onSelect: (doc: DocumentDTO) => void;
  onCreate: () => void;
  onDelete: (doc: DocumentDTO) => void;
  trash: TrashEntryDTO[];
  trashOpen: boolean;
  trashLoading: boolean;
  onOpenTrash: () => void;
  onCloseTrash: () => void;
  onRestoreFromTrash: (entry: TrashEntryDTO) => void;
  onPurge: (entry: TrashEntryDTO) => void;
  query: string;
  results: SearchResultDTO[];
  searching: boolean;
  onQueryChange: (query: string) => void;
  onOpenSearchResult: (result: SearchResultDTO) => void;
  onOpenKeys: () => void;
};

function DocumentRow({
  doc,
  selected,
  onSelect,
  onDelete,
}: {
  doc: DocumentDTO;
  selected: boolean;
  onSelect: (doc: DocumentDTO) => void;
  onDelete: (doc: DocumentDTO) => void;
}) {
  return (
    <li
      className={selected ? 'doc selected' : 'doc'}
      data-testid="doc-row"
      data-doc-id={doc.id}
    >
      <button type="button" className="doc-open" data-testid="doc-open" onClick={() => onSelect(doc)}>
        <span className="doc-title">
          {doc.hasChildren && (
            <span className="doc-haschildren" data-testid="doc-haschildren" title="Has sub-documents">
              ▸
            </span>
          )}
          {doc.title}
        </span>
        <span className="doc-meta">
          <span
            className={`doc-visibility doc-visibility-${doc.visibility}`}
            data-testid="doc-visibility"
            title={doc.visibility === 'public' ? 'Visible to everyone' : 'Only you'}
          >
            {doc.visibility === 'public' ? '🌐 Public' : '🔒 Private'}
          </span>
          <span className="doc-date">{new Date(doc.updatedAt).toLocaleString()}</span>
        </span>
      </button>
      {/* Only the owner may delete; the API enforces this too. */}
      {doc.isOwner && (
        <button
          type="button"
          className="doc-delete"
          data-testid="doc-delete"
          title="Delete document"
          onClick={() => onDelete(doc)}
        >
          ×
        </button>
      )}
    </li>
  );
}

export function DocumentList({
  user,
  trail,
  current,
  loading,
  onNavigateCrumb,
  onSignOut,
  documents,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
  trash,
  trashOpen,
  trashLoading,
  onOpenTrash,
  onCloseTrash,
  onRestoreFromTrash,
  onPurge,
  query,
  results,
  searching,
  onQueryChange,
  onOpenSearchResult,
  onOpenKeys,
}: Props) {
  const searchActive = query.trim().length > 0;
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="brand">xDocs</span>
        <button type="button" onClick={onCreate} title="New document" data-testid="new-document">
          + New
        </button>
      </div>
      <div className="search-box">
        <input
          type="search"
          className="search-input"
          data-testid="search-input"
          placeholder="Search documents"
          aria-label="Search documents"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears rather than blurs: with a search open, backing out
            // of it is what you want the key for.
            if (event.key === 'Escape' && query.length > 0) {
              event.preventDefault();
              onQueryChange('');
            }
          }}
        />
      </div>
      {searchActive ? (
        <SearchResults
          query={query.trim()}
          results={results}
          loading={searching}
          onOpen={onOpenSearchResult}
        />
      ) : trashOpen ? (
        <TrashList
          entries={trash}
          loading={trashLoading}
          onRestore={onRestoreFromTrash}
          onPurge={onPurge}
          onClose={onCloseTrash}
        />
      ) : (
        <>
      {trail.length > 0 && (
        <nav className="crumbs" data-testid="crumbs" aria-label="Document path">
          <button type="button" className="crumb" data-testid="crumb-root" onClick={() => onNavigateCrumb(-1)}>
            All
          </button>
          {trail.map((doc, index) => (
            <span key={doc.id} className="crumb-part">
              <span className="crumb-sep">/</span>
              <button
                type="button"
                className="crumb"
                data-testid="crumb"
                onClick={() => onNavigateCrumb(index)}
              >
                {doc.title || 'Untitled'}
              </button>
            </span>
          ))}
        </nav>
      )}
      {current && (
        /*
         * The open document stays visible in the sidebar, not only in the
         * breadcrumb — otherwise it vanishes the moment you open it, and its
         * delete control goes with it.
         */
        <div className="current-doc" data-testid="current-doc">
          <span className="section-label">Current</span>
          <ul className="doc-list">
            <DocumentRow
              doc={current}
              selected={current.id === selectedId}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          </ul>
          <span className="section-label">Sub-documents</span>
        </div>
      )}
      <ul className="doc-list" data-testid="doc-list">
        {loading ? (
          // Never render the previous level's rows — showing the wrong tree for
          // a moment reads as a glitch, and worse, invites a misdirected click.
          <li className="doc-loading" data-testid="doc-list-loading">
            <span className="spinner" role="status" aria-label="Loading documents" />
          </li>
        ) : (
          <>
            {documents.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                selected={doc.id === selectedId}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
            {documents.length === 0 && (
              <li className="empty">
                {trail.length > 0 ? 'No sub-documents yet.' : 'No documents yet.'}
              </li>
            )}
          </>
        )}
      </ul>
        </>
      )}
      <button
        type="button"
        className={trashOpen ? 'trash-toggle active' : 'trash-toggle'}
        data-testid="trash-toggle"
        onClick={trashOpen ? onCloseTrash : onOpenTrash}
      >
        <span>🗑 Trash</span>
        {trash.length > 0 && (
          <span className="trash-count" data-testid="trash-count">
            {trash.length}
          </span>
        )}
      </button>
      <button type="button" className="trash-toggle" data-testid="keys-toggle" onClick={onOpenKeys}>
        <span>🔑 API keys</span>
      </button>
      {user && (
        <div className="account" data-testid="account">
          {user.image && <img className="account-avatar" src={user.image} alt="" />}
          <span className="account-name" title={user.email}>
            {user.name || user.email}
          </span>
          <button type="button" className="account-signout" data-testid="sign-out" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </aside>
  );
}
