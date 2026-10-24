/**
 * Which sidebar list responses may land (#72).
 *
 * Each rule in `ListFreshness` exists because of a real race (#22, #28), and
 * until now only the browser suite could reach them — `e2e/stale.spec.ts`,
 * `e2e/auth.spec.ts` — where the interleaving is whatever the machine's load
 * makes it. Here every fetch is a promise this script resolves by hand, so
 * each race is played out in exactly the order that once broke it.
 */
import { ListFreshness, UNSAVED_TITLE_TTL_MS } from './src/lib/listFreshness.ts';

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

/**
 * A fake `api.listLevel`: every call is held until the test answers it, so
 * responses can be delivered in any order.
 */
function server() {
  const calls = [];
  const fetch = (level) =>
    new Promise((resolve, reject) => {
      calls.push({ level, resolve, reject });
    });
  /** Answer call `i` with `rows`, read by the server at `asOf`. */
  const answer = (i, rows, asOf) => calls[i].resolve({ rows, asOf });
  return { calls, fetch, answer };
}

const row = (id, title = id) => ({ id, title });
const ids = (rows) => (rows === null ? null : rows.map((r) => r.id).join(','));

// --- the plain path -------------------------------------------------------
{
  const f = new ListFreshness(null);
  const s = server();
  const pending = f.load(null, s.fetch);
  s.answer(0, [row('a'), row('b')], 100);
  ck('an unchallenged response lands', ids(await pending) === 'a,b');
}

// --- level change ---------------------------------------------------------
{
  /*
   * Open a document while the root list is still loading: the root response
   * arrives after the child level's and must not overwrite it.
   */
  const f = new ListFreshness(null);
  const s = server();
  const root = f.load(null, s.fetch);
  f.setLevel('p');
  const child = f.load('p', s.fetch);
  s.answer(1, [row('c1')], 200);
  ck('the level now on screen lands', ids(await child) === 'c1');
  s.answer(0, [row('r1')], 100);
  ck('a response for a level left meanwhile is dropped', (await root) === null);
}
{
  const f = new ListFreshness(null);
  const s = server();
  const root = f.load(null, s.fetch);
  f.setLevel('p');
  f.setLevel(null);
  s.answer(0, [row('r1')], 100);
  ck('leaving a level and coming back before it answers still lands', ids(await root) === 'r1');
}

// --- a local mutation retires what is in flight ---------------------------
{
  /*
   * e2e/stale.spec.ts: create a document while the FIRST list fetch is out.
   * Same level, so the level guard passes it — only the change counter stops
   * it wiping the row just added.
   */
  const f = new ListFreshness(null);
  const s = server();
  const first = f.load(null, s.fetch);
  f.invalidate(); // the create
  s.answer(0, [row('old')], 100);
  ck('a response sent before a local change is dropped', (await first) === null);

  const after = f.load(null, s.fetch);
  s.answer(1, [row('new'), row('old')], 150);
  ck('one sent after the change lands', ids(await after) === 'new,old');
}
{
  const f = new ListFreshness(null);
  const s = server();
  const before = f.load(null, s.fetch);
  f.invalidate();
  const after = f.load(null, s.fetch);
  // The retired fetch answering LAST, with a later read time, still loses.
  s.answer(1, [row('new')], 100);
  s.answer(0, [row('stale')], 200);
  ck('the post-change fetch lands', ids(await after) === 'new');
  ck('and the pre-change one is dropped even if it answers later', (await before) === null);
}

// --- older than what is shown ---------------------------------------------
{
  /*
   * Out of order: under load the server answers a later request first. The
   * list read earlier (asOf 100) arrives last and must not hide what the list
   * read later (asOf 200) showed — this is how a restored row vanished.
   */
  const f = new ListFreshness(null);
  const s = server();
  const sentFirst = f.load(null, s.fetch);
  const sentSecond = f.load(null, s.fetch);
  s.answer(1, [row('restored'), row('a')], 200);
  ck('the newer read lands first', ids(await sentSecond) === 'restored,a');
  s.answer(0, [row('a')], 100);
  ck('an older read arriving afterwards is dropped', (await sentFirst) === null);
}
{
  // The comparison is the server's read time, NOT the order sent.
  const f = new ListFreshness(null);
  const s = server();
  const sentFirst = f.load(null, s.fetch);
  const sentSecond = f.load(null, s.fetch);
  s.answer(1, [row('x')], 100);
  await sentSecond;
  s.answer(0, [row('y')], 300);
  ck('a response sent earlier but read later still lands', ids(await sentFirst) === 'y');
}
{
  const f = new ListFreshness(null);
  const s = server();
  const a = f.load(null, s.fetch);
  const b = f.load(null, s.fetch);
  s.answer(0, [row('a')], 100);
  await a;
  s.answer(1, [row('b')], 100);
  ck('an equal read time is not older, so it lands', ids(await b) === 'b');
}
{
  /*
   * The read time on screen belongs to one level. A later visit to another
   * level starts fresh: its first response is not compared with a read time
   * taken somewhere else.
   */
  const f = new ListFreshness(null);
  const s = server();
  const root = f.load(null, s.fetch);
  s.answer(0, [row('r')], 500);
  await root;
  f.setLevel('p');
  const child = f.load('p', s.fetch);
  s.answer(1, [row('c')], 100);
  ck("another level's read time does not hold a response back", ids(await child) === 'c');
}

