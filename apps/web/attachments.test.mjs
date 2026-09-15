/**
 * Attachments: files stored beside a document and reachable exactly when the
 * document is.
 *
 * The access rule is the point of this suite. A file inherits its document's
 * visibility, disappears with it into the trash, comes back on restore, and is
 * destroyed by a permanent delete — there is no separate permission model to
 * get out of step.
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
const MAX = 10 * 1024 * 1024;

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

function upload(token, docId, bytes, name, type) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  // No content-type header: fetch writes the multipart boundary itself.
  return fetch(`${API}/api/documents/${docId}/attachments`, { method: 'POST', headers: H(token), body: form });
}
const download = (token, id) => fetch(`${API}/api/attachments/${id}`, { headers: H(token) });

const doc = await create(owner, 'Attachment test');

// --- upload -----------------------------------------------------------------
const text = 'hello, attachments\n';
const res = await upload(owner, doc.id, new TextEncoder().encode(text), 'notes.txt', 'text/plain');
ck('a file can be attached (201)', res.status === 201);
const attached = await res.json();
ck('the response describes it', attached.filename === 'notes.txt' && attached.size === text.length && attached.documentId === doc.id);
ck('with the href a document links to', attached.href === `/api/attachments/${attached.id}`);
ck('and the type it was sent with', attached.contentType === 'text/plain');

// --- download ---------------------------------------------------------------
const got = await download(owner, attached.id);
ck('it downloads (200)', got.status === 200);
ck('byte for byte', (await got.clone().text()) === text);
ck('as an attachment, with its name', /^attachment;.*filename="notes\.txt"/.test(got.headers.get('content-disposition') ?? ''));
ck('never sniffed', got.headers.get('x-content-type-options') === 'nosniff');
ck('and sandboxed if opened directly', (got.headers.get('content-security-policy') ?? '').includes('sandbox'));

// Binary content survives unchanged — the column is bytea, not text.
const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
const bin = await upload(owner, doc.id, binary, 'all-bytes.bin', 'application/octet-stream').then((r) => r.json());
const binBack = new Uint8Array(await download(owner, bin.id).then((r) => r.arrayBuffer()));
ck('binary content round-trips', binBack.length === 256 && binBack.every((b, i) => b === i));

// --- names and types are cleaned, not trusted -----------------------------------
const unicode = await upload(owner, doc.id, new Uint8Array([1]), 'Звіт "Q3".pdf', 'application/pdf').then((r) => r.json());
const disposition = (await download(owner, unicode.id)).headers.get('content-disposition') ?? '';
ck('a non-ASCII name is kept', unicode.filename === 'Звіт "Q3".pdf');
ck('and sent as RFC 6266 filename*', disposition.includes(`filename*=UTF-8''${encodeURIComponent('Звіт "Q3".pdf')}`));
ck('with quotes kept out of the ASCII fallback', !/filename="[^"]*"[^;]*"/.test(disposition));
const pathy = await upload(owner, doc.id, new Uint8Array([1]), '../../etc/passwd', 'text/plain').then((r) => r.json());
ck('a path in the name is reduced to its last segment', pathy.filename === 'passwd');
const typed = await upload(owner, doc.id, new Uint8Array([1]), 'x.html', 'text/html; charset=utf-8').then((r) => r.json());
ck('parameters are stripped from the type', typed.contentType === 'text/html');
const bogus = await upload(owner, doc.id, new Uint8Array([1]), 'x', 'not a type').then((r) => r.json());
ck('a malformed type becomes octet-stream', bogus.contentType === 'application/octet-stream');

// --- limits and validation ----------------------------------------------------
const tooBig = await upload(owner, doc.id, new Uint8Array(MAX + 1), 'big.bin', 'application/octet-stream');
ck('a file over the cap is refused (413)', tooBig.status === 413);
const exact = await upload(owner, doc.id, new Uint8Array(MAX), 'exact.bin', 'application/octet-stream');
ck('a file exactly at the cap is accepted', exact.status === 201);
const noFile = await fetch(`${API}/api/documents/${doc.id}/attachments`, {
  method: 'POST', headers: H(owner, { 'content-type': 'application/json' }), body: '{}',
});
ck('a body without a file is a 400', noFile.status === 400);
ck('a malformed attachment id is a 404, not a 500', (await download(owner, 'not-a-uuid')).status === 404);
ck('an unknown attachment is a 404', (await download(owner, '00000000-0000-0000-0000-000000000000')).status === 404);
ck('uploading to a malformed document id is a 404', (await upload(owner, 'nope', new Uint8Array([1]), 'a', 'text/plain')).status === 404);

// --- the storage quota ---------------------------------------------------------
const usage = (token) => fetch(`${API}/api/attachments/usage`, { headers: H(token) }).then((r) => r.json());

/*
 * Counted on a brand new account, not the shared test one.
 *
 * These are the only assertions in the integration layer that read a number
 * belonging to a whole user rather than to one document, so on the shared
 * account they would be at the mercy of anything else uploading at the same
 * time — another suite here, or a browser worker. A fresh user starts at zero
 * and nobody else touches it, which also lets the sums be exact instead of
 * deltas.
 */
