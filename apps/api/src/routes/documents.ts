import {
  BLOCKS_KEY,
  createDocumentSchema,
  updateDocumentSchema,
  type BlockMeta,
  type DocumentDTO,
} from '@xdocs/shared';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { getDb } from '../db/index.js';
import { documents } from '../db/schema.js';

/**
 * Seed the CRDT with one empty block at creation time.
 *
 * Doing this on the client instead would race: two people opening a brand-new
 * document at once would each see an empty block list and each seed one. The
 * server writes it exactly once, so every document starts with exactly one
 * block and clients never need to bootstrap.
 */
function initialYState(): Buffer {
  const doc = new Y.Doc();
  const block: BlockMeta = { id: randomUUID(), type: 'paragraph' };
  doc.getArray<BlockMeta>(BLOCKS_KEY).push([block]);
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
      .orderBy(desc(documents.updatedAt));
    return c.json(rows.map(toDTO));
  })

  .post('/', async (c) => {
    const body = createDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    const [row] = await getDb()
      .insert(documents)
      .values({ title: body.data.title, ystate: initialYState() })
      .returning(columns);
    return c.json(toDTO(row!), 201);
  })

  .get('/:id', async (c) => {
    const [row] = await getDb()
      .select(columns)
      .from(documents)
      .where(eq(documents.id, c.req.param('id')));
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(toDTO(row));
  })

  .patch('/:id', async (c) => {
    const body = updateDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    const [row] = await getDb()
      .update(documents)
      .set({ title: body.data.title, updatedAt: new Date() })
      .where(eq(documents.id, c.req.param('id')))
      .returning(columns);
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(toDTO(row));
  })

  .delete('/:id', async (c) => {
    const [row] = await getDb()
      .delete(documents)
      .where(eq(documents.id, c.req.param('id')))
      .returning({ id: documents.id });
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });
