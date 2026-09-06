import { defineConfig } from 'drizzle-kit';

// Migrations use the DIRECT (unpooled) Neon URL — the pooler does not support
// the session-level statements drizzle-kit issues.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!,
  },
});
