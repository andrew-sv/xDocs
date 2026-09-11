/**
 * Visibility: private is owner-only, public is open to any signed-in user.
 *
 * Everything here needs TWO users — a single-user test cannot tell "enforced"
 * from "not implemented". The websocket assertions matter most: block content
 * never travels over HTTP, so REST checks alone would prove very little.
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { authHeaders, createDisposableUser, signInForTests } from './test-auth.mjs';
import { trackCreatedDocuments } from './test-cleanup.mjs';

// Everything this suite creates is purged when it ends; see test-cleanup.mjs.
const tracker = trackCreatedDocuments();

const API = 'http://localhost:3001';
const WS = 'ws://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ck = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) fail++; };

const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);

/** Can this token reach the document over the websocket? */
async function canConnect(token, id) {
  const provider = new HocuspocusProvider({
    url: WS, name: `doc:${id}`, document: new Y.Doc(),
    token, onAuthenticationFailed: () => {},
  });
  const result = await Promise.race([
    new Promise((r) => provider.on('synced', () => r(true))),
    new Promise((r) => provider.on('authenticationFailed', () => r(false))),
    new Promise((r) => provider.on('close', () => r(false))),
    sleep(6000).then(() => false),
  ]);
  provider.destroy();
  return result;
}

const listIds = (token) =>
  fetch(`${API}/api/documents`, { headers: H(token) })
    .then((r) => r.json())
    .then((rows) => rows.map((d) => d.id));

// --- a new document is private and owner-only ------------------------------
const doc = await fetch(`${API}/api/documents`, {
  method: 'POST', headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'visibility test' }),
}).then((r) => r.json());

ck('a new document defaults to private', doc.visibility === 'private');
ck('the creator is the owner', doc.isOwner === true);
ck('owner sees it in their list', (await listIds(owner)).includes(doc.id));
ck('stranger does NOT see it in their list', !(await listIds(stranger)).includes(doc.id));
ck(
  'stranger gets 404 fetching it directly',
  (await fetch(`${API}/api/documents/${doc.id}`, { headers: H(stranger) })).status === 404,
);
ck('owner can open the websocket', await canConnect(owner, doc.id));
ck('stranger CANNOT open the websocket', !(await canConnect(stranger, doc.id)));

// --- a stranger cannot administer someone else's document ------------------
const patchAs = (token, visibility) =>
  fetch(`${API}/api/documents/${doc.id}/visibility`, {
    method: 'PATCH', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ visibility }),
  });
ck('stranger cannot change visibility (403)', (await patchAs(stranger, 'public')).status === 403);
ck(
  'stranger cannot delete (403)',
  (await fetch(`${API}/api/documents/${doc.id}`, { method: 'DELETE', headers: H(stranger) })).status === 403,
);
ck('document is still private after those attempts',
  (await fetch(`${API}/api/documents/${doc.id}`, { headers: H(owner) }).then((r) => r.json())).visibility === 'private');

// --- owner makes it public --------------------------------------------------
const madePublic = await patchAs(owner, 'public').then((r) => r.json());
ck('owner can make it public', madePublic.visibility === 'public');
ck('stranger now sees it listed', (await listIds(stranger)).includes(doc.id));
ck(
  'stranger can now fetch it',
  (await fetch(`${API}/api/documents/${doc.id}`, { headers: H(stranger) })).status === 200,
);
ck('stranger is not marked as owner',
  (await fetch(`${API}/api/documents/${doc.id}`, { headers: H(stranger) }).then((r) => r.json())).isOwner === false);
ck('stranger can now open the websocket', await canConnect(stranger, doc.id));
ck('stranger still cannot change visibility', (await patchAs(stranger, 'private')).status === 403);

// --- public means EDIT, not just read --------------------------------------
const a = new HocuspocusProvider({ url: WS, name: `doc:${doc.id}`, document: new Y.Doc(), token: owner });
const b = new HocuspocusProvider({ url: WS, name: `doc:${doc.id}`, document: new Y.Doc(), token: stranger });
await Promise.all([
  new Promise((r) => a.on('synced', r)),
  new Promise((r) => b.on('synced', r)),
]);
b.document.getArray('blocks').push([{ id: crypto.randomUUID(), type: 'paragraph' }]);
await sleep(800);
ck('a non-owner can edit a public document (collaboration works)',
  a.document.getArray('blocks').length === b.document.getArray('blocks').length &&
  a.document.getArray('blocks').length > 1);
a.destroy();
b.destroy();

// --- back to private revokes access ----------------------------------------
await patchAs(owner, 'private');
ck('stranger loses it from their list', !(await listIds(stranger)).includes(doc.id));
ck('stranger is refused the websocket again', !(await canConnect(stranger, doc.id)));

await fetch(`${API}/api/documents/${doc.id}`, { method: 'DELETE', headers: H(owner) });
await tracker.purge();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
