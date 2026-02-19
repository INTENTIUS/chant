import { isLexiconPlugin, type LexiconPlugin } from "../lexicon";
import { loadChantConfig } from "../config";
import { discover, detectLexicons } from "../index";
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
      rollback: notSupported("rollback"),
    };
  }

  throw new Error(`Package ${packageName} does not export a LexiconPlugin or Serializer`);
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
 */
export async function resolveProjectLexicons(projectPath: string): Promise<string[]> {
  const { config } = await loadChantConfig(projectPath);

  if (config.lexicons && config.lexicons.length > 0) {
    return config.lexicons;
  }

  // Fallback: detect from source imports
  const discoveryResult = await discover(projectPath);
  return detectLexicons(discoveryResult.sourceFiles);
}
