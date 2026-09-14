import type { Page } from '@playwright/test';
import { TEST_USER } from '../test-auth.mjs';
import { blocks, expect, getTestToken, seedDisposableSession, test } from './fixtures';

/**
 * Resolve once no document list has come back for `quiet` ms — or once `cap`
 * has passed, whichever is first.
 *
 * The cap is not a detail: during a full parallel run the other workers are
 * mutating documents constantly, every mutation pings every open app, and this
 * page refetches each time. Waiting for real quiet would then never return, and
 * this test would sit there until it timed out.
 */
async function listQuiet(page: Page, quiet = 750, cap = 5_000): Promise<void> {
  const deadline = Date.now() + cap;
  let last = Date.now();
  const seen = (response: { url: () => string }) => {
    if (new URL(response.url()).pathname === '/api/documents') last = Date.now();
  };
  page.on('response', seen);
  try {
    while (Date.now() - last < quiet && Date.now() < deadline) await page.waitForTimeout(100);
  } finally {
    page.off('response', seen);
  }
}

test.describe('authentication', () => {
  test('a signed-out visitor gets the login gate, not documents', async ({ browser }) => {
    // A bare context, deliberately NOT seeded by the page fixture.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto('/');
      await expect(page.getByTestId('login-gate')).toBeVisible();
      await expect(page.getByTestId('new-document')).toBeHidden();
      await expect(blocks(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('an invalid session token is rejected and shows the gate', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.addInitScript(() =>
        window.localStorage.setItem('xdocs.session-token', 'forged-not-a-real-session'),
      );
      await page.goto('/');
      // A forged token must not be mistaken for being signed in.
      await expect(page.getByTestId('login-gate')).toBeVisible();
      await expect(page.getByTestId('new-document')).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test('a signed-in user sees their account and can sign out', async ({ browser }) => {
    // A disposable user: signing out revokes the session server-side, which
    // would log every other parallel worker out if it used the shared one.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const user = await seedDisposableSession(page);
      await page.goto('/');
      await expect(page.getByTestId('new-document')).toBeVisible();
      await expect(page.getByTestId('account')).toContainText(user.name);
      await expect(page.locator('.account-name')).toHaveAttribute('title', user.email);

      await page.getByTestId('sign-out').click();

      await expect(page.getByTestId('login-gate')).toBeVisible();
      await expect(page.getByTestId('new-document')).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test('signing out clears the stored session token', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await seedDisposableSession(page);
      await page.goto('/');
      await expect(page.getByTestId('new-document')).toBeVisible();
      await page.getByTestId('sign-out').click();
      await expect(page.getByTestId('login-gate')).toBeVisible();

      const stored = await page.evaluate(() => window.localStorage.getItem('xdocs.session-token'));
      expect(stored).toBeNull();
    } finally {
      await context.close();
    }
  });

  /*
   * Signing out latches "no session" so that a read from the old one cannot
   * reach the screen; signing back in has to unlatch it. Without that reset the
   * gate accepts the password, disappears, and leaves an empty sidebar behind —
   * every list response silently dropped. A fresh context would not catch it,
   * since the latch starts off; this has to be the same page.
   */
  test('signing back in after signing out loads documents again', async ({ browser }) => {
    await getTestToken(); // create the shared account if this is a fresh database

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await seedDisposableSession(page);
      await page.goto('/');
      await expect(page.getByTestId('new-document')).toBeVisible();
      await page.getByTestId('sign-out').click();
      await expect(page.getByTestId('login-gate')).toBeVisible();

      await page.getByTestId('login-email').fill(TEST_USER.email);
      await page.getByTestId('login-password').fill(TEST_USER.password);
      await page.getByTestId('login-submit').click();

      await expect(page.getByTestId('new-document')).toBeVisible();
      await expect(page.getByTestId('account')).toContainText(TEST_USER.name);
      // The sidebar has to actually load, not just unlock.
      await expect(page.getByTestId('doc-list-loading')).toHaveCount(0);
      await expect(page.getByTestId('doc-row').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  /*
   * A list fetch outliving the session that asked for it (#28).
   *
   * Under a full parallel run a refetch is almost always in flight, and one
   * landing after sign-out used to be applied like any other: it called
   * setLocked(false), so the gate never appeared and the sidebar filled back
   * up with the documents the ended session could see. Here the response is
   * held open deliberately, which turns that race into a certainty.
   */
  test('a list response that lands after sign-out cannot undo it', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await seedDisposableSession(page);
      await page.goto('/');
      await expect(page.getByTestId('new-document')).toBeVisible();

      /*
       * Wait out the fetches the page load starts before holding one.
       *
       * refresh() also drops a list older than the one already shown, by the
       * server read time in x-list-as-of. Holding a response while others are
       * still in flight lets a newer one land first, and then the held one is
       * discarded as stale — the right thing, but not the case under test.
       * Once the page is quiet the next read is the newest there is.
       */
      await listQuiet(page);

      /*
       * Let the list request reach the server now, while the session is still
       * good, and hold only its RESPONSE back until this test says so.
       *
       * Delaying the request instead would not reproduce anything: it would
       * arrive after sign-out had revoked the session, come back 401, and lock
       * the app for that reason rather than the one under test.
       */
      let answered!: () => void;
      const hasAnswered = new Promise<void>((resolve) => (answered = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      await page.route('**/api/documents*', async (route) => {
        const response = await route.fetch();
        answered();
        await released;
        await route.fulfill({ response });
      });

      // The app refetches when the window regains focus; that is the fetch
      // left in flight across the sign-out.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      // Bounded, so a refetch that never happens fails here and says why,
      // rather than hanging until the test times out.
      const intercepted = await Promise.race([
        hasAnswered.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      expect(intercepted, 'the focus event should have started a list refetch').toBe(true);

      await page.getByTestId('sign-out').click();
      await expect(page.getByTestId('login-gate')).toBeVisible();

      /*
       * Watch for the signed-in UI rather than sampling for it.
       *
       * Applying the stale list unlocks the app, but the next request to fail
       * with a 401 locks it again — so the leak can come and go between two
       * assertions. This records it the moment it renders.
       */
      await page.evaluate(() => {
        const seen = () => !!document.querySelector('[data-testid="new-document"]');
        (window as unknown as { __signedInAgain: boolean }).__signedInAgain = seen();
        new MutationObserver(() => {
          if (seen()) (window as unknown as { __signedInAgain: boolean }).__signedInAgain = true;
        }).observe(document.body, { childList: true, subtree: true });
      });

      // Now let the stale list land, and wait until the page has really seen it.
      const landed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/documents');
      release();
      await landed;

      // It must change nothing: this is the ended session's data.
      expect(
        await page.evaluate(
          () => (window as unknown as { __signedInAgain: boolean }).__signedInAgain,
        ),
      ).toBe(false);
      await expect(page.getByTestId('login-gate')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a fresh context can sign in with the password provider', async ({ browser }) => {
    // This spec takes no page/doc fixture, so nothing else here creates the
    // shared account. CI starts from an empty database, so without this the
    // test signs in to a user that does not exist — and only passed locally
    // because an earlier run had already created it.
    await getTestToken();

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto('/');
      // Credentials come from the helper so they cannot drift out of sync.
      await page.getByTestId('login-email').fill(TEST_USER.email);
      await page.getByTestId('login-password').fill(TEST_USER.password);
      await page.getByTestId('login-submit').click();

      await expect(page.getByTestId('new-document')).toBeVisible();
      await expect(page.getByTestId('account')).toContainText(TEST_USER.name);
      await expect(page.locator('.account-name')).toHaveAttribute('title', TEST_USER.email);
    } finally {
      await context.close();
    }
  });
});
