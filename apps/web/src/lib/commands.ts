/**
 * Commands offered by the `\` palette.
 *
 * A registry rather than a switch buried in the UI: adding a command later is
 * an entry here plus a branch in the runner, not a new mechanism.
 */
export type CommandId = 'exportToPdf';

export type PaletteCommand = {
  id: CommandId;
  label: string;
  description: string;
  /** Extra words that should match this command when typed. */
  keywords: string[];
};

export const COMMANDS: PaletteCommand[] = [
  {
    id: 'exportToPdf',
    label: 'Export to PDF',
    description: 'Download this document as a PDF',
    keywords: ['export', 'pdf', 'download', 'save'],
  },
];

/** Filter by whatever was typed after the `\`. Empty query lists everything. */
export function filterCommands(query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter(
    (command) =>
      command.id.toLowerCase().includes(q) ||
      command.label.toLowerCase().includes(q) ||
      command.keywords.some((keyword) => keyword.includes(q)),
  );
}
