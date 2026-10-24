/**
 * Trash: listing deletion roots, restoring, and permanent deletion.
 *
 * Permanent delete is the only operation in the app that destroys data, so it
 * gets tested from both sides — that it works for the owner, and that it is
 * refused for everyone else.
 */
import pg from 'pg';
import { check, cleanup, finish } from '@xdocs/test-support/harness';
import { authHeaders, createDisposableUser, signInForTests } from '@xdocs/test-support/auth';
import { trackCreatedDocuments } from '@xdocs/test-support/cleanup';

// Everything this suite creates is purged when it ends; see @xdocs/test-support/cleanup.
const tracker = trackCreatedDocuments();
cleanup(() => tracker.purge());

const API = 'http://localhost:3001';
const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);

const create = (token, title, parentId) =>
  fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
  }).then((r) => r.json());
const del = (token, id) =>
  fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers: H(token) });
const trash = (token) =>
  fetch(`${API}/api/documents/trash`, { headers: H(token) }).then((r) => r.json());
const get = (token, id) => fetch(`${API}/api/documents/${id}`, { headers: H(token) });
const listIds = (token, parent) =>
  fetch(`${API}/api/documents${parent ? `?parent=${parent}` : ''}`, { headers: H(token) })
    .then((r) => r.json())
    .then((rows) => (Array.isArray(rows) ? rows.map((d) => d.id) : []));

// --- a cascaded delete is ONE trash entry ----------------------------------
const parent = await create(owner, 'Trash parent');
const child = await create(owner, 'Trash child', parent.id);
const grandchild = await create(owner, 'Trash grandchild', child.id);
await del(owner, parent.id);

const entries = await trash(owner);
const entry = entries.find((e) => e.id === parent.id);
check('the deleted parent appears in trash', Boolean(entry));
check(
  'its descendants are NOT separate entries',
  !entries.some((e) => e.id === child.id || e.id === grandchild.id),
);
check('the entry counts the subtree that goes with it', entry?.descendantCount === 2);
check('the entry records when it was deleted', typeof entry?.deletedAt === 'string');

// --- scoping ----------------------------------------------------------------
check(
  'a stranger does not see it in their trash',
  !(await trash(stranger)).some((e) => e.id === parent.id),
);
check(
  'a stranger cannot permanently delete it',
  (
    await fetch(`${API}/api/documents/${parent.id}/permanent`, {
      method: 'DELETE',
      headers: H(stranger),
    })
  ).status === 403,
);

// --- restore ---------------------------------------------------------------
await fetch(`${API}/api/documents/${parent.id}/restore`, { method: 'POST', headers: H(owner) });
check('restoring removes it from trash', !(await trash(owner)).some((e) => e.id === parent.id));
check('the subtree comes back too', (await get(owner, grandchild.id)).status === 200);
check('and keeps its place in the tree', (await listIds(owner, child.id)).includes(grandchild.id));

// --- restoring a child whose parent is still deleted ------------------------
// Without reparenting this comes back somewhere unreachable: access needs the
// whole ancestor chain visible.
await del(owner, child.id); // delete the child subtree
await del(owner, parent.id); // then the parent, separately
await fetch(`${API}/api/documents/${child.id}/restore`, { method: 'POST', headers: H(owner) });
const restoredChild = await get(owner, child.id).then((r) => r.json());
check('a child restored under a deleted parent is reachable', Boolean(restoredChild.id));
check('and was lifted to the top level', restoredChild.parentId === null);
check('so it appears in the top-level list', (await listIds(owner)).includes(child.id));

// --- permanent delete -------------------------------------------------------
await del(owner, child.id);
check(
  'the trashed document is in trash to begin with',
  (await trash(owner)).some((e) => e.id === child.id),
);
const purge = await fetch(`${API}/api/documents/${child.id}/permanent`, {
  method: 'DELETE',
  headers: H(owner),
});
check('permanent delete succeeds for the owner', purge.status === 204);
// By id, not by counting: trash is scoped to the account, which other suites
// running beside this one share.
check('it leaves trash', !(await trash(owner)).some((e) => e.id === child.id));
check('the document is gone entirely', (await get(owner, child.id)).status === 404);
check('its descendants are gone too', (await get(owner, grandchild.id)).status === 404);
// A live document must never be destroyable — only something already trashed.
const liveDoc = await create(owner, 'still alive');
check(
  'permanently deleting a LIVE document is refused (403)',
  (
    await fetch(`${API}/api/documents/${liveDoc.id}/permanent`, {
      method: 'DELETE',
      headers: H(owner),
    })
  ).status === 403,
);
check('and that document is still there', (await get(owner, liveDoc.id)).status === 200);
await del(owner, liveDoc.id);

// --- a delete stops at what the deleter cannot reach (#87) ------------------
// The owner's public parent holds the owner's own child and a stranger's
// PRIVATE child (with a grandchild). The stranger can add it because the
// parent is public; the child copies that, then the stranger makes it private.
const setVisibility = (token, id, visibility) =>
  fetch(`${API}/api/documents/${id}/visibility`, {
    method: 'PATCH',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ visibility }),
  });
