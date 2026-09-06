# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
vercel env pull .env.local     # DATABASE_URL + DATABASE_URL_UNPOOLED (Neon)
pnpm db:push                   # apply schema changes to Neon
pnpm dev                       # api :3001 + collab :1234 + web :5173, concurrently
pnpm typecheck                 # all three packages
pnpm build
```

Tests:

```bash
pnpm test    # jsdom + pure-logic unit suites (apps/web/*.test.mjs)
pnpm e2e     # server integration; REQUIRES `pnpm dev` already running
```

There is no test runner. Each suite is a plain Node script that prints
`PASS`/`FAIL` lines and exits non-zero on failure. To run one:

```bash
cd apps/web && node undo.test.mjs
```

`.ts` files are imported directly from `.mjs` tests via Node 24 type stripping.

## Architecture

pnpm workspace: `apps/api` (Hono REST + Hocuspocus, one package, two entry
points), `apps/web` (Vite + React + TipTap v3), `packages/shared` (zod schemas
and the Yjs key names both sides must agree on).

### The central design decision

**A document is ONE Yjs doc; every block is a fragment on it.**

- `blocks` — `Y.Array<BlockMeta>` of `{id, type}`. Block creation, deletion and
  ordering are CRDT ops, so concurrent structural edits merge.
- `block-<id>` — a `Y.XmlFragment` per block, bound to that block's TipTap
  editor.
- `title` — a `Y.Text`, so renaming is collaborative too.

Consequences that shape everything else:

- **Block content never travels over HTTP.** REST only handles document-level
  metadata; all text goes over the collab socket. Do not add REST endpoints
  that read or write block content or the title — the next Hocuspocus store
  would clobber them. A `PATCH` title route existed and was removed for exactly
  this reason.
- Moving a block moves only its metadata entry; its text follows automatically
  because the fragment is keyed by block id.
- Deleting a block leaves its fragment behind on purpose (Yjs cannot drop a
  root type). This is why undoing a deletion restores the text for free.

### Persistence

Single `documents` table. `ystate` (bytea) is the authoritative content, written
by Hocuspocus's Database extension on a debounce. `title` is a denormalised
copy mirrored from the CRDT on each store, so the sidebar can be served without
loading every Yjs doc.

Deletion is a **soft delete** (`deleted_at`). A hard delete would drop the Yjs
state with the row, so the document could never return under the same id.
Deleted documents are hidden from the list, 404 over REST, and refused by
`onConnect` in the collab server.

## Non-obvious constraints

Each of these caused a real bug. Changing them silently breaks things.

- **Never pass the document-wide `UndoManager` to Collaboration's
  `yUndoOptions`.** That plugin assumes it owns its manager and calls
  `undoManager.destroy()` on editor teardown; Yjs's `destroy()` detaches the
  `afterTransaction` handler, so a shared manager stops recording as soon as
  any one block unmounts. Undo then silently does nothing. Collaboration gets
  its own private manager; `DocumentUndo` (priority 1000) claims `Mod-z` and
  applies it to the document stack instead. See `src/lib/documentUndo.ts`.
- **`StarterKit.configure({ undoRedo: false, trailingNode: false })`.**
  `undoRedo` off because Yjs owns undo. `trailingNode` off because it appends a
  paragraph whenever the last node isn't one and re-appends it on delete — an
  unremovable empty line under every heading and list, since each block is a
  single node here.
- **UndoManager `trackedOrigins` must be `{null, ySyncPluginKey}`.** Our
  mutations transact with origin `null`; ProseMirror's arrive under
  `ySyncPluginKey`. Remote peers' changes carry the provider as origin and are
  excluded so undo cannot revert someone else's typing. Also call
  `addToScope` for each block fragment — y-tiptap only auto-scopes a manager it
  builds itself.
- **To override an editor keybinding, use extension `priority` above 100.**
  StarterKit's HardBreak owns `Shift-Enter`; `BlockKeymap` outranks it at 1000
  and returns `true` to stop it also firing.
- **Use `@tiptap/extension-collaboration-caret`**, not `-cursor` (the v2 name,
  frozen and incompatible with TipTap 3).
- **Drag and drop:** the payload uses a private MIME type, never `text/plain`
  (ProseMirror would insert it as literal text), and `.blocks.dragging
  .block-body` drops editors out of hit-testing so ProseMirror cannot intercept
  the drop. The handle is a `span[role=button]`, since draggable `<button>` is
  unreliable across browsers.
- **Yjs has no atomic move.** Reordering is delete+insert in one transaction, so
  two people moving the same block at once can duplicate or lose it. Accepted
  tradeoff; do not "fix" it by inventing a move op.
- **DB driver:** `drizzle-orm/node-postgres` with a `pg` Pool, not `neon-http` —
  the API is a long-lived process. The app uses the pooled `DATABASE_URL`;
  drizzle-kit needs the direct `DATABASE_URL_UNPOOLED`.
- **`drizzle-kit` and `tsx` do not read `.env.local`**; every script wraps them
  in `dotenv-cli`.

## What the tests do and do not cover

`pnpm e2e` is a **server integration** test. It drives Hocuspocus and REST from
Node and touches **no React component** — no rendering, no clicks, no
keystrokes. It covers the REST contract, two-client convergence, CRDT-level
undo, and persistence across a disconnect.

It does not cover the UI layer: toasts, buttons, drag-and-drop DOM events,
focus, layout, or whether a keybinding reaches its handler. That gap is not
theoretical — the undo bug above shipped with every test green.

`undo.test.mjs`, `keymap.test.mjs` and `trailing.test.mjs` mount real TipTap
editors in jsdom, which is why they can catch teardown and keybinding bugs. New
UI behaviour belongs there. Closing the rest of the gap needs Playwright, which
is not installed.

Several suites deliberately assert the **old broken behaviour** alongside the
fix (e.g. "with trailingNode ON a heading gains a trailing paragraph"), so a
dependency upgrade that reintroduces it fails loudly. Do not delete those.

When writing Yjs tests, note `Y.UndoManager` merges changes within its 500ms
`captureTimeout` into one stack item — call `clear()` after setup to get a
clean baseline, or assertions on stack depth will mislead.

## Deployment

Hocuspocus holds authoritative in-memory state per document, so it needs a
single persistent process. Vercel Functions support WebSockets, but multiple
instances would split-brain the document. The SPA can go to Vercel; the collab
server needs a persistent host.
