# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
vercel env pull .env.local     # DATABASE_URL + DATABASE_URL_UNPOOLED (Neon)
pnpm db:push                   # apply schema changes to Neon
pnpm dev                       # api+collab :3001, web :5173
pnpm typecheck                 # all three packages
pnpm build
```

Tests — see **Test layers** below for what each one actually covers:

```bash
pnpm test          # jsdom + pure-logic suites (apps/web/*.test.mjs)
pnpm integration   # server integration (apps/web/integration.test.mjs)
pnpm e2e           # Playwright, real Chromium (apps/web/e2e/)
```

`pnpm test` and `pnpm integration` use no test runner: each suite is a plain
Node script printing `PASS`/`FAIL` and exiting non-zero. `.ts` files are
imported straight from `.mjs` via Node 24 type stripping. To run one:

```bash
cd apps/web && node undo.test.mjs
```

For a single browser spec or test:

```bash
cd apps/web && npx playwright test e2e/undo.spec.ts -g "Cmd\+Z restores"
npx playwright test --ui        # interactive debugging
```

## Architecture

pnpm workspace: `apps/api` (Hono REST + Hocuspocus on ONE port), `apps/web`
(Vite + React + TipTap v3), `packages/shared` (zod schemas and the Yjs key
names both sides must agree on).

**Hocuspocus owns the HTTP server; Hono is delegated to from its `onRequest`
hook** — not the other way round. Hocuspocus 4 handles upgrades through crossws
and passes `peer.websocket` to `handleConnection`, so mounting it on a Hono
server with an external `ws` upgrade handler gives it the wrong peer type: the
socket opens, then silently never syncs. `onRequest` must reject with a **falsy**
value to mean "already handled", or Hocuspocus appends its own 200 response.

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

## Test layers

| Command | Layer | Catches |
|---|---|---|
| `pnpm test` | pure logic + jsdom editors | index math, editor teardown, keybindings |
| `pnpm integration` | Node against the running servers | REST contract, CRDT convergence, persistence |
| `pnpm e2e` | Playwright, real Chromium | layout, focus, event routing, multi-client UI |

`pnpm integration` and `pnpm e2e` both need the stack running (`pnpm dev`);
Playwright will start it itself if it is not, and reuses it if it is.

**Put new UI behaviour in `apps/web/e2e/`.** The first two layers cannot see
layout, focus or event routing — the undo bug shipped completely broken with
both of them green, and the two-click add button, the "Untitled" flash and the
trailing-line bug were invisible for the same reason. Each of those four now has
a spec, verified by reintroducing the defect and confirming the spec fails.

Several suites deliberately assert the **old broken behaviour** alongside the
fix (e.g. "with trailingNode ON a heading gains a trailing paragraph"), so a
dependency upgrade that reintroduces it fails loudly. Do not delete those.

Notes for writing tests here:

- `Y.UndoManager` merges changes within its 500ms `captureTimeout` into one
  stack item — call `clear()` after setup, or stack-depth assertions mislead.
- In Playwright, wait for the new block to be focused before typing
  (`addBlock()` in `e2e/fixtures.ts` does this). The editor instance does not
  exist on first render, so focus arrives a tick late and early keystrokes land
  in the previous block.
- `blockTexts()` strips collaborator caret labels, which otherwise count as
  document text in multi-client specs.
- HTML5 drag works via `dragTo`, but aim at an explicit `targetPosition`: the
  drop edge depends on the pointer being above or below the target's midpoint,
  and the element centre is exactly that boundary.

## Deployment

Hocuspocus holds authoritative in-memory state per document, so it needs a
**single persistent process**. Vercel Functions support WebSockets, but multiple
instances would split-brain the document — hence SPA on Vercel (`vercel.json`),
backend on Railway (`railway.json`), Neon for data.

Server env: `PORT` (injected by the host), `DATABASE_URL`, `WEB_ORIGIN` (the CORS
origin — pinned to one, so Vercel preview URLs will not work unless added), and
`ACCESS_PASSWORD`.

`ACCESS_PASSWORD` gates both surfaces: a Hono middleware on `/api/*` and
Hocuspocus's `onAuthenticate`. **Unset means the gate is off entirely**, which is
what keeps local dev and the whole test suite running unauthenticated. `/health`
is always public for the platform healthcheck. It is a shared secret every
visitor holds — a gate for staging, not authentication.

`pnpm smoke <url> <password>` checks a deployment: that health is public, the
API 401s without the password, and the websocket rejects a bad token but syncs
with a good one.
