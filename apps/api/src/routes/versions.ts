import type { DocumentVersionContentDTO, DocumentVersionDTO } from '@xdocs/shared';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { readTitle, withDirectConnection, withDocument } from '../collab.js';
import { readContent } from '../content.js';
import { canAccessDocument } from '../db/access.js';
import { user } from '../db/auth-schema.js';
import { getDb } from '../db/index.js';
import { documentVersions } from '../db/schema.js';
import { capture, decodeVersion, recordVersion, restoreVersion } from '../versions.js';

type Variables = { userId: string; email: string };

/** Checked before SQL: a malformed id would fail the uuid cast as a 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Enough to go back weeks in a busy document; older ones are still stored. */
const LIST_LIMIT = 200;

/** Never the Yjs payload: a list of versions must not load every one of them. */
const columns = {
  id: documentVersions.id,
  documentId: documentVersions.documentId,
  title: documentVersions.title,
  reason: documentVersions.reason,
  savedAt: documentVersions.savedAt,
  authorId: user.id,
  authorName: user.name,
} as const;

type VersionRow = {
  id: string;
  documentId: string;
  title: string;
  reason: DocumentVersionDTO['reason'];
  savedAt: Date;
  authorId: string | null;
  authorName: string | null;
};

function toDTO(row: VersionRow): DocumentVersionDTO {
  return {
    id: row.id,
    documentId: row.documentId,
    title: row.title,
    reason: row.reason,
    author: row.authorId && row.authorName !== null ? { id: row.authorId, name: row.authorName } : null,
    savedAt: row.savedAt.toISOString(),
  };
}

/** Can this user reach the document? Every route here starts with it. */
const reachable = async (userId: string, id: string) =>
  UUID.test(id) && (await canAccessDocument(userId, id));

const NOT_FOUND = { error: 'Document not found' } as const;

async function findVersion(documentId: string, versionId: string) {
  const [row] = await getDb()
    .select({ ...columns, ystate: documentVersions.ystate })
    .from(documentVersions)
    .leftJoin(user, eq(user.id, documentVersions.createdBy))
    .where(and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId)));
  return row ?? null;
}

/*
 * A document's history (#49).
 *
 * Access is exactly the document's, like its content and its files: anyone who
 * can open a document can read its earlier versions and restore one — the same
 * people who could type the old wording back in by hand. Every refusal is a
 * 404, so a stranger's document stays unprobeable.
 *
 * Reading a version is not a content read in the sense CLAUDE.md forbids: a
 * version is immutable, so there is no live state for Hocuspocus to clobber.
 * Restoring IS a content write, and goes through a direct connection.
 */
export const versionsRoute = new Hono<{ Variables: Variables }>()
  /** Newest first, by when the document was in that state. */
  .get('/:id/versions', async (c) => {
    if (!(await reachable(c.get('userId'), c.req.param('id')))) return c.json(NOT_FOUND, 404);
    const rows = await getDb()
      .select(columns)
      .from(documentVersions)
      .leftJoin(user, eq(user.id, documentVersions.createdBy))
      .where(eq(documentVersions.documentId, c.req.param('id')))
      .orderBy(desc(documentVersions.savedAt))
      .limit(LIST_LIMIT);
    return c.json(rows.map(toDTO));
  })

  /**
   * Keep the document as it stands right now.
   *
   * Read from the live document rather than `ystate`, which lags by the store
   * debounce — "save a version" straight after typing must include the typing.
   */
  .post('/:id/versions', async (c) => {
    const id = c.req.param('id');
    if (!(await reachable(c.get('userId'), id))) return c.json(NOT_FOUND, 404);
    const state = await withDocument(id, (doc) => capture(doc, readTitle(doc)));
    const { id: versionId } = await recordVersion({
      documentId: id,
      capture: state,
      reason: 'manual',
      userId: c.get('userId'),
    });
    const row = await findVersion(id, versionId);
    return c.json(toDTO(row!), 201);
  })

  /** One version and its content, shaped like a content read. */
  .get('/:id/versions/:versionId', async (c) => {
    const id = c.req.param('id');
    const versionId = c.req.param('versionId');
    if (!(await reachable(c.get('userId'), id))) return c.json(NOT_FOUND, 404);
    if (!UUID.test(versionId)) return c.json({ error: 'Version not found' }, 404);
    const row = await findVersion(id, versionId);
    if (!row) return c.json({ error: 'Version not found' }, 404);

    const doc = decodeVersion(row.ystate);
    try {
      const body: DocumentVersionContentDTO = { version: toDTO(row), content: readContent(id, doc) };
      return c.json(body);
    } finally {
      doc.destroy();
    }
  })

  /**
   * Bring a version back.
   *
   * Not a rollback of history: the restore is a new edit on top of the
   * document, and what it replaced is first kept as a `before-restore`
   * version — so restoring the wrong version is itself undoable from here.
   * Both steps share one direct connection, so the state that is kept is the
   * state that is replaced.
   */
  .post('/:id/versions/:versionId/restore', async (c) => {
    const id = c.req.param('id');
    const versionId = c.req.param('versionId');
    if (!(await reachable(c.get('userId'), id))) return c.json(NOT_FOUND, 404);
    if (!UUID.test(versionId)) return c.json({ error: 'Version not found' }, 404);
    const row = await findVersion(id, versionId);
    if (!row) return c.json({ error: 'Version not found' }, 404);

    const version = decodeVersion(row.ystate);
    try {
      const content = await withDirectConnection(id, async (transact) => {
        const before = await transact((doc) => capture(doc, readTitle(doc)));
        if (!before.empty) {
          await recordVersion({ documentId: id, capture: before, reason: 'before-restore', userId: c.get('userId') });
        }
        return transact((doc) => {
          restoreVersion(doc, version);
          return readContent(id, doc);
        });
      });
      return c.json(content);
    } finally {
      version.destroy();
    }
  });
