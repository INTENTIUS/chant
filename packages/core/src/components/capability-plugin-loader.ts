/**
 * Discovery + loading for capability plugins — the capability-side analogue
 * of ../cli/plugins.ts's `loadPlugin`/`loadPlugins` for lexicons.
 *
 * Naming convention mirrors lexicons exactly, substituting "capability" for
 * "lexicon": a capability plugin package is
 * `@intentius/chant-capability-<name>` and is expected to export a value
 * satisfying `CapabilityPlugin` (./capability-plugin.ts), detected at
 * runtime with `isCapabilityPlugin` — the same dynamic-import + shape-guard
 * strategy `loadPlugin` uses for `@intentius/chant-lexicon-<name>`.
 *
 * `buildCapabilityRegistry` is the Phase 2 replacement for Phase 1's
 * `createCapabilityRegistry` (./registry.ts): it always loads the built-in
 * `starterCapabilityPlugin` (./starter-plugin.ts) first — preserving every
 * Phase 1 kind with zero behavior change — then loads any additional
 * requested plugin packages on top, registering every capability they
 * contribute into one `CapabilityRegistry` the driver resolves verbs
 * through. Duplicate `kind` registration across plugins throws (via
 * `CapabilityRegistry.register`'s existing guard), the same hard-conflict
 * discipline `checkConflicts` (../cli/conflict-check.ts) applies to
 * duplicate lexicon rule IDs.
 */

import { CapabilityRegistry } from "./capability";
import type { CapabilityPlugin } from "./capability-plugin";
import { isCapabilityPlugin } from "./capability-plugin";
import { starterCapabilityPlugin } from "./starter-plugin";

/** Thrown when a dynamically-imported capability package does not satisfy `CapabilityPlugin` — the "malformed capability package" case #559 asks doctor/validation to detect. */
export class MalformedCapabilityPluginError extends Error {
  constructor(
    public readonly packageName: string,
    reason: string,
  ) {
    super(`capability plugin package "${packageName}" is malformed: ${reason}`);
    this.name = "MalformedCapabilityPluginError";
  }
}

/** Thrown when two loaded capability plugins register the same `kind` — mirrors the lexicon loader's hard rule-ID conflict. */
export class DuplicateCapabilityKindError extends Error {
  constructor(
    public readonly kind: string,
    public readonly plugins: string[],
  ) {
    super(`capability "${kind}" is registered by more than one plugin: ${plugins.join(", ")}`);
    this.name = "DuplicateCapabilityKindError";
  }
}

/**
 * Dynamically import and validate a single capability plugin package by
 * name. Mirrors ../cli/plugins.ts's `loadPlugin` for lexicons: imports
 * `@intentius/chant-capability-{name}`, scans its exports for a value
 * satisfying `isCapabilityPlugin`, and throws a descriptive
 * `MalformedCapabilityPluginError` if the package exists but exports nothing
 * usable (the malformed-package case), or the original import error if the
 * package cannot be found at all.
 */
export async function loadCapabilityPlugin(name: string): Promise<CapabilityPlugin> {
  const packageName = `@intentius/chant-capability-${name}`;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(packageName)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `capability plugin package "${packageName}" could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const value of Object.values(mod)) {
    if (isCapabilityPlugin(value)) {
      return value;
    }
  }

  throw new MalformedCapabilityPluginError(
    packageName,
    `does not export a CapabilityPlugin (expected an export with string "name", string "version", and a "capabilities" function)`,
  );
}

/**
 * Load and initialize multiple named capability plugins, in order. Calls
 * `init()` on each plugin if present — mirrors `loadPlugins`'s lexicon
 * `init()` hook.
 */
export async function loadCapabilityPlugins(names: string[]): Promise<CapabilityPlugin[]> {
  const plugins: CapabilityPlugin[] = [];
  for (const name of names) {
    const plugin = await loadCapabilityPlugin(name);
    if (plugin.init) {
      await plugin.init();
    }
    plugins.push(plugin);
  }
  return plugins;
}

/**
 * Register every capability every plugin contributes into one registry, in
 * plugin order. Throws `DuplicateCapabilityKindError` if two plugins
 * register the same `kind` (via a pre-check, so the error names every
 * offending plugin rather than surfacing only the second registration
 * attempt's generic `CapabilityRegistry.register` message).
 */
export function registerCapabilityPlugins(
  registry: CapabilityRegistry,
  plugins: CapabilityPlugin[],
): CapabilityRegistry {
  const owners = new Map<string, string[]>();
  for (const plugin of plugins) {
    for (const capability of plugin.capabilities()) {
      const existing = owners.get(capability.kind) ?? [];
      existing.push(plugin.name);
      owners.set(capability.kind, existing);
    }
  }
  for (const [kind, pluginNames] of owners) {
    if (pluginNames.length > 1) {
      throw new DuplicateCapabilityKindError(kind, pluginNames);
    }
  }

  for (const plugin of plugins) {
    for (const capability of plugin.capabilities()) {
      registry.register(capability);
    }
  }
  return registry;
}

export interface BuildCapabilityRegistryOptions {
  /**
   * Additional capability plugin package names to load and register on top
   * of the built-in starter plugin (e.g. third-party/cloud-specific
   * capability packages). Defaults to none — Phase 1 behavior (just the
   * starter set) is preserved when omitted.
   */
  plugins?: string[];
  /**
   * Skip loading the built-in starter plugin. Only meaningful for tests that
   * want a registry seeded purely from explicit `plugins`; real callers
   * should leave this unset so the Phase 1 verb set is always present.
   */
  includeStarter?: boolean;
}

/**
 * Build a `CapabilityRegistry` through the Phase 2 plugin contract: always
 * registers the built-in `starterCapabilityPlugin` first (preserving every
 * Phase 1 `kind` — see ./starter-plugin.ts), then loads and registers any
 * additional named plugin packages. This is the Phase 2 entry point;
 * `createCapabilityRegistry` (./registry.ts) remains available and now
 * delegates to this same starter plugin, so existing Phase 1 callers (and
 * the pilots) are unaffected.
 */
export async function buildCapabilityRegistry(
  options: BuildCapabilityRegistryOptions = {},
): Promise<CapabilityRegistry> {
  const registry = new CapabilityRegistry();
  const plugins: CapabilityPlugin[] = [];
  if (options.includeStarter !== false) {
    plugins.push(starterCapabilityPlugin);
  }
  plugins.push(...(await loadCapabilityPlugins(options.plugins ?? [])));
  return registerCapabilityPlugins(registry, plugins);
}
