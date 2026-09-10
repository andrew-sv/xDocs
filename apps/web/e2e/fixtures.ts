import { test as base, expect, type Page } from '@playwright/test';
import { authHeaders, createDisposableUser, signInForTests } from '../test-auth.mjs';

const API = 'http://localhost:3001';
const TOKEN_KEY = 'xdocs.session-token';

/**
 * One shared test session for the whole run.
 *
 * Google OAuth cannot be automated, so tests use the email+password provider
 * the API only enables under ALLOW_PASSWORD_LOGIN. Cached so parallel workers
 * do not each re-sign-in.
 */
let tokenPromise: Promise<string> | null = null;
export function getTestToken(): Promise<string> {
  tokenPromise ??= signInForTests(API);
  return tokenPromise;
}

/**
 * Put the session token in localStorage before any page script runs, so the app
 * boots already signed in and never renders the login gate.
 */
export async function seedDisposableSession(page: Page): Promise<{ email: string; name: string }> {
  const user = await createDisposableUser(API);
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [TOKEN_KEY, user.token] as const,
  );
  return { email: user.email, name: user.name };
}

export async function seedSession(page: Page): Promise<void> {
  const token = await getTestToken();
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [TOKEN_KEY, token] as const,
  );
}

export type TestDocument = { id: string; title: string };

export const test = base.extend<{ doc: TestDocument }>({
  // Every page starts signed in.
  page: async ({ page }, use) => {
    await seedSession(page);
    await use(page);
  },

  /**
   * Create the document over REST rather than through the UI: it is faster and
   * keeps each test independent, so specs can run fully parallel. Torn down
   * afterwards (a soft delete — the row survives by design).
   */
  doc: async ({ request }, use) => {
    const token = await getTestToken();
    const created = await request.post(`${API}/api/documents`, {
      headers: authHeaders(token),
      data: { title: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    const doc = (await created.json()) as TestDocument;
    await use(doc);
    await request
      .delete(`${API}/api/documents/${doc.id}`, { headers: authHeaders(token) })
      .catch(() => {});
  },
});

export { expect };

/** Open a document from the sidebar and wait until the CRDT has synced. */
export async function openDocument(page: Page, doc: TestDocument) {
  await page.goto('/');
  await page.locator(`[data-doc-id="${doc.id}"] [data-testid="doc-open"]`).click();
  // 'Live' only renders once connected AND synced, so it is the real ready gate.
  await expect(page.locator('.status')).toHaveText('Live');
  await expect(blocks(page).first()).toBeVisible();
}

export const blocks = (page: Page) => page.getByTestId('block');

/** The editable ProseMirror surface of the nth block. */
export const blockEditor = (page: Page, index: number) =>
  blocks(page).nth(index).locator('.tiptap');

/**
 * Add a block and wait until the caret has actually arrived in it.
 *
 * The editor instance does not exist on the new block's first render, so focus
 * moves a tick later. Typing before that lands the first keystrokes in the
 * previously focused block, which is a genuine race a fast typist can hit.
 * Waiting here also asserts the click focused the new block.
 */
export async function addBlock(page: Page) {
  const before = await blocks(page).count();
  await page.getByTestId('add-block').click();
  await expect(blocks(page)).toHaveCount(before + 1);
  await expect(blockEditor(page, before)).toBeFocused();
}

export async function typeInBlock(page: Page, index: number, text: string) {
  await blockEditor(page, index).click();
  await page.keyboard.type(text);
}

/**
 * Text of every block, in order.
 *
 * Remote collaborator carets render inside the editor and their name labels
 * would otherwise be counted as document text, so they are stripped from a
 * clone before reading. Only shows up in multi-client tests.
 */
export async function blockTexts(page: Page): Promise<string[]> {
  return blocks(page)
    .locator('.tiptap')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const clone = node.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.collaboration-carets__caret').forEach((c) => c.remove());
        return (clone.textContent ?? '').trim();
      }),
    );
}

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
