/**
 * The content bridge: reading and writing block text over REST.
 *
 * The point of this suite is that REST edits go through the CRDT rather than
 * around it — an edit made over HTTP must reach a client that is connected at
 * the time, and must not be clobbered by that client's next save.
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { authHeaders, createDisposableUser, signInForTests } from './test-auth.mjs';

const API = 'http://localhost:3001';
const WS = 'ws://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ck = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) fail++; };

const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);

const create = (token, title) =>
  fetch(`${API}/api/documents`, {
    method: 'POST', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ title }),
  }).then((r) => r.json());

const getContent = (token, id) =>
  fetch(`${API}/api/documents/${id}/content`, { headers: H(token) });
const putContent = (token, id, body) =>
  fetch(`${API}/api/documents/${id}/content`, {
    method: 'PUT', headers: H(token, { 'content-type': 'application/json' }), body: JSON.stringify(body),
  });
const postContent = (token, id, body) =>
  fetch(`${API}/api/documents/${id}/content`, {
    method: 'POST', headers: H(token, { 'content-type': 'application/json' }), body: JSON.stringify(body),
  });

function connect(docId, token) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: WS, name: `doc:${docId}`, document: doc, token, onAuthenticationFailed: () => {},
  });
  return { doc, provider, synced: new Promise((res) => provider.on('synced', () => res())) };
}

const textOf = (doc) => {
  const out = [];
  for (const block of doc.getArray('blocks').toArray()) {
    const parts = [];
    const walk = (n) => {
      if (n instanceof Y.XmlText) return parts.push(n.toString());
      if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) n.toArray().forEach(walk);
    };
    walk(doc.getXmlFragment(`block-${block.id}`));
    out.push(parts.join(''));
  }
  return out;
};

// --- reading ----------------------------------------------------------------
const doc = await create(owner, 'Bridge test');
const initial = await getContent(owner, doc.id).then((r) => r.json());
ck('a new document reads back with its title', initial.title === 'Bridge test');
ck('and its seeded empty block', Array.isArray(initial.blocks) && initial.blocks.length === 1);
ck('blocks carry ids and types', typeof initial.blocks[0].id === 'string' && initial.blocks[0].type === 'paragraph');

// --- writing ----------------------------------------------------------------
const written = await putContent(owner, doc.id, { title: 'Written by API', blocks: ['First line', 'Second line'] });
ck('content can be replaced', written.status === 200);
const body = await written.json();
ck('the response reflects the new blocks', body.blocks.map((b) => b.text).join('|') === 'First line|Second line');
ck('and the new title', body.title === 'Written by API');
ck('replacing removes what was there', body.blocks.length === 2);

const appended = await postContent(owner, doc.id, { blocks: ['Third line'] }).then((r) => r.json());
ck('blocks can be appended', appended.blocks.map((b) => b.text).join('|') === 'First line|Second line|Third line');

// A block is one node, so an embedded newline becomes another block — the same
// shape typing it would have produced.
const multiline = await putContent(owner, doc.id, { blocks: ['One\nTwo'] }).then((r) => r.json());
ck('a newline splits into separate blocks', multiline.blocks.map((b) => b.text).join('|') === 'One|Two');

// --- it really goes through the CRDT ----------------------------------------
const client = connect(doc.id, owner);
await client.synced;
await sleep(300);
ck('a connected client sees the API-written text', textOf(client.doc).join('|') === 'One|Two');

await postContent(owner, doc.id, { blocks: ['Added while connected'] });
await sleep(600);
ck(
  'an API edit reaches a client that is already connected',
  textOf(client.doc).join('|') === 'One|Two|Added while connected',
);

// The client edits too; both edits must survive, which is what writing ystate
// directly would have broken.
const blockId = client.doc.getArray('blocks').get(0).id;
const fragment = client.doc.getXmlFragment(`block-${blockId}`);
const paragraph = new Y.XmlElement('paragraph');
const text = new Y.XmlText();
text.insert(0, 'Typed by a person');
paragraph.insert(0, [text]);
fragment.delete(0, fragment.length);
fragment.insert(0, [paragraph]);
await sleep(600);

const afterBoth = await getContent(owner, doc.id).then((r) => r.json());
ck('a human edit is visible over REST', afterBoth.blocks[0].text === 'Typed by a person');
ck('and the API-written blocks are still there', afterBoth.blocks.map((b) => b.text).includes('Added while connected'));

client.provider.destroy();
await sleep(3500);

// --- persistence and the search mirror --------------------------------------
const reread = await getContent(owner, doc.id).then((r) => r.json());
ck('content survives every client disconnecting', reread.blocks.map((b) => b.text).includes('Added while connected'));
const hits = await fetch(`${API}/api/documents/search?q=${encodeURIComponent('Added while connected')}`, { headers: H(owner) }).then((r) => r.json());
ck('API-written text is searchable once stored', hits.some((h) => h.document.id === doc.id));
const listed = await fetch(`${API}/api/documents`, { headers: H(owner) }).then((r) => r.json());
ck('an API-written title reaches the documents list', listed.find((d) => d.id === doc.id)?.title === 'Written by API');

// --- access -----------------------------------------------------------------
ck('a stranger cannot read a private document (404)', (await getContent(stranger, doc.id)).status === 404);
ck('a stranger cannot write to it (404)', (await putContent(stranger, doc.id, { blocks: ['nope'] })).status === 404);
ck('an unknown document is a 404', (await getContent(owner, '00000000-0000-0000-0000-000000000000')).status === 404);

// --- validation --------------------------------------------------------------
ck('a malformed body is a 400', (await putContent(owner, doc.id, { blocks: 'not an array' })).status === 400);
ck('an over-long title is a 400', (await putContent(owner, doc.id, { title: 'x'.repeat(201), blocks: [] })).status === 400);
ck('an empty block list is allowed (it empties the document)', (await putContent(owner, doc.id, { blocks: [] })).status === 200);
ck('and the document is then empty', (await getContent(owner, doc.id).then((r) => r.json())).blocks.length === 0);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
