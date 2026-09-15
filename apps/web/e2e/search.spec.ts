import { blocks, createsDocument, docRow, expect, openDocument, seedDisposableSession, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Search, then wait for a hit.
 *
 * Both the title column and the content mirror are written by Hocuspocus on a
 * debounce, so anything typed in the browser is searchable a second or two
 * later — not immediately. Retrying has to clear the box first: re-filling the
 * same value fires no change event, so the query would never be re-sent.
 */
async function searchUntilFound(page: Page, query: string, text: string) {
  await expect(async () => {
    await page.getByTestId('search-input').fill('');
    await page.getByTestId('search-input').fill(query);
    await expect(page.getByTestId('search-row').filter({ hasText: text })).toHaveCount(1);
  }).toPass({ timeout: 20_000 });
}

/*
 * Body text only becomes searchable once Hocuspocus has flushed the CRDT to
 * Postgres, which it does on a debounce. Specs that type and immediately search
 * would be racing that flush, so the ones below search by title except where
 * the flush is the point — and that one waits for it.
 */
test.describe('search', () => {
  test('finds a document by title and opens it', async ({ page, doc }) => {
    await page.goto('/');
    await page.getByTestId('search-input').fill(doc.title);

    const row = page.getByTestId('search-row').filter({ hasText: doc.title });
    await expect(row).toHaveCount(1);
    await row.getByTestId('search-open').click();

    await expect(page.getByTestId('title-input')).toHaveValue(doc.title);
    // Opening a result leaves search mode rather than leaving stale hits up.
    await expect(page.getByTestId('search-results')).toBeHidden();
    await expect(page.getByTestId('search-input')).toHaveValue('');
  });

  test('Escape clears the query and restores the document list', async ({ page, doc }) => {
    await page.goto('/');
    await page.getByTestId('search-input').fill(doc.title);
    await expect(page.getByTestId('search-results')).toBeVisible();

    await page.getByTestId('search-input').press('Escape');
    await expect(page.getByTestId('search-results')).toBeHidden();
    await expect(page.getByTestId('doc-list')).toBeVisible();
  });

  test('a query with no matches says so instead of showing everything', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('search-input').fill(`nomatch${Date.now()}`);
    await expect(page.getByTestId('search-empty')).toBeVisible();
    await expect(page.getByTestId('search-row')).toHaveCount(0);
  });

  test('a nested result shows the path it lives under', async ({ page }) => {
    await seedDisposableSession(page);
    // The real "sidebar is ready" signal. `doc-list-loading` is not: it renders
    // only while the loaded level differs from the open one, which at the top
    // level is false before the first fetch has even been sent.
    await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/documents',
      ),
      page.goto('/'),
    ]);

    const parentDoc = await createsDocument(page, () => page.getByTestId('new-document').click());
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    const parent = `parent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await page.getByTestId('title-input').fill(parent);

    /*
     * By id, never by title (#29).
     *
     * This sidebar holds every public document in the workspace, including
     * real people's, and the title just typed is client-side state until the
     * collab server's debounced save — so a title-filtered row can match
     * nothing, or the wrong thing, for as long as that save takes. Three runs
     * of this spec once added their children to a stranger's document that
     * way, owned by a disposable user nobody could delete them as.
     */
    await docRow(page, parentDoc.id).getByTestId('doc-open').click();

    /*
     * And the parent must be the OPEN document before a child goes under it.
     * This is the assertion that makes a misdirected click fail here, harmless,
     * instead of somewhere else's document a moment later.
     */
    await expect(page.getByTestId('title-input')).toHaveValue(parent);

    const childDoc = await createsDocument(page, () => page.getByTestId('add-document').click());
    expect(childDoc.parentId).toBe(parentDoc.id);
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    const child = `child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await page.getByTestId('title-input').fill(child);

    await searchUntilFound(page, child, child);
    const row = page.getByTestId('search-row').filter({ hasText: child });
    await expect(row.getByTestId('search-path')).toHaveText(parent);

    // Opening it lands inside the real tree, so the breadcrumb is the path.
    await row.getByTestId('search-open').click();
    await expect(page.getByTestId('crumb')).toHaveCount(2);
    await expect(page.getByTestId('crumb').first()).toHaveText(parent);
  });

  test('typed block text becomes searchable and the match is highlighted', async ({ page, doc }) => {
    await openDocument(page, doc);
    const needle = `zorblat${Date.now()}`;
    await blocks(page).first().locator('.block-body').click();
    await page.keyboard.type(`The minutes mention ${needle} once.`);

    // Until Hocuspocus writes, the mirror the index is built from is stale.
    await searchUntilFound(page, needle, doc.title);

    const row = page.getByTestId('search-row').filter({ hasText: doc.title });
    await expect(row.getByTestId('search-snippet')).toContainText('minutes');
    await expect(row.getByTestId('search-hit')).toHaveText(needle);
  });

  test('another user cannot find a private document', async ({ page, doc }) => {
    // `doc` belongs to the shared account and is private by default.
    await seedDisposableSession(page);
    await page.goto('/');
    await page.getByTestId('search-input').fill(doc.title);
    await expect(page.getByTestId('search-empty')).toBeVisible();
  });
});
