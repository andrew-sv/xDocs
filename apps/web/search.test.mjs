/**
 * Search: full-text over titles and mirrored block text.
 *
 * The interesting parts are not "does it find the word" but: does the mirror
 * actually get written by the collab store hook, and does a search respect the
 * ancestor-gated visibility rule — a search that ignored it would be a read
 * hole straight through private documents.
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
const ck = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) fail++; };

const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);

const create = (token, title, parentId) =>
  fetch(`${API}/api/documents`, {
    method: 'POST', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
  }).then((r) => r.json());

const search = (token, q) =>
  fetch(`${API}/api/documents/search?q=${encodeURIComponent(q)}`, { headers: H(token) })
    .then((r) => r.json());

const setVisibility = (token, id, visibility) =>
  fetch(`${API}/api/documents/${id}/visibility`, {
    method: 'PATCH', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ visibility }),
  });

/** Write one paragraph into a block, the way TipTap does, and let it persist. */
async function writeBody(docId, text) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: WS, name: `doc:${docId}`, document: doc, token: owner, onAuthenticationFailed: () => {},
  });
  await new Promise((res) => provider.on('synced', () => res()));
  await sleep(300);
  const blockId = doc.getArray('blocks').get(0).id;
  const fragment = doc.getXmlFragment(`block-${blockId}`);
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  fragment.insert(fragment.length, [p]);
  await sleep(400);
  provider.destroy();
  // Nothing is searchable until the store hook mirrors the block text into
  // `content_text`, so make that happen rather than waiting out its debounce.
  await flushStore(API, H(owner), docId);
}

// A nonsense word, so a match proves this document was found and not another.
const NEEDLE = `zorblat${Date.now()}`;

// --- title search -----------------------------------------------------------
const titled = await create(owner, `Quarterly ${NEEDLE} report`);
let hits = await search(owner, NEEDLE);
ck('a title match is found', hits.some((h) => h.document.id === titled.id));
ck('the hit carries the full document', hits[0]?.document?.visibility === 'private');

// --- prefix matching, so results narrow as you type -------------------------
hits = await search(owner, NEEDLE.slice(0, 10));
ck('a partial word still matches (prefix search)', hits.some((h) => h.document.id === titled.id));

// --- body search ------------------------------------------------------------
const bodied = await create(owner, 'Ordinary title');
await writeBody(bodied.id, `The minutes mention ${NEEDLE} exactly once.`);
hits = await search(owner, NEEDLE);
const bodyHit = hits.find((h) => h.document.id === bodied.id);
ck('block text is searchable once the CRDT has been stored', Boolean(bodyHit));
ck('the snippet quotes the surrounding text', (bodyHit?.snippet ?? '').includes('minutes'));
ck('the snippet marks the match for highlighting', (bodyHit?.snippet ?? '').includes('[['));

// --- ranking ----------------------------------------------------------------
ck(
  'a title match outranks a body match',
  hits.findIndex((h) => h.document.id === titled.id) < hits.findIndex((h) => h.document.id === bodied.id),
);

// --- the path, so a buried result says where it lives -----------------------
const parent = await create(owner, `Folder ${NEEDLE}-parent`);
const child = await create(owner, `Child ${NEEDLE}-deep`, parent.id);
hits = await search(owner, `${NEEDLE}`);
const childHit = hits.find((h) => h.document.id === child.id);
ck('a nested result is found', Boolean(childHit));
ck('it carries its ancestor path', childHit?.path?.length === 1 && childHit.path[0].id === parent.id);
ck('the path is ordered root first', (hits.find((h) => h.document.id === parent.id)?.path ?? []).length === 0);

// --- visibility: the load-bearing part --------------------------------------
ck('a stranger cannot find a private document', !(await search(stranger, NEEDLE)).some((h) => h.document.id === titled.id));

await setVisibility(owner, titled.id, 'public');
ck('made public, a stranger can find it', (await search(stranger, NEEDLE)).some((h) => h.document.id === titled.id));

// A public child under a private parent must stay unreachable — the same
// ancestor gate the listing and the collab handshake use.
await setVisibility(owner, child.id, 'public');
ck(
  'a public child of a private parent is NOT findable',
  !(await search(stranger, NEEDLE)).some((h) => h.document.id === child.id),
);

// --- deleted documents drop out ---------------------------------------------
await fetch(`${API}/api/documents/${titled.id}`, { method: 'DELETE', headers: H(owner) });
ck('a deleted document leaves the index', !(await search(owner, NEEDLE)).some((h) => h.document.id === titled.id));

// --- degenerate queries -----------------------------------------------------
ck('an empty query returns nothing rather than everything', (await search(owner, '')).length === 0);
ck('a punctuation-only query is empty, not an error', (await search(owner, '  ??? ')).length === 0);
ck('an unmatched word returns no hits', (await search(owner, 'qqzzxx' + Date.now())).length === 0);

await tracker.purge();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
