import { authHeaders } from '../test-auth.mjs';
import { blockEditor, blocks, blockTexts, expect, getTestToken, openDocument, test } from './fixtures';

const API = 'http://localhost:3001';

/*
 * The content bridge, from the browser's side.
 *
 * This is the layer that proves the design: an edit made over REST joins the
 * document as a participant, so it appears in an editor that is already open.
 * Writing the `ystate` column directly would pass every server-side test and
 * fail exactly here — the open editor would never see it, and would overwrite
 * it on its next save.
 */
test.describe('content API', () => {
  test('an API write appears live in an open editor', async ({ page, doc }) => {
    await openDocument(page, doc);

    const token = await getTestToken();
    await page.request.put(`${API}/api/documents/${doc.id}/content`, {
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      data: { blocks: ['Written from a script', 'While you were watching'] },
    });

    // No reload: the text has to arrive over the socket.
    await expect
      .poll(() => blockTexts(page), { timeout: 10_000 })
      .toEqual(['Written from a script', 'While you were watching']);
  });

  test('an API-written code block renders as one code block in an open editor', async ({ page, doc }) => {
    await openDocument(page, doc);

    const diagram = '+-----+\n|  a  |  indented\n+-----+';
    const token = await getTestToken();
    await page.request.put(`${API}/api/documents/${doc.id}/content`, {
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      data: { blocks: ['Diagram:', { type: 'code', text: diagram }] },
    });

    // The server builds the node by name; if that name drifted from TipTap's,
    // the editor would drop it rather than render it, and only a browser sees.
    await expect(blocks(page)).toHaveCount(2, { timeout: 10_000 });
    const pre = blockEditor(page, 1).locator('pre');
    await expect(pre).toHaveCount(1);
    await expect.poll(() => pre.evaluate((el) => el.textContent)).toBe(diagram);
    await expect(blockEditor(page, 1).locator('p')).toHaveCount(0);
  });

  test('an API title change appears live', async ({ page, doc }) => {
    await openDocument(page, doc);
    const token = await getTestToken();
    await page.request.put(`${API}/api/documents/${doc.id}/content`, {
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      data: { title: 'Renamed by a script', blocks: ['body'] },
    });

    await expect(page.getByTestId('title-input')).toHaveValue('Renamed by a script');
  });

  test('text typed in the browser is readable over the API', async ({ page, doc }) => {
    await openDocument(page, doc);
    await page.locator('.block-body').first().click();
    await page.keyboard.type('Typed in a browser');

    const token = await getTestToken();
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${API}/api/documents/${doc.id}/content`, {
            headers: authHeaders(token),
          });
          const body = (await response.json()) as { blocks: Array<{ text: string }> };
          return body.blocks.map((block) => block.text);
        },
        { timeout: 10_000 },
      )
      .toContain('Typed in a browser');
  });
});
