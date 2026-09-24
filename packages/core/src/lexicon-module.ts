/**
 * Lexicons declared by module path (chant #2520).
 *
 * A `lexicons` entry has always been a bare name, and chant resolves a name to
 * the package `@intentius/chant-lexicon-<name>`. A project that writes its own
 * lexicon in the same repo can instead point at the module:
 *
 * ```ts
 * export default {
 *   lexicons: ["fly", { name: "site", module: "./lexicon/index.ts" }],
 * } satisfies ChantConfig;
 * ```
 *
 * The path is resolved against the directory holding `chant.config.ts`. That
 * module is the whole lexicon: its `LexiconPlugin` export is the plugin, the
 * plugin's `activities()` and `activityContracts()` members stand in for the
 * `op/activities` and `op/activity-contracts` subpaths, a `CapabilityPlugin`
 * export feeds the capability registry, and an `evaluateGatePolicy` export
 * stands in for the `gate-policy` subpath.
 *
 * Loaders take lexicon names, so the config loader records each path-declared
 * name here and every loader asks {@link lexiconModulePath} before falling back
 * to the package name. A name declared as a plain string is never recorded, so
 * a project that names lexicons by package takes exactly the path it always did.
 */

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * One `lexicons` entry: a package-backed name, or a name plus the module that
 * implements it. `root` (chant#2590) names the directory the lexicon's files
 * live in, for fold's trust; see {@link pathLexiconRoot}.
 */
export type LexiconDeclaration = string | { name: string; module: string; root?: string };

/** The lexicon name an entry declares, whichever form it takes. */
export function lexiconDeclarationName(entry: LexiconDeclaration): string {
  return typeof entry === "string" ? entry : entry.name;
}

/** Every entry's name, in declaration order. `undefined` in, `undefined` out. */
export function lexiconNames(entries: readonly LexiconDeclaration[]): string[];
export function lexiconNames(entries: readonly LexiconDeclaration[] | undefined): string[] | undefined;
export function lexiconNames(entries: readonly LexiconDeclaration[] | undefined): string[] | undefined {
  return entries?.map(lexiconDeclarationName);
}

/** Name to absolute module path, for the lexicons declared by path in the configs loaded so far. */
const modulePaths = new Map<string, string>();

/** Name to the absolute directory fold trusts for that lexicon (chant#2590). Absent: only the module is trusted. */
const moduleRoots = new Map<string, string>();

/** True when `path` is `dir` itself or lies under it. Both are absolute. */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * chant#2590 — the directory fold trusts for a lexicon declared by path.
 *
 * A package has a root that bounds its subpaths. A module path has none, so
 * the directory is either the one `root` names, resolved like `module`, or the
 * module's own directory. It must lie inside the project (`baseDir`, the
 * directory holding `chant.config.ts`) and must not contain the project's
 * source directory (`sourceDir`, relative to `baseDir`, default `.`). The
 * module must lie inside it.
 *
 * Returns the directory, or `undefined` when only the module file is trusted.
 * A declared `root` that breaks a rule returns a `problem` to report; the
 * module's own directory breaking one (a module at the project root, say)
 * just leaves the lexicon with its module file.
 */
export function pathLexiconRoot(
  entry: { module: string; root?: string },
  baseDir: string,
  sourceDir = ".",
): { root?: string; problem?: string } {
  const modulePath = isAbsolute(entry.module) ? entry.module : resolve(baseDir, entry.module);
  const declared = entry.root !== undefined;
  const candidate = declared
    ? isAbsolute(entry.root!)
      ? resolve(entry.root!)
      : resolve(baseDir, entry.root!)
    : dirname(modulePath);
  const project = resolve(baseDir);
  const source = resolve(baseDir, sourceDir);
  let problem: string | undefined;
  if (!isWithin(candidate, project)) problem = `${candidate} is outside the project (${project})`;
  else if (isWithin(source, candidate)) problem = `${candidate} contains the project's source directory (${source})`;
  else if (!isWithin(modulePath, candidate)) problem = `the module ${modulePath} is not inside ${candidate}`;
  if (problem === undefined) return { root: candidate };
  return declared ? { problem } : {};
}

/**
 * Record the path-declared entries of one loaded config. `baseDir` is the
 * directory the config file sits in. A plain-string entry for a name removes
 * any path recorded for it earlier in this process, so loading a second
 * project (the example harness does) cannot leave the first one's module in
 * place of a package.
 *
 * Returns the recorded name-to-path map for this config, empty when every
 * entry is a plain name.
 */
export function registerLexiconDeclarations(
  entries: readonly LexiconDeclaration[] | undefined,
  baseDir: string,
  sourceDir?: string,
): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const entry of entries ?? []) {
    if (typeof entry === "string") {
      modulePaths.delete(entry);
      moduleRoots.delete(entry);
      continue;
    }
    const path = isAbsolute(entry.module) ? entry.module : resolve(baseDir, entry.module);
    modulePaths.set(entry.name, path);
    recorded[entry.name] = path;
    const { root } = pathLexiconRoot(entry, baseDir, sourceDir);
    if (root === undefined) moduleRoots.delete(entry.name);
    else moduleRoots.set(entry.name, root);
  }
  return recorded;
}

/** The absolute module path `name` was declared with, or `undefined` for a package-backed lexicon. */
export function lexiconModulePath(name: string): string | undefined {
  return modulePaths.get(name);
}

/**
 * chant#2590 — the directory fold trusts for a path-declared lexicon, or
 * `undefined` when only its module file is trusted (or `name` is package-backed).
 * See {@link pathLexiconRoot}.
 */
export function lexiconModuleRoot(name: string): string | undefined {
  return moduleRoots.get(name);
}

/** Forget every recorded path. For tests. */
export function resetLexiconModules(): void {
  modulePaths.clear();
  moduleRoots.clear();
}

/**
 * Import the module a path-declared lexicon names. Returns `undefined` when
 * `name` is package-backed, so a caller falls through to its package import.
 * An import failure is thrown with the declared path in the message.
 */
export async function importLexiconModule(name: string): Promise<Record<string, unknown> | undefined> {
  const path = modulePaths.get(name);
  if (path === undefined) return undefined;
  try {
    return (await import(path)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `lexicon "${name}" is declared with module ${path}, which could not be loaded: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * chant#2578 — how a message should name a lexicon. A package-backed name is
 * its npm package; a lexicon declared by path is that path, relative to
 * `fromDir` when it sits under it.
 */
export function lexiconSourceLabel(name: string, fromDir: string = process.cwd()): string {
  const path = modulePaths.get(name);
  if (path === undefined) return `@intentius/chant-lexicon-${name}`;
  const rel = relative(fromDir, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : `./${rel.split(sep).join("/")}`;
}

/** The npm packages that provide `names`, leaving out every lexicon declared by path: those have nothing to install. */
export function lexiconPackagesToInstall(names: readonly string[]): string[] {
  return names.filter((name) => !modulePaths.has(name)).map((name) => `@intentius/chant-lexicon-${name}`);
}
