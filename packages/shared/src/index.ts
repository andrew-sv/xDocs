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

/** An API key as listed. The key itself is returned once, at creation. */
export const apiKeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** First characters of the key, so a row is identifiable without the secret. */
  prefix: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type ApiKeyDTO = z.infer<typeof apiKeySchema>;

/** Creation is the only response that ever contains the key itself. */
export const createdApiKeySchema = apiKeySchema.extend({ key: z.string() });
export type CreatedApiKeyDTO = z.infer<typeof createdApiKeySchema>;

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).default('Untitled'),
  /** When set, the new document becomes a child and copies its visibility. */
  parentId: z.uuid().nullish(),
});

/**
 * A block as the REST API exposes it.
 *
 * Text only, deliberately: the editor's rich text lives in ProseMirror nodes
 * inside the CRDT, and round-tripping that through HTTP would need the TipTap
 * schema on the server. Reading returns the words; writing sets them.
 */
export const contentBlockSchema = z.object({
  id: z.string(),
  type: blockTypeSchema,
  text: z.string(),
});
export type ContentBlockDTO = z.infer<typeof contentBlockSchema>;

export const documentContentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  blocks: z.array(contentBlockSchema),
});
export type DocumentContentDTO = z.infer<typeof documentContentSchema>;

/** Body for writing content: replace everything, or append to it. */
export const writeContentSchema = z.object({
  /** Omitted leaves the title alone; only a replace may set it. */
  title: z.string().trim().max(200).optional(),
  blocks: z.array(z.string()).max(500),
});
export type WriteContentInput = z.infer<typeof writeContentSchema>;

/** Reparenting. null means "make it top level". */
export const moveDocumentSchema = z.object({
  parentId: z.uuid().nullable(),
});

export const updateVisibilitySchema = z.object({
  visibility: visibilitySchema,
});
export type CreateDocumentInput = z.input<typeof createDocumentSchema>;
