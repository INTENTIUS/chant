/**
 * The one place chant assembles `build()`'s options for a project directory.
 *
 * chant #2002 — `chant build` (./commands/build.ts) and the `policyGate` Op
 * step (../lint/policy.ts's `evaluateProjectPolicies`) both build the same
 * directory, and each used to assemble that option object itself. The two lists
 * drifted to nine options against two: the gate built with fold off (the path
 * `chant build` retired as its default in #1134), without the project's config
 * (so serializers lost their lexicon-scoped dialect settings and a policy
 * reading `ctx.docs` inspected different documents), and without `buildRoots`
 * (so config-declared roots contributed no entities at all). A gate can only
 * decide on a build `chant build` would produce if the two are assembled from
 * one place, so they are.
 *
 * Two functions rather than one because the *modes* are needed earlier than the
 * rest: `chant build` arms sandboxed policy execution from the resolved
 * `sandbox` before it loads any policy module, which happens before build-time
 * parameters and the ownership marker exist. {@link resolveBuildModes} is that
 * early half; {@link resolveProjectBuildOptions} takes its result and assembles
 * everything `build()` is given.
 */
import { resolveFoldEnabled, resolveSandboxEnabled, type ChantConfig } from "../config";
import { collectBuildRootContributors, resolveLexiconVersions } from "./plugins";
import type { LexiconPlugin } from "../lexicon";
import type { BuildOptions } from "../build";
import type { OwnershipMarker } from "../ownership";
import type { BuildParamProvenance } from "../provenance";

/** The resolved fold/sandbox execution modes for one build. */
export interface BuildModes {
  /** #1022/#1134 — fold source modules statically; the default build path. */
  fold: boolean;
  /** #1045 Phase 2 — execute run-fallback files in a sandboxed child. */
  sandbox: boolean;
}

/**
 * Resolve this build's execution modes: an explicit CLI flag wins over
 * `chant.config.ts`'s `build.fold`/`build.sandbox`, which wins over the default
 * (fold on, sandbox off). Callers with no flags to offer (the `policyGate` step)
 * pass no overrides and get the project's own answer.
 */
export function resolveBuildModes(
  config: ChantConfig,
  overrides?: { fold?: boolean; sandbox?: boolean },
): BuildModes {
  return {
    fold: resolveFoldEnabled(config, overrides?.fold),
    sandbox: resolveSandboxEnabled(config, overrides?.sandbox),
  };
}

/** Inputs {@link resolveProjectBuildOptions} needs to assemble a build. */
export interface ProjectBuildOptionsInput {
  /** The project's resolved config, from `loadChantConfigUpward`. */
  config: ChantConfig;
  /** Directory the config was found in — build roots are rooted here, not at a (possibly sourceDir-scoped) build path. */
  configDir: string;
  /** The lexicon plugins loaded for this build. */
  plugins?: readonly LexiconPlugin[];
  /** Resolved execution modes, from {@link resolveBuildModes}. */
  modes: BuildModes;
  /** The resolved ownership marker, when marking is on. */
  ownership?: OwnershipMarker;
  /** This build's resolved build-time parameters (#1064). */
  buildParams?: BuildParamProvenance[];
}

/**
 * Assemble the option object `build()` takes for a project directory.
 *
 * Every option here is derived from the project (its config, its plugins, its
 * resolved parameters) rather than from the command that asked, so two callers
 * handing in the same project get byte-identical builds. A new option belongs
 * in this function, never at a call site.
 */
export function resolveProjectBuildOptions(input: ProjectBuildOptionsInput): BuildOptions {
  const { config, configDir, plugins, modes, ownership, buildParams } = input;

  // #1039 — each loaded plugin's registered intrinsics (e.g. AWS's `Sub`), so
  // a file using a registered intrinsic tagged template folds instead of
  // unconditionally falling back to run. `intrinsics` is an optional plugin
  // extension, hence the guard.
  const intrinsics = plugins?.flatMap((plugin) => plugin.intrinsics?.() ?? []) ?? [];

  // #1063 — the same loaded plugins, by NAME, are this build's allowlist for
  // following a bare import specifier into a lexicon package (so `Azure`,
  // `GCP`, `S3Actions`, `CI` fold as values).
  const lexicons = plugins?.map((plugin) => plugin.name) ?? [];

  return {
    ownership,
    config: config as unknown as Record<string, unknown>,
    fold: modes.fold,
    sandbox: modes.sandbox,
    intrinsics,
    lexicons,
    // chant #1442 — which lexicon VERSION interpreted each declaration.
    lexiconVersions: resolveLexiconVersions(lexicons),
    buildParams,
    // #1548 piece 3 — config-declared build roots (kustomize dirs, committed
    // ciphertext), rendered into entities by the owning lexicon's hook.
    buildRoots: collectBuildRootContributors(
      plugins,
      config as unknown as Record<string, unknown>,
      configDir,
    ),
  };
}
