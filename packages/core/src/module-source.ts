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
