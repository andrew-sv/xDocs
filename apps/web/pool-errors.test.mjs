/**
 * A database connection dropped under the API does not crash it (#81).
 *
 * When the server ends an idle pooled client — Neon does on compute suspend,
 * restart or idle timeout — `pg` emits 'error' on the pool, and with no
 * listener that is thrown and the process exits.
 *
 * Provoking it means terminating the API's backends, and the shared dev stack
 * and every other suite use the same database. So this suite starts its OWN
 * API on :3012 under an application_name unique to this run, and terminates
 * only backends carrying exactly that name: nobody else's connection can match.
 * It connects directly rather than through Neon's pooler, because behind the
 * pooler pg_stat_activity shows the pooler's connections, not the API's, and
 * ending one of those would not reach the API's socket at all.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const PORT = 3012;
const API = `http://localhost:${PORT}`;
const APP_NAME = `xdocs-pool-errors-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiDir = resolve(root, 'apps/api');
// pg is the API's dependency, not this package's.
const pg = createRequire(resolve(apiDir, 'package.json'))('pg');

/** What dotenv-cli would give the API, read here so the test can connect too. */
function envLocal() {
  const vars = {};
  for (const line of readFileSync(resolve(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (match) vars[match[1]] = match[2];
  }
  return { ...vars, ...process.env };
}
const env = envLocal();
// CI has one local Postgres and only DATABASE_URL; Neon dev has both.
const direct = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;

// dotenv-cli does not override variables already set, so these win over
// .env.local. pg reads PGAPPNAME for application_name.
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
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: direct, PGAPPNAME: APP_NAME },
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

const admin = new pg.Client({ connectionString: direct });

try {
  await waitForHealth();
  await admin.connect();

  const token = (await createDisposableUser(API)).token;
  const H = (extra) => authHeaders(token, extra);

  const doc = await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ title: 'Pool errors' }),
  }).then((r) => r.json());
  const read = () => fetch(`${API}/api/documents/${doc.id}`, { headers: H() });
  ck('the document reads before anything is dropped', (await read()).status === 200);

  // The requests are answered, so the API's clients are back in the pool and
  // idle — exactly the state Neon drops them in. Exact name, never a pattern:
  // this database is shared.
  const { rows } = await admin.query(
    `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
      WHERE application_name = $1 AND pid <> pg_backend_pid()`,
    [APP_NAME],
  );
  ck(
    `the API's own idle connections are terminated (${rows.length})`,
    rows.length > 0 && rows.every((r) => r.ended),
  );

  // Long enough for the dropped sockets to reach the API and, without a
  // handler, for the process to exit.
  await new Promise((r) => setTimeout(r, 1500));
  ck(`the API is still running (exit code ${server.exitCode})`, server.exitCode === null);

  const health = await fetch(`${API}/health`).then(
    (r) => r.ok,
    () => false,
  );
  ck('it still answers /health', health);
  // Authenticated, so the session lookup and the read both need a fresh client.
  const after = await read().then(
    (r) => r.status,
    (e) => e.message,
  );
  ck(`and a document read on new connections (${after})`, after === 200);
} finally {
  await admin.end().catch(() => {});
  await tracker.purge().catch((e) => console.log(`purge failed: ${e.message}`));
  server.kill();
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