const counter = (await createDisposableUser(API)).token;
const before = await usage(counter);
ck('usage reports a quota', before.quotaBytes > 0);
ck('and a new account has used nothing', before.usedBytes === 0);

const quotaDoc = await create(counter, 'Quota test');
await upload(counter, quotaDoc.id, new Uint8Array(2048), 'counted.bin', 'application/octet-stream');
const after = await usage(counter);
ck('an upload adds exactly its size', after.usedBytes === 2048);
ck('the quota itself does not move', after.quotaBytes === before.quotaBytes);

// Another user's files are not counted against this one.
const strangerDoc = await create(stranger, 'Their quota');
await upload(stranger, strangerDoc.id, new Uint8Array(4096), 'theirs.bin', 'application/octet-stream');
ck('usage is per user', (await usage(counter)).usedBytes === 2048);
ck('and each user sees their own', (await usage(stranger)).usedBytes === 4096);

// Destroying the document frees what its files took.
await fetch(`${API}/api/documents/${quotaDoc.id}`, { method: 'DELETE', headers: H(counter) });
await fetch(`${API}/api/documents/${quotaDoc.id}/permanent`, { method: 'DELETE', headers: H(counter) });
ck('deleting for good frees the space', (await usage(counter)).usedBytes === 0);

ck('usage needs a credential', (await fetch(`${API}/api/attachments/usage`)).status === 401);
// "usage" must not be read as an attachment id by the route below it.
ck('and is not mistaken for a file', (await usage(owner)).quotaBytes !== undefined);

// --- access follows the document ---------------------------------------------
ck('no credential is a 401', (await fetch(`${API}/api/attachments/${attached.id}`)).status === 401);
ck('a stranger cannot download from a private document (404)', (await download(stranger, attached.id)).status === 404);
ck('nor attach to it (404)', (await upload(stranger, doc.id, new Uint8Array([1]), 'a', 'text/plain')).status === 404);

await fetch(`${API}/api/documents/${doc.id}/visibility`, {
  method: 'PATCH', headers: H(owner, { 'content-type': 'application/json' }), body: JSON.stringify({ visibility: 'public' }),
});
ck('once the document is public, others can download', (await download(stranger, attached.id)).status === 200);
ck('and attach, as they can edit', (await upload(stranger, doc.id, new Uint8Array([1]), 'theirs.txt', 'text/plain')).status === 201);

// --- the document's file list ------------------------------------------------
const listDoc = await create(owner, 'File list test');
const listed = (token, id) => fetch(`${API}/api/documents/${id}/attachments`, { headers: H(token) });
const del = (token, id) => fetch(`${API}/api/attachments/${id}`, { method: 'DELETE', headers: H(token) });

ck('a document with no files lists none', (await listed(owner, listDoc.id).then((r) => r.json())).length === 0);
const loose = await upload(owner, listDoc.id, new Uint8Array([1, 2, 3]), 'loose.txt', 'text/plain').then((r) => r.json());
const listedOnce = await listed(owner, listDoc.id).then((r) => r.json());
ck('an uploaded file appears in the list', listedOnce.length === 1 && listedOnce[0].id === loose.id);
ck('with its name and size', listedOnce[0].filename === 'loose.txt' && listedOnce[0].size === 3);
ck('and is marked unused while nothing links to it', listedOnce[0].linked === false);

