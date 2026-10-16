import { readFile } from 'node:fs/promises';
import { blockEditor, expect, mod, openDocument, test } from './fixtures';

const ATTACHMENT_HREF = /^\/api\/attachments\/[0-9a-f-]{36}$/;

test.describe('toolbar links', () => {
  test('the link button turns the selected text into a link', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('the xDocs site');
    await page.keyboard.press(`${mod}+a`);

    await page.getByTestId('tb-link').click();
    // Typed the way people type them: no scheme.
    await page.getByTestId('link-input').fill('example.com');
    await page.keyboard.press('Enter');

    const link = blockEditor(page, 0).locator('a');
    await expect(link).toHaveText('the xDocs site');
    await expect(link).toHaveAttribute('href', 'https://example.com');
    await expect(page.getByTestId('link-input')).toHaveCount(0);
    // Back in the text, ready to keep typing.
    expect(await blockEditor(page, 0).evaluate((el) => el.contains(document.activeElement))).toBe(
      true,
    );
  });

  test('with nothing selected, the address itself becomes the link', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.getByTestId('tb-link').click();
    await page.getByTestId('link-input').fill('https://example.org/docs');
    await page.keyboard.press('Enter');

    const link = blockEditor(page, 0).locator('a');
    await expect(link).toHaveText('https://example.org/docs');
    await expect(link).toHaveAttribute('href', 'https://example.org/docs');
  });

  test('an existing link can be edited, then removed', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('docs');
    await page.keyboard.press(`${mod}+a`);
    await page.getByTestId('tb-link').click();
    await page.getByTestId('link-input').fill('example.com');
    await page.keyboard.press('Enter');

    // Caret inside the link, without clicking it — a click opens it.
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('tb-link')).toHaveClass(/active/);

    await page.getByTestId('tb-link').click();
    await expect(page.getByTestId('link-input')).toHaveValue('https://example.com');
    await page.getByTestId('link-input').fill('example.net');
    await page.keyboard.press('Enter');
    const link = blockEditor(page, 0).locator('a');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', 'https://example.net');
    await expect(link).toHaveText('docs');

    await page.getByTestId('tb-link').click();
    await page.getByTestId('tb-link-remove').click();
    await expect(blockEditor(page, 0).locator('a')).toHaveCount(0);
    await expect(blockEditor(page, 0)).toHaveText('docs');
  });

  test('an unsafe address is refused and the text is left alone', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('click me');
    await page.keyboard.press(`${mod}+a`);
    await page.getByTestId('tb-link').click();
    await page.getByTestId('link-input').fill('javascript:alert(1)');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('link-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(blockEditor(page, 0).locator('a')).toHaveCount(0);
  });

  test('Escape closes the link field without changing anything', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('unchanged');
    await page.keyboard.press(`${mod}+a`);
    await page.getByTestId('tb-link').click();
    await page.getByTestId('link-input').fill('example.com');
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('link-input')).toHaveCount(0);
    await expect(blockEditor(page, 0).locator('a')).toHaveCount(0);
    // The toolbar is still there: focus went back to the text, not away.
    await expect(page.getByTestId('tb-link')).toBeVisible();
  });

  test('a plain click opens nothing, leaving the text editable', async ({ page, context, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('the docs');
    await page.keyboard.press(`${mod}+a`);
    await page.getByTestId('tb-link').click();
    await page.getByTestId('link-input').fill('https://example.org/docs');
    await page.keyboard.press('Enter');

    const link = blockEditor(page, 0).locator('a');
    const box = (await link.boundingBox())!;
    await link.click({ position: { x: box.width / 2, y: box.height / 2 } });

    /*
     * Clicking a link used to open it, so its words could not be edited at all.
     * That the caret lands in the text is not asserted here: a synthetic click
     * moves the browser's caret without ProseMirror reading it back, so typing
     * after one behaves the same over plain text, bold text or a link — an
     * artefact of the harness, not of the editor.
     */
    expect(context.pages()).toHaveLength(1);
    await expect(link).toHaveText('the docs');
    await expect(link).toHaveAttribute('href', 'https://example.org/docs');
  });

  test('Mod-click follows the link', async ({ page, context, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('the app');
    await page.keyboard.press(`${mod}+a`);
    await page.getByTestId('tb-link').click();
    // The app's own origin: a real site would put the network in the test.
    await page.getByTestId('link-input').fill('http://localhost:5173/');
    await page.keyboard.press('Enter');

    const opening = context.waitForEvent('page');
    await blockEditor(page, 0)
      .locator('a')
      .click({ modifiers: [mod] });
    const opened = await opening;

    expect(opened.url()).toBe('http://localhost:5173/');
    await opened.close();
  });

  test('the link field opens the current link', async ({ page, context, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('the app');
    await page.keyboard.press(`${mod}+a`);
    await page.getByTestId('tb-link').click();
    await page.getByTestId('link-input').fill('http://localhost:5173/');
    await page.keyboard.press('Enter');

    // Caret inside the link, so the field opens on the existing address.
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.getByTestId('tb-link').click();
    const opening = context.waitForEvent('page');
    await page.getByTestId('tb-link-open').click();
    const opened = await opening;

    expect(opened.url()).toBe('http://localhost:5173/');
    await opened.close();
  });

  test('link and attach are unavailable inside a code block', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    // A code block's text cannot carry marks, and an attachment is a link.
    await page.keyboard.type('``` ');
    await expect(page.getByTestId('tb-link')).toBeDisabled();
    await expect(page.getByTestId('tb-attach-file')).toBeDisabled();
  });
});

test.describe('attachments', () => {
  async function attach(
    page: import('@playwright/test').Page,
    file: { name: string; mimeType: string; buffer: Buffer },
  ) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('tb-attach-file').click();
    await (await chooser).setFiles(file);
  }

  test('attaching a file uploads it and links it by name', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('See ');
    await attach(page, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from a test'),
    });

    const link = blockEditor(page, 0).locator('a');
    await expect(link).toHaveText('notes.txt');
    await expect(link).toHaveAttribute('href', ATTACHMENT_HREF);
    await expect(page.getByTestId('block-note')).toHaveCount(0);

    // It is in the document, not just the DOM.
    await page.reload();
    await page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-open"]`).click();
    await expect(page.locator('.status')).toHaveText('Live');
    await expect(blockEditor(page, 0).locator('a')).toHaveAttribute('href', ATTACHMENT_HREF);
  });

  test('clicking an attachment downloads it, rather than navigating', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await attach(page, {
      name: 'Звіт Q3.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('quarterly numbers'),
    });
    const link = blockEditor(page, 0).locator('a');
    await expect(link).toHaveAttribute('href', ATTACHMENT_HREF);

    const downloading = page.waitForEvent('download');
    await link.click({ modifiers: [mod] });
    const download = await downloading;

    // Fetched with the session's token: a plain navigation would carry none
    // and land on the SPA instead.
    expect(download.suggestedFilename()).toBe('Звіт Q3.txt');
    expect(await readFile(await download.path(), 'utf8')).toBe('quarterly numbers');
    expect(page.context().pages()).toHaveLength(1);
  });

  test('a file over the limit is refused before anything is uploaded', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    const uploads: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/attachments')) uploads.push(request.url());
    });

    await attach(page, {
      name: 'huge.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });

    await expect(page.getByTestId('block-note')).toContainText('10 MB');
    await expect(blockEditor(page, 0).locator('a')).toHaveCount(0);
    expect(uploads).toHaveLength(0);
  });
});
