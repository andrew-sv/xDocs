const NAMES = ['Otter', 'Heron', 'Lynx', 'Marten', 'Ibis', 'Vole', 'Shrike', 'Tern'];
const COLORS = ['#e5484d', '#0090ff', '#12a594', '#f76b15', '#8e4ec6', '#e93d82', '#46a758'];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Stable for the tab's lifetime so a reload looks like the same collaborator. */
export const localUser = {
  name: `${pick(NAMES)} ${Math.floor(Math.random() * 90 + 10)}`,
  color: pick(COLORS),
};

/** Platform-appropriate label for the undo shortcut. */
export const undoShortcutLabel =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? '⌘Z'
    : 'Ctrl+Z';
