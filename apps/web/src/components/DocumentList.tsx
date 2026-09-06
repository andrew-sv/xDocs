import type { DocumentDTO } from '@xdocs/shared';

type Props = {
  documents: DocumentDTO[];
  selectedId: string | null;
  onSelect: (doc: DocumentDTO) => void;
  onCreate: () => void;
  onDelete: (doc: DocumentDTO) => void;
};

export function DocumentList({ documents, selectedId, onSelect, onCreate, onDelete }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="brand">xDocs</span>
        <button type="button" onClick={onCreate} title="New document">
          + New
        </button>
      </div>
      <ul className="doc-list">
        {documents.map((doc) => (
          <li key={doc.id} className={doc.id === selectedId ? 'doc selected' : 'doc'}>
            <button type="button" className="doc-open" onClick={() => onSelect(doc)}>
              <span className="doc-title">{doc.title}</span>
              <span className="doc-date">{new Date(doc.updatedAt).toLocaleString()}</span>
            </button>
            <button
              type="button"
              className="doc-delete"
              title="Delete document"
              onClick={() => onDelete(doc)}
            >
              ×
            </button>
          </li>
        ))}
        {documents.length === 0 && <li className="empty">No documents yet.</li>}
      </ul>
    </aside>
  );
}
