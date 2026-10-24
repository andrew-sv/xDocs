import { ACCOUNT_NOT_ALLOWED } from '@xdocs/shared';
import { authHeaders, createDisposableUser } from '@xdocs/test-support/auth';
import { expect, test } from './fixtures';

const API = 'http://localhost:3001';

/*
 * 403 means two different things, and the client must tell them apart (#31).
 *
 * One is "this account may not use xDocs", which ends the session. Every other
 * one refuses a single action and must leave the session alone — the client
 * used to read them all the first way, so an owner-only route would have
 * signed the user out.
 */
test.describe('refused actions', () => {
  /**
   * A public document belonging to somebody else, and a way to get rid of it.
   *
   * It has to be owned elsewhere for the server to refuse, and public for this
   * account to see it at all. Nothing in the page creates it, so the `page`
   * fixture's tracker cannot purge it and the caller does so itself.
   */
  async function strangersPublicDocument(request: import('@playwright/test').APIRequestContext) {
    const stranger = await createDisposableUser(API);
    const headers = authHeaders(stranger.token);
    const created = await request.post(`${API}/api/documents`, {
      headers,
      data: { title: `pw-stranger-${Date.now()}` },
    });
    const doc = (await created.json()) as { id: string; title: string };
    await request.patch(`${API}/api/documents/${doc.id}/visibility`, {
      headers: { ...headers, 'content-type': 'application/json' },
      data: { visibility: 'public' },
    });
    const purge = async () => {
      await request.delete(`${API}/api/documents/${doc.id}`, { headers }).catch(() => {});
      await request.delete(`${API}/api/documents/${doc.id}/permanent`, { headers }).catch(() => {});
    };
    return { doc, purge };
  }

  /*
   * The delete control is hidden unless the row says you own it, so the only
   * way to reach the refusal through the UI is to make the row claim you do.
   * Only that one flag is faked: the click goes to the real route, which
   * refuses for the real reason, and the words asserted below are the server's
   * own. Nothing here mocks the 403 itself.
   */
  test('an owner-only refusal shows its reason and keeps you signed in', async ({
    page,
    request,
  }) => {
    const { doc, purge } = await strangersPublicDocument(request);
    try {
      await page.route('**/api/documents*', async (route) => {
        try {
          const response = await route.fetch();
          const rows = (await response.json()) as Array<{ id: string; isOwner: boolean }>;
          await route.fulfill({
            response,
            json: rows.map((row) => (row.id === doc.id ? { ...row, isOwner: true } : row)),
          });
        } catch {
          // The app refetches on every ping, so one of these is usually still in
          // flight when the test ends — "Route is already handled" then fails a
          // test that has otherwise passed. Nothing to do: the page is going.
        }
      });
      await page.goto('/');

      const row = page.locator(`[data-doc-id="${doc.id}"]`);
      await expect(row).toHaveCount(1);
      await row.hover();
      await row.getByTestId('doc-delete').click();
      await page.getByTestId('confirm-delete').click();

      // The server's own wording, not something the client invented.
      await expect(page.getByTestId('notice')).toContainText(
        'Only the owner can delete this document.',
      );
      // The whole point: still signed in, and the document is still there.
      await expect(page.getByTestId('login-gate')).toHaveCount(0);
      await expect(page.getByTestId('new-document')).toBeVisible();
      await expect(row).toHaveCount(1);

      await page.getByTestId('notice-dismiss').click();
      await expect(page.getByTestId('notice')).toHaveCount(0);
    } finally {
      await page.unroute('**/api/documents*').catch(() => {});
      await purge();
    }
  });

  /*
   * The other half: the allowlist refusal still ends the session.
   *
   * That check is driven by ALLOWED_EMAILS, which is deliberately unset in dev
   * and CI — every account is allowed there — so the response is injected here
   * rather than provoked. What is being tested is the client's half of the
   * contract: this code, and only this code, shows the gate.
   */
  test('the allowlist refusal still shows the gate, with its reason', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('new-document')).toBeVisible();

    const reason = 'This account is not authorised for xDocs.';
    await page.route('**/api/documents*', (route) =>
      route.fulfill({ status: 403, json: { error: reason, code: ACCOUNT_NOT_ALLOWED } }),
    );
    // Any refetch will do; the app refetches when the window regains focus.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expect(page.getByTestId('login-gate')).toBeVisible();
    await expect(page.getByTestId('login-gate')).toContainText(reason);
    await expect(page.getByTestId('new-document')).toHaveCount(0);
    // And the token is gone, so a reload does not walk back into the app.
    expect(
      await page.evaluate(() => window.localStorage.getItem('xdocs.session-token')),
    ).toBeNull();
  });
});
