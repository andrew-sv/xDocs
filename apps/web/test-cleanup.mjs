/**
 * Purge the documents an integration suite creates, once it has finished.
 *
 * Without this every run left its documents in the dev database for good, and
 * the public ones ("Replaced by MCP", "Move home") turned up in real people's
 * sidebars. The e2e fixtures do the same job for the browser suite.
 *
 * Creation is observed rather than declared: `trackCreatedDocuments()` wraps
 * the global fetch and records every successful `POST /api/documents` with the
 * credential that made it, so a suite needs no bookkeeping of its own and a
 * document made as a disposable user is purged as that user. Documents made in
 * another process — by the MCP server — are registered with `add()`.
 */
import { TEST_ORIGIN, signInForTests } from './test-auth.mjs';

export function trackCreatedDocuments() {
  const realFetch = globalThis.fetch;
  /** In creation order, so a parent goes first and takes its subtree with it. */
  const created = [];
  const pending = [];

  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST' && url.pathname === '/api/documents' && response.status === 201) {
      const authorization = new Headers(init?.headers).get('authorization');
      pending.push(
        response.clone().json().then(
          (doc) => {
            if (doc?.id && authorization) created.push({ id: doc.id, authorization, api: url.origin });
          },
          () => {},
        ),
      );
    }
    return response;
  };

  return {
    /** A document this process did not create itself, e.g. one made through MCP. */
    add(id, token, api = 'http://localhost:3001') {
      created.push({ id, authorization: `Bearer ${token}`, api });
    },

    /**
     * Trash, then permanently delete, everything recorded. The permanent route
     * only accepts something already trashed, hence two steps.
     */
    async purge() {
      globalThis.fetch = realFetch;
      await Promise.all(pending);
      let shared = null;
      const leftBehind = [];

      const attempt = async ({ id, api }, authorization) => {
        const headers = { authorization, origin: TEST_ORIGIN };
        const trashed = await realFetch(`${api}/api/documents/${id}`, { method: 'DELETE', headers })
          .then((r) => r.status, () => 0);
        const purged = await realFetch(`${api}/api/documents/${id}/permanent`, { method: 'DELETE', headers })
          .then((r) => r.status, () => 0);
        return { trashed, purged };
      };

      for (const doc of created) {
        let result = await attempt(doc, doc.authorization);
        // The credential may be gone by now — a suite that revokes the API key
        // it created documents with. Those belong to the shared test account.
        if (result.trashed === 401 || result.purged === 401) {
          shared ??= `Bearer ${await signInForTests(doc.api)}`;
          result = await attempt(doc, shared);
        }
        // 403 twice means it is already gone: with a purged ancestor, or by
        // the suite's own hand.
        const gone = result.purged === 204 || (result.trashed === 403 && result.purged === 403);
        if (!gone) leftBehind.push(`${doc.id} (delete ${result.trashed}, purge ${result.purged})`);
      }

      if (leftBehind.length > 0) {
        console.warn(`cleanup: ${leftBehind.length} document(s) left behind:\n  ${leftBehind.join('\n  ')}`);
      }
    },
  };
}
