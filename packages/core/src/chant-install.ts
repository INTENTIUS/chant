/**
 * #4800 — the chant a product is installed with, and how to run it.
 *
 * A product runs the `chant` CLI as a child for the commands it does not run
 * in process, and the chant it runs must be the one in its own dependencies,
 * not whatever `chant` is first on the PATH. Each product found it its own
 * way: SQL Yodeler resolved `@intentius/chant` and ran `src/cli/main.ts`
 * under its own tsx, terragucci walked up its directories for
 * `node_modules/@intentius/chant/package.json` and read `bin.chant`, and
 * plywood added a resolve hook so the Op files a repository holds find
 * chant in plywood's install when the repository has none. This module is
 * the one copy.
 *
 * {@link bundledChant} is the package this module belongs to, so a product
 * that imports `@intentius/chant/chant-install` gets its own chant. When a
 * product bundles this module into a file of its own, the module no longer
 * sits in chant's package, and it walks up from where it is instead.
 * {@link chantArgv} runs the package's `bin/chant` with the node running
 * now: the bin picks the compiled CLI in an installed package and the source
 * in a checkout (#3878), so a product never chooses between them.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where a chant package is installed. */
export interface ChantInstall {
  /** The `@intentius/chant` package directory. */
  root: string;
  /** Its `chant` bin script, from the manifest's `bin.chant`. */
  bin: string;
  /** The directory holding the bin, to put first on a child's PATH. */
  binDir: string;
  /** The package's version, from its manifest. */
  version?: string;
}

const PACKAGE = "@intentius/chant";

/** The install whose manifest is `<root>/package.json`, when it is chant's and names a bin that is there. */
function installAt(root: string): ChantInstall | undefined {
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const m = JSON.parse(readFileSync(manifest, "utf-8")) as { name?: unknown; version?: unknown; bin?: unknown };
    if (m.name !== PACKAGE) return undefined;
    const rel = typeof m.bin === "string" ? m.bin : m.bin && typeof m.bin === "object" ? (m.bin as Record<string, unknown>).chant : undefined;
    if (typeof rel !== "string") return undefined;
    const bin = resolve(root, rel);
    if (!existsSync(bin)) return undefined;
    return { root, bin, binDir: dirname(bin), ...(typeof m.version === "string" ? { version: m.version } : {}) };
  } catch {
    // An unreadable manifest is not an install.
    return undefined;
  }
}

/**
 * The chant installed for the first of `from` that has one: each directory
 * and every directory above it, through `node_modules/@intentius/chant`
 * (terragucci's `installedChant`, which looked from its own file and then
 * from the repository). The package exports no `./package.json`, so the
 * manifest is read from disk, not resolved. Undefined when none has it.
 */
export function installedChant(from: readonly string[]): ChantInstall | undefined {
  for (const start of from) {
    for (let dir = resolve(start); ; ) {
      const found = installAt(join(dir, "node_modules", "@intentius", "chant"));
      if (found) return found;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return undefined;
}

let bundled: ChantInstall | null | undefined;

/**
 * The chant this module is part of: `src/chant-install.ts` or
 * `dist/chant-install.js`, one level under the package root. Bundled into a
 * product's own file, the module is not in chant's package, and this is the
 * chant {@link installedChant} finds from the module's directory. Undefined
 * when neither has one.
 */
export function bundledChant(): ChantInstall | undefined {
  if (bundled === undefined) {
    const here = dirname(fileURLToPath(import.meta.url));
    bundled = installAt(dirname(here)) ?? installedChant([here]) ?? null;
  }
  return bundled ?? undefined;
}

/**
 * The chant executable a product runs: `chant` when the caller names one
 * (a `--chant` flag), else {@link bundledChant}'s bin, else the first of
 * `from` {@link installedChant} finds, else `chant` on the PATH.
 */
export function chantCommand(options: { chant?: string; from?: readonly string[] } = {}): string {
  return options.chant ?? bundledChant()?.bin ?? installedChant(options.from ?? [])?.bin ?? "chant";
}

/**
 * The argv to spawn `chant <args>` with: the node running now, `nodeArgs`
 * (a product's own `--import` hooks), the install's bin and `args`. Running
 * the bin through `process.execPath` works where a shebang does not
 * (Windows, #4734). Throws when no install is found.
 */
export function chantArgv(args: readonly string[], options: { install?: ChantInstall; nodeArgs?: readonly string[] } = {}): string[] {
  const install = options.install ?? bundledChant();
  if (!install) throw new Error(`${PACKAGE} is not installed beside this module; install it, or name the chant to run`);
  return [process.execPath, ...(options.nodeArgs ?? []), install.bin, ...args];
}

/**
 * `base` with the install's bin directory first on PATH, for a chant child:
 * chant's own Op activities run `chant` themselves (`lifecycleDiff` runs
 * `chant lifecycle diff`), and they must find the same one.
 */
export function chantEnv(base: NodeJS.ProcessEnv = process.env, install: ChantInstall | undefined = bundledChant()): NodeJS.ProcessEnv {
  if (!install) return { ...base };
  return { ...base, PATH: [install.binDir, base.PATH ?? ""].filter(Boolean).join(delimiter) };
}

/** The specifiers {@link chantResolveFallback} covers: chant and its lexicons, with any subpath. */
export const CHANT_SPECIFIER = /^@intentius\/chant(?:-lexicon-[a-z0-9-]+)?(?:\/|$)/;

// `module.registerHooks` (Node 22.15 and later) is newer than the
// @types/node the repository pins, so its shape is declared here.
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context?: Record<string, unknown>) => ResolveResult;
type RegisterHooks = (hooks: { resolve: (specifier: string, context: Record<string, unknown>, next: NextResolve) => ResolveResult }) => unknown;

/**
 * A resolve hook (plywood's `chantResolveHook`): a chant or lexicon import
 * the importing file's own `node_modules` cannot satisfy resolves from
 * `from`, a file URL in the product's install. A repository that runs the
 * product from a global install has no chant of its own, and the Op files
 * it holds import `@intentius/chant/op`. Any other specifier, and any other
 * failure, is left as Node reports it.
 */
export function chantResolveFallback(from: string) {
  return (specifier: string, context: Record<string, unknown>, next: NextResolve): ResolveResult => {
    try {
      return next(specifier, context);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (!CHANT_SPECIFIER.test(specifier) || (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND")) throw err;
      if (context.parentURL === from) throw err;
      return next(specifier, { ...context, parentURL: from });
    }
  };
}

const FALLBACK = Symbol.for("chant.resolveFallback");

/**
 * Install {@link chantResolveFallback} once in this process. `from` is a
 * file URL in the product's install, by default this module's own, which
 * sits in the chant the product depends on. Returns whether it is
 * installed: false on a Node without `module.registerHooks`, where the
 * repository needs chant in its own `node_modules`.
 */
export function installChantResolveFallback(from: string = import.meta.url): boolean {
  const flags = globalThis as { [FALLBACK]?: boolean };
  if (flags[FALLBACK]) return true;
  const register = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (typeof register !== "function") return false;
  register({ resolve: chantResolveFallback(from) });
  flags[FALLBACK] = true;
  return true;
}
