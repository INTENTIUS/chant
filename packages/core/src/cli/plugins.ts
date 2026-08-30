import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { isLexiconPlugin, type LexiconPlugin } from "../lexicon";
import { loadChantConfigUpward } from "../config";
import { findInfraFiles, detectLexicons } from "../index";
import { checkConflicts } from "./conflict-check";

/**
 * Load a single lexicon plugin by lexicon name.
 *
 * Dynamically imports `@intentius/chant-lexicon-{name}` and looks for a
 * LexiconPlugin export. Falls back to wrapping a raw Serializer export.
 */
export async function loadPlugin(lexiconName: string): Promise<LexiconPlugin> {
  const packageName = `@intentius/chant-lexicon-${lexiconName}`;
  const mod = await import(packageName);

  // Look for an explicit LexiconPlugin export
  for (const value of Object.values(mod)) {
    if (isLexiconPlugin(value)) {
      return value;
    }
  }

  // Fallback: wrap a raw Serializer export into a minimal plugin
  const serializer = mod.serializer ?? mod.default?.serializer ?? mod[`${lexiconName}Serializer`];
  if (serializer && typeof serializer === "object" && "name" in serializer && "serialize" in serializer) {
    const notSupported = (op: string) => async () => {
      throw new Error(`${serializer.name}: ${op} is not supported (raw serializer fallback)`);
    };
    return {
      name: serializer.name,
      serializer,
      generate: notSupported("generate"),
      validate: notSupported("validate"),
      coverage: notSupported("coverage"),
      package: notSupported("package"),

    };
  }

  throw new Error(`Package ${packageName} does not export a LexiconPlugin or Serializer`);
}

/**
 * The installed version of each named lexicon package (chant #1442).
 *
 * A `LexiconPlugin` does not carry its own version — `LexiconManifest` does,
 * but that is an artifact type describing generated output, not something the
 * plugin object exposes. The version wanted here is a property of the
 * *installed package*, so it is read from the package's own `package.json`.
 *
 * Resolved by walking up from the package's entry point rather than resolving
 * `<pkg>/package.json` directly: lexicon packages declare an `exports` map
 * that does not include `./package.json`, so the direct specifier is blocked
 * by Node. `./manifest` (→ `dist/manifest.json`) is not used either — it is a
 * `prepack` build artifact, absent in a monorepo dev tree, and its absence
 * once read as four unrelated bugs (#1367).
 *
 * A lexicon whose version cannot be determined is omitted rather than
 * recorded as `"unknown"`: a digest that says nothing is honest, one that
 * says `unknown` compares unequal to itself across builds.
 */
export function resolveLexiconVersions(lexiconNames: readonly string[]): Record<string, string> {
  const require_ = createRequire(import.meta.url);
  const versions: Record<string, string> = {};

  for (const name of lexiconNames) {
    const packageName = `@intentius/chant-lexicon-${name}`;
    try {
      let dir = dirname(require_.resolve(packageName));
      // Bounded walk — a resolved entry point is never deeply nested inside
      // its own package, and an unbounded loop here would climb to `/`.
      for (let depth = 0; depth < 10; depth++) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
          const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: string; version?: string };
          // Only the lexicon's OWN package.json — a nested dependency's
          // manifest would otherwise be read as the lexicon's version.
          if (pkg.name === packageName && pkg.version) {
            versions[name] = pkg.version;
            break;
          }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // Not installed, or not resolvable from here — omit it.
    }
  }

  return versions;
}

/**
 * Bind each loaded plugin's `buildRoots` hook (#1548 piece 3) to this
 * invocation's config and project root, producing the closures
 * `BuildOptions.buildRoots` takes — the same extract-then-thread shape the
 * CLI uses for `intrinsics`. Plugins without the hook contribute nothing;
 * an empty array is the common case and `build()` treats it as absent.
 */
export function collectBuildRootContributors(
  plugins: readonly LexiconPlugin[] | undefined,
  config: Record<string, unknown>,
  projectRoot: string,
): Array<import("../lexicon").BuildRootContributor> {
  return (plugins ?? [])
    .filter((plugin) => typeof plugin.buildRoots === "function")
    // `entities` is not bindable here — discovery has not run — so the merge
    // hands it in when it calls the closure (#1828 / SOPS provenance).
    .map((plugin) => (ctx) => plugin.buildRoots!({ projectRoot, config, entities: ctx?.entities }));
}

/**
 * Load plugins for all detected lexicon names.
 * Calls `init()` on each plugin if present.
 */
export async function loadPlugins(lexiconNames: string[]): Promise<LexiconPlugin[]> {
  const plugins: LexiconPlugin[] = [];
  for (const name of lexiconNames) {
    const plugin = await loadPlugin(name);
    if (plugin.init) {
      await plugin.init();
    }
    plugins.push(plugin);
  }

  // Cross-lexicon conflict detection
  const report = checkConflicts(plugins);

  for (const warning of report.warnings) {
    console.warn(
      `[chant] warning: ${warning.type} "${warning.key}" is provided by multiple lexicons: ${warning.plugins.join(", ")}`,
    );
  }

  if (report.conflicts.length > 0) {
    const details = report.conflicts
      .map((c) => `  ${c.type} "${c.key}" from: ${c.plugins.join(", ")}`)
      .join("\n");
    throw new Error(
      `Cross-lexicon conflicts detected:\n${details}`,
    );
  }

  return plugins;
}

/**
 * Resolve lexicon names for a project directory.
 *
 * Reads `lexicons` from `chant.config.ts` / `chant.config.json` if present.
 * Falls back to source-file detection via `detectLexicons()`.
 *
 * chant #1045 Phase 2 — this used to fall back to a full `discover()` call
 * just to read its `sourceFiles` list, which imports and RUNS every project
 * source file to collect entities that are then discarded here. That ran
 * unconditionally, on every command that reaches this function without an
 * explicit `chant.config.ts` `lexicons` list (`build`, `lint`, `doctor`,
 * `import`, `graph`, the MCP server — effectively the whole CLI), with no
 * `--fold`/`--sandbox` involved at all: a project could omit `lexicons` and
 * every file would execute here, in the CLI's own process, before the
 * caller's OWN (possibly folded, possibly sandboxed) build ever ran. Fixed
 * by using `findInfraFiles()` alone — the pure directory walk `discover()`
 * itself starts from, no import, no execution — since `detectLexicons()` is
 * already a plain text/regex scan over file contents (`../detectLexicon.ts`)
 * that never needed live module exports to begin with. This is strictly
 * better than routing the detection through the sandbox: it removes the
 * execution entirely rather than containing it, at no bundling/spawn cost.
 *
 * chant #1117 — walks up from `projectPath` to the project root
 * (`loadChantConfigUpward`) rather than reading `projectPath` alone: `chant
 * build src/<stack>` calls this with the stack's own subdirectory, and a
 * project that declares `lexicons` only in its root `chant.config.ts` (never
 * detectable by `detectLexicons()`'s import scan alone, e.g. a lexicon that's
 * loaded but never imported by name in that particular stack's files) would
 * otherwise silently miss it.
 */
export async function resolveProjectLexicons(projectPath: string): Promise<string[]> {
  const { config } = await loadChantConfigUpward(projectPath);

  if (config.lexicons && config.lexicons.length > 0) {
    return config.lexicons;
  }

  // Fallback: detect from source imports — a pure text scan, no execution.
  const files = await findInfraFiles(projectPath);
  return detectLexicons(files);
}
