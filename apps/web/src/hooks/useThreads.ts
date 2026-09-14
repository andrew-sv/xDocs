import { COMMENTS_KEY } from '@xdocs/shared';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { readThreads, type Thread } from '../lib/comments';

const EMPTY: Thread[] = [];

/**
 * Subscribe to the document's comment threads as immutable React state.
 *
 * `observeDeep`, not `observe`: a thread is a nested Y.Map and its comments are
 * another inside that, so a shallow observer would see a thread appear and then
 * miss every reply, edit and deletion within it.
 *
 * The snapshot is cached and rebuilt only when something actually changed —
 * readThreads allocates, and returning a fresh array from getSnapshot on every
 * render would spin React forever. Same reasoning as useYArray.
 */
export function useThreads(ydoc: Y.Doc | null): Thread[] {
  const cache = useRef<{ src: Y.Doc | null; value: Thread[] }>({ src: null, value: EMPTY });

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!ydoc) return () => {};
      const map = ydoc.getMap(COMMENTS_KEY);
      const handler = () => {
        cache.current = { src: ydoc, value: readThreads(ydoc) };
        onStoreChange();
      };
      map.observeDeep(handler);
      return () => map.unobserveDeep(handler);
    },
    [ydoc],
  );

  const getSnapshot = useCallback(() => {
    if (!ydoc) return EMPTY;
    if (cache.current.src !== ydoc) {
      cache.current = { src: ydoc, value: readThreads(ydoc) };
    }
    return cache.current.value;
  }, [ydoc]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