/*
 * Linked the way the editor does it: a link mark in the CRDT. The content
 * routes are plain text here, so this is the only way to make a real link.
 */
const ydoc = new Y.Doc();
const provider = new HocuspocusProvider({ url: WS, name: `doc:${listDoc.id}`, document: ydoc, token: owner });
await new Promise((r) => provider.on('synced', () => r()));
await sleep(300);
const blockId = ydoc.getArray('blocks').get(0).id;
const fragment = ydoc.getXmlFragment(`block-${blockId}`);
const paragraph = new Y.XmlElement('paragraph');
const linkText = new Y.XmlText();
paragraph.insert(0, [linkText]);
fragment.delete(0, fragment.length);
fragment.insert(0, [paragraph]);
linkText.insert(0, 'loose.txt');
linkText.format(0, 9, { link: { href: loose.href } });
await sleep(600);
ck('a linked file is marked as used', (await listed(owner, listDoc.id).then((r) => r.json()))[0].linked === true);

// An image counts too: it refers to its file through src, not a link mark.
const picture = await upload(owner, listDoc.id, new Uint8Array([1]), 'picture.png', 'image/png').then((r) => r.json());
const image = new Y.XmlElement('image');
image.setAttribute('src', picture.href);
image.setAttribute('alt', 'picture.png');
fragment.insert(fragment.length, [image]);
await sleep(600);
const withImage = await listed(owner, listDoc.id).then((r) => r.json());
ck('an image marks its file as used', withImage.find((f) => f.id === picture.id)?.linked === true);

// Remove both: the files survive, since the deletion is undoable.
fragment.delete(0, fragment.length);
await sleep(600);
ck('the image file survives its removal too', (await listed(owner, listDoc.id).then((r) => r.json())).length === 2);
await del(owner, picture.id);
provider.destroy();
const afterUnlink = await listed(owner, listDoc.id).then((r) => r.json());
ck('removing the link keeps the file', afterUnlink.length === 1);
ck('but marks it unused again', afterUnlink[0].linked === false);
ck('and it still downloads', (await download(owner, loose.id)).status === 200);

ck('a stranger cannot list a private document\'s files', (await listed(stranger, listDoc.id)).status === 404);
ck('nor delete one of its files', (await del(stranger, loose.id)).status === 404);
ck('an unknown file is a 404', (await del(owner, '00000000-0000-0000-0000-000000000000')).status === 404);
ck('the owner can delete it', (await del(owner, loose.id)).status === 204);
ck('and it is gone for good', (await download(owner, loose.id)).status === 404);
ck('leaving the list empty', (await listed(owner, listDoc.id).then((r) => r.json())).length === 0);

// --- trash, restore, purge ------------------------------------------------------
await fetch(`${API}/api/documents/${doc.id}`, { method: 'DELETE', headers: H(owner) });
ck('a trashed document\'s files are unreachable', (await download(owner, attached.id)).status === 404);
await fetch(`${API}/api/documents/${doc.id}/restore`, { method: 'POST', headers: H(owner) });
ck('and come back on restore', (await download(owner, attached.id)).status === 200);

await fetch(`${API}/api/documents/${doc.id}`, { method: 'DELETE', headers: H(owner) });
const purged = await fetch(`${API}/api/documents/${doc.id}/permanent`, { method: 'DELETE', headers: H(owner) });
ck('the document can be purged', purged.status === 204);
// Restoring is impossible now, so a 404 here can only mean the row is gone.
const restoreAfter = await fetch(`${API}/api/documents/${doc.id}/restore`, { method: 'POST', headers: H(owner) });
ck('a purged document cannot be restored', restoreAfter.status === 404 || restoreAfter.status === 403);
ck('and its files are gone with it', (await download(owner, attached.id)).status === 404);

await tracker.purge();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
