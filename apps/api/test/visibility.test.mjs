/**
 * Visibility: private is owner-only, public is open to any signed-in user.
 *
 * Everything here needs TWO users — a single-user test cannot tell "enforced"
 * from "not implemented". The websocket assertions matter most: block content
 * never travels over HTTP, so REST checks alone would prove very little.
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { check, cleanup, finish } from '@xdocs/test-support/harness';
import { authHeaders, createDisposableUser, signInForTests } from '@xdocs/test-support/auth';
import { trackCreatedDocuments } from '@xdocs/test-support/cleanup';

// Everything this suite creates is purged when it ends; see @xdocs/test-support/cleanup.
const tracker = trackCreatedDocuments();
cleanup(() => tracker.purge());

const API = 'http://localhost:3001';
const WS = 'ws://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);

/** Can this token reach the document over the websocket? */
async function canConnect(token, id) {
  const provider = new HocuspocusProvider({
    url: WS,
    name: `doc:${id}`,
    document: new Y.Doc(),
    token,
    onAuthenticationFailed: () => {},
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
  method: 'POST',
  headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'visibility test' }),
}).then((r) => r.json());

check('a new document defaults to private', doc.visibility === 'private');
check('the creator is the owner', doc.isOwner === true);
check('owner sees it in their list', (await listIds(owner)).includes(doc.id));
check('stranger does NOT see it in their list', !(await listIds(stranger)).includes(doc.id));
check(
  'stranger gets 404 fetching it directly',
  (await fetch(`${API}/api/documents/${doc.id}`, { headers: H(stranger) })).status === 404,
);
check('owner can open the websocket', await canConnect(owner, doc.id));
check('stranger CANNOT open the websocket', !(await canConnect(stranger, doc.id)));

// --- a stranger cannot administer someone else's document ------------------
const patchAs = (token, visibility) =>
  fetch(`${API}/api/documents/${doc.id}/visibility`, {
    method: 'PATCH',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ visibility }),
  });
check(
  'stranger cannot change visibility (403)',
  (await patchAs(stranger, 'public')).status === 403,
);
check(
  'stranger cannot delete (403)',
  (await fetch(`${API}/api/documents/${doc.id}`, { method: 'DELETE', headers: H(stranger) }))
    .status === 403,
);
check(
  'document is still private after those attempts',
  (await fetch(`${API}/api/documents/${doc.id}`, { headers: H(owner) }).then((r) => r.json()))
    .visibility === 'private',
);

/*
 * An owner-only refusal must NOT carry the code that ends a session (#31).
 *
 * The web client signs out on `account_not_allowed` and on nothing else, so a
 * route that answered 403 with that code — or that the client read as one —
 * would log the user out for doing something as ordinary as clicking delete on
 * a document they do not own.
 */
const refusal = await fetch(`${API}/api/documents/${doc.id}`, {
  method: 'DELETE',
  headers: H(stranger),
}).then((r) => r.json());
check('the refusal carries no account_not_allowed code', refusal.code === undefined);
check(
  'and explains itself in words',
  typeof refusal.error === 'string' && refusal.error.length > 0,
);

// --- owner makes it public --------------------------------------------------
const madePublic = await patchAs(owner, 'public').then((r) => r.json());
check('owner can make it public', madePublic.visibility === 'public');
check('stranger now sees it listed', (await listIds(stranger)).includes(doc.id));
check(
  'stranger can now fetch it',
  (await fetch(`${API}/api/documents/${doc.id}`, { headers: H(stranger) })).status === 200,
);
check(
  'stranger is not marked as owner',
  (await fetch(`${API}/api/documents/${doc.id}`, { headers: H(stranger) }).then((r) => r.json()))
    .isOwner === false,
);
check('stranger can now open the websocket', await canConnect(stranger, doc.id));
check(
  'stranger still cannot change visibility',
  (await patchAs(stranger, 'private')).status === 403,
);

// --- public means EDIT, not just read --------------------------------------
const a = new HocuspocusProvider({
  url: WS,
  name: `doc:${doc.id}`,
  document: new Y.Doc(),
  token: owner,
});
const b = new HocuspocusProvider({
  url: WS,
  name: `doc:${doc.id}`,
  document: new Y.Doc(),
  token: stranger,
});
await Promise.all([new Promise((r) => a.on('synced', r)), new Promise((r) => b.on('synced', r))]);
b.document.getArray('blocks').push([{ id: crypto.randomUUID(), type: 'paragraph' }]);
await sleep(800);
check(
  'a non-owner can edit a public document (collaboration works)',
  a.document.getArray('blocks').length === b.document.getArray('blocks').length &&
    a.document.getArray('blocks').length > 1,
);
a.destroy();
b.destroy();

// --- back to private revokes access ----------------------------------------
await patchAs(owner, 'private');
check('stranger loses it from their list', !(await listIds(stranger)).includes(doc.id));
check('stranger is refused the websocket again', !(await canConnect(stranger, doc.id)));

/*
 * hasChildren counts only children the caller can reach (#82). Counting any
 * live child gave a stranger an expand arrow on a public document whose
 * children were all private — opening onto nothing, and confirming private
 * documents sat beneath it.
 */
const post = (body) =>
  fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H(owner, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }).then((r) => r.json());
const setVisibility = (id, visibility) =>
  fetch(`${API}/api/documents/${id}/visibility`, {
    method: 'PATCH',
    headers: H(owner, { 'content-type': 'application/json' }),
    body: JSON.stringify({ visibility }),
  });

// A unique word, so search finds this parent and nothing another suite made.
const marker = `haschildren${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const parent = await post({ title: `parent ${marker}` });
await setVisibility(parent.id, 'public');
// A new child copies its parent's visibility, so make this one private by hand.
const hidden = await post({ title: 'private child', parentId: parent.id });
await setVisibility(hidden.id, 'private');

/** The parent's hasChildren, as each route that returns it reports it. */
const reported = async (token) => {
  const get = (path) =>
    fetch(`${API}/api/documents${path}`, { headers: H(token) }).then((r) => r.json());
  const [level, flat, one, found] = await Promise.all([
    get(''),
    get('?flat=1'),
    get(`/${parent.id}`),
    get(`/search?q=${marker}`),
  ]);
  return {
    level: level.find((d) => d.id === parent.id)?.hasChildren,
    flat: flat.find((d) => d.id === parent.id)?.hasChildren,
    get: one.hasChildren,
    search: found.find((r) => r.document.id === parent.id)?.document.hasChildren,
  };
};
const ROUTES = ['level', 'flat', 'get', 'search'];

const ownerOnlyPrivate = await reported(owner);
const strangerOnlyPrivate = await reported(stranger);
for (const route of ROUTES) {
  check(
    `only a private child: owner sees hasChildren (${route})`,
    ownerOnlyPrivate[route] === true,
  );
  check(
    `only a private child: stranger does NOT see hasChildren (${route})`,
    strangerOnlyPrivate[route] === false,
  );
}

const shown = await post({ title: 'public child', parentId: parent.id });
check('the second child inherits public', shown.visibility === 'public');
const strangerWithPublic = await reported(stranger);
for (const route of ROUTES) {
  check(
    `with a public child: stranger sees hasChildren (${route})`,
    strangerWithPublic[route] === true,
  );
}

await fetch(`${API}/api/documents/${doc.id}`, { method: 'DELETE', headers: H(owner) });
await finish();
