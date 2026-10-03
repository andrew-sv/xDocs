import { useEditorState, type Editor } from '@tiptap/react';
import { followLink } from '../lib/attachments';
import { useEffect, useState, type ReactNode } from 'react';

type Action = {
  label: ReactNode;
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
  /** Reported under the block, which outlives this toolbar. */
  onError: (message: string) => void;
  /** Opens a thread on the selection; the CRDT write lives in DocumentEditor. */
  onComment: () => void;
};

export function Toolbar({ editor, onAttachFile, onError, onComment }: Props) {
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
      comment: e.isActive('comment'),
      table: e.isActive('table'),
      selectionEmpty: e.state.selection.empty,
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
    // Replaced by the table's own controls while the caret is in one: tables
    // do not nest, and the group needs the room (see TableIcon).
    ...(active.table
      ? []
      : [
          {
            label: <TableIcon edit="insert" />,
            title: 'Table',
            isActive: false,
            disabled: active.codeBlock,
            run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
          },
        ]),
    {
      label: '💬',
      title: 'Comment',
      isActive: active.comment,
      // There has to be something to quote: a thread anchored to an empty
      // selection would have nothing to highlight and nothing to show.
      disabled: active.selectionEmpty,
      run: onComment,
    },
  ];

  /*
   * Shown only while the caret is in a table, in the right-hand group for the
   * same reason as the rest of it: the left group may not grow.
   */
  const table: Action[] = active.table
    ? [
        { label: <TableIcon edit="add-row" />, title: 'Add row', isActive: false, run: () => chain().addRowAfter().run() },
        { label: <TableIcon edit="add-column" />, title: 'Add column', isActive: false, run: () => chain().addColumnAfter().run() },
        { label: <TableIcon edit="delete-row" />, title: 'Delete row', isActive: false, run: () => chain().deleteRow().run() },
        { label: <TableIcon edit="delete-column" />, title: 'Delete column', isActive: false, run: () => chain().deleteColumn().run() },
        { label: <TableIcon edit="delete-table" />, title: 'Delete table', isActive: false, run: () => chain().deleteTable().run() },
      ]
    : [];

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
        <div className="toolbar toolbar-insert">
          {insert.map(renderButton)}
          {table.length > 0 && <span className="tb-sep" aria-hidden="true" />}
          {table.map(renderButton)}
        </div>
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
              data-testid="tb-link-open"
              // Mod-click follows a link in the text; this is the same thing
              // for anyone who does not know that.
              onClick={() => followLink(linkDraft, 'download', onError)}
            >
              Open
            </button>
          )}
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

/*
 * Icons rather than words: the right-hand group grows leftward, and with "+ Row"
 * and the like it reached past the middle of the block above (tables.spec.ts).
 * The title on each button says what it does.
 */
function TableIcon({
  edit,
}: {
  edit: 'insert' | 'add-row' | 'add-column' | 'delete-row' | 'delete-column' | 'delete-table';
}) {
  const rows = edit === 'add-row' || edit === 'delete-row';
  const shape =
    edit === 'insert' ? (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="1" />
        <path d="M2 6.2h12M2 9.8h12M6 2.5v11M10 2.5v11" />
      </>
    ) : edit === 'delete-table' ? (
      <>
        <rect x="2" y="2" width="12" height="12" rx="1" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
      </>
    ) : rows ? (
      <>
        <rect x="2" y="2" width="12" height="7" rx="1" />
        <path d="M2 5.5h12M6 2v7M10 2v7" />
        <path d={edit === 'add-row' ? 'M8 10.5v5M5.5 13h5' : 'M5.5 13h5'} />
      </>
    ) : (
      <>
        <rect x="2" y="2" width="7" height="12" rx="1" />
        <path d="M5.5 2v12M2 6h7M2 10h7" />
        <path d={edit === 'add-column' ? 'M13 5.5v5M10.5 8h5' : 'M10.5 8h5'} />
      </>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      {shape}
    </svg>
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
