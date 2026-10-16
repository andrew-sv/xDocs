/**
 * Nested documents: the ancestor-gated access rule is the whole security
 * boundary here, so it gets tested directly and with a second user — a
 * single-user test cannot tell "enforced" from "not implemented".
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
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);

const create = (token, title, parentId) =>
  fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
  }).then((r) => r.json());

const setVisibility = (token, id, visibility) =>
  fetch(`${API}/api/documents/${id}/visibility`, {
    method: 'PATCH',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ visibility }),
  });

const listIds = (token, parent) =>
  fetch(`${API}/api/documents${parent ? `?parent=${parent}` : ''}`, { headers: H(token) })
    .then((r) => r.json())
    .then((rows) => (Array.isArray(rows) ? rows.map((d) => d.id) : []));

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

// --- structure ---------------------------------------------------------------
const parent = await create(owner, 'Parent');
ck('a new top-level document has no parent', parent.parentId === null);
ck('and reports no children yet', parent.hasChildren === false);

const child = await create(owner, 'Child', parent.id);
ck('a sub-document records its parent', child.parentId === parent.id);
ck('a child inherits the parent visibility (private)', child.visibility === 'private');

ck('child is not in the top-level listing', !(await listIds(owner)).includes(child.id));
ck('child IS in the parent listing', (await listIds(owner, parent.id)).includes(child.id));
const [parentRow] = (
  await fetch(`${API}/api/documents`, { headers: H(owner) }).then((r) => r.json())
).filter((d) => d.id === parent.id);
ck('parent now reports hasChildren', parentRow?.hasChildren === true);

// --- inheritance is a copy, not a live link ---------------------------------
await setVisibility(owner, parent.id, 'public');
const childAfter = await fetch(`${API}/api/documents/${child.id}`, { headers: H(owner) }).then(
  (r) => r.json(),
);
ck('changing the parent does NOT change existing children', childAfter.visibility === 'private');
const child2 = await create(owner, 'Child2', parent.id);
ck('a NEW child inherits the parent current visibility (public)', child2.visibility === 'public');

// --- ancestor gating: the security boundary ---------------------------------
ck('stranger sees the public parent', (await listIds(stranger)).includes(parent.id));
ck('stranger sees the public child', (await listIds(stranger, parent.id)).includes(child2.id));
ck('stranger can open the public child socket', await canConnect(stranger, child2.id));
ck(
  'stranger does NOT see the private child',
  !(await listIds(stranger, parent.id)).includes(child.id),
);

// The critical case: a PUBLIC document beneath a PRIVATE parent.
await setVisibility(owner, parent.id, 'private');
ck(
  'public child under a private parent is not listed',
  !(await listIds(stranger, parent.id)).includes(child2.id),
);
ck(
  'public child under a private parent 404s by id',
  (await fetch(`${API}/api/documents/${child2.id}`, { headers: H(stranger) })).status === 404,
);
ck(
  'public child under a private parent is REFUSED on the websocket',
  !(await canConnect(stranger, child2.id)),
);
ck('the owner can still reach it', await canConnect(owner, child2.id));

// --- grafting onto someone else's tree --------------------------------------
const forged = await fetch(`${API}/api/documents`, {
  method: 'POST',
  headers: H(stranger, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'graft', parentId: parent.id }),
});
ck('stranger cannot create a child under an invisible parent', forged.status === 404);

// --- cascade delete and restore ---------------------------------------------
const grandchild = await create(owner, 'Grandchild', child.id);
await fetch(`${API}/api/documents/${parent.id}`, { method: 'DELETE', headers: H(owner) });
ck('deleting the parent removes it', !(await listIds(owner)).includes(parent.id));
ck(
  'the whole subtree goes with it',
  (await fetch(`${API}/api/documents/${grandchild.id}`, { headers: H(owner) })).status === 404,
);

await fetch(`${API}/api/documents/${parent.id}/restore`, { method: 'POST', headers: H(owner) });
ck('restoring brings the parent back', (await listIds(owner)).includes(parent.id));
ck(
  'and the whole subtree with it',
  (await fetch(`${API}/api/documents/${grandchild.id}`, { headers: H(owner) })).status === 200,
);
ck(
  'descendants keep their place in the tree',
  (await listIds(owner, child.id)).includes(grandchild.id),
);

// --- the path to a document ---------------------------------------------------
const pathOf = (token, id) => fetch(`${API}/api/documents/${id}/path`, { headers: H(token) });
const titles = async (res) => (await res.json()).map((d) => d.title);

ck(
  "a nested document's path is its ancestors, root first",
  JSON.stringify(await titles(await pathOf(owner, grandchild.id))) ===
    JSON.stringify(['Parent', 'Child']),
);
ck(
  "a top-level document's path is empty",
  JSON.stringify(await titles(await pathOf(owner, parent.id))) === '[]',
);
ck(
  'ancestors carry full metadata, marked as having children',
  (await pathOf(owner, grandchild.id).then((r) => r.json())).every(
    (d) => d.id && d.hasChildren === true,
  ),
);
ck('a malformed id is a 404, not a 500', (await pathOf(owner, 'not-a-uuid')).status === 404);

// Ancestor gating: a public child under a private parent is unreachable, and
// its path must not be a way to learn the parent's title.
const secretParent = await create(owner, 'Secret parent');
const publicChild = await create(owner, 'Public child', secretParent.id);
await setVisibility(owner, publicChild.id, 'public');
ck(
  'a stranger cannot read the path of a document under a private parent (404)',
  (await pathOf(stranger, publicChild.id)).status === 404,
);
await setVisibility(owner, secretParent.id, 'public');
ck(
  'once the whole chain is public, the stranger gets the path',
  JSON.stringify(await titles(await pathOf(stranger, publicChild.id))) ===
    JSON.stringify(['Secret parent']),
);

/*
 * Gating is by EVERY ancestor, not just the parent (#62).
 *
 * Access walks up from the document, so a walk that stopped one level short —
 * checking the parent but not the grandparent — would pass every check above,
 * where the private node is always the direct parent. Here it is two levels up,
 * then in the middle.
 */
