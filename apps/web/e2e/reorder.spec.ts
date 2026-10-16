import { addBlock, blocks, blockTexts, expect, openDocument, test, typeInBlock } from './fixtures';

async function threeBlocks(
  page: import('@playwright/test').Page,
  doc: { id: string; title: string },
) {
  await openDocument(page, doc);
  await typeInBlock(page, 0, 'one');
  await addBlock(page);
  await page.keyboard.type('two');
  await addBlock(page);
  await page.keyboard.type('three');
  await expect.poll(() => blockTexts(page)).toEqual(['one', 'two', 'three']);
}

test.describe('reorder', () => {
  test('arrow keys on the drag handle move a block', async ({ page, doc }) => {
    await threeBlocks(page, doc);

    await blocks(page).nth(2).hover();
    await blocks(page).nth(2).getByTestId('block-handle').focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => blockTexts(page)).toEqual(['one', 'three', 'two']);

    await page.keyboard.press('ArrowUp');
    await expect.poll(() => blockTexts(page)).toEqual(['three', 'one', 'two']);

    // And must clamp at the top rather than wrapping or vanishing.
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => blockTexts(page)).toEqual(['three', 'one', 'two']);
  });

  test('dragging the handle below a block moves it after that block', async ({ page, doc }) => {
    await threeBlocks(page, doc);

    // Native HTML5 drag works under Chromium, but the drop EDGE depends on
    // whether the pointer is above or below the target's midpoint — so aim at a
    // definite point rather than the element centre, which is exactly the
    // boundary and resolves ambiguously.
    const target = blocks(page).nth(2);
    const box = (await target.boundingBox())!;

    await blocks(page).nth(0).hover();
    await blocks(page)
      .nth(0)
      .getByTestId('block-handle')
      .dragTo(target, {
        targetPosition: { x: box.width / 2, y: box.height * 0.8 },
      });

    await expect.poll(() => blockTexts(page)).toEqual(['two', 'three', 'one']);
  });

  test('dragging the handle above a block moves it before that block', async ({ page, doc }) => {
    await threeBlocks(page, doc);

    const target = blocks(page).nth(0);
    const box = (await target.boundingBox())!;

    await blocks(page).nth(2).hover();
    await blocks(page)
      .nth(2)
      .getByTestId('block-handle')
      .dragTo(target, {
        targetPosition: { x: box.width / 2, y: box.height * 0.2 },
      });

    await expect.poll(() => blockTexts(page)).toEqual(['three', 'one', 'two']);
  });

  test('a reordered block keeps its own text', async ({ page, doc }) => {
    await threeBlocks(page, doc);
    await blocks(page).nth(0).hover();
    await blocks(page).nth(0).getByTestId('block-handle').focus();
    await page.keyboard.press('ArrowDown');

    await expect.poll(() => blockTexts(page)).toEqual(['two', 'one', 'three']);
    await expect(blocks(page)).toHaveCount(3);
  });
});
