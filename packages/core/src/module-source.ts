/**
 * #3981 — paths for a module that may run from `src/*.ts` or from compiled
 * `dist/*.js`.
 *
 * A package compiles `src/` to `dist/` with the same layout (`rootDir: src`,
 * `outDir: dist`), so a compiled module sits at the same relative path under
 * `dist/` as its source does under `src/`. tsc compiles only the modules: a
 * file a module reads beside itself (generated JSON, skills markdown,
 * snapshots) stays under `src/`, which every package publishes. A module that
 * reads such a file names it from {@link moduleSourceDir}, not from its own
 * directory, and finds it from either layout.
 *
 * String arithmetic only, no filesystem access, so it is safe in a sandboxed
 * child and costs nothing at module scope.
 */

import { dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = `${sep}dist${sep}`;

/**
 * The path a module's source has: `path` itself for a source module, and the
 * matching path under `<package>/src` for a module under `<package>/dist`.
 */
function sourcePathOf(path: string): string {
  if (!/\.[cm]?js$/.test(path)) return path;
  const at = path.lastIndexOf(DIST);
  if (at < 0) return path;
  return path.slice(0, at) + `${sep}src${sep}` + path.slice(at + DIST.length);
}

/**
 * #3981 — the source file a compiled module was built from:
 * `<package>/dist/x/y.js` is `<package>/src/x/y.ts` (`.mjs` from `.mts`, `.cjs`
 * from `.cts`). `undefined` for a path that is not a compiled module under a
 * `dist/`. The file is not checked for.
 */
export function compiledModuleSource(path: string): string | undefined {
  const ext = /\.([cm]?)js$/.exec(path);
  if (!ext || path.lastIndexOf(DIST) < 0) return undefined;
  return sourcePathOf(path).slice(0, -ext[0].length) + `.${ext[1]}ts`;
}

/**
 * The directory a module's source sits in: `dirname` of `moduleUrl` when it
 * runs from source, and the matching directory under `<package>/src` when it
 * runs compiled from `<package>/dist`.
 */
export function moduleSourceDir(moduleUrl: string): string {
  return dirname(sourcePathOf(fileURLToPath(moduleUrl)));
}

/**
 * A URL in the module's source directory, for `createRequire` to read a file
 * that sits beside the source (`require("./generated/lexicon-aws.json")`). The
 * file name keeps the compiled extension; only the directory matters to
 * `createRequire`.
 */
export function moduleSourceUrl(moduleUrl: string): string {
  return pathToFileURL(sourcePathOf(fileURLToPath(moduleUrl))).href;
}

/**
 * Whether `pathOrUrl` names a TypeScript module, which plain node cannot
 * import without a loader: `.ts`, `.mts`, `.cts` or `.tsx`, and not a
 * declaration file. A query or hash is ignored.
 */
export function isTypeScriptModule(pathOrUrl: string): boolean {
  const path = pathOrUrl.replace(/[?#].*$/, "");
  return /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

/**
 * Whether plain node imports `pathOrUrl` with no loader: `.js`, `.mjs`,
 * `.cjs` or `.json`. Anything else, a module with no extension included, is
 * left to tsx, whose resolver completes an extensionless path.
 */
export function isJavaScriptModule(pathOrUrl: string): boolean {
  return /\.(?:[cm]?js|json)$/.test(pathOrUrl.replace(/[?#].*$/, ""));
}

/**
 * #3981 — whether this process resolves chant's packages through their
 * `development` export condition: always when chant runs from source (the
 * CLI's `main()` installs a resolve hook that does so, and vitest's resolver
 * adds the condition outside production mode), and otherwise when node runs
 * with `--conditions=development` (or `-C development`, on the command line
 * or in `NODE_OPTIONS`). Not from the environment: a compiled CLI that a test
 * spawns inherits vitest's variables.
 */
function resolvesDevelopment(): boolean {
  if (isTypeScriptModule(import.meta.url)) return true;
  if (typeof process === "undefined") return false;
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
  return flags.some(
    (flag, i) =>
      flag === "--conditions=development" ||
      flag === "-C=development" ||
      ((flag === "--conditions" || flag === "-C") && flags[i + 1] === "development"),
  );
}

/**
 * #3981 — the package export conditions chant adds to `import`, `node` and
 * `default` when it resolves a package itself (fold's import resolution, the
 * sandbox bundle), so it lands on the module this process's `import()` would.
 * Each chant package maps `development` to `src/*.ts` and `default` to the
 * compiled `dist/*.js` it publishes. `["development"]` when the process
 * resolves with it ({@link resolvesDevelopment}), else empty.
 */
export const SOURCE_EXPORT_CONDITIONS: readonly string[] = resolvesDevelopment() ? ["development"] : [];
