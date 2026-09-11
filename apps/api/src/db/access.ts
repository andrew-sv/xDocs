import { sql } from 'drizzle-orm';
import { getDb } from './index.js';

/**
 * The visibility rule for a document tree.
 *
 * A document is reachable only if EVERY node from the root down to it is
 * public or owned by the caller. Checking the document alone is not enough:
 * that would let a public child of a private parent be read by anyone holding
 * its id, quietly leaking a private subtree one document at a time.
 *
 * The recursive term only admits a row whose parent is already in the set, so
 * an unreachable ancestor prunes everything beneath it.
 *
 * This is the whole access boundary — REST listing, per-document routes and the
 * collaboration handshake all go through here, so there is one rule rather
 * than three that can drift apart.
 */
export const visibleTreeSql = (userId: string) => sql`
  WITH RECURSIVE visible AS (
    SELECT id, parent_id
      FROM documents
     WHERE deleted_at IS NULL
       AND parent_id IS NULL
       AND (visibility = 'public' OR created_by = ${userId})
    UNION ALL
    SELECT d.id, d.parent_id
      FROM documents d
      JOIN visible v ON d.parent_id = v.id
     WHERE d.deleted_at IS NULL
       AND (d.visibility = 'public' OR d.created_by = ${userId})
  )
`;

/** Every document id this user may reach. */
export async function visibleDocumentIds(userId: string): Promise<Set<string>> {
  const result = await getDb().execute(sql`${visibleTreeSql(userId)} SELECT id FROM visible`);
  const rows = (result as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
  return new Set(rows.map((row) => row.id));
}

/** Is this one document reachable? Used by the per-document routes and collab. */
export async function canAccessDocument(userId: string, documentId: string): Promise<boolean> {
  const result = await getDb().execute(
    sql`${visibleTreeSql(userId)} SELECT 1 AS ok FROM visible WHERE id = ${documentId} LIMIT 1`,
  );
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
  return rows.length > 0;
}

/**
 * The document plus all of its descendants, for cascading a delete.
 * Walks downward regardless of visibility — the caller has already proven
 * ownership of the root.
 */
export async function subtreeIds(documentId: string): Promise<string[]> {
  const result = await getDb().execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM documents WHERE id = ${documentId}
      UNION ALL
      SELECT d.id FROM documents d JOIN subtree s ON d.parent_id = s.id
    )
    SELECT id FROM subtree
  `);
  const rows = (result as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
  return rows.map((row) => row.id);
}

/**
 * Would making `parentId` the parent of `documentId` create a cycle?
 * Impossible through the UI, but a hand-made request could otherwise detach a
 * subtree into a loop that the recursive queries would never terminate on.
 */
export async function wouldCreateCycle(documentId: string, parentId: string): Promise<boolean> {
  if (documentId === parentId) return true;
  const descendants = await subtreeIds(documentId);
  return descendants.includes(parentId);
}
