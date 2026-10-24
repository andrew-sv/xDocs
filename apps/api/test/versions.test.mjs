/**
 * Version history (#49): what gets kept, what a version reads back as, and
 * that restoring one is a real CRDT edit rather than a write behind the
 * editors' backs.
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as Y from 'yjs';
import { check, cleanup, finish } from '@xdocs/test-support/harness';
import { authHeaders, createDisposableUser, signInForTests } from '@xdocs/test-support/auth';
import { trackCreatedDocuments } from '@xdocs/test-support/cleanup';
import { flushStore } from '@xdocs/test-support/store';

// Everything this suite creates is purged when it ends; see @xdocs/test-support/cleanup.
const tracker = trackCreatedDocuments();
cleanup(() => tracker.purge());

const API = 'http://localhost:3001';
const WS = 'ws://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);
const json = { 'content-type': 'application/json' };

const create = (token, title) =>
  fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H(token, json),
    body: JSON.stringify({ title }),
  }).then((r) => r.json());
const putContent = (token, id, body) =>
  fetch(`${API}/api/documents/${id}/content`, {
    method: 'PUT',
    headers: H(token, json),
    body: JSON.stringify(body),
  });
const getContent = (token, id) =>
  fetch(`${API}/api/documents/${id}/content`, { headers: H(token) }).then((r) => r.json());
const listVersions = (token, id) =>
  fetch(`${API}/api/documents/${id}/versions`, { headers: H(token) });
const saveVersion = (token, id) =>
  fetch(`${API}/api/documents/${id}/versions`, { method: 'POST', headers: H(token) });
const getVersion = (token, id, v) =>
  fetch(`${API}/api/documents/${id}/versions/${v}`, { headers: H(token) });
const restore = (token, id, v) =>
  fetch(`${API}/api/documents/${id}/versions/${v}/restore`, { method: 'POST', headers: H(token) });
const texts = (content) => content.blocks.map((b) => b.text);

function connect(docId, token) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: WS,
    name: `doc:${docId}`,
    document: doc,
    token,
    onAuthenticationFailed: () => {},
  });
  return { doc, provider, synced: new Promise((res) => provider.on('synced', () => res())) };
}

/** Plain text of each block in a client's copy of the document. */
const clientTexts = (doc) =>
  doc
    .getArray('blocks')
    .toArray()
    .map((block) => {
      const parts = [];
      const walk = (n) => {
        if (n instanceof Y.XmlText)
          return parts.push(
            n
              .toDelta()
              .map((op) => op.insert)
              .join(''),
          );
        if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) n.toArray().forEach(walk);
      };
      walk(doc.getXmlFragment(`block-${block.id}`));
      return parts.join('');
    });

