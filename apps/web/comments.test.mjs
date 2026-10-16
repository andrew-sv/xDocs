/**
 * Comment threads as CRDT operations (#46).
 *
 * Pure-logic, against real Y.Docs: the interesting cases are two people acting
 * at once, which no browser test can stage reliably, and the rules about what a
 * deletion takes with it.
 */
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

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

const ada = { id: 'u-ada', name: 'Ada' };
const bob = { id: 'u-bob', name: 'Bob' };
const open = (doc, text = 'first') =>
  createThread(doc, { blockId: 'b1', quote: 'the quoted words', text, author: ada });

// --- a thread arrives whole ------------------------------------------------
{
  const doc = new Y.Doc();
  const id = open(doc);
  const [thread] = readThreads(doc);
  ck('creating a thread yields one thread', readThreads(doc).length === 1);
  ck('with its id', thread.id === id);
  ck('the block it was opened in', thread.blockId === 'b1');
  ck('the quoted text', thread.quote === 'the quoted words');
  ck('and exactly one comment', thread.comments.length === 1);
  ck('attributed to its author', thread.comments[0].authorName === 'Ada');
  ck('carrying the author id, so only they can edit it', thread.comments[0].authorId === 'u-ada');
  ck('unresolved to begin with', thread.resolved === false);
  ck('and not yet edited', thread.comments[0].updatedAt === null);
}

// --- replies, edits, deletes ------------------------------------------------
{
  const doc = new Y.Doc();
  const id = open(doc, 'why this?');
  addComment(doc, id, 'because of that', bob);
  let [thread] = readThreads(doc);
  ck('a reply joins the thread', thread.comments.length === 2);
  ck('oldest first, so it reads as a conversation', thread.comments[0].text === 'why this?');
  ck('and the reply carries its own author', thread.comments[1].authorName === 'Bob');

  editComment(doc, id, thread.comments[1].id, 'because of the other thing');
  [thread] = readThreads(doc);
  ck('an edit changes the text', thread.comments[1].text === 'because of the other thing');
  ck('and is marked as edited', typeof thread.comments[1].updatedAt === 'number');
  ck('without touching the other comment', thread.comments[0].updatedAt === null);

  const { threadGone } = deleteComment(doc, id, thread.comments[1].id);
  [thread] = readThreads(doc);
  ck('deleting a reply leaves the thread', threadGone === false && thread.comments.length === 1);
}

// --- the last comment takes the thread with it -----------------------------
{
  const doc = new Y.Doc();
  const id = open(doc);
  const [thread] = readThreads(doc);
  const { threadGone } = deleteComment(doc, id, thread.comments[0].id);
  ck('deleting the last comment reports the thread is gone', threadGone === true);
  ck('and it really is', readThreads(doc).length === 0);
  ck('so no mark can be left pointing at it', !threadIds(doc).has(id));
}

// --- resolving, and deleting outright --------------------------------------
{
  const doc = new Y.Doc();
  const id = open(doc);
  setResolved(doc, id, true);
  ck('a thread can be resolved', readThreads(doc)[0].resolved === true);
  setResolved(doc, id, false);
  ck('and reopened', readThreads(doc)[0].resolved === false);
  deleteThread(doc, id);
  ck('deleting a thread removes it whole', readThreads(doc).length === 0);
}

// --- acting on something that is already gone ------------------------------
{
  const doc = new Y.Doc();
  const id = open(doc);
  deleteThread(doc, id);
  addComment(doc, id, 'into the void', bob);
  editComment(doc, id, 'no-such-comment', 'x');
  setResolved(doc, id, true);
  ck(
    'replying to a deleted thread does nothing, rather than resurrecting it',
    readThreads(doc).length === 0,
  );
  ck('and deleting from it is safe', deleteComment(doc, id, 'nope').threadGone === true);
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
  ck('a thread reaches the other client', readThreads(b).length === 1);

  // Both reply before either has seen the other's reply.
  addComment(a, id, 'Ada again', ada);
  addComment(b, id, 'Bob here', bob);
  sync();
  const merged = readThreads(a)[0];
  ck('concurrent replies both survive', merged.comments.length === 3);
  ck('and the other client agrees', readThreads(b)[0].comments.length === 3);

  // Both edit the SAME comment at once: last write wins, nothing duplicates.
  const target = merged.comments[0].id;
  editComment(a, id, target, 'Ada rewrote it');
  editComment(b, id, target, 'Bob rewrote it');
  sync();
  const after = readThreads(a)[0];
  ck('a concurrent edit of one comment does not duplicate it', after.comments.length === 3);
  ck(
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
  ck(
    'a thread deleted while someone replies stays deleted on both sides',
    readThreads(a).some((t) => t.id === doomed) === readThreads(b).some((t) => t.id === doomed),
  );
}

// --- quoting ----------------------------------------------------------------
ck('a quote collapses whitespace', quoteFor('  two   words \n here ') === 'two words here');
ck('a long quote is truncated', quoteFor('x'.repeat(300)).length === 180);
ck('and says it was', quoteFor('x'.repeat(300)).endsWith('…'));
ck('a short one is left alone', quoteFor('brief') === 'brief');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
