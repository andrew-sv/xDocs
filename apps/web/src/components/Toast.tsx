import { undoShortcutLabel } from '../lib/identity';

type Props = {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
};

export function Toast({ message, onUndo, onDismiss }: Props) {
  return (
    <div className="toast" role="status" data-testid="toast">
      <span className="toast-message">{message}</span>
      <button type="button" className="toast-undo" data-testid="toast-undo" onClick={onUndo}>
        Undo
      </button>
      <span className="toast-key">{undoShortcutLabel}</span>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
