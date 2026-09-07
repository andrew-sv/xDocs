import { getRequestListener } from '@hono/node-server';
import { Server } from '@hocuspocus/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authEnabled, isValidToken } from './auth.js';
import { collabConfiguration } from './collab.js';
import { documentsRoute } from './routes/documents.js';

const app = new Hono()
  .use('*', logger())
  .use('/api/*', cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }))
  // Health stays public so a platform healthcheck works without the secret.
  .get('/health', (c) => c.json({ ok: true }))
  // After cors, so preflight is answered before anything can be rejected.
  .use('/api/*', async (c, next) => {
    if (!authEnabled) return next();
    const token = c.req.header('authorization')?.replace(/^Bearer /, '');
    if (!isValidToken(token)) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  })
  .route('/api/documents', documentsRoute);

const handleHttp = getRequestListener(app.fetch);

// PORT is what hosting platforms inject; API_PORT stays for local overrides.
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);

/*
 * One server for both protocols. Hocuspocus owns it because it needs control of
 * the websocket upgrade, and plain HTTP is handed to Hono from onRequest — so
 * REST and collaboration share a port, an origin and a single deployed service.
 */
const server = new Server({
  port,
  ...collabConfiguration,

  onRequest: async ({ request, response }) => {
    handleHttp(request, response);
    // Hocuspocus's requestHandler rethrows only TRUTHY errors, so rejecting
    // with null means "already handled" and suppresses its default response.
    return Promise.reject(null);
  },
});

void server.listen().then(() => {
  console.log(`[api]    http://localhost:${port}`);
  console.log(`[collab] ws://localhost:${port}`);
  if (!authEnabled) console.warn('[auth]   ACCESS_PASSWORD unset — API and collab are OPEN');
});

export type AppType = typeof app;
