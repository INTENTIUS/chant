import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The single place chant evaluates a project's `chant.config.ts` **in the CLI's
 * own process**.
 *
 * This is the config-side analogue of `./discovery/import.ts`'s `importModule`
 * — one narrow module whose only job is "execute project-authored code here",
 * so that the question "did any project code run in this process?" has one
 * place to look and one place to instrument (see
 * `examples/sandbox-execution-boundary.test.ts`, which spies on both).
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
export async function importConfigModule(configPath: string): Promise<ConfigModuleNamespace> {
  return (await import(configPath)) as ConfigModuleNamespace;
}

/**
 * `require()` a `chant.config.ts` into THIS process from `dir`'s resolution
 * context — the synchronous path `./lint/config.ts`'s `loadConfig` has used
 * since before the async loader existed (`chant lint` is a sync pipeline).
 */
export function requireConfigModule(configPath: string, dir: string): ConfigModuleNamespace {
  const req = createRequire(join(dir, "package.json"));
  return req(configPath) as ConfigModuleNamespace;
}
