import { timingSafeEqual } from 'node:crypto';

/**
 * Shared-password gate for staging.
 *
 * When ACCESS_PASSWORD is unset the gate is disabled entirely, so local
 * development and the whole test suite run unauthenticated and unchanged.
 * Only a deployed environment sets it.
 *
 * This is a gate, not authentication: everyone who logs in holds the same
 * secret and can read it out of devtools. It keeps a staging URL from being
 * world-writable; it is not a substitute for real accounts.
 */
const configured = process.env.ACCESS_PASSWORD?.trim();

export const accessPassword: string | null = configured ? configured : null;
export const authEnabled = accessPassword !== null;

/** Constant-time compare, so the endpoint does not leak the secret's prefix. */
export function isValidToken(token: string | undefined | null): boolean {
  if (!authEnabled) return true;
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(accessPassword!);
  // timingSafeEqual throws on length mismatch, so compare lengths first — the
  // length of the secret is not the part worth protecting.
  return a.length === b.length && timingSafeEqual(a, b);
}
