/**
 * Moving documents between parents.
 *
 * The interesting cases are the ones the UI cannot produce: cycles, moving
 * someone else's document, and moving into a destination you cannot see.
 */
import { authHeaders, createDisposableUser, signInForTests } from './test-auth.mjs';
import { trackCreatedDocuments } from './test-cleanup.mjs';

// Everything this suite creates is purged when it ends; see test-cleanup.mjs.
const tracker = trackCreatedDocuments();

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

const move = (token, id, parentId) =>
  fetch(`${API}/api/documents/${id}/parent`, {
    method: 'PATCH', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ parentId }),
  });

const listIds = (token, parent) =>
  fetch(`${API}/api/documents${parent ? `?parent=${parent}` : '?flat=1'}`, { headers: H(token) })
    .then((r) => r.json()).then((rows) => (Array.isArray(rows) ? rows.map((d) => d.id) : []));

const setVisibility = (token, id, visibility) =>
  fetch(`${API}/api/documents/${id}/visibility`, {
    method: 'PATCH', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ visibility }),
  });

// --- the ordinary move ------------------------------------------------------
const home = await create(owner, 'Move home');
const away = await create(owner, 'Move away');
const child = await create(owner, 'Move child', home.id);
const grandchild = await create(owner, 'Move grandchild', child.id);

const moved = await move(owner, child.id, away.id);
ck('a document can be reparented', moved.status === 200);
ck('the response reports the new parent', (await moved.json()).parentId === away.id);
ck('it leaves the old parent', !(await listIds(owner, home.id)).includes(child.id));
ck('it appears under the new one', (await listIds(owner, away.id)).includes(child.id));
ck('its subtree travels with it', (await listIds(owner, child.id)).includes(grandchild.id));

// --- to the top level -------------------------------------------------------
ck('it can be moved to the top level', (await move(owner, child.id, null)).status === 200);
ck(
  'and shows up in the top-level listing',
  (await fetch(`${API}/api/documents`, { headers: H(owner) }).then((r) => r.json()))
    .some((d) => d.id === child.id),
);

// --- cycles -----------------------------------------------------------------
await move(owner, child.id, home.id);
ck('a document cannot be moved into itself', (await move(owner, home.id, home.id)).status === 400);
ck('nor into its own child', (await move(owner, home.id, child.id)).status === 400);
ck('nor into its own grandchild', (await move(owner, home.id, grandchild.id)).status === 400);
ck('and the tree is unchanged after a refused move', (await listIds(owner, home.id)).includes(child.id));

// --- ownership and visibility ----------------------------------------------
await setVisibility(owner, home.id, 'public');
await setVisibility(owner, child.id, 'public');
ck(
  "a non-owner cannot move someone else's document (403)",
  (await move(stranger, child.id, null)).status === 403,
);

const strangerDoc = await create(stranger, 'Stranger private');
ck(
  'a document cannot be moved into a destination the caller cannot see',
  (await move(owner, child.id, strangerDoc.id)).status === 404,
);
ck('a move into an unknown destination is refused', (await move(owner, child.id, '00000000-0000-0000-0000-000000000000')).status === 404);

// Moving a public document under a private parent hides it from others rather
// than quietly making the parent public.
const privateParent = await create(owner, 'Private parent');
await move(owner, child.id, privateParent.id);
ck('a public document under a private parent is hidden from others', !(await listIds(stranger)).includes(child.id));
ck('but its owner still reaches it', (await fetch(`${API}/api/documents/${child.id}`, { headers: H(owner) })).status === 200);

// --- malformed --------------------------------------------------------------
ck(
  'a malformed body is a 400',
  (await fetch(`${API}/api/documents/${child.id}/parent`, {
    method: 'PATCH', headers: H(owner, { 'content-type': 'application/json' }),
    body: JSON.stringify({ parentId: 'not-a-uuid' }),
  })).status === 400,
);

// --- concurrent moves into each other (#55) ----------------------------------
// Sent together, "A under B" and "B under A" each used to pass a cycle check
// that ran before the other's write, and both landed: a loop with no top-level
// document, invisible to everyone. One pair can miss the window by luck, so
// several race at once.
const pairs = await Promise.all(
  Array.from({ length: 8 }, async (_, i) => [
    await create(owner, `Race A ${i}`),
    await create(owner, `Race B ${i}`),
  ]),
);
const raced = await Promise.all(
  pairs.map(([a, b]) => Promise.all([move(owner, a.id, b.id), move(owner, b.id, a.id)])),
);
const statuses = raced.map((pair) => pair.map((r) => r.status).sort().join(','));
ck(
  `of each racing pair exactly one move lands and the other is refused (${statuses.join(' ')})`,
  statuses.every((s) => s === '200,400'),
);
const reachable = await listIds(owner);
ck(
  'and both documents of every pair are still reachable',
  pairs.every(([a, b]) => reachable.includes(a.id) && reachable.includes(b.id)),
);

await tracker.purge();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
