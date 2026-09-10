import type { DocumentDTO } from '@xdocs/shared';

type SignedInUser = { name?: string | null; email: string; image?: string | null };

type Props = {
  user: SignedInUser | null;
  /** Breadcrumb path; empty means the top level. */
  trail: DocumentDTO[];
  onNavigateCrumb: (index: number) => void;
  onSignOut: () => void;
  documents: DocumentDTO[];
  selectedId: string | null;
  onSelect: (doc: DocumentDTO) => void;
  onCreate: () => void;
  onDelete: (doc: DocumentDTO) => void;
};

export function DocumentList({
  user,
  trail,
  onNavigateCrumb,
  onSignOut,
  documents,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="brand">xDocs</span>
        <button type="button" onClick={onCreate} title="New document" data-testid="new-document">
          + New
        </button>
      </div>
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
      <ul className="doc-list">
        {documents.map((doc) => (
          <li
            key={doc.id}
            className={doc.id === selectedId ? 'doc selected' : 'doc'}
            data-testid="doc-row"
            data-doc-id={doc.id}
          >
            <button
              type="button"
              className="doc-open"
              data-testid="doc-open"
              onClick={() => onSelect(doc)}
            >
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
        ))}
        {documents.length === 0 && (
          <li className="empty">{trail.length > 0 ? 'No sub-documents yet.' : 'No documents yet.'}</li>
        )}
      </ul>
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
