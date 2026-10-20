/**
 * #3878 — TypeScript loading for the compiled CLI.
 *
 * An installed chant runs `dist/cli/main.js` with plain `node`, so chant's own
 * modules need no loader. Everything else chant imports at run time still can
 * be TypeScript: a project's `chant.config.ts` and source files, `*.op.ts`,
 * policies and lint rules, and the lexicon packages, which ship `src/*.ts`.
 * {@link ensureTypeScriptLoader} registers tsx for those, the first time one of
 * them is about to be imported, so a command that imports none (`--version`,
 * `run wave` on a project with no `chant.config.ts`) never loads tsx at all.
 *
 * {@link installCompiledCli} also points every resolution of chant's own
 * source at the compiled file next to it. A lexicon or project file imports
 * `@intentius/chant`, and the package exports resolve that to `src/*.ts`;
 * without the redirect that import would load a second copy of core,
 * transpiled, beside the one the CLI runs, with its own registries and
 * classes.
 *
 * Run from source (the repository's `bin/chant` through tsx, vitest), this
 * module is itself TypeScript, the TypeScript loader is already there, and
 * both functions do nothing, except that {@link installCompiledCli} resolves
 * chant's packages to their source (#3981, {@link installSourceResolution}).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isJavaScriptModule, moduleSourceDir } from "./module-source";

// `module.registerHooks` (Node 22.15+, 24) is newer than the @types/node the
// repository pins, so its shape is declared here.
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context?: unknown) => ResolveResult;
const { createRequire, registerHooks } = nodeModule as unknown as {
  createRequire: typeof nodeModule.createRequire;
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolveResult }) => unknown;
};

interface CompiledCliState {
  /** Whether tsx has been registered in this process. */
  tsx: boolean;
}

const STATE = Symbol.for("chant.compiledCli");

function compiledState(): CompiledCliState | undefined {
  return (globalThis as { [STATE]?: CompiledCliState })[STATE];
}

/** True when this module runs as compiled JavaScript, from `<package>/dist`. */
function runsCompiled(): boolean {
  return import.meta.url.endsWith(".js");
}

/**
 * Called once by the CLI's `main()`. Compiled, it records that TypeScript
 * loads lazily and installs the `src/*.ts` to `dist/*.js` redirect. From
 * source it installs {@link installSourceResolution}.
 */
export function installCompiledCli(): void {
  if (!runsCompiled()) {
    installSourceResolution();
    return;
  }
  if (compiledState()) return;
  (globalThis as { [STATE]?: CompiledCliState })[STATE] = { tsx: false };

  const distDir = dirname(fileURLToPath(import.meta.url));
  const srcUrl = pathToFileURL(join(dirname(distDir), "src") + sep).href;
  const distUrl = pathToFileURL(distDir + sep).href;
  const compiled = new Map<string, string | null>();

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!result.url.startsWith(srcUrl)) {
        const twin = lexiconCompiledTwin(result.url);
        return twin === undefined ? result : { ...result, url: twin, format: "module" };
      }
      const path = result.url.slice(srcUrl.length).replace(/[?#].*$/, "");
      if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return result;
      let target = compiled.get(path);
      if (target === undefined) {
        const js = distUrl + path.slice(0, -3) + ".js";
        target = existsSync(fileURLToPath(js)) ? js : null;
        compiled.set(path, target);
      }
      return target === null ? result : { ...result, url: target, format: "module" };
    },
  });
}

/** Package directories by the directory a module sits in: a lexicon package's root, or null for any other package. */
const lexiconRoots = new Map<string, string | null>();

/** The lexicon package `dir` belongs to: the nearest directory up with a package.json, when it names a chant lexicon. */
function lexiconRootOf(dir: string): string | undefined {
  const seen: string[] = [];
  let root: string | null = null;
  for (let at = dir; ; ) {
    const cached = lexiconRoots.get(at);
    if (cached !== undefined) {
      root = cached;
      break;
    }
    seen.push(at);
    const manifest = join(at, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, "utf-8")) as { name?: unknown }).name;
        root = typeof name === "string" && name.startsWith("@intentius/chant-lexicon-") ? at : null;
      } catch {
        root = null;
      }
      break;
    }
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  for (const at of seen) lexiconRoots.set(at, root);
  return root ?? undefined;
}

/**
 * #3981 — the compiled module for a lexicon's `src/*.ts`: `<lexicon>/dist/*.js`
 * when it exists, as a URL, else `undefined`. A lexicon ships both, and its
 * exports name the compiled one; fold reads a composite from the source, and
 * an import that source makes must land on the module the plugin and the
 * project already loaded, with no TypeScript loader.
 */
