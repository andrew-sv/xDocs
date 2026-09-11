/**
 * API keys: a credential for scripts, acting as its owner.
 *
 * The security properties are the point here — a key must not be able to mint
 * more keys, must stop working the moment it is revoked, must not be readable
 * back out of the database, and must see exactly what its owner sees and
 * nothing more.
 */
import { authHeaders, createDisposableUser, signInForTests } from './test-auth.mjs';

const API = 'http://localhost:3001';
let fail = 0;
const ck = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) fail++; };

const owner = await signInForTests(API);
const stranger = await createDisposableUser(API);
const H = (t, extra) => authHeaders(t, extra);
const keyHeaders = (key, extra = {}) => ({ authorization: `Bearer ${key}`, origin: 'http://localhost:5173', ...extra });

const createKey = (token, name) =>
  fetch(`${API}/api/keys`, {
    method: 'POST', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ name }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// --- creation ---------------------------------------------------------------
const created = await createKey(owner, 'integration test key');
ck('a key is created', created.status === 201);
const key = created.body?.key;
ck('the response carries the key itself, once', typeof key === 'string' && key.startsWith('xdk_'));
ck('and a prefix for identifying it later', typeof created.body?.prefix === 'string' && key.startsWith(created.body.prefix));

const listed = await fetch(`${API}/api/keys`, { headers: H(owner) }).then((r) => r.json());
const row = listed.find((k) => k.id === created.body.id);
ck('it appears in the list', Boolean(row));
ck('the list never returns the key', !JSON.stringify(listed).includes(key));

// --- the key works as its owner ---------------------------------------------
const viaKey = await fetch(`${API}/api/documents`, { headers: keyHeaders(key) });
ck('the key authenticates REST requests', viaKey.status === 200);

const madeByKey = await fetch(`${API}/api/documents`, {
  method: 'POST', headers: keyHeaders(key, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Made by a script' }),
}).then((r) => r.json());
ck('a document can be created with a key', typeof madeByKey.id === 'string');

const ownerSees = await fetch(`${API}/api/documents/${madeByKey.id}`, { headers: H(owner) });
ck('and it belongs to the key owner', ownerSees.status === 200);

// --- it sees exactly what its owner sees ------------------------------------
const strangerDoc = await fetch(`${API}/api/documents`, {
  method: 'POST', headers: H(stranger.token, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Private to a stranger' }),
}).then((r) => r.json());
ck(
  'a key cannot reach a document its owner cannot',
  (await fetch(`${API}/api/documents/${strangerDoc.id}`, { headers: keyHeaders(key) })).status === 404,
);

// --- a key cannot manage keys ------------------------------------------------
const mintedByKey = await fetch(`${API}/api/keys`, {
  method: 'POST', headers: keyHeaders(key, { 'content-type': 'application/json' }),
  body: JSON.stringify({ name: 'escalation' }),
});
ck('a key cannot mint another key (403)', mintedByKey.status === 403);
ck('a key cannot even list keys (403)', (await fetch(`${API}/api/keys`, { headers: keyHeaders(key) })).status === 403);
ck(
  'a key cannot revoke a key',
  (await fetch(`${API}/api/keys/${created.body.id}`, { method: 'DELETE', headers: keyHeaders(key) })).status === 403,
);

// --- forged and foreign keys -------------------------------------------------
ck('a forged key is refused', (await fetch(`${API}/api/documents`, { headers: keyHeaders('xdk_not-a-real-key') })).status === 401);
ck(
  "a stranger cannot revoke someone else's key",
  (await fetch(`${API}/api/keys/${created.body.id}`, { method: 'DELETE', headers: H(stranger.token) })).status === 404,
);

// --- revocation --------------------------------------------------------------
const revoked = await fetch(`${API}/api/keys/${created.body.id}`, { method: 'DELETE', headers: H(owner) });
ck('the owner can revoke it', revoked.status === 204);
ck('a revoked key stops working immediately', (await fetch(`${API}/api/documents`, { headers: keyHeaders(key) })).status === 401);
ck('and disappears from the list', !(await fetch(`${API}/api/keys`, { headers: H(owner) }).then((r) => r.json())).some((k) => k.id === created.body.id));
ck('revoking twice is a 404, not a silent success', (await fetch(`${API}/api/keys/${created.body.id}`, { method: 'DELETE', headers: H(owner) })).status === 404);

// --- flat listing, for callers with no sidebar -------------------------------
const parent = await fetch(`${API}/api/documents`, {
  method: 'POST', headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Flat parent' }),
}).then((r) => r.json());
const child = await fetch(`${API}/api/documents`, {
  method: 'POST', headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Flat child', parentId: parent.id }),
}).then((r) => r.json());

const level = await fetch(`${API}/api/documents`, { headers: H(owner) }).then((r) => r.json());
const flat = await fetch(`${API}/api/documents?flat=1`, { headers: H(owner) }).then((r) => r.json());
ck('a level listing omits nested documents', !level.some((d) => d.id === child.id));
ck('a flat listing includes them', flat.some((d) => d.id === child.id) && flat.some((d) => d.id === parent.id));
ck('flat rows still say where they sit', flat.find((d) => d.id === child.id)?.parentId === parent.id);
ck('a flat listing is still gated by visibility', !flat.some((d) => d.id === strangerDoc.id));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
