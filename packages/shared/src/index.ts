import { z } from 'zod';

/**
 * Yjs top-level key holding the ordered block list for a document.
 * Each entry's rich text lives in its own fragment, see `blockFragmentName`.
 */
export const BLOCKS_KEY = 'blocks';

/** Y.XmlFragment key bound to a single block's TipTap editor. */
export function blockFragmentName(blockId: string): string {
  return `block-${blockId}`;
}

/** Hocuspocus document name for a given xDocs document. */
export function collabDocName(documentId: string): string {
  return `doc:${documentId}`;
}

export const blockTypeSchema = z.enum(['paragraph']);
export type BlockType = z.infer<typeof blockTypeSchema>;

/**
 * Block *metadata* only. The text itself is never serialised here — it lives
 * in the CRDT fragment, so this stays tiny and conflict-free to reorder.
 */
export const blockMetaSchema = z.object({
  id: z.string().min(1),
  type: blockTypeSchema,
});
export type BlockMeta = z.infer<typeof blockMetaSchema>;

export const documentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocumentDTO = z.infer<typeof documentSchema>;

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).default('Untitled'),
});
export type CreateDocumentInput = z.input<typeof createDocumentSchema>;

export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
