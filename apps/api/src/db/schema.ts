import { sql } from 'drizzle-orm';
import { customType, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

/** Raw Yjs update payload. drizzle has no first-class bytea, so declare it. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** Postgres full-text vector. Generated, so it is never written directly. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

export const documents = pgTable(
  'documents',
  {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull().default('Untitled'),
  // Authoritative content: the encoded Yjs state written by Hocuspocus.
  ystate: bytea('ystate'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /*
   * Soft delete, so deletion is undoable. A hard DELETE would drop the Yjs
   * state with the row and the document could not come back — not under the
   * same id, which is what any open link or restore would need.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /*
   * The owner. Only the owner may change visibility, delete or restore.
   *
   * Nullable because rows predating authentication have none; combined with the
   * private default that makes them unreachable, which is correct — they are
   * soft-deleted test artefacts.
   */
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  /*
   * private: owner only. public: any signed-in user, with full edit rights, so
   * live collaboration keeps working. Private by default — a new document is
   * yours until you deliberately share it.
   */
  visibility: text('visibility', { enum: ['private', 'public'] })
    .notNull()
    .default('private'),
    /*
     * Parent document; null means top level.
     *
     * Deliberately NOT onDelete: 'cascade'. Deletion here is a soft delete, and
     * a real FK cascade would hard-delete rows and destroy the Yjs state that
     * the soft delete exists to preserve.
     */
    parentId: uuid('parent_id'),
    /*
     * Plain text of every block, mirrored out of the CRDT by the collab store
     * hook — the same denormalisation as `title`, for the same reason.
     *
     * Search cannot read the real content: it lives in `ystate` as an opaque
     * Yjs update, so Postgres cannot index it and answering a query would mean
     * decoding every document. This column is derived, never authoritative;
     * the next store overwrites it.
     */
    contentText: text('content_text'),
    /*
     * The search index itself, generated so it can never drift from the two
     * columns it summarises. Title is weighted above body text, so a document
     * called "Invoices" outranks one that merely mentions invoices.
     */
    search: tsvector('search').generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`setweight(to_tsvector('english', coalesce(${documents.title}, '')), 'A') || setweight(to_tsvector('english', coalesce(${documents.contentText}, '')), 'B')`,
    ),
  },
  (table) => [
    // Every sidebar query filters on this.
    index('documents_parent_idx').on(table.parentId),
    index('documents_search_idx').using('gin', table.search),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;

/**
 * Credentials for scripts and other machines.
 *
 * Session tokens are wrong for automation — they expire, they belong to one
 * browser, and revoking one logs a person out. A key is owned by a user and
 * acts entirely as them: same allowlist, same visibility rules, same ownership
 * checks. It is deliberately NOT a separate principal with its own grants.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /*
     * SHA-256 of the key. The key itself is shown once at creation and never
     * stored, so a database leak yields nothing usable — and "show me the key
     * again" is impossible by construction rather than by policy.
     */
    hash: text('hash').notNull().unique(),
    /** First few characters, so a key is still identifiable in a list. */
    prefix: text('prefix').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Rough: written on use, so "is this key still in use" is answerable. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Revocation is a soft delete, so a revoked key's history survives it. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('api_keys_user_idx').on(table.userId)],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/**
 * Files attached to a document, stored in Postgres itself.
 *
 * Kept in the database rather than an object store so there is no second
 * system, credential or access model: a file is reachable exactly when its
 * document is. The size cap (MAX_ATTACHMENT_BYTES) is what keeps that sane.
 *
 * The document holds only a link to `/api/attachments/<id>`; the bytes never
 * enter the CRDT.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /*
     * ON DELETE CASCADE, unlike documents.parent_id: a document row is only
     * ever hard-deleted by the permanent-delete route, and its files should go
     * with it. A soft delete leaves them in place, so a restore brings them
     * back along with the links to them.
     */
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    data: bytea('data').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('attachments_document_idx').on(table.documentId)],
);
