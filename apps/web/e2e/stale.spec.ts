import { expect, openDocument, test } from './fixtures';

test.describe('sidebar level switching', () => {
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
