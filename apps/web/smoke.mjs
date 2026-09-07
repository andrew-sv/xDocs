/**
 * Post-deploy smoke test. Verifies the password gate really covers BOTH
 * surfaces — a gate on the page alone would leave the API wide open.
 *
 *   node smoke.mjs https://xdocs-api.example.com "<password>"
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const [baseUrl, password] = process.argv.slice(2);
if (!baseUrl || !password) {
  console.error('usage: node smoke.mjs <base-url> <password>');
  process.exit(2);
}
const WS = baseUrl.replace(/^http/, 'ws');
const BLOCKS_KEY = 'blocks';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ck = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) fail++; };
const authed = (extra = {}) => ({ authorization: `Bearer ${password}`, ...extra });

// --- HTTP surface -----------------------------------------------------------
ck('health is public', (await fetch(`${baseUrl}/health`)).status === 200);
ck('unauthenticated list is 401', (await fetch(`${baseUrl}/api/documents`)).status === 401);
ck(
  'wrong password is 401',
  (await fetch(`${baseUrl}/api/documents`, { headers: { authorization: 'Bearer nope' } })).status === 401,
);

const listed = await fetch(`${baseUrl}/api/documents`, { headers: authed() });
ck('correct password is 200', listed.status === 200);

// --- WebSocket surface ------------------------------------------------------
const created = await fetch(`${baseUrl}/api/documents`, {
  method: 'POST',
  headers: authed({ 'content-type': 'application/json' }),
  body: JSON.stringify({ title: `smoke-${Date.now()}` }),
}).then((r) => r.json());
ck('document created', typeof created.id === 'string');

function connect(token) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: WS,
    name: `doc:${created.id}`,
    document: doc,
    token: token ?? '',
    onAuthenticationFailed: () => {},
  });
  return { doc, provider };
}

const bad = connect('definitely-wrong');
const rejected = await Promise.race([
  new Promise((res) => bad.provider.on('authenticationFailed', () => res(true))),
  new Promise((res) => bad.provider.on('close', () => res(true))),
  sleep(6000).then(() => false),
]);
ck('websocket rejects a bad token', rejected === true);
bad.provider.destroy();

const good = connect(password);
const synced = await Promise.race([
  new Promise((res) => good.provider.on('synced', () => res(true))),
  sleep(10000).then(() => false),
]);
ck('websocket syncs with the correct token', synced === true);
ck('synced document has its seeded block', good.doc.getArray(BLOCKS_KEY).length === 1);
good.provider.destroy();

await fetch(`${baseUrl}/api/documents/${created.id}`, { method: 'DELETE', headers: authed() });

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
