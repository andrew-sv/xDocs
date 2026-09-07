import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { resolveMove, applyMove } from './src/lib/reorder.ts';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

const API = 'http://localhost:3001';
const WS = 'ws://localhost:3001';
const BLOCKS_KEY = 'blocks';
const TITLE_KEY = 'title';
const frag = (id) => `block-${id}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

function connect(docId) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: WS, name: `doc:${docId}`, document: doc });
  const synced = new Promise((res) => provider.on('synced', () => res()));
  return { doc, provider, synced };
}

/** Mimic what TipTap writes into a block fragment: <paragraph>text</paragraph> */
function writeParagraph(doc, blockId, text) {
  const fragment = doc.getXmlFragment(frag(blockId));
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  fragment.insert(fragment.length, [p]);
}

function readText(doc, blockId) {
  const out = [];
  const walk = (n) => {
    if (n instanceof Y.XmlText) return out.push(n.toString());
    if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) n.toArray().forEach(walk);
  };
  walk(doc.getXmlFragment(frag(blockId)));
  return out.join('');
}

// 1. Create document over REST
const created = await fetch(`${API}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Untitled' }),
}).then((r) => r.json());
check('REST creates document', typeof created.id === 'string');
const id = created.id;

// 2. Client A connects; the document is seeded server-side with one block
const A = connect(id);
await A.synced;
await sleep(400);
const seeded = A.doc.getArray(BLOCKS_KEY).toArray();
check('new document is seeded with exactly one block', seeded.length === 1);
const b1 = seeded[0]?.id;

// 3. A titles the document and types into the seeded block
check('new document is seeded with the requested title', A.doc.getText(TITLE_KEY).toString() === 'Untitled');
// The title is already in the CRDT, so renaming REPLACES it — the same thing
// applyTextEdit does in the app when you select all and retype.
const titleA = A.doc.getText(TITLE_KEY);
titleA.delete(0, titleA.length);
titleA.insert(0, 'Quarterly notes');
writeParagraph(A.doc, b1, 'Hello from the first block');
const b2 = crypto.randomUUID();
A.doc.getArray(BLOCKS_KEY).push([{ id: b2, type: 'paragraph' }]);
writeParagraph(A.doc, b2, 'Second block text');
await sleep(600);

// 4. Client B sees A's work, then edits concurrently
const B = connect(id);
await B.synced;
await sleep(600);
check('client B sees both blocks', B.doc.getArray(BLOCKS_KEY).length === 2);
check('client B sees block 1 text', readText(B.doc, b1) === 'Hello from the first block');
check('client B sees the title', B.doc.getText(TITLE_KEY).toString() === 'Quarterly notes');

// Title edits are collaborative too: B renames, A must see it.
B.doc.getText(TITLE_KEY).insert(15, ' 2026');
await sleep(600);
check('A receives B\'s title edit', A.doc.getText(TITLE_KEY).toString() === 'Quarterly notes 2026');

const b3 = crypto.randomUUID();
B.doc.getArray(BLOCKS_KEY).push([{ id: b3, type: 'paragraph' }]);
writeParagraph(B.doc, b3, 'Added by B');
await sleep(700);
check("A receives B's new block", A.doc.getArray(BLOCKS_KEY).length === 3);
check("A receives B's text", readText(A.doc, b3) === 'Added by B');

// 4b. A reorders: drag the last block to the top. B must see the new order.
const orderBefore = A.doc.getArray(BLOCKS_KEY).toArray().map((b) => b.id);
const mv = resolveMove(A.doc.getArray(BLOCKS_KEY).toArray(), b3, b1, 'above');
applyMove(A.doc.getArray(BLOCKS_KEY), mv.from, mv.to);
await sleep(700);
const orderAfter = A.doc.getArray(BLOCKS_KEY).toArray().map((b) => b.id);
check('reorder moves block to the front', orderAfter.join() === [b3, b1, b2].join());
check('reorder preserves every block', [...orderAfter].sort().join() === [...orderBefore].sort().join());
check('B sees the reorder', B.doc.getArray(BLOCKS_KEY).toArray().map((b) => b.id).join() === orderAfter.join());
check('reordered block keeps its text', readText(B.doc, b3) === 'Added by B');

// 4c. Undo. Built exactly as the app builds it, including trackedOrigins.
const undoA = new Y.UndoManager([A.doc.getArray(BLOCKS_KEY), A.doc.getText(TITLE_KEY)], {
  trackedOrigins: new Set([null, ySyncPluginKey]),
});
for (const b of A.doc.getArray(BLOCKS_KEY).toArray()) {
  undoA.addToScope([A.doc.getXmlFragment(frag(b.id))]);
}

// B edits concurrently; A's undo must not touch this.
writeParagraph(B.doc, b2, 'edit by B');
await sleep(700);

