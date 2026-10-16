import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { TEST_ORIGIN, authHeaders, createDisposableUser, signInForTests } from '../test-auth.mjs';

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
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    TOKEN_KEY,
    user.token,
  ] as const);
  return { email: user.email, name: user.name };
}

export async function seedSession(page: Page): Promise<void> {
  const token = await getTestToken();
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    TOKEN_KEY,
    token,
  ] as const);
}

export type TestDocument = { id: string; title: string };

/**
 * Destroy a document and its subtree for good.
 *
 * A soft delete alone parked every run's documents in the test account's
 * Trash — over sixteen hundred of them. The permanent route only accepts
 * something already trashed, hence two steps. Either may fail harmlessly: the
 * test may have trashed it already, or it went with a purged ancestor.
 */
async function purgeDocument(
  request: APIRequestContext,
  id: string,
  headers: Record<string, string>,
) {
  const status = (response: Promise<APIResponse>) =>
    response.then(
      (r) => r.status(),
      () => 0,
    );
  const trashed = await status(request.delete(`${API}/api/documents/${id}`, { headers }));
  const purged = await status(request.delete(`${API}/api/documents/${id}/permanent`, { headers }));
  // 403 twice means it is already gone, with an ancestor or by the test's own
  // hand. Anything else short of a purge leaves a document behind.
  if (purged !== 204 && !(trashed === 403 && purged === 403)) {
    console.warn(
      `e2e cleanup: document ${id} was left behind (delete ${trashed}, purge ${purged})`,
    );
  }
}

/**
 * Record every document a page creates, with the credential that created it.
 *
 * Specs make documents through the UI too ("+ New", "+ Add document"), often
 * as a disposable user whose token only the page holds. Taking the header off
 * the create request itself means teardown can purge each one as its owner.
 */
function trackCreatedDocuments(
  page: Page,
): () => Promise<Array<{ id: string; authorization: string }>> {
  const pending: Array<Promise<{ id: string; authorization: string } | null>> = [];
  page.on('response', (response) => {
    const request = response.request();
    if (request.method() !== 'POST' || response.status() !== 201) return;
    if (new URL(response.url()).pathname !== '/api/documents') return;
    pending.push(
      Promise.all([response.json() as Promise<{ id: string }>, request.allHeaders()]).then(
        ([doc, headers]) =>
          headers.authorization ? { id: doc.id, authorization: headers.authorization } : null,
        () => null,
      ),
    );
  });
  return async () => (await Promise.all(pending)).filter((entry) => entry !== null);
}

export const test = base.extend<{ doc: TestDocument }>({
  // Every page starts signed in, and leaves nothing it created behind.
  page: async ({ page, request }, use) => {
    await seedSession(page);
    const created = trackCreatedDocuments(page);
    await use(page);
    for (const { id, authorization } of await created()) {
      await purgeDocument(request, id, { authorization, origin: TEST_ORIGIN });
    }
  },

  /**
   * Create the document over REST rather than through the UI: it is faster and
   * keeps each test independent, so specs can run fully parallel. Purged
   * afterwards, with everything created under it.
   */
  doc: async ({ request }, use) => {
    const token = await getTestToken();
    const created = await request.post(`${API}/api/documents`, {
      headers: authHeaders(token),
      data: { title: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    const doc = (await created.json()) as TestDocument;
    await use(doc);
    await purgeDocument(request, doc.id, authHeaders(token));
  },
});

export { expect };

/**
 * Run something that creates a document, and return the document it made.
 *
 * A spec that creates through the UI ("+ New", "+ Add document") otherwise has
 * no id to work with, and is left finding its own row by title — which is the
 * one thing about a row that is NOT reliable. The title is client-side state
 * until Hocuspocus's debounced save, the sidebar holds every public document
 * in the workspace beside it, and a ping refetches the list at any moment. A
 * spec that picks the wrong row there does not just fail: it adds its
 * sub-documents to somebody's real document (#29).
 *
 * The id from the create response is immune to all of that. Click rows by
 * `[data-doc-id="..."]`, as `openDocument()` below does.
 */
export async function createsDocument(
  page: Page,
  action: () => Promise<void>,
): Promise<{ id: string; parentId: string | null; title: string }> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === '/api/documents' &&
        r.status() === 201,
    ),
    action(),
  ]);
  return response.json();
}

/** The sidebar's own row for a document, by id rather than by title. */
export const docRow = (page: Page, id: string) =>
  page.getByTestId('doc-list').locator(`[data-doc-id="${id}"]`);

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