// --- starting a fetch never retires another -------------------------------
{
  /*
   * Pings start a fetch each (#22). When each new fetch retired the last, a
   * steady stream meant nothing ever landed and the sidebar froze. Start ten,
   * answer them in send order with rising read times: every one must land.
   */
  const f = new ListFreshness(null);
  const s = server();
  const loads = Array.from({ length: 10 }, () => f.load(null, s.fetch));
  const landed = [];
  for (let i = 0; i < 10; i++) {
    s.answer(i, [row(`v${i}`)], 100 + i);
    landed.push(await loads[i]);
  }
  ck(
    'under a stream of overlapping fetches every response still lands',
    landed.every((r) => r !== null),
  );
}
{
  const f = new ListFreshness(null);
  const s = server();
  const first = f.load(null, s.fetch);
  void f.load(null, s.fetch); // started, never answered
  s.answer(0, [row('first')], 100);
  ck('a fetch that is merely started does not retire one in flight', ids(await first) === 'first');
}

// --- the sign-out latch ---------------------------------------------------
{
  // Already in flight when sign-out starts: checked AFTER the await.
  const f = new ListFreshness(null);
  const s = server();
  const inFlight = f.load(null, s.fetch);
  f.endSession();
  s.answer(0, [row('theirs')], 100);
  ck('a response in flight when sign-out began is dropped', (await inFlight) === null);
}
{
  /*
   * Started DURING sign-out, while the token is still set: checked BEFORE the
   * await. This is the case a sequence number got wrong — the fetch would
   * see the bumped number and agree with itself.
   */
  const f = new ListFreshness(null);
  const s = server();
  f.endSession();
  const started = f.load(null, s.fetch);
  ck('a fetch starting after sign-out is not even sent', s.calls.length === 0);
  // Answer it if it was sent anyway, so a regression fails here, not by hanging.
  if (s.calls.length > 0) s.answer(0, [row('theirs')], 100);
  ck('and resolves to nothing', (await started) === null);
}
{
  const f = new ListFreshness(null);
  f.endSession();
  ck('the latch reads as ended for other fetchers (the trash)', f.sessionEnded === true);
  f.resumeSession();
  ck('signing in clears it', f.sessionEnded === false);
  const s = server();
  const back = f.load(null, s.fetch);
  s.answer(0, [row('mine')], 100);
  ck("and the next account's list lands", ids(await back) === 'mine');
}
{
  /*
   * A response from the ended session that is still in flight when the next
   * one signs in: clearing the latch lets it through. That is how the code
   * behaved before this module existed too — recorded, not endorsed, so a
   * change to it is a deliberate one.
   */
  const f = new ListFreshness(null);
  const s = server();
  const old = f.load(null, s.fetch);
  f.endSession();
  f.resumeSession();
  s.answer(0, [row('old')], 100);
  ck('the latch is a latch: only its state on arrival matters', ids(await old) === 'old');
}

// --- errors ---------------------------------------------------------------
{
  const f = new ListFreshness(null);
  const s = server();
  const failing = f.load(null, s.fetch);
  s.calls[0].reject(new Error('GET /documents failed: 500'));
  let thrown = null;
  try {
    await failing;
  } catch (e) {
    thrown = e;
  }
  ck('a failed fetch rejects to the caller untouched', thrown?.message.includes('500'));
  const next = f.load(null, s.fetch);
  s.answer(1, [row('a')], 1);
  ck('and leaves nothing shown, so any read time lands next', ids(await next) === 'a');
}

// --- unsaved titles -------------------------------------------------------
{
  /*
   * A refetch lands before the collab server's debounced save of a title
   * being typed: the fetched row still says "Untitled".
   */
  const f = new ListFreshness(null);
  const s = server();
  f.noteTitle('a', 'Quarterly plan', 1_000);
  const load = f.load(null, s.fetch, () => 2_000);
  const fetched = [row('a', 'Untitled'), row('b', 'Other')];
  s.answer(0, fetched, 100);
  const rows = await load;
  ck('a typed title survives a refetch', rows[0].title === 'Quarterly plan');
  ck('other rows are untouched', rows[1] === fetched[1]);
  ck('and the fetched row is copied, not mutated', fetched[0].title === 'Untitled');
}
{
  const f = new ListFreshness(null);
  f.noteTitle('a', 'Plan', 1_000);
  f.withUnsavedTitles([row('a', 'Plan')], 2_000); // the save arrived
  const later = f.withUnsavedTitles([row('a', 'Renamed elsewhere')], 3_000);
  ck(
    'once a fetched row agrees, the typed title is forgotten',
    later[0].title === 'Renamed elsewhere',
  );
}
{
  const f = new ListFreshness(null);
  f.noteTitle('a', 'Plan', 0);
  const within = f.withUnsavedTitles([row('a', 'Untitled')], UNSAVED_TITLE_TTL_MS);
  ck('a typed title holds right up to the backstop', within[0].title === 'Plan');
  const past = f.withUnsavedTitles([row('a', 'Untitled')], UNSAVED_TITLE_TTL_MS + 1);
  ck('and gives way after it', past[0].title === 'Untitled');
  const after = f.withUnsavedTitles([row('a', 'Untitled')], 0);
  ck('for good', after[0].title === 'Untitled');
}
{
  // A dropped response must not spend the entry: only applied lists consult it.
  const f = new ListFreshness(null);
  const s = server();
  f.noteTitle('a', 'Plan', 1_000);
  const dropped = f.load(null, s.fetch, () => 2_000);
  f.invalidate();
  s.answer(0, [row('a', 'Plan')], 100);
  await dropped;
  const kept = f.withUnsavedTitles([row('a', 'Untitled')], 3_000);
  ck('a dropped response does not clear an unsaved title', kept[0].title === 'Plan');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