export function lexiconCompiledTwin(url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  const path = fileURLToPath(url.replace(/[?#].*$/, ""));
  if (!/\.[cm]?ts$/.test(path) || /\.d\.[cm]?ts$/.test(path) || !path.includes(`${sep}src${sep}`)) return undefined;
  const root = lexiconRootOf(dirname(path));
  if (root === undefined) return undefined;
  const srcDir = join(root, "src") + sep;
  if (!path.startsWith(srcDir)) return undefined;
  const js = join(root, "dist", path.slice(srcDir.length)).replace(/\.([cm]?)ts$/, ".$1js");
  return existsSync(js) ? pathToFileURL(js).href : undefined;
}

const SOURCE_RESOLUTION = Symbol.for("chant.sourceResolution");

/**
 * #3981 — the `development` target a chant package's `exports` give
 * `specifier`, found from `parentPath`'s directory up through each
 * `node_modules`, or `undefined` when there is none or its file does not
 * exist. Reads exact keys and single-`*` patterns, the shapes chant's
 * packages use; anything else is left to Node.
 */
export function chantPackageSourceTarget(specifier: string, parentPath: string): string | undefined {
  const match = /^(@intentius\/chant(?:-[a-z0-9-]+)?)(\/.*)?$/.exec(specifier);
  if (!match) return undefined;
  const subpath = match[2] ? `.${match[2]}` : ".";
  let dir = dirname(parentPath);
  for (;;) {
    const pkgDir = join(dir, "node_modules", match[1]!);
    const manifest = join(pkgDir, "package.json");
    if (existsSync(manifest)) {
      let exportsField: unknown;
      try {
        exportsField = (JSON.parse(readFileSync(manifest, "utf-8")) as { exports?: unknown }).exports;
      } catch {
        return undefined;
      }
      if (!exportsField || typeof exportsField !== "object") return undefined;
      const map = exportsField as Record<string, unknown>;
      let entry: unknown = map[subpath];
      let star: string | undefined;
      if (entry === undefined) {
        let best = "";
        for (const key of Object.keys(map)) {
          const at = key.indexOf("*");
          if (at < 0 || key.indexOf("*", at + 1) >= 0) continue;
          const prefix = key.slice(0, at);
          const suffix = key.slice(at + 1);
          if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length || prefix.length <= best.length) continue;
          best = prefix;
          entry = map[key];
          star = subpath.slice(prefix.length, subpath.length - suffix.length);
        }
      }
      const development = entry && typeof entry === "object" ? (entry as { development?: unknown }).development : undefined;
      if (typeof development !== "string") return undefined;
      const target = join(pkgDir, star === undefined ? development : development.split("*").join(star));
      // Node keys a module by its real path, so a symlinked package must too.
      return existsSync(target) ? realpathSync(target) : undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * #3981 — from source, resolve chant's own packages through their
 * `development` export condition, as `node --conditions=development` (which
 * the repository's `bin/chant` passes) would. A lexicon's `default` export is
 * its compiled `dist/*.js`, which a checkout may not have built, or built from
 * older source; `development` is its `src/*.ts`, which vitest, a project's
 * tsconfig `paths` and fold's own resolution (`SOURCE_EXPORT_CONDITIONS`)
 * pick. Without this, a CLI run from source by `node --import tsx` would load
 * a plugin from `dist/` and fold the project against `src/`: two copies of the
 * lexicon with their own classes.
 *
 * The hook resolves the specifier itself and short-circuits: conditions added
 * to the context here do not reach tsx's resolver. Nothing is installed under
 * vitest, whose resolver already adds the condition, or on a node without
 * `module.registerHooks`.
 */
function installSourceResolution(): void {
  // In a vitest worker (not a CLI it spawns, which inherits its environment), vite resolves.
  if ("__vitest_worker__" in globalThis || typeof registerHooks !== "function") return;
  const flags = globalThis as { [SOURCE_RESOLUTION]?: boolean };
  if (flags[SOURCE_RESOLUTION]) return;
  flags[SOURCE_RESOLUTION] = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentURL = (context as { parentURL?: string } | undefined)?.parentURL;
      if (specifier.startsWith("@intentius/chant") && parentURL?.startsWith("file:")) {
        const target = chantPackageSourceTarget(specifier, fileURLToPath(parentURL));
        if (target !== undefined) return { url: pathToFileURL(target).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * Register tsx for the ESM and CommonJS loaders, once, before importing
 * anything that may be TypeScript. A no-op from source, where tsx (or vitest)
 * is already loading chant itself. Returns whether the compiled CLI's tsx
 * registration covers this process, so a caller that registers its own
 * CommonJS hook from source knows not to add a second one.
 */
export function ensureTypeScriptLoader(): boolean {
  const state = compiledState();
  if (!state) return false;
  if (state.tsx) return true;
  state.tsx = true;
  const require = createRequire(import.meta.url);
  (require("tsx/cjs/api") as { register: () => unknown }).register();
  (require("tsx/esm/api") as { register: () => unknown }).register();
  return true;
}

/**
 * #3981 — register tsx only when the module about to be imported is not
 * JavaScript. `pathOrUrl` is the resolved module, a path or a file URL. A
 * compiled lexicon (`dist/*.js`) imports with plain node, so a command that
 * loads only compiled modules never pays for tsx's hooks thread. A `.ts`
 * module, or one with no extension, registers tsx as before. Returns what
 * {@link ensureTypeScriptLoader} does, or whether tsx is already registered
 * when the module is JavaScript.
 */
export function ensureTypeScriptLoaderFor(pathOrUrl: string): boolean {
  if (!isJavaScriptModule(pathOrUrl)) return ensureTypeScriptLoader();
  return compiledState()?.tsx ?? false;
}

/**
 * #3981 — whether a caller about to import a module of unknown kind should
 * resolve it first: true only in the compiled CLI before tsx is registered.
 * From source, and once tsx is in, every module loads either way.
 */
export function typeScriptLoaderPending(): boolean {
  const state = compiledState();
  return state !== undefined && !state.tsx;
}

/**
 * The source directory for a module of chant's own: `dirname` of `moduleUrl`
 * from source, and the matching directory under `<package>/src` when the
 * module runs from `<package>/dist`. The sandbox drivers hand chant's own
 * modules to esbuild by path, and must name the TypeScript source the
 * project's own `@intentius/chant/*` imports resolve to. String arithmetic
 * only: no filesystem access, so it is safe inside a sandboxed child. The
 * same mapping as {@link moduleSourceDir}, which lexicons use.
 */
export function chantSourceDir(moduleUrl: string): string {
  return moduleSourceDir(moduleUrl);
}
