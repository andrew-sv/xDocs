/**
 * Sign-in helper for automated tests.
 *
 * Google OAuth cannot be driven headlessly and CI holds no Google credentials,
 * so tests use the email+password provider that the API enables only when
 * ALLOW_PASSWORD_LOGIN is set. Staging leaves it unset, where Google is the
 * only way in.
 */
export const TEST_ORIGIN = 'http://localhost:5173';

export const TEST_USER = {
  email: 'e2e@xdocs.test',
  password: 'e2e-password-not-a-secret',
  name: 'E2E User',
};

/**
 * Returns a bearer session token, creating the shared test user on first run.
 *
 * Better Auth requires an Origin header on state-changing requests as CSRF
 * protection — browsers always send one, Node's fetch never does.
 */
export async function signInForTests(apiBase) {
  const headers = { 'content-type': 'application/json', origin: TEST_ORIGIN };

  const signIn = async () => {
    const res = await fetch(`${apiBase}/api/auth/sign-in/email`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
    });
    const token = res.headers.get('set-auth-token');
    return res.ok && token ? token : null;
  };

  const existing = await signIn();
  if (existing) return existing;

  const signUp = await fetch(`${apiBase}/api/auth/sign-up/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify(TEST_USER),
  });
  const created = signUp.headers.get('set-auth-token');
  if (signUp.ok && created) return created;

  /*
   * Sign-up lost a race.
   *
   * Playwright runs several worker PROCESSES, each with its own cached token,
   * so against an empty database they all try to create this user at once.
   * Exactly one wins and the rest get a duplicate-email error — so retry the
   * sign-in, which now succeeds because the winner created the account.
   */
  const afterRace = await signIn();
  if (afterRace) return afterRace;

  throw new Error(`could not sign in test user: ${signUp.status} ${await signUp.text()}`);
}

/** Headers for an authenticated REST call. */
export function authHeaders(token, extra = {}) {
  return { authorization: `Bearer ${token}`, origin: TEST_ORIGIN, ...extra };
}

/**
 * A throwaway user with its own session.
 *
 * Any test that signs OUT must use one of these: signing out revokes the
 * session server-side, so using the shared token would log every other
 * parallel worker out mid-test.
 */
export async function createDisposableUser(apiBase) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = {
    email: `disposable-${unique}@xdocs.test`,
    password: 'disposable-password-not-a-secret',
    name: `Disposable ${unique}`,
  };
  const res = await fetch(`${apiBase}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: TEST_ORIGIN },
    body: JSON.stringify(user),
  });
  const token = res.headers.get('set-auth-token');
  if (!res.ok || !token) {
    throw new Error(`could not create disposable user: ${res.status} ${await res.text()}`);
  }
  return { ...user, token };
}
