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
 *
 * At most one refetch runs at a time, and pings arriving during it collapse
 * into a single trailing one. Every ping reaches every signed-in user, so a
 * workspace several people are editing at once pings faster than the 250ms
 * debounce gap — the debounce alone then fires per gap rather than per burst,
 * and with each fetch outlasting the interval between them the requests pile
 * up without bound. That is what a parallel e2e run does to the dev stack
 * (#28): list fetches stacked up until they took eight seconds each and
 * assertions timed out all over the suite. Note this DELAYS a fetch, it never
 * retires one — a fetch that cancelled the one in flight would leave the
 * sidebar frozen under a steady stream of pings, which is a bug we have
 * already shipped once.
 */
export function useDocumentsChanged(enabled: boolean, onChange: () => void | Promise<void>): void {
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await callback.current();
        } while (again);
      } finally {
        running = false;
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), 250);
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
