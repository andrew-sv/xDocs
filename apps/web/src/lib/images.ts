import Image from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { attachmentHref, type AttachmentDTO } from '@xdocs/shared';
import { Extension, type Editor } from '@tiptap/react';
import { api } from './api';
import { attachmentIdOf } from './attachments';

export const isImage = (file: File): boolean => file.type.startsWith('image/');

/**
 * Blob URLs for attachments already fetched, one per attachment id.
 *
 * An <img> cannot send a bearer token, and the src in the document is the
 * origin-relative API path, so every image has to be fetched with the session's
 * credential and shown from a blob instead. Cached for the life of the tab:
 * the same image usually appears in one document repeatedly, and re-fetching
 * it on every re-render would be visible.
 */
const objectUrls = new Map<string, Promise<string>>();

function imageUrl(id: string): Promise<string> {
  const cached = objectUrls.get(id);
  if (cached) return cached;
  const loading = api.downloadAttachment(id).then(({ blob }) => URL.createObjectURL(blob));
  objectUrls.set(id, loading);
  // A failure must not be cached, or a reload is the only way to retry.
  loading.catch(() => objectUrls.delete(id));
  return loading;
}

/**
 * The standard `image` node, rendered from an authenticated fetch.
 *
 * Deliberately TipTap's own node name rather than a private one: y-tiptap
 * DELETES an element whose name the editor's schema does not know, so an
 * unknown node would be destroyed by any client that has not been reloaded.
 * `alt` carries the filename, which is what the server mirrors into
 * `content_text` (see contentText.ts) so images are searchable and the REST
 * content view shows them.
 */
export const AttachmentImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      /*
       * A holder element that ProseMirror never inspects.
       *
       * The image is swapped in once it has been fetched, and swapped for a
       * message if that fails. Both are DOM changes inside a node view, and
       * without `ignoreMutation` ProseMirror reads them as an edit: replacing
       * the <img> turned the image into a paragraph of text — and a reload,
       * which aborts the fetch in flight, was enough to trigger it.
       */
      const dom = document.createElement('div');
      dom.className = 'block-image-holder';

      const alt = (node.attrs.alt as string | null) ?? '';
      const src = (node.attrs.src as string | null) ?? '';
      const img = document.createElement('img');
      img.className = 'block-image';
      img.alt = alt;
      dom.append(img);

      const id = attachmentIdOf(src);
      if (!id) {
        // Not one of ours (pasted HTML, or an older document): leave it alone.
        img.src = src;
        return { dom, ignoreMutation: () => true };
      }

      dom.dataset.attachment = id;
      imageUrl(id).then(
        (url) => {
          img.src = url;
        },
        () => {
          img.remove();
          const failed = document.createElement('span');
          failed.className = 'block-image-missing';
          failed.textContent = alt ? `Could not load “${alt}”` : 'Could not load this image';
          dom.append(failed);
        },
      );

      return { dom, ignoreMutation: () => true };
    };
  },
});

/** Upload an image and place it at the caret. */
export async function insertImage(editor: Editor, documentId: string, file: File): Promise<void> {
  const attachment: AttachmentDTO = await api.uploadAttachment(documentId, file);
  if (editor.isDestroyed) return;
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'image',
      attrs: { src: attachmentHref(attachment.id), alt: attachment.filename },
    })
    .run();
}

/**
 * Pasting or dropping image files uploads them, instead of inserting nothing.
 *
 * ProseMirror ignores files it is handed — a pasted image is neither HTML nor
 * text — so without this a paste did nothing at all. Block reordering is
 * unaffected: it carries a private MIME type and no files.
 */
export const ImageDrop = Extension.create<{ onFiles: (files: File[]) => void }>({
  name: 'imageDrop',

  addOptions() {
    return { onFiles: () => {} };
  },

  addProseMirrorPlugins() {
    const { onFiles } = this.options;
    const handle = (list: FileList | null | undefined): boolean => {
      const files = [...(list ?? [])].filter(isImage);
      if (files.length === 0) return false;
      onFiles(files);
      return true;
    };
    return [
      new Plugin({
        key: new PluginKey('imageDrop'),
        props: {
          handlePaste: (_view, event) => handle(event.clipboardData?.files),
          handleDrop: (_view, event) => handle(event.dataTransfer?.files),
        },
      }),
    ];
  },
});
