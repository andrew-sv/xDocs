import type { TrashEntryDTO } from '@xdocs/shared';

type Props = {
  entries: TrashEntryDTO[];
  loading: boolean;
  onRestore: (entry: TrashEntryDTO) => void;
  onPurge: (entry: TrashEntryDTO) => void;
  onClose: () => void;
};

/** "3 hours ago" — enough to judge age without a date library. */
function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const units: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
  ];
  let value = seconds;
  let label = 'second';
  for (const [step, name] of units) {
    if (value < step) break;
    value = Math.floor(value / step);
    label = name === 'second' ? 'minute' : name;
  }
  const rounded = Math.max(1, Math.floor(value));
  return `${rounded} ${label}${rounded === 1 ? '' : 's'} ago`;
}

export function TrashList({ entries, loading, onRestore, onPurge, onClose }: Props) {
  return (
    <div className="trash" data-testid="trash-view">
      <div className="trash-header">
        <span className="section-label">Trash</span>
        <button type="button" className="crumb" data-testid="trash-close" onClick={onClose}>
          Back to documents
        </button>
      </div>
      <ul className="doc-list" data-testid="trash-list">
        {loading && (
          <li className="doc-loading">
            <span className="spinner" role="status" aria-label="Loading trash" />
          </li>
        )}
        {!loading &&
          entries.map((entry) => (
            <li key={entry.id} className="doc trash-row" data-testid="trash-row" data-doc-id={entry.id}>
              <div className="doc-open trash-entry">
                <span className="doc-title">{entry.title || 'Untitled'}</span>
                <span className="doc-meta">
                  <span className="doc-date">deleted {timeAgo(entry.deletedAt)}</span>
                  {entry.descendantCount > 0 && (
                    <span className="doc-visibility" data-testid="trash-descendants">
                      +{entry.descendantCount} sub-document{entry.descendantCount === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
              </div>
              <div className="trash-actions">
                <button
                  type="button"
                  className="trash-restore"
                  data-testid="trash-restore"
                  title="Restore"
                  onClick={() => onRestore(entry)}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="trash-purge"
                  data-testid="trash-purge"
                  title="Delete forever"
                  onClick={() => onPurge(entry)}
                >
                  Delete forever
                </button>
              </div>
            </li>
          ))}
        {!loading && entries.length === 0 && <li className="empty">Trash is empty.</li>}
      </ul>
    </div>
  );
}
