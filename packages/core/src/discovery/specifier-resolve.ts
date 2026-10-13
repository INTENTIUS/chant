/**
 * chant#3090 — the file-system half of fold's import resolution: which file a
 * relative specifier names, which file a package's `exports` map names for a
 * subpath, and which file a tsconfig `paths` entry names.
 *
 * The rules follow TypeScript's `bundler` resolution with `noDtsResolution`,
 * the resolver `tsc` and the editor use for these specifiers:
 *
 * - `./x.js` names `./x.ts` (or `./x.tsx`) when that file exists, and the
 *   `.js` file only otherwise. `.mjs` maps to `.mts`, `.cjs` to `.cts` and
 *   `.jsx` to `.tsx` the same way.
 * - A package's `exports` map is read for the root and for subpaths, with
 *   one `*` per pattern key, and its condition objects are read in key order
 *   against the `import`, `node` and `default` conditions, as an ESM import
 *   in Node reads them.
 * - A `paths` entry from the nearest `tsconfig.json` resolves relative to
 *   `baseUrl` when the config chain sets one and to the directory of the
 *   config that declares `paths` otherwise.
 *
 * Nothing here calls Node's `Module._resolveFilename`: every answer comes from
 * `statSync` and `readFileSync`, which is what keeps the cold-resolution cost
 * of chant#1020 off this path.
 */
import * as ts from "typescript";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve as resolvePath } from "node:path";

/** True when `path` is an existing regular file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** True when `path` is an existing directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/** The TypeScript source extensions a JavaScript extension in a specifier stands for, in the order `tsc` tries them. */
const TS_SOURCE_FOR_JS_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/**
 * The file an absolute module base path names, or `undefined` when none of
 * the probed files exists. A JavaScript extension is first swapped for its
 * TypeScript source extension. Then the path itself, the path with `.ts`,
 * `.tsx`, `.js` and `.mjs` appended, and `index.ts` and `index.js` under it
 * are tried in that order.
 */
export function probeModuleFile(base: string): string | undefined {
  const ext = extname(base);
  const sourceExts = TS_SOURCE_FOR_JS_EXTENSION[ext];
  if (sourceExts) {
    const stem = base.slice(0, -ext.length);
    for (const sourceExt of sourceExts) {
      if (isFile(stem + sourceExt)) return stem + sourceExt;
    }
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  return candidates.find(isFile);
}

/** A bare specifier split into its package name and the subpath after it (`"."` for the root). */
export function splitBareSpecifier(specifier: string): { name: string; subpath: string } | undefined {
  const segments = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  if (segments.length < nameLength || segments.slice(0, nameLength).some((s) => s === "")) return undefined;
  const name = segments.slice(0, nameLength).join("/");
  const rest = segments.slice(nameLength).join("/");
  return { name, subpath: rest === "" ? "." : `./${rest}` };
}

/** The conditions an ESM import in Node matches, which is what the run path does. */
const EXPORT_CONDITIONS: ReadonlySet<string> = new Set(["import", "node", "default"]);

/**
 * The target an `exports` value selects, with `star` substituted for each `*`
 * when it came from a pattern key. A string is the target; an array yields its
 * first resolvable entry; a condition object is read in key order and the
 * first matching condition that resolves wins. `null`, and a condition object
 * with no matching condition, resolve to nothing.
 */
function exportsValueTarget(value: unknown, star: string | undefined): string | undefined {
  if (typeof value === "string") return star === undefined ? value : value.split("*").join(star);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = exportsValueTarget(entry, star);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [condition, conditional] of Object.entries(value)) {
    if (!EXPORT_CONDITIONS.has(condition)) continue;
    const target = exportsValueTarget(conditional, star);
    if (target !== undefined) return target;
  }
  return undefined;
}

/**
 * The target `exportsField` gives `subpath` (`"."` or `"./x"`), relative to
 * the package directory, or `undefined` when the map does not export it. An
 * exact key wins over a pattern; among patterns, the longest prefix before the
 * `*` wins, as in Node's own resolver.
 */
