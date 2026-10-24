import { sql } from 'drizzle-orm';
import { getDb, rowsOf } from './index.js';

/**
 * The visibility rule for a document tree.
 *
 * A document is reachable only if EVERY node from the root down to it is
 * live and public or owned by the caller. Checking the document alone is not
 * enough: that would let a public child of a private parent be read by anyone
 * holding its id, quietly leaking a private subtree one document at a time.
 *
 * This is the whole access boundary — REST listing, per-document routes and the
 * collaboration handshake all go through here, so there is one rule rather
 * than three that can drift apart. `admits` is the per-node half of it; the
 * queries below differ only in which direction they walk the tree.
 */
const admits = (alias: string, userId: string) => sql`(
  ${sql.raw(alias)}.deleted_at IS NULL
  AND (${sql.raw(alias)}.visibility = 'public' OR ${sql.raw(alias)}.created_by = ${userId})
)`;

/**
 * Downward from every root: the whole visible set, for callers that need all
 * of it (search, `?flat=1`).
 *
 * The recursive term only admits a row whose parent is already in the set, so
 * an unreachable ancestor prunes everything beneath it.
 */
export const visibleTreeSql = (userId: string) => sql`
  WITH RECURSIVE visible AS (
    SELECT id, parent_id
      FROM documents
     WHERE parent_id IS NULL
       AND ${admits('documents', userId)}
    UNION ALL
    SELECT d.id, d.parent_id
      FROM documents d
      JOIN visible v ON d.parent_id = v.id
     WHERE ${admits('d', userId)}
  )
`;

/** Every document id this user may reach. Costs the size of the workspace. */
export async function visibleDocumentIds(userId: string): Promise<Set<string>> {
  const result = await getDb().execute(sql`${visibleTreeSql(userId)} SELECT id FROM visible`);
  const rows = rowsOf<{ id: string }>(result);
  return new Set(rows.map((row) => row.id));
}

/**
 * Is this one document reachable? Used by the per-document routes and collab,
 * so it runs on nearly every request and every websocket handshake (#62).
 *
 * Walks UP from the document instead of down from every root: each step is a
 * primary-key lookup, so the cost is the document's depth, not the size of
 * the workspace. The walk stops at the first node the rule refuses, and the
 * document is reachable only if it got as far as a root — the same answer
 * the downward walk gives, since that one admits a node exactly when the
 * rule admits it and every node above it.
 *
 * UNION, not UNION ALL, so a parent cycle ends the walk (#55). A cycle has no
 * root, so it is refused, as the downward walk would never reach it. So is a
 * document whose parent row does not exist.
 */
export async function canAccessDocument(userId: string, documentId: string): Promise<boolean> {
  const result = await getDb().execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id
        FROM documents
       WHERE id = ${documentId}
         AND ${admits('documents', userId)}
      UNION
      SELECT d.id, d.parent_id
        FROM documents d
        JOIN chain c ON d.id = c.parent_id
       WHERE ${admits('d', userId)}
    )
    SELECT 1 AS ok FROM chain WHERE parent_id IS NULL LIMIT 1
  `);
  const rows = rowsOf<unknown>(result);
  return rows.length > 0;
}

/**
 * The per-row half of the rule, for listing one level of the tree.
 *
 * A child is reachable exactly when its parent is and the rule admits the
 * child, so a level is "check the parent once, then filter its rows by this"
 * — no need to compute everything else the user can see. For a query over
 * the `documents` table itself.
 */
export const admittedRow = (userId: string) => admits('documents', userId);

/** The pool, or a transaction on it — anything that can run a statement. */
type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

/**
 * The document plus all of its descendants, for cascading a delete.
 * Walks downward regardless of visibility — the caller has already proven
 * ownership of the root.
 *
 * UNION, not UNION ALL: it drops rows already seen, so the walk ends even on
 * a parent cycle (#55). UNION ALL would spin forever on one, holding a pooled
 * connection while Postgres burns CPU.
 */
export async function subtreeIds(documentId: string, db: Executor = getDb()): Promise<string[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM documents WHERE id = ${documentId}
      UNION
      SELECT d.id FROM documents d JOIN subtree s ON d.parent_id = s.id
    )
    SELECT id FROM subtree
  `);
  const rows = rowsOf<{ id: string }>(result);
  return rows.map((row) => row.id);
}

