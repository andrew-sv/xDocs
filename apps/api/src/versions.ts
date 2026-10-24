import {
  BLOCKS_KEY,
  COMMENTS_KEY,
  TITLE_KEY,
  blockFragmentName,
  type BlockMeta,
  type VersionReason,
} from '@xdocs/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { readContentText } from './contentText.js';
import { getDb } from './db/index.js';
import { documentVersions } from './db/schema.js';
import { versionsToPrune } from './retention.js';

/**
 * Version history (#49).
 *
 * `documents.ystate` holds only the latest state, so earlier ones are copied
 * into `document_versions` as full Yjs updates, three ways:
 *
 *  - automatically, by the collab store hook: before it overwrites the stored
 *    state, that state is archived — at most once per VERSION_INTERVAL
 *  - on request ("Save version")
 *  - just before an operation that rewrites the whole document — a restore,
 *    or a replace over REST — throws the current state away
 */

/**
 * How often, at most, editing leaves an automatic version behind.
 *
 * The store hook runs every couple of seconds while anyone types, so archiving
 * on every save would store the same document hundreds of times an hour.
 */
const VERSION_INTERVAL_SECONDS =
  Number(process.env.VERSION_INTERVAL_MINUTES) > 0
    ? Number(process.env.VERSION_INTERVAL_MINUTES) * 60
    : 10 * 60;

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Archive the stored state of a document before the store hook replaces it.
 *
 * Archiving what is about to be overwritten, rather than what is being
 * written, is what makes the first save of a session keep the state the last
 * session ended in — "yesterday's wording" exactly, not whatever was typed in
 * the ten minutes before the previous version happened to be taken. The
 * version is dated by that state's own save (`updated_at`), not by now.
 *
 * Skipped when:
 *  - a version was written within the interval — the throttle
 *  - the newest version already IS this state (same save time), which happens
 *    after a restore or a manual save
 *  - the document has not been saved since it was created: its first state is
 *    the empty seed from initialYState, and a version of nothing is clutter
 *
 * One statement, run inside the store's own transaction, so the archive and
 * the overwrite commit together. Reports whether a version was written, which
 * is the store hook's cue to prune (#63).
 */
export async function archivePreviousState(tx: Tx, documentId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    INSERT INTO document_versions (document_id, ystate, title, reason, saved_at)
    SELECT d.id, d.ystate, d.title, 'auto', d.updated_at
      FROM documents d
     WHERE d.id = ${documentId}
       AND d.ystate IS NOT NULL
       AND d.updated_at > d.created_at
       AND NOT EXISTS (
         SELECT 1 FROM document_versions v
          WHERE v.document_id = d.id
            AND (
              v.created_at > now() - make_interval(secs => ${VERSION_INTERVAL_SECONDS})
              OR v.saved_at >= d.updated_at
            )
       )
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Apply the retention policy (#63, see retention.ts) to one document's history.
 *
 * The store hook calls it only when it has just archived an automatic version,
 * inside the same transaction: history only grows when a document is edited,
 * so pruning on that growth keeps every document bounded without a scheduled
 * job, and a store that archived nothing — nearly all of them, given the
 * interval — pays nothing. When it does run it is one indexed read of the
 * document's version metadata (never `ystate`) on
 * `document_versions_document_idx`, and at most one delete by primary key.
 *
 * Manual, before-restore and before-replace versions do not trigger it: they
 * are rare, and the next automatic version prunes for them.
 */
export async function pruneVersions(tx: Tx, documentId: string, now = new Date()): Promise<number> {
  const versions = await tx
    .select({
      id: documentVersions.id,
      reason: documentVersions.reason,
      savedAt: documentVersions.savedAt,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId));
  const doomed = versionsToPrune(versions, now);
  if (doomed.length === 0) return 0;
  await tx
    .delete(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), inArray(documentVersions.id, doomed)));
  return doomed.length;
}

/** The live document, captured for a version. */
export type Capture = { update: Uint8Array; title: string; empty: boolean };

/**
 * Everything needed to keep this state as a version. Synchronous, so it runs
 * inside a direct connection's transaction and sees one consistent state.
 */
export function capture(doc: Y.Doc, title: string): Capture {
  return {
    update: Y.encodeStateAsUpdate(doc),
    title,
    // Nothing to lose: a document that is still its empty seed.
    empty: readContentText(doc).length === 0,
  };
}

export async function recordVersion(input: {
  documentId: string;
  capture: Capture;
  reason: VersionReason;
  userId: string | null;
}): Promise<{ id: string }> {
  const [row] = await getDb()
    .insert(documentVersions)
    .values({
      documentId: input.documentId,
      ystate: Buffer.from(input.capture.update),
      title: input.capture.title,
      reason: input.reason,
      createdBy: input.userId,
      savedAt: new Date(),
    })
    .returning({ id: documentVersions.id });
  return row!;
}

