import { expect, openDocument, test } from './fixtures';

test.describe('sidebar level switching', () => {
  test('a document created while the list is still loading is not wiped by it', async ({ page }) => {
    /*
     * The first list request is held open, so it resolves AFTER the new
     * document has been added to the sidebar. Without the sequence guard in
     * App.tsx that stale response replaces the list and the new document
     * vanishes from the sidebar — while still being the open document.
     */
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/documents', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      // Fetch NOW but deliver later: the body has to be the list as it was
      // BEFORE the new document existed, which is what makes it stale.
      const response = await route.fetch();
      const body = await response.text();
      await gate;
      await route.fulfill({ response, body });
    });

    await page.goto('/');
    await page.getByTestId('new-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    const row = page.getByTestId('doc-list').getByTestId('doc-row').first();
    const newId = await row.getAttribute('data-doc-id');

    // Arm the wait BEFORE releasing, then assert only once the stale response
    // has actually been applied — asserting sooner passes either way.
    const landed = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && response.url().endsWith('/api/documents'),
    );
    release();
    await landed;
    await expect(page.locator(`[data-doc-id="${newId}"]`)).toHaveCount(1);
    await page.unroute('**/api/documents');
  });

  test('never shows the previous level while loading the next', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');

    // Back to the parent, so the sidebar holds a known child row.
    await page.getByTestId('crumb').first().click();
    const children = page.getByTestId('doc-list').getByTestId('doc-row');
    await expect(children).toHaveCount(1);
    const childId = await children.first().getAttribute('data-doc-id');

    /*
     * Hold the next level's request open, then navigate. If the sidebar kept
     * rendering the old list we would still see the child; it must show the
     * loading state instead.
     */
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/documents?parent=*', async (route) => {
      await gate;
      await route.continue();
    });

    await page.getByTestId('crumb-root').click();
    await page.getByTestId('doc-list').getByTestId('doc-row').first().getByTestId('doc-open').click();

    await expect(page.getByTestId('doc-list-loading')).toBeVisible();
    // The previous level's row must be gone already, not lingering underneath.
    await expect(page.locator(`[data-doc-id="${childId}"]`)).toHaveCount(0);

    release();
    await expect(page.getByTestId('doc-list-loading')).toBeHidden();
  });

  test('the loading state clears once the level has loaded', async ({ page, doc }) => {
    await openDocument(page, doc);
    await expect(page.getByTestId('doc-list-loading')).toBeHidden();
    await expect(page.getByTestId('doc-list')).toContainText('No sub-documents yet.');
  });
});
