import { expect, openDocument, test } from './fixtures';

test.describe('nested documents', () => {
  test('the sidebar shows top-level documents, with no breadcrumb', async ({ page, doc }) => {
    await openDocument(page, doc);
    // openDocument drills in, so go back to the root first.
    await page.getByTestId('crumb-root').click();
    await expect(page.getByTestId('crumbs')).toBeHidden();
    await expect(page.locator(`[data-doc-id="${doc.id}"]`)).toHaveCount(1);
  });

  test('"+ Add document" creates a sub-document and opens it', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('add-document').click();

    // The new child opens in the editor and the trail follows it.
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    await expect(page.getByTestId('crumbs')).toBeVisible();
    await expect(page.getByTestId('crumbs')).toContainText(doc.title);
  });

  test('clicking a document shows its sub-documents in the sidebar', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');

    // Back to the parent: its child should now be listed.
    await page.getByTestId('crumb').first().click();
    const children = page.getByTestId('doc-list').getByTestId('doc-row');
    await expect(children).toHaveCount(1);
    await expect(children.first()).toContainText('Untitled');
  });

  test('a parent with children is marked in the list', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');

    await page.getByTestId('crumb-root').click();
    // At the top level nothing is "current", so there is no pinned row and the
    // document appears exactly once.
    await expect(page.getByTestId('current-doc')).toHaveCount(0);
    await expect(page.locator(`[data-doc-id="${doc.id}"]`)).toHaveCount(1);
    // Navigating up refetches the root list, so this waits on a round trip —
    // the config's expect timeout covers it.
    await expect(
      page.getByTestId('doc-list').locator(`[data-doc-id="${doc.id}"] [data-testid="doc-haschildren"]`),
    ).toBeVisible();
  });

  test('the breadcrumb walks back up the tree', async ({ page, doc }) => {
    await openDocument(page, doc);

    /*
     * Wait for the newly created child to actually be open before clicking
     * again. `.status` is unreliable (the editor is keyed by document id, so
     * the assertion can match the OLD editor), and a breadcrumb count that is
     * already true waits for nothing — the second click then fired before React
     * had re-rendered with the new selection.
     */
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');

    // Nest one level deeper: this child becomes the new parent.
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('crumb')).toHaveCount(2);

    await page.getByTestId('crumb-root').click();
    await expect(page.getByTestId('crumbs')).toBeHidden();
    // Back at the top level, the original document is there again.
    await expect(page.locator(`[data-doc-id="${doc.id}"]`)).toHaveCount(1);
  });

  test('clicking the open document again does not add another crumb', async ({ page, doc }) => {
    await openDocument(page, doc);
    await expect(page.getByTestId('crumb')).toHaveCount(1);

    // The "Current" row opens documents like any other row, but it is already
    // the last crumb — drilling into it again stacked a duplicate each click.
    const current = page.getByTestId('current-doc').getByTestId('doc-open');
    await current.click();
    await current.click();
    await expect(page.getByTestId('crumb')).toHaveCount(1);
    await expect(page.getByTestId('crumbs')).toContainText(doc.title);
  });

  test('the Current row reopens the parent after adding a sub-document', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');

    // The child is open but the sidebar is still at the parent's level, so the
    // parent is the Current row: clicking it opens it without going deeper.
    await page.getByTestId('current-doc').getByTestId('doc-open').click();
    await expect(page.getByTestId('title-input')).toHaveValue(doc.title);
    await expect(page.getByTestId('crumb')).toHaveCount(1);
    await expect(page.getByTestId('doc-list').getByTestId('doc-row')).toHaveCount(1);
  });

  test('a sub-document inherits the parent visibility', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('visibility-toggle').click();
    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Public/);

    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    // Copied from the parent at creation time.
    await expect(page.getByTestId('visibility-toggle')).toHaveText(/Public/);
  });
});
