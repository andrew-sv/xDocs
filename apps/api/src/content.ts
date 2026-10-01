import {
  BLOCKS_KEY,
  TITLE_KEY,
  blockFragmentName,
  type BlockMeta,
  type ContentBlockDTO,
  type ContentBlockType,
  type DocumentContentDTO,
} from '@xdocs/shared';
import * as Y from 'yjs';
import { textOf as textOfFragment } from './contentText.js';
import { markdownOf } from './markdownLinks.js';

/**
 * TipTap's node name for a code block. y-tiptap discards an element whose name
 * the editor's schema does not know, so this must match StarterKit exactly.
 */
export const CODE_BLOCK_NODE = 'codeBlock';

/** See `contentBlockTypeSchema`: a block is code only if that is all it holds. */
function contentTypeOf(fragment: Y.XmlFragment): ContentBlockType {
  const only = fragment.length === 1 ? fragment.get(0) : null;
  return only instanceof Y.XmlElement && only.nodeName === CODE_BLOCK_NODE ? 'code' : 'paragraph';
}

/**
 * The document as text: the same view `content_text` is built from.
 *
 * Shared by the content routes, which read the live document, and the version
 * routes, which read one decoded from a stored version — so a version previews
 * in exactly the shape a content read returns.
 */
export function readContent(id: string, doc: Y.Doc): DocumentContentDTO {
  const blocks: ContentBlockDTO[] = doc
    .getArray<BlockMeta>(BLOCKS_KEY)
    .toArray()
    .filter((block) => Boolean(block?.id))
    .map((block) => {
      const fragment = doc.getXmlFragment(blockFragmentName(block.id));
      const type = contentTypeOf(fragment);
      // Code is verbatim; everything else can carry links, so it is escaped
      // and its links written as [label](href) — the form writes accept back.
      const text = type === 'code' ? textOfFragment(fragment) : markdownOf(fragment);
      return { id: block.id, type, text };
    });
  return { id, title: doc.getText(TITLE_KEY).toString(), blocks };
}
