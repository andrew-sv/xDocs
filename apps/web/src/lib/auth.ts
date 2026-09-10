import { createAuthClient } from 'better-auth/react';

const STORAGE_KEY = 'xdocs.session-token';
const API_BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * Session token for the API and the collab socket.
 *
 * Bearer rather than cookie: the SPA and the API sit on different registrable
 * domains, so a session cookie would be third-party — blocked by default in
 * Safari and being phased out in Chrome. It also gives the websocket a
 * credential, which it authenticates with instead of cookies.
 *
 * The cost, stated plainly: a token in localStorage is reachable by XSS in a
 * way an HttpOnly cookie is not.
 */
export function getToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private mode, blocked site data
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* not fatal for this page's lifetime */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Thrown when the API rejects the current session (or the lack of one). */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/**
 * The session is genuine but the account is not on the allowlist. Distinct
 * from UnauthorizedError so the gate can explain why, rather than silently
 * bouncing the user back to a sign-in button that will keep "failing".
 */
export class ForbiddenError extends Error {
  constructor(message = 'This account is not authorised for xDocs.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export const authClient = createAuthClient({
  baseURL: API_BASE || window.location.origin,
  fetchOptions: {
    auth: { type: 'Bearer', token: () => getToken() ?? '' },
    // The bearer plugin returns a fresh session token in this header; capture
    // it on every successful call so refreshes are picked up automatically.
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get('set-auth-token');
      if (token) setToken(token);
    },
  },
});

export const { useSession, signOut } = authClient;

/**
 * Sign in with a Google ID token obtained in the browser.
 *
 * Deliberately not the redirect flow: that completes on the API's domain and
 * leaves the session in a cross-site cookie the SPA cannot rely on reading.
 * Passing the ID token signs in directly and hands back a bearer token.
 */
export async function signInWithGoogleIdToken(idToken: string) {
  const result = await authClient.signIn.social({ provider: 'google', idToken: { token: idToken } });
  if (result.error) throw new Error(result.error.message ?? 'Google sign-in failed');
  return result;
}

/** Email + password, enabled only where ALLOW_PASSWORD_LOGIN is set (dev, CI). */
export async function signInWithPassword(email: string, password: string) {
  const result = await authClient.signIn.email({ email, password });
  if (result.error) throw new Error(result.error.message ?? 'Sign-in failed');
  return result;
}
