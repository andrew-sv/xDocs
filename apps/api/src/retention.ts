import type { VersionReason } from '@xdocs/shared';

/**
 * Which versions of one document to let go of (#63).
 *
 * Without this nothing deleted a version short of a permanent delete, and each
 * is a full copy of the document: a working day of editing left ~50, a
 * long-lived document thousands. The rule thins history out with age, the way
 * people look back through it — every step of today, how each recent day
 * ended, how each older week ended:
 *
 *  - saved in the last 24 hours: every version is kept
 *  - then, up to 30 days old: one per day
 *  - older than that: one per week
 *
 * Exempt, whatever their age:
 *  - every `manual` version — someone asked for exactly that state to be kept
 *  - the newest `before-restore` and the newest `before-replace` — each is the
 *    only way back from the last whole-document rewrite of its kind. Older ones
 *    are ordinary history and thin out like `auto` ones.
 *
 * The survivor of each day or week is the NEWEST of its non-exempt versions:
 * how the document stood when that day or week ended, which is also what an
 * automatic version is for — the state a session finished in. Exempt versions
 * do not count towards a bucket, so a day with a manual save still keeps its
 * own last state beside it.
 *
 * Buckets are by `saved_at` — when the document was in that state, the time
 * history shows — never `created_at`, which for an automatic version can be
 * much later. Days are UTC days and weeks start on Monday, UTC: one clock for
 * every user, and stable from run to run, so pruning the same rows twice
 * deletes nothing the second time.
 *
 * Pure, and given `now`, so the rule can be tested without a database or a
 * clock (retention.test.mjs). It is the ONE implementation: the store hook
 * (`pruneVersions`) and the backfill script both call it, rather than one of
 * them restating it in SQL that could drift.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Everything younger than this is kept. */
export const KEEP_ALL_MS = DAY_MS;
/** Up to this age, one version per day; beyond it, one per week. */
export const DAILY_MS = 30 * DAY_MS;

export type RetentionCandidate = {
  id: string;
  reason: VersionReason;
  savedAt: Date;
  createdAt: Date;
};

/** Newest first; ties broken by write time, then id, so the survivor is never arbitrary. */
function newestFirst(a: RetentionCandidate, b: RetentionCandidate): number {
  return (
    b.savedAt.getTime() - a.savedAt.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/** The bucket a version competes in, or null when it is young enough to keep regardless. */
function bucketOf(savedAt: Date, now: Date): string | null {
  const age = now.getTime() - savedAt.getTime();
  // A negative age is a clock disagreement, not a reason to delete anything.
  if (age < KEEP_ALL_MS) return null;
  const day = Math.floor(savedAt.getTime() / DAY_MS);
  if (age < DAILY_MS) return `day:${day}`;
  // Day 0 (1970-01-01) was a Thursday; shifting by 3 starts weeks on Monday.
  return `week:${Math.floor((day + 3) / 7)}`;
}

/** The ids, from one document's versions, that the retention policy would delete. */
export function versionsToPrune(versions: readonly RetentionCandidate[], now: Date): string[] {
  const ordered = [...versions].sort(newestFirst);

  const exempt = new Set<string>();
  const newestOfKind = new Set<VersionReason>();
  for (const version of ordered) {
    if (version.reason === 'manual') exempt.add(version.id);
    else if (version.reason !== 'auto' && !newestOfKind.has(version.reason)) {
      newestOfKind.add(version.reason);
      exempt.add(version.id);
    }
  }

  const claimed = new Set<string>();
  const doomed: string[] = [];
  for (const version of ordered) {
    if (exempt.has(version.id)) continue;
    const bucket = bucketOf(version.savedAt, now);
    if (bucket === null) continue;
    // Newest first, so the first to reach a bucket is the one that survives it.
    if (claimed.has(bucket)) doomed.push(version.id);
    else claimed.add(bucket);
  }
  return doomed;
}
