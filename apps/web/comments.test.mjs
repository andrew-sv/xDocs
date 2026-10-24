/**
 * Comment threads as CRDT operations (#46).
 *
 * Pure-logic, against real Y.Docs: the interesting cases are two people acting
 * at once, which no browser test can stage reliably, and the rules about what a
 * deletion takes with it.
 */
import { check } from '@xdocs/test-support/harness';
import * as Y from 'yjs';
import {
  addComment,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  quoteFor,
  readThreads,
  setResolved,
  threadIds,
} from './src/lib/comments.ts';

const ada = { id: 'u-ada', name: 'Ada' };
const bob = { id: 'u-bob', name: 'Bob' };
const open = (doc, text = 'first') =>
  createThread(doc, { blockId: 'b1', quote: 'the quoted words', text, author: ada });

// --- a thread arrives whole ------------------------------------------------
{
  const doc = new Y.Doc();
  const id = open(doc);
  const [thread] = readThreads(doc);
  check('creating a thread yields one thread', readThreads(doc).length === 1);
  check('with its id', thread.id === id);
  check('the block it was opened in', thread.blockId === 'b1');
  check('the quoted text', thread.quote === 'the quoted words');
  check('and exactly one comment', thread.comments.length === 1);
  check('attributed to its author', thread.comments[0].authorName === 'Ada');
  check(
    'carrying the author id, so only they can edit it',
    thread.comments[0].authorId === 'u-ada',
  );
  check('unresolved to begin with', thread.resolved === false);
  check('and not yet edited', thread.comments[0].updatedAt === null);
}

// --- replies, edits, deletes ------------------------------------------------
{
  const doc = new Y.Doc();
  const id = open(doc, 'why this?');
  addComment(doc, id, 'because of that', bob);
  let [thread] = readThreads(doc);
  check('a reply joins the thread', thread.comments.length === 2);
  check('oldest first, so it reads as a conversation', thread.comments[0].text === 'why this?');
  check('and the reply carries its own author', thread.comments[1].authorName === 'Bob');

  editComment(doc, id, thread.comments[1].id, 'because of the other thing');
  [thread] = readThreads(doc);
  check('an edit changes the text', thread.comments[1].text === 'because of the other thing');
  check('and is marked as edited', typeof thread.comments[1].updatedAt === 'number');
  check('without touching the other comment', thread.comments[0].updatedAt === null);

  const { threadGone } = deleteComment(doc, id, thread.comments[1].id);
  [thread] = readThreads(doc);
  check('deleting a reply leaves the thread', threadGone === false && thread.comments.length === 1);
}

// --- the last comment takes the thread with it -----------------------------
{
  const doc = new Y.Doc();
  const id = open(doc);
  const [thread] = readThreads(doc);
  const { threadGone } = deleteComment(doc, id, thread.comments[0].id);
  check('deleting the last comment reports the thread is gone', threadGone === true);
  check('and it really is', readThreads(doc).length === 0);
  check('so no mark can be left pointing at it', !threadIds(doc).has(id));
}

// --- resolving, and deleting outright --------------------------------------
{
  const doc = new Y.Doc();
  const id = open(doc);
  setResolved(doc, id, true);
  check('a thread can be resolved', readThreads(doc)[0].resolved === true);
  setResolved(doc, id, false);
  check('and reopened', readThreads(doc)[0].resolved === false);
  deleteThread(doc, id);
  check('deleting a thread removes it whole', readThreads(doc).length === 0);
}

// --- acting on something that is already gone ------------------------------
{
  const doc = new Y.Doc();
  const id = open(doc);
  deleteThread(doc, id);
  addComment(doc, id, 'into the void', bob);
  editComment(doc, id, 'no-such-comment', 'x');
  setResolved(doc, id, true);
  check(
    'replying to a deleted thread does nothing, rather than resurrecting it',
    readThreads(doc).length === 0,
  );
  check('and deleting from it is safe', deleteComment(doc, id, 'nope').threadGone === true);
}

// --- two people at once ----------------------------------------------------
{
  // Two docs kept in step by hand, the way two browsers would be.
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };

  const id = open(a, 'from Ada');
  sync();
  check('a thread reaches the other client', readThreads(b).length === 1);

  // Both reply before either has seen the other's reply.
  addComment(a, id, 'Ada again', ada);
  addComment(b, id, 'Bob here', bob);
  sync();
  const merged = readThreads(a)[0];
  check('concurrent replies both survive', merged.comments.length === 3);
  check('and the other client agrees', readThreads(b)[0].comments.length === 3);

  // Both edit the SAME comment at once: last write wins, nothing duplicates.
  const target = merged.comments[0].id;
  editComment(a, id, target, 'Ada rewrote it');
  editComment(b, id, target, 'Bob rewrote it');
  sync();
  const after = readThreads(a)[0];
  check('a concurrent edit of one comment does not duplicate it', after.comments.length === 3);
  check(
    'both clients settle on the same text',
    after.comments.find((c) => c.id === target).text ===
      readThreads(b)[0].comments.find((c) => c.id === target).text,
  );

  // One deletes a thread while the other replies to it.
  const doomed = open(a, 'short-lived');
  sync();
  deleteThread(a, doomed);
  addComment(b, doomed, 'too late', bob);
  sync();
  check(
    'a thread deleted while someone replies stays deleted on both sides',
    readThreads(a).some((t) => t.id === doomed) === readThreads(b).some((t) => t.id === doomed),
  );
}

// --- quoting ----------------------------------------------------------------
check('a quote collapses whitespace', quoteFor('  two   words \n here ') === 'two words here');
check('a long quote is truncated', quoteFor('x'.repeat(300)).length === 180);
check('and says it was', quoteFor('x'.repeat(300)).endsWith('…'));
check('a short one is left alone', quoteFor('brief') === 'brief');
