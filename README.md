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
pnpm test        # unit: reorder index math; undo survives editor teardown
pnpm e2e         # end-to-end: 2-client sync, reorder, persistence across disconnect
pnpm typecheck
```

Blocks reorder by dragging the handle in the left gutter, or by focusing that
handle and pressing arrow up/down.

### Undo

One `Y.UndoManager` per document, shared by every block editor, so a single
Cmd/Ctrl+Z walks back through text edits, title edits, reordering and block
deletion in the order they actually happened. The alternative — TipTap's
default, one manager per editor — gives each block a private history that
cannot see structural changes, so deleting a block would be unundoable.

The manager is deliberately **not** passed to Collaboration's `yUndoOptions`.
That plugin assumes it owns its manager's lifecycle and calls
`undoManager.destroy()` when its editor view tears down; Yjs's `destroy()`
detaches the `afterTransaction` handler and drops every observer, so a shared
manager silently stops recording the moment any one block unmounts. Instead
each editor keeps the private manager TipTap can safely destroy, and a
higher-priority `DocumentUndo` extension claims Mod-z and applies it to the
document stack.

Two further details make it work:

- `trackedOrigins` is `{null, ySyncPluginKey}`. Our own mutations transact with
  origin `null`; ProseMirror's arrive under `ySyncPluginKey`. Remote peers'
  changes carry the provider as origin and are deliberately excluded, so undo
  never reverts somebody else's typing.
- y-tiptap only auto-scopes a manager it constructs itself, so each block adds
  its own fragment via `addToScope`.

Deleting a block shows a toast offering undo; it retires as soon as any later
change lands, so it can never apply to the wrong thing.

Yjs has no atomic move, so reordering is a delete plus an insert in one
transaction. If two people move the *same* block at the same instant it can
duplicate or vanish — that is why upstream never shipped a move primitive, and
it is an accepted tradeoff here. Ordinary concurrent editing is unaffected.

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
