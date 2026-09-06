import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { documentsRoute } from './routes/documents.js';

const app = new Hono()
  .use('*', logger())
  .use('/api/*', cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }))
  .get('/health', (c) => c.json({ ok: true }))
  .route('/api/documents', documentsRoute);

const port = Number(process.env.API_PORT ?? 3001);
serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`[api]    http://localhost:${port}`);
});

export type AppType = typeof app;
