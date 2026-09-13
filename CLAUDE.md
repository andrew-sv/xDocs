# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
vercel env pull .env.local     # DATABASE_URL + DATABASE_URL_UNPOOLED (Neon)
pnpm db:generate               # create a migration after editing schema.ts
pnpm db:migrate                # apply pending migrations
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
(Vite + React + TipTap v3), `apps/mcp` (an MCP server over the REST API),
`packages/shared` (zod schemas and the Yjs key names both sides must agree on).

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

Delete cascades to the subtree under **one shared `deleted_at`**, and that
timestamp is the grouping key everywhere afterwards: restore brings back rows
matching it, and `GET /documents/trash` treats a deleted document whose parent
does *not* share it as a deletion root. Do not "tidy" the cascade into
per-row timestamps — both would break.

`content_text` is a second denormalised mirror, written by the same store hook
as `title`, holding the plain text of every block so search has something
Postgres can index. `search` is a **generated** tsvector over `title` (weight A)
and `content_text` (weight B) with a GIN index — generated so it cannot drift.
Neither mirror is authoritative; `ystate` is. Documents saved before the column
existed are filled by `pnpm --filter @xdocs/api backfill:search`.

`api_keys` stores only a SHA-256 of each key, so the plaintext exists exactly
once — in the creation response. Revocation is soft (`revoked_at`), and the
lookup filters on it, so a revoked key stops working on the next request.

`DELETE /documents/:id/permanent` is the only hard delete in the codebase. Its
`where` clause requires `deleted_at IS NOT NULL` as well as ownership, so a live
document can never be destroyed even if the UI asks; keep it that way.

`attachments` holds uploaded files as bytea, capped at `MAX_ATTACHMENT_BYTES`.
Its `document_id` FK is `ON DELETE CASCADE` — the opposite of `parent_id` — so
files go with a permanent delete and survive a soft one. Access is exactly the
document's (`canAccessDocument`); there is no separate file permission.

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
- **Build the search query with Postgres's own lexer, not by splitting words.**
  `to_tsvector` reads `invoice-2026-draft` as `invoice`, `-2026`, `draft` — the
  hyphen becomes a minus sign — so a hand-split query for `2026` never matches
  it, and every hyphenated or numeric title silently fails to be findable.
  `GET /documents/search` ORs `plainto_tsquery` (same lexer as the index) with a
  hand-built prefix query (search-as-you-type, which plainto cannot do). Each
  side ANDs its own terms, so the OR does not loosen matching.
- **Every list response must be discardable, and fetches must not cancel each
  other.** `refresh()` in `App.tsx` drops a response when the level changed, when
  a local mutation (`invalidateList`) happened after it was sent, or when it is
  older than the list on screen. The level guard alone misses same-level races:
  creating a document while the first list fetch is in flight lets that response
  land afterwards and wipe the new row (`e2e/stale.spec.ts`). "Older" is the
  server's read time, `x-list-as-of`, not the order sent: under load the server
  answers out of order, and a list read before a restore landed last and hid the
  restored row. And no fetch may retire another merely by starting — with pings
  arriving faster than responses, that froze the sidebar entirely.
- **Sidebar liveness is a content-free ping (#22).** The documents routes (one
  middleware, every successful non-GET) and the collab store hook (only when a
  title actually changed) call `notifyDocumentsChanged()`, which broadcasts
  `documents-changed` on the read-only `workspace` collab channel; open apps
  refetch over REST. Never put ids or titles in the ping — every signed-in user
  hears it. A refetch can land before the debounced save of a title being typed,
  so `App.tsx` keeps unsaved titles (`withUnsavedTitles`) over fetched rows;
  without that, the name you are typing flips back to "Untitled".
- **REST content writes go through `withDocument()` in `src/collab.ts`, never
  the `ystate` column.** It opens a Hocuspocus direct connection, so the edit is
  a real CRDT operation: it merges with what people are typing and appears in
  open editors. Writing `ystate` passes every server-side test and fails exactly
  one browser spec — `e2e/content-api.spec.ts`, verified by doing it. Always
  `disconnect()`, or the document stays loaded for the life of the process.
- **The Hocuspocus server reaches routes through `setCollabServer()`, and the
  direct connection hangs off `server.hocuspocus`, not `server`.** `Server` is
  the transport; `Hocuspocus` is the document layer. It is set at startup rather
  than imported because the server is built from `collab.ts`'s own config.
- **Never answer 403 for "you cannot reach this document".** The web client's
  `send()` treats any 403 as "this account is not allowed in", drops the token
  and shows the login gate. Refusals on a document or file are 404, which also
  keeps ids unprobeable.
- **An attachment is a Link mark whose href is `/api/attachments/<id>`, not a
  node.** The name stays searchable text, and an older client renders a link
  instead of dropping an unknown node. The href is origin-relative and needs a
  bearer token, so it is downloaded through `fetch`, never followed.
