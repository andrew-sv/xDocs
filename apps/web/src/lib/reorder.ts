import type { BlockMeta } from '@xdocs/shared';
import type * as Y from 'yjs';

export type DropEdge = 'above' | 'below';

/**
 * A private MIME type, deliberately not `text/plain`.
 *
 * ProseMirror handles drop events on its own editable region, and would happily
 * insert a text/plain payload as literal text if a drop landed inside a block.
 */
export const BLOCK_DRAG_MIME = 'application/x-xdocs-block';

/**
 * Turn "dropped on `targetId`, on its `edge`" into concrete array indices,
 * or null when the move would be a no-op (dropping a block back where it is).
 */
export function resolveMove(
  blocks: readonly BlockMeta[],
  draggedId: string,
  targetId: string,
  edge: DropEdge,
): { from: number; to: number } | null {
  const from = blocks.findIndex((b) => b.id === draggedId);
  const targetIndex = blocks.findIndex((b) => b.id === targetId);
  if (from === -1 || targetIndex === -1) return null;

  const to = edge === 'below' ? targetIndex + 1 : targetIndex;
  // `to === from + 1` means "insert directly after itself" — same position.
  if (to === from || to === from + 1) return null;
  return { from, to };
}

/** Clamp a keyboard nudge to the ends of the list; null when it can't move. */
export function resolveNudge(
  blocks: readonly BlockMeta[],
  id: string,
  direction: -1 | 1,
): { from: number; to: number } | null {
  const from = blocks.findIndex((b) => b.id === id);
  if (from === -1) return null;
  const target = from + direction;
  if (target < 0 || target >= blocks.length) return null;
  // Moving down one slot means landing *after* the neighbour, hence the +1.
  return { from, to: direction === 1 ? target + 1 : target };
}

/**
 * Move a block within the Y.Array.
 *
 * Yjs has no atomic move operation, so this is a delete plus an insert inside a
 * single transaction. The consequence is real and worth knowing: if two people
 * move the same block at the same instant, the block can end up duplicated or
 * dropped, because each peer's delete and insert interleave independently.
 * That is exactly why upstream has never shipped a move primitive, and it is an
 * accepted tradeoff here — ordinary concurrent editing is unaffected.
 *
 * The block's rich text needs no migration: it lives in a top-level fragment
 * keyed by block id, so reordering the metadata carries the content with it.
 */
export function applyMove(array: Y.Array<BlockMeta>, from: number, to: number): void {
  const item = array.get(from);
  if (!item) return;

  const write = () => {
    array.delete(from, 1);
    // Removing `from` shifts every later index left by one.
    array.insert(to > from ? to - 1 : to, [item]);
  };

  if (array.doc) array.doc.transact(write);
  else write();
}
