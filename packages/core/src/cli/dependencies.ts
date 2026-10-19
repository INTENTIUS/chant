/**
 * chant #4116: a failure caused by a project whose dependencies are not installed.
 *
 * In a clone with no node_modules, every project file that imports
 * `@intentius/chant` or a lexicon package fails to load. Lint reports each one
 * (LEX002, COMP000), the graph's lint gate then says the source has lint
 * errors, and build prints node's own "Cannot find package" per file. The
 * source is fine; the install is missing.
 *
 * This runs only after something has already failed, on that failure's
 * messages. A project chant builds today never reaches it, whatever its
 * node_modules looks like: chant resolves a lexicon from its own install first,
 * and a project that imports only what it has installed loads fine. That is why
 * the check is not made up front (#4118, reverted in #4125).
 *
 * A message counts when it is node's "Cannot find package|module '<spec>'",
 * `<spec>` names a package that is `@intentius/*` or declared in the project's
 * package.json, and no node_modules from the project directory up holds it. A
 * typo in an import of an undeclared package keeps its message as it is.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageNameOf } from "../lexicon-module";
import { formatError } from "./format";

/** A package that a failure could not import and that is not installed for the project. */
export interface UninstalledDependency {
  package: string;
  /** The project directory it does not resolve from. */
  dir: string;
}

const NOT_FOUND = /Cannot find (?:package|module) '([^']+)'(?: imported from (\S+))?/g;

/** True when a node_modules at `dir` or above holds `pkg`. */
function installedFrom(pkg: string, dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules", ...pkg.split("/")))) return true;
    if (dirname(d) === d) return false;
  }
}

/** The packages the nearest package.json at `dir` or above declares, in any dependency field. */
function declaredPackages(dir: string): Set<string> {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const file = join(d, "package.json");
    if (existsSync(file)) {
      try {
        const json = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
        const names = new Set<string>();
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const deps = json[field];
          if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
        }
        return names;
      } catch {
        return new Set();
      }
    }
    if (dirname(d) === d) return new Set();
  }
}

function importerDir(importer: string | undefined): string | undefined {
  if (!importer) return undefined;
  try {
    const path = importer.startsWith("file:") ? fileURLToPath(importer) : importer;
    return isAbsolute(path) ? dirname(path) : undefined;
  } catch {
    return undefined;
  }
}

/** The uninstalled package `message` reports, or `undefined` when it reports none. */
export function uninstalledDependencyIn(message: string, projectDir: string): UninstalledDependency | undefined {
  const dir = resolve(projectDir);
  let declared: Set<string> | undefined;
  for (const match of message.matchAll(NOT_FOUND)) {
    const pkg = packageNameOf(match[1]);
    if (pkg === undefined) continue;
    if (!pkg.startsWith("@intentius/")) {
      declared ??= declaredPackages(dir);
      if (!declared.has(pkg)) continue;
    }
    if (installedFrom(pkg, dir)) continue;
    const from = importerDir(match[2]);
    if (from !== undefined && installedFrom(pkg, from)) continue;
    return { package: pkg, dir };
  }
  return undefined;
}

/** The dependencies message, formatted as an error with the install hint. */
export function formatDependenciesNotInstalled(dep: UninstalledDependency): string {
  return formatError({
    message: `dependencies not installed: ${dep.package} does not resolve from ${dep.dir}`,
    hint: "run npm install (or the project's package manager)",
  });
}

/**
 * Print the dependencies message, naming the first uninstalled package, when
 * any of a failure's `messages` reports one. Prints nothing and returns
 * `undefined` when none does. Returns `"all"` when every message reports one,
 * so a caller can drop its own wording when that wording blames the source.
 */
export function reportUninstalledDependencies(
  messages: readonly string[],
  projectDir: string,
): "all" | "some" | undefined {
  let first: UninstalledDependency | undefined;
  let all = messages.length > 0;
  for (const message of messages) {
    const dep = uninstalledDependencyIn(message, projectDir);
    if (dep) first ??= dep;
    else all = false;
  }
  if (!first) return undefined;
  console.error(formatDependenciesNotInstalled(first));
  return all ? "all" : "some";
}
