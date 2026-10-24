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
