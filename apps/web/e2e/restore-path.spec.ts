import type { Page } from '@playwright/test';
import { expect, seedDisposableSession, test } from './fixtures';

/*
 * A restored document opens where it lives in the tree, not at the top level.
 *
 * Throwaway users, as in trash.spec.ts: trash is per owner, so a fresh user's
 * trash holds exactly what the test put there.
 */
test.describe('restoring a nested document', () => {
  const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** A parent with one child, the child deleted, and the sidebar back at the top level. */
  async function nestedAndDeleted(page: Page) {
    await seedDisposableSession(page);
    await page.goto('/');
    await expect(page.getByTestId('doc-list-loading')).toHaveCount(0);

    const parent = `parent-${unique()}`;
    const child = `child-${unique()}`;
    await page.getByTestId('new-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    await page.getByTestId('title-input').fill(parent);
    await page
      .getByTestId('doc-list')
      .getByTestId('doc-row')
      .filter({ hasText: parent })
      .getByTestId('doc-open')
      .click();
    await expect(page.getByTestId('title-input')).toHaveValue(parent);

    await page.getByTestId('add-document').click();
    await expect(page.getByTestId('title-input')).toHaveValue('Untitled');
    await page.getByTestId('title-input').fill(child);

    const row = page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: child });
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await page.getByTestId('confirm-delete').click();
    await expect(page.getByTestId('toast')).toBeVisible();

    // Somewhere else entirely, so the restore cannot lean on the level on screen.
    await page.getByTestId('crumb-root').click();
    await expect(page.getByTestId('crumbs')).toBeHidden();
    return { parent, child };
  }

  test('from the Trash, it opens inside its parent with real breadcrumbs', async ({ page }) => {
    const { parent, child } = await nestedAndDeleted(page);

    await page.getByTestId('trash-toggle').click();
    await page
      .getByTestId('trash-row')
      .filter({ hasText: child })
      .getByTestId('trash-restore')
      .click();

    await expect(page.getByTestId('title-input')).toHaveValue(child);
    // The sidebar is at its parent's level: the parent is the path, and the
    // restored document is listed among the parent's sub-documents.
    await expect(page.getByTestId('crumb')).toHaveText([parent]);
    await expect(
      page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: child }),
    ).toHaveCount(1);
  });

  test('by undo, after navigating away, it still opens inside its parent', async ({ page }) => {
    const { parent, child } = await nestedAndDeleted(page);

    await page.getByTestId('toast-undo').click();

    await expect(page.getByTestId('title-input')).toHaveValue(child);
    await expect(page.getByTestId('crumb')).toHaveText([parent]);
    await expect(
      page.getByTestId('doc-list').getByTestId('doc-row').filter({ hasText: child }),
    ).toHaveCount(1);
  });
});
