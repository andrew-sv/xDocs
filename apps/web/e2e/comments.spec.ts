import type { Page } from '@playwright/test';
import { authHeaders } from '../test-auth.mjs';
import {
  blockEditor,
  expect,
  getTestToken,
  openDocument,
  seedDisposableSession,
  test,
  typeInBlock,
} from './fixtures';

const API = 'http://localhost:3001';

/**
 * Select exactly the first `length` characters of the first block.
 *
 * Character by character, deliberately. Double-click selects the whole
 * paragraph here rather than a word, and Cmd/Ctrl+Shift+Right is "select to
 * end of line" on macOS — both quietly comment the entire sentence, which
 * makes every assertion about WHICH text is highlighted meaningless.
 */
async function selectFirstWord(page: Page, length = 5) {
  await blockEditor(page, 0).click();
  await page.keyboard.press('Home');
  for (let i = 0; i < length; i += 1) await page.keyboard.press('Shift+ArrowRight');
}

async function commentFirstWord(page: Page, text: string) {
  await selectFirstWord(page);
  await page.getByTestId('tb-comment').click();
  await expect(page.getByTestId('comment-input')).toBeVisible();
  await page.getByTestId('comment-input').fill(text);
  await page.getByTestId('comment-send').click();
}

test.describe('comments', () => {
  test('commenting a selection opens a thread and highlights the text', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Alpha beta gamma');
    await expect(page.getByTestId('comments-empty')).toBeVisible();

    await selectFirstWord(page);
    await page.getByTestId('tb-comment').click();

    // The composer says whose comment this will be, per the spec.
    await expect(page.getByTestId('comment-composer')).toBeVisible();
    await expect(page.getByTestId('composer-author')).toHaveText('E2E User');
    // Nothing is written until Send: an empty thread would already be a
    // highlight on everyone else's screen with nothing behind it.
    await expect(page.getByTestId('thread')).toHaveCount(0);
    await expect(page.locator('.comment-mark')).toHaveCount(0);

    await page.getByTestId('comment-input').fill('Why alpha?');
    await page.getByTestId('comment-send').click();

    await expect(page.getByTestId('thread')).toHaveCount(1);
    await expect(page.getByTestId('comment-text')).toHaveText('Why alpha?');
    await expect(page.getByTestId('comments-count')).toHaveText('1');
    // Only the selected word is highlighted, not the whole block.
    await expect(page.locator('.comment-mark')).toHaveText('Alpha');
  });

  test('Cancel leaves no thread and no highlight', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Alpha beta gamma');

    await selectFirstWord(page);
    await page.getByTestId('tb-comment').click();
    await page.getByTestId('comment-input').fill('never mind');
    await page.getByTestId('comment-cancel').click();

    await expect(page.getByTestId('pending-thread')).toHaveCount(0);
    await expect(page.getByTestId('thread')).toHaveCount(0);
    await expect(page.locator('.comment-mark')).toHaveCount(0);
  });

  test('a thread is collapsed until it is clicked, and its highlight opens it', async ({
    page,
    doc,
  }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Alpha beta gamma');
    await commentFirstWord(page, 'Why alpha?');

    // Sending opens the thread it just created; collapse it again.
    await page.getByTestId('thread-summary').click();
    await expect(page.getByTestId('thread')).toHaveAttribute('data-open', 'false');
    await expect(page.getByTestId('comment-text')).toHaveCount(0);

    await page.getByTestId('thread-summary').click();
    await expect(page.getByTestId('thread')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('comment-text')).toBeVisible();

    // Collapse, then reach it from the document instead of the rail.
    await page.getByTestId('thread-summary').click();
    await expect(page.getByTestId('thread')).toHaveAttribute('data-open', 'false');
    await page.locator('.comment-mark').click();
    await expect(page.getByTestId('thread')).toHaveAttribute('data-open', 'true');
  });

  test('a thread can be replied to, edited and deleted', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Alpha beta gamma');
    await commentFirstWord(page, 'Why alpha?');

    // Reply.
    await page.getByTestId('comment-input').fill('Because of beta.');
    await page.getByTestId('comment-send').click();
    await expect(page.getByTestId('comment-text')).toHaveText(['Why alpha?', 'Because of beta.']);

    // Edit the first one.
    await page.getByTestId('comment-edit').first().click();
    await page.getByTestId('comment-input').first().fill('Why alpha, exactly?');
    await page.getByTestId('comment-send').first().click();
    await expect(page.getByTestId('comment-text').first()).toHaveText('Why alpha, exactly?');

    // Delete the reply; the thread and its highlight stay.
    await page.getByTestId('comment-delete').last().click();
    await expect(page.getByTestId('comment-text')).toHaveText(['Why alpha, exactly?']);
    await expect(page.locator('.comment-mark')).toHaveCount(1);

    // Delete the last comment: the thread goes, and so must the highlight, or
    // the document would keep a mark that opens nothing.
    await page.getByTestId('comment-delete').click();
    await expect(page.getByTestId('thread')).toHaveCount(0);
    await expect(page.locator('.comment-mark')).toHaveCount(0);
    await expect(page.getByTestId('comments-empty')).toBeVisible();
  });

  test('a thread survives a reload, because it lives in the document', async ({ page, doc }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Alpha beta gamma');
    await commentFirstWord(page, 'Why alpha?');
    await expect(page.getByTestId('thread')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.status')).toHaveText('Live');

    await expect(page.getByTestId('thread')).toHaveCount(1);
    await expect(page.locator('.comment-mark')).toHaveText('Alpha');
    await page.getByTestId('thread-summary').click();
    await expect(page.getByTestId('comment-text')).toHaveText('Why alpha?');
  });

  test('the rail folds away, remembers it, and unfolds when there is something to show', async ({
    page,
    doc,
  }) => {
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Alpha beta gamma');
    await commentFirstWord(page, 'Why alpha?');
    await expect(page.getByTestId('comments-rail')).toHaveAttribute('data-collapsed', 'false');

    await page.getByTestId('comments-toggle').click();
    await expect(page.getByTestId('comments-rail')).toHaveAttribute('data-collapsed', 'true');
    // Folded, not gone: a document with comments still says how many, and there
    // is something to click to get them back.
    await expect(page.getByTestId('comments-count')).toHaveText('1');
    await expect(page.getByTestId('thread')).toHaveCount(0);

    // It is a preference, so it outlives the page.
    await page.reload();
    await expect(page.locator('.status')).toHaveText('Live');
    await expect(page.getByTestId('comments-rail')).toHaveAttribute('data-collapsed', 'true');

    /*
     * The case that would otherwise fail silently: commenting while the rail is
     * folded away must unfold it, or pressing 💬 appears to do nothing at all
     * because the composer is behind the fold.
     */
    await selectFirstWord(page, 4);
    await page.getByTestId('tb-comment').click();
    await expect(page.getByTestId('comments-rail')).toHaveAttribute('data-collapsed', 'false');
    await expect(page.getByTestId('comment-input')).toBeVisible();
    await page.getByTestId('comment-cancel').click();

    // So must clicking a highlight in the text.
    await page.getByTestId('comments-toggle').click();
    await expect(page.getByTestId('comments-rail')).toHaveAttribute('data-collapsed', 'true');
    await page.locator('.comment-mark').first().click();
    await expect(page.getByTestId('comments-rail')).toHaveAttribute('data-collapsed', 'false');
    await expect(page.getByTestId('thread')).toHaveAttribute('data-open', 'true');
  });

  /*
   * Comments are CRDT state on the document, so they sync like the text does —
   * and a comment is attributed to the account that wrote it, which needs two
   * accounts to mean anything.
   */
  test('a comment reaches the other person, and only its author can change it', async ({
    page,
    request,
    doc,
    browser,
  }) => {
    await request.patch(`${API}/api/documents/${doc.id}/visibility`, {
      headers: authHeaders(await getTestToken(), { 'content-type': 'application/json' }),
      data: { visibility: 'public' },
    });
    await openDocument(page, doc);
    await typeInBlock(page, 0, 'Alpha beta gamma');

    const context = await browser.newContext();
    const other = await context.newPage();
    try {
      const guest = await seedDisposableSession(other);
      await openDocument(other, doc);

      await commentFirstWord(page, 'Why alpha?');

      // No reload: it arrives over the collab socket.
      await expect(other.getByTestId('thread')).toHaveCount(1);
      await other.getByTestId('thread-summary').click();
      await expect(other.getByTestId('comment-text')).toHaveText('Why alpha?');
      await expect(other.getByTestId('comment-author').first()).toHaveText('E2E User');
      // Somebody else's comment offers no Edit or Delete — the name stays on
      // it, so changing its words would misattribute them.
      await expect(other.getByTestId('comment-edit')).toHaveCount(0);
      await expect(other.getByTestId('comment-delete')).toHaveCount(0);

      // The guest replies, under their own name, and it comes back the other way.
      await other.getByTestId('comment-input').fill('Because of beta.');
      await other.getByTestId('comment-send').click();
      await expect(page.getByTestId('comment-text')).toHaveText(['Why alpha?', 'Because of beta.']);
      await expect(page.getByTestId('comment-author').last()).toHaveText(guest.name);
      // And the reply is theirs to manage, not ours.
      await expect(page.getByTestId('comment-edit')).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});
