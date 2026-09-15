import { expect, seedDisposableSession, test } from './fixtures';

/*
 * A throwaway user: the move picker lists every document you can see, and the
 * shared account can see every public document in the database.
 */
test.describe('moving documents', () => {
  test.beforeEach(async ({ page }) => {
    await seedDisposableSession(page);
    await page.goto('/');
    await expect(page.getByTestId('doc-list-loading')).toHaveCount(0);
  });

  /** Create a top-level document with a known title, and return it. */
  async function newDocument(page: import('@playwright/test').Page, label: string) {
    await page.getByTestId('new-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    const title = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await page.getByTestId('title-input').fill(title);
    return title;
  }

  test('a document can be moved under another and back to the top level', async ({ page }) => {
    const destination = await newDocument(page, 'dest');
    const subject = await newDocument(page, 'subject');

    const row = page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: subject });
    await row.hover();
    await row.getByTestId('doc-move').click();

    await expect(page.getByTestId('move-dialog')).toBeVisible();
    await page.getByTestId('move-filter').fill(destination);
    await page.getByTestId('move-option').filter({ hasText: destination }).click();

    // Gone from the top level, and inside the destination.
    await expect(
      page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: subject }),
    ).toHaveCount(0);
    await page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: destination })
      .getByTestId('doc-open').click();
    await expect(
      page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: subject }),
    ).toHaveCount(1);

    // And back out again.
    const nested = page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: subject });
    await nested.hover();
    await nested.getByTestId('doc-move').click();
    await page.getByTestId('move-to-root').click();
    await expect(
      page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: subject }),
    ).toHaveCount(0);

    await page.getByTestId('crumb-root').click();
    await expect(
      page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: subject }),
    ).toHaveCount(1);
  });

  test('a document is not offered as a destination for itself', async ({ page }) => {
    const subject = await newDocument(page, 'self');
    const row = page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: subject });
    await row.hover();
    await row.getByTestId('doc-move').click();

    await page.getByTestId('move-filter').fill(subject);
    // Its own row must not appear — the server refuses the cycle, but offering
    // a choice that always fails is worse than not offering it.
    await expect(page.getByTestId('move-option').filter({ hasText: subject })).toHaveCount(0);
  });

  test('neither is its own sub-document', async ({ page }) => {
    const parent = await newDocument(page, 'cycleparent');
    await page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: parent })
      .getByTestId('doc-open').click();
    /*
     * The parent must be the OPEN document before a child goes under it — a
     * misdirected row click otherwise adds one to somebody's real document
     * rather than failing here (#29).
     */
    await expect(page.getByTestId('title-input')).toHaveValue(parent);
    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    const child = `cyclechild-${Date.now()}`;
    await page.getByTestId('title-input').fill(child);

    await page.getByTestId('crumb').first().click();
    const row = page.getByTestId('current-doc').getByTestId('doc-row');
    await row.hover();
    await row.getByTestId('doc-move').click();
    await page.getByTestId('move-filter').fill(child);
    await expect(page.getByTestId('move-option').filter({ hasText: child })).toHaveCount(0);
  });

  test('the dialog says sub-documents come along and visibility does not change', async ({
    page,
  }) => {
    const subject = await newDocument(page, 'warned');
    const row = page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: subject });
    await row.hover();
    await row.getByTestId('doc-move').click();
    await expect(page.getByTestId('move-dialog')).toContainText('Its sub-documents move with it');
    await expect(page.getByTestId('move-dialog')).toContainText('Visibility is unchanged');
  });

  test('a document owned by someone else offers no move control', async ({ page, doc }) => {
    // `doc` belongs to the shared account; make it public so it is visible.
    const { authHeaders } = await import('../test-auth.mjs');
    const { getTestToken } = await import('./fixtures');
    const token = await getTestToken();
    await page.request.patch(`http://localhost:3001/api/documents/${doc.id}/visibility`, {
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      data: { visibility: 'public' },
    });

    await page.reload();
    const row = page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: doc.title });
    await expect(row).toHaveCount(1);
    await row.hover();
    await expect(row.getByTestId('doc-move')).toHaveCount(0);
  });
});
