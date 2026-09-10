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

  test('long lines scroll rather than wrap, so indentation stays intact', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('``` ');

    const pre = blockEditor(page, 0).locator('pre');
    // prosemirror-view injects `.ProseMirror pre { white-space: pre-wrap }`;
    // wrapping restarts continuation lines at column 0 and destroys indentation.
    await expect(pre).toHaveCSS('white-space', 'pre');
  });

  test('Tab indents inside a code block instead of leaving the editor', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('``` ');
    await page.keyboard.type('def f():');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('return 1');

    const pre = blockEditor(page, 0).locator('pre');
    await expect.poll(() => pre.evaluate((el) => el.textContent)).toBe('def f():\n  return 1');
    // Focus must still be in the editor — by default Tab escapes it.
    expect(await blockEditor(page, 0).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  });

  test('Shift+Tab removes one level of indentation', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('``` ');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('x');
    await page.keyboard.press('Shift+Tab');

    const pre = blockEditor(page, 0).locator('pre');
    await expect.poll(() => pre.evaluate((el) => el.textContent)).toBe('  x');
  });

  test('Tab outside a code block still moves focus', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('plain paragraph');
    await page.keyboard.press('Tab');

    // Capturing Tab everywhere would trap keyboard users in the editor.
    expect(await blockEditor(page, 0).evaluate((el) => el.contains(document.activeElement))).toBe(false);
  });

  test('typed leading spaces survive a round trip', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('``` ');
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('    indented');

    const pre = blockEditor(page, 0).locator('pre');
    await expect.poll(() => pre.evaluate((el) => el.textContent)).toBe('a\n    indented');

    // And they must survive persistence, not just the live DOM.
    await page.reload();
    await page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-open"]`).click();
    await expect(page.locator('.status')).toHaveText('Live');
    await expect
      .poll(() => blockEditor(page, 0).locator('pre').evaluate((el) => el.textContent))
      .toBe('a\n    indented');
  });

  test('the toolbar button creates a code block', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('some code');

    await page.getByTestId('tb-code-block').click();

    await expect(blockEditor(page, 0).locator('pre')).toContainText('some code');
    await expect(blockEditor(page, 0).locator('pre')).toHaveCount(1);
  });

  test('converting several inline-code lines yields ONE block, not one per line', async ({ page, doc }) => {
    // The shape people actually produce: a paragraph per line, each marked as
    // inline code. TipTap's own toggleCodeBlock would make five separate
    // blocks — with exactly the margins between them we are trying to remove.
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    const lines = ['function f() {', '  if (x) {', '    return 1;', '  }', '}'];
    for (const [i, line] of lines.entries()) {
      await page.keyboard.type(line);
      if (i < lines.length - 1) await page.keyboard.press('Enter');
    }
    await page.keyboard.press('ControlOrMeta+a');
    await page.getByTestId('tb-code').click();
    await expect(blockEditor(page, 0).locator('p code')).toHaveCount(5);

    await page.keyboard.press('ControlOrMeta+a');
    await page.getByTestId('tb-code-block').click();

    const pre = blockEditor(page, 0).locator('pre');
    await expect(pre).toHaveCount(1);
    await expect(blockEditor(page, 0).locator('p')).toHaveCount(0);
    // Newlines and indentation both survive the conversion.
    await expect
      .poll(() => pre.evaluate((el) => el.textContent))
      .toBe('function f() {\n  if (x) {\n    return 1;\n  }\n}');
  });

  test('the code block button reports active state and toggles back', async ({ page, doc }) => {
    await openDocument(page, doc);
    await blockEditor(page, 0).click();
    await page.keyboard.type('x');

    await page.getByTestId('tb-code-block').click();
    await expect(page.getByTestId('tb-code-block')).toHaveClass(/active/);

    await page.getByTestId('tb-code-block').click();
    await expect(blockEditor(page, 0).locator('pre')).toHaveCount(0);
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
