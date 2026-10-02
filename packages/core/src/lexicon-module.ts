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

import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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
    const path = declaredModulePath(entry, baseDir);
    modulePaths.set(entry.name, path);
    recorded[entry.name] = path;
    const { root } = pathLexiconRoot(entry, baseDir, sourceDir);
    if (root === undefined) moduleRoots.delete(entry.name);
    else moduleRoots.set(entry.name, root);
  }
  return recorded;
}

function declaredModulePath(entry: { module: string }, baseDir: string): string {
  return isAbsolute(entry.module) ? entry.module : resolve(baseDir, entry.module);
}

/**
 * chant#2589 — the name-to-path map `entries` declare, without recording it.
 * For a caller that must name path lexicons in its messages but must never
 * let a loader import one (`chant audit` runs no project code).
 */
export function pathLexiconMap(entries: readonly LexiconDeclaration[], baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry !== "string") map.set(entry.name, declaredModulePath(entry, baseDir));
  }
  return map;
}

/** A copy of the paths recorded so far in this process. */
export function recordedLexiconModules(): Map<string, string> {
  return new Map(modulePaths);
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
 * `fromDir` when it sits under it. `paths` defaults to the paths recorded in
 * this process; see {@link pathLexiconMap} for a map that is not recorded.
 */
export function lexiconSourceLabel(
  name: string,
  fromDir: string = process.cwd(),
  paths: ReadonlyMap<string, string> = modulePaths,
): string {
  const path = paths.get(name);
  if (path === undefined) return `@intentius/chant-lexicon-${name}`;
  const rel = relative(fromDir, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : `./${rel.split(sep).join("/")}`;
}

/**
 * The npm packages that provide `names`, leaving out every lexicon declared by
 * path: those have nothing to install. `paths` as in {@link lexiconSourceLabel}.
 */
export function lexiconPackagesToInstall(
  names: readonly string[],
  paths: ReadonlyMap<string, string> = modulePaths,
): string[] {
  return names.filter((name) => !paths.has(name)).map((name) => `@intentius/chant-lexicon-${name}`);
}

/**
 * chant#2845 — the npm package a bare specifier names: `@scope/name` for a
 * scoped one, else its first segment. `undefined` for a relative or absolute
 * path, which is not a package.
 */
export function packageNameOf(spec: string): string | undefined {
  if (spec.startsWith(".") || isAbsolute(spec) || spec.startsWith("file:")) return undefined;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** True when `err` says the package `pkg` itself could not be found, not something it imports. */
function isPackageNotFound(err: unknown, pkg: string): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(`'${pkg}'`) || message.includes(`"${pkg}"`) || message.includes(`${pkg}/`);
}

/**
 * chant#2845 — resolve `spec` (a lexicon package or one of its subpaths) from
 * `fromDir` instead of from chant's own install, or `undefined` when the
 * project doesn't have it either.
 */
export function resolveFromProject(spec: string, fromDir: string = process.cwd()): string | undefined {
  try {
    return createRequire(join(fromDir, "package.json")).resolve(spec);
  } catch {
    return undefined;
  }
}

/**
 * chant#2845 — import a lexicon package, or one of its subpaths, by its bare
 * specifier. chant's own install is tried first, as a bare `import()` always
 * did, so a lexicon chant can reach loads exactly as before. When the package
 * isn't there, which is the case for a chant installed globally and a project
 * that installs its lexicons in its own node_modules, it is resolved from
 * `fromDir` (the project) and imported from there. Any other failure, and a
 * package the project doesn't have either, rethrows the first error.
 */
export async function importLexiconPackage(spec: string, fromDir: string = process.cwd()): Promise<Record<string, unknown>> {
  try {
    return (await import(spec)) as Record<string, unknown>;
  } catch (err) {
    const pkg = packageNameOf(spec);
    if (pkg === undefined || !isPackageNotFound(err, pkg)) throw err;
    const resolved = resolveFromProject(spec, fromDir);
    if (resolved === undefined) throw err;
    return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  }
}
