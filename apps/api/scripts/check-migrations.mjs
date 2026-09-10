/**
 * Refuse to deploy a destructive migration without a deliberate decision.
 *
 * Adding a column is recoverable; dropping one from the table holding every
 * document's Yjs state is not. CD runs this before applying anything, so a
 * careless schema edit fails the pipeline instead of the database.
 *
 * Only PENDING migrations are inspected: a destructive change that has already
 * been applied must not block every future deploy. Drizzle records applied
 * migrations by the SHA-256 of the .sql file, which is what lets us tell them
 * apart without re-deriving its internals.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = new URL('../drizzle/', import.meta.url).pathname;
const DESTRUCTIVE = /\b(DROP\s+TABLE|DROP\s+COLUMN|DROP\s+SCHEMA|TRUNCATE)\b/i;

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_UNPOOLED (or DATABASE_URL) is required');
  process.exit(2);
}

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();

let applied = new Set();
try {
  const { rows } = await client.query('select hash from drizzle.__drizzle_migrations');
  applied = new Set(rows.map((r) => r.hash));
} catch {
  // No journal yet: every migration is pending, which is the correct reading
  // for a fresh database.
}
await client.end();

const problems = [];
for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  if (applied.has(hash)) continue;

  const lines = sql.split('\n').filter((line) => DESTRUCTIVE.test(line));
  if (lines.length > 0) problems.push({ file, lines });
}

if (problems.length === 0) {
  const pending = files.length - applied.size;
  console.log(`migration check ok — ${pending} pending, none destructive`);
  process.exit(0);
}

console.error('Refusing to deploy: pending migrations contain destructive statements.\n');
for (const { file, lines } of problems) {
  console.error(`  ${file}`);
  for (const line of lines) console.error(`    ${line.trim()}`);
}
console.error(`
This is deliberately a hard stop. Dropping a column or table cannot be undone,
and this database holds every document's content.

If it is genuinely intended, apply it yourself against the target database and
redeploy — CD will then see it as already applied and continue.
`);
process.exit(1);
