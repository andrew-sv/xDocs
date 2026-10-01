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

/**
 * The one 403 that means "this account may not use xDocs at all".
 *
 * Shared because both sides have to agree on it exactly: the client signs out
 * on this code and on nothing else. Every other 403 is an ordinary refusal of
 * one action — "only the owner can delete this" — and must leave the session
 * alone. Treating all of them alike is what made 403 unusable for anything but
 * the allowlist, and forced other routes to answer 404 instead (#31).
 */
export const ACCOUNT_NOT_ALLOWED = 'account_not_allowed';

/**
 * Yjs top-level Y.Map of comment threads, keyed by thread id.
 *
 * On the document rather than in Postgres for the same reason the text is: a
 * comment written while someone else is typing has to merge, not overwrite,
 * and a thread anchored to a range that is being edited only stays anchored if
 * it travels with the CRDT. It also means no REST route reads or writes
 * document content, which is the rule the content bridge exists to keep.
 *
 * Each thread is a Y.Map, and its `comments` field is a Y.Map keyed by comment
 * id rather than an array: editing is then a field write on one entry, where an
 * array would need delete-plus-insert and could duplicate or lose a comment
 * exactly as reordering blocks can.
 */
export const COMMENTS_KEY = 'comments';

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
 * What a block holds, as the REST API sees it.
 *
 * Not `BlockMeta.type`: that is always "paragraph", including for a block the
 * editor has since turned into a code block. This is read from the block's
 * content instead — "code" when its only node is a code block, "paragraph" for
 * everything else.
 */
export const contentBlockTypeSchema = z.enum(['paragraph', 'code']);
export type ContentBlockType = z.infer<typeof contentBlockTypeSchema>;

/**
 * A block as the REST API exposes it.
 *
 * Text only, deliberately: the editor's rich text lives in ProseMirror nodes
 * inside the CRDT, and round-tripping that through HTTP would need the TipTap
 * schema on the server. Reading returns the words; writing sets them.
 *
 * Two exceptions, both because the plain words would be wrong without them: a
 * code block, whose text is only readable verbatim, and links, which are
 * written the Markdown way as `[label](href)` in both directions (a backslash
 * escapes a literal bracket). Code block text is never link notation.
 */
export const contentBlockSchema = z.object({
  id: z.string(),
  type: contentBlockTypeSchema,
  text: z.string(),
});
export type ContentBlockDTO = z.infer<typeof contentBlockSchema>;

export const documentContentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  blocks: z.array(contentBlockSchema),
});
export type DocumentContentDTO = z.infer<typeof documentContentSchema>;

/**
 * Why a version exists; see `document_versions.reason`. `auto` versions are
 * archived by the collab store as editing goes on, the rest are taken on
 * request or just before something rewrites the whole document.
 */
export const versionReasonSchema = z.enum(['auto', 'manual', 'before-restore', 'before-replace']);
export type VersionReason = z.infer<typeof versionReasonSchema>;

/** One entry in a document's history. Never carries the content itself. */
export const documentVersionSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  title: z.string(),
  reason: versionReasonSchema,
  /** Whoever asked for it; null for automatic versions and deleted accounts. */
  author: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** When the document was in this state. */
  savedAt: z.iso.datetime(),
});
export type DocumentVersionDTO = z.infer<typeof documentVersionSchema>;

/** A version with its content, in the same shape as a content read. */
export const documentVersionContentSchema = z.object({
  version: documentVersionSchema,
  content: documentContentSchema,
});
export type DocumentVersionContentDTO = z.infer<typeof documentVersionContentSchema>;

/**
 * One block to write.
 *
 * A bare string is a paragraph, and a newline in it starts another paragraph
 * block. `{type: 'code'}` is ONE code block that keeps its newlines and
 * indentation. The object form accepts what a read returns, so a document can
 * be read, edited and written back without reshaping it.
 */
export const writeBlockSchema = z.union([
  z.string(),
  z.object({ type: contentBlockTypeSchema, text: z.string() }),
]);
export type WriteBlockInput = z.infer<typeof writeBlockSchema>;

/** Body for writing content: replace everything, or append to it. */
export const writeContentSchema = z.object({
  /** Omitted leaves the title alone; only a replace may set it. */
  title: z.string().trim().max(200).optional(),
  blocks: z.array(writeBlockSchema).max(500),
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

/**
 * Upload cap for attachments. Files are stored in Postgres (see the
 * `attachments` table), which is only reasonable while they stay small.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * How much attachment storage one user may hold in total.
 *
 * The per-file cap alone bounds nothing: files live in the same Postgres
 * database as every document's Yjs state, so one person uploading steadily
 * would grow the backups and the bill without limit. The server can override
 * this with ATTACHMENT_QUOTA_BYTES.
 */
export const DEFAULT_ATTACHMENT_QUOTA_BYTES = 200 * 1024 * 1024;

export const attachmentUsageSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
});
export type AttachmentUsageDTO = z.infer<typeof attachmentUsageSchema>;

/** Rounded: the exact byte count of a file store tells nobody anything. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Why this upload cannot be accepted, or null if it fits.
 *
 * Says what is used and what the limit is, because "quota exceeded" leaves
 * someone with no idea how much to delete.
 */
export function quotaRefusal(
  usedBytes: number,
  incomingBytes: number,
  quotaBytes: number,
): string | null {
  if (usedBytes + incomingBytes <= quotaBytes) return null;
  return (
    `That file would take you past your ${formatBytes(quotaBytes)} of file storage ` +
    `(${formatBytes(usedBytes)} used). Delete some files and try again.`
  );
}

/**
 * Where a document links to one of its attachments.
 *
 * Origin-relative on purpose: the SPA and the API sit on different hosts, and
 * which ones differs per environment, so an absolute URL written into a
 * document would break on the next move. The editor intercepts clicks on these
 * and downloads through the API with the caller's token — a bearer credential
 * cannot ride along on a plain link.
 */
export function attachmentHref(id: string): string {
  return `/api/attachments/${id}`;
}

/** Matches an `attachmentHref`, capturing the id. */
export const ATTACHMENT_HREF = /^\/api\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const attachmentSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  /** What to link to from the document; see `attachmentHref`. */
  href: z.string(),
});
export type AttachmentDTO = z.infer<typeof attachmentSchema>;

/**
 * An attachment as the document's file list shows it.
 *
 * `linked` is whether the document still refers to it. Deleting the link to a
 * file does not delete the file — it cannot, since the deletion is undoable —
 * so unused files accumulate invisibly. The list makes them visible, and
 * deletable, without guessing on anyone's behalf.
 */
export const documentAttachmentSchema = attachmentSchema.extend({ linked: z.boolean() });
export type DocumentAttachmentDTO = z.infer<typeof documentAttachmentSchema>;

/**
 * A collab channel that carries no content, only a signal.
 *
 * The server sends DOCUMENTS_CHANGED on it whenever the document list may have
 * changed — a document created, moved, renamed, deleted or restored, by anyone
 * or anything — and open apps refetch their sidebar over REST. The ping holds
 * no data, so REST's access rules still decide what each person gets to see.
 */
export const WORKSPACE_DOC_NAME = 'workspace';
export const DOCUMENTS_CHANGED = 'documents-changed';
