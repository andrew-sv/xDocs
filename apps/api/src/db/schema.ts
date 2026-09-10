import { customType, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

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
  /*
   * Who created it. Recorded for provenance only — access is NOT scoped by it,
   * because every signed-in user shares one workspace. Nullable so the rows
   * that predate authentication stay valid.
   */
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
});

export type DocumentRow = typeof documents.$inferSelect;
