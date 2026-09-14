import { useEffect, useRef, useState } from 'react';

type Props = {
  /** Shown above the box: whose comment this will be. */
  authorName: string;
  initialText?: string;
  submitLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => void;
};

/**
 * Author name on top, a plain text box below, Cancel and Send.
 *
 * Deliberately a `textarea` and not a TipTap editor: a comment is a remark
 * about the document, not more document, and giving it the same rich-text
 * machinery would mean a second CRDT-bound editor per comment — dozens of
 * providers on a busy page, for formatting nobody asked for.
 */
export function CommentComposer({
  authorName,
  initialText = '',
  submitLabel = 'Send',
  placeholder = 'Add a comment…',
  autoFocus = false,
  onCancel,
  onSubmit,
}: Props) {
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const box = ref.current;
    if (!box) return;
    box.focus();
    // Caret at the end, so editing starts where you would keep typing.
    box.setSelectionRange(box.value.length, box.value.length);
  }, [autoFocus]);

  const trimmed = text.trim();
  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
    setText('');
  };

  return (
    <div className="comment-composer" data-testid="comment-composer">
      <span className="comment-author" data-testid="composer-author">
        {authorName}
      </span>
      <textarea
        ref={ref}
        className="comment-input"
        data-testid="comment-input"
        value={text}
        placeholder={placeholder}
        aria-label="Comment"
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Escape abandons the comment; the editor beneath must not also act
          // on either key, hence stopPropagation.
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
            return;
          }
          // Enter sends, Shift+Enter starts a new line — the convention
          // everywhere else a short message is typed.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            submit();
          }
        }}
      />
      <div className="comment-actions">
        <button type="button" className="comment-cancel" data-testid="comment-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="comment-send"
          data-testid="comment-send"
          // An empty comment is not a comment; the button says so rather than
          // accepting the click and doing nothing.
          disabled={!trimmed}
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