export function packageExportsTarget(exportsField: unknown, subpath: string): string | undefined {
  const isSubpathMap =
    typeof exportsField === "object" &&
    exportsField !== null &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((k) => k.startsWith("."));
  if (!isSubpathMap) return subpath === "." ? exportsValueTarget(exportsField, undefined) : undefined;

  const map = exportsField as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(map, subpath) && !subpath.includes("*")) return exportsValueTarget(map[subpath], undefined);

  let bestKey: string | undefined;
  let bestStar: string | undefined;
  for (const key of Object.keys(map)) {
    const starAt = key.indexOf("*");
    if (starAt === -1 || key.indexOf("*", starAt + 1) !== -1) continue;
    const prefix = key.slice(0, starAt);
    const suffix = key.slice(starAt + 1);
    if (!subpath.startsWith(prefix) || subpath === prefix) continue;
    if (suffix !== "" && (!subpath.endsWith(suffix) || subpath.length < key.length)) continue;
    if (bestKey === undefined || prefix.length > bestKey.indexOf("*") || (prefix.length === bestKey.indexOf("*") && key.length > bestKey.length)) {
      bestKey = key;
      bestStar = subpath.slice(prefix.length, subpath.length - suffix.length);
    }
  }
  return bestKey === undefined ? undefined : exportsValueTarget(map[bestKey], bestStar);
}

// ─────────────────────────────────────────────────────────────────────────
// tsconfig `paths`
// ─────────────────────────────────────────────────────────────────────────

/** One `paths` key, split at its `*`. */
interface PathsPattern {
  key: string;
  prefix: string;
  /** `undefined` for a key with no `*`, which matches only itself. */
  suffix: string | undefined;
  substitutions: readonly string[];
}

/** The `paths` a config chain ends with, ready to match. */
interface TsconfigPaths {
  /** `baseUrl` when the chain sets one, else the directory of the config that declares `paths`. */
  base: string;
  patterns: readonly PathsPattern[];
}

/** A parsed config chain, with the files it was read from and their modification times. */
interface CachedTsconfig {
  stamps: ReadonlyArray<readonly [string, number]>;
  paths: TsconfigPaths | undefined;
}

/** Nearest `tsconfig.json` for a directory (`null` when there is none). */
const nearestTsconfigCache = new Map<string, string | null>();
/** Parsed config chains by leaf config path, re-read when a file in the chain changes. */
const tsconfigCache = new Map<string, CachedTsconfig>();

function nearestTsconfig(dir: string): string | null {
  const cached = nearestTsconfigCache.get(dir);
  if (cached !== undefined) return cached;
  const candidate = join(dir, "tsconfig.json");
  let found: string | null;
  if (isFile(candidate)) found = candidate;
  else {
    const parent = dirname(dir);
    found = parent === dir ? null : nearestTsconfig(parent);
  }
  nearestTsconfigCache.set(dir, found);
  return found;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? -1;
  } catch {
    return -1;
  }
}

