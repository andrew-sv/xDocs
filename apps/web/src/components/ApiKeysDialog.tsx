import { useCallback, useEffect, useState } from 'react';
import type { ApiKeyDTO, CreatedApiKeyDTO } from '@xdocs/shared';
import { api } from '../lib/api';

type Props = { onClose: () => void };

export function ApiKeysDialog({ onClose }: Props) {
  const [keys, setKeys] = useState<ApiKeyDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  /*
   * The key is shown once and only once — the server stores a hash, so this is
   * genuinely the only moment it exists outside the caller's hands. Kept in
   * state rather than in the list, so it cannot be confused for something the
   * list could show again.
   */
  const [created, setCreated] = useState<CreatedApiKeyDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setKeys(await api.listApiKeys());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function create() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setError(null);
    try {
      const key = await api.createApiKey(trimmed);
      setCreated(key);
      setName('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function revoke(key: ApiKeyDTO) {
    await api.revokeApiKey(key.id);
    if (created?.id === key.id) setCreated(null);
    await refresh();
  }

  return (
    <div className="dialog-backdrop" data-testid="keys-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="API keys"
        data-testid="keys-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title">API keys</h2>
        <p className="dialog-message">
          A key acts as you: same documents, same permissions. Send it as{' '}
          <code>Authorization: Bearer …</code>.
        </p>

        <div className="key-create">
          <input
            className="search-input"
            data-testid="key-name"
            placeholder="What is it for?"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void create();
              }
            }}
          />
          <button type="button" data-testid="key-create" onClick={() => void create()}>
            Create key
          </button>
        </div>
        {error && <p className="dialog-warning">{error}</p>}

        {created && (
          <div className="key-revealed" data-testid="key-revealed">
            <p className="dialog-warning">
              Copy this now — it is stored hashed and cannot be shown again.
            </p>
            <code className="key-value" data-testid="key-value">
              {created.key}
            </code>
          </div>
        )}

        <ul className="key-list" data-testid="key-list">
          {loading && <li className="empty">Loading…</li>}
          {!loading &&
            keys.map((key) => (
              <li key={key.id} className="key-row" data-testid="key-row">
                <span className="key-name">{key.name}</span>
                <span className="key-meta">
                  <code>{key.prefix}…</code>
                  <span>
                    {key.lastUsedAt
                      ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                      : 'never used'}
                  </span>
                </span>
                <button
                  type="button"
                  className="key-revoke"
                  data-testid="key-revoke"
                  onClick={() => void revoke(key)}
                >
                  Revoke
                </button>
              </li>
            ))}
          {!loading && keys.length === 0 && <li className="empty">No keys yet.</li>}
        </ul>

        <div className="dialog-actions">
          <button type="button" className="dialog-cancel" data-testid="keys-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
