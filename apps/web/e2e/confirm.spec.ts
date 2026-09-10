import { expect, openDocument, test } from './fixtures';

test.describe('delete confirmation', () => {
  test('deleting asks first, and cancelling keeps the document', async ({ page, doc }) => {
    await openDocument(page, doc);

    // The open document stays in the sidebar, so it can be deleted from there.
    const row = page.getByTestId('current-doc').getByTestId('doc-row');
    await row.hover();
    await row.getByTestId('doc-delete').click();

    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toContainText(doc.title);

    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toBeHidden();

    // Still there — cancelling must not delete.
    await page.getByTestId('crumb-root').click();
    await expect(page.locator(`[data-doc-id="${doc.id}"]`)).toHaveCount(1);
  });

  test('confirming deletes and offers undo', async ({ page, doc }) => {
    await openDocument(page, doc);
    const row = page.getByTestId('current-doc').getByTestId('doc-row');
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await page.getByTestId('confirm-delete').click();

    await expect(page.getByTestId('confirm-dialog')).toBeHidden();
    await expect(page.getByTestId('toast')).toBeVisible();
    await expect(page.locator(`[data-doc-id="${doc.id}"]`)).toHaveCount(0);
  });

  test('Escape dismisses the dialog without deleting', async ({ page, doc }) => {
    await openDocument(page, doc);
    const row = page.getByTestId('current-doc').getByTestId('doc-row');
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm-dialog')).toBeHidden();
    await page.getByTestId('crumb-root').click();
    await expect(page.locator(`[data-doc-id="${doc.id}"]`)).toHaveCount(1);
  });

  test('a document with sub-documents warns that they go too', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');

    // Back to the parent, which now has a child.
    await page.getByTestId('crumb').first().click();
    const row = page.getByTestId('current-doc').getByTestId('doc-row');
    await row.hover();
    await row.getByTestId('doc-delete').click();

    await expect(page.getByTestId('confirm-warning')).toContainText('sub-documents');
  });

  test('the open document is shown in the sidebar, not only the breadcrumb', async ({ page, doc }) => {
    await openDocument(page, doc);
    await expect(page.getByTestId('current-doc')).toBeVisible();
    await expect(page.getByTestId('current-doc')).toContainText(doc.title);
  });
});
