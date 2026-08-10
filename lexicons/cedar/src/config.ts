/**
 * The `cedar` namespace in `chant.config.ts` (#1344, #1650).
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-cedar";   // brings the `cedar` key into ChantConfig
 *
 * export default {
 *   lexicons: ["cedar"],
 *   cedar: {
 *     schema: "authz/app.cedarschema",
 *     validation: { mode: "strict", warnings: "warn" },
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * Cedar is the one lexicon whose codegen input is the *project's* file rather
 * than a global upstream (epic #1645), so this namespace is not a convenience —
 * it is where `generate()` is told what to read. A typo in the path is the
 * difference between "your entity types" and "the bundled default schema",
 * which is exactly the kind of silent fallback `z.strictObject` exists to stop
 * one level down.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";

/**
 * Where `generate()` looks when `cedar.schema` is unset.
 *
 * Relative to the project root (the directory holding `chant.config.ts`).
 */
export const CEDAR_DEFAULT_SCHEMA_PATH = "schema.cedarschema";

/**
 * `strictObject`, not `object`. Core applies `.strict()` to the top level of a
 * declared namespace itself; `validation` is nested, and is the lexicon's own
 * to close.
 */
export const cedarConfigSchema = z.strictObject({
  /**
   * Path to the project's human-readable Cedar schema, relative to the project
   * root. Defaults to {@link CEDAR_DEFAULT_SCHEMA_PATH}; when neither the
   * configured path nor the default exists, generation falls back to the
   * schema bundled at `src/spec/default-schema.cedarschema` so a fresh
   * checkout still produces artifacts.
   */
  schema: z.string().optional(),

  /**
   * Knobs for the `cedar-wasm` validator. `mode` is a single-variant enum on
   * purpose: `ValidationMode` in cedar-wasm 4.12.0 accepts `"strict"` and
   * nothing else, and passing anything further throws (#1648 §5.7).
   */
  validation: z
    .strictObject({
      /** Validator mode. Only `"strict"` exists in this build of cedar-wasm. */
      mode: z.literal("strict").optional(),
      /**
       * What to do with `validationWarnings` — the validator reports things
       * like "policy is impossible" here, separately from errors.
       */
      warnings: z.enum(["ignore", "warn", "error"]).optional(),
      /**
       * Refuse to build when no project schema is found rather than falling
       * back to the bundled default. Off by default so `chant init` works;
       * worth turning on once a project has its own schema, because
       * `checkParseSchema("")` succeeds and an empty schema validates
       * everything clean (#1648 §1).
       */
      requireProjectSchema: z.boolean().optional(),
    })
    .optional(),
});

export type CedarConfig = z.infer<typeof cedarConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    cedar?: CedarConfig;
  }
}

/**
 * Compile-time proof that the augmentation above reaches `ChantConfig` (#1344).
 *
 * Without it this line is `Property 'cedar' does not exist on type
 * 'ChantConfig'`. It lives here rather than in a test because the root tsconfig
 * excludes test files, so a compile-time claim asserted in one is checked by
 * nothing.
 */
export type CedarConfigNamespace = NonNullable<ChantConfig["cedar"]>;

/**
 * Read the `cedar` namespace out of the project's config.
 *
 * Searches upward from `startDir`, so `chant generate` finds the config from a
 * subdirectory the same way `chant build` does. A project with no config, or
 * one with no `cedar` key, gets `{}` — the schema resolution order in
 * `spec/fetch.ts` handles that case without needing to know why.
 *
 * Core has already validated the namespace against {@link cedarConfigSchema}
 * by the time this reads it, so the parse here is a type narrowing rather than
 * a second gate; it stays because a caller can point this at a directory core
 * never loaded.
 */
export async function loadCedarConfig(startDir: string): Promise<CedarConfig> {
  const { loadChantConfigUpward } = await import("@intentius/chant/config");
  try {
    const { config } = await loadChantConfigUpward(startDir);
    const parsed = cedarConfigSchema.safeParse(config.cedar ?? {});
    return parsed.success ? parsed.data : {};
  } catch {
    // A project whose config does not load is not this function's problem to
    // report — every other command reports it first, and generation falling
    // back to the bundled schema is the same behaviour as having no config.
    return {};
  }
}
