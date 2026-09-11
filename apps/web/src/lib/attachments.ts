import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Extension, type Editor } from '@tiptap/react';
import { ATTACHMENT_HREF, MAX_ATTACHMENT_BYTES } from '@xdocs/shared';
import { api } from './api';

/** The attachment id behind a link, or null for an ordinary URL. */
export function attachmentIdOf(href: string | null | undefined): string | null {
  return href ? (ATTACHMENT_HREF.exec(href)?.[1] ?? null) : null;
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
      { type: 'text', text: attachment.filename, marks: [{ type: 'link', attrs: { href: attachment.href } }] },
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
 * Clicking an attachment downloads it instead of navigating.
 *
 * Auth is a bearer token, which a plain link cannot carry, and the href is
 * origin-relative — opened directly it would land on the SPA, not the API.
 * StarterKit's Link would `window.open()` it on click, so this runs first:
 * priority above Link's 100, and it claims the click.
 */
export const AttachmentLinks = Extension.create<{ onError: (message: string) => void }>({
  name: 'attachmentLinks',
  priority: 1000,

  addOptions() {
    return { onError: () => {} };
  },

  addProseMirrorPlugins() {
    const { onError } = this.options;
    return [
      new Plugin({
        key: new PluginKey('attachmentLinks'),
        props: {
          handleClick: (view, _pos, event) => {
            if (event.button !== 0) return false;
            const link = event.target instanceof Element ? event.target.closest('a') : null;
            if (!link || !view.dom.contains(link)) return false;
            const id = attachmentIdOf(link.getAttribute('href'));
            if (!id) return false;
            event.preventDefault();
            saveAttachment(id, link.textContent?.trim() || 'download').catch((e: unknown) =>
              onError(e instanceof Error ? e.message : 'Download failed.'),
            );
            return true;
          },
        },
      }),
    ];
  },
});