- **Link runs with `openOnClick: false`, and `LinkClicks` handles Mod-click.**
  Link opens a link on ANY click, which made a link's own words uneditable —
  clicking into them navigated away (#23). A plain click now places the caret;
  Mod-click opens a URL or downloads an attachment, as does the Open button in
  the toolbar's link field. `e2e/links.spec.ts` covers all three.
  Note for specs: a synthetic click moves the browser caret without ProseMirror
  reading it back, so "the caret landed here" cannot be asserted after one —
  it behaves the same over plain text, a mark, or a link.
- **The formatting toolbar floats over the block above, so keep its left group
  short of that block's middle.** Link and attach sit in a separate right-hand
  group for this reason: one row of every button covered the middle, and a click
  into the block above landed on a button — `e2e/editor.spec.ts` "Shift+Enter
  inserts a block below" caught it.
- **API keys are recognised by their `xdk_` prefix before Better Auth sees the
  request**, and resolve to a plain userId — so ownership and visibility rules
  need no notion of "a key did this". `/api/keys` is session-only for the same
  reason: a key that could mint keys would survive revoking the original.
- **`apps/mcp` talks to the REST API over HTTP, never to the database.** That
  is what keeps it from being a second access path: an MCP client reaches
  exactly what its `xdk_` key could reach with curl, and there is one permission
  model rather than two that drift. Keep tool handlers as thin translations of
  routes; if a tool needs something the API cannot do, add the route.
- **In `apps/mcp`, log to stderr.** stdout carries JSON-RPC. This SDK's stdio
  transport happens to skip lines it cannot parse — verified — but other clients
  are stricter, so do not rely on it. Its tests spawn the real binary rather
  than using an in-memory transport, which is what covers the entry point.
- **Yjs has no atomic move.** Reordering is delete+insert in one transaction, so
  two people moving the same block at once can duplicate or lose it. Accepted
  tradeoff; do not "fix" it by inventing a move op.
- **DB driver:** `drizzle-orm/node-postgres` with a `pg` Pool, not `neon-http` —
  the API is a long-lived process. The app uses the pooled `DATABASE_URL`;
  drizzle-kit needs the direct `DATABASE_URL_UNPOOLED`.
- **`drizzle-kit` and `tsx` do not read `.env.local`**; every script wraps them
  in `dotenv-cli`.
- **There is no `db:push`, deliberately.** Schema changes go through committed
  migrations in `apps/api/drizzle/`: edit `schema.ts`, run `pnpm db:generate`,
  commit the generated SQL. CI applies the chain to a throwaway Postgres on
  every PR, so a broken migration fails there rather than in production. CD
  applies it to staging before deploying.
- **CD refuses destructive migrations.** `scripts/check-migrations.mjs` scans
  *pending* migrations for DROP/TRUNCATE and fails the deploy. Dropping a column
  from `documents` would take every document's `ystate` with it. To apply one
  deliberately, run it against the target yourself and redeploy — CD then sees
  it as applied.

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

- **Tests purge what they create.** Both server suites run against the dev
  database, and leftovers showed up in real sidebars. An integration suite
  calls `trackCreatedDocuments()` from `test-cleanup.mjs` before its first
  request and `await tracker.purge()` before exiting; documents made in another
  process (the MCP server) are registered with `tracker.add()`. In the browser
  suite the `doc` and `page` fixtures do it. Do not sweep "everything the test
  account owns" instead: e2e and integration share that account and can run at
  once.
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

Authentication is **Better Auth**, mounted on Hono at `/api/auth/*` with a
Drizzle adapter over the same Neon database. Google is the only sign-in method
in staging. Access is a **shared workspace**: every signed-in user sees and
edits every document. `documents.createdBy` records provenance and is
deliberately **not** used to scope access.

Two choices that are load-bearing:

- **Bearer tokens, not cookies.** The SPA and API sit on different registrable
  domains (`vercel.app` / `railway.app`), so a session cookie would be
  third-party — blocked in Safari, being phased out in Chrome. Bearer also gives
  the collab websocket a credential; it authenticates via
  `sessionFromToken()` in `src/auth.ts`, not cookies.
- **Google ID-token sign-in, not the redirect flow.** The redirect completes on
  the API's domain and leaves the session in exactly that cross-site cookie. The
  SPA gets an ID token from Google Identity Services and Better Auth exchanges
  it directly.

`ALLOW_PASSWORD_LOGIN=true` enables email+password, used **only** by local dev
and CI because Google OAuth cannot be automated. Staging leaves it unset.

Better Auth requires an `Origin` header on state-changing requests (CSRF).
Browsers always send one; Node's `fetch` does not — `test-auth.mjs` adds it.

Any test that signs **out** must use `createDisposableUser` /
`seedDisposableSession`: sign-out revokes the session server-side, so using the
shared test session logs every other parallel worker out mid-run.

`pnpm smoke <url>` checks a deployment. It covers the **negative path only** —
health is public, REST 401s unauthenticated, a forged bearer is refused, the
auth routes are mounted, and the websocket rejects a forged session. Staging has
no non-Google way in, so the signed-in path cannot be scripted there; it is
covered by the browser suite against a local stack.
