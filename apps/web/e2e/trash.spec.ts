import { expect, test } from './fixtures';
import { seedDisposableSession } from './fixtures';

/*
 * These specs run as a throwaway user, not the shared test account: trash is
 * scoped per owner, and the shared account has accumulated over a thousand
 * deleted documents from earlier runs. A fresh user starts with empty trash,
 * so what the list shows is exactly what the test put there.
 */
test.describe('trash', () => {
  test.beforeEach(async ({ page }) => {
    await seedDisposableSession(page);
    await page.goto('/');
    await expect(page.getByTestId('doc-list-loading')).toHaveCount(0);
  });

  async function createAndDelete(page: import('@playwright/test').Page) {
    await page.getByTestId('new-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    const title = `trash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await page.getByTestId('title-input').fill(title);

    // By title, not .first(): public documents from other users share this list.
    const row = page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: title });
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await page.getByTestId('confirm-delete').click();
    await expect(page.getByTestId('toast')).toBeVisible();
    return title;
  }

  test('a deleted document appears in trash and can be restored', async ({ page }) => {
    const title = await createAndDelete(page);

    await expect(page.getByTestId('trash-count')).toHaveText('1');
    await page.getByTestId('trash-toggle').click();
    const entry = page.getByTestId('trash-row').filter({ hasText: title });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('deleted');

    await entry.getByTestId('trash-restore').click();
    await expect(page.getByTestId('trash-view')).toBeHidden();
    // Back in the document list, and out of the trash.
    await expect(page.getByTestId('title-input')).toHaveValue(title);
    await page.getByTestId('trash-toggle').click();
    await expect(page.getByTestId('trash-row').filter({ hasText: title })).toHaveCount(0);
  });

  test('deleting forever is confirmed, says it cannot be undone, and removes the entry', async ({
    page,
  }) => {
    const title = await createAndDelete(page);
    await page.getByTestId('trash-toggle').click();
    const entry = page.getByTestId('trash-row').filter({ hasText: title });
    await entry.getByTestId('trash-purge').click();

    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toContainText(title);
    await expect(page.getByTestId('confirm-message')).toContainText('cannot be undone');

    await page.getByTestId('confirm-cancel').click();
    // Cancelling destroys nothing.
    await expect(page.getByTestId('trash-row').filter({ hasText: title })).toHaveCount(1);

    await entry.getByTestId('trash-purge').click();
    await page.getByTestId('confirm-delete').click();
    await expect(page.getByTestId('trash-row').filter({ hasText: title })).toHaveCount(0);
  });

  test('a cascaded subtree is one entry naming how many go with it', async ({ page }) => {
    await page.getByTestId('new-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    const parent = `parent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await page.getByTestId('title-input').fill(parent);

    // Drill in and add a child, then come back up to delete the parent.
    await page
      .getByTestId('doc-list')
      .getByTestId('doc-row')
      .filter({ hasText: parent })
      .getByTestId('doc-open')
      .click();
    /*
     * The parent must be the OPEN document before a child goes under it — a
     * misdirected row click otherwise adds one to somebody's real document
     * rather than failing here (#29).
     */
    await expect(page.getByTestId('title-input')).toHaveValue(parent);
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    await page.getByTestId('crumb').first().click();

    const row = page.getByTestId('current-doc').getByTestId('doc-row');
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await page.getByTestId('confirm-delete').click();

    await page.getByTestId('trash-toggle').click();
    const entry = page.getByTestId('trash-row').filter({ hasText: parent });
    // ONE entry for the whole subtree, not one per document.
    await expect(entry).toHaveCount(1);
    await expect(entry.getByTestId('trash-descendants')).toContainText('1 sub-document');

    // And the warning counts them before destroying anything.
    await entry.getByTestId('trash-purge').click();
    await expect(page.getByTestId('confirm-warning')).toContainText('1 sub-document');
  });

  test('trash shows only your own deleted documents', async ({ page, doc, request }) => {
    // `doc` belongs to the shared test account; delete it as its owner.
    const { authHeaders } = await import('../test-auth.mjs');
    const { getTestToken } = await import('./fixtures');
    const token = await getTestToken();
    await request.delete(`http://localhost:3001/api/documents/${doc.id}`, {
      headers: authHeaders(token),
    });

    await page.reload();
    await page.getByTestId('trash-toggle').click();
    await expect(page.getByTestId('trash-row').filter({ hasText: doc.title })).toHaveCount(0);
  });
});