async function until(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

// --- versions taken around a replace ----------------------------------------
const doc = await create(owner, 'History test');
check(
  'a new document has no history',
  (await listVersions(owner, doc.id).then((r) => r.json())).length === 0,
);

await putContent(owner, doc.id, {
  title: 'First title',
  blocks: ['First wording with [a link](https://example.com)'],
});
check(
  'replacing an empty document keeps no version of the emptiness',
  (await listVersions(owner, doc.id).then((r) => r.json())).length === 0,
);

await putContent(owner, doc.id, { title: 'Second title', blocks: ['Second wording'] });
let versions = await listVersions(owner, doc.id).then((r) => r.json());
check(
  'replacing real content keeps what it replaced',
  versions.length === 1 && versions[0].reason === 'before-replace',
);
check(
  'the version lists its title without its content',
  versions[0].title === 'First title' && !('ystate' in versions[0]),
);
check('and who replaced it', versions[0].author?.name?.length > 0);
const firstVersion = versions[0];

const read = await getVersion(owner, doc.id, firstVersion.id).then((r) => r.json());
check(
  'a version reads back in the shape of a content read',
  read.content.title === 'First title' &&
    texts(read.content).join('|') === 'First wording with [a link](https://example.com)',
);
check(
  'the live document is untouched by reading one',
  texts(await getContent(owner, doc.id)).join('|') === 'Second wording',
);

// --- manual versions ----------------------------------------------------------
const manual = await saveVersion(owner, doc.id);
check('a version can be saved on request', manual.status === 201);
const manualVersion = await manual.json();
check(
  'as a manual version of the document as it stands',
  manualVersion.reason === 'manual' && manualVersion.title === 'Second title',
);
versions = await listVersions(owner, doc.id).then((r) => r.json());
check(
  'history is newest first',
  versions.map((v) => v.id).join() === [manualVersion.id, firstVersion.id].join(),
);

// --- restoring ------------------------------------------------------------------
const watcher = connect(doc.id, owner);
await watcher.synced;

const restored = await restore(owner, doc.id, firstVersion.id);
check('a version can be restored', restored.status === 200);
const restoredBody = await restored.json();
check(
  'the response is the restored content',
  restoredBody.title === 'First title' &&
    texts(restoredBody).join('|') === 'First wording with [a link](https://example.com)',
);
check(
  'a connected editor sees the restore live, links and all',
  await until(() => clientTexts(watcher.doc).join('|') === 'First wording with a link'),
);
check('including the title', watcher.doc.getText('title').toString() === 'First title');

versions = await listVersions(owner, doc.id).then((r) => r.json());
check('what the restore replaced is kept first', versions[0].reason === 'before-restore');
const beforeRestore = await getVersion(owner, doc.id, versions[0].id).then((r) => r.json());
check(
  'so a wrong restore can itself be undone',
  texts(beforeRestore.content).join('|') === 'Second wording',
);

// --- comments survive, and only live threads keep their highlight ---------------
watcher.doc.transact(() => {
  const threads = watcher.doc.getMap('comments');
  for (const id of ['kept', 'gone']) {
    const thread = new Y.Map();
    thread.set('id', id);
    threads.set(id, thread);
  }
  const blocks = watcher.doc.getArray('blocks');
  const block = { id: crypto.randomUUID(), type: 'paragraph' };
  blocks.push([block]);
  const paragraph = new Y.XmlElement('paragraph');
  watcher.doc.getXmlFragment(`block-${block.id}`).insert(0, [paragraph]);
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  text.insert(0, 'kept', { 'comment--a': { threadId: 'kept' } });
  text.insert(4, ' gone', { 'comment--a': null, 'comment--b': { threadId: 'gone' } });
});
await sleep(300);
const commented = await saveVersion(owner, doc.id).then((r) => r.json());
watcher.doc.transact(() => watcher.doc.getMap('comments').delete('gone'));
await sleep(300);
await restore(owner, doc.id, commented.id);
check(
  'the restored text arrives',
  await until(() => clientTexts(watcher.doc).includes('kept gone')),
);
const marks = new Set();
for (const block of watcher.doc.getArray('blocks').toArray()) {
  const walk = (n) => {
    if (n instanceof Y.XmlText)
      for (const op of n.toDelta()) Object.keys(op.attributes ?? {}).forEach((k) => marks.add(k));
    else if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) n.toArray().forEach(walk);
  };
  walk(watcher.doc.getXmlFragment(`block-${block.id}`));
}
check('a highlight whose thread still exists comes back', marks.has('comment--a'));
check('a highlight whose thread was deleted does not', !marks.has('comment--b'));
check(
  'the thread list is left as it is',
  [...watcher.doc.getMap('comments').keys()].join() === 'kept',
);

watcher.provider.destroy();
watcher.doc.destroy();

