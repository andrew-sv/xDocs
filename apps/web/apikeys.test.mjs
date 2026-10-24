/**
 * API keys: a credential for scripts, acting as its owner.
 *
 * The security properties are the point here — a key must not be able to mint
 * more keys, must stop working the moment it is revoked, must not be readable
 * back out of the database, and must see exactly what its owner sees and
 * nothing more.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeaders, createDisposableUser, signInForTests } from './test-auth.mjs';
import { trackCreatedDocuments } from './test-cleanup.mjs';

// Everything this suite creates is purged when it ends; see test-cleanup.mjs.
const tracker = trackCreatedDocuments();

const API = 'http://localhost:3001';
let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

const owner = await signInForTests(API);
const stranger = await createDisposableUser(API);
const H = (t, extra) => authHeaders(t, extra);
const keyHeaders = (key, extra = {}) => ({
  authorization: `Bearer ${key}`,
  origin: 'http://localhost:5173',
  ...extra,
});

const createKey = (token, name) =>
  fetch(`${API}/api/keys`, {
    method: 'POST',
    headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ name }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// --- creation ---------------------------------------------------------------
const created = await createKey(owner, 'integration test key');
ck('a key is created', created.status === 201);
const key = created.body?.key;
ck('the response carries the key itself, once', typeof key === 'string' && key.startsWith('xdk_'));
ck(
  'and a prefix for identifying it later',
  typeof created.body?.prefix === 'string' && key.startsWith(created.body.prefix),
);

const listed = await fetch(`${API}/api/keys`, { headers: H(owner) }).then((r) => r.json());
const row = listed.find((k) => k.id === created.body.id);
ck('it appears in the list', Boolean(row));
ck('the list never returns the key', !JSON.stringify(listed).includes(key));

// --- the key works as its owner ---------------------------------------------
const viaKey = await fetch(`${API}/api/documents`, { headers: keyHeaders(key) });
ck('the key authenticates REST requests', viaKey.status === 200);

const madeByKey = await fetch(`${API}/api/documents`, {
  method: 'POST',
  headers: keyHeaders(key, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Made by a script' }),
}).then((r) => r.json());
ck('a document can be created with a key', typeof madeByKey.id === 'string');

const ownerSees = await fetch(`${API}/api/documents/${madeByKey.id}`, { headers: H(owner) });
ck('and it belongs to the key owner', ownerSees.status === 200);

// --- it sees exactly what its owner sees ------------------------------------
const strangerDoc = await fetch(`${API}/api/documents`, {
  method: 'POST',
  headers: H(stranger.token, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Private to a stranger' }),
}).then((r) => r.json());
ck(
  'a key cannot reach a document its owner cannot',
  (await fetch(`${API}/api/documents/${strangerDoc.id}`, { headers: keyHeaders(key) })).status ===
    404,
);

// --- a key cannot manage keys ------------------------------------------------
const mintedByKey = await fetch(`${API}/api/keys`, {
  method: 'POST',
  headers: keyHeaders(key, { 'content-type': 'application/json' }),
  body: JSON.stringify({ name: 'escalation' }),
});
ck('a key cannot mint another key (403)', mintedByKey.status === 403);
ck(
  'a key cannot even list keys (403)',
  (await fetch(`${API}/api/keys`, { headers: keyHeaders(key) })).status === 403,
);
ck(
  'a key cannot revoke a key',
  (
    await fetch(`${API}/api/keys/${created.body.id}`, {
      method: 'DELETE',
      headers: keyHeaders(key),
    })
  ).status === 403,
);

// --- forged and foreign keys -------------------------------------------------
ck(
  'a forged key is refused',
  (await fetch(`${API}/api/documents`, { headers: keyHeaders('xdk_not-a-real-key') })).status ===
    401,
);
ck(
  "a stranger cannot revoke someone else's key",
  (
    await fetch(`${API}/api/keys/${created.body.id}`, {
      method: 'DELETE',
      headers: H(stranger.token),
    })
  ).status === 404,
);

// --- last_used_at is written at most once a minute (#66) --------------------
// A key of its own, so no other request in this suite moves its timestamp.
const usage = await createKey(owner, 'last-used test key');
const usageKey = usage.body.key;
const lastUsedAt = async () =>
  (await fetch(`${API}/api/keys`, { headers: H(owner) }).then((r) => r.json())).find(
    (k) => k.id === usage.body.id,
  )?.lastUsedAt;
// The write is fire-and-forget, so the response can arrive before it lands.
const settle = async (until) => {
  for (let i = 0; i < 20; i++) {
    const v = await lastUsedAt();
    if (until(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return lastUsedAt();
};

ck('a fresh key has never been used', usage.body.lastUsedAt === null);
await fetch(`${API}/api/documents`, { headers: keyHeaders(usageKey) });
const firstUse = await settle((v) => v != null);
ck('its first use sets last_used_at', typeof firstUse === 'string');

await fetch(`${API}/api/documents`, { headers: keyHeaders(usageKey) });
// A negative: there is nothing to wait FOR, so give a write that should not
// happen the same two seconds the positive above was allowed.
const secondUse = await settle((v) => v !== firstUse);
ck('an immediate second use does not rewrite it', secondUse === firstUse);

// The stale path, without waiting out the minute: age the row in the database,
// which is what a minute passing does to it, and use the key again.
const require = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), '../api/package.json'),
);
const pg = require('pg');
if (!process.env.DATABASE_URL) {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'));
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const aged = await db.query(
  `UPDATE api_keys SET last_used_at = now() - interval '1 hour' WHERE id = $1 RETURNING last_used_at`,
  [usage.body.id],
);
await db.end();
const agedAt = aged.rows[0].last_used_at.toISOString();
await fetch(`${API}/api/documents`, { headers: keyHeaders(usageKey) });
const staleUse = await settle((v) => v !== agedAt);
ck(
  'a use after it has gone stale rewrites it',
  typeof staleUse === 'string' && Date.parse(staleUse) > Date.parse(firstUse),
);
await fetch(`${API}/api/keys/${usage.body.id}`, { method: 'DELETE', headers: H(owner) });

// --- revocation --------------------------------------------------------------
const revoked = await fetch(`${API}/api/keys/${created.body.id}`, {
  method: 'DELETE',
  headers: H(owner),
});
ck('the owner can revoke it', revoked.status === 204);
ck(
  'a revoked key stops working immediately',
  (await fetch(`${API}/api/documents`, { headers: keyHeaders(key) })).status === 401,
);
ck(
  'and disappears from the list',
  !(await fetch(`${API}/api/keys`, { headers: H(owner) }).then((r) => r.json())).some(
    (k) => k.id === created.body.id,
  ),
);
ck(
  'revoking twice is a 404, not a silent success',
  (await fetch(`${API}/api/keys/${created.body.id}`, { method: 'DELETE', headers: H(owner) }))
    .status === 404,
);

// --- flat listing, for callers with no sidebar -------------------------------
const parent = await fetch(`${API}/api/documents`, {
  method: 'POST',
  headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Flat parent' }),
}).then((r) => r.json());
const child = await fetch(`${API}/api/documents`, {
  method: 'POST',
  headers: H(owner, { 'content-type': 'application/json' }),
  body: JSON.stringify({ title: 'Flat child', parentId: parent.id }),
}).then((r) => r.json());

const level = await fetch(`${API}/api/documents`, { headers: H(owner) }).then((r) => r.json());
const flat = await fetch(`${API}/api/documents?flat=1`, { headers: H(owner) }).then((r) =>
  r.json(),
);
ck('a level listing omits nested documents', !level.some((d) => d.id === child.id));
ck(
  'a flat listing includes them',
  flat.some((d) => d.id === child.id) && flat.some((d) => d.id === parent.id),
);
ck(
  'flat rows still say where they sit',
  flat.find((d) => d.id === child.id)?.parentId === parent.id,
);
ck('a flat listing is still gated by visibility', !flat.some((d) => d.id === strangerDoc.id));

await tracker.purge();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
