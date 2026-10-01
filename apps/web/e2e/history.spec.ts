import type { DocumentVersionDTO } from '@xdocs/shared';
import type { Page } from '@playwright/test';
import { blockEditor, blockTexts, expect, mod, openDocument, seedSession, test, typeInBlock } from './fixtures';

/** Save a version from the open History dialog, and return it. */
async function saveVersion(page: Page): Promise<DocumentVersionDTO> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/versions$/.test(new URL(r.url()).pathname) && r.status() === 201,
    ),
    page.getByTestId('history-save').click(),
  ]);
  return response.json();
}

const entry = (page: Page, id: string) =>
  page.getByTestId('history-list').locator(`[data-version-id="${id}"]`);

/** Replace everything in the first block with `text`. */
async function rewriteFirstBlock(page: Page, text: string) {
  await blockEditor(page, 0).click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type(text);
}

test.describe('version history', () => {
  test('a saved version can be previewed and restored', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Original wording');

    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('history-dialog')).toBeVisible();
    const saved = await saveVersion(page);
    await expect(entry(page, saved.id)).toContainText('Saved by');
    // Saving selects the new version, so its preview is what is shown.
    await expect(page.getByTestId('history-preview')).toContainText('Original wording');
    await page.getByTestId('history-close').click();
    await expect(page.getByTestId('history-dialog')).toBeHidden();

    await rewriteFirstBlock(page, 'Rewritten wording');
    await expect.poll(() => blockTexts(page)).toEqual(['Rewritten wording']);

    await page.getByTestId('history-open').click();
    await entry(page, saved.id).click();
    await expect(page.getByTestId('history-preview')).toContainText('Original wording');
    await page.getByTestId('history-restore').click();
    await page.getByTestId('confirm-delete').click();

    // The restore arrives over the collab socket like anyone else's edit.
    await expect(page.getByTestId('history-dialog')).toBeHidden();
    await expect.poll(() => blockTexts(page)).toEqual(['Original wording']);

    // And what it replaced is one click away.
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('history-entry').first()).toContainText('restored an earlier version');
    await page.getByTestId('history-entry').first().click();
    await expect(page.getByTestId('history-preview')).toContainText('Rewritten wording');
  });

  test('a restore appears in another open editor', async ({ browser, page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Before');
    await page.getByTestId('history-open').click();
    const saved = await saveVersion(page);
    await page.getByTestId('history-close').click();
    await rewriteFirstBlock(page, 'After');

    const context = await browser.newContext();
    const other = await context.newPage();
    // Built by hand, so the page fixture never touched it.
    await seedSession(other);
    try {
      await openDocument(other, doc);
      await expect.poll(() => blockTexts(other)).toEqual(['After']);

      await page.getByTestId('history-open').click();
      await entry(page, saved.id).click();
      await expect(page.getByTestId('history-preview')).toContainText('Before');
      await page.getByTestId('history-restore').click();
      await page.getByTestId('confirm-delete').click();

      await expect.poll(() => blockTexts(other)).toEqual(['Before']);
    } finally {
      await context.close();
    }
  });

  test('Escape closes the dialog, and cancels a restore first', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Some text');
    await page.getByTestId('history-open').click();
    await saveVersion(page);
    await expect(page.getByTestId('history-preview')).toContainText('Some text');

    await page.getByTestId('history-restore').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm-dialog')).toBeHidden();
    await expect(page.getByTestId('history-dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-dialog')).toBeHidden();
  });
});