/** A stored version as a document of its own, for reading or restoring from. */
export function decodeVersion(ystate: Buffer): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(ystate));
  return doc;
}

/** y-tiptap names a mark's attribute after it, suffixed `--<hash>` when marks may overlap. */
const isCommentAttribute = (key: string) => key === 'comment' || key.startsWith('comment--');

/**
 * Clear comment highlights whose thread is gone.
 *
 * Comments are live discussion, not part of the wording, so a restore leaves
 * the thread list as it is. The restored text still carries the marks it had,
 * though, and a mark whose thread has since been deleted is a highlight that
 * opens nothing — the one state the comments code is careful never to leave.
 */
function dropOrphanedCommentMarks(
  node: Y.XmlFragment | Y.XmlElement | Y.XmlText,
  threads: Set<string>,
) {
  if (node instanceof Y.XmlText) {
    let at = 0;
    for (const op of node.toDelta() as Array<{
      insert: unknown;
      attributes?: Record<string, unknown>;
    }>) {
      const length = typeof op.insert === 'string' ? op.insert.length : 1;
      for (const [key, value] of Object.entries(op.attributes ?? {})) {
        const threadId = (value as { threadId?: unknown } | null)?.threadId;
        if (isCommentAttribute(key) && !(typeof threadId === 'string' && threads.has(threadId))) {
          node.format(at, length, { [key]: null });
        }
      }
      at += length;
    }
    return;
  }
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText)
      dropOrphanedCommentMarks(child, threads);
  }
}

/**
 * A block's content as a comparable string: element names, attributes and
 * text runs with their marks, keys sorted so equal content compares equal.
 *
 * With `threads`, comment marks whose thread is not in it are left out — the
 * version is compared as the restore would write it, after
 * `dropOrphanedCommentMarks`. Runs left with the same marks are merged, since
 * Yjs would have merged them too.
 */
function contentKey(fragment: Y.XmlFragment, threads?: Set<string>): string {
  const stable = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
        )
      : Array.isArray(value)
        ? value.map(stable)
        : value;
  const marks = (attributes: Record<string, unknown> = {}) =>
    stable(
      Object.fromEntries(
        Object.entries(attributes).filter(([key, value]) => {
          if (value === null || value === undefined) return false;
          if (!threads || !isCommentAttribute(key)) return true;
          const threadId = (value as { threadId?: unknown }).threadId;
          return typeof threadId === 'string' && threads.has(threadId);
        }),
      ),
    );
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText): unknown => {
    if (node instanceof Y.XmlText) {
      const runs: Array<{ insert: unknown; marks: string }> = [];
      for (const op of node.toDelta() as Array<{
        insert: unknown;
        attributes?: Record<string, unknown>;
      }>) {
        const key = JSON.stringify(marks(op.attributes));
        const last = runs.at(-1);
        if (last?.marks === key && typeof last.insert === 'string' && typeof op.insert === 'string')
          last.insert += op.insert;
        else runs.push({ insert: stable(op.insert), marks: key });
      }
      return runs;
    }
    const children = node
      .toArray()
      .map((child) =>
        child instanceof Y.XmlElement || child instanceof Y.XmlText ? walk(child) : null,
      );
    return node instanceof Y.XmlElement
      ? { name: node.nodeName, attributes: stable(node.getAttributes()), children }
      : children;
  };
  return JSON.stringify(walk(fragment));
}

/**
 * Which entries of `from` to leave where they are, standing for which entries
 * of `to`: an order-preserving matching of the two block lists, as pairs of
 * indices, scored by `score` (0 = cannot stand in) and maximised.
 */
