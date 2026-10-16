import { readFileSync } from 'node:fs';
import { blockEditor, blocks, expect, openDocument, test, typeInBlock } from './fixtures';

test.describe('command palette', () => {
  test('typing \\ opens the palette and filters as you type', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();

    await page.keyboard.type('\\');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect(page.getByTestId('palette-item-exportToPdf')).toBeVisible();

    await page.keyboard.type('exp');
    await expect(page.getByTestId('palette-item-exportToPdf')).toBeVisible();

    await page.keyboard.type('zzz');
    await expect(page.getByTestId('palette-empty')).toBeVisible();
  });

  test('Escape dismisses the palette', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();

    await page.keyboard.type('\\ex');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toBeHidden();
  });

  test('a backslash mid-word does not trigger the palette', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'path');
    await page.keyboard.type('\\');

    // Suggestion only fires at a word boundary, so ordinary text is unaffected.
    await expect(page.getByTestId('command-palette')).toBeHidden();
    await expect(blockEditor(page, 0)).toContainText('path\\');
  });

  test('Enter runs the command and downloads a real PDF', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Exported content');
    // Give the document a title so the filename is predictable.
    await page.getByTestId('title-input').fill('Quarterly Notes');

    await blockEditor(page, 0).click();
    await page.keyboard.press('End');
    // A space first: the palette deliberately ignores a mid-word backslash.
    await page.keyboard.type(' \\export');
    await expect(page.getByTestId('palette-item-exportToPdf')).toBeVisible();

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.keyboard.press('Enter');
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('quarterly-notes.pdf');

    // Prove it is genuinely a PDF, not an empty or HTML file.
    const path = await download.path();
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  test('running a command leaves no trigger text behind', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Keep me');
    await page.keyboard.type(' \\export');

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.keyboard.press('Enter');
    await downloadPromise;

    // The typed `\export` must not survive into the document.
    await expect(blockEditor(page, 0)).toHaveText('Keep me');
    await expect(blocks(page)).toHaveCount(1);
  });
});
