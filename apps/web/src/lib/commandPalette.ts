import { Extension } from '@tiptap/react';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { filterCommands, type CommandId, type PaletteCommand } from './commands';

/** What the editor tells the UI about the palette's current state. */
export type PaletteState = {
  items: PaletteCommand[];
  /** Caret rectangle, for positioning. Null when it cannot be determined. */
  rect: DOMRect | null;
  /**
   * Runs a command through the suggestion plugin.
   *
   * Must be used instead of acting directly: only the plugin knows the exact
   * range of the typed `\…`, so anything hand-rolled leaves part of the
   * trigger text behind in the document.
   */
  run: (command: PaletteCommand) => void;
};

export interface CommandPaletteOptions {
  onStateChange: (state: PaletteState | null) => void;
  /** Called with the chosen command id once the trigger text is removed. */
  onRun: (id: CommandId) => void;
  /**
   * The UI owns selection, so it owns the key handling too.
   *
   * A getter, NOT a ref object: TipTap's configure() deep-merges options and
   * clones plain objects, so a passed ref would be a different object from the
   * one the component writes to — the handler would never arrive and Enter
   * would fall through to ProseMirror. Functions survive the merge by identity.
   */
  getKeyHandler: () => ((event: KeyboardEvent) => boolean) | null;
}

/**
 * A `\`-triggered command palette.
 *
 * Registered per block, because every block is its own editor — the palette
 * appears in whichever one has focus. Commands themselves may act on the whole
 * document, so `onRun` hands the id upward rather than acting here.
 */
export const CommandPalette = Extension.create<CommandPaletteOptions>({
  name: 'commandPalette',

  addOptions() {
    return {
      onStateChange: () => {},
      onRun: () => {},
      getKeyHandler: () => null,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    const suggestion: SuggestionOptions = {
      editor: this.editor,
      char: '\\',
      // Only at a word boundary, so an ordinary backslash mid-word is untouched.
      allowSpaces: false,
      startOfLine: false,

      items: ({ query }) => filterCommands(query),

      command: ({ editor, range, props }) => {
        // Remove the typed `\…` before running, so the trigger text never
        // survives into the document.
        editor.chain().focus().deleteRange(range).run();
        options.onRun((props as PaletteCommand).id);
      },

      render: () => {
        return {
          onStart: (props) => {
            options.onStateChange({
              items: props.items as PaletteCommand[],
              rect: props.clientRect?.() ?? null,
              run: (command) => props.command(command),
            });
          },
          onUpdate: (props) => {
            options.onStateChange({
              items: props.items as PaletteCommand[],
              rect: props.clientRect?.() ?? null,
              run: (command) => props.command(command),
            });
          },
          // Handled here rather than in a keymap so the palette beats
          // ProseMirror's own Enter and arrow handling.
          onKeyDown: ({ event }) => options.getKeyHandler()?.(event) ?? false,
          onExit: () => options.onStateChange(null),
        };
      },
    };

    return [Suggestion(suggestion)];
  },
});
