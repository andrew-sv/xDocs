import { Database } from '@hocuspocus/extension-database';
import type { Server, ServerConfiguration } from '@hocuspocus/server';
import { collabDocName, DOCUMENTS_CHANGED, TITLE_KEY, WORKSPACE_DOC_NAME } from '@xdocs/shared';

import * as Y from 'yjs';
import { sessionFromToken } from './auth.js';
import { readContentText } from './contentText.js';
import { eq } from 'drizzle-orm';
import { canAccessDocument } from './db/access.js';
import { getDb } from './db/index.js';
import { documents } from './db/schema.js';

/*
 * The running Hocuspocus server, for editing a document from the REST side.
 *
 * Writing `ystate` directly would be wrong twice over: any connected editor
 * would overwrite it on its next save, and open editors would never see the
 * change. A direct connection joins the document as a participant instead, so
 * an API edit merges like any other and appears live in everyone's editor.
 *
 * Set once at startup rather than imported, because the server is constructed
 * from this module's own configuration — importing it would be circular.
 */
let collabServer: Server | null = null;

export function setCollabServer(server: Server): void {
  collabServer = server;
}

/**
 * Run a transaction against the live document.
 *
 * The connection is always closed, including on failure: a leaked direct
 * connection keeps the document loaded in memory for the life of the process.
 */
export async function withDocument<T>(
  documentId: string,
  transaction: (doc: Y.Doc) => T,
): Promise<T> {
  if (!collabServer) throw new Error('Collaboration server is not running');
  // `Server` is the transport; `hocuspocus` is the document layer that can open
  // a direct connection.
  const connection = await collabServer.hocuspocus.openDirectConnection(
    collabDocName(documentId),
  );
  let result!: T;
  try {
    await connection.transact((doc: { getArray: Y.Doc['getArray'] }) => {
      result = transaction(doc as unknown as Y.Doc);
    });
  } finally {
    await connection.disconnect();
  }
  return result;
}

/**
 * Tell every open app that the document list may have changed.
 *
 * The ping is content-free on purpose: every signed-in user listens on the same
 * channel, so it cannot say what changed without telling people about
 * documents they may not see. Clients refetch over REST, which applies the
 * access rules. Called after every successful change through the documents
 * routes, and by the store hook when a title changes.
 */
export function notifyDocumentsChanged(): void {
  collabServer?.hocuspocus.documents.get(WORKSPACE_DOC_NAME)?.broadcastStateless(DOCUMENTS_CHANGED);
}

/** The title each loaded document last stored, so only a rename pings. */
const storedTitles = new Map<string, string>();

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
        const title = readTitle(document);
        await getDb()
          .update(documents)
          .set({
            ystate: Buffer.from(state),
            title,
            // Mirrored for search, exactly like the title and for the same
            // reason: `ystate` is opaque to Postgres.
            contentText: readContentText(document),
            updatedAt: new Date(),
          })
          .where(eq(documents.id, id));
        // Renaming is typing, not a REST call, so the routes never see it.
        // Every save lands here, though — ping only when the title moved.
        if (storedTitles.get(documentName) !== title) {
          storedTitles.set(documentName, title);
          notifyDocumentsChanged();
        }
      },
    }),
  ],

  afterUnloadDocument: async ({ documentName }) => {
    storedTitles.delete(documentName);
  },

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
  onAuthenticate: async ({ token, documentName, connectionConfig }) => {
    const session = await sessionFromToken(token);
    if (!session) throw new Error('Invalid or expired session');

    if (documentName === WORKSPACE_DOC_NAME) {
      // Anyone signed in may listen and nobody may write: the channel only
      // carries content-free pings (see notifyDocumentsChanged).
      connectionConfig.readOnly = true;
      return { userId: session.user.id, email: session.user.email };
    }

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
