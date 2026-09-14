import { Mark, mergeAttributes } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const COMMENT_MARK = 'comment';

declare module '@tiptap/react' {
  interface Commands<ReturnType> {
    comment: {
      setCommentThread: (threadId: string) => ReturnType;
      unsetCommentThread: (threadId: string) => ReturnType;
    };
  }
}

/**
 * The highlight that ties a range of text to a comment thread.
 *
 * A mark rather than a decoration, because it has to live in the CRDT: a
 * decoration is local to one editor, so nobody else would see what was
 * commented on, and it would not survive a reload. As a mark it travels with
 * the text, and the range follows edits inside it for free.
 *
 * `inclusive: false` so typing at either end of a commented range does not
 * silently extend the comment over the new words — the range is a quotation,
 * and it should stay the one somebody actually objected to.
 *
 * The name is deliberately plain, as with the image node: y-tiptap drops what a
 * client's schema does not know, so a private name would be stripped by any
 * client that had not reloaded, taking the highlight with it.
 */
export const CommentMark = Mark.create<{ onActivate: (threadId: string) => void }>({
  name: COMMENT_MARK,
  inclusive: false,
  // Several threads can cover overlapping text; the later one wins visually.
  excludes: '',

  addOptions() {
    return { onActivate: () => {} };
  },

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-thread-id'),
        renderHTML: (attributes) =>
          attributes.threadId ? { 'data-thread-id': attributes.threadId as string } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-thread-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'comment-mark' }), 0];
  },

  addCommands() {
    return {
      setCommentThread:
        (threadId: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { threadId }),
      /*
       * Clear one thread's highlight without disturbing any other.
       *
       * `unsetMark` would remove every comment mark in the range, so deleting
       * one thread would silently un-highlight the others overlapping it.
       */
      unsetCommentThread:
        (threadId: string) =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.marks[this.name];
          if (!type) return false;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const mark of node.marks) {
              if (mark.type === type && mark.attrs.threadId === threadId) {
                tr.removeMark(pos, pos + node.nodeSize, mark);
                changed = true;
              }
            }
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },

  addProseMirrorPlugins() {
    const onActivate = () => this.options.onActivate;
    return [
      new Plugin({
        key: new PluginKey('commentMarkClicks'),
        props: {
          /*
           * Opening a thread must not also move the caret into the quoted text,
           * or clicking a comment would put you in the middle of editing it. So
           * this reports the click and returns true to stop ProseMirror
           * handling it.
           */
          handleClick: (_view, _pos, event) => {
            const target = (event.target as HTMLElement | null)?.closest('[data-thread-id]');
            const threadId = target?.getAttribute('data-thread-id');
            if (!threadId) return false;
            onActivate()(threadId);
            return true;
          },
        },
      }),
    ];
  },
});
