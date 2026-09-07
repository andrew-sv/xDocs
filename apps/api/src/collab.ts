import { Database } from '@hocuspocus/extension-database';
import type { ServerConfiguration } from '@hocuspocus/server';
import { TITLE_KEY } from '@xdocs/shared';
import { and, eq, isNull } from 'drizzle-orm';
import * as Y from 'yjs';
import { authEnabled, isValidToken } from './auth.js';
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

/**
 * Collaboration configuration, applied to the Hocuspocus server in server.ts.
 *
 * Hocuspocus owns the HTTP server there and Hono is delegated to from its
 * onRequest hook — the inverse of mounting Hocuspocus on a Hono server. It has
 * to be this way round: Hocuspocus 4 handles upgrades through crossws and hands
 * `peer.websocket` to handleConnection, so a raw `ws` socket from an external
 * upgrade handler is silently the wrong peer type — the socket opens and then
 * never syncs.
 */
export const collabConfiguration: Partial<ServerConfiguration> = {
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

  // Defining onAuthenticate makes authentication REQUIRED, so it is only wired
  // up when a password is actually configured.
  ...(authEnabled
    ? {
        onAuthenticate: async ({ token }) => {
          if (!isValidToken(token)) throw new Error('Invalid access token');
        },
      }
    : {}),

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
};
