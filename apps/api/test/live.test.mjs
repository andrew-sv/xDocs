/**
 * The workspace channel: how an open app learns the document list changed.
 *
 * The channel is shared by every signed-in user, so what matters most here is
 * what it does NOT carry — a ping with no data, and no way to write into it —
 * and that it pings for changes made by any route, and for renames made by
 * typing, which never touch a route at all.
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { check, cleanup, finish } from '@xdocs/test-support/harness';
import { authHeaders, signInForTests } from '@xdocs/test-support/auth';
import { trackCreatedDocuments } from '@xdocs/test-support/cleanup';

// Everything this suite creates is purged when it ends; see @xdocs/test-support/cleanup.
const tracker = trackCreatedDocuments();
cleanup(() => tracker.purge());

const API = 'http://localhost:3001';
const WS = 'ws://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = await signInForTests(API);
const H = (t, extra) => authHeaders(t, extra);

/** A listener on the workspace channel, recording every ping. */
function listen(token) {
  const doc = new Y.Doc();
  const pings = [];
  const provider = new HocuspocusProvider({
    url: WS,
    name: 'workspace',
    document: doc,
    token,
    onStateless: ({ payload }) => pings.push(payload),
    onAuthenticationFailed: () => {},
  });
  const ready = Promise.race([
    new Promise((r) => provider.on('synced', () => r(true))),
    new Promise((r) => provider.on('authenticationFailed', () => r(false))),
    sleep(6000).then(() => false),
  ]);
  return { doc, pings, provider, ready };
}

/** Wait until `pings` grows past `from`, or give up. */
async function pingAfter(pings, from, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (pings.length > from) return true;
    await sleep(50);
  }
  return false;
}

const a = listen(owner);
const b = listen(owner);
check('a signed-in user can listen on the workspace channel', await a.ready);
await b.ready;

// --- routes ping ---------------------------------------------------------------
let seen = a.pings.length;
const created = await fetch(`${API}/api/documents`, {
  method: 'POST',
  headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Live test' }),
}).then((r) => r.json());
check('creating a document pings', await pingAfter(a.pings, seen));
check('and the ping carries nothing but the signal', a.pings.at(-1) === 'documents-changed');

seen = a.pings.length;
await fetch(`${API}/api/documents/${created.id}/visibility`, {
  method: 'PATCH',
  headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ visibility: 'public' }),
});
check('changing visibility pings', await pingAfter(a.pings, seen));

seen = a.pings.length;
await fetch(`${API}/api/documents`, { headers: H(owner) });
await fetch(`${API}/api/documents/${created.id}`, { headers: H(owner) });
await sleep(500);
check('reads do not ping', a.pings.length === seen);

seen = a.pings.length;
const refused = await fetch(`${API}/api/documents/${created.id}/parent`, {
  method: 'PATCH',
  headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ parentId: created.id }),
});
await sleep(500);
check('a refused change does not ping', refused.status >= 400 && a.pings.length === seen);

// --- renaming by typing pings too, once the title is stored ----------------------
const editor = new HocuspocusProvider({
  url: WS,
  name: `doc:${created.id}`,
  document: new Y.Doc(),
  token: owner,
});
await new Promise((r) => editor.on('synced', () => r()));
seen = a.pings.length;
const title = editor.document.getText('title');
title.delete(0, title.length);
title.insert(0, 'Renamed by typing');
check('a rename typed in an editor pings once it is stored', await pingAfter(a.pings, seen, 8000));
const listed = await fetch(`${API}/api/documents`, { headers: H(owner) }).then((r) => r.json());
check(
  'and by then the list has the new title',
  listed.find((d) => d.id === created.id)?.title === 'Renamed by typing',
);

// Ordinary typing, with the title unchanged, is not a list change.
await sleep(500);
seen = a.pings.length;
const blocks = editor.document.getArray('blocks');
const fragment = editor.document.getXmlFragment(`block-${blocks.get(0).id}`);
const paragraph = new Y.XmlElement('paragraph');
paragraph.insert(0, [new Y.XmlText()]);
fragment.insert(fragment.length, [paragraph]);
await sleep(4000);
check('typing that leaves the title alone does not ping', a.pings.length === seen);
editor.destroy();

// --- the channel is read-only ------------------------------------------------------
a.doc.getText('smuggled').insert(0, 'hello from a');
await sleep(800);
check(
  'nothing written into the channel reaches other listeners',
  b.doc.getText('smuggled').toString() === '',
);

// --- and closed to strangers ---------------------------------------------------------
const forged = listen('not-a-real-session');
check('a forged session cannot listen', !(await forged.ready));
forged.provider.destroy();

a.provider.destroy();
b.provider.destroy();

await finish();
