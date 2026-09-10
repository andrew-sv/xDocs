import { getRequestListener } from '@hono/node-server';
import { Server } from '@hocuspocus/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import {
  allowPasswordLogin,
  allowlistEnabled,
  auth,
  disableSignUp,
  googleConfigured,
  isAllowedEmail,
} from './auth.js';
import { collabConfiguration } from './collab.js';
import { documentsRoute } from './routes/documents.js';

/** Set by the session guard so routes know who is asking. */
type Variables = { userId: string; email: string };

const app = new Hono<{ Variables: Variables }>()
  .use('*', logger())
  .use(
    '/api/*',
    cors({
      origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
      // Explicit origin is required once credentials are allowed.
      credentials: true,
      allowHeaders: ['content-type', 'authorization'],
      exposeHeaders: ['set-auth-token'],
    }),
  )
  // Health stays public so a platform healthcheck works without a session.
  .get('/health', (c) => c.json({ ok: true }))
  // Better Auth owns sign-in, callbacks and sign-out. Mounted BEFORE the guard,
  // since signing in obviously cannot require already being signed in.
  .all('/api/auth/*', (c) => auth.handler(c.req.raw))
  // Everything else needs a session.
  .use('/api/*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    // 403, not 401: the session is genuine, the account simply is not allowed.
    // The client tells them apart to show a useful message.
    if (!isAllowedEmail(session.user.email)) {
      return c.json({ error: 'This account is not authorised for xDocs.' }, 403);
    }
    c.set('userId', session.user.id);
    c.set('email', session.user.email);
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
  console.log(
    `[auth]   google=${googleConfigured ? 'on' : 'OFF'} password=${allowPasswordLogin ? 'on' : 'off'} signup=${disableSignUp ? 'CLOSED' : 'open'} allowlist=${allowlistEnabled ? 'on' : 'off'}`,
  );
  if (!googleConfigured && !allowPasswordLogin) {
    console.warn('[auth]   no sign-in method configured — nobody can get in');
  }
});

export type AppType = typeof app;
