import { useEffect, useMemo, useState } from 'react';
import type { DocumentDTO } from '@xdocs/shared';

type Props = {
  document: DocumentDTO;
  /** Every visible document, flat — the candidate destinations before filtering. */
  candidates: DocumentDTO[];
  loading: boolean;
  onMove: (parentId: string | null) => void;
  onCancel: () => void;
};

/** Ancestor titles, so two documents with the same name are distinguishable. */
function pathOf(doc: DocumentDTO, byId: Map<string, DocumentDTO>): string {
  const parts: string[] = [];
  let current = doc.parentId ? byId.get(doc.parentId) : undefined;
  // Guard against a malformed chain rather than trusting it to terminate.
  let hops = 0;
  while (current && hops < 50) {
    parts.unshift(current.title || 'Untitled');
    current = current.parentId ? byId.get(current.parentId) : undefined;
    hops += 1;
  }
  return parts.join(' / ');
}

export function MoveDialog({ document, candidates, loading, onMove, onCancel }: Props) {
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const byId = useMemo(() => new Map(candidates.map((doc) => [doc.id, doc])), [candidates]);

  /*
   * A document cannot move inside itself or its own subtree — the server
   * refuses it, but offering the option and then failing is worse than not
   * offering it. Descendants are found by walking each candidate upward, since
   * the flat list carries parent links rather than children.
   */
  const destinations = useMemo(() => {
    const isInsideSubject = (doc: DocumentDTO): boolean => {
      let current: DocumentDTO | undefined = doc;
      let hops = 0;
      while (current && hops < 50) {
        if (current.id === document.id) return true;
        current = current.parentId ? byId.get(current.parentId) : undefined;
        hops += 1;
      }
      return false;
    };
    const needle = filter.trim().toLowerCase();
    return candidates
      .filter((doc) => !isInsideSubject(doc))
      .filter((doc) => doc.id !== document.parentId)
      .filter((doc) =>
        needle.length === 0
          ? true
          : `${pathOf(doc, byId)} ${doc.title}`.toLowerCase().includes(needle),
      )
      .slice(0, 50);
  }, [candidates, byId, document, filter]);

  return (
    <div className="dialog-backdrop" data-testid="move-backdrop" onClick={onCancel}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Move document"
        data-testid="move-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title">Move “{document.title || 'Untitled'}”</h2>
        <p className="dialog-message">
          Its sub-documents move with it. Visibility is unchanged — a public
          document under a private parent stops being visible to others.
        </p>

        <input
          className="search-input"
          data-testid="move-filter"
          placeholder="Filter documents"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />

        <ul className="key-list" data-testid="move-list">
          {document.parentId !== null && (
            <li className="key-row">
              <button
                type="button"
                className="move-option"
                data-testid="move-to-root"
                onClick={() => onMove(null)}
              >
                Top level
              </button>
            </li>
          )}
          {loading && <li className="empty">Loading…</li>}
          {!loading &&
            destinations.map((doc) => (
              <li key={doc.id} className="key-row" data-testid="move-option-row">
                <button
                  type="button"
                  className="move-option"
                  data-testid="move-option"
                  data-doc-id={doc.id}
                  onClick={() => onMove(doc.id)}
                >
                  <span className="doc-title">{doc.title || 'Untitled'}</span>
                  {pathOf(doc, byId) && <span className="search-path">{pathOf(doc, byId)}</span>}
                </button>
              </li>
            ))}
          {!loading && destinations.length === 0 && (
            <li className="empty" data-testid="move-empty">
              Nowhere else to put it.
            </li>
          )}
        </ul>

        <div className="dialog-actions">
          <button type="button" className="dialog-cancel" data-testid="move-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
