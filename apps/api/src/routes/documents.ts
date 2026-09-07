import {
  BLOCKS_KEY,
  TITLE_KEY,
  createDocumentSchema,
  type BlockMeta,
  type DocumentDTO,
} from '@xdocs/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { getDb } from '../db/index.js';
import { documents } from '../db/schema.js';

/**
 * Seed the CRDT with the title and one empty block at creation time.
 *
 * Doing this on the client instead would race: two people opening a brand-new
 * document at once would each see an empty block list and each seed one. The
 * server writes it exactly once, so every document starts with exactly one
 * block and clients never need to bootstrap.
 *
 * The title has to be seeded here too. It is CRDT-owned, so an empty Y.Text
 * would win over whatever this endpoint was asked for the moment the document
 * is opened — silently renaming it to 'Untitled' and making the `title`
 * argument meaningless.
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
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
} as const;

type DocumentColumns = {
  [K in keyof typeof columns]: (typeof columns)[K]['_']['data'];
};

function toDTO(row: DocumentColumns): DocumentDTO {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const documentsRoute = new Hono()
  .get('/', async (c) => {
    const rows = await getDb()
      .select(columns)
      .from(documents)
      .where(isNull(documents.deletedAt))
      .orderBy(desc(documents.updatedAt));
    return c.json(rows.map(toDTO));
  })

  .post('/', async (c) => {
    const body = createDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    const [row] = await getDb()
      .insert(documents)
      .values({ title: body.data.title, ystate: initialYState(body.data.title) })
      .returning(columns);
    return c.json(toDTO(row!), 201);
  })

  .get('/:id', async (c) => {
    const [row] = await getDb()
      .select(columns)
      .from(documents)
      .where(and(eq(documents.id, c.req.param('id')), isNull(documents.deletedAt)));
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(toDTO(row));
  })


  // Soft delete: the row and its Yjs state survive so /restore can bring the
  // document back under the same id, with its content intact.
  .delete('/:id', async (c) => {
    const [row] = await getDb()
      .update(documents)
      .set({ deletedAt: new Date() })
      .where(and(eq(documents.id, c.req.param('id')), isNull(documents.deletedAt)))
      .returning({ id: documents.id });
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  })

  .post('/:id/restore', async (c) => {
    // updatedAt is deliberately untouched, so a restored document returns to
    // its original place in the list rather than jumping to the top.
    const [row] = await getDb()
      .update(documents)
      .set({ deletedAt: null })
      .where(eq(documents.id, c.req.param('id')))
      .returning(columns);
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(toDTO(row));
  });
