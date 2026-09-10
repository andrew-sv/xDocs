import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { getDb, schema } from './db/index.js';

/**
 * Password login exists only for automation.
 *
 * Google OAuth cannot be driven in CI and the runners hold no Google
 * credentials, so tests sign in with a seeded email/password user. This is
 * enabled in local dev and CI and deliberately absent in staging, where Google
 * is the only way in.
 */
export const allowPasswordLogin = process.env.ALLOW_PASSWORD_LOGIN === 'true';

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
export const googleConfigured = Boolean(googleClientId && googleClientSecret);

/** Where the SPA lives — also the origin Better Auth will accept redirects for. */
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

export const auth = betterAuth({
  // Used to build the OAuth callback URL Google is told to return to, so it
  // must match the redirect URI registered in the Google console exactly.
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(getDb(), { provider: 'pg', schema }),
  trustedOrigins: [webOrigin],

  /*
   * Bearer tokens rather than cookies.
   *
   * The SPA is on vercel.app and this API on railway.app — different
   * registrable domains, so a session cookie would be third-party: blocked by
   * default in Safari and being phased out in Chrome. A bearer token sidesteps
   * that, and doubles as the credential for the collab websocket, which
   * authenticates with a token rather than cookies.
   */
  plugins: [bearer()],

  socialProviders: googleConfigured
    ? { google: { clientId: googleClientId!, clientSecret: googleClientSecret! } }
    : {},

  emailAndPassword: { enabled: allowPasswordLogin },
});

export type Session = typeof auth.$Infer.Session;

/**
 * Allowlist of addresses permitted to sign in.
 *
 * Unset means no restriction, which is what local dev and CI rely on — their
 * test users have made-up addresses. Staging sets it, so a Google account being
 * valid is not the same as being allowed in.
 */
const allowedEmails = new Set(
  (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);

export const allowlistEnabled = allowedEmails.size > 0;

export function isAllowedEmail(email: string | undefined | null): boolean {
  if (!allowlistEnabled) return true;
  return Boolean(email && allowedEmails.has(email.toLowerCase()));
}

/**
 * Enforced where it counts: at session resolution, so it applies to every
 * provider and to sessions that already existed when the list changed. A
 * blocked user may hold a valid Better Auth session and still reach nothing.
 */

/**
 * Resolve a session from a raw bearer token — used by the collab server, which
 * receives a token from the websocket handshake rather than an HTTP request.
 */
export async function sessionFromToken(token: string | undefined | null) {
  if (!token) return null;
  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
  if (!session || !isAllowedEmail(session.user.email)) return null;
  return session;
}
