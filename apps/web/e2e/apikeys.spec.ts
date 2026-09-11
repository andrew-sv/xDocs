import { expect, seedDisposableSession, test } from './fixtures';

/*
 * A throwaway user per test: keys are per-owner, and asserting on "the list has
 * one key" is only meaningful when the list started empty.
 */
test.describe('API keys', () => {
  test.beforeEach(async ({ page }) => {
    await seedDisposableSession(page);
    await page.goto('/');
    await page.getByTestId('keys-toggle').click();
    await expect(page.getByTestId('keys-dialog')).toBeVisible();
  });

  test('creating a key shows it once, with a warning that it cannot be shown again', async ({
    page,
  }) => {
    await expect(page.getByTestId('key-row')).toHaveCount(0);

    await page.getByTestId('key-name').fill('deploy script');
    await page.getByTestId('key-create').click();

    const revealed = page.getByTestId('key-revealed');
    await expect(revealed).toBeVisible();
    await expect(revealed).toContainText('cannot be shown again');
    const key = await page.getByTestId('key-value').textContent();
    expect(key?.startsWith('xdk_')).toBe(true);

    const row = page.getByTestId('key-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('deploy script');
    // The list shows a prefix, never the key.
    await expect(page.getByTestId('key-list')).not.toContainText(key!);

    // Reopening proves the key is gone for good, not merely hidden.
    await page.getByTestId('keys-close').click();
    await page.getByTestId('keys-toggle').click();
    await expect(page.getByTestId('key-revealed')).toHaveCount(0);
    await expect(page.getByTestId('keys-dialog')).not.toContainText(key!);
  });

  test('a key can be revoked and leaves the list', async ({ page }) => {
    await page.getByTestId('key-name').fill('temporary');
    await page.getByTestId('key-create').click();
    await expect(page.getByTestId('key-row')).toHaveCount(1);

    await page.getByTestId('key-revoke').click();
    await expect(page.getByTestId('key-row')).toHaveCount(0);
    await expect(page.getByTestId('key-list')).toContainText('No keys yet');
  });

  test('a created key actually authenticates a request', async ({ page, request }) => {
    await page.getByTestId('key-name').fill('smoke');
    await page.getByTestId('key-create').click();
    const key = (await page.getByTestId('key-value').textContent())!;

    // Used exactly as an outside script would: a bearer token, no session.
    const response = await request.get('http://localhost:3001/api/documents', {
      headers: { authorization: `Bearer ${key}`, origin: 'http://localhost:5173' },
    });
    expect(response.status()).toBe(200);
  });
});
