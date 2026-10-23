/**
 * TipTap packages move in lockstep (#69).
 *
 * TipTap pins its own packages to each other exactly — starter-kit wants
 * `@tiptap/core@3.31.3`, not `^3.31.3` — so if any of ours drifts to a newer
 * minor, the exact requirements disagree and a second `@tiptap/core` or
 * `@tiptap/pm` gets installed. ProseMirror then fails in ways that look
 * nothing like a version problem ("Adding different instances of a keyed
 * plugin", schema mismatches).
 *
 * `pnpm add @tiptap/...` writes a `^` range by default, which is how the mix
 * crept in, so this checks both the declarations and what the lockfile
 * actually resolved. To upgrade, change every `@tiptap/*` version together,
 * then `pnpm install`.
 */
import { readFileSync } from 'node:fs';

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const declared = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name]) =>
  name.startsWith('@tiptap/'),
);
const EXACT = /^\d+\.\d+\.\d+$/;

// --- declarations -------------------------------------------------------------
const loose = declared.filter(([, version]) => !EXACT.test(version));
ck(
  `every @tiptap/* dependency is an exact version${loose.length ? ` (loose: ${loose.map(([n, v]) => `${n}@${v}`).join(', ')})` : ''}`,
  loose.length === 0,
);

// y-tiptap is the Yjs binding, released on its own version line.
const lockstep = declared.filter(([name]) => name !== '@tiptap/y-tiptap');
const versions = new Set(lockstep.map(([, version]) => version));
ck(
  `and all of them except y-tiptap are the same version (${[...versions].join(', ')})`,
  versions.size === 1,
);

// --- what was actually installed ----------------------------------------------
const lock = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
const resolved = new Map();
for (const [, name, version] of lock.matchAll(/^ {2}'?(@tiptap\/[a-z-]+)@(\d+\.\d+\.\d+)[(':]/gm)) {
  if (!resolved.has(name)) resolved.set(name, new Set());
  resolved.get(name).add(version);
}
const doubled = [...resolved].filter(([, set]) => set.size > 1);
ck('the lockfile lists TipTap packages at all', resolved.has('@tiptap/core'));
ck(
  `each resolves to exactly one version${doubled.length ? ` (doubled: ${doubled.map(([n, s]) => `${n} ${[...s].join('/')}`).join(', ')})` : ''}`,
  doubled.length === 0,
);
const installed = new Set(
  [...resolved].filter(([name]) => name !== '@tiptap/y-tiptap').flatMap(([, set]) => [...set]),
);
ck(
  `and the whole family resolves to the declared one (${[...installed].join(', ')})`,
  installed.size === 1 && versions.has([...installed][0]),
);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
