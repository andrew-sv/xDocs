import type { ContentBlockDTO, DocumentVersionContentDTO, DocumentVersionDTO } from '@xdocs/shared';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';

type Props = {
  documentId: string;
  onClose: () => void;
};

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** What a version is, in the words of someone browsing history. */
function describe(version: DocumentVersionDTO): string {
  const who = version.author?.name ?? 'Someone';
  switch (version.reason) {
    case 'auto':
      return 'Saved automatically';
    case 'manual':
      return `Saved by ${who}`;
    case 'before-restore':
      return `Before ${who} restored an earlier version`;
    case 'before-replace':
      return `Before ${who} replaced the content through the API`;
  }
}

/**
 * Paragraph text arrives as the content routes write it: `[label](href)` for a
 * link, backslash-escaped brackets otherwise. Shown as the words, not the
 * notation — a preview is for recognising the wording.
 */
const LINK = /\[((?:\\.|[^\\\]])*)\]\(((?:\\.|[^\\)])*)\)/g;
const unescape = (text: string) => text.replace(/\\(.)/g, '$1');

function Paragraph({ text }: { text: string }) {
  const parts: Array<{ text: string; link: boolean }> = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    if (match.index > at) parts.push({ text: unescape(text.slice(at, match.index)), link: false });
    parts.push({ text: unescape(match[1] ?? ''), link: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: unescape(text.slice(at)), link: false });
  return (
    <p className="version-paragraph">
      {parts.map((part, i) =>
        part.link ? (
          <span key={i} className="version-link">
            {part.text}
          </span>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </p>
  );
}

function Block({ block }: { block: ContentBlockDTO }) {
  if (block.type === 'code') return <pre className="version-code">{block.text}</pre>;
  // A block holding a list or several lines reads back one line per item.
  return (
    <>
      {block.text.split('\n').map((line, i) => (
        <Paragraph key={i} text={line} />
      ))}
    </>
  );
}

/**
 * A document's earlier versions: pick one, read it, bring it back (#49).
 *
 * Restoring is an edit like any other — it lands in everyone's open editor —
 * and what it replaces is kept as a version first, so the dialog can say
 * plainly that nothing is lost by trying one.
 */
export function VersionHistory({ documentId, onClose }: Props) {
  const [versions, setVersions] = useState<DocumentVersionDTO[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentVersionContentDTO | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listVersions(documentId);
      setVersions(list);
      setSelected((current) => current ?? list[0]?.id ?? null);
    } catch (e) {
      setVersions([]);
      setError(e instanceof Error ? e.message : 'Could not load the history.');
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    // A slow preview must not replace the one picked after it.
    let current = true;
    setPreview(null);
    api.getVersion(documentId, selected).then(
      (body) => current && setPreview(body),
      (e: unknown) =>
        current && setError(e instanceof Error ? e.message : 'Could not load that version.'),
    );
    return () => {
      current = false;
    };
  }, [documentId, selected]);

  // Escape belongs to the confirmation while it is open.
  useEffect(() => {
    if (confirming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirming, onClose]);

  const saveNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveVersion(documentId);
      setSelected(saved.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save a version.');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!selected) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await api.restoreVersion(documentId, selected);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore that version.');
      setBusy(false);
    }
  };

  const chosen = versions?.find((v) => v.id === selected) ?? null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-history"
        role="dialog"
        aria-modal="true"
        aria-label="Version history"
        data-testid="history-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="history-header">
          <h2 className="dialog-title">Version history</h2>
          <button
            type="button"
            className="history-save"
            data-testid="history-save"
            disabled={busy}
            onClick={() => void saveNow()}
          >
            Save version now
          </button>
        </div>

        <div className="history-body">
          <ul className="history-list" data-testid="history-list">
            {versions === null && (
              <li className="doc-loading">
                <span className="spinner" role="status" aria-label="Loading history" />
              </li>
            )}
            {versions?.length === 0 && (
              <li className="history-empty">
                No earlier versions yet. They are kept as the document is edited, or when you save
                one.
              </li>
            )}
            {versions?.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  className={version.id === selected ? 'history-entry active' : 'history-entry'}
                  data-testid="history-entry"
                  data-version-id={version.id}
                  aria-current={version.id === selected}
                  onClick={() => setSelected(version.id)}
                >
                  <span className="history-when">{when.format(new Date(version.savedAt))}</span>
                  <span className="history-why">{describe(version)}</span>
                </button>
              </li>
            ))}
          </ul>

          <section className="history-preview" data-testid="history-preview" aria-label="Preview">
            {chosen && !preview && (
              <span className="spinner" role="status" aria-label="Loading version" />
            )}
            {preview && (
              <>
                <h3 className="version-title">{preview.content.title || 'Untitled'}</h3>
                {preview.content.blocks.map((block) => (
                  <Block key={block.id} block={block} />
                ))}
              </>
            )}
          </section>
        </div>

        {error && (
          <p className="dialog-warning" role="alert" data-testid="history-error">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-cancel"
            data-testid="history-close"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="dialog-confirm history-restore"
            data-testid="history-restore"
            disabled={!preview || busy}
            onClick={() => setConfirming(true)}
          >
            Restore this version
          </button>
        </div>

        {confirming && chosen && (
          <ConfirmDialog
            title="Restore this version?"
            message={`The document will read as it did on ${when.format(new Date(chosen.savedAt))}, for everyone who has it open. What it says now is kept in the history, so you can switch back.`}
            confirmLabel="Restore"
            onCancel={() => setConfirming(false)}
            onConfirm={() => void restore()}
          />
        )}
      </div>
    </div>
  );
}