const shared = await create(owner, 'Hidden-child parent');
await setVisibility(owner, shared.id, 'public');
const ownChild = await create(owner, 'Owner child', shared.id);
const hidden = await create(stranger, 'Stranger private child', shared.id);
const hiddenUnder = await create(stranger, 'Stranger grandchild', hidden.id);
await setVisibility(stranger, hidden.id, 'private');
check(
  'setup: the owner cannot see the stranger child',
  (await get(owner, hidden.id)).status === 404,
);

await del(owner, shared.id);
const sharedEntry = (await trash(owner)).find((e) => e.id === shared.id);
check('the parent is in the trash', Boolean(sharedEntry));
check('its trash entry counts only the owner child', sharedEntry?.descendantCount === 1);
check('the owner child went with it', (await get(owner, ownChild.id)).status === 404);
const hiddenAfter = await get(stranger, hidden.id);
check('the stranger child was NOT trashed', hiddenAfter.status === 200);
check('it moved to the top level', (await hiddenAfter.json()).parentId === null);
check('it is in the stranger top-level list', (await listIds(stranger)).includes(hidden.id));
const hiddenUnderAfter = await get(stranger, hiddenUnder.id);
check('its grandchild is live', hiddenUnderAfter.status === 200);
check('and still under it', (await hiddenUnderAfter.json()).parentId === hidden.id);
check('the owner still cannot see it', (await get(owner, hidden.id)).status === 404);
check(
  'it is in nobody trash',
  !(await trash(owner)).some((e) => e.id === hidden.id) &&
    !(await trash(stranger)).some((e) => e.id === hidden.id),
);

await fetch(`${API}/api/documents/${shared.id}/restore`, { method: 'POST', headers: H(owner) });
check('restoring brings the owner child back', (await get(owner, ownChild.id)).status === 200);
check('under its parent', (await listIds(owner, shared.id)).includes(ownChild.id));
check(
  'the stranger child stays at the top level',
  (await get(stranger, hidden.id).then((r) => r.json())).parentId === null,
);
check(
  'and is not back under the parent',
  !(await listIds(stranger, shared.id)).includes(hidden.id),
);

await del(owner, shared.id);
const purgeShared = await fetch(`${API}/api/documents/${shared.id}/permanent`, {
  method: 'DELETE',
  headers: H(owner),
});
check('purging the parent succeeds', purgeShared.status === 204);
check('and takes the owner child', (await get(owner, ownChild.id)).status === 404);
check(
  'but not the stranger child or its grandchild',
  (await get(stranger, hidden.id)).status === 200 &&
    (await get(stranger, hiddenUnder.id)).status === 200,
);

// --- purging trash from before #87 spares what the purger cannot reach -------
// A delete used to trash the whole subtree, so existing trash can hold a
// stranger's private document. No route makes that state any more, so it is
// built with SQL: the delete above's outcome, rewound to what it used to be.
if (!process.env.DATABASE_URL) process.loadEnvFile(new URL('../../../.env.local', import.meta.url));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
cleanup(() => db.end());

const legacy = await create(owner, 'Legacy trash parent');
await setVisibility(owner, legacy.id, 'public');
const legacyHidden = await create(stranger, 'Legacy stranger child', legacy.id);
const legacyUnder = await create(stranger, 'Legacy stranger grandchild', legacyHidden.id);
await setVisibility(stranger, legacyHidden.id, 'private');
await del(owner, legacy.id);
await db.query(
  `UPDATE documents
      SET deleted_at = (SELECT deleted_at FROM documents WHERE id = $1),
          parent_id = CASE WHEN id = $2 THEN $1::uuid ELSE parent_id END
    WHERE id IN ($2, $3)`,
  [legacy.id, legacyHidden.id, legacyUnder.id],
);
const parentOf = async (id) =>
  (await db.query('SELECT parent_id FROM documents WHERE id = $1', [id])).rows[0];
check(
  'setup: the stranger child is trashed under the parent',
  (await parentOf(legacyHidden.id))?.parent_id === legacy.id,
);

const legacyPurge = await fetch(`${API}/api/documents/${legacy.id}/permanent`, {
  method: 'DELETE',
  headers: H(owner),
});
check('purging old trash succeeds', legacyPurge.status === 204);
check('and destroys the parent', (await parentOf(legacy.id)) === undefined);
const spared = await parentOf(legacyHidden.id);
check('but spares the stranger child', spared !== undefined);
check('moving it to the top level', spared?.parent_id === null);
check(
  'with its grandchild still under it',
  (await parentOf(legacyUnder.id))?.parent_id === legacyHidden.id,
);
const legacyEntry = (await trash(stranger)).find((e) => e.id === legacyHidden.id);
check('it is in its owner trash, with the grandchild', legacyEntry?.descendantCount === 1);
await fetch(`${API}/api/documents/${legacyHidden.id}/restore`, {
  method: 'POST',
  headers: H(stranger),
});
check(
  'from which its owner can restore both',
  (await get(stranger, legacyHidden.id)).status === 200 &&
    (await get(stranger, legacyUnder.id)).status === 200,
);
await db.end();

// cleanup
await fetch(`${API}/api/documents/${parent.id}/permanent`, { method: 'DELETE', headers: H(owner) });
await finish();
