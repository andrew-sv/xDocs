const STORAGE_KEY = 'xdocs.access-token';

/**
 * Shared-password token for gated deployments.
 *
 * Kept in sessionStorage so it dies with the tab. This is a gate, not
 * authentication: every visitor holds the same secret and can read it out of
 * devtools. It stops a staging URL being world-writable, nothing more.
 */
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode and blocked site data both throw here.
    return null;
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* not fatal — the token still applies for this page's lifetime */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Thrown when the API rejects the current token (or the lack of one). */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}
