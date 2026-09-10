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
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
  dbInstance = null;
}

export { schema };
