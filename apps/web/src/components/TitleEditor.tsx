import { useEffect } from 'react';
import type * as Y from 'yjs';
import { applyTextEdit, useYText } from '../hooks/useYText';

type Props = {
  title: Y.Text;
  /** Lets the sidebar track the title live, ahead of the debounced DB write. */
  onChange: (title: string) => void;
};

export function TitleEditor({ title, onChange }: Props) {
  const value = useYText(title);

  useEffect(() => {
    onChange(value.trim() || 'Untitled');
  }, [value, onChange]);

  return (
    <input
      className="title-input"
      data-testid="title-input"
      value={value}
      placeholder="Untitled"
      aria-label="Document title"
      onChange={(e) => applyTextEdit(title, e.target.value)}
    />
  );
}
