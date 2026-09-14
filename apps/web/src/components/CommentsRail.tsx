import { useState } from 'react';
import type { Collaborator } from '../lib/identity';
import type { Comment, Thread } from '../lib/comments';
import { CommentComposer } from './CommentComposer';

type Props = {
  threads: Thread[];
  /** The thread shown expanded; everything else is collapsed. */
  activeId: string | null;
  me: Collaborator | null;
  /** A thread being written but not yet created — see DocumentEditor. */
  pending: { quote: string } | null;
  onSendPending: (text: string) => void;
  onCancelPending: () => void;
  onActivate: (threadId: string | null) => void;
  onReply: (threadId: string, text: string) => void;
  onEdit: (threadId: string, commentId: string, text: string) => void;
  onDelete: (threadId: string, commentId: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
};

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function CommentRow({
  comment,
  canManage,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  canManage: boolean;
  onEdit: (text: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <CommentComposer
        authorName={comment.authorName}
        initialText={comment.text}
        submitLabel="Save"
        autoFocus
        onCancel={() => setEditing(false)}
        onSubmit={(text) => {
          onEdit(text);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="comment" data-testid="comment">
      <div className="comment-head">
        <span className="comment-author" data-testid="comment-author">
          {comment.authorName}
        </span>
        <span className="comment-when" title={when(comment.createdAt)}>
          {comment.updatedAt ? 'edited' : ''}
        </span>
      </div>
      <p className="comment-text" data-testid="comment-text">
        {comment.text}
      </p>
      {/* Only the author's own comment: editing somebody else's words would
          misattribute them, and the name stays on it either way. */}
      {canManage && (
        <div className="comment-row-actions">
          <button type="button" data-testid="comment-edit" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" data-testid="comment-delete" onClick={onDelete}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The comment rail.
 *
 * Threads are collapsed to their quote and first line, and one expands at a
 * time — a document with twenty threads should still read as a list, and two
 * open composers would leave it ambiguous which one Send belongs to.
 */
export function CommentsRail({
  threads,
  activeId,
  me,
  pending,
  onSendPending,
  onCancelPending,
  onActivate,
  onReply,
  onEdit,
  onDelete,
  onResolve,
}: Props) {
  return (
    <aside className="comments-rail" data-testid="comments-rail" aria-label="Comments">
      <header className="comments-rail-header">
        <span>Comments</span>
        <span className="comments-count" data-testid="comments-count">
          {threads.length}
        </span>
      </header>

      {/* The new thread sits at the top, where the eye goes after pressing 💬. */}
      {pending && me && (
        <section className="thread thread-open thread-pending" data-testid="pending-thread">
          <span className="thread-quote" data-testid="thread-quote">
            {pending.quote}
          </span>
          <div className="thread-body">
            <CommentComposer
              authorName={me.name}
              autoFocus
              onCancel={onCancelPending}
              onSubmit={onSendPending}
            />
          </div>
        </section>
      )}

      {threads.length === 0 && !pending && (
        <p className="comments-empty" data-testid="comments-empty">
          Select some text and press 💬 to start a thread.
        </p>
      )}

      {threads.map((thread) => {
        const expanded = thread.id === activeId;
        const first = thread.comments[0];
        return (
          <section
            key={thread.id}
            className={`thread${expanded ? ' thread-open' : ''}${thread.resolved ? ' thread-resolved' : ''}`}
            data-testid="thread"
            data-thread-id={thread.id}
            data-open={expanded ? 'true' : 'false'}
          >
            {/* The whole collapsed card is the control, so the hit area is the
                card rather than a word inside it. */}
            <button
              type="button"
              className="thread-summary"
              data-testid="thread-summary"
              aria-expanded={expanded}
              onClick={() => onActivate(expanded ? null : thread.id)}
            >
              <span className="thread-quote" data-testid="thread-quote">
                {thread.quote}
              </span>
              {!expanded && first && (
                <span className="thread-preview">
                  <span className="comment-author">{first.authorName}</span> {first.text}
                </span>
              )}
              {!expanded && thread.comments.length > 1 && (
                <span className="thread-more" data-testid="thread-more">
                  {thread.comments.length} comments
                </span>
              )}
            </button>

            {expanded && (
              <div className="thread-body">
                {thread.comments.map((comment) => (
                  <CommentRow
                    key={comment.id}
                    comment={comment}
                    canManage={!!me && comment.authorId === me.id}
                    onEdit={(text) => onEdit(thread.id, comment.id, text)}
                    onDelete={() => onDelete(thread.id, comment.id)}
                  />
                ))}

                {me && (
                  <CommentComposer
                    authorName={me.name}
                    placeholder="Reply…"
                    onCancel={() => onActivate(null)}
                    onSubmit={(text) => onReply(thread.id, text)}
                  />
                )}

                <button
                  type="button"
                  className="thread-resolve"
                  data-testid="thread-resolve"
                  onClick={() => onResolve(thread.id, !thread.resolved)}
                >
                  {thread.resolved ? 'Reopen' : 'Resolve'}
                </button>
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
}
