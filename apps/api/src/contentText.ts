import { BLOCKS_KEY, blockFragmentName, type BlockMeta } from '@xdocs/shared';
import * as Y from 'yjs';

/**
 * Plain text of a document's blocks, in document order.
 *
 * Search needs something Postgres can index, and the real content is an opaque
 * Yjs update in `ystate`. This flattens it once per save, the same way `title`
 * is mirrored — see `documents.content_text`.
 *
 * A document is far more text than Postgres needs to answer "does it mention
 * invoices", and ts_headline slows down markedly on very long inputs, so the
 * result is capped. Truncation only costs matches deep inside an unusually
 * large document.
 */
const MAX_CHARS = 100_000;

export function readContentText(doc: Y.Doc): string {
  const blocks = doc.getArray<BlockMeta>(BLOCKS_KEY).toArray();
  const parts: string[] = [];
  let length = 0;

  for (const block of blocks) {
    if (!block?.id) continue;
    const text = textOf(doc.getXmlFragment(blockFragmentName(block.id))).trim();
    if (text.length === 0) continue;
    parts.push(text);
    length += text.length + 1;
    if (length >= MAX_CHARS) break;
  }

  return parts.join('\n').slice(0, MAX_CHARS);
}

/** TipTap's node name for a table row; see TABLE_CELL_SEPARATOR. */
export const TABLE_ROW = 'tableRow';

/**
 * How a table reads as text: a line per row, its cells joined by this.
 *
 * Without it every cell came out on a line of its own, and a table read over
 * REST was a column of words with nothing to say which belonged together. A
 * cell holding several paragraphs is folded onto one line for the same reason.
 */
export const TABLE_CELL_SEPARATOR = ' | ';

/**
 * Walk a fragment for its characters only.
 *
 * Not `toString()`: that serialises marks as XML, so a bolded word would enter
 * the index as `<strong>invoice</strong>` and searching for "strong" would
 * match every document that uses bold.
 */
export function textOf(node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : ''))
      .join('');
  }
  /*
   * An image has no text, only attributes. Its filename lives in `alt`, so
   * taking that is what makes an image findable by name and gives the REST
   * content view something to show for it.
   */
  if (node instanceof Y.XmlElement && node.nodeName === 'image') {
    return node.getAttribute('alt') ?? '';
  }
  // One line per row, cells beside each other; see TABLE_CELL_SEPARATOR.
  if (node instanceof Y.XmlElement && node.nodeName === TABLE_ROW) {
    const cells: string[] = [];
    for (let i = 0; i < node.length; i++) {
      cells.push(textOf(node.get(i)).replace(/\n+/g, ' '));
    }
    return cells.join(TABLE_CELL_SEPARATOR);
  }
  if (node instanceof Y.XmlFragment || node instanceof Y.XmlElement) {
    const children: string[] = [];
    for (let i = 0; i < node.length; i++) {
      children.push(textOf(node.get(i)));
    }
    // Block-level children (list items, code lines) are separate lines; inline
    // marks are not, and they arrive as XmlText handled above.
    return children.join(node instanceof Y.XmlFragment ? '\n' : '');
  }
  return '';
}
