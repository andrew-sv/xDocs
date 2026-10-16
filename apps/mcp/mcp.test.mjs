/**
 * The MCP server, driven the way a client drives it.
 *
 * The real binary is spawned over stdio rather than wired up in memory, so this
 * covers the entry point, the environment handling and the stdout discipline —
 * a stray console.log corrupts the protocol stream, and only this path notices.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { authHeaders, createDisposableUser, signInForTests } from '../web/test-auth.mjs';
import { trackCreatedDocuments } from '../web/test-cleanup.mjs';

// Everything this suite creates is purged when it ends; see test-cleanup.mjs.
const tracker = trackCreatedDocuments();

const API = 'http://localhost:3001';
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

const session = await signInForTests(API);
const H = (token, extra) => authHeaders(token, extra);

/** Keys are created over REST, exactly as a person would in the app. */
async function mintKey(sessionToken, name) {
  const res = await fetch(`${API}/api/keys`, {
    method: 'POST',
    headers: H(sessionToken, { 'content-type': 'application/json' }),
    body: JSON.stringify({ name }),
  });
  return res.json();
}
const revokeKey = (sessionToken, id) =>
  fetch(`${API}/api/keys/${id}`, { method: 'DELETE', headers: H(sessionToken) });

async function connect(apiKey) {
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', resolve(here, 'src/index.ts')],
    env: { ...process.env, XDOCS_API_URL: API, XDOCS_API_KEY: apiKey },
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}

const text = (result) => result.content.map((part) => part.text ?? '').join('\n');
const call = (client, name, args) => client.callTool({ name, arguments: args });

const ownerKey = await mintKey(session, 'mcp integration test');
const client = await connect(ownerKey.key);

// --- the tool surface -------------------------------------------------------
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
ck('the server advertises its tools', names.length === 8);
ck(
  'and they are the documented ones',
  names.join(',') ===
    'append_to_document,create_document,list_documents,move_document,read_document,replace_document_content,search_documents,set_document_visibility',
);
ck(
  'reads are annotated read-only',
  tools.find((t) => t.name === 'read_document')?.annotations?.readOnlyHint === true,
);
ck(
  'writes are not',
  tools.find((t) => t.name === 'create_document')?.annotations?.readOnlyHint !== true,
);
ck(
  'replacing content is flagged destructive',
  tools.find((t) => t.name === 'replace_document_content')?.annotations?.destructiveHint === true,
);
ck('no deletion tool is exposed', !names.includes('delete_document'));
ck(
  'tools carry input schemas',
  Boolean(tools.find((t) => t.name === 'read_document')?.inputSchema),
);

// --- create and read back ---------------------------------------------------
const NEEDLE = `zorblat${Date.now()}`;
const created = await call(client, 'create_document', {
  title: `MCP ${NEEDLE}`,
  blocks: ['First paragraph from MCP.', `It mentions ${NEEDLE}.`],
});
const id = text(created).match(/([0-9a-f-]{36})/)?.[1];
// Created by the server process, so the fetch wrapper never saw it. The key
// acts as the session's user, so the session can purge it.
if (id) tracker.add(id, session);
ck('a document can be created', Boolean(id));

const read = await call(client, 'read_document', { id });
ck('it reads back with its blocks', text(read).includes('First paragraph from MCP.'));
ck('structured content carries the blocks', read.structuredContent?.blocks?.length === 2);
ck('and the title', read.structuredContent?.title === `MCP ${NEEDLE}`);

// It is a real document, not something only MCP can see.
const overRest = await fetch(`${API}/api/documents/${id}`, { headers: H(session) }).then((r) =>
  r.json(),
);
ck('the document exists over REST too', overRest.id === id);

// --- append and replace -----------------------------------------------------
await call(client, 'append_to_document', { id, blocks: ['Appended line.'] });
const afterAppend = await call(client, 'read_document', { id });
ck('append adds without replacing', afterAppend.structuredContent.blocks.length === 3);
ck(
  'and keeps the original first block',
  afterAppend.structuredContent.blocks[0] === 'First paragraph from MCP.',
);

await call(client, 'replace_document_content', {
  id,
  blocks: ['Only this now.'],
  title: 'Replaced by MCP',
});
const afterReplace = await call(client, 'read_document', { id });
ck(
  'replace removes what was there',
  afterReplace.structuredContent.blocks.join('|') === 'Only this now.',
);
ck('and can set the title', afterReplace.structuredContent.title === 'Replaced by MCP');

