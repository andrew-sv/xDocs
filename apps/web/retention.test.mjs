/**
 * The version retention rule (#63) as pure logic: given a document's versions
 * and "now", which ones go. The store hook and the backfill script both call
 * this one function; versions.test.mjs covers the wiring against a database.
 */
import { DAILY_MS, KEEP_ALL_MS, versionsToPrune } from '../api/src/retention.ts';

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A Wednesday, mid-afternoon UTC — far enough from midnight that "N days ago
// at 10:00" lands on the day it says.
const now = new Date('2026-10-21T15:00:00Z');
const at = (iso) => new Date(iso);
let seq = 0;
const v = (reason, savedAt, createdAt = savedAt) => ({
  id: `v${String(++seq).padStart(3, '0')}`,
  reason,
  savedAt: typeof savedAt === 'string' ? at(savedAt) : savedAt,
  createdAt: typeof createdAt === 'string' ? at(createdAt) : createdAt,
});
const prune = (versions) => new Set(versionsToPrune(versions, now));
const ids = (...vs) => vs.map((x) => x.id);

ck('the tiers are 24 hours and 30 days', KEEP_ALL_MS === DAY && DAILY_MS === 30 * DAY);
ck('no versions, nothing to prune', versionsToPrune([], now).length === 0);

// --- the last 24 hours ----------------------------------------------------------
{
  const recent = [1, 2, 3, 23].map((h) => v('auto', new Date(now.getTime() - h * HOUR)));
  ck('every version from the last 24 hours is kept', prune(recent).size === 0);
  const edge = v('auto', new Date(now.getTime() - DAY + 1));
  const twin = v('auto', new Date(now.getTime() - DAY + 2));
  ck('right up to the 24-hour line', prune([edge, twin]).size === 0);
  const future = [
    v('auto', new Date(now.getTime() + HOUR)),
    v('auto', new Date(now.getTime() + 2 * HOUR)),
  ];
  ck('a version dated in the future (clock skew) is kept', prune(future).size === 0);
}

// --- one per day for 30 days -----------------------------------------------------
{
  const morning = v('auto', '2026-10-18T09:00:00Z');
  const noon = v('auto', '2026-10-18T12:00:00Z');
  const evening = v('auto', '2026-10-18T21:00:00Z');
  const otherDay = v('auto', '2026-10-17T21:00:00Z');
  const gone = prune([morning, evening, noon, otherDay]);
  ck('versions on the same day collapse to one', gone.size === 2);
  ck('the newest of the day survives', !gone.has(evening.id));
  ck('the earlier ones go', gone.has(morning.id) && gone.has(noon.id));
  ck('another day keeps its own', !gone.has(otherDay.id));

  // Days are UTC: 23:30 and 00:30 are different days, however close.
  const late = v('auto', '2026-10-15T23:30:00Z');
  const early = v('auto', '2026-10-16T00:30:00Z');
  ck('days split at UTC midnight', prune([late, early]).size === 0);

  // Ties on saved_at fall to created_at, then id — never to input order.
  const a = v('auto', '2026-10-10T10:00:00Z', '2026-10-10T10:05:00Z');
  const b = v('auto', '2026-10-10T10:00:00Z', '2026-10-10T10:09:00Z');
  ck(
    'a tie is broken by write time, whatever the order given',
    versionsToPrune([a, b], now).join() === a.id && versionsToPrune([b, a], now).join() === a.id,
  );
}

// --- one per week beyond that ------------------------------------------------------
{
  // 2026-08-03 is a Monday; all of these are well past 30 days.
  const mon = v('auto', '2026-08-03T08:00:00Z');
  const wed = v('auto', '2026-08-05T08:00:00Z');
  const sun = v('auto', '2026-08-09T23:00:00Z');
  const nextMon = v('auto', '2026-08-10T01:00:00Z');
  const gone = prune([mon, wed, sun, nextMon]);
  ck('older versions collapse to one per week', gone.size === 2);
  ck('the newest of the week survives', !gone.has(sun.id) && gone.has(mon.id) && gone.has(wed.id));
  ck('weeks start on Monday', !gone.has(nextMon.id));

  // The tiers do not share buckets: a week straddling the 30-day line keeps one
  // version on each side of it.
  const daily = v('auto', new Date(now.getTime() - DAILY_MS + HOUR));
  const weekly = v('auto', new Date(now.getTime() - DAILY_MS - HOUR));
  ck(
    'a day in the daily tier and a week beyond it are separate',
    prune([daily, weekly]).size === 0,
  );
}

// --- exemptions ------------------------------------------------------------------------
{
  const manualOld = v('manual', '2025-01-01T10:00:00Z');
  const manualOld2 = v('manual', '2025-01-01T11:00:00Z');
  const manualDay = v('manual', '2026-10-12T10:00:00Z');
  const autoDay = v('auto', '2026-10-12T09:00:00Z');
  const gone = prune([manualOld, manualOld2, manualDay, autoDay]);
  ck('manual versions are never pruned, however old or many', gone.size === 0);
  ck(
    "and do not take a bucket's place: the day keeps its own last state too",
    !gone.has(autoDay.id),
  );

  const restoreOld = v('before-restore', '2026-10-05T10:00:00Z');
  const restoreNew = v('before-restore', '2026-10-06T10:00:00Z');
  const autoAfterRestore = v('auto', '2026-10-06T12:00:00Z');
  const autoAfterOld = v('auto', '2026-10-05T12:00:00Z');
  const replaceOld = v('before-replace', '2026-07-01T10:00:00Z');
  const replaceNew = v('before-replace', '2026-07-02T10:00:00Z');
  const autoSameWeek = v('auto', '2026-07-03T10:00:00Z');
  const gone2 = prune([
    restoreOld,
    restoreNew,
    autoAfterRestore,
    autoAfterOld,
    replaceOld,
    replaceNew,
    autoSameWeek,
  ]);
  ck(
    'the newest before-restore is kept beside a newer version of its day',
    !gone2.has(restoreNew.id),
  );
  ck(
    'the newest before-replace is kept beside a newer version of its week',
    !gone2.has(replaceNew.id),
  );
  ck(
    'older ones thin out like automatic versions',
    gone2.has(restoreOld.id) && gone2.has(replaceOld.id),
  );
  ck(
    'and the automatic versions those days end with survive',
    !gone2.has(autoAfterRestore.id) && !gone2.has(autoAfterOld.id) && !gone2.has(autoSameWeek.id),
  );
  ck(
    'exactly those two go',
    [...gone2].sort().join() === ids(restoreOld, replaceOld).sort().join(),
  );
}

// --- stability ------------------------------------------------------------------------
{
  const history = [];
  for (let h = 0; h < 24 * 90; h += 1) {
    history.push(v(h % 50 === 0 ? 'manual' : 'auto', new Date(now.getTime() - h * HOUR)));
  }
  const gone = prune(history);
  const kept = history.filter((x) => !gone.has(x.id));
  ck('pruning what was kept deletes nothing more', versionsToPrune(kept, now).length === 0);
  ck(
    'ninety days of hourly versions shrink to under two hundred',
    kept.length < 200 && kept.length > 24 + 29,
  );
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
