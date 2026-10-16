/**
 * The storage quota holds when uploads arrive together (#65).
 *
 * The check and the insert used to be two statements, so uploads sent at once
 * all read the same total, all passed, and together went past the quota.
 *
 * Provoking that over HTTP needs a user within one file of the limit, which
 * against the real 200 MB quota means storing ~190 MB first. So this suite
 * starts its OWN API on another port with a 1 MB quota, against the same
 * database — the same reason quota.test.mjs is pure logic, solved the other
 * way. It runs beside the other suites because it talks only to that server
 * and uses a fresh user, whose total nothing else can move.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeaders, createDisposableUser } from './test-auth.mjs';
import { trackCreatedDocuments } from './test-cleanup.mjs';

const tracker = trackCreatedDocuments();

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

const KB = 1024;
const QUOTA = 1024 * KB;
const PORT = 3011;
const API = `http://localhost:${PORT}`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiDir = resolve(root, 'apps/api');
// dotenv-cli does not override variables already set, so PORT and the quota
// below win over anything in .env.local.
const server = spawn(
  resolve(apiDir, 'node_modules/.bin/dotenv'),
  [
    '-e',
    resolve(root, '.env.local'),
    '--',
    resolve(apiDir, 'node_modules/.bin/tsx'),
    'src/server.ts',
  ],
  {
    cwd: apiDir,
    env: { ...process.env, PORT: String(PORT), ATTACHMENT_QUOTA_BYTES: String(QUOTA) },
    stdio: ['ignore', 'ignore', 'inherit'],
  },
);

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`API exited with ${server.exitCode}`);
    const ok = await fetch(`${API}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API on :${PORT} did not become healthy`);
}

try {
  await waitForHealth();

  const token = (await createDisposableUser(API)).token;
  const H = (extra) => authHeaders(token, extra);
  const usage = () => fetch(`${API}/api/attachments/usage`, { headers: H() }).then((r) => r.json());

  ck('the server runs with the small quota', (await usage()).quotaBytes === QUOTA);

  const doc = await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ title: 'Quota race' }),
  }).then((r) => r.json());

  const upload = (name) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(400 * KB)]), name);
    return fetch(`${API}/api/documents/${doc.id}/attachments`, {
      method: 'POST',
      headers: H(),
      body: form,
    }).then((r) => r.status);
  };

  // Two 400 KB files fit in 1 MB; a third does not. Sent all at once, the old
  // code let every one of them through.
  const statuses = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => upload(`${n}.bin`)));
  const accepted = statuses.filter((s) => s === 201).length;
  const refused = statuses.filter((s) => s === 413).length;
  const used = (await usage()).usedBytes;

  ck(`exactly two of six concurrent uploads are accepted (got ${accepted})`, accepted === 2);
  ck(`and the other four refused with 413 (got ${refused})`, refused === 4);
  ck(`usage never passes the quota (${used} of ${QUOTA})`, used <= QUOTA);
  ck('and is exactly what was accepted', used === accepted * 400 * KB);

  // Sequentially, as before the fix: the lock must not stop a later upload
  // that does fit.
  const small = new FormData();
  small.append('file', new Blob([new Uint8Array(100 * KB)]), 'small.bin');
  const after = await fetch(`${API}/api/documents/${doc.id}/attachments`, {
    method: 'POST',
    headers: H(),
    body: small,
  });
  ck('a later upload that fits is still accepted', after.status === 201);
} finally {
  await tracker.purge();
  server.kill();
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
