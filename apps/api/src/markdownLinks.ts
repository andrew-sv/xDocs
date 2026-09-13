import type { WriteBlockInput } from '@xdocs/shared';
import * as Y from 'yjs';

/**
 * Links in block text over REST, written the Markdown way: `[label](href)`.
 *
 * The content routes are text-only, so a link used to vanish in both
 * directions: reading a document returned bare words, and nothing written
 * through the API or MCP could link anywhere. A tiny notation costs less than
 * a structured shape for what is, from a caller's side, one string per block.
 *
 * Only links are represented. Bold and the rest stay plain text — they are not
 * information a caller can act on, whereas an address is.
 */

/**
 * What an href may be, matching the editor's own rule (TipTap Link's
 * `isAllowedUri`): the protocols it allows, or an in-app path. Anything else —
 * `javascript:` above all — is refused rather than quietly written in, since
 * the editor would render it as an empty href anyway.
 */
const ALLOWED_HREF = /^(?:(?:https?|mailto|tel|ftp|ftps|sms|callto|cid|xmpp):|[/#])/i;

/** One stretch of block text, linked or not. */
export type TextRun = { text: string; href?: string };

/** `\x` -> `x`, for a bracket or backslash the caller escaped. */
const unescape = (text: string) => text.replace(/\\(.)/g, '$1');

const escapeText = (text: string) => text.replace(/([\\[\]])/g, '\\$1');
const escapeHref = (href: string) => href.replace(/([\\()])/g, '\\$1');

const LINK = /\[((?:\\.|[^\\\]])*)\]\(((?:\\.|[^\\)])*)\)/g;

export class InvalidLinkError extends Error {}

/**
 * Split a line into runs. `[label](href)` becomes a linked run; a backslash
 * escapes a bracket, so literal brackets survive a round trip.
 */
export function parseLinks(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    const start = match.index;
    if (start > at) runs.push({ text: unescape(text.slice(at, start)) });
    const href = unescape(match[2] ?? '').trim();
    if (!ALLOWED_HREF.test(href)) {
      throw new InvalidLinkError(`“${href}” is not a link this editor can open.`);
    }
    runs.push({ text: unescape(match[1] ?? ''), href });
    at = start + match[0].length;
  }
  if (at < text.length) runs.push({ text: unescape(text.slice(at)) });
  return runs;
}

/** The inverse: what a caller can send back unchanged. */
export function formatLinks(runs: TextRun[]): string {
  return runs
    .map((run) => (run.href ? `[${escapeText(run.text)}](${escapeHref(run.href)})` : escapeText(run.text)))
    .join('');
}

/** Write runs into a Yjs text node, linked runs carrying a `link` mark. */
export function writeRuns(node: Y.XmlText, runs: TextRun[]): void {
  // The offset is tracked rather than read back from the node: it must already
  // be part of the document for `length` to mean anything (see writeBlocks).
  let at = 0;
  for (const run of runs) {
    if (run.text.length === 0) continue;
    /*
     * y-prosemirror stores a mark as an attribute named after it, holding its
     * own attributes — the same shape the editor writes when you make a link.
     * `link: null` on the plain runs is required, not tidiness: text inserted
     * next to a link inherits its formatting, so the words after one were
     * swallowed into it.
     */
    node.insert(at, run.text, run.href ? { link: { href: run.href } } : { link: null });
    at += run.text.length;
  }
}

/** The runs of a block, reading `link` marks back out of the CRDT. */
export function runsOf(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): TextRun[] {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .filter((op: { insert?: unknown }) => typeof op.insert === 'string')
      .map((op: { insert: string; attributes?: { link?: { href?: unknown } } }) => {
        const href = op.attributes?.link?.href;
        return typeof href === 'string' && href.length > 0
          ? { text: op.insert, href }
          : { text: op.insert };
      });
  }
  /*
   * An image has no text, only attributes; its filename lives in `alt`, which
   * is what contentText.ts mirrors for search. Reading it here keeps the
   * content view and the search index saying the same thing about an image.
   */
  if (node instanceof Y.XmlElement && node.nodeName === 'image') {
    const alt = node.getAttribute('alt');
    return alt ? [{ text: alt }] : [];
  }
  const runs: TextRun[] = [];
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i) as Y.XmlElement;
    // Block-level children (list items, paragraphs) are separate lines, as in
    // contentText.ts; inline marks arrive as XmlText above.
    if (node instanceof Y.XmlFragment && i > 0) runs.push({ text: '\n' });
    runs.push(...runsOf(child));
  }
  return runs;
}

/** A block as text, with its links written as `[label](href)`. */
export const markdownOf = (node: Y.XmlFragment): string => formatLinks(runsOf(node));

/**
 * The first link these blocks cannot use, or null.
 *
 * Callers check before writing anything: parsing throws, and a throw halfway
 * through a document would leave it half replaced.
 */
export function linkProblem(blocks: WriteBlockInput[]): string | null {
  for (const block of blocks) {
    const { type, text } = typeof block === 'string' ? { type: 'paragraph', text: block } : block;
    if (type === 'code') continue;
    try {
      parseLinks(text);
    } catch (e) {
      if (e instanceof InvalidLinkError) return e.message;
      throw e;
    }
  }
  return null;
}
