/**
 * Loading a lexicon's plugin so completeness checks can look at what it
 * actually registers (#1342).
 *
 * `check-lexicon`'s checks were almost all existence assertions over the
 * directory: `src/lsp/completions.ts exists`, `At least 1 lint rule in
 * src/lint/rules/`. A file with the right name is not the contract — the
 * contract is the member the plugin exposes, because that is what core
 * dispatches through. helm is the proof: it ships `src/lsp/completions.ts` and
 * `src/lsp/hover.ts`, both with passing tests, exports `helmCompletions` and
 * `helmHover` from its index, and never sets `completionProvider` or
 * `hoverProvider` on the plugin. `cli/lsp/server.ts` dispatches through exactly
 * those fields, so helm's LSP support is unreachable in an editor — while tier 1
 * (the files) and tier 2 (the tests) both passed.
 *
 * Resolution is directory-local rather than by package name: `chant dev
 * check-lexicon <dir>` should work on a lexicon that is not installed, and
 * `loadPlugin` in ../plugins.ts imports `@intentius/chant-lexicon-<name>`,
 * which requires it to be.
 */

import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { pathToFileURL } from "url";
import { isLexiconPlugin, type LexiconPlugin } from "../../lexicon";

export interface LoadedLexicon {
  /** The plugin, when the package exported one. */
  plugin?: LexiconPlugin;
  /** Why loading failed, for a check's `detail`. */
  error?: string;
  /** The entry point that was imported, for diagnostics. */
  entry?: string;
}

/**
 * The module a lexicon package presents to consumers.
 *
 * Tier 1 requires `exports["."].default` to be `./src/index.ts`, so that is the
 * first choice — it is the module core itself imports. The fallbacks keep this
 * usable on a lexicon that has not reached that check yet.
 */
export function pluginEntryFor(dir: string): string | undefined {
  const candidates: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
      exports?: { "."?: { default?: string } };
      main?: string;
    };
    for (const declared of [pkg.exports?.["."]?.default, pkg.main]) {
      if (typeof declared === "string") candidates.push(declared);
    }
  } catch {
    // no package.json, or unreadable — fall through to the conventional paths
  }
  candidates.push("./src/index.ts", "./src/plugin.ts");

  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : resolve(dir, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Import a lexicon directory and return the `LexiconPlugin` it exports.
 *
 * Never throws: a lexicon that cannot be loaded is a finding, not a crash, and
 * every caller reports it as a failed check rather than aborting the run.
 */
export async function loadLexiconFromDir(dir: string): Promise<LoadedLexicon> {
  const entry = pluginEntryFor(dir);
  if (!entry) {
    return { error: "no importable entry point (looked for package.json exports, src/index.ts, src/plugin.ts)" };
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  } catch (error) {
    return { entry, error: `import failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  for (const value of Object.values(mod)) {
    if (isLexiconPlugin(value)) return { plugin: value, entry };
  }
  // A default export whose own members are the plugin (some lexicons re-export
  // a namespace rather than the object itself).
  const fallback = (mod.default ?? {}) as Record<string, unknown>;
  for (const value of Object.values(fallback)) {
    if (isLexiconPlugin(value)) return { plugin: value, entry };
  }

  return { entry, error: "the module exports no LexiconPlugin" };
}

/** Whether the plugin exposes a callable member under `name`. */
export function registers(plugin: LexiconPlugin | undefined, name: keyof LexiconPlugin): boolean {
  return typeof plugin?.[name] === "function";
}

/**
 * Call a plugin member that returns a list, treating a throw as an empty list.
 *
 * A member that throws is not a registration — it is worse than an absent one,
 * and the check that counts its results should fail rather than the whole run.
 */
export function safeList<T>(fn: (() => T[]) | undefined): { items: T[]; error?: string } {
  if (typeof fn !== "function") return { items: [] };
  try {
    return { items: fn() ?? [] };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : String(error) };
  }
}
