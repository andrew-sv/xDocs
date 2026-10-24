/**
 * Apply the version retention policy (#63) to history that already exists.
 *
 * The store hook prunes a document's history each time it archives a new
 * automatic version, so anything edited after the policy shipped keeps itself
 * in shape. History saved before then stays as it was until its document is
 * next edited — for a document nobody touches again, forever. This catches
 * those up once. Running it again is harmless: the rule is stable, so a second
 * pass over pruned history deletes nothing.
 *
 * The rule is `versionsToPrune` in src/retention.ts, imported rather than
 * restated, so this and the store hook cannot disagree about what to keep.
 *
 *   pnpm --filter @xdocs/api prune:versions
 *   pnpm --filter @xdocs/api prune:versions --dry-run
 *   pnpm --filter @xdocs/api prune:versions --document <id> [--document <id>]
 *
 * --dry-run does all of it inside a transaction and rolls it back, so the
 * counts it prints are the real ones rather than an estimate. --document
 * limits it to the documents named.
 *
 * Unlike cleanup:test-users this is meant for staging too, so it has no
 * ALLOW_PASSWORD_LOGIN guard: it deletes only what the running API would
 * delete at that document's next edit.
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { versionsToPrune } from '../src/retention.ts';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    document: { type: 'string', multiple: true },
  },
});

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// No pool.on('error') here, unlike the API (#81): a dropped connection ending
// this short, operator-run script loudly is the right outcome: its one
// transaction dies with the connection, and running it again is safe.
const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  // One clock for the whole run, so every document is judged against the same "now".
  const now = new Date();

  const only = values.document ?? null;
  const { rows: documents } = await client.query(
    `SELECT DISTINCT document_id FROM document_versions
      WHERE $1::uuid[] IS NULL OR document_id = ANY($1::uuid[])`,
    [only],
  );

  let examined = 0;
  let deleted = 0;
  let bytes = 0;
  for (const { document_id: documentId } of documents) {
    // Metadata only: the rule never needs the Yjs payload.
    const { rows: versions } = await client.query(
      `SELECT id, reason, saved_at AS "savedAt", created_at AS "createdAt"
         FROM document_versions WHERE document_id = $1`,
      [documentId],
    );
    examined += versions.length;
    const doomed = versionsToPrune(versions, now);
    if (doomed.length === 0) continue;
    const result = await client.query(
      `DELETE FROM document_versions WHERE document_id = $1 AND id = ANY($2::uuid[])
       RETURNING octet_length(ystate) AS size`,
      [documentId, doomed],
    );
    deleted += result.rowCount;
    for (const row of result.rows) bytes += Number(row.size);
  }

  await client.query(values['dry-run'] ? 'ROLLBACK' : 'COMMIT');

  const verb = values['dry-run'] ? 'would delete' : 'deleted';
  console.log(
    `${verb} ${deleted} of ${examined} version(s) across ${documents.length} document(s), ` +
      `${(bytes / 1024 / 1024).toFixed(1)} MB of Yjs state`,
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
