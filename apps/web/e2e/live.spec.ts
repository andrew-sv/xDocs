import type { APIRequestContext } from '@playwright/test';
import { authHeaders } from '../test-auth.mjs';
import { expect, getTestToken, openDocument, test, type TestDocument } from './fixtures';

const API = 'http://localhost:3001';

/*
 * Changes made elsewhere reach an open sidebar without a reload (#22).
 *
 * "Elsewhere" is REST, exactly as the MCP server or a script would do it. None
 * of these tests reload the page or move focus: the change has to arrive by
 * itself.
 */
async function addChild(request: APIRequestContext, parent: TestDocument, title: string): Promise<TestDocument> {
  const res = await request.post(`${API}/api/documents`, {
    headers: authHeaders(await getTestToken()),
    data: { title, parentId: parent.id },
  });
  return (await res.json()) as TestDocument;
}

const subDocRow = (page: import('@playwright/test').Page, title: string) =>
  page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: title });

test.describe('live sidebar', () => {
  test('a document created elsewhere appears without a reload', async ({ page, request, doc }) => {
    await openDocument(page, doc);
    await expect(page.getByTestId('doc-list-loading')).toHaveCount(0);

    await addChild(request, doc, 'Made elsewhere');

    await expect(subDocRow(page, 'Made elsewhere')).toBeVisible();
  });

  test('a document deleted elsewhere disappears', async ({ page, request, doc }) => {
    const child = await addChild(request, doc, 'Doomed elsewhere');
    await openDocument(page, doc);
    await expect(subDocRow(page, 'Doomed elsewhere')).toBeVisible();

    await request.delete(`${API}/api/documents/${child.id}`, { headers: authHeaders(await getTestToken()) });

    await expect(subDocRow(page, 'Doomed elsewhere')).toHaveCount(0);
  });

  test('a rename made elsewhere shows up once it is saved', async ({ page, request, doc }) => {
    const child = await addChild(request, doc, 'Old name');
    await openDocument(page, doc);
    await expect(subDocRow(page, 'Old name')).toBeVisible();

    // A title written through the content bridge lands in the list column on
    // the collab server's debounced save — the ping from that save is what
    // brings it here.
    await request.put(`${API}/api/documents/${child.id}/content`, {
      headers: authHeaders(await getTestToken(), { 'content-type': 'application/json' }),
      data: { title: 'New name', blocks: ['body'] },
    });

    await expect(subDocRow(page, 'New name')).toBeVisible();
  });

  test('changes made while offline appear once the page is back', async ({ page, context, request, doc }) => {
    await openDocument(page, doc);
    await expect(page.getByTestId('doc-list-loading')).toHaveCount(0);

    // Pings sent while the socket is down are lost for good; the reconnect
    // itself has to trigger the refetch.
    await context.setOffline(true);
    await addChild(request, doc, 'Made while offline');
    await context.setOffline(false);

    await expect(subDocRow(page, 'Made while offline')).toBeVisible({ timeout: 20_000 });
  });
});
