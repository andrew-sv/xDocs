import { formatBytes, type AttachmentUsageDTO } from '@xdocs/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * How much of the file quota this account has used.
 *
 * Shown because the limit is otherwise invisible until an upload is refused,
 * and a refusal is a poor moment to learn there was a limit at all. Refreshed
 * when the window regains focus, which covers uploads made in another tab
 * without polling for something that changes this rarely.
 */
export function StorageUsage() {
  const [usage, setUsage] = useState<AttachmentUsageDTO | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsage(await api.attachmentUsage());
    } catch {
      // Decoration: a failure here must not disturb the sidebar.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // Nothing stored yet: a limit nobody is near is noise.
  if (!usage || usage.usedBytes === 0) return null;

  return (
    <div className="storage-usage" data-testid="storage-usage">
      Files: {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)}
    </div>
  );
}
