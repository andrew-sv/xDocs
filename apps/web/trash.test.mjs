/**
 * Trash: listing deletion roots, restoring, and permanent deletion.
 *
 * Permanent delete is the only operation in the app that destroys data, so it
 * gets tested from both sides — that it works for the owner, and that it is
 * refused for everyone else.
 */
import { authHeaders, createDisposableUser, signInForTests } from './test-auth.mjs';

const API = 'http://localhost:3001';
let fail = 0;
const ck = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) fail++; };

const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);

const create = (token, title, parentId) =>
  fetch(`${API}/api/documents`, {
    method: 'POST', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
  }).then((r) => r.json());
const del = (token, id) => fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers: H(token) });
const trash = (token) => fetch(`${API}/api/documents/trash`, { headers: H(token) }).then((r) => r.json());
const get = (token, id) => fetch(`${API}/api/documents/${id}`, { headers: H(token) });
const listIds = (token, parent) =>
  fetch(`${API}/api/documents${parent ? `?parent=${parent}` : ''}`, { headers: H(token) })
    .then((r) => r.json()).then((rows) => (Array.isArray(rows) ? rows.map((d) => d.id) : []));

// --- a cascaded delete is ONE trash entry ----------------------------------
const parent = await create(owner, 'Trash parent');
const child = await create(owner, 'Trash child', parent.id);
const grandchild = await create(owner, 'Trash grandchild', child.id);
await del(owner, parent.id);

const entries = await trash(owner);
const entry = entries.find((e) => e.id === parent.id);
ck('the deleted parent appears in trash', Boolean(entry));
ck('its descendants are NOT separate entries', !entries.some((e) => e.id === child.id || e.id === grandchild.id));
ck('the entry counts the subtree that goes with it', entry?.descendantCount === 2);
ck('the entry records when it was deleted', typeof entry?.deletedAt === 'string');

// --- scoping ----------------------------------------------------------------
ck('a stranger does not see it in their trash', !(await trash(stranger)).some((e) => e.id === parent.id));
ck(
  'a stranger cannot permanently delete it',
  (await fetch(`${API}/api/documents/${parent.id}/permanent`, { method: 'DELETE', headers: H(stranger) })).status === 403,
);

// --- restore ---------------------------------------------------------------
await fetch(`${API}/api/documents/${parent.id}/restore`, { method: 'POST', headers: H(owner) });
ck('restoring removes it from trash', !(await trash(owner)).some((e) => e.id === parent.id));
ck('the subtree comes back too', (await get(owner, grandchild.id)).status === 200);
ck('and keeps its place in the tree', (await listIds(owner, child.id)).includes(grandchild.id));

// --- restoring a child whose parent is still deleted ------------------------
// Without reparenting this comes back somewhere unreachable: access needs the
// whole ancestor chain visible.
await del(owner, child.id);        // delete the child subtree
await del(owner, parent.id);       // then the parent, separately
await fetch(`${API}/api/documents/${child.id}/restore`, { method: 'POST', headers: H(owner) });
const restoredChild = await get(owner, child.id).then((r) => r.json());
ck('a child restored under a deleted parent is reachable', Boolean(restoredChild.id));
ck('and was lifted to the top level', restoredChild.parentId === null);
ck('so it appears in the top-level list', (await listIds(owner)).includes(child.id));

// --- permanent delete -------------------------------------------------------
await del(owner, child.id);
const before = (await trash(owner)).length;
const purge = await fetch(`${API}/api/documents/${child.id}/permanent`, { method: 'DELETE', headers: H(owner) });
ck('permanent delete succeeds for the owner', purge.status === 204);
ck('it leaves trash', (await trash(owner)).length === before - 1);
ck('the document is gone entirely', (await get(owner, child.id)).status === 404);
ck('its descendants are gone too', (await get(owner, grandchild.id)).status === 404);
// A live document must never be destroyable — only something already trashed.
const liveDoc = await create(owner, 'still alive');
ck(
  'permanently deleting a LIVE document is refused (403)',
  (await fetch(`${API}/api/documents/${liveDoc.id}/permanent`, { method: 'DELETE', headers: H(owner) })).status === 403,
);
ck('and that document is still there', (await get(owner, liveDoc.id)).status === 200);
await del(owner, liveDoc.id);

// cleanup
await fetch(`${API}/api/documents/${parent.id}/permanent`, { method: 'DELETE', headers: H(owner) });
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
