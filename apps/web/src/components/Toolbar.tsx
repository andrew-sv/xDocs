import { useEditorState, type Editor } from '@tiptap/react';

type Action = {
  label: string;
  title: string;
  isActive: boolean;
  run: () => void;
};

/**
 * Turn the selection into ONE code block.
 *
 * TipTap's toggleCodeBlock converts each selected paragraph into its own code
 * block, so marking up five lines of code produced five grey boxes with margins
 * between them — the very gaps this is meant to remove. Pulling the selected
 * text out with newline separators and inserting a single node gives one
 * continuous block instead.
 */
function toggleCodeBlock(editor: Editor): boolean {
  const { state } = editor;
  const { from, to, empty } = state.selection;

  // Already a code block, or nothing selected: the built-in behaviour is right.
  if (empty || editor.isActive('codeBlock')) return editor.chain().focus().toggleCodeBlock().run();

  const text = state.doc.textBetween(from, to, '\n', '\n');
  return editor
    .chain()
    .focus()
    .deleteSelection()
    .insertContent({
      type: 'codeBlock',
      content: text ? [{ type: 'text', text }] : [],
    })
    .run();
}

export function Toolbar({ editor }: { editor: Editor }) {
  const chain = () => editor.chain().focus();

  /*
   * useEditor does NOT re-render on every transaction in TipTap v3, so calling
   * editor.isActive() during render produced a value that never updated —
   * no button ever showed as active. useEditorState subscribes properly and
   * re-renders only when these specific values change.
   */
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      codeBlock: e.isActive('codeBlock'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
    }),
  });

  const actions: Action[] = [
    { label: 'B', title: 'Bold', isActive: active.bold, run: () => chain().toggleBold().run() },
    { label: 'I', title: 'Italic', isActive: active.italic, run: () => chain().toggleItalic().run() },
    { label: 'S', title: 'Strike', isActive: active.strike, run: () => chain().toggleStrike().run() },
    { label: '<>', title: 'Code', isActive: active.code, run: () => chain().toggleCode().run() },
    {
      label: '{ }',
      title: 'Code block',
      isActive: active.codeBlock,
      run: () => toggleCodeBlock(editor),
    },
    { label: 'H1', title: 'Heading 1', isActive: active.h1, run: () => chain().toggleHeading({ level: 1 }).run() },
    { label: 'H2', title: 'Heading 2', isActive: active.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
    { label: '•', title: 'Bullet list', isActive: active.bulletList, run: () => chain().toggleBulletList().run() },
    { label: '1.', title: 'Ordered list', isActive: active.orderedList, run: () => chain().toggleOrderedList().run() },
    { label: '”', title: 'Blockquote', isActive: active.blockquote, run: () => chain().toggleBlockquote().run() },
  ];

  return (
    <div className="toolbar">
      {actions.map((a) => (
        <button
          key={a.title}
          type="button"
          title={a.title}
          data-testid={`tb-${a.title.toLowerCase().replace(/\s+/g, '-')}`}
          className={a.isActive ? 'tb active' : 'tb'}
          // Keep focus in the editor so the command applies to the live selection.
          onMouseDown={(e) => e.preventDefault()}
          onClick={a.run}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
