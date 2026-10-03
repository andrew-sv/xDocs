import { addBlock, blockEditor, blocks, expect, openDocument, seedSession, test, typeInBlock } from './fixtures';
import type { Page } from '@playwright/test';

/** Rows of the first table in a block, as cell texts. */
const tableCells = (page: Page, index: number) =>
  blockEditor(page, index)
    .locator('table tr')
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.children].map((cell) => {
          // A remote caret's name label would otherwise read as cell text.
          const clone = cell.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('.collaboration-carets__caret').forEach((c) => c.remove());
          return clone.textContent ?? '';
        }),
      ),
    );

async function insertTable(page: Page, index: number) {
  await blockEditor(page, index).click();
  await page.getByTestId('tb-table').click();
  await expect(blockEditor(page, index).locator('table')).toBeVisible();
}

test.describe('tables (#50)', () => {
  test('a table inserted into an empty block replaces it, with a header row', async ({ page, doc }) => {
    await openDocument(page, doc);
    await insertTable(page, 0);

    // The block IS the table: no empty paragraph left above or below it.
    await expect(blockEditor(page, 0).locator('> *')).toHaveCount(1);
    await expect(blockEditor(page, 0).locator('tr')).toHaveCount(3);
    await expect(blockEditor(page, 0).locator('tr').first().locator('th')).toHaveCount(3);
    await expect(blockEditor(page, 0).locator('td')).toHaveCount(6);
  });

  test('Tab moves cell to cell, and off the last cell adds a row', async ({ page, doc }) => {
    await openDocument(page, doc);
    await insertTable(page, 0);

    // The caret starts in the first cell.
    for (const word of ['a', 'b', 'c', 'd']) {
      await page.keyboard.type(word);
      await page.keyboard.press('Tab');
    }
    await expect.poll(() => tableCells(page, 0)).toEqual([['a', 'b', 'c'], ['d', '', ''], ['', '', '']]);

    // Moving into a cell selects what is in it, so typing replaces it.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('D');
    await expect.poll(() => tableCells(page, 0)).toEqual([['a', 'b', 'c'], ['D', '', ''], ['', '', '']]);

    // Into the last cell, then once more.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    await expect(blockEditor(page, 0).locator('tr')).toHaveCount(4);
    // Focus stayed in the editor, in the new row.
    expect(await blockEditor(page, 0).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  });

  test('the toolbar adds and deletes rows and columns, and the table', async ({ page, doc }) => {
    await openDocument(page, doc);
    await insertTable(page, 0);
    // Row and column controls only exist while the caret is in a table.
    await expect(page.getByTestId('tb-add-row')).toBeVisible();
    // Tables do not nest, so the insert button gives way to them.
    await expect(page.getByTestId('tb-table')).toHaveCount(0);

    await page.getByTestId('tb-add-row').click();
    await expect(blockEditor(page, 0).locator('tr')).toHaveCount(4);
    await page.getByTestId('tb-add-column').click();
    await expect(blockEditor(page, 0).locator('tr').first().locator('th')).toHaveCount(4);
    await page.getByTestId('tb-delete-column').click();
    await expect(blockEditor(page, 0).locator('tr').first().locator('th')).toHaveCount(3);
    await page.getByTestId('tb-delete-row').click();
    await expect(blockEditor(page, 0).locator('tr')).toHaveCount(3);

    await page.getByTestId('tb-delete-table').click();
    await expect(blockEditor(page, 0).locator('table')).toHaveCount(0);
    await expect(page.getByTestId('tb-add-row')).toHaveCount(0);
    // What is left is an ordinary block that still takes typing.
    await page.keyboard.type('after');
    await expect(blockEditor(page, 0)).toHaveText('after');
  });

  test('Shift+Enter in a cell still adds a block below', async ({ page, doc }) => {
    await openDocument(page, doc);
    await insertTable(page, 0);
    await page.keyboard.press('Shift+Enter');

    await expect(blocks(page)).toHaveCount(2);
    await expect(blockEditor(page, 1)).toBeFocused();
    // Not a hard break left behind in the cell.
    await expect(blockEditor(page, 0).locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(0);
  });

  test('a table syncs to another client and survives a reload', async ({ browser, doc }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await seedSession(pageA);
    await seedSession(pageB);

    try {
      await openDocument(pageA, doc);
      await openDocument(pageB, doc);

      await insertTable(pageA, 0);
      await pageA.keyboard.type('from A');
      await expect.poll(() => tableCells(pageB, 0)).toEqual([['from A', '', ''], ['', '', ''], ['', '', '']]);

      // B edits a different cell of the same table; A sees it.
      await blockEditor(pageB, 0).locator('td').first().click();
      await pageB.keyboard.type('from B');
      await expect.poll(() => tableCells(pageA, 0)).toEqual([['from A', '', ''], ['from B', '', ''], ['', '', '']]);

      await pageA.reload();
      await expect.poll(() => tableCells(pageA, 0)).toEqual([['from A', '', ''], ['from B', '', ''], ['', '', '']]);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("the table controls stay clear of the middle of the block above", async ({ page, doc }) => {
    // See the toolbar note in CLAUDE.md: it floats over the block above, and a
    // button over that block's middle swallows clicks meant for its text.
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'above');
    await addBlock(page);
    await page.getByTestId('tb-table').click();
    await expect(page.getByTestId('tb-delete-table')).toBeVisible();

    const above = (await blockEditor(page, 0).boundingBox())!;
    const group = (await page.locator('.toolbar-insert').boundingBox())!;
    expect(group.x).toBeGreaterThan(above.x + above.width / 2);
  });
});