const root = await create(owner, 'Deep root');
const mid = await create(owner, 'Deep mid', root.id);
const leaf = await create(owner, 'Deep leaf', mid.id);
await setVisibility(owner, mid.id, 'public');
await setVisibility(owner, leaf.id, 'public');
const fetchAs = (token, id) => fetch(`${API}/api/documents/${id}`, { headers: H(token) });

ck(
  'public leaf under public mid under PRIVATE root 404s by id',
  (await fetchAs(stranger, leaf.id)).status === 404,
);
ck('and is refused on the websocket', !(await canConnect(stranger, leaf.id)));
ck(
  'and the public mid level lists nothing for the stranger',
  (await listIds(stranger, mid.id)).length === 0,
);
ck('the owner still reaches the leaf', (await fetchAs(owner, leaf.id)).status === 200);
ck('and sees it listed under mid', (await listIds(owner, mid.id)).includes(leaf.id));

await setVisibility(owner, root.id, 'public');
ck(
  'once the root is public, the stranger reaches the leaf',
  (await fetchAs(stranger, leaf.id)).status === 200,
);
ck('and sees it listed under mid', (await listIds(stranger, mid.id)).includes(leaf.id));
ck('and may open its websocket', await canConnect(stranger, leaf.id));

await setVisibility(owner, mid.id, 'private');
ck(
  'a private MIDDLE ancestor hides the leaf again',
  (await fetchAs(stranger, leaf.id)).status === 404,
);
ck('mid is not listed under the public root', !(await listIds(stranger, root.id)).includes(mid.id));
ck('and its level lists nothing', (await listIds(stranger, mid.id)).length === 0);
ck('the websocket is refused again', !(await canConnect(stranger, leaf.id)));

const malformed = await fetch(`${API}/api/documents?parent=not-a-uuid`, { headers: H(owner) });
ck(
  'a malformed ?parent= lists nothing rather than failing',
  malformed.status === 200 && (await malformed.json()).length === 0,
);

await fetch(`${API}/api/documents/${root.id}`, { method: 'DELETE', headers: H(owner) });
ck('a deleted root takes its leaf out of reach', (await fetchAs(owner, leaf.id)).status === 404);

await fetch(`${API}/api/documents/${parent.id}`, { method: 'DELETE', headers: H(owner) });
ck('a deleted document has no path (404)', (await pathOf(owner, grandchild.id)).status === 404);
await tracker.purge();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
