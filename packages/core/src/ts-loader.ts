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
 * both functions do nothing.
 */

import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * loads lazily and installs the `src/*.ts` to `dist/*.js` redirect; from
 * source it does nothing.
 */
export function installCompiledCli(): void {
  if (!runsCompiled() || compiledState()) return;
  (globalThis as { [STATE]?: CompiledCliState })[STATE] = { tsx: false };

  const distDir = dirname(fileURLToPath(import.meta.url));
  const srcUrl = pathToFileURL(join(dirname(distDir), "src") + sep).href;
  const distUrl = pathToFileURL(distDir + sep).href;
  const compiled = new Map<string, string | null>();

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!result.url.startsWith(srcUrl)) return result;
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
 * The source directory for a module of chant's own: `dirname` of `moduleUrl`
 * from source, and the matching directory under `<package>/src` when the
 * module runs from `<package>/dist`. The sandbox drivers hand chant's own
 * modules to esbuild by path, and must name the TypeScript source the
 * project's own `@intentius/chant/*` imports resolve to. String arithmetic
 * only: no filesystem access, so it is safe inside a sandboxed child.
 */
export function chantSourceDir(moduleUrl: string): string {
  const dir = dirname(fileURLToPath(moduleUrl));
  if (!moduleUrl.endsWith(".js")) return dir;
  const marker = `${sep}dist${sep}`;
  const at = (dir + sep).lastIndexOf(marker);
  if (at < 0) return dir;
  return dir.slice(0, at) + `${sep}src` + dir.slice(at + marker.length - 1);
}
