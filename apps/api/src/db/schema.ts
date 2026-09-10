import { customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

/** Raw Yjs update payload. drizzle has no first-class bytea, so declare it. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
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
  },
  // Every sidebar query filters on this.
  (table) => [index('documents_parent_idx').on(table.parentId)],
);

export type DocumentRow = typeof documents.$inferSelect;
