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
});

export type DocumentRow = typeof documents.$inferSelect;