// --- a restore reuses the blocks it can (#60) -----------------------------------
// Every restore used to bring each block back under a new id, leaving the old
// fragments behind, so restoring N times added N fragments per block for good.
const repeated = await create(owner, 'Repeated restore test');
await putContent(owner, repeated.id, { title: 'Repeated', blocks: ['One', 'Two', 'Three'] });
const kept = await saveVersion(owner, repeated.id).then((r) => r.json());
const editor = connect(repeated.id, owner);
await editor.synced;
/** Root types of the `block-<id>` kind: live blocks and every one left behind. */
const fragmentCount = (ydoc) => [...ydoc.share.keys()].filter((k) => k.startsWith('block-')).length;
const blockIds = (ydoc) =>
  ydoc
    .getArray('blocks')
    .toArray()
    .map((b) => b.id);
// Edit the first block's text and delete the last block, as a person would.
editor.doc.transact(() => {
  const [first] = editor.doc.getArray('blocks').toArray();
  const text = editor.doc.getXmlFragment(`block-${first.id}`).get(0).get(0);
  text.insert(text.length, ' edited');
  editor.doc.getArray('blocks').delete(2, 1);
});
await sleep(300);
const idsBefore = blockIds(editor.doc);
const fragmentsBefore = fragmentCount(editor.doc);

for (let n = 0; n < 3; n++) await restore(owner, repeated.id, kept.id);
check(
  'restoring repeatedly lands the version',
  await until(() => clientTexts(editor.doc).join('|') === 'One|Two|Three'),
);
await sleep(300);
const fragmentsAfter = fragmentCount(editor.doc);
check(
  `three restores add one fragment, the deleted block's copy — not one per block each time (${fragmentsBefore} -> ${fragmentsAfter})`,
  fragmentsAfter === fragmentsBefore + 1,
);
check(
  'a block still in the document keeps its id, so an open editor stays on it',
  blockIds(editor.doc).slice(0, 2).join() === idsBefore.join(),
);
editor.provider.destroy();
editor.doc.destroy();
// What reaches Postgres is the same: nothing piled up behind the editor.
await flushStore(API, H(owner), repeated.id);
const reloaded = connect(repeated.id, owner);
await reloaded.synced;
check(
  'the stored document holds no more fragments than the client saw',
  fragmentCount(reloaded.doc) === fragmentsAfter &&
    clientTexts(reloaded.doc).join('|') === 'One|Two|Three',
);
reloaded.provider.destroy();
reloaded.doc.destroy();

// --- automatic versions from the store hook -------------------------------------
const auto = await create(owner, 'Autosave test');
/** One editing session: connect, change something, leave, and let it store. */
async function session(change, docId = auto.id) {
  const client = connect(docId, owner);
  await client.synced;
  client.doc.transact(() => change(client.doc));
  await sleep(300);
  client.provider.destroy();
  client.doc.destroy();
  await flushStore(API, H(owner), docId);
}
const setText = (text) => (ydoc) => {
  const [block] = ydoc.getArray('blocks').toArray();
  const fragment = ydoc.getXmlFragment(`block-${block.id}`);
  fragment.delete(0, fragment.length);
  const paragraph = new Y.XmlElement('paragraph');
  fragment.insert(0, [paragraph]);
  const node = new Y.XmlText();
  paragraph.insert(0, [node]);
  node.insert(0, text);
};

await session(setText('Wording from the first session'));
// The next session's save overwrites that stored state, so it is archived.
await session(setText('Wording from the second session'));
versions = await listVersions(owner, auto.id).then((r) => r.json());
const autos = versions.filter((v) => v.reason === 'auto');
check('saving over a stored state archives it automatically', autos.length === 1);
check('an automatic version has no single author', autos[0]?.author === null);
const autoRead = autos[0]
  ? await getVersion(owner, auto.id, autos[0].id).then((r) => r.json())
  : null;
check(
  'and holds the wording the session ended with',
  autoRead !== null && texts(autoRead.content).join('|') === 'Wording from the first session',
);

// Within the interval, further saves add no automatic version.
await session((ydoc) => ydoc.getText('title').insert(0, 'Renamed '));
await session(setText('Wording from the third session'));
versions = await listVersions(owner, auto.id).then((r) => r.json());
check('automatic versions are throttled', versions.filter((v) => v.reason === 'auto').length === 1);

