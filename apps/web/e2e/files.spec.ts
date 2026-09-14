import type { Page } from '@playwright/test';
import { blockEditor, expect, openDocument, test } from './fixtures';

/*
 * The document's file list (#26).
 *
 * Deleting the link to a file cannot delete the file — that deletion is
 * undoable — so files outlive their links. The list is how they stay visible,
 * and how one gets removed.
 */
const files = (page: Page) => page.getByTestId('doc-file');

async function attach(page: Page, name: string, body = 'a file') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('tb-attach-file').click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
}

test.describe('document files', () => {
  test('a document with no files shows no list', async ({ page, doc }) => {
    await openDocument(page, doc);
    await expect(page.getByTestId('doc-files')).toHaveCount(0);
  });

  test('an attached file is listed, with its size, and marked as used', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await attach(page, 'notes.txt', 'hello');

    await expect(files(page)).toHaveCount(1);
    await expect(files(page)).toContainText('notes.txt');
    await expect(files(page)).toContainText('5 B');
    await expect(page.getByTestId('doc-file-unused')).toHaveCount(0);
  });

  test('removing its link leaves the file, marked unused', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await attach(page, 'orphan.txt');
    await expect(files(page)).toHaveCount(1);

    // Clear the block: the link goes, the file does not.
    await blockEditor(page, 0).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');

    await expect(page.getByTestId('doc-file-unused')).toBeVisible();
    await expect(files(page)).toHaveCount(1);
  });

  test('a file can be deleted, and says so first', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await attach(page, 'goodbye.txt');
    await expect(files(page)).toHaveCount(1);

    await files(page).hover();
    await page.getByTestId('doc-file-delete').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('goodbye.txt');
    // The link in the text still points at it, and that is worth knowing.
    await expect(page.getByTestId('confirm-warning')).toBeVisible();
    await page.getByTestId('confirm-delete').click();

    await expect(page.getByTestId('doc-files')).toHaveCount(0);
  });

  test('cancelling keeps the file', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await attach(page, 'kept.txt');
    await files(page).hover();
    await page.getByTestId('doc-file-delete').click();

    await page.getByTestId('confirm-cancel').click();

    await expect(files(page)).toHaveCount(1);
  });
});
