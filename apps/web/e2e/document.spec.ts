import { blockEditor, blocks, expect, openDocument, test, typeInBlock } from './fixtures';

test.describe('documents', () => {
  test('opening a document shows its real name and a spinner, never "Untitled"', async ({ page, doc }) => {
    /*
     * Block the collab socket so the document never syncs and the loading state
     * persists — otherwise this is a sub-second flash and the test would be a
     * race. Before the fix the empty Y.Text fell through to the input's
     * "Untitled" placeholder here.
     */
    await page.routeWebSocket(/localhost:1234/, () => {
      // Accept the socket and answer nothing: permanently unsynced.
    });

    await page.goto('/');
    await page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-open"]`).click();

    const loading = page.getByTestId('title-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveText(new RegExp(doc.title));
    await expect(loading).not.toContainText('Untitled');
    await expect(loading.locator('.spinner')).toBeVisible();
  });

  test('renaming updates the sidebar live', async ({ page, doc }) => {
    await openDocument(page, doc);

    const title = page.getByTestId('title-input');
    await title.click();
    await title.fill('Renamed in a test');

    await expect(page.locator(`[data-doc-id="${doc.id}"] .doc-title`)).toHaveText('Renamed in a test');
  });

  test('deleting a document is undoable and restores its content', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'precious content');

    const row = page.locator(`[data-doc-id="${doc.id}"]`);
    await row.hover();
    await row.getByTestId('doc-delete').click();

    await expect(row).toHaveCount(0);
    await expect(page.getByTestId('toast')).toContainText(doc.title);

    await page.getByTestId('toast-undo').click();

    await expect(page.locator(`[data-doc-id="${doc.id}"]`)).toHaveCount(1);
    await expect(page.locator('.status')).toHaveText('Live');
    await expect(blockEditor(page, 0)).toContainText('precious content');
  });

  test('a new document starts with exactly one empty block', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-document').click();

    await expect(page.locator('.status')).toHaveText('Live');
    await expect(blocks(page)).toHaveCount(1);
    await expect(blockEditor(page, 0)).toHaveText('');
  });
});
