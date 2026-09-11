import { z } from 'zod';

/**
 * Yjs top-level key holding the ordered block list for a document.
 * Each entry's rich text lives in its own fragment, see `blockFragmentName`.
 */
export const BLOCKS_KEY = 'blocks';

/**
 * Yjs top-level Y.Text holding the document title.
 *
 * The title lives in the CRDT rather than in a REST field so that editing it is
 * collaborative like everything else, and so nothing can overwrite it out of
 * band. The `documents.title` column is a denormalised copy for the sidebar.
 */
export const TITLE_KEY = 'title';

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

export const visibilitySchema = z.enum(['private', 'public']);
export type Visibility = z.infer<typeof visibilitySchema>;

export const documentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  visibility: visibilitySchema,
  /** Parent document; null means top level. */
  parentId: z.uuid().nullable(),
  /** Lets the sidebar mark rows that lead somewhere, without a second request. */
  hasChildren: z.boolean(),
  /** Derived per request from the caller's session — never stored. */
  isOwner: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocumentDTO = z.infer<typeof documentSchema>;

/** A deleted document as shown in Trash: one entry per delete operation. */
export const trashEntrySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  deletedAt: z.iso.datetime(),
  /** Sub-documents that were deleted with it and come back on restore. */
  descendantCount: z.number().int().nonnegative(),
});
export type TrashEntryDTO = z.infer<typeof trashEntrySchema>;

/**
 * One search hit.
 *
 * `snippet` marks matched terms with [[ ]] rather than HTML — the client turns
 * them into <mark> as text nodes, so a document whose content happens to look
 * like markup cannot inject anything.
 */
export const searchResultSchema = z.object({
  document: documentSchema,
  /** Ancestors, root first, so a buried result can say where it lives. */
  path: z.array(documentSchema),
  snippet: z.string(),
});
export type SearchResultDTO = z.infer<typeof searchResultSchema>;

/** Wraps [[matched]] runs so the client can highlight without parsing HTML. */
export const SNIPPET_OPEN = '[[';
export const SNIPPET_CLOSE = ']]';

/**
 * Turn a raw query into a Postgres tsquery.
 *
 * This is the PREFIX half of the search query; the route ORs it with
 * plainto_tsquery over the raw input, which handles punctuation the same way
 * the index does. Words here are reduced to letters and digits — punctuation
 * would be a syntax error in to_tsquery — and the final word gets a prefix
 * match so results narrow as you type.
 *
 * Shared so the client can tell "no usable terms" from "no results" without a
 * round trip.
 */
export function toTsQuery(raw: string): string | null {
  const words = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length === 0) return null;
  return words.map((word, i) => (i === words.length - 1 ? `${word}:*` : word)).join(' & ');
}

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).default('Untitled'),
  /** When set, the new document becomes a child and copies its visibility. */
  parentId: z.uuid().nullish(),
});

export const updateVisibilitySchema = z.object({
  visibility: visibilitySchema,
});
export type CreateDocumentInput = z.input<typeof createDocumentSchema>;
