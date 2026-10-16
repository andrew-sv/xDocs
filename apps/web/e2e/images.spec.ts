import type { Page } from '@playwright/test';
import { blockEditor, expect, openDocument, test } from './fixtures';

/*
 * Inline images (#24).
 *
 * An image is an attachment rendered in place: the document holds a link to
 * `/api/attachments/<id>`, and the editor fetches the bytes with the session's
 * token and shows them from a blob — an <img> cannot send a bearer token.
 */

/** A 2x2 red PNG, small enough to inline. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z4AATAxQxhArIQAAAP//BqoA6ENkbcQAAAAASUVORK5CYII=',
  'base64',
);

const image = (page: Page) => blockEditor(page, 0).locator('img.block-image');

/** Is it actually painted, rather than a broken image icon? */
const isLoaded = (page: Page) =>
  image(page).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);

async function attach(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('tb-attach-file').click();
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: PNG });
}

test.describe('inline images', () => {
  test('attaching an image shows it, rather than linking it', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await attach(page, 'diagram.png');

    await expect(image(page)).toBeVisible();
    await expect(image(page)).toHaveAttribute('alt', 'diagram.png');
    // A file, not an image, is still a link: that is the other branch.
    await expect(blockEditor(page, 0).locator('a')).toHaveCount(0);
    await expect.poll(() => isLoaded(page)).toBe(true);
    // Fetched with the session's token and shown from a blob.
    await expect(image(page)).toHaveAttribute('src', /^blob:/);
  });

  test('an image survives a reload, and loads again', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await attach(page, 'kept.png');
    await expect(image(page)).toBeVisible();

    await page.reload();
    await expect(page.locator('.status')).toHaveText('Live');

    await expect(image(page)).toHaveAttribute('alt', 'kept.png');
    await expect.poll(() => isLoaded(page)).toBe(true);
  });

  test('a pasted image is uploaded and shown', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();

    // A paste carrying a file, which ProseMirror itself ignores.
    await page.evaluate((bytes) => {
      const file = new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(file);
      document
        .querySelector('.tiptap')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...PNG]);

    await expect(image(page)).toBeVisible();
    await expect(image(page)).toHaveAttribute('alt', 'pasted.png');
    await expect.poll(() => isLoaded(page)).toBe(true);
  });

  test('an image can be undone like any other content', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await attach(page, 'undone.png');
    await expect(image(page)).toBeVisible();

    await page.keyboard.press('ControlOrMeta+z');

    await expect(image(page)).toHaveCount(0);
  });
});
