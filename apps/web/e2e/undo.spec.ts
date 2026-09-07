import {
  addBlock,
  blockEditor,
  blocks,
  blockTexts,
  expect,
  mod,
  openDocument,
  test,
  typeInBlock,
} from './fixtures';

/*
 * The regression this whole suite exists for. Undo shipped completely broken
 * while every CRDT-level test passed, because none of them ever mounted an
 * editor — and Collaboration destroys a shared UndoManager on editor teardown.
 * These tests fail if that wiring regresses.
 */
test.describe('undo', () => {
  test('Cmd+Z restores a deleted block and its text', async ({ page, doc }) => {
    await openDocument(page, doc);

    await typeInBlock(page, 0, 'first block');
    await addBlock(page);
    await page.keyboard.type('second block');
    await expect(blocks(page)).toHaveCount(2);

    // Delete the second block via its gutter button.
    await blocks(page).nth(1).hover();
    await blocks(page).nth(1).getByTestId('block-delete').click();
    await expect(blocks(page)).toHaveCount(1);
    await expect(page.getByTestId('toast')).toBeVisible();

    await page.keyboard.press(`${mod}+z`);

    await expect(blocks(page)).toHaveCount(2);
    // The text must come back too, not just an empty block.
    await expect.poll(() => blockTexts(page)).toEqual(['first block', 'second block']);
  });

  test('the toast Undo button restores a deleted block', async ({ page, doc }) => {
    await openDocument(page, doc);

    await typeInBlock(page, 0, 'keep me');
    await addBlock(page);
    await page.keyboard.type('delete me');
    await expect(blocks(page)).toHaveCount(2);

    await blocks(page).nth(1).hover();
    await blocks(page).nth(1).getByTestId('block-delete').click();
    await expect(blocks(page)).toHaveCount(1);

    await page.getByTestId('toast-undo').click();

    await expect(blocks(page)).toHaveCount(2);
    await expect.poll(() => blockTexts(page)).toEqual(['keep me', 'delete me']);
    await expect(page.getByTestId('toast')).toBeHidden();
  });

  test('undo steps back through typing inside a block', async ({ page, doc }) => {
    await openDocument(page, doc);

    await typeInBlock(page, 0, 'hello');
    await expect(blockEditor(page, 0)).toContainText('hello');

    // stopCapturing boundary: a pause makes the next run a separate stack item.
    await page.waitForTimeout(700);
    await page.keyboard.type(' world');
    await expect(blockEditor(page, 0)).toContainText('hello world');

    await page.keyboard.press(`${mod}+z`);
    await expect(blockEditor(page, 0)).toContainText('hello');
    await expect(blockEditor(page, 0)).not.toContainText('world');
  });

  test('undo keeps working after other blocks have unmounted', async ({ page, doc }) => {
    // The exact shape of the shipped bug: an unmount used to kill the shared
    // UndoManager, so undo silently stopped recording from then on.
    await openDocument(page, doc);

    await typeInBlock(page, 0, 'one');
    await addBlock(page);
    await page.keyboard.type('two');
    await addBlock(page);
    await page.keyboard.type('three');
    await expect(blocks(page)).toHaveCount(3);

    // Unmount a block, which is what used to break the manager.
    await blocks(page).nth(2).hover();
    await blocks(page).nth(2).getByTestId('block-delete').click();
    await expect(blocks(page)).toHaveCount(2);
    await page.getByTestId('toast-undo').click();
    await expect(blocks(page)).toHaveCount(3);

    // Now a NEW deletion must still be undoable.
    await blocks(page).nth(1).hover();
    await blocks(page).nth(1).getByTestId('block-delete').click();
    await expect(blocks(page)).toHaveCount(2);
    await page.keyboard.press(`${mod}+z`);

    await expect(blocks(page)).toHaveCount(3);
    await expect.poll(() => blockTexts(page)).toEqual(['one', 'two', 'three']);
  });
});
