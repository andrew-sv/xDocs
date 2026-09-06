import { useCallback, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';

const EMPTY: never[] = [];

/**
 * Subscribe to a Y.Array as immutable React state.
 *
 * `toArray()` allocates a fresh array every call, so it cannot be used directly
 * as getSnapshot — React would see a new identity each render and loop forever.
 * The snapshot is cached and only rebuilt when the array actually changes (or
 * when we're handed a different Y.Array).
 */
export function useYArray<T>(array: Y.Array<T> | null): T[] {
  const cache = useRef<{ src: Y.Array<T> | null; value: T[] }>({ src: null, value: EMPTY });

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!array) return () => {};
      const handler = () => {
        cache.current = { src: array, value: array.toArray() };
        onStoreChange();
      };
      array.observe(handler);
      return () => array.unobserve(handler);
    },
    [array],
  );

  const getSnapshot = useCallback(() => {
    if (!array) return EMPTY;
    if (cache.current.src !== array) {
      cache.current = { src: array, value: array.toArray() };
    }
    return cache.current.value;
  }, [array]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
