import { HocuspocusProvider } from '@hocuspocus/provider';
import { DOCUMENTS_CHANGED, WORKSPACE_DOC_NAME } from '@xdocs/shared';
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { getToken } from './auth';

export const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:3001';

/**
 * Call `onChange` whenever the document list may have changed elsewhere:
 * another person, another tab, a script, the MCP server.
 *
 * The server pings a content-free channel (WORKSPACE_DOC_NAME) and the caller
 * refetches over REST, so what anyone sees is still decided by REST's access
 * rules. Debounced, because one action can ping twice (the route, then the
 * debounced title save) and a burst should cost one refetch. A reconnect also
 * counts as a change: pings sent while the socket was down are lost.
 */
export function useDocumentsChanged(enabled: boolean, onChange: () => void): void {
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => callback.current(), 250);
    };
    let syncedBefore = false;
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: COLLAB_URL,
      name: WORKSPACE_DOC_NAME,
      document: ydoc,
      token: () => getToken() ?? '',
      onStateless: ({ payload }) => {
        if (payload === DOCUMENTS_CHANGED) schedule();
      },
      // The first sync is the initial connection, which the initial list
      // fetch already covers; any later one is a reconnect.
      onSynced: () => {
        if (syncedBefore) schedule();
        syncedBefore = true;
      },
    });
    return () => {
      clearTimeout(timer);
      provider.destroy();
      ydoc.destroy();
    };
  }, [enabled]);
}
