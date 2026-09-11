import { useEditorState, type Editor } from '@tiptap/react';
import { useEffect, useState } from 'react';

type Action = {
  label: string;
  title: string;
  isActive: boolean;
  disabled?: boolean;
  run: () => void;
};

/**
 * What a typed link should point at. People type "example.com", not
 * "https://example.com", and without a scheme the browser would resolve it as
 * a path on the app itself.
 */
export function normalizeLink(input: string): string {
  const url = input.trim();
  if (!url) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) return url;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url)) return `mailto:${url}`;
  return `https://${url}`;
}

/**
 * Set, change or remove the link at the selection. Returns false for an
 * address Link refuses (javascript: and the like), leaving the text untouched.
 */
function applyLink(editor: Editor, draft: string): boolean {
  const href = normalizeLink(draft);
  if (!href) return editor.chain().focus().extendMarkRange('link').unsetLink().run();
  // Link's own check, so what is accepted here is exactly what it will render.
  if (!editor.can().setLink({ href })) return false;
  if (editor.state.selection.empty && !editor.isActive('link')) {
    // Nothing selected to wrap: the address itself becomes the text.
    return editor
      .chain()
      .focus()
      .insertContent([
        { type: 'text', text: draft.trim(), marks: [{ type: 'link', attrs: { href } }] },
        { type: 'text', text: ' ' },
      ])
      .run();
  }
  return editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

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

type Props = {
  editor: Editor;
  /** Opens the file picker; the upload itself lives in BlockEditor, which outlives this. */
  onAttachFile: () => void;
};

export function Toolbar({ editor, onAttachFile }: Props) {
  const chain = () => editor.chain().focus();
  // The address being typed; null while the link field is closed.
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [linkRefused, setLinkRefused] = useState(false);

  // Going back to the text abandons an unsubmitted link.
  useEffect(() => {
    const close = () => setLinkDraft(null);
    editor.on('focus', close);
    return () => {
      editor.off('focus', close);
    };
  }, [editor]);

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
      link: e.isActive('link'),
    }),
  });

  const format: Action[] = [
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

  // A code block's text cannot carry marks, so neither a link nor an
  // attachment (which is a link) can go inside one.
  const insert: Action[] = [
    {
      label: '🔗',
      title: 'Link',
      isActive: active.link,
      disabled: active.codeBlock,
      run: () => {
        setLinkRefused(false);
        setLinkDraft((editor.getAttributes('link').href as string | undefined) ?? '');
      },
    },
    { label: '📎', title: 'Attach file', isActive: false, disabled: active.codeBlock, run: onAttachFile },
  ];

  const submitLink = () => {
    if (linkDraft === null) return;
    if (applyLink(editor, linkDraft)) setLinkDraft(null);
    else setLinkRefused(true);
  };

  /*
   * Two floating groups: formatting at the left edge, inserting at the right.
   * The toolbar floats over the block above, and one row of every button
   * reached past that block's middle, so clicking into it there hit a button
   * instead. Split, the middle stays clear however the groups grow.
   */
  return (
    <>
      <div className="toolbar">{format.map(renderButton)}</div>
      {linkDraft === null ? (
        <div className="toolbar toolbar-insert">{insert.map(renderButton)}</div>
      ) : (
        <div className="toolbar toolbar-insert toolbar-link">
          <input
            className="link-input"
            data-testid="link-input"
            aria-label="Link address"
            aria-invalid={linkRefused}
            placeholder="Paste or type a link"
            autoFocus
            value={linkDraft}
            onChange={(event) => {
              setLinkDraft(event.target.value);
              setLinkRefused(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitLink();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                editor.commands.focus();
              }
            }}
          />
          <button type="button" className="tb" data-testid="tb-link-apply" onClick={submitLink}>
            Apply
          </button>
          {active.link && (
            <button
              type="button"
              className="tb"
              data-testid="tb-link-remove"
              onClick={() => {
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
              }}
            >
              Remove
            </button>
          )}
        </div>
      )}
    </>
  );
}

function renderButton(a: Action) {
  return (
    <button
      key={a.title}
      type="button"
      title={a.title}
      data-testid={`tb-${a.title.toLowerCase().replace(/\s+/g, '-')}`}
      className={a.isActive ? 'tb active' : 'tb'}
      disabled={a.disabled}
      // Keep focus in the editor so the command applies to the live selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={a.run}
    >
      {a.label}
    </button>
  );
}
