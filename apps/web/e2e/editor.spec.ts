import {
  addBlock,
  blockEditor,
  blocks,
  blockTexts,
  expect,
  openDocument,
  test,
  typeInBlock,
} from './fixtures';

test.describe('editing', () => {
  test('one click on "Add paragraph" adds exactly one block, from an editing state', async ({
    page,
    doc,
  }) => {
    // The two-click regression: mousedown used to blur the editor, unmounting
    // the toolbar and shifting the button out from under the pointer, so the
    // first click only exited edit mode.
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'editing away');
    await expect(blockEditor(page, 0)).toBeFocused();

    await page.getByTestId('add-block').click();

    await expect(blocks(page)).toHaveCount(2);
    await expect(blockEditor(page, 1)).toBeFocused();
  });

  test('Shift+Enter inserts a block below and moves the caret into it', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'first');
    await addBlock(page);
    await page.keyboard.type('third');

    // From the FIRST block, so we can prove it inserts below rather than at the end.
    await blockEditor(page, 0).click();
    await page.keyboard.press('Shift+Enter');

    await expect(blocks(page)).toHaveCount(3);
    await expect(blockEditor(page, 1)).toBeFocused();
    await page.keyboard.type('second');
    await expect.poll(() => blockTexts(page)).toEqual(['first', 'second', 'third']);
  });

  test('a heading block has no trailing empty paragraph', async ({ page, doc }) => {
    // trailingNode used to append a paragraph that came straight back on delete.
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'a heading');
    await page.getByTestId('tb-heading-1').click();

    await expect(blockEditor(page, 0).locator('h1')).toHaveText('a heading');
    await expect(blockEditor(page, 0).locator('> *')).toHaveCount(1);
  });

  test('a bullet list block has no trailing empty paragraph', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'an item');
    await page.getByTestId('tb-bullet-list').click();

    await expect(blockEditor(page, 0).locator('li')).toHaveText('an item');
    await expect(blockEditor(page, 0).locator('> *')).toHaveCount(1);
  });

  test('the toolbar applies formatting to the selection', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'make me bold');
    await page.keyboard.press('ControlOrMeta+a');
    await page.getByTestId('tb-bold').click();

    await expect(blockEditor(page, 0).locator('strong')).toHaveText('make me bold');
  });

  test('toolbar buttons show active state for the current formatting', async ({ page, doc }) => {
    // useEditor does not re-render on transactions in TipTap v3, so isActive()
    // read during render never updated and NO button ever lit up.
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'formatted');
    await page.keyboard.press('ControlOrMeta+a');

    await expect(page.getByTestId('tb-bold')).not.toHaveClass(/active/);
    await page.getByTestId('tb-bold').click();
    await expect(page.getByTestId('tb-bold')).toHaveClass(/active/);

    await page.getByTestId('tb-bold').click();
    await expect(page.getByTestId('tb-bold')).not.toHaveClass(/active/);
  });

  test('the last block cannot be deleted', async ({ page, doc }) => {
    await openDocument(page, doc);
    await expect(blocks(page)).toHaveCount(1);
    await blocks(page).first().hover();
    await expect(blocks(page).first().getByTestId('block-delete')).toBeHidden();
  });
});
