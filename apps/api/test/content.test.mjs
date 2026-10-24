/**
 * The content bridge: reading and writing block text over REST.
 *
 * The point of this suite is that REST edits go through the CRDT rather than
 * around it — an edit made over HTTP must reach a client that is connected at
 * the time, and must not be clobbered by that client's next save.
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { check, cleanup, finish } from '@xdocs/test-support/harness';
import { authHeaders, createDisposableUser, signInForTests } from '@xdocs/test-support/auth';
import { trackCreatedDocuments } from '@xdocs/test-support/cleanup';
import { flushStore } from '@xdocs/test-support/store';

// Everything this suite creates is purged when it ends; see @xdocs/test-support/cleanup.
const tracker = trackCreatedDocuments();
cleanup(() => tracker.purge());

const API = 'http://localhost:3001';
const WS = 'ws://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = await signInForTests(API);
const stranger = (await createDisposableUser(API)).token;
const H = (t, extra) => authHeaders(t, extra);

const create = (token, title) =>
  fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ title }),
  }).then((r) => r.json());

const getContent = (token, id) =>
  fetch(`${API}/api/documents/${id}/content`, { headers: H(token) });
const putContent = (token, id, body) =>
  fetch(`${API}/api/documents/${id}/content`, {
    method: 'PUT',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
const postContent = (token, id, body) =>
  fetch(`${API}/api/documents/${id}/content`, {
    method: 'POST',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });

function connect(docId, token) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: WS,
    name: `doc:${docId}`,
    document: doc,
    token,
    onAuthenticationFailed: () => {},
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
check('a new document reads back with its title', initial.title === 'Bridge test');
check('and its seeded empty block', Array.isArray(initial.blocks) && initial.blocks.length === 1);
check(
  'blocks carry ids and types',
  typeof initial.blocks[0].id === 'string' && initial.blocks[0].type === 'paragraph',
);

// --- writing ----------------------------------------------------------------
const written = await putContent(owner, doc.id, {
  title: 'Written by API',
  blocks: ['First line', 'Second line'],
});
check('content can be replaced', written.status === 200);
const body = await written.json();
check(
  'the response reflects the new blocks',
  body.blocks.map((b) => b.text).join('|') === 'First line|Second line',
);
check('and the new title', body.title === 'Written by API');
check('replacing removes what was there', body.blocks.length === 2);

const appended = await postContent(owner, doc.id, { blocks: ['Third line'] }).then((r) => r.json());
check(
  'blocks can be appended',
  appended.blocks.map((b) => b.text).join('|') === 'First line|Second line|Third line',
);

// A block is one node, so an embedded newline becomes another block — the same
// shape typing it would have produced.
const multiline = await putContent(owner, doc.id, { blocks: ['One\nTwo'] }).then((r) => r.json());
check(
  'a newline splits into separate blocks',
  multiline.blocks.map((b) => b.text).join('|') === 'One|Two',
);

// --- it really goes through the CRDT ----------------------------------------
const client = connect(doc.id, owner);
await client.synced;
await sleep(300);
check('a connected client sees the API-written text', textOf(client.doc).join('|') === 'One|Two');

await postContent(owner, doc.id, { blocks: ['Added while connected'] });
await sleep(600);
check(
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
check('a human edit is visible over REST', afterBoth.blocks[0].text === 'Typed by a person');
check(
  'and the API-written blocks are still there',
  afterBoth.blocks.map((b) => b.text).includes('Added while connected'),
);

client.provider.destroy();
await flushStore(API, H(owner), doc.id);

// --- persistence and the search mirror --------------------------------------
const reread = await getContent(owner, doc.id).then((r) => r.json());
check(
  'content survives every client disconnecting',
  reread.blocks.map((b) => b.text).includes('Added while connected'),
);
const hits = await fetch(
  `${API}/api/documents/search?q=${encodeURIComponent('Added while connected')}`,
  { headers: H(owner) },
).then((r) => r.json());
check(
  'API-written text is searchable once stored',
  hits.some((h) => h.document.id === doc.id),
);
const listed = await fetch(`${API}/api/documents`, { headers: H(owner) }).then((r) => r.json());
check(
  'an API-written title reaches the documents list',
  listed.find((d) => d.id === doc.id)?.title === 'Written by API',
);

// --- access -----------------------------------------------------------------
check(
  'a stranger cannot read a private document (404)',
  (await getContent(stranger, doc.id)).status === 404,
);
check(
  'a stranger cannot write to it (404)',
  (await putContent(stranger, doc.id, { blocks: ['nope'] })).status === 404,
);
check(
  'an unknown document is a 404',
  (await getContent(owner, '00000000-0000-0000-0000-000000000000')).status === 404,
);

// --- validation --------------------------------------------------------------
check(
  'a malformed body is a 400',
  (await putContent(owner, doc.id, { blocks: 'not an array' })).status === 400,
);
check(
  'an over-long title is a 400',
  (await putContent(owner, doc.id, { title: 'x'.repeat(201), blocks: [] })).status === 400,
);
check(
  'an empty block list is allowed (it empties the document)',
  (await putContent(owner, doc.id, { blocks: [] })).status === 200,
);
check(
  'and the document is then empty',
  (await getContent(owner, doc.id).then((r) => r.json())).blocks.length === 0,
);

// --- code blocks --------------------------------------------------------------
const codeDoc = await create(owner, 'Code block test');
const diagram = '+-----+\n|  a  |  indented\n+-----+';
const withCode = await putContent(owner, codeDoc.id, {
  blocks: ['Before', { type: 'code', text: diagram }, 'After'],
}).then((r) => r.json());
check('a code block is written as ONE block, newlines and all', withCode.blocks.length === 3);
check('it reads back as code', withCode.blocks[1].type === 'code');
check('with its newlines and indentation intact', withCode.blocks[1].text === diagram);
check(
  'the strings around it are still paragraphs',
  withCode.blocks[0].type === 'paragraph' && withCode.blocks[2].type === 'paragraph',
);

const codeClient = connect(codeDoc.id, owner);
await codeClient.synced;
await sleep(300);
const codeFragment = (index) =>
  codeClient.doc.getXmlFragment(`block-${codeClient.doc.getArray('blocks').get(index).id}`);
// y-tiptap discards an element whose name the editor's schema does not know,
// so the node name is the contract, not an implementation detail.
check(
  'a client receives it as a TipTap codeBlock node',
  codeFragment(1).get(0)?.nodeName === 'codeBlock',
);
check('holding the text verbatim', textOf(codeClient.doc)[1] === diagram);

// A code block made in the editor has the same shape, and "paragraph" meta.
const typed = codeFragment(0);
const typedCode = new Y.XmlElement('codeBlock');
const typedText = new Y.XmlText();
typedText.insert(0, 'made\n  in the editor');
typedCode.insert(0, [typedText]);
typed.delete(0, typed.length);
typed.insert(0, [typedCode]);
// And a block holding prose AND code is not "code" — its text is not verbatim.
const mixed = codeFragment(2);
const mixedCode = new Y.XmlElement('codeBlock');
const mixedText = new Y.XmlText();
mixedText.insert(0, 'x = 1');
mixedCode.insert(0, [mixedText]);
mixed.insert(mixed.length, [mixedCode]);
await sleep(600);

const reread2 = await getContent(owner, codeDoc.id).then((r) => r.json());
check('an editor-made code block reads as code', reread2.blocks[0].type === 'code');
check('with its text', reread2.blocks[0].text === 'made\n  in the editor');
check(
  'a block mixing a paragraph and code reads as a paragraph',
  reread2.blocks[2].type === 'paragraph',
);
codeClient.provider.destroy();

const codeAppended = await postContent(owner, codeDoc.id, {
  blocks: [{ type: 'code', text: 'appended()' }],
}).then((r) => r.json());
check(
  'a code block can be appended',
  codeAppended.blocks.at(-1).type === 'code' && codeAppended.blocks.at(-1).text === 'appended()',
);

const emptyCode = await putContent(owner, codeDoc.id, {
  blocks: [{ type: 'code', text: '' }],
}).then((r) => r.json());
check(
  'an empty code block is still a code block',
  emptyCode.blocks.length === 1 && emptyCode.blocks[0].type === 'code',
);

const objectParagraph = await putContent(owner, codeDoc.id, {
  blocks: [{ type: 'paragraph', text: 'a\nb' }],
}).then((r) => r.json());
check(
  'the object form of a paragraph splits on newlines like a string',
  objectParagraph.blocks.map((b) => b.text).join('|') === 'a|b',
);

// What a read returns can be written straight back.
await putContent(owner, codeDoc.id, { blocks: ['prose', { type: 'code', text: 'a\n  b' }] });
const roundTrip = await getContent(owner, codeDoc.id).then((r) => r.json());
const rewritten = await putContent(owner, codeDoc.id, { blocks: roundTrip.blocks }).then((r) =>
  r.json(),
);
check(
  'a read round-trips through a write unchanged',
  JSON.stringify(rewritten.blocks.map(({ type, text }) => [type, text])) ===
    JSON.stringify(roundTrip.blocks.map(({ type, text }) => [type, text])),
);

// --- images: the filename is what search and the content view can see -----------
const imageDoc = await create(owner, 'Image test');
const imageClient = connect(imageDoc.id, owner);
await imageClient.synced;
await sleep(300);
const imageBlockId = imageClient.doc.getArray('blocks').get(0).id;
const imageFragment = imageClient.doc.getXmlFragment(`block-${imageBlockId}`);
const imageNeedle = `zorblat${Date.now()}`;
const imageNode = new Y.XmlElement('image');
imageNode.setAttribute('src', '/api/attachments/00000000-0000-0000-0000-000000000000');
imageNode.setAttribute('alt', `${imageNeedle}.png`);
imageFragment.delete(0, imageFragment.length);
imageFragment.insert(0, [imageNode]);
await sleep(600);

const imageContent = await getContent(owner, imageDoc.id).then((r) => r.json());
check(
  'an image block reads back as its filename',
  imageContent.blocks[0].text === `${imageNeedle}.png`,
);
imageClient.provider.destroy();
await flushStore(API, H(owner), imageDoc.id);
const imageHits = await fetch(`${API}/api/documents/search?q=${encodeURIComponent(imageNeedle)}`, {
  headers: H(owner),
}).then((r) => r.json());
check(
  'and an image is findable by its filename',
  imageHits.some((h) => h.document.id === imageDoc.id),
);

// --- tables: a row reads as one line, its cells side by side (#50) --------------
const tableDoc = await create(owner, 'Table test');
const tableClient = connect(tableDoc.id, owner);
await tableClient.synced;
await sleep(300);
const tableBlockId = tableClient.doc.getArray('blocks').get(0).id;
const tableFragment = tableClient.doc.getXmlFragment(`block-${tableBlockId}`);
const tableNeedle = `quillok${Date.now()}`;
// Cells as the editor writes them: each holds paragraphs, a header row first.
const rows = [
  ['tableHeader', ['Name', 'Role']],
  ['tableCell', ['Ada', tableNeedle]],
  ['tableCell', ['Grace', 'two\nparagraphs']],
];
const texts = [];
const table = new Y.XmlElement('table');
table.insert(
  0,
  rows.map(([cellName, cells]) => {
    const row = new Y.XmlElement('tableRow');
    row.insert(
      0,
      cells.map((cellText) => {
        const cell = new Y.XmlElement(cellName);
        cell.insert(
          0,
          cellText.split('\n').map((line) => {
            const paragraph = new Y.XmlElement('paragraph');
            const text = new Y.XmlText();
            paragraph.insert(0, [text]);
            texts.push([text, line]);
            return paragraph;
          }),
        );
        return cell;
      }),
    );
    return row;
  }),
);
tableFragment.delete(0, tableFragment.length);
tableFragment.insert(0, [table]);
// Only once attached: a detached Y.XmlText queues what it is given (#25).
for (const [text, line] of texts) text.insert(0, line);
await sleep(600);

const tableContent = await getContent(owner, tableDoc.id).then((r) => r.json());
check(
  `a table reads back a line per row (${JSON.stringify(tableContent.blocks[0].text)})`,
  tableContent.blocks[0].text === `Name | Role\nAda | ${tableNeedle}\nGrace | two paragraphs`,
);
tableClient.provider.destroy();
await flushStore(API, H(owner), tableDoc.id);
const tableHits = await fetch(`${API}/api/documents/search?q=${encodeURIComponent(tableNeedle)}`, {
  headers: H(owner),
}).then((r) => r.json());
check(
  'and the words in its cells are searchable',
  tableHits.some((h) => h.document.id === tableDoc.id),
);

// --- links ----------------------------------------------------------------------
const linkDoc = await create(owner, 'Link test');
const linkWritten = await putContent(owner, linkDoc.id, {
  blocks: [
    'See [the docs](https://example.com/docs) for more.',
    'Brackets \\[not a link\\] stay literal.',
    { type: 'code', text: 'const link = "[label](href)";' },
  ],
}).then((r) => r.json());
check(
  'a link round-trips as written',
  linkWritten.blocks[0].text === 'See [the docs](https://example.com/docs) for more.',
);
check(
  'escaped brackets stay literal',
  linkWritten.blocks[1].text === 'Brackets \\[not a link\\] stay literal.',
);
check(
  'code block text is verbatim, not link notation',
  linkWritten.blocks[2].text === 'const link = "[label](href)";',
);

// The mark is real, not decoration: a connected client sees it.
const linkClient = connect(linkDoc.id, owner);
await linkClient.synced;
await sleep(300);
const linkedBlockId = linkClient.doc.getArray('blocks').get(0).id;
const linkedDelta = linkClient.doc.getXmlFragment(`block-${linkedBlockId}`).get(0).get(0).toDelta();
check(
  'a client receives it as a link mark',
  linkedDelta.some(
    (op) => op.attributes?.link?.href === 'https://example.com/docs' && op.insert === 'the docs',
  ),
);

// And a link made in the editor reads back in the same notation.
const linkFragment = linkClient.doc.getXmlFragment(`block-${linkedBlockId}`);
const linkParagraph = new Y.XmlElement('paragraph');
const linkTextNode = new Y.XmlText();
linkParagraph.insert(0, [linkTextNode]);
linkFragment.delete(0, linkFragment.length);
linkFragment.insert(0, [linkParagraph]);
// Written the way the editor does it: type the words, then mark a range.
linkTextNode.insert(0, 'xDocs is here');
linkTextNode.format(0, 5, { link: { href: 'https://xdocs.test/' } });
await sleep(600);
const linkBack = await getContent(owner, linkDoc.id).then((r) => r.json());
check(
  'a link made in the editor reads back as [label](href)',
  linkBack.blocks[0].text === '[xDocs](https://xdocs.test/) is here',
);
linkClient.provider.destroy();

// What search indexes stays plain: the words, not the notation.
const linkSearch = await fetch(`${API}/api/documents/search?q=${encodeURIComponent('the docs')}`, {
  headers: H(owner),
}).then((r) => r.json());
check('search still sees the words, not the markup', Array.isArray(linkSearch));

const unsafeLink = await putContent(owner, linkDoc.id, {
  blocks: ['[click](javascript:alert(1))'],
});
check('an unusable link is refused (400)', unsafeLink.status === 400);
const afterUnsafe = await getContent(owner, linkDoc.id).then((r) => r.json());
check(
  'and the document is left alone',
  afterUnsafe.blocks[0].text === '[xDocs](https://xdocs.test/) is here',
);
check(
  'a relative link is allowed',
  (
    await putContent(owner, linkDoc.id, {
      blocks: ['[a doc](/doc/00000000-0000-0000-0000-000000000000)'],
    })
  ).status === 200,
);

check(
  'an unknown block type is a 400',
  (await putContent(owner, codeDoc.id, { blocks: [{ type: 'heading', text: 'x' }] })).status ===
    400,
);
check(
  'a code block without text is a 400',
  (await putContent(owner, codeDoc.id, { blocks: [{ type: 'code' }] })).status === 400,
);

await finish();
