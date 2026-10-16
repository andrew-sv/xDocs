import { blockEditor, expect, openDocument, test } from './fixtures';

/*
 * The storage line in the sidebar (#27).
 *
 * The quota is otherwise invisible until an upload is refused, which is a poor
 * moment to learn there was one.
 */
test.describe('storage usage', () => {
  test('the sidebar shows what files are using', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();

    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('tb-attach-file').click();
    await (
      await chooser
    ).setFiles({
      name: 'counted.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(4096),
    });
    await expect(blockEditor(page, 0).locator('a')).toHaveText('counted.txt');

    // Read on load and when the window regains focus, so this is where a
    // reload picks it up; the line itself is not live.
    await page.reload();

    const usage = page.getByTestId('storage-usage');
    await expect(usage).toBeVisible();
    await expect(usage).toContainText('Files:');
    await expect(usage).toContainText('of');
  });
});
