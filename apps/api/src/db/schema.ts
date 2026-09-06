import { customType, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Raw Yjs update payload. drizzle has no first-class bytea, so declare it. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const documents = pgTable('documents', {
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
});

export type DocumentRow = typeof documents.$inferSelect;
