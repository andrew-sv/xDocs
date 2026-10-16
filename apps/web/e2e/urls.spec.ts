import type { APIRequestContext } from '@playwright/test';
import { authHeaders } from '../test-auth.mjs';
import {
  expect,
  getTestToken,
  openDocument,
  seedDisposableSession,
  test,
  type TestDocument,
} from './fixtures';

const API = 'http://localhost:3001';

/** A sub-document made over REST; the fixture purges it with the parent. */
async function addChild(
  request: APIRequestContext,
  parent: TestDocument,
  title: string,
): Promise<TestDocument> {
  const res = await request.post(`${API}/api/documents`, {
    headers: authHeaders(await getTestToken()),
    data: { title, parentId: parent.id },
  });
  return (await res.json()) as TestDocument;
}

test.describe('document URLs', () => {
  test('opening a document puts it in the URL, and a reload keeps it open', async ({
    page,
    doc,
  }) => {
    await openDocument(page, doc);
    await expect(page).toHaveURL(`/doc/${doc.id}`);

    await page.reload();
    await expect(page.getByTestId('title-input')).toHaveValue(doc.title);
    await expect(page.getByTestId('crumb')).toHaveText([doc.title]);
  });

  test('a link to a nested document opens it with its real breadcrumbs', async ({
    page,
    request,
    doc,
  }) => {
    const child = await addChild(request, doc, 'Linked child');

    await page.goto(`/doc/${child.id}`);

    await expect(page.getByTestId('title-input')).toHaveValue('Linked child');
    await expect(page.getByTestId('crumb')).toHaveText([doc.title, 'Linked child']);
    // Never the "select a document" prompt on the way: the link names one.
    await expect(page.getByText('Select a document')).toHaveCount(0);
  });

  test('Back and Forward move between documents', async ({ page, request, doc }) => {
    await addChild(request, doc, 'Next door');
    await openDocument(page, doc);
    await page
      .getByTestId('doc-list')
      .getByTestId('doc-row')
      .filter({ hasText: 'Next door' })
      .getByTestId('doc-open')
      .click();
    await expect(page.getByTestId('title-input')).toHaveValue('Next door');

    await page.goBack();
    await expect(page).toHaveURL(`/doc/${doc.id}`);
    await expect(page.getByTestId('title-input')).toHaveValue(doc.title);
    await expect(page.getByTestId('crumb')).toHaveText([doc.title]);

    await page.goForward();
    await expect(page.getByTestId('title-input')).toHaveValue('Next door');
    await expect(page.getByTestId('crumb')).toHaveText([doc.title, 'Next door']);

    // The top level is a place in history too.
    await page.getByTestId('crumb-root').click();
    await expect(page).toHaveURL('/');
    await page.goBack();
    await expect(page.getByTestId('title-input')).toHaveValue('Next door');
  });

  test('a link to a document that does not exist says so, and keeps the URL', async ({
    page,
    doc,
  }) => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await page.goto(`/doc/${missing}`);

    await expect(page.getByTestId('doc-not-found')).toBeVisible();
    await expect(page).toHaveURL(`/doc/${missing}`);

    // The rest of the app still works from there.
    await page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-open"]`).click();
    await expect(page.getByTestId('title-input')).toHaveValue(doc.title);
    await expect(page).toHaveURL(`/doc/${doc.id}`);
    await expect(page.getByTestId('doc-not-found')).toHaveCount(0);
  });

  test('a link to someone else\'s private document is "not found"', async ({ page, doc }) => {
    // The fixture document is private to the shared test account.
    await seedDisposableSession(page);
    await page.goto(`/doc/${doc.id}`);

    await expect(page.getByTestId('doc-not-found')).toBeVisible();
    await expect(page.getByTestId('title-input')).toHaveCount(0);
  });

  test('deleting the open document leaves its URL', async ({ page, doc }) => {
    await openDocument(page, doc);
    const row = page.getByTestId('current-doc').getByTestId('doc-row');
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await page.getByTestId('confirm-delete').click();

    await expect(page).toHaveURL('/');
  });
});
