/**
 * Attachments: files stored beside a document and reachable exactly when the
 * document is.
 *
 * The access rule is the point of this suite. A file inherits its document's
 * visibility, disappears with it into the trash, comes back on restore, and is
 * destroyed by a permanent delete — there is no separate permission model to
 * get out of step.
 */
import { authHeaders, createDisposableUser, signInForTests } from './test-auth.mjs';

const API = 'http://localhost:3001';
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

// --- access follows the document ---------------------------------------------
ck('no credential is a 401', (await fetch(`${API}/api/attachments/${attached.id}`)).status === 401);
ck('a stranger cannot download from a private document (404)', (await download(stranger, attached.id)).status === 404);
ck('nor attach to it (404)', (await upload(stranger, doc.id, new Uint8Array([1]), 'a', 'text/plain')).status === 404);

await fetch(`${API}/api/documents/${doc.id}/visibility`, {
  method: 'PATCH', headers: H(owner, { 'content-type': 'application/json' }), body: JSON.stringify({ visibility: 'public' }),
});
ck('once the document is public, others can download', (await download(stranger, attached.id)).status === 200);
ck('and attach, as they can edit', (await upload(stranger, doc.id, new Uint8Array([1]), 'theirs.txt', 'text/plain')).status === 201);

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

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
