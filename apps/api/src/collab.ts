import { Database } from '@hocuspocus/extension-database';
import { Server } from '@hocuspocus/server';
import { TITLE_KEY } from '@xdocs/shared';
import { and, eq, isNull } from 'drizzle-orm';
import * as Y from 'yjs';
import { getDb } from './db/index.js';
import { documents } from './db/schema.js';

/** `doc:<uuid>` -> `<uuid>`; null for anything we don't recognise. */
function documentIdFrom(documentName: string): string | null {
  const [prefix, id] = documentName.split(':');
  return prefix === 'doc' && id ? id : null;
}

/**
 * The title is authored in the CRDT; this mirrors it into the `title` column so
 * the document list can be served over REST without loading each Yjs doc.
 */
function readTitle(doc: Y.Doc): string {
  const title = doc.getText(TITLE_KEY).toString().trim();
  return title.length > 0 ? title.slice(0, 200) : 'Untitled';
}

const server = new Server({
  port: Number(process.env.COLLAB_PORT ?? 1234),
  address: '0.0.0.0',
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const id = documentIdFrom(documentName);
        if (!id) return null;
        const [row] = await getDb()
          .select({ ystate: documents.ystate })
          .from(documents)
          .where(eq(documents.id, id));
        return row?.ystate ? new Uint8Array(row.ystate) : null;
      },

      store: async ({ documentName, state, document }) => {
        const id = documentIdFrom(documentName);
        if (!id) return;
        await getDb()
          .update(documents)
          .set({
            ystate: Buffer.from(state),
            title: readTitle(document),
            updatedAt: new Date(),
          })
          .where(eq(documents.id, id));
      },
    }),
  ],

  onConnect: async ({ documentName }) => {
    // Refuse connections for documents that were never created over REST,
    // otherwise a typo'd id silently creates an orphan CRDT in memory.
    const id = documentIdFrom(documentName);
    if (!id) throw new Error(`Malformed document name: ${documentName}`);
    const [row] = await getDb()
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
    // A soft-deleted document is not editable until it is restored.
    if (!row) throw new Error(`Unknown document: ${id}`);
  },
});

void server.listen().then(() => {
  console.log(`[collab] ws://localhost:${process.env.COLLAB_PORT ?? 1234}`);
});
