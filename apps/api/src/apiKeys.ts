import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from './db/index.js';
import { apiKeys } from './db/schema.js';
import { user } from './db/auth-schema.js';
import { isAllowedEmail } from './auth.js';

/** Distinguishes a key from a session token at a glance, in logs and in code. */
export const API_KEY_PREFIX = 'xdk_';

/** Length of the shown-in-lists prefix, including `xdk_`. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

/**
 * How stale `last_used_at` may get before a request rewrites it (#66).
 *
 * Writing it on every request turned a burst of MCP reads into a burst of row
 * updates on Neon, for a value nothing reads more precisely than "today" (the
 * keys dialog shows a date). A minute still answers "is this key in use right
 * now" and caps the writes at one per key per minute, however busy the key is.
 */
export const LAST_USED_RESOLUTION_SECONDS = 60;

export function isApiKey(token: string | undefined | null): boolean {
  return typeof token === 'string' && token.startsWith(API_KEY_PREFIX);
}

/** SHA-256 is right here: the input is 256 bits of entropy, not a password. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

export type ApiKeyIdentity = { userId: string; email: string; keyId: string };

/**
 * Resolve a raw key to the user it acts as, or null.
 *
 * The lookup is by hash, so the key never has to be compared in the clear, and
 * the constant-time compare afterwards keeps a wrong-but-close key from being
 * distinguishable by timing.
 *
 * The allowlist is applied here for the same reason it is applied at session
 * resolution: a credential being valid is not the same as its owner being
 * allowed in, and a key must not outlive its owner's access.
 */
export async function identityFromApiKey(token: string): Promise<ApiKeyIdentity | null> {
  const hash = hashApiKey(token);
  const [row] = await getDb()
    .select({
      id: apiKeys.id,
      hash: apiKeys.hash,
      userId: apiKeys.userId,
      email: user.email,
    })
    .from(apiKeys)
    .innerJoin(user, eq(user.id, apiKeys.userId))
    .where(and(eq(apiKeys.hash, hash), isNull(apiKeys.revokedAt)));

  if (!row) return null;
  const given = Buffer.from(hash);
  const stored = Buffer.from(row.hash);
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
  if (!isAllowedEmail(row.email)) return null;

  // Fire-and-forget: knowing when a key was last used must never be able to
  // fail a request that was otherwise fine.
  //
  // The staleness test is in the statement rather than read first, so it stays
  // one round trip and two requests racing cannot both decide to write (#66).
  // Both sides use the database's now(), not this process's clock: comparing
  // the two would make the throttle depend on clock skew.
  void getDb()
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(
          isNull(apiKeys.lastUsedAt),
          lt(
            apiKeys.lastUsedAt,
            sql`now() - make_interval(secs => ${LAST_USED_RESOLUTION_SECONDS})`,
          ),
        ),
      ),
    )
    .catch(() => {});

  return { userId: row.userId, email: row.email, keyId: row.id };
}