/**
 * Soft-delete a document and the part of its subtree the deleter can reach,
 * under ONE shared `deleted_at` — the value restore and the trash listing
 * group by. The caller has already proven `userId` owns the live root.
 *
 * You cannot delete what you cannot see (#87). A descendant the rule refuses
 * the deleter — someone else's private document under their public one — is
 * not trashed but moved to the top level, and its own subtree goes with it
 * untouched, as `cleanup:test-users` does with other people's sub-documents.
 * Since #82 the deleter's `hasChildren`, and so the delete dialog's warning,
 * counts only what they can reach; this makes the delete act on exactly that.
 *
 * The walk carries whether each row is reachable and descends only through
 * reachable ones, so the unreachable rows it finds are the TOPMOST ones — the
 * roots of what to spare. Rows already in the trash are skipped with what is
 * under them, as before: they keep the timestamp of their own deletion.
 *
 * One statement, so the cascade and the re-parenting cannot be split by a
 * concurrent move, and `parent_id`'s NO ACTION FK (#64) is never in play: no
 * row is removed. UNION, not UNION ALL, so a parent cycle ends the walk (#55).
 */
export async function trashSubtree(
  documentId: string,
  userId: string,
  deletedAt: Date,
  db: Executor = getDb(),
): Promise<void> {
  await db.execute(sql`
    WITH RECURSIVE walk AS (
      SELECT id, true AS reachable FROM documents WHERE id = ${documentId}
      UNION
      SELECT d.id, ${admits('d', userId)} AS reachable
        FROM documents d
        JOIN walk w ON d.parent_id = w.id
       WHERE w.reachable AND d.deleted_at IS NULL
    ),
    spared AS (
      UPDATE documents SET parent_id = NULL
       WHERE id IN (SELECT id FROM walk WHERE NOT reachable)
      RETURNING id
    )
    UPDATE documents SET deleted_at = ${deletedAt.toISOString()}::timestamptz
     WHERE id IN (SELECT id FROM walk WHERE reachable)
       AND deleted_at IS NULL
  `);
}

/**
 * Permanently delete a trashed document and the trashed part of its subtree
 * the purger can reach — the only hard delete the app performs. The caller has
 * already proven `userId` owns the root and that it is in the trash.
 *
 * The same rule as `trashSubtree`, for trash that predates it (#87): a delete
 * used to cascade over everything, so a trashed subtree can still hold someone
 * else's private document, and purging it destroyed that document — one its
 * owner never deleted and the purger never knew was there. Such a row, or a
 * live one, is the topmost of a part to spare: it moves to the top level with
 * everything beneath it, keeping its `deleted_at`, so a trashed one becomes a
 * deletion root in its owner's trash, to restore or purge themselves.
 *
 * Reachable here ignores `deleted_at`, which every row walked through has:
 * public or the purger's own, as `admits` would judge it were it live.
 *
 * One statement: the re-parenting lands before `parent_id`'s NO ACTION FK
 * (#64) is checked at its end, so no spared row is left pointing at a deleted
 * parent. UNION, not UNION ALL, so a parent cycle ends the walk (#55).
 */
export async function purgeSubtree(
  documentId: string,
  userId: string,
  db: Executor = getDb(),
): Promise<void> {
  await db.execute(sql`
    WITH RECURSIVE walk AS (
      SELECT id, true AS doomed FROM documents WHERE id = ${documentId}
      UNION
      SELECT d.id,
             d.deleted_at IS NOT NULL
             AND (d.visibility = 'public' OR d.created_by = ${userId}) AS doomed
        FROM documents d
        JOIN walk w ON d.parent_id = w.id
       WHERE w.doomed
    ),
    spared AS (
      UPDATE documents SET parent_id = NULL
       WHERE id IN (SELECT id FROM walk WHERE NOT doomed)
      RETURNING id
    )
    DELETE FROM documents WHERE id IN (SELECT id FROM walk WHERE doomed)
  `);
}

/**
 * Would making `parentId` the parent of `documentId` create a cycle?
 * Impossible through the UI, but a hand-made request could otherwise detach a
 * subtree into a loop that the recursive queries would never terminate on.
 */
export async function wouldCreateCycle(
  documentId: string,
  parentId: string,
  db: Executor = getDb(),
): Promise<boolean> {
  if (documentId === parentId) return true;
  const descendants = await subtreeIds(documentId, db);
  return descendants.includes(parentId);
}