// --- retention (#63) ----------------------------------------------------------------
// History older than a day is made by writing backdated rows straight into
// document_versions — only ever for documents this suite created — and the
// store hook prunes when the next session archives a version. The rule itself,
// edge by edge, is apps/web/retention.test.mjs; this is that the hook applies it.
if (!process.env.DATABASE_URL) process.loadEnvFile(new URL('../../../.env.local', import.meta.url));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
cleanup(() => db.end());

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** UTC midnight `n` days before now, plus `hours`. */
const daysAgo = (n, hours = 0) => {
  const day = new Date(Date.now() - n * DAY);
  day.setUTCHours(0, 0, 0, 0);
  return new Date(day.getTime() + hours * HOUR);
};
/** A version of the document's stored state, dated `savedAt`, as if written then. */
const backdate = async (docId, reason, savedAt) => {
  const { rows } = await db.query(
    `INSERT INTO document_versions (document_id, ystate, title, reason, saved_at, created_at)
     SELECT id, ystate, title, $2, $3, $3 FROM documents WHERE id = $1
     RETURNING id`,
    [docId, reason, savedAt],
  );
  return rows[0].id;
};
const storedIds = async (docId) =>
  new Set(
    (await db.query(`SELECT id FROM document_versions WHERE document_id = $1`, [docId])).rows.map(
      (r) => r.id,
    ),
  );

const pruned = await create(owner, 'Retention test');
const bystander = await create(owner, 'Retention bystander');
// A first session, so each has a stored state to copy and to archive later.
await session(setText('Retention wording one'), pruned.id);
await session(setText('Bystander wording'), bystander.id);
// A session can store twice — once as its socket closes, again as the flush's
// direct connection does — and the second archives the first, which would
// throttle the next session's archive for the whole interval. Age those rows'
// write time past it, which is all the interval passing would do.
await db.query(
  `UPDATE document_versions SET created_at = created_at - interval '1 day'
    WHERE document_id = ANY($1::uuid[])`,
  [[pruned.id, bystander.id]],
);

// The Monday of a week well beyond the 30-day daily tier.
const monday = daysAgo(70);
monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
const atMonday = (days, hours) => new Date(monday.getTime() + days * DAY + hours * HOUR);

const old = {
  manual: await backdate(pruned.id, 'manual', daysAgo(45, 10)),
  sameDay1: await backdate(pruned.id, 'auto', daysAgo(3, 1)),
  sameDay2: await backdate(pruned.id, 'auto', daysAgo(3, 2)),
  sameDay3: await backdate(pruned.id, 'auto', daysAgo(3, 3)),
  restoreNew: await backdate(pruned.id, 'before-restore', daysAgo(5, 10)),
  afterRestoreNew: await backdate(pruned.id, 'auto', daysAgo(5, 12)),
  restoreOld: await backdate(pruned.id, 'before-restore', daysAgo(6, 10)),
  afterRestoreOld: await backdate(pruned.id, 'auto', daysAgo(6, 12)),
  replaceNew: await backdate(pruned.id, 'before-replace', daysAgo(8, 10)),
  afterReplaceNew: await backdate(pruned.id, 'auto', daysAgo(8, 12)),
  replaceOld: await backdate(pruned.id, 'before-replace', daysAgo(9, 10)),
  afterReplaceOld: await backdate(pruned.id, 'auto', daysAgo(9, 12)),
  tuesday: await backdate(pruned.id, 'auto', atMonday(1, 10)),
  wednesday: await backdate(pruned.id, 'auto', atMonday(2, 10)),
  recent1: await backdate(pruned.id, 'auto', new Date(Date.now() - 2 * HOUR)),
  recent2: await backdate(pruned.id, 'auto', new Date(Date.now() - 1 * HOUR)),
};
const bystanderOld = [
  await backdate(bystander.id, 'auto', daysAgo(3, 1)),
  await backdate(bystander.id, 'auto', daysAgo(3, 2)),
];

