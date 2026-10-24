import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as authSchema from './auth-schema.js';
import * as documentSchema from './schema.js';

// One schema object: Drizzle relations and the Better Auth adapter both need
// every table visible in the same place.
const schema = { ...documentSchema, ...authSchema };

// A long-lived Node process, so a TCP pool beats the neon-http driver:
// real transactions and clean bytea round-trips for the Yjs payloads.
let pool: pg.Pool | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!dbInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set — run `vercel env pull .env.local`');
    pool = new pg.Pool({ connectionString: url, max: 10 });
    /*
     * An idle client the server drops — Neon does on compute suspend, restart
     * or idle timeout — emits 'error' on the pool, and an EventEmitter with no
     * listener throws it: the whole process exits, taking every editor and any
     * change still inside the store debounce with it (#81). The pool has
     * already discarded that client and connects afresh on the next checkout,
     * so logging is all there is to do. Errors on a checked-out client still
     * reject the query that was using it.
     */
    pool.on('error', (error) => {
      console.error(`database: idle client dropped (${error.message})`);
    });
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
  dbInstance = null;
}

/**
 * The rows of a `db.execute(sql...)` result. Drizzle types a raw execute
 * loosely, but with the node-postgres driver it resolves to pg's QueryResult,
 * whose rows sit under `.rows` — this is the one place that shape is assumed,
 * instead of a cast repeated at every raw query (#71). The caller names the
 * row type; nothing checks it, so it must match the SELECT list.
 */
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? [];
}

export { schema };
