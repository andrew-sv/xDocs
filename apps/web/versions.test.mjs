/**
 * Version history (#49): what gets kept, what a version reads back as, and
 * that restoring one is a real CRDT edit rather than a write behind the
 * editors' backs.
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { authHeaders, createDisposableUser, signInForTests } from './test-auth.mjs';
import { trackCreatedDocuments } from './test-cleanup.mjs';
import { flushStore } from './test-store.mjs';

// Everything this suite creates is purged when it ends; see test-cleanup.mjs.
const tracker = trackCreatedDocuments();

const API = 'http://localhost:3001';
const WS = 'ws://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

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
ck(
  'a new document has no history',
  (await listVersions(owner, doc.id).then((r) => r.json())).length === 0,
);

await putContent(owner, doc.id, {
  title: 'First title',
  blocks: ['First wording with [a link](https://example.com)'],
});
ck(
  'replacing an empty document keeps no version of the emptiness',
  (await listVersions(owner, doc.id).then((r) => r.json())).length === 0,
);

await putContent(owner, doc.id, { title: 'Second title', blocks: ['Second wording'] });
let versions = await listVersions(owner, doc.id).then((r) => r.json());
ck(
  'replacing real content keeps what it replaced',
  versions.length === 1 && versions[0].reason === 'before-replace',
);
ck(
  'the version lists its title without its content',
  versions[0].title === 'First title' && !('ystate' in versions[0]),
);
ck('and who replaced it', versions[0].author?.name?.length > 0);
const firstVersion = versions[0];

const read = await getVersion(owner, doc.id, firstVersion.id).then((r) => r.json());
ck(
  'a version reads back in the shape of a content read',
  read.content.title === 'First title' &&
    texts(read.content).join('|') === 'First wording with [a link](https://example.com)',
);
ck(
  'the live document is untouched by reading one',
  texts(await getContent(owner, doc.id)).join('|') === 'Second wording',
);

// --- manual versions ----------------------------------------------------------
const manual = await saveVersion(owner, doc.id);
ck('a version can be saved on request', manual.status === 201);
const manualVersion = await manual.json();
ck(
  'as a manual version of the document as it stands',
  manualVersion.reason === 'manual' && manualVersion.title === 'Second title',
);
versions = await listVersions(owner, doc.id).then((r) => r.json());
ck(
  'history is newest first',
  versions.map((v) => v.id).join() === [manualVersion.id, firstVersion.id].join(),
);

// --- restoring ------------------------------------------------------------------
const watcher = connect(doc.id, owner);
await watcher.synced;

const restored = await restore(owner, doc.id, firstVersion.id);
ck('a version can be restored', restored.status === 200);
const restoredBody = await restored.json();
ck(
  'the response is the restored content',
  restoredBody.title === 'First title' &&
    texts(restoredBody).join('|') === 'First wording with [a link](https://example.com)',
);
ck(
  'a connected editor sees the restore live, links and all',
  await until(() => clientTexts(watcher.doc).join('|') === 'First wording with a link'),
);
ck('including the title', watcher.doc.getText('title').toString() === 'First title');

versions = await listVersions(owner, doc.id).then((r) => r.json());
ck('what the restore replaced is kept first', versions[0].reason === 'before-restore');
const beforeRestore = await getVersion(owner, doc.id, versions[0].id).then((r) => r.json());
ck(
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
ck('the restored text arrives', await until(() => clientTexts(watcher.doc).includes('kept gone')));
const marks = new Set();
for (const block of watcher.doc.getArray('blocks').toArray()) {
  const walk = (n) => {
    if (n instanceof Y.XmlText)
      for (const op of n.toDelta()) Object.keys(op.attributes ?? {}).forEach((k) => marks.add(k));
    else if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) n.toArray().forEach(walk);
  };
  walk(watcher.doc.getXmlFragment(`block-${block.id}`));
}
ck('a highlight whose thread still exists comes back', marks.has('comment--a'));
ck('a highlight whose thread was deleted does not', !marks.has('comment--b'));
ck(
  'the thread list is left as it is',
  [...watcher.doc.getMap('comments').keys()].join() === 'kept',
);

watcher.provider.destroy();
watcher.doc.destroy();

// --- automatic versions from the store hook -------------------------------------
const auto = await create(owner, 'Autosave test');
/** One editing session: connect, change something, leave, and let it store. */
async function session(change) {
  const client = connect(auto.id, owner);
  await client.synced;
  client.doc.transact(() => change(client.doc));
  await sleep(300);
  client.provider.destroy();
  client.doc.destroy();
  await flushStore(API, H(owner), auto.id);
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
ck('saving over a stored state archives it automatically', autos.length === 1);
ck('an automatic version has no single author', autos[0]?.author === null);
const autoRead = autos[0]
  ? await getVersion(owner, auto.id, autos[0].id).then((r) => r.json())
  : null;
ck(
  'and holds the wording the session ended with',
  autoRead !== null && texts(autoRead.content).join('|') === 'Wording from the first session',
);

// Within the interval, further saves add no automatic version.
await session((ydoc) => ydoc.getText('title').insert(0, 'Renamed '));
await session(setText('Wording from the third session'));
versions = await listVersions(owner, auto.id).then((r) => r.json());
ck('automatic versions are throttled', versions.filter((v) => v.reason === 'auto').length === 1);

// --- access ------------------------------------------------------------------------
ck(
  "a stranger cannot list a private document's history",
  (await listVersions(stranger, doc.id)).status === 404,
);
ck('or read a version of it', (await getVersion(stranger, doc.id, firstVersion.id)).status === 404);
ck('or save one', (await saveVersion(stranger, doc.id)).status === 404);
ck('or restore one', (await restore(stranger, doc.id, firstVersion.id)).status === 404);
ck(
  'a version is only reachable through its own document',
  (await getVersion(owner, auto.id, firstVersion.id)).status === 404 &&
    (await restore(owner, auto.id, firstVersion.id)).status === 404,
);
ck(
  'a malformed document id is a 404, not a 500',
  (await listVersions(owner, 'not-a-uuid')).status === 404,
);
ck(
  'a malformed version id is a 404, not a 500',
  (await getVersion(owner, doc.id, 'nope')).status === 404,
);
ck(
  'an unauthenticated request is refused',
  (await fetch(`${API}/api/documents/${doc.id}/versions`)).status === 401,
);

await tracker.purge();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
