/**
 * Post-deploy smoke test.
 *
 * Staging has no non-Google way in, so this deliberately covers the NEGATIVE
 * path only: that the deployment is up and that nothing reaches data without a
 * session. The signed-in path is covered by the browser suite in CI, which runs
 * against a local stack with the password provider enabled.
 *
 *   node smoke.mjs https://xdocs-api.example.com
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('usage: node smoke.mjs <base-url>');
  process.exit(2);
}
const WS = baseUrl.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

// --- the deployment is alive -------------------------------------------------
const health = await fetch(`${baseUrl}/health`);
ck('health is public', health.status === 200);
ck('health reports ok', (await health.json())?.ok === true);

// --- nothing reaches data without a session ---------------------------------
ck('unauthenticated list is 401', (await fetch(`${baseUrl}/api/documents`)).status === 401);
ck(
  'a forged bearer token is 401',
  (await fetch(`${baseUrl}/api/documents`, { headers: { authorization: 'Bearer forged' } }))
    .status === 401,
);
ck(
  'unauthenticated create is 401',
  (
    await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'should not exist' }),
    })
  ).status === 401,
);

// --- sign-in is actually reachable ------------------------------------------
// 404 here would mean the auth routes never mounted, which no other check sees.
const authRoute = await fetch(`${baseUrl}/api/auth/sign-in/social`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: baseUrl },
  body: JSON.stringify({}),
});
ck('auth routes are mounted', authRoute.status !== 404);

// --- the websocket refuses an unauthenticated client ------------------------
function connect(token) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: WS,
    name: 'doc:00000000-0000-0000-0000-000000000000',
    document: doc,
    token: token ?? '',
    onAuthenticationFailed: () => {},
  });
  return provider;
}

const provider = connect('forged-session-token');
const refused = await Promise.race([
  new Promise((res) => provider.on('authenticationFailed', () => res(true))),
  new Promise((res) => provider.on('close', () => res(true))),
  new Promise((res) => provider.on('synced', () => res(false))),
  sleep(8000).then(() => 'timeout'),
]);
ck('websocket refuses a forged session', refused === true);
provider.destroy();

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
