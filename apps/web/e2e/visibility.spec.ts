import { expect, openDocument, seedDisposableSession, test } from './fixtures';

test.describe('visibility', () => {
  test('a new document is private and the owner can toggle it public', async ({ page, doc }) => {
    await openDocument(page, doc);

    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Private/);
    await page.getByTestId('crumb-root').click();
    await expect(page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-visibility"]`)).toHaveText(
      /Private/,
    );
    await page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-open"]`).click();

    await page.getByTestId('visibility-toggle').click();

    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Public/);
    // The sidebar badge must follow, not just the header control.
    await page.getByTestId('crumb-root').click();
    await expect(page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-visibility"]`)).toHaveText(
      /Public/,
    );
  });

  test('toggling back to private sticks after a reload', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('visibility-toggle').click();
    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Public/);

    await page.reload();
    await page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-open"]`).click();
    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Public/);

    await page.getByTestId('visibility-toggle').click();
    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Private/);
  });

  test('a private document is invisible to another user', async ({ page, doc, browser }) => {
    await openDocument(page, doc);
    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Private/);

    const context = await browser.newContext();
    const other = await context.newPage();
    try {
      await seedDisposableSession(other);
      await other.goto('/');
      await expect(other.getByTestId('new-document')).toBeVisible();
      await expect(other.locator(`[data-doc-id="${doc.id}"]`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a non-owner sees a static badge, no toggle and no delete', async ({ page, doc, browser }) => {
    await openDocument(page, doc);
    await page.getByTestId('visibility-toggle').click();
    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Public/);

    const context = await browser.newContext();
    const other = await context.newPage();
    try {
      await seedDisposableSession(other);
      await other.goto('/');

      // Check the row FIRST: opening a document drills into it, after which the
      // document is a breadcrumb rather than a sidebar row.
      const row = other.locator(`[data-doc-id="${doc.id}"]`);
      await expect(row).toHaveCount(1);
      await row.hover();
      await expect(row.getByTestId('doc-delete')).toHaveCount(0);

      await row.getByTestId('doc-open').click();
      await expect(other.locator('.status')).toHaveText('Live');

      // Visible and editable, but not administrable.
      await expect(other.getByTestId('visibility-static')).toHaveText(/Public/);
      await expect(other.getByTestId('visibility-toggle')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
