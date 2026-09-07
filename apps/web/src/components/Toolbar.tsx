import type { Editor } from '@tiptap/react';

type Action = {
  label: string;
  title: string;
  isActive: () => boolean;
  run: () => void;
};

export function Toolbar({ editor }: { editor: Editor }) {
  const chain = () => editor.chain().focus();

  const actions: Action[] = [
    { label: 'B', title: 'Bold', isActive: () => editor.isActive('bold'), run: () => chain().toggleBold().run() },
    { label: 'I', title: 'Italic', isActive: () => editor.isActive('italic'), run: () => chain().toggleItalic().run() },
    { label: 'S', title: 'Strike', isActive: () => editor.isActive('strike'), run: () => chain().toggleStrike().run() },
    { label: '<>', title: 'Code', isActive: () => editor.isActive('code'), run: () => chain().toggleCode().run() },
    { label: 'H1', title: 'Heading 1', isActive: () => editor.isActive('heading', { level: 1 }), run: () => chain().toggleHeading({ level: 1 }).run() },
    { label: 'H2', title: 'Heading 2', isActive: () => editor.isActive('heading', { level: 2 }), run: () => chain().toggleHeading({ level: 2 }).run() },
    { label: '•', title: 'Bullet list', isActive: () => editor.isActive('bulletList'), run: () => chain().toggleBulletList().run() },
    { label: '1.', title: 'Ordered list', isActive: () => editor.isActive('orderedList'), run: () => chain().toggleOrderedList().run() },
    { label: '”', title: 'Blockquote', isActive: () => editor.isActive('blockquote'), run: () => chain().toggleBlockquote().run() },
  ];

  return (
    <div className="toolbar">
      {actions.map((a) => (
        <button
          key={a.title}
          type="button"
          title={a.title}
          data-testid={`tb-${a.title.toLowerCase().replace(/\s+/g, '-')}`}
          className={a.isActive() ? 'tb active' : 'tb'}
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
