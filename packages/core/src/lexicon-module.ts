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

import { isAbsolute, resolve } from "node:path";

/** One `lexicons` entry: a package-backed name, or a name plus the module that implements it. */
export type LexiconDeclaration = string | { name: string; module: string };

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
): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const entry of entries ?? []) {
    if (typeof entry === "string") {
      modulePaths.delete(entry);
      continue;
    }
    const path = isAbsolute(entry.module) ? entry.module : resolve(baseDir, entry.module);
    modulePaths.set(entry.name, path);
    recorded[entry.name] = path;
  }
  return recorded;
}

/** The absolute module path `name` was declared with, or `undefined` for a package-backed lexicon. */
export function lexiconModulePath(name: string): string | undefined {
  return modulePaths.get(name);
}

/** Forget every recorded path. For tests. */
export function resetLexiconModules(): void {
  modulePaths.clear();
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
