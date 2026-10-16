/**
 * Delete the disposable users the test suites leave behind (#30).
 *
 * Every run of the e2e and integration suites signs up fresh
 * `disposable-<timestamp>-<random>@xdocs.test` users (`createDisposableUser`
 * in apps/web/test-auth.mjs), and nothing else removes them. Deleting a user
 * cascades to its sessions, accounts and API keys through their FKs.
 *
 * Documents do NOT cascade: `documents.created_by` is ON DELETE SET NULL, so
 * deleting the user alone would leave its documents ownerless — private ones
 * then reachable by nobody. So they are deleted first, attachments going with
 * them through their own cascade. A sub-document someone ELSE owns under one of
 * them is moved to the top level rather than deleted: `parent_id` has no FK,
 * and a child pointing at a row that no longer exists is unreachable too.
 *
 * Only users older than the cutoff are touched, so a test run in progress
 * keeps its accounts. It refuses to run unless ALLOW_PASSWORD_LOGIN=true —
 * staging never sets it, and disposable users cannot exist without it.
 *
 *   pnpm --filter @xdocs/api cleanup:test-users                  # older than 24h
 *   pnpm --filter @xdocs/api cleanup:test-users --older-than 1   # hours
 *   pnpm --filter @xdocs/api cleanup:test-users --dry-run
 *
 * --dry-run does all of it inside a transaction and rolls it back, so the
 * counts it prints are the real ones rather than an estimate.
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';

const { values } = parseArgs({
  options: {
    'older-than': { type: 'string', default: '24' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const hours = Number(values['older-than']);
if (!Number.isFinite(hours) || hours < 0) {
  console.error(`--older-than takes a number of hours, got "${values['older-than']}"`);
  process.exit(2);
}

if (process.env.ALLOW_PASSWORD_LOGIN !== 'true') {
  console.error(
    'refusing to run: ALLOW_PASSWORD_LOGIN is not "true", so this does not look like a dev or test database',
  );
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const { rows: victims } = await client.query(
    `SELECT id FROM "user"
      WHERE email LIKE 'disposable-%@xdocs.test'
        AND created_at < now() - make_interval(secs => $1)`,
    [hours * 3600],
  );
  const ids = victims.map((row) => row.id);

  const reparented = await client.query(
    `UPDATE documents SET parent_id = NULL
      WHERE parent_id IN (SELECT id FROM documents WHERE created_by = ANY($1))
        AND (created_by IS NULL OR NOT (created_by = ANY($1)))`,
    [ids],
  );
  const documents = await client.query(`DELETE FROM documents WHERE created_by = ANY($1)`, [ids]);
  await client.query(`DELETE FROM "user" WHERE id = ANY($1)`, [ids]);

  const {
    rows: [{ count: ownerless }],
  } = await client.query(`SELECT count(*)::int AS count FROM documents WHERE created_by IS NULL`);

  await client.query(values['dry-run'] ? 'ROLLBACK' : 'COMMIT');

  const verb = values['dry-run'] ? 'would delete' : 'deleted';
  console.log(
    `${verb} ${ids.length} disposable user(s) older than ${hours}h and ${documents.rowCount} of their document(s)`,
  );
  if (reparented.rowCount > 0) {
    console.log(`moved ${reparented.rowCount} sub-document(s) owned by others to the top level`);
  }
  /*
   * Reported, not deleted: these predate this script — rows from before
   * authentication, or users removed some other way — and nothing here says
   * they are test data.
   */
  if (ownerless > 0) console.log(`note: ${ownerless} ownerless document(s) exist, untouched`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
