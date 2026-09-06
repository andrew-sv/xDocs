# xDocs

Prototype of a collaborative rich-text block editor. A document is a list of
blocks; each block is independently editable rich text, and edits sync live
between everyone with the document open.

TypeScript end to end: Hono API, Vite + React + TipTap frontend, Yjs CRDT over
Hocuspocus, Neon Postgres.

## How it fits together

```
apps/web     Vite + React + TipTap v3        :5173
apps/api     Hono REST                       :3001
             Hocuspocus (Yjs WebSocket)      :1234
packages/shared   zod schemas + the Yjs key names both sides agree on
```

### The one design decision worth knowing

**A document is a single Yjs doc, and every block is a fragment on it.**

- `blocks` — a `Y.Array` of `{ id, type }` metadata. Because block creation,
  deletion and ordering are themselves CRDT operations, two people adding blocks
  at the same moment merge cleanly instead of overwriting each other.
- `block-<id>` — a `Y.XmlFragment` per block, bound to that block's TipTap
  editor.

So opening a 40-block document is still **one** WebSocket connection, and
ordering is conflict-free. The alternative — one Yjs doc per block — needs N
connections and leaves block order outside the CRDT.

The consequence: **block content never travels over HTTP.** The REST API only
handles document-level metadata (list/create/rename/delete). All text goes over
the collab socket, and Hocuspocus writes the encoded Yjs state to the
`documents.ystate` bytea column, debounced.

The **title is a `Y.Text` on the same doc**, so renaming is collaborative and
concurrent renames merge rather than overwrite. `documents.title` is a
denormalised copy that Hocuspocus mirrors on save, purely so the sidebar can be
served without loading every Yjs doc. There is deliberately no REST endpoint for
renaming — it would be silently clobbered by the next debounced save.

A new document is seeded with its first block **server-side**, at creation. Doing
it in the client would race: two people opening a fresh document would each see
an empty list and each seed a block.

## Running it

```bash
pnpm install
vercel env pull .env.local     # DATABASE_URL + DATABASE_URL_UNPOOLED from Neon
pnpm db:push                   # create the documents table
pnpm dev                       # api + collab + web together
```

Open http://localhost:5173. To see collaboration, open it in two windows and
type in the same block.

```bash
pnpm e2e         # end-to-end: 2-client sync, persistence across disconnect
pnpm typecheck
```

## Notes for later

- `drizzle-kit` uses `DATABASE_URL_UNPOOLED`; the app uses the pooled
  `DATABASE_URL`. The API is a long-lived process, so it connects over TCP with
  `drizzle-orm/node-postgres` rather than the `neon-http` driver.
- TipTap's own history is disabled (`StarterKit.configure({ undoRedo: false })`)
  because Yjs owns undo via its `UndoManager`.
- **Deployment:** Hocuspocus holds authoritative in-memory state per document,
  so it needs a single persistent process. Vercel Functions support WebSockets,
  but multiple instances would split-brain the document. Deploy the SPA to
  Vercel and the collab server to a persistent host, or move to TipTap Cloud.

## Not built yet

Auth (collaborators are anonymous colours), drag-to-reorder, block types beyond
paragraph/heading/list, images, version history, search.
