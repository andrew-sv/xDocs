import type { APIRequestContext } from '@playwright/test';
import { authHeaders } from '../test-auth.mjs';
import { expect, getTestToken, openDocument, test, type TestDocument } from './fixtures';

const API = 'http://localhost:3001';

/** Sub-documents made over REST, in order. The fixture purges them with the parent. */
async function addChildren(request: APIRequestContext, parent: TestDocument, titles: string[]) {
  const token = await getTestToken();
  for (const title of titles) {
    await request.post(`${API}/api/documents`, {
      headers: authHeaders(token),
      data: { title, parentId: parent.id },
    });
  }
}

const links = (page: import('@playwright/test').Page) => page.getByTestId('sub-doc-link');

test.describe('sub-document links', () => {
  test('a document lists its sub-documents as links at the bottom', async ({
    page,
    request,
    doc,
  }) => {
    await addChildren(request, doc, ['Alpha child', 'Beta child']);
    await openDocument(page, doc);

    // Creation order, so the list does not reshuffle whenever a child is edited.
    await expect(links(page)).toHaveText(['Alpha child', 'Beta child']);

    // At the bottom: below the document's own actions, not among its blocks.
    const addButton = (await page.getByTestId('add-document').boundingBox())!;
    const section = (await page.getByTestId('sub-docs').boundingBox())!;
    expect(section.y).toBeGreaterThan(addButton.y);
  });

  test('a document without sub-documents shows no links section', async ({ page, doc }) => {
    await openDocument(page, doc);
    await expect(page.getByTestId('add-document')).toBeVisible();
    await expect(page.getByTestId('sub-docs')).toHaveCount(0);
  });

  test('clicking a link opens the sub-document inside its path', async ({ page, request, doc }) => {
    await addChildren(request, doc, ['Alpha child', 'Beta child']);
    await openDocument(page, doc);

    await links(page).filter({ hasText: 'Beta child' }).click();

    await expect(page.getByTestId('title-input')).toHaveValue('Beta child');
    await expect(page.getByTestId('crumb')).toHaveText([doc.title, 'Beta child']);
    await expect(page.getByTestId('current-doc')).toContainText('Beta child');
  });

  test('a new sub-document appears as a link under its current title', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    await page.getByTestId('title-input').fill('Freshly named');

    // Back to the parent: the link must not wait for the server's debounced
    // copy of the title, or it would read "Untitled".
    await page.getByTestId('crumb').first().click();
    await expect(page.getByTestId('title-input')).toHaveValue(doc.title);
    await expect(links(page)).toHaveText(['Freshly named']);
  });

  test('links work on a document reopened by undoing its deletion', async ({
    page,
    request,
    doc,
  }) => {
    await addChildren(request, doc, ['Alpha child']);
    await openDocument(page, doc);

    const row = page.getByTestId('current-doc').getByTestId('doc-row');
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await page.getByTestId('confirm-delete').click();
    await page.getByTestId('toast-undo').click();

    // Restored and open, but the sidebar is back at the top level — so the
    // links cannot come from the sidebar's list and have to be fetched.
    await expect(page.getByTestId('title-input')).toHaveValue(doc.title);
    await expect(links(page)).toHaveText(['Alpha child']);

    await links(page).first().click();
    await expect(page.getByTestId('title-input')).toHaveValue('Alpha child');
    await expect(page.getByTestId('crumb')).toHaveText([doc.title, 'Alpha child']);
  });
});
