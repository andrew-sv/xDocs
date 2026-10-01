import { getRequestListener } from '@hono/node-server';
import { Server } from '@hocuspocus/server';
import { ACCOUNT_NOT_ALLOWED } from '@xdocs/shared';
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
import { identityFromApiKey, isApiKey } from './apiKeys.js';
import { collabConfiguration, setCollabServer } from './collab.js';
import { attachmentsRoute } from './routes/attachments.js';
import { documentsRoute } from './routes/documents.js';
import { keysRoute } from './routes/keys.js';
import { versionsRoute } from './routes/versions.js';

/**
 * Set by the guard so routes know who is asking, and how.
 *
 * `authMethod` exists because a few things must stay out of reach of a
 * machine credential — managing keys, above all.
 */
type Variables = { userId: string; email: string; authMethod: 'session' | 'api-key' };

const app = new Hono<{ Variables: Variables }>()
  .use('*', logger())
  .use(
    '/api/*',
    cors({
      origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
      // Explicit origin is required once credentials are allowed.
      credentials: true,
      allowHeaders: ['content-type', 'authorization'],
      // content-disposition carries an attachment's filename, which the SPA
      // reads when it saves a download it fetched itself.
      // x-list-as-of lets the sidebar order list responses (routes/documents.ts).
      exposeHeaders: ['set-auth-token', 'content-disposition', 'x-list-as-of'],
    }),
  )
  // Health stays public so a platform healthcheck works without a session.
  .get('/health', (c) => c.json({ ok: true }))
  // Better Auth owns sign-in, callbacks and sign-out. Mounted BEFORE the guard,
  // since signing in obviously cannot require already being signed in.
  .all('/api/auth/*', (c) => auth.handler(c.req.raw))
  // Everything else needs a session.
  .use('/api/*', async (c, next) => {
    /*
     * Two credentials, one guard.
     *
     * An API key is checked first and recognised by its prefix, so it never
     * reaches Better Auth — which would reject it anyway, but more slowly and
     * less clearly. Everything downstream sees the same userId either way, so
     * ownership and visibility rules need no notion of "a key did this".
     */
    const bearer = c.req.header('authorization')?.replace(/^Bearer /i, '');
    if (isApiKey(bearer)) {
      const identity = await identityFromApiKey(bearer!);
      if (!identity) return c.json({ error: 'Invalid or revoked API key' }, 401);
      c.set('userId', identity.userId);
      c.set('email', identity.email);
      c.set('authMethod', 'api-key');
      return next();
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    // 403, not 401: the session is genuine, the account simply is not allowed.
    // The client tells them apart to show a useful message. The code is what it
    // keys on — this is the only 403 that may end a session, so it is the only
    // one that carries it (#31).
    if (!isAllowedEmail(session.user.email)) {
      return c.json(
        { error: 'This account is not authorised for xDocs.', code: ACCOUNT_NOT_ALLOWED },
        403,
      );
    }
    c.set('userId', session.user.id);
    c.set('email', session.user.email);
    c.set('authMethod', 'session');
    return next();
  })
  .route('/api/documents', documentsRoute)
  // /documents/:id/versions — history (#49), its own module to keep that one sane.
  .route('/api/documents', versionsRoute)
  .route('/api/keys', keysRoute)
  // Spans two prefixes: uploads under /documents/:id, downloads by their own id.
  .route('/api', attachmentsRoute);

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

/*
 * Hand the running server to the collab module so REST routes can edit a
 * document through a direct connection rather than writing `ystate` behind the
 * editors' backs.
 */
setCollabServer(server);

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
