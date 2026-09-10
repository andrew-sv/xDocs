import {
  addBlock,
  blockEditor,
  blocks,
  blockTexts,
  expect,
  openDocument,
  seedSession,
  test,
  typeInBlock,
} from './fixtures';

test.describe('collaboration', () => {
  test('edits sync live between two browsers', async ({ browser, doc }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    // These contexts are built by hand, so the page fixture never touched them.
    await seedSession(pageA);
    await seedSession(pageB);

    try {
      await openDocument(pageA, doc);
      await openDocument(pageB, doc);

      // A types; B must see it without a reload.
      await typeInBlock(pageA, 0, 'written by A');
      await expect(blockEditor(pageB, 0)).toContainText('written by A');

      // B adds a block; A must see both the block and its text.
      await addBlock(pageB);
      await pageB.keyboard.type('written by B');
      await expect(blocks(pageA)).toHaveCount(2);
      await expect.poll(() => blockTexts(pageA)).toEqual(['written by A', 'written by B']);

      // Structural changes converge too: B reorders, A follows.
      await blocks(pageB).nth(1).hover();
      await blocks(pageB).nth(1).getByTestId('block-handle').focus();
      await pageB.keyboard.press('ArrowUp');
      await expect.poll(() => blockTexts(pageA)).toEqual(['written by B', 'written by A']);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('the title is collaborative', async ({ browser, doc }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    // These contexts are built by hand, so the page fixture never touched them.
    await seedSession(pageA);
    await seedSession(pageB);

    try {
      await openDocument(pageA, doc);
      await openDocument(pageB, doc);

      await pageA.getByTestId('title-input').fill('Agreed title');

      await expect(pageB.getByTestId('title-input')).toHaveValue('Agreed title');
      // And it reaches B's sidebar, not just the header.
      await expect(pageB.locator(`[data-doc-id="${doc.id}"] .doc-title`)).toHaveText('Agreed title');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("a remote collaborator's caret is visible", async ({ browser, doc }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    // These contexts are built by hand, so the page fixture never touched them.
    await seedSession(pageA);
    await seedSession(pageB);

    try {
      await openDocument(pageA, doc);
      await openDocument(pageB, doc);

      await typeInBlock(pageA, 0, 'A is here');

      await expect(pageB.locator('.collaboration-carets__caret').first()).toBeVisible();
      await expect(pageB.locator('.collaboration-carets__label').first()).not.toBeEmpty();
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