// This session's store archives the first session's state, then prunes.
const beforeArchive = await storedIds(pruned.id);
await session(setText('Retention wording two'), pruned.id);
let stored = await storedIds(pruned.id);
const has = (...keys) => keys.every((k) => stored.has(old[k]));
const lacks = (...keys) => keys.every((k) => !stored.has(old[k]));

check(
  'archiving a version prunes the history it joins',
  [...stored].some((id) => !beforeArchive.has(id)) && lacks('sameDay1'),
);
check(
  'old automatic versions on one day collapse to the newest of them',
  has('sameDay3') && lacks('sameDay1', 'sameDay2'),
);
check('a manual version survives pruning, however old', has('manual'));
check(
  'the newest before-restore survives beside a newer version of its day',
  has('restoreNew', 'afterRestoreNew'),
);
check(
  'the newest before-replace survives beside a newer version of its day',
  has('replaceNew', 'afterReplaceNew'),
);
check(
  'older before-restore and before-replace versions thin out like automatic ones',
  lacks('restoreOld', 'replaceOld') && has('afterRestoreOld', 'afterReplaceOld'),
);
check('beyond 30 days, one version per week: its newest', has('wednesday') && lacks('tuesday'));
check('every version from the last 24 hours is kept', has('recent1', 'recent2'));
check(
  "pruning one document leaves another's history alone",
  await storedIds(bystander.id).then((ids) => bystanderOld.every((id) => ids.has(id))),
);

// Within the interval a store archives nothing, so it prunes nothing either:
// the cost is paid only on the rare store that grew the history.
const unpruned = [
  await backdate(pruned.id, 'auto', daysAgo(4, 1)),
  await backdate(pruned.id, 'auto', daysAgo(4, 2)),
];
await session(setText('Retention wording three'), pruned.id);
stored = await storedIds(pruned.id);
check(
  'a store that archives nothing prunes nothing',
  unpruned.every((id) => stored.has(id)),
);

// The backfill script applies the same rule to history nobody edits — here,
// the bystander's, and only that: --document keeps it off everyone else's.
const pruneScript = (...args) =>
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/prune-versions.mjs', import.meta.url)),
      '--document',
      bystander.id,
      ...args,
    ],
    // stderr is captured rather than echoed — pg prints an sslmode notice
    // there — and still comes back on the error if the script fails.
    { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
const dry = pruneScript('--dry-run');
check(
  'the backfill script reports what it would prune, and a dry run keeps it',
  /would delete 1 of \d+ version\(s\) across 1 document/.test(dry) &&
    (await storedIds(bystander.id).then((ids) => bystanderOld.every((id) => ids.has(id)))),
);
pruneScript();
const bystanderLeft = await storedIds(bystander.id);
check(
  'and a real run collapses the day to its newest version',
  bystanderLeft.has(bystanderOld[1]) && !bystanderLeft.has(bystanderOld[0]),
);
await db.end();

// --- access ------------------------------------------------------------------------
check(
  "a stranger cannot list a private document's history",
  (await listVersions(stranger, doc.id)).status === 404,
);
check(
  'or read a version of it',
  (await getVersion(stranger, doc.id, firstVersion.id)).status === 404,
);
check('or save one', (await saveVersion(stranger, doc.id)).status === 404);
check('or restore one', (await restore(stranger, doc.id, firstVersion.id)).status === 404);
check(
  'a version is only reachable through its own document',
  (await getVersion(owner, auto.id, firstVersion.id)).status === 404 &&
    (await restore(owner, auto.id, firstVersion.id)).status === 404,
);
check(
  'a malformed document id is a 404, not a 500',
  (await listVersions(owner, 'not-a-uuid')).status === 404,
);
check(
  'a malformed version id is a 404, not a 500',
  (await getVersion(owner, doc.id, 'nope')).status === 404,
);
check(
  'an unauthenticated request is refused',
  (await fetch(`${API}/api/documents/${doc.id}/versions`)).status === 401,
);

await finish();
