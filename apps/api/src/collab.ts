import { Database } from '@hocuspocus/extension-database';
import { Server } from '@hocuspocus/server';
import { BLOCKS_KEY, blockFragmentName, type BlockMeta } from '@xdocs/shared';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { getDb } from './db/index.js';
import { documents } from './db/schema.js';

/** `doc:<uuid>` -> `<uuid>`; null for anything we don't recognise. */
function documentIdFrom(documentName: string): string | null {
  const [prefix, id] = documentName.split(':');
  return prefix === 'doc' && id ? id : null;
}

/** Collect plain text out of a Y.XmlFragment without needing a DOM. */
function fragmentText(fragment: Y.XmlFragment): string {
  let out = '';
  const walk = (node: Y.XmlElement | Y.XmlFragment | Y.XmlText | Y.XmlHook): void => {
    if (node instanceof Y.XmlText) {
      out += node.toString();
      return;
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) walk(child);
    }
  };
  walk(fragment);
  return out;
}

/**
 * Title is derived from the first block's text so the sidebar stays meaningful
 * without a separate title input. Falls back to whatever is already stored.
 */
function deriveTitle(doc: Y.Doc): string | null {
  const blocks = doc.getArray<BlockMeta>(BLOCKS_KEY).toArray();
  const first = blocks[0];
  if (!first) return null;
  const text = fragmentText(doc.getXmlFragment(blockFragmentName(first.id))).trim();
  if (!text) return null;
  return text.slice(0, 200);
}

const server = new Server({
  port: Number(process.env.COLLAB_PORT ?? 1234),
  address: '0.0.0.0',
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const id = documentIdFrom(documentName);
        if (!id) return null;
        const [row] = await getDb()
          .select({ ystate: documents.ystate })
          .from(documents)
          .where(eq(documents.id, id));
        return row?.ystate ? new Uint8Array(row.ystate) : null;
      },

      store: async ({ documentName, state, document }) => {
        const id = documentIdFrom(documentName);
        if (!id) return;
        const title = deriveTitle(document);
        await getDb()
          .update(documents)
          .set({
            ystate: Buffer.from(state),
            updatedAt: new Date(),
            ...(title ? { title } : {}),
          })
          .where(eq(documents.id, id));
      },
    }),
  ],

  onConnect: async ({ documentName }) => {
    // Refuse connections for documents that were never created over REST,
    // otherwise a typo'd id silently creates an orphan CRDT in memory.
    const id = documentIdFrom(documentName);
    if (!id) throw new Error(`Malformed document name: ${documentName}`);
    const [row] = await getDb()
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, id));
    if (!row) throw new Error(`Unknown document: ${id}`);
  },
});

void server.listen().then(() => {
  console.log(`[collab] ws://localhost:${process.env.COLLAB_PORT ?? 1234}`);
});
