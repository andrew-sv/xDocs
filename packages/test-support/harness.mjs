/**
 * The harness every Node suite shares: unit, jsdom and server integration
 * alike (#70).
 *
 * It used to be re-implemented per file — a `ck(label, ok)` printing PASS or
 * FAIL, a failure counter, an `ALL PASS` footer and a `process.exit` — so
 * there were two dozen copies, and no way to run one check by name. This is
 * that same harness built on `node:test`, which is still no dependency and
 * still a plain Node script: `node undo.test.mjs` runs a suite as before.
 * What it adds is a name per check, `--test-name-pattern` to pick checks, and
 * one exit code computed by Node rather than by every file.
 *
 * The suites are STORIES, not collections of independent tests: a check reads
 * state that every step before it built, between top-level awaits. So a check
 * is evaluated by the suite, in the suite's own order, and node:test is only
 * told the result. That keeps what the old harness had:
 *
 *  - Order. Nothing is reordered or run concurrently; the story runs exactly
 *    as written. Top-level tests registered after an `await` still run, in
 *    registration order.
 *  - A failed check does not stop the story. It is reported and the next step
 *    runs, so one run shows every failure.
 *  - `--test-name-pattern` narrows what is REPORTED, never what runs: every
 *    step still executes, because the check you want depends on them.
 *
 * Do not use node:test's `before`/`after` at the top level of a suite, or run
 * one with `--test-force-exit`. The root test runs its hooks — and that flag
 * ends the process — as soon as its queue first drains, which is after the
 * first check, while the story is still awaiting its second step.
 * `cleanup()` and `finish()` are the replacement.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';

/**
 * Report one named check. `ok` is anything truthy or falsy, as `ck` took.
 *
 * Names should be unique within a suite: they are what `--test-name-pattern`
 * matches and what the failure summary lists.
 */
export function check(name, ok) {
  // node:test locates every check here, in the harness, so the failure names
  // the line in the suite that made it.
  const at = new Error().stack?.split('\n')[2]?.trim().replace(/^at /, '') ?? 'unknown';
  void test(name, () => {
    assert.ok(ok, `got ${inspect(ok)}, checked at ${at}`);
  });
}

/** In registration order; run backwards, so what was set up last goes first. */
const cleanups = [];

/**
 * Undo something when the suite ends, however it ends: at `finish()`, or when
 * a step throws. Register it right where the thing is made — `tracker.purge()`
 * after `trackCreatedDocuments()`, `db.end()` after `db.connect()`. Each runs
 * at most once.
 */
export function cleanup(fn) {
  cleanups.push(fn);
}

async function runCleanups() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch (err) {
      console.error(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The end of the story: run every cleanup. The last line of a suite that
 * registered any.
 *
 * node:test ends the process when nothing is left open, so a socket, client
 * or child process still open here keeps the suite running. The old footer's
 * `process.exit` hid that; close what you open, or register it.
 */
export async function finish() {
  await runCleanups();
}

/*
 * A step that throws. node:test catches it — a top-level rejection reaches it
 * as an uncaught exception — and reports it as a one-line note, but the
 * process carries on as long as anything is open, so a suite that throws
 * with a provider connected would hang where it used to crash. So: print the
 * error whole, mark the run failed, clean up, and if something unregistered
 * still holds the process open, end it. The checks reported so far stand.
 */
let crashed = false;
function crash(err) {
  if (crashed) return;
  crashed = true;
  process.exitCode = 1;
  console.error('the suite stopped on an exception:\n', err);
  void runCleanups().finally(() => {
    setTimeout(() => process.exit(1), 1000).unref();
  });
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
