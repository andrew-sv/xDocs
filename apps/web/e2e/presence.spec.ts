import type { Page } from '@playwright/test';
import { TEST_USER, authHeaders } from '@xdocs/test-support/auth';
import {
  blockEditor,
  expect,
  getTestToken,
  openDocument,
  seedDisposableSession,
  seedSession,
  test,
  typeInBlock,
  type TestDocument,
} from './fixtures';

const API = 'http://localhost:3001';

/*
 * Collaborators are the people signed in, not a colour drawn per tab (#45).
 *
 * Every test here needs TWO ACCOUNTS, not two tabs: identity is now the
 * account, so the same user in two windows is deliberately one person. A pair
 * of shared-session tabs would prove nothing about names and would show an
 * empty collaborator list on purpose — which the last test pins down.
 */
test.describe('collaborator identity', () => {
  /** Public, so an account that does not own it can open it at all. */
  async function shareDocument(
    request: import('@playwright/test').APIRequestContext,
    doc: TestDocument,
  ) {
    await request.patch(`${API}/api/documents/${doc.id}/visibility`, {
      headers: authHeaders(await getTestToken(), { 'content-type': 'application/json' }),
      data: { visibility: 'public' },
    });
  }

  const caretLabels = (page: Page) =>
    page
      .locator('.collaboration-carets__label')
      .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));

  test("a caret carries the collaborator's real name", async ({ page, request, doc, browser }) => {
    await shareDocument(request, doc);
    await openDocument(page, doc);

    const context = await browser.newContext();
    const other = await context.newPage();
    try {
      const guest = await seedDisposableSession(other);
      await openDocument(other, doc);
      // A caret exists only where its owner has put one, so the guest types.
      await typeInBlock(other, 0, 'hello');

      // The signed-in name, not an animal.
      await expect.poll(() => caretLabels(page)).toContain(guest.name);
      await expect(blockEditor(page, 0)).toContainText('hello');
    } finally {
      await context.close();
    }
  });

  test('the collaborator list names who else is in the document', async ({
    page,
    request,
    doc,
    browser,
  }) => {
    await shareDocument(request, doc);
    await openDocument(page, doc);
    // Alone, there is no list at all rather than an empty one.
    await expect(page.getByTestId('collaborators')).toHaveCount(0);

    const context = await browser.newContext();
    const other = await context.newPage();
    try {
      const guest = await seedDisposableSession(other);
      await openDocument(other, doc);

      // Presence does not wait for anybody to type — opening the document is
      // what makes you present.
      await expect(page.getByTestId('collaborator')).toHaveCount(1);
      await expect(page.getByTestId('collaborator')).toHaveAttribute('title', guest.name);
      await expect(page.getByTestId('collaborators')).toHaveAttribute(
        'aria-label',
        `Also here: ${guest.name}`,
      );

      // And it is mutual: the guest sees the account that owns the document.
      await expect(other.getByTestId('collaborator')).toHaveAttribute('title', TEST_USER.name);

      // Leaving removes you, so the list cannot accumulate ghosts.
      await context.close();
      await expect(page.getByTestId('collaborators')).toHaveCount(0);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('the same person in two tabs is one collaborator, not two', async ({
    page,
    doc,
    browser,
  }) => {
    await openDocument(page, doc);

    const context = await browser.newContext();
    const twin = await context.newPage();
    try {
      // The SAME account as `page`, in a second window.
      await seedSession(twin);
      await openDocument(twin, doc);
      await typeInBlock(twin, 0, 'typing next door');

      // The edit arrives, so the two really are connected to one document...
      await expect(blockEditor(page, 0)).toContainText('typing next door');
      // ...and yet nobody else is here, because that is me.
      await expect(page.getByTestId('collaborators')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a reload keeps the same name and colour', async ({ page, request, doc, browser }) => {
    await shareDocument(request, doc);
    await openDocument(page, doc);

    const context = await browser.newContext();
    const other = await context.newPage();
    try {
      const guest = await seedDisposableSession(other);
      await openDocument(other, doc);

      const chip = page.getByTestId('collaborator');
      await expect(chip).toHaveAttribute('title', guest.name);
      const before = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);

      // The old identity was drawn at random when the module loaded, so this is
      // exactly where the same person used to come back as somebody else.
      await other.reload();
      await expect(other.locator('.status')).toHaveText('Live');

      await expect(page.getByTestId('collaborator')).toHaveAttribute('title', guest.name);
      const after = await page
        .getByTestId('collaborator')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(after).toBe(before);
    } finally {
      await context.close();
    }
  });
});
