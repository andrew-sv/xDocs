/**
 * Populate `documents.content_text` for documents saved before it existed.
 *
 * The column is a mirror written by the collab store hook, so it fills in
 * naturally — but only when someone opens a document and edits it. Without a
 * backfill, search would silently miss every existing document until then,
 * which reads as "search is broken" rather than "search is new".
 *
 * Safe to re-run: it only touches rows whose mirror is missing, and it never
 * writes `ystate`.
 *
 *   pnpm --filter @xdocs/api backfill:search
 */
import { Pool } from 'pg';
import * as Y from 'yjs';
import { readContentText } from '../src/contentText.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const { rows } = await pool.query(
  `SELECT id, ystate FROM documents WHERE content_text IS NULL AND ystate IS NOT NULL`,
);
console.log(`${rows.length} document(s) without a content mirror`);

let written = 0;
let empty = 0;
let failed = 0;

for (const row of rows) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(row.ystate));
    const text = readContentText(doc);
    // Write even when empty: an empty document HAS no text, and leaving it null
    // would make every re-run decode it again.
    await pool.query(`UPDATE documents SET content_text = $1 WHERE id = $2`, [text, row.id]);
    if (text.length === 0) empty += 1;
    else written += 1;
  } catch (error) {
    failed += 1;
    console.warn(`skipped ${row.id}: ${error instanceof Error ? error.message : error}`);
  } finally {
    doc.destroy();
  }
}

console.log(`backfilled ${written} with text, ${empty} empty, ${failed} unreadable`);
await pool.end();
