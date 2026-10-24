# xDocs

Prototype of a collaborative rich-text block editor. A document is a list of
blocks; each block is independently editable rich text, and edits sync live
between everyone with the document open.

TypeScript end to end: Hono API, Vite + React + TipTap frontend, Yjs CRDT over
Hocuspocus, Neon Postgres.

## How it fits together

```
apps/web     Vite + React + TipTap v3        :5173
apps/api     Hono REST + Hocuspocus          :3001  (one server, both protocols)
packages/shared   zod schemas + the Yjs key names both sides agree on
packages/test-support   helpers and harness shared by every test layer
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
pnpm db:migrate                # apply migrations
pnpm dev                       # api + collab + web together
```

Open http://localhost:5173. To see collaboration, open it in two windows and
type in the same block.

```bash
pnpm test          # unit: reorder index math; undo/keymap/trailing in jsdom
pnpm integration   # server: 2-client CRDT sync, persistence (needs pnpm dev)
pnpm e2e           # Playwright, real Chromium over the full stack
pnpm typecheck
```

### What the tests cover

Three layers, deliberately:

- **`pnpm test`** — pure logic plus jsdom-mounted editors, in
  `apps/web/*.test.mjs`. Fast; catches teardown and keybinding bugs.
- **`pnpm integration`** — drives Hocuspocus and REST from Node, in
  `apps/api/test/` (plus the MCP server's suite in `apps/mcp/`). Covers the REST
  contract, two-client convergence and persistence. Touches no React component.
  Its fourteen suites run concurrently (`scripts/integration.mjs`), since each
  one creates and purges everything it asserts on; pass suite names to run a
  subset.

Both are plain Node scripts on `node:test` — `node undo.test.mjs` runs one, and
`--test-name-pattern` picks out checks by name. The helpers they share with the
browser suite are the `@xdocs/test-support` package in `packages/test-support`.
- **`pnpm e2e`** — Chromium over the real stack: real clicks, real Cmd+Z, real
  HTML5 drag, two browser contexts editing one document. CI runs it as three
  shards on three runners, each with its own database.

The browser suite exists because the first two layers cannot see layout, focus
or event routing — the undo feature once shipped completely broken with both of
them green. A good few of its specs target a defect that actually shipped, and
each of those was verified by reintroducing the defect and confirming the
matching spec fails. Some deliberately assert the old broken behaviour alongside
the fix, so a dependency upgrade that brings it back fails loudly.

`npx playwright test --ui` to debug locally; failures record a trace, screenshot
and video under `test-results/`.

### Deleting a document

Deletion is a soft delete (`documents.deleted_at`). A hard delete would drop
the Yjs state with the row, so the document could never come back under the
same id. Deleted documents are hidden from the list, 404 over REST, and are
refused by the collab server until restored.

Deleting a document cascades to its sub-documents under one shared timestamp,
which is what makes the whole subtree restorable together.

### MCP server

`apps/mcp` exposes xDocs to Claude as MCP tools, so it can search your documents
for context and write notes back into them. It is a **stdio** server: the client
spawns it, and it talks to the same public REST API an outside script would,
holding an `xdk_` key.

That is the whole security story — the key acts as its owner, so the allowlist,
ancestor-gated visibility and owner-only writes all apply unchanged. The MCP
layer cannot reach anything the key could not already reach with `curl`, because
it goes through exactly that interface rather than importing the database.

#### Setting it up

**1. Create a key.** In the app, click **🔑 API keys** at the foot of the
sidebar, name it (“Claude”), and copy it. It is shown once — it is stored
hashed, so it cannot be shown again. Revoking is one click in the same dialog.

**2. Add the server.** In Claude Code:

```bash
claude mcp add xdocs --env XDOCS_API_KEY=xdk_… -- pnpm --filter @xdocs/mcp start
```

Add `--env XDOCS_API_URL=https://your-api.up.railway.app` to work against
staging instead of a local stack.

**3. Check it.** Run `/mcp` in Claude Code — `xdocs` should be connected, with
eight tools. Then ask it to search your documents, or to write one.

Claude Desktop wants the same thing as JSON:

```json
{
  "mcpServers": {
    "xdocs": {
      "command": "pnpm",
      "args": ["--filter", "@xdocs/mcp", "start"],
      "env": {
        "XDOCS_API_URL": "https://your-api.up.railway.app",
        "XDOCS_API_KEY": "xdk_…"
      }
    }
  }
}
```

Two environment variables, and only one is required:

| Variable | Required | Default |
|---|---|---|
| `XDOCS_API_KEY` | yes — the server exits at once without it | — |
| `XDOCS_API_URL` | no | `http://localhost:3001` |

There is also a `.mcp.json` in this repo, so Claude Code picks the server up
automatically in this project when `XDOCS_API_KEY` is exported in your shell —
no key is committed to it.

If the API is not running the server still starts: failures surface per tool
call, naming the URL it tried, because clients spawn it long before the stack is
up and exiting would make a working setup look broken.

Eight tools: `search_documents`, `list_documents`, `read_document`,
`create_document`, `append_to_document`, `replace_document_content`,
`move_document`, `set_document_visibility`. Reads are annotated read-only and
replacing content is annotated destructive, so clients can ask before it runs.

**No delete, restore or trash tools, deliberately.** A mistaken delete is a
surprise you find later rather than a dialog you decline, so removing a document
stays a human action in the UI, where it has a confirmation and an undo.

Because writes go through the content bridge, a document Claude writes appears
in an open editor as it lands.

### The HTTP API

Everything the app does over REST can be driven by a script. Create a key under
**API keys** in the sidebar and send it as a bearer token:

```bash
curl -H "Authorization: Bearer xdk_…" http://localhost:3001/api/documents?flat=1
```

A key acts entirely as its owner — same allowlist, same visibility rules, same
ownership checks — rather than being a separate principal with its own grants.
Only the SHA-256 is stored, so the key is shown once at creation and cannot be
recovered; revoking one takes effect on the next request. Keys cannot manage
keys: `/api/keys` answers 403 to a key, because a key that could mint keys would
turn one leaked credential into access that revoking the original does not undo.

| Route | Does |
|---|---|
| `GET /api/documents` | one level (`?parent=<id>`), or the whole visible tree with `?flat=1` |
| `POST /api/documents` | create; `parentId` nests it and copies that parent's visibility |
| `GET /api/documents/search?q=` | full-text, with ancestor paths and snippets |
| `GET /api/documents/trash` | deletion roots, with descendant counts |
| `GET /api/documents/:id` | metadata |
| `GET /api/documents/:id/path` | its ancestors, root first; empty at the top level |
| `GET /api/documents/:id/content` | title and block text |
| `PUT /api/documents/:id/content` | replace blocks, optionally the title |
| `POST /api/documents/:id/content` | append blocks |
| `GET /api/documents/:id/versions` | its history, newest first, without content |
| `POST /api/documents/:id/versions` | keep the document as it stands now |
| `GET /api/documents/:id/versions/:versionId` | one version and its content, shaped like a content read |
| `POST /api/documents/:id/versions/:versionId/restore` | make the document read as that version did |
| `PATCH /api/documents/:id/parent` | move it, `null` for the top level |
| `PATCH /api/documents/:id/visibility` | owner only |
| `DELETE /api/documents/:id` | soft delete, cascading |
| `POST /api/documents/:id/restore` | undo that |
| `DELETE /api/documents/:id/permanent` | destroy it, trash only |
| `POST /api/documents/:id/attachments` | attach a file: multipart field `file`, up to 10 MB |
| `GET /api/attachments/:id` | download it, always as an attachment |
| `GET /api/attachments/usage` | this account's file storage: used, and the limit |
| `GET /api/documents/:id/attachments` | its files, each marked used or not |
| `DELETE /api/attachments/:id` | delete one for good |
| `GET`/`POST`/`DELETE /api/keys` | manage keys; session only |

#### Content goes through the CRDT, not around it

The content routes are the only place REST touches text, and they do it by
**joining the document as a participant** through Hocuspocus's direct
connection. Writing the `ystate` column would be wrong twice over: a connected
editor would overwrite it on its next save, and open editors would never see the
change. Because the write is a real CRDT edit, text written by a script appears
in someone's open editor as it lands, and merges with what they are typing.

Blocks are plain text, deliberately. Rich text lives in ProseMirror nodes inside
the CRDT, and round-tripping that over HTTP would need the TipTap schema on the
server. A block is a single node here, so a newline inside one becomes another
block — the same shape typing it would have produced.

Links survive in both directions, written the Markdown way as
`[label](https://example.com)`; a backslash escapes a literal bracket, and an
address the editor could not open — `javascript:` and the like — is refused
rather than written in. What search indexes stays the plain words, not the
notation.

#### Attachments

The editor toolbar's 📎 uploads a file and inserts its name as a link to
`/api/attachments/<id>`. Files live in Postgres, in an `attachments` table,
rather than an object store: there is no second system or credential, and a
file is reachable exactly when its document is — it follows the document's
visibility, disappears into the trash with it, returns on restore, and is
destroyed with it by a permanent delete. The 10 MB cap is what keeps storing
them in the database reasonable.

An image is shown in place rather than linked: attaching, pasting or dropping
one inserts an image node holding the same `/api/attachments/<id>` link, and the
editor fetches it with the session's token and displays it from a blob. Its
filename lives in `alt`, which is mirrored into `content_text`, so an image is
findable by name and the content routes still have something to show for it.
A document lists its files at the foot, marking any that nothing links to any
more. Deleting a link cannot delete the file — that deletion is undoable, and
the link may be in someone else's unsynced edit — so files outlive their links
and would otherwise pile up unseen. Deleting one from the list is permanent, and
says so, including whether the document still links to it.

An attachment is an ordinary link, not a node of its own, so its name is plain
text that search finds and the content routes return. Because auth is a bearer
token, which a link cannot carry, clicking one makes the editor fetch the file
with the session's token and save it; opening the href directly gets a 401.
Downloads are always `Content-Disposition: attachment`, with `nosniff` and a
sandboxing CSP, so an uploaded HTML or SVG file never runs on the API's origin.

Each account has a total of 200 MB by default (`ATTACHMENT_QUOTA_BYTES` to
change it), counted per uploader rather than per document, since a document is
not a container anyone owns. The sidebar shows what is used once there is
anything to show, and an upload that would pass the limit is refused with what
is used and what the limit is — "quota exceeded" leaves nobody any wiser.

The other exception is a code block, whose text only means anything verbatim.
Write `{"type": "code", "text": "..."}` in place of a string and it becomes one
code block with its newlines and indentation intact; reads report such a block
as `"type": "code"`, and the object form accepts what a read returns, so a
document can be read and written back unchanged.

```json
{ "blocks": ["A paragraph", { "type": "code", "text": "if (x) {\n  y();\n}" }] }
```

### A live sidebar

A document created, moved, renamed or deleted anywhere — by another person,
another tab, a script or the MCP server — shows up in every open sidebar without
a reload. After each successful change through the documents API, and whenever
a save changes a title, the server broadcasts a `documents-changed` ping on a
read-only `workspace` collab channel, and open apps refetch their level over
REST. The ping carries no ids or titles, since everyone signed in hears it, so
what each person sees is still decided by the REST access rules.

Pings sent while a socket is down are lost, so a reconnect, and returning to the
tab, also refetch. List responses carry `x-list-as-of`, the server time they
were read, and the sidebar never replaces a list with an older one.

### Comments

Select some text, press 💬, and a thread opens in the rail on the right. Threads
are collapsed to their quote and first line; clicking one expands it, and
clicking the highlight in the text expands it too. Each comment carries its
author's name, and its author can edit or delete it — nobody else can, since the
name stays on it either way. Deleting the last comment in a thread deletes the
thread, and takes the highlight with it rather than leaving one that opens
nothing.

The rail folds away to a strip on the right, which still shows how many threads
a document has and clicks to bring them back; that choice is remembered per
browser, not in the document, since folding it on your laptop should not fold it
on anyone else's screen. Anything with a comment to show unfolds it first —
pressing 💬 with the rail folded would otherwise look like it had done nothing.

Threads live on the document's own Yjs doc, like the text and the title, so
commenting is collaborative for the same reason editing is: two people
commenting at once merge, a reply appears without a reload, and a thread
survives the paragraph around it being rewritten. Nothing goes over REST, which
is also why a comment is not searchable — `content_text` mirrors the document,
and a comment is not the document.

The highlight is a mark rather than a decoration, so it is part of the text
everyone shares rather than something drawn locally in one browser. A thread
also keeps a copy of the words it quotes: the point of a comment is what the
text said when somebody objected to it, and that range may since have been
rewritten or deleted.

### Who else is here

Each caret carries the name on the account that is typing, and the document
header shows a row of initials for everyone else in it, each in that person's
own colour — the same colour their caret is drawn in.

Identity is the **account**, not the connection. The colour is a hash of the
account id rather than a random pick, so one person is one colour on every
device and after every reload; it used to be drawn per tab, which made the same
colleague a new animal in every window. Awareness has one entry per open socket,
so the list keys people by account id: your own second tab is not a stranger,
and someone with the document open twice is one person in the row.

Presence rides on the awareness state the carets already use, rather than a
channel of its own. Being "here" therefore means having the document open, not
having typed — and leaving removes you without anything needing to be cleaned
up, because the state goes with the socket.

### Search

The search box at the top of the sidebar searches titles and block text
together, ranked with titles weighted above body text, and shows each hit with
the path it lives under and a snippet of the matching line.

Block content is a Yjs update in `ystate` — opaque to Postgres, so it cannot be
indexed and answering a query would mean decoding every document. So the collab
store hook mirrors the plain text into `documents.content_text` on each save,
exactly as it already did for `title`, and a generated `tsvector` column indexes
both. Both mirrors are derived; `ystate` stays authoritative.

Results are restricted to the caller's visible tree by the same recursive rule
the listing and the collab handshake use — a search that checked only the
document itself would be a read hole straight through visibility.

Two smaller things worth knowing:

- Results update as you type because the last word is matched as a prefix. That
  query is OR'd with `plainto_tsquery` over the raw input, which lexes it the
  way the index was built — Postgres reads `invoice-2026-draft` as `invoice`,
  `-2026`, `draft`, hyphen as minus sign, so a hand-split query for `2026`
  would otherwise never match it.
- Anything typed becomes searchable a second or two later, when Hocuspocus
  flushes the document to Postgres, not on the keystroke.

Documents saved before search existed have no mirror until someone edits them,
so there is a one-off backfill that decodes `ystate` and fills the column:

```bash
pnpm --filter @xdocs/api backfill:search    # safe to re-run
```

### Trash

**Trash** at the foot of the sidebar lists what you deleted, newest first, with
**Restore** and **Delete forever** on each row.

It lists *deletion roots*, not every deleted row: a root is a deleted document
whose parent is not deleted in the same operation. A cascaded five-document
subtree is therefore one entry saying how many descendants travel with it —
listing all five would offer restores that cannot happen independently.

Restoring re-checks the ancestor chain. Access requires every ancestor to be
visible, so a document restored under a parent that is still deleted would come
back somewhere unreachable — restored and still gone. Restore therefore clears
`parent_id` when the parent is not live, lifting the document to the top level.

**Delete forever** is the only operation in the app that destroys data: the row
and its `ystate`, which is the entire content. It is confirmation-gated, worded
as irreversible because it is, and refused (403) on a document that is not
already in the trash — so nothing live can be destroyed in one step.

### Version history

**History** in the document header lists earlier versions of the document,
previews the one you pick, and restores it (#49). `documents.ystate` only ever
holds the latest state and Yjs's undo stack lives and dies with one session, so
earlier states are copied into `document_versions`, each a full Yjs update that
decodes on its own. Three things write one:

- **The collab store hook, automatically.** Before it overwrites the stored
  state it archives that state — at most once every ten minutes
  (`VERSION_INTERVAL_MINUTES`). Archiving what is about to be overwritten, not
  what is being written, is what makes the first save of a session keep exactly
  the wording the last session ended with. A document never saved since it was
  created has nothing worth archiving and is skipped.
- **Save version now**, which reads the live document, so it includes typing
  the store has not saved yet.
- **Anything that rewrites the whole document**: a restore, and
  `PUT /content`. The likeliest caller of a replace is a script or an MCP
  client, and the automatic versions alone could be ten minutes stale.

Restoring is an edit, not a rollback: it goes through a direct connection like
every REST content write, lands in everyone's open editor, and keeps what it
replaced as a version first — so a wrong restore is one more restore away. Each
block comes back under a new id, leaving the old fragments as recoverable as a
deleted block's. Comment threads are live discussion rather than wording, so a
restore leaves them alone and only drops highlights whose thread has since been
deleted, which would otherwise open nothing.

Access is the document's: anyone who can open it can read and restore its
history. Versions go with a permanent delete and survive a soft one. Nothing
prunes them yet.

### Moving documents

`⇄` on a sidebar row reparents a document; its sub-documents go with it.
Owner-only, like delete and visibility — anyone who can see a public document
may edit its text, but rearranging someone else's tree is different.

Visibility is deliberately left alone by a move. A public document under a
private parent stops being visible to others through ancestor gating, which is
the honest outcome; flipping the document public to "fix" it would leak it. The
dialog says so before you move anything, and hides the document's own subtree
rather than offering destinations the server would refuse.

Blocks reorder by dragging the handle in the left gutter, or by focusing that
handle and pressing arrow up/down.

StarterKit's `trailingNode` is disabled. It appends a real paragraph whenever
the document's last node is not one, and re-appends it the moment you delete
it — so a heading or list block grew a permanent, unremovable empty line. That
behaviour is right for a single whole-document editor (it lets you click past a
trailing table); here every block *is* one node.

**Shift+Enter** while editing adds an empty paragraph directly below the
current block and moves the caret into it. StarterKit's HardBreak owns that key
by default, so `BlockKeymap` sits above it at priority 1000 and claims the
keystroke; without a handler it still falls through to a hard break. Note this
inserts an empty block — it does not split the text at the caret.

### Undo

TipTap's own history is off (`StarterKit.configure({ undoRedo: false })`)
because Yjs owns undo: one `Y.UndoManager` per document, shared by every block
editor, so a single Cmd/Ctrl+Z walks back through text edits, title edits,
reordering and block deletion in the order they actually happened. The
alternative — one manager per editor, which is what TipTap does by default —
gives each block a private history that cannot see structural changes, so
deleting a block would be unundoable.

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

## Staging

| | |
|---|---|
| App | https://xdocs-andrew-svs-projects.vercel.app |
| API + collab | https://xdocs-api-production.up.railway.app |
| Database | Neon (`xdocs-db`) |

Sign in with Google; only addresses in `ALLOWED_EMAILS` get in. A new document
is private to you until you make it public, after which any signed-in user can
open and edit it — as long as every document above it is public too.

`pnpm smoke <url>` checks a deployment's negative path: health is public, REST
401s without a session, and the websocket refuses a forged one. Run it after any
backend deploy.

Railway runs the root `build` script, then the root `start` script
(`pnpm -F @xdocs/api start`), which runs `dist/server.js` with plain `node`.
That file is an esbuild bundle (`apps/api/scripts/build.mjs`): `packages/shared`
exports raw TypeScript, so it is inlined, while every npm dependency stays
external and loads from `node_modules`. Without the build step, start fails on
a missing `dist/server.js`. `tsx` is only for `pnpm dev`.

Deliberately **not** using `.railway/railway.ts`: that config is declarative and
would delete every variable it does not itself declare, which would mean
committing `DATABASE_URL` and the password.

CORS is pinned to `WEB_ORIGIN`, so Vercel preview deployments will not reach
staging unless their URL is added.

## Why the hosting is split

Hocuspocus holds authoritative in-memory state per document, so it needs a
**single persistent process**. Vercel Functions do support WebSockets, but
several instances would split-brain the document: two people could be served by
different instances, each sure it held the real state.

Hence the split above — SPA on Vercel, API and collab server on Railway, data in
Neon. That is settled, not a placeholder: TipTap Cloud was the alternative and
would mean handing over the part of this repo that is actually interesting.

Two database details that follow from the same "long-lived process" fact:
`drizzle-kit` needs the direct `DATABASE_URL_UNPOOLED` while the app uses the
pooled `DATABASE_URL`, and the API connects over TCP with
`drizzle-orm/node-postgres` rather than the `neon-http` driver.

## Not built yet

- **Suggestions.** Comments exist, but there is no way to propose an edit that
  somebody else accepts or rejects — changing the words is still the only way
  to change the words.
- **Tables.** A separate TipTap extension rather than part of StarterKit, and
  nothing here wires one up.

Everything the sections above describe is built; this list is only what they do
not. It was badly out of date once (#33) — it still claimed auth, search,
drag-to-reorder and images were missing long after they shipped — so if you add
a feature, the honest cost of it is deleting a line here.
