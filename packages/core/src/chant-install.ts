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
 *
 * #4889: {@link runChant} spawns that chant and returns its output and its
 * last `--json` document ({@link lastJsonLine}), and
 * {@link installResolveFallback} and {@link fallbackImportArgs} resolve any
 * bare specifier a file with no `node_modules` above it imports, in the
 * product's process and in chant's children, from the product's install
 * (SQL Yodeler's `resolve-fallback.ts` and `process.ts`, terragucci's
 * `runChant` in `resume.ts`).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NEXT_RELEASE } from "./release-floors";

/** The first chant with `runChant`, `lastJsonLine`, `installResolveFallback` and `fallbackImportArgs` in `@intentius/chant/chant-install` (#4889): a product runs chant and reads its `--json` document, and a file with no `node_modules` above it imports the product's packages, with no code of the product's own. */
export const CHANT_RUN_FLOOR = NEXT_RELEASE;

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

// ── #4889: any bare specifier, for a file with no node_modules above it ────

/** A bare specifier: a package name, not a relative or absolute path, a URL, a `node:` builtin or a `#` import. */
export function isBareSpecifier(specifier: string): boolean {
  return !/^(\.{0,2}\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(specifier) && !specifier.startsWith("#");
}

/** Whether the file at `url` has a `node_modules` directory in its own directory or any above it. A URL that is not a file's counts as having one. */
export function hasNodeModulesAbove(url: unknown): boolean {
  if (typeof url !== "string" || !url.startsWith("file:")) return true;
  for (let dir = dirname(fileURLToPath(url)); ; ) {
    if (existsSync(join(dir, "node_modules"))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * The file URL a bare specifier is retried from: a file beside the
 * `node_modules` directory that holds `from` (by default this module, in
 * the chant the product depends on), so the retry finds the product's own
 * packages first; `from` itself when it is in no `node_modules`, as in a
 * chant checkout. SQL Yodeler's `ownModules`.
 */
export function fallbackParent(from: string = import.meta.url): string {
  const path = from.startsWith("file:") ? fileURLToPath(from) : from;
  const marker = `${sep}node_modules${sep}`;
  const at = path.lastIndexOf(marker);
  if (at < 0) return from.startsWith("file:") ? from : pathToFileURL(from).href;
  return pathToFileURL(join(path.slice(0, at), "chant-resolve-fallback.js")).href;
}

/**
 * A resolve hook (SQL Yodeler's `resolve-fallback.ts`): a bare specifier
 * Node could not find, imported by a file with no `node_modules` in its
 * directory or any above it, resolves from `parent`. chant's commit job
 * runs a product's command in a git worktree outside the checkout the job
 * installed, so a `chant.config.ts` or an Op there imports chant, its
 * lexicons and the product by name and finds none of them. A file that has
 * an install of its own, and any other failure, is left as Node reports it.
 */
export function bareResolveFallback(parent: string) {
  return (specifier: string, context: Record<string, unknown>, next: NextResolve): ResolveResult => {
    try {
      return next(specifier, context);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw err;
      if (!isBareSpecifier(specifier) || context.parentURL === parent || hasNodeModulesAbove(context.parentURL)) throw err;
      return next(specifier, { ...context, parentURL: parent });
    }
  };
}

/**
 * {@link bareResolveFallback} as module source for a child's `--import`,
 * with `PARENT` bound: the same checks, written for Node's synchronous
 * `registerHooks` and, on a Node without it, the asynchronous `register`,
 * whose `next` returns a promise.
 */
function hooksSource(parent: string): string {
  return [
    'import { existsSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `const PARENT = ${JSON.stringify(parent)};`,
    'const bare = (s) => !/^(\\.{0,2}\\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(s) && !s.startsWith("#");',
    "function installed(url) {",
    '  if (typeof url !== "string" || !url.startsWith("file:")) return true;',
    "  for (let d = dirname(fileURLToPath(url)); ; ) {",
    '    if (existsSync(join(d, "node_modules"))) return true;',
    "    const up = dirname(d);",
    "    if (up === d) return false;",
    "    d = up;",
    "  }",
    "}",
    "function retry(specifier, context, next, e) {",
    '  if (!e || (e.code !== "ERR_MODULE_NOT_FOUND" && e.code !== "MODULE_NOT_FOUND") || !bare(specifier) || context.parentURL === PARENT || installed(context.parentURL)) throw e;',
    "  return next(specifier, { ...context, parentURL: PARENT });",
    "}",
    "export function resolve(specifier, context, next) {",
    "  let r;",
    "  try { r = next(specifier, context); } catch (e) { return retry(specifier, context, next, e); }",
    '  return r && typeof r.then === "function" ? r.catch((e) => retry(specifier, context, next, e)) : r;',
    "}",
  ].join("\n");
}

const dataUrl = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;

const BARE_FALLBACK = Symbol.for("chant.bareResolveFallback");

/**
 * Install {@link bareResolveFallback} once in this process, retrying from
 * `parent` (default {@link fallbackParent}). A product's bin calls it before
 * it loads a repository's `chant.config.ts` or Ops. Uses Node's
 * `module.registerHooks` where it has one, else `module.register`. Returns
 * whether it is installed: false on a Node with neither.
 */
export function installResolveFallback(parent: string = fallbackParent()): boolean {
  const flags = globalThis as { [BARE_FALLBACK]?: boolean };
  if (flags[BARE_FALLBACK]) return true;
  const m = nodeModule as unknown as { registerHooks?: RegisterHooks; register?: (url: string) => unknown };
  if (typeof m.registerHooks === "function") m.registerHooks({ resolve: bareResolveFallback(parent) });
  else if (typeof m.register === "function") m.register(dataUrl(hooksSource(parent)));
  else return false;
  flags[BARE_FALLBACK] = true;
  return true;
}

/**
 * The node arguments that install {@link bareResolveFallback} in a chant
 * child (`chant build`, `chant run`), before its own imports of the
 * repository's files: one `--import` of a `data:` module, so it loads the
 * same from a product's `src/` under tsx and from its bundle. Pass them as
 * {@link chantArgv}'s `nodeArgs`, or {@link runChant}'s `resolveFallback`.
 */
export function fallbackImportArgs(parent: string = fallbackParent()): string[] {
  const hooks = dataUrl(hooksSource(parent));
  const registrar = [
    'import * as m from "node:module";',
    `import { resolve } from ${JSON.stringify(hooks)};`,
    `if (typeof m.registerHooks === "function") m.registerHooks({ resolve }); else m.register(${JSON.stringify(hooks)});`,
  ].join("\n");
  return ["--import", dataUrl(registrar)];
}

// ── #4889: running chant and reading its --json document ──────────────────

/** What {@link runChant} returns once the child exits. */
export interface ChantRun {
  /** The exit code; 128 when a signal ended it. */
  code: number;
  stdout: string;
  stderr: string;
  /** {@link lastJsonLine} of `stdout`: the `--json` document, when the command printed one. */
  json?: unknown;
}

export interface RunChantOptions {
  /** The directory chant runs in. Default the current one. */
  cwd?: string;
  /** The environment the child starts from, before {@link chantEnv}. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * A chant executable to run as it is (a product's `--chant` flag): no
   * node in front of it, so `nodeArgs` and `resolveFallback` do not apply.
   */
  chant?: string;
  /** The install to run. Default {@link bundledChant}, else the first of `from` that {@link installedChant} finds, else `chant` on PATH. */
  install?: ChantInstall;
  /** Directories to look for an install from when this module is in none (terragucci looks from the repository). */
  from?: readonly string[];
  /** Node arguments before the bin, such as a product's own `--import`. */
  nodeArgs?: readonly string[];
  /** Install {@link bareResolveFallback} in the child (`true` from {@link fallbackParent}, or a parent URL). */
  resolveFallback?: boolean | string;
  /** `FORCE_COLOR=0` and `NO_COLOR=1`, for output a product reads. */
  noColor?: boolean;
  /** `inherit` writes the child's output to this process's and captures none. Default `pipe`. */
  stdio?: "pipe" | "inherit";
  /** Each chunk as it arrives, for output a person watches. */
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/**
 * Run `chant <args>` and resolve with its exit code, its output and its
 * `--json` document (#4889; SQL Yodeler's `runChant`, terragucci's in
 * `resume.ts`). The chant is the product's own ({@link chantArgv}) with its
 * bin first on PATH ({@link chantEnv}). Never rejects on a non-zero exit;
 * rejects when the child cannot start.
 */
export function runChant(args: readonly string[], options: RunChantOptions = {}): Promise<ChantRun> {
  const install = options.chant === undefined ? (options.install ?? bundledChant() ?? installedChant(options.from ?? [])) : undefined;
  const fallback = options.resolveFallback === true ? fallbackImportArgs() : typeof options.resolveFallback === "string" ? fallbackImportArgs(options.resolveFallback) : [];
  const [command, ...argv] = install ? chantArgv(args, { install, nodeArgs: [...fallback, ...(options.nodeArgs ?? [])] }) : [options.chant ?? "chant", ...args];
  const env = { ...chantEnv(options.env ?? process.env, install), ...(options.noColor ? { FORCE_COLOR: "0", NO_COLOR: "1" } : {}) };
  const piped = options.stdio !== "inherit";
  return new Promise((done, reject) => {
    const child = spawn(command!, argv, { cwd: options.cwd ?? process.cwd(), env, stdio: ["ignore", piped ? "pipe" : "inherit", piped ? "pipe" : "inherit"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const json = lastJsonLine(stdout);
      done({ code: code ?? (signal ? 128 : 1), stdout, stderr, ...(json !== undefined ? { json } : {}) });
    });
  });
}

/**
 * The last line of `stdout` that parses as a JSON object: chant prints its
 * `--json` document as one line, after any log lines. A pretty-printed
 * document is read from the first `{` to the end. Undefined when there is
 * none.
 */
export function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // A log line that starts with "{"; keep looking.
    }
  }
  const at = stdout.indexOf("{");
  if (at >= 0) {
    try {
      return JSON.parse(stdout.slice(at)) as unknown;
    } catch {
      // Not JSON.
    }
  }
  return undefined;
}
