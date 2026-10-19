/**
 * chant #4116: a project whose dependencies are not installed.
 *
 * Linting a project with no node_modules fails on every `import` of
 * `@intentius/chant` and of the lexicon packages, and the gates built on lint
 * (graph, build) then say the source has lint errors. The source is fine; the
 * install is missing. This check runs before any of them and names the first
 * package that does not resolve.
 *
 * Resolution is the one lexicon loading falls back to (`resolveFromProject`,
 * node resolution from the project directory), so a package found in a parent
 * node_modules or a workspace root counts as installed.
 */
import { resolve } from "node:path";
import { resolveFromProject, lexiconModulePath } from "../lexicon-module";
import { resolveProjectLexicons } from "./plugins";
import { isNoLexiconDetected } from "../detectLexicon";
import { formatError } from "./format";

/** The first package the project cannot resolve, or `undefined` when all resolve. */
export async function findMissingDependency(path: string): Promise<{ package: string; dir: string } | undefined> {
  const dir = resolve(path);
  const core = resolveFromProject("@intentius/chant", dir) === undefined ? { package: "@intentius/chant", dir } : undefined;

  let names: string[];
  try {
    names = (await resolveProjectLexicons(dir)) ?? [];
  } catch (err) {
    // A config that imports a package that is not there fails to load: the install is what is missing.
    // A project that names no lexicon is the caller's "no lexicon detected" to report.
    return isNoLexiconDetected(err) ? undefined : core;
  }
  // Core first: the config and every source file import it.
  if (core) return core;
  for (const name of names) {
    if (lexiconModulePath(name) !== undefined) continue; // declared by path, nothing to install
    const pkg = `@intentius/chant-lexicon-${name}`;
    if (resolveFromProject(pkg, dir) === undefined) return { package: pkg, dir };
  }
  return undefined;
}

/** Print the dependencies message and return 1 when a package is missing; `undefined` otherwise. */
export async function dependenciesNotInstalled(path: string): Promise<1 | undefined> {
  const missing = await findMissingDependency(path);
  if (!missing) return undefined;
  console.error(
    formatError({
      message: `dependencies not installed: ${missing.package} does not resolve from ${missing.dir}`,
      hint: "run npm install (or the project's package manager)",
    }),
  );
  return 1;
}
