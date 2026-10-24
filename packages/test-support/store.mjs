/**
 * Make the collab server write a document to Postgres, now.
 *
 * Hocuspocus's Database extension stores on a 2s debounce, so a suite that
 * wants to see persisted state used to `sleep(3500)` and hope. That is the
 * single biggest fixed wait in the integration layer, and it is a guess in
 * both directions — long enough to be slow, short enough to be flaky on a bad
 * day (#32).
 *
 * There is no need to wait at all. A direct connection disconnecting runs the
 * store hook with a debounce of ZERO and awaits it, then unloads the document
 * if nothing else holds it — and `withDocument()` in the API opens exactly
 * such a connection, for every route under `/documents/:id/content`. So a
 * plain READ of that route flushes the CRDT to Postgres and drops it out of
 * memory, as a side effect of serving the request. That is what this does.
 *
 * Two things follow, and both are what a suite calling this actually wants:
 *
 *  - `title`, `content_text` and `updated_at` are mirrored by the same store
 *    hook, so search can see the document the moment this returns.
 *  - the document is out of memory, so the next client to connect really does
 *    load it from Postgres — which is the whole point of a persistence check.
 */

/**
 * The one genuine wait left, and it is small.
 *
 * The unload only happens when the document has no connections, and the server
 * learns a client is gone when it processes that socket's close — for which
 * there is no observable from out here. Closing a local socket is a
 * single-digit millisecond affair, so this is a wide margin, not a guess at a
 * duration. Get it wrong and the store still runs and the content is still
 * safe; only the "loaded from Postgres" part of a persistence check weakens.
 */
const SETTLE_MS = 250;

/**
 * Flush `documentId` to Postgres and wait for it to land.
 *
 * Call it after destroying every provider for that document. `headers` are the
 * caller's authenticated headers, as `authHeaders()` builds them.
 */
export async function flushStore(api, headers, documentId) {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const res = await fetch(`${api}/api/documents/${documentId}/content`, { headers });
  // A failure here is a broken test, not a failed assertion: everything after
  // it would be asserting on state that was never written.
  if (!res.ok) {
    throw new Error(`flushStore(${documentId}) failed: ${res.status} ${await res.text()}`);
  }
  await res.json();
}
