import type { DocumentAttachmentDTO } from '@xdocs/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { saveAttachment } from '../lib/attachments';
import { ConfirmDialog } from './ConfirmDialog';

/** Rounded, because the exact byte count of an attachment tells nobody anything. */
function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Every file attached to this document, including any nothing links to.
 *
 * Deleting the link to a file cannot delete the file — the deletion is
 * undoable, the link may be in someone else's unsynced edit — so unused files
 * used to pile up invisibly, reachable only by whoever still had the link.
 * Here they are listed, marked as in use or not, and can be deleted.
 */
export function DocumentFiles({ documentId, reloadKey }: { documentId: string; reloadKey: number }) {
  const [files, setFiles] = useState<DocumentAttachmentDTO[]>([]);
  const [pendingDelete, setPendingDelete] = useState<DocumentAttachmentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await api.listAttachments(documentId));
    } catch {
      // A list of files is not worth an error banner over the document.
    }
  }, [documentId]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  if (files.length === 0) return null;

  const remove = async (file: DocumentAttachmentDTO) => {
    setPendingDelete(null);
    try {
      await api.deleteAttachment(file.id);
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete that file.');
    }
  };

  return (
    <section className="doc-files" data-testid="doc-files" aria-label="Files">
      <h2 className="sub-docs-title">Files</h2>
      <ul className="doc-files-list">
        {files.map((file) => (
          <li key={file.id} className="doc-file" data-testid="doc-file" data-linked={file.linked}>
            <button
              type="button"
              className="doc-file-open"
              data-testid="doc-file-open"
              onClick={() => {
                saveAttachment(file.id, file.filename).catch(() =>
                  setError(`Could not download “${file.filename}”.`),
                );
              }}
            >
              {file.filename}
            </button>
            <span className="doc-file-meta">
              {readableSize(file.size)}
              {!file.linked && (
                // Not an error: a file can outlive the text that linked it,
                // and undo can bring that text back.
                <span className="doc-file-unused" data-testid="doc-file-unused">
                  not used in this document
                </span>
              )}
            </span>
            <button
              type="button"
              className="doc-file-delete"
              data-testid="doc-file-delete"
              title={`Delete ${file.filename}`}
              aria-label={`Delete ${file.filename}`}
              onClick={() => setPendingDelete(file)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="block-note block-note-error" role="alert" data-testid="doc-files-error">
          {error}
        </p>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete file"
          message={`“${pendingDelete.filename}” will be permanently deleted. This cannot be undone.`}
          warning={
            pendingDelete.linked
              ? 'This document still links to it, and that link will stop working.'
              : null
          }
          confirmLabel="Delete file"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void remove(pendingDelete)}
        />
      )}
    </section>
  );
}
