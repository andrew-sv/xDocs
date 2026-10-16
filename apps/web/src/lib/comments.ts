import { COMMENTS_KEY } from '@xdocs/shared';
import * as Y from 'yjs';

/**
 * Comment threads, stored on the document's own Yjs doc.
 *
 * Everything here is a CRDT operation, so two people commenting at once merge
 * instead of overwriting, and a thread survives the text around it being
 * rewritten. Nothing goes over REST.
 *
 * Shapes, as they live in Yjs:
 *
 *   comments: Y.Map<threadId, thread>
 *   thread:   Y.Map { id, blockId, quote, createdAt, resolved,
 *                     comments: Y.Map<commentId, comment> }
 *   comment:  Y.Map { id, authorId, authorName, text, createdAt, updatedAt }
 *
 * `comments` is a map keyed by id, never an array: editing one is then a field
 * write on that entry. An array would make an edit a delete plus an insert,
 * which is the same shape as the block reorder that Yjs cannot do atomically —
 * two people editing at once could duplicate or lose a comment.
 */

/**
 * Whether the rail is collapsed, remembered across reloads.
 *
 * A preference about the window rather than anything about the document, so it
 * is per browser and not in the CRDT — collapsing the rail on your laptop must
 * not fold it away on somebody else's screen. Wrapped like the session token
 * is, because storage throws in private mode and a blocked read must not stop
 * the editor rendering.
 */
const RAIL_KEY = 'xdocs.comments-collapsed';

export function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_KEY, String(collapsed));
  } catch {
    /* not fatal for this page's lifetime */
  }
}

export type Comment = {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: number;
  /** Set when the author has edited it, so the UI can say so. */
  updatedAt: number | null;
};

export type Thread = {
  id: string;
  /** Which block the commented text is in, so the rail can order by position. */
  blockId: string;
  /** The text as it read when the thread was opened — see quoteFor. */
  quote: string;
  createdAt: number;
  resolved: boolean;
  /** Oldest first: a thread reads as a conversation. */
  comments: Comment[];
};

const threadsMap = (ydoc: Y.Doc): Y.Map<Y.Map<unknown>> =>
  ydoc.getMap<Y.Map<unknown>>(COMMENTS_KEY);

const commentsIn = (thread: Y.Map<unknown>): Y.Map<Y.Map<unknown>> =>
  thread.get('comments') as Y.Map<Y.Map<unknown>>;

/** Crypto ids, so two clients never coin the same one. */
const newId = () => crypto.randomUUID();

/**
 * What the thread quotes.
 *
 * Kept as a copy rather than read back from the document: the point of a
 * comment is what the text said when somebody objected to it, and the range it
 * marks may since have been rewritten or deleted entirely. Truncated because
 * this is a label in a narrow rail, not the document.
 */
export function quoteFor(text: string, limit = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export type Author = { id: string; name: string };

/**
 * Open a thread on a range, with its first comment.
 *
 * One transaction, so a peer never sees a thread that has no comment in it —
 * which the rail would otherwise render as an empty card.
 */
export function createThread(
  ydoc: Y.Doc,
  input: { blockId: string; quote: string; text: string; author: Author },
): string {
  const threadId = newId();
  ydoc.transact(() => {
    const thread = new Y.Map<unknown>();
    thread.set('id', threadId);
    thread.set('blockId', input.blockId);
    thread.set('quote', input.quote);
    thread.set('createdAt', Date.now());
    thread.set('resolved', false);
    thread.set('comments', new Y.Map<Y.Map<unknown>>());
    threadsMap(ydoc).set(threadId, thread);
    appendComment(thread, input.text, input.author);
  });
  return threadId;
}

function appendComment(thread: Y.Map<unknown>, text: string, author: Author): string {
  const id = newId();
  const comment = new Y.Map<unknown>();
  comment.set('id', id);
  comment.set('authorId', author.id);
  comment.set('authorName', author.name);
  comment.set('text', text);
  comment.set('createdAt', Date.now());
  comment.set('updatedAt', null);
  commentsIn(thread).set(id, comment);
  return id;
}

/** Reply to a thread. A no-op if the thread has been deleted meanwhile. */
export function addComment(ydoc: Y.Doc, threadId: string, text: string, author: Author): void {
  const thread = threadsMap(ydoc).get(threadId);
  if (!thread) return;
  ydoc.transact(() => appendComment(thread, text, author));
}

/**
 * Change a comment's text. Only the fields that changed are written, so an edit
 * cannot clobber anything else about the comment.
 */
export function editComment(ydoc: Y.Doc, threadId: string, commentId: string, text: string): void {
  const comment =
    threadsMap(ydoc).get(threadId) && commentsIn(threadsMap(ydoc).get(threadId)!).get(commentId);
  if (!comment) return;
  ydoc.transact(() => {
    comment.set('text', text);
    comment.set('updatedAt', Date.now());
  });
}

/**
 * Remove a comment, and the thread with it when it was the last one.
 *
 * An empty thread would leave a mark on the text pointing at nothing, so the
 * two go together — the caller clears the mark when this reports the thread is
 * gone.
 */
export function deleteComment(
  ydoc: Y.Doc,
  threadId: string,
  commentId: string,
): { threadGone: boolean } {
  const thread = threadsMap(ydoc).get(threadId);
  if (!thread) return { threadGone: true };
  let threadGone = false;
  ydoc.transact(() => {
    const comments = commentsIn(thread);
    comments.delete(commentId);
    if (comments.size === 0) {
      threadsMap(ydoc).delete(threadId);
      threadGone = true;
    }
  });
  return { threadGone };
}

/** Remove a whole thread, however many comments are in it. */
export function deleteThread(ydoc: Y.Doc, threadId: string): void {
  ydoc.transact(() => threadsMap(ydoc).delete(threadId));
}

export function setResolved(ydoc: Y.Doc, threadId: string, resolved: boolean): void {
  const thread = threadsMap(ydoc).get(threadId);
  if (!thread) return;
  ydoc.transact(() => thread.set('resolved', resolved));
}

/** Plain snapshot for rendering. Threads newest first; comments oldest first. */
export function readThreads(ydoc: Y.Doc): Thread[] {
  const out: Thread[] = [];
  threadsMap(ydoc).forEach((thread) => {
    const comments: Comment[] = [];
    const raw = thread.get('comments');
    // A thread mid-creation from a peer can arrive before its comments map.
    if (raw instanceof Y.Map) {
      (raw as Y.Map<Y.Map<unknown>>).forEach((comment) => {
        comments.push({
          id: String(comment.get('id')),
          authorId: String(comment.get('authorId')),
          authorName: String(comment.get('authorName')),
          text: String(comment.get('text') ?? ''),
          createdAt: Number(comment.get('createdAt') ?? 0),
          updatedAt: (comment.get('updatedAt') as number | null) ?? null,
        });
      });
    }
    comments.sort((a, b) => a.createdAt - b.createdAt);
    out.push({
      id: String(thread.get('id')),
      blockId: String(thread.get('blockId') ?? ''),
      quote: String(thread.get('quote') ?? ''),
      createdAt: Number(thread.get('createdAt') ?? 0),
      resolved: Boolean(thread.get('resolved')),
      comments,
    });
  });
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Thread ids that exist, for pruning marks whose thread has been deleted. */
export function threadIds(ydoc: Y.Doc): Set<string> {
  return new Set(threadsMap(ydoc).keys());
}
