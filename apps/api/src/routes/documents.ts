import {
  BLOCKS_KEY,
  TITLE_KEY,
  createDocumentSchema,
  updateVisibilitySchema,
  type BlockMeta,
  type DocumentDTO,
} from '@xdocs/shared';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { getDb } from '../db/index.js';
import { documents } from '../db/schema.js';

type Variables = { userId: string; email: string };

/**
 * Seed the CRDT with the title and one empty block at creation time.
 *
 * Doing this on the client instead would race: two people opening a brand-new
 * document at once would each see an empty block list and each seed one.
 *
 * The title is seeded here too. It is CRDT-owned, so an empty Y.Text would win
 * over whatever this endpoint was asked for the moment the document is opened.
 */
function initialYState(title: string): Buffer {
  const doc = new Y.Doc();
  const block: BlockMeta = { id: randomUUID(), type: 'paragraph' };
  doc.getArray<BlockMeta>(BLOCKS_KEY).push([block]);
  doc.getText(TITLE_KEY).insert(0, title);
  const update = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return update;
}

/**
 * Explicit projection: never leak the Yjs binary over REST. It can be megabytes
 * and the client gets that content over the collab socket instead.
 */
const columns = {
  id: documents.id,
  title: documents.title,
  visibility: documents.visibility,
  createdBy: documents.createdBy,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
} as const;

// Derived from the table rather than mapped over `columns`: a mapped type over
// column definitions loses nullability, so createdBy came out as string.
type DocumentColumns = Pick<
  typeof documents.$inferSelect,
  'id' | 'title' | 'visibility' | 'createdBy' | 'createdAt' | 'updatedAt'
>;

function toDTO(row: DocumentColumns, userId: string): DocumentDTO {
  return {
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    isOwner: row.createdBy === userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Visible means public, or mine. Used for listing and for opening by id. */
const visibleTo = (userId: string) =>
  or(eq(documents.visibility, 'public'), eq(documents.createdBy, userId));

export const documentsRoute = new Hono<{ Variables: Variables }>()
  .get('/', async (c) => {
    const userId = c.get('userId');
    const rows = await getDb()
      .select(columns)
      .from(documents)
      .where(and(isNull(documents.deletedAt), visibleTo(userId)))
      .orderBy(desc(documents.updatedAt));
    return c.json(rows.map((row) => toDTO(row, userId)));
  })

  .post('/', async (c) => {
    const userId = c.get('userId');
    const body = createDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    const [row] = await getDb()
      .insert(documents)
      // visibility falls to the schema default: private.
      .values({ title: body.data.title, ystate: initialYState(body.data.title), createdBy: userId })
      .returning(columns);
    return c.json(toDTO(row!, userId), 201);
  })

  .get('/:id', async (c) => {
    const userId = c.get('userId');
    const [row] = await getDb()
      .select(columns)
      .from(documents)
      .where(and(eq(documents.id, c.req.param('id')), isNull(documents.deletedAt), visibleTo(userId)));
    // 404 rather than 403: a stranger's document should not be distinguishable
    // from one that does not exist, or ids become probeable.
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(toDTO(row, userId));
  })

  .patch('/:id/visibility', async (c) => {
    const userId = c.get('userId');
    const body = updateVisibilitySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    const [row] = await getDb()
      .update(documents)
      .set({ visibility: body.data.visibility })
      // Owner only — the where clause IS the authorisation.
      .where(and(eq(documents.id, c.req.param('id')), eq(documents.createdBy, userId), isNull(documents.deletedAt)))
      .returning(columns);
    if (!row) return c.json({ error: 'Only the owner can change visibility.' }, 403);
    return c.json(toDTO(row, userId));
  })

  // Soft delete: the row and its Yjs state survive so /restore can bring the
  // document back under the same id, with its content intact.
  .delete('/:id', async (c) => {
    const userId = c.get('userId');
    const [row] = await getDb()
      .update(documents)
      .set({ deletedAt: new Date() })
      .where(and(eq(documents.id, c.req.param('id')), eq(documents.createdBy, userId), isNull(documents.deletedAt)))
      .returning({ id: documents.id });
    if (!row) return c.json({ error: 'Only the owner can delete this document.' }, 403);
    return c.body(null, 204);
  })

  .post('/:id/restore', async (c) => {
    const userId = c.get('userId');
    // updatedAt is deliberately untouched, so a restored document returns to
    // its original place in the list rather than jumping to the top.
    const [row] = await getDb()
      .update(documents)
      .set({ deletedAt: null })
      .where(and(eq(documents.id, c.req.param('id')), eq(documents.createdBy, userId)))
      .returning(columns);
    if (!row) return c.json({ error: 'Only the owner can restore this document.' }, 403);
    return c.json(toDTO(row, userId));
  });
