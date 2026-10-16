import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Extension, type Editor } from '@tiptap/react';
import {
  ATTACHMENT_HREF,
  BLOCKS_KEY,
  MAX_ATTACHMENT_BYTES,
  blockFragmentName,
  type BlockMeta,
} from '@xdocs/shared';
import * as Y from 'yjs';
import { api } from './api';

/** The attachment id behind a link, or null for an ordinary URL. */
export function attachmentIdOf(href: string | null | undefined): string | null {
  return href ? (ATTACHMENT_HREF.exec(href)?.[1] ?? null) : null;
}

/**
 * Every attachment this document refers to: link marks, and image sources.
 *
 * The same reading the server makes when it marks a file used or unused (see
 * routes/attachments.ts), done locally so the file list can refetch when that
 * set changes — and only then, rather than on every keystroke.
 */
export function attachmentIdsIn(ydoc: Y.Doc): string[] {
  const ids = new Set<string>();
  const add = (href: unknown) => {
    const id = typeof href === 'string' ? attachmentIdOf(href) : null;
    if (id) ids.add(id.toLowerCase());
  };

  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as Array<{ attributes?: { link?: { href?: unknown } } }>) {
        add(op.attributes?.link?.href);
      }
      return;
    }
    if (node instanceof Y.XmlElement) add(node.getAttribute('src'));
    for (let i = 0; i < node.length; i++) walk(node.get(i));
  };

  for (const block of ydoc.getArray<BlockMeta>(BLOCKS_KEY).toArray()) {
    if (!block?.id) continue;
    walk(ydoc.getXmlFragment(blockFragmentName(block.id)));
  }
  return [...ids].sort();
}

/**
 * Upload a file and link it at the caret, named after the file.
 *
 * An attachment is an ordinary link to `/api/attachments/<id>`, not a node of
 * its own: the filename stays plain text (so search finds it and the REST
 * content view shows it), and a client that predates attachments still renders
 * a link rather than dropping an element its schema does not know.
 */
export async function attachFile(editor: Editor, documentId: string, file: File): Promise<void> {
  // Checked here too so a large file fails at once rather than after uploading.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`“${file.name}” is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`);
  }
  const attachment = await api.uploadAttachment(documentId, file);
  // The upload is slow enough for the block to have gone away meanwhile.
  if (editor.isDestroyed) return;
  editor
    .chain()
    .focus()
    .insertContent([
      {
        type: 'text',
        text: attachment.filename,
        marks: [{ type: 'link', attrs: { href: attachment.href } }],
      },
      // Typing after it should not extend the link.
      { type: 'text', text: ' ' },
    ])
    .run();
}

/** Fetch with the session's token and hand the result to the browser as a download. */
export async function saveAttachment(id: string, fallbackName: string): Promise<void> {
  const { blob, filename } = await api.downloadAttachment(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? fallbackName;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking at once can cancel the download before it starts in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Follow a link: download an attachment, or open a URL in a new tab.
 *
 * An attachment cannot simply be opened. Auth is a bearer token, which a link
 * cannot carry, and its href is origin-relative — followed directly it would
 * land on the SPA, not the API.
 */
export function followLink(
  href: string | null | undefined,
  fallbackName: string,
  onError: (message: string) => void,
): void {
  if (!href) return;
  const id = attachmentIdOf(href);
  if (!id) {
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  saveAttachment(id, fallbackName).catch((e: unknown) =>
    onError(e instanceof Error ? e.message : 'Download failed.'),
  );
}

/**
 * Mod-click follows a link; a plain click belongs to the text.
 *
 * StarterKit's Link opens a link on any click, which made the words of a link
 * uneditable: clicking into them to fix a typo navigated away instead. It is
 * configured with `openOnClick: false` (see BlockEditor) and this takes over,
 * so a plain click just places the caret. The toolbar's link field has an Open
 * button for anyone who does not know the shortcut.
 */
export const LinkClicks = Extension.create<{ onError: (message: string) => void }>({
  name: 'linkClicks',
  priority: 1000,

  addOptions() {
    return { onError: () => {} };
  },

  addProseMirrorPlugins() {
    const { onError } = this.options;
    return [
      new Plugin({
        key: new PluginKey('linkClicks'),
        props: {
          handleClick: (view, _pos, event) => {
            if (event.button !== 0) return false;
            if (!(event.metaKey || event.ctrlKey)) return false; // a plain click edits
            const link = event.target instanceof Element ? event.target.closest('a') : null;
            if (!link || !view.dom.contains(link)) return false;
            // The browser may also act on a modified click inside contenteditable.
            event.preventDefault();
            followLink(link.getAttribute('href'), link.textContent?.trim() || 'download', onError);
            return true;
          },
        },
      }),
    ];
  },
});
