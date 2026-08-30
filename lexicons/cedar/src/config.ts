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
 * Where `generate()` writes when `cedar.outDir` is unset and the project is a
 * consumer of the published package (#1696).
 *
 * Relative to the project root. Inside this lexicon's own checkout the
 * package directory *is* the project root, and the output stays at
 * `src/generated/` so `src/index.ts` can re-export it; see
 * `resolveGeneratedDir` in `codegen/generate.ts`.
 */
export const CEDAR_DEFAULT_OUT_DIR = "src/generated/cedar";

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
   * Directory `generate()` writes the typed classes into, relative to the
   * project root. Defaults to {@link CEDAR_DEFAULT_OUT_DIR}.
   *
   * The output used to land in the installed package's own `src/generated/`,
   * which `npm ci` wipes (#1696). It is the project's artifact — the classes
   * describe the project's schema, not the package's — so it lives in the
   * project tree, and `src/policies.ts` imports from it rather than from
   * `@intentius/chant-lexicon-cedar`. Commit it or regenerate it in CI; either
   * way it is never under `node_modules`.
   */
  outDir: z.string().optional(),

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

  /**
   * The dogwood dialect's CLI-gated leg (#1659).
   *
   * `strictObject` again, for the reason the outer one is: a typo here is the
   * difference between "full .dw validation ran" and "DWDE010 said it could
   * not run", and the second is easy to skim past.
   */
  dogwood: z
    .strictObject({
      /**
       * Path to the `dogwood` binary, absolute or relative to the config file.
       *
       * Optional, and its absence is not an error: DWDE010 warns-and-skips
       * with an issue-linked advisory when no binary is found, which is the
       * epic's explicit exception. Set this when the binary is built somewhere
       * `PATH` does not reach — the on-demand harness shape the epic borrows
       * from forgejo-runtime-e2e.
       *
       * A `chant.config.ts` cannot be read from inside a post-synth check —
       * `check()` is synchronous and evaluating project code is not — so this
       * key is honoured from `chant.config.json` and the `CHANT_DOGWOOD_BINARY`
       * environment variable covers the TypeScript-config case. See
       * `src/dogwood/cli.ts`.
       */
      binary: z.string().optional(),
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
 * Searches upward from `startDir`, so `chant cedar generate` finds the config from a
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
  return (await loadCedarProject(startDir)).config;
}

/** A project as cedar's commands see it: the root paths resolve against, and the namespace. */
export interface CedarProject {
  /** The directory holding `chant.config.*`, or `startDir` when there is none. */
  projectRoot: string;
  config: CedarConfig;
}

/**
 * {@link loadCedarConfig}, plus the directory the config was found in.
 *
 * `cedar.schema` and `cedar.outDir` are relative to the config file, not to
 * wherever the command was run (#1696) — `chant cedar generate` from a subdirectory
 * has to write to the same place as the same command from the root.
 */
export async function loadCedarProject(startDir: string): Promise<CedarProject> {
  const { loadChantConfigUpward } = await import("@intentius/chant/config");
  const { dirname } = await import("path");
  try {
    const { config, configPath } = await loadChantConfigUpward(startDir);
    const parsed = cedarConfigSchema.safeParse(config.cedar ?? {});
    return {
      projectRoot: configPath ? dirname(configPath) : startDir,
      config: parsed.success ? parsed.data : {},
    };
  } catch {
    // A project whose config does not load is not this function's problem to
    // report — every other command reports it first, and generation falling
    // back to the bundled schema is the same behaviour as having no config.
    return { projectRoot: startDir, config: {} };
  }
}
