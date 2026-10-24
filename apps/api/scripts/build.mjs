/**
 * Bundle the API into `dist/server.js`, which `pnpm start` runs with plain node.
 *
 * A bundler rather than `tsc` emit because `@xdocs/shared` exports raw `.ts`:
 * tsc would leave `import '@xdocs/shared'` pointing at TypeScript that node
 * cannot load from a dependency, so the shared package would need a build of
 * its own. esbuild inlines it instead. Every OTHER dependency stays external —
 * resolved from node_modules at runtime, as under tsx — because bundling CJS
 * packages like `pg` into an ESM file breaks their `require` calls.
 *
 * This only transpiles; `pnpm typecheck` is what checks the types.
 *
 *   pnpm --filter @xdocs/api build
 */
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@xdocs/'));

await build({
  entryPoints: [new URL('../src/server.ts', import.meta.url).pathname],
  outfile: new URL('../dist/server.js', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Naming a package also externalises its subpaths (`hono/cors`).
  external,
  sourcemap: true,
  logLevel: 'info',
});
