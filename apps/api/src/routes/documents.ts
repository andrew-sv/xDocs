import {
  BLOCKS_KEY,
  TITLE_KEY,
  createDocumentSchema,
  updateVisibilitySchema,
  type BlockMeta,
  type DocumentDTO,
} from '@xdocs/shared';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { canAccessDocument, subtreeIds, visibleDocumentIds } from '../db/access.js';
import { getDb } from '../db/index.js';
import { documents } from '../db/schema.js';

type Variables = { userId: string; email: string };

/**
 * Seed the CRDT with the title and one empty block at creation time.
 *
 * Doing this on the client instead would race: two people opening a brand-new
 * document at once would each see an empty block list and each seed one.
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

/** Never leak the Yjs binary over REST — the client gets content over the socket. */
const columns = {
  id: documents.id,
  title: documents.title,
  visibility: documents.visibility,
  parentId: documents.parentId,
  createdBy: documents.createdBy,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
} as const;

type DocumentColumns = Pick<
  typeof documents.$inferSelect,
  'id' | 'title' | 'visibility' | 'parentId' | 'createdBy' | 'createdAt' | 'updatedAt'
>;

function toDTO(row: DocumentColumns, userId: string, hasChildren: boolean): DocumentDTO {
  return {
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    parentId: row.parentId,
    hasChildren,
    isOwner: row.createdBy === userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Which of these documents have at least one live child? One query, not N. */
async function childBearing(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .selectDistinct({ parentId: documents.parentId })
    .from(documents)
    .where(and(isNull(documents.deletedAt), isNotNull(documents.parentId), inArray(documents.parentId, ids)));
  return new Set(rows.map((row) => row.parentId!).filter(Boolean));
}

export const documentsRoute = new Hono<{ Variables: Variables }>()
  .get('/', async (c) => {
    const userId = c.get('userId');
    const parent = c.req.query('parent') ?? null;

    // The visible set is ancestor-gated, so a child under a private parent is
    // absent even when the child itself is public.
    const visible = await visibleDocumentIds(userId);
    if (parent && !visible.has(parent)) return c.json([]);

    const rows = await getDb()
      .select(columns)
      .from(documents)
      .where(
        and(
          isNull(documents.deletedAt),
          parent ? eq(documents.parentId, parent) : isNull(documents.parentId),
        ),
      )
      .orderBy(desc(documents.updatedAt));

    const allowed = rows.filter((row) => visible.has(row.id));
    const withChildren = await childBearing(allowed.map((row) => row.id));
    return c.json(allowed.map((row) => toDTO(row, userId, withChildren.has(row.id))));
  })

  .post('/', async (c) => {
    const userId = c.get('userId');
    const body = createDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    const parentId = body.data.parentId ?? null;
    let visibility: 'private' | 'public' = 'private';

    if (parentId) {
      // Must be able to see the parent, or anyone could graft a child onto
      // someone else's document and read it through the tree.
      if (!(await canAccessDocument(userId, parentId))) {
        return c.json({ error: 'Parent document not found' }, 404);
      }
      const [parent] = await getDb()
        .select({ visibility: documents.visibility })
        .from(documents)
        .where(eq(documents.id, parentId));
      // Copied once, then independent: changing the parent later leaves
      // existing children alone.
      visibility = parent?.visibility ?? 'private';
    }

    const [row] = await getDb()
      .insert(documents)
      .values({
        title: body.data.title,
        ystate: initialYState(body.data.title),
        createdBy: userId,
        parentId,
        visibility,
      })
      .returning(columns);
    return c.json(toDTO(row!, userId, false), 201);
  })

  .get('/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    // 404 not 403: a stranger's document should be indistinguishable from one
    // that does not exist, or ids become probeable.
    if (!(await canAccessDocument(userId, id))) return c.json({ error: 'Not found' }, 404);

    const [row] = await getDb().select(columns).from(documents).where(eq(documents.id, id));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const withChildren = await childBearing([row.id]);
    return c.json(toDTO(row, userId, withChildren.has(row.id)));
  })

  .patch('/:id/visibility', async (c) => {
    const userId = c.get('userId');
    const body = updateVisibilitySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    // Owner only — the where clause IS the authorisation.
    const [row] = await getDb()
      .update(documents)
      .set({ visibility: body.data.visibility })
      .where(and(eq(documents.id, c.req.param('id')), eq(documents.createdBy, userId), isNull(documents.deletedAt)))
      .returning(columns);
    if (!row) return c.json({ error: 'Only the owner can change visibility.' }, 403);
    const withChildren = await childBearing([row.id]);
    return c.json(toDTO(row, userId, withChildren.has(row.id)));
  })

  .delete('/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    const [owned] = await getDb()
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.createdBy, userId), isNull(documents.deletedAt)));
    if (!owned) return c.json({ error: 'Only the owner can delete this document.' }, 403);

    /*
     * Cascade to the whole subtree, stamping ONE timestamp across it. Restore
     * uses that exact value to find precisely the documents this delete took,
     * without disturbing anything deleted earlier.
     */
    const ids = await subtreeIds(id);
    const deletedAt = new Date();
    await getDb()
      .update(documents)
      .set({ deletedAt })
      .where(and(inArray(documents.id, ids), isNull(documents.deletedAt)));
    return c.body(null, 204);
  })

  .post('/:id/restore', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    const [target] = await getDb()
      .select({ id: documents.id, deletedAt: documents.deletedAt })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.createdBy, userId)));
    if (!target?.deletedAt) return c.json({ error: 'Only the owner can restore this document.' }, 403);

    // Everything that went with it: same subtree, same deletion timestamp.
    const ids = await subtreeIds(id);
    await getDb()
      .update(documents)
      .set({ deletedAt: null })
      .where(and(inArray(documents.id, ids), eq(documents.deletedAt, target.deletedAt)));

    const [row] = await getDb().select(columns).from(documents).where(eq(documents.id, id));
    const withChildren = await childBearing([id]);
    return c.json(toDTO(row!, userId, withChildren.has(id)));
  });