/** The config file an `extends` entry names, or `undefined` when it cannot be found. */
function resolveExtends(entry: string, fromConfig: string): string | undefined {
  const fromDir = dirname(fromConfig);
  if (entry.startsWith(".") || isAbsolute(entry)) {
    const path = resolvePath(fromDir, entry);
    if (isFile(path)) return path;
    if (!path.endsWith(".json") && isFile(`${path}.json`)) return `${path}.json`;
    return undefined;
  }
  // A package's config, looked up in `node_modules` the way `tsc` does for
  // the common shapes: the file itself, the file plus `.json`, or the
  // package directory's `tsconfig.json`.
  for (let dir = fromDir; ; ) {
    const path = join(dir, "node_modules", entry);
    if (isFile(path)) return path;
    if (!path.endsWith(".json") && isFile(`${path}.json`)) return `${path}.json`;
    if (isDirectory(path) && isFile(join(path, "tsconfig.json"))) return join(path, "tsconfig.json");
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface ChainOptions {
  paths?: { value: Record<string, unknown>; declaredIn: string };
  baseUrl?: string;
}

/** Read `configPath` and everything it extends, later configs overriding earlier ones. */
function readConfigChain(configPath: string, files: string[], seen: Set<string>): ChainOptions {
  if (seen.has(configPath)) return {};
  seen.add(configPath);
  files.push(configPath);
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch {
    return {};
  }
  const { config } = ts.parseConfigFileTextToJson(configPath, text);
  if (typeof config !== "object" || config === null) return {};
  const raw = config as { extends?: unknown; compilerOptions?: { paths?: unknown; baseUrl?: unknown } };

  const merged: ChainOptions = {};
  const parents = typeof raw.extends === "string" ? [raw.extends] : Array.isArray(raw.extends) ? raw.extends : [];
  for (const parent of parents) {
    if (typeof parent !== "string") continue;
    const parentPath = resolveExtends(parent, configPath);
    if (parentPath === undefined) continue;
    const inherited = readConfigChain(parentPath, files, seen);
    if (inherited.paths) merged.paths = inherited.paths;
    if (inherited.baseUrl !== undefined) merged.baseUrl = inherited.baseUrl;
  }

  const options = raw.compilerOptions;
  if (options && typeof options.paths === "object" && options.paths !== null && !Array.isArray(options.paths)) {
    merged.paths = { value: options.paths as Record<string, unknown>, declaredIn: dirname(configPath) };
  }
  if (options && typeof options.baseUrl === "string") merged.baseUrl = resolvePath(dirname(configPath), options.baseUrl);
  return merged;
}

function parsePaths(chain: ChainOptions): TsconfigPaths | undefined {
  if (!chain.paths) return undefined;
  const patterns: PathsPattern[] = [];
  for (const [key, value] of Object.entries(chain.paths.value)) {
    if (!Array.isArray(value)) continue;
    const substitutions = value.filter((s): s is string => typeof s === "string");
    const starAt = key.indexOf("*");
    if (starAt !== -1 && key.indexOf("*", starAt + 1) !== -1) continue;
    patterns.push(
      starAt === -1
        ? { key, prefix: key, suffix: undefined, substitutions }
        : { key, prefix: key.slice(0, starAt), suffix: key.slice(starAt + 1), substitutions },
    );
  }
  return { base: chain.baseUrl ?? chain.paths.declaredIn, patterns };
}

function tsconfigPathsFor(configPath: string): TsconfigPaths | undefined {
  const cached = tsconfigCache.get(configPath);
  if (cached && cached.stamps.every(([file, mtime]) => mtimeOf(file) === mtime)) return cached.paths;
  const files: string[] = [];
  const paths = parsePaths(readConfigChain(configPath, files, new Set()));
  tsconfigCache.set(configPath, { stamps: files.map((f) => [f, mtimeOf(f)] as const), paths });
  return paths;
}

/**
 * The tsconfig `paths` entry that matches a bare `specifier` imported by
 * `fromFile`, read from the nearest `tsconfig.json` above it, and the file it
 * maps the specifier to (`target`, `undefined` when no substitution names an
 * existing file). `undefined` when no entry matches. An exact key wins over a
 * pattern, and among patterns the longest prefix wins, as in `tsc`.
 * Substitutions are tried in order with {@link probeModuleFile}.
 */
export function tsconfigPathsMatch(
  specifier: string,
  fromFile: string,
): { key: string; target: string | undefined } | undefined {
  const configPath = nearestTsconfig(dirname(fromFile));
  if (configPath === null) return undefined;
  const paths = tsconfigPathsFor(configPath);
  if (!paths) return undefined;

  let best: PathsPattern | undefined;
  for (const pattern of paths.patterns) {
    if (pattern.suffix === undefined) {
      if (pattern.key === specifier) {
        best = pattern;
        break;
      }
      continue;
    }
    if (
      specifier.length >= pattern.prefix.length + pattern.suffix.length &&
      specifier.startsWith(pattern.prefix) &&
      specifier.endsWith(pattern.suffix) &&
      (best === undefined || pattern.prefix.length > best.prefix.length)
    ) {
      best = pattern;
    }
  }
  if (!best) return undefined;

  const star =
    best.suffix === undefined ? "" : specifier.slice(best.prefix.length, specifier.length - best.suffix.length);
  for (const substitution of best.substitutions) {
    const target = probeModuleFile(resolvePath(paths.base, substitution.split("*").join(star)));
    if (target !== undefined) return { key: best.key, target };
  }
  return { key: best.key, target: undefined };
}

/** The file {@link tsconfigPathsMatch} maps `specifier` to, or `undefined`. */
export function tsconfigPathsTarget(specifier: string, fromFile: string): string | undefined {
  return tsconfigPathsMatch(specifier, fromFile)?.target;
}
