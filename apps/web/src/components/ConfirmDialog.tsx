import { useEffect, useRef } from 'react';

type Props = {
  title: string;
  message: string;
  /** Extra warning shown in a stronger style, e.g. a cascading delete. */
  warning?: string | null;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ title, message, warning, confirmLabel, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" data-testid="confirm-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="confirm-dialog"
        // The backdrop closes on click; the dialog itself must not.
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title">{title}</h2>
        <p className="dialog-message" data-testid="confirm-message">
          {message}
        </p>
        {warning && (
          <p className="dialog-warning" data-testid="confirm-warning">
            {warning}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-cancel" data-testid="confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="dialog-confirm"
            data-testid="confirm-delete"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
