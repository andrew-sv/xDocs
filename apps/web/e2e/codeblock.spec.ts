import { blockEditor, expect, openDocument, test } from './fixtures';

const TRANSPARENT = ['rgba(0, 0, 0, 0)', 'transparent'];

test.describe('code block', () => {
  test('renders as one continuous block, with no gaps between lines', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();

    // ``` plus a space is StarterKit's input rule for a code block.
    await page.keyboard.type('``` ');
    await page.keyboard.type('line one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('line two');

    const pre = blockEditor(page, 0).locator('pre');
    await expect(pre).toBeVisible();
    await expect(pre).toContainText('line one');
    await expect(pre).toContainText('line two');

    // The background must sit on the block-level <pre>...
    const preBg = await pre.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(TRANSPARENT).not.toContain(preBg);

    // ...and NOT on the inline <code>, which would paint one box per line and
    // leave the unpainted gaps this test exists to prevent.
    const codeBg = await pre.locator('code').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(TRANSPARENT).toContain(codeBg);
  });

  test('the code block is taller than a single line, so both lines are inside it', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('``` ');
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');

    const pre = blockEditor(page, 0).locator('pre');
    const box = (await pre.boundingBox())!;
    // Two lines plus padding: comfortably more than one line's height.
    expect(box.height).toBeGreaterThan(40);
  });

  test('inline code still has its own background', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('use `npm run dev` here');

    const code = blockEditor(page, 0).locator('code');
    await expect(code).toHaveText('npm run dev');
    const bg = await code.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(TRANSPARENT).not.toContain(bg);
  });
});