// --- code blocks ------------------------------------------------------------
const diagram = '+---+\n|   |  keeps its indentation\n+---+';
const codeAppend = await call(client, 'append_to_document', {
  id,
  blocks: [{ type: 'code', text: diagram }],
});
ck('a code block can be written', !codeAppend.isError);
const afterCode = await call(client, 'read_document', { id });
ck('it is one block, not one per line', afterCode.structuredContent.blocks.length === 2);
ck(
  'structured content gives it back in the shape the tools take',
  JSON.stringify(afterCode.structuredContent.blocks[1]) ===
    JSON.stringify({ type: 'code', text: diagram }),
);
ck(
  'and the text result shows it fenced',
  text(afterCode).includes(`2. \`\`\`\n${diagram}\n\`\`\``),
);
// So a read can be passed straight back to a write.
await call(client, 'replace_document_content', { id, blocks: afterCode.structuredContent.blocks });
const rewritten = await call(client, 'read_document', { id });
ck(
  'a read round-trips through replace unchanged',
  JSON.stringify(rewritten.structuredContent.blocks) ===
    JSON.stringify(afterCode.structuredContent.blocks),
);
// --- links ---------------------------------------------------------------------
await call(client, 'replace_document_content', {
  id,
  blocks: ['Read [the docs](https://example.com/docs) first.'],
});
const withLink = await call(client, 'read_document', { id });
ck(
  'a link written through MCP comes back in the same notation',
  withLink.structuredContent.blocks[0] === 'Read [the docs](https://example.com/docs) first.',
);
const refusedLink = await call(client, 'append_to_document', {
  id,
  blocks: ['[no](javascript:alert(1))'],
});
ck('a link the editor could not open is refused', refusedLink.isError === true);
ck('and the refusal explains itself', /not a link/i.test(text(refusedLink)));

const badBlock = await call(client, 'append_to_document', {
  id,
  blocks: [{ type: 'heading', text: 'x' }],
});
ck('an unknown block type is rejected', badBlock.isError === true);

// --- listing and search -----------------------------------------------------
const listed = await call(client, 'list_documents', {});
ck('the document appears in a listing', text(listed).includes(id));

const child = await call(client, 'create_document', { title: `Child of ${NEEDLE}`, parentId: id });
const childId = text(child).match(/([0-9a-f-]{36})/)?.[1];
if (childId) tracker.add(childId, session);
const children = await call(client, 'list_documents', { parentId: id });
ck('children can be listed by parent', text(children).includes(childId));
const flat = await call(client, 'list_documents', { flat: true });
ck('a flat listing includes nested documents', text(flat).includes(childId));

// Search needs the store debounce to have run, as the search suite does.
let found = false;
for (let attempt = 0; attempt < 10 && !found; attempt++) {
  await sleep(1000);
  found = text(await call(client, 'search_documents', { query: NEEDLE })).includes(childId);
}
ck('search finds a document created through MCP', found);

// --- move -------------------------------------------------------------------
await call(client, 'move_document', { id: childId, parentId: null });
const topLevel = await call(client, 'list_documents', {});
ck('a document can be moved to the top level', text(topLevel).includes(childId));

const cycle = await call(client, 'move_document', { id, parentId: id });
ck('moving a document into itself is refused', cycle.isError === true);
ck('and the refusal is readable, not a stack trace', /invalid|cannot|refused/i.test(text(cycle)));

// --- visibility -------------------------------------------------------------
await call(client, 'set_document_visibility', { id, visibility: 'public' });
ck(
  'visibility changes reach the API',
  (await fetch(`${API}/api/documents/${id}`, { headers: H(session) }).then((r) => r.json()))
    .visibility === 'public',
);

// --- errors a model has to act on -------------------------------------------
const missing = await call(client, 'read_document', { id: '00000000-0000-0000-0000-000000000000' });
ck('an unknown document is an error result, not a crash', missing.isError === true);
ck('and says it may simply not be visible', text(missing).includes('not visible to this API key'));

const badArgs = await call(client, 'read_document', {});
ck('a missing argument is rejected before the handler runs', badArgs.isError === true);

// --- the access boundary ----------------------------------------------------
const stranger = await createDisposableUser(API);
const strangerKey = await mintKey(stranger.token, 'stranger key');
const strangerClient = await connect(strangerKey.key);
const privateDoc = await fetch(`${API}/api/documents`, {
  method: 'POST',
  headers: H(session, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Private to the owner' }),
}).then((r) => r.json());

const denied = await call(strangerClient, 'read_document', { id: privateDoc.id });
ck("another user's key cannot read a private document", denied.isError === true);
const strangerSearch = await call(strangerClient, 'search_documents', {
  query: 'Private to the owner',
});
ck('nor find it by searching', !text(strangerSearch).includes(privateDoc.id));
await strangerClient.close();

// --- a revoked key ----------------------------------------------------------
const throwaway = await mintKey(session, 'about to be revoked');
const throwawayClient = await connect(throwaway.key);
await revokeKey(session, throwaway.id);
const afterRevoke = await call(throwawayClient, 'list_documents', {});
ck('a revoked key fails', afterRevoke.isError === true);
ck('and says so in words', text(afterRevoke).includes('invalid or has been revoked'));
await throwawayClient.close();

await client.close();
await revokeKey(session, ownerKey.id);
await revokeKey(stranger.token, strangerKey.id);

await tracker.purge();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