const orderBeforeDelete = A.doc.getArray(BLOCKS_KEY).toArray().map((b) => b.id);
const deleteAt = orderBeforeDelete.indexOf(b1);
A.doc.getArray(BLOCKS_KEY).delete(deleteAt, 1);
await sleep(400);
check('deleting a block removes it', A.doc.getArray(BLOCKS_KEY).length === 2);
check('B sees the deletion', B.doc.getArray(BLOCKS_KEY).length === 2);

undoA.undo();
await sleep(700);
const restored = A.doc.getArray(BLOCKS_KEY).toArray().map((b) => b.id);
check('undo restores the deleted block', restored.join() === orderBeforeDelete.join());
check('undo restores it at its original index', restored[deleteAt] === b1);
check('undo restores the block text', readText(A.doc, b1) === 'Hello from the first block');
check("undo leaves B's concurrent edit alone", readText(A.doc, b2).includes('edit by B'));
check('B sees the restored block', B.doc.getArray(BLOCKS_KEY).length === 3);

// Redo must put it back again.
undoA.redo();
await sleep(500);
check('redo re-deletes the block', A.doc.getArray(BLOCKS_KEY).length === 2);
undoA.undo();
await sleep(600);
check('undo after redo restores again', A.doc.getArray(BLOCKS_KEY).length === 3);
undoA.destroy();

// 5. Disconnect everything, let Hocuspocus flush to Postgres
A.provider.destroy(); B.provider.destroy();
await sleep(3500);

// 6. Fresh client loads purely from Postgres
const C = connect(id);
await C.synced;
await sleep(600);
check('persisted: block count restored', C.doc.getArray(BLOCKS_KEY).length === 3);
check('persisted: block 1 text restored', readText(C.doc, b1) === 'Hello from the first block');
check('persisted: block 3 text restored', readText(C.doc, b3) === 'Added by B');
check(
  'persisted: block order restored',
  C.doc.getArray(BLOCKS_KEY).toArray().map((b) => b.id).join() === [b3, b1, b2].join(),
);
const C2Title = C.doc.getText(TITLE_KEY).toString();
C.provider.destroy();

// 7. Title persisted to the column and served over REST
const list = await fetch(`${API}/api/documents`).then((r) => r.json());
const row = list.find((d) => d.id === id);
check('persisted: title restored in CRDT', C2Title === 'Quarterly notes 2026');
check('title mirrored to the documents.title column', row?.title === 'Quarterly notes 2026');
check('REST never returns ystate', row && !('ystate' in row));

// 8. Unknown document is rejected by the collab server
const bogus = connect('00000000-0000-0000-0000-000000000000');
const rejected = await Promise.race([
  new Promise((res) => bogus.provider.on('authenticationFailed', () => res(true))),
  new Promise((res) => bogus.provider.on('close', () => res(true))),
  bogus.synced.then(() => false),
  sleep(4000).then(() => 'timeout'),
]);
check('unknown document rejected', rejected === true);
bogus.provider.destroy();

// 9. Document deletion is a soft delete, and is undoable.
await fetch(`${API}/api/documents/${id}`, { method: 'DELETE' });
const after = await fetch(`${API}/api/documents`).then((r) => r.json());
check('delete removes document from the list', !after.some((d) => d.id === id));
check(
  'deleted document 404s',
  (await fetch(`${API}/api/documents/${id}`)).status === 404,
);

// A deleted document must not be editable until it comes back.
const whileDeleted = connect(id);
const blocked = await Promise.race([
  // The server rejects with authenticationFailed/permission-denied; 'close'
  // alone never fires, so watching only for that would miss the rejection.
  new Promise((res) => whileDeleted.provider.on('authenticationFailed', () => res(true))),
  new Promise((res) => whileDeleted.provider.on('close', () => res(true))),
  whileDeleted.synced.then(() => false),
  sleep(4000).then(() => 'timeout'),
]);
check('collab refuses a deleted document', blocked === true);
whileDeleted.provider.destroy();

const restoredDoc = await fetch(`${API}/api/documents/${id}/restore`, { method: 'POST' })
  .then((r) => r.json());
check('restore returns the same document id', restoredDoc.id === id);
check('restore keeps the title', restoredDoc.title === 'Quarterly notes 2026');

const backInList = await fetch(`${API}/api/documents`).then((r) => r.json());
check('restored document is listed again', backInList.some((d) => d.id === id));

// The whole point of the soft delete: the Yjs state came back with it.
const D = connect(id);
await D.synced;
await sleep(600);
check('restored document keeps its blocks', D.doc.getArray(BLOCKS_KEY).length === 3);
check(
  'restored document keeps its block order',
  D.doc.getArray(BLOCKS_KEY).toArray().map((b) => b.id).join() === [b3, b1, b2].join(),
);
check('restored document keeps its text', readText(D.doc, b1) === 'Hello from the first block');
check('restored document keeps its title', D.doc.getText(TITLE_KEY).toString() === 'Quarterly notes 2026');
D.provider.destroy();

// 10. Cleanup
await fetch(`${API}/api/documents/${id}`, { method: 'DELETE' });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