function keptInPlace(
  from: number,
  to: number,
  score: (i: number, j: number) => number,
): Array<[number, number]> {
  // best[i][j]: the best total over from[i..] and to[j..].
  const best = Array.from({ length: from + 1 }, () => new Array<number>(to + 1).fill(0));
  for (let i = from - 1; i >= 0; i--)
    for (let j = to - 1; j >= 0; j--) {
      const pair = score(i, j);
      best[i]![j] = Math.max(
        pair > 0 ? best[i + 1]![j + 1]! + pair : 0,
        best[i + 1]![j]!,
        best[i]![j + 1]!,
      );
    }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < from && j < to;) {
    const pair = score(i, j);
    if (pair > 0 && best[i]![j] === best[i + 1]![j + 1]! + pair) pairs.push([i++, j++]);
    else if (best[i]![j] === best[i + 1]![j]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Make the live document read as `version` does.
 *
 * A CRDT edit like any other, so it merges with whoever is typing and appears
 * in every open editor — never a write to `ystate`, which the next store would
 * clobber.
 *
 * It changes as little as it can (#60). Each restore used to bring every block
 * back under a new id, leaving the old fragments behind — Yjs cannot drop a
 * root type — so every restore roughly doubled the document's fragments, and
 * every later store and version paid for them. Now:
 *
 *  - A block still in the document, in the same relative order, keeps its id.
 *    If its content already reads as the version's it is not touched at all;
 *    otherwise its fragment is emptied and refilled in place. A live block
 *    under another id that already reads exactly as a version block also
 *    stands in for it — that is the copy an earlier restore of this same
 *    version made, and without this every repeat would copy it again. An open editor
 *    stays bound to it and shows the restored text, keeping its focus — and
 *    text someone types into it during the restore merges into what is
 *    visible, where it used to land in an orphaned fragment and vanish.
 *  - Every other block in the version — deleted since, or moved — comes back
 *    as a copy under a NEW id, as before. That keeps one property the old code
 *    had for free: a restore never re-inserts an id that has been in `blocks`.
 *    A client's undo stack can still hold "delete block X" or a move of X;
 *    undoing it re-inserts X's original entry, and had the restore put X back
 *    too, the list would hold X twice — two editors on one fragment. A copy
 *    under a new id cannot collide with anything. These are the only new
 *    fragments a restore creates, so growth follows how much the document
 *    changed, not how big it is.
 *  - Blocks absent from the version leave `blocks`, their fragments staying
 *    behind exactly like any deleted block's.
 *
 * A restore arrives at clients as a remote change, so it is on nobody's undo
 * stack. A client's own earlier edits to a block that was refilled in place
 * still undo against that fragment — the same as after any collaborator's
 * edit — where before they undid into a fragment no longer on screen.
 *
 * Content is copied into a fragment only as it joins the document (Yjs
 * integrates a clone's pending content on insert), which is the order
 * CLAUDE.md requires for text nodes.
 */
export function restoreVersion(doc: Y.Doc, version: Y.Doc): void {
  const threads = new Set(doc.getMap(COMMENTS_KEY).keys());
  doc.transact(() => {
    const blocks = doc.getArray<BlockMeta>(BLOCKS_KEY);
    const live = blocks.toArray();
    const wanted = version
      .getArray<BlockMeta>(BLOCKS_KEY)
      .toArray()
      .filter((meta) => meta?.id);
    const liveKeys = live.map((meta) => contentKey(doc.getXmlFragment(blockFragmentName(meta.id))));
    const wantedKeys = wanted.map((meta) =>
      contentKey(version.getXmlFragment(blockFragmentName(meta.id)), threads),
    );
    // The same block outranks a different block that merely reads the same.
    const kept = keptInPlace(live.length, wanted.length, (i, j) =>
      live[i]!.type !== wanted[j]!.type
        ? 0
        : live[i]!.id === wanted[j]!.id
          ? 2
          : liveKeys[i] === wantedKeys[j]
            ? 1
            : 0,
    );
    const keptLive = new Set(kept.map(([i]) => i));
    const keptWanted = new Set(kept.map(([, j]) => j));

    const fill = (target: Y.XmlFragment, sourceId: string) => {
      const source = version.getXmlFragment(blockFragmentName(sourceId));
      target.insert(
        0,
        source.toArray().map((node) => node.clone() as Y.XmlElement | Y.XmlText),
      );
      dropOrphanedCommentMarks(target, threads);
    };

    // Kept blocks: rewrite only the ones whose content differs.
    for (const [i, j] of kept) {
      if (liveKeys[i] === wantedKeys[j]) continue;
      const target = doc.getXmlFragment(blockFragmentName(live[i]!.id));
      target.delete(0, target.length);
      fill(target, wanted[j]!.id);
    }

    // Leaves exactly the kept entries, in order, so the version's other
    // blocks can be slotted in between them by position.
    for (let i = live.length - 1; i >= 0; i--) if (!keptLive.has(i)) blocks.delete(i, 1);
    wanted.forEach((meta, j) => {
      if (keptWanted.has(j)) return;
      const copy: BlockMeta = { ...meta, id: randomUUID() };
      blocks.insert(j, [copy]);
      fill(doc.getXmlFragment(blockFragmentName(copy.id)), meta.id);
    });
    // Every document has at least one block to type into.
    if (blocks.length === 0) blocks.push([{ id: randomUUID(), type: 'paragraph' }]);

    const title = doc.getText(TITLE_KEY);
    const wantedTitle = version.getText(TITLE_KEY).toString();
    if (title.toString() !== wantedTitle) {
      title.delete(0, title.length);
      title.insert(0, wantedTitle);
    }
  });
}
