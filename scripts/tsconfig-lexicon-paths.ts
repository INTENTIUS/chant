/**
 * The root tsconfig.json's lexicon `paths`, generated from `lexicons/` (chant #2376).
 *
 * Each lexicon needs two entries, `@intentius/chant-lexicon-<name>` and its `/*` subpath.
 * A single wildcard cannot replace them: a paths pattern may hold one `*` (TS5061), and the
 * subpath form needs two, one for the lexicon name and one for the path under its `src/`.
 *
 * So the block is generated. `npm run generate:tsconfig-paths` rewrites it, and
 * scripts/tsconfig-lexicon-paths.test.ts fails both ways: a lexicon directory with no entry,
 * or an entry whose directory is gone. `chant dev onboard` appends a new lexicon's pair at
 * the end of the map; the test checks entries, not their order.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "@intentius/chant-lexicon-";

export type Paths = Record<string, string[]>;

/** Every directory under lexicons/ that holds a package.json, sorted. */
export function lexiconNames(repoRoot: string): string[] {
  const dir = join(repoRoot, "lexicons");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "package.json")))
    .map((e) => e.name)
    .sort();
}

/** The two paths entries one lexicon needs. */
export function lexiconEntries(name: string): Paths {
  return {
    [`${PREFIX}${name}`]: [`./lexicons/${name}/src/index.ts`],
    [`${PREFIX}${name}/*`]: [`./lexicons/${name}/src/*`],
  };
}

/** The paths object with its lexicon entries replaced by the generated ones, sorted by name. */
export function generatePaths(current: Paths, names: string[]): Paths {
  const out: Paths = {};
  for (const [key, value] of Object.entries(current)) {
    if (!key.startsWith(PREFIX)) out[key] = value;
  }
  for (const name of [...names].sort()) Object.assign(out, lexiconEntries(name));
  return out;
}

/** Lexicon keys the generator would add, and lexicon keys it would drop. */
export function diffPaths(current: Paths, names: string[]): { missing: string[]; stale: string[] } {
  const want = generatePaths(current, names);
  const has = (p: Paths, k: string, v?: string[]) => k in p && JSON.stringify(p[k]) === JSON.stringify(v ?? p[k]);
  const missing = Object.keys(want).filter((k) => k.startsWith(PREFIX) && !has(current, k, want[k]));
  const stale = Object.keys(current).filter((k) => k.startsWith(PREFIX) && !has(want, k, current[k]));
  return { missing, stale };
}

/** tsconfig.json's text as the generator writes it. */
export function renderTsconfig(text: string, names: string[]): string {
  const config = JSON.parse(text);
  config.compilerOptions.paths = generatePaths(config.compilerOptions.paths ?? {}, names);
  return `${JSON.stringify(config, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const file = join(repoRoot, "tsconfig.json");
  const before = readFileSync(file, "utf-8");
  const after = renderTsconfig(before, lexiconNames(repoRoot));
  if (after === before) {
    console.log("tsconfig.json lexicon paths are up to date");
  } else {
    writeFileSync(file, after);
    console.log("tsconfig.json lexicon paths regenerated");
  }
}
