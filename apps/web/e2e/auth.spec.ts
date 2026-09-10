import { TEST_USER } from '../test-auth.mjs';
import { blocks, expect, getTestToken, seedDisposableSession, test } from './fixtures';

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
