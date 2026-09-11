import { SNIPPET_CLOSE, SNIPPET_OPEN, type SearchResultDTO } from '@xdocs/shared';

type Props = {
  query: string;
  results: SearchResultDTO[];
  loading: boolean;
  onOpen: (result: SearchResultDTO) => void;
};

/**
 * Render a snippet, highlighting the [[marked]] runs.
 *
 * The server marks matches with brackets rather than HTML precisely so this can
 * stay text nodes: a document containing <script> is just characters here.
 */
function Snippet({ text }: { text: string }) {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let rest = text;
  while (rest.length > 0) {
    const start = rest.indexOf(SNIPPET_OPEN);
    if (start === -1) {
      parts.push({ text: rest, hit: false });
      break;
    }
    const end = rest.indexOf(SNIPPET_CLOSE, start);
    if (end === -1) {
      parts.push({ text: rest, hit: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), hit: false });
    parts.push({ text: rest.slice(start + SNIPPET_OPEN.length, end), hit: true });
    rest = rest.slice(end + SNIPPET_CLOSE.length);
  }
  return (
    <span className="search-snippet" data-testid="search-snippet">
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} data-testid="search-hit">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

export function SearchResults({ query, results, loading, onOpen }: Props) {
  return (
    <div className="search-results" data-testid="search-results">
      <span className="section-label">
        {loading ? 'Searching…' : `${results.length} result${results.length === 1 ? '' : 's'}`}
      </span>
      <ul className="doc-list" data-testid="search-list">
        {results.map((result) => (
          <li
            key={result.document.id}
            className="doc search-row"
            data-testid="search-row"
            data-doc-id={result.document.id}
          >
            <button
              type="button"
              className="doc-open"
              data-testid="search-open"
              onClick={() => onOpen(result)}
            >
              <span className="doc-title">{result.document.title || 'Untitled'}</span>
              {result.path.length > 0 && (
                <span className="search-path" data-testid="search-path">
                  {result.path.map((ancestor) => ancestor.title || 'Untitled').join(' / ')}
                </span>
              )}
              {result.snippet.trim().length > 0 && <Snippet text={result.snippet} />}
            </button>
          </li>
        ))}
        {!loading && results.length === 0 && (
          <li className="empty" data-testid="search-empty">
            Nothing matches “{query}”.
          </li>
        )}
      </ul>
    </div>
  );
}
