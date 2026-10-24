import {
  BLOCKS_KEY,
  TITLE_KEY,
  blockFragmentName,
  createDocumentSchema,
  moveDocumentSchema,
  writeContentSchema,
  updateVisibilitySchema,
  type BlockMeta,
  toTsQuery,
  type DocumentDTO,
  type SearchResultDTO,
  type TrashEntryDTO,
  type WriteBlockInput,
} from '@xdocs/shared';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  admittedRow,
  canAccessDocument,
  subtreeIds,
  visibleDocumentIds,
  visibleTreeSql,
  wouldCreateCycle,
} from '../db/access.js';
import {
  notifyDocumentsChanged,
  readTitle,
  withDirectConnection,
  withDocument,
} from '../collab.js';
import { CODE_BLOCK_NODE, readContent } from '../content.js';
import { linkProblem, parseLinks, writeRuns } from '../markdownLinks.js';
import { getDb } from '../db/index.js';
import { documents } from '../db/schema.js';
import { capture, recordVersion } from '../versions.js';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Which of these documents have at least one child this user can reach? One
 * query, not N.
 *
 * Every id passed in is already reachable by the caller, so a child is
 * reachable exactly when the rule admits the child itself — `admittedRow`,
 * no ancestor walk. Counting any live child instead marked a public document
 * as having children when all of them were private, so a stranger saw an
 * expand arrow that opened onto nothing: proof private documents sat beneath
 * it, the probe the 404-not-403 rule exists to prevent (#82).
 */
async function childBearing(ids: string[], userId: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .selectDistinct({ parentId: documents.parentId })
    .from(documents)
    .where(
      and(admittedRow(userId), isNotNull(documents.parentId), inArray(documents.parentId, ids)),
    );
  return new Set(rows.map((row) => row.parentId!).filter(Boolean));
}

/**
 * Append the given blocks.
 *
 * A paragraph is a single node, so an embedded newline cannot live inside one
 * — each line becomes its own block, which is what typing the same text would
 * have produced. A code block's text may contain newlines, so it stays whole.
 */
function writeBlocks(doc: Y.Doc, inputs: WriteBlockInput[]): void {
  const blocks = doc.getArray<BlockMeta>(BLOCKS_KEY);

  const append = (nodeName: string, text: string) => {
    // The meta type stays "paragraph" for a code block too, exactly as when
    // the editor converts one; readers look at the content instead.
    const meta: BlockMeta = { id: randomUUID(), type: 'paragraph' };
    blocks.push([meta]);
    const element = new Y.XmlElement(nodeName);
    // An empty block must stay empty: inserting a zero-length XmlText would
    // still render, but it also confuses ProseMirror's mapping.
    const node = text.length > 0 ? new Y.XmlText() : null;
    if (node) element.insert(0, [node]);
    const fragment = doc.getXmlFragment(blockFragmentName(meta.id));
    fragment.insert(fragment.length, [element]);
    /*
     * Written only once the node is part of the document. A Yjs text node
     * reports length 0 until then and queues what it is given, so appending
     * run by run before that wrote them all at 0 — in reverse.
     */
    if (node) {
      // A code block is verbatim; a paragraph may carry [label](href) links.
      if (nodeName === CODE_BLOCK_NODE) node.insert(0, text);
      else writeRuns(node, parseLinks(text));
    }
  };

  for (const input of inputs) {
    const { type, text } = typeof input === 'string' ? { type: 'paragraph', text: input } : input;
    if (type === 'code') append(CODE_BLOCK_NODE, text);
    else for (const line of text.split('\n')) append('paragraph', line);
  }
}

/** A row as it comes back from a raw SQL query: snake_case, dates as strings. */
type SearchRow = {
  id: string;
  title: string;
  visibility: 'private' | 'public';
  parent_id: string | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  snippet?: string;
};

function fromSql(row: SearchRow): DocumentColumns {
  return {
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    parentId: row.parent_id,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * The ancestor chain of each id, root first.
 *
 * Search results are the one place a document arrives with no context — the
 * whole point is finding things that are buried — so each hit carries the path
 * it lives under. Every ancestor has a child by definition, hence hasChildren.
 *
 * Walks upward from all matches in one query rather than one per result.
 *
 * The CYCLE clause ends a walk that comes back to a document it has already
 * visited (#64). Moves are serialised so a parent cycle should never form
 * (#55), but this is an UPWARD walk, the one shape that can enter a cycle and
 * never leave — and UNION alone would not stop it, since `depth` makes every
 * row distinct. A downward walk from a root cannot reach a cycle at all.
 */
async function ancestorPaths(ids: string[], userId: string): Promise<Map<string, DocumentDTO[]>> {
  const paths = new Map<string, DocumentDTO[]>();
  if (ids.length === 0) return paths;

  const result = await getDb().execute(sql`
    WITH RECURSIVE up AS (
      SELECT id AS match_id, id, parent_id, title, visibility, created_by, created_at, updated_at, 0 AS depth
        FROM documents
       WHERE id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})
      UNION ALL
      SELECT u.match_id, d.id, d.parent_id, d.title, d.visibility, d.created_by, d.created_at, d.updated_at, u.depth + 1
        FROM documents d
        JOIN up u ON d.id = u.parent_id
    ) CYCLE id SET is_cycle USING visited
    SELECT match_id, id, parent_id, title, visibility, created_by, created_at, updated_at, depth
      FROM up
     WHERE depth > 0 AND NOT is_cycle
     ORDER BY match_id, depth DESC
  `);

  const rows = (result as unknown as { rows?: Array<SearchRow & { match_id: string }> }).rows ?? [];
  for (const row of rows) {
    const path = paths.get(row.match_id) ?? [];
    path.push(toDTO(fromSql(row), userId, true));
    paths.set(row.match_id, path);
  }
  return paths;
}

export const documentsRoute = new Hono<{ Variables: Variables }>()
  /*
   * Any successful change here may change someone's sidebar, so every open app
   * is told to refetch (#22). One middleware rather than a call per route, so
   * a new route cannot forget it; content writes ping too, which only costs a
   * refetch.
   */
  .use('*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.res.ok) notifyDocumentsChanged();
  })
  .get('/', async (c) => {
    const userId = c.get('userId');
    const parent = c.req.query('parent') ?? null;
    /*
     * `flat=1` returns the whole visible tree at once instead of one level.
     *
     * The sidebar walks levels, but a script has no sidebar: finding a document
     * by walking every level is a request per node, and the levels only exist
     * because of how the UI navigates. Callers still get parentId on each row,
     * so the tree is reconstructable.
     */
    const flat = c.req.query('flat') === '1' || c.req.query('flat') === 'true';

    /*
     * When this list was read, so a client can tell which of two lists is
     * newer. Taken before the first query: everything committed by then is in
     * it. Requests do not run in the order they were sent, so under load a
     * list fetched earlier can arrive later, and the order of sending proved
     * no guide (#22). One process, one clock, so these compare.
     */
    c.header('x-list-as-of', String(Date.now()));

    if (flat) {
      // The one caller that wants the whole visible set, so it pays for it.
      const ids = [...(await visibleDocumentIds(userId))];
      if (ids.length === 0) return c.json([]);
      const all = await getDb()
        .select(columns)
        .from(documents)
        .where(and(isNull(documents.deletedAt), inArray(documents.id, ids)))
        .orderBy(desc(documents.updatedAt));
      const parents = await childBearing(
        all.map((row) => row.id),
        userId,
      );
      return c.json(all.map((row) => toDTO(row, userId, parents.has(row.id))));
    }

    /*
     * One level: the parent is checked once, and its rows are filtered by the
     * same rule, rather than computing everything the user can see (#62).
     * Ancestor-gated still — a public child under a private parent is absent,
     * because its parent fails the check. An unreachable parent lists as
     * empty rather than 404, as it always has.
     */
    if (parent && !(UUID.test(parent) && (await canAccessDocument(userId, parent)))) {
      return c.json([]);
    }

    const allowed = await getDb()
      .select(columns)
      .from(documents)
      .where(
        and(
          admittedRow(userId),
          parent ? eq(documents.parentId, parent) : isNull(documents.parentId),
        ),
      )
      .orderBy(desc(documents.updatedAt));

    const withChildren = await childBearing(
      allowed.map((row) => row.id),
      userId,
    );
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

  /*
   * Declared before /:id, like /trash.
   *
   * Full-text over the title and the mirrored `content_text`, restricted to the
   * caller's visible tree by the same recursive rule as everything else — a
   * search that ignored it would be a read hole straight through visibility.
   */
  .get('/search', async (c) => {
    const userId = c.get('userId');
    const raw = (c.req.query('q') ?? '').trim();
    const prefixQuery = toTsQuery(raw);
    // Punctuation-only input has no terms to match; that is an empty result,
    // not a malformed query.
    if (!prefixQuery) return c.json([]);

    const result = await getDb().execute(sql`
      ${visibleTreeSql(userId)},
      /*
       * Two queries OR'd together, because neither alone is right.
       *
       * plainto_tsquery runs the user's words through the SAME lexer that built
       * the index, which matters more than it sounds: Postgres lexes
       * "invoice-2026-draft" as 'invoice', '-2026', 'draft' — with the hyphen
       * read as a minus sign — so a hand-split query for "2026" never matches
       * it. But plainto_tsquery has no prefix matching, so nothing appears
       * until you finish a word.
       *
       * The OR keeps both: exact lexing for punctuated titles, prefix matching
       * for search-as-you-type. Each side ANDs its own terms, so this does not
       * loosen the match to "any word".
       */
      q AS (
        SELECT plainto_tsquery('english', ${raw}) || to_tsquery('english', ${prefixQuery}) AS query
      )
      SELECT d.id, d.title, d.visibility, d.parent_id, d.created_by, d.created_at, d.updated_at,
             ts_headline(
               'english', coalesce(d.content_text, ''), q.query,
               'StartSel="[[", StopSel="]]", MaxWords=26, MinWords=10, ShortWord=2, MaxFragments=1'
             ) AS snippet
        FROM documents d
        JOIN visible v ON v.id = d.id
        CROSS JOIN q
       WHERE d.deleted_at IS NULL
         AND d.search @@ q.query
       -- rank_cd rewards matches close together, so a document arguing about
       -- the phrase beats one that mentions each word in a different block.
       ORDER BY ts_rank_cd(d.search, q.query) DESC, d.updated_at DESC
       LIMIT 30
    `);

    const rows = (result as unknown as { rows?: SearchRow[] }).rows ?? [];
    if (rows.length === 0) return c.json([]);

    const withChildren = await childBearing(
      rows.map((row) => row.id),
      userId,
    );
    const paths = await ancestorPaths(
      rows.map((row) => row.id),
      userId,
    );

    const results: SearchResultDTO[] = rows.map((row) => ({
      document: toDTO(fromSql(row), userId, withChildren.has(row.id)),
      path: paths.get(row.id) ?? [],
      snippet: row.snippet ?? '',
    }));
    return c.json(results);
  })

  /*
   * Declared before /:id — otherwise the param route captures "trash".
   *
   * Lists deletion ROOTS only. Deleting a parent cascades under one shared
   * timestamp, so listing every descendant would show a five-document subtree
   * as five entries you cannot restore independently.
   */
  .get('/trash', async (c) => {
    const userId = c.get('userId');
    const rows = await getDb().execute(sql`
      WITH RECURSIVE roots AS (
        SELECT id, title, deleted_at
          FROM documents d
         WHERE d.deleted_at IS NOT NULL
           AND d.created_by = ${userId}
           AND (
             d.parent_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM documents p
                WHERE p.id = d.parent_id AND p.deleted_at = d.deleted_at
             )
           )
      ),
      descendants AS (
        SELECT r.id AS root_id, d.id
          FROM roots r
          JOIN documents d ON d.parent_id = r.id AND d.deleted_at IS NOT NULL
        UNION ALL
        SELECT x.root_id, d.id
          FROM descendants x
          JOIN documents d ON d.parent_id = x.id AND d.deleted_at IS NOT NULL
      )
      SELECT r.id, r.title, r.deleted_at,
             (SELECT count(*) FROM descendants x WHERE x.root_id = r.id) AS descendant_count
        FROM roots r
       ORDER BY r.deleted_at DESC
    `);
    const list = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    const entries: TrashEntryDTO[] = list.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      deletedAt: new Date(row.deleted_at as string).toISOString(),
      descendantCount: Number(row.descendant_count ?? 0),
    }));
    return c.json(entries);
  })

  /*
   * The only operation in the app that destroys data: the rows AND their
   * ystate, which is every document's entire content. No soft delete behind it.
   */
  .delete('/:id/permanent', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    const [owned] = await getDb()
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(eq(documents.id, id), eq(documents.createdBy, userId), isNotNull(documents.deletedAt)),
      );
    // Only something already in the trash can be destroyed — never a live one.
    if (!owned)
      return c.json({ error: 'Only the owner can permanently delete a trashed document.' }, 403);

    const ids = await subtreeIds(id);
    await getDb().delete(documents).where(inArray(documents.id, ids));
    return c.body(null, 204);
  })

  .get('/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    // 404 not 403: a stranger's document should be indistinguishable from one
    // that does not exist, or ids become probeable.
    if (!(await canAccessDocument(userId, id))) return c.json({ error: 'Not found' }, 404);

    const [row] = await getDb().select(columns).from(documents).where(eq(documents.id, id));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const withChildren = await childBearing([row.id], userId);
    return c.json(toDTO(row, userId, withChildren.has(row.id)));
  })

  /*
   * The document's ancestors, root first; empty at the top level.
   *
   * For opening a document whose place in the tree the client does not know —
   * a restore, an undo, a link. Checking the document alone is enough:
   * visibility is ancestor-gated (see visibleTreeSql), so every ancestor of a
   * reachable document is reachable too, and the path cannot reveal one the
   * caller could not open.
   */
  .get('/:id/path', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    // Checked before SQL: a malformed id would fail the uuid cast as a 500.
    if (!UUID.test(id) || !(await canAccessDocument(userId, id))) {
      return c.json({ error: 'Not found' }, 404);
    }
    const paths = await ancestorPaths([id], userId);
    return c.json(paths.get(id) ?? []);
  })

  /*
   * Reparent a document, or move it to the top level with parentId: null.
   *
   * Owner-only, like delete and visibility: this is structural, not editorial.
   * Anyone who can see a public document may edit its text, but rearranging
   * someone else's tree is a different thing.
   *
   * Note what this deliberately does NOT do: it leaves visibility alone. Moving
   * a public document under a private parent makes it unreachable to others
   * through ancestor gating, which is the honest outcome — silently flipping
   * the document public to "fix" that would leak it.
   */
  /*
   * Read the document's text.
   *
   * Served from the LIVE document through a direct connection, not from the
   * `ystate` column: that column lags by the store debounce, so a read straight
   * after a write would return the previous version.
   */
  .get('/:id/content', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!(await canAccessDocument(userId, id))) return c.json({ error: 'Document not found' }, 404);

    const content = await withDocument(id, (doc) => readContent(id, doc));
    return c.json(content);
  })

  /*
   * Replace the document's blocks, and optionally its title.
   *
   * This is the one place REST touches content, and it does it by joining the
   * document as a participant rather than writing `ystate`. Writing the column
   * directly would be wrong twice over: a connected editor would overwrite it
   * on its next save, and open editors would never see the change at all.
   *
   * Anyone who can reach the document may write to it — the same rule the
   * collaboration socket applies, since that is exactly what this is.
   */
  .put('/:id/content', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = writeContentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    if (!(await canAccessDocument(userId, id))) return c.json({ error: 'Document not found' }, 404);
    // Checked before the document is touched, so a refused link cannot leave
    // it half written.
    const badLink = linkProblem(body.data.blocks);
    if (badLink) return c.json({ error: badLink }, 400);

    const content = await withDirectConnection(id, async (transact) => {
      /*
       * Keep what is about to be thrown away (#49). A replace is the one REST
       * write that destroys wording — and the likeliest caller is a script or
       * an MCP client, not someone watching the screen. The automatic versions
       * alone could be ten minutes stale by now.
       */
      const before = await transact((doc) => capture(doc, readTitle(doc)));
      if (!before.empty) {
        await recordVersion({ documentId: id, capture: before, reason: 'before-replace', userId });
      }
      return transact((doc) => {
        // One transaction, so collaborators see the new version appear at once
        // rather than watching it be rebuilt block by block.
        doc.transact(() => {
          const blocks = doc.getArray<BlockMeta>(BLOCKS_KEY);
          blocks.delete(0, blocks.length);
          // Old fragments are left behind deliberately: Yjs cannot drop a root
          // type, and keeping them is what makes undo able to bring text back.
          writeBlocks(doc, body.data.blocks);
          if (body.data.title !== undefined) {
            const title = doc.getText(TITLE_KEY);
            title.delete(0, title.length);
            title.insert(0, body.data.title);
          }
        });
        return readContent(id, doc);
      });
    });
    return c.json(content);
  })

  /** Append blocks, leaving what is already there alone. */
  .post('/:id/content', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = writeContentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    if (!(await canAccessDocument(userId, id))) return c.json({ error: 'Document not found' }, 404);
    // Checked before the document is touched, so a refused link cannot leave
    // it half written.
    const badLink = linkProblem(body.data.blocks);
    if (badLink) return c.json({ error: badLink }, 400);

    const content = await withDocument(id, (doc) => {
      doc.transact(() => writeBlocks(doc, body.data.blocks));
      return readContent(id, doc);
    });
    return c.json(content);
  })

  .patch('/:id/parent', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = moveDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const parentId = body.data.parentId;

    const [row] = await getDb()
      .select({ createdBy: documents.createdBy })
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
    if (!row) return c.json({ error: 'Document not found' }, 404);
    // 404 for a document you cannot see, 403 for one you can but do not own —
    // the same split the other owner-only routes use.
    if (!(await canAccessDocument(userId, id))) return c.json({ error: 'Document not found' }, 404);
    if (row.createdBy !== userId)
      return c.json({ error: 'Only the owner can move a document' }, 403);

    if (parentId) {
      if (!(await canAccessDocument(userId, parentId))) {
        return c.json({ error: 'Destination not found' }, 404);
      }
    }

    /*
     * A cycle is unreachable through the UI but trivial over the API, and it
     * would be permanent: the visibility walk starts from top-level documents,
     * so a loop and everything under it vanishes for everyone.
     *
     * The check and the write share one transaction behind one lock (#55).
     * Apart, "A under B" and "B under A" sent together each passed a check
     * that ran before the other's write, and both landed. The lock is global
     * rather than per document because the conflicting moves touch different
     * rows; moves are rare enough that serialising all of them costs nothing.
     * Under READ COMMITTED each statement after the lock sees the move that
     * held it before.
     */
    const moved = await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('xdocs:documents.parent_id'))`);
      if (parentId && (await wouldCreateCycle(id, parentId, tx))) return null;
      const [row] = await tx
        .update(documents)
        .set({ parentId, updatedAt: new Date() })
        .where(eq(documents.id, id))
        .returning(columns);
      return row!;
    });
    if (!moved) return c.json({ error: 'A document cannot be moved inside itself' }, 400);

    const withChildren = await childBearing([id], userId);
    return c.json(toDTO(moved, userId, withChildren.has(id)));
  })

  .patch('/:id/visibility', async (c) => {
    const userId = c.get('userId');
    const body = updateVisibilitySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    // Owner only — the where clause IS the authorisation.
    const [row] = await getDb()
      .update(documents)
      .set({ visibility: body.data.visibility })
      .where(
        and(
          eq(documents.id, c.req.param('id')),
          eq(documents.createdBy, userId),
          isNull(documents.deletedAt),
        ),
      )
      .returning(columns);
    if (!row) return c.json({ error: 'Only the owner can change visibility.' }, 403);
    const withChildren = await childBearing([row.id], userId);
    return c.json(toDTO(row, userId, withChildren.has(row.id)));
  })

  .delete('/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    const [owned] = await getDb()
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(eq(documents.id, id), eq(documents.createdBy, userId), isNull(documents.deletedAt)),
      );
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
    if (!target?.deletedAt)
      return c.json({ error: 'Only the owner can restore this document.' }, 403);

    // Everything that went with it: same subtree, same deletion timestamp.
    const ids = await subtreeIds(id);
    await getDb()
      .update(documents)
      .set({ deletedAt: null })
      .where(and(inArray(documents.id, ids), eq(documents.deletedAt, target.deletedAt)));

    /*
     * If its parent is still deleted, the document would come back somewhere
     * unreachable: access needs the whole ancestor chain visible, so it would
     * be restored and still invisible. Lift it to the top level instead.
     */
    const [restored] = await getDb()
      .select({ parentId: documents.parentId })
      .from(documents)
      .where(eq(documents.id, id));
    if (restored?.parentId) {
      const [parent] = await getDb()
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, restored.parentId));
      if (!parent || parent.deletedAt !== null) {
        await getDb().update(documents).set({ parentId: null }).where(eq(documents.id, id));
      }
    }

    const [row] = await getDb().select(columns).from(documents).where(eq(documents.id, id));
    const withChildren = await childBearing([id], userId);
    return c.json(toDTO(row!, userId, withChildren.has(id)));
  });
