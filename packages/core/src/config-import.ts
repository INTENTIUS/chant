import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let freshLoads = 0;
import { ensureTypeScriptLoader } from "./ts-loader";

/**
 * The single place chant evaluates a project's `chant.config.ts` **in the CLI's
 * own process**.
 *
 * This is the config-side analogue of `./discovery/import.ts`'s `importModule`
 * — one narrow module whose only job is "execute project-authored code here",
 * so that the question "did any project code run in this process?" has one
 * place to look and one place to instrument (see
 * `examples/sandbox-execution-boundary.e2e.test.ts`, which spies on both).
 *
 * Callers must not `import()` a config file directly. `./config-sandbox.ts`
 * decides whether a given load is allowed to come through here at all: under
 * `chant build --sandbox` it routes the evaluation into the sandboxed child
 * instead (chant #1113), and these functions are never reached.
 *
 * `chant.config.json` is pure data and is parsed, not executed — it never goes
 * through this module.
 */

/** The shape a config module evaluates to, before `default`/`config`/namespace selection. */
export type ConfigModuleNamespace = Record<string, unknown>;

/**
 * Import a `chant.config.ts` into THIS process and return its module namespace.
 * Node's ESM registry caches it, so repeated loads within one CLI invocation
 * evaluate the file once — the behavior `loadChantConfig` has always had.
 */
export async function importConfigModule(configPath: string, fresh = false): Promise<ConfigModuleNamespace> {
  // #5263: with no tsx in chant's install or the project's, node's own type stripping (22.18+, 23.6+) may still read the file.
  let noTsx: Error | null = null;
  try {
    ensureTypeScriptLoader(dirname(configPath));
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("chant needs tsx") || !nativeTypeScript()) throw err;
    noTsx = err;
  }
  // `fresh` re-evaluates the config file itself: a query string makes the specifier a new module. Files it imports stay cached.
  const specifier = fresh ? `${pathToFileURL(configPath).href}?fresh=${++freshLoads}` : configPath;
  try {
    return (await import(specifier)) as ConfigModuleNamespace;
  } catch (err) {
    if (noTsx === null) throw err;
    const why = String(err instanceof Error ? err.message : err).split("\n")[0];
    throw Object.assign(new Error(`${noTsx.message} (node's own type stripping could not read ${configPath} either: ${why})`), { cause: err });
  }
}

/** Whether this node strips TypeScript types itself, so an `import()` of a `.ts` file needs no loader. */
function nativeTypeScript(): boolean {
  const ts = (process.features as { typescript?: unknown }).typescript;
  return ts === "strip" || ts === "transform";
}

/**
 * `require()` a `chant.config.ts` into THIS process from `dir`'s resolution
 * context — the synchronous path `./lint/config.ts`'s `loadConfig` has used
 * since before the async loader existed (`chant lint` is a sync pipeline).
 */
export function requireConfigModule(configPath: string, dir: string): ConfigModuleNamespace {
  const req = createRequire(join(dir, "package.json"));
  ensureTypeScriptLoader(dir);
  return req(configPath) as ConfigModuleNamespace;
}
