import { useCallback, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';

/**
 * Subscribe to a Y.Text as a plain string.
 *
 * Unlike useYArray this needs no snapshot cache: `toString()` allocates a new
 * string each call, but React compares snapshots with Object.is and strings
 * compare by value, so an unchanged document yields a stable snapshot.
 */
export function useYText(ytext: Y.Text | null): string {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!ytext) return () => {};
      ytext.observe(onStoreChange);
      return () => ytext.unobserve(onStoreChange);
    },
    [ytext],
  );

  const getSnapshot = useCallback(() => ytext?.toString() ?? '', [ytext]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Apply a string edit to a Y.Text as a minimal insert/delete pair.
 *
 * Replacing the whole string on every keystroke would work locally but would
 * destroy concurrent edits and collapse everyone's cursor to the end, so we
 * diff off the common prefix and suffix and touch only what actually changed.
 */
export function applyTextEdit(ytext: Y.Text, next: string): void {
  const prev = ytext.toString();
  if (prev === next) return;

  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev[start] === next[start]) start++;

  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }

  const write = () => {
    if (prevEnd > start) ytext.delete(start, prevEnd - start);
    if (nextEnd > start) ytext.insert(start, next.slice(start, nextEnd));
  };

  // One transaction so remote peers see the edit as a single atomic change.
  if (ytext.doc) ytext.doc.transact(write);
  else write();
}
