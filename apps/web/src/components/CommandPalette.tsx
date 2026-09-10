import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PaletteState } from '../lib/commandPalette';

type Props = {
  state: PaletteState;
  /**
   * The palette owns selection, so it also owns the keys. The plugin calls this
   * before ProseMirror sees them; returning true consumes the key.
   */
  bindKeyHandler: (handler: ((event: KeyboardEvent) => boolean) | null) => void;
};

export function CommandPaletteMenu({ state, bindKeyHandler }: Props) {
  // Always via the plugin: it owns the range of the typed trigger text.
  const onSelect = state.run;
  const [active, setActive] = useState(0);
  const { items, rect } = state;

  // Whatever was typed may have narrowed the list past the current index.
  useEffect(() => {
    setActive((current) => (current < items.length ? current : 0));
  }, [items]);

  useEffect(() => {
    bindKeyHandler((event) => {
      if (event.key === 'ArrowDown') {
        setActive((current) => (items.length ? (current + 1) % items.length : 0));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setActive((current) => (items.length ? (current - 1 + items.length) % items.length : 0));
        return true;
      }
      if (event.key === 'Enter') {
        const command = items[active];
        if (command) onSelect(command);
        // Consume it either way, so Enter never splits the block while the
        // palette is open.
        return true;
      }
      if (event.key === 'Escape') return false; // let the plugin close itself
      return false;
    });
    return () => bindKeyHandler(null);
  }, [items, active, onSelect, bindKeyHandler]);

  if (!rect) return null;

  return createPortal(
    <div
      className="palette"
      data-testid="command-palette"
      style={{ top: rect.bottom + window.scrollY + 6, left: rect.left + window.scrollX }}
    >
      {items.length === 0 ? (
        <div className="palette-empty" data-testid="palette-empty">
          No matching command
        </div>
      ) : (
        items.map((command, index) => (
          <button
            key={command.id}
            type="button"
            className={index === active ? 'palette-item active' : 'palette-item'}
            data-testid={`palette-item-${command.id}`}
            // Keep focus in the editor so the range delete still applies.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => onSelect(command)}
          >
            <span className="palette-label">{command.label}</span>
            <span className="palette-description">{command.description}</span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
