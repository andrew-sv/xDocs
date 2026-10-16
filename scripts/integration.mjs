#!/usr/bin/env node
/**
 * Run the server integration suites, most of them at once.
 *
 * Each suite is a plain Node script that prints PASS/FAIL lines and exits
 * non-zero — there is no test runner (see CLAUDE.md). Run one after another
 * they spend nearly all of their time waiting: on round trips to Neon, on the
 * Hocuspocus store, on an MCP subprocess starting. Run together they overlap
 * that waiting, and the whole thing finishes in about the time of the slowest
 * suite (#32).
 *
 * Output is buffered per suite and printed when that suite ends, so the
 * PASS/FAIL lines stay in their own block instead of interleaving. Failures
 * are reprinted at the end, because a failure that scrolled past ten other
 * suites is a failure nobody sees.
 *
 * Suites may run together because each one creates everything it asserts on
 * and purges it afterwards (test-cleanup.mjs) — the same property the browser
 * suite needs to shard. Anything that cannot is marked `alone` below, with the
 * reason.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, 'apps/web');
const mcp = resolve(root, 'apps/mcp');

/*
 * Longest first, because the pool takes them in order and the run ends when
 * the last one does: starting the 40-second suite behind four 13-second ones
 * leaves it running alone at the end.
 */
const SUITES = [
  { name: 'attachments', cwd: web, file: 'attachments.test.mjs' },
  /*
   * Starts its own API on :3011 with a 1 MB quota, so it needs nothing from
   * the shared server and can overlap everything else.
   */
  { name: 'quota-race', cwd: web, file: 'quota-race.test.mjs' },
  { name: 'content', cwd: web, file: 'content.test.mjs' },
  { name: 'versions', cwd: web, file: 'versions.test.mjs' },
  { name: 'nested', cwd: web, file: 'nested.test.mjs' },
  { name: 'mcp', cwd: mcp, file: 'mcp.test.mjs' },
  { name: 'move', cwd: web, file: 'move.test.mjs' },
  { name: 'integration', cwd: web, file: 'integration.test.mjs' },
  { name: 'trash', cwd: web, file: 'trash.test.mjs' },
  { name: 'search', cwd: web, file: 'search.test.mjs' },
  { name: 'apikeys', cwd: web, file: 'apikeys.test.mjs' },
  { name: 'visibility', cwd: web, file: 'visibility.test.mjs' },
  /*
   * Alone: it counts pings on the workspace channel, which every signed-in
   * user shares, and three of its assertions are that NOTHING pinged. Every
   * successful non-GET on the documents routes pings, so any suite running
   * beside it fails those three.
   */
  { name: 'live', cwd: web, file: 'live.test.mjs', alone: true },
];

const wanted = process.argv.slice(2);
const unknown = wanted.filter((n) => !SUITES.some((s) => s.name === n));
if (unknown.length > 0) {
  console.error(`unknown suite(s): ${unknown.join(', ')}`);
  console.error(`available: ${SUITES.map((s) => s.name).join(', ')}`);
  process.exit(2);
}
const suites = wanted.length > 0 ? SUITES.filter((s) => wanted.includes(s.name)) : SUITES;

/*
 * Six is where the run stops getting faster: past it the critical path is no
 * longer the queue but `attachments`, the slowest single suite, which nothing
 * can overlap with itself. Measured at 75s with four and 55s with six; eight
 * buys nothing.
 *
 * It is bounded rather than "spawn them all" because one API process serves
 * every suite, and several of them assert on timings a saturated server would
 * stretch — a CRDT update reaching another client within 600ms, say. Unlike
 * the browser suite these are cheap Node processes rather than Chromiums, so
 * the ceiling sits higher than #28's.
 */
const limit = Number(process.env.INTEGRATION_CONCURRENCY ?? 6);

const results = [];

function run(suite) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [suite.file], {
      cwd: suite.cwd,
      // Merged, and captured rather than inherited: interleaved PASS lines from
      // ten suites are unreadable.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });
    child.on('error', (err) => {
      output += `\nfailed to start: ${err.message}\n`;
    });
    child.on('close', (code) => {
      const result = {
        name: suite.name,
        // A signal kill reports code null; that is a failure, not a pass.
        ok: code === 0,
        code,
        seconds: (Date.now() - started) / 1000,
        output: output.trimEnd(),
      };
      results.push(result);
      report(result);
      done(result);
    });
  });
}

function report({ name, ok, seconds, output }) {
  const badge = ok ? 'PASS' : 'FAIL';
  console.log(
    `\n── ${name} ${'─'.repeat(Math.max(1, 40 - name.length))} ${seconds.toFixed(1)}s  ${badge}`,
  );
  if (output) console.log(output);
}

/** Run `list` with at most `limit` going at once. */
async function pool(list, limit) {
  const queue = [...list];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await run(next);
  });
  await Promise.all(workers);
}

/*
 * One clear line beats eleven stack traces: every suite hardcodes this API and
 * they would all fail identically with the stack down.
 */
const health = await fetch('http://localhost:3001/health').catch(() => null);
if (!health?.ok) {
  console.error(
    'the API is not answering on http://localhost:3001 — start the stack with `pnpm dev`',
  );
  process.exit(2);
}

const together = suites.filter((s) => !s.alone);
const separately = suites.filter((s) => s.alone);

console.log(
  `integration: ${suites.length} suite(s) — ${together.length} together (concurrency ${limit}), ` +
    `${separately.length} on their own`,
);

// The solitary ones first, and one at a time: they must not overlap the pool
// OR each other.
for (const suite of separately) await run(suite);
await pool(together, limit);

const failed = results.filter((r) => !r.ok);
const slowest = results.reduce((max, r) => Math.max(max, r.seconds), 0);

console.log(`\n${'═'.repeat(60)}`);
for (const r of [...results].sort((a, b) => b.seconds - a.seconds)) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(14)} ${r.seconds.toFixed(1)}s`);
}

if (failed.length === 0) {
  console.log(`\nALL PASS — ${results.length} suite(s), slowest ${slowest.toFixed(1)}s`);
  process.exit(0);
}

// Reprinted: the failure itself is thousands of lines back by now.
console.log(`\n${failed.length} suite(s) FAILED\n`);
for (const r of failed) {
  console.log(`── ${r.name} (exit ${r.code}) ──`);
  console.log(
    r.output
      .split('\n')
      .filter((line) => /^FAIL|Error|error:/.test(line))
      .join('\n') || r.output,
  );
  console.log();
}
process.exit(1);
