import { Database } from '@hocuspocus/extension-database';
import type { ServerConfiguration } from '@hocuspocus/server';
import { TITLE_KEY } from '@xdocs/shared';

import * as Y from 'yjs';
import { sessionFromToken } from './auth.js';
import { eq } from 'drizzle-orm';
import { canAccessDocument } from './db/access.js';
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

  /*
   * Authentication AND authorisation happen here, together.
   *
   * They cannot be split across hooks: onConnect fires BEFORE onAuthenticate,
   * so `context` is still empty there — an ownership check in onConnect sees no
   * userId and locks owners out of their own private documents.
   *
   * The provider sends the same bearer token the REST API uses, which is why
   * bearer beats cookies here: a websocket handshake carries no usable
   * cross-site cookie.
   */
  onAuthenticate: async ({ token, documentName }) => {
    const session = await sessionFromToken(token);
    if (!session) throw new Error('Invalid or expired session');

    const id = documentIdFrom(documentName);
    if (!id) throw new Error(`Malformed document name: ${documentName}`);

    /*
     * The load-bearing access check.
     *
     * Block content never travels over HTTP — it all comes through this socket,
     * so guarding only the REST routes would leave a private document fully
     * readable AND writable to anyone with its id.
     *
     * Uses the same ancestor-gated helper as REST, so a public document nested
     * under a private parent is refused here too rather than being reachable
     * through a rule that only checked the document itself.
     */
    const allowed = await canAccessDocument(session.user.id, id);
    if (!allowed) throw new Error(`Document not found or not accessible: ${id}`);

    // Handed to every hook downstream as `context`.
    return { userId: session.user.id, email: session.user.email };
  },
};
